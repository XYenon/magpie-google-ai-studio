import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "./session.ts";

const prepared = new Map<string, Promise<string>>();
const containerArgs = ["--no-sandbox", "--disable-dev-shm-usage"];

function directory(): string {
  return join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "magpie-google-ai-studio",
    "dependencies",
  );
}

export function chromePath(explicit?: string): string {
  if (explicit || process.env.BUN_CHROME_PATH) return explicit || process.env.BUN_CHROME_PATH!;
  for (const name of [
    join(directory(), "chromium"),
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "msedge",
    "chrome",
  ]) {
    const path = Bun.which(name);
    if (path) return path;
  }
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32")
    return join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
  throw new Error("Install Chrome/Chromium or set BUN_CHROME_PATH");
}

async function officialContainer(): Promise<boolean> {
  return (
    process.platform === "linux" &&
    (process.env.XDG_CONFIG_HOME === "/config" || homedir() === "/config/home") &&
    (await Bun.file("/magpie").exists()) &&
    /^ID=debian$/m.test(await Bun.file("/etc/os-release").text())
  );
}

async function run(argv: string[], report = false): Promise<string> {
  const env = process.env;
  const child = Bun.spawn(argv, {
    env:
      argv[0] === "apt-get"
        ? {
            ...env,
            http_proxy: env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy,
            https_proxy: env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy,
            no_proxy: env.NO_PROXY || env.no_proxy,
          }
        : undefined,
    stdin: "ignore",
    stdout: "pipe",
    stderr: report ? "inherit" : "pipe",
    timeout: 600_000,
  });
  const [output, , code] = await Promise.all([
    new Response(child.stdout).text(),
    child.stderr ? new Response(child.stderr).text() : "",
    child.exited,
  ]);
  // Installer output can contain proxy credentials. Do not copy it into logs or IPC.
  if (code !== 0)
    throw new Error(
      `Dependency command ${argv[0]} failed (exit ${code}); check network access and /config permissions`,
    );
  return output;
}

async function browserWorks(path: string): Promise<boolean> {
  const profile = await mkdtemp(join(directory(), "probe-"));
  try {
    const child = Bun.spawn(
      [
        path,
        ...containerArgs,
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--dump-dom",
        "about:blank",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
    const [output, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return code === 0 && output.includes("<html");
  } catch {
    return false;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

async function install(explicit?: string): Promise<string> {
  const root = directory();
  let chrome: string | undefined;
  try {
    chrome = chromePath(explicit);
  } catch {
    /* Install the default browser below. */
  }
  if (chrome && !(await browserWorks(chrome))) {
    if (explicit || process.env.BUN_CHROME_PATH)
      throw new Error(
        "The configured Chrome cannot start; check chromePath/BUN_CHROME_PATH and its shared libraries",
      );
    chrome = undefined;
  }
  if (chrome) return chrome;
  console.error("[google-ai-studio] Preparing browser dependencies in /config; the first request will wait.");
  const stage = await mkdtemp(join(root, "install-"));
  try {
    const state = join(stage, "apt-state");
    const cache = join(stage, "apt-cache");
    await mkdir(join(state, "lists", "partial"), { recursive: true });
    await mkdir(join(cache, "archives", "partial"), { recursive: true });
    const apt = [
      "apt-get",
      "-o",
      `Dir::State=${state}`,
      "-o",
      `Dir::Cache=${cache}`,
      "-o",
      "Dir::State::status=/var/lib/dpkg/status",
      "-o",
      "Debug::NoLocking=1",
      "-o",
      "APT::Update::Error-Mode=any",
      "-o",
      "Acquire::Retries=1",
      "-o",
      "Acquire::http::Timeout=30",
      "-o",
      "Acquire::https::Timeout=30",
    ];
    await run([...apt, "update"]);
    await run([
      ...apt,
      "--download-only",
      "--yes",
      "--no-install-recommends",
      "install",
      "chromium",
      "fonts-liberation",
    ]);
    const extracted = join(root, "root");
    await mkdir(extracted, { recursive: true });
    for (const name of await readdir(join(cache, "archives"))) {
      if (name.endsWith(".deb"))
        await run(["dpkg-deb", "--extract", join(cache, "archives", name), extracted]);
    }
    const triplet = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
    await Bun.write(
      join(root, "fonts.conf"),
      `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir prefix="relative">root/usr/share/fonts</dir><cachedir prefix="relative">font-cache</cachedir></fontconfig>`,
    );
    const wrapper = join(root, "chromium");
    await Bun.write(
      wrapper,
      `#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LD_LIBRARY_PATH="$root/root/usr/lib/${triplet}:$root/root/lib/${triplet}:$root/root/usr/lib/${triplet}/pulseaudio\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_FILE="$root/fonts.conf"
exec "$root/root/usr/lib/chromium/chromium" "$@"
`,
    );
    await chmod(wrapper, 0o755);
    if (!(await browserWorks(wrapper)))
      throw new Error(
        "Installed Chromium could not start; check /config permissions and container restrictions",
      );
    console.error("[google-ai-studio] Browser dependencies are ready.");
    return wrapper;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function prepareBrowser(options: Options = {}): Promise<Options> {
  if (!(await officialContainer())) return options;
  const prototype = Bun.WebView?.prototype;
  if (
    !prototype ||
    !["navigate", "evaluate", "cdp", "click", "type", "close", "addEventListener"].every(
      (key) => typeof (prototype as unknown as Record<string, unknown>)[key] === "function",
    )
  )
    throw new Error("The Bun runtime used by Magpie does not provide the required Bun.WebView APIs");
  const key = options.chromePath || process.env.BUN_CHROME_PATH || "";
  let result = prepared.get(key);
  if (!result) {
    result = (async () => {
      if (process.arch !== "x64" && process.arch !== "arm64")
        throw new Error("Unsupported official Docker image architecture");
      const root = directory();
      await mkdir(root, { recursive: true });
      // flock releases on exit, including crashes, and works across containers sharing /config.
      const output = await run(
        [
          "flock",
          "--no-fork",
          "--wait",
          "600",
          join(root, "install.lock"),
          process.execPath,
          "--no-orphans",
          fileURLToPath(import.meta.url),
          "--install",
          key,
        ],
        true,
      );
      return JSON.parse(output) as string;
    })();
    prepared.set(key, result);
    void result.catch(() => prepared.delete(key));
  }
  return {
    ...options,
    chromePath: await result,
    chromeArgs: [...containerArgs, ...(options.chromeArgs || [])],
  };
}

if (import.meta.main && process.argv[2] === "--install") {
  try {
    process.stdout.write(JSON.stringify(await install(process.argv[3] || undefined)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Dependency installation failed");
    process.exitCode = 1;
  }
}

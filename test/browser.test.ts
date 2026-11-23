import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { StudioBrowser } from "../src/browser.ts";
import { optionsFrom, type Session } from "../src/session.ts";

// A Chrome stand-in that advertises an unreachable DevTools endpoint, so
// WebView fails after startup and open() must close the spawned process.
test.skipIf(process.platform === "win32" || typeof Bun.WebView !== "function")(
  "failed browser startup closes the spawned Chrome before rethrowing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "magpie-studio-rollback-"));
    const profile = join(root, "profile");
    const pidFile = join(root, "chrome.pid");
    const chrome = join(root, "chrome");
    await mkdir(profile, { recursive: true });
    await writeFile(
      chrome,
      `#!/bin/sh
echo $$ > ${JSON.stringify(pidFile)}
printf '1\\n/devtools/browser/fixture\\n' > ${JSON.stringify(join(profile, "DevToolsActivePort"))}
trap 'exit 0' TERM
sleep 30
`,
    );
    await chmod(chrome, 0o755);
    const browser = new StudioBrowser({ version: 1, profile, accountId: "fixture" }, { chromePath: chrome });
    try {
      await expect(browser.open(false)).rejects.toThrow();
      const pid = Number(await Bun.file(pidFile).text());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

const unix = process.platform !== "win32";

function fakeSession(profile: string): Session {
  return { version: 1, accountId: "test@example.com", profile };
}

test.skipIf(!unix)(
  "open rejects without removing DevToolsActivePort when SingletonLock has a live owner",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "studio-browser-live-lock-"));
    const portFile = join(profile, "DevToolsActivePort");
    try {
      await symlink(`${hostname()}-${process.pid}`, join(profile, "SingletonLock"));
      await writeFile(portFile, "9222\n/devtools/browser/live\n");
      const browser = new StudioBrowser(fakeSession(profile), {
        chromePath: "/nonexistent/chrome",
        recoverForeignProfileLock: true,
      });
      await expect(browser.open()).rejects.toThrow(
        `Chrome profile is in use by ${hostname()}-${process.pid}; close that browser and retry`,
      );
      expect(await readFile(portFile, "utf8")).toBe("9222\n/devtools/browser/live\n");
      expect(await readlink(join(profile, "SingletonLock"))).toBe(`${hostname()}-${process.pid}`);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test.skipIf(!unix)(
  "open rejects a lock owned by another host without removing DevToolsActivePort",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "studio-browser-remote-lock-"));
    const portFile = join(profile, "DevToolsActivePort");
    try {
      await symlink("another-host-12345", join(profile, "SingletonLock"));
      await writeFile(portFile, "9222\n/devtools/browser/remote\n");
      const browser = new StudioBrowser(fakeSession(profile), { chromePath: "/nonexistent/chrome" });
      await expect(browser.open()).rejects.toThrow("Chrome profile is in use by another-host-12345");
      expect(await readFile(portFile, "utf8")).toBe("9222\n/devtools/browser/remote\n");
      expect(await readlink(join(profile, "SingletonLock"))).toBe("another-host-12345");
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "exclusive deployment can start Chrome after a previous container leaves a foreign lock",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "studio-browser-container-lock-"));
    const lock = join(profile, "SingletonLock");
    const chrome = join(profile, "fake-chrome.sh");
    const browser = new StudioBrowser(
      fakeSession(profile),
      optionsFrom({ chromePath: chrome, recoverForeignProfileLock: true }),
    );
    try {
      await symlink("previous-container-181", lock);
      await writeFile(chrome, `#!/bin/sh\nif [ -L "\${1#*=}/SingletonLock" ]; then exit 1; fi\nexit 42\n`);
      await chmod(chrome, 0o755);
      await expect(browser.open()).rejects.toThrow(
        "Chrome exited before starting WebView (exit 42, signal none)",
      );
      await expect(readlink(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await browser.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test.skipIf(!unix)(
  "open ignores stale SingletonLock and reports Chrome exit code on early exit",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "studio-browser-stale-lock-"));
    const fakeChrome = join(profile, "fake-chrome.sh");
    try {
      await symlink(`${hostname()}-99999999`, join(profile, "SingletonLock"));
      await writeFile(fakeChrome, "#!/bin/sh\nexit 42\n");
      await chmod(fakeChrome, 0o755);
      const browser = new StudioBrowser(fakeSession(profile), { chromePath: fakeChrome });
      await expect(browser.open()).rejects.toThrow(
        "Chrome exited before starting WebView (exit 42, signal none)",
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
);

test.skipIf(!unix)("open reports a signal when Chrome is killed before starting WebView", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-browser-signal-"));
  const profile = join(root, "profile");
  const fakeChrome = join(root, "fake-chrome.sh");
  await mkdir(profile);
  await writeFile(fakeChrome, "#!/bin/sh\nkill -9 $$\n");
  await chmod(fakeChrome, 0o755);
  const browser = new StudioBrowser(fakeSession(profile), { chromePath: fakeChrome });
  try {
    await expect(browser.open()).rejects.toThrow(
      "Chrome exited before starting WebView (exit none, signal SIGKILL)",
    );
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

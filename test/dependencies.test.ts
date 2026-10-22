import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.env.AISTUDIO_DOCKER_TEST !== "1")(
  "official Docker installs the packaged plugin's browser as nonroot and reuses it offline after recreation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "magpie-docker-"));
    const volume = `magpie-aistudio-test-${crypto.randomUUID()}`;
    const image = "ghcr.io/yetone/magpie:latest";
    const command = async (args: string[]) => {
      const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}`);
      return { stdout, stderr };
    };
    try {
      await command([process.execPath, "pm", "pack", "--destination", directory]);
      await command(["tar", "-xzf", join(directory, "magpie-google-ai-studio-0.1.0.tgz"), "-C", directory]);
      await command(["docker", "volume", "create", volume]);
      await command([
        "docker",
        "run",
        "--rm",
        "--user",
        "0",
        "-v",
        `${volume}:/config`,
        "--entrypoint",
        "chown",
        image,
        "-R",
        "65532:65532",
        "/config",
      ]);
      const code = `
        import { stat } from 'node:fs/promises';
        import plugin from '/package/index.ts';
        import { prepareBrowser } from '/package/src/dependencies.ts';
        const start = performance.now();
        await plugin.server({});
        const initMs = performance.now() - start;
        if (initMs > 2000) throw new Error('Dependency installation blocked plugin initialization');
        const executable = '/config/cache/magpie-google-ai-studio/dependencies/chromium';
        const deadline = Date.now() + 570000;
        while (!await Bun.file(executable).exists()) {
          if (Date.now() > deadline) throw new Error('Plugin startup did not install Chromium');
          await Bun.sleep(100);
        }
        const options = await prepareBrowser();
        const view = new Bun.WebView({ backend: { type: 'chrome', path: options.chromePath, argv: options.chromeArgs } });
        try {
          await view.navigate('data:text/html,<title>installed-browser</title><input id=x>');
          await view.click('#x');
          await view.type('persisted dependency');
          console.log(JSON.stringify({
            uid: process.getuid(), initMs,
            title: await view.evaluate('document.title'),
            input: await view.evaluate('document.querySelector("#x").value'),
            version: (await view.cdp('Browser.getVersion')).product,
            modified: (await stat(executable)).mtimeMs,
          }));
        } finally { view.close(); }
      `;
      const run = (network: string, source = code, environment: string[] = []) =>
        command([
          "docker",
          "run",
          "--rm",
          "--network",
          network,
          "-v",
          `${volume}:/config`,
          "-v",
          `${join(directory, "package")}:/package:ro`,
          "-v",
          `${process.execPath}:/test-bun:ro`,
          ...environment,
          "--entrypoint",
          "/test-bun",
          image,
          "--eval",
          source,
        ]);
      const unavailable = await run(
        "host",
        `
        import { prepareBrowser } from '/package/src/dependencies.ts';
        try { await prepareBrowser(); throw new Error('Unexpected success'); }
        catch (error) {
          if (!error.message.includes('Dependency command')) throw error;
          console.log('Network failure reported');
        }
      `,
        ["-e", "HTTP_PROXY=http://127.0.0.1:9", "-e", "HTTPS_PROXY=http://127.0.0.1:9"],
      );
      expect(unavailable.stdout).toContain("Network failure reported");
      const installed = await run("host");
      expect(installed.stderr).toContain("Browser dependencies are ready");
      const first = JSON.parse(installed.stdout);
      expect(first).toMatchObject({
        uid: 65532,
        title: "installed-browser",
        input: "persisted dependency",
      });
      expect(first.version).toStartWith("Chrome/");
      const restarted = await run("none");
      expect(restarted.stderr).not.toContain("Preparing browser dependencies");
      expect(JSON.parse(restarted.stdout)).toMatchObject({
        uid: 65532,
        title: first.title,
        input: first.input,
        version: first.version,
        modified: first.modified,
      });
      await run(
        "none",
        `
        import { readdir, unlink } from 'node:fs/promises';
        const triplet = process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
        const dir = '/config/cache/magpie-google-ai-studio/dependencies/root/usr/lib/' + triplet + '/pulseaudio';
        const library = (await readdir(dir)).find(name => name.startsWith('libpulsecommon-'));
        if (!library) throw new Error('Missing library for repair control');
        await unlink(dir + '/' + library);
      `,
      );
      const repaired = await run("host");
      expect(repaired.stderr).toContain("Browser dependencies are ready");
      const last = JSON.parse(repaired.stdout);
      expect(last).toMatchObject({ uid: 65532, title: first.title, input: first.input });
      expect(last.modified).toBeGreaterThan(first.modified);
      console.error(
        "Docker dependency validation:",
        JSON.stringify({
          failure: unavailable.stdout.trim(),
          first,
          restarted: JSON.parse(restarted.stdout),
          repaired: last,
        }),
      );
    } finally {
      await command(["docker", "volume", "rm", "--force", volume]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  650_000,
);

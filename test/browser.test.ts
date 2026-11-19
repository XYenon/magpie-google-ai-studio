import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioBrowser } from "../src/browser.ts";

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

import { StudioBrowser } from "./browser.ts";
import { errorBody, type Wire } from "./protocol.ts";
import { proxySignature } from "./proxy.ts";
import type { Options, Session } from "./session.ts";

// Magpie injects the current account's proxy into child environments, not
// into the host's process.env. This short-lived mode detects routing changes
// without logging proxy URLs or credentials or starting Chrome.
if (process.argv.includes("--proxy-signature")) {
  process.stdout.write(proxySignature());
  process.exit(0);
}

let browser: StudioBrowser | undefined;
const decoder = new TextDecoder();
let pending = "";
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void (async () => {
      await browser?.close();
      process.exit(0);
    })();
  });
}
try {
  for await (const bytes of Bun.stdin.stream()) {
    pending += decoder.decode(bytes, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const command = JSON.parse(line) as {
        id: number;
        method: string;
        session: Session;
        options: Options;
        requestId: string;
        body: Wire;
        binding: string;
        upstreamMethod?: string;
        proofIndex?: number;
        interactive?: boolean;
      };
      try {
        let value: unknown;
        switch (command.method) {
          case "open":
            browser = new StudioBrowser(command.session, command.options);
            await browser.open(command.interactive);
            value = { timezone: browser.timezone, proxy: proxySignature() };
            break;
          case "models":
            value = await browser!.listModels();
            break;
          case "buildModels":
            value = await browser!.buildModels();
            break;
          case "snapshot":
            value = await browser!.snapshot();
            break;
          case "generate":
            if (command.binding !== undefined) await browser!.bootstrap();
            await browser!.start(
              command.requestId,
              command.upstreamMethod || "GenerateContent",
              command.body,
              command.binding,
              command.proofIndex,
            );
            value = true;
            break;
          case "poll":
            value = await browser!.poll(command.requestId);
            break;
          case "cancel":
            await browser!.cancel(command.requestId);
            value = true;
            break;
          default:
            throw new Error("Unknown browser command");
        }
        process.stdout.write(`${JSON.stringify({ id: command.id, value })}\n`);
      } catch (error) {
        // Keep diagnostics bounded across IPC without serializing exception stacks.
        const message = error instanceof Error ? error.message : "Browser operation failed";
        process.stdout.write(
          `${JSON.stringify({
            id: command.id,
            error: errorBody(message),
            signIn: (error as { signIn?: string }).signIn,
          })}\n`,
        );
      }
    }
  }
} finally {
  await browser?.close();
}

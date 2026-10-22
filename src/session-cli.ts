import { join } from "node:path";
import { StudioClient } from "./client.ts";
import { importSession, listSessions, saveSession } from "./session.ts";

const [command, input, output] = process.argv.slice(2);
if (!command || command === "--help") {
  console.log(`Usage:
  bun run session list
  bun run session export <account.session.json> <output.aistudio.json>
  bun run session import <input.aistudio.json> [account-name]

Export writes a portable file containing Google login credentials (mode 0600).
Import verifies the session and prints its new local descriptor path. Register
that descriptor with "magpie plugin login google-ai-studio", or import the
portable file directly through Magpie's login menu instead.
Close Magpie before CLI export if it is using the same Chrome profile.`);
} else {
  let client: StudioClient | undefined;
  try {
    if (command === "list") {
      for (const session of await listSessions())
        console.log(`${session.accountId}\t${join(session.profile, "account.session.json")}`);
    } else if (command === "export" && input && output) {
      client = new StudioClient(await importSession(input));
      console.log(await client.export(output));
    } else if (command === "import" && input) {
      const session = await importSession(input, output);
      client = new StudioClient(session);
      await client.models();
      console.log(await saveSession(session));
    } else {
      throw new Error("Use 'bun run session --help' for export/import usage");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Session operation failed");
    process.exitCode = 1;
  } finally {
    await client?.close();
  }
}

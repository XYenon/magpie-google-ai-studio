import { StudioClient } from "./client.ts";
import { createSession, saveSession } from "./session.ts";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: bun run login [account-name]\nOpens Chrome for Google login and prints the local session descriptor path.",
  );
} else {
  const session = await createSession(process.argv[2] || "Google AI Studio");
  const client = new StudioClient(session, {});
  try {
    console.error(
      "请在打开的普通 Chrome 窗口登录 Google AI Studio，完成首次使用设置后关闭该窗口。最多等待 10 分钟，关闭后自动验证并保存会话。",
    );
    await client.login();
    console.log(await saveSession(session));
  } finally {
    await client.close();
  }
}

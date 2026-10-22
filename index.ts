import { rm } from "node:fs/promises";
import { StudioClient } from "./src/client.ts";
import { prepareBrowser } from "./src/dependencies.ts";
import { providerFetch, providerModels } from "./src/provider.ts";
import {
  createSession,
  importSession,
  importSessionText,
  listSessions,
  optionsFrom,
  readSession,
  type Session,
  saveSession,
} from "./src/session.ts";

const ID = "google-ai-studio";

function authSuccess(session: Session) {
  return {
    type: "success" as const,
    key: JSON.stringify(session),
    metadata: { email: session.accountId },
  };
}

export default {
  id: "magpie-google-ai-studio",
  async server(_input: unknown, rawOptions: Record<string, unknown> = {}) {
    const options = optionsFrom(rawOptions);
    // Downloads can exceed Magpie's host-init deadline. Start now and let
    // browser operations await the same preparation without blocking init.
    void prepareBrowser(options).catch((error) => {
      console.error(
        "[google-ai-studio]",
        error instanceof Error ? error.message : "Browser dependency setup failed",
      );
    });
    const clients = new Map<string, StudioClient>();
    const clientFor = (session: Session) => {
      let client = clients.get(session.profile);
      if (!client) {
        client = new StudioClient(session, options);
        clients.set(session.profile, client);
      }
      return client;
    };
    process.once("exit", () => {
      for (const client of clients.values()) client.close();
    });
    return {
      config(config: { provider?: Record<string, unknown> }) {
        config.provider ??= {};
        config.provider[ID] = {
          name: "Google AI Studio",
          npm: "@ai-sdk/google",
          api: "https://generativelanguage.googleapis.com/v1beta",
          models: {},
          ...(config.provider[ID] as Record<string, unknown> | undefined),
        };
      },
      auth: {
        provider: ID,
        maxConcurrency: 1,
        methods: [
          {
            type: "oauth" as const,
            label: "登录 Google AI Studio（打开本机 Chrome）",
            prompts: [
              {
                type: "text",
                key: "account",
                message: "账号名称（用于区分多个账号）",
                placeholder: "you@gmail.com",
              },
              {
                type: "text",
                key: "exportPath",
                message: "可迁移会话包导出路径（留空跳过）",
                placeholder: "/path/to/account.aistudio.json",
              },
            ],
            async authorize(inputs: Record<string, string> = {}) {
              const session = await createSession(inputs.account || "Google AI Studio");
              const client = new StudioClient(session, options);
              const result = (async () => {
                try {
                  await client.login();
                  await saveSession(session);
                  if (inputs.exportPath?.trim()) await client.export(inputs.exportPath.trim());
                  return authSuccess(session);
                } catch (error) {
                  return {
                    type: "failed" as const,
                    error: error instanceof Error ? error.message : "登录失败",
                  };
                } finally {
                  await client.close();
                }
              })();
              return {
                url: "https://aistudio.google.com/",
                opened: true,
                instructions:
                  "请在打开的普通 Chrome 窗口登录 Google AI Studio，完成首次使用设置后关闭该窗口。最多等待 10 分钟，关闭后自动验证并保存会话。",
                method: "auto" as const,
                callback: () => result,
              };
            },
          },
          {
            type: "oauth" as const,
            label: "导入 Google AI Studio 会话／导出本机会话",
            prompts: [
              {
                type: "text",
                key: "path",
                message: "跨机器会话包、本机 account.session.json 或 storage-state JSON 的绝对路径",
              },
              {
                type: "text",
                key: "account",
                message: "账号名称（留空保留会话包中的名称）",
                placeholder: "you@gmail.com",
              },
              {
                type: "text",
                key: "exportPath",
                message: "同时导出可迁移会话包到此路径（留空跳过）",
                placeholder: "/path/to/account.aistudio.json",
              },
            ],
            async authorize(inputs: Record<string, string> = {}) {
              const result = (async () => {
                try {
                  const session = await importSession(inputs.path, inputs.account);
                  // Reuse an active account when exporting its local session.
                  const client = clientFor(session);
                  await client.models();
                  if (inputs.exportPath?.trim()) await client.export(inputs.exportPath.trim());
                  return authSuccess(session);
                } catch (error) {
                  return {
                    type: "failed" as const,
                    error: error instanceof Error ? error.message : "导入失败",
                  };
                }
              })();
              // The automatic flow avoids Magpie's API-key prompt, which is
              // always shown for API methods even when authorize reads a file.
              return {
                url: "",
                opened: true,
                instructions: "正在验证会话；如果填写了导出路径，验证后会将可迁移会话包保存到该路径。",
                method: "auto" as const,
                callback: () => result,
              };
            },
          },
          {
            type: "oauth" as const,
            label: "导出可复制的会话迁移文本（Web）",
            prompts: [
              {
                type: "text",
                key: "account",
                message: "要导出的账号名称（与登录时填写的一致，仅有一个本机会话时可留空）",
              },
            ],
            async authorize(inputs: Record<string, string> = {}) {
              const account = inputs.account?.trim();
              const sessions = (await listSessions()).filter((s) => !account || s.accountId === account);
              if (sessions.length === 0) throw new Error("找不到本机会话，请检查账号名称或先登录");
              if (sessions.length !== 1)
                throw new Error("存在多个本机会话，请填写唯一的账号名称；同名会话请通过文件入口导出");
              const session = sessions[0];
              const text = await clientFor(session).export();
              return {
                // Magpie's bounded sign-in-link row has a copy button that
                // copies the entire value. Never put credentials in an HTTP URL.
                url: text,
                opened: true,
                instructions:
                  "请点击下方文本旁的复制按钮，将完整迁移文本私密传给目标机器。它包含登录凭据，请勿打开链接或点击 Open again。复制完成后，在 Code 中输入 DONE 并完成；也可关闭窗口，源账号不受影响。",
                method: "code" as const,
                async callback(code = "") {
                  if (code.trim() !== "DONE")
                    return { type: "failed" as const, error: "请输入 DONE 确认已复制迁移文本" };
                  return authSuccess(session);
                },
              };
            },
          },
          {
            type: "oauth" as const,
            label: "粘贴会话迁移文本导入（Web）",
            prompts: [
              {
                type: "password",
                key: "payload",
                message: "粘贴完整的 aistudio-session:v1- 迁移文本（包含登录凭据）",
              },
            ],
            async authorize(inputs: Record<string, string> = {}) {
              const result = (async () => {
                let session: Session | undefined;
                let client: StudioClient | undefined;
                try {
                  session = await importSessionText(inputs.payload || "");
                  client = clientFor(session);
                  await client.models();
                  return authSuccess(session);
                } catch (error) {
                  // A failed import must not leave an exportable local account.
                  if (session) {
                    await client?.close();
                    clients.delete(session.profile);
                    await rm(session.profile, { recursive: true, force: true });
                  }
                  return {
                    type: "failed" as const,
                    error: error instanceof Error ? error.message : "导入失败",
                  };
                }
              })();
              return {
                url: "",
                opened: true,
                instructions: "正在恢复并验证会话，成功后会自动保存账号并读取模型列表。",
                method: "auto" as const,
                callback: () => result,
              };
            },
          },
        ],
        async loader(getAuth: () => Promise<{ key?: unknown }>) {
          const session = readSession((await getAuth())?.key);
          return {
            apiKey: "aistudio-browser-session",
            fetch: providerFetch(clientFor(session)),
          };
        },
      },
      provider: {
        id: ID,
        async models(_provider: unknown, context: { auth?: { key?: unknown } } = {}) {
          return providerModels(clientFor(readSession(context.auth?.key)));
        },
      },
    };
  },
};

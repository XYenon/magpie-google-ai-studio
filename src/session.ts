import type { Dirent } from "node:fs";
import { chmod, mkdir, open, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export interface Session {
  version: 1;
  profile: string;
  accountId: string;
}

export interface StorageState {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    priority?: "Low" | "Medium" | "High";
    sourceScheme?: "Unset" | "NonSecure" | "Secure";
    sourcePort?: number;
    partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
  }[];
  origins: {
    origin: string;
    localStorage: { name: string; value: string }[];
    sessionStorage?: { name: string; value: string }[];
  }[];
}

const PORTABLE_FORMAT = "magpie-google-ai-studio/session";
const TRANSFER_PREFIX = "aistudio-session:v1-";
// Magpie caps sign-in request bodies at 64 KiB. Leave room for its JSON envelope.
const MAX_TRANSFER_LENGTH = 60 * 1024;
const MAX_TRANSFER_JSON = 1024 * 1024;

export interface Options {
  chromePath?: string;
  chromeArgs?: string[];
  bootstrapModel?: string;
  timeoutMs?: number;
}

export function optionsFrom(raw: Record<string, unknown> = {}): Options {
  const result: Options = {};
  if (raw.chromePath !== undefined) {
    if (typeof raw.chromePath !== "string") throw new Error("chromePath must be a string");
    result.chromePath = raw.chromePath;
  }
  if (raw.chromeArgs !== undefined) {
    if (!Array.isArray(raw.chromeArgs) || !raw.chromeArgs.every((v) => typeof v === "string")) {
      throw new Error("chromeArgs must be an array of strings");
    }
    if (raw.chromeArgs.some((v) => /^--(user-data-dir|remote-debugging|headless)/.test(v))) {
      throw new Error("chromeArgs cannot override profile, debugging or headless settings");
    }
    result.chromeArgs = raw.chromeArgs;
  }
  if (raw.bootstrapModel !== undefined) {
    if (typeof raw.bootstrapModel !== "string" || !/^[\w.-]+$/.test(raw.bootstrapModel)) {
      throw new Error("bootstrapModel must be a model ID without models/ prefix");
    }
    result.bootstrapModel = raw.bootstrapModel;
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs < 1000) {
      throw new Error("timeoutMs must be at least 1000");
    }
    result.timeoutMs = raw.timeoutMs;
  }
  return result;
}

export function readSession(key: unknown): Session {
  if (typeof key !== "string")
    throw Object.assign(new Error("Sign in to Google AI Studio first"), { signIn: "expired" });
  const value = JSON.parse(key);
  if (
    value?.version !== 1 ||
    typeof value.profile !== "string" ||
    !value.profile ||
    typeof value.accountId !== "string"
  ) {
    throw new Error("Invalid Google AI Studio session descriptor");
  }
  return { version: 1, profile: resolve(value.profile), accountId: value.accountId };
}

function dataDirectory(): string {
  return (
    process.env.MAGPIE_AISTUDIO_DATA_DIR || join(homedir(), ".local", "share", "magpie-google-ai-studio")
  );
}

export async function createSession(accountId: string): Promise<Session> {
  const root = dataDirectory();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const profile = join(resolve(root), crypto.randomUUID());
  await mkdir(profile, { mode: 0o700 });
  return { version: 1, profile, accountId: accountId || "Google AI Studio" };
}

export async function saveSession(session: Session): Promise<string> {
  const path = join(session.profile, "account.session.json");
  await Bun.write(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function listSessions(): Promise<Session[]> {
  const root = dataDirectory();
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sessions: Session[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = Bun.file(join(root, entry.name, "account.session.json"));
    if (await file.exists()) sessions.push(readSession(await file.text()));
  }
  return sessions;
}

// Only browser state used by this provider travels between machines. In
// particular, never deserialize a profile path or Chrome encryption key here.
export function storageState(value: unknown): StorageState {
  const invalid = () => {
    throw new Error("Invalid Google AI Studio browser storage state");
  };
  if (!value || typeof value !== "object") return invalid();
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.cookies) || !raw.cookies.length) return invalid();
  const cookies: StorageState["cookies"] = [];
  for (const c of raw.cookies) {
    if (!c || typeof c !== "object" || typeof c.domain !== "string") return invalid();
    const domain = c.domain.replace(/^\./, "").toLowerCase();
    if (domain !== "google.com" && !domain.endsWith(".google.com")) continue;
    if (
      typeof c.name !== "string" ||
      !c.name ||
      typeof c.value !== "string" ||
      typeof c.path !== "string" ||
      !c.path.startsWith("/")
    )
      return invalid();
    const cookie: StorageState["cookies"][number] = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    };
    for (const key of ["secure", "httpOnly"] as const) {
      if (c[key] === undefined) continue;
      if (typeof c[key] !== "boolean") return invalid();
      cookie[key] = c[key];
    }
    if (c.expires !== undefined) {
      if (typeof c.expires !== "number" || !Number.isFinite(c.expires)) return invalid();
      if (c.expires > 0) cookie.expires = c.expires;
    }
    if (c.sameSite !== undefined) {
      if (!["Strict", "Lax", "None"].includes(c.sameSite)) return invalid();
      cookie.sameSite = c.sameSite;
    }
    if (c.priority !== undefined) {
      if (!["Low", "Medium", "High"].includes(c.priority)) return invalid();
      cookie.priority = c.priority;
    }
    if (c.sourceScheme !== undefined) {
      if (!["Unset", "NonSecure", "Secure"].includes(c.sourceScheme)) return invalid();
      cookie.sourceScheme = c.sourceScheme;
    }
    if (c.sourcePort !== undefined) {
      if (!Number.isInteger(c.sourcePort) || c.sourcePort < -1 || c.sourcePort > 65535) return invalid();
      cookie.sourcePort = c.sourcePort;
    }
    if (c.partitionKey !== undefined) {
      const key = c.partitionKey;
      if (
        !key ||
        typeof key.topLevelSite !== "string" ||
        !/^https?:\/\//.test(key.topLevelSite) ||
        typeof key.hasCrossSiteAncestor !== "boolean"
      )
        return invalid();
      cookie.partitionKey = {
        topLevelSite: key.topLevelSite,
        hasCrossSiteAncestor: key.hasCrossSiteAncestor,
      };
    }
    cookies.push(cookie);
  }
  if (!cookies.some((c) => ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"].includes(c.name))) {
    throw new Error("The storage state has no Google SAPISID session cookie");
  }
  if (raw.origins !== undefined && !Array.isArray(raw.origins)) return invalid();
  const origins: StorageState["origins"] = [];
  for (const origin of (raw.origins || []) as Record<string, unknown>[]) {
    if (origin?.origin !== "https://aistudio.google.com") continue;
    const entries = (items: unknown): { name: string; value: string }[] => {
      if (!Array.isArray(items)) return invalid();
      return items.map((item) => {
        if (!item || typeof item.name !== "string" || typeof item.value !== "string") return invalid();
        return { name: item.name, value: item.value };
      });
    };
    origins.push({
      origin: "https://aistudio.google.com",
      localStorage: entries(origin.localStorage ?? []),
      ...(origin.sessionStorage === undefined ? {} : { sessionStorage: entries(origin.sessionStorage) }),
    });
  }
  return { cookies, origins };
}

function portableSession(session: Session, state: StorageState) {
  return {
    format: PORTABLE_FORMAT,
    version: 1,
    accountId: session.accountId,
    exportedAt: new Date().toISOString(),
    ...storageState(state),
  };
}

export function exportSessionText(session: Session, state: StorageState): string {
  const json = JSON.stringify(portableSession(session, state));
  if (Buffer.byteLength(json) > MAX_TRANSFER_JSON) throw new Error("会话数据过大，请使用文件导出和导入");
  const text = TRANSFER_PREFIX + gzipSync(json).toString("hex").toUpperCase();
  if (text.length > MAX_TRANSFER_LENGTH)
    throw new Error("迁移文本超过 Magpie Web 表单长度限制，请使用文件导出和导入");
  return text;
}

export async function importSessionText(text: string): Promise<Session> {
  const input = text.trim();
  if (input.length > MAX_TRANSFER_LENGTH)
    throw new Error("迁移文本超过 Magpie Web 表单长度限制，请使用文件导出和导入");
  if (!input.startsWith(TRANSFER_PREFIX))
    throw new Error("无法识别迁移文本格式或版本，请复制完整的 aistudio-session:v1- 文本");
  const hex = input.slice(TRANSFER_PREFIX.length);
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error("迁移文本不完整或已损坏，请重新复制");
  let value: Record<string, unknown> | null;
  try {
    value = JSON.parse(
      gunzipSync(Buffer.from(hex, "hex"), { maxOutputLength: MAX_TRANSFER_JSON }).toString("utf8"),
    );
  } catch {
    throw new Error("迁移文本不完整、已损坏或解压后过大，请重新导出或使用文件迁移");
  }
  if (value?.format !== PORTABLE_FORMAT || value.version !== 1)
    throw new Error("Unsupported Google AI Studio portable session format/version");
  return restoreSession(value);
}

export async function exportSession(session: Session, state: StorageState, path: string): Promise<string> {
  if (!path.trim()) throw new Error("An export file path is required");
  const output = resolve(path);
  const portable = portableSession(session, state);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  // Exclusive creation also prevents accidentally replacing the local descriptor
  // or overwriting an existing file whose permissions might expose credentials.
  const file = await open(output, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(portable, null, 2)}\n`);
  } catch (error) {
    await file.close();
    await rm(output, { force: true });
    throw error;
  }
  await file.close();
  return output;
}

// Import only local files. Session material never travels through a remote login URL.
export async function importSession(path: string, accountId?: string): Promise<Session> {
  let value: unknown;
  try {
    value = JSON.parse(await Bun.file(resolve(path)).text());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid session JSON file");
    throw error;
  }
  return restoreSession(value, accountId);
}

async function restoreSession(value: unknown, accountId?: string): Promise<Session> {
  const metadata = value as Record<string, unknown> | null | undefined;
  if (metadata?.format !== undefined && (metadata.format !== PORTABLE_FORMAT || metadata.version !== 1))
    throw new Error("Unsupported Google AI Studio portable session format/version");
  if (metadata?.format === undefined && metadata?.version === 1) return readSession(JSON.stringify(value));
  const name = metadata?.format === PORTABLE_FORMAT ? metadata.accountId : "Google AI Studio";
  if (typeof name !== "string") throw new Error("Invalid portable session account name");
  const state = storageState(value);
  const session = await createSession(accountId?.trim() || name);
  try {
    await Bun.write(join(session.profile, "storage-state.json"), JSON.stringify(state), { mode: 0o600 });
    await saveSession(session);
    return session;
  } catch (error) {
    await rm(session.profile, { recursive: true, force: true });
    throw error;
  }
}

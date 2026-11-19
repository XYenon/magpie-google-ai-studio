import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioClient } from "../src/client.ts";
import type { EncodedRequest } from "../src/protocol.ts";

// A minimal worker protocol fixture: "hang" never answers polls, "empty"
// returns headers without data, and "stream" emits one chunk every 300ms.
const fakeWorker = `
export {};
if (process.argv.includes("--proxy-signature")) {
  process.stdout.write("");
  process.exit(0);
}
const decoder = new TextDecoder();
let pending = "";
const requests = new Map();
const mode = __MODE__;
const total = 12;
for await (const bytes of Bun.stdin.stream()) {
  pending += decoder.decode(bytes, { stream: true });
  let end;
  while ((end = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    const command = JSON.parse(line);
    let value;
    switch (command.method) {
      case "open":
        value = { timezone: "UTC", proxy: "" };
        break;
      case "generate":
        requests.set(command.requestId, { status: false, chunks: 0, start: Date.now(), done: false });
        value = true;
        break;
      case "poll": {
        if (mode === "hang") continue;
        const state = requests.get(command.requestId);
        if (!state) throw new Error("Unknown request");
        if (mode === "empty") {
          value = { status: 200, headers: [], chunks: [], done: false, error: "" };
          break;
        }
        if (!state.status) {
          state.status = true;
          value = { status: 200, headers: [], chunks: [], done: false, error: "" };
          break;
        }
        if (state.done) {
          value = { status: 200, headers: [], chunks: [], done: true, error: "" };
          break;
        }
        const due = Math.floor((Date.now() - state.start) / 300);
        if (due <= state.chunks) {
          value = { status: 200, headers: [], chunks: [], done: false, error: "" };
          break;
        }
        state.chunks++;
        state.done = state.chunks >= total;
        value = {
          status: 200,
          headers: [],
          chunks: [Buffer.from("x").toString("base64")],
          done: state.done,
          error: "",
        };
        break;
      }
      case "cancel":
        requests.delete(command.requestId);
        value = true;
        break;
      default:
        throw new Error("Unknown command");
    }
    process.stdout.write(JSON.stringify({ id: command.id, value }) + "\\n");
  }
}
`;

const encode = (): EncodedRequest => ({ upstreamMethod: "GenerateContent", body: [], proofIndex: 4 });

const fakeWorkerFor = (mode: string) => fakeWorker.replace("__MODE__", JSON.stringify(mode));

async function clientFor(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "magpie-studio-client-"));
  const worker = join(root, "worker.mjs");
  await writeFile(worker, fakeWorkerFor(mode));
  const client = new StudioClient(
    { version: 1, profile: join(root, "profile"), accountId: "fixture" },
    { timeoutMs: 1000 },
    worker,
  );
  return {
    client,
    async close() {
      await client.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("generation rejects with TimeoutError when the worker stops answering", async () => {
  const { client, close } = await clientFor("hang");
  try {
    await expect(client.generate("", {}, encode)).rejects.toMatchObject({
      name: "TimeoutError",
      message: "The operation timed out after 1000ms",
    });
  } finally {
    await close();
  }
}, 10_000);

test("a stream errors with TimeoutError after headers when no data arrives", async () => {
  const { client, close } = await clientFor("empty");
  try {
    const response = await client.generate("", {}, encode);
    await expect(response.body!.getReader().read()).rejects.toMatchObject({
      name: "TimeoutError",
      message: "The operation timed out after 1000ms",
    });
  } finally {
    await close();
  }
}, 10_000);

test("regular stream data renews the idle timeout", async () => {
  const { client, close } = await clientFor("stream");
  try {
    const response = await client.generate("", {}, encode);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toBe("x".repeat(12));
  } finally {
    await close();
  }
}, 10_000);

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioClient } from "../src/client.ts";
import { type EncodedRequest, parseModels } from "../src/protocol.ts";
import { providerFetch, providerModels } from "../src/provider.ts";

const model = "gemini-3.8-flash";
const catalog = parseModels([
  [[`models/${model}`, null, null, "Playground Flash", null, 4096, 1024, ["generateContent"]]],
]);

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
      case "models":
        value = ${JSON.stringify(catalog)};
        break;
      case "GenerateContent":
        requests.set(command.requestId, { command, status: false, chunks: 0, start: Date.now(), done: false });
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
        if (mode === "catalog") {
          const { body, binding } = state.command;
          const [model, contents, , config, , , tools] = body;
          if (model !== "models/gemini-3.8-flash" || config[3] !== 1024 ||
              binding !== "Fixture AA==" || contents[0][0][1][2][0] !== "image/png" ||
              config[8][6][0][0] !== "answer" || !tools[0][3])
            throw new Error("Expected a Playground generation with image, schema, and search");
          const content = [[[null, "OK"]], "model"];
          const frame = [[[content, 1, 0]], null, [6, 1, 7]];
          const wire = [[frame]];
          value = { status: 200, headers: [], chunks: [Buffer.from(JSON.stringify(wire)).toString("base64")], done: true };
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

const encode = (): EncodedRequest => ({ body: [], binding: "" });

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

test("catalog and generation use Playground for requests with tools, schema, and media", async () => {
  const { client, close } = await clientFor("catalog");
  const fetch = providerFetch(client);
  const generate = (model: string, method = "generateContent") =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}`, {
      method: "POST",
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Fixture" }, { inlineData: { mimeType: "image/png", data: "AA==" } }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: { type: "object", properties: { answer: { type: "string" } } },
        },
      }),
    });
  try {
    const unary = await generate("gemini-3.8-flash");
    expect({ status: unary.status, body: await unary.json() }).toMatchObject({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] },
    });
    const models = await providerModels(client);
    expect(Object.keys(models)).toEqual(["gemini-3.8-flash"]);
    expect(models["gemini-3.8-flash"].name).toBe("Playground Flash");
    expect(models["gemini-3.8-flash"]).not.toHaveProperty("defaults");
    expect(Object.hasOwn(models, Symbol.for("magpie.fellBack"))).toBe(false);
    const stream = await generate("gemini-3.8-flash", "streamGenerateContent");
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const events = await stream.text();
    expect(events).toContain('"text":"OK"');
    expect(events).toContain('"finishReason":"STOP"');
    for (const id of ["gemini-4-hydrogen", "constructor"]) {
      const missing = await generate(id);
      expect((await missing.json()).error.message).toContain("not available for generation");
    }
  } finally {
    await close();
  }
});

test("generation rejects with TimeoutError when the worker stops answering", async () => {
  const { client, close } = await clientFor("hang");
  try {
    await expect(client.generate(model, encode)).rejects.toMatchObject({
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
    const response = await client.generate(model, encode);
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
    const response = await client.generate(model, encode);
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

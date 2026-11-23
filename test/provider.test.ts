import { expect, test } from "bun:test";
import plugin from "../index.ts";
import { parseModels, type Wire } from "../src/protocol.ts";
import { providerFetch, providerModels, type Transport } from "../src/provider.ts";

const root = JSON.stringify([
  [
    [[[[[[null, "你好"]], "model"]]]],
    [
      [[null, 1]],
      null,
      [17, 2, 24, null, null, null, null, 1, null, 4],
      null,
      null,
      null,
      null,
      "fixture-response",
    ],
  ],
]);
const base = "https://generativelanguage.googleapis.com/v1beta/models/fixture:";
const request = { contents: [{ role: "user", parts: [{ text: "Hello" }] }] };
const transport: Transport = {
  async models() {
    return {};
  },
  async countTokens() {
    throw new Error("Unexpected token count request");
  },
  async generate(_model, encode, signal) {
    signal?.throwIfAborted();
    const encoded = encode([], "Asia/Shanghai");
    expect(encoded.body[0]).toBe("models/fixture");
    expect(encoded.binding).toBe("Hello");
    return new Response(root);
  },
};

test("plugin exports the Magpie server and preserves existing provider configuration", async () => {
  const hooks = await plugin.server({});
  const config = { provider: { "google-ai-studio": { name: "Custom" } } };
  hooks.config(config);
  expect(config.provider["google-ai-studio"].name).toBe("Custom");
  expect(config.provider["google-ai-studio"]).toMatchObject({
    npm: "@ai-sdk/google",
    api: "https://generativelanguage.googleapis.com/v1beta",
  });
  expect(hooks.auth.provider).toBe("google-ai-studio");
  expect(hooks.auth.methods.map((m) => m.type)).toEqual(["oauth", "oauth", "oauth", "oauth"]);
  const importing = await hooks.auth.methods[1].authorize({
    path: `/missing-${crypto.randomUUID()}.json`,
  });
  expect(importing.method).toBe("auto");
  expect(importing.url).toBe("");
  expect(importing.opened).toBe(true);
  expect(await importing.callback()).toMatchObject({ type: "failed" });
  const textImport = await hooks.auth.methods[3].authorize({ payload: "invalid-migration-text" });
  expect(await textImport.callback()).toMatchObject({ type: "failed" });
});

test("provider lists Playground chat and image models with their capabilities", async () => {
  const row = (id: string, codes: number[], methods = ["generateContent"]) => {
    const model: Wire = Array(65).fill(null);
    model[0] = `models/${id}`;
    model[3] = id;
    model[5] = 131072;
    model[6] = 8192;
    model[7] = methods;
    model[64] = codes;
    return model;
  };
  const models = await providerModels({
    ...transport,
    async models() {
      return parseModels([
        [
          row("chat", [10]),
          row("gemini-multimodal", [1]),
          row("speech", [37]),
          row("image", [21]),
          row("embed", [], ["embedContent"]),
          row("live", [26]),
        ],
      ]);
    },
  });
  expect(Object.keys(models)).toEqual(["chat", "gemini-multimodal", "image"]);
  expect(models.chat).toMatchObject({ capabilities: { output: { text: true } } });
  expect(models["gemini-multimodal"]).toMatchObject({
    modalities: { input: ["text", "image", "audio", "video", "pdf"], output: ["text"] },
    api: { id: "gemini-multimodal", npm: "@ai-sdk/google" },
  });
  expect(models.image).toMatchObject({ capabilities: { output: { text: true, image: true } } });
});

test("malformed contents are rejected before resolving a generation route", async () => {
  let generationAttempts = 0;
  const fetch = providerFetch({
    ...transport,
    async generate() {
      generationAttempts++;
      throw new Error("Catalog unavailable");
    },
  });
  for (const method of ["generateContent", "streamGenerateContent"]) {
    for (const tools of [undefined, [{ googleSearch: {} }]]) {
      for (const [contents, error] of [
        [[{ parts: [] }], "content.parts cannot be empty"],
        [[{ parts: [null] }], "part must be an object"],
        [[{ parts: [{}] }], "part cannot be empty"],
        [[{ parts: [{ text: 1 }] }], "part.text must be a string"],
      ] as const) {
        const response = await fetch(`${base}${method}`, {
          method: "POST",
          body: JSON.stringify({ contents, tools }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error.message).toContain(error);
      }
    }
  }
  expect(generationAttempts).toBe(0);
});

test("Gemini fetch returns SSE chunks and aggregates the same unary response", async () => {
  const fetch = providerFetch(transport);
  const stream = await fetch(`${base}streamGenerateContent?alt=sse`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  const frames = (await stream.text())
    .trim()
    .split("\n\n")
    .map((s) => JSON.parse(s.slice(6)));
  expect(frames[0].candidates[0].content.parts).toEqual([{ text: "你好" }]);
  expect(frames.at(-1).candidates[0].finishReason).toBe("STOP");
  const unary = await fetch(
    new Request(`${base}generateContent`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
  const body = await unary.json();
  expect(body.candidates[0].content.parts).toEqual([{ text: "你好" }]);
  expect(body.responseId).toBe("fixture-response");
  expect(body.usageMetadata.promptTokenCount).toBe(17);
});

test("Magpie thinking levels work for Playground requests", async () => {
  for (const [level, code] of [
    ["low", 1],
    ["medium", 2],
    ["high", 3],
    ["minimal", 4],
    ["LOW", 1],
  ] as const) {
    const fetch = providerFetch({
      ...transport,
      async generate(_model, encode) {
        const encoded = encode([], "UTC");
        expect((encoded.body[3] as Wire)[16]).toEqual([1, null, null, code]);
        return new Response(root);
      },
    });
    const response = await fetch(`${base}streamGenerateContent`, {
      method: "POST",
      body: JSON.stringify({
        ...request,
        generationConfig: {
          maxOutputTokens: 16384,
          thinkingConfig: { thinkingLevel: level, includeThoughts: true },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"finishReason":"STOP"');
  }
});

test("Playground rejects invalid generation settings before contacting Google", async () => {
  const fetch = providerFetch({
    ...transport,
    async generate() {
      throw new Error("Invalid input must not reach Google");
    },
  });
  for (const tools of [undefined, [{ googleSearch: {} }]]) {
    for (const [generationConfig, message] of [
      [{ temperature: -0.01 }, "temperature"],
      [{ temperature: 2.01 }, "temperature"],
      [{ temperature: "2" }, "temperature"],
      [{ thinkingConfig: { thinkingBudget: 0, thinkingLevel: "low" } }, "mutually exclusive"],
      [{ speechConfig: {} }, "speechConfig"],
    ] as const) {
      for (const method of ["generateContent", "streamGenerateContent"]) {
        const response = await fetch(`${base}${method}`, {
          method: "POST",
          body: JSON.stringify({ ...request, generationConfig, tools }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toMatchObject({
          status: "INVALID_ARGUMENT",
          message: expect.stringContaining(message),
        });
      }
    }
  }
  for (const mode of [undefined, "AUTO", "NONE"]) {
    const response = await fetch(`${base}generateContent`, {
      method: "POST",
      body: JSON.stringify({
        ...request,
        toolConfig: { functionCallingConfig: { mode, allowedFunctionNames: ["choose"] } },
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("allowedFunctionNames requires mode ANY");
  }
  for (const mode of ["ANY", "VALIDATED"]) {
    const response = await fetch(`${base}generateContent`, {
      method: "POST",
      body: JSON.stringify({ ...request, toolConfig: { functionCallingConfig: { mode } } }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("unsupported functionCallingConfig.mode");
  }
});

test("Playground preserves temperature boundaries and gives explicit thinking settings precedence", async () => {
  const defaults: Wire = Array(72).fill(null);
  defaults[64] = [52];
  defaults[71] = [null, null, null, null, null, 2, [4, 2]];
  for (const [temperature, thinkingConfig, expected] of [
    [0, { thinkingBudget: 0 }, [1, 0]],
    [2, { thinkingBudget: -1 }, [1, -1]],
    [1, { thinkingBudget: 10_000 }, [1, 10_000]],
    [1, { thinkingLevel: "minimal" }, [1, null, null, 4]],
    [1, undefined, [1, null, null, 2]],
  ] as const) {
    const fetch = providerFetch({
      ...transport,
      async generate(_model, encode) {
        const config = encode(defaults, "UTC").body[3] as Wire;
        expect(config[4]).toBe(temperature);
        expect(config[16]).toEqual([...expected]);
        return new Response(root);
      },
    });
    const response = await fetch(`${base}generateContent`, {
      method: "POST",
      body: JSON.stringify({
        ...request,
        generationConfig: { temperature, thinkingConfig },
        toolConfig: { functionCallingConfig: { mode: "AUTO", allowedFunctionNames: [] } },
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).candidates[0].finishReason).toBe("STOP");
  }
});

test("Gemini fetch rejects unsupported input locally and retains upstream HTTP errors", async () => {
  const fetch = providerFetch(transport);
  expect((await fetch(`${base}generateContent`)).status).toBe(405);
  expect(
    (
      await fetch(`${base}generateContent`, {
        method: "POST",
        body: "bad json",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${base}generateContent`, {
        method: "POST",
        body: JSON.stringify({ ...request, cachedContent: "cachedContents/x" }),
      })
    ).status,
  ).toBe(400);
  const failure = providerFetch({
    ...transport,
    async generate() {
      return new Response("private protobuf error", { status: 429 });
    },
  });
  const response = await failure(`${base}generateContent`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(429);
  expect((await response.json()).error).toMatchObject({
    status: "RESOURCE_EXHAUSTED",
    message: expect.stringContaining("private protobuf error"),
  });
});

test("generation and token counting preserve raw error bodies and HTTP status", async () => {
  for (const [status, body] of [
    [400, '{\n  "diagnostic": {"原因": "未知参数", "fields": ["temperature"]}\n}\n'],
    [429, '[8,"Quota exceeded",[{"retryAfter":30}]]'],
    [403, '[null,[7,"Model access denied"],{"context":"fixture"}]'],
    [502, "<!doctype html><html><body>Bad gateway</body></html>"],
    [400, '{"error":'],
    [400, "  Plain-text error\nwith context\n"],
  ] as const) {
    const fetch = providerFetch({
      ...transport,
      async generate() {
        return new Response(body, { status });
      },
      async countTokens() {
        return new Response(body, { status });
      },
    });
    for (const [url, input] of [
      [`${base}generateContent`, request],
      [`${base}streamGenerateContent`, { ...request, tools: [{ googleSearch: {} }] }],
      [`${base}countTokens`, request],
    ] as const) {
      const response = await fetch(url, { method: "POST", body: JSON.stringify(input) });
      expect(response.status).toBe(status);
      expect((await response.json()).error).toMatchObject({
        code: status,
        message: `Google AI Studio returned HTTP ${status}: ${body}`,
      });
    }
  }
});

test("empty or unreadable upstream error bodies retain HTTP status", async () => {
  for (const body of [
    null,
    "",
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("upstream connection lost"));
      },
    }),
  ]) {
    const fetch = providerFetch({
      ...transport,
      async generate() {
        return new Response(body, { status: 400 });
      },
    });
    const response = await fetch(`${base}generateContent`, { method: "POST", body: JSON.stringify(request) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Google AI Studio returned HTTP 400");
  }
});

test("raw errors keep an 8 KiB prefix and mark truncation without waiting for EOF", async () => {
  for (const length of [8191, 8192, 8193]) {
    const body = "x".repeat(length);
    const fetch = providerFetch({
      ...transport,
      async generate() {
        return new Response(body, { status: 400 });
      },
    });
    const response = await fetch(`${base}generateContent`, { method: "POST", body: JSON.stringify(request) });
    expect((await response.json()).error.message).toBe(
      `Google AI Studio returned HTTP 400: ${"x".repeat(Math.min(length, 8192))}${length > 8192 ? "\n[truncated]" : ""}`,
    );
  }
  let cancelled = false;
  const fetch = providerFetch({
    ...transport,
    async generate() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${"x".repeat(8191)}中tail`));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 400 },
      );
    },
  });
  const response = await fetch(`${base}generateContent`, { method: "POST", body: JSON.stringify(request) });
  expect((await response.json()).error.message).toBe(
    `Google AI Studio returned HTTP 400: ${"x".repeat(8191)}\n[truncated]`,
  );
  expect(cancelled).toBe(true);
});

test("a truncated stream emits an error instead of a successful finish", async () => {
  const fetch = providerFetch({
    ...transport,
    async generate() {
      return new Response("[[");
    },
  });
  const response = await fetch(`${base}streamGenerateContent`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  const text = await response.text();
  expect(text).toContain('"code":502');
  expect(text).not.toContain('"finishReason":"STOP"');
});

test("timeouts surface as 504 DEADLINE_EXCEEDED", async () => {
  const timeout = () => new DOMException("The operation timed out after 1000ms", "TimeoutError");
  const fetch = providerFetch({
    ...transport,
    async generate() {
      throw timeout();
    },
  });
  const response = await fetch(`${base}generateContent`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(504);
  expect((await response.json()).error).toMatchObject({
    code: 504,
    status: "DEADLINE_EXCEEDED",
    message: "The operation timed out after 1000ms",
  });
  const streamFetch = providerFetch({
    ...transport,
    async generate() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(timeout());
          },
        }),
      );
    },
  });
  const stream = await streamFetch(`${base}streamGenerateContent`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  const frames = (await stream.text())
    .trim()
    .split("\n\n")
    .map((frame) => JSON.parse(frame.slice(6)));
  expect(frames.at(-1).error).toMatchObject({
    code: 504,
    status: "DEADLINE_EXCEEDED",
    message: "The operation timed out after 1000ms",
  });
});

test("cancelling Gemini output aborts a pending upstream read", async () => {
  let aborted = false;
  const fetch = providerFetch({
    ...transport,
    async generate(_model, _encode, signal) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("[["));
            signal!.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(signal!.reason);
              },
              { once: true },
            );
          },
        }),
      );
    },
  });
  const response = await fetch(`${base}streamGenerateContent`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  const reader = response.body!.getReader();
  const pending = reader.read();
  await reader.cancel();
  expect(await pending).toEqual({ value: undefined, done: true });
  expect(aborted).toBe(true);
});

test("NONE disables user functions while retaining Playground search", async () => {
  const fetch = providerFetch({
    ...transport,
    async generate(_model, encode) {
      expect(encode([], "UTC").body[6]).toEqual([[null, null, null, [null, [[]]]]]);
      return new Response(root);
    },
  });
  const response = await fetch(`${base}generateContent`, {
    method: "POST",
    body: JSON.stringify({
      ...request,
      tools: [{ functionDeclarations: [{ name: "disabled" }] }, { googleSearch: {} }],
      toolConfig: { functionCallingConfig: { mode: "NONE" } },
    }),
  });
  expect(response.status).toBe(200);
});

test("embedding endpoints are rejected while native token counting still works", async () => {
  let counts = 0;
  const fetch = providerFetch({
    ...transport,
    async generate() {
      throw new Error("Unexpected generation");
    },
    async countTokens(body) {
      counts++;
      expect(body.slice(0, 2)).toEqual(["models/fixture", null]);
      expect((body[2] as Wire)[1]).toEqual([[[[null, "Hello"]], "user"]]);
      return new Response("[17]");
    },
  });
  for (const url of [
    "https://generativelanguage.googleapis.com/v1/embeddings",
    "https://generativelanguage.googleapis.com/v1beta/embeddings",
    `${base}embedContent`,
    `${base}batchEmbedContents`,
  ]) {
    const response = await fetch(url, { method: "POST" });
    expect(response.status).toBe(404);
  }
  expect(counts).toBe(0);
  for (const body of [request, { generateContentRequest: { ...request, model: "models/fixture" } }]) {
    const response = await fetch(`${base}countTokens`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ totalTokens: 17 });
  }
  expect(counts).toBe(2);
});

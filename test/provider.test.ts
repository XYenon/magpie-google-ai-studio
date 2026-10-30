import { expect, test } from "bun:test";
import plugin from "../index.ts";
import type { Wire } from "../src/protocol.ts";
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
    return [];
  },
  async generate(_model, _request, encode, signal) {
    signal?.throwIfAborted();
    const encoded = encode(undefined, "Asia/Shanghai");
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

test("provider declares model outputs so Magpie can separate chat from embeddings and TTS", async () => {
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
      return [
        [
          row("chat", [10]),
          row("gemini-multimodal", [1]),
          row("speech", [37]),
          row("image", [21]),
          row("embed", [], ["embedContent"]),
          row("live", [26]),
        ],
      ];
    },
    async buildModels() {
      return [
        {
          name: "models/build-embed",
          displayName: "Build Embedding",
          inputTokenLimit: 2048,
          supportedGenerationMethods: ["embedContent", "batchEmbedContents"],
        },
        { name: "models/build-chat", supportedGenerationMethods: ["generateContent"] },
      ];
    },
  });
  expect(Object.keys(models)).toEqual(["chat", "gemini-multimodal", "speech", "image", "build-embed"]);
  expect(models["gemini-multimodal"]).toMatchObject({
    modalities: { input: ["text", "image", "audio", "video", "pdf"], output: ["text"] },
    api: { id: "gemini-multimodal", npm: "@ai-sdk/google" },
  });
  expect(models.speech).toMatchObject({
    capabilities: { output: { text: false, audio: true } },
    modalities: { input: ["text"], output: ["audio"] },
    api: { id: "speech", npm: "@ai-sdk/google" },
  });
  expect(models.image).toMatchObject({
    capabilities: { output: { text: true, image: true } },
    modalities: { output: ["text", "image"] },
  });
  expect(models["build-embed"]).toMatchObject({
    id: "build-embed",
    name: "Build Embedding",
    limit: { context: 2048, output: 0 },
    capabilities: {
      reasoning: false,
      toolcall: false,
      attachment: false,
      input: { text: true },
      output: { text: false },
    },
    modalities: { input: ["text"], output: [] },
    api: { id: "build-embed", npm: "@ai-sdk/google" },
  });
});

test("provider retains the Playground catalog when the Build catalog is unavailable", async () => {
  const row: Wire = Array(65).fill(null);
  row[0] = "models/chat";
  row[3] = "Chat";
  row[5] = 131072;
  row[6] = 8192;
  row[7] = ["generateContent"];
  const unavailable = (status: number) => async () => {
    throw Object.assign(new Error("Build catalog unavailable"), { status });
  };
  for (const buildModels of [undefined, unavailable(403), unavailable(404)]) {
    const models = await providerModels({
      ...transport,
      async models() {
        return [[row]];
      },
      buildModels,
    });
    expect(Object.keys(models)).toEqual(["chat"]);
    expect(models.chat).toMatchObject({
      name: "Chat",
      api: { id: "chat", npm: "@ai-sdk/google" },
    });
  }
});

test("provider propagates unexpected Build catalog failures", async () => {
  const row: Wire = ["models/chat", null, null, "Chat", null, 131072, 8192, ["generateContent"]];
  for (const error of [
    new SyntaxError("Malformed Build JSON"),
    new Error("Invalid Build model catalog"),
    new Error("Build catalog pagination exceeded"),
    Object.assign(new Error("Session expired"), { status: 401, signIn: "expired" }),
    Object.assign(new Error("Rate limited"), { status: 429 }),
    Object.assign(new Error("Server failure"), { status: 500 }),
  ]) {
    await expect(
      providerModels({
        ...transport,
        async models() {
          return [[row]];
        },
        async buildModels() {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  }
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

test("Magpie thinking levels work for Playground and Build requests", async () => {
  for (const [level, native, code] of [
    ["low", "LOW", 1],
    ["medium", "MEDIUM", 2],
    ["high", "HIGH", 3],
    ["minimal", "MINIMAL", 4],
    ["LOW", "LOW", 1],
  ] as const) {
    for (const build of [false, true]) {
      const fetch = providerFetch({
        ...transport,
        async call() {
          throw new Error("unused");
        },
        async generate(_model, _request, encode) {
          const encoded = encode(undefined, "UTC");
          if (!build) {
            expect((encoded.body[3] as Wire)[16]).toEqual([1, null, null, code]);
            return new Response(root);
          }
          const sent = JSON.parse(String(encoded.body[1]));
          expect(sent.generationConfig.thinkingConfig).toEqual({
            thinkingLevel: native,
            includeThoughts: true,
          });
          expect(sent.generationConfig.maxOutputTokens).toBe(16384);
          const reply = { candidates: [{ finishReason: "STOP" }] };
          return new Response(JSON.stringify([[[JSON.stringify(reply)]]]));
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
          ...(build ? { tools: [{ googleSearch: {} }] } : {}),
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"finishReason":"STOP"');
    }
  }
});

test("Playground and Build reject invalid generation settings before contacting Google", async () => {
  const fetch = providerFetch({
    ...transport,
    async call() {
      throw new Error("Invalid input must not reach Google");
    },
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
});

test("both routes preserve temperature boundaries and automatic or zero thinking budgets", async () => {
  for (const build of [false, true]) {
    for (const [temperature, thinkingBudget] of [
      [0, 0],
      [2, -1],
    ]) {
      const generationConfig = { temperature, thinkingConfig: { thinkingBudget } };
      const fetch = providerFetch({
        ...transport,
        async call() {
          throw new Error("unused");
        },
        async generate(_model, _request, encode) {
          const encoded = encode(undefined, "UTC");
          if (!build) {
            expect((encoded.body[3] as Wire)[4]).toBe(temperature);
            expect(((encoded.body[3] as Wire)[16] as Wire)[1]).toBe(thinkingBudget);
            return new Response(root);
          }
          const sent = JSON.parse(String(encoded.body[1]));
          expect(sent.generationConfig).toEqual(generationConfig);
          expect(sent.toolConfig.functionCallingConfig).toEqual({ mode: "AUTO", allowedFunctionNames: [] });
          return new Response(JSON.stringify([JSON.stringify({ candidates: [{ finishReason: "STOP" }] })]));
        },
      });
      const response = await fetch(`${base}generateContent`, {
        method: "POST",
        body: JSON.stringify({
          ...request,
          generationConfig,
          ...(build
            ? { toolConfig: { functionCallingConfig: { mode: "AUTO", allowedFunctionNames: [] } } }
            : {}),
        }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).candidates[0].finishReason).toBe("STOP");
    }
  }
});

test("Gemini fetch rejects unsupported input locally and retains upstream HTTP errors", async () => {
  const fetch = providerFetch(transport);
  expect((await fetch(`${base}generateContent`)).status).toBe(405);
  expect((await fetch(`${base}countTokens`, { method: "POST" })).status).toBe(404);
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

test("generation and auxiliary endpoints preserve raw error bodies and HTTP status", async () => {
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
      async call() {
        return new Response(body, { status });
      },
    });
    for (const [url, input] of [
      [`${base}generateContent`, request],
      [`${base}streamGenerateContent`, { ...request, tools: [{ googleSearch: {} }] }],
      [`${base}countTokens`, request],
      ["https://generativelanguage.googleapis.com/v1beta/embeddings", { model: "embed", input: "hello" }],
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

test("Build JSON errors remain visible for unary and streaming generation", async () => {
  const body = '{"error":{"message":"Invalid function declaration","details":[{"field":"name"}]}}';
  for (const method of ["generateContent", "streamGenerateContent"]) {
    const fetch = providerFetch({
      ...transport,
      async call() {
        throw new Error("unused");
      },
      async generate() {
        const wire = [body];
        return new Response(JSON.stringify(method === "generateContent" ? wire : [[wire]]));
      },
    });
    const response = await fetch(`${base}${method}`, {
      method: "POST",
      body: JSON.stringify({ ...request, tools: [{ googleSearch: {} }] }),
    });
    if (method === "generateContent")
      expect((await response.json()).error.message).toBe(`AI Studio Build: ${body}`);
    else {
      const events = (await response.text()).trim().split("\n\n");
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].slice(6)).error.message).toBe(`AI Studio Build: ${body}`);
    }
  }
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

test("cancelling Gemini output aborts a pending upstream read", async () => {
  let aborted = false;
  const fetch = providerFetch({
    ...transport,
    async generate(_model, _request, _encode, signal) {
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

test("Build preserves native tools, JSON Schema constraints, media, and response metadata", async () => {
  const schema = {
    type: "object",
    properties: { n: { $ref: "#/$defs/n" } },
    required: ["n"],
    additionalProperties: false,
    $defs: { n: { type: "integer", minimum: 7 } },
  };
  const reply = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: { name: "choose", args: { n: 7 }, id: "call-1" },
              thoughtSignature: "signature",
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { totalTokenCount: 19 },
    modelVersion: "native-version",
  };
  const fetch = providerFetch({
    ...transport,
    async call() {
      throw new Error("unused");
    },
    async generate(_model, _request, encode) {
      const sent = JSON.parse(String(encode(undefined, "UTC").body[1]));
      expect(sent.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(schema);
      expect(sent.toolConfig.functionCallingConfig).toEqual({
        mode: "ANY",
        allowedFunctionNames: ["choose"],
      });
      expect(sent.generationConfig.responseFormat.text.schema).toEqual(schema);
      expect(sent.contents[0].parts[1]).toEqual({
        inlineData: { mimeType: "image/png", data: "AA==" },
      });
      return new Response(JSON.stringify([JSON.stringify(reply)]));
    },
  });
  const response = await fetch(`${base}generateContent`, {
    method: "POST",
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "Call choose" }, { inlineData: { mimeType: "image/png", data: "AA==" } }],
        },
      ],
      tools: [
        {
          functionDeclarations: [{ name: "choose", parametersJsonSchema: schema }],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: ["choose"],
        },
      },
      generationConfig: { responseJsonSchema: schema },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(reply);
});

test("NONE disables user functions while retaining built-in tool settings", async () => {
  const fetch = providerFetch({
    ...transport,
    async call() {
      throw new Error("unused");
    },
    async generate(_model, _request, encode) {
      const sent = JSON.parse(String(encode(undefined, "UTC").body[1]));
      expect(sent.tools).toEqual([{ googleMaps: {} }]);
      expect(sent.toolConfig).toEqual({ retrievalConfig: { latLng: { latitude: 48.86, longitude: 2.35 } } });
      return new Response(JSON.stringify([JSON.stringify({ candidates: [{ finishReason: "STOP" }] })]));
    },
  });
  const response = await fetch(`${base}generateContent`, {
    method: "POST",
    body: JSON.stringify({
      ...request,
      tools: [{ functionDeclarations: [{ name: "disabled" }] }, { googleMaps: {} }],
      toolConfig: {
        functionCallingConfig: { mode: "NONE" },
        retrievalConfig: { latLng: { latitude: 48.86, longitude: 2.35 } },
      },
    }),
  });
  expect(response.status).toBe(200);
});

test("Build rejects empty generation but preserves explicit blocking feedback", async () => {
  for (const blocked of [false, true]) {
    const reply = blocked
      ? { promptFeedback: { blockReason: "SAFETY" } }
      : { usageMetadata: { totalTokenCount: 18 } };
    const fetch = providerFetch({
      ...transport,
      async call() {
        throw new Error("unused");
      },
      async generate() {
        return new Response(JSON.stringify([JSON.stringify(reply)]));
      },
    });
    const response = await fetch(`${base}generateContent`, {
      method: "POST",
      body: JSON.stringify({ ...request, tools: [{ googleSearch: {} }] }),
    });
    expect(response.status).toBe(blocked ? 200 : 502);
    const result = await response.json();
    if (blocked) expect(result).toEqual(reply);
    else expect(result.error.message).toContain("no candidates");
  }
});

test("Build SSE preserves native frames and rejects a missing terminal candidate", async () => {
  const frames = [
    {
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: "first" }] } }],
    },
    {
      candidates: [{ index: 0, finishReason: "STOP" }],
      usageMetadata: { totalTokenCount: 11 },
    },
  ];
  for (const complete of [true, false]) {
    const fetch = providerFetch({
      ...transport,
      async call() {
        throw new Error("unused");
      },
      async generate() {
        return new Response(
          JSON.stringify([(complete ? frames : frames.slice(0, 1)).map((frame) => [JSON.stringify(frame)])]),
        );
      },
    });
    const response = await fetch(`${base}streamGenerateContent`, {
      method: "POST",
      body: JSON.stringify({ ...request, tools: [{ codeExecution: {} }] }),
    });
    const chunks = (await response.text())
      .trim()
      .split("\n\n")
      .map((value) => JSON.parse(value.slice(6)));
    expect(chunks[0]).toEqual(frames[0]);
    if (complete) expect(chunks).toEqual(frames);
    else expect(chunks.at(-1).error.code).toBe(502);
  }
});

test("embedding batches preserve order, dimensions, float encoding, and input errors", async () => {
  const fetch = providerFetch({
    ...transport,
    async call(_method, body) {
      const input = JSON.parse(String(body[1]));
      if (input.requests.length > 100) return new Response("too many", { status: 400 });
      return new Response(
        JSON.stringify([
          JSON.stringify({
            embeddings: input.requests.map(
              (item: { content: { parts: { text: string }[] }; outputDimensionality: number }) => ({
                values: [Number(item.content.parts[0].text), -item.outputDimensionality],
              }),
            ),
            tokenCount: input.requests.length,
          }),
        ]),
      );
    },
  });
  const input = Array.from({ length: 101 }, (_, index) => String(index + 1));
  for (const encoding of ["float", "base64"]) {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/embeddings", {
      method: "POST",
      body: JSON.stringify({
        model: "embed",
        input,
        dimensions: 2,
        encoding_format: encoding,
      }),
    });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.usage).toEqual({ prompt_tokens: 101, total_tokens: 101 });
    expect(result.data.length).toBe(101);
    expect(result.data.map((item: { index: number }) => item.index)).toEqual(input.map((_, index) => index));
    const last = result.data.at(-1).embedding;
    expect(
      encoding === "float"
        ? last
        : [Buffer.from(last, "base64").readFloatLE(0), Buffer.from(last, "base64").readFloatLE(4)],
    ).toEqual([101, -2]);
  }
  for (const invalid of [
    { input: [] },
    { input: "hi", dimensions: 0 },
    { input: "hi", encoding_format: "unknown" },
  ]) {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "embed", ...invalid }),
    });
    expect(response.status).toBe(400);
  }
});

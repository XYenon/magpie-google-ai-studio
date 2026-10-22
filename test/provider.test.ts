import { expect, test } from "bun:test";
import plugin from "../index.ts";
import { providerFetch, type Transport } from "../src/provider.ts";

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
  expect((await response.json()).error.status).toBe("RESOURCE_EXHAUSTED");
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

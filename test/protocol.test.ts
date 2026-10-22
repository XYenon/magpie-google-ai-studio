import { expect, test } from "bun:test";
import {
  aggregateGenerate,
  decodeGenerateStream,
  encodeGenerateRequest,
  parseModels,
  parseSparseJSON,
  type Wire,
} from "../src/protocol.ts";

const contents = [{ role: "user", parts: [{ text: "Hello" }] }];
const textFrame = [[[[[[null, '你😀好 ],\\"[,x']], "model"]]]];
const finishFrame = [[[null, 1, 0]], null, [9, 3, 14, null, null, null, null, 0, null, 2]];

function byteStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
      c.close();
    },
  });
}

test("request indices and WAA binding preserve roles, media, and empty function bindings", () => {
  const defaults: Wire = Array(72).fill(null);
  defaults[6] = 8192;
  defaults[8] = 0.75;
  defaults[9] = 0.8;
  defaults[10] = 32;
  defaults[64] = [10, 25, 52];
  defaults[71] = [null, null, null, null, null, 3, [1, 3]];
  const encoded = encodeGenerateRequest(
    "fixture",
    {
      contents: [
        {
          role: "user",
          parts: [{ text: "first" }, { inlineData: { mimeType: "image/png", data: "AQI=" } }],
        },
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "lookup", args: {} },
              thoughtSignature: "signed",
            },
          ],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "lookup", response: { result: 0 } } }, { text: "last" }],
        },
      ],
      systemInstruction: { parts: [{ text: "DO NOT BIND ME" }] },
      generationConfig: {
        topP: 0.9,
        thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false },
      },
      safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }],
    },
    defaults,
    "Asia/Shanghai",
  );
  expect(encoded.binding).toBe("first AQI=   last");
  expect(encoded.body[0]).toBe("models/fixture");
  expect(encoded.body[2]).toEqual([[null, null, 7, 3]]);
  expect((encoded.body[3] as Wire).slice(3, 7)).toEqual([8192, 0.75, 0.9, 32]);
  expect((encoded.body[3] as Wire)[16]).toEqual([0, null, null, 1]);
  expect(encoded.body[4]).toBeNull(); // Only the browser may supply a fresh proof.
  expect(encoded.body[5]).toEqual([[[null, "DO NOT BIND ME"]], "user"]);
  expect(encoded.body[13]).toEqual([[null, null, "Asia/Shanghai"]]);
});

test("coding tool schemas retain full constraints and project nullable local references", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    $defs: { path: { type: "string", minLength: 2 } },
    properties: {
      path: { $ref: "#/$defs/path" },
      count: { anyOf: [{ type: "integer" }, { type: "null" }] },
    },
  };
  const tools = [
    {
      functionDeclarations: [{ name: "read", description: "Read a file", parameters: schema }],
    },
    { codeExecution: {} },
  ];
  const { body } = encodeGenerateRequest("fixture", { contents, tools }, [], "UTC");
  const declarations = ((body[6] as Wire)[0] as Wire)[1] as Wire[];
  expect(declarations[0][1]).toBe(
    `Read a file\nArguments must follow this JSON Schema: ${JSON.stringify(schema)}`,
  );
  const parameters = declarations[0][2] as Wire;
  expect(parameters[0]).toBe(6);
  expect(parameters[6]).toEqual([
    [
      "count",
      [
        3,
        null,
        null,
        true,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        [[3]],
      ],
    ],
    ["path", [1, null, null, null, null, null, null, null, null, null, null, null, 2]],
  ]);
  expect(body[13]).toEqual([[null, null, "UTC"], null, true]);
  const disabled = encodeGenerateRequest("fixture", {
    contents,
    tools,
    toolConfig: { functionCallingConfig: { mode: "NONE" } },
  });
  expect(disabled.body[6]).toEqual([[[]]]);
  expect(() =>
    encodeGenerateRequest("fixture", {
      contents,
      tools,
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    }),
  ).toThrow("unsupported functionCallingConfig.mode");
});

test("sparse protobuf and byte-fragmented Unicode stream decode without losing usage", async () => {
  expect(parseSparseJSON('[,0,,"[,],\\"",[false,,]]')).toEqual([null, 0, null, '[,],"', [false, null, null]]);
  const result = await aggregateGenerate(
    decodeGenerateStream(byteStream(JSON.stringify([[textFrame, finishFrame]]))),
  );
  expect(result.candidates).toEqual([
    {
      index: 0,
      content: { role: "model", parts: [{ text: '你😀好 ],\\"[,x' }] },
      finishReason: "STOP",
    },
  ]);
  expect(result.usageMetadata).toEqual({
    promptTokenCount: 9,
    candidatesTokenCount: 3,
    totalTokenCount: 14,
    toolUsePromptTokenCount: 0,
    thoughtsTokenCount: 2,
  });
});

test("complete frames arrive before EOF and missing finish or root fails", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encode = (s: string) => new TextEncoder().encode(s);
  const chunks = decodeGenerateStream(source);
  controller.enqueue(encode(`[[${JSON.stringify(textFrame)}`));
  const first = await chunks.next();
  expect(first.value?.candidates).toBeDefined();
  controller.enqueue(encode(`,${JSON.stringify(finishFrame)}]]`));
  controller.close();
  expect((await chunks.next()).value?.candidates).toEqual([{ index: 0, finishReason: "STOP" }]);
  expect((await chunks.next()).done).toBe(true);
  await expect(
    aggregateGenerate(decodeGenerateStream(byteStream(JSON.stringify([[textFrame]])))),
  ).rejects.toThrow("before finish frame");
  await expect(
    aggregateGenerate(decodeGenerateStream(byteStream(`[[${JSON.stringify(finishFrame)}`))),
  ).rejects.toThrow("truncated");
  for (const prefix of ["null", "[]"]) {
    await expect(
      aggregateGenerate(decodeGenerateStream(byteStream(`[${prefix},[429,"private error"]]`))),
    ).rejects.toThrow(`private RPC error: [${prefix},[429,"private error"]]`);
  }
});

test("function args preserve every Struct type, IDs, special keys, and thought signatures", async () => {
  const call: Wire = Array(15).fill(null);
  call[10] = [
    "lookup",
    [
      [
        ["zero", [null, 0]],
        ["false", [null, null, null, false]],
        ["null", [0]],
        [
          "list",
          [
            null,
            null,
            null,
            null,
            null,
            [
              [
                [null, null, "x"],
                [null, -2.5],
              ],
            ],
          ],
        ],
        ["__proto__", [null, null, null, null, [[["nested", [null, null, "safe"]]]]]],
      ],
    ],
    "call-7",
  ];
  call[14] = "opaque-signature";
  const frame = [[[[[call], "model"], 1, 0]]];
  const result = await aggregateGenerate(decodeGenerateStream(byteStream(JSON.stringify([[frame]]))));
  const candidates = result.candidates as {
    content: {
      parts: {
        functionCall: { name: string; id: string; args: unknown };
        thoughtSignature: string;
      }[];
    };
  }[];
  expect(JSON.parse(JSON.stringify(candidates[0].content.parts))).toEqual([
    {
      functionCall: {
        name: "lookup",
        id: "call-7",
        args: JSON.parse(
          '{"zero":0,"false":false,"null":null,"list":["x",-2.5],"__proto__":{"nested":"safe"}}',
        ),
      },
      thoughtSignature: "opaque-signature",
    },
  ]);
  const encoded = encodeGenerateRequest("fixture", {
    contents: [{ role: "model", parts: candidates[0].content.parts }],
  });
  const part = (((encoded.body[1] as Wire)[0] as Wire)[0] as Wire)[0] as Wire;
  expect(part[14]).toBe("opaque-signature");
  expect((part[10] as Wire)[2]).toBe("call-7");
  expect(Object.hasOwn({} as Record<string, unknown>, "nested")).toBe(false);
});

test("model listing uses account limits and excludes non-GenerateContent routes", () => {
  const model = (id: string, caps: number[], methods = ["generateContent"]) => {
    const row: Wire = Array(72).fill(null);
    row[0] = `models/${id}`;
    row[3] = id;
    row[5] = 131072;
    row[6] = 8192;
    row[7] = methods;
    row[64] = caps;
    row[71] = [null, null, null, null, null, 3, [1, 3]];
    return row;
  };
  const models = parseModels([
    [
      model("chat", [1, 10, 25, 52]),
      model("live", [26]),
      model("embed", [], ["embedContent"]),
      model("gemini-fixture", [1, 91]),
      model("speech", [37]),
    ],
  ]);
  expect(Object.keys(models)).toEqual(["chat", "gemini-fixture", "speech"]);
  expect(models.chat.limit).toEqual({ context: 131072, output: 8192 });
  expect(models.chat.variants).toEqual({
    low: { thinkingConfig: { thinkingLevel: "LOW" } },
    high: { thinkingConfig: { thinkingLevel: "HIGH" } },
  });
  expect(models.chat.capabilities).toMatchObject({
    reasoning: true,
    toolcall: true,
    input: { image: false },
  });
  expect(models["gemini-fixture"].modalities).toEqual({
    input: ["text", "image", "audio", "video", "pdf"],
    output: ["text"],
  });
  expect(models["gemini-fixture"].limit).toEqual({
    context: 131072,
    output: 131072,
  });
  expect(models.speech.modalities).toEqual({
    input: ["text"],
    output: ["audio"],
  });
});

test("continuation carries the opaque token, suppresses intermediate finishes, and merges usage", async () => {
  const defaults: Wire = Array(65).fill(null);
  defaults[5] = 131072;
  defaults[6] = 65536;
  defaults[64] = [91];
  const request = { contents, generationConfig: { maxOutputTokens: 50000 } };
  const initial = encodeGenerateRequest("fixture", request, defaults);
  const next = encodeGenerateRequest("fixture", request, defaults, undefined, 1, "resume-opaque");
  expect((initial.body[3] as Wire)[3]).toBe(32768);
  expect((next.body[3] as Wire)[3]).toBe(50000);
  expect(next.body[16]).toBe("resume-opaque");
  const first = [
    [[[[[null, "before "]], "model"], 22, 0, null, null, null, null, null, "resume-opaque"]],
    null,
    [13, 7, 23, null, null, null, null, 1, null, 2],
  ];
  const second = [
    [[[[[null, "after"]], "model"], 1, 0]],
    null,
    [5, 11, 21, null, null, null, null, 2, null, 3],
  ];
  const chunks = [];
  for await (const chunk of decodeGenerateStream(byteStream(JSON.stringify([[first]])), {
    limit: 50000,
    async resume(token, round) {
      expect(token).toBe("resume-opaque");
      expect(round).toBe(1);
      return new Response(JSON.stringify([[second]]));
    },
  }))
    chunks.push(chunk);
  expect((chunks[0].candidates as Record<string, unknown>[])[0].finishReason).toBeUndefined();
  const result = await aggregateGenerate(
    (async function* () {
      yield* chunks;
    })(),
  );
  expect(result.candidates).toEqual([
    {
      index: 0,
      content: { role: "model", parts: [{ text: "before after" }] },
      finishReason: "STOP",
    },
  ]);
  expect(result.usageMetadata).toEqual({
    promptTokenCount: 5,
    candidatesTokenCount: 18,
    totalTokenCount: 31,
    toolUsePromptTokenCount: 3,
    thoughtsTokenCount: 5,
  });
  // The same upstream token must not extend a request past its own budget.
  const limited = await aggregateGenerate(
    decodeGenerateStream(byteStream(JSON.stringify([[first]])), {
      limit: 32768,
      async resume() {
        throw new Error("must not resume");
      },
    }),
  );
  expect((limited.candidates as Record<string, unknown>[])[0].finishReason).toBe("MAX_TOKENS");
  await expect(
    aggregateGenerate(
      decodeGenerateStream(byteStream(JSON.stringify([[first]])), {
        limit: 50000,
        async resume() {
          return Response.json({ error: { message: "Continuation quota exceeded" } }, { status: 429 });
        },
      }),
    ),
  ).rejects.toThrow('HTTP 429: {"error":{"message":"Continuation quota exceeded"}}');
});

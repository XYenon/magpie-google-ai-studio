import { expect, test } from "bun:test";
import { providerFetch, type Transport } from "../src/provider.ts";

const url = "https://generativelanguage.googleapis.com/v1beta/audio/speech";
const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
const request = { model: "gemini-fixture-tts", input: "你好", voice: "Kore", response_format: "wav" };
const reply = (mimeType = "audio/L16;codec=pcm;rate=24000", bytes = pcm) => ({
  candidates: [
    {
      content: { role: "model", parts: [{ inlineData: { mimeType, data: bytes.toString("base64") } }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 10, totalTokenCount: 13 },
});
const transport: Transport = {
  async models() {
    return [];
  },
  async call() {
    throw new Error("Speech must use generation with fresh WAA");
  },
  async generate(model, body, encode, signal) {
    signal?.throwIfAborted();
    expect(model).toBe("gemini-fixture-tts");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "你好" }] }]);
    const encoded = encode(undefined, "UTC");
    expect(encoded.upstreamMethod).toBe("ProxyUnaryCall");
    expect(encoded.body[0]).toBe("/v1beta/models/gemini-fixture-tts:generateContent");
    expect(JSON.parse(String(encoded.body[1])).generationConfig).toEqual({
      responseModalities: ["AUDIO"],
      responseFormat: { audio: { mimeType: "AUDIO_L16", sampleRate: 24000 } },
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
    });
    return new Response(JSON.stringify([JSON.stringify(reply())]));
  },
};

test("Magpie speech requests produce a mono 24 kHz PCM WAV through Build", async () => {
  const response = await providerFetch(transport)(url, { method: "POST", body: JSON.stringify(request) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/wav");
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(bytes.readUInt32LE(4)).toBe(42);
  expect(bytes.subarray(8, 16).toString()).toBe("WAVEfmt ");
  expect(bytes.readUInt16LE(20)).toBe(1);
  expect(bytes.readUInt16LE(22)).toBe(1);
  expect(bytes.readUInt32LE(24)).toBe(24000);
  expect(bytes.readUInt16LE(34)).toBe(16);
  expect(bytes.readUInt32LE(40)).toBe(6);
  expect(bytes.subarray(44)).toEqual(pcm);
});

test("speech defaults to WAV and can return headerless PCM", async () => {
  for (const format of [undefined, "pcm"]) {
    const response = await providerFetch(transport)(url, {
      method: "POST",
      body: JSON.stringify({ ...request, response_format: format }),
    });
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(format === "pcm" ? bytes : bytes.subarray(44)).toEqual(pcm);
    expect(response.headers.get("content-type")).toBe(format === "pcm" ? "audio/pcm" : "audio/wav");
  }
});

test("speech keeps style instructions separate from the transcript and normalizes Gemini voices", async () => {
  const fetch = providerFetch({
    ...transport,
    async generate(_model, _body, encode) {
      const sent = JSON.parse(String(encode(undefined, "UTC").body[1]));
      expect(sent.contents).toEqual([
        { role: "user", parts: [{ text: "你好", speechMetadata: { style: "Speak cheerfully." } }] },
      ]);
      expect(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
      return new Response(JSON.stringify([JSON.stringify(reply())]));
    },
  });
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ ...request, voice: "puck", instructions: "Speak cheerfully." }),
  });
  expect(response.status).toBe(200);
});

test("speech rejects unsupported options before generating audio", async () => {
  let calls = 0;
  const fetch = providerFetch({
    ...transport,
    async generate() {
      calls++;
      throw new Error("Invalid requests must not reach Google");
    },
  });
  for (const invalid of [
    { model: "../bad" },
    { input: "" },
    { input: 7 },
    { voice: "alloy" },
    { voice: { id: "custom" } },
    { response_format: "mp3" },
    { response_format: "flac" },
    { speed: 1.25 },
    { speed: "1" },
    { stream_format: "sse" },
    { instructions: 1 },
    { voice_id: "custom" },
    { extra: true },
  ]) {
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ ...request, ...invalid }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.status).toBe("INVALID_ARGUMENT");
  }
  expect(calls).toBe(0);
  expect((await fetch(url)).status).toBe(405);
  expect(
    (
      await fetch(url.replace("generativelanguage.googleapis.com", "other.invalid"), {
        method: "POST",
        body: JSON.stringify(request),
      })
    ).status,
  ).toBe(400);
});

test("speech preserves Google errors and rejects blocked, incomplete or malformed audio", async () => {
  for (const [result, status] of [
    [new Response("quota denied", { status: 429 }), 429],
    [{ promptFeedback: { blockReason: "SAFETY" } }, 403],
    [{ candidates: [{ ...reply().candidates[0], finishReason: "MAX_TOKENS" }] }, 502],
    [reply("image/png"), 502],
    [reply("audio/L16;rate=48000"), 502],
    [reply("audio/L16", Buffer.from([1])), 502],
    [{ candidates: {} }, 502],
    [reply("audio/L16", Buffer.alloc(0)), 502],
    [{ candidates: [{ content: { parts: [{ text: "No audio" }] }, finishReason: "STOP" }] }, 502],
    [
      {
        candidates: [
          {
            content: { parts: [{ inlineData: { mimeType: "audio/L16", data: "!!!" } }] },
            finishReason: "STOP",
          },
        ],
      },
      502,
    ],
  ] as const) {
    const fetch = providerFetch({
      ...transport,
      async generate() {
        return result instanceof Response ? result : new Response(JSON.stringify([JSON.stringify(result)]));
      },
    });
    const response = await fetch(url, { method: "POST", body: JSON.stringify(request) });
    expect(response.status).toBe(status);
    const error = (await response.json()).error;
    expect(error.message).toBeTruthy();
    if (status === 429) expect(error.message).toContain("quota denied");
  }
});

test("speech passes cancellation to generation and preserves expired session errors", async () => {
  const controller = new AbortController();
  const fetch = providerFetch({
    ...transport,
    async generate(_model, _body, _encode, signal) {
      expect(signal?.aborted).toBe(false);
      controller.abort(new DOMException("Cancelled", "AbortError"));
      signal?.throwIfAborted();
      throw new Error("Cancellation was not propagated");
    },
  });
  await expect(
    fetch(url, { method: "POST", body: JSON.stringify(request), signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const expired = await providerFetch({
    ...transport,
    async generate() {
      throw Object.assign(new Error("expired"), { signIn: "expired" });
    },
  })(url, { method: "POST", body: JSON.stringify(request) });
  expect(expired.status).toBe(401);
});

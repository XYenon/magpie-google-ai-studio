import {
  decodeBuildStream,
  decodeBuildUnary,
  embeddingRequests,
  encodeBuild,
  encodeBuildGenerate,
  needsBuild,
} from "./build.ts";
import {
  aggregateGenerate,
  decodeGenerateStream,
  type EncodedRequest,
  encodeGenerateRequest,
  parseModels,
  parseSparseJSON,
  responseError,
  type Wire,
} from "./protocol.ts";
import { speechAudio, speechRequest } from "./speech.ts";

export interface Transport {
  models(): Promise<Wire>;
  buildModels?(): Promise<Record<string, unknown>[]>;
  call?(
    method: string,
    body: Wire,
    binding?: string,
    proofIndex?: number,
    signal?: AbortSignal,
  ): Promise<Response>;
  generate(
    model: string,
    request: Record<string, unknown>,
    encode: (defaults: Wire | undefined, timezone: string) => EncodedRequest,
    signal?: AbortSignal,
  ): Promise<Response>;
}

export function errorResponse(status: number, message: string): Response {
  const names: Record<number, string> = {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    429: "RESOURCE_EXHAUSTED",
    502: "UNAVAILABLE",
    504: "DEADLINE_EXCEEDED",
  };
  return Response.json({ error: { code: status, message, status: names[status] || "UNKNOWN" } }, { status });
}

export function providerFetch(
  transport: Transport,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/audio/speech")) return speechFetch(transport, request);
    if (
      transport.call &&
      /\/(embeddings|models\/[^/:]+:(embedContent|batchEmbedContents|countTokens))$/.test(url.pathname)
    )
      return auxiliaryFetch(transport, request);
    const match = /^\/v1beta\/models\/([^/:]+):(streamGenerateContent|generateContent)$/.exec(url.pathname);
    if (!match) return errorResponse(404, "Unsupported Google AI Studio endpoint");
    if (request.method !== "POST") return errorResponse(405, "Use POST for content generation");
    if (url.origin !== "https://generativelanguage.googleapis.com")
      return errorResponse(400, "Unexpected Gemini API origin");
    let body: Record<string, unknown>,
      build = false;
    try {
      body = await request.json();
      build = Boolean(transport.call && (needsBuild(body) || /(?:^|-)tts(?:-|$)/.test(match[1])));
      if (build)
        encodeBuildGenerate(decodeURIComponent(match[1]), body, match[2] === "streamGenerateContent");
      else encodeGenerateRequest(decodeURIComponent(match[1]), body);
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : "Invalid Gemini request");
    }
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal]);
    try {
      const model = decodeURIComponent(match[1]);
      let continuationLimit: number | undefined;
      const response = await transport.generate(
        model,
        body,
        (defaults, timezone) => {
          const encoded = build
            ? encodeBuildGenerate(model, body, match[2] === "streamGenerateContent")
            : encodeGenerateRequest(model, body, defaults, timezone);
          continuationLimit = encoded.continuationLimit;
          return encoded;
        },
        signal,
      );
      if (!response.ok) {
        return errorResponse(response.status, await responseError(response));
      }
      if (!response.body) return errorResponse(502, "AI Studio returned no response body");
      if (build && match[2] === "generateContent") {
        const result = await decodeBuildUnary(response);
        if (
          !(result.candidates as unknown[] | undefined)?.length &&
          !(result.promptFeedback as Record<string, unknown> | undefined)?.blockReason
        )
          throw new Error("AI Studio returned no candidates or blocking feedback");
        return Response.json(result);
      }
      const chunks = build
        ? decodeBuildStream(response.body)
        : decodeGenerateStream(
            response.body,
            continuationLimit
              ? {
                  limit: continuationLimit,
                  resume: (token, round) =>
                    transport.generate(
                      model,
                      body,
                      (defaults, timezone) =>
                        encodeGenerateRequest(model, body, defaults, timezone, round, token),
                      signal,
                    ),
                }
              : undefined,
          );
      if (match[2] === "generateContent") return Response.json(await aggregateGenerate(chunks));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await chunks.next();
            if (done) controller.close();
            else controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          } catch (error) {
            if (cancellation.signal.aborted) return;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: { code: 502, status: "UNAVAILABLE", message: error instanceof Error ? error.message : "AI Studio stream interrupted" } })}\n\n`,
              ),
            );
            controller.close();
            await chunks.return(undefined);
          }
        },
        async cancel() {
          // Unblock a pending page read before asking the async generator to
          // return; return() alone waits for that read and can hang forever.
          cancellation.abort(new DOMException("Gemini response cancelled", "AbortError"));
          await chunks.return(undefined);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if ((error as { signIn?: string }).signIn === "expired")
        return errorResponse(401, "Google AI Studio session expired; sign in again");
      return errorResponse(502, error instanceof Error ? error.message : "AI Studio request failed");
    }
  };
}

export async function providerModels(transport: Transport): Promise<Record<string, Record<string, unknown>>> {
  const models = parseModels(await transport.models());
  if (transport.buildModels) {
    let buildCatalog: Record<string, unknown>[] = [];
    try {
      buildCatalog = await transport.buildModels();
    } catch (error) {
      // Build access is optional; only denied or absent endpoints may omit embeddings.
      const status = (error as { status?: number } | null)?.status;
      if (status !== 403 && status !== 404) throw error;
      console.warn("AI Studio Build catalog unavailable; retaining the Playground model catalog");
    }
    for (const model of buildCatalog) {
      const generationMethods = model.supportedGenerationMethods as string[] | undefined;
      if (!generationMethods?.includes("embedContent")) continue;
      const id = String(model.name).replace(/^models\//, "");
      models[id] = {
        id,
        name: model.displayName || id,
        limit: { context: model.inputTokenLimit, output: 0 },
        capabilities: {
          toolcall: false,
          reasoning: false,
          attachment: false,
          input: { text: true },
          // Magpie v0.1.2038+ distinguishes this from unspecified outputs.
          output: { text: false },
        },
        modalities: { input: ["text"], output: [] },
      };
    }
  }
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [
      id,
      {
        ...model,
        api: {
          id,
          npm: "@ai-sdk/google",
          url: "https://generativelanguage.googleapis.com/v1beta",
        },
      },
    ]),
  );
}

async function speechFetch(transport: Transport, request: Request): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "Use POST for speech generation");
  if (new URL(request.url).origin !== "https://generativelanguage.googleapis.com")
    return errorResponse(400, "Unexpected Gemini API origin");
  const { signal } = request;
  let generationStarted = false;
  try {
    signal.throwIfAborted();
    const data = await request.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a JSON object");
    const { model, format, body } = speechRequest(data);
    if (!transport.call) return errorResponse(502, "AI Studio Build transport is unavailable");
    encodeBuildGenerate(model, body, false);
    generationStarted = true;
    const response = await transport.generate(
      model,
      body,
      () => encodeBuildGenerate(model, body, false),
      signal,
    );
    if (!response.ok) return errorResponse(response.status, await responseError(response));
    const result = await decodeBuildUnary(response);
    signal.throwIfAborted();
    return speechAudio(result, format);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if ((error as { signIn?: string }).signIn === "expired")
      return errorResponse(401, "Google AI Studio session expired; sign in again");
    return errorResponse(
      generationStarted ? 502 : 400,
      error instanceof Error ? error.message : "Speech request failed",
    );
  }
}

async function auxiliaryFetch(transport: Transport, request: Request): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "Use POST");
  if (new URL(request.url).origin !== "https://generativelanguage.googleapis.com")
    return errorResponse(400, "Unexpected Gemini API origin");
  let upstream = false;
  try {
    const data = (await request.json()) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a JSON object");
    const path = new URL(request.url).pathname;
    const native = /\/models\/([^/:]+):(embedContent|batchEmbedContents|countTokens)$/.exec(path);
    if (native?.[2] === "countTokens") {
      const input = data.generateContentRequest ?? data;
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid generateContentRequest");
      const { model: _, ...content } = input as Record<string, unknown>;
      const encoded = encodeGenerateRequest(native[1], content);
      upstream = true;
      const response = await transport.call!(
        "CountTokens",
        [`models/${native[1]}`, null, encoded.body],
        undefined,
        4,
        request.signal,
      );
      if (!response.ok) {
        return errorResponse(response.status, await responseError(response));
      }
      const value = parseSparseJSON(await response.text()) as Wire;
      if (typeof value[0] !== "number") throw new Error("Invalid CountTokens response");
      return Response.json({ totalTokens: value[0] });
    }
    const model = native?.[1] || String(data.model || "").replace(/^models\//, "");
    let inputs: unknown;
    if (native) inputs = native[2] === "embedContent" ? [data] : data.requests;
    else inputs = embeddingRequests(model, data);
    if (!Array.isArray(inputs) || !inputs.length || !/^[\w.-]+$/.test(model))
      throw new Error("Invalid embedding requests");
    const vectors: number[][] = [];
    let tokens = 0;
    for (let offset = 0; offset < inputs.length; offset += 100) {
      const batch = inputs.slice(offset, offset + 100).map((item) => ({ ...item, model: `models/${model}` }));
      const encoded = encodeBuild(`/v1beta/models/${model}:batchEmbedContents`, { requests: batch });
      upstream = true;
      const response = await transport.call!(
        encoded.upstreamMethod!,
        encoded.body,
        encoded.binding,
        encoded.proofIndex,
        request.signal,
      );
      if (!response.ok) {
        return errorResponse(response.status, await responseError(response));
      }
      const result = await decodeBuildUnary(response);
      const embeddings = result.embeddings as { values: number[] }[];
      if (
        !Array.isArray(embeddings) ||
        embeddings.length !== batch.length ||
        embeddings.some(
          (e) =>
            !Array.isArray(e.values) ||
            !e.values.length ||
            e.values.some((v) => typeof v !== "number" || !Number.isFinite(v)),
        )
      )
        throw new Error("Invalid embedding response");
      vectors.push(...embeddings.map((e) => e.values));
      tokens += Number(result.tokenCount || 0);
    }
    if (native)
      return Response.json(
        native[2] === "embedContent"
          ? { embedding: { values: vectors[0] } }
          : {
              embeddings: vectors.map((values) => ({ values })),
              tokenCount: tokens,
            },
      );
    return Response.json({
      object: "list",
      model,
      data: vectors.map((values, index) => {
        const bytes = Buffer.alloc(values.length * 4);
        if (data.encoding_format === "base64")
          values.forEach((v, i) => {
            bytes.writeFloatLE(v, i * 4);
          });
        return {
          object: "embedding",
          index,
          embedding: data.encoding_format === "base64" ? bytes.toString("base64") : values,
        };
      }),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    if ((error as { signIn?: string }).signIn === "expired")
      return errorResponse(401, "Google AI Studio session expired; sign in again");
    return errorResponse(
      upstream ? 502 : 400,
      error instanceof Error ? error.message : "AI Studio auxiliary request failed",
    );
  }
}

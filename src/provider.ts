import {
  aggregateGenerate,
  decodeGenerateStream,
  type EncodedRequest,
  encodeGenerateRequest,
  type ModelCatalog,
  parseSparseJSON,
  responseError,
  type Wire,
} from "./protocol.ts";

const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
export const GEMINI_API = `${GEMINI_ORIGIN}/v1beta`;

export interface Transport {
  models(): Promise<ModelCatalog>;
  countTokens(body: Wire, signal?: AbortSignal): Promise<Response>;
  generate(
    model: string,
    encode: (defaults: Wire, timezone: string) => EncodedRequest,
    signal?: AbortSignal,
  ): Promise<Response>;
}

const ERROR_STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  429: "RESOURCE_EXHAUSTED",
  502: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

function errorJson(status: number, message: string): Record<string, unknown> {
  return { error: { code: status, message, status: ERROR_STATUS[status] || "UNKNOWN" } };
}

function isTimeout(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === "TimeoutError";
}

function errorResponse(status: number, message: string): Response {
  return Response.json(errorJson(status, message), { status });
}

function upstreamError(error: unknown, fallback: string): Response {
  if ((error as { signIn?: string } | null)?.signIn === "expired")
    return errorResponse(401, "Google AI Studio session expired; sign in again");
  return errorResponse(isTimeout(error) ? 504 : 502, error instanceof Error ? error.message : fallback);
}

export function providerFetch(
  transport: Transport,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const count = /\/models\/([^/:]+):countTokens$/.exec(url.pathname);
    const match = /^\/v1beta\/models\/([^/:]+):(streamGenerateContent|generateContent)$/.exec(url.pathname);
    if (!count && !match) return errorResponse(404, "Unsupported Google AI Studio endpoint");
    if (request.method !== "POST")
      return errorResponse(405, count ? "Use POST" : "Use POST for content generation");
    if (url.origin !== GEMINI_ORIGIN) return errorResponse(400, "Unexpected Gemini API origin");
    if (count) return countTokens(transport, request, count[1]);
    let model: string, body: Record<string, unknown>;
    try {
      model = decodeURIComponent(match![1]);
      body = await request.json();
      encodeGenerateRequest(model, body);
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : "Invalid Gemini request");
    }
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal]);
    const effort = request.headers.get("X-Magpie-Effort") ?? undefined;
    let validationError: unknown;
    try {
      let continuationLimit: number | undefined;
      const response = await transport.generate(
        model,
        (defaults, timezone) => {
          try {
            const encoded = encodeGenerateRequest(model, body, defaults, timezone, 0, undefined, effort);
            continuationLimit = encoded.continuationLimit;
            return encoded;
          } catch (error) {
            validationError = error;
            throw error;
          }
        },
        signal,
      );
      if (!response.ok) {
        return errorResponse(response.status, await responseError(response));
      }
      if (!response.body) return errorResponse(502, "AI Studio returned no response body");
      const chunks = decodeGenerateStream(
        response.body,
        continuationLimit
          ? {
              limit: continuationLimit,
              resume: (token, round) =>
                transport.generate(
                  model,
                  (defaults, timezone) =>
                    encodeGenerateRequest(model, body, defaults, timezone, round, token, effort),
                  signal,
                ),
            }
          : undefined,
      );
      if (match![2] === "generateContent") return Response.json(await aggregateGenerate(chunks));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await chunks.next();
            if (done) controller.close();
            else controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          } catch (error) {
            if (cancellation.signal.aborted) return;
            const status = isTimeout(error) ? 504 : 502;
            const message = error instanceof Error ? error.message : "AI Studio stream interrupted";
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorJson(status, message))}\n\n`));
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
      if (validationError instanceof Error) return errorResponse(400, validationError.message);
      return upstreamError(error, "AI Studio request failed");
    }
  };
}

export async function providerModels(transport: Transport) {
  const models = await transport.models();
  return Object.fromEntries(
    Object.entries(models).map(([id, { defaults: _, ...model }]) => [
      id,
      {
        ...model,
        api: {
          id,
          npm: "@ai-sdk/google",
          url: GEMINI_API,
        },
      },
    ]),
  );
}

async function countTokens(transport: Transport, request: Request, model: string): Promise<Response> {
  let body: Wire;
  try {
    const data = (await request.json()) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a JSON object");
    const input = data.generateContentRequest ?? data;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid generateContentRequest");
    const { model: _, ...content } = input as Record<string, unknown>;
    body = [`models/${model}`, null, encodeGenerateRequest(model, content).body];
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    return errorResponse(400, error instanceof Error ? error.message : "Invalid token count request");
  }
  try {
    const response = await transport.countTokens(body, request.signal);
    if (!response.ok) return errorResponse(response.status, await responseError(response));
    const value = parseSparseJSON(await response.text()) as Wire;
    if (typeof value[0] !== "number") throw new Error("Invalid CountTokens response");
    return Response.json({ totalTokens: value[0] });
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    return upstreamError(error, "AI Studio token count request failed");
  }
}

import {
  decodeRPCStream,
  type EncodedRequest,
  errorBody,
  parseSparseJSON,
  validateGenerateRequest,
} from "./protocol.ts";

export function needsBuild(request: Record<string, unknown>): boolean {
  const config = request.generationConfig as Record<string, unknown> | undefined;
  const media =
    Array.isArray(request.contents) &&
    request.contents.some(
      (content) =>
        Array.isArray(content?.parts) &&
        content.parts.some(
          (part: Record<string, unknown>) => part?.inlineData !== undefined || part?.fileData !== undefined,
        ),
    );
  return (
    request.tools !== undefined ||
    request.toolConfig !== undefined ||
    config?.responseSchema !== undefined ||
    config?.responseJsonSchema !== undefined ||
    config?.responseFormat !== undefined ||
    config?.speechConfig !== undefined ||
    request.cachedContent !== undefined ||
    (Array.isArray(config?.responseModalities) &&
      config.responseModalities.some((value) => value !== "TEXT")) ||
    media
  );
}

export function encodeBuild(
  path: string,
  data: unknown,
  stream = false,
  httpMethod = "POST",
): EncodedRequest {
  const json = JSON.stringify(data);
  return {
    upstreamMethod: stream ? "ProxyStreamedCall" : "ProxyUnaryCall",
    body: stream ? [path, json, null] : [path, json, null, httpMethod],
    binding: httpMethod === "GET" ? undefined : `${path} ${json}`,
    proofIndex: 2,
  };
}

export function encodeBuildGenerate(
  model: string,
  request: Record<string, unknown>,
  stream: boolean,
): EncodedRequest {
  if (!/^[\w.-]+$/.test(model)) throw new Error("Invalid model ID");
  if (!Array.isArray(request.contents) || !request.contents.length)
    throw new Error("contents must be a nonempty array");
  validateGenerateRequest(request);
  const body = structuredClone(request);
  const calling = (body.toolConfig as { functionCallingConfig?: { mode?: string } } | undefined)
    ?.functionCallingConfig;
  if (calling?.mode === "NONE" && Array.isArray(body.tools)) {
    // Do not expose disabled user functions to the model. Google's built-in
    // tools retain their own independent execution policy.
    const tools = body.tools
      .map((tool) => {
        const { functionDeclarations, ...builtin } = tool;
        return builtin;
      })
      .filter((tool) => Object.keys(tool).length);
    if (tools.length) body.tools = tools;
    else delete body.tools;
    const { functionCallingConfig, ...config } = body.toolConfig as Record<string, unknown>;
    if (Object.keys(config).length) body.toolConfig = config;
    else delete body.toolConfig;
  }
  const config = body.generationConfig as Record<string, unknown> | undefined;
  const thinking = config?.thinkingConfig as Record<string, unknown> | undefined;
  // Magpie sends lowercase levels; the proxy expects Gemini enum names.
  if (typeof thinking?.thinkingLevel === "string")
    thinking.thinkingLevel = thinking.thinkingLevel.toUpperCase();
  if (config?.responseJsonSchema !== undefined) {
    if (config.responseSchema !== undefined || config.responseFormat !== undefined)
      throw new Error("Response schema formats are mutually exclusive");
    // The website proxy rejects responseJsonSchema, but accepts the current
    // native responseFormat envelope without projecting away JSON Schema fields.
    config.responseFormat = {
      text: { mimeType: "APPLICATION_JSON", schema: config.responseJsonSchema },
    };
    delete config.responseJsonSchema;
    delete config.responseMimeType;
  }
  return encodeBuild(
    `/v1beta/models/${model}:${stream ? "streamGenerateContent" : "generateContent"}`,
    body,
    stream,
  );
}

export function decodeBuildMessage(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error("Invalid Build proxy response");
  let text = "";
  if (typeof value[0] === "string") text = value[0];
  else if (typeof value[2] === "string") text = Buffer.from(value[2], "base64").toString();
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid Build JSON response");
  if (data.error) throw new Error(`AI Studio Build: ${errorBody(text)}`);
  return data;
}

export async function decodeBuildUnary(response: Response): Promise<Record<string, unknown>> {
  return decodeBuildMessage(parseSparseJSON(await response.text()));
}

export async function* decodeBuildStream(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const unfinished = new Set<number>();
  let complete = false;
  for await (const wire of decodeRPCStream(source)) {
    const chunk = decodeBuildMessage(wire);
    for (const candidate of (chunk.candidates || []) as Record<string, unknown>[]) {
      const index = Number(candidate.index || 0);
      if (candidate.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED") {
        unfinished.delete(index);
        complete = true;
      } else unfinished.add(index);
    }
    if ((chunk.promptFeedback as Record<string, unknown> | undefined)?.blockReason) complete = true;
    yield chunk;
  }
  if (!complete || unfinished.size) throw new Error("Build stream ended before finish frame");
}

export function embeddingRequests(
  model: string,
  request: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!/^[\w.-]+$/.test(model)) throw new Error("Invalid embedding model ID");
  const input = typeof request.input === "string" ? [request.input] : request.input;
  if (!Array.isArray(input) || !input.length || !input.every((v) => typeof v === "string" && v.length))
    throw new Error("Embedding input must be text or a nonempty array of texts");
  if (
    request.dimensions !== undefined &&
    (!Number.isSafeInteger(request.dimensions) || Number(request.dimensions) < 1)
  )
    throw new Error("Embedding dimensions must be a positive integer");
  if (request.encoding_format !== undefined && !["float", "base64"].includes(String(request.encoding_format)))
    throw new Error("Unsupported embedding encoding_format");
  return input.map((text) => ({
    model: `models/${model}`,
    content: { role: "user", parts: [{ text }] },
    ...(request.dimensions === undefined ? {} : { outputDimensionality: request.dimensions }),
    ...(request.task_type === undefined ? {} : { taskType: request.task_type }),
    ...(request.title === undefined ? {} : { title: request.title }),
  }));
}

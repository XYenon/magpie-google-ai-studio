// MakerSuite JSON+protobuf indices follow AIStudio2API (MIT). See NOTICE.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Wire = Json[];
export interface EncodedRequest {
  body: Wire;
  binding?: string;
  upstreamMethod?: string;
  proofIndex?: number;
  continuationLimit?: number;
}
type ObjectValue = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`AI Studio protocol: ${message}`);
}
function object(value: unknown, path = "object"): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value as ObjectValue;
}
function array(value: unknown, path = "array"): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}
function string(value: unknown, path = "string"): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}
function number(value: unknown, path = "number", min = -Infinity, max = Infinity, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    fail(`${path} has an invalid number`);
  return value;
}
function boolean(value: unknown, path = "boolean"): boolean {
  if (typeof value !== "boolean") fail(`${path} must be boolean`);
  return value;
}
function keys(value: ObjectValue, allowed: string[], path: string): void {
  for (const key of Object.keys(object(value, path)))
    if (!allowed.includes(key)) fail(`unsupported ${path}.${key}`);
}
function enumCode(value: unknown, values: Record<string, number>, path: string): number {
  const name = string(value, path);
  if (!Object.hasOwn(values, name)) fail(`unsupported ${path}: ${name}`);
  return values[name];
}
function set(wire: Wire, index: number, value: Json): void {
  while (wire.length <= index) wire.push(null);
  wire[index] = value;
}
function json(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return number(value);
  if (Array.isArray(value)) return value.map(json);
  const result: Record<string, Json> = Object.create(null);
  for (const [key, item] of Object.entries(object(value, "JSON"))) result[key] = json(item);
  return result;
}
function strings(value: unknown, path: string): string[] {
  return array(value, path).map((item) => string(item, path));
}

/** Normalize omitted protobuf array slots without executing JavaScript. */
export function parseSparseJSON(text: string): Json {
  let output = "",
    quoted = false,
    escaped = false,
    previous = "";
  const stack: string[] = [];
  for (const char of text) {
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    const parent = stack.at(-1);
    if (
      (char === "," && parent === "[" && (previous === "[" || previous === ",")) ||
      (char === "]" && parent === "[" && previous === ",")
    )
      output += "null";
    output += char;
    if (char === "[" || char === "{") stack.push(char);
    else if (char === "]" || char === "}") stack.pop();
    if (!/\s/.test(char)) previous = char;
  }
  return json(JSON.parse(output) as unknown);
}

const ERROR_BODY_LIMIT = 8 * 1024;

/** Keep the raw UTF-8 body prefix without interpreting private error fields. */
export function errorBody(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const truncated = bytes.byteLength > ERROR_BODY_LIMIT;
  const text = new TextDecoder().decode(bytes.subarray(0, ERROR_BODY_LIMIT), { stream: truncated });
  return truncated ? `${text}\n[truncated]` : text;
}

/** Read only enough bytes to retain the body prefix and detect truncation. */
export async function responseError(response: Response): Promise<string> {
  const fallback = `Google AI Studio returned HTTP ${response.status}`;
  const reader = response.body?.getReader();
  if (!reader) return fallback;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, ERROR_BODY_LIMIT + 1 - size);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size > ERROR_BODY_LIMIT) break;
    }
  } catch {
    // Preserve any body bytes received before the connection failed.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = errorBody(Buffer.concat(chunks));
  return body ? `${fallback}: ${body}` : fallback;
}

function encodeStruct(value: unknown): Wire {
  const entries = Object.entries(object(value, "function args/response")).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return entries.length ? [entries.map(([key, item]) => [key, encodeValue(json(item))])] : [];
}
function encodeValue(value: Json): Wire {
  if (value === null) return [0];
  if (typeof value === "number") return [null, value];
  if (typeof value === "string") return [null, null, value];
  if (typeof value === "boolean") return [null, null, null, value];
  if (Array.isArray(value)) return [null, null, null, null, null, [value.map(encodeValue)]];
  return [null, null, null, null, encodeStruct(value)];
}
function decodeStruct(value: unknown): Record<string, Json> {
  const wire = array(value, "Struct"),
    result: Record<string, Json> = Object.create(null);
  for (const item of wire[0] == null ? [] : array(wire[0], "Struct entries")) {
    const entry = array(item, "Struct entry");
    if (entry.length !== 2) fail("Struct entry must contain a key and value");
    const key = string(entry[0], "Struct key");
    if (Object.hasOwn(result, key)) fail(`duplicate Struct key ${key}`);
    result[key] = decodeValue(entry[1]);
  }
  return result;
}
function decodeValue(value: unknown): Json {
  const fields = array(value, "Value"),
    indices = fields.flatMap((item, index) => (item == null ? [] : [index]));
  if (indices.length !== 1) fail("Value must set exactly one oneof field");
  switch (indices[0]) {
    case 0:
      if (fields[0] !== 0) fail("invalid null Value");
      return null;
    case 1:
      return number(fields[1]);
    case 2:
      return string(fields[2]);
    case 3:
      return wireBool(fields[3]);
    case 4:
      return decodeStruct(fields[4]);
    case 5: {
      const list = array(fields[5], "ListValue");
      return list[0] == null ? [] : array(list[0]).map(decodeValue);
    }
    default:
      return fail("unknown Value oneof field");
  }
}
function wireBool(value: unknown): boolean {
  return value === 1 ? true : value === 0 ? false : boolean(value);
}

const schemaTypes = {
  STRING: 1,
  NUMBER: 2,
  INTEGER: 3,
  BOOLEAN: 4,
  ARRAY: 5,
  OBJECT: 6,
};
function encodeSchema(value: unknown, tool = false, root = value, refs: string[] = []): Wire {
  const s = { ...object(value, "schema") };
  if (tool && s.$ref !== undefined) {
    const ref = string(s.$ref, "schema.$ref");
    if (!ref.startsWith("#/") || refs.includes(ref)) fail("tool schemas require non-recursive local $refs");
    let resolved: unknown = root;
    for (const key of ref.slice(2).split("/")) {
      const target = object(resolved, "schema.$ref target"),
        name = key.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!Object.hasOwn(target, name)) fail("unresolved tool schema $ref");
      resolved = target[name];
    }
    delete s.$ref;
    return encodeSchema({ ...object(resolved), ...s }, true, root, [...refs, ref]);
  }
  if (tool && typeof s.const === "string") {
    s.type ??= "string";
    s.enum = [s.const];
  }
  const scalar: Record<string, [number, "string" | "number" | "integer" | "boolean" | "strings"]> = {
    format: [1, "string"],
    description: [2, "string"],
    nullable: [3, "boolean"],
    enum: [4, "strings"],
    required: [7, "strings"],
    minProperties: [8, "integer"],
    maxProperties: [9, "integer"],
    minimum: [10, "number"],
    maximum: [11, "number"],
    minLength: [12, "integer"],
    maxLength: [13, "integer"],
    pattern: [14, "string"],
    maxItems: [20, "integer"],
    minItems: [21, "integer"],
    propertyOrdering: [22, "strings"],
  };
  if (!tool)
    keys(
      s,
      [
        "type",
        ...Object.keys(scalar),
        "items",
        "properties",
        "anyOf",
        "oneOf",
        "allOf",
        "not",
        "example",
        "title",
        "$schema",
        "default",
      ],
      "schema",
    );
  for (const name of ["anyOf", "oneOf"])
    if (s[name] !== undefined) {
      const branches = array(s[name], `schema.${name}`);
      const nonNull = branches.filter((branch) => object(branch).type !== "null");
      if (nonNull.length !== branches.length) {
        s.nullable = true;
        s[name] = nonNull;
      }
    }
  let type = s.type,
    nullable = s.nullable;
  if (Array.isArray(type)) {
    const types = strings(type, "schema.type"),
      nonNull = types.filter((t) => t.toLowerCase() !== "null");
    if (nonNull.length !== 1) fail("schema.type unions require one non-null type");
    type = nonNull[0];
    nullable = types.length !== nonNull.length || nullable;
  }
  if (tool && type === "null") {
    type = "string";
    nullable = true;
  }
  const branches = s.anyOf ?? s.oneOf ?? s.allOf;
  const first = branches === undefined ? undefined : array(branches)[0];
  const inferred =
    s.properties !== undefined
      ? "OBJECT"
      : s.items !== undefined
        ? "ARRAY"
        : tool && first !== undefined
          ? (object(first).type ?? "string")
          : tool
            ? "string"
            : undefined;
  const resolvedType = type ?? inferred;
  const wire: Wire = [
    resolvedType === undefined
      ? 0
      : enumCode(string(resolvedType, "schema.type").toUpperCase(), schemaTypes, "schema.type"),
  ];
  if (wire[0] === 0) fail("schema requires an explicit or inferred type");
  for (const [key, [index, kind]] of Object.entries(scalar)) {
    const item = key === "nullable" ? nullable : s[key];
    if (item === undefined || (tool && key === "enum" && !array(item).every((v) => typeof v === "string")))
      continue;
    set(
      wire,
      index,
      kind === "string"
        ? string(item, key)
        : kind === "strings"
          ? strings(item, key)
          : kind === "boolean"
            ? boolean(item, key)
            : number(item, key, kind === "integer" ? 0 : -Infinity, Infinity, kind === "integer"),
    );
  }
  const childSchema = (child: unknown) => encodeSchema(tool && child === true ? {} : child, tool, root, refs);
  if (s.items !== undefined) set(wire, 5, childSchema(s.items));
  else if (tool && wire[0] === 5) set(wire, 5, childSchema(object(first ?? {}).items ?? {}));
  if (s.properties !== undefined)
    set(
      wire,
      6,
      Object.entries(object(s.properties))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, childSchema(child)]),
    );
  for (const [name, index] of [
    ["oneOf", 16],
    ["anyOf", 17],
    ["allOf", 18],
  ] as const)
    if (s[name] !== undefined) set(wire, index, array(s[name]).map(childSchema));
  if (s.not !== undefined) set(wire, 19, childSchema(s.not));
  if (s.example !== undefined) set(wire, 15, encodeValue(json(s.example)));
  return wire;
}

function encodePart(value: unknown): { wire: Wire; binding: string } {
  const part = object(value, "part"),
    variants = [
      "text",
      "inlineData",
      "fileData",
      "functionCall",
      "functionResponse",
      "executableCode",
      "codeExecutionResult",
    ];
  keys(part, [...variants, "thought", "thoughtSignature"], "part");
  const active = variants.filter((key) => part[key] !== undefined);
  if (active.length > 1 || (active.length === 0 && part.thoughtSignature === undefined))
    fail("part requires exactly one content field or a thoughtSignature");
  const wire: Wire = [];
  let binding = "";
  if (part.text !== undefined) {
    binding = string(part.text, "part.text");
    set(wire, 1, binding);
  }
  if (part.inlineData !== undefined) {
    const data = object(part.inlineData);
    keys(data, ["mimeType", "data"], "inlineData");
    const encoded = string(data.data, "inlineData.data");
    if (
      !encoded ||
      !/^[A-Za-z0-9+/_\-\r\n]*={0,2}$/.test(encoded) ||
      encoded.replace(/[\r\n=]/g, "").length % 4 === 1
    )
      fail("invalid inlineData base64");
    try {
      binding = btoa(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      fail("invalid inlineData base64");
    }
    const mime = string(data.mimeType, "inlineData.mimeType");
    if (!mime.includes("/")) fail("invalid inlineData MIME");
    set(wire, 2, [mime, binding]);
  }
  if (part.fileData !== undefined) {
    const data = object(part.fileData);
    keys(data, ["mimeType", "fileUri"], "fileData");
    const uri = string(data.fileUri, "fileData.fileUri"),
      mime = string(data.mimeType, "fileData.mimeType");
    if (!/^https?:\/\//.test(uri) || !mime.includes("/"))
      fail("fileData requires an external HTTP(S) URI and MIME");
    set(wire, 6, [mime, uri]);
  }
  for (const [key, index, field] of [
    ["functionCall", 10, "args"],
    ["functionResponse", 11, "response"],
  ] as const)
    if (part[key] !== undefined) {
      const call = object(part[key]);
      keys(call, ["name", field, "id"], key);
      const name = string(call.name, `${key}.name`);
      if (!name) fail(`${key}.name cannot be empty`);
      const data: Wire = [name, encodeStruct(call[field] ?? {})];
      if (call.id !== undefined) data.push(string(call.id, `${key}.id`));
      set(wire, index, data);
    }
  if (part.executableCode !== undefined) {
    const code = object(part.executableCode);
    keys(code, ["language", "code"], "executableCode");
    set(wire, 7, [
      enumCode(code.language, { LANGUAGE_UNSPECIFIED: 0, PYTHON: 1 }, "language"),
      string(code.code),
    ]);
  }
  if (part.codeExecutionResult !== undefined) {
    const result = object(part.codeExecutionResult);
    keys(result, ["outcome", "output"], "codeExecutionResult");
    set(wire, 8, [
      enumCode(
        result.outcome,
        {
          OUTCOME_UNSPECIFIED: 0,
          OUTCOME_OK: 1,
          OUTCOME_FAILED: 2,
          OUTCOME_DEADLINE_EXCEEDED: 3,
        },
        "outcome",
      ),
      string(result.output ?? ""),
    ]);
  }
  if (part.thought !== undefined) set(wire, 12, boolean(part.thought, "thought"));
  if (part.thoughtSignature !== undefined) set(wire, 14, string(part.thoughtSignature, "thoughtSignature"));
  return { wire, binding };
}
function encodeContent(value: unknown, system = false): { wire: Wire; binding: string[] } {
  const content = object(value, "content");
  keys(content, ["role", "parts"], "content");
  const role = content.role ?? "user";
  if ((!system && role !== "user" && role !== "model") || (system && role !== "user" && role !== "system"))
    fail(`invalid content role ${String(role)}`);
  const parts = array(content.parts, "content.parts").map(encodePart);
  if (!parts.length) fail("content.parts cannot be empty");
  if (system && parts.some((p) => p.wire[1] == null)) fail("systemInstruction supports text only");
  return {
    wire: [parts.map((p) => p.wire), system ? "user" : string(role)],
    binding: parts.map((p) => p.binding),
  };
}
const thinkingLevels = {
  THINKING_LEVEL_UNSPECIFIED: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  MINIMAL: 4,
};
const harmCategories = {
  HARM_CATEGORY_HARASSMENT: 7,
  HARM_CATEGORY_HATE_SPEECH: 8,
  HARM_CATEGORY_SEXUALLY_EXPLICIT: 9,
  HARM_CATEGORY_DANGEROUS_CONTENT: 10,
  HARM_CATEGORY_CIVIC_INTEGRITY: 11,
};
const thresholds = {
  HARM_BLOCK_THRESHOLD_UNSPECIFIED: 0,
  BLOCK_LOW_AND_ABOVE: 1,
  BLOCK_MEDIUM_AND_ABOVE: 2,
  BLOCK_ONLY_HIGH: 3,
  BLOCK_NONE: 4,
  OFF: 5,
};

/** Checks shared by the Playground encoder and the native Build proxy. */
export function validateGenerateRequest(request: ObjectValue): void {
  const config = object(request.generationConfig ?? {}, "generationConfig");
  if (config.temperature != null) {
    const temperature = number(config.temperature, "temperature");
    if (temperature < 0 || temperature > 2) fail("temperature must be between 0 and 2");
  }
  if (config.thinkingConfig !== undefined) {
    const thinking = object(config.thinkingConfig, "thinkingConfig");
    if (thinking.thinkingBudget !== undefined && thinking.thinkingLevel !== undefined)
      fail("thinkingBudget and thinkingLevel are mutually exclusive");
  }
  if (request.toolConfig !== undefined) {
    const tool = object(request.toolConfig, "toolConfig");
    if (tool.functionCallingConfig !== undefined) {
      const calling = object(tool.functionCallingConfig, "functionCallingConfig");
      if (
        calling.allowedFunctionNames !== undefined &&
        strings(calling.allowedFunctionNames, "allowedFunctionNames").length > 0 &&
        calling.mode !== "ANY"
      )
        fail("allowedFunctionNames requires mode ANY");
    }
  }
}

/** defaults is the original ListModels row. The browser supplies a fresh WAA slot. */
export function encodeGenerateRequest(
  model: string,
  request: Record<string, unknown>,
  defaults: Wire = [],
  timezone?: string,
  continuationRound = 0,
  continuationToken?: string,
): EncodedRequest & { binding: string } {
  keys(
    request,
    ["contents", "systemInstruction", "tools", "toolConfig", "generationConfig", "safetySettings"],
    "request",
  );
  validateGenerateRequest(request);
  if (!/^(models\/)?[\w.-]+$/.test(model)) fail("invalid model ID");
  const contents = array(request.contents, "contents").map((c) => encodeContent(c));
  if (!contents.length) fail("contents cannot be empty");
  const body: Wire = Array<Json>(11).fill(null);
  body[0] = model.startsWith("models/") ? model : `models/${model}`;
  body[1] = contents.map((c) => c.wire);
  body[10] = 1;
  if (request.systemInstruction !== undefined) body[5] = encodeContent(request.systemInstruction, true).wire;
  const config = object(request.generationConfig ?? {}, "generationConfig");
  keys(
    config,
    [
      "temperature",
      "topP",
      "topK",
      "maxOutputTokens",
      "stopSequences",
      "candidateCount",
      "responseMimeType",
      "responseSchema",
      "responseJsonSchema",
      "responseModalities",
      "thinkingConfig",
      "seed",
      "mediaResolution",
      "imageConfig",
    ],
    "generationConfig",
  );
  const wire: Wire = Array<Json>(14).fill(null);
  wire[13] = 1;
  for (const [name, index, fallback, min, max, integer] of [
    ["maxOutputTokens", 3, 6, 1, Infinity, true],
    ["temperature", 4, 8, 0, 2, false],
    ["topP", 5, 9, 0, 1, false],
    ["topK", 6, 10, 0, Infinity, true],
  ] as const) {
    const value = config[name] ?? defaults[fallback];
    if (value != null) set(wire, index, number(value, name, min, max, integer));
  }
  if (config.candidateCount !== undefined && config.candidateCount !== 1) fail("candidateCount must be 1");
  if (config.stopSequences !== undefined) set(wire, 1, strings(config.stopSequences, "stopSequences"));
  if (config.responseMimeType !== undefined) set(wire, 7, string(config.responseMimeType));
  if (config.responseSchema !== undefined && config.responseJsonSchema !== undefined)
    fail("responseSchema and responseJsonSchema are mutually exclusive");
  const schema = config.responseJsonSchema ?? config.responseSchema;
  if (schema !== undefined) set(wire, 8, encodeSchema(schema));
  if (config.seed !== undefined) set(wire, 18, number(config.seed, "seed", -2147483648, 2147483647, true));
  if (config.mediaResolution !== undefined)
    set(
      wire,
      17,
      enumCode(
        config.mediaResolution,
        {
          MEDIA_RESOLUTION_UNSPECIFIED: 0,
          MEDIA_RESOLUTION_LOW: 1,
          MEDIA_RESOLUTION_MEDIUM: 2,
          MEDIA_RESOLUTION_HIGH: 3,
        },
        "mediaResolution",
      ),
    );
  if (config.responseModalities !== undefined)
    set(
      wire,
      14,
      strings(config.responseModalities, "responseModalities").map((m) =>
        enumCode(m, { TEXT: 1, IMAGE: 2, AUDIO: 3 }, "responseModalities"),
      ),
    );
  if (config.imageConfig !== undefined) {
    const image = object(config.imageConfig);
    keys(image, ["aspectRatio", "imageSize"], "imageConfig");
    set(wire, 26, [
      image.aspectRatio === undefined ? null : string(image.aspectRatio),
      image.imageSize === undefined ? null : string(image.imageSize),
    ]);
  }
  const caps = defaults[64] == null ? [] : array(defaults[64]);
  if (config.thinkingConfig !== undefined || caps.some((c) => c === 25 || c === 35 || c === 52)) {
    const t = object(config.thinkingConfig ?? {});
    keys(t, ["thinkingBudget", "thinkingLevel", "includeThoughts"], "thinkingConfig");
    const thinking: Wire = [t.includeThoughts === undefined ? 1 : boolean(t.includeThoughts) ? 1 : 0];
    if (t.thinkingBudget !== undefined)
      set(thinking, 1, number(t.thinkingBudget, "thinkingBudget", -1, Infinity, true));
    if (t.thinkingLevel !== undefined)
      set(
        thinking,
        3,
        enumCode(string(t.thinkingLevel, "thinkingLevel").toUpperCase(), thinkingLevels, "thinkingLevel"),
      );
    else if (caps.includes(52))
      set(thinking, 3, defaults[71] == null ? 2 : json(array(defaults[71])[5] ?? 2));
    set(wire, 16, thinking);
  }
  let continuationLimit: number | undefined;
  if (caps.includes(91)) {
    continuationLimit = Math.min(number(wire[3], "maxOutputTokens", 1, Infinity, true), number(defaults[5]));
    set(wire, 45, 1);
    wire[3] = Math.min(continuationLimit, (continuationRound + 1) * 32768);
    body[10] = null;
    if (continuationToken) set(body, 16, continuationToken);
  }
  body[3] = wire;
  if (request.safetySettings !== undefined) {
    const seen = new Set<number>();
    body[2] = array(request.safetySettings).map((value) => {
      const s = object(value);
      keys(s, ["category", "threshold"], "safetySettings");
      const category = enumCode(s.category, harmCategories, "safety category");
      if (seen.has(category)) fail("duplicate safety category");
      seen.add(category);
      return [null, null, category, enumCode(s.threshold, thresholds, "safety threshold")];
    });
  }
  const tools: Wire = [];
  let functions = false,
    builtin = false;
  if (request.tools !== undefined)
    for (const item of array(request.tools, "tools")) {
      const tool = object(item);
      keys(tool, ["functionDeclarations", "codeExecution", "googleSearch"], "tool");
      if (!Object.keys(tool).length) fail("empty tool");
      if (tool.functionDeclarations !== undefined) {
        const declarations = array(tool.functionDeclarations).map((value) => {
          const d = object(value);
          keys(d, ["name", "description", "parameters", "parametersJsonSchema"], "functionDeclaration");
          if (d.parameters !== undefined && d.parametersJsonSchema !== undefined)
            fail("function parameter schemas are mutually exclusive");
          const name = string(d.name, "function name");
          if (!name) fail("empty function name");
          let schema = d.parametersJsonSchema ?? d.parameters ?? { type: "object" };
          if (Object.keys(object(schema)).length === 0) schema = { type: "object" };
          // Playground only carries a schema projection. Preserve all constraints
          // (including additionalProperties) in the model's tool instructions.
          const description = `${string(d.description ?? "")}\nArguments must follow this JSON Schema: ${JSON.stringify(json(schema))}`;
          return [name, description, encodeSchema(schema, true)];
        });
        tools.push([null, declarations]);
        functions = true;
      }
      if (tool.codeExecution !== undefined) {
        keys(object(tool.codeExecution), [], "codeExecution");
        tools.push([[]]);
        builtin = true;
      }
      if (tool.googleSearch !== undefined) {
        keys(object(tool.googleSearch), [], "googleSearch");
        tools.push([null, null, null, [null, [[]]]]);
        builtin = true;
      }
    }
  if (request.toolConfig !== undefined) {
    const t = object(request.toolConfig);
    keys(t, ["functionCallingConfig"], "toolConfig");
    const f = object(t.functionCallingConfig);
    keys(f, ["mode"], "functionCallingConfig");
    // No verified private slot for required/validated tool choice exists.
    if (f.mode === "NONE") {
      for (let n = tools.length - 1; n >= 0; n--)
        if (Array.isArray(tools[n]) && (tools[n] as Wire)[1] != null) tools.splice(n, 1);
      functions = false;
    } else if (f.mode !== undefined && f.mode !== "AUTO" && f.mode !== "MODE_UNSPECIFIED")
      fail("unsupported functionCallingConfig.mode");
  }
  if (tools.length) body[6] = tools;
  if (timezone !== undefined || (functions && builtin && tools.length > 0)) {
    const context: Wire = [timezone === undefined ? null : [null, null, timezone]];
    if (functions && builtin && tools.length > 0) set(context, 2, true);
    set(body, 13, context);
  }
  return {
    body,
    binding: contents.flatMap((c) => c.binding).join(" "),
    continuationLimit,
  };
}

/** Only verified chat GenerateContent routes are listed, not other MakerSuite APIs. */
export function parseModels(response: unknown): Record<string, Record<string, unknown>> {
  const root = array(
      typeof response === "string" ? parseSparseJSON(response) : response,
      "ListModels response",
    ),
    rows = array(root[0], "ListModels rows");
  const models: Record<string, Record<string, unknown>> = Object.create(null),
    seen = new Set<string>();
  for (const value of rows) {
    const row = array(value, "model row"),
      id = string(row[0], "model ID").replace(/^models\//, ""),
      name = string(row[3], "model display name");
    if (!id || !name || seen.has(id)) fail("empty or duplicate ListModels model ID/name");
    seen.add(id);
    const methods = row[7] == null ? [] : strings(row[7], "model methods");
    const codes =
      row[64] == null ? [] : array(row[64]).map((c) => number(c, "capability code", 0, Infinity, true));
    if (
      !methods.includes("generateContent") ||
      row[78] != null ||
      codes.some((c) => [20, 26, 46, 53, 59].includes(c))
    )
      continue;
    const context = number(row[5], "input token limit", 1, Infinity, true),
      output = number(row[6], "output token limit", 1, Infinity, true);
    const reasoning = codes.some((c) => [25, 35, 52].includes(c)),
      variants: Record<string, unknown> = Object.create(null);
    if (codes.includes(52) && row[71] != null) {
      const levels = array(row[71]);
      for (const level of levels[6] == null ? [] : array(levels[6])) {
        const name = ({ 1: "low", 2: "medium", 3: "high", 4: "minimal" } as Record<number, string>)[
          number(level)
        ];
        if (name)
          variants[name] = {
            thinkingConfig: { thinkingLevel: name.toUpperCase() },
          };
      }
    }
    // Standard Gemini chat models accept the four tested media types through
    // Build. Image-generation and speech models have narrower input contracts.
    const speech = codes.includes(37),
      image = codes.includes(21);
    const multimodal = id.startsWith("gemini-") && codes.includes(1) && !image && !speech;
    const input = {
      text: true,
      image: multimodal || image,
      audio: multimodal,
      video: multimodal,
      pdf: multimodal,
    };
    const outputModalities = {
      text: !speech,
      image,
      audio: speech,
      video: false,
      pdf: false,
    };
    models[id] = {
      id,
      name,
      limit: { context, output: codes.includes(91) ? context : output },
      capabilities: {
        reasoning,
        toolcall: codes.includes(10),
        attachment: input.image,
        input,
        output: outputModalities,
      },
      modalities: {
        input: Object.keys(input).filter((key) => input[key as keyof typeof input]),
        output: Object.keys(outputModalities).filter(
          (key) => outputModalities[key as keyof typeof outputModalities],
        ),
      },
      variants,
    };
  }
  if (!Object.keys(models).length)
    fail("ListModels contains no compatible GenerateContent playground models");
  return models;
}

const finishReasons = [
  "FINISH_REASON_UNSPECIFIED",
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "OTHER",
  "LANGUAGE",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "IMAGE_SAFETY",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_OTHER",
  "NO_IMAGE",
  "IMAGE_RECITATION",
  "MISSING_THOUGHT_SIGNATURE",
];
function decodePart(value: unknown): Record<string, unknown> {
  const p = array(value, "response Part"),
    part: Record<string, unknown> = {};
  if (p[1] != null) part.text = string(p[1]);
  for (const [index, key, field1, field2] of [
    [2, "inlineData", "mimeType", "data"],
    [6, "fileData", "mimeType", "fileUri"],
  ] as const)
    if (p[index] != null) {
      const media = array(p[index]);
      part[key] = { [field1]: string(media[0]), [field2]: string(media[1]) };
    }
  if (p[5] != null) fail("response Drive file references require account-aware resolution");
  for (const [index, key, field] of [
    [10, "functionCall", "args"],
    [11, "functionResponse", "response"],
  ] as const)
    if (p[index] != null) {
      const c = array(p[index]),
        call: Record<string, unknown> = {
          name: string(c[0]),
          [field]: c[1] == null ? {} : decodeStruct(c[1]),
        };
      if (c[2] != null) call.id = string(c[2]);
      part[key] = call;
    }
  if (p[7] != null) {
    const code = array(p[7]);
    part.executableCode = {
      language: enumName(code[0], ["LANGUAGE_UNSPECIFIED", "PYTHON"], "code language"),
      code: string(code[1]),
    };
  }
  if (p[8] != null) {
    const code = array(p[8]);
    part.codeExecutionResult = {
      outcome: enumName(
        code[0],
        ["OUTCOME_UNSPECIFIED", "OUTCOME_OK", "OUTCOME_FAILED", "OUTCOME_DEADLINE_EXCEEDED"],
        "code outcome",
      ),
      output: code[1] == null ? "" : string(code[1]),
    };
  }
  if (p[12] != null) part.thought = wireBool(p[12]);
  if (p[14] != null) part.thoughtSignature = string(p[14]);
  if (Object.keys(part).length === 0) fail("response Part has no supported fields");
  return part;
}
function enumName(value: unknown, names: string[], path: string): string {
  const code = number(value, path, 0, Infinity, true);
  return names[code] ?? fail(`unknown ${path} code ${code}`);
}
function decodeRatings(value: unknown): Record<string, unknown>[] {
  return array(value, "safety ratings").map((item) => {
    const r = array(item),
      category = Object.entries(harmCategories).find(([, code]) => code === r[0])?.[0];
    if (!category) fail("unknown safety rating category");
    const result: Record<string, unknown> = {
      category,
      probability: enumName(
        r[1],
        ["HARM_PROBABILITY_UNSPECIFIED", "NEGLIGIBLE", "LOW", "MEDIUM", "HIGH"],
        "harm probability",
      ),
    };
    if (r[2] != null) result.blocked = wireBool(r[2]);
    return result;
  });
}

function decodeGrounding(value: unknown): Record<string, unknown> {
  const g = array(value, "grounding metadata"),
    result: Record<string, unknown> = {};
  if (g[0] != null) {
    const entry = array(g[0]);
    result.searchEntryPoint = {
      ...(entry[0] == null ? {} : { renderedContent: string(entry[0]) }),
      ...(entry[1] == null ? {} : { sdkBlob: string(entry[1]) }),
    };
  }
  if (g[1] != null)
    result.groundingChunks = array(g[1]).map((value) => {
      const chunk = array(value),
        index = chunk.findIndex((v) => v != null);
      if (index < 0 || index > 2 || chunk.filter((v) => v != null).length !== 1)
        fail("unknown grounding chunk source");
      const source = array(chunk[index]),
        fields: Record<string, unknown> = {};
      for (const [n, key] of ["uri", "title", "text", "placeId"].entries())
        if (source[n] != null) fields[key] = string(source[n]);
      return { [["web", "retrievedContext", "maps"][index]]: fields };
    });
  if (g[2] != null)
    result.groundingSupports = array(g[2]).map((value) => {
      const support = array(value),
        result: Record<string, unknown> = {};
      if (support[0] != null) {
        const s = array(support[0]),
          segment: Record<string, unknown> = {};
        for (const [index, key] of ["partIndex", "startIndex", "endIndex", "text"].entries())
          if (s[index] != null)
            segment[key] = index === 3 ? string(s[index]) : number(s[index], key, 0, Infinity, true);
        result.segment = segment;
      }
      if (support[1] != null)
        result.groundingChunkIndices = array(support[1]).map((v) =>
          number(v, "grounding chunk index", 0, Infinity, true),
        );
      if (support[2] != null)
        result.confidenceScores = array(support[2]).map((v) => number(v, "grounding confidence", 0, 1));
      return result;
    });
  if (g[3] != null && array(g[3])[1] != null)
    result.retrievalMetadata = {
      googleSearchDynamicRetrievalScore: number(array(g[3])[1]),
    };
  if (g[4] != null || g[5] != null)
    result.webSearchQueries = [
      ...new Set([
        ...(g[4] == null ? [] : strings(g[4], "search queries")),
        ...(g[5] == null ? [] : strings(g[5], "search queries")),
      ]),
    ];
  if (g[6] != null) result.googleMapsWidgetContextToken = string(g[6]);
  return result;
}

function decodeFrame(value: unknown, seen: Set<number>, finished: Set<number>): Record<string, unknown> {
  const frame = array(value, "GenerateContent frame");
  if (!frame.length) fail("empty GenerateContent frame");
  const response: Record<string, unknown> = {};
  if (frame[0] != null)
    response.candidates = array(frame[0], "candidates").map((value, position) => {
      const c = array(value, "candidate"),
        index = c[2] == null ? position : number(c[2], "candidate index", 0, Infinity, true);
      seen.add(index);
      const candidate: Record<string, unknown> = { index };
      if (c[0] != null) {
        const content = array(c[0], "candidate content");
        if (content[1] !== "model") fail("response content role must be model");
        candidate.content = {
          role: "model",
          parts: content[0] == null ? [] : array(content[0]).map(decodePart),
        };
      }
      if (c[1] != null) {
        candidate.finishReason = enumName(c[1], finishReasons, "finish reason");
        if (c[1] !== 0) finished.add(index);
      }
      if (c[3] != null) candidate.finishMessage = string(c[3]);
      if (c[4] != null) candidate.safetyRatings = decodeRatings(c[4]);
      if (c[6] != null) {
        const citations = array(c[6]);
        candidate.citationMetadata = {
          citationSources: (citations[0] == null ? [] : array(citations[0])).map((value) => {
            const citation = array(value),
              result: Record<string, unknown> = {};
            for (const [index, key] of [
              [0, "startIndex"],
              [1, "endIndex"],
              [2, "uri"],
              [3, "title"],
            ] as const)
              if (citation[index] != null)
                result[key] = index < 2 ? number(citation[index]) : string(citation[index]);
            return result;
          }),
        };
      }
      if (c[7] != null) candidate.groundingMetadata = decodeGrounding(c[7]);
      return candidate;
    });
  if (frame[1] != null) {
    const f = array(frame[1], "promptFeedback"),
      feedback: Record<string, unknown> = {};
    if (f[0] != null)
      feedback.blockReason = enumName(
        f[0],
        ["BLOCK_REASON_UNSPECIFIED", "SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"],
        "block reason",
      );
    if (f[1] != null) feedback.safetyRatings = decodeRatings(f[1]);
    if (f[2] != null) feedback.blockReasonMessage = string(f[2]);
    response.promptFeedback = feedback;
  }
  if (frame[2] != null) {
    const u = array(frame[2], "usageMetadata"),
      usage: Record<string, unknown> = {};
    for (const [index, key] of [
      [0, "promptTokenCount"],
      [1, "candidatesTokenCount"],
      [2, "totalTokenCount"],
      [3, "cachedContentTokenCount"],
      [7, "toolUsePromptTokenCount"],
      [9, "thoughtsTokenCount"],
    ] as const)
      if (u[index] != null) usage[key] = number(u[index], key, 0, Infinity, true);
    response.usageMetadata = usage;
  }
  if (frame[7] != null) response.responseId = string(frame[7], "responseId");
  return response;
}

/** Yield each complete root[0] message without waiting for the JSON root to end. */
export async function* decodeRPCStream(source: ReadableStream<Uint8Array>): AsyncGenerator<Wire> {
  const reader = source.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let state: "root" | "list" | "item" | "frame" | "separator" | "tail" | "error" = "root";
  let frame = "",
    tail = "",
    prefix = "",
    depth = 0,
    quoted = false,
    escaped = false,
    ended = false;
  try {
    while (true) {
      const next = await reader.read(),
        text = decoder.decode(next.value, { stream: !next.done });
      for (const char of text) {
        if (state === "error") {
          prefix += char;
          continue;
        }
        if (state === "tail") {
          tail += char;
          continue;
        }
        if (state === "frame") {
          frame += char;
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === "[" || char === "{") depth++;
          else if (char === "]" || char === "}") depth--;
          if (depth === 0) {
            const message = array(parseSparseJSON(frame), "RPC message") as Wire;
            state = "separator";
            frame = "";
            yield message;
          }
          continue;
        }
        if (/\s/.test(char)) continue;
        if (state === "root") {
          if (char !== "[") fail("GenerateContent root must be an array");
          prefix = "[";
          state = "list";
        } else if (state === "list") {
          if (char === "[") state = "item";
          else {
            prefix += char;
            state = "error";
          }
        } else if (state === "item") {
          if (char === "]") {
            state = "tail";
            continue;
          }
          if (char !== "[") fail("GenerateContent frame must be an array");
          frame = "[";
          depth = 1;
          quoted = false;
          escaped = false;
          state = "frame";
        } else if (state === "separator") {
          if (char === ",") state = "item";
          else if (char === "]") state = "tail";
          else fail("missing frame separator");
        }
      }
      if (next.done) {
        ended = true;
        break;
      }
    }
    if (state === "error") {
      const root = array(parseSparseJSON(prefix), "GenerateContent error");
      if (root[1] != null) fail(`upstream returned a private RPC error: ${errorBody(prefix)}`);
      fail("GenerateContent root[0] must be a repeated frame array");
    }
    if (state !== "tail") fail("truncated GenerateContent stream");
    const root = array(parseSparseJSON(`[[]${tail}`), "GenerateContent root");
    if (root[1] != null) fail(`upstream returned a private RPC error: ${errorBody(`[[]${tail}`)}`);
  } finally {
    if (!ended) {
      try {
        await reader.cancel();
      } catch {
        /* Preserve the decoding or consumer error. */
      }
    }
    reader.releaseLock();
  }
}

export async function* decodeGenerateStream(
  source: ReadableStream<Uint8Array>,
  continuation?: {
    limit: number;
    resume(token: string, round: number): Promise<Response>;
  },
): AsyncGenerator<Record<string, unknown>> {
  let previous: Record<string, unknown> | undefined;
  for (let round = 0; ; round++) {
    const seen = new Set<number>(),
      finished = new Set<number>();
    let blocked = false,
      token = "",
      resume = false;
    let usage: Record<string, unknown> | undefined;
    const more = continuation && (round + 1) * 32768 < continuation.limit;
    for await (const frame of decodeRPCStream(source)) {
      const continuing = new Set<number>();
      for (const [position, value] of (frame[0] == null ? [] : array(frame[0])).entries()) {
        const candidate = array(value) as Wire;
        if (candidate[8] != null && continuation) token = string(candidate[8], "continuation token");
        if (candidate[1] === 22) {
          if (!continuation || !token) fail("upstream requested continuation without a usable token");
          candidate[1] = 2;
        }
        if (candidate[1] === 2 && token && more) {
          resume = true;
          continuing.add(candidate[2] == null ? position : number(candidate[2]));
        }
      }
      const response = decodeFrame(frame, seen, finished);
      for (const candidate of (response.candidates || []) as Record<string, unknown>[])
        if (continuing.has(Number(candidate.index))) delete candidate.finishReason;
      if (response.usageMetadata) {
        usage = object(response.usageMetadata);
        if (previous) {
          const merged = { ...usage };
          let spent = 0;
          for (const key of ["candidatesTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount"]) {
            const old = Number(previous[key] || 0);
            spent += old;
            if (usage[key] !== undefined || old) merged[key] = Number(usage[key] || 0) + old;
          }
          if (usage.totalTokenCount !== undefined)
            merged.totalTokenCount = Number(usage.totalTokenCount) + spent;
          usage = merged;
          response.usageMetadata = merged;
        }
      }
      const feedback = response.promptFeedback;
      if (
        feedback &&
        object(feedback).blockReason !== undefined &&
        object(feedback).blockReason !== "BLOCK_REASON_UNSPECIFIED"
      )
        blocked = true;
      if (Object.keys(response).length) yield response;
    }
    if ((!seen.size && !blocked) || [...seen].some((index) => !finished.has(index)))
      fail("upstream stream ended before finish frame");
    if (!resume || blocked) return;
    previous = usage;
    const response = await continuation!.resume(token, round + 1);
    if (!response.ok || !response.body) {
      fail(`continuation failed: ${await responseError(response)}`);
    }
    source = response.body;
  }
}

/** Preserve signature boundaries while joining adjacent text deltas per candidate. */
export async function aggregateGenerate(
  chunks: AsyncIterable<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {},
    candidates = new Map<number, Record<string, unknown>>();
  for await (const chunk of chunks) {
    for (const [key, value] of Object.entries(chunk))
      if (key !== "candidates") result[key] = structuredClone(value);
    for (const value of chunk.candidates === undefined ? [] : array(chunk.candidates)) {
      const incoming = object(value),
        index = number(incoming.index ?? 0, "candidate index", 0, Infinity, true);
      const target = candidates.get(index) ?? {
          index,
          content: { role: "model", parts: [] },
        },
        parts = array(object(target.content).parts);
      for (const [key, value] of Object.entries(incoming))
        if (key !== "content") target[key] = structuredClone(value);
      if (incoming.content !== undefined)
        for (const value of array(object(incoming.content).parts)) {
          const part = structuredClone(object(value)),
            previous = parts.at(-1);
          if (
            part.thoughtSignature !== undefined &&
            Object.keys(part).length === 1 &&
            previous &&
            object(previous).thoughtSignature === undefined
          )
            object(previous).thoughtSignature = part.thoughtSignature;
          else if (
            previous &&
            typeof part.text === "string" &&
            typeof object(previous).text === "string" &&
            part.thought === object(previous).thought &&
            part.thoughtSignature === undefined &&
            object(previous).thoughtSignature === undefined &&
            Object.keys(part).every((k) => k === "text" || k === "thought") &&
            Object.keys(object(previous)).every((k) => k === "text" || k === "thought")
          )
            object(previous).text = String(object(previous).text) + part.text;
          else parts.push(part);
        }
      candidates.set(index, target);
    }
  }
  if (candidates.size)
    result.candidates = [...candidates.values()].sort((a, b) => Number(a.index) - Number(b.index));
  return result;
}

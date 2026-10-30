const voices = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];

export function speechRequest(data: Record<string, unknown>): {
  model: string;
  format: "wav" | "pcm";
  body: Record<string, unknown>;
} {
  for (const key of Object.keys(data))
    if (
      !["model", "input", "voice", "response_format", "speed", "instructions", "stream_format"].includes(key)
    )
      throw new Error(`Unsupported speech option: ${key}`);
  if (typeof data.model !== "string" || !/^[\w.-]+$/.test(data.model))
    throw new Error("Invalid speech model ID");
  if (typeof data.input !== "string" || !data.input.trim())
    throw new Error("Speech input must be nonempty text");
  if (typeof data.voice !== "string") throw new Error("Speech voice must be a Gemini prebuilt voice name");
  const voice = voices.find((value) => value.toLowerCase() === String(data.voice).toLowerCase());
  if (!voice) throw new Error("Unsupported speech voice; use a Gemini prebuilt voice such as Kore or Puck");
  // No codec dependency: WAV is PCM with a header, not an MP3 substitute.
  const format = data.response_format ?? "wav";
  if (format !== "wav" && format !== "pcm") throw new Error("Speech response_format must be wav or pcm");
  if (data.speed !== undefined && data.speed !== 1) throw new Error("Speech speed is only supported at 1");
  if (data.stream_format !== undefined && data.stream_format !== "audio")
    throw new Error("Speech stream_format must be audio; SSE is not supported");
  if (data.instructions !== undefined && typeof data.instructions !== "string")
    throw new Error("Speech instructions must be text");
  return {
    model: data.model,
    format,
    body: {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: data.input,
              ...(data.instructions ? { speechMetadata: { style: data.instructions } } : {}),
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        responseFormat: { audio: { mimeType: "AUDIO_L16", sampleRate: 24000 } },
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    },
  };
}

export function speechAudio(result: Record<string, unknown>, format: "wav" | "pcm"): Response {
  const feedback = result.promptFeedback as { blockReason?: string } | undefined;
  const candidates = result.candidates as
    | {
        finishReason?: string;
        content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; thought?: boolean }[] };
      }[]
    | undefined;
  const blocked =
    feedback?.blockReason ||
    (Array.isArray(candidates)
      ? candidates.find((candidate) =>
          ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(candidate?.finishReason || ""),
        )?.finishReason
      : undefined);
  if (blocked)
    return Response.json(
      { error: { code: 403, status: "PERMISSION_DENIED", message: `Speech blocked: ${blocked}` } },
      { status: 403 },
    );
  if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0]?.finishReason !== "STOP")
    throw new Error("Speech generation did not finish successfully");
  const parts = candidates[0].content?.parts;
  if (!Array.isArray(parts)) throw new Error("Speech response contains no audio");
  const chunks: Buffer[] = [];
  let size = 0;
  for (const part of parts) {
    if (part?.thought || !part?.inlineData) continue;
    const { mimeType, data } = part.inlineData;
    const mime =
      typeof mimeType === "string"
        ? mimeType
            .toLowerCase()
            .split(";")
            .map((v) => v.trim())
        : [];
    if (
      mime[0] !== "audio/l16" ||
      mime.slice(1).some((value) => !["codec=pcm", "rate=24000", "channels=1"].includes(value))
    )
      throw new Error("Speech response must be mono 24 kHz 16-bit PCM audio");
    if (typeof data !== "string" || !data.length || data.length > 48 * 1024 * 1024)
      throw new Error("Invalid speech audio base64");
    const chunk = Buffer.from(data, "base64");
    if (chunk.toString("base64") !== data) throw new Error("Invalid speech audio base64");
    if (!chunk.length || chunk.length % 2) throw new Error("Invalid PCM audio length");
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error("Speech audio exceeds 32 MiB");
    chunks.push(chunk);
  }
  if (!chunks.length) throw new Error("Speech response contains no audio");
  const pcm = Buffer.concat(chunks);
  if (format === "pcm") return new Response(pcm, { headers: { "content-type": "audio/pcm" } });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return new Response(Buffer.concat([header, pcm]), { headers: { "content-type": "audio/wav" } });
}

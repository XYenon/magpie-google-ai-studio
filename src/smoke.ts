import { StudioClient } from "./client.ts";
import { providerFetch, providerModels } from "./provider.ts";
import { importSession } from "./session.ts";

if (process.argv.includes("--help") || !process.argv[2]) {
  console.log(
    "Usage: bun run smoke <session-file> [model-id]\nLists account models and requests a short streamed response from Google AI Studio.",
  );
} else {
  const client = new StudioClient(await importSession(process.argv[2]));
  try {
    const models = await providerModels(client);
    console.error(`Found ${Object.keys(models).length} account models`);
    const model = process.argv[3] || Object.keys(models)[0];
    const response = await providerFetch(client)(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }] }),
      },
    );
    if (!response.ok) throw new Error(`Smoke request failed (${response.status}): ${await response.text()}`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = "",
      answer = "",
      finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      process.stdout.write(text);
      pending += text;
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const event = JSON.parse(pending.slice(0, end).replace(/^data: /, ""));
        pending = pending.slice(end + 2);
        if (event.error) throw new Error(`Smoke stream failed: ${event.error.message}`);
        for (const candidate of event.candidates || []) {
          if (candidate.finishReason) finished = true;
          for (const part of candidate.content?.parts || [])
            if (!part.thought && part.text) answer += part.text;
        }
      }
    }
    if (!finished || answer.trim() !== "OK")
      throw new Error("Smoke generation did not finish with the expected OK answer");
    console.error("Smoke generation passed");
  } finally {
    await client.close();
  }
}

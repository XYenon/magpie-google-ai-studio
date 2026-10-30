import { expect, test } from "bun:test";
import { providerFetch, type Transport } from "../src/provider.ts";

// Magpie v0.1.2075+ translates its image routes to Gemini streaming generation.
test("Magpie image generation and edits retain image modalities and bytes through Build", async () => {
  const image = "iVBORw0KGgo=";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-canvas:streamGenerateContent";
  for (const edit of [false, true]) {
    const transport: Transport = {
      async models() {
        return [];
      },
      async call() {
        throw new Error("Images must use generation with fresh WAA");
      },
      async generate(model, _request, encode) {
        expect(model).toBe("gemini-canvas");
        const encoded = encode(undefined, "UTC");
        expect(encoded.upstreamMethod).toBe("ProxyStreamedCall");
        expect(encoded.body[0]).toBe("/v1beta/models/gemini-canvas:streamGenerateContent");
        const sent = JSON.parse(String(encoded.body[1]));
        expect(sent.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
        expect(sent.contents[0].parts).toEqual([
          { text: "a blue magpie" },
          ...(edit ? [{ inlineData: { mimeType: "image/png", data: image } }] : []),
        ]);
        return new Response(
          JSON.stringify([
            [
              [
                JSON.stringify({
                  candidates: [
                    {
                      content: {
                        role: "model",
                        parts: [{ text: "Here" }, { inlineData: { mimeType: "image/png", data: image } }],
                      },
                      finishReason: "STOP",
                    },
                  ],
                  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 100 },
                }),
              ],
            ],
          ]),
        );
      },
    };
    const response = await providerFetch(transport)(url, {
      method: "POST",
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "a blue magpie" },
              ...(edit ? [{ inlineData: { mimeType: "image/png", data: image } }] : []),
            ],
          },
        ],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    });
    expect(response.status).toBe(200);
    const event = JSON.parse((await response.text()).trim().slice(6));
    expect(event.candidates[0].content.parts[1].inlineData).toEqual({ mimeType: "image/png", data: image });
    expect(event.candidates[0].finishReason).toBe("STOP");
  }
});

import { expect, test } from "bun:test";
import { type PageChunk, StudioBrowser } from "../src/browser.ts";

class CatalogBrowser extends StudioBrowser {
  cancelled = false;
  constructor(readonly response: PageChunk) {
    super({ version: 1, profile: "/unused", accountId: "fixture" }, {});
  }
  override async start(_id: string, method: string, body: unknown[]): Promise<void> {
    expect(method).toBe("ProxyUnaryCall");
    expect(body[0]).toBe("/v1beta/models");
  }
  override async poll(): Promise<PageChunk> {
    return this.response;
  }
  override async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

const response = (status: number, body: string): PageChunk => ({
  status,
  headers: [],
  chunks: [Buffer.from(body).toString("base64")],
  done: true,
  error: "",
});

test("Build catalog HTTP errors expose stable status without hiding diagnostics", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const browser = new CatalogBrowser(response(status, "catalog denied"));
    await expect(browser.buildModels()).rejects.toMatchObject({ status });
    expect(browser.cancelled).toBe(true);
  }
});

test("Build catalog rejects malformed JSON, invalid shape and excessive pagination", async () => {
  for (const body of [
    JSON.stringify(["not JSON"]),
    JSON.stringify([JSON.stringify({ models: {} })]),
    JSON.stringify([JSON.stringify({ models: [], nextPageToken: "again" })]),
  ]) {
    const browser = new CatalogBrowser(response(200, body));
    await expect(browser.buildModels()).rejects.toBeInstanceOf(Error);
    expect(browser.cancelled).toBe(true);
  }
});

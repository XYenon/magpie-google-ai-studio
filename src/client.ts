import { fileURLToPath } from "node:url";
import type { PageChunk } from "./browser.ts";
import { prepareBrowser } from "./dependencies.ts";
import type { EncodedRequest, ModelCatalog, Wire } from "./protocol.ts";
import {
  exportSession,
  exportSessionText,
  type Options,
  type Session,
  type StorageState,
} from "./session.ts";

export class StudioClient {
  private child?: Bun.Subprocess<"pipe", "pipe", "inherit">;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private queue: Promise<void> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private catalog?: ModelCatalog;
  private closing: Promise<unknown> = Promise.resolve();
  private proxy?: string;
  timezone = "UTC";

  constructor(
    readonly session: Session,
    readonly options: Options = {},
    private readonly workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url)),
  ) {}

  private async rpc<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeout = this.options.timeoutMs || 180_000,
  ): Promise<T> {
    if (!this.child) throw new Error("AI Studio browser is not running");
    const child = this.child;
    const id = ++this.sequence;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new DOMException(`AI Studio ${method} timed out`, "TimeoutError")),
        timeout,
      );
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    try {
      child.stdin.write(`${JSON.stringify({ id, method, ...params })}\n`);
      await child.stdin.flush();
    } catch {
      this.close(new Error("AI Studio browser process disconnected"));
    }
    return promise;
  }

  private async read(child: Bun.Subprocess<"pipe", "pipe", "inherit">): Promise<void> {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const bytes of child.stdout) {
        buffer += decoder.decode(bytes, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, end)) as {
            id: number;
            value: unknown;
            error?: string;
            signIn?: string;
          };
          buffer = buffer.slice(end + 1);
          const listener = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error)
            listener?.reject(
              Object.assign(new Error(message.error), {
                signIn: message.signIn,
              }),
            );
          else listener?.resolve(message.value);
        }
      }
    } catch {
      /* The connection failure below rejects all pending operations. */
    }
    if (this.child === child) this.close(new Error("AI Studio browser process exited"));
  }

  private async open(interactive = false, signal?: AbortSignal): Promise<void> {
    const worker = this.workerPath;
    if (this.child) {
      const probe = Bun.spawn([process.execPath, worker, "--proxy-signature"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const [proxy, code] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
      if (code !== 0) throw new Error("Cannot read the current browser proxy configuration");
      signal?.throwIfAborted();
      if (proxy === this.proxy) return;
      await this.close();
    }
    await this.closing;
    const options = await prepareBrowser(this.options);
    signal?.throwIfAborted();
    this.child = Bun.spawn([process.execPath, "--no-orphans", worker], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    void this.read(this.child);
    try {
      const result = await this.rpc<{ timezone: string; proxy: string }>(
        "open",
        { session: this.session, options, interactive },
        interactive ? 780_000 : undefined,
      );
      this.timezone = result.timezone;
      this.proxy = result.proxy;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async lock(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const previous = this.queue;
    let unlock!: () => void;
    this.queue = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    if (this.idle) clearTimeout(this.idle);
    if (signal?.aborted) {
      unlock();
      signal.throwIfAborted();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.idle = setTimeout(() => this.close(), 300_000);
      this.idle.unref();
      unlock();
    };
  }

  async login(): Promise<void> {
    const release = await this.lock();
    try {
      await this.open(true);
      await this.rpc("models");
    } finally {
      await this.close();
      release();
    }
  }

  async models(): Promise<ModelCatalog> {
    const release = await this.lock();
    try {
      await this.open();
      return (this.catalog = await this.rpc<ModelCatalog>("models"));
    } finally {
      release();
    }
  }

  generate(
    model: string,
    encode: (defaults: Wire, timezone: string) => EncodedRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.request(
      "GenerateContent",
      async () => {
        const catalog = (this.catalog ??= await this.rpc<ModelCatalog>("models"));
        if (!Object.hasOwn(catalog, model))
          throw new Error(`Model ${model} is not available for generation in this Google AI Studio account`);
        const { body, binding } = encode(catalog[model].defaults, this.timezone);
        return { body, binding };
      },
      signal,
    );
  }

  countTokens(body: Wire, signal?: AbortSignal): Promise<Response> {
    return this.request("CountTokens", () => ({ body }), signal);
  }

  async export(path?: string): Promise<string> {
    const release = await this.lock();
    try {
      await this.open();
      await this.rpc("models");
      const state = await this.rpc<StorageState>("snapshot");
      return path === undefined
        ? exportSessionText(this.session, state)
        : await exportSession(this.session, state, path);
    } finally {
      release();
    }
  }

  // The lease lasts until the response is consumed or cancelled. This also
  // serializes WebView evaluate calls when Magpie raises account concurrency.
  private async request(
    method: "GenerateContent" | "CountTokens",
    prepare: () => { body: Wire; binding?: string } | Promise<{ body: Wire; binding?: string }>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const release = await this.lock(signal);
    const id = crypto.randomUUID();
    const timeoutMs = this.options.timeoutMs || 180_000;
    const timeoutController = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const resetTimeout = () => {
      clearTimeout(timeoutTimer);
      if (finished) return;
      timeoutTimer = setTimeout(() => {
        timeoutController.abort(
          new DOMException(`The operation timed out after ${timeoutMs}ms`, "TimeoutError"),
        );
      }, timeoutMs);
      timeoutTimer.unref();
    };
    resetTimeout();
    const abort = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    const cleanup = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      abort.removeEventListener("abort", onAbort);
      try {
        if (this.child) await this.rpc("cancel", { requestId: id }, 5000);
      } catch {
        this.close();
      }
      release();
    };
    // Killing an account's isolated process also cancels navigation/bootstrap,
    // not only the final fetch, when the caller disconnects during startup.
    const onAbort = () => {
      void this.close(abort.reason);
      void cleanup();
    };
    abort.addEventListener("abort", onAbort, { once: true });
    try {
      abort.throwIfAborted();
      await this.open(false, abort);
      abort.throwIfAborted();
      const payload = await prepare();
      abort.throwIfAborted();
      await this.rpc(method, { requestId: id, ...payload });
      let head: PageChunk;
      for (;;) {
        abort.throwIfAborted();
        head = await this.rpc<PageChunk>("poll", { requestId: id });
        if (head.error)
          throw new Error("AI Studio page request failed; sign in again or check the page protocol");
        if (head.status) {
          resetTimeout();
          break;
        }
        await Bun.sleep(25);
      }
      let buffered: PageChunk | undefined = head;
      const stream = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            while (!finished) {
              abort.throwIfAborted();
              const result = buffered ?? (await this.rpc<PageChunk>("poll", { requestId: id }));
              buffered = undefined;
              if (result.error) throw new Error("AI Studio response stream interrupted");
              const chunks = result.chunks;
              if (chunks.length) resetTimeout();
              for (const chunk of chunks) controller.enqueue(Buffer.from(chunk, "base64"));
              if (result.done) {
                await cleanup();
                controller.close();
                return;
              }
              if (chunks.length) return;
              await Bun.sleep(25);
            }
            abort.throwIfAborted();
          } catch (error) {
            await cleanup();
            controller.error(error);
          }
        },
        cancel: cleanup,
      });
      return new Response(stream, {
        status: head.status,
        headers: head.headers,
      });
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  close(reason = new Error("AI Studio browser closed")): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.catalog = undefined;
    this.proxy = undefined;
    if (child) {
      // EOF lets the worker close Chrome and flush its cookie store. Sending
      // SIGTERM immediately can terminate Chrome before that flush completes.
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      this.closing = child.exited.finally(() => clearTimeout(timer));
    }
    for (const listener of this.pending.values()) listener.reject(reason);
    this.pending.clear();
    return this.closing.then(() => {});
  }
}

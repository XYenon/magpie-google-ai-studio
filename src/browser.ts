import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromePath } from "./dependencies.ts";
import { cancelFetch, INSTALL, launchFetch, readFetch } from "./page.ts";
import { parseModels, parseSparseJSON, type Wire } from "./protocol.ts";
import { browserProxy } from "./proxy.ts";
import { type Options, type Session, type StorageState, storageState } from "./session.ts";

export { chromePath } from "./dependencies.ts";

const ORIGIN = "https://aistudio.google.com";
const RPC =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";

export interface PageChunk {
  status: number;
  headers: [string, string][];
  chunks: string[];
  done: boolean;
  error: string;
}

export class StudioBrowser {
  view!: Bun.WebView;
  catalog?: Wire;
  timezone = "UTC";
  private chrome?: ReturnType<typeof Bun.spawn>;
  private headers: Record<string, string> = {};
  private bootstrapped = false;
  private closing?: Promise<void>;
  private proxy?: Awaited<ReturnType<typeof browserProxy>>;

  constructor(
    readonly session: Session,
    readonly options: Options,
  ) {}

  async open(interactive = false): Promise<void> {
    if (typeof Bun.WebView !== "function")
      throw new Error("The Bun runtime used by Magpie must provide Bun.WebView");
    await access(this.session.profile);
    const path = chromePath(this.options.chromePath);
    const configuredArgs = this.options.chromeArgs || [];
    this.proxy = await browserProxy(configuredArgs);
    const argv = [...this.proxy.args, ...configuredArgs];
    if (interactive) {
      // Google can reject sign-in inside a browser controlled by automation.
      // Let the user sign in with ordinary Chrome, then reopen its persisted
      // profile with WebView only after the user has closed the login window.
      this.chrome = Bun.spawn(
        [
          path,
          `--user-data-dir=${this.session.profile}`,
          "--no-first-run",
          "--no-default-browser-check",
          ...argv,
          "--allow-browser-signin=false",
          `${ORIGIN}/prompts/new_chat`,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          this.chrome.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Timed out waiting for the login window to close")),
              600_000,
            );
          }),
        ]);
        if (code !== 0)
          throw new Error(
            "Chrome login window exited unsuccessfully. Use a desktop session or import a storage-state file.",
          );
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.chrome = undefined;
    }
    // Own the process so close() can wait for Chrome to finish writing its
    // profile. WebView's spawned backend exposes no process-exit promise.
    const portFile = join(this.session.profile, "DevToolsActivePort");
    await rm(portFile, { force: true });
    this.chrome = Bun.spawn(
      [
        path,
        `--user-data-dir=${this.session.profile}`,
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-blink-features=AutomationControlled",
        ...argv,
        // Dice can log out imported web cookies when the new profile has no
        // Chrome OAuth tokens. This provider uses website login exclusively.
        "--allow-browser-signin=false",
        "about:blank",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    let endpoint = "";
    for (let attempt = 0; attempt < 150; attempt++) {
      if (this.chrome.exitCode !== null) throw new Error("Chrome exited before starting WebView");
      const file = Bun.file(portFile);
      if (await file.exists()) {
        const [port, path] = (await file.text()).trim().split("\n");
        if (/^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) {
          endpoint = `ws://127.0.0.1:${port}${path}`;
          break;
        }
      }
      await Bun.sleep(100);
    }
    if (!endpoint) throw new Error("Timed out starting Chrome for WebView");
    this.view = new Bun.WebView({
      backend: { type: "chrome", url: endpoint },
      width: 1280,
      height: 900,
    });
    await this.view.navigate("about:blank");
    // AI Studio rejects the default headless identity even with a valid login.
    // Keep Chrome's actual platform/version, without the HeadlessChrome token.
    const { userAgent } = await this.view.cdp<{ userAgent: string }>("Browser.getVersion");
    await this.view.cdp("Network.setUserAgentOverride", {
      userAgent: userAgent.replace("HeadlessChrome/", "Chrome/"),
    });
    await this.view.cdp("Network.enable");
    this.view.addEventListener("Network.requestWillBeSent", (event) => {
      const data = (
        event as unknown as {
          data: { request: { url: string; headers: Record<string, string> } };
        }
      ).data;
      if (!data.request.url.startsWith(RPC)) return;
      for (const [name, value] of Object.entries(data.request.headers)) {
        if (/^(x-goog-|x-aistudio-|x-user-agent|content-type)/i.test(name))
          this.headers[name.toLowerCase()] = value;
      }
    });
    await this.view.cdp("Page.addScriptToEvaluateOnNewDocument", {
      source: `if (location.origin === ${JSON.stringify(ORIGIN)}) ${INSTALL}`,
    });
    const importScript = await this.restoreStorage();
    const model = this.options.bootstrapModel;
    await this.view.navigate(
      `${ORIGIN}/prompts/new_chat${model ? `?model=${encodeURIComponent(model)}` : ""}`,
    );
    await this.wait(
      `(() => {
      if (location.hostname === 'accounts.google.com') return 'expired';
      if (location.pathname.includes('/u/') || location.pathname.includes('/prompts/')) {
        return [...document.querySelectorAll('ms-prompt-box textarea')].some(el => el.checkVisibility());
      }
      if (location.pathname.includes('unavailable')) return 'unavailable';
      return false;
    })()`,
      90_000,
    );
    this.timezone = await this.view.evaluate<string>("Intl.DateTimeFormat().resolvedOptions().timeZone");
    await this.syncHeaders();
    if (importScript) {
      await this.view.cdp("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: importScript,
      });
      await rm(join(this.session.profile, "storage-state.json"), {
        force: true,
      });
    }
  }

  private async restoreStorage(): Promise<string | undefined> {
    const file = Bun.file(join(this.session.profile, "storage-state.json"));
    if (!(await file.exists())) return;
    const state = storageState(await file.json());
    await this.view.cdp("Network.setCookies", { cookies: state.cookies });
    const { identifier } = await this.view.cdp<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `(() => {
      for (const origin of ${JSON.stringify(state.origins)}) {
        if (location.origin !== origin.origin) continue;
        for (const item of origin.localStorage) localStorage.setItem(item.name, item.value);
        for (const item of origin.sessionStorage || []) sessionStorage.setItem(item.name, item.value);
      }
    })()`,
      },
    );
    return identifier;
  }

  async snapshot(): Promise<StorageState> {
    const { cookies } = await this.view.cdp<{ cookies: unknown[] }>("Storage.getCookies");
    const origin = await this.view.evaluate<StorageState["origins"][number]>(`({
      origin: location.origin,
      localStorage: Object.entries(localStorage).map(([name, value]) => ({name, value})),
      sessionStorage: Object.entries(sessionStorage).map(([name, value]) => ({name, value}))
    })`);
    if (origin.origin !== ORIGIN)
      throw new Error("Open the signed-in AI Studio page before exporting a session");
    return storageState({ cookies, origins: [origin] });
  }

  private async syncHeaders(): Promise<void> {
    await this.wait("Boolean(window.__magpieStudio)", 15_000);
    await this.view.evaluate(`Object.assign(window.__magpieStudio.headers, ${JSON.stringify(this.headers)})`);
    if (!this.headers["x-goog-api-key"]) {
      throw new Error(
        "AI Studio did not expose its RPC headers. Complete onboarding and accept terms in the login window, then retry.",
      );
    }
  }

  private async wait(expression: string, timeout = this.options.timeoutMs || 120_000): Promise<void> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await this.view.evaluate(expression);
      if (result === "expired")
        throw Object.assign(new Error("Google AI Studio session expired. Sign in again."), {
          signIn: "expired",
        });
      if (result === "unavailable")
        throw new Error("Google AI Studio is unavailable for this account or region");
      if (result) return;
      await Bun.sleep(100);
    }
    throw new Error(
      "Timed out waiting for AI Studio. Check account access, onboarding, network and the current page protocol.",
    );
  }

  async listModels(): Promise<Wire> {
    await this.syncHeaders();
    const response = await this.request("ListModels", []);
    const value = parseSparseJSON(await response.text());
    parseModels(value);
    this.catalog = value as Wire;
    return this.catalog;
  }

  async buildModels(): Promise<Record<string, unknown>[]> {
    const models: Record<string, unknown>[] = [];
    let pageToken: unknown;
    for (let page = 0; page < 10; page++) {
      const response = await this.request("ProxyUnaryCall", [
        "/v1beta/models",
        JSON.stringify({
          pageSize: "200",
          ...(pageToken ? { pageToken } : {}),
        }),
        null,
        "GET",
      ]);
      const wire = parseSparseJSON(await response.text()) as Wire;
      const data = JSON.parse(String(wire[0]));
      if (!Array.isArray(data.models)) throw new Error("Invalid Build model catalog");
      models.push(...data.models);
      pageToken = data.nextPageToken;
      if (!pageToken) return models;
    }
    throw new Error("Build model catalog pagination exceeded ten pages");
  }

  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const catalog = this.catalog || (await this.listModels());
    const ids = Object.keys(parseModels(catalog));
    const model = this.options.bootstrapModel || ids[0];
    if (!ids.includes(model))
      throw new Error("bootstrapModel is not available in this account's GenerateContent catalog");
    await this.view.navigate(`${ORIGIN}/prompts/new_chat?model=${encodeURIComponent(model)}&temporary=true`);
    await this.wait("Boolean(window.__magpieStudio?.hook())", 30_000);
    await this.wait(
      "[...document.querySelectorAll('ms-prompt-box textarea')].some(el => el.checkVisibility())",
      30_000,
    );
    for (const selector of [
      "ms-g1-welcome-dialog button[aria-label='Close dialog']",
      "button[aria-label='Close guided tour']",
      "#glue-cookie-notification-bar-1 .glue-cookie-notification-bar__reject",
    ]) {
      const visible = await this.view.evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`,
      );
      if (visible) await this.view.click(selector, { timeout: 3000 });
    }
    await this.view.evaluate("window.__magpieStudio.bootstrap = true");
    await this.view.click("ms-prompt-box textarea", { timeout: 15_000 });
    await this.view.type("Google AI Studio provider initialization");
    await this.view.click("ms-run-button button:not(:disabled)", {
      timeout: 15_000,
    });
    await this.wait("Boolean(window.__magpieStudio.captured && window.__magpieStudio.service)", 60_000);
    const captured = await this.view.evaluate<{
      body: string;
      headers: Record<string, string>;
    }>("({body: window.__magpieStudio.body, headers: window.__magpieStudio.headers})");
    if (!captured.body || (parseSparseJSON(captured.body) as Wire)[0] !== `models/${model}`)
      throw new Error("AI Studio bootstrap model/body does not match the requested model");
    for (const name of ["x-goog-api-key", "x-goog-authuser", "x-user-agent"]) {
      if (!captured.headers[name]) throw new Error(`AI Studio bootstrap did not capture ${name}`);
    }
    await this.view.evaluate("window.__magpieStudio.bootstrap = false");
    this.bootstrapped = true;
  }

  async start(id: string, method: string, body: Wire, binding?: string, proofIndex = 4): Promise<void> {
    await this.view.evaluate(launchFetch(id, RPC + method, body, binding, proofIndex));
  }

  async poll(id: string): Promise<PageChunk> {
    return this.view.evaluate<PageChunk>(readFetch(id));
  }

  async cancel(id: string): Promise<void> {
    await this.view.evaluate(cancelFetch(id));
  }

  private async request(method: string, body: Wire): Promise<Response> {
    const id = crypto.randomUUID();
    await this.start(id, method, body);
    const chunks: Uint8Array[] = [];
    const end = Date.now() + (this.options.timeoutMs || 120_000);
    try {
      while (Date.now() < end) {
        const result = await this.poll(id);
        if (result.error) throw new Error("AI Studio page fetch failed");
        for (const chunk of result.chunks) chunks.push(Buffer.from(chunk, "base64"));
        if (result.done) {
          if (result.status === 401)
            throw Object.assign(new Error("Google session expired"), {
              signIn: "expired",
            });
          if (result.status < 200 || result.status >= 300)
            throw new Error(`AI Studio ${method} returned HTTP ${result.status}`);
          return new Response(Buffer.concat(chunks));
        }
        await Bun.sleep(25);
      }
      throw new Error(`AI Studio ${method} timed out`);
    } finally {
      await this.cancel(id);
    }
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      try {
        if (this.view) await Promise.race([this.view.cdp("Browser.close"), Bun.sleep(2000)]);
        else this.chrome?.kill();
      } catch {
        /* The browser closing its connection is expected. */
      }
      if (this.chrome) {
        const chrome = this.chrome;
        const timer = setTimeout(() => chrome.kill("SIGKILL"), 5000);
        try {
          await chrome.exited;
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        this.view?.close();
      } finally {
        await this.proxy?.close();
      }
    })());
  }
}

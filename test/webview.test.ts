import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { StudioClient } from "../src/client.ts";
import { cancelFetch, INSTALL, launchFetch, readFetch } from "../src/page.ts";
import type { Wire } from "../src/protocol.ts";
import { providerFetch } from "../src/provider.ts";
import { createSession, importSessionText } from "../src/session.ts";

const enabled = process.env.AISTUDIO_WEBVIEW_TEST === "1";

test.skipIf(!enabled)(
  "Bun.WebView sends fresh WAA-bound requests and SAPISID auth, streams bytes, and cancels",
  async () => {
    const received: { body: unknown[]; authorization: string | null; cookie: string | null }[] = [];
    const encoder = new TextEncoder();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/")
          return new Response("<!doctype html><title>Transport fixture</title>", {
            headers: {
              "content-type": "text/html",
              "set-cookie": "SAPISID=fixture-session; Path=/; SameSite=Lax",
            },
          });
        if (req.method !== "POST") return new Response(null, { status: 404 });
        received.push({
          body: await req.json(),
          authorization: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
        });
        if (url.pathname === "/hold")
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(encoder.encode("start"));
              },
              cancel() {
                finish();
              },
            }),
          );
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode("前半段"));
              await finished;
              controller.enqueue(encoder.encode("后半段"));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json+protobuf" } },
        );
      },
    });
    const view = new Bun.WebView({ backend: { type: "chrome", url: false }, width: 1280, height: 720 });
    const poll = async (
      id: string,
      predicate: (value: { chunks: string[]; done: boolean; error: string }) => boolean,
    ) => {
      const chunks: string[] = [];
      for (let n = 0; n < 200; n++) {
        const result = await view.evaluate<{ chunks: string[]; done: boolean; error: string }>(readFetch(id));
        if (result.error) throw new Error(result.error);
        chunks.push(...result.chunks);
        if (predicate(result)) return { ...result, chunks };
        await Bun.sleep(10);
      }
      throw new Error("Timed out waiting for browser transport");
    };
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      await view.navigate(origin);
      await view.evaluate(INSTALL);
      await view.evaluate(`(() => {
      window.default_MakerSuite = { proof: async function(service, digest) { /* yield */ return service.snapshot({content: digest}); } };
      window.__magpieStudio.hook();
      const service = {counter: 0, snapshot({content}) { return Promise.resolve('!'+content+':'+(++this.counter)); }};
      return window.default_MakerSuite.proof(service, 'bootstrap');
    })()`);
      await view.evaluate(
        launchFetch(
          "first",
          `${origin}/generate`,
          ["models/fixture", [], null, null, null],
          "你好 attachment",
        ),
      );
      const first = await poll("first", (result) => result.chunks.length > 0);
      expect(Buffer.concat(first.chunks.map((s) => Buffer.from(s, "base64"))).toString()).toBe("前半段");
      expect(first.done).toBe(false);
      expect(received[0].body[4]).toBe(`!${createHash("sha256").update("你好 attachment").digest("hex")}:2`);
      expect(received[0].cookie).toContain("SAPISID=fixture-session");
      const signature = received[0].authorization!.match(/^SAPISIDHASH (\d+)_([a-f0-9]+)$/)!;
      expect(signature).not.toBeNull();
      expect(signature[2]).toBe(
        createHash("sha1")
          .update(`${signature[1]} fixture-session https://aistudio.google.com`)
          .digest("hex"),
      );
      finish();
      const last = await poll("first", (result) => result.done);
      expect(Buffer.concat(last.chunks.map((s) => Buffer.from(s, "base64"))).toString()).toBe("后半段");
      await view.evaluate(cancelFetch("first"));
      await view.evaluate(
        launchFetch("second", `${origin}/hold`, ["models/fixture", [], null, null, null], "different"),
      );
      await poll("second", (result) => result.chunks.length > 0);
      expect(received[1].body[4]).toBe(`!${createHash("sha256").update("different").digest("hex")}:3`);
      await view.evaluate(cancelFetch("second"));
      await expect(view.evaluate(readFetch("second"))).rejects.toThrow("Unknown page request");
      // The bootstrap request is captured before reaching the server.
      await view.evaluate("window.__magpieStudio.bootstrap = true");
      const intercepted = await view.evaluate<boolean>(
        `fetch(${JSON.stringify(`${origin}/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent`)}, {method:'POST', headers:{'x-goog-api-key':'fixture-key'}, body:'["models/fixture"]'}).then(() => false, () => true)`,
      );
      expect(intercepted).toBe(true);
      expect(received).toHaveLength(2);
      expect(await view.evaluate("window.__magpieStudio.captured")).toBe(true);
    } finally {
      finish();
      view.close();
      server.stop(true);
    }
  },
  15_000,
);

test.skipIf(!enabled)(
  "Bun.WebView persists a session across isolated account processes",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "magpie-studio-profile-"));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<!doctype html><title>Persistence fixture</title>", {
          headers: { "content-type": "text/html" },
        }),
    });
    try {
      const run = async (setCookie: boolean) => {
        const source = `
        import { StudioBrowser, chromePath } from ${JSON.stringify(new URL("../src/browser.ts", import.meta.url).href)};
        const browser = new StudioBrowser({version:1, profile:${JSON.stringify(profile)}, accountId:'fixture'}, {});
        browser.view = new Bun.WebView({backend:{type:'chrome', path:chromePath()}, dataStore:{directory:${JSON.stringify(profile)}}});
        try {
          await browser.view.navigate(${JSON.stringify(`http://127.0.0.1:${server.port}`)});
          ${setCookie ? "await browser.view.evaluate(\"document.cookie = 'persisted=fixture-session; Path=/; Max-Age=3600'\");" : ""}
          console.log(await browser.view.evaluate("document.cookie.includes('persisted=fixture-session')"));
        } finally { await browser.close(); }
      `;
        const child = Bun.spawn([process.execPath, "--no-orphans", "--eval", source], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [output, error, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) throw new Error(`WebView fixture process failed: ${error}`);
        return output.trim();
      };
      expect(await run(true)).toBe("true");
      expect(await run(false)).toBe("true");
    } finally {
      server.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(!enabled)(
  "portable browser state works without the source profile and survives a destination restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "magpie-studio-transfer-"));
    const previous = process.env.MAGPIE_AISTUDIO_DATA_DIR;
    const proxyVars = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
      "MAGPIE_HTTP_PROXY",
      "MAGPIE_HTTPS_PROXY",
      "MAGPIE_ALL_PROXY",
      "MAGPIE_NO_PROXY",
    ];
    const previousProxy = proxyVars.map((key) => [key, process.env[key]] as const);
    const clients: StudioClient[] = [];
    let seed = true;
    const key = join(root, "key.pem"),
      cert = join(root, "cert.pem");
    const generated = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=aistudio.google.com",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(generated.exitCode).toBe(0);
    const row: Wire = Array(65).fill(null);
    row[0] = "models/fixture";
    row[3] = "Fixture";
    row[5] = 1024;
    row[6] = 128;
    row[7] = ["generateContent"];
    row[64] = [];
    const rpc =
      "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
    // Gaia ListAccountsResponse: one valid cookie account, no Chrome OAuth
    // tokens. A Chrome Dice reconcilor must not sign this web account out.
    const email = Buffer.from("fixture@example.com"),
      id = Buffer.from("12345");
    const account = Buffer.concat([
      Buffer.from([0x1a, email.length]),
      email,
      Buffer.from([0x48, 1, 0x52, id.length]),
      id,
      Buffer.from([0x70, 0, 0x78, 1]),
    ]);
    const gaia = Buffer.concat([Buffer.from([0x0a, account.length]), account]).toString("base64");
    let signedIn = true;
    const routes = new Map<number, string>();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ListAccounts")
          return new Response(
            url.searchParams.get("laf") === "b64bin"
              ? gaia
              : JSON.stringify([
                  "gaia.l.a.r",
                  [["gaia.l.a", 1, "", "fixture@example.com", "", 1, 1, 0, 0, 1, "12345"]],
                ]),
          );
        if (url.pathname === "/Logout") {
          if (req.headers.get("cookie")?.includes("SID=fixture-httponly")) signedIn = false;
          return new Response("Signed out");
        }
        const headers = new Headers({
          "access-control-allow-origin": "https://aistudio.google.com",
          "access-control-allow-credentials": "true",
          "access-control-allow-headers": "*",
        });
        if (req.method === "OPTIONS") {
          headers.set(
            "access-control-allow-headers",
            req.headers.get("access-control-request-headers") || "",
          );
          return new Response(null, { status: 204, headers });
        }
        if (new URL(req.url).pathname.startsWith("/prompts/")) {
          headers.set("content-type", "text/html");
          if (seed) {
            headers.append(
              "set-cookie",
              "SAPISID=fixture-signing; Domain=.google.com; Path=/; Secure; SameSite=None; Max-Age=3600",
            );
            headers.append(
              "set-cookie",
              "SID=fixture-httponly; Domain=.google.com; Path=/; Secure; HttpOnly; Max-Age=3600",
            );
          }
          return new Response(
            `<!doctype html><body><script>
            ${seed ? "localStorage.setItem('fixture','persisted');sessionStorage.setItem('context','portable');" : ""}
            const headers = {'content-type':'application/json+protobuf','x-goog-api-key':'fixture-key','x-goog-authuser':'0','x-user-agent':'fixture','x-goog-fixture-state':localStorage.getItem('fixture') || ''};
            window.default_MakerSuite = { proof: async function(service, digest) { /* yield */ return service.snapshot({content:digest}); } };
            fetch(${JSON.stringify(`${rpc}ListModels`)},{method:'POST',headers,credentials:'include',body:'[]'}).then(() => {
              document.body.insertAdjacentHTML('beforeend','<ms-prompt-box><textarea></textarea></ms-prompt-box><ms-run-button><button>Run</button></ms-run-button>');
              document.querySelector('button').onclick = async () => {
                const proof = await window.default_MakerSuite.proof({snapshot:({content})=>Promise.resolve('!'+content)},'bootstrap');
                fetch(${JSON.stringify(`${rpc}GenerateContent`)},{method:'POST',headers,credentials:'include',body:JSON.stringify(['models/fixture',null,null,null,proof])}).catch(()=>{});
              };
            });
          </script>`,
            { headers },
          );
        }
        const cookie = req.headers.get("cookie") || "";
        if (
          !signedIn ||
          !cookie.includes("SAPISID=fixture-signing") ||
          !cookie.includes("SID=fixture-httponly") ||
          req.headers.get("x-goog-fixture-state") !== "persisted"
        )
          return new Response("unauthenticated fixture", { status: 403, headers });
        headers.set("content-type", "application/json+protobuf");
        const content = [[[null, "OK"]], "model"];
        const frame = [[[content, 1, 0]], null, [6, 1, 7]];
        const model = [...row];
        model[3] = routes.get(server.requestIP(req)?.port || 0) || "direct";
        return new Response(
          JSON.stringify(new URL(req.url).pathname.endsWith("ListModels") ? [[model]] : [[frame]]),
          { headers },
        );
      },
    });
    const tunnels = new Set<Duplex>();
    const proxyFor = async (name: string, authorization?: string) => {
      const proxy = createServer((_req, res) => {
        res.writeHead(502);
        res.end();
      });
      proxy.on("connect", (req, client, head) => {
        if (req.headers["proxy-authorization"] !== authorization) {
          client.end(
            "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=fixture\r\n\r\n",
          );
          return;
        }
        if (
          !/^(aistudio\.google\.com|alkalimakersuite-pa\.clients6\.google\.com|accounts\.google\.com):443$/.test(
            req.url || "",
          )
        ) {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          return;
        }
        const upstream = connect(server.port!, "127.0.0.1", () => {
          const port = upstream.localPort!;
          routes.set(port, name);
          upstream.once("close", () => routes.delete(port));
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        for (const socket of [client, upstream]) {
          tunnels.add(socket);
          socket.once("close", () => tunnels.delete(socket));
        }
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("Cannot start test proxy");
      return { proxy, url: `http://127.0.0.1:${address.port}` };
    };
    const first = await proxyFor("proxy-a");
    const authenticated = await proxyFor(
      "proxy-b",
      `Basic ${Buffer.from("fixture+name:p:@/ word").toString("base64")}`,
    );
    const authenticatedURL = new URL(authenticated.url);
    authenticatedURL.username = "fixture+name";
    authenticatedURL.password = "p:@/ word";
    const options = {
      chromeArgs: [
        "--ignore-certificate-errors",
        "--gaia-url=https://accounts.google.com/",
        `--host-resolver-rules=MAP aistudio.google.com 127.0.0.1:${server.port}, MAP alkalimakersuite-pa.clients6.google.com 127.0.0.1:${server.port}, MAP accounts.google.com 127.0.0.1:${server.port}`,
      ],
    };
    const clientFor = (session: Awaited<ReturnType<typeof createSession>>) => {
      const client = new StudioClient(session, options);
      clients.push(client);
      return client;
    };
    try {
      for (const key of proxyVars) delete process.env[key];
      process.env.HTTP_PROXY = "http://127.0.0.1:1";
      process.env.HTTPS_PROXY = first.url;
      process.env.MAGPIE_AISTUDIO_DATA_DIR = join(root, "source");
      const source = await createSession("fixture-account");
      const from = clientFor(source);
      expect(((await from.models())[0] as Wire[])[0][3]).toBe("proxy-a");
      const portable = await from.export(join(root, "portable.aistudio.json"));
      const text = await from.export();
      const exported = await Bun.file(portable).json();
      expect(
        exported.cookies.some((c: { name: string; httpOnly?: boolean }) => c.name === "SID" && c.httpOnly),
      ).toBe(true);
      expect(exported.origins[0].sessionStorage).toContainEqual({ name: "context", value: "portable" });
      await from.close();
      await rm(source.profile, { recursive: true });
      seed = false;

      process.env.HTTPS_PROXY = authenticatedURL.href;
      process.env.MAGPIE_AISTUDIO_DATA_DIR = join(root, "destination");
      const empty = clientFor(await createSession("empty-control"));
      await expect(empty.models()).rejects.toThrow();
      await empty.close();
      const destination = await importSessionText(text);
      const to = clientFor(destination);
      row[3] = "proxy-b";
      expect((await to.models())[0]).toEqual([row]);
      // Let Chrome's asynchronous account consistency task finish before
      // verifying that the imported session still authorizes requests.
      await Bun.sleep(1000);
      await to.export(join(root, "second-export.aistudio.json"));
      expect(
        (await Bun.file(join(root, "second-export.aistudio.json")).json()).origins[0].sessionStorage,
      ).toContainEqual({ name: "context", value: "portable" });
      process.env.HTTPS_PROXY = first.url;
      expect(((await to.models())[0] as Wire[])[0][3]).toBe("proxy-a");
      process.env.NO_PROXY = ".google.com,.clients6.google.com";
      expect(((await to.models())[0] as Wire[])[0][3]).toBe("direct");
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
      process.env.MAGPIE_HTTPS_PROXY = first.url;
      expect(((await to.models())[0] as Wire[])[0][3]).toBe("direct");
      await to.close();
      process.env.HTTPS_PROXY = authenticatedURL.href;
      const manual = new StudioClient(destination, {
        ...options,
        chromeArgs: [...options.chromeArgs, `--proxy-server=${first.url}`],
      });
      clients.push(manual);
      expect(((await manual.models())[0] as Wire[])[0][3]).toBe("proxy-a");
      await manual.close();
      const restarted = clientFor(destination);
      const response = await providerFetch(restarted)(
        "https://generativelanguage.googleapis.com/v1beta/models/fixture:generateContent",
        {
          method: "POST",
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply OK" }] }] }),
        },
      );
      expect({ status: response.status, body: await response.json() }).toMatchObject({
        status: 200,
        body: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] },
      });
    } finally {
      for (const client of clients) await client.close();
      if (previous === undefined) delete process.env.MAGPIE_AISTUDIO_DATA_DIR;
      else process.env.MAGPIE_AISTUDIO_DATA_DIR = previous;
      for (const [key, value] of previousProxy) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const socket of tunnels) socket.destroy();
      await Promise.all(
        [first.proxy, authenticated.proxy].map(
          (proxy) => new Promise<void>((resolve) => proxy.close(() => resolve())),
        ),
      );
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

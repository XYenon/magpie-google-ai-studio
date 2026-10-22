import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket, connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

function environment() {
  const env = process.env;
  const all = env.ALL_PROXY || env.all_proxy || "";
  return {
    http: env.HTTP_PROXY || env.http_proxy || all,
    https: env.HTTPS_PROXY || env.https_proxy || all,
    no: env.NO_PROXY || env.no_proxy || "",
    // Magpie keeps its global proxy in MAGPIE_* and injects the effective
    // account proxy as ordinary *_PROXY only into the spawned worker. Never
    // fall back to MAGPIE_* here: their absence from *_PROXY can mean direct.
    magpie: Object.keys(env).some((key) => /^MAGPIE_(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)),
  };
}

export function proxySignature(): string {
  return createHash("sha256").update(JSON.stringify(environment())).digest("hex");
}

async function authenticatedProxy(proxy: URL) {
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:")
    throw new Error("Authenticated browser proxies must use HTTP or HTTPS");
  let authorization: string;
  try {
    authorization =
      "Basic " +
      Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString(
        "base64",
      );
  } catch {
    throw new Error("Invalid browser proxy credentials");
  }
  const endpoint = new URL(proxy);
  endpoint.username = endpoint.password = "";
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((req, res) => {
    const upstream = (proxy.protocol === "https:" ? httpsRequest : httpRequest)(
      endpoint,
      {
        method: req.method,
        path: req.url,
        headers: { ...req.headers, "proxy-authorization": authorization },
      },
      (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502);
        res.end("Proxy connection failed");
      }
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", track);
  server.on("connect", (req, client, head) => {
    const host = proxy.hostname.replace(/^\[|\]$/g, "");
    const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const upstream = track(
      proxy.protocol === "https:"
        ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host })
        : tcpConnect({ host, port }),
    );
    upstream.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
      upstream.write(
        `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${authorization}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start browser proxy");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export async function browserProxy(args: string[]) {
  const relays: Awaited<ReturnType<typeof authenticatedProxy>>[] = [];
  const close = async () => {
    await Promise.all(relays.map((relay) => relay.close()));
  };
  if (args.some((arg) => /^--(proxy-server|proxy-pac-url|proxy-auto-detect|no-proxy-server)(=|$)/.test(arg)))
    return { args: [], close };
  const env = environment();
  if (env.no.split(",").some((item) => item.trim() === "*") || (!env.http && !env.https && env.magpie))
    return { args: ["--no-proxy-server"], close };
  const servers: string[] = [];
  const urls = new Map<string, string>();
  try {
    for (const scheme of ["http", "https"] as const) {
      const value = env[scheme];
      if (!value) continue;
      let address = urls.get(value);
      if (!address) {
        let proxy: URL;
        try {
          proxy = new URL(value);
        } catch {
          throw new Error("Invalid browser proxy URL");
        }
        if (!["http:", "https:", "socks4:", "socks5:", "socks5h:"].includes(proxy.protocol))
          throw new Error("Unsupported browser proxy protocol");
        if (proxy.username || proxy.password) {
          const relay = await authenticatedProxy(proxy);
          relays.push(relay);
          address = relay.url;
        } else {
          address = `${proxy.protocol === "socks5h:" ? "socks5:" : proxy.protocol}//${proxy.host}`;
        }
        urls.set(value, address);
      }
      servers.push(`${scheme}=${address}`);
    }
    const result = servers.length ? [`--proxy-server=${servers.join(";")}`] : [];
    if (result.length && env.no && !args.some((arg) => /^--proxy-bypass-list(=|$)/.test(arg))) {
      const bypass = env.no
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .flatMap((item) => {
          const host = item.replace(/^\*?\./, "");
          return !isIP(host.replace(/^\[|\]$/g, "")) && !host.includes(":") ? [host, `*.${host}`] : [host];
        });
      result.push(`--proxy-bypass-list=${bypass.join(";")}`);
    }
    return { args: result, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// Real mitmdump, real curl: the addon must send each request the way serve-sim's resolver says.

import { execFile, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { locateMitmdump, startMitmProxy, type CaptureProxy } from "../mitm-engine";
import { CaptureStore } from "../store";

const MITMDUMP = locateMitmdump();
const describeOrSkip = MITMDUMP ? describe : describe.skip;
if (!MITMDUMP) console.warn("[capture upstream] skipping: no mitmdump on this host");
const H2_CLIENT = join(import.meta.dir, "fixtures/h2-mixed-authority.mjs");
const HAS_NODE = spawnSync("node", ["--version"]).status === 0;

/**
 * Stands in for the local egress proxy. mitmproxy tunnels plain HTTP too, so a CONNECT to port 80
 * is accepted and answered here; any other CONNECT is dropped after it is recorded.
 */
function fakeEgressProxy(lines: string[]): Server {
  const firstLine = (chunk: Buffer) => chunk.toString("latin1").split("\r\n")[0]!;
  return createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (chunk: Buffer) => {
      const line = firstLine(chunk);
      lines.push(line);
      if (!/^CONNECT \S+:80 /.test(line)) return socket.destroy();
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", (inner: Buffer) => {
        lines.push(firstLine(inner));
        socket.end("HTTP/1.1 200 OK\r\ncontent-length: 12\r\nconnection: close\r\n\r\nvia-upstream");
      });
    });
  });
}

function listen(server: Server | HttpServer, host = "127.0.0.1", port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as { port: number }).port));
  });
}

function close(server: Server | HttpServer): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

const portOf = (proxy: CaptureProxy) => Number(proxy.address.split(":")[1]);

function curl(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("curl", ["-s", "--max-time", "20", ...args], (_error, stdout) => resolve(stdout));
  });
}

/** Sends bytes as written, since curl rewrites a URL's default port. */
function rawRequest(address: string, request: string): Promise<string> {
  const [host, port] = address.split(":");
  return new Promise((resolve) => {
    let reply = "";
    const socket = connect(Number(port), host!, () => socket.write(request));
    socket.setTimeout(20_000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => (reply += chunk.toString("latin1")));
    socket.on("close", () => resolve(reply));
    socket.on("error", () => resolve(reply));
  });
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (value === undefined && Date.now() < deadline) {
    await Bun.sleep(50);
    value = read();
  }
  return value;
}

describeOrSkip("capture forwarding through an upstream proxy", () => {
  const store = new CaptureStore();
  const upstreamLines: string[] = [];
  const asked: string[] = [];
  let upstream: Server;
  let origin: HttpServer;
  let originPort: number;
  let proxy: CaptureProxy;

  beforeAll(async () => {
    upstream = fakeEgressProxy(upstreamLines);
    const upstreamPort = await listen(upstream);
    origin = createHttpServer((_req, res) => res.end("direct"));
    originPort = await listen(origin);

    proxy = await startMitmProxy(store, {
      resolveUpstream: async (url) => {
        asked.push(url);
        return url.includes("example.com") ? { host: "127.0.0.1", port: upstreamPort } : null;
      },
    });
  }, 60_000);

  afterAll(async () => {
    await proxy?.close();
    await close(upstream);
    await close(origin);
  });

  test("forwards a plain request through the upstream and still captures it", async () => {
    expect(await curl(["-x", `http://${proxy.address}`, "http://api.example.com/items?id=1"])).toBe("via-upstream");
    expect(upstreamLines).toEqual(["CONNECT api.example.com:80 HTTP/1.1", "GET /items?id=1 HTTP/1.1"]);
    expect(asked).toContain("http://api.example.com/");
    // The addon reports the response from its own thread, after curl has its answer.
    const status = await waitFor(
      () => store.list().find((entry) => entry.url.startsWith("http://api.example.com/items") && entry.status != null)?.status,
    );
    expect(status).toBe(200);
  }, 30_000);

  test("opens an HTTPS request's server connection through the upstream, not direct", async () => {
    // Under the eager strategy mitmdump would dial secure.example.com itself before the addon ran.
    await curl(["-k", "-x", `http://${proxy.address}`, "https://secure.example.com/login"]);
    expect(upstreamLines).toContain("CONNECT secure.example.com:443 HTTP/1.1");
    expect(asked).toContain("https://secure.example.com/");
  }, 30_000);

  test("sends a request direct when the resolver names no upstream", async () => {
    const before = upstreamLines.length;
    expect(await curl(["-x", `http://${proxy.address}`, `http://127.0.0.1:${originPort}/local`])).toBe("direct");
    expect(upstreamLines.length).toBe(before);
  }, 30_000);

  test("asks about a default port the app wrote out", async () => {
    const reply = await rawRequest(
      proxy.address,
      "GET http://written.example.com:80/account HTTP/1.1\r\nHost: written.example.com:80\r\nConnection: close\r\n\r\n",
    );
    expect(asked).toContain("http://written.example.com:80/");
    expect(reply).toEndWith("via-upstream");
  }, 30_000);
});

describeOrSkip("capture with the upstream set to its own listener", () => {
  test("sends traffic direct for each address of its own port", async () => {
    // One origin per alias, since the addon keeps each origin's answer.
    // "::1" never reaches the listener, but mitmproxy refuses it on its own port with a 502.
    const aliases = ["127.0.0.1", "0127.0.0.1", "0x7f.1", "１２７.０.０.１", "localhost.", "::ffff:127.0.0.1", "::ffff:127.0.0.1%lo0", "::1"];
    const origins = aliases.map(() => createHttpServer((_req, res) => res.end("direct")));
    const ports = await Promise.all(origins.map((server) => listen(server)));
    let ownPort = 0;
    const proxy = await startMitmProxy(new CaptureStore(), {
      resolveUpstream: async (url) => ({ host: aliases[ports.indexOf(Number(new URL(url).port))]!, port: ownPort }),
    });
    ownPort = portOf(proxy);
    try {
      for (const [index, port] of ports.entries()) {
        const body = await curl(["--max-time", "5", "-x", `http://${proxy.address}`, `http://127.0.0.1:${port}/self`]);
        expect([aliases[index], body]).toEqual([aliases[index], "direct"]);
      }
    } finally {
      await proxy.close();
      await Promise.all(origins.map(close));
    }
  }, 60_000);

  test("forwards through an IPv6 upstream on another port", async () => {
    const lines: string[] = [];
    const other = fakeEgressProxy(lines);
    const otherPort = await listen(other, "::1");
    const proxy = await startMitmProxy(new CaptureStore(), { resolveUpstream: async () => ({ host: "::1", port: otherPort }) });
    try {
      expect(await curl(["-x", `http://${proxy.address}`, "http://api.example.com/ipv6"])).toBe("via-upstream");
      expect(lines[0]).toBe("CONNECT api.example.com:80 HTTP/1.1");
    } finally {
      await proxy.close();
      await close(other);
    }
  }, 30_000);
});

(MITMDUMP && HAS_NODE ? describe : describe.skip)("capture routing for HTTP/2 streams on one connection", () => {
  test("gives each stream its own route when they differ", async () => {
    // An explicit :443 routes through the upstream; the implicit form goes direct. The streams share
    // one tunnel, and a route set on its shared server connection would reroute the others.
    const host = "mixed.serve-sim.invalid";
    const lines: string[] = [];
    const upstream = fakeEgressProxy(lines);
    const upstreamPort = await listen(upstream);
    const store = new CaptureStore();
    const proxy = await startMitmProxy(store, {
      resolveUpstream: async (url) => (url.endsWith(":443/") ? { host: "127.0.0.1", port: upstreamPort } : null),
    });
    try {
      const client = await new Promise<string>((resolve) => {
        execFile("node", [H2_CLIENT, proxy.address, host, "5"], { timeout: 30_000 }, (_error, stdout) => resolve(stdout));
      });
      expect(JSON.parse(client)).toHaveLength(10);
      const settled = await waitFor(() => {
        const rows = store.list().filter((row) => row.failure != null);
        return rows.length >= 10 ? rows : undefined;
      }, 10_000);
      const unresolved = (path: string) =>
        settled!.filter((row) => row.url.includes(path)).map((row) => row.failure!.startsWith("The host could not be resolved"));
      // Through the upstream the host is never resolved here; direct, the .invalid name never resolves.
      expect(unresolved("/written-")).toEqual([false, false, false, false, false]);
      expect(unresolved("/implicit-")).toEqual([true, true, true, true, true]);
      expect(lines).toContain(`CONNECT ${host}:443 HTTP/1.1`);
    } finally {
      await proxy.close();
      await close(upstream);
    }
  }, 60_000);
});

describeOrSkip("capture shutdown with a route lookup in flight", () => {
  test("stops inside the kill window while serve-sim has not answered", async () => {
    // mitmdump waited for a blocked lookup thread here, past serve-sim's 3 s SIGKILL escalation.
    let asked = () => {};
    const lookupStarted = new Promise<void>((resolve) => (asked = resolve));
    const proxy = await startMitmProxy(new CaptureStore(), {
      resolveUpstream: () => {
        asked();
        return new Promise(() => {});
      },
    });
    const request = curl(["-x", `http://${proxy.address}`, "http://stalled.example.com/"]);
    await lookupStarted;
    const started = Date.now();
    await proxy.close();
    expect(Date.now() - started).toBeLessThan(2_500);
    await request;
  }, 30_000);
});

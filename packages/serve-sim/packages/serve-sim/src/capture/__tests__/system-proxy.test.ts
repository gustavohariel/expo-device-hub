import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { resolveSystemProxies } from "../../native";

// Native CFNetwork lookups; `bun run build.ts` first or the suite skips.
const ADDON = join(import.meta.dir, "../../../dist/native/serve-sim-native.node");
const describeOrSkip = existsSync(ADDON) ? describe : describe.skip;

// What build-tools' local egress sets with networksetup, in the shape `scutil --proxy` prints.
const EGRESS = {
  HTTPEnable: 1,
  HTTPProxy: "127.0.0.1",
  HTTPPort: 8899,
  HTTPSEnable: 1,
  HTTPSProxy: "127.0.0.1",
  HTTPSPort: 8899,
  ExceptionsList: ["*.local", "169.254/16"],
};

const PAC = `function FindProxyForURL(url, host) {
  return dnsDomainIs(host, "example.com") ? "PROXY 127.0.0.1:8899; DIRECT" : "DIRECT";
}`;

describeOrSkip("resolveSystemProxies", () => {
  test("returns the manual proxy for each scheme", async () => {
    expect(await resolveSystemProxies("https://example.com:443/", EGRESS)).toEqual([
      { type: "https", host: "127.0.0.1", port: 8899 },
    ]);
    expect(await resolveSystemProxies("http://example.com:80/", EGRESS)).toEqual([
      { type: "http", host: "127.0.0.1", port: 8899 },
    ]);
  });

  test("applies the bypass list and never proxies loopback", async () => {
    for (const url of ["https://printer.local:443/", "http://169.254.1.1:80/", "http://127.0.0.1:8081/", "http://localhost:8081/"]) {
      expect(await resolveSystemProxies(url, EGRESS)).toEqual([{ type: "direct" }]);
    }
  });

  test("runs an inline PAC script", async () => {
    const settings = { ProxyAutoConfigEnable: 1, ProxyAutoConfigJavaScript: PAC };
    expect((await resolveSystemProxies("https://api.example.com:443/", settings))[0]).toEqual({
      type: "https",
      host: "127.0.0.1",
      port: 8899,
    });
    expect((await resolveSystemProxies("https://httpbin.org:443/", settings))[0]).toEqual({ type: "direct" });
  });

  test("fetches and runs a PAC file", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" });
      res.end(PAC);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    try {
      const settings = { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: `http://127.0.0.1:${port}/proxy.pac` };
      expect((await resolveSystemProxies("https://api.example.com:443/", settings))[0]).toEqual({
        type: "https",
        host: "127.0.0.1",
        port: 8899,
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("falls back to direct when the PAC file cannot be fetched", async () => {
    const settings = { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: "http://127.0.0.1:1/proxy.pac" };
    expect(await resolveSystemProxies("https://api.example.com:443/", settings)).toEqual([{ type: "direct" }]);
  });

  test("gives up on a PAC script that runs past the deadline", async () => {
    // Finite, so the system agent that runs PAC scripts is free again soon after the test.
    const slow = `function FindProxyForURL(url, host) {
      var stop = Date.now() + 1500; while (Date.now() < stop) {} return "PROXY 127.0.0.1:8899";
    }`;
    const started = Date.now();
    const entries = await resolveSystemProxies(
      "https://api.example.com/",
      { ProxyAutoConfigEnable: 1, ProxyAutoConfigJavaScript: slow },
      300,
    );
    expect(Date.now() - started).toBeLessThan(1200);
    expect(entries).toEqual([{ type: "direct" }]);
  });

  test("hands the PAC file the URL as given, so an explicit default port can change its answer", async () => {
    // Why capture asks about https://host/ and never https://host:443/.
    const settings = {
      ProxyAutoConfigEnable: 1,
      ProxyAutoConfigJavaScript: `function FindProxyForURL(url, host) {
        return shExpMatch(url, "https://api.example.com/*") ? "PROXY 127.0.0.1:8899" : "DIRECT";
      }`,
    };
    expect((await resolveSystemProxies("https://api.example.com/", settings))[0]?.type).toBe("https");
    expect((await resolveSystemProxies("https://api.example.com:443/", settings))[0]?.type).toBe("direct");
  });

  test("rejects a value that is not a URL", async () => {
    await expect(resolveSystemProxies("not a url", EGRESS)).rejects.toThrow("Not a URL");
  });
});

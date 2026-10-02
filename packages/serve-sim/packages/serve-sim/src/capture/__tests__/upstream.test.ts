import { describe, expect, test } from "bun:test";

import type { SystemProxyEntry } from "../../native";
import {
  CAPTURE_UPSTREAM_ENV,
  createUpstreamResolver,
  guardUpstream,
  parseUpstreamOverride,
  pickUpstream,
  skipsUnusable,
} from "../upstream";

describe("pickUpstream", () => {
  test("takes the first HTTP or HTTPS proxy", () => {
    expect(pickUpstream([{ type: "https", host: "127.0.0.1", port: 8899 }, { type: "direct" }])).toEqual({
      host: "127.0.0.1",
      port: 8899,
    });
  });

  test("goes direct when the system says direct first", () => {
    expect(pickUpstream([{ type: "direct" }, { type: "http", host: "proxy", port: 3128 }])).toBeNull();
    expect(pickUpstream([])).toBeNull();
  });

  test("skips a SOCKS proxy, which mitmproxy cannot forward through", () => {
    const entries: SystemProxyEntry[] = [
      { type: "socks", host: "127.0.0.1", port: 1080 },
      { type: "http", host: "proxy", port: 3128 },
    ];
    expect(pickUpstream(entries)).toEqual({ host: "proxy", port: 3128 });
    expect(pickUpstream([{ type: "socks", host: "127.0.0.1", port: 1080 }])).toBeNull();
    expect(skipsUnusable(entries)).toBe(true);
    expect(skipsUnusable([{ type: "direct" }, { type: "socks", host: "127.0.0.1", port: 1080 }])).toBe(false);
  });

  test("skips a proxy host that holds credentials, which macOS accepts in the host field", () => {
    const entries: SystemProxyEntry[] = [
      { type: "http", host: "user:s3cret@proxy.example.com", port: 8899 },
      { type: "https", host: "proxy.example.com", port: 8899 },
    ];
    expect(pickUpstream(entries)).toEqual({ host: "proxy.example.com", port: 8899 });
    expect(skipsUnusable(entries)).toBe(true);
  });

  test("skips an HTTP proxy entry without a host or port", () => {
    expect(pickUpstream([{ type: "http", host: "proxy" }, { type: "https", host: "proxy", port: 3128 }])).toEqual({
      host: "proxy",
      port: 3128,
    });
  });
});

describe("parseUpstreamOverride", () => {
  test("reads a proxy URL, none, or nothing", () => {
    expect(parseUpstreamOverride(undefined)).toBeUndefined();
    expect(parseUpstreamOverride(" ")).toBeUndefined();
    expect(parseUpstreamOverride("none")).toBeNull();
    expect(parseUpstreamOverride("http://127.0.0.1:8899")).toEqual({ host: "127.0.0.1", port: 8899 });
    expect(parseUpstreamOverride("http://proxy.internal")).toEqual({ host: "proxy.internal", port: 80 });
    expect(parseUpstreamOverride("http://[::1]:8899/")).toEqual({ host: "::1", port: 8899 });
  });

  test("rejects a value mitmproxy could not forward through", () => {
    for (const value of [
      "127.0.0.1:8899",
      "socks5://127.0.0.1:1080",
      "https://proxy:443",
      "http://u:p@proxy:1",
      "http://:p@proxy:1",
      "http://proxy/path",
      "http://proxy:8899/#x",
      "http://proxy:0",
    ]) {
      expect(() => parseUpstreamOverride(value)).toThrow(CAPTURE_UPSTREAM_ENV);
    }
  });

  test("never repeats the rejected value, which may hold proxy credentials", () => {
    expect(() => parseUpstreamOverride("http://user:s3cret@proxy:8899")).not.toThrow(/s3cret/);
    expect(() => parseUpstreamOverride("user:s3cret@proxy:8899")).not.toThrow(/s3cret/);
    expect(() => parseUpstreamOverride("user:s3cret@proxy:8899")).toThrow("without credentials");
  });
});

describe("createUpstreamResolver", () => {
  test("follows the system settings for each URL", async () => {
    const asked: string[] = [];
    const resolve = createUpstreamResolver({
      env: {},
      resolve: async (url) => {
        asked.push(url);
        return url.includes("example.com")
          ? [{ type: "https", host: "127.0.0.1", port: 8899 }]
          : [{ type: "direct" }];
      },
    });

    expect(await resolve("https://api.example.com:443/")).toEqual({ host: "127.0.0.1", port: 8899 });
    expect(await resolve("https://cdn.example.com:443/")).toEqual({ host: "127.0.0.1", port: 8899 });
    expect(await resolve("http://printer.local:80/")).toBeNull();
    expect(asked).toEqual(["https://api.example.com:443/", "https://cdn.example.com:443/", "http://printer.local:80/"]);
  });

  test("uses the override for every URL without reading the system settings", async () => {
    const resolve = createUpstreamResolver({
      env: { [CAPTURE_UPSTREAM_ENV]: "http://127.0.0.1:3128" },
      resolve: async () => {
        throw new Error("system settings were read");
      },
    });
    expect(await resolve("https://a.test:443/")).toEqual({ host: "127.0.0.1", port: 3128 });

    const direct = createUpstreamResolver({ env: { [CAPTURE_UPSTREAM_ENV]: "none" }, resolve: async () => [{ type: "http", host: "p", port: 1 }] });
    expect(await direct("https://a.test:443/")).toBeNull();
  });

  test("throws at creation for an override it cannot use, so capture does not start on a bad value", () => {
    expect(() => createUpstreamResolver({ env: { [CAPTURE_UPSTREAM_ENV]: "proxy:8899" } })).toThrow(CAPTURE_UPSTREAM_ENV);
  });

  test("never logs a skipped proxy host, which may hold credentials", async () => {
    const logs: string[] = [];
    const resolve = createUpstreamResolver({
      env: {},
      log: (message) => logs.push(message),
      resolve: async () => [{ type: "http", host: "user:s3cret@proxy.example.com", port: 8899 }, { type: "direct" }],
    });
    expect(await resolve("https://a.test/")).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("a host with credentials");
    expect(logs[0]).not.toContain("s3cret");
  });

  test("says once that a SOCKS proxy was skipped", async () => {
    const logs: string[] = [];
    const resolve = createUpstreamResolver({
      env: {},
      log: (message) => logs.push(message),
      resolve: async () => [{ type: "socks", host: "127.0.0.1", port: 1080 }, { type: "direct" }],
    });
    expect(await resolve("https://a.test:443/")).toBeNull();
    expect(await resolve("https://b.test:443/")).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("SOCKS");
  });

  test("routes a value that is not a URL direct, without blaming the system settings", async () => {
    const logs: string[] = [];
    const resolve = createUpstreamResolver({
      env: {},
      log: (message) => logs.push(message),
      resolve: async () => {
        throw new Error("resolved a value that is not a URL");
      },
    });
    expect(await resolve("http://:80/")).toBeNull();
    expect(logs).toEqual([]);
  });

  test("goes direct and warns once when the system settings cannot be read", async () => {
    const logs: string[] = [];
    const resolve = createUpstreamResolver({
      env: {},
      log: (message) => logs.push(message),
      resolve: async () => {
        throw new Error("addon missing");
      },
    });
    expect(await resolve("https://a.test:443/")).toBeNull();
    expect(await resolve("https://b.test:443/")).toBeNull();
    expect(logs).toEqual([
      "Network capture: could not read the system proxy settings, so captured traffic goes direct: addon missing",
    ]);
  });
});

describe("guardUpstream", () => {
  const OWN_PORT = 54321;
  const guard = (host: string, port = OWN_PORT, log: (message: string) => void = () => {}) =>
    guardUpstream(async () => ({ host, port }), { ownPort: OWN_PORT, log });

  test("announces each upstream once", async () => {
    const logs: string[] = [];
    const resolve = guardUpstream(
      async (url) => (url.includes("example.com") ? { host: "127.0.0.1", port: 8899 } : null),
      { ownPort: OWN_PORT, log: (message) => logs.push(message) },
    );
    expect(await resolve("https://api.example.com/")).toEqual({ host: "127.0.0.1", port: 8899 });
    expect(await resolve("https://cdn.example.com/")).toEqual({ host: "127.0.0.1", port: 8899 });
    expect(await resolve("http://printer.local/")).toBeNull();
    expect(logs).toEqual(["Network capture: forwarding captured traffic through the upstream proxy at 127.0.0.1:8899."]);
  });

  test("sends an address or localhost name on its own port direct, and says so once", async () => {
    const own = [
      "127.0.0.1",
      "127.1",
      "0x7f.1",
      "0127.0.0.1",
      "00127.0.0.1",
      "2130706433",
      "0.0.0.0",
      "localhost",
      "LOCALHOST",
      "localhost.",
      "dev.localhost",
      "::1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:FFFF:7f00:1",
      "::ffff:127.0.0.1%lo0",
      // Unicode spellings a connection maps to ASCII.
      "１２７.０.０.１",
      "127。0。0。1",
      "ℓocalhost",
      // Any address on the random port, since macOS and URL parsers disagree on numeric spellings.
      "10.0.0.5",
    ];
    for (const host of own) {
      const logs: string[] = [];
      const resolve = guard(host, OWN_PORT, (message) => logs.push(message));
      expect([host, await resolve("https://a.test/")]).toEqual([host, null]);
      await resolve("https://b.test/");
      expect(logs).toEqual([
        `Network capture: the upstream proxy at ${host}:${OWN_PORT} uses the capture proxy's port and could ` +
          "loop back into it, so captured traffic goes direct.",
      ]);
    }
  });

  test("keeps a host name on its own port, and any proxy on another port", async () => {
    for (const host of ["proxy.invalid", "notlocalhost", "ip6-localhost", "1.cafe", "999.0.0.1"]) {
      expect(await guard(host)("https://a.test/")).toEqual({ host, port: OWN_PORT });
    }
    expect(await guard("127.0.0.1", 8899)("https://a.test/")).toEqual({ host: "127.0.0.1", port: 8899 });
  });
});

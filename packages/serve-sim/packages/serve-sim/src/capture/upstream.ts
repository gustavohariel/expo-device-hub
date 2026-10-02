import { isIP } from "node:net";

import { resolveSystemProxies, type SystemProxyEntry } from "../native";

/**
 * Forces where captured traffic goes: a proxy such as `http://127.0.0.1:8899`, or `none` to send it
 * direct. Unset, each request follows the system proxy settings, as it would without capture.
 */
export const CAPTURE_UPSTREAM_ENV = "SERVE_SIM_CAPTURE_UPSTREAM";

export interface Upstream {
  host: string;
  port: number;
}

export type UpstreamResolver = (url: string) => Promise<Upstream | null>;

/** An HTTP(S) proxy capture can forward through. A host with credentials ("user:pass@host") is not one. */
const isUsableProxy = (entry: SystemProxyEntry) =>
  (entry.type === "http" || entry.type === "https") && !!entry.host && !!entry.port && !entry.host.includes("@");

/**
 * The entry capture follows: the first direct entry or usable proxy. mitmproxy cannot forward
 * through SOCKS, so those entries are skipped, like a client without SOCKS support would.
 */
function followedIndex(entries: readonly SystemProxyEntry[]): number {
  return entries.findIndex((entry) => entry.type === "direct" || isUsableProxy(entry));
}

export function pickUpstream(entries: readonly SystemProxyEntry[]): Upstream | null {
  const entry = entries[followedIndex(entries)];
  return entry && entry.type !== "direct" ? { host: entry.host!, port: entry.port! } : null;
}

/** True when the system named a proxy capture cannot use before the entry capture follows. */
export function skipsUnusable(entries: readonly SystemProxyEntry[]): boolean {
  const index = followedIndex(entries);
  return (index === -1 ? entries : entries.slice(0, index)).some((entry) => entry.type !== "direct");
}

/** `undefined` when unset, `null` for direct. Throws on a value that is neither. */
export function parseUpstreamOverride(value: string | undefined): Upstream | null | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text === "none") return null;
  const url = URL.canParse(text) ? new URL(text) : null;
  const extra = url && (url.pathname !== "/" || url.username || url.password || url.search || url.hash);
  if (url?.protocol !== "http:" || !url.hostname || url.port === "0" || extra) {
    // Not repeated: the value may hold credentials, and this message reaches the panel.
    throw new Error(
      `${CAPTURE_UPSTREAM_ENV} must be an HTTP proxy without credentials, such as http://127.0.0.1:8899, or "none".`,
    );
  }
  return { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(url.port || 80) };
}

export function createUpstreamResolver(
  deps: {
    env?: Record<string, string | undefined>;
    resolve?: (url: string) => Promise<SystemProxyEntry[]>;
    log?: (message: string) => void;
  } = {},
): UpstreamResolver {
  const override = parseUpstreamOverride((deps.env ?? process.env)[CAPTURE_UPSTREAM_ENV]);
  const resolve = deps.resolve ?? resolveSystemProxies;
  const log = deps.log ?? console.log;
  const warned = new Set<"unreadable" | "unusable">();
  const warnOnce = (kind: "unreadable" | "unusable", message: string) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    log(message);
  };

  return async (url) => {
    if (override !== undefined) return override;
    if (!URL.canParse(url)) return null;
    try {
      const entries = await resolve(url);
      if (skipsUnusable(entries)) {
        // The value is not logged: a host can hold credentials.
        warnOnce(
          "unusable",
          "Network capture: the system proxy settings name a proxy that capture cannot forward through " +
            "(SOCKS, or a host with credentials); those requests use the next proxy in the settings or go direct.",
        );
      }
      return pickUpstream(entries);
    } catch (error) {
      warnOnce(
        "unreadable",
        "Network capture: could not read the system proxy settings, so captured traffic goes direct: " +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  };
}

/**
 * An IP address or localhost name (RFC 6761) in any spelling. The URL parser maps Unicode and numeric
 * forms to ASCII; it reads leading zeros differently from macOS, but either result is an address.
 */
function isAddressOrLocalhost(host: string): boolean {
  const bare = host.trim();
  if (isIP(bare.split("%")[0]!) !== 0) return true;
  try {
    const ascii = new URL(`http://${bare}/`).hostname;
    return isIP(ascii) !== 0 || /^(?:.+\.)?localhost\.?$/.test(ascii);
  } catch {
    return false;
  }
}

/**
 * Wraps any resolver: an address or localhost name on the capture proxy's own (random) port could
 * loop back into it, so it goes direct; each upstream is logged once.
 */
export function guardUpstream(
  resolve: UpstreamResolver,
  options: { ownPort: number; log?: (message: string) => void },
): UpstreamResolver {
  const log = options.log ?? console.log;
  const announced = new Set<string>();
  let warnedSelf = false;
  return async (url) => {
    const upstream = await resolve(url);
    if (!upstream) return null;
    const where = `${upstream.host}:${upstream.port}`;
    if (upstream.port === options.ownPort && isAddressOrLocalhost(upstream.host)) {
      if (!warnedSelf) {
        warnedSelf = true;
        log(
          `Network capture: the upstream proxy at ${where} uses the capture proxy's port and could loop back ` +
            "into it, so captured traffic goes direct.",
        );
      }
      return null;
    }
    if (!announced.has(where)) {
      announced.add(where);
      log(`Network capture: forwarding captured traffic through the upstream proxy at ${where}.`);
    }
    return upstream;
  };
}

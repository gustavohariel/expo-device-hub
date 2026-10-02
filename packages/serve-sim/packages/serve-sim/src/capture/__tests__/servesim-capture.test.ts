import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { locateMitmdump } from "../mitm-engine";

const ADDON = resolve(import.meta.dir, "../mitm-addon/servesim_capture.py");
const PROBE = resolve(import.meta.dir, "fixtures/servesim-capture-probe.py");
const BROTLI_PROBE = resolve(import.meta.dir, "fixtures/servesim-capture-brotli-probe.py");
const ROUTE_PROBE = resolve(import.meta.dir, "fixtures/servesim-capture-route-probe.py");

function python(): string | null {
  for (const candidate of ["python3", "/usr/bin/python3"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "pipe" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = python();
const describeOrSkip = PYTHON && existsSync(ADDON) ? describe : describe.skip;
if (!PYTHON) console.warn("[servesim_capture] skipping: no python3 on this host");

/** Every probe assertion comes from one addon instance, so the module state is shared as in production. */
function runProbe(): Record<string, unknown> {
  const result = spawnSync(PYTHON!, [PROBE, ADDON], { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`probe failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

describeOrSkip("servesim_capture addon", () => {
  const probe = PYTHON ? runProbe() : {};

  test("reports the proxy's original request time in milliseconds", () => {
    expect(probe.requestStartedAt).toBe(1_000_000);
  });

  test("keeps the wire bytes of a body without a content-encoding", () => {
    expect(probe.plainSize).toBe(90);
    expect(probe.plainBody).toBe("gzipbytes".repeat(10));
  });

  test("never decodes a body it was not asked to keep", () => {
    expect(probe.metadataBody).toBe("");
    expect(probe.metadataDecoded).toBe(false);
  });

  test("decodes gzip and deflate bodies so they read as text, and reports wire size", () => {
    expect(probe.gzipBody).toBe('{"ok":true}');
    expect(probe.gzipSize).toBe(true);
    expect(probe.gzipTruncated).toBe(false);
    expect(probe.deflateBodies).toEqual(["zlib deflate", "raw deflate"]);
  });

  test("stops decoding a compressed body at the cap instead of inflating all of it", () => {
    expect(probe.bombBodyLength).toBe(512 * 1024);
    expect(probe.bombTruncated).toBe(true);
    expect(probe.bombSize).toBe(true);
    expect(probe.bombDecodedBytes).toBe(512 * 1024 + 1);
  });

  test("marks a compressed body that ends early as incomplete", () => {
    expect(probe.cutBody).toBe('{"a":1,"b":"text"');
    expect(probe.cutTruncated).toBe(true);
  });

  test("marks data after the first gzip member as not shown", () => {
    expect(probe.membersBody).toBe("first member ");
    expect(probe.membersTruncated).toBe(true);
  });

  test("falls back to the wire bytes for an encoding it does not decode", () => {
    expect(probe.unsupportedBase64).toBe("//4=");
  });

  test("survives a body whose content-encoding does not match its bytes", () => {
    // A decode error must not kill the hook, which would leave the row in flight forever.
    expect(probe.lyingBody).toBe("raw-wire-bytes");
    expect(probe.lyingSize).toBe(14);
  });

  test("sends binary bodies as base64 rather than mojibake", () => {
    expect(probe.binaryBody).toBeNull();
    expect(probe.binaryBase64).toBe("//4AAQ==");
  });

  test("caps a body at the per-body limit and says it was cut", () => {
    expect(probe.oversizedTruncated).toBe(true);
    expect(probe.oversizedBodyLength).toBe(512 * 1024);
  });

  test("keeps a text body readable when the cap splits a multibyte character", () => {
    expect(probe.splitCharBody).toBe(512 * 1024 - 1);
    expect(probe.splitCharBase64).toBeNull();
    expect(probe.splitCharTruncated).toBe(true);
  });

  test("reports an absent body as empty rather than as a cut one", () => {
    expect(probe.emptySize).toBe(0);
    expect(probe.emptyBody).toBe("");
    expect(probe.emptyTruncated).toBe(false);
  });

  test("lowercases header names, which the session looks up in lower case", () => {
    expect(probe.headerKeys).toEqual(["content-type"]);
  });

  test("announces itself so readiness proves the hooks are installed", () => {
    expect(probe.readyDelivered).toBe(true);
    expect(probe.readyPath).toBe("/ready");
    expect(probe.readyToken).toBe("probe-token");
  });

  test("ignores a configured http_proxy when reporting", () => {
    expect(probe.proxyBypassed).toBe(true);
  });

  test("does not report a second row when a completed response already reported one", () => {
    expect(probe.errorSkippedWhenResponseCompleted).toBe(true);
  });

  test("settles a row whose response started and then died mid-body", () => {
    // Skipping on any response at all left these rows started forever: no status, no failure.
    expect(probe.errorAfterPartialResponseFrames).toBe(1);
    expect(probe.errorAfterPartialResponseStatus).toBeNull();
    expect(probe.errorAfterPartialResponseMessage).toBe("server closed the connection");
  });

  test("opens and settles a row for a CONNECT that never established", () => {
    expect(probe.connectErrorFrames).toBe(2);
    expect(probe.connectErrorPaths).toEqual(["/request", "/response"]);
  });

  test("releases queued bytes as records drain", () => {
    expect(probe.queuedBytesAfterDrain).toBe(0);
  });

  test("drops a record rather than queueing past the byte limit", () => {
    expect(probe.oversizedRecordDropped).toBe(true);
    // A dropped record must not leave its size behind, or the limit creeps shut.
    expect(probe.queuedBytesAfterDrop).toBe(0);
    // And it is counted as lost, like a failed send, so shutdown reports it.
    expect(probe.droppedRecordCounted).toBe(1);
  });

  test("shuts down cleanly when it was loaded without a control url", () => {
    const result = spawnSync(
      PYTHON!,
      [
        "-c",
        [
          "import importlib.util, os, sys",
          "os.environ.pop('SERVE_SIM_CAPTURE_CONTROL_URL', None)",
          `spec = importlib.util.spec_from_file_location('servesim_capture', ${JSON.stringify(ADDON)})`,
          "addon = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(addon)",
          "addon.done()",
          "print('ok')",
        ].join("\n"),
      ],
      { stdio: "pipe", encoding: "utf8" },
    );
    expect(result.stderr).not.toContain("RuntimeError");
    expect(result.status).toBe(0);
  });

  test("redacts query values but keeps their names, so requests stay distinguishable", () => {
    // A URL alone carries OAuth codes, signed-URL keys and reset tokens; header redaction never saw them.
    expect(probe.urlQueryRedacted).toBe("https://a.test/cb?code=[REDACTED]&state=[REDACTED]");
  });

  test("leaves a URL without a query alone", () => {
    expect(probe.urlWithoutQueryUntouched).toBe("https://a.test/thing");
  });

  test("caps a URL whose redaction makes it longer, not just one long value", () => {
    expect(probe.urlCappedExpanding).toBe(true);
    expect(probe.urlCapped).toBe(true);
  });

  test("redacts a bare query token, which is the whole credential", () => {
    expect(probe.urlBareTokenRedacted).toBe("https://a.test/cb?[REDACTED]");
  });

  test("counts a bodyless record against the queue limit", () => {
    // Body-only accounting sized this at zero, so a large URL or header set was unbounded.
    expect(probe.bodylessRecordCounted).toBe(true);
  });

  test("reports a request that failed before any response", () => {
    expect(probe.errorWithoutResponseFrames).toBe(1);
    expect(probe.errorWithoutResponseMessage).toBe("connection reset");
  });
});

describeOrSkip("servesim_capture upstream routing", () => {
  const run = PYTHON ? spawnSync(PYTHON, [ROUTE_PROBE, ADDON], { stdio: "pipe", encoding: "utf8" }) : null;
  if (run && run.status !== 0) throw new Error(`route probe failed (${run.status}):\n${run.stderr || run.stdout}`);
  const probe: Record<string, unknown> = run ? JSON.parse(run.stdout.trim().split("\n").at(-1)!) : {};

  test("forwards a request through the upstream serve-sim names for its origin", () => {
    expect(probe.proxiedVia).toEqual(["http", ["127.0.0.1", 8899]]);
    expect(probe.askedPath).toBe("/route");
    // No explicit default port: a PAC file can answer https://host:443/ differently from https://host/.
    expect(probe.askedUrl).toBe("https://api.example.com/");
    expect(probe.askedToken).toBe("probe-token");
  });

  test("leaves a request direct when serve-sim names no upstream", () => {
    expect(probe.directVia).toBeNull();
  });

  test("asks once per origin while the answer is fresh", () => {
    expect(probe.cachedLookups).toBe(0);
  });

  test("leaves a CONNECT alone; the requests inside the tunnel are routed", () => {
    expect(probe.connectVia).toBeNull();
    expect(probe.connectLookups).toBe(0);
  });

  test("brackets an IPv6 host and keeps a port that is not the default", () => {
    expect(probe.ipv6Url).toBe("http://[::1]:8080/");
    expect(probe.otherPortUrl).toBe("https://api.example.com:8443/");
  });

  test("keeps a default port the app wrote out, which a PAC file can answer differently", () => {
    expect(probe.writtenPortUrls).toEqual([
      "http://written.example.com:80/",
      "https://written.example.com:443/",
      "http://written.example.com/",
      "http://spoofed.example.com/",
      "http://[::1]:80/",
    ]);
  });

  test("limits how many new origins it looks up at once", () => {
    expect(probe.spreadMostAtOnce).toBe(4);
    expect(probe.spreadAllProxied).toBe(true);
  });

  test("shares one lookup among simultaneous requests to a new origin", () => {
    expect(probe.burstLookups).toBe(1);
    expect(probe.burstAllProxied).toBe(true);
  });

  test("holds requests no longer than one deadline when serve-sim stalls, without threads", () => {
    expect(probe.stallSeconds as number).toBeLessThan(1.5);
    expect(probe.stallConnections).toBe(1);
    expect(probe.stallAllDirect).toBe(true);
    expect(probe.stallThreadsAdded).toBe(0);
  });

  test("never sets a route on a server connection that other streams share", () => {
    expect(probe.sharedUntouched).toBe(true);
    expect(probe.sharedRoutes).toEqual([false, true, false, true, false, true, false, true, false, true]);
    expect(probe.sharedKeptForDirect).toBe(true);
  });

  test("gives a request a new server connection when the open one is on another route", () => {
    expect(probe.openReplaced).toBe(true);
    expect(probe.openReplacedAddress).toEqual(["www.example.com", 443]);
    expect(probe.openReplacedVia).toEqual(["http", ["127.0.0.1", 8899]]);
    expect(probe.originalUntouched).toBe(true);
  });

  test("skips a request without a host", () => {
    expect(probe.hostlessVia).toBeNull();
    expect(probe.hostlessLookups).toBe(0);
  });

  test("goes direct and says so once when serve-sim does not answer", () => {
    expect(probe.controlGoneVia).toBeNull();
    expect(run?.stderr).toContain("[servesim-capture] could not ask serve-sim for the upstream proxy");
  });

  test("keeps a failed lookup for seconds, not as long as an answer", () => {
    expect(probe.controlGoneKeptSeconds as number).toBeLessThanOrEqual(5);
    expect(probe.answerKeptSeconds as number).toBeGreaterThan(5);
  });
});

const MITMDUMP = locateMitmdump();
const describeUnderMitmproxy = MITMDUMP && existsSync(ADDON) ? describe : describe.skip;
if (!MITMDUMP) console.warn("[servesim_capture] skipping brotli: no mitmdump on this host");

describeUnderMitmproxy("servesim_capture addon under mitmproxy's own Python", () => {
  test("decodes brotli bodies and stops a brotli bomb at the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-brotli-probe-"));
    const out = join(dir, "result.json");
    try {
      const run = spawnSync(MITMDUMP!, ["-q", "--set", "server=false", "-s", BROTLI_PROBE], {
        env: { ...process.env, SERVE_SIM_ADDON_PATH: ADDON, SERVE_SIM_BROTLI_PROBE_OUT: out },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(existsSync(out), run.stderr || run.stdout).toBe(true);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        textBody: '{"hello":"brotli"}',
        textTruncated: false,
        bombBodyLength: 512 * 1024,
        bombTruncated: true,
        garbageBase64: "//5ub3QtYnJvdGxp",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

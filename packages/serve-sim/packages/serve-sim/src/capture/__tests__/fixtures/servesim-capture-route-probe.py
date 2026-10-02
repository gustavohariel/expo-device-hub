"""Route fake flows through one add-on instance against a control server that answers /route."""

import asyncio
import importlib.util
import json
import os
import socket
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ADDON_PATH = sys.argv[1]

asked = []


class ControlHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parts = urlsplit(self.path)
        url = parse_qs(parts.query).get("url", [""])[0]
        asked.append({"path": parts.path, "url": url, "token": self.headers.get("x-serve-sim-capture-token")})
        proxied = "example.com" in url or url.endswith(":443/")
        upstream = {"host": "127.0.0.1", "port": 8899} if proxied else None
        body = json.dumps({"upstream": upstream}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), ControlHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()

class SlowControlHandler(ControlHandler):
    """Answers like the control server after 50 ms, and records how many lookups overlap."""

    active = 0
    most = 0
    lock = threading.Lock()

    def do_GET(self):
        with SlowControlHandler.lock:
            SlowControlHandler.active += 1
            SlowControlHandler.most = max(SlowControlHandler.most, SlowControlHandler.active)
        time.sleep(0.05)
        try:
            super().do_GET()
        finally:
            with SlowControlHandler.lock:
                SlowControlHandler.active -= 1


slow = ThreadingHTTPServer(("127.0.0.1", 0), SlowControlHandler)
threading.Thread(target=slow.serve_forever, daemon=True).start()

# Accepts connections and never answers, like a control server that has stalled.
stalled = socket.socket()
stalled.bind(("127.0.0.1", 0))
stalled.listen(64)
stalled_accepted = []


def accept_forever():
    while True:
        connection, _ = stalled.accept()
        stalled_accepted.append(connection)


threading.Thread(target=accept_forever, daemon=True).start()

os.environ["SERVE_SIM_CAPTURE_CONTROL_URL"] = f"http://127.0.0.1:{server.server_port}"
os.environ["SERVE_SIM_CAPTURE_CONTROL_TOKEN"] = "probe-token"
for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ[name] = "http://127.0.0.1:1"


class FakeServer:
    def __init__(self, address=None):
        self.address = address
        self.via = None
        self.timestamp_start = None


# The add-on imports mitmproxy only to replace a connection that is already open.
mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.connection = types.ModuleType("mitmproxy.connection")
mitmproxy.connection.Server = FakeServer
sys.modules["mitmproxy"] = mitmproxy
sys.modules["mitmproxy.connection"] = mitmproxy.connection

spec = importlib.util.spec_from_file_location("servesim_capture", ADDON_PATH)
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)


class FakeRequest:
    def __init__(self, host, scheme="https", port=443, method="GET", host_header=None):
        self.host = host
        self.scheme = scheme
        self.port = port
        self.method = method
        self.host_header = host_header


class FakeFlow:
    def __init__(self, host, **request):
        self.request = FakeRequest(host, **request)
        self.server_conn = FakeServer((host, self.request.port))


def route(flow):
    asyncio.run(addon.requestheaders(flow))
    return flow


def route_all(flows):
    async def run():
        await asyncio.gather(*(addon.requestheaders(flow) for flow in flows))

    started = time.monotonic()
    asyncio.run(run())
    return time.monotonic() - started


results = {}

proxied = route(FakeFlow("api.example.com"))
results["proxiedVia"] = proxied.server_conn.via
results["askedUrl"] = asked[0]["url"] if asked else None
results["askedPath"] = asked[0]["path"] if asked else None
results["askedToken"] = asked[0]["token"] if asked else None

direct = route(FakeFlow("printer.local", scheme="http", port=80))
results["directVia"] = direct.server_conn.via

asked.clear()
route(FakeFlow("api.example.com"))
results["cachedLookups"] = len(asked)

connect = route(FakeFlow("api.example.com", method="CONNECT"))
results["connectVia"] = connect.server_conn.via
results["connectLookups"] = len(asked)

ipv6 = route(FakeFlow("::1", scheme="http", port=8080))
results["ipv6Url"] = asked[-1]["url"] if asked else None

route(FakeFlow("api.example.com", port=8443))
results["otherPortUrl"] = asked[-1]["url"] if asked else None


def asked_for(host, **request):
    route(FakeFlow(host, **request))
    return asked[-1]["url"] if asked else None


# mitmproxy normalizes the port; the Host header keeps a default port the app wrote out.
results["writtenPortUrls"] = [
    asked_for("written.example.com", scheme="http", port=80, host_header="written.example.com:80"),
    asked_for("written.example.com", host_header="WRITTEN.example.com:443"),
    asked_for("written.example.com", scheme="http", port=80, host_header="written.example.com"),
    asked_for("spoofed.example.com", scheme="http", port=80, host_header="other.example.com:80"),
    asked_for("::1", scheme="http", port=80, host_header="[::1]:80"),
]

asked.clear()
burst = [FakeFlow("burst.example.com") for _ in range(50)]
route_all(burst)
results["burstLookups"] = len(asked)
results["burstAllProxied"] = all(flow.server_conn.via == ("http", ("127.0.0.1", 8899)) for flow in burst)

# Many new origins at once share a few lookup slots instead of opening a connection each.
addon.CONTROL = f"http://127.0.0.1:{slow.server_port}"
addon.ROUTE_MAX_LOOKUPS = 4
spread = [FakeFlow(f"origin{i}.example.com") for i in range(40)]
route_all(spread)
results["spreadMostAtOnce"] = SlowControlHandler.most
results["spreadAllProxied"] = all(flow.server_conn.via == ("http", ("127.0.0.1", 8899)) for flow in spread)
addon.CONTROL = f"http://127.0.0.1:{server.server_port}"

# HTTP/2 streams start from one shared server connection; a route set on it would reroute the rest.
shared = FakeServer(("mixed.test", 443))
streams = [FakeFlow("mixed.test", host_header="mixed.test:443" if i % 2 else "mixed.test") for i in range(10)]
for flow in streams:
    flow.server_conn = shared
route_all(streams)
results["sharedUntouched"] = shared.via is None
results["sharedRoutes"] = [flow.server_conn.via is not None for flow in streams]
results["sharedKeptForDirect"] = all(flow.server_conn is shared for flow in streams[0::2])

opened = FakeFlow("www.example.com")
opened.server_conn.timestamp_start = 1.0
original = opened.server_conn
route(opened)
results["openReplaced"] = opened.server_conn is not original
results["openReplacedAddress"] = opened.server_conn.address
results["openReplacedVia"] = opened.server_conn.via
results["originalUntouched"] = original.via is None

asked.clear()
hostless = route(FakeFlow(""))
results["hostlessVia"] = hostless.server_conn.via
results["hostlessLookups"] = len(asked)

# A stalled control server holds a burst of requests for one deadline, not one per request.
addon.CONTROL = f"http://127.0.0.1:{stalled.getsockname()[1]}"
addon.ROUTE_TIMEOUT_SECONDS = 0.3
threads_before = threading.active_count()
held = [FakeFlow("stall.example.com") for _ in range(20)]
results["stallSeconds"] = route_all(held)
results["stallConnections"] = len(stalled_accepted)
results["stallAllDirect"] = all(flow.server_conn.via is None for flow in held)
results["stallThreadsAdded"] = threading.active_count() - threads_before

# A control server that is gone sends the request direct instead of failing it.
addon.CONTROL = "http://127.0.0.1:1"
gone = route(FakeFlow("down.example.com"))
results["controlGoneVia"] = gone.server_conn.via
results["controlGoneKeptSeconds"] = addon._routes["https://down.example.com/"][0] - time.monotonic()
results["answerKeptSeconds"] = addon._routes["https://api.example.com/"][0] - time.monotonic()

print(json.dumps(results))

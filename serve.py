#!/usr/bin/env python3
"""Local dev server that sets the two headers browsers require for
crossOriginIsolated (SharedArrayBuffer / shared WebAssembly.Memory /
Atomics.wait in Workers): Cross-Origin-Opener-Policy and
Cross-Origin-Embedder-Policy. Plain `python -m http.server` can't set
custom response headers at all, so the real multithreaded build won't
work when served that way - use this instead:

    python3 serve.py [port]   # default port 8000
"""
import socket
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn


class CrossOriginIsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # This server only exists for local development (the real deployment
        # target, GitHub Pages, never runs this file - it relies on
        # coi-shim.js instead, see the README). A normal browser HTTP cache
        # is actively hostile to that workflow: main.html/main.css/main.js
        # have no cache-busting query params (unlike main.wasm/
        # replay_worker.wasm/replay-worker.js, which already force
        # {cache:'no-store'} or a `?v=` suffix on every fetch precisely
        # because they're rebuilt constantly during a session), so a plain
        # repeat navigation to the same URL can silently keep serving
        # whatever the browser cached minutes or sessions ago even after the
        # file on disk changed - confirmed in practice: edited CSS/HTML not
        # reflected until the exact cache key was bypassed by hand. Blanket
        # no-store here is the actual fix (every response from this dev
        # server, not just the handful of assets someone remembered to
        # cache-bust in JS) and costs nothing in production since this
        # handler never runs there.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    # IPv4-only (the HTTPServer default) breaks Chrome specifically: Chrome
    # resolves "localhost" to both ::1 and 127.0.0.1 and races them
    # (RFC 8305 Happy Eyeballs), trying ::1 first. An IPv4-only listener
    # refuses that attempt at the kernel level (instant RST, since nothing
    # is bound on that address/port for AF_INET6) - Chrome's fallback to
    # 127.0.0.1 then succeeds and starts streaming normally, but for large
    # responses Chrome's own network stack aborts that fallback connection
    # partway through (RST from the client side, confirmed via tcpdump:
    # clean data flow and ACKs up to a point, then an RST from Chrome's
    # socket, not the server's) - surfacing as "Failed to fetch" only for
    # big files, only in Chrome. Firefox doesn't race connections the same
    # way and was unaffected. Binding dual-stack (AF_INET6 on "::" with
    # IPV6_V6ONLY disabled, which is the Linux default anyway - set
    # explicitly here so it doesn't depend on that default) makes the IPv6
    # attempt succeed directly, so the race/fallback/abort sequence never
    # happens at all.
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()

    # Plain HTTPServer handles one request at a time - fine for a single
    # browser tab, but this project routinely has several concurrent
    # consumers (parallel reader workers each fetching the wasm/db, or
    # multiple browser engines in the automated test suite each holding
    # their own keep-alive connection) that would otherwise queue behind
    # whichever connection happens to still be open, silently serializing
    # things that are supposed to be concurrent and occasionally causing
    # outright hangs (one lingering connection blocks everyone after it).
    daemon_threads = True
    allow_reuse_address = True

    # TCPServer.request_queue_size default is 5 - the OS-level backlog of
    # connections waiting to be accept()ed. run_test_suite.py can easily
    # have 6+ browser processes in flight at once, each firing off several
    # near-simultaneous requests (the HTML page, the wasm, the ground-truth
    # JSON, and a multi-hundred-MB .sqlite) - bursts well past 5 pending
    # connections are normal, not a bug. Once the backlog fills, the OS
    # refuses new connections outright, which browsers surface as "Failed to
    # fetch" - seen in practice running the suite under load. A bigger
    # backlog doesn't add real concurrency (still one thread per accepted
    # connection - see daemon_threads above) but stops legitimate bursts
    # from being rejected before a thread even gets a chance to pick them up.
    request_queue_size = 128

    def handle_error(self, request, client_address):
        # A client (browser/driver process) disappearing mid-response is
        # routine under this workload - a Selenium retry killing a browser
        # while its in-flight fetch() is still being served, a test timeout,
        # a page navigating away - not a server bug. The stdlib default
        # dumps a full traceback for this exact case (ConnectionResetError/
        # BrokenPipeError while writing the response body), which reads as
        # alarming server crash spam when it's actually an expected,
        # harmless, per-connection event; every other request keeps working
        # fine (that's the whole point of ThreadingMixIn). Log it as the
        # one-liner it actually is; anything else still gets the real
        # traceback, since that WOULD be worth seeing.
        exc_type, exc, _ = sys.exc_info()
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            print(f"{client_address[0]} - - client disconnected mid-response ({exc_type.__name__}), continuing")
            return
        super().handle_error(request, client_address)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("::", port), CrossOriginIsolatedHandler)
    print(f"Serving on http://localhost:{port} (COOP/COEP enabled, crossOriginIsolated-capable)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

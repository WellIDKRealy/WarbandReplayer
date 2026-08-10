#!/usr/bin/env python3
"""Local dev server that sets the two headers browsers require for
crossOriginIsolated (SharedArrayBuffer / shared WebAssembly.Memory /
Atomics.wait in Workers): Cross-Origin-Opener-Policy and
Cross-Origin-Embedder-Policy. Plain `python -m http.server` can't set
custom response headers at all, so the real multithreaded build won't
work when served that way - use this instead:

    python3 serve.py [port]   # default port 8000
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class CrossOriginIsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = HTTPServer(("", port), CrossOriginIsolatedHandler)
    print(f"Serving on http://localhost:{port} (COOP/COEP enabled, crossOriginIsolated-capable)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

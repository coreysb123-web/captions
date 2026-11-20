#!/usr/bin/env python3
"""Preview the captions app on this computer.

    python serve.py        ->  http://localhost:8123

Serves the "docs" folder (the app) with the right file types and no caching.
The microphone works on http://localhost. Phones need the real https address.
"""
import functools
import http.server
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
# Optional second argument: a different folder to serve (used to test the app in a sub-folder).
ROOT = os.path.join(HERE, sys.argv[2] if len(sys.argv) > 2 else "docs")


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows sometimes reports .js as text/plain, which browsers refuse to run.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"Captions preview running at http://localhost:{PORT}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass

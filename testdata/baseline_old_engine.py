#!/usr/bin/env python3
"""Baseline measurements of the OLD engine (committed main.html + wasm) on one replay file.

Starts serve.py (COOP/COEP), opens main.html in headless Chromium, picks the file, and records:
  - seconds until the viewer is ready (hamburger menu visible) or the timeout / an alert,
  - the loading-text sequence the user sees,
  - peak and final resident memory of the whole browser process tree,
  - how many battles the timeline shows,
  - frames per second over a few seconds of playback (software GL: informational only, never a budget).
Results go to stdout as JSON and, with --json, to a file. Requires playwright 1.56 (matches /opt/pw-browsers chromium-1194).
Usage: baseline_old_engine.py FILE.sqlite [--timeout 900] [--json out.json] [--port 8139]
"""
import argparse
import functools
import json
import os
import socket
import sys
import threading
import time
from http.server import HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn

import psutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import serve  # the old dev server's COOP/COEP handler (its own main() binds IPv6 only; some containers have no IPv6)


class IPv4Server(ThreadingMixIn, HTTPServer):
    address_family = socket.AF_INET
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128

    def handle_error(self, request, client_address):
        pass


def browser_rss_mb():
    total = 0
    for p in psutil.process_iter(["name", "cmdline", "memory_info"]):
        try:
            n = (p.info["name"] or "").lower()
            if "chrom" in n or "headless" in n:
                total += p.info["memory_info"].rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return total / 1e6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--json")
    ap.add_argument("--port", type=int, default=8139)
    ap.add_argument("--play-seconds", type=int, default=6)
    a = ap.parse_args()
    path = Path(a.file).resolve()

    handler = functools.partial(serve.CrossOriginIsolatedHandler, directory=str(ROOT))
    server = IPv4Server(("127.0.0.1", a.port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    peak = [0.0]
    stop = threading.Event()

    def sampler():
        while not stop.is_set():
            peak[0] = max(peak[0], browser_rss_mb())
            time.sleep(0.5)

    threading.Thread(target=sampler, daemon=True).start()
    result = {"file": path.name, "bytes": path.stat().st_size, "loadavg": os.getloadavg()[0]}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"])
            page = browser.new_page()
            dialogs = []
            page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)[:200]))
            page.goto(f"http://127.0.0.1:{a.port}/main.html?debug=1")
            page.wait_for_timeout(500)
            t0 = time.time()
            page.set_input_files("#file-input", str(path))
            seen = []
            ready = False
            while time.time() - t0 < a.timeout:
                try:
                    txt = page.evaluate("document.getElementById('progress-text') ? document.getElementById('progress-text').innerText : ''")
                    vis = page.evaluate("document.getElementById('hamburger-container').style.display === 'block'")
                except Exception as e:  # page crashed
                    result["page_error"] = str(e)[:200]
                    break
                if txt and (not seen or seen[-1][1] != txt):
                    seen.append((round(time.time() - t0, 1), txt))
                if vis:
                    ready = True
                    break
                if dialogs:
                    break
                time.sleep(0.25)
            result["ready"] = ready
            result["seconds_to_ready"] = round(time.time() - t0, 1)
            result["loading_text_sequence"] = seen[-40:]
            result["alerts"] = dialogs
            result["page_errors"] = errors[:5]
            if ready:
                time.sleep(1.0)
                result["battles_on_timeline"] = page.evaluate("document.querySelectorAll('[title^=\"Jump to Match\"]').length")
                result["fps_software_gl"] = page.evaluate(
                    "new Promise(r=>{let n=0,t=performance.now();function f(){n++;if(performance.now()-t>%d){r(n*1000/(performance.now()-t))}else requestAnimationFrame(f)}requestAnimationFrame(f)})" % (a.play_seconds * 1000))
            browser.close()
    finally:
        stop.set()
        server.shutdown()
        result["peak_browser_rss_mb"] = round(peak[0])
    print(json.dumps(result, indent=2))
    if a.json:
        Path(a.json).write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

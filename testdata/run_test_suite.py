#!/usr/bin/env python3
"""
Automated test suite for the replay engine. Drives verify_against_truth.html
(which drives the real replay_worker.wasm, checked against ground_truth.py's
independent SQL reimplementation) across every replay in testdata/, in every
browser engine available, using Selenium instead of Playwright.

Browsers: chrome, firefox, webkit (webkit is Linux-only - see note below).

Error reporting:
  - Before running any real cases, each browser gets ONE cheap launch-and-quit
    probe. If a browser can't start at all (missing/mismatched driver, missing
    binary, ...), that's reported ONCE clearly and its cases are skipped -
    instead of every one of N cases failing with the same wall of text.
  - Exception messages are trimmed to their actual point (Selenium likes to
    bury it under a doc-link URL and/or an embedded stacktrace dump).
  - A page-internal fetch() failure (seen in practice under concurrent load
    against a local dev server) gets one retry, same as a crashed browser,
    since it's usually a transient hiccup, not a real bug.
  - Ctrl-C exits immediately and cleanly (no double traceback from Python's
    thread-pool shutdown machinery). Note this means a hard-interrupted run
    can leave orphaned chromedriver/geckodriver/browser processes behind -
    `pkill -f chromedriver`/`geckodriver`/`WebKitWebDriver` if you see any.

WEBKIT NOTE: there is no real headless WebKit WebDriver for Windows. The only
two real options anywhere are WebKitGTK (Linux, via
`apt install webkit2gtk-driver`) and actual Safari (macOS only, via
safaridriver). Playwright's "webkit" is a separately-patched build that only
Playwright can drive - Selenium cannot use it. So on Windows, run with
--browsers chrome,firefox, or run this under WSL for webkit coverage. This
script hard-errors (instead of silently skipping) if you ask for webkit on
Windows, so that gap is loud instead of quietly missing coverage.

Requires:
  pip install selenium
  Chrome and Firefox installed (Selenium 4.6+'s Selenium Manager
    auto-downloads chromedriver/geckodriver - no manual driver install
    needed for those two, on either OS).
  For webkit on Linux: sudo apt install webkit2gtk-driver

Requires: testdata/*.sqlite served by serve.py on localhost with COOP/COEP
headers (needed for crossOriginIsolated/SharedArrayBuffer - plain
`python -m http.server` will NOT work; must be the threading server, see
serve.py, or concurrent runs queue behind each other on the socket).

Usage:
  python run_test_suite.py [--base-url URL] [--browsers chrome,firefox,webkit]
                            [--concurrency-per-browser N] [--only substr]
"""
import argparse
import json
import logging
import os
import platform
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.support.ui import WebDriverWait

TESTDATA_DIR = Path(__file__).parent
DEFAULT_BASE_URL = "http://localhost:8126/testdata"

# Substrings that mean "the browser process itself died" (OOM under
# concurrency, most likely) rather than a real test failure - worth exactly
# one retry with a fresh browser, unlike an actual assertion mismatch.
CRASH_SIGNS = ("crash", "disconnected", "invalid session id", "no such window", "connection refused")

# Same idea, but for failures reported INSIDE the page itself (a fetch()
# that failed, not a Selenium/Python exception) - the page code ran fine and
# handed back a clean result, it's just that the result says a network call
# failed. Seen in practice under concurrent load against a local dev server.
TRANSIENT_RESULT_SIGNS = ("failed to fetch", "networkerror", "err_connection", "err_network", "err_empty_response")


def discover_cases():
    """Yields (label, file_url_path, gt_url_path) for every replay with a
    matching ground-truth JSON already generated."""
    batch_dir = TESTDATA_DIR / "replays_batch"
    gt_dir = TESTDATA_DIR / "gt_batch"
    if not (batch_dir.is_dir() and gt_dir.is_dir()):
        return
    for sqlite_path in sorted(batch_dir.glob("*.sqlite")):
        gt_path = gt_dir / (sqlite_path.stem + ".json")
        if gt_path.exists():
            yield (sqlite_path.name, f"replays_batch/{sqlite_path.name}", f"gt_batch/{sqlite_path.stem}.json")


def make_driver(browser, args):
    if browser == "chrome":
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        opts = Options()
        opts.add_argument("--headless=new")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        service = Service(args.chromedriver) if args.chromedriver else Service()
        return webdriver.Chrome(service=service, options=opts)

    if browser == "firefox":
        from selenium.webdriver.firefox.options import Options
        from selenium.webdriver.firefox.service import Service
        opts = Options()
        opts.add_argument("-headless")
        service = Service(args.geckodriver) if args.geckodriver else Service()
        return webdriver.Firefox(service=service, options=opts)

    if browser == "webkit":
        from selenium.webdriver.webkitgtk.options import Options
        from selenium.webdriver.webkitgtk.service import Service
        opts = Options()
        opts.add_argument("--headless")
        service = Service(args.webkitwebdriver or "WebKitWebDriver")
        return webdriver.WebKitGTK(service=service, options=opts)

    raise ValueError(f"unknown browser {browser!r} (expected chrome, firefox, or webkit)")


def short_error(e):
    """Selenium exceptions often bury the actual message under a doc-link
    URL and/or an embedded stacktrace dump. Keep just the core message, on
    one line, so a failure is readable instead of a wall of text."""
    msg = getattr(e, "msg", None) or str(e)
    msg = msg.split("; For documentation on this error")[0]
    msg = msg.split("\nStacktrace:")[0]
    msg = " ".join(msg.split())  # collapse to one line
    if len(msg) > 160:
        msg = msg[:157] + "..."
    return msg.strip() or type(e).__name__


def looks_transient(error_text):
    if not error_text:
        return False
    e = error_text.lower()
    return any(s in e for s in TRANSIENT_RESULT_SIGNS)


def probe_browser(browser, args):
    """Launch and immediately quit one driver before running any real cases.
    Catches a browser that can't start AT ALL (missing/mismatched driver,
    missing binary, ...) exactly once, up front - instead of every one of N
    cases failing with the same message."""
    driver = None
    try:
        driver = make_driver(browser, args)
        return None
    except Exception as e:
        return short_error(e)
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass


def run_case(browser, args, label, file_path, gt_path):
    """Runs one (browser, replay) test case. Every attempt gets a brand new
    driver process and always quits it afterward - so a crashed/poisoned
    browser can never leak into the next case, retry or not."""
    url = f"{args.base_url}/verify_against_truth.html?file={file_path}&gt={gt_path}"
    t0 = time.time()
    last_err = None

    for attempt in range(2):  # one retry, only on a crash- or network-flake-like failure
        driver = None
        try:
            driver = make_driver(browser, args)
            driver.set_page_load_timeout(args.timeout_s)
            driver.get(url)
            WebDriverWait(driver, args.timeout_s).until(
                lambda d: d.execute_script("return !!(window.__testResult && window.__testResult.done === true)")
            )
            result = driver.execute_script("return window.__testResult")
            if not result.get("allPass") and looks_transient(result.get("error")) and attempt == 0:
                last_err = RuntimeError(result.get("error"))
                continue  # retry once - Selenium's own round-trip was fine, the page's fetch() wasn't
            result["wallMs"] = round((time.time() - t0) * 1000)
            if attempt > 0:
                result["retried"] = attempt
            return result
        except Exception as e:
            last_err = e
            if not any(s in str(e).lower() for s in CRASH_SIGNS) or attempt == 1:
                break
        finally:
            if driver is not None:
                try:
                    driver.quit()
                except Exception:
                    pass

    return {"allPass": False, "error": short_error(last_err) if last_err is not None else "unknown error",
            "wallMs": round((time.time() - t0) * 1000)}


def run_browser(browser, cases, args, results, print_lock):
    """Runs every case for this browser, up to --concurrency-per-browser at
    once. Called from its own thread (one per browser) so all browsers run
    at the same time; the pool here bounds concurrency WITHIN one browser -
    each worker gets its own browser process, since Selenium has no cheap
    shared-process concurrency the way Playwright's pages do."""
    preflight = probe_browser(browser, args)
    if preflight is not None:
        with print_lock:
            print(f"  [{browser:9s}] SKIP  all {len(cases)} cases -- {browser} can't start: {preflight}", flush=True)
        for label, _, _ in cases:
            results[(browser, label)] = {"allPass": False, "skipped": True, "error": preflight, "wallMs": 0}
        return

    with ThreadPoolExecutor(max_workers=args.concurrency_per_browser) as pool:
        futures = {pool.submit(run_case, browser, args, label, fp, gp): label for label, fp, gp in cases}
        for future in as_completed(futures):
            label = futures[future]
            r = future.result()
            status = "PASS" if r.get("allPass") else "FAIL"
            extra = ""
            if not r.get("allPass"):
                if r.get("error"):
                    extra = f" -- {r['error']}"
                elif r.get("sampleFailures"):
                    extra = f" -- {r['sampleFailures']}/{r.get('totalSamples', '?')} samples failed"
            with print_lock:
                print(f"  [{browser:9s}] {status:4s} {label:45s} ({r.get('wallMs', '?')}ms){extra}", flush=True)
            results[(browser, label)] = r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--browsers", default="chrome,firefox,webkit")
    ap.add_argument("--timeout-s", type=int, default=120)
    ap.add_argument("--concurrency-per-browser", type=int, default=3)
    ap.add_argument("--only", default=None, help="substring filter on filename")
    ap.add_argument("--chromedriver", default=None, help="path to chromedriver (default: auto)")
    ap.add_argument("--geckodriver", default=None, help="path to geckodriver (default: auto)")
    ap.add_argument("--webkitwebdriver", default=None, help="path to WebKitWebDriver (default: PATH)")
    args = ap.parse_args()

    # Best-effort: silence Selenium's own internal INFO/WARNING chatter (e.g.
    # repeated "chromedriver version might not be compatible" lines, once
    # per driver launch). Not guaranteed to catch every message - some
    # Selenium/driver output goes straight to stderr instead of through
    # logging - but harmless either way. If you keep seeing a version-
    # mismatch warning, that one's real: it means the chromedriver/geckodriver
    # on PATH doesn't match your installed browser - point --chromedriver /
    # --geckodriver at a matching one, or remove the stale one from PATH.
    logging.getLogger("selenium").setLevel(logging.ERROR)

    browsers = [b.strip() for b in args.browsers.split(",") if b.strip()]

    if "webkit" in browsers and platform.system() != "Linux":
        print(f"ERROR: --browsers includes webkit, but there is no real WebKit WebDriver on "
              f"{platform.system()}. WebKitGTK (what 'webkit' means here) only runs on Linux.\n"
              f"Either drop webkit (--browsers chrome,firefox) or run this under WSL.")
        sys.exit(1)

    cases = list(discover_cases())
    if args.only:
        cases = [c for c in cases if args.only in c[0]]
    if not cases:
        print("No test cases found (no ground truth JSON under gt_batch/ - run ground_truth.py first).")
        sys.exit(1)

    print(f"{len(cases)} replay file(s) x {len(browsers)} browser engine(s) = {len(cases) * len(browsers)} runs, "
          f"concurrency={args.concurrency_per_browser}/browser, all browsers concurrent\n", flush=True)

    t0 = time.time()
    results = {}
    print_lock = threading.Lock()

    threads = [threading.Thread(target=run_browser, args=(b, cases, args, results, print_lock), daemon=True)
               for b in browsers]
    for t in threads:
        t.start()
    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        print("\nInterrupted - stopping immediately. Some browser/driver processes may be left running "
              "(daemon threads don't get a chance to clean up on a hard interrupt) - "
              "`pkill -f chromedriver`/`geckodriver`/`WebKitWebDriver` if you see leftovers.")
        os._exit(130)  # os._exit, not sys.exit: skips atexit/thread-pool shutdown, which is what
                        # produces the ugly double traceback on Ctrl-C otherwise.

    wall = time.time() - t0
    failed = [k for k, r in results.items() if not r.get("allPass")]
    print("\n" + "=" * 70)
    print(f"SUMMARY: {len(results) - len(failed)}/{len(results)} passed in {wall:.1f}s wall clock")
    if failed:
        print("\nFAILURES:")
        # Group identical (browser, error) failures together so a systemic
        # problem (a browser that can't start, say) shows up as ONE line
        # with a count, not N duplicate lines.
        groups = {}
        for browser, label in failed:
            r = results[(browser, label)]
            detail = r.get("error") or f"{r.get('sampleFailures')}/{r.get('totalSamples')} samples"
            groups.setdefault((browser, detail), []).append(label)
        for (browser, detail), labels in sorted(groups.items()):
            if len(labels) == 1:
                print(f"  [{browser}] {labels[0]}: {detail}")
            else:
                shown = ", ".join(labels[:3]) + (", ..." if len(labels) > 3 else "")
                print(f"  [{browser}] {len(labels)} cases, same failure: {detail}")
                print(f"      ({shown})")

    out_path = TESTDATA_DIR / "test_suite_results.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({f"{b}::{l}": r for (b, l), r in results.items()}, f, indent=1)
    print(f"\nfull results written to {out_path}")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

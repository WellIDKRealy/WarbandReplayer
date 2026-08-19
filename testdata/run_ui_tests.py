#!/usr/bin/env python3
"""
UI-behavior regression suite - a companion to run_test_suite.py's
ground-truth data-correctness suite. That one asks "does the replay engine
compute the right positions/corpses/chat"; this one asks "does the UI
actually behave correctly": the hamburger menu, the draggable/toggleable
debug panels, and two real races found and fixed during development (an
OPFS sync-access-handle release racing a fast reset->reload, and the
prefetch worker's readiness racing the per-frame handler) - none of which
would be caught by ground-truth comparison, since none of them affect
computed replay data.

Drives ui_behavior_tests.js against the REAL main.html (not a copy/mock of
it) via Selenium's execute_script, then polls window.__testResult exactly
like run_test_suite.py polls verify_against_truth.html - same convention on
purpose, so both suites read the same way and a future person maintaining
one already understands the other.

Requires: serve.py running (COOP/COEP + crossOriginIsolated, same
requirement as run_test_suite.py) and testdata/synthetic_fixture.sqlite
present (already used by other tests in this directory).

Usage:
  python run_ui_tests.py [--base-url URL] [--browsers chrome,firefox]
"""
import argparse
import sys
import time
from pathlib import Path

from selenium.webdriver.support.ui import WebDriverWait

# Reuses run_test_suite.py's driver-launching logic instead of duplicating
# it - same Chrome/Firefox/WebKit setup, same chromedriver/binary-pairing
# footgun avoidance, one place to fix if that ever needs to change.
from run_test_suite import make_driver, probe_browser, short_error

TESTDATA_DIR = Path(__file__).parent
# main.html lives at the project root, one level up from testdata/ - unlike
# run_test_suite.py's DEFAULT_BASE_URL, which points AT testdata/ (that
# suite's own test page - verify_against_truth.html - lives there instead).
DEFAULT_BASE_URL = "http://localhost:8137"


def run_one(browser, args):
    driver = None
    try:
        driver = make_driver(browser, args)
        driver.set_page_load_timeout(args.timeout_s)
        driver.get(f"{args.base_url}/main.html?debug=1")
        script = (TESTDATA_DIR / "ui_behavior_tests.js").read_text(encoding="utf-8")
        driver.execute_script(script)
        WebDriverWait(driver, args.timeout_s).until(
            lambda d: d.execute_script("return !!(window.__testResult && window.__testResult.done === true)")
        )
        return driver.execute_script("return window.__testResult")
    except Exception as e:
        return {"allPass": False, "error": short_error(e), "checks": []}
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--browsers", default="chrome,firefox")
    ap.add_argument("--timeout-s", type=int, default=90)
    ap.add_argument("--chromedriver", default=None, help="path to chromedriver (default: auto)")
    ap.add_argument("--chrome-binary", default=None, help="path to chrome/chromium binary (default: auto-paired with chromedriver)")
    ap.add_argument("--geckodriver", default=None, help="path to geckodriver (default: auto)")
    ap.add_argument("--webkitwebdriver", default=None, help="path to WebKitWebDriver (default: PATH)")
    args = ap.parse_args()

    browsers = [b.strip() for b in args.browsers.split(",") if b.strip()]
    any_fail = False

    for browser in browsers:
        preflight = probe_browser(browser, args)
        if preflight is not None:
            print(f"[{browser:9s}] SKIP -- {browser} can't start: {preflight}")
            any_fail = True
            continue

        t0 = time.time()
        result = run_one(browser, args)
        wall_ms = round((time.time() - t0) * 1000)
        status = "PASS" if result.get("allPass") else "FAIL"
        print(f"[{browser:9s}] {status} ({wall_ms}ms)")

        for c in result.get("checks", []):
            mark = "  ok  " if c.get("ok") else "  FAIL"
            line = f"    {mark} {c.get('name')}"
            if not c.get("ok") and c.get("detail"):
                line += f" -- {c['detail']}"
            print(line)

        if not result.get("allPass"):
            any_fail = True
            if result.get("error"):
                print(f"    error: {result['error']}")

    sys.exit(1 if any_fail else 0)


if __name__ == "__main__":
    main()

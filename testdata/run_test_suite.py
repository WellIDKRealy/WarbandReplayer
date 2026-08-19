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
  Optional: pip install psutil - enables --max-suite-memory-mb (see below).
    Without it, that flag is accepted but has no effect (a warning is
    printed once).

Memory budget (--max-suite-memory-mb): this suite can spawn a lot of
concurrent browser processes (concurrency-per-browser x browser count),
each a real Chrome/Firefox instance with its own subprocess tree. On a
machine also being used for other things at the same time, that's a real
problem. --max-suite-memory-mb caps how much RAM THIS SUITE'S OWN spawned
processes (tracked by PID/process-tree, summed via psutil) are allowed to
use at once - it does NOT look at, and NEVER touches, anything else running
on the machine. When a new case would push the suite over that cap, it
waits (polling, no fixed timeout death spiral) for a currently-running case
to finish and free memory, rather than launching immediately. Guarded
against the degenerate case of a cap set below what even one browser
instance needs: with zero cases currently running, a new one is always let
through immediately (waiting would just deadlock forever), and there's also
a bounded max-wait fallback that proceeds-with-a-warning rather than hang
indefinitely if the cap stays exceeded for too long even with something
already running.

Requires: testdata/*.sqlite served by serve.py on localhost with COOP/COEP
headers (needed for crossOriginIsolated/SharedArrayBuffer - plain
`python -m http.server` will NOT work; must be the threading server, see
serve.py, or concurrent runs queue behind each other on the socket).

Usage:
  python run_test_suite.py [--base-url URL] [--browsers chrome,firefox,webkit]
                            [--concurrency-per-browser N] [--only substr]
"""
import argparse
import contextlib
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

try:
    import psutil
except ImportError:
    psutil = None

TESTDATA_DIR = Path(__file__).parent
DEFAULT_BASE_URL = "http://localhost:8137/testdata"  # matches serve.py's/run_ui_tests.py's convention

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


def _default_chrome_binary():
    """If a chromedriver is going to be resolved from PATH (the branch
    below), pin the browser binary to a matching PATH entry too, instead of
    letting Selenium Manager silently auto-download a DIFFERENT Chrome
    version to pair with it. That skew is a real, confirmed footgun here:
    chromedriver picked up chromium 150.x from PATH while Selenium Manager
    downloaded Chrome-for-Testing 151.x into ~/.cache/selenium and used that
    instead - two different browser builds, only one of them actually
    matching the driver talking to it."""
    import shutil
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        path = shutil.which(name)
        if path:
            return path
    return None


def make_driver(browser, args):
    if browser == "chrome":
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        opts = Options()
        opts.add_argument("--headless=new")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        if args.chrome_binary:
            opts.binary_location = args.chrome_binary
        elif not args.chromedriver:
            # Neither pinned explicitly - if a system chromedriver exists on
            # PATH, pin the matching system browser too so the two can't
            # silently drift apart (see _default_chrome_binary above).
            import shutil
            if shutil.which("chromedriver"):
                default_binary = _default_chrome_binary()
                if default_binary:
                    opts.binary_location = default_binary
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


class MemoryBudget:
    """Gates new browser launches against a memory cap that covers ONLY this
    suite's own spawned processes (tracked by root PID + full descendant
    tree via psutil, summed RSS) - never system-wide usage, never anything
    this suite didn't itself launch, and this class never kills or signals
    any process, ever - it only decides when to let a new `make_driver()`
    call proceed. See the module docstring's "Memory budget" section for
    the deadlock-avoidance reasoning behind the guards below.

    Usage is `with budget.launch_slot(): driver = make_driver(...); pid =
    ...; budget.register(pid)` - NOT separate acquire()/release() calls
    bracketing the whole test case. That distinction matters: a real
    browser process takes a moment after launch before psutil can see its
    true memory footprint (chromedriver spawns, then chrome spawns, then
    its renderer/GPU/utility subprocesses start up and actually allocate).
    An earlier version of this class checked "is anything registered yet"
    and let a launch through immediately whenever nothing was - which,
    tested under real concurrency, let MULTIPLE threads slip through
    together at pool startup (all racing the same "nothing registered yet"
    window) or immediately after any one case finished (release happening
    before the replacement case's process had ramped up), silently
    defeating the cap entirely rather than just being imprecise about it.
    launch_slot() fixes this by holding a single lock across the ENTIRE
    decide-then-launch-then-settle sequence, so only one browser is ever in
    its startup ramp-up window at a time - the cap is enforced against
    what's actually running, not against what's been reported running."""

    SETTLE_S = 3.0  # time to let a freshly-launched browser's memory footprint
                     # become visible to psutil before the next waiting launch
                     # re-checks usage - see the class docstring.

    def __init__(self, max_mb, print_lock):
        self.max_mb = max_mb
        self._print_lock = print_lock
        self._lock = threading.Lock()
        self._launch_lock = threading.Lock()  # serializes the launch+settle window itself
        self._roots = set()
        self._warned_no_psutil = False

    def _current_usage_mb(self):
        with self._lock:
            roots = list(self._roots)
        total_bytes = 0
        for pid in roots:
            try:
                proc = psutil.Process(pid)
                total_bytes += proc.memory_info().rss
                for child in proc.children(recursive=True):
                    try:
                        total_bytes += child.memory_info().rss
                    except psutil.NoSuchProcess:
                        pass  # child exited between listing and sampling - fine, just skip it
            except psutil.NoSuchProcess:
                pass  # root itself already exited (quit() raced this check) - fine
        return total_bytes / (1024 * 1024)

    @contextlib.contextmanager
    def launch_slot(self, poll_interval_s=2.0, max_wait_s=300.0):
        """Blocks (polling, not a condition variable - simplest thing that's
        correct here) until launching a new browser process would keep the
        suite's own tracked usage under max_mb, then holds the launch lock
        for SETTLE_S seconds AFTER the caller's `with` block finishes (by
        which point it should have called register() with the new
        process's PID) so the NEXT waiting launch sees this one's real
        memory footprint instead of a startup-window zero."""
        if self.max_mb is None or psutil is None:
            if self.max_mb is not None and psutil is None and not self._warned_no_psutil:
                with self._print_lock:
                    print("  [budget] --max-suite-memory-mb requires psutil (pip install psutil) - "
                          "no memory limit is being enforced this run.", flush=True)
                self._warned_no_psutil = True
            yield
            return

        with self._launch_lock:
            waited = 0.0
            while True:
                with self._lock:
                    active_count = len(self._roots)
                if active_count == 0:
                    # Nothing of ours is running yet. If we blocked here
                    # anyway, a cap set below what even one instance needs
                    # would wait forever for usage to drop below a floor
                    # nothing has ever reached - deadlocking the entire
                    # suite permanently. Always let the first launch
                    # through; the cap still applies to every launch after.
                    break
                usage = self._current_usage_mb()
                if usage < self.max_mb:
                    break
                if waited >= max_wait_s:
                    with self._print_lock:
                        print(f"  [budget] still over cap after waiting {max_wait_s:.0f}s "
                              f"(usage={usage:.0f}MB, cap={self.max_mb:.0f}MB, "
                              f"{active_count} case(s) still running) - proceeding anyway "
                              f"rather than wait indefinitely.", flush=True)
                    break
                time.sleep(poll_interval_s)
                waited += poll_interval_s

            yield  # caller launches + registers here, still holding _launch_lock

            time.sleep(self.SETTLE_S)  # let this launch become visible before releasing the lock

    def register(self, pid):
        if pid is None:
            return
        with self._lock:
            self._roots.add(pid)

    def release(self, pid):
        if pid is None:
            return
        with self._lock:
            self._roots.discard(pid)


def _driver_root_pid(driver):
    """Best-effort: the OS PID of the driver process Selenium launched (the
    browser itself is a child of this, picked up via children(recursive=True)
    when summing usage) - returns None if this Selenium version/setup
    doesn't expose it, in which case that one case just isn't tracked by the
    budget rather than erroring the whole run."""
    try:
        return driver.service.process.pid
    except Exception:
        return None


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


def run_case(browser, args, label, file_path, gt_path, budget):
    """Runs one (browser, replay) test case. Every attempt gets a brand new
    driver process and always quits it afterward - so a crashed/poisoned
    browser can never leak into the next case, retry or not.

    Retries on a transient-looking failure use a backoff delay, not an
    immediate retry. Confirmed by direct packet capture that this specific
    failure mode (Chrome's own client socket sending an RST mid-transfer on
    a large fetch(), independent of file content, COEP headers, IPv4/IPv6,
    Selenium vs raw CDP, chrome/chromedriver version match - all ruled out
    individually) comes and goes with real transient load on the machine
    running the browsers: the exact same case can fail 100% of attempts for
    several minutes, then pass 100% cleanly with nothing in this script
    changed. An immediate retry races against whatever's causing that
    load; a short delay gives it a chance to actually clear.

    budget.launch_slot() below waits (if --max-suite-memory-mb is set) for
    room under the suite's own memory cap before launching each new browser
    process - see MemoryBudget's docstring."""
    url = f"{args.base_url}/verify_against_truth.html?file={file_path}&gt={gt_path}"
    if args.priming_budget_bytes:
        url += f"&primingBudgetBytes={args.priming_budget_bytes}"
    t0 = time.time()
    last_err = None
    max_attempts = args.max_attempts

    for attempt in range(max_attempts):
        driver = None
        pid = None
        try:
            with budget.launch_slot():
                driver = make_driver(browser, args)
                pid = _driver_root_pid(driver)
                budget.register(pid)
            driver.set_page_load_timeout(args.timeout_s)
            driver.get(url)
            WebDriverWait(driver, args.timeout_s).until(
                lambda d: d.execute_script("return !!(window.__testResult && window.__testResult.done === true)")
            )
            result = driver.execute_script("return window.__testResult")
            if not result.get("allPass") and looks_transient(result.get("error")) and attempt < max_attempts - 1:
                last_err = RuntimeError(result.get("error"))
                time.sleep(args.retry_backoff_s * (attempt + 1))
                continue
            result["wallMs"] = round((time.time() - t0) * 1000)
            if attempt > 0:
                result["retried"] = attempt
            return result
        except Exception as e:
            last_err = e
            if not any(s in str(e).lower() for s in CRASH_SIGNS) or attempt == max_attempts - 1:
                break
            time.sleep(args.retry_backoff_s * (attempt + 1))
        finally:
            if driver is not None:
                try:
                    driver.quit()
                except Exception:
                    pass
            budget.release(pid)  # after quit() completes, not before - a waiting
                                  # launch shouldn't see "room" until the memory's
                                  # actually being freed, not just about to be

    return {"allPass": False, "error": short_error(last_err) if last_err is not None else "unknown error",
            "wallMs": round((time.time() - t0) * 1000)}


def run_browser(browser, cases, args, results, print_lock, budget):
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
        futures = {pool.submit(run_case, browser, args, label, fp, gp, budget): label for label, fp, gp in cases}
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
    ap.add_argument("--max-attempts", type=int, default=3, help="attempts per case before giving up on a transient-looking failure (default: 3, i.e. up to 2 retries)")
    ap.add_argument("--retry-backoff-s", type=float, default=3.0, help="base delay before a retry, multiplied by attempt number (default: 3s, 6s, ...) - gives transient machine load a chance to clear instead of racing it")
    ap.add_argument("--only", default=None, help="substring filter on filename")
    ap.add_argument("--priming-budget-bytes", type=int, default=None,
                     help="force replay_worker.wasm's per-battle-index memory budget to this many bytes "
                          "before the ground-truth sampling pass, so every sample exercises the evict-then-"
                          "rebuild path (replay_evict_battle/replay_ensure_battle_ready) instead of build-once. "
                          "Unset = default device-tiered budget, same as normal use.")
    ap.add_argument("--chromedriver", default=None, help="path to chromedriver (default: auto)")
    ap.add_argument("--chrome-binary", default=None, help="path to chrome/chromium binary (default: auto-paired with chromedriver, see make_driver)")
    ap.add_argument("--geckodriver", default=None, help="path to geckodriver (default: auto)")
    ap.add_argument("--webkitwebdriver", default=None, help="path to WebKitWebDriver (default: PATH)")
    ap.add_argument("--max-suite-memory-mb", type=float, default=None,
                     help="cap on THIS SUITE'S OWN spawned-process memory usage (MB) - never looks at or "
                          "touches other programs on the machine. New browser launches wait for a running "
                          "case to finish and free memory rather than exceed it. Requires `pip install psutil` "
                          "(warns once and runs unlimited if missing). Unset = no limit (default).")
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
    budget = MemoryBudget(args.max_suite_memory_mb, print_lock)
    if args.max_suite_memory_mb is not None and psutil is not None:
        print(f"Suite memory cap: {args.max_suite_memory_mb:.0f}MB (this suite's own processes only)\n", flush=True)

    threads = [threading.Thread(target=run_browser, args=(b, cases, args, results, print_lock, budget), daemon=True)
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

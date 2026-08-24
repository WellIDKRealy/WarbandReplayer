#!/usr/bin/env python3
"""Ctrl+Enter-runs-the-query regression test - Playwright, not Selenium.

This is a NARROW, ADDITIVE test file, same convention as
run_playwright_ctrl_scroll_test.py right next to it: it does not replace or
duplicate anything in run_ui_tests.py/ui_behavior_tests.js. That Selenium-
driven suite already covers Ctrl+Enter for generator-script editors via a
manually dispatchEvent-built KeyboardEvent (see its own comment on why that
approach's ctrlKey flag is trustworthy there). This file exists because the
actual bug report was "Ctrl+Enter does not work in the SQL Terminal" -
verifying a FIX for a real keyboard shortcut deserves a real, OS-level
Ctrl+Enter keypress (Playwright's page.keyboard.press("Control+Enter")),
not a synthetic event the app's own JS constructs for itself - the whole
point is to catch exactly the class of bug where a synthetic-event-based
test would still pass while a genuine keypress does nothing (e.g. if focus
had silently moved off the textarea, or the real browser's own default
Ctrl+Enter handling intercepted it first).

Root cause of the actual bug (fixed alongside this test, main.js's
initSqlTerminalInstance): the main SQL Terminal's own .sql-terminal-input
textarea never had a keydown listener for Ctrl+Enter at all - only
generator-script editors did (wireGeneratorScriptEditorBehavior). It wasn't
a regression in the modifier-key-detection sense; the listener plain didn't
exist on this specific surface.

Requires: serve.py running on port 8137 (same requirement as
run_ui_tests.py/run_test_suite.py/run_playwright_ctrl_scroll_test.py) and
testdata/replays_batch/ populated. Runs in both Chromium and Firefox.

Usage:
  python3 testdata/run_playwright_ctrl_enter_test.py [--base-url URL]
"""
import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

TESTDATA_DIR = Path(__file__).parent
DEFAULT_BASE_URL = "http://localhost:8137"
FIXTURE = TESTDATA_DIR / "replays_batch" / "replayLog_2026-07-22_23-18-29.sqlite"

SQL_INPUT = '[data-panel-type="sql-terminal-panel"] .sql-terminal-input'
SQL_STATUS = '[data-panel-type="sql-terminal-panel"] .sql-terminal-status'
SQL_RESULTS = '[data-panel-type="sql-terminal-panel"] .sql-terminal-results'


def load_replay(page, base_url):
    page.goto(f"{base_url}/main.html?debug=1")
    page.wait_for_timeout(500)
    page.set_input_files("#file-input", str(FIXTURE))
    page.wait_for_function(
        "document.getElementById('hamburger-container').style.display === 'block'",
        timeout=25000,
    )
    page.wait_for_timeout(500)
    # Real user behavior: the SQL Terminal starts CSS-`minimized` even in
    # debug mode - a test must un-collapse it the same way a click would,
    # not just reach into the DOM around the minimized state.
    page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"]', "el => el.classList.remove('minimized')"
    )
    page.wait_for_timeout(300)


# Generous timeouts throughout this file, not tight ones: this shares a dev
# box with other, unrelated CPU-heavy tooling (Ghidra debugger sessions
# among them), and the app itself serializes ALL SQL through one real
# WASM/SQLite worker (sql_terminal.c has exactly one live prepared
# statement - see main.js's sqlRequestQueue) - a query that's normally
# near-instant can genuinely take several real seconds under load. These
# checks assert correctness and ordering, not raw speed.
SQL_WAIT_TIMEOUT_MS = 30000


def run_query_via_ctrl_enter(page, sql):
    """Types `sql` into the SQL Terminal's real input and runs it via a
    genuine OS-level Ctrl+Enter keypress - never the Run button, never a
    JS-constructed event. Returns once the run has genuinely finished."""
    page.click(SQL_INPUT)
    page.fill(SQL_INPUT, "")
    page.type(SQL_INPUT, sql)
    page.keyboard.press("Control+Enter")
    page.wait_for_function(
        """(sel) => {
            const t = document.querySelector(sel).innerText;
            return t.length > 0 && !t.includes('Running') && !t.includes('Queued');
        }""",
        arg=SQL_STATUS,
        timeout=SQL_WAIT_TIMEOUT_MS,
    )


def run_checks(page, browser_name):
    checks = []  # (name, ok, detail)

    def record(name, ok, detail=""):
        checks.append((name, ok, detail))

    # ---- 1. The actual bug report: Ctrl+Enter in the main SQL Terminal
    # input runs the query, with no Run button click at all. ----
    page.eval_on_selector(SQL_RESULTS, "el => el.innerHTML = ''")
    page.eval_on_selector(SQL_STATUS, "el => el.innerText = ''")
    run_query_via_ctrl_enter(page, "SELECT 777 AS marker")
    status = page.eval_on_selector(SQL_STATUS, "el => el.innerText")
    results_text = page.eval_on_selector(SQL_RESULTS, "el => el.innerText")
    record("a real Ctrl+Enter keypress in the SQL Terminal input runs the query",
           "777" in results_text and "row(s)" in status,
           f"status={status!r} results={results_text!r}")

    # ---- 2. Cmd+Enter (macOS-style metaKey) works too - the JS listener
    # checks e.ctrlKey || e.metaKey, so Playwright's "Meta+Enter" must also
    # trigger a run, not just "Control+Enter". ----
    page.eval_on_selector(SQL_RESULTS, "el => el.innerHTML = ''")
    page.eval_on_selector(SQL_STATUS, "el => el.innerText = ''")
    page.click(SQL_INPUT)
    page.fill(SQL_INPUT, "")
    page.type(SQL_INPUT, "SELECT 888 AS marker")
    page.keyboard.press("Meta+Enter")
    page.wait_for_function(
        """(sel) => {
            const t = document.querySelector(sel).innerText;
            return t.length > 0 && !t.includes('Running') && !t.includes('Queued');
        }""",
        arg=SQL_STATUS,
        timeout=SQL_WAIT_TIMEOUT_MS,
    )
    status2 = page.eval_on_selector(SQL_STATUS, "el => el.innerText")
    results_text2 = page.eval_on_selector(SQL_RESULTS, "el => el.innerText")
    record("a real Meta+Enter (Cmd+Enter) keypress also runs the query",
           "888" in results_text2 and "row(s)" in status2,
           f"status={status2!r} results={results_text2!r}")

    # ---- 3. Plain Enter (no modifier) must NOT run the query - it's a
    # multi-line SQL input (rows="3"), so a bare Enter should just insert a
    # newline, same as before this fix. ----
    page.eval_on_selector(SQL_RESULTS, "el => el.innerHTML = ''")
    page.eval_on_selector(SQL_STATUS, "el => el.innerText = ''")
    page.click(SQL_INPUT)
    page.fill(SQL_INPUT, "")
    page.type(SQL_INPUT, "SELECT 999 AS marker")
    page.keyboard.press("Enter")
    page.wait_for_timeout(600)
    # Not asserting the status line is pristine-empty - unrelated background
    # activity (e.g. the periodic camera-recenter probe during playback) can
    # legitimately touch it independently of this keypress. What actually
    # matters: OUR query never ran (no "999" in the results/status) and a
    # real newline landed in the textarea instead.
    results3 = page.eval_on_selector(SQL_RESULTS, "el => el.innerText")
    status3 = page.eval_on_selector(SQL_STATUS, "el => el.innerText")
    value3 = page.eval_on_selector(SQL_INPUT, "el => el.value")
    record("a plain Enter (no Ctrl/Cmd) does not run the query, just inserts a newline",
           "999" not in results3 and "999" not in status3 and "\n" in value3,
           f"status={status3!r} results={results3!r} value={value3!r}")

    # ---- 4. Ctrl+Enter still works after a second SQL Terminal window is
    # opened - each window's own textarea gets its own listener
    # (initSqlTerminalInstance runs once per instance), not a single
    # document-wide one that could end up wired to the wrong panel. ----
    page.evaluate("openNewPanelInstance('sql-terminal-panel')")
    page.wait_for_timeout(300)
    panels = page.query_selector_all('[data-panel-type="sql-terminal-panel"]')
    record("opening a second SQL Terminal window actually creates a second instance",
           len(panels) == 2, f"panel count={len(panels)}")
    if len(panels) == 2:
        second_input = panels[1].query_selector(".sql-terminal-input")
        second_status = panels[1].query_selector(".sql-terminal-status")
        second_results = panels[1].query_selector(".sql-terminal-results")
        second_input.click()
        second_input.fill("")
        second_input.type("SELECT 555 AS marker")
        page.keyboard.press("Control+Enter")
        page.wait_for_function(
            """(el) => {
                const t = el.innerText;
                return t.length > 0 && !t.includes('Running') && !t.includes('Queued');
            }""",
            arg=second_status,
            timeout=SQL_WAIT_TIMEOUT_MS,
        )
        second_results_text = second_results.inner_text()
        first_results_text = page.eval_on_selector(SQL_RESULTS, "el => el.innerText")
        record("Ctrl+Enter in a SECOND SQL Terminal window runs its own query in its own results area",
               "555" in second_results_text and "555" not in first_results_text,
               f"second={second_results_text!r} first={first_results_text!r}")

    return checks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--browsers", default="chromium,firefox")
    args = ap.parse_args()

    if not FIXTURE.exists():
        print(f"FATAL: fixture not found: {FIXTURE}")
        return 1

    browser_names = [b.strip() for b in args.browsers.split(",") if b.strip()]
    overall_ok = True

    with sync_playwright() as p:
        for browser_name in browser_names:
            browser_type = getattr(p, browser_name, None)
            if browser_type is None:
                print(f"[{browser_name}] SKIP - not a Playwright browser type")
                overall_ok = False
                continue
            browser = browser_type.launch()
            try:
                page = browser.new_page(viewport={"width": 1900, "height": 1100})
                load_replay(page, args.base_url)
                checks = run_checks(page, browser_name)
            except Exception as e:
                print(f"[{browser_name:8s}] FAIL - {e}")
                overall_ok = False
                browser.close()
                continue
            browser.close()

            all_pass = all(ok for _, ok, _ in checks)
            overall_ok = overall_ok and all_pass
            print(f"[{browser_name:8s}] {'PASS' if all_pass else 'FAIL'}")
            for name, ok, detail in checks:
                mark = "ok  " if ok else "FAIL"
                suffix = f"  ({detail})" if detail and not ok else ""
                print(f"      {mark} {name}{suffix}")

    print()
    print("=" * 70)
    print("SUMMARY:", "ALL PASSED" if overall_ok else "FAILURES ABOVE")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Ctrl+Scroll text-zoom regression test - Playwright, not Selenium.

This is a NARROW, ADDITIVE test file: it does not replace, port, or
duplicate anything in run_ui_tests.py/ui_behavior_tests.js (the Selenium-
driven suites) - those keep covering everything else. This file exists
because of one specific limitation Selenium's Actions API has here:
`ActionChains(...).key_down(Keys.CONTROL).scroll_by_amount(...)` does not
reliably carry the Ctrl modifier through to the resulting `wheel` DOM event
in either Chrome or Firefox under WebDriver (confirmed directly - the
resulting event's `ctrlKey` comes through false, so a test built on it can
neither reproduce nor verify a real Ctrl+Scroll gesture). Playwright's
`page.keyboard.down("Control")` + `page.mouse.wheel(...)` does not have this
problem - it tracks held modifiers as real input state, the same way an
actual OS-level input stream would - so it can actually exercise the exact
gesture this bug is about.

What's being verified, precisely - two DIFFERENT bugs, both real, found in
two rounds of the same user report ("it is still resizing when I scroll"):

1. Native browser zoom leaking through. main.js's window-level `wheel`
   handler (search "Single wheel handler for the whole page") is supposed to
   zoom a panel's content when the user holds Ctrl and scrolls anywhere
   inside that panel - INCLUDING over the 8 resize-handle strips, which are
   siblings of .panel-content, not descendants of it, and were the original
   gap: a wheel event landing on one of those never reached a per-content-
   element listener at all, so preventDefault() never ran, letting the
   browser's own native Ctrl+Scroll page-zoom through unimpeded (which -
   since it scales the whole page - looks exactly like every window
   "resizing" together); and plain scroll (no Ctrl) must be left alone
   entirely, so normal content scrolling keeps working.

2. The panel box ITSELF growing. The first fix for #1 applied CSS `zoom`
   directly to .panel-content - but .panel-content is the element carrying
   the real box constraint (main.css's `max-height: 174px`, or whatever a
   resize/restore has set inline), and `zoom` scales EVERY length on the
   zoomed element, including its own max-height - confirmed directly:
   zoom:1.5 on .panel-content grew ITS OWN rendered box by 1.5x. That's a
   second, different way to get the exact same "the window resizes as I
   scroll" symptom the user reported, with nothing to do with native
   browser zoom at all. The fix moves `zoom` onto a plain wrapper div INSIDE
   .panel-content (main.js's ensurePanelZoomWrap) that carries no box
   constraints of its own - .panel-content's pre-existing overflow-y:auto
   clips/scrolls the now-larger wrapper exactly like any other overflowing
   content, while the panel's own on-screen footprint never moves. Check #7
   below is the direct regression test for this: the panel's own
   getBoundingClientRect() must be bit-for-bit identical before and after
   zooming.

Requires: serve.py running on port 8137 (same requirement as
run_ui_tests.py/run_test_suite.py) and testdata/replays_batch/ populated.
Runs in both Chromium and Firefox (Playwright ships and manages its own
builds of both - `python3 -m playwright install` if either is missing).

Usage:
  python3 testdata/run_playwright_ctrl_scroll_test.py [--base-url URL]
"""
import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

TESTDATA_DIR = Path(__file__).parent
DEFAULT_BASE_URL = "http://localhost:8137"
FIXTURE = TESTDATA_DIR / "replays_batch" / "replayLog_2026-07-22_23-18-29.sqlite"


def ctrl_wheel_at(page, x, y, delta_y=-300):
    """One discrete Ctrl+Scroll tick at a page-relative point."""
    page.mouse.move(x, y)
    page.keyboard.down("Control")
    page.mouse.wheel(0, delta_y)
    page.keyboard.up("Control")
    page.wait_for_timeout(200)


def plain_wheel_at(page, x, y, delta_y=100):
    page.mouse.move(x, y)
    page.mouse.wheel(0, delta_y)
    page.wait_for_timeout(200)


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
    # debug mode (see main.html - only its own header is visible until a
    # user clicks it once, or a test explicitly un-collapses it the same
    # way ui_behavior_tests.js's own SQL-terminal section already does).
    page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"]', "el => el.classList.remove('minimized')"
    )
    page.wait_for_timeout(300)


def content_zoom(page, content_selector):
    """Reads the ZOOM WRAP's zoom, not .panel-content's own - zoom lives on
    main.js's ensurePanelZoomWrap, a child inserted inside .panel-content
    specifically so it's never applied to .panel-content itself (see bug #2
    in the module docstring)."""
    return page.eval_on_selector(
        content_selector,
        "el => (el.querySelector(':scope > .panel-zoom-wrap') || el).style.zoom || '1'",
    )


def panel_box(page, panel_selector):
    return page.eval_on_selector(
        panel_selector,
        "el => { const r = el.getBoundingClientRect(); return {w: r.width, h: r.height}; }",
    )


def run_checks(page, browser_name):
    checks = []  # (name, ok, detail)

    def record(name, ok, detail=""):
        checks.append((name, ok, detail))

    inner_width_baseline = page.evaluate("window.innerWidth")

    def assert_no_native_zoom(label):
        iw = page.evaluate("window.innerWidth")
        record(f"[{label}] native browser page-zoom did not fire", iw == inner_width_baseline,
                f"innerWidth {inner_width_baseline} -> {iw}")

    # ---- 1. Ctrl+Scroll over the SQL Terminal's ordinary content body zooms
    # it, without triggering native page-zoom. ----
    terminal_content = '[data-panel-type="sql-terminal-panel"] > .panel-content'
    box = page.eval_on_selector(
        terminal_content,
        "el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.top + 20}; }",
    )
    zoom_before = content_zoom(page, terminal_content)
    ctrl_wheel_at(page, box["x"], box["y"])
    zoom_after = content_zoom(page, terminal_content)
    record("Ctrl+Scroll over SQL Terminal content increases its zoom",
           float(zoom_after) > float(zoom_before), f"{zoom_before} -> {zoom_after}")
    assert_no_native_zoom("over SQL Terminal content")

    # ---- 2. The original bug: Ctrl+Scroll right at a panel's top edge,
    # where .resize-handle.n overlaps (a sibling of .panel-content, not a
    # descendant - the actual gap this fix closes). ----
    panel_edge_pos = page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"]',
        "el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, top: r.top}; }",
    )
    zoom_before = content_zoom(page, terminal_content)
    ctrl_wheel_at(page, panel_edge_pos["x"], panel_edge_pos["top"] + 1)
    zoom_after = content_zoom(page, terminal_content)
    record("Ctrl+Scroll right at the panel's top edge (resize-handle zone) still zooms it",
           float(zoom_after) > float(zoom_before), f"{zoom_before} -> {zoom_after}")
    assert_no_native_zoom("at panel top edge")

    # ---- 3. Over the panel header (title bar) - also a sibling of
    # .panel-content, same class of gap as #2. ----
    header_box = page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"] .panel-header',
        "el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }",
    )
    zoom_before = content_zoom(page, terminal_content)
    ctrl_wheel_at(page, header_box["x"], header_box["y"])
    zoom_after = content_zoom(page, terminal_content)
    record("Ctrl+Scroll over the panel header still zooms its content",
           float(zoom_after) > float(zoom_before), f"{zoom_before} -> {zoom_after}")
    assert_no_native_zoom("over panel header")

    # ---- 4. Over the SQL input textarea itself (a form control - some
    # browsers give form elements special-cased native scroll handling). ----
    ta_box = page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"] .sql-terminal-input',
        "el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }",
    )
    zoom_before = content_zoom(page, terminal_content)
    ctrl_wheel_at(page, ta_box["x"], ta_box["y"])
    zoom_after = content_zoom(page, terminal_content)
    record("Ctrl+Scroll over the SQL input textarea still zooms the panel",
           float(zoom_after) > float(zoom_before), f"{zoom_before} -> {zoom_after}")
    assert_no_native_zoom("over textarea")

    # ---- 5. A second, unrelated window type (Chat) - the bug report named
    # "other windows" too, not just the SQL Terminal. ----
    chat_content = '[data-panel-type="chat-box"] > .panel-content'
    chat_box = page.eval_on_selector(
        chat_content,
        "el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }",
    )
    zoom_before = content_zoom(page, chat_content)
    ctrl_wheel_at(page, chat_box["x"], chat_box["y"])
    zoom_after = content_zoom(page, chat_content)
    record("Ctrl+Scroll over the Chat window zooms it independently of the SQL Terminal",
           float(zoom_after) > float(zoom_before), f"{zoom_before} -> {zoom_after}")
    assert_no_native_zoom("over chat window")

    # ---- 6. Plain scroll (no Ctrl) must NOT zoom - and must still actually
    # scroll real overflowing content, not just "not crash". ----
    page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"] .sql-terminal-input',
        "el => el.value = 'a\\n'.repeat(80)",
    )  # force real overflow in the input so plain-scroll has somewhere to go
    ta_wrap = page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"] .sql-terminal-input',
        "el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }",
    )
    page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"] .sql-terminal-input', "el => { el.scrollTop = 0; }"
    )
    zoom_before = content_zoom(page, terminal_content)
    scroll_before = page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"] .sql-terminal-input', "el => el.scrollTop"
    )
    plain_wheel_at(page, ta_wrap["x"], ta_wrap["y"])
    zoom_after = content_zoom(page, terminal_content)
    scroll_after = page.eval_on_selector(
        '[data-panel-type="sql-terminal-panel"] .sql-terminal-input', "el => el.scrollTop"
    )
    record("Plain scroll (no Ctrl) does not change zoom", zoom_after == zoom_before,
           f"{zoom_before} -> {zoom_after}")
    record("Plain scroll (no Ctrl) still actually scrolls overflowing content",
           scroll_after > scroll_before, f"scrollTop {scroll_before} -> {scroll_after}")
    assert_no_native_zoom("plain scroll")

    # ---- 7. THE key regression check for bug #2 (see module docstring):
    # the PANEL's own box - not the page, not the content, the panel root
    # itself - must be bit-for-bit unchanged across a whole run of zoom
    # ticks. This is what "it is still resizing when I scroll" was actually
    # about the second time around: zoom applied directly to .panel-content
    # grows that element's own max-height right along with its text. ----
    panel_sel = '[data-panel-type="sql-terminal-panel"]'
    box_before = panel_box(page, panel_sel)
    for _ in range(5):
        ctrl_wheel_at(page, box["x"], box["y"])
    box_after = panel_box(page, panel_sel)
    record("The panel's own box is unchanged after 5 Ctrl+Scroll zoom ticks (only its content grows)",
           box_before == box_after, f"{box_before} -> {box_after}")

    wrap_height_before = page.eval_on_selector(
        terminal_content, "el => el.querySelector(':scope > .panel-zoom-wrap').getBoundingClientRect().height"
    )
    zoom_now = float(content_zoom(page, terminal_content))
    record("...while the zoom actually did increase across those 5 ticks (not a no-op)",
           zoom_now > 1.0, f"zoom={zoom_now}")
    record("...and the zoomed content is now genuinely taller than the panel's own visible window (so there's really something to scroll into)",
           wrap_height_before > box_after["h"], f"wrap height={wrap_height_before} vs panel height={box_after['h']}")

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

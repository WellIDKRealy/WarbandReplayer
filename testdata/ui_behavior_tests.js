// UI-behavior regression suite - a companion to verify_against_truth.html's
// data-correctness checks. That harness asks "does the engine compute the
// right positions/corpses/chat"; this one asks "does the UI actually behave
// correctly" - the hamburger menu, the draggable/toggleable debug panels,
// and two real races found and fixed during development (OPFS-handle
// release racing a fast reset->reload, and the prefetch worker's readiness
// racing the 'frame' handler) that wouldn't be caught by ground-truth
// comparison at all, since none of them affect computed replay data.
//
// Meant to be injected into the REAL main.html (not a copy/mock of it) via
// Selenium's execute_script - see run_ui_tests.py - after a normal page
// load with ?debug=1. Exposes window.__testResult = {..., done:true} using
// the exact same shape/polling convention verify_against_truth.html and
// run_test_suite.py already use, so both suites read the same way.
//
// Every check pushes ['name', ok, detail?] onto `checks`; a thrown
// exception anywhere aborts the run and is reported as its own failure
// rather than silently hanging (matches verify_against_truth.html's
// try/catch-sets-done-true-either-way pattern).

window.__testResult = { done: false };

(async () => {
  const result = { done: false, allPass: false, checks: [] };
  window.__testResult = result;
  const checks = [];

  function waitFor(cond, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (cond()) { clearInterval(iv); resolve(true); }
        else if (Date.now() - start > timeoutMs) { clearInterval(iv); resolve(false); }
      }, 30);
    });
  }

  function fireMouse(el, type, x, y) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  }

  function dragPanel(panelId, dx, dy) {
    const header = document.querySelector(`#${panelId} .panel-header`);
    const r = header.getBoundingClientRect();
    const sx = r.left + 20, sy = r.top + 10;
    fireMouse(header, 'mousedown', sx, sy);
    fireMouse(window, 'mousemove', sx + dx, sy + dy);
    fireMouse(window, 'mousemove', sx + dx + 5, sy + dy + 5); // real drags fire more than one move
    fireMouse(window, 'mouseup', sx + dx + 5, sy + dy + 5);
  }

  function clickPanelHeader(panelId) {
    const header = document.querySelector(`#${panelId} .panel-header`);
    const r = header.getBoundingClientRect();
    fireMouse(header, 'mousedown', r.left + 20, r.top + 10);
    fireMouse(window, 'mouseup', r.left + 20, r.top + 10);
  }

  function rectOf(id) {
    return document.getElementById(id).getBoundingClientRect();
  }

  function overlaps(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  let capturedLogLines = [];
  const origAppendLog = appendToConsoleLog;
  appendToConsoleLog = (m) => { capturedLogLines.push(m); origAppendLog(m); };

  let capturedAlerts = [];
  window.alert = (m) => { capturedAlerts.push(m); };

  try {
    // ---- 1. Basic load reaches RUNNING ----
    const res = await fetch('testdata/synthetic_fixture.sqlite');
    const fixtureBuf = await res.arrayBuffer();
    const freshFile = () => new File([fixtureBuf], 'synthetic_fixture.sqlite');

    startReplayLoad(freshFile());
    const loaded = await waitFor(() => currentSimulationState === 'RUNNING', 15000);
    checks.push(['initial load reaches RUNNING', loaded, `simState=${currentSimulationState}`]);
    if (!loaded) throw new Error('initial load never reached RUNNING - aborting remaining checks');

    // ---- 1b. "b" (replay_export.c's export_create_battledb_schema) - now
    // an arbitrary, user-editable schema (roster_history/corpses by
    // default - see sql/canonical_roster_history.sql/canonical_corpses.sql)
    // that default rendering queries read directly, joined against
    // main.agent_states for position data - not a fixed, C-populated
    // staging table rewritten every tick (that older design, rb.frame_state_a/b,
    // was removed: its schema couldn't be made user-editable without
    // breaking the hardcoded C insert loop that fed it). Attached
    // automatically as soon as a battle is active, via
    // build_frame_at_time's own replay_ensure_db_view(2) call - no
    // ensureDbViewAsync call needed at all from here. ----
    if (matches.length > 0) {
      const battleActive = await waitFor(() => latestFrame && latestFrame.activeMatchIndex >= 0, 10000);
      checks.push(['a battle becomes active on a clean load ("b" attaches as a side effect)',
        battleActive, `battleActive=${battleActive}`]);

      if (battleActive) {
        // Wait for GENUINE content, not just a fixed delay - a fixed short
        // wait right at battle-activation can legitimately still show 0
        // rows (t=0 in the battle, before any unit has spawned yet), which
        // would make the "populates" check below vacuously true even if
        // roster_history/corpses were completely broken (0 >= 0 passes
        // trivially). Confirmed directly during the original rendering
        // rework: this exact gap let a real bug (the interpolation-wrapped
        // query silently failing to prepare on every real fixture, only
        // caught later by ground-truth verification) through this check
        // unnoticed during development.
        // waitFor only supports a SYNCHRONOUS condition (see its own
        // definition above) - runSchemaQueryAsync is inherently async, so
        // this polls manually instead of (incorrectly) passing an async
        // function to waitFor, which would resolve immediately on a Promise
        // object's own truthiness rather than the value it eventually
        // resolves to.
        {
          const pollDeadline = Date.now() + 8000;
          while (Date.now() < pollDeadline) {
            const r = await runSchemaQueryAsync("SELECT COUNT(*) FROM b.roster_history");
            if (r.rows.length && parseInt(r.rows[0][0], 10) > 0) break;
            await new Promise((res) => setTimeout(res, 200));
          }
        }
        const bCounts = await runSchemaQueryAsync(
          "SELECT (SELECT COUNT(*) FROM b.roster_history), (SELECT COUNT(*) FROM b.corpses)");
        const rosterCount = bCounts.rows.length ? parseInt(bCounts.rows[0][0], 10) : -1;
        const corpsesCount = bCounts.rows.length ? parseInt(bCounts.rows[0][1], 10) : -1;
        checks.push(['b.roster_history/corpses populate automatically once a battle is active',
          rosterCount > 0 && corpsesCount >= 0,
          `roster_history=${rosterCount} corpses=${corpsesCount}`]);
        // The default rendering queries must actually be producing points
        // right now too - a real, non-vacuous proof that main.agent_states
        // JOIN b.roster_history (living) and b.corpses (dead) both resolve
        // correctly against the live schema, not just that the tables
        // themselves exist. Same "poll for genuine content" hazard as the
        // roster_history wait above applies here too, one tick further down
        // the pipeline: roster_history/corpses can be fully populated (the
        // whole-battle derive script doesn't depend on the cursor) while
        // CURRENT_TICK() is still sitting at the battle's very first tick,
        // before any agent has a recorded position row yet - confirmed
        // directly (a real fixture's agent_states can start several ticks
        // after the match's own boundary tick). Playback auto-advances
        // replayTime every RAF once RUNNING, so this converges to non-zero
        // quickly in practice; a one-shot snapshot right after the
        // roster_history poll would flake exactly like a one-shot snapshot
        // right at battle-activation would have, per that poll's own
        // comment.
        let renderSlotTotal = -1;
        {
          const pollDeadline = Date.now() + 8000;
          while (Date.now() < pollDeadline) {
            renderSlotTotal = latestFrame && latestFrame.renderSlots
              ? latestFrame.renderSlots.reduce((sum, s) => sum + s.count, 0) : -1;
            if (renderSlotTotal > 0) break;
            await new Promise((res) => setTimeout(res, 200));
          }
        }
        checks.push(['default rendering queries against b.roster_history/corpses produce live points',
          !!latestFrame && renderSlotTotal > 0,
          `renderSlotTotal=${renderSlotTotal} renderSlots=${latestFrame && latestFrame.renderSlots ? JSON.stringify(latestFrame.renderSlots.map((s) => s.count)) : 'n/a'}`]);
      }
    }

    // ---- 2. Panel visibility defaults (debug mode: chat + SQL terminal on, log/VFS off) ----
    checks.push(['chat visible by default', getComputedStyle(document.getElementById('chat-box')).display !== 'none']);
    checks.push(['SQL terminal visible by default in debug mode', getComputedStyle(document.getElementById('sql-terminal-panel')).display !== 'none']);
    checks.push(['system logs hidden by default', getComputedStyle(document.getElementById('log-box')).display === 'none']);
    checks.push(['VFS trace hidden by default', getComputedStyle(document.getElementById('debug-panel')).display === 'none']);

    // ---- 3. No overlap among default-visible chrome ----
    const hamburgerR = rectOf('hamburger-container');
    const chatR = rectOf('chat-box');
    const sqlR = rectOf('sql-terminal-panel');
    const timelineR = rectOf('timeline-container');
    checks.push(['hamburger does not overlap chat', !overlaps(hamburgerR, chatR)]);
    checks.push(['hamburger does not overlap SQL terminal', !overlaps(hamburgerR, sqlR)]);
    checks.push(['SQL terminal does not overlap timeline', !overlaps(sqlR, timelineR)]);
    checks.push(['chat does not overlap timeline', !overlaps(chatR, timelineR)]);

    // ---- 4. Hamburger menu open/close ----
    document.getElementById('hamburger-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const menuOpen = document.getElementById('main-menu').classList.contains('open');
    checks.push(['hamburger menu opens on click', menuOpen]);
    document.getElementById('canvas').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const menuClosed = !document.getElementById('main-menu').classList.contains('open');
    checks.push(['hamburger menu closes on outside click', menuClosed]);

    // ---- 5. Panel visibility checkboxes (menu must be open to interact - reopen) ----
    document.getElementById('hamburger-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    function setCheckbox(id, checked) {
      const el = document.getElementById(id);
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setCheckbox('panel-toggle-log-box', true);
    checks.push(['checking System Logs checkbox shows the panel', getComputedStyle(document.getElementById('log-box')).display !== 'none']);
    setCheckbox('panel-toggle-log-box', false);
    checks.push(['unchecking System Logs checkbox hides the panel', getComputedStyle(document.getElementById('log-box')).display === 'none']);
    setCheckbox('panel-toggle-debug-panel', true);
    checks.push(['checking VFS Trace checkbox shows the panel', getComputedStyle(document.getElementById('debug-panel')).display !== 'none']);
    setCheckbox('panel-toggle-debug-panel', false);
    checks.push(['unchecking VFS Trace checkbox hides the panel', getComputedStyle(document.getElementById('debug-panel')).display === 'none']);
    setCheckbox('panel-toggle-sql-terminal-panel', false);
    checks.push(['unchecking SQL Terminal checkbox hides the panel', getComputedStyle(document.getElementById('sql-terminal-panel')).display === 'none']);
    setCheckbox('panel-toggle-sql-terminal-panel', true); // restore default
    checks.push(['re-checking SQL Terminal checkbox restores it', getComputedStyle(document.getElementById('sql-terminal-panel')).display !== 'none']);

    // ---- 6. Dragging moves a panel and does NOT toggle minimize ----
    const wasMinBefore = document.getElementById('chat-box').classList.contains('minimized');
    const chatBeforeDrag = rectOf('chat-box');
    dragPanel('chat-box', 120, 60);
    const chatAfterDrag = rectOf('chat-box');
    const actuallyMoved = chatAfterDrag.left !== chatBeforeDrag.left || chatAfterDrag.top !== chatBeforeDrag.top;
    checks.push(['dragging the chat header moves the panel', actuallyMoved,
      `before=(${chatBeforeDrag.left},${chatBeforeDrag.top}) after=(${chatAfterDrag.left},${chatAfterDrag.top})`]);
    checks.push(['dragging does not toggle minimize',
      document.getElementById('chat-box').classList.contains('minimized') === wasMinBefore]);

    // ---- 7. A plain click (no movement) still toggles minimize ----
    clickPanelHeader('chat-box');
    const minimizedAfterClick = document.getElementById('chat-box').classList.contains('minimized');
    checks.push(['a plain click on the header still toggles minimize', minimizedAfterClick !== wasMinBefore]);
    if (minimizedAfterClick !== wasMinBefore) clickPanelHeader('chat-box'); // restore

    // ---- 8. Drag clamping keeps the panel on-screen ----
    dragPanel('sql-terminal-panel', -5000, -5000);
    const clampedTL = rectOf('sql-terminal-panel');
    checks.push(['dragging past the top-left edge clamps within the viewport', clampedTL.left >= 0 && clampedTL.top >= 0,
      `left=${clampedTL.left} top=${clampedTL.top}`]);
    dragPanel('sql-terminal-panel', 5000, 5000);
    const clampedBR = rectOf('sql-terminal-panel');
    checks.push(['dragging past the bottom-right edge clamps within the viewport',
      clampedBR.right <= window.innerWidth + 1 && clampedBR.top <= window.innerHeight,
      `right=${clampedBR.right} top=${clampedBR.top} viewport=${window.innerWidth}x${window.innerHeight}`]);

    // ---- 8b. Panel window chrome: every panel starts un-minimized, and the
    // maximize button (main.js's toggleMaximize) - between minimize and
    // close, same left-to-right ordering as a real OS window. Two real bugs
    // found and fixed by hand while building this: (1) a resize-handle
    // (main.js's makeResizable appends them AFTER the header, so with no
    // z-index of its own the header lost to them in paint order wherever
    // the 'n'/'ne'/'nw' hit-zones overlap it) sat on top of the header's own
    // icons, showing the resize cursor and swallowing clicks meant for
    // minimize/maximize/close; (2) the FIRST fix attempt for "don't let a
    // maximized panel be dragged" bailed out of the drag state machine too
    // early, which also silently broke "plain click toggles minimize" for a
    // maximized panel, since that's implemented as a special case of the
    // SAME mousedown/mousemove/mouseup chain, not a separate listener. ----
    {
      const ALL_PANEL_IDS = ['log-box', 'debug-panel', 'sql-terminal-panel', 'schema-explorer-panel', 'render-queries-panel', 'sql-docs-panel'];
      const stillMinimized = ALL_PANEL_IDS.filter((id) => document.getElementById(id).classList.contains('minimized'));
      checks.push(['every panel starts un-minimized (not collapsed to just its header bar) the first time it opens',
        stillMinimized.length === 0, `still minimized: ${stillMinimized.join(', ') || 'none'}`]);

      const mPanel = document.getElementById('sql-docs-panel');
      setPanelVisible('sql-docs-panel', true);
      mPanel.classList.remove('minimized'); // in case an earlier check left it collapsed
      const mHeader = mPanel.querySelector(':scope > .panel-header');
      const toggleIcon = mPanel.querySelector('.toggle-icon');
      const maxBtn = mPanel.querySelector('.panel-maximize-btn');
      const closeBtn = mPanel.querySelector('.panel-close-btn');

      // Ordering: minimize, then maximize, then close, left to right.
      const controlsOrder = Array.from(mPanel.querySelector('.panel-header-controls').children).map((c) => c.className);
      checks.push(['the maximize button sits between the minimize toggle and the close button in the header',
        controlsOrder.indexOf('toggle-icon') < controlsOrder.indexOf('panel-maximize-btn') &&
          controlsOrder.indexOf('panel-maximize-btn') < controlsOrder.indexOf('panel-close-btn'),
        controlsOrder.join(' | ')]);

      // Regression: a resize-handle intercepting hover/clicks meant for the
      // header's own icons (checked via elementFromPoint - the real
      // top-of-stack element at that exact pixel, not just "does the icon
      // exist in the DOM somewhere").
      function topElementAt(el) {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      }
      checks.push(['no resize-handle sits on top of the minimize toggle - it is the real element hit-tested at its own position',
        topElementAt(toggleIcon) === toggleIcon]);
      checks.push(['no resize-handle sits on top of the maximize button - it is the real element hit-tested at its own position',
        topElementAt(maxBtn) === maxBtn]);
      checks.push(['the minimize toggle and maximize button show a pointer cursor, not the inherited move/resize cursor',
        getComputedStyle(toggleIcon).cursor === 'pointer' && getComputedStyle(maxBtn).cursor === 'pointer']);

      const rectBefore = mPanel.getBoundingClientRect();
      // The panel's true "home" is whatever INLINE top/left/right/bottom/
      // width it has right now (likely all empty - sql-docs-panel has never
      // been dragged - meaning main.css's own top/right/width rule governs)
      // - NOT rectBefore's computed pixel values. Reconstructing "home" from
      // computed pixels further down would set an inline left+width WHILE
      // main.css's own right:20px rule is still separately in effect (an
      // inline style only overrides its OWN property, never a different one
      // - clearing inline .style.right to '' does NOT suppress the
      // stylesheet's right:20px), over-constraining the box and rendering
      // it somewhere neither fullscreen nor actually at rectBefore. Saving
      // the real inline strings (even if empty) and restoring exactly those
      // is what main.js's own transitionPanel does too - mirroring it here
      // avoids the same trap.
      const homeInlineRect = { top: mPanel.style.top, left: mPanel.style.left, right: mPanel.style.right, bottom: mPanel.style.bottom, width: mPanel.style.width };
      function resetToHome() {
        mPanel.classList.remove('minimized', 'maximized');
        mPanel.style.top = homeInlineRect.top;
        mPanel.style.left = homeInlineRect.left;
        mPanel.style.right = homeInlineRect.right;
        mPanel.style.bottom = homeInlineRect.bottom;
        mPanel.style.width = homeInlineRect.width;
        mContent.style.minHeight = '';
        mContent.style.maxHeight = '';
        mContent.style.height = '';
        mContent.style.paddingTop = '';
        mContent.style.paddingBottom = '';
      }
      // The exact 10-transition minimize/maximize state machine the user
      // specified, verified transition-by-transition. Each state is
      // {mode, restoreMode} - restoreMode only meaningful while minimized
      // or maximized - and both buttons share one rule: clicking a mode's
      // own button while already in it restores restoreMode (or 'normal');
      // clicking it from elsewhere enters that mode, remembering whatever
      // is being left (main.js's transitionPanel). The rect only actually
      // moves at the two moments fullscreen-ness changes - NOT on every
      // minimize/maximize click - which is what makes "minimize while
      // maximized, then maximize again" land back on the SAME full-width
      // collapsed header instead of the small pre-maximize rect (the exact
      // "big square"/lost-header-size regression hand-reported and fixed).
      const mContent = mPanel.querySelector(':scope > .panel-content');
      function clickMin() {
        const r = mHeader.getBoundingClientRect();
        mHeader.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 50, clientY: r.top + 10, button: 0 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 50, clientY: r.top + 10 }));
      }
      function clickMax() { maxBtn.click(); }
      function isFullscreen() {
        const r = mPanel.getBoundingClientRect();
        return Math.abs(r.left - 10) <= 1 && Math.abs(r.top - 10) <= 1 && Math.abs((window.innerWidth - r.right) - 10) <= 1;
      }
      function atHomeRect() {
        const r = mPanel.getBoundingClientRect();
        return Math.abs(r.top - rectBefore.top) <= 1 && Math.abs(r.left - rectBefore.left) <= 1 && Math.abs(r.width - rectBefore.width) <= 1;
      }
      function assertState(label, transitionId, expectMode, expectFullscreen) {
        const mode = mPanel.classList.contains('minimized') ? 'minimized' : mPanel.classList.contains('maximized') ? 'maximized' : 'normal';
        const fullscreen = isFullscreen();
        const home = atHomeRect();
        const rectOk = fullscreen ? expectFullscreen : (!expectFullscreen && home); // never a third, ambiguous rect
        const contentOk = mode === 'minimized' ? mContent.offsetHeight === 0
          : mode === 'maximized' ? mContent.offsetHeight > 174 // fills fullscreen, not the plain 174px default
          : mContent.offsetHeight > 0;
        // The PANEL's own box (not just its content) must actually shrink
        // to just the header while minimized, regardless of which span
        // family it's borrowing its width from - a real, hand-reported bug
        // this check exists specifically to catch: a stale bottom:10px left
        // over from a prior maximize kept the panel's own box pinned to the
        // bottom of the screen even after its content collapsed, leaving a
        // big empty square below the header instead of the header
        // collapsing down to meet it ("minimize while maximized shows a
        // big square instead of hiding the content").
        const panelHeight = mPanel.getBoundingClientRect().height;
        const headerHeight = mHeader.getBoundingClientRect().height;
        const panelHeightOk = mode === 'minimized' ? panelHeight <= headerHeight + 4
          : mode === 'maximized' ? panelHeight > window.innerHeight - 40
          : true; // 'normal' height varies with content-resize history - not asserted here
        checks.push([`${transitionId}: ${label}`,
          mode === expectMode && rectOk && contentOk && panelHeightOk,
          `mode=${mode} fullscreen=${fullscreen} home=${home} contentOffsetHeight=${mContent.offsetHeight} panelHeight=${Math.round(panelHeight)} headerHeight=${Math.round(headerHeight)}`]);
      }

      // Sub-walk A: normal -T6-> minimized(normal) -T1-> maximized(minimized)
      // -T9-> minimized(maximized) -T4-> maximized(minimized) -T7->
      // minimized(maximized) -T2-> maximized(minimized).
      clickMin();
      assertState('normal + minimize -> minimized(previously normal)', 'T6', 'minimized', false);
      clickMax();
      assertState('minimized(normal) + maximize -> maximized(previously minimized)', 'T1', 'maximized', true);
      clickMin();
      assertState('maximized(minimized) + minimize -> minimized(previously maximized), rect STAYS fullscreen', 'T9', 'minimized', true);
      clickMin();
      assertState('minimized(maximized) + minimize -> maximized(previously minimized), rect STAYS fullscreen', 'T4', 'maximized', true);
      clickMax();
      assertState('maximized(minimized) + maximize -> minimized(previously maximized), rect STAYS fullscreen', 'T7', 'minimized', true);
      clickMax();
      assertState('minimized(maximized) + maximize -> maximized(previously minimized), rect STAYS fullscreen', 'T2', 'maximized', true);

      // Sub-walk A's OWN longer history (T9 freshly re-enters 'minimized'
      // from 'maximized', overwriting what minimize's own restore-memory
      // held since T6) is what makes plain 'normal' unreachable from here
      // via clicks alone - a real, correct consequence of the user's most
      // recent minimize/maximize action legitimately superseding an older
      // one, not a general limitation of the whole state machine. Sub-walk C
      // below proves the general case: the SAME "minimize, then maximize"
      // 2-click opening (T6 -> T1) escapes back to plain 'normal' just fine
      // via 2 more clicks, AS LONG AS nothing after T1 does what T9 does
      // here (freshly re-enter minimized FROM maximized, which is a
      // deliberate, separate action, not an accident of clicking either
      // button "too many times").
      resetToHome();

      // Sub-walk B: normal -T6-> minimized(normal) -T3-> normal -T5->
      // maximized(normal) -T8-> normal -T5-> maximized(normal) -T10->
      // minimized(maximized), rect STAYS fullscreen (does NOT restore the
      // small pre-maximize rect) - the exact scenario from the hand-caught
      // "minimize in maximized mode shows a big square instead of hiding
      // the content" report.
      clickMin();
      assertState('normal + minimize -> minimized(previously normal) [repeat of T6]', 'T6', 'minimized', false);
      clickMin();
      assertState('minimized(normal) + minimize -> plain normal, home rect restored', 'T3', 'normal', false);
      clickMax();
      assertState('normal + maximize -> maximized(previously normal)', 'T5', 'maximized', true);
      clickMax();
      assertState('maximized(normal) + maximize -> plain normal, home rect restored', 'T8', 'normal', false);
      clickMax();
      assertState('normal + maximize -> maximized(previously normal) [repeat of T5]', 'T5', 'maximized', true);
      clickMin();
      assertState('maximized(normal) + minimize -> minimized(previously maximized), rect STAYS fullscreen (not the home rect)', 'T10', 'minimized', true);

      // Regression: dragging a "minimized, remembers maximized" header bar
      // to a new spot must sever that memory, so de-minimizing afterward
      // lands on plain 'normal' AT THE DRAGGED POSITION - not back on the
      // fullscreen rect the drag just moved away from. Hand-reported as
      // "you can move the header and then click minimize to de-minimize,
      // causing one to enter a bugged maximized mode" - transitionPanel
      // trusts the remembered mode, not the actual rendered rect, so
      // without main.js's makeDraggable clearing panelRestoreMode/
      // panelSavedRect on a real drag of a minimized panel, de-minimizing
      // would restore 'maximized' (the stale memory) while the panel's own
      // span still sat wherever it was just dragged to - a broken hybrid,
      // neither the drag target nor a real maximized rect.
      {
        const hr2 = mHeader.getBoundingClientRect();
        mHeader.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: hr2.left + 80, clientY: hr2.top + 10, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: hr2.left + 80, clientY: hr2.top + 200 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: hr2.left + 80, clientY: hr2.top + 200 }));
        const rectAfterDragWhileMinimized = mPanel.getBoundingClientRect();
        clickMin();
        const rectAfterDeminimize = mPanel.getBoundingClientRect();
        checks.push(['dragging a minimized(remembers maximized) header, then de-minimizing, lands on plain normal at the dragged spot',
          !mPanel.classList.contains('minimized') && !mPanel.classList.contains('maximized') &&
            Math.abs(rectAfterDeminimize.top - rectAfterDragWhileMinimized.top) <= 1 &&
            Math.abs(rectAfterDeminimize.left - rectAfterDragWhileMinimized.left) <= 1 &&
            mContent.offsetHeight > 0 && mContent.offsetHeight < 200, // plain default size, not fullscreen-filled
          `draggedTo=${JSON.stringify({ top: rectAfterDragWhileMinimized.top, left: rectAfterDragWhileMinimized.left })} afterDeminimize=${JSON.stringify({ top: rectAfterDeminimize.top, left: rectAfterDeminimize.left })} contentOffsetHeight=${mContent.offsetHeight}`]);
      }

      // Regression: dragging a genuinely MAXIMIZED (content-visible,
      // fullscreen) panel's header now un-maximizes it first, at its
      // CURRENT (fullscreen) footprint, then follows the cursor - not a
      // no-op, and not a snap back to the small pre-maximize rect. Run last
      // in this section (not folded into the T1-T10 walk above) since it
      // deliberately changes main.js's panelResizedHeight for this content
      // element to the fullscreen height, which would otherwise pollute
      // every later 'normal'-mode content-size check in the walk.
      {
        resetToHome();
        clickMax();
        const rectWhileMax = mPanel.getBoundingClientRect();
        const contentHeightWhileMax = mContent.getBoundingClientRect().height;
        const hr3 = mHeader.getBoundingClientRect();
        mHeader.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: hr3.left + 80, clientY: hr3.top + 10, button: 0 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: hr3.left + 80, clientY: hr3.top + 90, button: 0 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: hr3.left + 80, clientY: hr3.top + 90 }));
        const rectAfterDragWhileMax = mPanel.getBoundingClientRect();
        const contentHeightAfterDragWhileMax = mContent.getBoundingClientRect().height;
        checks.push(['dragging a MAXIMIZED panel un-maximizes it and follows the cursor, preserving its current (fullscreen) dimensions',
          !mPanel.classList.contains('maximized') && !mPanel.classList.contains('minimized') &&
            rectAfterDragWhileMax.top > rectWhileMax.top && // actually moved, not a no-op
            Math.abs(rectAfterDragWhileMax.width - rectWhileMax.width) <= 2 && // width preserved from the fullscreen moment
            Math.abs(contentHeightAfterDragWhileMax - contentHeightWhileMax) <= 2, // content height preserved too, not reset to the plain default
          `whileMax=${JSON.stringify({ top: rectWhileMax.top, width: Math.round(rectWhileMax.width), contentH: Math.round(contentHeightWhileMax) })} afterDrag=${JSON.stringify({ top: rectAfterDragWhileMax.top, width: Math.round(rectAfterDragWhileMax.width), contentH: Math.round(contentHeightAfterDragWhileMax) })}`]);
      }

      // Clean up for later sections.
      resetToHome();

      setPanelVisible('sql-docs-panel', false);
    }

    // ---- 9. OPFS graceful-shutdown race (regression: fast reset->reload used
    // to be able to throw NoModificationAllowedError - see gracefulTerminateWorker
    // in main.js) - several rapid iterations, each must reach RUNNING clean. ----
    let resetRaceOk = true;
    let resetRaceDetail = '';
    for (let i = 0; i < 4; i++) {
      capturedAlerts = [];
      currentSimulationState = null;
      triggerReset();
      startReplayLoad(freshFile());
      const ok = await waitFor(() => currentSimulationState === 'RUNNING' || capturedAlerts.length > 0, 15000);
      if (!ok || capturedAlerts.length > 0) {
        resetRaceOk = false;
        resetRaceDetail = `iteration ${i}: ok=${ok} alerts=${JSON.stringify(capturedAlerts)}`;
        break;
      }
    }
    checks.push(['rapid reset->reload cycles never hit an OPFS handle race', resetRaceOk, resetRaceDetail]);

    // ---- 10. Prefetch-worker readiness race (regression: schedulePrefetch()
    // used to fire from the per-frame handler before the prefetch worker's
    // own bootstrap finished - see prefetchWorkerReady in main.js) - load,
    // then let real playback run long enough for many frame messages to
    // fire, which is exactly the race window. ----
    capturedLogLines = [];
    capturedAlerts = [];
    currentSimulationState = null;
    triggerReset();
    startReplayLoad(freshFile());
    const prefetchLoadOk = await waitFor(() => currentSimulationState === 'RUNNING' || capturedAlerts.length > 0, 15000);
    checks.push(['load before the prefetch-race check reaches RUNNING', prefetchLoadOk && capturedAlerts.length === 0,
      `simState=${currentSimulationState} alerts=${JSON.stringify(capturedAlerts)}`]);
    await new Promise((r) => setTimeout(r, 2000));
    const prefetchErrors = capturedLogLines.filter((l) => l.includes('Prefetch Worker Error'));
    checks.push(['no prefetch-worker race during real playback', prefetchErrors.length === 0, prefetchErrors.join(' | ')]);

    // ---- 11. Export -> reload round trip (never triggers a real download -
    // see finishExportDownload override below, matching this project's
    // standing "never trigger real save dialogs during automated tests" rule) ----
    const activeOk = await waitFor(() => latestFrame && latestFrame.activeMatchIndex >= 0, 10000);
    checks.push(['a battle becomes active during playback', activeOk]);
    if (activeOk) {
      let exportedBytes = null;
      const origFinish = finishExportDownload;
      finishExportDownload = (bytes) => { exportedBytes = bytes; resetExportButton(); };
      exportActiveBattle();
      const exported = await waitFor(() => exportedBytes !== null, 20000);
      checks.push(['export battle produces bytes', exported, exported ? `${exportedBytes.length} bytes` : `capturedAlerts=${JSON.stringify(capturedAlerts)}`]);
      finishExportDownload = origFinish;

      if (exported) {
        capturedAlerts = [];
        currentSimulationState = null;
        triggerReset();
        startBattleFileLoad(new File([exportedBytes], 'exported_battle_test.tar.xz'));
        const reloadOk = await waitFor(() => currentSimulationState === 'RUNNING' || capturedAlerts.length > 0, 20000);
        checks.push(['loading the exported battle back in reaches RUNNING', reloadOk && capturedAlerts.length === 0,
          `simState=${currentSimulationState} alerts=${JSON.stringify(capturedAlerts)}`]);
      }
    }

    // ---- 12. Memory-budgeted eviction: force a tiny budget and scrub across
    // several battles - primedBattles must stay small (eviction happening)
    // while the active battle is always ready (correctness preserved).
    // Needs a real multi-battle fixture (testdata/replays_batch/, gitignored
    // real player data) - skips gracefully if it isn't present locally
    // rather than failing the whole suite on a missing optional asset. ----
    const evictionFixture = 'testdata/replays_batch/replayLog_2026-07-22_23-18-29.sqlite';
    const evictionRes = await fetch(evictionFixture);
    if (evictionRes.ok) {
      const evictionBuf = await evictionRes.arrayBuffer();
      currentSimulationState = null;
      triggerReset();
      startReplayLoad(new File([evictionBuf], 'eviction_test.sqlite'));
      const evictionLoadOk = await waitFor(() => currentSimulationState === 'RUNNING', 30000);
      checks.push(['eviction fixture loads (multi-battle)', evictionLoadOk, `matches=${matches.length}`]);

      if (evictionLoadOk && matches.length >= 3) {
        // Aggressive tiny budget - small enough that keeping more than a
        // couple of battles' indexes warm at once should be impossible.
        playbackWorker.postMessage({ type: 'setPrimingBudget', bytes: 256 * 1024 });
        await new Promise((r) => setTimeout(r, 200)); // let the setter message land before scrubbing

        // Setting replayTime directly (not calling seekTo()) sidesteps a
        // real race: seekTo() only posts a 'frame' request if
        // !pendingFrameRequest, and the render loop's own continuous 60fps
        // frame requests mean that gate can already be held at any given
        // instant - a seekTo() call landing then would silently no-op. The
        // render loop reads whatever replayTime currently is on its own
        // next tick regardless, so this always takes effect.
        let maxPrimedSeen = 0;
        let activeAlwaysReady = true;
        let failDetail = '';
        const stepCount = Math.min(matches.length, 8);
        for (let i = 0; i < stepCount; i++) {
          replayTime = (matches[i].startTime + matches[i].endTime) / 2;
          await new Promise((r) => setTimeout(r, 400)); // several render-loop ticks + a frame round-trip + schedulePriming's follow-up
          maxPrimedSeen = Math.max(maxPrimedSeen, primedBattles.size);
          let active = latestFrame ? latestFrame.activeMatchIndex : -1;
          if (active >= 0 && !primedBattles.has(active)) {
            // replay_ensure_battle_ready() runs synchronously inside the
            // SAME 'frame' message that reports activeMatchIndex, so there's
            // no architectural gap where this should legitimately be false
            // once things have settled - confirmed by a much more aggressive
            // standalone stress pass (3 rounds x 13 battles at 120ms/step,
            // tighter than here) finding zero such gaps outside the cold-
            // start window. What IS legitimate: right after a fresh load,
            // this same playbackWorker connection is also racing the initial
            // reader-fan-out AND prefetch worker's own concurrent OPFS I/O
            // (all real, all genuinely competing for the same file) - a
            // direct diagnostic confirmed this can stretch the FIRST
            // self-heal build's own round trip to ~2.4-3s during that
            // startup burst (30-poll/300ms trace: primedBattles stayed
            // empty through poll 6 at ~2.6s, appeared at poll 7 at ~2.9s),
            // then stays comfortably sub-second for every battle after -
            // a one-time cold-start cost, not a recurring one. Polling with
            // real margin above that observed worst case (instead of one
            // fixed-length re-check) gives genuine cold-start settling room
            // to finish while still failing outright on a real, non-
            // transient violation.
            const graceDeadline = Date.now() + 5000;
            while (Date.now() < graceDeadline) {
              await new Promise((r) => setTimeout(r, 200));
              active = latestFrame ? latestFrame.activeMatchIndex : -1;
              if (active < 0 || primedBattles.has(active)) break;
            }
            if (active >= 0 && !primedBattles.has(active)) {
              activeAlwaysReady = false;
              failDetail = `iter=${i} seekTarget=${i} active=${active} primedBattles=[${[...primedBattles].sort((a,b)=>a-b).join(',')}] declinedPrimingBattles=[${[...declinedPrimingBattles].sort((a,b)=>a-b).join(',')}] primingInFlight=${primingInFlight} pendingFrameRequest=${pendingFrameRequest}`;
            }
          }
        }
        checks.push(['eviction keeps primedBattles bounded under a tiny budget', maxPrimedSeen <= 4,
          `maxPrimedSeen=${maxPrimedSeen} totalMatches=${matches.length}`]);
        checks.push(['the active battle is always ready even under eviction pressure', activeAlwaysReady, failDetail]);
      }

      // ---- 13. The other half of the same feature, and the one that was
      // actually broken: with a REALISTIC (not artificially tiny) budget,
      // the engine should aggressively use available memory rather than
      // stopping after a couple of battles. Regression coverage for a real
      // bug - computePrimingBudgetBytes() originally mirrored
      // computeReaderCount()/computeDictSizeMiB()'s small navigator.
      // deviceMemory tiers (16-128MiB), capped there because deviceMemory
      // itself caps at reporting "8" for ANY device with 8GB+ of RAM - so a
      // 64GB desktop and an 8GB one both got the identical, needlessly tiny
      // 128MiB ceiling, nowhere close to "use all available memory". Direct
      // manual testing against this exact fixture confirmed it: capped at
      // 128MiB, priming plateaued well short of all 13 battles. ----
      if (evictionLoadOk && matches.length >= 3) {
        currentSimulationState = null;
        triggerReset();
        startReplayLoad(new File([evictionBuf], 'default_budget_test.sqlite'));
        const reloadOk = await waitFor(() => currentSimulationState === 'RUNNING', 30000);
        checks.push(['default-budget fixture reload reaches RUNNING', reloadOk]);

        if (reloadOk) {
          // Real, uncapped default - whatever main.js's 'loaded' handler
          // actually sent (computePrimingBudgetBytes()), not overridden.
          // Sequential single-writer CREATE INDEX per battle is genuinely
          // not instant against a 164MB file - give it real time to work
          // through all of them rather than judging on an early snapshot
          // (which is exactly how this bug first looked "not working" under
          // casual inspection before the deeper investigation here).
          const gotAllPrimed = await waitFor(() => primedBattles.size >= matches.length, 25000);
          const heapDebug = await new Promise((resolve) => {
            const h = playbackWorker.onmessage;
            playbackWorker.onmessage = (e) => {
              if (e.data && e.data.type === 'heapDebug') { playbackWorker.onmessage = h; resolve(e.data); return; }
              h(e);
            };
            playbackWorker.postMessage({ type: 'heapDebug' });
          });
          const maskPopcount = (() => {
            let n = 0, m = heapDebug.battleReadyMask;
            while (m) { n += m & 1; m >>= 1; }
            return n;
          })();
          checks.push(['default budget primes every battle in a real multi-battle file, not just a couple',
            gotAllPrimed, `primed=${primedBattles.size}/${matches.length} playbackHeapBytes=${heapDebug.playbackHeapBytes}`]);
          checks.push(['JS-side primedBattles agrees with the C-side readyMask (readyMask sync is accurate)',
            maskPopcount === primedBattles.size, `maskPopcount=${maskPopcount} primedBattles.size=${primedBattles.size}`]);

          // ---- 13b. Roster/corpse summary cache (replay_export.c's
          // g_rc_cache, populated by replay_prewarm_battle_summary and
          // scheduleSummaryPrewarm in main.js) - proactive pre-warming
          // actually happens during idle time, once agent_states priming
          // above has caught up and stops competing for the same idle slot
          // (see battlePrimed's "fair alternation" comment in main.js).
          // Under a REALISTIC/uncapped budget, not the artificially tiny one
          // - both share g_priming_budget_bytes, and 12's own tiny-budget
          // test already established that agent_states priming alone can
          // legitimately consume the entire tiny budget, correctly leaving
          // zero room for anything else (see 13c below for that case). ----
          if (gotAllPrimed) {
            const gotSomeCached = await waitFor(() => cachedSummaryBattles.size > 0, 15000);
            checks.push(['proactive summary pre-warming populates the cache during idle time',
              gotSomeCached,
              `cachedSummaryBattles=[${[...cachedSummaryBattles].sort((a, b) => a - b).join(',')}]`]);
          }
        }
      }

      // ---- 13c. Same cache, under the tight budget from 12: must decline
      // gracefully (no crash/hang, no unbounded growth) rather than force
      // its way past budget - and regardless, the ACTIVE/cursor battle's
      // summary must always be obtainable on demand, since
      // insert_battledb_roster_corpse_from_cache's compute-on-miss fallback
      // (replay_export.c) has no budget gate at all - that's the actual
      // "ensure there is always memory available to load the battle under
      // the cursor" guarantee for this cache, not "the cache is never empty
      // under pressure" (12 already showed agent_states priming alone can
      // legitimately claim an entire tiny budget). ----
      if (evictionLoadOk && matches.length >= 3) {
        currentSimulationState = null;
        triggerReset();
        startReplayLoad(new File([evictionBuf], 'summary_cache_test.sqlite'));
        const summaryReloadOk = await waitFor(() => currentSimulationState === 'RUNNING', 30000);
        checks.push(['summary-cache test fixture reload reaches RUNNING', summaryReloadOk]);

        if (summaryReloadOk) {
          playbackWorker.postMessage({ type: 'setPrimingBudget', bytes: 256 * 1024 });
          await new Promise((r) => setTimeout(r, 200));

          const stepCount2 = Math.min(matches.length, 6);
          for (let i = 0; i < stepCount2; i++) {
            replayTime = (matches[i].startTime + matches[i].endTime) / 2;
            await new Promise((r) => setTimeout(r, 400));
          }
          checks.push(['summary cache stays bounded (never exceeds total battle count) under a tight budget',
            cachedSummaryBattles.size <= matches.length,
            `cachedSummaryBattles.size=${cachedSummaryBattles.size} totalMatches=${matches.length}`]);

          const activeIdx = latestFrame ? latestFrame.activeMatchIndex : -1;
          let activeSummaryOk = false;
          let activeSummaryDetail = '';
          if (activeIdx >= 0) {
            let attachErr = 'none';
            const attachOk = await ensureDbViewAsync(2).then(() => true).catch((e) => { attachErr = (e && (e.message || e.toString())); return false; }); // 2 = battle.db (b)
            if (attachOk) {
              const summaryRows = await runSchemaQueryAsync(
                "SELECT roster_json IS NOT NULL, corpses_json IS NOT NULL FROM b.roster_corpse_final");
              activeSummaryOk = summaryRows.rows.length === 1 &&
                summaryRows.rows[0][0] === '1' && summaryRows.rows[0][1] === '1';
              activeSummaryDetail = `attachOk=${attachOk} rows=${JSON.stringify(summaryRows.rows)}`;
            } else {
              activeSummaryDetail = `attachOk=${attachOk} attachErr=${attachErr}`;
            }
          }
          checks.push(["the active/cursor battle's roster/corpse summary is always obtainable, even under a tight budget",
            activeIdx >= 0 && activeSummaryOk,
            `activeIdx=${activeIdx} ${activeSummaryDetail}`]);
        }
      }
    }

    // ---- 14. computePrimingBudgetBytes() itself: verify the tiering logic
    // directly (not just its downstream effect) by overriding
    // navigator.deviceMemory - the low tiers should stay conservative (real
    // constrained-device protection), the high/undefined tier should be
    // generous (most of the real 2GiB WASM_MEMORY_MAX_PAGES ceiling, not a
    // small fixed guess), confirming the fix actually changed the right
    // thing rather than coincidentally passing check 13 above. ----
    {
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory')
        || Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
      function withDeviceMemory(value, fn) {
        Object.defineProperty(navigator, 'deviceMemory', { value, configurable: true });
        try { return fn(); } finally {
          if (desc) Object.defineProperty(navigator, 'deviceMemory', desc);
          else delete navigator.deviceMemory;
        }
      }
      const budget1 = withDeviceMemory(1, () => computePrimingBudgetBytes());
      const budget8 = withDeviceMemory(8, () => computePrimingBudgetBytes());
      const budgetUndef = withDeviceMemory(undefined, () => computePrimingBudgetBytes());
      checks.push(['constrained devices (deviceMemory<=1) still get a small, safe budget',
        budget1 > 0 && budget1 <= 256 * 1024 * 1024, `budget1=${budget1}`]);
      checks.push(['capable devices (deviceMemory=8, or undefined on Firefox/Safari) get a generous budget, not a tiny fixed one',
        budget8 >= 1024 * 1024 * 1024 && budgetUndef >= 1024 * 1024 * 1024,
        `budget8=${budget8} budgetUndef=${budgetUndef}`]);
      checks.push(['budget scales up monotonically with more deviceMemory', budget1 < budget8]);
    }

    // ---- 15. Multi-database SQL terminal: DB selector + smart caching,
    // schema explorer, variable functions, live editing, editable generator
    // scripts, real tokenizer (syntax highlighting + autocomplete). Fresh,
    // self-contained fixture load here - evictionBuf/evictionLoadOk above
    // are block-scoped and out of reach at this point in the file. ----
    // task #68: SQL Terminal windows are multi-instance now, resolved via
    // panel.closest('[data-panel-type="sql-terminal-panel"]') from whatever
    // element was clicked/typed in - passing `panel` itself works fine
    // (Element.closest() checks the element itself first), same as a real
    // click on that window's own controls would resolve.
    const panel = document.getElementById('sql-terminal-panel');
    function runSqlSync(sql) {
      panel.querySelector('.sql-terminal-input').value = sql;
      sqlTerminalRun(panel);
    }
    function waitForSqlDone() {
      return waitFor(() => !panel.querySelector('.sql-terminal-status').innerText.includes('Running'), 10000);
    }

    {
      const sqlFixtureUrl = 'testdata/replays_batch/replayLog_2026-07-22_23-18-29.sqlite';
      const sqlFixtureRes = await fetch(sqlFixtureUrl);
      if (sqlFixtureRes.ok) {
        const sqlFixtureBuf = await sqlFixtureRes.arrayBuffer();
        currentSimulationState = null;
        triggerReset();
        startReplayLoad(new File([sqlFixtureBuf], 'sql_terminal_test.sqlite'));
        const loadOk = await waitFor(() => currentSimulationState === 'RUNNING', 30000);
        checks.push(['SQL terminal test fixture loads', loadOk, `matches=${matches.length}`]);

        if (loadOk && matches.length >= 2) {
          panel.classList.remove('minimized');

          // 15a. Tokenizer edge cases - pure, synchronous, no app state needed.
          // The tokenizer is exactly the kind of component that's easy to get
          // subtly wrong on edge cases, so these check real lexical behavior
          // directly, not just "highlighting looks right in a screenshot".
          checks.push(['tokenizer: doubled single-quote escape inside a string',
            tokenizeSQL("SELECT 'it''s'").some((t) => t.type === 'string' && t.text === "'it''s'")]);
          checks.push(['tokenizer: doubled double-quote escape inside a quoted identifier',
            tokenizeSQL('SELECT "a""b"').some((t) => t.type === 'quoted_identifier' && t.text === '"a""b"')]);
          checks.push(['tokenizer: doubled backtick escape inside a backtick identifier',
            tokenizeSQL('SELECT `a``b`').some((t) => t.type === 'quoted_identifier' && t.text === '`a``b`')]);
          checks.push(['tokenizer: bracket-form quoted identifier (no escape, stops at first ])',
            tokenizeSQL('SELECT [my col]').some((t) => t.type === 'quoted_identifier' && t.text === '[my col]')]);
          checks.push(['tokenizer: blob literal x\'...\'',
            tokenizeSQL("SELECT x'0011FF'").some((t) => t.type === 'blob' && t.text === "x'0011FF'")]);
          checks.push(['tokenizer: line comment stops at the newline, does not consume it',
            tokenizeSQL('SELECT 1 -- c\nFROM t').some((t) => t.type === 'comment' && t.text === '-- c')]);
          checks.push(['tokenizer: block comment spans multiple lines',
            tokenizeSQL('SELECT /* a\nb */ 1').some((t) => t.type === 'comment' && t.text === '/* a\nb */')]);
          checks.push(['tokenizer: keyword matching is case-insensitive',
            tokenizeSQL('select From wHeRe').filter((t) => t.type !== 'whitespace').every((t) => t.type === 'keyword')]);
          checks.push(['tokenizer: numeric literals (int/decimal/leading-dot/scientific/hex)',
            JSON.stringify(tokenizeSQL('1 1.5 .5 1e10 1.5e-3 0x1F').filter((t) => t.type === 'number').map((t) => t.text))
              === JSON.stringify(['1', '1.5', '.5', '1e10', '1.5e-3', '0x1F'])]);

          // 15b. Variable functions - values must match known JS-side state,
          // not just "the query didn't error".
          const currentMatch = matches[latestFrame ? latestFrame.activeMatchIndex : 0];
          runSqlSync('SELECT CURRENT_BATTLE_TICK_START(), CURRENT_BATTLE_TICK_END()');
          await waitForSqlDone();
          const tickRangeRow = panel.querySelector('.sql-terminal-results tbody tr');
          const tickRangeOk = !!(tickRangeRow && currentMatch &&
            parseInt(tickRangeRow.children[0].textContent, 10) === currentMatch.startTickId &&
            parseInt(tickRangeRow.children[1].textContent, 10) === currentMatch.endTickId);
          checks.push(['CURRENT_BATTLE_TICK_START()/END() match the active battle',
            tickRangeOk, `row=${tickRangeRow ? tickRangeRow.textContent : null} expected=${currentMatch ? currentMatch.startTickId + '/' + currentMatch.endTickId : null}`]);

          // 15c. DB selector: switch to Replay DB, a bare table name auto-
          // qualifies to r.<table>.
          const dbSelect = panel.querySelector('.sql-terminal-db-select');
          const dbStatus = panel.querySelector('.sql-terminal-db-status');
          dbSelect.value = 'replay';
          sqlTerminalDbChanged(dbSelect);
          const dbReadyOk = await waitFor(() => {
            const t = dbStatus.innerText;
            return t.includes('ready') || t.includes('rebuilt');
          }, 15000);
          checks.push(['DB selector attaches Replay DB on demand', dbReadyOk, dbStatus.innerText]);

          if (dbReadyOk) {
            runSqlSync('SELECT count(*) FROM agent_states'); // bare name, should target r.agent_states
            // Longer budget than the shared waitForSqlDone()'s 10s: this
            // query runs against the replay DB view that was JUST attached
            // above, whose own populate step is a real multi-statement
            // generator script over a 2M+-row source table - genuinely
            // slower than an ordinary query, and this dev box shares CPU
            // with other unrelated tooling on top of that (same "generous,
            // not tight" reasoning as the Playwright suites use).
            const statusEl = panel.querySelector('.sql-terminal-status');
            await waitFor(() => !statusEl.innerText.includes('Running') && !statusEl.innerText.includes('Queued'), 30000);
            const replayCountOk = statusEl.innerText.includes('1 row');
            checks.push(['bare table name auto-qualifies to the selected non-main schema',
              replayCountOk, statusEl.innerText]);

            // 15d. Smart caching: re-selecting the SAME db/battle with
            // nothing changed must NOT report a rebuild - this is the actual
            // proof "don't regenerate everything" holds, not an assumption.
            dbSelect.value = 'main';
            sqlTerminalDbChanged(dbSelect);
            await new Promise((r) => setTimeout(r, 300));
            dbSelect.value = 'replay';
            sqlTerminalDbChanged(dbSelect);
            const reselectOk = await waitFor(() => dbStatus.innerText.includes('ready'), 10000);
            checks.push(['re-selecting an unchanged DB view reuses it instead of rebuilding',
              reselectOk, dbStatus.innerText]);
          }

          // 15e. Schema explorer reflects real attached schemas dynamically.
          const schemaPanel = document.getElementById('schema-explorer-panel');
          schemaPanel.querySelector('.schema-explorer-filter').value = 'all';
          await refreshSchemaExplorerPanel(schemaPanel);
          const treeText = schemaPanel.querySelector('.schema-explorer-tree').textContent;
          checks.push(['schema explorer shows both main and the attached replay.db schema',
            treeText.includes('Main (main)') && treeText.includes('Replay DB (r)') && treeText.includes('agent_states'),
            treeText.slice(0, 200)]);

          // 15e2. A refresh patches the tree in place instead of wiping and
          // rebuilding it (the actual "flickers and resets on every SQL
          // run" bug report) - expand/collapse state, scroll position, and
          // even the exact DOM node identity of an expanded table and the
          // generator-script editor's own textarea must all survive a
          // refresh unchanged, not just look the same afterward.
          // Still display:none (never shown via setPanelVisible up to this
          // point in the suite) AND minimized (max-height:0) - anything
          // inside a display:none ancestor has zero layout regardless of
          // the minimized class, so scrollTop could never stick without
          // both of these.
          schemaPanel.style.display = 'flex';
          schemaPanel.classList.remove('minimized');
          await new Promise((r) => setTimeout(r, 250)); // past the minimize/unminimize max-height CSS transition (main.css: 0.2s)
          const agentStatesNode = schemaPanel.querySelector('.schema-tree-schema[data-schema-name="main"] .schema-tree-table[data-table-name="agent_states"]');
          agentStatesNode.querySelector('.schema-tree-header').click(); // expand it
          agentStatesNode.__regressionMarker = 'ORIGINAL_TABLE_NODE';
          const genTaForMarker = schemaPanel.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
          genTaForMarker.__regressionMarker = 'ORIGINAL_GENTA_NODE';
          const scrollTarget = schemaPanel.querySelector('.panel-content');
          scrollTarget.scrollTop = 30;
          await refreshSchemaExplorerPanel(schemaPanel);
          const agentStatesAfter = schemaPanel.querySelector('.schema-tree-schema[data-schema-name="main"] .schema-tree-table[data-table-name="agent_states"]');
          const genTaAfter = schemaPanel.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
          const smartUpdateOk = agentStatesAfter.__regressionMarker === 'ORIGINAL_TABLE_NODE' &&
            !agentStatesAfter.classList.contains('collapsed') &&
            genTaAfter.__regressionMarker === 'ORIGINAL_GENTA_NODE' &&
            scrollTarget.scrollTop === 30;
          checks.push(['a schema explorer refresh patches the tree in place - same DOM nodes, expand state, and scroll position survive, not wiped and rebuilt',
            smartUpdateOk,
            `sameTableNode=${agentStatesAfter.__regressionMarker === 'ORIGINAL_TABLE_NODE'} stillExpanded=${!agentStatesAfter.classList.contains('collapsed')} sameGenTaNode=${genTaAfter.__regressionMarker === 'ORIGINAL_GENTA_NODE'} scrollTop=${scrollTarget.scrollTop}`]);

          // 15f. Generator script default text is real, parameter-free SQL.
          const defaultSql = await getDefaultGeneratorSqlAsync(1);
          checks.push(['replay.db generator script default text uses the parameter-free variable functions',
            defaultSql.includes('CURRENT_BATTLE_TICK_START()') && defaultSql.includes('CURRENT_BATTLE_ROWID_LO()')]);

          // 15g. Live editing: an UPDATE against main is reflected on an
          // immediate re-read - no caching at the "main" level at all.
          dbSelect.value = 'main';
          sqlTerminalDbChanged(dbSelect);
          runSqlSync('UPDATE agent_states SET pos_x = 54321 WHERE id = (SELECT id FROM agent_states LIMIT 1)');
          await waitForSqlDone();
          runSqlSync('SELECT pos_x FROM agent_states WHERE id = (SELECT id FROM agent_states LIMIT 1)');
          await waitForSqlDone();
          const liveEditOk = panel.querySelector('.sql-terminal-results').innerText.includes('54321');
          checks.push(['a live UPDATE against main is reflected on an immediate re-read', liveEditOk,
            panel.querySelector('.sql-terminal-results').innerText]);

          // 15g2. task: "add data modification ability directly to SQL
          // results" - editing a cell directly in the main terminal's own
          // results table (not just the separate pop-out viewer) marks it
          // dirty, and Save changes writes a real UPDATE back to the source
          // table (verified by reading the value back through a fresh query,
          // not just trusting the DOM).
          runSqlSync('SELECT * FROM agent_states ORDER BY id LIMIT 5');
          await waitForSqlDone();
          const editTable = panel.querySelector('.sql-terminal-results table');
          const posXHeaderIdx = Array.from(editTable.querySelectorAll('thead th')).findIndex((th) => th.textContent === 'pos_x');
          const editRow = editTable.querySelectorAll('tbody tr')[1]; // id=2 - distinct from 15g's own id=1 edit above
          const editRowid = editRow.dataset.rowid;
          const editCell = editRow.children[posXHeaderIdx];
          editCell.textContent = '13131.5';
          editCell.dispatchEvent(new Event('input', { bubbles: true }));
          const cellMarkedDirty = editCell.classList.contains('cell-dirty');
          const saveBtn = panel.querySelector('.sql-terminal-save-btn');
          const saveBtnShownWhenEligible = getComputedStyle(saveBtn).display !== 'none';
          saveBtn.click();
          await waitFor(() => /\d+ row\(s\)/.test(panel.querySelector('.sql-terminal-status').innerText), 10000);
          runSqlSync(`SELECT pos_x FROM agent_states WHERE rowid = ${editRowid}`);
          await waitForSqlDone();
          const editReadback = panel.querySelector('.sql-terminal-results table').querySelector('tbody tr td').textContent;
          checks.push(['editing a cell directly in the SQL Terminal results table and clicking Save changes writes a real UPDATE back to the table',
            cellMarkedDirty && saveBtnShownWhenEligible && editReadback === '13131.5',
            `dirty=${cellMarkedDirty} saveBtnShown=${saveBtnShownWhenEligible} rowid=${editRowid} readback=${editReadback}`]);

          // 15g3. The x delete-row button marks a row for deletion; Save
          // changes issues a real DELETE and the row is genuinely gone on
          // re-fetch, not just visually hidden.
          runSqlSync('SELECT * FROM agent_states ORDER BY id LIMIT 5');
          await waitForSqlDone();
          const delTable = panel.querySelector('.sql-terminal-results table');
          const delRow = delTable.querySelectorAll('tbody tr')[2];
          const delRowid = delRow.dataset.rowid;
          delRow.querySelector('.results-row-delete button').click();
          const markedForDeletion = delRow.classList.contains('results-row-deleted');
          panel.querySelector('.sql-terminal-save-btn').click();
          await waitFor(() => /\d+ row\(s\)/.test(panel.querySelector('.sql-terminal-status').innerText), 10000);
          runSqlSync(`SELECT COUNT(*) FROM agent_states WHERE rowid = ${delRowid}`);
          await waitForSqlDone();
          const countReadback = panel.querySelector('.sql-terminal-results table').querySelector('tbody tr td').textContent;
          checks.push(["clicking a row's x delete button and Save changes issues a real DELETE, removing the row from the table",
            markedForDeletion && countReadback === '0',
            `marked=${markedForDeletion} countReadback=${countReadback}`]);

          // 15g4. The sticky results-table header must have an OPAQUE
          // background - the actual bug report ("headers...overlap with the
          // data...unreadable") was a translucent header letting scrolled-
          // under data rows show through it.
          const headerBg = getComputedStyle(panel.querySelector('.sql-terminal-results th')).backgroundColor;
          const headerAlphaMatch = headerBg.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
          const headerIsOpaque = !headerAlphaMatch || parseFloat(headerAlphaMatch[1]) === 1;
          checks.push(['SQL results table header has an opaque background so it does not overlap unreadably with scrolled data',
            headerIsOpaque, `backgroundColor=${headerBg}`]);

          // 15h. Autocomplete suggests a real table name after a partial prefix.
          // (task #68 follow-up: autocomplete state now lives on panel.sqlEditor,
          // not panel.sqlState - generalized so the same machinery also drives
          // generator-script editors, see 15k below.)
          await ensureKnownSchemasBootstrapped();
          const ta = panel.querySelector('.sql-terminal-input');
          ta.value = 'SELECT * FROM agent_st';
          ta.focus();
          ta.selectionStart = ta.selectionEnd = ta.value.length;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 150));
          const ac = panel.sqlEditor.autocomplete;
          const suggestionsOk = ac.active && ac.items.some((i) => i.text === 'agent_states');
          checks.push(['autocomplete suggests a real table name after a partial prefix', suggestionsOk,
            JSON.stringify(ac.items.slice(0, 5))]);
          hideAutocomplete(panel.sqlEditor);

          // 15h2. The suggestion popup is a single shared, position:fixed
          // element floating above every window (not embedded inside
          // whichever panel is being edited) - the actual bug report this
          // exists to fix: editing a line near a panel's bottom edge used to
          // render the popup partly/fully clipped behind the panel's own
          // border, with nowhere to escape to. Pin the SQL Terminal so its
          // own top edge starts exactly at the bottom of the viewport - the
          // input (and caret) are then GUARANTEED off-screen below,
          // regardless of the panel's own internal layout height, so "stays
          // fully on-screen anyway" is only possible if positionAutocompleteList
          // actually flipped/clamped it back up - Emacs corfu-style - rather
          // than just placing it below the caret as it used to.
          panel.style.top = window.innerHeight + 'px';
          panel.style.bottom = 'auto';
          ta.value = 'SELECT * FROM agent_st';
          ta.focus();
          ta.selectionStart = ta.selectionEnd = ta.value.length;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 150));
          const floatingList = document.querySelector('.autocomplete-list');
          const listRect = floatingList.getBoundingClientRect();
          const taRect = ta.getBoundingClientRect();
          const isFixed = getComputedStyle(floatingList).position === 'fixed';
          const staysOnScreen = listRect.top >= 0 && listRect.bottom <= window.innerHeight;
          checks.push(['autocomplete popup is a shared floating element that stays fully on-screen even when the caret itself is off-screen below',
            isFixed && staysOnScreen,
            `position=${getComputedStyle(floatingList).position} listRect=${JSON.stringify(listRect)} taRect=${JSON.stringify(taRect)} viewportH=${window.innerHeight}`]);
          hideAutocomplete(panel.sqlEditor);
          panel.style.top = '';

          // 15i. Syntax highlighting renders real classified token spans.
          panel.querySelector('.sql-terminal-input').value = 'SELECT 1 -- comment';
          renderSqlHighlightInto(panel.querySelector('.sql-terminal-input'), panel.querySelector('.sql-terminal-highlight'));
          const highlightHtml = panel.querySelector('.sql-terminal-highlight').innerHTML;
          checks.push(['syntax highlighting renders classified token spans',
            highlightHtml.includes('tok-keyword') && highlightHtml.includes('tok-comment'), highlightHtml]);

          // 15j. task #68: a second, independent SQL Terminal window - opened
          // via the same mechanism the hamburger's "+" button uses - gets its
          // own state and doesn't interfere with the first's.
          const panel2 = openNewPanelInstance('sql-terminal-panel');
          const dbSelectsIndependent = panel2.sqlState !== panel.sqlState;
          panel2.querySelector('.sql-terminal-input').value = 'SELECT 999 AS marker';
          sqlTerminalRun(panel2);
          const panel2Done = await waitFor(() => !panel2.querySelector('.sql-terminal-status').innerText.includes('Running') &&
            !panel2.querySelector('.sql-terminal-status').innerText.includes('Queued'), 10000);
          const panel2Ok = panel2Done && panel2.querySelector('.sql-terminal-results').innerText.includes('999');
          const panel1Untouched = !panel.querySelector('.sql-terminal-results').innerText.includes('999 row');
          checks.push(['a second SQL Terminal window has independent state and completes its own query',
            dbSelectsIndependent && panel2Ok && panel1Untouched,
            `panel2 status=${panel2.querySelector('.sql-terminal-status').innerText}`]);
          closePanelInstance(panel2);
          const panel2Removed = !document.body.contains(panel2);
          checks.push(['closing a cloned panel instance removes it from the document', panel2Removed]);

          // 15j2. task: "when one pops out data it does have different style
          // than SQL terminal results - which is not acceptable as it
          // should be consistent - infact add data modification ability
          // directly to SQL results. Also the cursor placing in pop out
          // data is absurd..." - the pop-out Data Viewer renders through the
          // exact same buildResultsTableHead/buildResultsRow functions as
          // the main terminal's own results (not a separate textarea-based
          // widget), so the two are identical by construction: same header
          // background, same editable cells. No textarea exists at all
          // anymore - a <textarea>'s caret follows character offsets rather
          // than visual tab-stop columns, which is what caused "text is
          // rendered to the left while the cursor is placed to the right".
          runSqlSync('SELECT * FROM agent_states ORDER BY id LIMIT 5');
          await waitForSqlDone();
          const popOutBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Pop out data');
          popOutBtn.click();
          const viewerAppeared = await waitFor(() => !!document.querySelector('[data-panel-type="sql-data-viewer-panel"]'), 5000);
          const viewerPanel = viewerAppeared ? document.querySelector('[data-panel-type="sql-data-viewer-panel"]') : null;
          const viewerTableReady = viewerPanel && await waitFor(() => !!viewerPanel.querySelector('.sql-terminal-results table tbody tr'), 5000);
          const viewerTable = viewerTableReady ? viewerPanel.querySelector('.sql-terminal-results table') : null;
          const viewerHasNoTextarea = viewerPanel ? !viewerPanel.querySelector('textarea') : false;
          const viewerHeaderBg = viewerTable ? getComputedStyle(viewerTable.querySelector('th')).backgroundColor : '';
          const mainHeaderBg2 = getComputedStyle(panel.querySelector('.sql-terminal-results th')).backgroundColor;
          const viewerFirstCellEditable = viewerTable ? viewerTable.querySelector('tbody tr td').contentEditable === 'true' : false;
          const viewerHasDeleteBtn = viewerTable ? !!viewerTable.querySelector('.results-row-delete button') : false;
          checks.push(['pop-out Data Viewer renders the same editable table markup/style as the main SQL Terminal results, with no textarea',
            viewerTableReady && viewerHasNoTextarea && viewerFirstCellEditable && viewerHasDeleteBtn && viewerHeaderBg === mainHeaderBg2,
            `viewerTableReady=${viewerTableReady} noTextarea=${viewerHasNoTextarea} editable=${viewerFirstCellEditable} hasDeleteBtn=${viewerHasDeleteBtn} viewerBg=${viewerHeaderBg} mainBg=${mainHeaderBg2}`]);
          if (viewerPanel) closePanelInstance(viewerPanel);

          // 15k. Generator-script editors: autocomplete works there too
          // ("auto completion should work everywhere SQL can be edited"),
          // the schema explorer loads itself as soon as it's shown (no
          // Refresh click required), Ctrl+Enter runs the script from the
          // keyboard in BOTH the schema-explorer-embedded editor and the
          // pop-out, the pop-out has NO buttons at all (status/errors show
          // in an Emacs-style minibuffer instead, and it has no Reset
          // control - that stays exclusive to the compact widget), the
          // pop-out's editor genuinely fills and resizes with its window,
          // and popping one out keeps it live-synced with the embedded copy
          // in both directions.
          const schemaPanel2 = document.getElementById('schema-explorer-panel');
          schemaPanel2.classList.remove('minimized');
          schemaPanel2.querySelector('.schema-explorer-tree').innerHTML = '';
          setPanelVisible('schema-explorer-panel', true); // the real show path - must self-load, not require a manual Refresh click
          const autoLoadOk = await waitFor(() => {
            const t = schemaPanel2.querySelector('.schema-explorer-tree').textContent;
            return t.trim().length > 0 && t !== 'Loading...';
          }, 20000);
          checks.push(['schema explorer loads itself as soon as it is shown, without requiring a Refresh click', autoLoadOk,
            schemaPanel2.querySelector('.schema-explorer-tree').textContent.slice(0, 150)]);

          const rSchemaReady = await waitFor(
            () => Array.from(schemaPanel2.querySelectorAll('.schema-tree-schema > .schema-tree-header')).some((h) => h.textContent.includes('(r)')),
            20000
          );
          if (rSchemaReady) {
            const genTa = schemaPanel2.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
            genTa.value = 'SELECT * FROM agent_st';
            genTa.focus();
            genTa.selectionStart = genTa.selectionEnd = genTa.value.length;
            genTa.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 200));
            // The suggestion list is one shared, floating popup appended to
            // <body> (not scoped inside this editor's own wrap - see
            // ensureSharedAutocompleteList) so it can float above every
            // window regardless of which one summoned it.
            const genAcList = document.querySelector('.autocomplete-list');
            const genAcOk = genAcList && getComputedStyle(genAcList).display !== 'none' && genAcList.children.length > 0;
            checks.push(['autocomplete works in a generator-script editor, not just the main SQL Terminal', genAcOk,
              genAcList ? genAcList.innerHTML.slice(0, 200) : 'no autocomplete list found']);
            genTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise((r) => setTimeout(r, 100));

            // The compact widget keeps its Run/Reset/Open-in-window buttons -
            // only the pop-out drops them.
            const compactButtons = Array.from(schemaPanel2.querySelectorAll('.schema-tree-schema[data-schema-name="r"] .generator-script-editor button')).map((b) => b.textContent);
            checks.push(['compact schema-explorer editor keeps its Run/Reset/Open-in-window buttons',
              compactButtons.includes('Run') && compactButtons.includes('Reset to default') && compactButtons.includes('Open in window'),
              compactButtons.join(',')]);

            // Ctrl+Enter must run the script from the compact widget too, not
            // just via its Run button - a real dispatchEvent-built
            // KeyboardEvent carries ctrlKey correctly (unlike Selenium
            // ActionChains key_down, which doesn't - see the Ctrl+Scroll test
            // for that unrelated, already-fixed bug), so this is a genuine
            // check, not a false pass.
            genTa.value = 'SELECT * FROM agent_states LIMIT 1';
            genTa.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 100));
            const genStatus = schemaPanel2.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-status');
            genStatus.innerText = '';
            genTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
            const ctrlEnterRanInSchemaExplorer = await waitFor(() => genStatus.innerText.length > 0, 5000);
            checks.push(['Ctrl+Enter runs the generator script from the schema-explorer-embedded editor', ctrlEnterRanInSchemaExplorer,
              'status=' + genStatus.innerText]);

            // Running the script is itself a rebuild, which (onDbViewReady)
            // re-refreshes every visible Schema Explorer - including this
            // one, replacing its tree DOM wholesale. Give that cascade a
            // moment to settle, then re-query genTa fresh rather than reuse
            // the now-possibly-detached reference from above, so the
            // sync comparison below isn't racing a DOM replacement it
            // doesn't know happened.
            await new Promise((r) => setTimeout(r, 400));
            const genTaFresh = schemaPanel2.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
            const openInWindowBtn = Array.from(schemaPanel2.querySelectorAll('.schema-tree-schema[data-schema-name="r"] .generator-script-editor button'))
              .find((b) => b.textContent === 'Open in window');
            openInWindowBtn.click();
            await new Promise((r) => setTimeout(r, 300));
            const popoutPanel = document.querySelector('[data-panel-type="generator-script-popout-panel"]');
            const popoutTa = popoutPanel.querySelector('.generator-popout-textarea');
            const popoutStartedSynced = !!popoutTa && popoutTa.value === genTaFresh.value;

            // The pop-out is a dedicated UI, not the compact widget copied
            // verbatim - its own editor-wrap/minibuffer DOM shape, and ZERO
            // buttons anywhere in the panel (no Run, no Reset - the header's
            // close/minimize controls are plain <span>s, not <button>s).
            const hasDedicatedLayout = !!popoutPanel.querySelector('.generator-popout-editor-wrap') &&
              !!popoutPanel.querySelector('.generator-popout-minibuffer') &&
              !popoutPanel.querySelector('.generator-script-editor');
            const popoutButtonCount = popoutPanel.querySelectorAll('button').length;
            checks.push(['pop-out generator script window has its own dedicated editor UI with no buttons at all, not the compact widget copied verbatim',
              hasDedicatedLayout && popoutButtonCount === 0,
              `dedicatedLayout=${hasDedicatedLayout} buttonCount=${popoutButtonCount}`]);

            // The editor must genuinely fill the window and track a live
            // resize (a real Firefox-only bug found after this redesign
            // first shipped: equal min/max-height on .panel-content pins its
            // own box fine in every browser, but isn't a "definite" height
            // for a percentage-height CHILD to resolve against per spec -
            // Chrome resolved it anyway, Firefox didn't - fixed by also
            // setting an explicit content.style.height inline, see
            // makeResizable/toggleMinimize).
            const contentBefore = popoutPanel.querySelector('.panel-content').getBoundingClientRect();
            const taBefore = popoutTa.getBoundingClientRect();
            const fillsBeforeResize = taBefore.height > contentBefore.height * 0.7;
            // Direction-agnostic: dragging the SE handle toward the
            // viewport's bottom-right SHOULD grow the panel, but this suite
            // runs after many other panels/windows have already been
            // opened, so a headless window of unknown size may leave this
            // pop-out spawned near an edge where growth gets clamped and it
            // shrinks instead - already independently confirmed (real
            // Firefox, manual test) that growth-on-resize works; what this
            // check actually needs to prove is that the editor keeps
            // tracking the window's real size in EITHER direction, not that
            // a specific drag always grows it.
            const seHandle = popoutPanel.querySelector('.resize-handle.se');
            const hr = seHandle.getBoundingClientRect();
            const sx = hr.left + hr.width / 2, sy = hr.top + hr.height / 2;
            fireMouse(seHandle, 'mousedown', sx, sy);
            fireMouse(window, 'mousemove', sx + 120, sy + 150);
            fireMouse(window, 'mousemove', sx + 120, sy + 150);
            fireMouse(window, 'mouseup', sx + 120, sy + 150);
            const contentAfter = popoutPanel.querySelector('.panel-content').getBoundingClientRect();
            const taAfter = popoutTa.getBoundingClientRect();
            const sizeTracked = Math.abs(contentAfter.height - contentBefore.height) > 20 &&
              Math.abs(taAfter.height - taBefore.height) > 20;
            const fillsAfterResize = taAfter.height > contentAfter.height * 0.7;
            checks.push(['pop-out editor fills its window and resizes along with it (both before and after a live resize drag)',
              fillsBeforeResize && sizeTracked && fillsAfterResize,
              `before: content=${contentBefore.height} ta=${taBefore.height} | after: content=${contentAfter.height} ta=${taAfter.height}`]);

            popoutTa.value = popoutTa.value + '\n-- synced from popout';
            popoutTa.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 300));
            const genTaAfterPopoutEdit = schemaPanel2.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
            const embeddedGotPopoutEdit = genTaAfterPopoutEdit.value.includes('-- synced from popout');

            genTaAfterPopoutEdit.value = genTaAfterPopoutEdit.value + '\n-- synced from embedded';
            genTaAfterPopoutEdit.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 300));
            const popoutGotEmbeddedEdit = popoutTa.value.includes('-- synced from embedded');

            checks.push(['popping out a generator script starts synced and stays synced in both directions',
              popoutStartedSynced && embeddedGotPopoutEdit && popoutGotEmbeddedEdit,
              `startedSynced=${popoutStartedSynced} embeddedGotEdit=${embeddedGotPopoutEdit} popoutGotEdit=${popoutGotEmbeddedEdit}`]);

            // Ctrl+Enter must run the script from the pop-out too - its ONLY
            // way to run, since it has no Run button.
            const popoutMinibuffer = popoutPanel.querySelector('.generator-popout-minibuffer');
            popoutMinibuffer.innerText = '';
            popoutTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
            const ctrlEnterRanInPopout = await waitFor(() => popoutMinibuffer.innerText.length > 0, 5000);
            checks.push(['Ctrl+Enter runs the generator script from the pop-out window (its only way to run, having no buttons)',
              ctrlEnterRanInPopout, 'minibuffer=' + popoutMinibuffer.innerText]);

            popoutPanel.querySelector('.panel-close-btn').click();
            await new Promise((r) => setTimeout(r, 200));
            const popoutClosed = !document.querySelector('[data-panel-type="generator-script-popout-panel"]');
            checks.push(['closing a popped-out generator script window removes it and leaves the embedded one working', popoutClosed]);
          } else {
            checks.push(['autocomplete works in a generator-script editor, not just the main SQL Terminal', false, 'r schema never attached in time']);
          }
        }
      }
    }

    // ---- 16. Chat: a pure "visualization of a SQL query" (chats/events
    // tables, gated by CURRENT_TICK()/CURRENT_BATTLE_TICK_START()), not an
    // append-only feed driven by frame events - the actual bug report this
    // exists to fix: scrubbing back past a chat message's tick and then
    // forward again used to re-deliver it a second time, because the old
    // mechanism was a monotonic, advance-only cursor with no way to know
    // playback had rewound. Reuses the still-loaded SQL terminal fixture
    // (matches[0] is a real match in it - real chat messages included). ----
    if (matches.length > 0) {
      const playBtn = document.getElementById('tl-play-btn');
      if (playBtn && playBtn.innerText === 'Pause') playBtn.click(); // pause - deterministic seeking needs playback to hold still

      async function seekAndSettle(t) {
        const start = Date.now();
        let landed = null;
        while (Date.now() - start < 10000) {
          seekTo(t);
          await new Promise((r) => setTimeout(r, 150));
          if (latestFrame && latestFrame.activeMatchIndex === 0) { landed = latestFrame; break; }
        }
        await new Promise((r) => setTimeout(r, 1000)); // let refreshChatFromQuery's async round-trip finish
        return landed;
      }
      function chatWrapEl() { return document.querySelector('#chat-box .panel-content > .panel-zoom-wrap'); }
      function chatMessageDivCount() { const wrap = chatWrapEl(); return wrap ? wrap.children.length : 0; }

      const chatDbSelect = panel.querySelector('.sql-terminal-db-select');
      chatDbSelect.value = 'main';
      sqlTerminalDbChanged(chatDbSelect);
      runSqlSync(
        'SELECT c.event_id, e.tick_id, t.time FROM chats c JOIN events e ON c.event_id = e.id ' +
        'JOIN ticks t ON t.id = e.tick_id ' +
        `WHERE e.tick_id >= ${matches[0].startTickId} AND e.tick_id <= ${matches[0].endTickId} ` +
        'ORDER BY e.id ASC LIMIT 1'
      );
      await waitForSqlDone();
      const firstChatText = panel.querySelector('.sql-terminal-results').innerText;
      const chatRow = firstChatText.split('\n')[1]; // header line, then one data line if found
      checks.push(['chat regression fixture has at least one real chat message in the first match', !!chatRow, firstChatText]);

      if (chatRow) {
        // event_id captured directly from the chat row itself, NOT
        // re-derived from tick_id alone - a tick can carry several events
        // (spawn/kill/chat all share the same events table), so "the first
        // event at this tick" is not reliably the chat event.
        const [msgEventId, , msgTime] = chatRow.split('\t').map(Number);
        const before = Math.max(matches[0].startTime + 0.5, msgTime - 3);
        const after = msgTime + 3;

        // 16a. Before the message's tick: chat shows the empty-state
        // placeholder, not a blank box (a genuinely empty box "reads as
        // broken" - the other half of this same bug report).
        const beforeFrame = await seekAndSettle(before);
        const emptyStateText = chatWrapEl() ? chatWrapEl().textContent : '';
        checks.push(['chat shows a placeholder instead of a blank box before any message is due',
          !!beforeFrame && emptyStateText.includes('No chat messages yet'), emptyStateText]);

        // 16b. Seek past the message once - it appears exactly once.
        await seekAndSettle(after);
        const countAfterFirstPass = chatMessageDivCount();

        // 16c. Scrub BACK before it again, then FORWARD past it again - the
        // actual reported bug: this used to duplicate the message.
        await seekAndSettle(before);
        await seekAndSettle(after);
        const countAfterRescrub = chatMessageDivCount();
        checks.push(['scrubbing back before a chat message and forward past it again does not duplicate it',
          countAfterFirstPass === 1 && countAfterRescrub === 1,
          `countAfterFirstPass=${countAfterFirstPass} countAfterRescrub=${countAfterRescrub}`]);

        // 16d. Editing the chats table directly via the SQL Terminal shows
        // up in the chat box on the next refresh - chat reads the live
        // table, not a stale snapshot cached at match-activation time.
        const marker = 'REGRESSION_TEST_MARKER_' + Date.now();
        runSqlSync(`UPDATE chats SET message = '${marker}' WHERE event_id = ${msgEventId}`);
        await waitForSqlDone();
        // Nudge the tick so refreshChatFromQuery's gate key actually
        // changes (it only re-queries when activeMatchIndex/currentTickId
        // change, by design - an edit alone with no playback movement has
        // nothing to gate on).
        await seekAndSettle(after + 2);
        const textAfterEdit = chatWrapEl() ? chatWrapEl().textContent : '';
        checks.push(['editing the chats table via the SQL Terminal shows up in the chat box on the next refresh',
          textAfterEdit.includes(marker), textAfterEdit]);
      }
    }

    // ---- 17. Checkpoints (global selection, #0 = initial state by
    // default, integrated with the replay engine) + generator-script line
    // numbers + SQL error line/char reporting. Reuses the still-loaded SQL
    // terminal fixture and its `panel`/runSqlSync/waitForSqlDone. Ordered
    // deliberately: the disruptive action (17e's checkpoint revert, which
    // detaches r/b server-side and kicks off its own background schema
    // refresh) runs LAST, so nothing else has to coordinate around its
    // side effects - confirmed directly that chaining a fresh generator-
    // script run immediately after a revert races real dbView-attach state
    // ("database r is already in use") purely from stacking too many rapid
    // actions with no natural pacing between them, not a genuine bug (this
    // exact error-reporting path was already manually verified working
    // correctly earlier in the same session, in isolation). ----
    if (matches.length > 0) {
      checks.push(['checkpoint #0 (the initial state) exists automatically once a database is loaded',
        knownCheckpointIds.includes(0) && currentCheckpointId !== null,
        `knownCheckpointIds=${JSON.stringify(knownCheckpointIds)} currentCheckpointId=${currentCheckpointId}`]);

      const sqlCkSelect = panel.querySelector('.sql-terminal-checkpoints');
      checks.push(['the SQL Terminal checkpoint dropdown shows "#0 (initial state)"',
        Array.from(sqlCkSelect.options).some((o) => o.value === '0' && o.textContent.includes('initial state')),
        Array.from(sqlCkSelect.options).map((o) => o.textContent).join(',')]);

      // 17b. Line-number gutters (the "internal schema sql editor" - the
      // compact widget embedded in the Schema Explorer) - line count in the
      // gutter must track the textarea's own line count exactly.
      await ensureDbViewAsync(1).catch(() => {});
      const schemaPanel3 = document.getElementById('schema-explorer-panel');
      schemaPanel3.style.display = 'flex';
      schemaPanel3.classList.remove('minimized');
      await refreshSchemaExplorerPanel(schemaPanel3);
      const rReady = await waitFor(
        () => !!schemaPanel3.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea'),
        20000
      );
      if (rReady) {
        const genTa2 = schemaPanel3.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
        const gutter2 = schemaPanel3.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-gutter');
        genTa2.value = 'SELECT 1;\nSELECT 2;\nSELECT 3;\nSELECT 4;';
        genTa2.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        const gutterLines = gutter2.textContent.split('\n').filter((l) => l.length > 0);
        checks.push(['the embedded generator-script editor\'s line-number gutter tracks its textarea\'s line count',
          gutterLines.length === 4 && gutterLines.join(',') === '1,2,3,4',
          `gutterText=${JSON.stringify(gutter2.textContent)}`]);

        // 17c. SQL error line/char reporting - a genuine syntax error must
        // surface "(line N, char M)" (sqlite3_error_offset-backed, "if
        // possible" - see main.js's formatSqlErrorMessage).
        await waitFor(() => !dbViewPending[1] && !dbViewInFlight[1], 20000);
        genTa2.value = 'SELECT 1;\nSELECT * FROM WHERE WHERE id = 1;';
        genTa2.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        const runBtn2 = Array.from(schemaPanel3.querySelectorAll('.schema-tree-schema[data-schema-name="r"] .generator-script-editor button'))
          .find((b) => b.textContent === 'Run');
        runBtn2.click();
        const statusEl2 = schemaPanel3.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-status');
        await waitFor(() => statusEl2.innerText.startsWith('Error'), 10000);
        checks.push(['a genuine SQL syntax error in a generator script reports "(line N, char M)"',
          /line \d+, char \d+/.test(statusEl2.innerText), statusEl2.innerText]);
      } else {
        checks.push(['the embedded generator-script editor\'s line-number gutter tracks its textarea\'s line count', false, 'r schema editor never appeared']);
        checks.push(['a genuine SQL syntax error in a generator script reports "(line N, char M)"', false, 'r schema editor never appeared']);
      }

      // 17d. Same line/char reporting in the main SQL Terminal's own input
      // (not just generator scripts) - a distinct code path
      // (runSqlIntoResultsTable's onError), worth its own direct check.
      await waitFor(() => !activeSqlRequest && sqlRequestQueue.length === 0, 20000);
      runSqlSync('SELECT * FROM\nagent_states WHERE WHERE id = 1');
      await waitForSqlDone();
      const terminalErrText = panel.querySelector('.sql-terminal-status').innerText;
      checks.push(['a genuine SQL syntax error in the main SQL Terminal input reports "(line N, char M)"',
        /line 2, char \d+/.test(terminalErrText), terminalErrText]);

      // 17f. Multi-statement error offset - a syntax error well past the
      // first statement must still report ITS OWN line, not line 1.
      // Regression for the actual bug report: exec_sql (replay_export.c)
      // used to run generator scripts through sqlite3_exec(), which
      // re-invokes sqlite3_prepare_v2() from wherever the PREVIOUS
      // statement's own parsing left off for each subsequent one -
      // sqlite3_error_offset() then returns an offset relative to THAT
      // statement's own start, not the original script's, so anything past
      // the first statement misreported as "line 1". Deliberately run here,
      // before 17e's own checkpoint revert below (which detaches r/b
      // server-side and kicks off its own background schema refresh) -
      // see this section's own opening comment on why the disruptive
      // action runs last.
      await waitFor(() => !dbViewPending[1] && !dbViewInFlight[1], 20000);
      const schemaPanel4 = document.getElementById('schema-explorer-panel');
      await refreshSchemaExplorerPanel(schemaPanel4);
      await waitFor(() => !!schemaPanel4.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea'), 20000);
      const genTa3 = schemaPanel4.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
      if (genTa3) {
        const scriptLines = [];
        for (let i = 1; i <= 19; i++) scriptLines.push(`SELECT ${i};`);
        scriptLines.push('SELECT * FROM WHERE WHERE id = 1;'); // line 20, broken
        genTa3.value = scriptLines.join('\n');
        genTa3.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        const runBtn3 = Array.from(schemaPanel4.querySelectorAll('.schema-tree-schema[data-schema-name="r"] .generator-script-editor button'))
          .find((b) => b.textContent === 'Run');
        runBtn3.click();
        const statusEl3 = schemaPanel4.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-status');
        await waitFor(() => statusEl3.innerText.startsWith('Error'), 10000);
        checks.push(['a syntax error past the first statement in a multi-statement generator script reports its OWN line, not line 1',
          /line 20, char \d+/.test(statusEl3.innerText), statusEl3.innerText]);
      } else {
        checks.push(['a syntax error past the first statement in a multi-statement generator script reports its OWN line, not line 1',
          false, 'r schema editor not available']);
      }

      // 17e. Save/revert round trip - a value edited after checkpoint #0
      // must come back exactly once reverted to it (the actual "checkpoint
      // #0 = initial state" guarantee, not just that a dropdown entry
      // exists). Run LAST in this section - see its own module comment
      // above. The highest real id in the table, not a guessed literal -
      // 15g's own "live UPDATE" check already edits the LOWEST id earlier in
      // this same run, and checkpoint #0 predates THAT edit too (created
      // once, at load time, before section 15 even starts) - reverting to
      // #0 would undo it as well, so comparing against a row captured
      // mid-run (post-15g, pre-this-test) wouldn't actually equal what #0
      // reverts it to. The highest id is real (guaranteed to exist) and far
      // from every low, small id other checks in this suite touch.
      runSqlSync('SELECT MAX(id) FROM agent_states');
      await waitForSqlDone();
      const targetId = panel.querySelector('.sql-terminal-results table').querySelector('tbody tr td').textContent;

      runSqlSync(`SELECT pos_x FROM agent_states WHERE id = ${targetId}`);
      await waitForSqlDone();
      const originalPosXText = panel.querySelector('.sql-terminal-results table').querySelector('tbody tr td').textContent;

      runSqlSync(`UPDATE agent_states SET pos_x = 55555.25 WHERE id = ${targetId}`);
      await waitForSqlDone();
      runSqlSync(`SELECT pos_x FROM agent_states WHERE id = ${targetId}`);
      await waitForSqlDone();
      const editedPosXText = panel.querySelector('.sql-terminal-results table').querySelector('tbody tr td').textContent;

      setCurrentCheckpoint('0');
      const revertDone = await new Promise((resolve) => {
        playbackWorker.addEventListener('message', function handler(e) {
          if (e.data.type === 'checkpointReverted' || e.data.type === 'checkpointError') {
            playbackWorker.removeEventListener('message', handler);
            resolve(e.data.type === 'checkpointReverted');
          }
        });
        checkpointRevert();
      });
      // checkpointReverted's own handler kicks off a schema-explorer refresh
      // (a whole chain of background schema/PRAGMA probes) as a side effect -
      // let the SQL request queue fully drain before posting anything else,
      // rather than racing it (background requests can't be preempted once
      // already active, only ones still queued - see postSqlRequest).
      await waitFor(() => !activeSqlRequest && sqlRequestQueue.length === 0, 20000);
      runSqlSync(`SELECT pos_x FROM agent_states WHERE id = ${targetId}`);
      await waitForSqlDone();
      const revertedStatusText = panel.querySelector('.sql-terminal-status').innerText;
      const revertedRow = panel.querySelector('.sql-terminal-results table')?.querySelector('tbody tr td');
      const revertedPosXText = revertedRow ? revertedRow.textContent : null;
      checks.push(['reverting to checkpoint #0 restores a value edited afterward to its true original state',
        revertDone && editedPosXText === '55555.25' && revertedPosXText === originalPosXText,
        `revertDone=${revertDone} targetId=${targetId} original=${originalPosXText} edited=${editedPosXText} reverted=${revertedPosXText} status=${revertedStatusText}`]);

      // 17g. The hamburger menu is a real participant in the same
      // click-to-front stacking system every .ui-panel uses (main.js's
      // panelZIndexCounter) - regression for it sitting at a fixed CSS
      // z-index (12) that a couple of ordinary panel clicks already climb
      // past, permanently burying the menu.
      const hamburger = document.getElementById('hamburger-container');
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const schemaPanel4b = document.getElementById('schema-explorer-panel');
      schemaPanel4b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      hamburger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const hamburgerOnTopAfterOwnClick = parseInt(hamburger.style.zIndex, 10) > parseInt(schemaPanel4b.style.zIndex, 10);
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const panelOnTopAfterItsOwnClick = parseInt(panel.style.zIndex, 10) > parseInt(hamburger.style.zIndex, 10);
      checks.push(['clicking the hamburger menu brings it to front, and clicking a panel afterward brings THAT to front again',
        hamburgerOnTopAfterOwnClick && panelOnTopAfterItsOwnClick,
        `hamburgerZ=${hamburger.style.zIndex} schemaZ=${schemaPanel4b.style.zIndex} panelZ=${panel.style.zIndex}`]);

      // ---- 18. SQL-driven battle-boundary detection (scan_matches_via_sql,
      // replacing the old hardcoded scan_matches() heuristic) - see section
      // 1b for the "b" schema coverage. ----
      checks.push(['matches[] is internally consistent (chronological, non-overlapping, start<=end)',
        matches.every((m, i) =>
          m.startTickId <= m.endTickId &&
          (i === 0 || matches[i - 1].endTickId < m.startTickId)),
        JSON.stringify(matches.map((m) => [m.startTickId, m.endTickId]))]);

      // ---- 19. Rendering Queries panel (Phase 5: SQL-driven rendering -
      // main.js's renderQueries/buildRenderQueryCard/refreshAllRenderQueryPanels,
      // replay_worker.c's RenderQuerySlot engine). "Duplicable window chrome,
      // globally shared underlying state", like Chat/System Logs, not SQL
      // Terminal - see this section's own tests near the end. ----
      {
        setPanelVisible('render-queries-panel', true);
        document.getElementById('panel-toggle-render-queries-panel').checked = true;
        const rqPanel = document.getElementById('render-queries-panel');
        const rqList = () => rqPanel.querySelector('.render-queries-list');

        checks.push(['Rendering Queries panel opens with the 3 default cards',
          rqList().querySelectorAll('.render-query-card').length === 3,
          JSON.stringify(Array.from(rqList().querySelectorAll('.render-query-name')).map((i) => i.value))]);

        checks.push(['default cards have the expected name/kind (Corpses/dots, Living Agents/dots, Chat/chat)',
          renderQueries.length === 3 &&
            renderQueries[0].name === 'Corpses' && renderQueries[0].kind === 'dots' &&
            renderQueries[1].name === 'Living Agents' && renderQueries[1].kind === 'dots' &&
            renderQueries[2].name === 'Chat' && renderQueries[2].kind === 'chat',
          JSON.stringify(renderQueries.map((q) => [q.name, q.kind]))]);

        // Pin playback to a known, stable mid-battle instant before the
        // live-data checks below - real autoplay has been running since a
        // much earlier section loaded its own fixture, so by this point in
        // a long sequential run the cursor could legitimately be anywhere,
        // including a gap between battles (activeMatchIndex < 0, both
        // render slots genuinely 0 - not a bug, just not useful for THESE
        // checks). Setting replayTime directly (not calling seekTo()) is
        // the same idiom section 13 already established - see that
        // section's own comment on why. isPaused=true on top of that stops
        // the render loop's own dt*playbackSpeed advance from drifting the
        // cursor back out of the match during the several-hundred-ms
        // round-trips the checks below need (confirmed as a real flake
        // without this: a short match's midpoint can play past the match's
        // own end before a 5s waitFor resolves, landing both render slots
        // back at a genuine, non-bug 0 mid-check). Restored after this
        // section so later sections see normal playback again.
        const wasPaused = isPaused;
        isPaused = true;
        replayTime = (matches[0].startTime + matches[0].endTime) / 2;
        await new Promise((r) => setTimeout(r, 400));
        const pinnedOk = await waitFor(() => latestFrame && latestFrame.activeMatchIndex === 0, 5000);
        checks.push(['playback cursor pins to the first match for the checks below',
          pinnedOk, `activeMatchIndex=${latestFrame ? latestFrame.activeMatchIndex : 'n/a'}`]);

        // 19a. Editing a query's SQL text live-updates the C engine, not
        // just the JS-side object - the whole point of
        // pushRenderQueriesToEngine. A LIMIT 1 rewrite of the Living Agents
        // query should collapse its live point count to exactly 1 - checked
        // against its ORIGINAL count too, so this can't pass vacuously if
        // the edit silently did nothing (the exact class of bug a past
        // "vacuous pass" test mistake in this same file let through once -
        // see section 1b's own comment on that).
        const livingCard = rqPanel.querySelector(`.render-query-card[data-query-id="${renderQueries[1].id}"]`);
        const livingTextarea = livingCard.querySelector('.render-query-textarea');
        const originalLivingSql = renderQueries[1].sql;
        const beforeEditCount = latestFrame && latestFrame.renderSlots ? latestFrame.renderSlots[1].count : -1;
        // row_key is required because this card's interpolate flag is still
        // true (only a directive-comment edit or the panel's own checkbox
        // changes it, neither of which this raw textarea edit touches) -
        // omitting it would make the C engine's interpolation LEFT JOIN wrap
        // fail to prepare (no such column: q.row_key), which reads as a
        // silent 0-row result exactly like the real trailing-semicolon bug
        // this session's own Phase 4 work found and fixed - see
        // replay_worker.c's build_query_text_for_slot.
        livingTextarea.value = "SELECT agent_id AS row_key, pos_x AS x, pos_y AS y, 1.0 AS color_r, 1.0 AS color_g, 1.0 AS color_b FROM main.agent_states WHERE tick_id = CURRENT_TICK() LIMIT 1;";
        livingTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        const editTookEffect = await waitFor(() =>
          latestFrame && latestFrame.renderSlots && latestFrame.renderSlots[1] && latestFrame.renderSlots[1].count === 1, 5000);
        checks.push(['editing a query\'s SQL text live-updates the rendered output (LIMIT 1 -> exactly 1 point)',
          editTookEffect && beforeEditCount !== 1,
          `beforeEditCount=${beforeEditCount} renderSlots=${latestFrame && latestFrame.renderSlots ? JSON.stringify(latestFrame.renderSlots.map((s) => s.count)) : 'n/a'} ` +
          `cardStatus=${JSON.stringify(livingCard.querySelector('.render-query-status').innerText)} activeMatchIndex=${latestFrame ? latestFrame.activeMatchIndex : 'n/a'}`]);
        livingTextarea.value = originalLivingSql;
        livingTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        await waitFor(() => latestFrame && latestFrame.renderSlots && latestFrame.renderSlots[1] && latestFrame.renderSlots[1].count !== 1, 5000);

        // 19b. Reordering changes draw order, i.e. the C engine's own slot
        // order - list order IS draw order, by construction
        // (replay_worker.c's build_frame_at_time).
        const corpsesId = renderQueries.find((q) => q.name === 'Corpses').id;
        moveRenderQuery(corpsesId, 1); // Corpses<->Living Agents swap
        const reorderTookEffect = await waitFor(() => renderQueries[0].name === 'Living Agents' &&
          latestFrame && latestFrame.renderSlots && latestFrame.renderSlots[0] && latestFrame.renderSlots[0].count > 0, 5000);
        checks.push(['drag-reordering the query list changes the live draw order (C engine slot order)',
          reorderTookEffect,
          `renderQueries=${JSON.stringify(renderQueries.map((q) => q.name))} renderSlots=${latestFrame ? JSON.stringify(latestFrame.renderSlots.map((s) => s.count)) : 'n/a'}`]);
        moveRenderQuery(corpsesId, -1); // swap back
        await waitFor(() => renderQueries[0].name === 'Corpses', 3000);

        // 19c. Add + delete update both the shared list and this panel's DOM.
        const beforeAddLen = renderQueries.length;
        addRenderQuery();
        const addedId = renderQueries[renderQueries.length - 1].id;
        checks.push(['Add Query appends a new card to both the list and the panel DOM',
          renderQueries.length === beforeAddLen + 1 &&
            rqList().querySelectorAll('.render-query-card').length === beforeAddLen + 1]);
        deleteRenderQuery(addedId);
        checks.push(['deleting a query removes it from both the list and the panel DOM',
          renderQueries.length === beforeAddLen &&
            rqList().querySelectorAll('.render-query-card').length === beforeAddLen]);

        // 19d. Reset to Defaults restores the original 3-entry list exactly.
        resetRenderQueriesToDefaults();
        checks.push(['Reset to Defaults restores the original 3-query default list',
          renderQueries.length === 3 && renderQueries.map((q) => q.name).join(',') === 'Corpses,Living Agents,Chat']);

        // 19e. A second Rendering Queries window mirrors the SAME shared
        // list rather than starting as an independent empty copy - "globally
        // shared underlying state", the same broadcast-panel model Chat/
        // System Logs already use (there's one GL canvas/one query list, so
        // per-window rendering config has no coherent meaning).
        openNewPanelInstance('render-queries-panel');
        const rqClones = document.querySelectorAll('[data-panel-type="render-queries-panel"]');
        checks.push(['a second Rendering Queries window mirrors the same shared query list',
          rqClones.length === 2 && rqClones[1].querySelectorAll('.render-query-card').length === 3,
          `cloneCount=${rqClones.length}`]);
        closePanelInstance(rqClones[1]);
        checks.push(['closing a cloned Rendering Queries window removes it and leaves the original working',
          document.querySelectorAll('[data-panel-type="render-queries-panel"]').length === 1 &&
            rqList().querySelectorAll('.render-query-card').length === 3]);

        isPaused = wasPaused; // restore - see this section's own comment on why it was pinned
      }

      // ---- 20. NATO APP-6 symbol kind (Phase 6: @KIND nato_symbol) - a
      // dom-overlay surface, entirely JS-only (main.js's map-symbol-layer/
      // NATO_UNIT_TYPE_MAP/updateNatoSymbolLayer), never reaching the C
      // render-query engine at all. ----
      {
        // 20a. The unit-type -> glyph mapping is pure, DOM-independent JS -
        // verify every one of the 14 real class_id values Napoleonic Wars
        // uses (lua/msfiles/header_common.py's multi_troop_class_* enum,
        // 10-23) renders its expected arm/glyph family, plus the 0/unmapped
        // fallback (empty frame, no glyph - APP-6's own "unknown function"
        // convention).
        const expectedArms = {
          1: 'infantry', 10: 'infantry', 11: 'infantry', 12: 'infantry', 13: 'infantry',
          3: 'cavalry', 14: 'cavalry', 15: 'cavalry', 16: 'cavalry', 17: 'cavalry', 18: 'cavalry', 19: 'cavalry',
          4: 'infantry', 5: 'infantry', 6: 'cavalry', 7: 'cavalry',
          20: 'artillery', 21: 'rocket', 22: 'engineer', 23: 'medical',
          0: 'other', 2: 'other',
        };
        let armMismatches = [];
        let glyphMismatches = [];
        for (const classIdStr in expectedArms) {
          const classId = parseInt(classIdStr, 10);
          const info = getNatoUnitInfo(classId);
          if (info.arm !== expectedArms[classIdStr]) armMismatches.push(`${classId}:got ${info.arm} want ${expectedArms[classIdStr]}`);
          const el = buildNatoSymbolElement({ x: 0, y: 0, unit_type: classId, commander_name: '', aux_text: '' });
          const hasGlyph = el.querySelectorAll('.nato-symbol-glyph').length > 0;
          const shouldHaveGlyph = info.arm !== 'other';
          if (hasGlyph !== shouldHaveGlyph) glyphMismatches.push(`${classId}:hasGlyph=${hasGlyph} expected=${shouldHaveGlyph}`);
        }
        checks.push(['every real class_id (10-23) plus the legacy 0-7 set maps to its documented NATO arm',
          armMismatches.length === 0, armMismatches.join('; ')]);
        checks.push(['each mapped arm renders an interior glyph; 0/unmapped renders an empty frame with none',
          glyphMismatches.length === 0, glyphMismatches.join('; ')]);

        // 20b. Ranged amplifier (archer/crossbow classes 4-7) and cavalry's
        // mobility amplifier (3, 14-19) are present exactly where expected.
        const rangedInfo4 = getNatoUnitInfo(4), infantryInfo1 = getNatoUnitInfo(1), cavalryInfo3 = getNatoUnitInfo(3);
        checks.push(['archer/crossbow class_ids (4-7) carry the ranged amplifier flag, plain infantry/cavalry do not',
          rangedInfo4.ranged === true && !infantryInfo1.ranged && !cavalryInfo3.ranged]);

        // 20c. Affiliation controls frame SHAPE (APP-6: rectangle=friend,
        // diamond=hostile, square=neutral, quatrefoil-ish=unknown).
        const shapeByAffiliation = {};
        for (const aff of ['friend', 'hostile', 'neutral', 'unknown', undefined]) {
          const el = buildNatoSymbolElement({ x: 0, y: 0, unit_type: 1, affiliation: aff, commander_name: '', aux_text: '' });
          shapeByAffiliation[aff || 'default'] = el.querySelector('.nato-symbol-frame').tagName;
        }
        checks.push(['affiliation selects the documented APP-6 frame shape (diamond/square/quatrefoil/rectangle)',
          shapeByAffiliation.hostile === 'polygon' && shapeByAffiliation.neutral === 'rect' &&
            shapeByAffiliation.unknown === 'ellipse' && shapeByAffiliation.friend === 'rect' && shapeByAffiliation.default === 'rect',
          JSON.stringify(shapeByAffiliation)]);

        // 20d. commander_name/aux_text/size/rotation_deg are independently
        // reflected in the DOM (per this session's no-screenshots convention
        // - verified via DOM inspection, not visually).
        const labeled = buildNatoSymbolElement({ x: 0, y: 0, unit_type: 1, commander_name: 'CmdA', aux_text: 'AuxB' });
        const commanderOk = labeled.querySelector('.nato-symbol-commander') && labeled.querySelector('.nato-symbol-commander').textContent === 'CmdA';
        const auxOk = labeled.querySelector('.nato-symbol-aux') && labeled.querySelector('.nato-symbol-aux').textContent === 'AuxB';
        const sizedRotated = buildNatoSymbolElement({ x: 0, y: 0, unit_type: 1, commander_name: '', aux_text: '' });
        updateNatoSymbolTransform(sizedRotated, { x: 3, y: 4, rotation_deg: 90 }, null, 0, 2.5);
        const transformOk = /rotate\(90\)/.test(sizedRotated.getAttribute('transform')) && /scale\(2\.5\)/.test(sizedRotated.getAttribute('transform'));
        checks.push(['commander_name, aux_text, size, and rotation_deg are each independently reflected in the symbol DOM',
          commanderOk && auxOk && transformOk,
          `commanderOk=${commanderOk} auxOk=${auxOk} transformOk=${transformOk} transform=${sizedRotated.getAttribute('transform')}`]);

        // 20e. Rotation interpolates via shortest angle, not naive linear -
        // a 359deg -> 1deg blend must cross through 360/0, never dip toward
        // 180 the long way around.
        const blended = blendAngleDeg(359, 1, 0.5);
        checks.push(['rotation interpolation crosses a 359deg->0deg boundary via the shortest angle, not naive linear',
          Math.abs(((blended % 360) + 360) % 360) < 5, `blendAngleDeg(359,1,0.5)=${blended}`]);

        // 20f. End-to-end: enabling a nato_symbol query (via the panel's own
        // Kind switch, which pre-fills the real sample template on an
        // untouched new query - see updateRenderQueryField) actually
        // populates #map-symbol-layer with one <g> per living agent, and
        // disabling/deleting it cleans the layer back up - not just that the
        // pure glyph-mapping functions above work in isolation.
        if (matches.length > 0 && latestFrame && latestFrame.activeMatchIndex >= 0) {
          const beforeLen = renderQueries.length;
          addRenderQuery();
          const natoQ = renderQueries[renderQueries.length - 1];
          updateRenderQueryField(natoQ.id, 'kind', 'nato_symbol');
          checks.push(['switching a fresh query\'s Kind to nato_symbol pre-fills the real sample template, not an empty placeholder',
            natoQ.sql.includes('@KIND nato_symbol') && natoQ.interpolate === true]);

          const layer = document.getElementById('map-symbol-layer');
          const symbolsAppeared = await waitFor(() => layer.childElementCount > 0, 8000);
          checks.push(['enabling a nato_symbol query populates #map-symbol-layer with real symbols',
            symbolsAppeared, `childCount=${layer.childElementCount}`]);

          updateRenderQueryField(natoQ.id, 'enabled', false);
          const symbolsCleared = await waitFor(() => layer.childElementCount === 0, 8000);
          checks.push(['disabling a nato_symbol query clears its symbols from the layer',
            symbolsCleared, `childCount=${layer.childElementCount}`]);

          deleteRenderQuery(natoQ.id);
          checks.push(['deleting the nato_symbol query leaves the render-query list back at its original length',
            renderQueries.length === beforeLen]);
        }
      }

      // ---- 21. Cross-panel UI consistency regressions - real bugs a user
      // found by hand that none of the checks above happened to exercise:
      // a whole panel silently missing from the shared themed-button/select
      // selector list (renders as unstyled native OS widgets), a fixed
      // .panel-content width fighting makeResizable(), several sibling
      // <div> button groups that can never consolidate onto one row no
      // matter how wide the panel gets, and a reachable-but-content-gated
      // panel that reads as permanently broken. Kept as its own numbered
      // section (not folded into 19/20 above) since these are properties of
      // the PANEL CHROME shared across features, not any one feature's own
      // behavior - the next new panel is exactly the thing most likely to
      // reintroduce one of these by omission, so this checks the pattern
      // itself, not just today's instances of it. ----
      {
        function showPanel(id) {
          const p = document.getElementById(id);
          p.style.display = 'flex';
          p.classList.remove('minimized');
          return p;
        }

        // 21a. Every panel with real button/select controls must use the
        // app's themed appearance, not the browser's native OS widget
        // chrome - checked by comparing against a known-good reference
        // (Schema Explorer's own button/select) rather than hardcoding
        // color literals, so this stays valid if the theme itself changes
        // later; it only catches a panel silently left OUT of the shared
        // rule (exactly today's real bug: render-queries-panel and
        // debug-panel were both missing from it, rendering plain gray
        // native buttons and a native <select> arrow poking out from behind
        // the themed background, right next to panels that looked correct).
        const refBtn = showPanel('schema-explorer-panel').querySelector('.button-row button');
        const refSel = document.querySelector('#schema-explorer-panel .button-row select');
        const refBtnCss = getComputedStyle(refBtn);
        const refSelCss = getComputedStyle(refSel);
        const panelsWithControls = [
          ['log-box', null], // text-only, no controls to check
          ['debug-panel', 'button'],
          ['sql-terminal-panel', 'button'],
          ['render-queries-panel', 'button'],
        ];
        let styleMismatches = [];
        for (const [panelId, tag] of panelsWithControls) {
          if (!tag) continue;
          const el = showPanel(panelId).querySelector(`.button-row ${tag}`);
          if (!el) { styleMismatches.push(`${panelId}: no ${tag} found`); continue; }
          const cs = getComputedStyle(el);
          if (cs.backgroundColor !== refBtnCss.backgroundColor || cs.borderColor !== refBtnCss.borderColor || cs.color !== refBtnCss.color) {
            styleMismatches.push(`${panelId} ${tag}: bg=${cs.backgroundColor} border=${cs.borderColor} color=${cs.color} (want bg=${refBtnCss.backgroundColor} border=${refBtnCss.borderColor} color=${refBtnCss.color})`);
          }
        }
        checks.push(['every panel with button controls uses the app-themed appearance, not native OS widget chrome',
          styleMismatches.length === 0, styleMismatches.join('; ')]);

        const renderQuerySelect = document.querySelector('#render-queries-panel .render-query-controls-row select');
        checks.push(['Rendering Queries panel\'s Kind/Cache/Shape <select> dropdowns strip native appearance, matching every other themed select',
          renderQuerySelect && getComputedStyle(renderQuerySelect).appearance === 'none' && getComputedStyle(renderQuerySelect).appearance === refSelCss.appearance,
          renderQuerySelect ? `appearance=${getComputedStyle(renderQuerySelect).appearance}` : 'no select found']);

        // 21b. Rendering Queries' .panel-content must stretch to fill the
        // panel on resize, not stay pinned at some fixed width - regression
        // for width:420px having been set on .panel-content directly
        // (fighting makeResizable()'s inline panel.style.width) instead of
        // on the panel itself, the same convention every other sizeable
        // panel (e.g. [data-panel-type="sql-terminal-panel"]) already uses.
        const rqPanelForResize = showPanel('render-queries-panel');
        const widthBeforeResize = rqPanelForResize.querySelector('.panel-content').getBoundingClientRect().width;
        rqPanelForResize.style.width = (Math.round(widthBeforeResize) + 200) + 'px';
        const widthAfterResize = rqPanelForResize.querySelector('.panel-content').getBoundingClientRect().width;
        checks.push(['Rendering Queries panel\'s content stretches to fill the panel when resized wider, not pinned at a fixed width',
          widthAfterResize > widthBeforeResize + 150,
          `before=${widthBeforeResize} after=${widthAfterResize}`]);
        rqPanelForResize.style.width = ''; // restore

        // 21c. Schema Explorer / VFS Trace toolbar controls must live in ONE
        // flex-wrap row per panel, not several fixed sibling <div>s that can
        // never consolidate onto fewer lines regardless of available width -
        // the SQL Terminal's own button-row already documents this exact
        // principle ("widening the panel lets these consolidate onto fewer
        // rows instead of staying stuck exactly where they started").
        // .panel-content .button-row (descendant, not direct child) -
        // ensurePanelZoomWrap moves every .panel-content's real children one
        // level deeper into a .panel-zoom-wrap (see that function's own
        // comment), so a direct-child selector here would never match.
        const seRowCount = showPanel('schema-explorer-panel').querySelectorAll('.panel-content .button-row').length;
        const vfsRowCount = showPanel('debug-panel').querySelectorAll('.panel-content .button-row').length;
        checks.push(['Schema Explorer\'s toolbar controls (DB filter/refresh/checkpoint save/revert) live in one consolidated flex-wrap row',
          seRowCount === 1, `button-row count=${seRowCount}`]);
        checks.push(['VFS Trace\'s toolbar controls live in one consolidated flex-wrap row, not plain non-wrapping <div>s',
          vfsRowCount === 1, `button-row count=${vfsRowCount}`]);

        // 21d. System Logs is reachable by every user regardless of
        // DEBUG_MODE (see DEBUG_MODE's own comment - the Panels menu
        // section itself is never debug-gated), so its content must not
        // stay silently frozen on the empty-state placeholder for a
        // non-debug user no matter what happens - regression for
        // appendToConsoleLog's own DEBUG_MODE gate silently discarding
        // every real log line for exactly the users who CAN open this
        // panel through the menu.
        const logContentEl = showPanel('log-box').querySelector('.panel-content');
        checks.push(['System Logs shows a real status message after a successful load, not stuck on the empty-state placeholder',
          /Parse Complete|Matches detected/.test(logContentEl.innerText),
          JSON.stringify(logContentEl.innerText)]);

        // 21e. Per-query pop-out (main.js's createRenderQueryPopoutPanel) -
        // the user's own explicit ask: "It should be per query and you
        // should open pop out editor as it does in schema explorer", not a
        // whole-panel clone (openNewPanelInstance, already covered by
        // section 19's own "second window mirrors the shared list" check -
        // a DIFFERENT, still-valid feature, just not what this button is).
        const rqPanelFor21e = showPanel('render-queries-panel');
        const firstCard = rqPanelFor21e.querySelector('.render-query-card');
        const firstCardQueryId = parseInt(firstCard.dataset.queryId, 10);
        const openInWindowBtn = Array.from(firstCard.querySelectorAll('button')).find((b) => b.textContent === 'Open in window');
        const popoutCountBefore = document.querySelectorAll('[data-panel-type="render-query-popout-panel"]').length;
        if (openInWindowBtn) openInWindowBtn.click();
        const popoutEl = document.querySelector('[data-panel-type="render-query-popout-panel"]');
        checks.push(['a render-query card has a per-query "Open in window" pop-out button, and it opens a dedicated editor window',
          !!openInWindowBtn && document.querySelectorAll('[data-panel-type="render-query-popout-panel"]').length === popoutCountBefore + 1,
          `btnFound=${!!openInWindowBtn} popoutTitle=${popoutEl ? popoutEl.querySelector('.panel-header span').textContent : 'n/a'}`]);

        if (popoutEl) {
          const popoutTa = popoutEl.querySelector('.render-query-popout-textarea');
          const cardTa = firstCard.querySelector('.render-query-textarea');
          const marker = '-- popout sync test marker';
          popoutTa.value = popoutTa.value + '\n' + marker;
          popoutTa.dispatchEvent(new Event('input', { bubbles: true }));
          checks.push(['editing a query in its popped-out window syncs back to the compact card\'s own textarea',
            cardTa.value.includes(marker)]);
          cardTa.value = cardTa.value.replace('\n' + marker, ''); // restore
          cardTa.dispatchEvent(new Event('input', { bubbles: true }));

          deleteRenderQuery(firstCardQueryId);
          checks.push(['deleting a query whose pop-out is currently open closes that pop-out instead of orphaning it',
            document.querySelectorAll('[data-panel-type="render-query-popout-panel"]').length === popoutCountBefore]);
          resetRenderQueriesToDefaults(); // restore the default 3-query list for anything after this
        }
      }

      // ---- 22. Editor box-model/cursor-sync integrity - a real, hand-
      // reproduced bug: a query/script with more lines than the textarea's
      // own (rows-based or user-resized) height naturally shows made the
      // line-number gutter's OWN content (all those line numbers) drive its
      // flex-stretch preferred size taller than the textarea - and because
      // every gutter'd editor's row is `align-items:stretch` over
      // [gutter, editor-wrap], that inflated the WHOLE ROW, backdrop
      // included, past where the real (invisible) textarea's own typing/
      // scrolling area actually ends. Visually: colored syntax-highlighted
      // text extending below the real cursor's reachable area, and a
      // native textarea scrollbar whose thumb implies far more hidden
      // content than what's really there - exactly what got hand-
      // reproduced and screenshotted. Fixed at the shared function level
      // (renderLineNumbersInto now pins gutter.style.height to the
      // textarea's own real, measured height on every call, instead of
      // trusting two separately-authored CSS blocks to happen to agree) -
      // checked here for every surface that shares that function, not just
      // Rendering Queries, since the same latent vulnerability existed
      // identically in generator-script editors, just less likely to
      // trigger there with typically-short scripts. ----
      {
        function showPanel22(id) {
          const p = document.getElementById(id);
          p.style.display = 'flex';
          p.classList.remove('minimized');
          return p;
        }

        // A query with far more lines than a rows=8 textarea naturally
        // shows - the exact shape of fixture that triggers the bug (a short
        // query never would, which is exactly why it went unnoticed for as
        // long as it did).
        const LONG_SQL = Array.from({ length: 50 }, (_, i) => `-- line ${i + 1}`).join('\n') +
          "\nSELECT pos_x AS x, pos_y AS y, 1.0 AS color_r, 1.0 AS color_g, 1.0 AS color_b FROM main.agent_states;";

        function checkGutterPinned(label, textarea, gutter, backdrop) {
          textarea.value = LONG_SQL;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          const taH = textarea.offsetHeight, gutterH = gutter.offsetHeight;
          checks.push([`${label}: line-number gutter height stays pinned to the textarea's real height even with 51 lines of content`,
            Math.abs(taH - gutterH) <= 1, // sub-pixel rounding only
            `textareaHeight=${taH} gutterHeight=${gutterH} lineCount=${gutter.dataset.lineCount}`]);
          // The backdrop must never extend meaningfully past the textarea
          // either - it's bound to editor-wrap, which was the OTHER victim
          // of the same gutter-driven stretch inflation.
          const backdropH = backdrop.offsetHeight;
          checks.push([`${label}: syntax-highlight backdrop height stays within a few px of the textarea's real height (not inflated by gutter content)`,
            Math.abs(taH - backdropH) <= 6,
            `textareaHeight=${taH} backdropHeight=${backdropH}`]);
        }

        // 22a. Rendering Queries compact card.
        const rqPanel22 = showPanel22('render-queries-panel');
        const rqQ = renderQueries[1];
        const rqCard = rqPanel22.querySelector(`.render-query-card[data-query-id="${rqQ.id}"]`);
        checkGutterPinned('Rendering Queries card',
          rqCard.querySelector('.render-query-textarea'), rqCard.querySelector('.render-query-gutter'), rqCard.querySelector('.render-query-highlight'));
        const rqOriginalSql = rqQ.sql;

        // 22b. Rendering Queries pop-out (same wireRenderQueryEditorBehavior,
        // different DOM shell - see main.js's own comment on why this is
        // the RIGHT level to have fixed this at).
        const openBtn22 = Array.from(rqCard.querySelectorAll('button')).find((b) => b.textContent === 'Open in window');
        openBtn22.click();
        const rqPopout = document.querySelector('[data-panel-type="render-query-popout-panel"]');
        if (rqPopout) {
          checkGutterPinned('Rendering Query pop-out',
            rqPopout.querySelector('.render-query-popout-textarea'), rqPopout.querySelector('.render-query-popout-gutter'), rqPopout.querySelector('.render-query-popout-highlight'));
          rqPopout.remove(); // close it - deleteRenderQuery isn't being called, just tearing down the DOM directly
        }

        // Restore the card's original SQL so later sections see the
        // unmodified default list.
        rqCard.querySelector('.render-query-textarea').value = rqOriginalSql;
        rqCard.querySelector('.render-query-textarea').dispatchEvent(new Event('input', { bubbles: true }));
        resetRenderQueriesToDefaults();

        // 22c. Generator-script editor (Schema Explorer's embedded r/b
        // editor) - the SAME renderLineNumbersInto function, a genuinely
        // different feature, confirming the fix is shared infrastructure
        // and not a render-query-specific patch.
        await ensureDbViewAsync(1).catch(() => {});
        const schemaPanel22 = showPanel22('schema-explorer-panel');
        await refreshSchemaExplorerPanel(schemaPanel22);
        const genReady22 = await waitFor(
          () => !!schemaPanel22.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea'), 20000);
        if (genReady22) {
          const genTa22 = schemaPanel22.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
          const genGutter22 = schemaPanel22.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-gutter');
          const genBackdrop22 = schemaPanel22.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-highlight');
          const genOriginalSql = genTa22.value;
          checkGutterPinned('Generator-script editor (Schema Explorer)', genTa22, genGutter22, genBackdrop22);
          genTa22.value = genOriginalSql;
          genTa22.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 22d. A native-style resize (setting the textarea's own height
        // directly, exactly what dragging its resize:vertical handle does
        // internally) fires neither 'input' nor 'scroll' - the
        // ResizeObserver added specifically for this must still re-pin the
        // gutter's height afterward, not just leave it stale until the
        // next keystroke.
        const rqPanel22b = showPanel22('render-queries-panel');
        const rqQ2 = renderQueries[1];
        const rqCard2 = rqPanel22b.querySelector(`.render-query-card[data-query-id="${rqQ2.id}"]`);
        const ta22d = rqCard2.querySelector('.render-query-textarea');
        const gutter22d = rqCard2.querySelector('.render-query-gutter');
        ta22d.style.height = '250px'; // simulates a resize-drag's own end effect
        const resizeSynced = await waitFor(() => Math.abs(ta22d.offsetHeight - gutter22d.offsetHeight) <= 1, 3000);
        checks.push(['a native-style resize (no input/scroll event) still re-pins the gutter height via ResizeObserver',
          resizeSynced, `textareaHeight=${ta22d.offsetHeight} gutterHeight=${gutter22d.offsetHeight}`]);
        ta22d.style.height = ''; // restore

        // 22e. Editing a @KIND=chat query must not flood refreshChatFromQuery
        // once per keystroke - regression for exactly that (an unbounded
        // number of overlapping background SQL requests while still
        // actively, often invalidly, mid-edit), now debounced the same way
        // the engine push already was.
        const wasPausedFor22e = isPaused;
        isPaused = true;
        let chatCallCount22e = 0;
        const origRefreshChat22e = refreshChatFromQuery;
        refreshChatFromQuery = function (...args) { chatCallCount22e++; return origRefreshChat22e.apply(this, args); };
        const chatQ22e = renderQueries.find((q) => q.kind === 'chat');
        const chatCard22e = document.querySelector(`.render-query-card[data-query-id="${chatQ22e.id}"]`);
        const chatTa22e = chatCard22e.querySelector('.render-query-textarea');
        const chatOriginalSql = chatTa22e.value;
        for (let i = 0; i < 10; i++) {
          chatTa22e.value += 'x';
          chatTa22e.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const immediateChatCalls = chatCallCount22e;
        await new Promise((r) => setTimeout(r, 600));
        const finalChatCalls = chatCallCount22e;
        refreshChatFromQuery = origRefreshChat22e;
        chatTa22e.value = chatOriginalSql;
        chatTa22e.dispatchEvent(new Event('input', { bubbles: true }));
        isPaused = wasPausedFor22e;
        checks.push(['editing a chat-kind query debounces refreshChatFromQuery instead of firing once per keystroke',
          immediateChatCalls === 0 && finalChatCalls === 1,
          `immediateCalls=${immediateChatCalls} finalCallsAfter600ms=${finalChatCalls} (10 keystrokes fired)`]);

        // 22f. Opening a second pop-out for a query that already has one
        // open must reuse/focus the existing window, not spawn a duplicate
        // - two independent live editors for the same query, stacked
        // almost on top of each other, is a real, easy way to end up
        // typing into a window the user didn't think had focus.
        const dedupQ = renderQueries[1];
        const dedupCard = document.querySelector(`.render-query-card[data-query-id="${dedupQ.id}"]`);
        const dedupBtn = Array.from(dedupCard.querySelectorAll('button')).find((b) => b.textContent === 'Open in window');
        dedupBtn.click();
        const popoutCountAfterFirst = document.querySelectorAll('[data-panel-type="render-query-popout-panel"]').length;
        dedupBtn.click();
        const popoutCountAfterSecond = document.querySelectorAll('[data-panel-type="render-query-popout-panel"]').length;
        checks.push(['clicking "Open in window" again on a query that already has one open reuses it instead of spawning a duplicate',
          popoutCountAfterFirst === 1 && popoutCountAfterSecond === 1,
          `afterFirst=${popoutCountAfterFirst} afterSecond=${popoutCountAfterSecond}`]);
        document.querySelectorAll('[data-panel-type="render-query-popout-panel"]').forEach((p) => p.remove());
      }

      // ---- 23. No-wrap architecture - the actual root cause behind the
      // cursor/text misalignment reports, found only after section 22's own
      // gutter-height fix turned out NOT to be the whole story. A plain
      // <textarea> soft-wraps long lines using the BROWSER's own native
      // text-layout engine; the colored backdrop approximated that by
      // setting white-space:pre-wrap on a <pre>, which soft-wraps using
      // CSS's OWN, ENTIRELY SEPARATE line-breaking algorithm. Nothing ever
      // guaranteed those two independent implementations chose the same
      // wrap point for a given long line, even with byte-identical padding/
      // font/line-height/width - and when they didn't, every character
      // after that point visibly drifted from the real (invisible) cursor,
      // no matter how precisely the box model itself was tuned, because the
      // box model was never what was actually disagreeing.
      //
      // The fix removes the disagreement at its source instead of trying to
      // keep two independent line-breaking engines in perpetual agreement:
      // white-space:pre (not pre-wrap) on BOTH the backdrop AND its real
      // textarea, in every one of this app's five editor surfaces, so
      // neither ever wraps at all - with nothing to wrap, there is no wrap
      // point either engine could compute differently. This section checks
      // the invariant holds across EVERY surface uniformly (not just
      // Rendering Queries, where it was first noticed), since the whole
      // point of fixing this at the shared CSS/JS level is that no future
      // editor surface should be able to reintroduce it by accident. ----
      {
        function assertNoWrap(label, textarea, backdrop) {
          const LONG_LINE = 'SELECT ' + Array.from({ length: 30 }, (_, i) => `col_${i}_with_a_fairly_long_name`).join(', ') + ' FROM some_table;';
          textarea.value = LONG_LINE;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));

          const taWs = getComputedStyle(textarea).whiteSpace;
          const bdWs = backdrop ? getComputedStyle(backdrop).whiteSpace : 'pre'; // SQL Terminal main input has no gutter but DOES have a backdrop; pass null only if truly none
          checks.push([`${label}: textarea and backdrop both use white-space:pre (never pre-wrap), so neither has an independent wrap-point decision to make`,
            taWs === 'pre' && bdWs === 'pre', `textarea=${taWs} backdrop=${bdWs}`]);

          checks.push([`${label}: a long single-line query overflows horizontally instead of wrapping (scrollWidth > clientWidth)`,
            textarea.scrollWidth > textarea.clientWidth + 5,
            `scrollWidth=${textarea.scrollWidth} clientWidth=${textarea.clientWidth}`]);

          // Genuinely didn't wrap into multiple visual rows: scrollHeight
          // shouldn't be meaningfully taller than clientHeight just from
          // this one long line (a real wrap would inflate scrollHeight by
          // roughly one extra line-height per wrap point on a 30-column
          // query at a narrow test-panel width).
          checks.push([`${label}: the long line did not wrap into extra visual rows (scrollHeight stays at clientHeight)`,
            textarea.scrollHeight <= textarea.clientHeight + 2,
            `scrollHeight=${textarea.scrollHeight} clientHeight=${textarea.clientHeight}`]);

          // Horizontal scroll still mirrors onto the backdrop - the
          // existing scrollLeft-sync in attachSqlHighlighting, unchanged by
          // this fix, still has to actually work now that there's real
          // horizontal overflow to scroll through.
          if (backdrop) {
            textarea.scrollLeft = 40;
            textarea.dispatchEvent(new Event('scroll', { bubbles: true }));
            checks.push([`${label}: scrolling the textarea horizontally mirrors onto the backdrop`,
              backdrop.scrollLeft === 40, `backdrop.scrollLeft=${backdrop.scrollLeft}`]);
            textarea.scrollLeft = 0;
            textarea.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        }

        // 23a. SQL Terminal's own main input (no gutter, but a real backdrop).
        const sqlPanel23 = document.getElementById('sql-terminal-panel');
        sqlPanel23.style.display = 'flex';
        sqlPanel23.classList.remove('minimized');
        assertNoWrap('SQL Terminal input',
          sqlPanel23.querySelector('.sql-terminal-input'), sqlPanel23.querySelector('.sql-terminal-highlight'));

        // 23b. Generator-script editor, compact (Schema Explorer embedded).
        await ensureDbViewAsync(1).catch(() => {});
        const schemaPanel23 = document.getElementById('schema-explorer-panel');
        schemaPanel23.style.display = 'flex';
        schemaPanel23.classList.remove('minimized');
        await refreshSchemaExplorerPanel(schemaPanel23);
        const genReady23 = await waitFor(
          () => !!schemaPanel23.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea'), 20000);
        let genOriginalSql23 = null;
        if (genReady23) {
          const genTa23 = schemaPanel23.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-textarea');
          const genBackdrop23 = schemaPanel23.querySelector('.schema-tree-schema[data-schema-name="r"] .generator-script-highlight');
          genOriginalSql23 = genTa23.value;
          assertNoWrap('Generator-script editor (Schema Explorer, compact)', genTa23, genBackdrop23);

          // 23c. Same editor, popped out - a genuinely different DOM shell
          // (buildGeneratorScriptPopoutEditor), sharing only the CSS class
          // NAMES' underlying declarations, not the actual elements.
          const popoutBtn23 = Array.from(schemaPanel23.querySelectorAll('.schema-tree-schema[data-schema-name="r"] .generator-script-editor button'))
            .find((b) => b.textContent === 'Open in window');
          if (popoutBtn23) {
            popoutBtn23.click();
            const genPopout23 = document.querySelector('[data-panel-type="generator-script-popout-panel"]');
            if (genPopout23) {
              assertNoWrap('Generator-script editor (pop-out)',
                genPopout23.querySelector('.generator-popout-textarea'), genPopout23.querySelector('.generator-popout-highlight'));
              genPopout23.remove();
            }
          }
          genTa23.value = genOriginalSql23;
          genTa23.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 23d/23e. Rendering Queries card + its own pop-out.
        const rqPanel23 = document.getElementById('render-queries-panel');
        rqPanel23.style.display = 'flex';
        rqPanel23.classList.remove('minimized');
        if (matches.length > 0 && renderQueries.length > 1) {
          const rqQ23 = renderQueries[1];
          const rqCard23 = rqPanel23.querySelector(`.render-query-card[data-query-id="${rqQ23.id}"]`);
          const rqOriginalSql23 = rqQ23.sql;
          assertNoWrap('Rendering Query card',
            rqCard23.querySelector('.render-query-textarea'), rqCard23.querySelector('.render-query-highlight'));

          const rqPopoutBtn23 = Array.from(rqCard23.querySelectorAll('button')).find((b) => b.textContent === 'Open in window');
          rqPopoutBtn23.click();
          const rqPopout23 = document.querySelector('[data-panel-type="render-query-popout-panel"]');
          if (rqPopout23) {
            assertNoWrap('Rendering Query pop-out',
              rqPopout23.querySelector('.render-query-popout-textarea'), rqPopout23.querySelector('.render-query-popout-highlight'));
            rqPopout23.remove();
          }

          rqCard23.querySelector('.render-query-textarea').value = rqOriginalSql23;
          rqCard23.querySelector('.render-query-textarea').dispatchEvent(new Event('input', { bubbles: true }));
          resetRenderQueriesToDefaults();
        }
      }

      // 17h. "Load Different Replay" must genuinely cover every open panel,
      // not just usually win a z-index race that a long enough session
      // could still lose. Regression for .overlay sitting at a fixed
      // z-index (20) that ordinary panel clicks (same counter as above)
      // climb past just as easily.
      const panelRectBeforeReset = panel.getBoundingClientRect();
      triggerReset();
      const elAtPanelCenter = document.elementFromPoint(
        panelRectBeforeReset.left + panelRectBeforeReset.width / 2,
        panelRectBeforeReset.top + panelRectBeforeReset.height / 2
      );
      const uploadOverlayEl = document.getElementById('upload-overlay');
      checks.push(['"Load Different Replay" (triggerReset) visually covers a panel that was open, not just usually',
        uploadOverlayEl.style.display === 'flex' && !!elAtPanelCenter &&
          (elAtPanelCenter.id === 'upload-overlay' || uploadOverlayEl.contains(elAtPanelCenter)),
        `overlayDisplay=${uploadOverlayEl.style.display} elementAtPanelCenter=${elAtPanelCenter ? (elAtPanelCenter.id || elAtPanelCenter.className) : null}`]);
    }

    result.checks = checks.map(([name, ok, detail]) => ({ name, ok: !!ok, detail: detail || undefined }));
    result.allPass = checks.every(([, ok]) => ok);
    result.done = true;
  } catch (e) {
    result.checks = checks.map(([name, ok, detail]) => ({ name, ok: !!ok, detail: detail || undefined }));
    result.error = e.message + (e.stack ? ('\n' + e.stack) : '');
    result.allPass = false;
    result.done = true;
  }
})();

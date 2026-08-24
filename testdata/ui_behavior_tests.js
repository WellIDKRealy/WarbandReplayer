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
      checks.push(['export battle produces bytes', exported, exported ? `${exportedBytes.length} bytes` : '']);
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
            await waitForSqlDone();
            const replayCountOk = panel.querySelector('.sql-terminal-status').innerText.includes('1 row');
            checks.push(['bare table name auto-qualifies to the selected non-main schema',
              replayCountOk, panel.querySelector('.sql-terminal-status').innerText]);

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
            const genTa = schemaPanel2.querySelector('.schema-tree-schema .generator-script-textarea');
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
            const compactButtons = Array.from(schemaPanel2.querySelectorAll('.schema-tree-schema .generator-script-editor button')).map((b) => b.textContent);
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
            const genStatus = schemaPanel2.querySelector('.schema-tree-schema .generator-script-status');
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
            const genTaFresh = schemaPanel2.querySelector('.schema-tree-schema .generator-script-textarea');
            const openInWindowBtn = Array.from(schemaPanel2.querySelectorAll('.schema-tree-schema .generator-script-editor button'))
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
            const genTaAfterPopoutEdit = schemaPanel2.querySelector('.schema-tree-schema .generator-script-textarea');
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

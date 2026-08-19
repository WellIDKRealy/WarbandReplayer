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

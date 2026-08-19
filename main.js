// ---- ustar extraction (Phase 5: loading a previously-exported .tar.xz
// battle file back in) - pure byte parsing, no WASM needed, same idiom as
// replay_export.c's tar_add_entry() on the writing side. Verified against
// replay_export.c's own output (testdata/export_test.html) and against
// real tar.exe. ----
const USTAR_MAGIC = [117, 115, 116, 97, 114, 0, 48, 48]; // "ustar\0" + "00"
function parseOctalField(bytes) {
    let s = '';
    for (const b of bytes) { if (b === 0 || b === 32) break; s += String.fromCharCode(b); }
    return s.length ? parseInt(s, 8) : 0;
}
function parseTar(bytes) {
    const entries = [];
    let off = 0;
    while (off + 512 <= bytes.length) {
        const header = bytes.subarray(off, off + 512);
        if (header.every(b => b === 0)) break; // end-of-archive zero block
        const nameBytes = header.subarray(0, 100);
        let nameEnd = 0; while (nameEnd < 100 && nameBytes[nameEnd] !== 0) nameEnd++;
        const name = new TextDecoder().decode(nameBytes.subarray(0, nameEnd));
        const size = parseOctalField(header.subarray(124, 136));
        const magicBytes = header.subarray(257, 265);
        const magicOk = USTAR_MAGIC.every((b, i) => magicBytes[i] === b);
        off += 512;
        const data = bytes.subarray(off, off + size);
        entries.push({ name, size, magicOk, data });
        off += size;
        if (size % 512 !== 0) off += 512 - (size % 512);
    }
    return entries;
}

const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl');
const logContent = document.getElementById('log-content');
const uploadOverlay = document.getElementById('upload-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const resetBtn = document.getElementById('reset-btn');

// `new Worker(url)` has its own cache behavior, separate from fetch()'s
// (and not controllable via a {cache} option at all) - a plain relative
// URL here can silently keep using a browser-cached copy of
// replay-worker.js even after the file on disk/server has changed. One
// cache-bust suffix per page load, reused by every Worker(...) call site,
// same pattern testdata/verify_against_truth.html already uses for the
// same reason.
const WORKER_SCRIPT_URL = 'replay-worker.js?v=' + Date.now();

// Debug mode gates the system-log panel, the VFS trace panel, and the SQL
// terminal (added in a later phase) - all noise/attack-surface most users
// never need. Opt in via ?debug=1 for a one-off session, or persist it with
// localStorage so it survives a reload without retyping the URL.
const DEBUG_MODE = new URLSearchParams(location.search).has('debug') ||
                    localStorage.getItem('wb_debug') === '1';
const logBox = document.getElementById('log-box');
const debugPanel = document.getElementById('debug-panel');
const sqlTerminalPanel = document.getElementById('sql-terminal-panel');
// System Logs/VFS Trace default OFF even in debug mode (opt in via the
// hamburger menu's Panels checkboxes - see setPanelVisible below); SQL
// Terminal is the one debug tool that's actually useful open by default.
// Showing all three unconditionally is what caused the original overlap
// complaints this whole panel redesign exists to fix.
if (DEBUG_MODE) {
    document.getElementById('menu-panels-section').style.display = 'block';
    sqlTerminalPanel.style.display = 'flex';
}

let currentSimulationState = "AWAITING_FILE";
let activeLogs = ["Ready to process Warband SQLite replay..."];
let wasmInstance = null;

// Replay playback state - all tick/SQL bookkeeping lives in replay_worker.wasm;
// this is just the continuous playback clock the render loop advances.
let replayTime = 0.0;
let totalStartTime = 0.0;
let totalEndTime = 0.0;
let isPaused = false;
let playbackSpeed = 1.0;
let matches = []; // small (<=16) summary array from the loader worker's 'loaded' message
let timelineLoadBars = []; // per-match DOM element for the buffered/loaded indicator, see updateLoadIndicators()

// Phase 4: battle export (replay.db+battle.db+manifest.json, tar'd then
// xz-compressed). Export itself runs on playbackWorker (the sole g_db
// writer, see replay_export.c); compression runs in a separate, lazily
// created Worker around compress.wasm so a slow LZMA pass never blocks
// playback message handling on the main replay engine thread.
let exportInFlight = false;
let compressWorker = null;

// Worker orchestration
const WASM_MEMORY_INITIAL_PAGES = 1536;  // 96MiB - must match Makefile's --initial-memory (Phase 6:
                                          // shrunk from 640MiB now that wasm_layout.h's nominal
                                          // per-thread sizes are small enough to actually approach the
                                          // 128MB-floor target - see wasm_layout.h's own comment for
                                          // why smaller nominal sizes lose no real capability.
const WASM_MEMORY_MAX_PAGES = 32768;     // 2GiB - must match Makefile's --max-memory; > initial
                                          // on purpose now, real headroom for heap_extend_threaded
                                          // to grow into (goyslopless-c/lib/heap.c) - initial===max
                                          // would make every grow call fail regardless of whether
                                          // the grow logic itself is correct.
let sharedMemory = null;
let replayModule = null;
let playbackWorker = null; // the loader worker, which continues serving live queries after load
let pendingFrameRequest = false;
let latestFrame = null; // { buffer, count, activeMatchIndex, relativeTime }

// Near-cursor prefetch (YouTube-buffering-style): a dedicated persistent
// worker builds not-yet-visited battles' indexes ahead of the playback
// cursor, so playbackWorker's own self-healing replay_ensure_battle_ready
// call is a cheap no-op by the time the user actually gets there instead of
// paying the one-time index-build cost live. See replay-worker.js's
// 'prefetch' role and replay_worker.c's replay_prefetch_battle(). Purely a
// latency optimization - fetch_positions() is self-healing regardless, so
// nothing here is required for correctness, only for hiding the cold-open
// cost before the cursor arrives.
const PREFETCH_THREAD_ID = 9; // must match WASM_PREFETCH_THREAD_ID in wasm_layout.h
let prefetchWorker = null;
// `prefetchWorker` is assigned synchronously in startPrefetchWorker() (new
// Worker(...) returns immediately), but the worker itself is still mid
// bootstrap()  - awaiting its own OPFS handles, then WebAssembly.instantiate -
// for a while after that. schedulePrefetch() is also called from the 'frame'
// handler below, which fires on essentially every animation frame during
// normal playback - so `!prefetchWorker` alone as a readiness check has a
// real window where a 'frame' response races the worker's own 'ready' and
// posts 'prefetchBattle' before `instance` is set, crashing the worker
// (instance.exports throws on null - surfaced as "[Prefetch Worker Error]
// Cannot read properties of null (reading 'exports')" / Firefox's "can't
// access property 'exports', instance is null" in the system log). Track
// readiness explicitly instead of inferring it from worker-object truthiness.
let prefetchWorkerReady = false;
let prefetchInFlight = false;
let prefetchedBattles = new Set(); // bounds computed (read-only, off playbackWorker)

// Priming is the other half: replay_prefetch_battle() only computes a
// battle's rowid bounds - actually building its index is a WRITE, and
// SQLite's rollback-journal locking only ever lets ONE connection hold that
// role (see the comment on replay_prefetch_battle in replay_worker.c), so it
// has to happen on playbackWorker itself. Sent only once a battle's bounds
// are already known (so playbackWorker's own call skips straight to the
// index build) and only when playbackWorker has no frame request in flight -
// still a visible one-time cost when it runs, but 1-2 battles ahead of the
// cursor instead of exactly when the user arrives.
let primingInFlight = false;
let primedBattles = new Set();

// Battles replay_try_prime_battle() (replay_worker.c) has told us aren't
// worth proactively evicting-for-and-priming right now (see its own
// comment) - pickPrimeTarget() below skips these like an already-primed
// target, otherwise the scheduler would busy-loop re-requesting the same
// declined target every tick. Cleared whenever the ready-battle set
// actually changes (resyncLoadState) - if an eviction happened, a
// previously-declined target might be worth reconsidering now.
let declinedPrimingBattles = new Set();

const glObjects = { programs: [], shaders: [], buffers: [], uniforms: [] };

// Resolves once any in-flight worker teardown from a previous
// triggerReset() has actually finished closing its OPFS handles.
// startReplayLoad()/beginBattleFileWorkerLoad() chain off this before
// spawning the next load's workers - otherwise a fast reset-then-reload
// (or export-then-reload) could still start the new load's
// createSyncAccessHandle() calls before the old ones finish closing,
// recreating the exact race gracefulTerminateWorker exists to close.
let pendingWorkerTeardown = Promise.resolve();

// Every replay-worker.js instance (any role) opens its own
// FileSystemSyncAccessHandle on the shared, fixed-name OPFS file backing
// the loaded replay (see replay-worker.js's OPFS_MAIN_DB_NAME comment).
// Worker.terminate() does NOT guarantee that lock is released before it
// returns - release-on-termination is implementation-timing-dependent, not
// spec-guaranteed - so a fast reset-then-reload could have the NEW worker's
// createSyncAccessHandle() on that same filename race the OLD worker's not-
// yet-finished teardown and fail with NoModificationAllowedError ("No
// modification allowed"). Ask the worker to close its own handles first
// (deterministic, spec-guaranteed) and wait for it to confirm before
// terminating - the setTimeout is only a safety net for a hung/crashed
// worker that never acks, not the normal path.
function gracefulTerminateWorker(worker, timeoutMs) {
    return new Promise((resolve) => {
        if (!worker) { resolve(); return; }
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
            resolve();
        };
        worker.onmessage = (e) => {
            if (e.data && e.data.type === 'shutdownComplete') finish();
        };
        worker.onerror = finish;
        worker.postMessage({ type: 'shutdown' });
        setTimeout(finish, timeoutMs || 2000);
    });
}

function triggerReset() {
    document.getElementById('file-input').value = "";
    uploadOverlay.style.display = 'flex';
    document.getElementById('hamburger-container').style.display = 'none';
    closeMainMenu();
    resetBtn.style.display = 'none';
    document.getElementById('export-btn').style.display = 'none';
    removeTimelineUI();
    currentSimulationState = "AWAITING_FILE";

    const outgoingPlayback = playbackWorker;
    const outgoingPrefetch = prefetchWorker;
    playbackWorker = null;
    prefetchWorker = null;
    prefetchWorkerReady = false;
    pendingWorkerTeardown = Promise.all([
        gracefulTerminateWorker(outgoingPlayback),
        gracefulTerminateWorker(outgoingPrefetch),
    ]).then(() => {
        appendToConsoleLog("[System] Previous session's workers released.");
    });
    prefetchedBattles = new Set();
    prefetchInFlight = false;
    primedBattles = new Set();
    primingInFlight = false;
    declinedPrimingBattles = new Set();
    sharedMemory = null;
    matches = [];
    timelineLoadBars = [];
    latestFrame = null;
    // A frame request can genuinely be in flight to the outgoing
    // playbackWorker right when reset happens (the render loop posts one on
    // essentially every animation frame - see the 'loop' function far below)
    // - that worker is going away and will never send the matching 'frame'
    // response back (the only other place this flips false, ~line 946).
    // Left set, this permanently wedges the render loop's `if
    // (!pendingFrameRequest)` gate shut for the NEXT load too: no frame
    // ever gets requested again, so latestFrame never updates again either.
    // Confirmed via testdata/ui_behavior_tests.js's rapid reset->reload
    // check, which reproduces this reliably (a fresh load's own render loop
    // ticks fast enough that a request is almost always in flight the
    // instant a reset fires).
    pendingFrameRequest = false;

    document.getElementById('chat-content').innerHTML = '<div>System: Chat initialized...</div>';
    appendToConsoleLog("[System] Reset complete. Select a new sqlite database.");
}

// Hamburger menu (replaces the old always-floating #reset-btn/#export-btn
// corner buttons - see main.css's #hamburger-container comment for why).
function toggleMainMenu(event) {
    event.stopPropagation(); // don't let the outside-click listener below immediately re-close it
    document.getElementById('main-menu').classList.toggle('open');
}

function closeMainMenu() {
    document.getElementById('main-menu').classList.remove('open');
}

// Backs the hamburger menu's Panels checkboxes (main.html's
// #menu-panels-section, debug-mode only). One-directional: the checkbox
// drives the panel, nothing else hides/shows these panels after the initial
// DEBUG_MODE default above, so there's no state to keep in sync the other way.
//
// Every checked-on panel spawns top-right, staggered by how many of the
// other toggleable panels are already visible at that moment - so checking
// two or three of these at once doesn't pile them on top of each other, and
// re-checking one you'd previously dragged elsewhere brings it back
// somewhere findable instead of leaving it wherever it was hidden.
const TOGGLEABLE_PANEL_IDS = ['log-box', 'debug-panel', 'sql-terminal-panel'];
function setPanelVisible(panelId, visible) {
    const panel = document.getElementById(panelId);
    if (visible) {
        const alreadyVisible = TOGGLEABLE_PANEL_IDS.filter(
            (id) => id !== panelId && getComputedStyle(document.getElementById(id)).display !== 'none'
        ).length;
        const offset = alreadyVisible * 30;
        panel.style.top = (20 + offset) + 'px';
        panel.style.right = (20 + offset) + 'px';
        panel.style.left = 'auto';
        panel.style.bottom = 'auto';
        panel.style.zIndex = String(++panelZIndexCounter); // bring the newly-shown panel to front too
    }
    panel.style.display = visible ? 'flex' : 'none';
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('main-menu');
    if (menu.classList.contains('open') && !document.getElementById('hamburger-container').contains(e.target)) {
        closeMainMenu();
    }
});

function toggleMinimize(contentId) {
    const panel = document.getElementById(contentId).parentElement;
    panel.classList.toggle('minimized');
    const minimized = panel.classList.contains('minimized');

    const icon = panel.querySelector('.toggle-icon');
    icon.innerText = minimized ? '+' : '-';

    // Chat's #chat-content has its own higher max-height (main.css, 400px
    // instead of the shared 150px) so it can actually visibly grow with
    // messages - an ID selector, which normal CSS specificity rules say
    // should still correctly yield to .minimized's collapse-to-0 rule when
    // minimized. In practice that didn't reliably happen (confirmed via
    // direct getComputedStyle inspection - the 400px value kept winning
    // regardless of selector specificity once real chat content/transitions
    // had been through a few cycles, for reasons that didn't resolve under
    // investigation). Setting it inline sidesteps the question entirely:
    // an inline style always wins over any stylesheet selector, full stop,
    // so this is unambiguous by construction rather than depending on
    // cascade behavior that proved unreliable here.
    if (contentId === 'chat-content') {
        document.getElementById('chat-content').style.maxHeight = minimized ? '0px' : '400px';
    }
}

// Panels (chat/log/VFS-trace/SQL-terminal) used to have fixed positions the
// app tried to keep from overlapping (a stacking container, individually
// hand-picked corners, etc.) - that approach kept needing revisiting every
// time a new panel showed up. Dragging is the actual fix: the user resolves
// any overlap themselves, once, by moving the panel where they want it.
// Attaches to a panel's .panel-header - mousedown-and-move repositions the
// panel (converting its CSS anchor from right/bottom to left/top, in
// viewport pixels, clamped so the header can't be dragged fully offscreen);
// a plain click with no real movement still toggles minimize, exactly like
// the inline onclick this replaces used to (see main.html, which no longer
// sets onclick on these headers directly).
let panelZIndexCounter = 11; // one above .ui-panel's base z-index:10
function makeDraggable(panelId, contentId) {
    const panel = document.getElementById(panelId);
    const header = panel.querySelector('.panel-header');
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // left button only
        dragging = true;
        moved = false;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        e.preventDefault(); // avoid text selection while dragging
    });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            moved = true;
            panel.style.zIndex = String(++panelZIndexCounter); // bring to front once a real drag starts
        }
        if (!moved) return;
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - header.offsetHeight);
        const newTop = Math.max(0, Math.min(maxTop, startTop + dy));
        panel.style.left = Math.max(0, Math.min(maxLeft, startLeft + dx)) + 'px';
        panel.style.top = newTop + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        // Chat is bottom-anchored (see reanchorChatBottom below) - keep
        // future growth/minimize anchored to wherever the user just dragged
        // it to, instead of snapping back to the original bottom:110px spot
        // the next time a message arrives.
        if (panelId === 'chat-box') chatBottomAnchor = newTop + panel.offsetHeight;
    });

    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        if (!moved) toggleMinimize(contentId); // plain click - same as the old onclick
    });
}

makeDraggable('chat-box', 'chat-content');
makeDraggable('log-box', 'log-content');
makeDraggable('debug-panel', 'debug-content');
makeDraggable('sql-terminal-panel', 'sql-terminal-content');

// Chat sits right above the timeline and should always grow/shrink from
// that fixed bottom edge - new messages push it taller upward, minimizing
// collapses it back down toward the same bottom edge - never the reverse.
// Plain CSS `bottom:` (main.css's default) gives this for free ONLY until
// the panel's `top`/`left` get set explicitly, which makeDraggable's drag
// handler above does the moment the user drags it even once; after that,
// height changes would anchor from the (now-fixed) top instead, growing
// the wrong direction. So the desired bottom Y is tracked explicitly here
// instead, and reapplied via ResizeObserver - which fires on every actual
// rendered size change, for ANY reason (a message appended, minimize/
// maximize's own 0.2s CSS transition animating frame by frame, a future
// unrelated content change) - rather than hand-wiring every individual
// call site that could change the panel's height and hoping none are missed.
let chatBottomAnchor = null;
function reanchorChatBottom() {
    if (chatBottomAnchor === null) return;
    const panel = document.getElementById('chat-box');
    if (getComputedStyle(panel).display === 'none') return;
    panel.style.top = (chatBottomAnchor - panel.getBoundingClientRect().height) + 'px';
    panel.style.bottom = 'auto';
}
{
    const chatPanel = document.getElementById('chat-box');
    chatBottomAnchor = chatPanel.getBoundingClientRect().bottom; // starts from the CSS default (bottom:110px)
    reanchorChatBottom(); // convert to explicit top immediately - consistent from the very first render, not just after the first resize
    new ResizeObserver(reanchorChatBottom).observe(chatPanel);
}

function appendToConsoleLog(message) {
    if (!DEBUG_MODE) return; // system log is debug-only, see DEBUG_MODE above
    activeLogs.push(message);
    if (activeLogs.length > 5) activeLogs.shift();
    logContent.innerText = activeLogs.join('\n');
}

function getString(charPtr) {
    const memory = new Uint8Array(wasmInstance.exports.memory.buffer);
    let str = "";
    let ptr = charPtr;
    while (memory[ptr] !== 0) {
        str += String.fromCharCode(memory[ptr]);
        ptr++;
    }
    return str;
}

function writeStringToWasm(str, targetPtr) {
    const bytes = new TextEncoder().encode(str + '\0');
    const heap = new Uint8Array(wasmInstance.exports.memory.buffer);
    heap.set(bytes, targetPtr);
}

// main.wasm's import object - the WebGL binding shim, and only that. This
// module never touches the database; it just renders whatever position/team
// snapshot ends up in agent_buffer each frame.
const importObject = {
    env: {
        js_sin: Math.sin, js_cos: Math.cos, js_sqrt: Math.sqrt,
        js_print_string: console.log,
        js_log_string: (charPtr) => appendToConsoleLog(getString(charPtr)),
        gl_clear_color: (r, g, b, a) => gl.clearColor(r, g, b, a),
        gl_clear: (mask) => gl.clear(mask),
        gl_create_shader: (type) => { glObjects.shaders.push(gl.createShader(type)); return glObjects.shaders.length - 1; },
        gl_shader_source: (idx, srcPtr) => gl.shaderSource(glObjects.shaders[idx], getString(srcPtr)),
        gl_compile_shader: (idx) => gl.compileShader(glObjects.shaders[idx]),
        gl_create_program: () => { glObjects.programs.push(gl.createProgram()); return glObjects.programs.length - 1; },
        gl_attach_shader: (progIdx, shaderIdx) => gl.attachShader(glObjects.programs[progIdx], glObjects.shaders[shaderIdx]),
        gl_link_program: (progIdx) => gl.linkProgram(glObjects.programs[progIdx]),
        gl_use_program: (progIdx) => gl.useProgram(glObjects.programs[progIdx]),
        gl_get_uniform_location: (progIdx, namePtr) => {
            glObjects.uniforms.push(gl.getUniformLocation(glObjects.programs[progIdx], getString(namePtr)));
            return glObjects.uniforms.length - 1;
        },
        gl_get_attrib_location: (progIdx, namePtr) => gl.getAttribLocation(glObjects.programs[progIdx], getString(namePtr)),
        gl_create_buffer: () => { glObjects.buffers.push(gl.createBuffer()); return glObjects.buffers.length - 1; },
        gl_bind_buffer: (target, bufIdx) => gl.bindBuffer(target, glObjects.buffers[bufIdx]),
        gl_buffer_data: (target, dataPtr, numBytes, usage) => {
            const dataView = new Float32Array(wasmInstance.exports.memory.buffer, dataPtr, numBytes / 4);
            gl.bufferData(target, dataView, usage);
        },
        gl_enable_vertex_attrib_array: (index) => gl.enableVertexAttribArray(index),
        gl_vertex_attrib_pointer: (idx, size, type, norm, stride, offset) => gl.vertexAttribPointer(idx, size, type, norm, stride, offset),
        gl_uniform1f: (uLocIdx, x) => gl.uniform1f(glObjects.uniforms[uLocIdx], x),
        gl_uniform2f: (uLocIdx, x, y) => gl.uniform2f(glObjects.uniforms[uLocIdx], x, y),
        gl_uniform3f: (uLocIdx, r, g, b) => gl.uniform3f(glObjects.uniforms[uLocIdx], r, g, b),
        gl_uniform_matrix4fv: (uLocIdx, matPtr) => {
            const matrix = new Float32Array(wasmInstance.exports.memory.buffer, matPtr, 16);
            gl.uniformMatrix4fv(glObjects.uniforms[uLocIdx], false, matrix);
        },
        gl_draw_arrays: (mode, first, count) => gl.drawArrays(mode, first, count),
        gl_viewport: (x, y, w, h) => gl.viewport(x, y, w, h)
    }
};

function handleResize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (wasmInstance) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        wasmInstance.exports.set_screen_dimensions(canvas.width, canvas.height);
    }
}
window.addEventListener('resize', handleResize);

// ---- Timeline UI - driven by the small `matches` summary array the loader
// worker sends once, plus the live replayTime/latestFrame state. No per-tick
// JS bookkeeping. ----

function createTimelineUI() {
    removeTimelineUI();

    const container = document.createElement('div');
    container.id = 'timeline-container';
    container.style.position = 'absolute';
    container.style.bottom = '20px';
    container.style.left = '20px';
    container.style.right = '20px';
    container.style.background = 'rgba(10, 10, 10, 0.95)';
    container.style.border = '1px solid #333';
    container.style.borderRadius = '8px';
    container.style.padding = '14px 20px';
    container.style.zIndex = '8';
    container.style.fontFamily = 'monospace';
    container.style.color = '#fff';
    container.style.boxShadow = '0 4px 20px rgba(0,0,0,0.8)';

    const infoRow = document.createElement('div');
    infoRow.style.display = 'flex';
    infoRow.style.justifyContent = 'space-between';
    infoRow.style.alignItems = 'center';
    infoRow.style.marginBottom = '12px';
    infoRow.style.fontSize = '12px';

    const matchDetails = document.createElement('div');
    matchDetails.id = 'tl-match-details';
    matchDetails.style.color = '#00ff00';
    matchDetails.style.fontWeight = 'bold';
    matchDetails.innerText = 'Initializing matches...';

    const timeDisplay = document.createElement('div');
    timeDisplay.id = 'tl-time-display';
    timeDisplay.style.color = '#888';
    timeDisplay.innerText = 'Frame: 0 / 0';

    // Export Battle is now the static #export-btn in main.html, docked under
    // #reset-btn - not created here anymore (see finishLoadAndStartPlayback/
    // triggerReset for its show/hide, matching #reset-btn's own lifecycle).

    infoRow.appendChild(matchDetails);
    infoRow.appendChild(timeDisplay);

    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.alignItems = 'center';
    controlsRow.style.gap = '15px';

    const playBtn = document.createElement('button');
    playBtn.id = 'tl-play-btn';
    playBtn.innerText = 'Pause';
    playBtn.style.background = '#1a1a1a';
    playBtn.style.color = '#00ff00';
    playBtn.style.border = '1px solid #00ff00';
    playBtn.style.padding = '6px 16px';
    playBtn.style.borderRadius = '4px';
    playBtn.style.cursor = 'pointer';
    playBtn.style.fontWeight = 'bold';
    playBtn.style.transition = 'all 0.1s';
    // "Play" and "Pause" are different lengths - without a fixed width the
    // button visibly resizes (and everything to its right in controlsRow
    // shifts) every single toggle. minWidth sized for the longer label
    // ("Pause"), textAlign keeps the shorter one centered rather than
    // hugging the left edge once there's slack.
    playBtn.style.minWidth = '76px';
    playBtn.style.textAlign = 'center';
    playBtn.onclick = () => {
        isPaused = !isPaused;
        playBtn.innerText = isPaused ? 'Play' : 'Pause';
        playBtn.style.color = isPaused ? '#ffaa00' : '#00ff00';
        playBtn.style.borderColor = isPaused ? '#ffaa00' : '#00ff00';
    };

    const speedSelect = document.createElement('select');
    speedSelect.style.background = '#1a1a1a';
    speedSelect.style.color = '#fff';
    speedSelect.style.border = '1px solid #333';
    speedSelect.style.padding = '5px 10px';
    speedSelect.style.borderRadius = '4px';
    speedSelect.style.cursor = 'pointer';
    [0.5, 1.0, 1.5, 2.0, 4.0, 8.0].forEach(sp => {
        const opt = document.createElement('option');
        opt.value = sp;
        opt.innerText = sp + 'x Speed';
        if (sp === 1.0) opt.selected = true;
        speedSelect.appendChild(opt);
    });
    speedSelect.onchange = (e) => {
        playbackSpeed = parseFloat(e.target.value);
    };

    const trackWrapper = document.createElement('div');
    trackWrapper.style.position = 'relative';
    trackWrapper.style.flexGrow = '1';
    trackWrapper.style.height = '24px';
    trackWrapper.style.background = '#141414';
    trackWrapper.style.borderRadius = '4px';
    trackWrapper.style.border = '1px solid #222';
    trackWrapper.style.overflow = 'hidden';

    const totalSpan = Math.max(1e-6, totalEndTime - totalStartTime);
    timelineLoadBars = [];
    matches.forEach((m, idx) => {
        const startPct = ((m.startTime - totalStartTime) / totalSpan) * 100;
        const widthPct = ((m.endTime - m.startTime) / totalSpan) * 100;

        const block = document.createElement('div');
        block.style.position = 'absolute';
        block.style.left = startPct + '%';
        block.style.width = widthPct + '%';
        block.style.height = '100%';
        block.style.background = idx % 2 === 0 ? 'rgba(0, 150, 255, 0.12)' : 'rgba(0, 255, 150, 0.08)';
        block.style.borderLeft = '2px solid #00ff00';
        block.style.cursor = 'pointer';
        block.title = `Jump to Match #${idx + 1} (Scene: ${m.sceneNo}, Factions: ${m.faction})`;
        block.onclick = (e) => {
            e.stopPropagation();
            seekTo(m.startTime);
        };

        // YouTube-style buffered indicator: a thin bar along the bottom of
        // this battle's block, brightness reflecting how "loaded" it is -
        // see updateLoadIndicators(). Purely visual, driven by the same
        // prefetchedBattles/primedBattles state the prefetch orchestration
        // (schedulePrefetch/schedulePriming) already tracks.
        const loadBar = document.createElement('div');
        loadBar.style.position = 'absolute';
        loadBar.style.bottom = '0';
        loadBar.style.left = '0';
        loadBar.style.width = '100%';
        loadBar.style.height = '3px';
        loadBar.style.background = 'transparent';
        loadBar.style.pointerEvents = 'none';
        block.appendChild(loadBar);
        timelineLoadBars[idx] = loadBar;

        trackWrapper.appendChild(block);
    });
    updateLoadIndicators();

    const slider = document.createElement('input');
    slider.id = 'tl-slider';
    slider.type = 'range';
    slider.min = totalStartTime.toString();
    slider.max = totalEndTime.toString();
    slider.step = "0.01";
    slider.value = totalStartTime.toString();
    slider.style.position = 'absolute';
    slider.style.top = '0';
    slider.style.left = '0';
    slider.style.width = '100%';
    slider.style.height = '100%';
    slider.style.margin = '0';
    slider.style.background = 'transparent';
    slider.style.outline = 'none';
    slider.style.cursor = 'pointer';
    slider.style.opacity = '0.95';
    slider.oninput = (e) => {
        seekTo(parseFloat(e.target.value));
    };

    trackWrapper.appendChild(slider);

    controlsRow.appendChild(playBtn);
    controlsRow.appendChild(speedSelect);
    controlsRow.appendChild(trackWrapper);

    container.appendChild(infoRow);
    container.appendChild(controlsRow);
    document.body.appendChild(container);
}

function removeTimelineUI() {
    const el = document.getElementById('timeline-container');
    if (el) el.remove();
}

// ---- Battle export (Phase 4) ----

let exportMatchIdxInFlight = -1;

function resetExportButton() {
    exportInFlight = false;
    const btn = document.getElementById('export-btn');
    if (btn) { btn.disabled = false; btn.innerText = 'Export Battle'; }
}

function exportActiveBattle() {
    if (exportInFlight) return;
    if (!playbackWorker || !latestFrame || latestFrame.activeMatchIndex < 0) {
        alert('No active battle to export - seek into a battle first.');
        return;
    }
    exportInFlight = true;
    exportMatchIdxInFlight = latestFrame.activeMatchIndex;
    const btn = document.getElementById('export-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Exporting...'; }
    // replay-worker.js's runExportBattle() supplies the real Unix-epoch
    // timestamp for manifest.json's generated_at_unix field internally
    // (replay_worker.wasm's only clock_gettime() import is performance.now()-
    // based, not wall-clock - see replay-worker.js) - nothing extra to send here.
    playbackWorker.postMessage({ type: 'exportBattle', matchIdx: exportMatchIdxInFlight });
}

function getOrCreateCompressWorker() {
    if (compressWorker) return compressWorker;
    compressWorker = new Worker('compress-worker.js?v=' + Date.now());
    compressWorker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'compressed') {
            finishExportDownload(d.out);
        } else if (d.type === 'error') {
            appendToConsoleLog('[Export] compression failed: ' + d.message);
            alert('Battle export failed during compression: ' + d.message);
            resetExportButton();
        }
        // 'compressProgress' ignored for now - a progress bar could read it later
    };
    return compressWorker;
}

// Phase 6: same navigator.deviceMemory tiering as computeReaderCount() above,
// applied to the LZMA dictionary size instead of Worker count - a bigger
// dictionary means more compression-time RAM (LZmaEnc's match-finder hash
// tables scale with it), which matters during export/derivation the same
// way it matters during playback. 24MiB is the existing capable-device
// default (a single battle's export is bounded - tens of MB, not 20GB - so
// even the "moderate" tier already captures most of the same redundancy a
// much bigger dictionary would, per the plan's extreme-compression-vs-128MB
// tradeoff note); constrained devices get progressively smaller.
function computeDictSizeMiB() {
    const mem = navigator.deviceMemory;
    if (mem === undefined) return 24;
    if (mem <= 1) return 4;
    if (mem <= 2) return 8;
    if (mem <= 4) return 16;
    return 24;
}

// Applied to the playback thread's own SQLite per-battle-index memory
// (replay_worker.c's g_priming_budget_bytes) - the soft ceiling
// replay_ensure_battle_ready()/replay_try_prime_battle() weigh against
// before building a new battle's index, evicting a farther-away one first
// if already over it. A ?primingBudgetMiB=N URL param overrides this for
// manual repro/testing without needing a real file large enough to exhaust
// memory organically - see testdata/ui_behavior_tests.js.
//
// Deliberately NOT the same small navigator.deviceMemory tiers
// computeReaderCount()/computeDictSizeMiB() use above (originally copied
// from there, then found - via a real multi-battle file that only reached
// 128MiB of committed-and-never-evicted-let-alone-real-need before
// plateauing, "using all available memory" it was not - deviceMemory
// reports at most 8 REGARDLESS of actual RAM, by spec, for fingerprinting
// resistance: a 64GB desktop and an 8GB one both report "8" and would get
// the identical, needlessly tiny budget). The point of this feature is to
// use memory that's actually available, evicting only once genuinely
// running low - not to impose an arbitrary low ceiling most machines never
// come close to needing. So the generous tier here targets a fraction of
// the REAL hard ceiling (WASM_MEMORY_MAX_PAGES, 2GiB) instead: most of it,
// leaving enough headroom below that ceiling for what else shares the same
// WebAssembly.Memory - up to 8 reader threads, the prefetch thread, fixed
// stack/TLS pools, and SQLite's own non-index working memory. Only devices
// deviceMemory can positively identify as constrained (<=4, still a
// meaningful signal at the low end even though it's meaningless at the
// high end) get a smaller cap, sized to not risk crashing the whole tab.
function computePrimingBudgetBytes() {
    const override = new URLSearchParams(location.search).get('primingBudgetMiB');
    if (override !== null) return parseInt(override, 10) * 1024 * 1024;
    const mem = navigator.deviceMemory;
    let mib;
    if (mem !== undefined && mem <= 1) mib = 128;
    else if (mem !== undefined && mem <= 2) mib = 384;
    else if (mem !== undefined && mem <= 4) mib = 768;
    else mib = 1536; // undefined (Firefox/Safari - could be any real desktop) or deviceMemory's own 8GB-and-up ceiling
    return mib * 1024 * 1024;
}

function handleExportedTar(matchIdx, tarBytes) {
    const dictSizeMiB = computeDictSizeMiB();
    appendToConsoleLog(`[Export] battle #${matchIdx + 1} raw tar: ${tarBytes.length} bytes, compressing (dict=${dictSizeMiB}MiB)...`);
    const worker = getOrCreateCompressWorker();
    worker.postMessage({ type: 'compress', data: tarBytes, dictSizeMiB }, [tarBytes.buffer]);
}

function finishExportDownload(compressedBytes) {
    const idx = exportMatchIdxInFlight;
    const m = matches[idx];
    const safeFaction = (m ? m.faction : 'battle').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    const filename = `battle_${idx + 1}_${safeFaction}.tar.xz`;
    const blob = new Blob([compressedBytes], { type: 'application/x-xz' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    appendToConsoleLog(`[Export] battle #${idx + 1} exported: ${compressedBytes.length} bytes -> ${filename}`);
    resetExportButton();
}

function seekTo(t) {
    replayTime = t;
    const slider = document.getElementById('tl-slider');
    if (slider) slider.value = replayTime.toString();
    if (playbackWorker && !pendingFrameRequest) {
        pendingFrameRequest = true;
        playbackWorker.postMessage({ type: 'frame', time: replayTime, seek: true });
    }
}

function updateSliderPosition() {
    const timeDisplay = document.getElementById('tl-time-display');
    const matchDetails = document.getElementById('tl-match-details');
    if (!latestFrame) return;

    const activeMatchIdx = latestFrame.activeMatchIndex;

    if (timeDisplay) {
        timeDisplay.innerText = `Time: +${latestFrame.relativeTime.toFixed(2)}s`;
    }
    if (matchDetails) {
        if (activeMatchIdx >= 0 && activeMatchIdx < matches.length) {
            const m = matches[activeMatchIdx];
            matchDetails.innerText = `MATCH #${activeMatchIdx + 1} | Scene: ${m.sceneNo} | Factions: ${m.faction}`;
        } else {
            matchDetails.innerText = 'Out of match boundaries';
        }
    }
}

function appendChatToUI(chat) {
    const chatContent = document.getElementById('chat-content');
    if (!chatContent) return;

    // Only follow new messages down if the user was already at (or very
    // near) the bottom - otherwise they're reading back through history,
    // and yanking their scroll position to the newest message on every
    // arrival makes that unreadable. Measured BEFORE appending, since
    // appending changes scrollHeight.
    const NEAR_BOTTOM_PX = 24;
    const wasNearBottom = chatContent.scrollHeight - chatContent.scrollTop - chatContent.clientHeight <= NEAR_BOTTOM_PX;

    const msgDiv = document.createElement('div');
    msgDiv.style.marginBottom = '5px';
    msgDiv.style.wordBreak = 'break-word';

    let color = '#00ff00';
    if (chat.team === 0) color = '#ff5151';
    else if (chat.team === 1) color = '#51adff';

    msgDiv.innerHTML = `<span style="color: ${color}; font-weight: bold;">${chat.username}</span>: <span style="color: #e0e0e0;">${chat.message}</span>`;
    chatContent.appendChild(msgDiv);
    // Cap history so the panel doesn't grow unbounded over a long session.
    while (chatContent.children.length > 40) chatContent.removeChild(chatContent.firstChild);
    if (wasNearBottom) chatContent.scrollTop = chatContent.scrollHeight;
}

// ---- Near-cursor prefetch orchestration ----

function matchIndexForTime(t) {
    for (let i = 0; i < matches.length; i++) {
        if (t >= matches[i].startTime && t <= matches[i].endTime) return i;
    }
    return -1;
}

// Priority order fans out from the cursor, forward-biased (playback usually
// moves forward): current+1, current-1, current+2, current-2, ... The
// currently-active battle itself is deliberately skipped - playbackWorker's
// own self-healing call already covers it on the very next frame request,
// same as a video player's initial buffer when you first press play.
function pickPrefetchTarget() {
    if (matches.length === 0) return -1;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    const base = current >= 0 ? current : 0;
    for (let d = 1; d < matches.length; d++) {
        const fwd = base + d;
        if (fwd < matches.length && !prefetchedBattles.has(fwd)) return fwd;
        const back = base - d;
        if (back >= 0 && !prefetchedBattles.has(back)) return back;
    }
    return -1;
}

function schedulePrefetch() {
    if (!prefetchWorker || !prefetchWorkerReady || prefetchInFlight) return;
    const idx = pickPrefetchTarget();
    if (idx < 0) return; // every battle already prefetched (or none loaded yet) - idle
    prefetchInFlight = true;
    prefetchWorker.postMessage({
        type: 'prefetchBattle',
        matchIdx: idx,
        startTickId: matches[idx].startTickId,
        endTickId: matches[idx].endTickId,
    });
}

function startPrefetchWorker() {
    prefetchWorkerReady = false;
    prefetchWorker = new Worker(WORKER_SCRIPT_URL);
    prefetchWorker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') {
            prefetchWorkerReady = true;
            schedulePrefetch();
        } else if (d.type === 'prefetched') {
            prefetchedBattles.add(d.matchIdx);
            prefetchInFlight = false;
            updateLoadIndicators();
            schedulePrefetch(); // always re-target the current cursor, not a stale one
            schedulePriming();  // this battle's bounds are ready - eligible to prime now
        } else if (d.type === 'error') {
            appendToConsoleLog('[Prefetch Worker Error] ' + d.message);
            // best-effort only (see comment above prefetchWorker decl) - drop
            // this attempt and move on rather than getting stuck retrying.
            prefetchInFlight = false;
            schedulePrefetch();
        }
    };
    prefetchWorker.postMessage({ type: 'init', role: 'prefetch', memory: sharedMemory, module: replayModule, threadId: PREFETCH_THREAD_ID });
}

// Same fan-out priority as pickPrefetchTarget, over every not-yet-primed
// battle - deliberately NOT gated on prefetchedBattles (bounds precomputed
// by the reader fan-out). That fan-out is a pure speed optimization: when it
// has already resolved a battle's rowid slice, replay_try_prime_battle()
// picks that up for free and skips straight to the index build; when it
// hasn't (either it hasn't gotten there yet, or - confirmed via real Firefox
// testing, see openSyncAccessHandleWithRetry's [OPFS DEBUG] logging in
// replay-worker.js - it can never succeed at all, because Firefox's OPFS
// won't grant a second concurrent handle on main.db while playbackWorker's
// is open), replay_try_prime_battle()/replay_ensure_battle_ready() resolve
// the bounds themselves on the fly (replay_worker.c:447-455), on the same
// connection that's already open and working. Gating priming eligibility on
// prefetchedBattles here was requiring an optimization's side effect as a
// correctness precondition - on a browser where that optimization can't run
// at all, it silently meant priming past the initially-active battle NEVER
// HAPPENED, no matter how much budget was available. Also skips anything
// replay_try_prime_battle() just declined (see declinedPrimingBattles) -
// re-requesting the identical target every tick with nothing having changed
// would just get declined again forever.
function pickPrimeTarget() {
    if (matches.length === 0) return -1;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    const base = current >= 0 ? current : 0;
    for (let d = 1; d < matches.length; d++) {
        const fwd = base + d;
        if (fwd < matches.length && !primedBattles.has(fwd) && !declinedPrimingBattles.has(fwd)) return fwd;
        const back = base - d;
        if (back >= 0 && !primedBattles.has(back) && !declinedPrimingBattles.has(back)) return back;
    }
    return -1;
}

function schedulePriming() {
    if (!playbackWorker || primingInFlight || pendingFrameRequest) return; // only when playbackWorker is truly idle
    const idx = pickPrimeTarget();
    if (idx < 0) return;
    primingInFlight = true;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    playbackWorker.postMessage({ type: 'primeBattle', matchIdx: idx, currentMatchIdx: current >= 0 ? current : 0 });
}

// YouTube-buffered-bar-style loading indicator, drawn along the bottom of
// each battle's timeline block: dim/transparent = not loaded at all, faint
// = bounds prefetched but index not built yet, bright = fully primed (an
// access to this battle would be instant). Called whenever prefetchedBattles/
// primedBattles change, and once from createTimelineUI() to paint the
// initial state.
function updateLoadIndicators() {
    for (let i = 0; i < timelineLoadBars.length; i++) {
        const bar = timelineLoadBars[i];
        if (!bar) continue;
        if (primedBattles.has(i)) {
            bar.style.background = 'rgba(255, 255, 255, 0.9)';
        } else if (prefetchedBattles.has(i)) {
            bar.style.background = 'rgba(255, 255, 255, 0.35)';
        } else {
            bar.style.background = 'transparent';
        }
    }
}

// Resyncs primedBattles against replay_get_battle_ready_mask()'s bitmask
// (sent on every 'frame'/'battlePrimed'/'primingDeclined' message) instead
// of trying to track individual evict events - a battle's bit can go from
// 1 back to 0 when replay_evict_battle() (replay_worker.c) drops its index
// to make room for another one, and diffing against the mask is what makes
// that visible here (its loading bar fading back down) without needing a
// dedicated "evicted" message that could lose an event if two evictions
// happened between messages (see replay_get_battle_ready_mask's comment in
// replay_worker.c for why a last-evicted scalar was rejected). Also clears
// declinedPrimingBattles whenever the ready set actually changes - an
// eviction may have made a previously-declined target worth reconsidering.
function resyncLoadState(readyMask) {
    if (readyMask === undefined) return; // older/unrelated message shapes - nothing to resync
    let changed = false;
    for (let i = 0; i < matches.length; i++) {
        const ready = (readyMask & (1 << i)) !== 0;
        if (ready === primedBattles.has(i)) continue;
        changed = true;
        if (ready) { primedBattles.add(i); prefetchedBattles.add(i); }
        else primedBattles.delete(i);
    }
    if (changed) {
        declinedPrimingBattles = new Set();
        updateLoadIndicators();
    }
}

// ---- Worker orchestration ----

function startReplayLoad(file) {
    uploadOverlay.style.display = 'none';
    loadingOverlay.style.display = 'flex';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').innerText = 'Starting worker pool...';

    sharedMemory = new WebAssembly.Memory({ initial: WASM_MEMORY_INITIAL_PAGES, maximum: WASM_MEMORY_MAX_PAGES, shared: true });

    pendingWorkerTeardown
        .then(() => fetch('replay_worker.wasm', { cache: 'no-store' }))
        .then(res => res.arrayBuffer())
        .then(WebAssembly.compile)
        .then(module => {
            replayModule = module;
            playbackWorker = new Worker(WORKER_SCRIPT_URL);
            playbackWorker.onmessage = onLoaderMessage;
            playbackWorker.onerror = (e) => {
                appendToConsoleLog('[Worker Error] ' + e.message);
            };
            playbackWorker.postMessage({ type: 'init', role: 'loader', memory: sharedMemory, module: replayModule, threadId: 0 });
            // 'ready' response triggers the actual load in onLoaderMessage.
            playbackWorker._pendingFile = file;
        })
        .catch(err => {
            alert("Failed to start replay engine: " + err.message);
            triggerReset();
        });
}

// Phase 5: load a previously-exported single battle's .tar.xz directly,
// skipping the full multi-battle scan_matches() path entirely - fetch the
// file's bytes, decompress via compress-worker.js (compress.wasm's xz
// decoder), extract replay.db out of the resulting ustar tar (parseTar,
// top of this file), then hand those bytes to a fresh loader worker via
// the 'loadBattleFile' message (replay-worker.js's runLoadBattleFile ->
// replay_finish_load_battle_file()). Reuses the exact same playbackWorker/
// onLoaderMessage 'loaded'-handling path startReplayLoad() does - the two
// only diverge in how the bytes reach the loader worker.
function startBattleFileLoad(file) {
    uploadOverlay.style.display = 'none';
    loadingOverlay.style.display = 'flex';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').innerText = 'Decompressing battle file...';

    file.arrayBuffer().then(buf => {
        const compressedBytes = new Uint8Array(buf);
        const decompressWorker = new Worker('compress-worker.js?v=' + Date.now());
        decompressWorker.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'decompressed') {
                decompressWorker.terminate();
                const entries = parseTar(d.out);
                const replayEntry = entries.find(en => en.name === 'replay.db');
                if (!replayEntry) {
                    alert('Battle file is missing replay.db - not a valid export from this app.');
                    triggerReset();
                    return;
                }
                beginBattleFileWorkerLoad(replayEntry.data.slice()); // detach from the shared tar buffer
            } else if (d.type === 'error') {
                decompressWorker.terminate();
                alert('Failed to decompress battle file: ' + d.message);
                triggerReset();
            }
        };
        decompressWorker.postMessage({ type: 'decompress', data: compressedBytes }, [compressedBytes.buffer]);
    }).catch(err => {
        alert('Failed to read battle file: ' + err.message);
        triggerReset();
    });
}

function beginBattleFileWorkerLoad(replayDbBytes) {
    document.getElementById('progress-text').innerText = 'Starting worker pool...';
    sharedMemory = new WebAssembly.Memory({ initial: WASM_MEMORY_INITIAL_PAGES, maximum: WASM_MEMORY_MAX_PAGES, shared: true });

    pendingWorkerTeardown
        .then(() => fetch('replay_worker.wasm', { cache: 'no-store' }))
        .then(res => res.arrayBuffer())
        .then(WebAssembly.compile)
        .then(module => {
            replayModule = module;
            playbackWorker = new Worker(WORKER_SCRIPT_URL);
            playbackWorker.onmessage = onLoaderMessage;
            playbackWorker.onerror = (e) => {
                appendToConsoleLog('[Worker Error] ' + e.message);
            };
            playbackWorker.postMessage({ type: 'init', role: 'loader', memory: sharedMemory, module: replayModule, threadId: 0 });
            // 'ready' response triggers the actual load in onLoaderMessage.
            playbackWorker._pendingBattleFileBytes = replayDbBytes;
        })
        .catch(err => {
            alert("Failed to start replay engine: " + err.message);
            triggerReset();
        });
}

function onLoaderMessage(e) {
    const d = e.data;
    switch (d.type) {
        case 'ready': {
            if (playbackWorker._pendingBattleFileBytes) {
                const bytes = playbackWorker._pendingBattleFileBytes;
                document.getElementById('progress-text').innerText = 'Streaming battle file into engine...';
                playbackWorker.postMessage({ type: 'loadBattleFile', replayDbBytes: bytes }, [bytes.buffer]);
            } else {
                const file = playbackWorker._pendingFile;
                document.getElementById('progress-text').innerText = 'Streaming file into engine...';
                playbackWorker.postMessage({ type: 'load', file });
            }
            break;
        }
        case 'progress': {
            const pct = d.total > 0 ? Math.round((d.loaded / d.total) * 100) : 0;
            document.getElementById('progress-fill').style.width = pct + '%';
            document.getElementById('progress-text').innerText = `Loading... ${pct}%`;
            break;
        }
        case 'loaded': {
            matches = d.matches;
            totalStartTime = d.totalStart;
            totalEndTime = d.totalEnd;
            // New phase, new bar - the fill was left at 100% from the byte-
            // streaming progress above, which would otherwise sit frozen
            // there (looking finished, or "fake") for however long the
            // parallel bounds computation below actually takes against a
            // multi-hundred-MB file - genuinely real, uneven time, not a
            // formality. Reset to 0% here and let startBoundsComputation's
            // reader-completion handler drive it back up for real.
            document.getElementById('progress-fill').style.width = '0%';
            document.getElementById('progress-text').innerText = `Computing map bounds (parallel)... 0/${READER_COUNT} readers done`;
            playbackWorker.postMessage({ type: 'setPrimingBudget', bytes: computePrimingBudgetBytes() });
            startBoundsComputation();
            // Delayed past the reader stagger window (startBoundsComputation
            // spaces up to READER_COUNT readers 25ms apart) rather than fired
            // in the same synchronous tick - this worker's own bootstrap()
            // opens an OPFS handle on the same file too, so starting it
            // right alongside the reader storm was part of the same Firefox
            // contention issue openSyncAccessHandleWithRetry/the reader
            // stagger above exist to address. Independent of bounds
            // computation otherwise - it doesn't need to wait for readers to
            // finish, just to not pile onto their handle-open burst.
            setTimeout(startPrefetchWorker, READER_COUNT * 25 + 50);
            break;
        }
        case 'boundsCombined': {
            wasmInstance.exports.set_map_bounds(d.minX, d.maxX, d.minY, d.maxY);
            finishLoadAndStartPlayback();
            break;
        }
        case 'frame': {
            pendingFrameRequest = false;
            latestFrame = { buffer: d.buffer, count: d.count, activeMatchIndex: d.activeMatchIndex, relativeTime: d.relativeTime };
            if (d.chatMessages && d.chatMessages.length) d.chatMessages.forEach(appendChatToUI);
            updateSliderPosition();
            // A battle can become ready without ever going through the
            // prefetch/prime pipeline - e.g. the very first battle on load,
            // or the user jumping straight to one (playbackWorker's own
            // self-healing call covers it live) - and, under a memory
            // budget, an access here can also EVICT a farther-away battle to
            // make room. readyMask is the source of truth for both:
            // resyncLoadState adds the just-readied active battle and drops
            // anything replay_ensure_battle_ready() had to sacrifice for it.
            resyncLoadState(d.readyMask);
            schedulePrefetch(); // re-target in case the cursor moved (playback, seek, or scrub)
            schedulePriming();  // playbackWorker is idle right now - a good moment to prime, if anything's eligible
            break;
        }
        case 'battlePrimed': {
            primingInFlight = false;
            resyncLoadState(d.readyMask);
            schedulePriming();
            break;
        }
        case 'primingDeclined': {
            // Budget's tight and this target wasn't worth evicting for
            // (replay_try_prime_battle in replay_worker.c) - "it should
            // stop" from the feature request. Don't re-request the same
            // target every tick; pickPrimeTarget() skips anything in here
            // until resyncLoadState sees the ready-set actually change.
            primingInFlight = false;
            resyncLoadState(d.readyMask);
            declinedPrimingBattles.add(d.matchIdx);
            break;
        }
        case 'exported': {
            handleExportedTar(d.matchIdx, d.tar);
            break;
        }
        case 'error': {
            appendToConsoleLog('[Replay Engine Error] ' + d.message);
            if (d.role === 'export') {
                alert('Battle export failed: ' + d.message);
                resetExportButton();
            } else if (currentSimulationState !== 'RUNNING') {
                alert('Failed to load replay: ' + d.message);
                triggerReset();
            } else {
                // A 'frame' or 'primeBattle' message against playbackWorker
                // threw (e.g. a transient SQLITE_BUSY racing the prefetch
                // connection's brief SHARED lock during heavy evict/rebuild
                // churn - see replay_prefetch_battle's comment in
                // replay_worker.c). replay-worker.js's outer catch reports
                // this as a generic {role: workerRole} error, not tagged
                // with which in-flight request caused it - so whichever of
                // pendingFrameRequest/primingInFlight is actually stuck
                // can't be identified here and must both be cleared
                // unconditionally, or the render loop's/schedulePriming's
                // own `if (!pendingFrameRequest)`/`if (!primingInFlight)`
                // gate never reopens and playback silently hangs forever.
                // Clearing the one that wasn't actually stuck is a harmless
                // no-op; leaving the real one stuck is not.
                pendingFrameRequest = false;
                primingInFlight = false;
            }
            break;
        }
        // Debug-only diagnostics - see DEBUG_MODE above and debugPanelOutput()
        // below. These four message types already existed in
        // replay-worker.js's protocol (used only by testdata/real_file_test.html
        // until now) - wiring them here is Phase 0's plumbing sanity check
        // before building the full SQL terminal on top in a later phase.
        case 'debugIndexVisible':
            debugPanelOutput(`idx_as_b${d.matchIdx} visible: ${d.result}`);
            break;
        case 'vfsTracesReset':
            debugPanelOutput('VFS traces reset.');
            break;
        case 'vfsTraces':
            debugPanelOutput(`lockTrace: ${d.lockTrace}\nioTrace: ${d.ioTrace}`);
            break;
        case 'lockCounters':
            debugPanelOutput(`sharedCount=${d.sharedCount} exclusiveKind=${d.exclusiveKind}`);
            break;
        case 'heapDebug':
            debugPanelOutput(`regionCount=${d.regionCount} extendFailures=${d.extendFailures} playbackHeapBytes=${d.playbackHeapBytes} battleReadyMask=${d.battleReadyMask} (0b${(d.battleReadyMask >>> 0).toString(2)}) lastError=${d.lastError}`);
            break;
        // Phase 5 SQL terminal - see sqlTerminalRun() and replay-worker.js's runSql()
        case 'sqlColumns':
            sqlTerminalOnColumns(d.columns);
            break;
        case 'sqlRows':
            sqlTerminalOnRows(d.rows);
            break;
        case 'sqlDone':
            sqlTerminalOnDone(d.rowCount);
            break;
        case 'sqlError':
            sqlTerminalOnError(d.message);
            break;
        case 'checkpointSaved':
            sqlTerminalOnCheckpointSaved(d.id);
            break;
        case 'checkpointReverted':
            document.getElementById('sql-terminal-status').innerText = `Reverted to checkpoint #${d.id}.`;
            break;
        case 'checkpointError':
            document.getElementById('sql-terminal-status').innerText = 'Checkpoint error: ' + d.message;
            break;
    }
}

// ---- SQL debug terminal (DEBUG_MODE only, Phase 5) ----
// Rows stream in from replay-worker.js's runSql() in bounded batches
// (sqlRows) - appended straight into the <tbody> as they arrive rather than
// buffered in a JS array first, so a large result set doesn't hold two
// copies of itself in memory (one in JS, one in the DOM) at once.

let sqlResultColumns = [];
let sqlResultRowCount = 0;

function sqlTerminalRun() {
    if (!playbackWorker) return;
    const sql = document.getElementById('sql-terminal-input').value;
    if (!sql.trim()) return;
    document.getElementById('sql-terminal-status').innerText = 'Running...';
    document.getElementById('sql-terminal-results').innerHTML = '';
    sqlResultColumns = [];
    sqlResultRowCount = 0;
    playbackWorker.postMessage({ type: 'runSql', sql });
}

function sqlTerminalOnColumns(columns) {
    sqlResultColumns = columns;
    const container = document.getElementById('sql-terminal-results');
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const col of columns) {
        const th = document.createElement('th');
        th.textContent = col;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    tbody.id = 'sql-terminal-tbody';
    table.appendChild(tbody);
    container.appendChild(table);
}

function sqlTerminalOnRows(rows) {
    const tbody = document.getElementById('sql-terminal-tbody');
    if (!tbody) return;
    const frag = document.createDocumentFragment();
    for (const row of rows) {
        const tr = document.createElement('tr');
        for (const val of row) {
            const td = document.createElement('td');
            td.textContent = val === null ? 'NULL' : val;
            tr.appendChild(td);
        }
        frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    sqlResultRowCount += rows.length;
}

function sqlTerminalOnDone(rowCount) {
    document.getElementById('sql-terminal-status').innerText =
        sqlResultColumns.length > 0 ? `${rowCount} row(s), ${sqlResultColumns.length} column(s).` : 'OK (no result set).';
}

function sqlTerminalOnError(message) {
    document.getElementById('sql-terminal-status').innerText = 'Error: ' + message;
}

function sqlTerminalCheckpointSave() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'checkpointSave' });
}

function sqlTerminalOnCheckpointSaved(id) {
    const select = document.getElementById('sql-terminal-checkpoints');
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `#${id}`;
    select.appendChild(opt);
    select.value = id;
    document.getElementById('sql-terminal-status').innerText = `Saved checkpoint #${id}.`;
}

function sqlTerminalCheckpointRevert() {
    if (!playbackWorker) return;
    const select = document.getElementById('sql-terminal-checkpoints');
    const id = parseInt(select.value, 10);
    if (!id) { document.getElementById('sql-terminal-status').innerText = 'No checkpoint selected.'; return; }
    playbackWorker.postMessage({ type: 'checkpointRevert', id });
}

// Pushes the CURRENT result table's points into main.wasm's highlight_buffer
// (mirrors the per-frame agent_buffer write in the render loop below) -
// reads back out of the already-rendered DOM table rather than a separate
// JS-side row array, so a big result set isn't held in memory twice over.
// Requires the query to alias its coordinate columns exactly "x"/"y"
// (e.g. `SELECT pos_x AS x, pos_y AS y FROM agent_states WHERE ...`) -
// explicit aliases, not column-name sniffing, per the design.
function sqlTerminalHighlightOnMap() {
    if (!wasmInstance) return;
    const xIdx = sqlResultColumns.indexOf('x');
    const yIdx = sqlResultColumns.indexOf('y');
    if (xIdx < 0 || yIdx < 0) {
        document.getElementById('sql-terminal-status').innerText =
            'Highlight needs columns aliased exactly "x" and "y", e.g. SELECT pos_x AS x, pos_y AS y FROM ...';
        return;
    }
    const rows = document.querySelectorAll('#sql-terminal-tbody tr');
    const points = new Float32Array(rows.length * 2);
    let n = 0;
    rows.forEach(tr => {
        const cells = tr.children;
        const x = parseFloat(cells[xIdx].textContent);
        const y = parseFloat(cells[yIdx].textContent);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            points[n * 2] = x; points[n * 2 + 1] = y; n++;
        }
    });
    const exports = wasmInstance.exports;
    const ptr = exports.ensure_highlight_capacity(n);
    new Float32Array(exports.memory.buffer, ptr, n * 2).set(points.subarray(0, n * 2));
    exports.update_highlight_data(n);
    document.getElementById('sql-terminal-status').innerText = `Highlighted ${n} point(s) on map.`;
}

function sqlTerminalClearHighlights() {
    if (!wasmInstance) return;
    wasmInstance.exports.update_highlight_data(0);
    document.getElementById('sql-terminal-status').innerText = 'Highlights cleared.';
}

// ---- Debug panel (DEBUG_MODE only) ----

function debugPanelOutput(text) {
    const el = document.getElementById('debug-output');
    if (el) el.textContent = text;
}

function debugCheckIndexVisible() {
    if (!playbackWorker) return;
    const matchIdx = parseInt(document.getElementById('debug-match-idx').value, 10) || 0;
    playbackWorker.postMessage({ type: 'debugIndexVisible', matchIdx });
}

function debugGetVfsTraces() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'getVfsTraces' });
}

function debugResetVfsTraces() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'resetVfsTraces' });
}

function debugGetLockCounters() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'getLockCounters' });
}

function debugGetHeapInfo() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'heapDebug' });
}

let readerBoundsRemaining = 0;

// Real progress, not decorative: each reader independently bisects its own
// slice of matches against agent_states (a multi-million-row table for a
// realistic file) and reports back exactly once, whether it succeeded or
// gave up (readers can never open a handle at all on browsers without
// concurrent OPFS support - see replay-worker.js's openSyncAccessHandleWithRetry
// - and still count as "done" for progress purposes either way, since
// playbackWorker's own combineBounds/self-heal paths cover the rest
// regardless). "how many of the N readers have reported in" is a genuine,
// monotonic completion signal for however long this phase actually takes -
// unlike leaving the byte-streaming progress bar frozen at 100% through the
// whole thing, which looks finished when it isn't.
function reportBoundsProgress() {
    const done = READER_COUNT - readerBoundsRemaining;
    const pct = READER_COUNT > 0 ? Math.round((done / READER_COUNT) * 100) : 100;
    const fill = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');
    if (fill) fill.style.width = pct + '%';
    if (text) text.innerText = `Computing map bounds (parallel)... ${pct}% (${done}/${READER_COUNT} readers done)`;
}

// Phase 6: navigator.deviceMemory clamp, on top of the existing
// hardwareConcurrency cap. This is NOT about wasm_layout.h's per-thread
// memory floor (Phase 6a already fixed that independently - unused reader
// thread-id slots cost nothing since they're never grown into) - it's
// about the real, fixed per-Worker overhead of spinning up a whole extra
// browser Worker (its own JS engine context, base heap, thread) regardless
// of how little wasm heap that Worker's thread ends up using. Coarse and
// capped at 8GB by spec (fingerprinting resistance), and Chromium-only -
// Firefox/Safari report `undefined`, which falls back to the
// hardwareConcurrency-only cap this project already had.
function computeReaderCount() {
    const override = new URLSearchParams(location.search).get('readerCount');
    if (override !== null) return parseInt(override, 10);
    const hwCap = Math.min(navigator.hardwareConcurrency || 4, 8);
    const mem = navigator.deviceMemory;
    if (mem === undefined) return hwCap;
    if (mem <= 1) return 1;
    if (mem <= 2) return 2;
    if (mem <= 4) return 4;
    return hwCap;
}
const READER_COUNT = computeReaderCount();

function startBoundsComputation() {
    if (matches.length === 0) {
        // Nothing to bound against - keep main.c's default bounds.
        wasmInstance.exports.set_map_bounds(-100, 100, -100, 100);
        finishLoadAndStartPlayback();
        return;
    }
    readerBoundsRemaining = READER_COUNT;
    // Staggered, not all READER_COUNT (up to 8) Worker.postMessage('init')
    // calls fired in the same synchronous tick - confirmed via direct
    // Selenium+Firefox testing (real file upload) that firing this many
    // concurrent createSyncAccessHandle({mode:"readwrite-unsafe"}) requests
    // on the same OPFS file at once isn't reliably handled by Firefox's OPFS
    // implementation (some readers failed outright with
    // NoModificationAllowedError; Chrome never showed this). replay-worker.js's
    // openSyncAccessHandleWithRetry already makes each individual attempt
    // resilient to that - this staggering is the complementary fix: reduce
    // how often the contention happens in the first place, not just survive
    // it after the fact. 25ms/reader adds well under 200ms total even at the
    // 8-reader cap, negligible against real load times.
    for (let i = 0; i < READER_COUNT; i++) {
        setTimeout(() => {
            const w = new Worker(WORKER_SCRIPT_URL);
            w.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    w.postMessage({ type: 'computeBounds', readerIdx: i, readerCount: READER_COUNT });
                } else if (e.data.type === 'boundsReady') {
                    gracefulTerminateWorker(w);
                    readerBoundsRemaining--;
                    reportBoundsProgress();
                    if (readerBoundsRemaining === 0) {
                        playbackWorker.postMessage({ type: 'combineBounds', readerCount: READER_COUNT });
                    }
                } else if (e.data.type === 'error') {
                    appendToConsoleLog('[Reader Worker Error] ' + e.data.message);
                    gracefulTerminateWorker(w);
                    readerBoundsRemaining--;
                    reportBoundsProgress();
                    if (readerBoundsRemaining === 0) {
                        playbackWorker.postMessage({ type: 'combineBounds', readerCount: READER_COUNT });
                    }
                }
            };
            w.postMessage({ type: 'init', role: 'reader', memory: sharedMemory, module: replayModule, threadId: i + 1 });
        }, i * 25);
    }
}

function finishLoadAndStartPlayback() {
    loadingOverlay.style.display = 'none';
    document.getElementById('hamburger-container').style.display = 'block';
    resetBtn.style.display = 'block';
    document.getElementById('export-btn').style.display = 'block';
    currentSimulationState = "RUNNING";
    replayTime = totalStartTime;
    isPaused = false;
    createTimelineUI();
    appendToConsoleLog(`[Replay Engine] Parse Complete! Matches detected: ${matches.length}`);
    if (!pendingFrameRequest) {
        pendingFrameRequest = true;
        playbackWorker.postMessage({ type: 'frame', time: replayTime, seek: true });
    }
}

Promise.all([
    // {cache: 'no-store'}: without it the browser can silently keep serving
    // a stale cached main.wasm after a rebuild - the exact class of bug
    // already fixed for replay_worker.wasm/replay-worker.js (see
    // WORKER_SCRIPT_URL's cache-bust comment above), just not caught here
    // until Phase 5d's new exports (ensure_highlight_capacity/
    // update_highlight_data) started failing with "is not a function"
    // against an old cached binary that didn't have them yet.
    fetch('main.wasm', { cache: 'no-store' }).then(res => {
        if (!res.ok) throw new Error("main.wasm not found.");
        return res.arrayBuffer();
    }),
    fetch('shaders/main_vs.glsl').then(res => res.text()),
    fetch('shaders/main_fs.glsl').then(res => res.text()),
    fetch('shaders/grid_vs.glsl').then(res => res.text()),
    fetch('shaders/grid_fs.glsl').then(res => res.text()),
]).then(([wasmBuffer, mainVs, mainFs, gridVs, gridFs]) => {
    return WebAssembly.instantiate(wasmBuffer, importObject).then(result => {
        wasmInstance = result.instance;
        const exports = wasmInstance.exports;

        writeStringToWasm(mainVs, exports.get_vs_main_ptr());
        writeStringToWasm(mainFs, exports.get_fs_main_ptr());
        writeStringToWasm(gridVs, exports.get_vs_grid_ptr());
        writeStringToWasm(gridFs, exports.get_fs_grid_ptr());

        exports.init_engine();
        exports.init_gl_programs();
        handleResize();

        document.getElementById('file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            startReplayLoad(file);
        });

        document.getElementById('battle-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            startBattleFileLoad(file);
        });

        // Both the WASD/space camera shortcuts below and the wheel-zoom
        // handler further down used to fire unconditionally on `window`,
        // `preventDefault()`-ing every keystroke/scroll regardless of what
        // was focused or under the cursor - so typing into the SQL
        // terminal's textarea (or any future text field) silently did
        // nothing (preventDefault on keydown blocks the field's own
        // character-insertion default action), and scrolling the mouse
        // wheel over a panel's own scrollable content zoomed the map
        // instead of scrolling the panel. These two checks opt out of the
        // camera controls whenever the target is actually a form field or
        // inside one of the floating UI panels, letting normal browser/DOM
        // behavior handle it instead.
        function isTypingIntoFormField(e) {
            const el = e.target;
            const tag = el && el.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable);
        }
        function isOverUiPanel(e) {
            return !!(e.target && e.target.closest && e.target.closest('.ui-panel'));
        }

        window.addEventListener('keydown', (e) => {
            if (isTypingIntoFormField(e)) return;
            if (e.key === 'w' || e.key === 'W') exports.set_key_state(0, 1);
            if (e.key === 'a' || e.key === 'A') exports.set_key_state(1, 1);
            if (e.key === 's' || e.key === 'S') exports.set_key_state(2, 1);
            if (e.key === 'd' || e.key === 'D') exports.set_key_state(3, 1);
            if (e.key === ' ') {
                isPaused = !isPaused;
                const playBtn = document.getElementById('tl-play-btn');
                if (playBtn) {
                    playBtn.innerText = isPaused ? 'Play' : 'Pause';
                    playBtn.style.color = isPaused ? '#ffaa00' : '#00ff00';
                    playBtn.style.borderColor = isPaused ? '#ffaa00' : '#00ff00';
                }
            }
            e.preventDefault();
        });

        window.addEventListener('keyup', (e) => {
            if (isTypingIntoFormField(e)) return;
            if (e.key === 'w' || e.key === 'W') exports.set_key_state(0, 0);
            if (e.key === 'a' || e.key === 'A') exports.set_key_state(1, 0);
            if (e.key === 's' || e.key === 'S') exports.set_key_state(2, 0);
            if (e.key === 'd' || e.key === 'D') exports.set_key_state(3, 0);
        });

        window.addEventListener('wheel', (e) => {
            if (isOverUiPanel(e)) return; // let the panel scroll its own content instead of zooming the map
            e.preventDefault();
            exports.apply_zoom(e.deltaY);
        }, { passive: false });

        let isDragging = false;
        let lastMouseX = 0;
        let lastMouseY = 0;

        canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
        });

        window.addEventListener('mousemove', (e) => {
            if (isDragging) {
                const dx = e.clientX - lastMouseX;
                const dy = e.clientY - lastMouseY;
                lastMouseX = e.clientX;
                lastMouseY = e.clientY;
                if (exports.pan_camera) exports.pan_camera(dx, dy);
            }
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
        });

        let lastFrameTime = 0;

        function loop(time) {
            const dt = (time - lastFrameTime) * 0.001;
            lastFrameTime = time;

            if (currentSimulationState === "RUNNING" && playbackWorker) {
                if (!isPaused) {
                    replayTime += dt * playbackSpeed;
                    if (replayTime >= totalEndTime) {
                        replayTime = totalEndTime;
                        isPaused = true;
                        const playBtn = document.getElementById('tl-play-btn');
                        if (playBtn) playBtn.innerText = 'Play';
                    }
                    const slider = document.getElementById('tl-slider');
                    if (slider) slider.value = replayTime.toString();
                }

                // Decoupled from the render rate: the DB query round-trip
                // happens async in the Worker, so a slow query never blocks
                // a frame - the render loop just draws the most recently
                // received snapshot every tick.
                if (!pendingFrameRequest) {
                    pendingFrameRequest = true;
                    playbackWorker.postMessage({ type: 'frame', time: replayTime, seek: false });
                }

                if (latestFrame) {
                    // No cap here - ensure_agent_capacity grows main.wasm's
                    // buffer to fit however many units+corpses this frame
                    // actually has (a long battle's corpse count is unbounded).
                    const n = latestFrame.count;
                    const agentBufferPtr = exports.ensure_agent_capacity(n);
                    const floatView = new Float32Array(wasmInstance.exports.memory.buffer, agentBufferPtr, n * 3);
                    floatView.set(latestFrame.buffer.subarray(0, n * 3));
                    exports.update_frame_data(n);
                }
                exports.render_frame(dt);
            }
            requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
    }).catch(err => {
        console.error("Wasm initialization error:", err);
        appendToConsoleLog("[WASM ERROR] " + err.message);
    });
}).catch(err => {
    console.error("Initialization failure:", err);
});

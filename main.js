const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl');
const logContent = document.getElementById('log-content');
const uploadOverlay = document.getElementById('upload-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const resetBtn = document.getElementById('reset-btn');

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

// Worker orchestration
const WASM_MEMORY_PAGES = 16384; // 1GB - must match Makefile's --initial-memory/--max-memory for replay_worker.wasm
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

const glObjects = { programs: [], shaders: [], buffers: [], uniforms: [] };

function triggerReset() {
    document.getElementById('file-input').value = "";
    uploadOverlay.style.display = 'flex';
    resetBtn.style.display = 'none';
    removeTimelineUI();
    currentSimulationState = "AWAITING_FILE";

    if (playbackWorker) { playbackWorker.terminate(); playbackWorker = null; }
    if (prefetchWorker) { prefetchWorker.terminate(); prefetchWorker = null; }
    prefetchedBattles = new Set();
    prefetchInFlight = false;
    primedBattles = new Set();
    primingInFlight = false;
    sharedMemory = null;
    matches = [];
    timelineLoadBars = [];
    latestFrame = null;

    document.getElementById('chat-content').innerHTML = '<div>System: Chat initialized...</div>';
    appendToConsoleLog("[System] Reset complete. Select a new sqlite database.");
}

function toggleMinimize(contentId) {
    const panel = document.getElementById(contentId).parentElement;
    panel.classList.toggle('minimized');

    const icon = panel.querySelector('.toggle-icon');
    icon.innerText = panel.classList.contains('minimized') ? '+' : '-';
}

function appendToConsoleLog(message) {
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
    const msgDiv = document.createElement('div');
    msgDiv.style.marginBottom = '5px';
    msgDiv.style.wordBreak = 'break-word';

    let color = '#00ff00';
    if (chat.team === 0) color = '#51adff';
    else if (chat.team === 1) color = '#ff5151';

    msgDiv.innerHTML = `<span style="color: ${color}; font-weight: bold;">[${chat.username}]</span>: <span style="color: #e0e0e0;">${chat.message}</span>`;
    chatContent.appendChild(msgDiv);
    // Cap history so the panel doesn't grow unbounded over a long session.
    while (chatContent.children.length > 40) chatContent.removeChild(chatContent.firstChild);
    chatContent.scrollTop = chatContent.scrollHeight;
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
    if (!prefetchWorker || prefetchInFlight) return;
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
    prefetchWorker = new Worker('replay-worker.js');
    prefetchWorker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') {
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

// Same fan-out priority as pickPrefetchTarget, but only among battles whose
// bounds are already known (prefetched) and not yet primed.
function pickPrimeTarget() {
    if (matches.length === 0) return -1;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    const base = current >= 0 ? current : 0;
    for (let d = 1; d < matches.length; d++) {
        const fwd = base + d;
        if (fwd < matches.length && prefetchedBattles.has(fwd) && !primedBattles.has(fwd)) return fwd;
        const back = base - d;
        if (back >= 0 && prefetchedBattles.has(back) && !primedBattles.has(back)) return back;
    }
    return -1;
}

function schedulePriming() {
    if (!playbackWorker || primingInFlight || pendingFrameRequest) return; // only when playbackWorker is truly idle
    const idx = pickPrimeTarget();
    if (idx < 0) return;
    primingInFlight = true;
    playbackWorker.postMessage({ type: 'primeBattle', matchIdx: idx });
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

// ---- Worker orchestration ----

function startReplayLoad(file) {
    uploadOverlay.style.display = 'none';
    loadingOverlay.style.display = 'flex';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').innerText = 'Starting worker pool...';

    sharedMemory = new WebAssembly.Memory({ initial: WASM_MEMORY_PAGES, maximum: WASM_MEMORY_PAGES, shared: true });

    fetch('replay_worker.wasm')
        .then(res => res.arrayBuffer())
        .then(WebAssembly.compile)
        .then(module => {
            replayModule = module;
            playbackWorker = new Worker('replay-worker.js');
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

function onLoaderMessage(e) {
    const d = e.data;
    switch (d.type) {
        case 'ready': {
            const file = playbackWorker._pendingFile;
            document.getElementById('progress-text').innerText = 'Streaming file into engine...';
            playbackWorker.postMessage({ type: 'load', file });
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
            document.getElementById('progress-text').innerText = 'Computing map bounds (parallel)...';
            startBoundsComputation();
            startPrefetchWorker(); // independent of bounds computation - can start working immediately
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
            // self-healing call covers it live). If we just got a real frame
            // for a battle, it's ready by definition; make sure the loading
            // indicator reflects that regardless of how it got there.
            if (d.activeMatchIndex >= 0 && !primedBattles.has(d.activeMatchIndex)) {
                primedBattles.add(d.activeMatchIndex);
                prefetchedBattles.add(d.activeMatchIndex);
                updateLoadIndicators();
            }
            schedulePrefetch(); // re-target in case the cursor moved (playback, seek, or scrub)
            schedulePriming();  // playbackWorker is idle right now - a good moment to prime, if anything's eligible
            break;
        }
        case 'battlePrimed': {
            primedBattles.add(d.matchIdx);
            primingInFlight = false;
            updateLoadIndicators();
            schedulePriming();
            break;
        }
        case 'error': {
            appendToConsoleLog('[Replay Engine Error] ' + d.message);
            if (currentSimulationState !== 'RUNNING') {
                alert('Failed to load replay: ' + d.message);
                triggerReset();
            }
            break;
        }
    }
}

let readerBoundsRemaining = 0;
const READER_COUNT = Math.min(navigator.hardwareConcurrency || 4, 8);

function startBoundsComputation() {
    if (matches.length === 0) {
        // Nothing to bound against - keep main.c's default bounds.
        wasmInstance.exports.set_map_bounds(-100, 100, -100, 100);
        finishLoadAndStartPlayback();
        return;
    }
    readerBoundsRemaining = READER_COUNT;
    for (let i = 0; i < READER_COUNT; i++) {
        const w = new Worker('replay-worker.js');
        w.onmessage = (e) => {
            if (e.data.type === 'ready') {
                w.postMessage({ type: 'computeBounds', readerIdx: i, readerCount: READER_COUNT });
            } else if (e.data.type === 'boundsReady') {
                w.terminate();
                readerBoundsRemaining--;
                if (readerBoundsRemaining === 0) {
                    playbackWorker.postMessage({ type: 'combineBounds', readerCount: READER_COUNT });
                }
            } else if (e.data.type === 'error') {
                appendToConsoleLog('[Reader Worker Error] ' + e.data.message);
                w.terminate();
                readerBoundsRemaining--;
                if (readerBoundsRemaining === 0) {
                    playbackWorker.postMessage({ type: 'combineBounds', readerCount: READER_COUNT });
                }
            }
        };
        w.postMessage({ type: 'init', role: 'reader', memory: sharedMemory, module: replayModule, threadId: i + 1 });
    }
}

function finishLoadAndStartPlayback() {
    loadingOverlay.style.display = 'none';
    resetBtn.style.display = 'block';
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
    fetch('main.wasm').then(res => {
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

        window.addEventListener('keydown', (e) => {
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
            if (e.key === 'w' || e.key === 'W') exports.set_key_state(0, 0);
            if (e.key === 'a' || e.key === 'A') exports.set_key_state(1, 0);
            if (e.key === 's' || e.key === 'S') exports.set_key_state(2, 0);
            if (e.key === 'd' || e.key === 'D') exports.set_key_state(3, 0);
        });

        window.addEventListener('wheel', (e) => {
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

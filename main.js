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

// Worker orchestration
const WASM_MEMORY_PAGES = 16384; // 1GB - must match Makefile's --initial-memory/--max-memory for replay_worker.wasm
let sharedMemory = null;
let replayModule = null;
let playbackWorker = null; // the loader worker, which continues serving live queries after load
let pendingFrameRequest = false;
let latestFrame = null; // { buffer, count, activeMatchIndex, relativeTime }

const glObjects = { programs: [], shaders: [], buffers: [], uniforms: [] };

function triggerReset() {
    document.getElementById('file-input').value = "";
    uploadOverlay.style.display = 'flex';
    resetBtn.style.display = 'none';
    removeTimelineUI();
    currentSimulationState = "AWAITING_FILE";

    if (playbackWorker) { playbackWorker.terminate(); playbackWorker = null; }
    sharedMemory = null;
    matches = [];
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

        trackWrapper.appendChild(block);
    });

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
                    const agentBufferPtr = exports.get_agent_buffer_ptr();
                    const floatView = new Float32Array(wasmInstance.exports.memory.buffer, agentBufferPtr, 1000 * 3);
                    const n = Math.min(latestFrame.count, 1000);
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

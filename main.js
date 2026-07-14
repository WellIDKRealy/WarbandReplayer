const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl');
const logContent = document.getElementById('log-content');
const uploadOverlay = document.getElementById('upload-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const resetBtn = document.getElementById('reset-btn');

let currentSimulationState = "AWAITING_FILE";
let activeLogs = ["Ready to process Warband SQLite replay..."];
let wasmInstance = null;

// Replay and Timeline State
let replayDb = null;
let ticks = [];             // Array of { id, time }
let matches = [];           // Array of { startTickIdx, endTickIdx, label, map, factions }
let currentTickIndex = 0;
let lastTickTime = 0;
let isPaused = false;
let playbackSpeed = 1.0;    // Realtime speed modifier
let chats = []; 
let lastDisplayedTickIndex = -1;

// Compiled SQLite Statement (for loop performance optimization)
let agentStmt = null;

const glObjects = { programs: [], shaders: [], buffers: [], uniforms: [] };

function triggerReset() {
    document.getElementById('file-input').value = "";
    uploadOverlay.style.display = 'flex';
    resetBtn.style.display = 'none';
    removeTimelineUI();
    currentSimulationState = "AWAITING_FILE";
    if (agentStmt) {
        agentStmt.free();
        agentStmt = null;
    }
    
    // Clear chat system
    chats = [];
    lastDisplayedTickIndex = -1;
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

// Helper function to dynamically locate the map/faction state at any given tick
function getMatchStateAtTick(tickId) {
    const mapStmt = replayDb.prepare(`
        SELECT ms.scene_no FROM map_switches ms
        JOIN events e ON ms.event_id = e.id
        WHERE e.tick_id <= ?
        ORDER BY e.id DESC LIMIT 1
    `);
    mapStmt.bind([tickId]);
    let sceneNo = "Unknown";
    if (mapStmt.step()) {
        sceneNo = mapStmt.get()[0];
    }
    mapStmt.free();

    const facStmt = replayDb.prepare(`
        SELECT fs.team_0_faction_name, fs.team_1_faction_name FROM faction_switches fs
        JOIN events e ON fs.event_id = e.id
        WHERE e.tick_id <= ?
        ORDER BY e.id DESC LIMIT 1
    `);
    facStmt.bind([tickId]);
    let factions = "Swarzadi vs Rhodoks";
    if (facStmt.step()) {
        const row = facStmt.get();
        factions = `${row[0] || "Unknown"} vs ${row[1] || "Unknown"}`;
    }
    facStmt.free();

    return { sceneNo, factions };
}

// Dynamic Timeline UI generation
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

    // Metadata Row
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

    // Controls Action Row
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

    // Track slider and tick indicators
    const trackWrapper = document.createElement('div');
    trackWrapper.style.position = 'relative';
    trackWrapper.style.flexGrow = '1';
    trackWrapper.style.height = '24px';
    trackWrapper.style.background = '#141414';
    trackWrapper.style.borderRadius = '4px';
    trackWrapper.style.border = '1px solid #222';
    trackWrapper.style.overflow = 'hidden';

    // Highlight segments on track represent matches
    matches.forEach((m, idx) => {
        const startPct = (m.startTickIdx / ticks.length) * 100;
        const endPct = (m.endTickIdx / ticks.length) * 100;
        const widthPct = endPct - startPct;

        const block = document.createElement('div');
        block.style.position = 'absolute';
        block.style.left = startPct + '%';
        block.style.width = widthPct + '%';
        block.style.height = '100%';
        // Alternating color blocks for visual division
        block.style.background = idx % 2 === 0 ? 'rgba(0, 150, 255, 0.12)' : 'rgba(0, 255, 150, 0.08)';
        block.style.borderLeft = '2px solid #00ff00';
        block.style.cursor = 'pointer';
        block.title = `Jump to ${m.label} (Scene: ${m.map}, Factions: ${m.factions})`;
        block.onclick = (e) => {
            e.stopPropagation();
            currentTickIndex = m.startTickIdx;
            updateSliderPosition();
        };

        trackWrapper.appendChild(block);
    });

    // Slider overlay
    const slider = document.createElement('input');
    slider.id = 'tl-slider';
    slider.type = 'range';
    slider.min = '0';
    slider.max = (ticks.length - 1).toString();
    slider.value = '0';
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
        currentTickIndex = parseInt(e.target.value);
        updateSliderPosition();
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

function updateSliderPosition() {
    const slider = document.getElementById('tl-slider');
    const timeDisplay = document.getElementById('tl-time-display');
    const matchDetails = document.getElementById('tl-match-details');

    if (slider) slider.value = currentTickIndex.toString();
    if (timeDisplay) {
        timeDisplay.innerText = `Frame: ${currentTickIndex + 1} / ${ticks.length}`;
    }

    if (matchDetails && matches.length > 0) {
        const activeMatchIdx = matches.findIndex(m => currentTickIndex >= m.startTickIdx && currentTickIndex <= m.endTickIdx);
        if (activeMatchIdx !== -1) {
            const m = matches[activeMatchIdx];
            matchDetails.innerText = `${m.label.toUpperCase()} | Scene: ${m.map} | Factions: ${m.factions}`;
        } else {
            matchDetails.innerText = 'Out of match boundaries';
        }
    }
}

// Processing DB records, mapping match boundaries, and center coordinates
function processDatabaseAndCompileMatches() {
    // 1. Fetch Ticks
    const tickRes = replayDb.exec("SELECT id, time FROM ticks ORDER BY id ASC");
    if (tickRes.length === 0 || !tickRes[0].values) {
        throw new Error("Replay database contains no ticks records.");
    }
    ticks = tickRes[0].values.map(v => ({ id: v[0], time: v[1] }));

    const tickIdToIndex = new Map(ticks.map((t, idx) => [t.id, idx]));

    // 2. Scan events for Match Segmentation Boundaries
    const eventsStmt = replayDb.prepare(`
        SELECT e.tick_id, e.event_type, ms.scene_no, ss.team_0_score, ss.team_1_score, fs.team_0_faction_name, fs.team_1_faction_name
        FROM events e
        LEFT JOIN map_switches ms ON e.id = ms.event_id
        LEFT JOIN score_switches ss ON e.id = ss.event_id
        LEFT JOIN faction_switches fs ON e.id = fs.event_id
        WHERE e.event_type IN ('map_switch', 'score_switch', 'faction_switch')
        ORDER BY e.id ASC
    `);

    const boundaryTicks = new Set();
    while (eventsStmt.step()) {
        const row = eventsStmt.getAsObject();
        boundaryTicks.add(row.tick_id);
    }
    eventsStmt.free();

    // Map boundary tick IDs to ordered indices
    const boundaryIndices = Array.from(boundaryTicks)
          .map(tId => tickIdToIndex.get(tId))
          .filter(idx => idx !== undefined)
          .sort((a, b) => a - b);

    // Group close boundary events occurring within 15 seconds (ticks) of each other
    const mergedBoundaries = [];
    for (const idx of boundaryIndices) {
        if (idx < 5) continue; // Skip initial state markers at game launch
        if (mergedBoundaries.length === 0) {
            mergedBoundaries.push(idx);
        } else {
            const lastIdx = mergedBoundaries[mergedBoundaries.length - 1];
            if (idx - lastIdx > 15) {
                mergedBoundaries.push(idx);
            }
        }
    }

    // Segment Match timelines and populate contextual metadata
    matches = [];
    let startIdx = 0;
    for (let i = 0; i < mergedBoundaries.length; i++) {
        const endIdx = mergedBoundaries[i];
        if (endIdx - startIdx >= 10) {
            const meta = getMatchStateAtTick(ticks[startIdx].id);
            matches.push({
                startTickIdx: startIdx,
                endTickIdx: endIdx,
                label: `Match #${matches.length + 1}`,
                map: meta.sceneNo !== "Unknown" ? `Scene ${meta.sceneNo}` : "Unknown Map",
                factions: meta.factions
            });
            startIdx = endIdx + 1;
        }
    }
    // Add remaining tail segment as the final match
    if (ticks.length - 1 - startIdx >= 5) {
        const meta = getMatchStateAtTick(ticks[startIdx].id);
        matches.push({
            startTickIdx: startIdx,
            endTickIdx: ticks.length - 1,
            label: `Match #${matches.length + 1}`,
            map: meta.sceneNo !== "Unknown" ? `Scene ${meta.sceneNo}` : "Unknown Map",
            factions: meta.factions
        });
    }

    // Prepare Optimized Parametric Loop Query
    if (agentStmt) {
        agentStmt.free();
    }
    agentStmt = replayDb.prepare(`
        SELECT 
            a.pos_x, 
            a.pos_y, 
            s.team AS active_team
        FROM agent_states a
        JOIN (
            SELECT s2.agent_id, MAX(s2.event_id) AS max_event_id
            FROM spawns s2
            JOIN events e2 ON s2.event_id = e2.id
            WHERE e2.tick_id <= ?
            GROUP BY s2.agent_id
        ) latest_spawns ON a.agent_id = latest_spawns.agent_id
        JOIN spawns s ON latest_spawns.max_event_id = s.event_id
        WHERE a.tick_id = ? AND s.is_human = 1
    `);

    // 2.5 Cache Chat Logs mapped to Tick Indices
    chats = [];
    const chatsRes = replayDb.exec(`
        SELECT e.tick_id, c.username, c.message, c.team 
        FROM chats c
        JOIN events e ON c.event_id = e.id
        ORDER BY e.tick_id ASC
    `);
    if (chatsRes.length > 0 && chatsRes[0].values) {
        chats = chatsRes[0].values.map(v => {
            const tickIdx = tickIdToIndex.get(v[0]);
            return {
                tickIdx: tickIdx !== undefined ? tickIdx : -1,
                username: v[1],
                message: v[2],
                team: v[3]
            };
        }).filter(c => c.tickIdx !== -1);
    }
    
    // 3. Resolve Map Bounds
    const boundsRes = replayDb.exec(`
        SELECT MIN(a.pos_x), MAX(a.pos_x), MIN(a.pos_y), MAX(a.pos_y)
        FROM agent_states a
        WHERE EXISTS (
            SELECT 1 FROM spawns s
            WHERE s.agent_id = a.agent_id
              AND s.is_human = 1
              AND s.event_id <= (
                  SELECT MAX(s2.event_id) FROM spawns s2 
                  JOIN events e2 ON s2.event_id = e2.id
                  WHERE s2.agent_id = a.agent_id AND e2.tick_id <= a.tick_id
              )
        )
    `);

    let minX = -100, maxX = 100, minY = -100, maxY = 100;
    if (boundsRes.length > 0 && boundsRes[0].values[0][0] !== null) {
        minX = parseFloat(boundsRes[0].values[0][0]) - 10.0;
        maxX = parseFloat(boundsRes[0].values[0][1]) + 10.0;
        minY = parseFloat(boundsRes[0].values[0][2]) - 10.0;
        maxY = parseFloat(boundsRes[0].values[0][3]) + 10.0;
    }
    
    wasmInstance.exports.set_map_bounds(minX, maxX, minY, maxY);
}

function updateChatDisplay() {
    const chatContent = document.getElementById('chat-content');
    if (!chatContent) return;

    // Rebuild log context if scrubber moves backwards or jumps drastically
    if (currentTickIndex < lastDisplayedTickIndex || Math.abs(currentTickIndex - lastDisplayedTickIndex) > 15) {
        chatContent.innerHTML = '';
        const history = chats.filter(c => c.tickIdx <= currentTickIndex).slice(-20); // Keep last 20 messages
        history.forEach(appendChatToUI);
    } else {
        // Smooth progressive play forward
        const nextChats = chats.filter(c => c.tickIdx > lastDisplayedTickIndex && c.tickIdx <= currentTickIndex);
        nextChats.forEach(appendChatToUI);
    }
    lastDisplayedTickIndex = currentTickIndex;
}

function appendChatToUI(chat) {
    const chatContent = document.getElementById('chat-content');
    const msgDiv = document.createElement('div');
    msgDiv.style.marginBottom = '5px';
    msgDiv.style.wordBreak = 'break-word';

    // Team color identification (Default to Green, 0 to Team Blue, 1 to Team Red)
    let color = '#00ff00'; 
    if (chat.team === '0') color = '#51adff'; 
    else if (chat.team === '1') color = '#ff5151';

    msgDiv.innerHTML = `<span style="color: ${color}; font-weight: bold;">[${chat.username}]</span>: <span style="color: #e0e0e0;">${chat.message}</span>`;
    chatContent.appendChild(msgDiv);
    chatContent.scrollTop = chatContent.scrollHeight; // Auto-scroll
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
    initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` })
]).then(([wasmBuffer, mainVs, mainFs, gridVs, gridFs, SQL]) => {
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

            uploadOverlay.style.display = 'none';
            loadingOverlay.style.display = 'flex';
            
            setTimeout(() => {
                const reader = new FileReader();
                reader.onload = function(evt) {
                    try {
                        const uInt8Array = new Uint8Array(evt.target.result);
                        replayDb = new SQL.Database(uInt8Array);
                        
                        processDatabaseAndCompileMatches();
                        createTimelineUI();

                        loadingOverlay.style.display = 'none';
                        resetBtn.style.display = 'block';
                        currentSimulationState = "RUNNING";
                        currentTickIndex = 0;
                        lastTickTime = performance.now();
                        appendToConsoleLog(`[Replay Engine] Parse Complete! Matches detected: ${matches.length}`);
                    } catch (err) {
                        alert("Failed parsing database: " + err.message);
                        triggerReset();
                    }
                };
                reader.readAsArrayBuffer(file);
            }, 100);
        });

        // Key bindings and camera
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

        let lastFrameTime = 0;
        
        function loop(time) {
            const dt = (time - lastFrameTime) * 0.001;
            lastFrameTime = time;

            if (currentSimulationState === "RUNNING" && replayDb && agentStmt) {
                if (!isPaused) {
                    const stepIntervalMs = 66.6 / playbackSpeed; // ~15 FPS step rate
                    if (time - lastTickTime > stepIntervalMs) {
                        if (currentTickIndex < ticks.length - 1) {
                            currentTickIndex++;
                            updateSliderPosition();
			    updateChatDisplay();
                        } else {
                            isPaused = true;
                            const playBtn = document.getElementById('tl-play-btn');
                            if (playBtn) playBtn.innerText = 'Play';
                        }
                        lastTickTime = time;
                    }
                }

		updateChatDisplay();
		
                const currentTickId = ticks[currentTickIndex].id;

                // Bind parameters safely & evaluate agent frames
                agentStmt.bind([currentTickId, currentTickId]);
                let renderedCount = 0;

                const maxAgentsToRender = 1000;
		
		const agentBufferPtr = exports.get_agent_buffer_ptr();
		const floatView = new Float32Array(
		    wasmInstance.exports.memory.buffer, 
		    agentBufferPtr, 
		    maxAgentsToRender * 3
		);

                while (agentStmt.step() && renderedCount < maxAgentsToRender) {
                    const row = agentStmt.get();
                    floatView[renderedCount * 3 + 0] = parseFloat(row[0]); // pos_x
                    floatView[renderedCount * 3 + 1] = parseFloat(row[1]); // pos_y
                    
                    let teamScalar = -1.0;
                    const parsedTeam = parseInt(row[2]);
                    if (parsedTeam === 0) teamScalar = 0.0;
                    else if (parsedTeam === 1) teamScalar = 1.0;

                    floatView[renderedCount * 3 + 2] = teamScalar;
                    renderedCount++;
                }
                agentStmt.reset(); // Crucial reset for sql.js prepared statements

                exports.update_frame_data(renderedCount);
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

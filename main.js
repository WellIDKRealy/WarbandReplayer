const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl');
const logBox = document.getElementById('log-box');
const uploadOverlay = document.getElementById('upload-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const resetBtn = document.getElementById('reset-btn');

let currentSimulationState = "AWAITING_FILE";
let activeLogs = ["Awaiting data config validation..."];
let wasmInstance = null;

const glObjects = {
    programs: [],
    shaders: [],
    buffers: [],
    uniforms: []
};

function triggerReset() {
    document.getElementById('file-input').value = "";
    uploadOverlay.style.display = 'flex';
    loadingOverlay.style.display = 'none';
    resetBtn.style.display = 'none';
    currentSimulationState = "AWAITING_FILE";
    appendToConsoleLog("[System] Reset requested. Awaiting config...");
}

function appendToConsoleLog(message) {
    activeLogs.push(message);
    if (activeLogs.length > 6) activeLogs.shift();
    logBox.innerText = activeLogs.join('\n');
}

function getString(charPtr) {
    const memory = new Uint8Array(wasmInstance.exports.memory.buffer);
    let str = "";
    while (memory[charPtr] !== 0) {
        str += String.fromCharCode(memory[charPtr]);
        charPtr++;
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
        js_sin: Math.sin, 
        js_cos: Math.cos, 
        js_sqrt: Math.sqrt,
        js_print_string: console.log,
        js_log_string: (charPtr) => appendToConsoleLog(getString(charPtr)),

        gl_clear_color: (r, g, b, a) => gl.clearColor(r, g, b, a),
        gl_clear: (mask) => gl.clear(mask),
        gl_create_shader: (type) => {
            glObjects.shaders.push(gl.createShader(type));
            return glObjects.shaders.length - 1;
        },
        gl_shader_source: (idx, srcPtr) => gl.shaderSource(glObjects.shaders[idx], getString(srcPtr)),
        gl_compile_shader: (idx) => gl.compileShader(glObjects.shaders[idx]),
        gl_create_program: () => {
            glObjects.programs.push(gl.createProgram());
            return glObjects.programs.length - 1;
        },
        gl_attach_shader: (progIdx, shaderIdx) => gl.attachShader(glObjects.programs[progIdx], glObjects.shaders[shaderIdx]),
        gl_link_program: (progIdx) => gl.linkProgram(glObjects.programs[progIdx]),
        gl_use_program: (progIdx) => gl.useProgram(glObjects.programs[progIdx]),
        gl_get_uniform_location: (progIdx, namePtr) => {
            const loc = gl.getUniformLocation(glObjects.programs[progIdx], getString(namePtr));
            glObjects.uniforms.push(loc);
            return glObjects.uniforms.length - 1;
        },
        gl_get_attrib_location: (progIdx, namePtr) => gl.getAttribLocation(glObjects.programs[progIdx], getString(namePtr)),
        gl_create_buffer: () => {
            glObjects.buffers.push(gl.createBuffer());
            return glObjects.buffers.length - 1;
        },
        gl_bind_buffer: (target, bufIdx) => gl.bindBuffer(target, glObjects.buffers[bufIdx]),
        gl_buffer_data: (target, dataPtr, numBytes, usage) => {
            const dataView = new Float32Array(wasmInstance.exports.memory.buffer, dataPtr, numBytes / 4);
            gl.bufferData(target, dataView, usage);
        },
        gl_enable_vertex_attrib_array: (index) => gl.enableVertexAttribArray(index),
        gl_vertex_attrib_pointer: (idx, size, type, norm, stride, offset) => gl.vertexAttribPointer(idx, size, type, norm, stride, offset),
        gl_uniform1f: (uLocIdx, x) => gl.uniform1f(glObjects.uniforms[uLocIdx], x),
        gl_uniform2f: (uLocIdx, x, y) => gl.uniform2f(glObjects.uniforms[uLocIdx], x, y),
        gl_uniform3f: (uLocIdx, x, g, b) => gl.uniform3f(glObjects.uniforms[uLocIdx], x, g, b),
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

// Asynchronously fetch all separate asset dependencies
Promise.all([
    fetch('main.wasm').then(res => res.arrayBuffer()),
    fetch('shaders/main_vs.glsl').then(res => res.text()),
    fetch('shaders/main_fs.glsl').then(res => res.text()),
    fetch('shaders/grid_vs.glsl').then(res => res.text()),
    fetch('shaders/grid_fs.glsl').then(res => res.text())
]).then(([wasmBuffer, mainVs, mainFs, gridVs, gridFs]) => {
    return WebAssembly.instantiate(wasmBuffer, importObject).then(result => {
        wasmInstance = result.instance;
        const exports = wasmInstance.exports;

        // Populate separated assets directly into the C runtime engine heap arrays
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

            const reader = new FileReader();
            reader.onload = function(evt) {
                const text = evt.target.result;
                const bytes = new TextEncoder().encode(text);
                
                const maxBufSize = exports.get_file_buffer_max_size();
                const bufPtr = exports.get_file_buffer_ptr();
                const copyLength = Math.min(bytes.length, maxBufSize);
                
                const wasmHeap = new Uint8Array(exports.memory.buffer);
                for (let i = 0; i < copyLength; i++) {
                    wasmHeap[bufPtr + i] = bytes[i];
                }

                exports.prepare_simulation_loading(copyLength);
                uploadOverlay.style.display = 'none';
                loadingOverlay.style.display = 'flex';
                currentSimulationState = "LOADING";
            };
            reader.readAsText(file);
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'w' || e.key === 'W') exports.set_key_state(0, 1);
            if (e.key === 'a' || e.key === 'A') exports.set_key_state(1, 1);
            if (e.key === 's' || e.key === 'S') exports.set_key_state(2, 1);
            if (e.key === 'd' || e.key === 'D') exports.set_key_state(3, 1);
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

        function loop(time) {
            if (currentSimulationState === "RUNNING") {
                exports.render_frame(time);
            } else if (currentSimulationState === "LOADING") {
                const progress = exports.execute_loading_step();
                progressFill.style.width = progress + "%";
                progressText.innerText = Math.floor(progress) + "%";

                if (progress >= 100.0) {
                    loadingOverlay.style.display = 'none';
                    currentSimulationState = "RUNNING";
                    resetBtn.style.display = 'block';
                    appendToConsoleLog("[System] Simulation activated.");
                }
            }
            requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
    });
});

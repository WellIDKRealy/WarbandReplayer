# Warband Replay Viewer

A Mount & Blade Warband battle-replay viewer: bare-metal WebAssembly (no Emscripten) rendering
recorded battles with WebGL, backed by a real multithreaded SQLite engine running entirely in C.
JS/HTML/CSS are a thin graphics-and-input stub - all SQL, tick bookkeeping, and playback logic run
in WASM.

It also still contains the original minimal rotating-cube demo pieces (`index.html`'s predecessor
project) this repo grew out of; the replay viewer (`main.html`) is the actual application.

## Architecture

- **`main.wasm`** (`main.c`) - the renderer. WebGL drawing, camera/pan/zoom, and nothing else. It
  never touches the database; it just receives an already-computed position/team snapshot into
  `agent_buffer` each frame.
- **`replay_worker.wasm`** (`replay_worker.c` + the `sqlite3/` sources) - the entire replay engine:
  the SQLite VFS, all SQL, the incremental roster/cursor algorithm, match segmentation, and the chat
  cache. Instantiated only inside Web Workers, never on the main thread, and only ever multiple
  instances of *this one* module sharing one `WebAssembly.Memory` - real WASM threads
  (`-matomics`/`--shared-memory`/`SQLITE_THREADSAFE=1`), not a single-writer-then-freeze
  workaround. See `replay-worker.js` for the loader/reader/playback role dispatch and
  `goyslopless-c/lib/heap.c` / `sqlite3/sqlite3_mutex_wasm.c` for the allocator and mutex backing
  that threading model.
- **`main.js`** - thin orchestration only: file input, `Worker`/`postMessage` plumbing, the WebGL
  import shim, and DOM updates for the timeline/chat panels driven by small summaries the workers
  send over - no SQL or per-tick bookkeeping happens here.

## Prerequisites

- **LLVM toolchain**: `clang` and `wasm-ld` (part of LLVM - on Windows, `choco install llvm` gets
  both; `lld` ships bundled with `clang`).
- **`make`**.
- **Python 3** (for `serve.py`, the local dev server - stdlib only, no dependencies).

## Building

```bash
make
```

Produces `main.wasm`, `benchmark.wasm`, and `replay_worker.wasm`. `make clean` removes them.

## Running

The replay engine uses real shared-memory WASM threads, which requires the browser to consider the
page **cross-origin isolated** (`window.crossOriginIsolated === true`) - a prerequisite for
`SharedArrayBuffer` / shared `WebAssembly.Memory` / `Atomics.wait` in Workers. That in turn requires
two response headers on every request:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Plain `python3 -m http.server` **cannot** set custom response headers, so it will not work for the
replay viewer (the renderer-only cube demo doesn't care, but `main.html` does). Use the included dev
server instead:

```bash
python3 serve.py        # defaults to port 8000
python3 serve.py 8080   # or pick a port
```

Then open `http://localhost:8000/main.html`.

### Deploying to a static host without header control (GitHub Pages, etc.)

GitHub Pages can't set custom response headers either. `main.html` already loads `coi-shim.js` as
the first thing in `<head>` - a small, self-contained Service Worker (no CDN dependency) that
injects the same two headers into every response the browser sees, achieving cross-origin isolation
purely client-side. It reloads the page once on first visit to activate; after that it's
transparent. See the comment block at the top of `coi-shim.js` for how it works.

## Project structure

- `main.html` / `main.js` / `main.css` - the replay viewer UI.
- `main.c` - the WebGL renderer (`main.wasm`).
- `replay_worker.c` - the threaded SQLite-backed replay engine (`replay_worker.wasm`).
- `replay-worker.js` - the Worker script (loader/reader/playback roles).
- `coi-shim.js` - cross-origin-isolation Service Worker shim for static hosting.
- `serve.py` - local dev server with the COOP/COEP headers the replay engine needs.
- `sqlite3/` - the SQLite amalgamation, the in-memory VFS (`sqlite3_vfs_mem.c`), and the WASM mutex
  backend (`sqlite3_mutex_wasm.c`).
- `goyslopless-c/` - the from-scratch freestanding libc this project builds against instead of a
  full libc, including the heap allocator (`lib/heap.c`) and the `__multi3` 128-bit-multiply
  compiler-rt shim (`lib/compiler_rt.c`) clang needs for SQLite's overflow-safe arithmetic.
- `cglm/`, `ubench/` - git submodules (3D math, benchmarking).
- `benchmark.c` / `benchmark.html` - the benchmark suite (see below).
- `lua/main.lua` - the Warband-side recorder script that produces the `.sqlite` replay logs this
  viewer reads; the ground-truth schema reference for `replay_worker.c`.

## Benchmarks

```bash
python3 serve.py
```

then open `http://localhost:8000/benchmark.html` and run the suite. Covers allocator throughput,
indexed-vs-naive query cost, incremental-cursor-vs-full-reseek cost, and 1-worker-vs-N-worker
parallel load wall clock.

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

### Memory footprint

`replay_worker.wasm`'s shared `WebAssembly.Memory` reserves 96MiB up front (`--initial-memory`,
`WASM_MEMORY_INITIAL_PAGES` in `main.js`) and can grow to 2GiB (`--max-memory`) as needed. That
96MiB isn't a hand-picked "safe-sounding" number - it's `goyslopless-c/include/wasm_layout.h`'s
per-thread slab sizes (8MiB loader + 8×2MiB readers + 4MiB prefetch + 4KiB bounds-result region)
plus fixed per-thread stack/TLS pools, and every one of those slab sizes is a *starting point*, not
a cap: `goyslopless-c/lib/heap.c`'s `heap_extend_threaded()` transparently grows any thread past its
nominal slab via `memory.grow`, landing a new disjoint region wherever the shared memory's current
size happens to be. A real `CREATE INDEX` over a 2M+-row table from an 8MiB starting heap is exactly
what proved that growth path safe in the first place (stress-tested with `heap_debug_region_count()`/
`heap_debug_extend_failures()`, see `wasm_layout.h`'s own comments) - so the up-front reservation
only has to cover the common case, not the worst case. `navigator.deviceMemory` (where supported;
Chromium-only, coarse) additionally clamps how many reader Workers spin up and the LZMA dictionary
size used for battle exports on constrained devices (`main.js`'s `computeReaderCount()`/
`computeDictSizeMiB()`) - that's about real fixed per-Worker/per-compression overhead, independent
of the wasm-side memory floor above.

## Prerequisites

- **LLVM toolchain**: `clang` and `wasm-ld` (part of LLVM - on Windows, `choco install llvm` gets
  both; `lld` ships bundled with `clang`).
- **`make`**.
- **Python 3** (for `serve.py`, the local dev server - stdlib only, no dependencies).

## Building

```bash
make
```

Produces `main.wasm`, `benchmark.wasm`, `replay_worker.wasm`, and `compress.wasm`. `make clean` removes them.

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
- `replay_export.c` / `compress_worker.c` (`compress.wasm`) - the battle export pipeline: per-battle
  `replay.db`/`battle.db`/`manifest.json`, packed into a minimal ustar tar, then xz/LZMA2-compressed
  (and decompressed, for loading one back in) by a public-domain LZMA SDK subset vendored under
  `lzma-sdk/` (see `lzma-sdk/NOTICE.md`). `compress-worker.js` is the thin Worker wrapper;
  `compress.wasm` is deliberately a separate, non-threaded module from `replay_worker.wasm`, built
  with its own elastic (non-shared) memory. "Load Battle Export (.tar.xz)" in `main.html` decompresses
  and tar-extracts client-side, then hands `replay.db`'s bytes to `replay_finish_load_battle_file()`
  (`replay_worker.c`) - the same OPFS-backed load path a full source file uses, just skipping
  `scan_matches()` in favor of the single row `replay_export.c` wrote into `replay_meta` at export time.
- `sql_terminal.c` - the `?debug=1` SQL terminal: arbitrary read/write SQL against whatever's
  currently loaded, row results streamed back in bounded batches, plus in-session
  `SAVEPOINT`/`ROLLBACK TO` checkpoints (never persisted - gone once the tab closes). Query results
  aliased exactly `x`/`y` can be pushed onto the map as highlighted rings via `main.c`'s
  `highlight_buffer` (mirrors `agent_buffer`'s pattern, third draw pass in `render_frame`).
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

## Testing

Correctness testing for the replay engine works by **ground-truth comparison, not rendering**: an
independent Python reimplementation (`testdata/ground_truth.py`) re-derives match segmentation,
living-agent positions, corpse accumulation, and chat delivery directly from a `.sqlite` file's SQL
- never touching `replay_worker.wasm` - producing an authoritative expected output. A browser-side
harness (`testdata/verify_against_truth.html`) then drives the *actual* engine through the same
`postMessage` protocol `main.js` uses, and diffs its output against that ground truth sample by
sample (agent positions/teams, corpse counts, chat counts, match boundaries). This is what caught a
real bug during development (corpse counts leaking one tick ahead of the displayed frame) that
count-only smoke testing had missed.

`testdata/run_test_suite.py` automates this across every replay in a batch and every real browser
engine available for automation on the machine - Chrome, Firefox, and (Linux only) WebKit via
[Selenium](https://www.selenium.dev/). Real Safari is macOS/iOS-only and can't be driven headlessly;
WebKitGTK is the closest available proxy for that engine and only runs on Linux (`apt install
webkit2gtk-driver`) - on Windows/macOS, run with `--browsers chrome,firefox` or use WSL for WebKit
coverage. Each case gets its own fresh browser process, runs concurrently (thread pool per browser,
all browsers at once), and gets one automatic retry if the browser process itself crashes or a
page-internal fetch flakes under concurrent load - not for a real assertion mismatch.

```bash
pip install selenium   # Selenium Manager auto-downloads chromedriver/geckodriver - nothing else to install for chrome/firefox
pip install psutil      # optional - enables --max-suite-memory-mb below

# one-time: generate ground truth for a batch of replays
python3 testdata/ground_truth.py path/to/replay.sqlite 6 testdata/gt_batch/replay.json
# (or loop it over testdata/replays_batch/*.sqlite -> testdata/gt_batch/*.json)

python3 serve.py 8126                                    # must be running - COOP/COEP + concurrent requests
python3 testdata/run_test_suite.py --browsers chrome,firefox   # all discovered replays x both engines
python3 testdata/run_test_suite.py --only match_substring
python3 testdata/run_test_suite.py --browsers chrome,firefox,webkit   # Linux only
python3 testdata/run_test_suite.py --max-suite-memory-mb 4096  # cap the SUITE's own memory use (its
                                                                 # spawned browsers only, never other
                                                                 # programs on the machine) - new
                                                                 # launches wait for a running case to
                                                                 # finish rather than pile on
```

Replay files themselves are never committed (they're real player data - usernames, chat) and
`testdata/replays_batch/` and `testdata/gt_batch/` are gitignored; populate them locally from
whatever `.sqlite` recordings you have (e.g. `Modules/Napoleonic Wars/lua/replays.7z` in a Warband
install) before running the suite.

### Pre-commit: catching a stale `.wasm`

`main.wasm`/`replay_worker.wasm` are committed binaries (GitHub Pages serves the repo directly, no
build step), which means nothing stops a commit from shipping C source changes without the matching
rebuilt binary - this happened once already, silently reintroducing an already-fixed bug.
`scripts/git-hooks/pre-commit` catches it: if a commit touches wasm-affecting source, it force-rebuilds
`main.wasm`/`replay_worker.wasm` and blocks the commit if what's staged doesn't match. `.git/hooks/`
isn't tracked by git, so install it explicitly once per clone:

```bash
cp scripts/git-hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

# Charter: simple, complete, fast

Three goals, all binding, none traded for another: **as simple as possible**, **every feature kept**, **fast**.

> "An idiot admires complexity, a genius admires simplicity." — Terry Davis

Proofs exist to give guarantees that are **simple to state** — something tests cannot do. The whole project must be as
easy to understand as possible while still implementing every feature in `docs/FEATURES.md`.

## Rules
1. **Guarantees first, in plain words.** Every unit's README opens with a "Guarantees" list a newcomer can read in a minute
   (at most ~10 lines). If the guarantees do not fit, the unit is too big or too clever: split it or cut it.
2. **Short public specs.** The visible contract of a package is short and readable. Proof scaffolding (lemmas, ghost helpers)
   lives in child packages (`*.Proofs`) and is never part of the interface.
3. **No bloat, no frameworks.** Allowed: GNAT (+LLVM backend) for Ada, clang only to compile SQLite's C, `wasm-ld`,
   `make` + `gprbuild`, and a small hand-written JS loader (DOM, Workers, WebGL calls). **Not allowed:** Emscripten/emcc,
   bundlers, npm dependencies, transpilers, `wasm-opt`/asyncify post-processing, generated glue. Python is for dev-time
   test oracles only and is never shipped.
4. **One idea, one mechanism.** One data flow (source -> battle replay -> battle db -> frames). One checkpoint mechanism
   (change-sets). One ownership rule (one file, one owner worker; everyone else asks by message).
5. **Fast is a requirement, measured, not hoped for.** Every budget below is a CI gate measured on real data; simplicity never excuses a missed budget, and speed never excuses unneeded complexity. **Simplest design first; complexity only against a measurement.** Add look-ahead, caches, atlases, extra databases or wider
   address spaces only when a measured gate (60 FPS, memory, load time) fails — and record the measurement next to the code.
6. **Every line pays rent.** Each piece of code must serve a row in `FEATURES.md` or `failure-modes.md`. No row -> delete it.
7. **Size is reported.** At cut-over, lines of code per layer are compared with the old tree; growth must be justified.

## Architecture decisions that follow (these supersede conflicting earlier plan text)
- **Single-threaded wasm instances with separate memories.** No SharedArrayBuffer, atomics, COOP/COEP shim, thread slabs,
  TLS pools, custom mutex or VFS lock automaton; SQLite built with `THREADSAFE=0`. This deletes the racy cross-thread lock
  protocol (register item R4) instead of trying to prove it, and makes the allocator single-threaded (far easier to prove).
- **One file, one owner worker.** The worker that opens a file owns it; others send messages. Rendered frames are handed to the
  main thread as transferable buffers (zero-copy, no shared memory).
- **wasm32 only.** Large data stays OPFS-resident (per-battle files are small), so memory per battle is bounded.
  wasm64 is considered only if a measurement shows wasm32 is insufficient.
- **No priming / prefetch / eviction / memory-budget machinery.** Per-battle files make it unnecessary: only the active battle
  is open; the timeline shows each battle as pending / ready / damaged. (The `eviction_policy` unit in the first proof batch
  is therefore expected to be redundant and will be removed unless a measured need appears.)
- **Rendering, simplest first:** instanced draw + double-buffered frame snapshots + GPU interpolation. A look-ahead ring and a GPU
  symbol atlas are added only if the 60 FPS gate (bad-PC profile) fails.
- **Checkpoints:** change-sets (SQLite session extension, part of SQLite itself) for all three databases — one mechanism.
- **JS stays thin:** DOM, Worker plumbing, WebGL calls. No logic that can live in the proven core.

## Open question (decide by measurement)
SQL-terminal queries and playback frames both want the active battle's files. With one owner worker a long terminal query
stalls playback. Options: a per-query time budget with `sqlite3_interrupt` and an explicit "query too slow" state, or a second
read-only owner of a copy. Start with the time budget; revisit only if it measurably hurts.

## Speed budgets (proposals — confirmed against a baseline of the old engine on the 1.1 GB file, then enforced as CI gates)
| Scenario | Budget |
|---|---|
| First battle visible after choosing the 1.1 GB file | <= 3 s |
| All 158 battles extracted (background; viewer fully usable meanwhile) | <= 60 s |
| Frame time p99 at 1,025 agents + corpses on the bad-PC profile (4-6x CPU throttle, software GL) | <= 16.6 ms |
| Seek to first complete frame | <= 100 ms |
| Switch to an already-extracted battle | <= 200 ms |
| SQL terminal query on the active battle (indexed, <= 100k rows) | <= 100 ms typical; hard time budget with a visible "too slow" state |
| Export one battle to .tar.xz | measured, target <= 5 s for a typical battle |

## Speed decisions that follow
- **Read the source file in place.** A dedicated worker reads the user's File synchronously with `FileReaderSync` through a
  tiny read-only VFS using large (>= 1 MiB) sequential reads with read-ahead. No 1.1 GB copy into browser storage, no ingest
  phase, no duplicate on disk. (Old design: copy every byte into OPFS, then 4 KiB reads = ~262k JS calls per GB.) The source is
  copied into the workspace only if the user edits it (copy-on-first-edit, explicit, with progress).
- **Never block the first picture on a whole-file hash.** Workspace identity is cheap (name, size, mtime + hash of head/tail
  blocks); the full SHA-256 runs in the background for verification.
- **Boundary detection touches only `ticks`/`events`** (0.15 s on the 81k-tick file) and extraction starts with the battle on
  screen; the remaining battles extract in the background in time order.
- **Set-based SQL only** (no O(K^2) JSON folds); small per-battle files are fully indexed once, so playback queries are
  index lookups; indexes are built off the playback worker.
- **Proven units compile with run-time checks suppressed.** The proof replaces the checks (smaller, faster wasm); anything not
  fully proven keeps its checks.
- **SQLite `THREADSAFE=0`** (no mutex overhead), single-threaded allocator, zero-copy frame hand-off by transferring buffers.
- **Draw cost independent of data:** instanced draws, GPU interpolation, one buffer upload per frame, render queries run on
  tick change only.

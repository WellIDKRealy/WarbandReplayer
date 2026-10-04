# Charter: simple, complete, fast

> "An idiot admires complexity, a genius admires simplicity." — Terry Davis

Three goals, all binding, none traded for another: **as simple as possible**, **every feature kept**, **fast**.

## The complexity rule
Complexity is allowed **only when it is necessary**, and necessary means *justified in writing by a measured performance gain or
a required feature*. Where complexity has to exist (real multi-threading, a streaming codec, a proof protocol) keep it and make it
**correct**; where it does not have to exist, it must not. A justification is one short entry in `docs/justifications.md`:
what it costs, what it buys (numbers or the feature row), and the measured alternative it beat.

## Rules
1. **Guarantees first, in plain words.** Every unit's README opens with a "Guarantees" list a newcomer can read in a minute
   (at most ~10 lines). If the guarantees do not fit, the unit is too big or too clever: split it or cut it.
2. **Short public specs.** Proof scaffolding (lemmas, ghost helpers) lives in child packages (`*.Proofs`), never in the interface.
3. **No bloat, no frameworks.** Allowed: GNAT (+LLVM backend) for Ada, clang only to compile SQLite's C (and a thin C shim where
   Ada cannot express the ABI), `wasm-ld`, `make` + `gprbuild`, and small hand-written JS (DOM, Workers, WebGL calls). **Not allowed:**
   Emscripten/emcc, bundlers, npm dependencies, transpilers, generated glue. Python is for dev-time test oracles only.
4. **One idea, one mechanism.** One data flow (source -> battle replay -> battle db -> frames), one checkpoint mechanism (change-sets),
   one ownership rule (a file has one owner thread at a time).
5. **Fast is a requirement, measured, not hoped for.** The budgets below are CI gates on real data. Simplicity never excuses a missed
   budget; speed never excuses unnecessary complexity.
6. **Every line pays rent.** Each piece of code serves a row in `FEATURES.md` or `failure-modes.md`. No row -> delete it.
7. **Size is reported.** At cut-over, lines of code per layer are compared with the old tree; growth is justified.

## Decisions that follow
- **Real multi-threading stays.** The old engine used real shared-memory WASM threads (not a single-writer-then-freeze workaround)
  and the owner found it necessary for speed. Thread roles: a **playback thread** (frames and render queries; never blocked by
  background work, which is what makes 60 FPS possible), an **extraction/derivation pool** (boundary detection, per-battle extraction
  and derivation, prefetch of neighbouring battles, the explicit extract-all), and **helper threads** (background SHA-256, multi-block
  xz). Each role gets a justification entry with a measured gain over its single-threaded alternative.
- **Threading is done correctly, not recklessly.** Share nothing mutable except atomic ready flags/counters and immutable published
  buffers; each thread has its own SQLite connection(s) and its own arena; a file has one owner at a time. Consequences: the old racy
  cross-thread VFS lock automaton is *deleted, not patched* (no cross-thread file locking is needed), and the mutexes SQLite needs for
  its few globals are real (the old mutex implementation existed but was never registered — a latent data race). The remaining
  cross-thread protocol (mutex, ready flags, frame hand-off) is small, its sequential state machines are proven, and its interleavings
  are model-checked and stress-tested (register item R4).
- **Source file read in place.** Threads read the user's File with `FileReaderSync` through a tiny read-only VFS using large (>= 1 MiB)
  sequential reads with read-ahead — in parallel from several threads. No ingest phase, no 1.1 GB copy; the source is copied into the
  workspace only on the first edit of it (explicit, with progress).
- **No whole-file work before the first picture.** Workspace identity is cheap (name, size, mtime, head/tail hash); the full SHA-256 runs
  in the background. Boundary detection touches only `ticks`/`events` (0.15 s on the 1.1 GB file); a battle is extracted on demand by
  rowid range (found by bisection), so no pass over `agent_states` is needed to show a battle.
- **wasm32 first.** Large data stays on disk and per-battle files are small; wasm64 is considered only if a measurement shows wasm32 is
  insufficient.
- **Old priming/eviction machinery is replaced** by per-battle files (only the active battle is open). Background prefetch of
  neighbouring battles runs on idle pool threads and exists only if the open-battle budget cannot be met without it.
- **Rendering, simplest first:** instanced draws, GPU interpolation, one buffer upload per frame, the playback thread preparing the next
  tick while the current one is drawn. A deeper look-ahead and a GPU symbol atlas are added only if the 60 FPS gate fails.
- **Checkpoints:** change-sets (SQLite session extension, part of SQLite) for all three databases.
- **Proven units compile with run-time checks suppressed** (the proof replaces them); unproven code keeps its checks.
- **JS stays thin:** DOM, Worker plumbing, WebGL calls. No logic that can live in the proven core.

## Speed budgets (confirmed against a baseline of the old engine on the 1.1 GB file, then enforced as CI gates)
| Scenario | Budget |
|---|---|
| First battle visible after choosing the 1.1 GB file | <= 3 s |
| Open an unopened battle (extract + derive) | <= 1.5 s |
| Background extract-all of the 158 battles on 4 cores (explicit action) | <= 60 s |
| Switch to an already-extracted battle | <= 200 ms |
| Frame time p99, 1,025 agents + corpses, bad-PC profile (4-6x CPU throttle, software GL) | <= 16.6 ms |
| Seek to first complete frame | <= 100 ms |
| SQL terminal query on the active battle (indexed, <= 100k rows) | <= 100 ms typical; hard time budget with a visible "too slow" state |
| Export one battle to .tar.xz | measured; target <= 5 s for a typical battle |

## Open question (decide by measurement)
Terminal queries and playback both want the active battle's files. Start with queries on the owner thread under a time budget; move
read-only queries to a separate reader thread (which then needs a correct in-process lock table) only if a stall is measured.

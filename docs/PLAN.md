# WarbandReplayer overhaul — as simple as possible, ALL features, FAST, proven

## Context
One overhaul (owner: "overhaul, while preserving ALL FEATURES"). Behaviour source of truth: the 33 commits + `b83c380`
("local work to rebase later"; the claude branch is fast-forwarded to it). The old C/JS tree stays untouched until parity and is the
differential-test ORACLE. Owner's rules, all binding, none traded for another (full text: docs/CHARTER.md):
1. **Simple, and complexity only when necessary:** added only when a measured performance gain or a required feature justifies it, with
   the justification written down (`docs/justifications.md`); where complexity must exist (real multi-threading, streaming codec, proof
   protocols) keep it and make it correct; where it need not exist, it must not. No emcc/bundlers/npm/transpilers; one mechanism per idea.
2. **All features** kept (docs/FEATURES.md is the acceptance checklist).
3. **Fast**, measured: the budgets below are CI gates on real data. **60 FPS on even bad PCs.** **Real multi-threading stays** (the old
   engine's threads were found necessary for speed).
4. **Proofs before tests.** Port everything portable to Ada/SPARK; anything unprovable -> I explain why, and it may be tested instead ONLY
   with the owner's explicit permission (register below). If SPARK fails use another real prover. No workarounds.
5. **Every failure scenario handled** (docs/failure-modes.md): corrupted file etc. -> explicit typed error -> visible state; never silent
   truncation, wrong data, UB, hang or half-baked frame.
6. Handle ~1 GB (even 4 GB) replays. SQLite stays (C). `lua/main.lua` is FROZEN; databases/schemas MAY change.
7. Database/SQL model per the owner's spec (two modes, 3 selectable databases, everything editable with checkpoints).
8. **At the very end: rewrite git history** into a clean, sensible-to-read history (force-push authorised) — Phase 9.

## Ground truth (old code at b83c380 + real corpus; agents read, I spot-checked key claims)
- Old engine: 1 connection `g_db` + ATTACHed copies `r`, `b`, `bc0..15`; scope dropdown = JS text rewrite; edits live in a never-released
  SAVEPOINT, never committed, vanish on reload; many staleness hazards (Appendix A). Real shared-memory WASM threads (loader / readers /
  prefetch / playback roles) with per-thread heaps; the README and `benchmark.html` (parallel-load wall clock) are the record of why.
- Real corpus (`lua.7z`, 39 files, 2.9 GB, same 9-table schema, all pass `quick_check`, 8 are empty 48 KB shells): the 1.1 GB file has 15.3M
  agent rows, 81k ticks over ~32 h and **158 battles — the old engine silently shows 16**; 3 more files exceed the cap. Boundary detection
  touches only `ticks/events` (0.15 s). Full `quick_check` of the 1.1 GB file = 73 s (cannot gate loading).
- Old defects: 8/16 KiB SQL buffers written by JS before C clamps; only the first statement runs; unchecked chunk lengths; sprintf overflow
  in a debug export; realloc-failure buffer overflow; zero screen height -> NaN camera; int-typed byte budgets wrap at 2 GiB; 16-battle cap;
  recorder uses `journal_mode=MEMORY`+`synchronous=OFF` (a crash leaves inconsistent files); **threading defects:** the custom SQLite mutex
  is never registered (threads run on shared SQLite globals with no-op mutexes = latent data race), the VFS cross-thread lock automaton
  is racy (no common atomic step), `heap.c` ALIGN8 wrap / cross-thread-free accounting underflow / thread ids >= 10 alias a slab,
  `time_t` is 32-bit. Defects in code the new design deletes vanish with it; defects in kept behaviour become proof obligations.

## Architecture (the simplest thing that meets every rule)
- **Languages/toolchain:** Ada/SPARK (GNAT, GNAT-LLVM backend -> wasm32 objects), SQLite C compiled by clang (+ a thin C shim only where Ada
  cannot express the ABI, e.g. wasm atomics if GNAT-LLVM cannot), `wasm-ld`, `make` + `gprbuild`, small hand-written JS (DOM, Workers, WebGL
  calls). wasm32 first; wasm64 only if a measurement proves wasm32 insufficient (large data stays on disk; per-battle files are small).
- **Real shared-memory WASM threads** (`--shared-memory`, atomics; COOP/COEP via `coi-shim.js` + `serve.py` headers stay). Roles:
  (1) **playback thread** — frames and render queries, owns the active battle's R/B, never blocked by background work (what makes 60 FPS
  possible); (2) **extraction/derivation pool**, N = clamp(cores-1, 1, 8) by cores/`deviceMemory` with an override flag — boundary
  detection, per-battle R_k extraction and B_k derivation, prefetch of neighbouring battles, explicit extract-all, parallel reads of S;
  (3) **helper threads** — background SHA-256, multi-block xz. Each role gets a justification entry with a measured gain over its
  single-threaded alternative (method = the old `benchmark.html` approach, rebuilt without asyncify if possible).
- **Threading discipline (correct, not reckless):** share nothing mutable except atomic ready flags/counters and immutable published
  buffers; each thread owns its SQLite connection(s) and its own fixed arena (per-thread allocator, no region growth; arena exhaustion =
  typed OOM error); **one owner per file at a time** (writer publishes atomically, next owner opens) so no cross-thread file locking is
  needed -> the racy VFS lock automaton is DELETED, not patched; the few global mutexes SQLite needs are real, implemented over atomics and
  actually registered (`SQLITE_THREADSAFE` multi-thread mode). The remaining cross-thread protocol (mutex, ready flags, frame hand-off) is
  small: its sequential state machines are proven, its interleavings are model-checked and stress-tested (register R4).
- **Source read in place:** threads read the user's File via `FileReaderSync` through a tiny read-only VFS (>= 1 MiB sequential reads +
  read-ahead), in parallel; no ingest phase, no 1.1 GB copy; S is copied into the workspace only on its first edit (explicit, progress).
  Workspace identity = cheap id (name, size, mtime, head/tail hash); the full SHA-256 runs in the background, never before the first picture.
- **Workspace (OPFS):** `battles` index, R_k and B_k files, scripts, change-set logs; persisted across sessions.
- **Proven core in `spark/`:** `leaf` (tar/octal, civil time, tokenizer, sha256, mem/str shim), `core` (tick index + interpolation, boundary
  segmentation, camera/projection, frame-snapshot swap, loader/lifecycle + per-battle status state machines, validators, change-set history
  log, write-back statement builder, mutex/ready-flag state machines), `engine` (Ada binding to SQLite C, workspace pipeline). Every unit's
  README opens with <=10 lines of plain-English Guarantees; proof scaffolding lives in `*.Proofs` child packages. Proven units compile with
  run-time checks suppressed (the proof replaces them); unproven code keeps its checks.

## Data model, modes and SQL editing (owner spec; [A] = my reading, confirm at approval)
- **Replay mode:** S (original `.sqlite`, may be 1 GB+) -> determine battle bounds on S -> for each battle k a **per-battle raw replay DB**
  R_k (recorder schema restricted to that battle: ticks, events, chats, spawns, kills, switches, agent_states in its range, plus `wr_meta`:
  source id/SHA-256, tick/rowid range, scene, factions, map bounds) -> the **battle SQL DB** B_k (derived: roster_history, corpses, ...) from R_k.
- **Battle mode:** input is ONLY a per-battle R_k (a valid one-battle replay, same schema); B_k derived from it. [A] No S exists; the selector
  shows 2 entries. "Export Battle (.tar.xz)" = bundle R_k + B_k + manifest; "Load Battle Export" = battle mode.
- **Exactly 3 selectable databases** (selector, Schema Explorer, terminal, data viewer): Original replay S, Per-battle replay R of the ON-SCREEN
  battle, Battle B of the ON-SCREEN battle. R and B re-point automatically on battle switch (they ARE the battle's files). Each selection opens
  exactly one file as `main`: no ATTACH, no table-name rewriting, no hidden schemas.
- **On-demand extraction** [A]: boundary detection fills the `battles` index and the timeline shows all 158 battles at once; a battle's R_k/B_k
  are built when first opened (rowid range by bisection, no whole-file pass) and cached in the workspace; neighbours may be prefetched on idle
  pool threads and "Extract all" is an explicit action. Timeline status per battle: not-opened / extracting / ready / damaged.
- **Derivation DAG:** S -> boundary script -> R_k -> derive script -> B_k; scripts (boundary, derive, render/chat/NATO queries) are editable
  artifacts in the workspace.
- **Everything editable + checkpoints** [A]: ONE mechanism — persisted change-set logs (SQLite session extension) for all three DBs, text diffs
  for scripts; named checkpoints, undo/redo, revert. Editing upstream re-derives downstream; downstream edits are re-applied on top of the
  re-derived content with conflicts shown — **an edit is never silently lost**. Editing R_k never writes back to S (explicit "reset battle from
  source"). Edits persist and export as files.
- **Write-back viewer:** quoted identifiers, typed values (NULL != 'NULL'), one transaction per Save, strict eligibility (single table, no
  aggregate/alias/join), all statements of multi-statement input run, no fixed query buffers; the statement builder is proven.
- **No effects-cache DB**; render output is cached as the next-tick snapshot only.

## Fast: budgets (CI gates; numbers confirmed against a baseline of the old engine on the 1.1 GB file)
| Scenario | Budget |
|---|---|
| First battle visible after choosing the 1.1 GB file | <= 3 s |
| Open an unopened battle (extract + derive) | <= 1.5 s |
| Background extract-all of the 158 battles on 4 cores (explicit action) — justifies the pool | <= 60 s |
| Switch to an already-extracted battle | <= 200 ms |
| Frame time p99, 1,025 agents + corpses, bad-PC profile (Chromium, 4-6x CPU throttle, SwiftShader) | <= 16.6 ms |
| Seek to first complete frame | <= 100 ms |
| SQL terminal query on the active battle (indexed, <= 100k rows) | <= 100 ms typical; hard time budget -> visible "too slow" state |
| Export one battle to .tar.xz | measured; target <= 5 s for a typical battle |
Playback: main thread = draw only (instanced draws, GPU interpolation, one buffer upload per frame, no per-agent JS call, skip frames when idle).
Render queries run on TICK change against small fully indexed R_k/B_k; the playback thread prepares the next tick while the current one is drawn
(frame-snapshot swap protocol proven: never draw an unpublished snapshot, never overwrite one in use). A frame is shown only when complete; during a
seek the last complete frame stays with an explicit state. Simplest first: NATO symbols stay an SVG overlay and there is no deep look-ahead; a GPU
symbol atlas / look-ahead are added ONLY if the 60 FPS gate fails (measurement recorded). Chat = incremental query by tick range + virtualised list;
DPR cap; corpse cap/LOD for dense battles. Terminal queries start on the owner thread under a time budget; a separate read-only reader thread (needing
a correct in-process lock table) only if a stall is measured.

## Toolchain status and Gate 0
- git access to all needed repos works; github.com web pages/APIs stay blocked (irrelevant). `apt`, Alire, GitHub release assets, PyPI, npm,
  Google Drive reachable.
- **Proof half DONE:** gnat_native 14.2.1, gprbuild, gnatprove 14.1.1 (Z3 4.13, CVC5) via Alire; spike `spark/spikes/tick_lookup`: 27 checks, 0 unproved,
  0 assumptions; `spark/tools/prove.sh` is the gate (exit 0 iff 0 unproved).
- **Codegen half:** GNAT-FSF has no wasm backend; Ada -> wasm32 uses GNAT-LLVM via AdaWebPack's CI recipe (gnat-llvm@66e36d9, bb-runtimes gnat-fsf-14,
  gcc-14.1.0 `gcc/ada`, LLVM 16.0.4 binary, two patches, `make wasm`; limits: no nested subprograms, no tasks/protected types, only local exception
  propagation — compatible with the charter since threads are JS Workers + shared memory, not Ada tasks). Build launched with owner consent (plan
  approval); its progress is not observable to me because the auto-mode classifier blocked reading its log. **Gate passes when:** the proven tick-lookup
  compiles to a wasm32 object, links with a C stub via `wasm-ld`, runs in node; AND a shared-memory atomics spike (CAS counter + ready flag across two
  Workers) works from Ada, or from the thin C shim if GNAT-LLVM cannot lower Ada atomics.
- If A fails: report it, then evaluate B (Isabelle/HOL + Isabelle-LLVM; needs host `dist.isabelle.cit.tum.de`) and C (Why3/Coq via apt, Frama-C/WP on
  the existing C, F*/KaRaMeL). No silent pivot, no unproven stand-in. Decision recorded in `docs/toolchain-decision.md`.

## Proof policy and the proof-boundary register
Every unit: SPARK contracts first (Silver: no run-time errors; Gold: functional postconditions that PIN behaviour); `spark/tools/prove.sh` exits 0
(0 unproved, 0 unregistered `pragma Assume`); a scripted MUTATION of the body must make gnatprove FAIL (the spec is not vacuous); native differential
tests against the old-tree oracle on all 31 real files + randomised/corrupted inputs; suites < 10 s. Things that cannot be proven — each needs the
owner's explicit permission to be tested instead:
 R1 SQLite internals (C, stays by decree; includes the session extension) — Ada binding contracts are trusted assumptions; mitigated by differential
    tests vs the old engine and `integrity_check` on produced files.
 R2 JS/DOM/WebGL/OPFS/FileReaderSync/Workers/browser/wasm engine.
 R3 The compiler chain (GNAT-LLVM, clang, wasm-ld): proofs cover source semantics only.
 R4 Cross-thread memory ordering of the atomics protocol (mutex, ready flags, frame hand-off): not expressible in SPARK; sequential state machines are
    proven; interleavings are model-checked (TLA+/Spin) and stress-tested.
 R5 Floating point beyond finiteness/range/error bounds, and GLSL: `sinf/cosf` replaced by constants (proven), shaders tested against a CPU reference.
 R6 LZMA SDK (vendored C): wrapped by a proven Ada driver (buffers/lengths/termination); codec trusted; round-trip + xz-reference tests.
 R7 Payload bit-flips inside structurally valid SQLite pages are undetectable (frozen recorder writes no checksums); mitigated by plausibility
    validation + a visible report.

## Phases (each ends: gnatprove clean + FEATURES rows green + budgets met + failure-mode rows covered)
0. **Environment, data, behaviour lock** — mostly done (branch, tools, real data outside the repo, boundary goldens, FEATURES.md, profile, failure-mode
   catalogue). Remaining: synthetic 1 GB / 4 GB fixtures (`testdata/make_synthetic_fixture.py`), old-engine baselines (time/RSS on the 1.1 GB file,
   golden frames via the Playwright harness).
1. **Gate 0** (above).
2. **Leaf and core proofs** via Workflow: batch 1 running — boundary_segmentation, tick_index, tar_layout, civil_time, sql_tokenizer (+ `eviction_policy`,
   now redundant because per-battle files replace the old priming/eviction; remove after the run). Per unit: author -> prove -> 3 independent verifiers
   (mutation, differential, fidelity/assumption audit) -> bounded repair -> commit. Then audits: robustness (totality on malformed input), simplicity
   (guarantees short and readable, nothing unneeded), speed (native benchmark). Batch 2: validators (SQLite header/page-count, recorder schema, data
   sanity, bundle), sha256, write-back statement builder, camera/projection, frame-snapshot swap, loader/lifecycle and per-battle status state machines,
   workspace atomic publish, change-set history log, mutex/ready-flag state machines, mem/str shim.
3. **Runtime base:** first the **threading spike** (`docs/justifications.md`: playback/pool/helper roles vs single-threaded alternatives on the 1.1 GB file and
   the bad-PC profile; frame hand-off by shared buffer vs transfer; per-thread arena allocator vs SQLite memsys5), then wasm32 build wiring, shared-memory
   threads, atomics mutex registered with SQLite, minimal VFSs (read-only FileReaderSync for sources, OPFS for workspace files), JS loader.
4. **Engine + workspace pipeline:** Ada binding to SQLite, boundary detection -> `battles` index, on-demand extraction (+ prefetch/extract-all on the pool),
   set-based B_k derivation (no JSON fold), validation, damage isolation, tar.xz bundle export/import (bounded buffers).
5. **Rendering + 60 FPS gate.**
6. **Editing:** change-set/checkpoint engine, 3-DB selector UI, write-back viewer, script editors.
7. **Robustness completion:** `testdata/corrupt/` fault injection (truncate, zero/swap pages, flip bits, drop tables, poison values, reorder ticks) through
   the whole pipeline; every failure-mode row ticked.
8. **UI shell cut-over:** delete the old tree and dead code, fix stale Docs text, report LOC per layer old vs new, final checks.
9. **History rewrite (owner-authorised, `--force` allowed; done last, after everything is green):** (a) back up first — `git bundle create` of all refs saved
   outside the repo, and ask whether to push a backup ref; (b) rebuild the history into a clean, readable series: squash/reword the noise ("balls",
   "ai goyslop", "DEMO", submodule fix/remove/re-add churn, "Partial update", "local work to rebase later", every WIP snapshot) into meaningful commits with
   proper messages, preserving the owner's authorship for their commits, and give the overhaul a logical per-phase/per-unit series; (c) verify the final tree is
   byte-identical to the pre-rewrite tip (`git diff` empty); (d) `git push --force-with-lease` to `claude/gifted-hawking-ukeg1n`; replacing `master` (where the
   owner's "local work to rebase later" lives) happens only after confirming with the owner at that moment. Old hashes change; clones must reset.

## Current state and next actions
Done: branch at `b83c380` + pushed commits (docs, tooling, WIP snapshots, corrected charter); proof tooling; real data + goldens; GNAT-LLVM build launched; batch-1
workflow running (2 concurrent agents on 4 CPUs; ~2 h per author; verifications queue behind all authors).
Next: (1) read batch-1 results, fix/redo failed units, remove `eviction_policy`; (2) run robustness/simplicity/speed audit lenses on every unit; (3) batch 2;
(4) synthetic fixtures + old-engine baselines (when CPU is free of provers); (5) Gate 0 spikes once the build is confirmed; (6) continue down the phases.

## Verification (end to end)
`gnatprove` 0 unproved on every unit (CI gate); mutation check per unit; differential run old vs new on all real files + synthetic 1/4 GB (match table, frames,
chat, exports); fault-injection suite green; Playwright/Selenium suites from `testdata/` kept and extended; every FEATURES.md row checked in Chromium and
Firefox; every budget measured; thread justifications recorded; LOC per layer reported at cut-over; final tree identical across the history rewrite.

## Needs the owner
1. Confirm my readings [A]: battle mode shows 2 selector entries; on-demand extraction with idle prefetch and explicit extract-all; edits persist in OPFS and
   export as files; downstream edits re-applied as change-sets with conflict reporting; R_k edits never write back to S; S read in place with copy-on-first-edit;
   no effects-cache DB.
2. Object to any other design choice: wasm32 first; one checkpoint mechanism; per-thread arenas; deleting (not patching) the VFS lock automaton; SVG NATO overlay
   first.
3. Features tied to deleted mechanisms — keep or drop: `?primingBudgetMiB=` (priming budget no longer exists); the cube demo (`index.html`); `benchmark.*` is KEPT as
   the justification harness (default). Debug "lock counters" become mutex counters, "heap info" becomes arena usage.
4. Permission decisions for register items R1-R7.
5. Monitoring the GNAT-LLVM build: add a Bash permission rule for reading its log (or tell me explicitly it is fine).
6. Confirm the budget numbers.
7. Behaviours that look like bugs but may be intended — which to preserve: `ticks.time` is whole seconds (sub-second ticks collapse); default living-agents query
   shows only `is_human = 1`; SQL/Logs/VFS panels are debug-only; corpses accumulate for the whole battle; the Docs panel claims edits show "on the very next frame".
8. History rewrite: whether to push a backup ref first, and confirmation before replacing `master`.

## Appendix A — old SQL design: hazards the new model removes, catalog to preserve
Hazards: `g_ticks`/`g_matches` loaded once; `r` stale until rebuilt; default living-agents query `@CACHE tick` hides current-tick edits; editing `r` is wiped by
the next rebuild and every `r` rebuild invalidates `b` + all `bcN`; edits to `b` lost on rebuild; checkpoints roll back SQLite but not JS `renderQueries` nor C
`custom_sql`; export ignores `custom_sql` and `b` edits; DETACH result ignored; empty `knownSchemas` makes the scope dropdown silently target `main`; write-back =
JS string concat (unquoted names, all TEXT, `'NULL'` string, weak eligibility, no transaction); only the first statement runs; `cp0` never released.
Catalog to preserve (`sql/`, compiled in via `scripts/gen_canonical_sql_header.py`): default_boundary_detection; canonical_roster_corpse / canonical_roster_history /
canonical_corpses (B_k derivation, `ground_truth.py` oracle); default_render_corpses, default_render_living_agents (interpolated), default_render_chat (JS-only kind),
sample_render_nato_symbols. SQL functions (public query API): CURRENT_TICK, CURRENT_TICK_B, CURRENT_TIME, CURRENT_BATTLE, CURRENT_BATTLE_TICK_START/END,
CURRENT_BATTLE_ROWID_LO/HI, CURSOR_X/Y. Directives `@KIND @CACHE @INTERPOLATE @SHAPE`. Recorder schema (FROZEN): ticks, events, chats, map_switches, score_switches,
faction_switches, kills, spawns, agent_states.

## Appendix B — FEATURES.md seed (full list with file:line in docs/FEATURES.md)
Loading: `.sqlite` upload; Load Battle Export (.tar.xz); loading overlay + progress; thread-count override flag; `index.html` redirect; dev server with COOP/COEP;
URL flags `?debug=1`/`wb_debug`. Playback: timeline with per-battle blocks (click to jump) and readiness indicators, scrub slider, play/pause (Space), speed 0.5-8x,
match info text, auto-pause at end. Camera: WASD pan, mouse-drag pan, wheel zoom (0.02-40), Ctrl+Scroll panel text zoom, typing guard, auto-fit to map bounds,
auto-follow (WASD/drag cancels), Re-center, centre crosshair. Rendering: 3-adic grid shader, map box, dots/rings, default queries (corpses, living agents
red/blue/grey interpolated, chat), NATO APP-6 symbol layer. Panels: chat (team colours, auto-scroll), draggable/resizable/minimise/maximise/close/z-order,
multi-instance "+", hamburger menu, visibility toggles (debug). Export/import: Export Battle (.tar.xz), load export, Export/Import SQL Set, dictionary size by
device memory. SQL tooling (debug): terminal (selector, Run, Ctrl/Cmd+Enter, highlight, line numbers, shared autocomplete, editable results + Save, error
line/col, checkpoints, pop-out data viewer), Schema Explorer + generator-script editors, Rendering Queries panel, SQL Docs, Logs, VFS trace (index visible, traces,
mutex counters, arena info). Engine: SQL boundary detection, battle readiness/status, checkpoint revert re-derivation, error recovery. Dev: `testdata/*` pages,
`ground_truth.py`, `make test`, recording script, Playwright/Selenium, benchmark harness. NOTE: `testdata/replays_batch/*.sqlite` are git-LFS pointers in this
clone (real bytes absent); the Drive `lua.7z` is the only real data.

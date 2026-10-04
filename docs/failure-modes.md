# Failure-mode catalogue — "every single possible scenario is handled"

**Policy (owner requirement).** Every failure is *detected*, becomes an explicit typed error, and ends in a
user-visible state that says what happened and what can still be done. Never: silent truncation, silently
wrong data, undefined behaviour, a hang, a wedged UI, or a half-baked frame. Each row below maps to at least
one of:

- **PROOF** — a SPARK contract (no run-time errors, total on all inputs, explicit error result),
- **FAULT** — a fault-injection test (corruption fuzzing of real files, driven through the whole pipeline),
- **E2E** — a browser-level test.

A row is only ticked when its PROOF/FAULT/E2E reference exists. Rows are grouped by layer.

## A. Source / per-battle replay file (SQLite, recorder schema)
- [ ] 0-byte file; file smaller than 100 B; the 48 KB "empty shell" recordings that really exist (8 of 39 real files: schema, 0 ticks) -> "empty recording", not an error screen
- [ ] Not SQLite (bad magic), garbage, encrypted, wrong extension, a `.7z`/`.tar.xz` picked by mistake
- [ ] Header damage: page size not a power of two in 512..65536, bad text encoding, reserved bytes, version numbers, change counter
- [ ] **Truncated file** (page count in header > pages present; size not a multiple of page size; copy interrupted)
- [ ] **Recorder crash mid-write**: `lua/main.lua` uses `journal_mode=MEMORY`, `synchronous=OFF`, one transaction per tick, so a crash/power loss can leave a *structurally inconsistent* database (frozen recorder, cannot change)
- [ ] Hot journal / WAL leftovers next to the file; file modified while being read (File object changed under us)
- [ ] Page-level corruption: zero-filled pages, swapped pages, freelist/b-tree damage -> `SQLITE_CORRUPT` at any query, at any phase (extract, derive, playback, export)
- [ ] Valid SQLite, wrong schema: missing table/column, wrong types, extra tables, older/newer recorder versions
- [ ] Valid schema, bad data: non-monotone tick ids or times; equal times (whole-second resolution — normal); time jumps (32 h server idle); duplicate ids; orphan events / agent_states without tick; agent_id outside 0..1024; negative ids; team not in {0,1}; NULL in NOT NULL columns; NaN/Inf/huge positions; absurd strings (MB-long names/chats)
- [ ] Degenerate shapes: 0 battles, 1 tick, boundary at tick 0 or last tick, all ticks in the first 5, a battle with 0 agents, 100k agents in one tick, 158+ battles (real), >2^31 rows, >4 GiB file
- [ ] **Undetectable-by-construction**: payload bit-flips in structurally valid pages (the frozen recorder writes no checksums). Mitigation = plausibility validation (ranges, monotonicity, rates) with a visible "plausibility violations" report. **Cannot be proven away -> proof-boundary register R7, needs owner permission.**

## B. Battle bundle (`.tar.xz`: manifest, replay.db, battle.db)
- [ ] Truncated xz stream, bad CRC/check, unsupported filter, dictionary larger than memory, xz bomb (output size explosion)
- [ ] Bad tar header checksum, size field overflow / non-octal, negative or absurd sizes, short final block, missing end blocks
- [ ] Path traversal / absolute / duplicate / unknown entry names; missing manifest, replay.db or battle.db
- [ ] Manifest version unknown; SHA-256 mismatch; replay.db and battle.db from different sources/battles; battle.db derived by a different script version

## C. Environment and platform
- [ ] OPFS unavailable (private mode), quota exceeded mid-write, eviction by the browser, `persist()` denied, storage cleared during a session
- [ ] SharedArrayBuffer unavailable (no COOP/COEP), `Memory.grow` fails, worker creation fails or dies silently (watchdog), Firefox exclusive sync-handle limits
- [ ] Two tabs on the same workspace; tab backgrounded (RAF throttling); low RAM / low-end GPU; WebGL unsupported or context lost; shader compile/link failure
- [ ] Canvas size 0, devicePixelRatio extremes, resize during load; browser without memory64 (wasm64 build must degrade to wasm32 path)

## D. Workspace persistence (S -> R_k -> B_k files)
- [ ] Tab closed mid-extraction: files are published atomically (temp + commit marker), a half-written R_k/B_k is never opened; extraction resumes
- [ ] Workspace file corrupted/missing -> rebuilt from S with a visible reason; source file moved/missing on resume; workspace version migration
- [ ] Stale B_k after a script or R_k change (generation/hash mismatch) -> re-derive, never serve stale

## E. SQL and editing
- [ ] Syntax errors with line/column; queries longer than any fixed buffer; multi-statement input (all statements run)
- [ ] Runaway queries: cancel via `sqlite3_interrupt` + progress handler; result caps with an explicit "truncated at N rows" state
- [ ] DDL/DML that destroys required tables/columns or makes data invalid -> guard rails + validation error on re-derive, never a crash
- [ ] User script returns wrong columns/types/NaN/millions of rows; render query too slow (per-query time budget + visible state)
- [ ] Change-set conflicts on re-apply (reported, never dropped); undo past the start; checkpoint storage exhaustion; edit during extraction

## F. Rendering and playback
- [ ] 0 agents; NaN/Inf positions skipped and counted; seek beyond end / before start; play on an empty battle or a 1-tick battle
- [ ] Rapid battle switching (stale responses ignored, last request wins); drag/zoom extremes clamped; worker returns frames out of order

## G. Lifecycle
- [ ] Cancel during load/extraction; double load; reset while loading; unhandled worker error -> explicit failed state with retry, never a spinner forever

## Fault-injection harness (to build, Phase 6)
`testdata/corrupt/`: generate corrupted variants of real files — truncate at random offsets (page boundary and mid-page), zero a
random page range, flip bits in the header/b-tree/payload, swap pages, drop tables/columns, poison values (NaN, huge, negative,
NULL), reorder ticks — and run each through ingest -> validate -> extract -> derive -> first frames. Assertions: terminates within a
time bound, bounded memory, ends in either a valid (possibly degraded and *reported*) result or a typed error, never a crash,
hang, or silent-wrong result. Unit-level: every parser/validator in `spark/` is total (proven) and returns an explicit error
for malformed input; native differential tests feed it the same corruption corpus.

## Validation strategy (consequence of measurements)
- Load-time gate is O(1)/small: magic, page size, header page count vs file size, schema/column check, scans of the small tables
  (`ticks`, `events`, switches) for monotonicity/plausibility. A full `integrity_check` is NOT possible at load (1.1 GB = ~73 s quick_check).
- Extracting a battle reads exactly that battle's rowid range of `agent_states`, so extraction doubles as the integrity pass for those
  rows: `SQLITE_CORRUPT` raised there is mapped to that battle (and any battle whose range touches the damaged page).
- **Damage isolation:** a damaged battle is marked "damaged (rows lo..hi, reason)" and stays visible in the timeline; every
  other battle remains playable. One bad page never takes down the whole replay.
- Real corpus has no naturally corrupted file (all 39 pass `quick_check`), so every FAULT test uses injected corruption.

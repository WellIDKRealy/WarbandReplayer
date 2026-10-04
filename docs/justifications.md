# Justifications for complexity

Rule (docs/CHARTER.md): complexity is allowed only when necessary — justified by a **measured performance gain** or a **required
feature**. One entry per piece of non-trivial complexity: what it costs, what it buys (numbers or the FEATURES/failure-mode row),
and the simpler alternative it was measured against. Entries marked *pending* are decided by the measurement named in the entry;
until then the baseline in the entry applies.

| # | Complexity | Buys | Measured against | Status |
|---|---|---|---|---|
| J1 | Real shared-memory WASM threads (atomics, COOP/COEP) | Owner found them necessary for speed in the old engine; playback never blocked by background work (60 FPS); parallel battle extraction | single-threaded engine / separate non-shared instances on the 1.1 GB file and the bad-PC profile | baseline = threads; per-role numbers *pending* (Phase 3 threading spike) |
| J2 | Playback thread separate from the extraction/derivation pool | frames never wait for extraction, derivation or terminal queries | one thread doing both | *pending* |
| J3 | Extraction/derivation pool of N = clamp(cores-1, 1, 8) threads | open-battle <= 1.5 s, extract-all of 158 battles <= 60 s on 4 cores | single extraction thread | *pending* |
| J4 | Helper threads: background SHA-256, multi-block xz | first picture not blocked by the whole-file hash; export time | inline hash / single-block xz | *pending* |
| J5 | Per-thread fixed arenas (own allocator) | no allocator lock contention between threads | SQLite memsys5 (global, mutex-guarded) | *pending* |
| J6 | Small atomics protocol (real mutexes for SQLite globals, ready flags, frame hand-off) | correct multi-threading | none (required by J1); VFS lock automaton deleted instead (one owner per file) | required |
| J7 | Streaming tar+xz with bounded buffers | export/import of battles larger than a memory budget | whole-buffer | *pending* (needed only if a battle exceeds the budget) |
| J8 | Source read in place via FileReaderSync + tiny read-only VFS | no 1.1 GB copy, no ingest phase, first picture <= 3 s | copy into OPFS then read (old design) | chosen by the budget; confirm in Phase 3 |
| J9 | SQLite session-extension change-sets | one checkpoint mechanism for all three DBs; edits never silently lost | per-DB snapshots / SAVEPOINTs | required by the editing spec |

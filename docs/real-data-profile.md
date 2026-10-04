# Real replay corpus profile (owner-provided `lua.7z`)

Counts only — the data itself contains other players' names and chat and must never be committed
(`*.7z` is gitignored; keep extracted files outside the repo).

- Archive: 609,562,239 B (LZMA2, solid, 1 block) -> 39 files, 2,909,925,376 B (2.91 GB) unpacked.
- All 39 files have the identical 9-table recorder schema:
  `agent_states, chats, events, faction_switches, kills, map_switches, score_switches, spawns, ticks`.
- 8 files are empty 48 KB shells (0 ticks).
- Totals over all files: 166,232 ticks, 287,728 events, 40,555,984 `agent_states` rows (~72 B/row).
- **One 1.1 GB file** (`replayLog_2026-08-20_00-37-27`): 15,275,440 agent rows, 81,449 ticks spanning ~32 h,
  48,536 spawns, 39,446 kills, 1,135 chats, a single `map_switch` event.
- Next largest: 203 MB, 199 MB, 161 MB, 141 MB, 137 MB.

## Battle boundaries (old engine's `sql/default_boundary_detection.sql`, uncapped)
- 355 battles over 31 non-empty files (one file yields 0).
- **4 files exceed the old 16-battle cap**: the 1.1 GB file has **158** battles, others 22, 21 and 20.
  The old engine silently keeps only the first 16 (see `MAX_MATCHES`, `replay_worker.c`), so on the
  1.1 GB file 142 battles (90%) are invisible.
- The boundary query touches only `ticks` and `events`: 0.15 s on the 81k-tick file, no `agent_states` scan.
- Shortest accepted spans are 12-13 ticks; longest 2,586 ticks.

## Integrity of the real corpus
- All 39 files: valid SQLite magic, header page count == file size / page size (4096), `PRAGMA quick_check` = ok.
  **No naturally corrupted file exists in the corpus** — corruption test cases must be injected (see `docs/failure-modes.md`).
- The 8 "empty shell" files (48 KB) are structurally valid databases with the 9 tables and 0 rows.
- `PRAGMA quick_check` on the 1.1 GB file takes ~73 s, so a full integrity check cannot be a load-time gate.

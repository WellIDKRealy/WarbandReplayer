# Limits catalogue — every real limit, where it comes from, and what happens at it

**Rule (owner): "reflect the limits in proofs."** A proof about an idealised, unbounded world is worthless on a real platform. Every
numeric bound the system depends on is named once in the `Limits` package (`spark/leaf/limits`), comes from a documented source or an
owner decision, and is used by every unit. Proofs then state the behaviour **below, at and above** each limit: values within the limit
are handled exactly; a value beyond it yields an explicit typed `Limit_Exceeded` result — never wraparound, truncation, undefined
behaviour or a crash. Units must not invent their own ad-hoc bounds (`2**40`, `2**32`, ...): use a `Limits` constant or add one here first.

Status: **doc** = documented by the platform/SQLite, **owner** = decided by the owner/design, **measure** = to be confirmed by measurement
(`sqlite3_limit()` at build time for the SQLite rows, browser tests for the platform rows).

## SQLite (compile-time defaults; the build asserts the compiled-in values equal these)
| Limit | Value | Status | Where it bites | Behaviour at the limit |
|---|---|---|---|---|
| Header size | 100 bytes | doc | header validator | fewer bytes => `Too_Short` |
| Page size | 512..65536, power of two | doc | header validator, extraction | other => `Bad_Page_Size` |
| Page count | <= 4,294,967,294 | doc | header validator | more => `Bad_Page_Count` |
| Database size | <= page size x page count (~2.8e14 B) | doc (derived) | file acceptance | beyond => `Too_Large` |
| Rowid / integer | signed 64-bit | doc | all counters, ids, offsets | arithmetic proven overflow-free in 64-bit |
| String / BLOB / row length | <= 1,000,000,000 B | doc | write-back values, chat text | longer => `Value_Too_Long` |
| SQL statement length | <= 1,000,000,000 B | doc | terminal, scripts | longer => `Sql_Too_Long` |
| Columns per table/result | <= 2,000 | doc | schema validator, viewer | more => `Too_Many_Columns` |
| Attached databases | <= 10 (design uses <= 2) | doc | extraction (main + one attached source) | never exceeded by design |
| Bound variables | <= 32,766 | doc | write-back builder | more => `Too_Many_Variables` |

## WebAssembly / browser
| Limit | Value | Status | Where it bites | Behaviour at the limit |
|---|---|---|---|---|
| wasm32 linear memory | <= 4 GiB (65,536 pages); pointers are 32-bit | doc | every buffer, arena | allocation beyond => typed `Out_Of_Memory` |
| Configured maximum memory | 2 GiB (owner: wasm32 first; revisit only if a measurement demands more) | owner | arenas, shared memory | `memory.grow` failure => `Out_Of_Memory` |
| In-memory buffer length | <= 2^31 - 1 B (keeps 32-bit offsets sign-safe) | owner | all buffers | larger request => `Buffer_Too_Large` |
| JS Number exact integer | <= 2^53 - 1 | doc | file sizes/offsets crossing the JS boundary | source larger => `Too_Large` |
| Read chunk | <= 16 MiB per `FileReaderSync`/OPFS call | owner | source VFS | design constant (>= 1 MiB reads for speed) |
| OPFS / storage quota | browser-defined | measure | workspace files | write failure => `Storage_Quota` |
| Worker thread count | clamp(cores - 1, 1, 8) | owner | pool | override flag clamped to the same range |
| Engine behaviour at large wasm memory | V8 crashed (segfault) in this container's Node 22 when a wasm32 module held several hundred MB across repeated database open/close; Chrome/Firefox not yet tested | measure | benchmarks, CI | memory use per instance is bounded by the arena budget; CI measures real browsers, not Node |

## Recorder / domain (frozen recorder `lua/main.lua`, old engine constants)
| Limit | Value | Status | Where it bites | Behaviour at the limit |
|---|---|---|---|---|
| Agent id | 0..1024 (`MAX_AGENT_SLOTS` = 1025) | doc (old code) | data-sanity validator, render slots | outside => `Agent_Id_Out_Of_Range` counted |
| Team | 0 or 1 | doc | validators, renderer | other => `Team_Invalid` counted |
| Tick id / tick time | signed 64-bit; time in whole seconds | doc | tick index, boundary segmentation | arithmetic proven in 64-bit |
| Ticks / agent rows per file | bounded by the database size limit above (real max seen: 15.3M rows, 1.1 GB) | doc | extraction, indexes | counts are 64-bit; no fixed caps |
| Battles per file | **no cap** (old engine: 16, a defect); bounded by the `battles` index memory budget | owner | boundary segmentation | index full => `Battle_Index_Full`, never silent truncation |

## Owner/design limits (small, explicit, documented)
| Limit | Value | Where it bites | Behaviour at the limit |
|---|---|---|---|
| Identifier length (write-back, schema names) | <= 128 B | write-back builder, schema validator | longer => `Identifier_Too_Long` |
| Name length (checkpoints, scripts) | <= 64 B | change-set log | longer => `Name_Too_Long` |
| Checkpoints / history entries | bounded capacity set by the memory budget | change-set log | full => `Full` (explicit) |
| Render rows per slot / terminal result rows shown | bounded by the memory budget; exceeding shows an explicit "truncated at N rows" state | renderer, terminal | explicit state, never silent |
| SQL terminal time budget | hard per-query limit (default 5 s) | terminal | interrupted => `Query_Too_Slow` |

## How the limits reach the proofs
1. `Limits` (`spark/leaf/limits`) defines the constants and range subtypes (`File_Bytes`, `Page_Size`, `Page_Count`, `Buffer_Length`,
   `Agent_Id`, ...). Its own compile-time assertions prove the relationships between limits (e.g. the largest database fits a JS Number and
   a signed 64-bit integer; the configured maximum memory fits wasm32; every buffer length fits the configured memory).
2. Every unit takes its sizes, counts and ids as `Limits` subtypes at the boundary and returns `Limit_Exceeded(kind)` for anything outside
   — for the **full** machine range of the raw input type, not just the in-limit part — and its postconditions pin the behaviour at
   `limit - 1`, `limit` and `limit + 1`.
3. The build asserts that SQLite's compiled-in limits (`sqlite3_limit`) and the wasm memory configuration equal the constants.
4. Every limit crossing has a row in `docs/failure-modes.md` (section H) with a fault-injection or boundary test.

# sqlite_header

## Guarantees

`Validate (Header, Length, Size)` looks at the first (up to) 100 bytes of a file and its size, and tells you whether the SQLite header is sane **before SQLite is asked anything**. Proved with gnatprove (level 4, 0 unproved, no assumptions):

1. **Always answers.** Any 100 bytes, any `Length` 0..100, any file size 0..2^63-1 gives `Ok` or exactly one typed error. No exception, no undefined behaviour, no overflow, no silent cap or truncation.
2. **Each error means exactly its condition.** It is returned when its condition holds and no condition earlier in the precedence list below holds.
3. **`Ok` means the whole header is sane:** the `SQLite format 3` magic, a power-of-two page size 512..65536 with at least 480 usable bytes, version bytes 1 or 2, payload fractions 64/32/32, schema format 1..4, text encoding 1..3.
4. **`Ok` carries one page count by one rule:** the header's count if it is positive and its "version-valid-for" number equals the change counter, otherwise file size / page size.
5. **`Ok` means the file really holds the database:** `page_count * page_size <= file size`, and the file size is a whole number of pages (a cut-off copy is `Truncated`, never `Ok`).
6. Reads 100 bytes, no loop over the file, no allocation: well under 100 ns (PROOF.md). What it cannot see (a damaged b-tree, flipped payload bits) is for later layers (register item R7).

No old counterpart: the old engine handed the file straight to `sqlite3_open` (failure-modes.md section A rows: bad magic, truncated file, header damage, page-count mismatch).

## Interface

```ada
function Validate (Header : Header_Bytes;      --  the first Length bytes of the file (bytes >= Length are ignored)
                   Length : Header_Length;     --  0 .. 100
                   Size   : File_Size)         --  whole file, 0 .. 2**63-1 (64-bit, no 32-bit counts)
  return Result;                                --  Ok (Page_Size, Page_Count, Encoding, Wal) | Error (Error_Kind)
```

`Page_Size`: 512..65536. `Page_Count`: pages of the database (>= 1). `Encoding`: `UTF_8 | UTF_16LE | UTF_16BE`. `Wal`: read version is 2 (the database is meant to be used in WAL mode).
The postcondition in `src/sqlite_header.ads` is the specification; its ghost vocabulary (`BE32`, `Page_Size_Of`, `Pages_Claimed`, ...) is the SQLite file-format document transcribed.

## Error precedence

The first line that holds is the error returned (the order is the order of `Error_Kind`).

| # | Error | Condition |
|---|---|---|
| 1 | `Too_Short` | fewer than 100 header bytes given (`Length < 100`), or the file itself is smaller than 100 bytes (this includes the 0-byte file) |
| 2 | `Bad_Magic` | bytes 0-15 are not `SQLite format 3` + NUL |
| 3 | `Bad_Page_Size` | bytes 16-17 (big-endian; 1 means 65536) are not 512, 1024, ..., 32768, 65536; **or** the page size minus the reserved bytes per page (byte 20) is below 480 |
| 4 | `Bad_Version` | write version (byte 18) or read version (byte 19) is not 1 or 2 |
| 5 | `Bad_Payload_Fractions` | bytes 21, 22, 23 are not 64, 32, 32 |
| 6 | `Bad_Schema_Format` | schema format (bytes 44-47) is not 1, 2, 3 or 4 (0 = no schema: a replay always has tables) |
| 7 | `Bad_Text_Encoding` | text encoding (bytes 56-59) is not 1, 2 or 3 |
| 8 | `Truncated` | the database claims more pages than the file holds whole (`claimed > size / page size`; only possible when the in-header count is trusted) |
| 9 | `Zero_Pages` | the database has no page: nothing claimed and the file is smaller than one page |
| 10 | `Size_Not_Page_Multiple` | the file size is not a whole number of pages (trailing bytes, copy cut mid-page) |

Page count rule (item 4 of the guarantees): `claimed` = bytes 28-31 if that is > 0 **and** bytes 24-27 (change counter) equal bytes 92-95 (version-valid-for); otherwise `size / page size`. Whole extra pages beyond the claimed count are allowed (SQLite ignores them too); `Page_Count` is the claimed count.
Precedence note: a header damage is reported before any size problem; a file cut mid-page with an intact header reports `Truncated` (the more useful message), not `Size_Not_Page_Multiple`.

## Where the validator is stricter than SQLite (decided, justified)

Differential testing against SQLite 3.45.1 (`tests/oracle.py`, 24,000 committed mutations; PROOF.md) found these cases where SQLite opens a file the format document does not allow. **The validator follows the format document**: a replay is written by a known recorder (`lua/main.lua`: page size 4096, versions 1/1, UTF-8, always has tables), so tolerating odd files buys nothing and hides damage.

| Case | SQLite | Validator |
|---|---|---|
| 0- or 1-byte file | empty database, opens | `Too_Short` (nothing to replay) |
| write version 0 or 3..255, read version 0 | opens (3+: read-only; 0: legacy) | `Bad_Version` |
| schema format 0 (and 256, 512, ...: SQLite keeps only the low byte) | opens (0 means 1) | `Bad_Schema_Format` unless it is 1..4 |
| text encoding 0, 4, 5, 8, ... | opens when its low two bits (0 means UTF-8) are the database's real encoding | `Bad_Text_Encoding` |
| a partial last page (size not a multiple, count = rounded-up size) | rounds the file size **up** | `Truncated` / `Size_Not_Page_Multiple` |

In the other direction (what SQLite itself must reject, and the validator therefore rejects too): bad magic, bad page size or usable size < 480, read version > 2, payload fractions, schema format low byte > 4, an in-header count above the (rounded-up) file page count, a file of 2..99 bytes. Tested: every such case failed in SQLite.
An `Ok` header can still be refused by SQLite later when the header no longer describes the content (a lowered page count, another valid page size, another valid encoding): only the b-tree/schema layer can see that. In the 24,000 cases, every `Ok` case whose page size, encoding and page count still match the database opened in SQLite.

## Layout

| file | content |
|---|---|
| `sqlite_header.gpr` | proof project (template `spark/templates/unit.gpr`) |
| `src/sqlite_header.ads/.adb` | the public spec (types, ghost vocabulary, `Validate` + postcondition) and the body |
| `src/sqlite_header-proofs.ads/.adb` | one ghost lemma (counted pages fit the file, no overflow); never compiled into code |
| `tests/` | `run_tests.sh` (< 10 s): oracle cases, real files, sweeps, 5M random headers, contracts build; `oracle.py` (Python reference + SQLite differential), `cases.txt` (24,000 committed cases), `real_headers.txt` (39 real headers), `mutation_check.py`, benchmark |
| `PROOF.md` | gnatprove summary, SQLite differential numbers, benchmark, register items |

Zero-footprint: `Pure` packages, no state, no standard-library units, no allocation, no exceptions raised, no nested subprograms, no tasking.

    spark/tools/prove.sh spark/core/sqlite_header        # gnatprove 14.1, level 4: 0 unproved
    spark/core/sqlite_header/tests/run_tests.sh [--bench]

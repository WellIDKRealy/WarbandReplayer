# recorder_schema

## Guarantees

* **Total.** Any description (empty, truncated, hostile, any lengths or counts) gets an answer: `Ok`, `Mismatch` or
  `Over_Limit`. No exception, no undefined behaviour, no silent truncation.
* **`Ok` exactly when** all 9 tables of the frozen recorder (`lua/main.lua`) are listed and each of their 61 columns exists with
  the SQLite *type affinity* the recorder declares (INTEGER / TEXT / REAL). Extra tables and columns, and order, do not matter.
* **`Mismatch` says exactly what is wrong:** `Missing_Table`, `Missing_Column`, `Wrong_Affinity`. Every reported problem is real,
  every real problem is reported (one fixed slot per requirement, so nothing is dropped for lack of room).
* **`Over_Limit`** when the description exceeds the bounds (256 tables, 64 columns per table, 64 bytes per name / declared type):
  an explicit answer, never a guess from truncated data.
* Names compare ASCII case-insensitively (SQLite's rule); the affinity of **any** declared type follows SQLite's five rules.

## What it is for

`failure-modes.md` A, "valid SQLite, wrong schema": once the file header looks fine, the loader reads `PRAGMA table_info` for every
table into a `Schema_Description` and calls `Check`. A wrong, older or damaged schema then becomes a typed error with a precise
list of what is missing, instead of a failing `SELECT` somewhere in extraction or playback. New unit; there is no counterpart in the
old C/JS tree (the old engine simply queried and crashed or showed nothing).

    spark/tools/prove.sh spark/core/recorder_schema        # gnatprove 14.1, level 4, 0 unproved (see PROOF.md)
    spark/core/recorder_schema/tests/run_tests.sh          # differential / exhaustive / fuzz tests, < 10 s

## Interface (`src/recorder_schema.ads`)

```ada
function Check (S : Schema_Description) return Report;      --  Report = (Status, Problems)
type Status_Kind is (Ok, Mismatch, Over_Limit);
```

`Schema_Description` is what `PRAGMA table_info` returned, bounded: `Table_Count` (the TRUE number of tables) and up to
`Max_Tables = 256` stored `Table_Entry` records, each with a `Name : Text`, `Column_Count` (TRUE) and up to
`Max_Columns = 64` stored `Column_Info` (name and declared type, `''` when none). A `Text` is a `Length` (the TRUE byte length, a
64-bit count) plus the first 64 bytes; bytes after `Length` and entries after the counts are never looked at. The binding fills
in the true counts and lengths even when it cannot store everything - that is what makes `Over_Limit` possible.

`Problems : Problem_Set` has `Missing_Table (T : Table_Id)` and `Column (C : Column_Id) : Fault_Kind` (`No_Fault`,
`Missing_Column`, `Wrong_Affinity`). The requirements themselves are public: `Table_Name`, `Column_Table`, `Column_Name`,
`Column_Affinity`, so a UI can print "table `kills`: column `dead_x` is missing" from the report alone.

### What is checked, precisely

* A table is **listed** when some stored entry has its name (case-insensitively). If a name is listed twice (a real database cannot
  do that) the *first* listing is the one judged (`Table_Index`).
* A column of a listed table is **missing** when no column of that name exists; it has the **wrong affinity** when columns of that
  name exist but none has the recorder's affinity; otherwise it is fine (`Column_Fault`).
* The columns of a missing table are not reported separately (one problem, not twelve).
* Affinity comes from the declared type text exactly as SQLite derives it (datatype3.html section 3.1): contains `INT` -> INTEGER;
  else `CHAR`, `CLOB` or `TEXT` -> TEXT; else `BLOB` or no type -> BLOB; else `REAL`, `FLOA` or `DOUB` -> REAL; else NUMERIC. Compared
  **exactly** with the recorder's affinity: a column declared `NUMERIC` or `DECIMAL(10,5)` where the recorder declares `INTEGER` is
  `Wrong_Affinity` (SQLite stores both alike, but `CAST` tells them apart, and the contract is the documented affinity).
  `BIGINT`, `int`, `UNSIGNED BIG INT` are INTEGER and fine. An embedded NUL is an ordinary byte (SQLite's own C code stops at NUL,
  but SQLite never reports a type containing one).
* The recorder schema is the CREATE TABLE text in `lua/main.lua`: `ticks`, `events`, `chats`, `map_switches`, `score_switches`,
  `faction_switches`, `kills`, `spawns`, `agent_states`; 61 columns. `sqlite_sequence` (created by `AUTOINCREMENT`) is an extra table.

## Layout

| file | content |
|---|---|
| `recorder_schema.gpr` | proof project (template `spark/templates/unit.gpr`) |
| `src/recorder_schema.ads/.adb` | the whole unit: input types, `Within_Limits`, `Affinity_Of`, the recorder's requirements, `Table_Index`, `Column_Fault`, `Check` |
| `tests/` | native differential tests, oracle generator (`gen_cases.py`), `run_tests.sh` |
| `PROOF.md` | final gnatprove summary, benchmark, what is proved, register |

Zero-footprint: `Pure` package, no state, no standard-library units, no allocation, no exceptions raised, no nested subprograms,
no unconstrained function results (no secondary stack). Counts and lengths are 64-bit (`Count`). `Schema_Description` is about
2.4 MB (256 x 64 columns x two 64-byte texts); the caller keeps one per thread, in static storage or its arena, and reuses it.

## Old behaviour

None: the old engine had no schema check at all. The divergence list is empty.

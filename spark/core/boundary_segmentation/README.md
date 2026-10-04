# boundary_segmentation

SPARK port of the **SQL-defined battle boundary detection** (FEATURES: "SQL-defined battle boundary
detection"): the pure algorithm that turns *boundary tick indexes* into *battle spans*.

| | |
|---|---|
| Old behaviour (oracle) | `sql/default_boundary_detection.sql` (the two folds + tail segment), `replay_worker.c` `scan_matches_via_sql`, `testdata/ground_truth.py` `scan_matches` |
| Proof status | see `PROOF.md` (gnatprove 14.1, level 4, 0 unproved, 0 `pragma Assume`, no `SPARK_Mode (Off)`, no `Annotate` justification) |
| Sources | `src/boundary_segmentation.ads`, `src/boundary_segmentation.adb` (Pure package, no state, no elaboration code) |
| Tests | `tests/run_tests.sh` (< 10 s) |

## Interface

```ada
procedure Segment
  (N          : Tick_Count;          --  number of ticks, 0 .. 2**62
   Boundaries : Boundary_Array;      --  strictly increasing boundary tick INDEXES, each < N
   Spans      : in out Span_Array;   --  output; capacity = Spans'Length (a parameter, no cap)
   Needed     : out Span_Count;      --  exact number of spans the algorithm produces
   Status     : out Status_Kind);    --  Ok | Overflow | Invalid_Input
```

* All sizes/indexes are `Long_Long_Integer` subtypes (64 bit). `Max_Ticks = 2**62` covers the required
  `N` up to `2**40` and boundary counts up to `2**31` with room to spare, and keeps every intermediate
  sum (`idx + 15`, `idx + 1`, ...) far from overflow.
* **No cap.** The old tree truncated to `MAX_MATCHES = 16` battles (and a 32-row buffer). Here the
  output capacity is the caller's `Spans'Length`; if it is too small the result is `Overflow` (never
  silent truncation), `Needed` is the *exact* number of spans (so the caller can retry with a bigger
  array) and the first `Spans'Length` spans are written. The algorithm itself has no cap at all.
* `Invalid_Input` (boundaries not strictly increasing, or some `>= N`) leaves `Spans` untouched.
  `Valid_Input (N, B)` is executable so a caller can pre-check untrusted data itself.
* Spans are written to `Spans (Spans'First + J - 1)`; `Spans'First` can be anything.

## The algorithm (old behaviour, as the SQL defines it)

`B(1..L)` are the boundary rows (`boundary_idx`, `rn = 1..L`), `N` the number of ticks.

1. **merge pass** (`merge_fold`, SQL lines 82-92): `last_kept` starts at the sentinel `-1_000_000`; row `b` is
   *kept* iff `b >= 5 and b > last_kept + 15`, and then `last_kept := b`. (Only boundaries MORE than 15 past
   the last KEPT one survive; a dropped boundary does not move `last_kept`.)
2. **segmentation pass** (`seg_fold`, lines 100-109): `start := 0`; for each kept `m` in order: if
   `m - start >= 10` emit span `(start, m)` and `start := m + 1`, otherwise skip `m` and keep `start`.
3. **tail** (lines 117-131): `start` (= last accepted end + 1, or 0) to `N - 1` is emitted iff
   `N - 1 - start >= 5`.

The Ada body is **one fused pass** (O(L) time, O(1) extra space, no allocation): each raw boundary goes
through the merge test and, if kept, immediately through the segmentation test.

## Contract <-> old behaviour

All identifiers below are in `src/boundary_segmentation.ads`.

### Ghost specification: a literal transcription of the SQL

| Spec entity | SQL / old source |
|---|---|
| `Skip_First = 5`, `Merge_Window = 15`, `Min_Match_Gap = 10`, `Min_Tail_Gap = 5`, `Sentinel = -1_000_000` | literals in `default_boundary_detection.sql` lines 83, 87-89, 105-107, 131 (the `#define`s of the legacy `scan_matches()` are only quoted in the file header, lines 17-30) |
| `Keeps (Idx, Last_Kept)` | `CASE WHEN b.idx >= 5 AND b.idx > f.last_kept_idx + 15` (lines 87-89) |
| `Accepts (Idx, Start)` | `CASE WHEN m.idx - f.start_idx >= 10` (lines 105-107) |
| `Fold_State.Last_Kept`, `.Start`, `.Emitted`, `.Last_End` | `merge_fold.last_kept_idx`, `seg_fold.start_idx`, `count (seg_fold.emit = 1)`, `COALESCE (MAX (end_idx), -1)` of `last_accepted_end` (line 118) |
| `Step`, `Fold (B, K)` | one raw row through `merge_fold` then (if kept) `seg_fold`; state after rows `1 .. K` |
| `Nth_End (B, K, J)`, `Nth_Start (B, K, J)` | `accepted.a_end_idx`, `accepted.a_start_idx = LAG (end_idx + 1, 1, 0)` (lines 111-115) |
| `Tail_Start`, `Has_Tail` | tail select (lines 126-131): `start_idx = last_accepted_end + 1`, `WHERE last_idx - start_idx >= 5` |
| `Spec_Count / Spec_Start / Spec_End` | the rows the SQL returns (`accepted UNION ALL tail`, `ORDER BY start_tick_id`) |

Rows are *counted* (`Elem (B, K)` is row `K`, `rn = K`), not indexed, so the contracts do not depend on `B'First`.

### `Segment` postcondition (valid input; W = written spans = `min (Needed, Spans'Length)`)

| Postcondition | Meaning / old behaviour |
|---|---|
| `Status = Invalid_Input` iff `not Valid_Input` | explicit error instead of undefined behaviour (new; the SQL cannot produce such input: `boundary_raw` is `DISTINCT` and ordered, every idx < N) |
| `Needed = Spec_Count`, `Status = Overflow` iff `Needed > Spans'Length` | the number of rows the SQL returns; **no `MAX_MATCHES` cap** (`replay_worker.c:1435-1459`) |
| `Spans (J) = (Spec_Start J, Spec_End J)` for `J in 1 .. W` | the output EQUALS the reference semantics |
| entries beyond `W` unchanged | no hidden writes |
| first span starts at 0; `Start (J) = End (J-1) + 1` | contiguous, strictly ordered, non-overlapping, gap-free (`start_idx` only advances to `end_idx + 1`) |
| `End - Start >= Min_Match_Gap` for non-tail spans | exact property: `end_idx - start_idx >= 10` (so a span covers at least **11** ticks) |
| tail (`J > Main_Count`): `End = N - 1`, `End - Start >= Min_Tail_Gap` (>= 6 ticks) | tail rule |
| `Needed = Main_Count + (1 if Has_Tail)` | tail exists iff `N - 1 - Tail_Start >= 5` |

### Declarative ghost lemmas (all proved)

| Lemma | Statement |
|---|---|
| `Lemma_Merge` | `merge_fold`'s state is exactly "the last KEPT boundary" (or the sentinel): `Fold (B, K).Last_Kept = Elem (B, Prev_Kept (B, K))` |
| `Lemma_Merge_Rule` | a boundary is kept **iff** `idx >= 5` and (nothing kept before it **or** `idx > previous kept idx + 15`); nothing else is ever kept |
| `Lemma_Last_End` | after `K` rows the last accepted end is `Nth_End (Emitted)` = `Last_End`, and `Last_End = Start - 1` (next span starts right after) |
| `Lemma_Emission` | the J-th span is emitted by exactly one kept row `Emit_Pos`; its start is the `start_idx` *before* that row and the row passes `>= 10` against it |
| `Lemma_Unskipped`, `Lemma_Span_Props` | **a span ends at the FIRST kept boundary that is >= 10 past its start**: every kept boundary in `[start, end)` was `< 10` past `start` |
| `Lemma_Spec_Properties` | (valid input) contiguity, non-tail gap `>= 10` and the first-eligible property for every span, tail rule, and "nothing left over for the tail except boundaries `< 10` past its start" |
| `Lemma_Rejection` | **the SQL header's "a rejected span is absorbed into the next" is exactly this**: the only kept boundary `seg_fold` can ever reject is the very *first* kept one, and only if its idx is in `5 .. 9`. Every other kept boundary is accepted (so spans are simply consecutive merged boundaries) |
| `Lemma_Fold_Step`, `Lemma_Nth_End_Step`, `Lemma_Nth_End_Stable`, `Lemma_Nth_Start_Stable`, `Lemma_Increasing`, `Lemma_Le_Last` | plumbing (one-step unfolding of the recursive definitions, stability of already-emitted spans, strict monotonicity of valid input) |

`Lemma_Rejection` shows the "absorbed span" case is rarer than the SQL comments suggest: it can only ever
affect the *first* span of a replay (when the first kept boundary has idx 5..9 the first span then simply
extends to the second kept boundary).

## Behavioural differences from the old tree

| Old | New | Class |
|---|---|---|
| `scan_matches_via_sql` silently drops spans past `MAX_MATCHES = 16` (`replay_worker.c:1459`) and rows past `MAX_MATCHES + MAX_NONBATTLE_SPANS` (`:1435-1439`); `ground_truth.py` `matches[:MAX_MATCHES]` (line 115) | no cap; `Overflow` status + exact `Needed` | intentional-fix |
| legacy `scan_matches()`: 256 raw-boundary cap and a mid-loop `MAX_MATCHES - 1` cap that merged everything after the 15th match into one giant tail (SQL header lines 40-58); `ground_truth.py` `rows[:256]` (line 75) | not present: the SQL itself is uncapped, and so is this port | intentional-fix (the SQL never had them) |
| 32-bit `int` indexes/counts in the C caller | 64-bit everywhere, proved overflow-free up to `2**62` | intentional-fix |
| undefined behaviour on non-increasing / out-of-range boundary arrays | `Invalid_Input`, output untouched | intentional-fix |
| everything else (sentinel `-1_000_000`, `>= 5`, `> last_kept + 15`, `>= 10`, tail `>= 5`, rejected candidates carry `start` forward, spans contiguous) | identical | faithful |

## Tests (`tests/`)

`run_tests.sh` builds `test_segmentation.adb` twice and runs it:

* **fast build** (full workload): the 31 real cases of `boundary_cases.txt` (integers only, derived from the real replays;
  expected spans from the old uncapped SQL), **2400 synthetic cases** in `synthetic_cases.txt` (generated by
  `gen_cases.py`: random in-memory SQLite DBs with `ticks` + `events` (map/score/faction switches, decoy events,
  duplicate events per tick, tick ids with gaps) -> the **real `sql/default_boundary_detection.sql`** through Python's
  `sqlite3`), each run with exact / roomy / `Spans'First <> 1` / too-small / half / zero capacities (Overflow + exact `Needed`,
  untouched tail of the output); hand-computed edge cases (every threshold at n-1/n/n+1); invalid-input cases; 64-bit
  magnitudes (`N = 2**62`, boundaries within 2 of the top) against an independent reference model; > 16 battles and a
  2-million-battle run; exhaustive enumeration of every boundary set with <= 6 elements for every `N <= 36` (13.1 million sets, compared with the independent two-pass reference model).
* **contracts build** (`-gnata`): the same program with all contracts, loop invariants **and the ghost specification
  executed** on the cases with few boundaries (the ghost specification is cubic by construction): this runs the
  SQL-transliterating folds themselves against the real-SQL oracle, and checks every postcondition at run time.
* **oracle freshness**: re-runs the real SQL on the committed cases (`gen_cases.py --check`).

Regenerate the synthetic oracle: `python3 tests/gen_cases.py` (deterministic, fixed seed).

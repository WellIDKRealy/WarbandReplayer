# tick_index

SPARK port of the OLD engine's tick lookup, interpolation fraction (alpha) and the lerp / shortest-angle
blends used by playback (FEATURES: "Playback", "interpolation").  The old C/JS code is the behavioural
oracle and was not touched.

    spark/tools/prove.sh spark/core/tick_index        # gnatprove 14.1, level 4, 0 unproved (see PROOF.md)
    spark/core/tick_index/tests/run_tests.sh          # differential + exhaustive tests, ~8 s

## Layout

| file | content |
|---|---|
| `tick_index.gpr` | proof project (template `spark/templates/unit.gpr`) |
| `src/tick_index.ads/.adb` | `Tick_Index`: types, `Is_Sorted`, `Last_At_Or_Before`, `Find_Tick_Index_For_Time`, `Match_Index_For_Time`, `Alpha_For`, `Locate` |
| `src/tick_index-blend.ads/.adb` | `Tick_Index.Blend`: `Lerp_Raw`/`Lerp` (float32), `Lerp64_Raw`/`Lerp64` (double), `Fmod360`, `Wrap_Delta`, `Shortest_Delta`, `Blend_Angle_Deg` |
| `src/tick_index-lemmas.ads/.adb` | `Tick_Index.Lemmas`: one ghost proof lemma (adjacent sortedness => all-pairs); `Ghost => Ignore`, never compiled into code |
| `tests/` | native differential test program, oracle generator, `run_tests.sh` |
| `PROOF.md` | final gnatprove summary, register items |

Zero-footprint: `Pure` packages, no state, no standard-library units, no allocation, no exceptions raised,
no nested subprograms, no tasking.  All sizes/indexes are 64-bit (`Tick_Pos'Size = 64`, up to
`Max_Ticks = 2**31` ticks; the old code used `int`).

## Types and domains

Every float that enters a contract is a range subtype with finite bounds, so GNATprove proves the absence
of overflow / NaN / Inf at every operator.  The bounds are *preconditions*: nothing is ever clamped
silently, the (future) wasm wrapper must reject out-of-domain input explicitly.

| subtype | range | why |
|---|---|---|
| `Tick_Time` (Long_Float) | +-1.0E19 | every SQLite INTEGER (< 2**63) converted to double; real times are ~1.8E9 |
| `Alpha_Type` (Float) | 0 .. 1 | old `float alpha` |
| `Coord` / `Coord64` | +-1.0E30 / +-1.0E150 | positions are ~ +-100; only keeps intermediates finite |
| `Angle_Deg` | +-1.0E9 | 2.8 million turns; keeps `b - a + 180` below the exact-fmod range (`Fmod_Arg`, +-4.0E9) |

`In_Time_Domain (X)` is the executable check for a time from outside (False for NaN, +-Inf, |X| > 1.0E19).
`Is_Sorted (T)` is the executable validator for the `Sorted` precondition (proved equal to the ghost
`Sorted`); a loader must call it and report an explicit error - the old engine binary-searched whatever
table it was given.

## Old behaviour -> contract

### `find_tick_index_for_time` (replay_worker.c:1188-1198) -> `Last_At_Or_Before`, `Find_Tick_Index_For_Time`

```c
if (g_tick_count == 0) return 0;                       // caller's job (build_frame_at_time:1236) - Pre: T'Length > 0
if (t <= g_ticks[0].time) return 0;                    // Find: X <= T(first)  -> T'First
if (t >= g_ticks[g_tick_count - 1].time) return g_tick_count - 1;   // Find: X > T(first) and X >= T(last) -> T'Last
lo = 0, hi = n-1; while (lo < hi) { mid = (lo+hi+1)/2; ... }        // greatest I with T(I) <= X
```

* `Last_At_Or_Before (T, X)` (the spike's search, generalised to 64-bit indexes / any lower bound):
  `Result in T'First - 1 .. T'Last` and **for every tick J: `(T (J) <= X) = (J <= Result)`**.  That one
  postcondition is the complete specification: the greatest index with time <= X, the sentinel
  `T'First - 1` when X is before the first tick, and it holds with duplicates (the LAST tick of a run of
  equal times is returned).  Pre: non-empty, `Sorted (T)` (non-strict).
* `Find_Tick_Index_For_Time` is the faithful port including both fast paths; its postcondition pins each
  branch and states `X > T(first) => Result = Last_At_Or_Before (T, X)`.  The two algorithms (old lo/hi
  loop, new Lo/Hi sentinel loop) agree because "greatest index with time <= X" is unique.

### `build_frame_at_time` (replay_worker.c:1235-1248) -> `Alpha_For`, `Locate`

```c
int idxA = find_tick_index_for_time(t);
int idxB = (idxA + 1 < g_tick_count) ? idxA + 1 : idxA;
float alpha = 0.0f;
if (g_ticks[idxB].time > g_ticks[idxA].time) {
    alpha = (float)((t - g_ticks[idxA].time) / (g_ticks[idxB].time - g_ticks[idxA].time));
    if (alpha < 0.0f) alpha = 0.0f;  if (alpha > 1.0f) alpha = 1.0f;
}
```

* `Locate (T, X)` -> `(Index_A, Index_B, Alpha)`; postcondition: `Index_A = Find_Tick_Index_For_Time`,
  `Index_B = Index_A + 1` unless `Index_A = T'Last`, `Alpha = Alpha_For (T(A), T(B), X)`, and
  `T(B) = T(A) => Alpha = 0`, `X <= T(A) => Alpha = 0`.
* `Alpha_For (Time_A, Time_B, X)` - complete piecewise definition in the postcondition:
  `not (Time_B > Time_A) or X <= Time_A => 0.0` (**no division when timeB == timeA**, alpha exactly 0 at/before
  timeA); `Time_B > Time_A and X >= Time_B => 1.0` (exactly 1 at/after timeB);
  `Time_A < X < Time_B => Float ((X - Time_A) / (Time_B - Time_A))` (the old formula, double arithmetic, one
  conversion to float; proved to be in [0, 1] and free of overflow / division by zero).
  The old clamp is realised by the two outer cases, so no division is evaluated where its quotient could leave
  [0, 1] (the old code relied on IEEE inf / out-of-range float conversion there).
* alpha can be exactly 1.0 *before* timeB (the float conversion rounds up when `X` is within about 6E-8 of
  `Time_B`): 12 of ~420k real-data queries.  This is the old behaviour and is kept.

### `matchIndexForTime` (main.js:2504) -> `Match_Index_For_Time`

First match (array order; intervals may overlap / touch / be unsorted) whose closed interval
`[Start_Time, End_Time]` contains X, else `No_Match = -1`.  Postcondition: `Result = -1` iff no interval
contains X; otherwise the interval at `Result` contains X and no earlier interval does.

### `blend_render_slot` lerp (replay_worker.c:1028-1029) and `updateNatoSymbolTransform` (main.js:887-888) -> `Tick_Index.Blend`

`x = x + (bx - x) * alpha` with one float rounding per operator (float32 in C, double in JS).

* `Lerp_Raw` / `Lerp64_Raw`: the **verbatim** old formula.  Proved: result `= A + (B - A) * Alpha`;
  exactly `A` when `Alpha = 0` or `A = B`; never outside the bracket `[A, A + (B - A)]` spanned by its own two
  float operations (monotone rounding, via the helper lemmas `Scale32/Scale64`).  It is *not* provable (because it is
  false) that it stays between the endpoints or is exact at alpha = 1 - e.g. `A = 1.0, B = 1.0E-8, Alpha = 1.0`
  gives `0.0`.
* `Lerp` / `Lerp64`: what the new engine should call.  Proved: result in `[min (A, B), max (A, B)]`; `Alpha = 0 =>
  A`; `Alpha = 1 => B`; `Alpha < 1 => Clamp (Lerp_Raw (A, B, Alpha), min, max)` - bit-identical to the old engine
  whenever the old value was inside the endpoints.  In 86k oracle cases the old value never overshot; it differed
  from the new value only at `Alpha = 1` (252 of the 44k float32 cases, 82 of the 42k double cases, all in the
  hand-picked extreme-magnitude corner set).

### `blendAngleDeg` (main.js:795-798) -> `Fmod360`, `Wrap_Delta`, `Shortest_Delta`, `Blend_Angle_Deg`

```js
let delta = ((b - a + 180) % 360 + 360) % 360 - 180;   return a + delta * alpha;
```

* `Fmod360 (X)` = C `fmod (X, 360.0)` (what JS `%` does), computed by exact binary long division (24
  subtract-if-not-less steps of 360 * 2**k; each subtraction is exact by Sterbenz) instead of a division, so every
  step is a provable range fact.  Proved: `|Result| < 360`, sign of the dividend, identity on `|X| < 360`, exact first
  wrap on `360 <= |X| < 720`.  Bit-identical to JS `%` on 61k oracle values incl. signed zeros.
* `Wrap_Delta (D)` = `((D + 180) % 360 + 360) % 360 - 180`.  Proved: result in `[-180, 180]` and, in the four windows
  around zero (`-540 <= D <= 540`, 1.0E-6 margins around the half turns), the result is the representative of `D`
  modulo 360 within 1.0E-12 (the formula's own rounding noise is ~1E-13).
* `Shortest_Delta (A, B) = Wrap_Delta (B - A)`; `Blend_Angle_Deg (A, B, Alpha) = A + Shortest_Delta (A, B) * Alpha`
  (formula pinned); `Alpha = 0 => A`; `Alpha = 1 => A + delta`; **proven bound**: the result never leaves the
  arc between `A` and `A + delta`, hence `A - 180 <= Result <= A + 180` (the blend travels at most half a turn,
  never the long way round; no 359deg -> 0deg spin).

## Intentional differences from the old code

See `old_behaviour_divergences` in the unit's result and `PROOF.md`; in short: 64-bit indexes and overflow-free midpoint;
`Sorted` is a stated precondition with an executable validator; explicit finite float domains instead of silent
NaN/Inf propagation; `Lerp` clamps to its endpoints and is exact at alpha = 1 (`Lerp_Raw` keeps the verbatim old
formula); alpha is `+0.0` where the old code could produce `-0.0f` by underflow (unobservable).

## Things worth knowing about the old code / data

* **The real corpus has no equal consecutive tick times.**  All 31 non-empty replays (166,232 ticks) are strictly
  increasing, gaps 1 s (95%), 2 s (4%) and a few longer; 0 duplicates, 0 decreases, 0 NULLs.  The duplicate-time
  paths are therefore exercised with duplicated copies of the real tables (`dup-*` sets) and synthetic arrays only.
* The old first-tick fast path `t <= times[0] -> 0` returns the FIRST tick of a leading run of equal times, while the
  interior path returns the LAST tick of a run.  Preserved (faithful); irrelevant for the real data (no duplicates).
* An unsorted tick table made the old search return garbage silently; the real data is sorted.

## Tests (`tests/`)

`run_tests.sh` (about 8 s) generates the oracle with `oracle.py` and runs `test_tick_index` twice: a fast build
(assertions off, full oracle) and a `-gnata` build (every pre/postcondition and loop invariant of the SPARK sources
executes as a run-time check).

* Tick arrays: the 31 real tables (`SELECT time FROM ticks ORDER BY id`, read live from `$REPLAY_DIR`; if the
  directory is absent the committed integer-only fixture `tests/oracle/tick_gaps.txt` - run-length encoded gaps, no
  absolute times, no names/chat - is used).  File classes by size: tiny (<100 ticks, 4 files), small (<1000, 6),
  medium (<10000, 20), huge (81,449 ticks, 1); >= 100,000 queries per class (random reals, whole seconds, every tick
  exactly and +-1 ulp, strictly between ticks, before first / after last, domain extremes), plus `dup-*` sets (the real
  tables with each tick repeated 1-4 times) and 16 synthetic arrays (1 tick, all equal, runs of equal times, negative
  times, +-1E19, denormal times).  579,496 frame queries total.
* Reference = a literal Python translation of the old C; **independently re-evaluated against the real old C code**
  (`oracle.py --check-c` extracts `find_tick_index_for_time`, the alpha block of `build_frame_at_time` and the lerp
  line from `replay_worker.c` by text, compiles them with gcc and checks all 579,496 queries and 44,000 lerp cases:
  0 mismatches).
* JS reference: `oracle_js.js` extracts `blendAngleDeg`, the NATO position-lerp expression and `matchIndexForTime`
  from the old `main.js` by text and runs them under node (angle 65k, lerp64 42k, fmod 61k, match 20k cases).
* Everything is compared bit-exactly (hex of the IEEE patterns).  Also: exhaustive check of every sorted array of
  length 1..6 over values 0..3 against a brute-force scan, and a 4M-tick generated array (200k queries against a closed
  form) for the 64-bit index paths.

# boundary_segmentation - proof summary

Reproduce: `spark/tools/prove.sh spark/core/boundary_segmentation` (exit 0; about 1 min 25 s wall on the shared
4-CPU machine, `-j1`), tests: `spark/core/boundary_segmentation/tests/run_tests.sh` (about 6 s cold).

Tool: gnatprove 14.1.1, `--level=4 --report=all --timeout=60 -j1` (CVC5 1.1.2, Z3 4.13.0, Alt-Ergo 2.4.0 available;
everything was discharged by CVC5 or trivially).

## Final gnatprove summary (copied from `obj/gnatprove/gnatprove.out`)

```
SPARK Analysis results        Total       Flow                       Provers   Justified   Unproved
---------------------------------------------------------------------------------------------------
Data Dependencies                 .          .                             .           .          .
Flow Dependencies                 .          .                             .           .          .
Initialization                    2          2                             .           .          .
Non-Aliasing                      .          .                             .           .          .
Run-time Checks                 132          .                    132 (CVC5)           .          .
Assertions                       52          .     52 (CVC5 91%, Trivial 9%)           .          .
Functional Contracts            251          .    251 (CVC5 99%, Trivial 1%)           .          .
LSP Verification                  .          .                             .           .          .
Termination                      30         20                     10 (CVC5)           .          .
Concurrency                       .          .                             .           .          .
---------------------------------------------------------------------------------------------------
Total                           467    22 (5%)                     445 (95%)           .          .

max steps used for successful proof: 7380
UNPROVED=.  PRAGMA_ASSUME_LINES=0
```

* **467 checks, 0 unproved, 0 justified.** 37 subprograms/packages analysed, all flow-clean (0 errors, 0 warnings).
* `pragma Assume`: **0**. `SPARK_Mode (Off)`: **0**. `pragma Annotate (GNATprove, ...)`: **0**. `Unchecked_*`: none.
  No `Ada.Text_IO`, no containers, no standard-library `with` at all: the package is `Pure`, has no state and no
  elaboration code. No nested subprograms, no tasking, no exceptions raised or propagated (every run-time check is proved).
* Proof sources: `src/boundary_segmentation.ads` (contracts and ghost specification), `src/boundary_segmentation.adb`.

## What is proved

### 1. Absence of run-time errors for all inputs in range
All `Segment` run-time checks (overflow, range, index) are proved with **no
precondition other than the types**: `N` up to `Max_Ticks = 2**62`, boundary arrays up to `2**62` rows (so the required
`N <= 2**40` and `2**31` boundaries are covered with a large margin), output capacity `Spans'Length` any value.
Every sum in the algorithm (`idx + 15`, `idx + 1`, `Count + 1`, `Spans'First + Count`, ...) is proved to stay in range.
`Segment` is total: bad input gives `Invalid_Input`, not a run-time error.

### 2. Functional contract (Gold level), see README for the old-behaviour mapping
* Output **equals the reference semantics**: `Needed = Spec_Count`, and for every written span `J`
  `Nth (Spans, J) = (Spec_Start J, Spec_End J)`, where `Spec_*` are defined through `Fold`, a ghost, recursive,
  row-by-row transcription of the SQL's `merge_fold` + `seg_fold` + `accepted`(LAG) + tail select.
* `Status = Overflow` iff `Needed > Spans'Length` (never silent truncation; no 16-battle cap anywhere); entries of
  `Spans` beyond the written ones are unchanged; `Invalid_Input` iff the input is not strictly increasing / not all `< N`
  and then `Needed = 0` and `Spans` is untouched.
* Consequences stated directly on the output: first span starts at 0; each span starts at the previous end + 1
  (strictly ordered, non-overlapping, gap-free); every span except the tail has `end - start >= 10`; the tail (when
  present) ends at `N - 1` and has `end - start >= 5`.

### 3. Declarative characterisation of the specification (ghost lemmas, all proved)
* **Merge pass** (`Lemma_Merge`, `Lemma_Merge_Rule`): `merge_fold`'s state is exactly "the last KEPT boundary"; a boundary
  is kept iff `idx >= 5` and (none kept before **or** `idx >` previous kept `+ 15`); nothing else is kept.
* **Segmentation pass** (`Lemma_Emission`, `Lemma_Unskipped`, `Lemma_Span_Props`, `Lemma_Spec_Properties`): each accepted
  span is emitted by exactly one kept boundary, with `end - start >= 10`, and that boundary is the **first** kept boundary
  at least 10 past the span's start (every kept boundary in `[start, end)` is `< 10` past `start`); nothing eligible is
  left over for the tail (every kept boundary `>= tail start` is `< 10` past it).
* **Tail rule**: tail exists iff `N - 1 - Tail_Start >= 5`, `Tail_Start = last accepted end + 1` (or 0), ends at `N - 1`.
* **Rejected-candidate quirk made exact** (`Lemma_Rejection`): the only kept boundary `seg_fold` can ever reject is the
  first kept one, and only if its idx is in `5 .. 9`.
* Supporting lemmas: one-step unfoldings (`Lemma_Fold_Step`, `Lemma_Nth_End_Step`), stability of already-emitted spans
  (`Lemma_Nth_End_Stable`, `Lemma_Nth_Start_Stable`), `Lemma_Last_End`, strict monotonicity of valid input
  (`Lemma_Increasing`, `Lemma_Le_Last`), and the ghost helper `Lemma_Contiguous` (body only).

### 4. Termination
The main loop has `Loop_Variant`; every recursive ghost function/lemma has a `Subprogram_Variant` (30 termination
checks, all proved).

## Register of unprovable items / assumptions

**None.** No `pragma Assume`, no justification, nothing deferred to testing: the unit is fully proved (`status: proved`).

## Trust base (stated honestly)

* The ghost specification is a *transcription* of the SQL; SQLite's semantics are not formalised, so that the transcription
  is faithful is established by differential testing, not proof: `tests/` runs the real
  `sql/default_boundary_detection.sql` (31 real cases + 2400 random ones) and also **executes the ghost specification itself**
  (the contracts build, `-gnata`) against those oracles, so the proved refinement target is the one that matches the SQL.
* The unit starts from boundary *indexes*; deriving them (`DISTINCT` events joined to the ordered tick list, sorted) is the
  caller's job and is outside this unit (`Valid_Input` is executable so the caller can check what it passes).
* `Max_Ticks = 2**62` and 64-bit index types follow the owner's spec; GNAT-LLVM wasm32/wasm64 code generation for arrays
  indexed by 64-bit types has not been exercised here (target constraint check only: no nested subprograms, tasking,
  containers or text I/O in the package).

## Proof engineering notes (for maintainers)

* `Elem` and `Nth` are deliberately plain functions with a postcondition (not expression functions): the quantified contracts
  then range over simple terms `Elem (B, J)` / `Nth (S, J)` instead of `B (B'First + (J - 1))`, which turned out to be the
  difference between CVC5 proving the shortening/monotonicity lemmas immediately and not at all.
* Fold's postcondition must not mention `Fold (B, K - 1)`: when contracts are executed (`-gnata`) that doubles the work per
  recursion level (exponential). Monotonicity is in `Lemma_Fold_Step` instead.
* Loop invariants live at the top of a `while` loop over an explicit `Done` counter, so the invariant holds with `Done = Len`
  at loop exit and the post-loop reasoning needs no instantiation tricks.
* The quantified "for all J" statements are proved by ghost loops that call a pointwise lemma, with the invariant placed
  *after* the lemma call.

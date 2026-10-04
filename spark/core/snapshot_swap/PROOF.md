# snapshot_swap - proof summary

Reproduce: `spark/tools/prove.sh spark/core/snapshot_swap` (exit 0; about 9 to 15 s wall on the shared 4-CPU machine, `-j1`),
tests: `spark/core/snapshot_swap/tests/run_tests.sh` (2 s warm, up to 7 s with a cold build on a loaded machine).

Tool: gnatprove 14.1.1, `--level=4 --report=all --timeout=60 -j1` (CVC5 1.1.2, Z3 4.13.0, Alt-Ergo 2.4.0 available;
everything was discharged by CVC5, Z3 or trivially).

## Final gnatprove summary (copied from `obj/gnatprove/gnatprove.out`)

```
SPARK Analysis results        Total        Flow                              Provers   Justified   Unproved
-----------------------------------------------------------------------------------------------------------
Data Dependencies                 6           6                                    .           .          .
Flow Dependencies                 .           .                                    .           .          .
Initialization                   10          10                                    .           .          .
Non-Aliasing                      .           .                                    .           .          .
Run-time Checks                   3           .                             3 (CVC5)           .          .
Assertions                        2           .            2 (CVC5 50%, Trivial 50%)           .          .
Functional Contracts             42           .    42 (CVC5 79%, Trivial 20%, Z3 1%)           .          .
LSP Verification                  .           .                                    .           .          .
Termination                       4           4                                    .           .          .
Concurrency                       .           .                                    .           .          .
-----------------------------------------------------------------------------------------------------------
Total                            67    20 (30%)                             47 (70%)           .          .

max steps used for successful proof: 347
UNPROVED=.  PRAGMA_ASSUME_LINES=0
```

* **67 checks, 0 unproved, 0 justified.** 13 subprograms/packages analysed, all flow-clean (0 errors, 0 warnings).
* `pragma Assume`: **0**. `SPARK_Mode (Off)`: **0**. `pragma Annotate (GNATprove, ...)`: **0**. `Unchecked_*`: none.
  No standard-library `with`, no state, no elaboration code (both packages are `Pure`), no nested subprograms, no tasking,
  no exceptions raised or propagated (every run-time check is proved).
* Sources: `src/snapshot_swap.ads` (types, `Valid`, contracts), `src/snapshot_swap.adb` (five operations plus the body-only
  `Find_First`), `src/snapshot_swap-proofs.ads/.adb` (two ghost lemmas, `Lemma_Initial_Valid` and `Lemma_Free_Exists`).

## What is proved

### 1. Absence of run-time errors for every possible state
No precondition at all: every operation accepts any `Swap_State` value (including states no run can produce) and
the three run-time checks (overflow of `Last_Seq + 1` in the body of `Producer_Publish` and in its postcondition, the index
check in `Set_Slot`) are proved. The 63-bit counter cannot wrap: `Producer_Publish` at `Seq_Number'Last` returns
`Seq_Exhausted` before computing anything (at 1,000 publishes per second the counter lasts 290 million years).

### 2. Functional contracts (Gold level): complete transition relation
Each operation has `Contract_Cases` over the same shape, plus `Post => (if Valid (S'Old) then Valid (S))`:

| Case | Result |
|---|---|
| state not `Valid` | `Status = Corrupt_State`, `Slot = Slot_Id'First`, `S = S'Old` |
| illegal use (`Already_Writing`, `Not_Writing`, `Already_In_Use`, `Nothing_New`, `Not_In_Use`, `Seq_Exhausted`) | that status, `Slot = Slot_Id'First`, `S = S'Old` |
| legal | `Status = Ok` and the **exact** new state: `Begin`: lowest Free slot (all lower ones are not Free) becomes `(Writing, 0)`; `Publish`: `Last_Seq + 1`, the written slot becomes `(Published, Last_Seq)`, a Published slot becomes Free, every other slot unchanged; `Abort`/`Release`: that slot becomes Free; `Acquire`: the Published slot (whose `Seq` is `Last_Seq`) becomes `(In_Use, Last_Seq)` |

GNATprove proves for every operation that the guards are **disjoint and complete** (totality: some case always applies), that
each consequence holds, and that `Valid` is preserved (the inductive step). `Lemma_Initial_Valid` proves `Valid (Initial)`,
which also shows that `Valid` is satisfiable (the contracts are not vacuous).

| Owner's property | Proved by |
|---|---|
| a slot is never both Being_Written and In_Use | one `Kind` per slot; the exact new state in every case never makes one into the other |
| consumer only acquires a fully Published slot | `Consumer_Acquire`, `Ok`: `S'Old.Slots (Slot).Kind = Published` |
| producer never gets the slot the consumer holds | `Producer_Begin`, `Ok`: `S'Old.Slots (Slot).Kind = Free` (and an In_Use slot is not Free) |
| published sequence numbers strictly increase | `Producer_Publish`, `Ok`: `S.Last_Seq = S'Old.Last_Seq + 1` with the slot numbered `Last_Seq`; no other operation changes `Last_Seq` |
| acquire returns the largest published one | `Consumer_Acquire`, `Ok`: the slot's `Seq = S'Old.Last_Seq`; afterwards no slot is Published (the same snapshot cannot be acquired again) |
| producer can always make progress | `Producer_Begin`: `Valid` and not `Writing` => `Status = Ok` (third case is the only one left), by `Lemma_Free_Exists` (three slots, at most one each of Writing, Published, In_Use) |
| counters cannot overflow | see 1 |
| totality | no precondition; complete and disjoint cases; every state gets a typed status |

### 3. Termination
No loop outside `Find_First` (a `for` loop over the 3 slots, with a loop invariant); no recursion (4 termination checks, all
flow-proved; GNATprove reports "implicit aspect Always_Terminates on Find_First has been proved").

## Register of unprovable items / assumptions

No `pragma Assume`, no justification, nothing in this unit deferred to testing: the unit is fully proved (`status: proved`).
Two items sit outside what a sequential SPARK unit can say; both are known register entries, listed for the owner:

* **R4 (interleavings and memory ordering).** The proof covers every sequence of operations run ONE AT A TIME on one `Swap_State`.
  That the producer and consumer threads run each operation atomically with respect to the other (mutex or a single atomic word),
  with correct memory ordering, is not expressible in SPARK. Mitigation: model-check (TLA+/Spin) the five operations as atomic
  steps of two processes, plus a native/wasm stress test. This unit's `Valid` and posts give the model checker its invariants.
* **Slot-buffer discipline (R2: JS/wasm glue).** The protocol decides who may touch which slot; that the producer writes only the
  buffer of the slot `Producer_Begin` returned (until `Publish`/`Abort`) and the draw side reads only the buffer of the slot
  `Consumer_Acquire` returned (until `Release`) is the discipline of the code around it (the render glue). Mitigation: that
  glue passes `Slot` straight from the operation's result and the frame tests assert complete frames.

## Trust base (stated honestly)

* The specification is the contract itself; it is checked against an independent formulation by differential testing
  (below), not by proof: `Valid` and every operation equal the naive Python model on every state of a bounded domain, and the
  five operations equal the model on every sequence of up to 10 operations.
* The Python oracle is itself checked: it enumerates every sequence of up to 10 operations literally (12,207,030 steps from each
  start state, `oracle.py --literal 10`, 1 min 47 s for both) and the result equals its own transition table, and on the small domain
  its validity predicate equals breadth-first reachability from the initial state. (`run_tests.sh` repeats this literally to length 6.)
* GNAT-LLVM wasm32 code generation of the 63-bit counter and the records has not been exercised here (target-constraint check
  only: `Pure`, no nested subprograms, tasking, containers or text I/O).
* GNAT 14.2 crashes (`gnat_to_gnu_entity`) on a postcondition of the form `(if not Valid (S'Old) then ... S = S'Old ...)` when compiled
  with `-gnata -gnatVa`; stating the same case analysis with `Contract_Cases` avoids it (and also gives the totality check).

## Tests and mutation checks

`tests/run_tests.sh`: ALL TESTS PASSED, 1.8 s warm and 6.6 s cold under load (fast build: 29,727,852 checks, 0 failures; `-gnata` build: 559,102 checks,
0 failures). Contents are listed in README.md. Oracle re-run offline with a literal depth-10 enumeration: model == table.

Mutation check (a scratch copy of the unit with one change; "tests" = `run_tests.sh` fails, "proof" = gnatprove with
`--timeout=5 --prover=cvc5,z3` leaves an unproved check; n/a = proof not run for that mutant):

| Mutant | proof | tests |
|---|---|---|
| `Begin`: no `Already_Writing` check | caught | caught (second slot becomes Writing) |
| `Begin`: highest Free slot instead of lowest | caught | caught |
| `Publish`: superseded Published slot not freed | caught | caught (two Published slots) |
| `Publish`: `Last_Seq + 2` | caught | caught |
| `Publish`: no `Seq_Exhausted` check | caught (overflow) | caught (`CONSTRAINT_ERROR`) |
| `Publish`: forgets to update `Last_Seq` | n/a | caught |
| `Acquire`: slot gets `Seq 0` | caught | caught |
| `Acquire`: no `Already_In_Use` check | caught | caught |
| `Acquire`: slot becomes Writing instead of In_Use | n/a | caught |
| `Release`: slot becomes Published instead of Free | n/a | caught |
| `Release`: no `Corrupt_State` check | n/a | caught |
| `Abort`: slot left Writing | n/a | caught |
| refusal leaves `Slot` = `Slot_Id'Last` instead of `'First` | n/a | caught |
| `Valid`: drop "at most one slot per role" | caught | caught |
| `Valid`: Published slot need not be the newest | caught | caught |
| `Valid`: drop "In_Use is older than Published / newest when nothing waits" (clause d) | **not caught** (proof still succeeds) | caught |

Result: all 16 mutants are caught by the tests. Ten were also run through the prover (the "n/a" ones were not, for time: each
failing proof burns its time-outs on a machine shared with other workers): nine are caught by the proof too; the only mutant
the proof cannot see is the weakening of clause (d) of `Valid`. That is expected: clause (d) is not needed by any other proved
contract (with it weakened every postcondition and the preservation of the weaker invariant still prove). It is there because it
makes `Valid` exactly the set of reachable states (so a corrupt state is recognised, and an acquire after a release is guaranteed
to return a larger sequence number than the one just released), and that equality is what the tests check.

## Benchmark (native, `tests/bench.adb`, run-time checks suppressed like a proven unit in production, `-O2`)

| Operation (single thread, best of 5 runs, 20 million iterations each) | time |
|---|---|
| full hand-off cycle: `Begin`, `Publish`, `Acquire`, `Release` | 96.7 ns per cycle (24.2 ns per operation), about 10.3 million cycles per second |
| producer only: `Begin` + `Publish` (each publish supersedes the last) | 50.8 ns per pair |
| `Acquire` polling an empty mailbox (`Nothing_New`) | 27.6 ns per call |

The same program built with run-time checks on (`-gnato -O2`, no `-gnatp`) measures 84-86 ns per cycle, i.e. the same within
the noise of the shared machine: the run-time checks are not what costs time here. Numbers: x86-64 container, `tests.gpr`
`-XCONTRACTS=off` (bench.adb is built with `-gnatp -O2`), `tests/bin_off/bench`.

At 60 frames per second one full cycle every 16.7 ms is 0.001 % of the frame budget: speed is not a concern for this unit.
Every call re-validates the whole state (`Valid`, a few dozen slot comparisons) so a corrupt state is never acted on; that check is
most of the cost, and is what makes the operations total.

## Proof engineering notes (for maintainers)

* `Valid` is an expression function with quantifiers over the 3 slots; CVC5 proves everything without help except the pigeonhole
  of `Lemma_Free_Exists`, which it also proves without a hint (the lemma body is `null`, but it is a separate subprogram so that
  `Producer_Begin` can call it and the statement is visible to a reader).
* `Find_First` is body-only; its postcondition (the slot has kind K, no lower one has) is what turns a loop into the "lowest Free
  slot" of the contract. Loop invariants are written `J < I`, not `Slot_Id'First .. I - 1`, so they cannot go out of range at I = 0.
* Slot_Count is a constant (3). The code and contracts are written over `Slot_Id` loops and quantifiers, but the progress lemma
  needs at least 3 slots, and the tests and the model are for 3.

## Independent re-verification (second session, by re-running everything)
- `spark/tools/prove.sh spark/core/snapshot_swap`: exit 0, **67 checks, 0 unproved, 0 pragma Assume**.
- `tests/run_tests.sh`: ALL TESTS PASSED (1.9 s).
- **Body mutation check: 6 of 6 mutants rejected by gnatprove** (the body has only 6 mutable operator sites outside contracts/ghost code):
  `<`->`<=` (line 12), `/=`->`=` (12), `and then`->`or else` (12: "contract case might fail"), `=`->`/=` (18),
  `=`->`/=` (48: "overflow check might fail ... S.Last_Seq + 1"), `+ 1`->`+ 2` (55: "overflow check might fail"). Three of the six first hit a 240 s
  timeout and were re-run with a 900 s limit to obtain definite failures (630 s, 254 s, 255 s).
- Scope/limits of this check: it mutates the BODY only (the contracts in the `.ads` are the specification, so mutating them is not a test of the proof).
  NOT yet done for this unit: an independently written oracle and audit, the robustness/simplicity/speed review, and the limits-alignment pass
  (docs/limits.md). Until those are done the unit is "re-verified", not fully "verified".

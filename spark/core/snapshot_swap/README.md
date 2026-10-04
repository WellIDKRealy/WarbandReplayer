# snapshot_swap

## Guarantees

The frame hand-off between the playback thread (producer) and the draw side (consumer), over three snapshot slots.
Each line below is a proved contract (gnatprove 14.1, level 4, 0 unproved; see `PROOF.md`):

1. **Never draw an unpublished snapshot.** The consumer only ever gets a slot the producer has finished and published.
2. **Never overwrite one in use.** The producer is only ever given a Free slot: never the one the consumer holds, never the newest unread one.
3. **Always the newest.** `Consumer_Acquire` returns the most recent published snapshot; sequence numbers are 1, 2, 3, ... and strictly increase. An unread snapshot that is overtaken is dropped, never shown late.
4. **The producer is never blocked.** Whenever it holds no slot, `Producer_Begin` succeeds (three slots: one written, one waiting, one drawn, so one is always free).
5. **Misuse changes nothing.** Publish without begin, release without acquire, begin or acquire twice: an explicit status, state untouched. A corrupt state is refused untouched (`Corrupt_State`).
6. **Total.** Every operation ends with a typed result on every possible state: no run-time error, no exception. The 63-bit sequence counter cannot wrap (`Seq_Exhausted`).
7. **Scope.** This is the protocol run one operation at a time. The two threads' interleavings and memory ordering are register item R4 (model-checked later).

| | |
|---|---|
| Old behaviour (oracle) | none: new unit (the old `main.js` loop simply drew "the most recently received snapshot", with no protocol) |
| Proof status | `PROOF.md`: 0 unproved, 0 `pragma Assume`, no `SPARK_Mode (Off)`, no `Annotate` justification |
| Sources | `src/snapshot_swap.ads/.adb` (Pure, no state, no elaboration code), `src/snapshot_swap-proofs.ads/.adb` (two ghost lemmas) |
| Tests | `tests/run_tests.sh` (2 s warm, up to 7 s cold on a loaded machine): all operation sequences up to length 10 against a naive Python model |

## How to use it

The state is a plain value (`Swap_State`, 56 bytes: three `(Kind, Seq)` cells and `Last_Seq`), initialised to `Initial`. The frame
buffers live elsewhere and are indexed by `Slot_Id` (0 .. 2). Five operations, each `(S : in out Swap_State; Status; Slot)`:

| Operation | Does | Refused with |
|---|---|---|
| `Producer_Begin` | the lowest Free slot becomes `Writing`; fill its buffer | `Already_Writing` |
| `Producer_Publish` | the written slot becomes the newest `Published` (`Seq = Last_Seq + 1`); an older unread one is superseded (Free) | `Not_Writing`, `Seq_Exhausted` |
| `Producer_Abort` | the written slot becomes Free | `Not_Writing` |
| `Consumer_Acquire` | the newest `Published` slot becomes `In_Use`; draw from it | `Nothing_New`, `Already_In_Use` |
| `Consumer_Release` | the held slot becomes Free | `Not_In_Use` |

`Slot` is meaningful only when `Status = Ok` (it is `Slot_Id'First` otherwise). Every operation also answers `Corrupt_State` for a state
that is not `Valid`, leaving it untouched. A typical frame: producer `Begin`, write, `Publish`; consumer `Acquire`, draw, `Release`.

Who may change which slot (read off the contracts): a `Writing` slot changes only by the producer's own `Publish`/`Abort`; an
`In_Use` slot only by the consumer's own `Release`; a `Published` slot only by `Acquire` or by being superseded in `Publish`.
All other slots are untouched by every operation. A slot has exactly one `Kind`, so it can never be both written and in use.

## The invariant (`Valid`)

`Valid` is an executable predicate, and it characterises exactly the states a run from `Initial` can produce (whichever Free slot the
producer was given; the tests check this against reachability): at most one `Writing`, one `Published` and one `In_Use` slot; Free and
Writing slots carry `Seq 0`; the `Published` slot is the newest (`Seq = Last_Seq`); the `In_Use` slot has `Seq` in `1 .. Last_Seq` and is
older than the `Published` one, or is itself the newest when nothing waits. Every operation proves `Valid` in => `Valid` out, and
`Lemma_Initial_Valid` proves `Valid (Initial)`, so every state of every run is valid. With at most one slot of each of the three
non-Free kinds and three slots in all, `Lemma_Free_Exists` (pigeonhole) gives a Free slot whenever the producer holds none: guarantee 4.

## Contract <-> required property

All contracts are in `src/snapshot_swap.ads` (`Contract_Cases`: guards are proved disjoint and complete, which is the totality of each operation).

| Required property | Where it is proved |
|---|---|
| consumer only acquires a fully Published slot | `Consumer_Acquire`, case `Ok`: `S'Old.Slots (Slot).Kind = Published` |
| producer never gets the slot the consumer holds | `Producer_Begin`, case `Ok`: `S'Old.Slots (Slot).Kind = Free`; `Valid` says the In_Use slot is not Free |
| a slot is never both Being_Written and In_Use | by representation (one `Kind` per slot); and no operation turns one into the other (each case gives the exact new state) |
| published sequence numbers strictly increase | `Producer_Publish`, case `Ok`: `S.Last_Seq = S'Old.Last_Seq + 1`, the slot gets that number; no other operation changes `Last_Seq` |
| acquire returns the largest published one | `Consumer_Acquire`, case `Ok`: the slot has `Seq = S'Old.Last_Seq`; after it no slot is Published, so the same snapshot cannot be acquired twice |
| producer can always make progress | `Producer_Begin`: when `Valid` and not `Writing`, the status is `Ok` (case 3), via `Lemma_Free_Exists` |
| counters cannot overflow | `Seq_Number` is 63 bits; `Producer_Publish` at the maximum returns `Seq_Exhausted` (1,000 publishes per second last 290 million years) |
| totality | no precondition; `Contract_Cases` complete and disjoint; run-time checks proved; `Corrupt_State` for invalid states |
| illegal use leaves the state unchanged | every refusal case: `S = S'Old`, `Slot = Slot_Id'First` |

Every successful case states the **complete** new state (`S = Set_Slot (S'Old, ...)`, or all slots for `Publish`), so no hidden change is possible.

## Design notes

* **Three slots, latest wins.** With two slots the producer would have to wait (or overwrite the unread newest one) while the consumer draws.
  With three it never waits, and a slow consumer simply skips frames: the draw side always gets the newest complete one.
* **No slot argument on `Publish`/`Abort`/`Release`:** the state knows the single written / held slot, so the caller cannot name a wrong one.
* **Lowest Free slot** is chosen (deterministic, so the model comparison is exact).
* **The state is a value passed in and out**: no package state, no elaboration, nothing shared; the caller decides where it lives (shared
  memory later) and must run the five operations one at a time (R4).
* Target constraints: `Pure` packages, no tasking, no nested subprograms, no exceptions, no standard-library units, 64-bit counter.

## Behavioural differences from the old tree

None: this is a new unit. (The old loop in `main.js` drew the last snapshot that had been received, with no ownership protocol at all.)

## Tests (`tests/`)

`run_tests.sh` builds `test_swap.adb` twice (without and with `-gnata`) and runs it against tables written by `oracle.py`:

* **`oracle.py`**: a deliberately naive model written in a different shape (three *role registers*: who writes, which snapshot waits, what
  the consumer holds; "Free" means "no role holds it"). It emits the model's transition table over every state reachable by sequences of
  up to 10 operations (66 states from `Initial`, 25 from a start 2 below the sequence maximum) and the model's verdict on 52,288 states of a
  bounded domain (small sequence numbers and numbers near 2**63 - 1, valid and invalid). It self-checks: every operation sequence up to
  length 6 enumerated literally gives the same results as the table (up to length 10 offline: see `PROOF.md`), and on the small domain the
  validity predicate equals breadth-first reachability.
* **Exhaustive enumeration**: the Ada test walks **every sequence of the 5 operations up to length 10** (12,207,030 steps) from both start
  states, comparing status, slot and the complete state with the model after every step, and counts 5^d sequences at every depth.
* **State domain**: `Valid` and one step of every operation on each of the 52,288 states (invalid ones: `Corrupt_State`, untouched).
* **Directed scenarios** (a full life of the protocol, sequence-number saturation, six corrupt states) written out by hand.
* **Random walk** of 5 million operations against an independent shadow model: exclusivity, strictly increasing acquired numbers, newest-wins.
* The `-gnata` build executes every contract (including `Valid` and the `Contract_Cases`) on a smaller workload.
* `tests/bench.adb`: the native micro-benchmark (numbers in `PROOF.md`); run it with
  `gprbuild -P tests/tests.gpr -XCONTRACTS=off bench.adb && tests/bin_off/bench`.

## Layout

| file | content |
|---|---|
| `snapshot_swap.gpr` | proof project (template `spark/templates/unit.gpr`) |
| `src/snapshot_swap.ads/.adb` | types, `Valid`, the five operations and their contracts |
| `src/snapshot_swap-proofs.ads/.adb` | ghost lemmas (`Lemma_Initial_Valid`, `Lemma_Free_Exists`), not part of the interface |
| `tests/` | `run_tests.sh`, `oracle.py`, `test_swap.adb`, `bench.adb`, `tests.gpr` |
| `PROOF.md` | final gnatprove summary, benchmark, register items |

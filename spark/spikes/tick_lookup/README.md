# Gate 0 spike A — SPARK proof of the tick lookup

`Spike.Last_At_Or_Before (T, X)` returns the greatest index `I` with `T (I) <= X` (or `T'First - 1`) for a
sorted time array — the algorithm behind `find_tick_index_for_time` in the old engine.

Proved with gnatprove 14.1.1 (`--level=2`): 27 checks, **0 unproved, 0 `pragma Assume`**
(run-time checks, loop invariants/variant, functional postcondition, termination).

Reproduce:

    alr toolchain --select gnat_native gprbuild
    alr build    # generates config/ (gitignored)
    alr exec -- gnatprove -P spike.gpr --level=2 --report=all

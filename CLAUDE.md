# CLAUDE.md — WarbandReplayer overhaul

**Start here:** read `docs/HANDOFF.md` (state, how to restore, next steps), then `docs/OWNER_DIRECTIVES.md` (the owner's exact words), `docs/PLAN.md`,
`docs/CHARTER.md`, `docs/limits.md`, `docs/failure-modes.md`. The branch is `claude/gifted-hawking-ukeg1n`.

## Binding rules (from the owner; details in docs/OWNER_DIRECTIVES.md)
- One overhaul: Ada/SPARK for everything portable, **proofs before tests**, **all existing features kept** (`docs/FEATURES.md`), handles ~1 GB+ replays, **simple, complete and fast**
  (60 FPS on bad PCs), **every failure scenario handled** (corrupted files etc.), no emcc/bundlers/npm/transpilers.
- Never say a unit is proven unless `spark/tools/prove.sh <unit>` exits 0 AND a mutation check shows the spec is not vacuous. Nothing unprovable may be tested instead without the owner's
  explicit permission — explain why it can't be proven and ask. No workarounds: if SPARK cannot do it, say so and evaluate another real prover.
- Complexity only when a measured performance gain or a required feature justifies it, recorded in `docs/justifications.md`. Real multi-threading is kept (the owner found it necessary).
- Limits are first-class: use `spark/leaf/limits`; units return explicit `Limit_Exceeded`; never wraparound/truncation/UB.
- SQLite stays (C). **`lua/main.lua` is frozen (production) — never modify it.** Databases/schemas may change.
- **Never commit real replay data or its download link** (other players' names/chat). Real data lives outside the repo; ask the owner for the link.
- The old C/JS tree is the behavioural oracle: leave it untouched until parity.
- READMEs of every unit open with <=10 lines of plain-English Guarantees; proof scaffolding in `<Unit>.Proofs`.
- Keep `docs/PLAN.md` internally consistent whenever you change it. At the very end, rewrite git history into a clean readable series (owner authorised `--force`; back up first).

## Commands
- `spark/tools/prove.sh spark/<group>/<unit>` — gnatprove level 4; exit 0 iff 0 unproved. `. spark/tools/env.sh` puts the Alire toolchain on PATH.
- `unit/tests/run_tests.sh` — native differential tests (< 10 s).
- `python3 testdata/make_large_fixture.py`, `baseline_old_engine.py`, `measure_extraction.py`, `testdata/wasm_bench/build.sh` — fixtures and measurements.

## Working style
The owner is direct and impatient: do the work, report facts and failures plainly, do not re-ask what the directives already answer, and keep spending in mind
(prefer focused single-unit work over large agent fan-outs unless asked).

# HANDOFF — continue this project in local Claude Code

This repo was worked on in a cloud Claude Code session that hit the owner's spend limit. Everything needed to continue is **in this repo**
(branch `claude/gifted-hawking-ukeg1n`). Read in this order: `CLAUDE.md` -> this file -> `docs/OWNER_DIRECTIVES.md` -> `docs/PLAN.md` ->
`docs/CHARTER.md` -> `docs/limits.md` -> `docs/failure-modes.md` -> `docs/FEATURES.md` -> `docs/justifications.md` -> `docs/real-data-profile.md`.

## Restore in 3 steps
```
git clone https://github.com/WellIDKRealy/WarbandReplayer && cd WarbandReplayer
git checkout claude/gifted-hawking-ukeg1n      # branch is ahead of master; master ends at the owner's "local work to rebase later"
claude                                           # local Claude Code auto-reads CLAUDE.md
```
First prompt to paste: *"Read CLAUDE.md, docs/HANDOFF.md, docs/OWNER_DIRECTIVES.md and docs/PLAN.md, then continue with 'Recommended next steps' in
HANDOFF.md. Ask me for the Google Drive link to lua.7z before doing any data work. Don't spend on fan-out unless I say so."*

## What the project is
A Mount & Blade Warband battle-replay viewer: bare-metal WebAssembly (no Emscripten) + WebGL + a multithreaded SQLite engine; `lua/main.lua`
(**frozen, in production**) records replays as SQLite files. The owner wants one overhaul: port everything portable to **Ada/SPARK with proofs
before tests**, keep **all features**, handle **1 GB+ files**, be **simple and fast (60 FPS on bad PCs)**, **handle every failure** (corrupted
files...), keep SQLite (C), with a new database model (two modes; exactly 3 selectable DBs: original replay, per-battle replay, battle db).
Details and the owner's exact words: `docs/OWNER_DIRECTIVES.md`; the consolidated plan: `docs/PLAN.md`.

## State of the work (end of the cloud session)
Branch history = master (`b83c380`) + ~30 commits of docs, tooling, tests, WIP snapshots. **No unit has passed all independent verifiers yet,
so nothing besides the items marked PROVED-AND-CHECKED may be called "proven" in public.**

| Item | Where | Status |
|---|---|---|
| Charter, plan, limits, failure modes, features, justifications | `docs/` | written, consistent (as of the last commit) |
| SPARK toolchain (GNAT 14.2.1, gnatprove 14.1.1) | via Alire | works (cloud: installed with `alr`) |
| `prove.sh` gate | `spark/tools/prove.sh` | exit 0 iff 0 unproved |
| Gate-0 spike: tick lookup | `spark/spikes/tick_lookup` | PROVED-AND-CHECKED: 27 checks, 0 unproved, mutation-style break tested during development |
| `Limits` package | `spark/leaf/limits` | PROVED-AND-CHECKED: 2 checks, 0 unproved; two mutations break it |
| `boundary_segmentation` | `spark/core/` | author reports PROVED: 467 checks, 0 unproved, 0 assumptions; ghost spec = literal transcription of `sql/default_boundary_detection.sql`; tests vs 31 real cases + 2400 synthetic (real SQL) + 13.1M exhaustive; 12/12 mutations killed. **Independent verification (mutation/differential/audit/robustness), limits alignment, simplicity audit NOT yet done** |
| `snapshot_swap` | `spark/core/` | RE-VERIFIED: 67 checks, 0 unproved, 0 assumptions (re-proved), tests pass, **6/6 body mutants rejected** (see its PROOF.md); 3-slot latest-wins protocol; exhaustive 12.2M-step model check; 97 ns per hand-off cycle. Still pending: independent oracle/audit, robustness/simplicity review, limits alignment |
| `tick_index` (+ `-blend`, `-lemmas`) | `spark/core/` | WIP: author was still working (float lerp/blend proofs are the hard part). Status unknown: re-run `prove.sh` |
| `tar_layout` (+ `-octal`) | `spark/leaf/` | WIP, partial |
| `camera_projection`, `loader_lifecycle`, `sqlite_header`, `recorder_schema` | `spark/core/` | WIP, authors had just started; files are partial |
| Not started | — | `data_sanity`, `sha256`, `writeback_builder`, `workspace_publish`, `changeset_log`, `sql_tokenizer`, `civil_time`; `eviction_policy` is REDUNDANT (skip it: per-battle files replace the old priming/eviction) |
| Old-engine oracle + baselines | `testdata/baseline_old_engine.py`, `docs/baselines/` | done |
| New-pipeline native timings | `testdata/measure_extraction.py` | done |
| wasm32-vs-native rig | `testdata/wasm_bench/` | done (wasm32 ~2.0x slower than native) |
| Synthetic large fixtures generator | `testdata/make_large_fixture.py` | done (1.25 GB x2, 5 GB generated in cloud — regenerate locally) |
| **Gate 0 codegen (Ada -> wasm32 via GNAT-LLVM)** | `spark/tools/build_gnatllvm_wasm.sh` | **BLOCKED/UNKNOWN**: the build was launched in the cloud but no `llvm-gcc` appeared and the log could not be read (sandbox safety classifier). Run it locally and read its log |

WIP files are committed as "WIP (UNVERIFIED)" snapshots; they are squashed away in the final history rewrite.

## Measured facts (see `docs/real-data-profile.md`, `docs/baselines/`)
- Real corpus (owner-provided `lua.7z`, 39 files, 2.9 GB): the 1.1 GB file has 15.3M agent rows, 81k ticks (~32 h), **158 battles**; the old engine
  silently shows 16 and **fails to load it** ("database disk image is malformed"); same failure on a 1.26 GB synthetic file -> size-related.
  A 694 MB synthetic file loads but takes 131 s and 1.96 GB browser memory.
- New design, native SQLite, real 1.1 GB file: boundary detection 0.15 s; open one battle (bisect + copy + index + derive) median 0.098 s, max 0.41 s;
  extract-all of 158 battles on ONE thread 17.9 s. wasm32 is ~2.0x slower -> still inside the budgets (1.5 s / 60 s). So the extraction thread pool is
  **not required by the budgets** (recorded in `docs/justifications.md` J3); the owner insists real multithreading stays — see directive 9.
- Native-vs-wasm benchmark crashed Node 22's V8 when several hundred MB of wasm memory were held across repeated open/close (cloud container). Measure in
  real browsers for CI.

## Decisions made (all in `docs/PLAN.md`; the [A] ones await the owner's confirmation)
Per-battle files R_k/B_k with on-demand extraction (rowid range by bisection); source file read in place via `FileReaderSync` (no copy); 3 selectable DBs (2 in
battle mode); one checkpoint mechanism (SQLite session change-sets); real shared-memory threads kept with a correctness discipline (one owner per file, per-thread
arena + connection, real registered mutexes, racy VFS lock automaton deleted); wasm32 first; simplest rendering first (instanced draws, GPU lerp, double-buffered
snapshots; look-ahead/atlas only if the 60 FPS gate fails); proven units compiled with checks suppressed; limits first-class (`Limits`).

## Blockers / open questions for the owner
1. GNAT-LLVM wasm build status (Gate 0). 2. Confirm the [A] readings listed in PLAN "Needs the owner". 3. Permission decisions for proof-boundary items
R1–R7 (nothing may be tested instead of proven without the owner's explicit OK). 4. Keep/drop: `?primingBudgetMiB=`, cube demo `index.html`. 5. Whether to keep the
extraction thread pool given J3 numbers. 6. Behaviours that look like bugs (PLAN "Needs the owner" 7).

## Rebuild the environment locally (Linux commands; macOS/Windows: use Alire's installers and adapt)
```
# 1. Ada/SPARK: Alire, GNAT 14.2.1, gnatprove 14.1.1
curl -L -o alr.zip https://github.com/alire-project/alire/releases/download/v2.0.2/alr-2.0.2-bin-x86_64-linux.zip
unzip alr.zip -d ~/alr && export PATH=~/alr/bin:$PATH
alr -n index --reset-community && alr -n toolchain --select gnat_native gprbuild
(cd spark/spikes/tick_lookup && alr -n build && alr -n exec -- gnatprove -P spike.gpr --level=2)   # fetches gnatprove; expect 27 checks, 0 unproved
spark/tools/prove.sh spark/leaf/limits                                                             # uses spark/tools/env.sh (honours $ALIRE_HOME)
# 2. wasm toolchain pieces from the distro (Ubuntu): clang, lld, wasi-libc, libclang-rt-18-dev-wasm32, node >= 22, python3 + sqlite3
# 3. Ada -> wasm32: spark/tools/build_gnatllvm_wasm.sh   (WR_TOOLS=dir; AdaWebPack's CI recipe; READ ITS LOG; then compile spark/spikes/tick_lookup
#    with: llvm-gcc -c -O1 --target=wasm32 -gnateT=<adawebpack>/source/rtl/wasm32.atp spike.adb ; link with wasm-ld; run in node)
# 4. Browser baselines: pip install "playwright==1.56.0" psutil ; playwright install chromium   (cloud had Chromium 141 preinstalled)
# 5. Real data (NEVER commit): ask the owner for the Drive link to lua.7z (609,562,239 B) -> 7z x -> $WR_DATA/replays/*.sqlite  (39 files, 2.9 GB)
# 6. Fixtures:  python3 testdata/make_large_fixture.py --out $WR_DATA/synthetic/s1g.sqlite --target-bytes 1073741824 --verify    (--shape giant for one huge battle)
# 7. Baselines: python3 testdata/baseline_old_engine.py FILE.sqlite --json out.json ;  python3 testdata/measure_extraction.py FILE.sqlite --json out.json
#    (note: serve.py binds IPv6 only; baseline_old_engine.py serves over IPv4 itself)
```
Golden data in the repo: `docs/baselines/golden_boundaries_old_engine_uncapped.json` (old SQL's battles for all 31 real files; integers only),
`spark/core/boundary_segmentation/tests/boundary_cases.txt` (31 cases). Cloud commits used the git identity `Claude <noreply@anthropic.com>`; use the owner's.

## The proof factory (how units were built; scripts in `spark/tools/workflows/`)
Per unit: author (SPARK contracts first; `prove.sh` exit 0; README opens with <=10 lines "Guarantees"; scaffolding in `<Unit>.Proofs`) -> four independent
checks: (1) **mutation** — >= 8 behaviour-changing mutations of the body must each make gnatprove fail; (2) **differential** — native test vs an independently
written oracle on real/random/edge data, suite < 10 s; (3) **audit** — contract vs old behaviour, grep for `pragma Assume`/`SPARK_Mode (Off)`/Annotate;
(4) **robustness + simplicity + speed** — fuzz totality, Guarantees readable, benchmark. Then commit "Prove <unit>: ...". The scripts are for Claude Code's `Workflow`
tool (args `{repo, data}`); they cost real money — by hand, follow the same loop one unit at a time. The specs of every planned unit are inside those scripts
(`UNITS`, `UNITS_2A`, `UNITS_2B`): read them, they are the unit requirements.

## Recommended next steps (ordered by value per cost)
1. **Local setup + sanity:** rebuild the environment above; `spark/tools/prove.sh` on `spark/spikes/tick_lookup`, `spark/leaf/limits`, `spark/core/boundary_segmentation`,
   `spark/core/snapshot_swap`; run each unit's `tests/run_tests.sh`.
2. **Close Gate 0:** run `build_gnatllvm_wasm.sh`, read the log, fix, then compile the proven tick lookup to wasm32, link, run in node. Also spike shared-memory atomics (CAS counter +
   ready flag across two Workers) from Ada or the thin C shim. Record the decision in `docs/toolchain-decision.md`. If GNAT-LLVM cannot work, tell the owner and evaluate routes B/C (PLAN).
3. **Verify the two author-proved units** with the four checks above and commit them as "Prove boundary_segmentation" / "Prove snapshot_swap" (fix findings first).
4. **Finish the WIP units in this order:** `sqlite_header`, `recorder_schema`, `tick_index` (if float proofs fight back, ask the owner about fixed-point time/alpha — do not weaken the spec),
   `sql_tokenizer`, `tar_layout`, `civil_time`, `data_sanity`, `writeback_builder`, `camera_projection`, `loader_lifecycle`, `workspace_publish`, `changeset_log`, `sha256`.
5. **Limits alignment pass** on every unit (use `Limits`; prove behaviour at limit-1/limit/limit+1; `Limit_Exceeded` beyond).
6. **Phase 3 threading spike** (`docs/justifications.md` J1–J5) in a real browser; then runtime base, engine + workspace pipeline, rendering + 60 FPS gate, editing/checkpoints,
   robustness fault-injection (`testdata/corrupt/`), UI cut-over (see PLAN phases 3–8).
7. **Last: history rewrite** (owner authorised `--force`): `git bundle create ../warband-pre-rewrite.bundle --all` first; squash/reword the noise ("balls", "ai goyslop", "DEMO",
   submodule fix/remove/re-add churn, "Partial update", "local work to rebase later", every "WIP (UNVERIFIED)") into meaningful commits keeping the owner's authorship; verify the final
   tree is byte-identical (`git diff` empty); `git push --force-with-lease` the claude branch; ask the owner before replacing `master`.

## File map
`docs/` plan, charter, limits, failure modes, features, justifications, baselines · `spark/{leaf,core,spikes}/<unit>/` SPARK units (`src/`, `tests/`, `README.md` Guarantees, `PROOF.md`) ·
`spark/tools/` prove.sh, env.sh, GNAT-LLVM build, workflow scripts · `spark/templates/unit.gpr` · `testdata/` old tests + new fixture/baseline/benchmark tools · everything else is the OLD tree
(oracle; leave it untouched until parity).

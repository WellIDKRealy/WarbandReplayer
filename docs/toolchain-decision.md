# Toolchain decision (Gate 0) — INTERIM

Rule: no unproven claims, no workarounds. Candidate chains are judged on an unbroken proof -> wasm binary
chain, wasm64 support, SQLite-boundary contracts, float story, and CI-runnability.

## A. SPARK (Ada) — proof half DONE, codegen half PENDING a permission decision
- gnat_native 14.2.1, gprbuild 22.0.1 and **gnatprove 14.1.1** (bundled Z3 4.13 / CVC5) install and run in
  the sandbox via Alire (`alr` 2.0.2). Spike `spark/spikes/tick_lookup`: 27 checks proved, 0 unproved.
- Ada -> wasm needs GNAT-LLVM (GNAT-FSF has no wasm backend). The reproducible recipe is AdaWebPack's CI
  (`godunko/adawebpack/.github/workflows/build.yml`): AdaCore/gnat-llvm @ 66e36d9, Fabien-Chouteau/bb-runtimes
  `gnat-fsf-14`, gcc-14.1.0 `gcc/ada` sources, LLVM 16.0.4 prebuilt, two patches, `make wasm`. All sources are
  reachable over git/HTTPS from the sandbox. **The auto-mode safety classifier blocked running that build**
  (it downloads and executes external code); it was not retried by another route. Needs the owner's decision.
- Known limits of that toolchain: nested subprograms, tasks/protected objects, and non-local exception
  propagation are unsupported; wasm32 only (wasm64 would need new work).

## B. Isabelle/HOL + Isabelle-LLVM — not evaluated (Isabelle distribution host still blocked; sources reachable by git)
## C. Why3 / Coq (apt: why3 1.6, coq 8.18), Frama-C, F*/KaRaMeL — not evaluated

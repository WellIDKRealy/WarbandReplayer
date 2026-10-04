# Owner directives (chronological, quoted from the conversation)

These are the owner's own instructions. Substantive requirements are quoted verbatim (spelling kept); pure insults are omitted with `[…]`.
They are binding. When something below conflicts with an older assumption in the code or docs, **the owner's words win**.

1. **The mission** (first big directive):
   > "Ai's like you are at programing as such i want you to try to port evertyhing that is portable to ADA Spark. You are to look through commit log and the commits, you are to proritize proofs over tests. You are to redesign the program as to be able to handle anomalousy large 1GB files, you are to take NO SHORTCUTS. YOU ARE TO PROOVE EVERYTHING AND IF YOU CANNOT PROOVE EVERYTHING YOU ARE TO EXPLAIN TO ME WHY THAT IS THE CASE AND ONLY IF I GIVE YOU PERMISSION YOU ARE ALLOWED TO NOT PROOVE IT - HOWEVER IN SUCH CASE IT NEEDS TO BE TESTED TRHOUGHLY - THE TESTS MUST BE FAST, EVERYTHING IS TO PE FIRST AND FORMOST PROOVEN AND THEN TESTED. ENSURE THAT NO HALF BAKED STATE IS EVER DISPLAYED, THAT EVERYTING IS FAST. THAT RENDERING USE BEST PRACTICAL ALGORITHMS TO ACHIVE WHAT THEY ARE SET OUT TO DO. KEEP SQLITE AS IT IS NESSECARY TO WORK - YOU ARE NOT ALLOWED TO MODIFY THE main.lua AS IT IS ALREADY DEPLOYED IN PRODUCTION AND IS COLLECTING DATA YOU ARE HOWEVER ARE ALLOWED TO MODIFY THE DATABASES IF NEEDED. CURRENTLY THE SQL EDITING HAS QUESTIONABLE DESIGN AS IT IS [expletive]ED UP BY MULTIPLE TRASH DATABASES, YOU ARE TO EXPLAIN TO ME HOW IT WORKS NOW IN DETAIL AND I WILL TELL YOU HOW IT SHOULD WORK"

2. **Scope clarification:** "the goal is overhaul, while preserving ALL FEATURES, read the commit log, what i mentioned is part of the overhaul."

3. **No workarounds:** "No work arounds are acceptable, if spark cannot be used test Issable/HOL or other proper formal proover that can be used for wasm32 if needed make it to wasm64"

4. **The database/SQL model (owner's spec):**
   > "there are to be 2 modes: Raw replay mode and battle mode both of them contain replay and battle files that serve as ultimate source of truth with replay file for battle mode is limited to only replay consiting of one battle. Overaly it should function in the following way in replay mode: Source Replay -> Determine battle bounds on source replay -> Produce per battle raw replay databases that just contain everything relating to that battle -> Produce battle sql database. Overaly it should function in the following way in battle mode: Battle mode is provided only battle raw replay databsase from which it producsed battle sql database is produced. Every single SQL is to be editable witch checkpoints o algo, currently when databases are produced they spam the selector with [stuff] - the final design should allow me to only select 3 databases namely original replay, per battle replay, battle replay. With the per battle replay and battle replay databases being synced to the battle on the screen. If you deem it sensible you can also create 3rd view database that will be just used for caching battle effects but you must deem it sensible and performant first. Overall since the task is so [expletive] simple it should work in full 60FPS on even [bad] PCs"

5. **Robustness:** "Ensure that every single possible scenario is handled such like corrupted file etc"

6. **Simplicity charter** (Terry Davis): "An idiot admires complexity, a genius admires simplicity, a physicist tries to make it simple, for an idiot anything the more complicated it is the more he will admire it, if you make something so clusterfucked he can't understand it he's gonna think you're a god cause you made it so complicated nobody can understand it. That's how they write journals in Academics, they try to make it so complicated people think you're a genius. The purpose of proofs is to provide guarantees that are simple, as providing such guarantees is impossible with tests. The entire project is to be as simple to undersand as possible. No [bloat] like emcc etc it should logical and simple while implementing all needed features for it to work"

7. **Fast too:** "No, it needs to also be fast. It is to be as simple as possible while having all the features and being fast"

8. **Plan hygiene:** "After you modify the plan ensure its internal consistency" / "Ensure consistency of the plan."

9. **Complexity rule** (a correction — the owner objected to removing multithreading):
   > "Do not [remove] multi threading it is necessary for speed. You misunderstood what i said. Add complexity only if it is necessary, and in order to add it you need to justify it with performance gains and or needing to add features. Multithreading in the past was found to be necessary. There are things that must be complicated in such case so be it but if they do not need to they shouldn't be. Ensure consistency of the plan."

10. **History rewrite (do it at the very end):** "Also later rewrite git project history, to make it clean and sensible to read. things like 'to rebase later' will need to be rebased, you are allowed to use --force if needed"

11. **Limits:** "Reflect the limits in proofs"

12. **Authors/maintainers in manifests:** set to "not your fucking problem o algo" (done in `spark/spikes/tick_lookup/alire.toml`; Alire insists on an email for `maintainers`, so a dummy `<nobody@example.com>` follows the text).

13. **Cost:** "you will hit the spend limit before you finish this, i do not intend on paying more for cloud. You will pack everything that is necessary to restore this conversation in local claude for which i am paying for and which is superior to cloud … Tell local claude how to do it, give him the plan as well." -> this handoff package.

## Permissions/approvals the owner gave in the cloud session (do not assume they carry over)
- Network allowlist was widened; the GitHub App was installed for push access; the owner approved building GNAT-LLVM from external sources.
- The owner provided a Google Drive link to `lua.7z` (real replay corpus). **The link is deliberately NOT in this repository** — ask the owner for it.

## Communication
The owner is direct and impatient. Do the work, report facts (including failures) plainly, don't pad, don't re-ask what these directives already answer.

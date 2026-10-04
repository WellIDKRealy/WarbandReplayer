# limits — proof record
- gnatprove 14.1.1, level 4: 2 checks (1 functional contract, 1 termination), **0 unproved, 0 assumptions**.
- `Consistent` (postcondition `Consistent'Result`) proves the relationships between the limits.
- Mutation check (temporary copies): raising `Max_Buffer_Bytes` to 2**31 -> compile error (no longer fits `Integer`); lowering
  `Js_Max_Safe_Integer` below the database limit -> "postcondition might fail". Both break the proof, so it is not vacuous.
- Not yet asserted (needs the build): SQLite's compiled-in `sqlite3_limit()` values and the wasm memory configuration equal these
  constants — added as a build-time check in Phase 3.

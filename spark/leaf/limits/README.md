# limits

## Guarantees
- Every numeric limit the system depends on (SQLite, wasm32, JavaScript, recorder, owner decisions) is defined here, once.
- Each limit has a documented source in `docs/limits.md`; units use these names, never ad-hoc bounds like `2**40`.
- The relationships between the limits are proved, not tested: the largest database fits an exact JS Number and a signed 64-bit
  integer; the configured wasm memory fits wasm32; every buffer length fits the configured memory and a 32-bit offset.
- The range subtypes (`File_Bytes`, `Page_Size`, `Page_Count`, `Buffer_Length`, `Agent_Id`, `Thread_Count`) make out-of-limit values
  unrepresentable inside a unit; every unit returns an explicit `Limit_Exceeded` result for raw input outside them.

Changing a limit means changing this file and `docs/limits.md`, and re-running the proofs of every unit that uses it.

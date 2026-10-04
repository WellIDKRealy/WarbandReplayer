# camera_projection

SPARK port of the OLD engine's camera and projection math (FEATURES: Camera — WASD pan, mouse-drag pan, wheel zoom,
auto-fit to map bounds, auto-follow view shift, centre crosshair).  The old C/JS code is the behavioural oracle and
was not touched.

## Guarantees

1. **Total.** Every operation returns a `Status` on *any* input: NaN, infinity, huge numbers, screen size 0, a bad key
   index. No exception, no division by zero, no NaN or infinity is ever stored or produced.
2. **A rejected call changes nothing.** On any status except `Ok` the camera is exactly as it was.
3. **The camera is always valid:** all numbers finite, position within +-1e6, zoom within 0.02 .. 40, screen at least 1x1
   (enforced by the component types and proved at every assignment).
4. **Same maths as the old engine, bit for bit.** Pan, wheel zoom, fit-to-map-bounds (clamp 0.05 .. 10), key panning
   (`35 / zoom`), view shift, aspect and `x_bound`: the contracts state the old formulas; 200 000 random operation
   sequences give identical results to the old `main.c`, and 150 000 projected points are identical to the old `main.js`.
5. **The view shift is a render-time offset only:** it never changes the camera position or zoom (nor does anything but
   the shift change the shift); the crosshair's world position is the camera position.
6. **World <-> screen:** `World_To_Screen` is the exact old `worldToScreen` formula; with no shift the camera centre maps to
   the exact middle of the canvas; the inverse formula returns the world point to within 1e-6 world units everywhere in the
   domain (`Camera_Projection.Proofs`).
7. **Fast:** a pan, zoom or projection costs a few nanoseconds (numbers in `PROOF.md`).

## Operations

| Operation (old function) | Rejected with |
|---|---|
| `Set_Screen` (`set_screen_dimensions`) | `Bad_Screen` unless 1 <= width, height <= 65 536 |
| `Set_Map_Bounds` (`set_map_bounds`): store bounds, centre camera, zoom to fit | `Not_Finite`, `Out_Of_Range` (> 1e6) |
| `Apply_Zoom` (`apply_zoom`): x1.1 / x0.9 then clamp 0.02 .. 40 | `Not_Finite` |
| `Pan` (`pan_camera`): drag by pixels | `Not_Finite`, `Out_Of_Range` (drag > 1e6 px, or the camera would leave +-1e6) |
| `Set_View_Shift` (`set_view_shift`) | `Not_Finite`, `Out_Of_Range` (> 2e6) |
| `Set_Key` (`set_key_state`) and `Advance` (the key-panning half of `render_frame`) | `Bad_Key`; `Not_Finite`, `Out_Of_Range` (dt > 1e6 s, or the camera would leave +-1e6) |
| `World_To_Screen` (`worldToScreen`) | `Not_Finite`, `Out_Of_Range` (point beyond +-1e6) |

`Camera` is a plain record the caller owns (`Initial` = the old globals' start values); the unit has no state.
The GL view-projection matrix stays in the renderer and is built from `Half_Width`, `Half_Height`, `X`, `Y`, `Zoom`.

## Deliberate differences from the old code

See `PROOF.md` ("Old behaviour"): the old engine turned screen height 0 into `aspect = inf` and a NaN camera, stored NaN/Inf
from JS silently, let a drag or key hold run the camera off to infinity, and zoomed on an infinite wheel delta. All of those
are now typed rejections; every input the old engine handled sanely gives bit-identical results.

## Layout

| file | content |
|---|---|
| `camera_projection.gpr` | proof project (template `spark/templates/unit.gpr`, plus the SPARK lemma library for the proof child) |
| `src/camera_projection.ads/.adb` | the unit: types, status, operations, the old formulas as expression functions |
| `src/camera_projection-proofs.ads/.adb` | `Camera_Projection.Proofs`: ghost scaffolding — the inverse mapping, the round-trip error bound, the crosshair lemma. Never part of the interface or the build |
| `tests/` | native differential test (old `main.c` linked in via `oracle.c`, old `main.js` via `oracle_js.js`), benchmark, `run_tests.sh` |
| `PROOF.md` | gnatprove summary, benchmark numbers, register items, old-behaviour differences |

    spark/tools/prove.sh spark/core/camera_projection          # gnatprove 14.1, level 4, 0 unproved
    spark/core/camera_projection/tests/run_tests.sh            # differential tests, a few seconds

Zero-footprint: `Pure`, no state, no allocation, no exceptions raised, no nested subprograms, no tasking; the only
language-defined unit used is `Ada.Unchecked_Conversion` (an intrinsic) for the NaN/Inf test. Sizes are 64-bit-safe
(`Max_Screen` is 65 536; nothing here counts bytes).

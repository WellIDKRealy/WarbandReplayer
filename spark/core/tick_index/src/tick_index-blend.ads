--  Tick_Index.Blend: the per-row blends applied with the interpolation fraction alpha.
--
--  Port of the OLD engine's
--    replay_worker.c blend_render_slot (~1015-1030):   x = x + (bx - x) * alpha            (32-bit float)
--    main.js updateNatoSymbolTransform (~886-888):      wx = rowA.x + (rowB.x - rowA.x) * alpha   (JS double)
--    main.js blendAngleDeg (~795-798):                  shortest-angle blend, JS doubles + `%`
--
--  Floating point model assumed (and the only thing the proofs cannot establish, see PROOF.md):
--  IEEE-754 binary32 / binary64, round-to-nearest-even, one rounding per operator, no fused
--  multiply-add, no extended precision.  x86-64 SSE2 and wasm32 satisfy this.
package Tick_Index.Blend
  with SPARK_Mode, Pure
is
   -----------------------------------------------------------------------------------------------
   --  32-bit lerp (the C engine's blend_render_slot)
   -----------------------------------------------------------------------------------------------

   --  Positions are small (about -100 .. 100); the bound only has to keep every intermediate finite.
   subtype Coord is Float range -1.0E30 .. 1.0E30;
   subtype Coord_Raw is Float range -4.0E30 .. 4.0E30;

   function Clamp (X, Lo, Hi : Float) return Float is
     (if X < Lo then Lo elsif X > Hi then Hi else X)
   with Pre => Lo <= Hi;

   --  VERBATIM old formula  x + (bx - x) * alpha  with one float rounding per operator.
   --  In floating point this is NOT guaranteed to stay between the endpoints (it can overshoot by a few
   --  ulp) and at alpha = 1 it can differ from bx by an ulp; both are impossible to prove because false
   --  (e.g. A = 1.0, B = 1.0E-8, Alpha = 1.0 gives 0.0).  What IS proved: the formula itself, no overflow,
   --  and that the result is exactly A at alpha = 0 or A = B.  (That it never leaves the bracket
   --  [A, A + (B - A)] is true by IEEE monotone rounding but the SMT solvers cannot discharge the float
   --  multiplication bound within the 60 s budget, so it is not claimed - see PROOF.md.)
   function Lerp_Raw (A, B : Coord; Alpha : Alpha_Type) return Coord_Raw
   with
     Global => null,
     Post   =>
       Lerp_Raw'Result = A + (B - A) * Alpha
       and then (if Alpha = 0.0 or else A = B then Lerp_Raw'Result = A);

   --  The lerp the new engine should use: the old value, except that it is forced between its
   --  endpoints and exact at both ends.
   --    * Result in [min (A, B), max (A, B)]                              (stays between the endpoints)
   --    * alpha = 0 -> exactly A,  alpha = 1 -> exactly B
   --    * alpha < 1 -> Clamp (old formula): bit-identical to the old engine whenever the old value
   --      was inside the endpoints, otherwise the nearest endpoint.
   function Lerp (A, B : Coord; Alpha : Alpha_Type) return Coord
   with
     Global => null,
     Post   =>
       Lerp'Result in Float'Min (A, B) .. Float'Max (A, B)
       and then (if Alpha = 0.0 then Lerp'Result = A)
       and then (if Alpha = 1.0 then Lerp'Result = B)
       and then (if Alpha < 1.0 then
                   Lerp'Result = Clamp (Lerp_Raw (A, B, Alpha), Float'Min (A, B), Float'Max (A, B)));

   -----------------------------------------------------------------------------------------------
   --  64-bit lerp (main.js: the NATO symbol layer does the same blend in JS doubles)
   -----------------------------------------------------------------------------------------------

   subtype Coord64 is Long_Float range -1.0E150 .. 1.0E150;
   subtype Coord64_Raw is Long_Float range -4.0E150 .. 4.0E150;
   subtype Alpha_Wide is Long_Float range 0.0 .. 1.0;

   function Clamp64 (X, Lo, Hi : Long_Float) return Long_Float is
     (if X < Lo then Lo elsif X > Hi then Hi else X)
   with Pre => Lo <= Hi;

   function Lerp64_Raw (A, B : Coord64; Alpha : Alpha_Wide) return Coord64_Raw
   with
     Global => null,
     Post   =>
       Lerp64_Raw'Result = A + (B - A) * Alpha
       and then (if Alpha = 0.0 or else A = B then Lerp64_Raw'Result = A);

   function Lerp64 (A, B : Coord64; Alpha : Alpha_Wide) return Coord64
   with
     Global => null,
     Post   =>
       Lerp64'Result in Long_Float'Min (A, B) .. Long_Float'Max (A, B)
       and then (if Alpha = 0.0 then Lerp64'Result = A)
       and then (if Alpha = 1.0 then Lerp64'Result = B)
       and then (if Alpha < 1.0 then
                   Lerp64'Result =
                     Clamp64 (Lerp64_Raw (A, B, Alpha),
                              Long_Float'Min (A, B), Long_Float'Max (A, B)));

   --  The float32 alpha of the C engine seen as the JS number the UI receives (exact conversion).
   function To_Wide (Alpha : Alpha_Type) return Alpha_Wide is (Long_Float (Alpha));

   -----------------------------------------------------------------------------------------------
   --  Shortest-angle blend (main.js blendAngleDeg)
   --
   --     delta = ((b - a + 180) % 360 + 360) % 360 - 180;   return a + delta * alpha;
   --
   --  `%` is C fmod on doubles (exact, sign of the dividend).  Angles are degrees; |angle| <= 1.0E9
   --  (2.8 million turns) keeps every intermediate finite and below 2**53 / 360 turns.
   -----------------------------------------------------------------------------------------------

   subtype Angle_Deg is Long_Float range -1.0E9 .. 1.0E9;
   subtype Raw_Diff is Long_Float range -2.0E9 .. 2.0E9;      --  B - A
   subtype Delta_Deg is Long_Float range -180.0 .. 180.0;
   subtype Angle_Out is Long_Float range -1.1E9 .. 1.1E9;
   subtype Fmod_Arg is Long_Float range -4.0E9 .. 4.0E9;
   subtype Fmod_Res is Long_Float range -360.0 .. 360.0;

   --  C fmod (X, 360.0), computed without division by exact binary long division (360 * 2**k steps).
   --  The proof pins the range, the sign, the identity on (-360, 360) and the exact first wrap; that the
   --  result is congruent to X modulo 360 for larger |X| is checked by differential tests (PROOF.md).
   function Fmod360 (X : Fmod_Arg) return Fmod_Res
   with
     Global => null,
     Post   =>
       abs Fmod360'Result < 360.0
       and then (if X >= 0.0 then Fmod360'Result >= 0.0)
       and then (if X <= 0.0 then Fmod360'Result <= 0.0)
       and then (if abs X < 360.0 then Fmod360'Result = X)
       and then (if X >= 360.0 and then X < 720.0 then Fmod360'Result = X - 360.0)
       and then (if X <= -360.0 and then X > -720.0 then Fmod360'Result = X + 360.0);

   --  ((D + 180) % 360 + 360) % 360 - 180 for a raw angle difference D = B - A: the signed shortest
   --  rotation, in [-180, 180).  The postcondition pins it as the representative of D modulo 360 in the
   --  four windows around zero (|D| < 540) with an explicit absolute tolerance (the old formula adds and
   --  subtracts 180 and 360, so it carries a few 1.0E-14 of rounding noise); the margins of 1.0E-6 around
   --  the half-turn points +-180 and +-540 keep the two equivalent representations of a half turn out of
   --  the windows.  Beyond |D| >= 540 only the range [-180, 180) is proved; congruence modulo 360 there
   --  is established by the differential tests (PROOF.md).
   function Wrap_Delta (D : Raw_Diff) return Delta_Deg
   with
     Global => null,
     Post   =>
       (if D >= 0.0 and then D <= 180.0 - 1.0E-6 then
          abs (Wrap_Delta'Result - D) <= 1.0E-12)
       and then (if D >= -180.0 and then D < 0.0 then
                   abs (Wrap_Delta'Result - D) <= 1.0E-12)
       and then (if D >= 180.0 + 1.0E-6 and then D <= 540.0 - 1.0E-6 then
                   abs (Wrap_Delta'Result - (D - 360.0)) <= 1.0E-12)
       and then (if D < -180.0 - 1.0E-6 and then D >= -540.0 then
                   abs (Wrap_Delta'Result - (D + 360.0)) <= 1.0E-12);

   --  Signed shortest rotation from angle A to angle B (old: the `delta` of blendAngleDeg).
   function Shortest_Delta (A, B : Angle_Deg) return Delta_Deg
   with
     Global => null,
     Post   =>
       Shortest_Delta'Result = Wrap_Delta (B - A)
       and then (if B - A >= -180.0 and then B - A <= 180.0 - 1.0E-6 then
                   abs (Shortest_Delta'Result - (B - A)) <= 1.0E-12)
       and then (if B - A >= 180.0 + 1.0E-6 and then B - A <= 540.0 - 1.0E-6 then
                   abs (Shortest_Delta'Result - ((B - A) - 360.0)) <= 1.0E-12)
       and then (if B - A < -180.0 - 1.0E-6 and then B - A >= -540.0 then
                   abs (Shortest_Delta'Result - ((B - A) + 360.0)) <= 1.0E-12);

   --  VERBATIM old formula  a + delta * alpha.  Proved: the formula, no overflow, A at alpha = 0,
   --  A + delta at alpha = 1.
   function Blend_Angle_Deg_Raw (A, B : Angle_Deg; Alpha : Alpha_Wide) return Angle_Out
   with
     Global => null,
     Post   =>
       Blend_Angle_Deg_Raw'Result = A + Shortest_Delta (A, B) * Alpha
       and then (if Alpha = 0.0 then Blend_Angle_Deg_Raw'Result = A)
       and then (if Alpha = 1.0 then Blend_Angle_Deg_Raw'Result = A + Shortest_Delta (A, B));

   --  The shortest-angle blend the new engine should use: the old value, forced onto the arc between A and
   --  A + delta (it can only differ from the old value by a rounding overshoot of that arc).
   --    * Result in [min (A, A + delta), max (A, A + delta)]  and  A - 180 <= Result <= A + 180:
   --      the blend never leaves the short arc, so it travels at most half a turn (no 359deg -> 0deg spin)
   --    * alpha = 0 -> A,  alpha = 1 -> A + delta
   --    * alpha < 1 -> Clamp64 (old formula, arc ends)
   function Blend_Angle_Deg (A, B : Angle_Deg; Alpha : Alpha_Wide) return Angle_Out
   with
     Global => null,
     Post   =>
       Blend_Angle_Deg'Result
         in Long_Float'Min (A, A + Shortest_Delta (A, B)) .. Long_Float'Max (A, A + Shortest_Delta (A, B))
       and then Blend_Angle_Deg'Result in A - 180.0 .. A + 180.0
       and then (if Alpha = 0.0 then Blend_Angle_Deg'Result = A)
       and then (if Alpha = 1.0 then Blend_Angle_Deg'Result = A + Shortest_Delta (A, B))
       and then (if Alpha < 1.0 then
                   Blend_Angle_Deg'Result =
                     Clamp64 (Blend_Angle_Deg_Raw (A, B, Alpha),
                              Long_Float'Min (A, A + Shortest_Delta (A, B)),
                              Long_Float'Max (A, A + Shortest_Delta (A, B))));

end Tick_Index.Blend;

package body Tick_Index.Blend
  with SPARK_Mode
is

   -----------------------------------------------------------------------------------------------
   --  32-bit lerp
   -----------------------------------------------------------------------------------------------

   function Lerp_Raw (A, B : Coord; Alpha : Alpha_Type) return Coord_Raw is
   begin
      return A + (B - A) * Alpha;        --  old: x = x + (bx - x) * alpha;
   end Lerp_Raw;

   function Lerp (A, B : Coord; Alpha : Alpha_Type) return Coord is
   begin
      if Alpha >= 1.0 then
         return B;
      else
         declare
            Lo : constant Coord := Float'Min (A, B);
            Hi : constant Coord := Float'Max (A, B);
            R  : constant Coord_Raw := Lerp_Raw (A, B, Alpha);
         begin
            if R < Lo then
               return Lo;
            elsif R > Hi then
               return Hi;
            else
               return R;
            end if;
         end;
      end if;
   end Lerp;

   -----------------------------------------------------------------------------------------------
   --  64-bit lerp
   -----------------------------------------------------------------------------------------------

   function Lerp64_Raw (A, B : Coord64; Alpha : Alpha_Wide) return Coord64_Raw is
   begin
      return A + (B - A) * Alpha;        --  JS: rowA.x + (rowB.x - rowA.x) * alpha
   end Lerp64_Raw;

   function Lerp64 (A, B : Coord64; Alpha : Alpha_Wide) return Coord64 is
   begin
      if Alpha >= 1.0 then
         return B;
      else
         declare
            Lo : constant Coord64 := Long_Float'Min (A, B);
            Hi : constant Coord64 := Long_Float'Max (A, B);
            R  : constant Coord64_Raw := Lerp64_Raw (A, B, Alpha);
         begin
            if R < Lo then
               return Lo;
            elsif R > Hi then
               return Hi;
            else
               return R;
            end if;
         end;
      end if;
   end Lerp64;

   -----------------------------------------------------------------------------------------------
   --  fmod (X, 360.0) by binary long division
   --
   --  Invariant before the step with P = 360 * 2**k:  0 <= R < 2 * P.  Subtracting P when R >= P is
   --  exact (Sterbenz: P <= R < 2 P) and leaves R < P = 2 * (360 * 2**(k-1)).  After the step with
   --  P = 360 the remainder is below 360.
   -----------------------------------------------------------------------------------------------

   subtype Rem_Value is Long_Float range 0.0 .. 8.0E9;

   function Reduce_Step (R : Rem_Value; P : Long_Float) return Rem_Value
   with
     Global => null,
     Pre    => P >= 360.0 and then P <= 4.0E9 and then R < 2.0 * P,
     Post   => Reduce_Step'Result < P
               and then (if R < P then Reduce_Step'Result = R else Reduce_Step'Result = R - P)
   is
   begin
      if R >= P then
         return R - P;
      else
         return R;
      end if;
   end Reduce_Step;

   function Fmod360 (X : Fmod_Arg) return Fmod_Res is
      R : Rem_Value := abs X;
   begin
      if R < 360.0 then
         return X;
      end if;
      R := Reduce_Step (R, 3019898880.0);   --  360 * 2**23
      R := Reduce_Step (R, 1509949440.0);   --  360 * 2**22
      R := Reduce_Step (R, 754974720.0);   --  360 * 2**21
      R := Reduce_Step (R, 377487360.0);   --  360 * 2**20
      R := Reduce_Step (R, 188743680.0);   --  360 * 2**19
      R := Reduce_Step (R, 94371840.0);   --  360 * 2**18
      R := Reduce_Step (R, 47185920.0);   --  360 * 2**17
      R := Reduce_Step (R, 23592960.0);   --  360 * 2**16
      R := Reduce_Step (R, 11796480.0);   --  360 * 2**15
      R := Reduce_Step (R, 5898240.0);   --  360 * 2**14
      R := Reduce_Step (R, 2949120.0);   --  360 * 2**13
      R := Reduce_Step (R, 1474560.0);   --  360 * 2**12
      R := Reduce_Step (R, 737280.0);   --  360 * 2**11
      R := Reduce_Step (R, 368640.0);   --  360 * 2**10
      R := Reduce_Step (R, 184320.0);   --  360 * 2**9
      R := Reduce_Step (R, 92160.0);   --  360 * 2**8
      R := Reduce_Step (R, 46080.0);   --  360 * 2**7
      R := Reduce_Step (R, 23040.0);   --  360 * 2**6
      R := Reduce_Step (R, 11520.0);   --  360 * 2**5
      R := Reduce_Step (R, 5760.0);   --  360 * 2**4
      R := Reduce_Step (R, 2880.0);   --  360 * 2**3
      R := Reduce_Step (R, 1440.0);   --  360 * 2**2
      R := Reduce_Step (R, 720.0);   --  360 * 2**1
      R := Reduce_Step (R, 360.0);   --  360 * 2**0
      return (if X < 0.0 then -R else R);
   end Fmod360;

   -----------------------------------------------------------------------------------------------
   --  Shortest angle
   -----------------------------------------------------------------------------------------------

   function Wrap_Delta (D : Raw_Diff) return Delta_Deg is
      T1 : constant Fmod_Arg := D + 180.0;             --  (b - a + 180)
      M1 : constant Fmod_Res := Fmod360 (T1);          --  ... % 360
      T2 : constant Fmod_Arg := M1 + 360.0;            --  ... + 360
      M2 : constant Fmod_Res := Fmod360 (T2);          --  ... % 360
   begin
      return M2 - 180.0;                               --  ... - 180
   end Wrap_Delta;

   function Shortest_Delta (A, B : Angle_Deg) return Delta_Deg is
   begin
      return Wrap_Delta (B - A);
   end Shortest_Delta;

   function Blend_Angle_Deg_Raw (A, B : Angle_Deg; Alpha : Alpha_Wide) return Angle_Out is
   begin
      return A + Shortest_Delta (A, B) * Alpha;        --  old: a + delta * alpha
   end Blend_Angle_Deg_Raw;

   function Blend_Angle_Deg (A, B : Angle_Deg; Alpha : Alpha_Wide) return Angle_Out is
      Delta_Angle : constant Delta_Deg := Shortest_Delta (A, B);
      End_Angle   : constant Angle_Out := A + Delta_Angle;
   begin
      if Alpha >= 1.0 then
         return End_Angle;
      else
         declare
            Lo : constant Angle_Out := Long_Float'Min (A, End_Angle);
            Hi : constant Angle_Out := Long_Float'Max (A, End_Angle);
            R  : constant Angle_Out := Blend_Angle_Deg_Raw (A, B, Alpha);
         begin
            if R < Lo then
               return Lo;
            elsif R > Hi then
               return Hi;
            else
               return R;
            end if;
         end;
      end if;
   end Blend_Angle_Deg;

end Tick_Index.Blend;

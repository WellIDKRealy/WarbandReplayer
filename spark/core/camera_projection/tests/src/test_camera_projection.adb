--  Native differential + property test of the camera_projection unit.
--
--    test_camera_projection <mode> <sequences> <js-cases-file>     mode = fast | contracts
--
--  1. Operation sequences.  Random sequences of all eight operations (screen sizes, bounds, wheel, drag,
--     view shift, keys, key-panning frames), including degenerate and non-finite arguments, are applied to
--     the Ada unit AND to the OLD main.c (tests/oracle.c includes it unmodified).  After every operation the
--     whole camera is compared BIT-EXACTLY (raw patterns).  The expected status is computed by an
--     independent classifier in this file (C's isfinite + comparisons); for arguments the unit must reject,
--     the camera must be unchanged and the status the documented one.  The same rejected calls are also
--     fed to the old C code (on a copy) to count what the old engine did with them.
--  2. World -> screen against the OLD main.js worldToScreen (cases produced by oracle_js.js from the real
--     source text), bit-exact; the round trip (inverse formula) is checked against its proven bound.
--  3. Is_Finite against C's isfinite on every NaN/Inf pattern, all exponents and sampled mantissas.
--
--  fast       : built with assertions off; the big runs.
--  contracts  : built with -gnata, every pre/postcondition of the SPARK sources runs as a run-time check.
with Ada.Text_IO;           use Ada.Text_IO;
with Ada.Command_Line;
with Ada.Unchecked_Conversion;
with Interfaces;            use Interfaces;
with Camera_Projection;     use Camera_Projection;

procedure Test_Camera_Projection is

   ---------------------------------------------------------------------------------------------
   --  C oracle (tests/oracle.c)
   ---------------------------------------------------------------------------------------------
   type Int_Array is array (0 .. 3) of Integer_32 with Convention => C;
   type OState is record
      Cam_X, Cam_Y, Zoom, Shift_X, Shift_Y : Unsigned_32;
      Width, Height                        : Integer_32;
      Min_X, Max_X, Min_Y, Max_Y           : Unsigned_32;
      Keys                                 : Int_Array;
   end record
     with Convention => C;

   procedure O_Get (S : out OState) with Import, Convention => C, External_Name => "o_get";
   procedure O_Set (S : in OState) with Import, Convention => C, External_Name => "o_set";
   procedure O_Reset with Import, Convention => C, External_Name => "o_reset";
   procedure O_Set_Screen (W, H : Integer_32) with Import, Convention => C, External_Name => "o_set_screen";
   procedure O_Set_Map_Bounds (A, B, C, D : Float)
     with Import, Convention => C, External_Name => "o_set_map_bounds";
   procedure O_Apply_Zoom (D : Float) with Import, Convention => C, External_Name => "o_apply_zoom";
   procedure O_Pan (Dx, Dy : Float) with Import, Convention => C, External_Name => "o_pan";
   procedure O_Set_View_Shift (X, Y : Float) with Import, Convention => C, External_Name => "o_set_view_shift";
   procedure O_Set_Key (I, P : Integer_32) with Import, Convention => C, External_Name => "o_set_key";
   procedure O_Render_Frame (Dt : Float) with Import, Convention => C, External_Name => "o_render_frame";
   function O_Isfinite32 (U : Unsigned_32) return Integer_32
     with Import, Convention => C, External_Name => "o_isfinite32";
   function O_Isfinite64 (U : Unsigned_64) return Integer_32
     with Import, Convention => C, External_Name => "o_isfinite64";

   function To_F   is new Ada.Unchecked_Conversion (Unsigned_32, Float);
   function To_U32 is new Ada.Unchecked_Conversion (Float, Unsigned_32);
   function To_LF  is new Ada.Unchecked_Conversion (Unsigned_64, Long_Float);
   function To_U64 is new Ada.Unchecked_Conversion (Long_Float, Unsigned_64);

   ---------------------------------------------------------------------------------------------
   --  Bookkeeping
   ---------------------------------------------------------------------------------------------
   Checks   : Natural := 0;
   Failures : Natural := 0;
   Contracts_Mode : Boolean := False;

   procedure Check (Cond : Boolean; Msg : String) is
   begin
      Checks := Checks + 1;
      if not Cond then
         Failures := Failures + 1;
         if Failures <= 20 then
            Put_Line ("FAIL: " & Msg);
         end if;
      end if;
   end Check;

   function Hex32 (U : Unsigned_32) return String is
      Digits_Of : constant String := "0123456789abcdef";
      R : String (1 .. 8);
      V : Unsigned_32 := U;
   begin
      for I in reverse R'Range loop
         R (I) := Digits_Of (Integer (V and 15) + 1);
         V := V / 16;
      end loop;
      return R;
   end Hex32;

   function Hex64 (U : Unsigned_64) return String is
      Digits_Of : constant String := "0123456789abcdef";
      R : String (1 .. 16);
      V : Unsigned_64 := U;
   begin
      for I in reverse R'Range loop
         R (I) := Digits_Of (Integer (V and 15) + 1);
         V := V / 16;
      end loop;
      return R;
   end Hex64;

   ---------------------------------------------------------------------------------------------
   --  Random numbers (splitmix64) and argument generators
   ---------------------------------------------------------------------------------------------
   type RNG is record
      S : Unsigned_64;
   end record;

   function Next (R : in out RNG) return Unsigned_64 is
      Z : Unsigned_64;
   begin
      R.S := R.S + 16#9E37_79B9_7F4A_7C15#;
      Z := R.S;
      Z := (Z xor Shift_Right (Z, 30)) * 16#BF58_476D_1CE4_E5B9#;
      Z := (Z xor Shift_Right (Z, 27)) * 16#94D0_49BB_1331_11EB#;
      return Z xor Shift_Right (Z, 31);
   end Next;

   function Below (R : in out RNG; N : Positive) return Natural is
     (Natural (Next (R) mod Unsigned_64 (N)));

   function Unit (R : in out RNG) return Float is
     (Float (Next (R) and 16#FF_FFFF#) / 16_777_216.0);        --  [0, 1)

   function Sign (R : in out RNG) return Float is (if Below (R, 2) = 0 then 1.0 else -1.0);

   --  A binary32 argument: ordinary numbers up to Typical, except for Tail percent of the draws, which are
   --  boundary values, zeros, denormals, huge finite numbers, NaNs, infinities or moderately out of range.
   function Gen_F (R : in out RNG; Typical, Limit : Float; Tail : Natural := 15) return Float is
      K : constant Natural := Below (R, 100);
   begin
      if K >= Tail then
         return (case Below (R, 8) is
                    when 0 => Sign (R) * Unit (R) * Unit (R) * Unit (R) * Typical,
                    when others => Sign (R) * Unit (R) * Typical);
      end if;
      case Below (R, 14) is
         when 0 | 1 =>
            return Sign (R) * Limit;
         when 2 =>
            return Sign (R) * To_F (To_U32 (Limit) + 1);                    --  just above the limit
         when 3 =>
            return Sign (R) * To_F (To_U32 (Limit) - 1);                    --  just below the limit
         when 4 =>
            return (if Below (R, 2) = 0 then 0.0 else To_F (16#8000_0000#));  --  +0 / -0
         when 5 =>
            return Sign (R) * To_F (Unsigned_32 (Below (R, 2 ** 23) + 1));   --  denormal
         when 6 | 7 =>                                                      --  any finite binary32
            declare
               U : Unsigned_32 := Unsigned_32 (Next (R) and 16#FFFF_FFFF#);
            begin
               if (U and 16#7F80_0000#) = 16#7F80_0000# then
                  U := U and 16#BFFF_FFFF#;                                 --  force a finite exponent
               end if;
               return To_F (U);
            end;
         when 8 | 9 =>                                                      --  NaN, any payload / sign
            return To_F (16#7F80_0001# + (Unsigned_32 (Next (R) and 16#3F_FFFF#))
                         + (if Below (R, 2) = 0 then 16#8000_0000# else 0));
         when 10 | 11 =>
            return (if Below (R, 2) = 0 then To_F (16#7F80_0000#) else To_F (16#FF80_0000#));
         when others =>                                                     --  moderately out of range
            return Sign (R) * Limit * (1.0 + 3.0 * Unit (R));
      end case;
   end Gen_F;

   --  A JS double for the projection (world point).
   function Gen_D (R : in out RNG; Typical, Limit : Long_Float; Tail : Natural := 30) return Long_Float is
      Sgn : constant Long_Float := Long_Float (Sign (R));
      U   : constant Long_Float := Long_Float (Next (R) and 16#1F_FFFF_FFFF_FFFF#) / 9_007_199_254_740_992.0;
   begin
      if Below (R, 100) >= Tail then
         return Sgn * U * Typical;
      end if;
      case Below (R, 12) is
         when 0 | 1 =>
            return Sgn * Limit;
         when 2 =>
            return Sgn * To_LF (To_U64 (Limit) + (if Below (R, 2) = 0 then 1 else Unsigned_64'Last));
         when 3 =>
            return (if Below (R, 2) = 0 then 0.0 else To_LF (16#8000_0000_0000_0000#));
         when 4 | 5 =>                                     --  NaN
            return To_LF (16#7FF0_0000_0000_0001# + (Next (R) and 16#7_FFFF_FFFF_FFFF#)
                          + (if Below (R, 2) = 0 then 16#8000_0000_0000_0000# else 0));
         when 6 | 7 =>
            return (if Below (R, 2) = 0 then To_LF (16#7FF0_0000_0000_0000#) else To_LF (16#FFF0_0000_0000_0000#));
         when 8 =>                                         --  any finite double
            declare
               B : Unsigned_64 := Next (R);
            begin
               if (B and 16#7FF0_0000_0000_0000#) = 16#7FF0_0000_0000_0000# then
                  B := B and 16#BFFF_FFFF_FFFF_FFFF#;
               end if;
               return To_LF (B);
            end;
         when others =>
            return Sgn * Limit * (1.0 + 3.0 * U);
      end case;
   end Gen_D;

   ---------------------------------------------------------------------------------------------
   --  Independent expectations (C's isfinite + comparisons; NOT the unit's own Classify)
   ---------------------------------------------------------------------------------------------
   function Cls (X : Float; Limit : Float) return Status is
   begin
      if O_Isfinite32 (To_U32 (X)) = 0 then
         return Not_Finite;
      elsif abs X > Limit then
         return Out_Of_Range;
      else
         return Ok;
      end if;
   end Cls;

   function Cls (X : Long_Float; Limit : Long_Float) return Status is
   begin
      if O_Isfinite64 (To_U64 (X)) = 0 then
         return Not_Finite;
      elsif abs X > Limit then
         return Out_Of_Range;
      else
         return Ok;
      end if;
   end Cls;

   function Worst (A, B : Status) return Status is (if A >= B then A else B);

   function Bit (B : Boolean) return Integer_32 is (if B then 1 else 0);

   --  The old engine keeps the raw int of set_key_state; the unit keeps a Boolean (non-zero = pressed).
   procedure Get_C (S : out OState) is
   begin
      O_Get (S);
      for I in S.Keys'Range loop
         S.Keys (I) := (if S.Keys (I) /= 0 then 1 else 0);
      end loop;
   end Get_C;

   function Of_Camera (C : Camera) return OState is
     ((Cam_X => To_U32 (C.X), Cam_Y => To_U32 (C.Y), Zoom => To_U32 (C.Zoom),
       Shift_X => To_U32 (C.Shift_X), Shift_Y => To_U32 (C.Shift_Y),
       Width => Integer_32 (C.Width), Height => Integer_32 (C.Height),
       Min_X => To_U32 (C.Min_X), Max_X => To_U32 (C.Max_X),
       Min_Y => To_U32 (C.Min_Y), Max_Y => To_U32 (C.Max_Y),
       Keys => (Bit (C.Keys (Key_W)), Bit (C.Keys (Key_A)), Bit (C.Keys (Key_S)), Bit (C.Keys (Key_D)))));

   --  Does the OLD engine's state (after some operation) contain a NaN or infinity?
   function Poisoned (S : OState) return Boolean is
     (O_Isfinite32 (S.Cam_X) = 0 or else O_Isfinite32 (S.Cam_Y) = 0 or else O_Isfinite32 (S.Zoom) = 0
      or else O_Isfinite32 (S.Shift_X) = 0 or else O_Isfinite32 (S.Shift_Y) = 0
      or else O_Isfinite32 (S.Min_X) = 0 or else O_Isfinite32 (S.Max_X) = 0
      or else O_Isfinite32 (S.Min_Y) = 0 or else O_Isfinite32 (S.Max_Y) = 0);

   function Out_Of_Domain (S : OState) return Boolean is
     (not (abs To_F (S.Cam_X) <= 1.0E6 and then abs To_F (S.Cam_Y) <= 1.0E6));

   ---------------------------------------------------------------------------------------------
   --  Sequence test
   ---------------------------------------------------------------------------------------------
   type Op_Kind is (Op_Screen, Op_Bounds, Op_Zoom, Op_Pan, Op_Shift, Op_Key, Op_Advance);
   Seen : array (Op_Kind, Status) of Natural := (others => (others => 0));

   --  What the OLD engine did with the calls the unit rejects:
   type Probe_Kind is (Corrupted, Unchanged_Or_Finite);
   Old_Reaction : array (Op_Kind, Probe_Kind) of Natural := (others => (others => 0));
   Old_Screen_Nan_After_Pan : Natural := 0;
   Old_Screen_Degenerate    : Natural := 0;
   Old_Finite_Beyond_Domain : Natural := 0;
   Old_Inf_Delta_Zoomed     : Natural := 0;

   A  : Camera := Initial;     --  the unit under test
   R  : RNG := (S => 1);

   procedure Probe_Old (Kind : Op_Kind; Before : OState) is
      After : OState;
   begin
      Get_C (After);
      if Poisoned (After) then
         Old_Reaction (Kind, Corrupted) := Old_Reaction (Kind, Corrupted) + 1;
      else
         Old_Reaction (Kind, Unchanged_Or_Finite) := Old_Reaction (Kind, Unchanged_Or_Finite) + 1;
      end if;
      O_Set (Before);
   end Probe_Old;

   --  Common tail of an op whose arguments are rejected by the classifier.
   procedure Expect_Rejected (Kind : Op_Kind; Want, Got : Status; Before_A : Camera; Name : String) is
   begin
      Seen (Kind, Got) := Seen (Kind, Got) + 1;
      Check (Got = Want, Name & ": status " & Status'Image (Got) & " expected " & Status'Image (Want));
      Check (Of_Camera (A) = Of_Camera (Before_A), Name & ": camera changed by a rejected call");
   end Expect_Rejected;

   procedure Step_Screen is
      W, H : Integer_32;
      Before_A : constant Camera := A;
      Before_C : OState;
      After_C  : OState;
      S : Status;
      function Dim return Integer_32 is
         K : constant Natural := Below (R, 100);
      begin
         case K is
            when 0 .. 74 => return Integer_32 (Below (R, 4096) + 1);
            when 75 .. 79 => return 1;
            when 80 .. 84 => return Integer_32 (Max_Screen);
            when 85 .. 87 => return 0;
            when 88 .. 90 => return -Integer_32 (Below (R, 100000));
            when 91 .. 93 => return Integer_32 (Max_Screen) + 1;
            when 94 .. 95 => return Integer_32 (Below (R, 2 ** 30)) + 65_537;
            when 96 => return Integer_32'Last;
            when others => return Integer_32 (Below (R, 65_536) + 1);
         end case;
      end Dim;
   begin
      W := Dim;
      H := Dim;
      Get_C (Before_C);
      Set_Screen (A, Integer (W), Integer (H), S);
      if W in 1 .. Integer_32 (Max_Screen) and then H in 1 .. Integer_32 (Max_Screen) then
         O_Set_Screen (W, H);
         Get_C (After_C);
         Seen (Op_Screen, S) := Seen (Op_Screen, S) + 1;
         Check (S = Ok, "Set_Screen: valid size rejected");
         Check (Of_Camera (A) = After_C, "Set_Screen: state differs from old C");
      else
         Expect_Rejected (Op_Screen, Bad_Screen, S, Before_A, "Set_Screen");
         --  old engine: stores it; with a zero or negative size the NaN / infinity appears at the next
         --  pan_camera (aspect = w / 0) - probe that.  A huge size is finite for the old engine.
         O_Set_Screen (W, H);
         if W < 1 or else H < 1 then
            Old_Screen_Degenerate := Old_Screen_Degenerate + 1;
            O_Pan (1.0, 1.0);
            declare
               Probe : OState;
            begin
               Get_C (Probe);
               if Poisoned (Probe) then
                  Old_Screen_Nan_After_Pan := Old_Screen_Nan_After_Pan + 1;
               end if;
            end;
         else
            Old_Finite_Beyond_Domain := Old_Finite_Beyond_Domain + 1;
         end if;
         O_Set (Before_C);
      end if;
   end Step_Screen;

   procedure Step_Bounds is
      Typ : constant Float := (if Below (R, 4) = 0 then 100_000.0 else 600.0);
      Lo_X : Float := Gen_F (R, Typ, 1.0E6, 6);
      Hi_X : Float := Gen_F (R, Typ, 1.0E6, 6);
      Lo_Y : Float := Gen_F (R, Typ, 1.0E6, 6);
      Hi_Y : Float := Gen_F (R, Typ, 1.0E6, 6);
      Before_A : constant Camera := A;
      Before_C, After_C : OState;
      Want, S : Status;
   begin
      case Below (R, 8) is           --  shape the interesting finite cases: sorted, equal, tiny span
         when 0 =>
            if Cls (Lo_X, 1.0E6) = Ok and then Cls (Hi_X, 1.0E6) = Ok and then Lo_X > Hi_X then
               declare T : constant Float := Lo_X; begin Lo_X := Hi_X; Hi_X := T; end;
            end if;
         when 1 =>
            Hi_X := Lo_X;
         when 2 =>
            Hi_Y := Lo_Y; Hi_X := Lo_X;
         when 3 =>
            if Cls (Lo_X, 1.0E6) = Ok then
               Hi_X := To_F (To_U32 (Lo_X) + 1);         --  adjacent floats: a (near-)zero span
            end if;
         when 4 =>
            Hi_X := -Lo_X; Hi_Y := -Lo_Y;
         when others => null;
      end case;
      Want := Worst (Worst (Cls (Lo_X, 1.0E6), Cls (Hi_X, 1.0E6)), Worst (Cls (Lo_Y, 1.0E6), Cls (Hi_Y, 1.0E6)));
      Get_C (Before_C);
      Set_Map_Bounds (A, Lo_X, Hi_X, Lo_Y, Hi_Y, S);
      if Want = Ok then
         O_Set_Map_Bounds (Lo_X, Hi_X, Lo_Y, Hi_Y);
         Get_C (After_C);
         Seen (Op_Bounds, S) := Seen (Op_Bounds, S) + 1;
         Check (S = Ok, "Set_Map_Bounds: valid bounds rejected");
         Check (Of_Camera (A) = After_C, "Set_Map_Bounds: state differs from old C");
      else
         Expect_Rejected (Op_Bounds, Want, S, Before_A, "Set_Map_Bounds");
         O_Set_Map_Bounds (Lo_X, Hi_X, Lo_Y, Hi_Y);
         Probe_Old (Op_Bounds, Before_C);
      end if;
   end Step_Bounds;

   procedure Step_Zoom is
      D : constant Float := Gen_F (R, 120.0, 1.0E30, 20);
      Before_A : constant Camera := A;
      Before_C, After_C : OState;
      Want, S : Status;
   begin
      Want := (if O_Isfinite32 (To_U32 (D)) /= 0 then Ok else Not_Finite);
      Get_C (Before_C);
      Apply_Zoom (A, D, S);
      if Want = Ok then
         O_Apply_Zoom (D);
         Get_C (After_C);
         Seen (Op_Zoom, S) := Seen (Op_Zoom, S) + 1;
         Check (S = Ok, "Apply_Zoom: finite delta rejected");
         Check (Of_Camera (A) = After_C, "Apply_Zoom: state differs from old C");
      else
         Expect_Rejected (Op_Zoom, Want, S, Before_A, "Apply_Zoom");
         O_Apply_Zoom (D);
         declare
            Probe : OState;
         begin
            Get_C (Probe);
            if Probe /= Before_C and then not Poisoned (Probe) then
               Old_Inf_Delta_Zoomed := Old_Inf_Delta_Zoomed + 1;     --  old zoomed on +-Inf
            end if;
         end;
         Probe_Old (Op_Zoom, Before_C);
      end if;
   end Step_Zoom;

   procedure Step_Pan is
      Dx : constant Float := Gen_F (R, 400.0, 1.0E6, 12);
      Dy : constant Float := Gen_F (R, 400.0, 1.0E6, 12);
      Before_A : constant Camera := A;
      Before_C, After_C : OState;
      Want, S : Status;
   begin
      Want := Worst (Cls (Dx, 1.0E6), Cls (Dy, 1.0E6));
      Get_C (Before_C);
      Pan (A, Dx, Dy, S);
      if Want = Ok then
         O_Pan (Dx, Dy);
         Get_C (After_C);
         if Out_Of_Domain (After_C) then
            Expect_Rejected (Op_Pan, Out_Of_Range, S, Before_A, "Pan (leaves the world)");
            if Poisoned (After_C) then
               Old_Reaction (Op_Pan, Corrupted) := Old_Reaction (Op_Pan, Corrupted) + 1;
            else
               Old_Finite_Beyond_Domain := Old_Finite_Beyond_Domain + 1;
            end if;
            O_Set (Before_C);
         else
            Seen (Op_Pan, S) := Seen (Op_Pan, S) + 1;
            Check (S = Ok, "Pan: valid drag rejected");
            Check (Of_Camera (A) = After_C, "Pan: state differs from old C");
         end if;
      else
         Expect_Rejected (Op_Pan, Want, S, Before_A, "Pan");
         O_Pan (Dx, Dy);
         Probe_Old (Op_Pan, Before_C);
      end if;
   end Step_Pan;

   procedure Step_Shift is
      X : constant Float := Gen_F (R, 500.0, 2.0E6, 12);
      Y : constant Float := Gen_F (R, 500.0, 2.0E6, 12);
      Before_A : constant Camera := A;
      Before_C, After_C : OState;
      Want, S : Status;
   begin
      Want := Worst (Cls (X, 2.0E6), Cls (Y, 2.0E6));
      Get_C (Before_C);
      Set_View_Shift (A, X, Y, S);
      if Want = Ok then
         O_Set_View_Shift (X, Y);
         Get_C (After_C);
         Seen (Op_Shift, S) := Seen (Op_Shift, S) + 1;
         Check (S = Ok, "Set_View_Shift: valid shift rejected");
         Check (Of_Camera (A) = After_C, "Set_View_Shift: state differs from old C");
         Check (A.X = Before_A.X and then A.Y = Before_A.Y and then A.Zoom = Before_A.Zoom,
                "Set_View_Shift changed the camera");
      else
         Expect_Rejected (Op_Shift, Want, S, Before_A, "Set_View_Shift");
         O_Set_View_Shift (X, Y);
         Probe_Old (Op_Shift, Before_C);
      end if;
   end Step_Shift;

   procedure Step_Key is
      Idx : constant Integer_32 :=
        (if Below (R, 100) < 80 then Integer_32 (Below (R, 4))
         else (case Below (R, 4) is
                 when 0 => -1, when 1 => 4, when 2 => Integer_32'Last, when others => Integer_32'First));
      Pressed : constant Integer_32 :=
        (case Below (R, 5) is
           when 0 => 0, when 1 => 1, when 2 => 2, when 3 => -1, when others => Integer_32 (Below (R, 1000)));
      Before_A : constant Camera := A;
      After_C : OState;
      S : Status;
   begin
      Set_Key (A, Integer (Idx), Integer (Pressed), S);
      if Idx in 0 .. 3 then
         O_Set_Key (Idx, Pressed);
         Get_C (After_C);
         Seen (Op_Key, S) := Seen (Op_Key, S) + 1;
         Check (S = Ok, "Set_Key: valid index rejected");
         Check (Of_Camera (A) = After_C, "Set_Key: state differs from old C");
      else
         Expect_Rejected (Op_Key, Bad_Key, S, Before_A, "Set_Key");
      end if;
   end Step_Key;

   procedure Step_Advance is
      Dt : constant Float :=
        (if Below (R, 3) = 0 then Gen_F (R, 0.05, 1.0E6) else Unit (R) * 0.05);
      Before_A : constant Camera := A;
      Before_C, After_C : OState;
      Want, S : Status;
   begin
      Want := Cls (Dt, 1.0E6);
      Get_C (Before_C);
      Advance (A, Dt, S);
      if Want = Ok then
         O_Render_Frame (Dt);
         Get_C (After_C);
         if Out_Of_Domain (After_C) then
            Expect_Rejected (Op_Advance, Out_Of_Range, S, Before_A, "Advance (leaves the world)");
            if Poisoned (After_C) then
               Old_Reaction (Op_Advance, Corrupted) := Old_Reaction (Op_Advance, Corrupted) + 1;
            else
               Old_Finite_Beyond_Domain := Old_Finite_Beyond_Domain + 1;
            end if;
            O_Set (Before_C);
         else
            Seen (Op_Advance, S) := Seen (Op_Advance, S) + 1;
            Check (S = Ok, "Advance: valid step rejected");
            Check (Of_Camera (A) = After_C, "Advance: state differs from old C");
         end if;
      else
         Expect_Rejected (Op_Advance, Want, S, Before_A, "Advance");
         O_Render_Frame (Dt);
         Probe_Old (Op_Advance, Before_C);
      end if;
   end Step_Advance;

   procedure Run_Sequences (Count : Natural; Ops_Per_Seq : Positive) is
      Mirror : OState;
   begin
      for Seq in 1 .. Count loop
         A := Initial;
         O_Reset;
         Get_C (Mirror);
         Check (Of_Camera (A) = Mirror, "Initial state differs from the old globals");
         --  Half of the sequences start on a realistic screen so that the clamps / fits are reached.
         if Seq mod 2 = 0 then
            declare
               S : Status;
            begin
               Set_Screen (A, 1 + Below (R, 3000), 1 + Below (R, 2000), S);
               O_Set_Screen (Integer_32 (A.Width), Integer_32 (A.Height));
            end;
         end if;
         declare
            Zoom_Bias : constant Float := (if Below (R, 2) = 0 then 1.0 else -1.0);
            pragma Unreferenced (Zoom_Bias);
         begin
            for Op in 1 .. Ops_Per_Seq loop
               case Below (R, 100) is
                  when 0 .. 7   => Step_Screen;
                  when 8 .. 19  => Step_Bounds;
                  when 20 .. 44 => Step_Zoom;
                  when 45 .. 69 => Step_Pan;
                  when 70 .. 76 => Step_Shift;
                  when 77 .. 86 => Step_Key;
                  when others   => Step_Advance;
               end case;
            end loop;
         end;
      end loop;
   end Run_Sequences;

   ---------------------------------------------------------------------------------------------
   --  Is_Finite against C's isfinite
   ---------------------------------------------------------------------------------------------
   procedure Test_Is_Finite is
      N32 : Natural := 0;
      N64 : Natural := 0;
      Bad : Natural := 0;
      Mantissas : constant array (1 .. 8) of Unsigned_64 :=
        (0, 1, 2, 16#7F_FFFF#, 16#40_0000#, 16#4_0000_0000_0000#, 16#F_FFFF_FFFF_FFFF#, 16#8_0000_0000_0000#);
   begin
      --  every pattern whose binary32 exponent field is all ones (NaNs and infinities), both signs
      for Sgn in Unsigned_32 range 0 .. 1 loop
         for M in Unsigned_32 range 0 .. 16#7F_FFFF# loop
            if Is_Finite (To_F (Sgn * 16#8000_0000# + 16#7F80_0000# + M)) then
               Bad := Bad + 1;
            end if;
            N32 := N32 + 1;
         end loop;
      end loop;
      --  a stride through the whole binary32 space (covers every exponent, ~16.7M patterns)
      declare
         U : Unsigned_32 := 0;
      begin
         loop
            if Is_Finite (To_F (U)) /= (O_Isfinite32 (U) /= 0) then
               Bad := Bad + 1;
            end if;
            N32 := N32 + 1;
            exit when U > Unsigned_32'Last - 257;
            U := U + 257;
         end loop;
      end;
      --  binary64: every exponent, both signs, structured and random mantissas
      for Sgn in Unsigned_64 range 0 .. 1 loop
         for E in Unsigned_64 range 0 .. 2047 loop
            for K in 1 .. 8 + 64 loop
               declare
                  M : constant Unsigned_64 :=
                    (if K <= 8 then Mantissas (K) else Next (R) and 16#F_FFFF_FFFF_FFFF#);
                  U : constant Unsigned_64 := Sgn * 16#8000_0000_0000_0000# + E * 16#10_0000_0000_0000# + M;
               begin
                  if Is_Finite (To_LF (U)) /= (O_Isfinite64 (U) /= 0) then
                     Bad := Bad + 1;
                  end if;
                  N64 := N64 + 1;
               end;
            end loop;
         end loop;
      end loop;
      Check (Bad = 0, "Is_Finite disagrees with isfinite on" & Natural'Image (Bad) & " patterns");
      Put_Line ("Is_Finite:" & Natural'Image (N32) & " binary32 and" & Natural'Image (N64)
                & " binary64 patterns compared with C isfinite");
   end Test_Is_Finite;

   --  Optional: every one of the 2**32 binary32 patterns (a few seconds).
   procedure Test_Is_Finite_Exhaustive is
      Bad : Natural := 0;
      U   : Unsigned_32 := 0;
   begin
      loop
         if Is_Finite (To_F (U)) /= (O_Isfinite32 (U) /= 0) then
            Bad := Bad + 1;
         end if;
         exit when U = Unsigned_32'Last;
         U := U + 1;
      end loop;
      Check (Bad = 0, "exhaustive Is_Finite disagrees on" & Natural'Image (Bad) & " patterns");
      Put_Line ("Is_Finite: all 4294967296 binary32 patterns compared with C isfinite, mismatches:" & Natural'Image (Bad));
   end Test_Is_Finite_Exhaustive;

   ---------------------------------------------------------------------------------------------
   --  World -> screen: against the OLD main.js (cases file from oracle_js.js)
   ---------------------------------------------------------------------------------------------
   Line : String (1 .. 1024);
   Last : Natural;
   Pos  : Positive;

   function Hex_Value (C : Character) return Unsigned_64 is
     (case C is
         when '0' .. '9' => Character'Pos (C) - Character'Pos ('0'),
         when 'a' .. 'f' => Character'Pos (C) - Character'Pos ('a') + 10,
         when others     => 0);

   procedure Skip_Blanks is
   begin
      while Pos <= Last and then Line (Pos) = ' ' loop
         Pos := Pos + 1;
      end loop;
   end Skip_Blanks;

   function Get_Int return Integer is
      V : Integer := 0;
   begin
      Skip_Blanks;
      while Pos <= Last and then Line (Pos) in '0' .. '9' loop
         V := V * 10 + (Character'Pos (Line (Pos)) - Character'Pos ('0'));
         Pos := Pos + 1;
      end loop;
      return V;
   end Get_Int;

   function Get_Hex return Unsigned_64 is
      V : Unsigned_64 := 0;
   begin
      Skip_Blanks;
      while Pos <= Last and then Line (Pos) /= ' ' loop
         V := V * 16 + Hex_Value (Line (Pos));
         Pos := Pos + 1;
      end loop;
      return V;
   end Get_Hex;

   function Inverse_X (C : Camera; Px : Long_Float) return Long_Float is
      Xb : constant Long_Float := Extent_X (C.Width, C.Height);
      N  : constant Long_Float := Px / Long_Float (C.Width) * 2.0 - 1.0;
   begin
      return (N * Xb / Long_Float (C.Zoom) + Long_Float (C.X)) - Long_Float (C.Shift_X);
   end Inverse_X;

   function Inverse_Y (C : Camera; Py : Long_Float) return Long_Float is
      Yb : constant Long_Float := Extent_Y (C.Width, C.Height);
      N  : constant Long_Float := 1.0 - Py / Long_Float (C.Height) * 2.0;
   begin
      return (N * Yb / Long_Float (C.Zoom) + Long_Float (C.Y)) - Long_Float (C.Shift_Y);
   end Inverse_Y;

   Worst_Round_Trip : Long_Float := 0.0;

   procedure Test_Projection_Vs_JS (Path : String) is
      F    : File_Type;
      Cams : Natural := 0;
      C    : Camera := Initial;
   begin
      Open (F, In_File, Path);
      while not End_Of_File (F) loop
         Get_Line (F, Line, Last);
         Pos := 1;
         declare
            W : constant Integer := Get_Int;
            H : constant Integer := Get_Int;
            Cx : constant Float := To_F (Unsigned_32 (Get_Hex));
            Cy : constant Float := To_F (Unsigned_32 (Get_Hex));
            Z  : constant Float := To_F (Unsigned_32 (Get_Hex));
            Sx : constant Float := To_F (Unsigned_32 (Get_Hex));
            Sy : constant Float := To_F (Unsigned_32 (Get_Hex));
            Wx : constant Long_Float := To_LF (Get_Hex);
            Wy : constant Long_Float := To_LF (Get_Hex);
            Ex : constant Unsigned_64 := Get_Hex;
            Ey : constant Unsigned_64 := Get_Hex;
            P  : Screen_Point;
         begin
            C := (X => Cx, Y => Cy, Zoom => Z, Shift_X => Sx, Shift_Y => Sy, Width => W, Height => H,
                  Min_X => 0.0, Max_X => 0.0, Min_Y => 0.0, Max_Y => 0.0, Keys => (others => False));
            P := World_To_Screen (C, Wx, Wy);
            Cams := Cams + 1;
            Check (P.Outcome = Ok, "World_To_Screen rejected an in-domain point");
            Check (To_U64 (P.X) = Ex, "px differs from main.js worldToScreen: case" & Natural'Image (Cams)
                   & " got " & Hex64 (To_U64 (P.X)) & " want " & Hex64 (Ex));
            Check (To_U64 (P.Y) = Ey, "py differs from main.js worldToScreen: case" & Natural'Image (Cams)
                   & " got " & Hex64 (To_U64 (P.Y)) & " want " & Hex64 (Ey));
            --  round trip: screen -> world with the inverse formula lands back on the world point
            declare
               Bx : constant Long_Float := abs (Inverse_X (C, P.X) - Wx);
               By : constant Long_Float := abs (Inverse_Y (C, P.Y) - Wy);
            begin
               Check (Bx <= 1.0E-6 and then By <= 1.0E-6, "round trip beyond 1e-6");
               if Bx > Worst_Round_Trip then Worst_Round_Trip := Bx; end if;
               if By > Worst_Round_Trip then Worst_Round_Trip := By; end if;
            end;
         end;
      end loop;
      Close (F);
      Put_Line ("World_To_Screen vs main.js worldToScreen:" & Natural'Image (Cams) & " cases bit-exact");
   end Test_Projection_Vs_JS;

   --  Random cameras and points: rejection classes, crosshair, round trip on the unit's own states.
   procedure Test_Projection_Random (Count : Natural) is
      C : Camera;
      S : Status;
      Rejected : Natural := 0;
   begin
      for I in 1 .. Count loop
         C := Initial;
         Set_Screen (C, 1 + Below (R, 5000), 1 + Below (R, 5000), S);
         Set_Map_Bounds (C, Gen_F (R, 500.0, 1.0E6, 3), Gen_F (R, 500.0, 1.0E6, 3),
                         Gen_F (R, 500.0, 1.0E6, 3), Gen_F (R, 500.0, 1.0E6, 3), S);
         Set_View_Shift (C, Gen_F (R, 500.0, 2.0E6, 3), Gen_F (R, 500.0, 2.0E6, 3), S);
         declare
            Wx : constant Long_Float := Gen_D (R, 800.0, 1.0E6);
            Wy : constant Long_Float := Gen_D (R, 800.0, 1.0E6);
            Want : constant Status := Worst (Cls (Wx, 1.0E6), Cls (Wy, 1.0E6));
            P : constant Screen_Point := World_To_Screen (C, Wx, Wy);
         begin
            Check (P.Outcome = Want, "World_To_Screen status " & Status'Image (P.Outcome)
                   & " expected " & Status'Image (Want));
            if Want /= Ok then
               Rejected := Rejected + 1;
               Check (P.X = 0.0 and then P.Y = 0.0, "rejected projection returned a point");
            end if;
         end;
         --  crosshair: with no shift the camera centre maps to the exact middle of the canvas
         declare
            C0 : Camera := C;
            P  : Screen_Point;
         begin
            C0.Shift_X := 0.0;
            C0.Shift_Y := 0.0;
            P := World_To_Screen (C0, Long_Float (C0.X), Long_Float (C0.Y));
            Check (P.Outcome = Ok and then P.X = Long_Float (C0.Width) / 2.0
                   and then P.Y = Long_Float (C0.Height) / 2.0, "crosshair is not at the screen centre");
         end;
      end loop;
      Put_Line ("World_To_Screen random:" & Natural'Image (Count) & " cases," & Natural'Image (Rejected)
                & " rejected");
   end Test_Projection_Random;

   Mode : constant String := Ada.Command_Line.Argument (1);
   Seqs : constant Natural := Natural'Value (Ada.Command_Line.Argument (2));

begin
   Contracts_Mode := Mode = "contracts";
   R.S := 20260401;

   Run_Sequences (Seqs, 32);

   Put_Line ("operation sequences:" & Natural'Image (Seqs) & " x 32 operations");
   for K in Op_Kind loop
      Put (Op_Kind'Image (K) & ":");
      for S in Status loop
         if Seen (K, S) > 0 then
            Put (" " & Status'Image (S) & "=" & Natural'Image (Seen (K, S)));
         end if;
      end loop;
      New_Line;
   end loop;
   Put_Line ("old C on the calls the unit rejects (state NaN/Inf afterwards vs finite):");
   for K in Op_Kind loop
      if Old_Reaction (K, Corrupted) + Old_Reaction (K, Unchanged_Or_Finite) > 0 then
         Put_Line ("  " & Op_Kind'Image (K) & ": corrupted=" & Natural'Image (Old_Reaction (K, Corrupted))
                   & " finite=" & Natural'Image (Old_Reaction (K, Unchanged_Or_Finite)));
      end if;
   end loop;
   Put_Line ("  screen sizes < 1:" & Natural'Image (Old_Screen_Degenerate)
             & ", of which the next pan_camera gave a NaN/Inf camera:" & Natural'Image (Old_Screen_Nan_After_Pan));
   Put_Line ("  finite old results beyond the documented domain (size > 65536, camera left +-1e6):"
             & Natural'Image (Old_Finite_Beyond_Domain));
   Put_Line ("  +-Inf wheel deltas the old engine zoomed on:" & Natural'Image (Old_Inf_Delta_Zoomed));

   Test_Is_Finite;
   if Ada.Command_Line.Argument_Count >= 4 and then Ada.Command_Line.Argument (4) = "exhaustive" then
      Test_Is_Finite_Exhaustive;
   end if;
   Test_Projection_Random (if Contracts_Mode then 20_000 else 400_000);
   if Ada.Command_Line.Argument_Count >= 3 then
      Test_Projection_Vs_JS (Ada.Command_Line.Argument (3));
      Put_Line ("worst round-trip error seen:" & Long_Float'Image (Worst_Round_Trip) & " (proven bound 1.0E-6)");
   end if;

   Put_Line ("checks:" & Natural'Image (Checks) & "  failures:" & Natural'Image (Failures));
   if Failures /= 0 then
      Put_Line ("FAILED");
      Ada.Command_Line.Set_Exit_Status (Ada.Command_Line.Failure);
   else
      Put_Line ("OK (" & Mode & ")");
   end if;
end Test_Camera_Projection;

--  Native differential + exhaustive test program for the tick_index unit.
--
--    test_tick_index <oracle-file> <mode>        mode = fast | contracts
--
--  fast       : built with assertions OFF (the Sorted precondition is O(n) per call); runs the whole oracle
--               (real tick arrays, 100k+ queries per file class) and a 4M-tick generated array.
--  contracts  : built with assertions ON (-gnata): every pre/postcondition of the SPARK sources is executed
--               as a run-time check on the exhaustive small-array tests, on all lerp / angle / fmod oracle
--               cases, and on the oracle tick sets small enough for the O(n) Sorted check.
--
--  Everything compared against the oracle is compared BIT-EXACTLY (hex patterns of the IEEE values).
with Ada.Text_IO;           use Ada.Text_IO;
with Ada.Command_Line;
with Ada.Unchecked_Conversion;
with Ada.Unchecked_Deallocation;
with Interfaces;            use Interfaces;
with Tick_Index;            use Tick_Index;
with Tick_Index.Blend;      use Tick_Index.Blend;

procedure Test_Tick_Index is

   function To_LF  is new Ada.Unchecked_Conversion (Unsigned_64, Long_Float);
   function To_U64 is new Ada.Unchecked_Conversion (Long_Float, Unsigned_64);
   function To_F   is new Ada.Unchecked_Conversion (Unsigned_32, Float);
   function To_U32 is new Ada.Unchecked_Conversion (Float, Unsigned_32);

   type Time_Array_Access is access Time_Array;
   procedure Free is new Ada.Unchecked_Deallocation (Time_Array, Time_Array_Access);

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

   --  ----- line / token parsing ------------------------------------------------------------------
   Line : String (1 .. 4096);
   Last : Natural;
   Pos  : Positive;

   procedure Read_Line (F : File_Type) is
   begin
      Get_Line (F, Line, Last);
      Pos := 1;
   end Read_Line;

   procedure Skip_Blanks is
   begin
      while Pos <= Last and then Line (Pos) = ' ' loop
         Pos := Pos + 1;
      end loop;
   end Skip_Blanks;

   function Next_Hex return Unsigned_64 is
      R : Unsigned_64 := 0;
      C : Character;
   begin
      Skip_Blanks;
      while Pos <= Last and then Line (Pos) /= ' ' loop
         C := Line (Pos);
         R := R * 16 + (case C is
                          when '0' .. '9' => Character'Pos (C) - Character'Pos ('0'),
                          when 'a' .. 'f' => Character'Pos (C) - Character'Pos ('a') + 10,
                          when others     => raise Constraint_Error with "bad hex");
         Pos := Pos + 1;
      end loop;
      return R;
   end Next_Hex;

   function Next_Int return Long_Long_Integer is
      R   : Long_Long_Integer := 0;
      Neg : Boolean := False;
   begin
      Skip_Blanks;
      if Pos <= Last and then Line (Pos) = '-' then
         Neg := True;
         Pos := Pos + 1;
      end if;
      while Pos <= Last and then Line (Pos) /= ' ' loop
         R := R * 10 + Long_Long_Integer (Character'Pos (Line (Pos)) - Character'Pos ('0'));
         Pos := Pos + 1;
      end loop;
      return (if Neg then -R else R);
   end Next_Int;

   function Next_Word return String is
   begin
      Skip_Blanks;
      declare
         B : constant Positive := Pos;
      begin
         while Pos <= Last and then Line (Pos) /= ' ' loop
            Pos := Pos + 1;
         end loop;
         return Line (B .. Pos - 1);
      end;
   end Next_Word;

   function LF (U : Unsigned_64) return Long_Float is (To_LF (U));
   function FL (U : Unsigned_64) return Float is (To_F (Unsigned_32 (U)));

   --  ----- literal transliterations of the OLD C code (independent of the SPARK sources) -------------
   function Old_Find (T : Time_Array; X : Long_Float) return Integer is
      N  : constant Integer := T'Length;
      Lo : Integer;
      Hi : Integer;
      Mid : Integer;
   begin
      if N = 0 then
         return 0;
      end if;
      if X <= T (0) then
         return 0;
      end if;
      if X >= T (Valid_Tick (N - 1)) then
         return N - 1;
      end if;
      Lo := 0;
      Hi := N - 1;
      while Lo < Hi loop
         Mid := (Lo + Hi + 1) / 2;
         if T (Valid_Tick (Mid)) <= X then
            Lo := Mid;
         else
            Hi := Mid - 1;
         end if;
      end loop;
      return Lo;
   end Old_Find;

   function Old_Alpha (TA, TB, X : Long_Float) return Float is
      Alpha : Float := 0.0;
   begin
      if TB > TA then
         Alpha := Float ((X - TA) / (TB - TA));
         if Alpha < 0.0 then
            Alpha := 0.0;
         end if;
         if Alpha > 1.0 then
            Alpha := 1.0;
         end if;
      end if;
      return Alpha;
   end Old_Alpha;

   --  ----- exhaustive small-array tests -----------------------------------------------------------
   procedure Exhaustive is
      Max_N  : constant := 6;
      Values : constant := 4;                    --  tick times are 0 .. 3
      Queries : constant array (1 .. 17) of Long_Float :=
        [-1.0, -0.25, 0.0, 0.25, 0.5, 1.0, 1.5, 2.0, 2.75, 3.0, 3.5, 4.0, 1.0e19, -1.0e19,
         0.999999, 1.000001, 2.5];
      Count : Natural := 0;
   begin
      for N in 1 .. Max_N loop
         declare
            Total : Natural := 1;
         begin
            for I in 1 .. N loop
               Total := Total * Values;
            end loop;
            for Code in 0 .. Total - 1 loop
               declare
                  C : Natural := Code;
                  T : Time_Array (0 .. Valid_Tick (N - 1));
                  Ok : Boolean := True;
               begin
                  for I in 0 .. N - 1 loop
                     T (Valid_Tick (I)) := Long_Float (C mod Values);
                     C := C / Values;
                  end loop;
                  for I in 0 .. N - 2 loop
                     if T (Valid_Tick (I)) > T (Valid_Tick (I + 1)) then
                        Ok := False;
                     end if;
                  end loop;
                  if Ok then
                     Count := Count + 1;
                     for X of Queries loop
                        declare
                           Q : constant Tick_Time := X;
                           L : constant Tick_Pos := Last_At_Or_Before (T, Q);
                           F : constant Valid_Tick := Find_Tick_Index_For_Time (T, Q);
                           P : constant Frame_Pos := Locate (T, Q);
                           Brute : Tick_Pos := -1;
                           OF_I  : constant Integer := Old_Find (T, Q);
                           OB    : constant Integer :=
                             (if OF_I + 1 < N then OF_I + 1 else OF_I);
                        begin
                           for J in T'Range loop
                              if T (J) <= Q then
                                 Brute := J;
                              end if;
                           end loop;
                           Check (L = Brute, "Last_At_Or_Before brute force");
                           Check (Integer (F) = OF_I, "Find_Tick_Index_For_Time vs old C find");
                           Check (Integer (P.Index_A) = OF_I and then Integer (P.Index_B) = OB,
                                  "Locate indexes vs old C");
                           Check (To_U32 (P.Alpha) = To_U32 (Old_Alpha (T (Valid_Tick (OF_I)),
                                                                        T (Valid_Tick (OB)), Q)),
                                  "Locate alpha vs old C alpha");
                        end;
                     end loop;
                  end if;
               end;
            end loop;
         end;
      end loop;
      Put_Line ("exhaustive: " & Natural'Image (Count) & " sorted arrays (length 1.."
                & Integer'Image (Max_N) & ", values 0..3) x 17 queries");
   end Exhaustive;

   --  ----- Alpha_For corner cases -------------------------------------------------------------------
   pragma Warnings (Off, "gradual underflow");
   procedure Alpha_Corners is
   begin
      Check (Alpha_For (5.0, 5.0, 5.0) = 0.0 and then Alpha_For (5.0, 5.0, 9.0) = 0.0
             and then Alpha_For (5.0, 5.0, 1.0) = 0.0, "equal times: no division, alpha 0");
      Check (Alpha_For (7.0, 5.0, 6.0) = 0.0, "timeB < timeA: alpha 0");
      Check (Alpha_For (5.0, 9.0, 5.0) = 0.0 and then Alpha_For (5.0, 9.0, -1.0E19) = 0.0,
             "at/before timeA: exactly 0");
      Check (Alpha_For (5.0, 9.0, 9.0) = 1.0 and then Alpha_For (5.0, 9.0, 1.0E19) = 1.0,
             "at/after timeB: exactly 1");
      Check (Alpha_For (5.0, 9.0, 6.0) = 0.25 and then Alpha_For (5.0, 9.0, 7.0) = 0.5, "interior");
      Check (Alpha_For (-1.0E19, 1.0E19, 0.0) = 0.5, "domain-limit times");
      Check (Alpha_For (0.0, 5.0E-324, 5.0E-324) = 1.0 and then Alpha_For (0.0, 5.0E-324, 0.0) = 0.0,
             "denormal times");
      Check (Alpha_For (1.0E10, 1.0E10 + 1.0, 1.0E10 + 0.5) = 0.5, "large offset");
   end Alpha_Corners;
   pragma Warnings (On, "gradual underflow");

   --  ----- large generated array (64-bit index paths, no oracle needed) ------------------------------
   procedure Big_Array is
      N : constant := 2 ** 22;
      T : Time_Array_Access := new Time_Array (0 .. N - 1);
      Seed : Unsigned_64 := 16#9E3779B97F4A7C15#;
      Bad : Natural := 0;
      function Next return Unsigned_64 is
      begin
         Seed := Seed xor Shift_Left (Seed, 13);
         Seed := Seed xor Shift_Right (Seed, 7);
         Seed := Seed xor Shift_Left (Seed, 17);
         return Seed;
      end Next;
   begin
      for I in T'Range loop
         T (I) := 2.0 * Long_Float (I);              --  T (i) = 2 i, strictly increasing
      end loop;
      for Q in 1 .. 200_000 loop
         declare
            K : constant Long_Long_Integer := Long_Long_Integer (Next mod (2 * N + 8)) - 4;
            X : constant Tick_Time := Long_Float (K) * 0.5;          --  x = k / 2
            Want : constant Long_Long_Integer :=
              (if K < 0 then -1 else Long_Long_Integer'Min (K / 4, N - 1));   --  greatest i: 2i <= k/2
            Got : constant Tick_Pos := Last_At_Or_Before (T.all, X);
            Wf : constant Long_Long_Integer :=                   --  find_tick_index_for_time
              (if K <= 0 then 0 else Long_Long_Integer'Min (K / 4, N - 1));
            Gf : constant Valid_Tick := Find_Tick_Index_For_Time (T.all, X);
         begin
            if Long_Long_Integer (Got) /= Want or else Long_Long_Integer (Gf) /= Wf then
               Bad := Bad + 1;
            end if;
         end;
      end loop;
      Check (Bad = 0, "4M-tick generated array: " & Natural'Image (Bad) & " mismatches");
      Put_Line ("big array: 2**22 ticks, 200000 queries, mismatches =" & Natural'Image (Bad));
      Free (T);
   end Big_Array;

   --  ----- oracle file ----------------------------------------------------------------------------
   Sets_Done     : Natural := 0;
   Sets_Skipped  : Natural := 0;
   Frame_Queries : Natural := 0;
   Lerp32_Cases  : Natural := 0;
   Lerp64_Cases  : Natural := 0;
   Angle_Cases   : Natural := 0;
   Fmod_Cases    : Natural := 0;
   Div32_Alpha1  : Natural := 0;
   Div32_Over    : Natural := 0;
   Div64_Alpha1  : Natural := 0;
   Div64_Over    : Natural := 0;
   Angle_Over    : Natural := 0;

   procedure Do_Set (F : File_Type) is
      Cls : constant String := Next_Word;
      N   : constant Natural := Natural (Next_Int);
      M   : constant Natural := Natural (Next_Int);
      T   : Time_Array_Access := new Time_Array (0 .. Valid_Tick (N - 1));
      Skip : constant Boolean := Contracts_Mode and then N > 700;
      Cap  : constant Natural := (if Contracts_Mode then 500 else Natural'Last);   --  O(n) contracts per call
      Bad  : Natural := 0;
      Sorted_Ok : Boolean := True;
   begin
      for I in 0 .. N - 1 loop
         Read_Line (F);
         T (Valid_Tick (I)) := Tick_Time (LF (Next_Hex));
      end loop;
      for I in 1 .. N - 1 loop
         if T (Valid_Tick (I)) < T (Valid_Tick (I - 1)) then
            Sorted_Ok := False;
         end if;
      end loop;
      Check (Sorted_Ok, "oracle set " & Cls & " is sorted");
      for Qn in 1 .. M loop
         Read_Line (F);
         declare
            X   : constant Tick_Time := Tick_Time (LF (Next_Hex));
            Ia  : constant Long_Long_Integer := Next_Int;
            Ib  : constant Long_Long_Integer := Next_Int;
            Al  : constant Unsigned_32 := Unsigned_32 (Next_Hex);
         begin
            if not Skip and then Qn <= Cap then
               declare
                  P : constant Frame_Pos := Locate (T.all, X);
                  L : constant Tick_Pos := Last_At_Or_Before (T.all, X);
               begin
                  Frame_Queries := Frame_Queries + 1;
                  if Long_Long_Integer (P.Index_A) /= Ia or else Long_Long_Integer (P.Index_B) /= Ib
                    or else To_U32 (P.Alpha) /= Al
                  then
                     Bad := Bad + 1;
                     if Bad <= 5 then
                        Put_Line ("  mismatch in set " & Cls & ": query " & Long_Float'Image (X)
                                  & " got " & Tick_Pos'Image (P.Index_A) & "/" & Tick_Pos'Image (P.Index_B)
                                  & " want " & Long_Long_Integer'Image (Ia) & "/"
                                  & Long_Long_Integer'Image (Ib));
                     end if;
                  end if;
                  --  Last_At_Or_Before agrees with the old index wherever the old code does not take its
                  --  first-tick fast path.
                  if X > T (0) and then Long_Long_Integer (L) /= Ia then
                     Bad := Bad + 1;
                  end if;
                  if X < T (0) and then L /= -1 then
                     Bad := Bad + 1;
                  end if;
               end;
            end if;
         end;
      end loop;
      Check (Bad = 0, "oracle set " & Cls & " mismatches:" & Natural'Image (Bad));
      if Skip then
         Sets_Skipped := Sets_Skipped + 1;
      else
         Sets_Done := Sets_Done + 1;
      end if;
      Free (T);
   end Do_Set;

   procedure Do_Lerp32 (F : File_Type; M : Natural) is
   begin
      for I in 1 .. M loop
         Read_Line (F);
         declare
            X  : constant Coord := Coord (FL (Next_Hex));
            Bx : constant Coord := Coord (FL (Next_Hex));
            Al : constant Alpha_Type := Alpha_Type (FL (Next_Hex));
            W  : constant Unsigned_32 := Unsigned_32 (Next_Hex);
            R  : constant Float := Lerp_Raw (X, Bx, Al);
            Lp : constant Float := Lerp (X, Bx, Al);
            Lo : constant Float := Float'Min (X, Bx);
            Hi : constant Float := Float'Max (X, Bx);
         begin
            Lerp32_Cases := Lerp32_Cases + 1;
            Check (To_U32 (R) = W, "Lerp_Raw bits vs old C lerp");
            Check (Lp >= Lo and then Lp <= Hi, "Lerp stays between endpoints");
            if Al = 0.0 then
               Check (Lp = X, "Lerp alpha 0 exact");
            end if;
            if Al = 1.0 then
               Check (Lp = Bx, "Lerp alpha 1 exact");
               if R /= Bx then
                  Div32_Alpha1 := Div32_Alpha1 + 1;
               end if;
            elsif R >= Lo and then R <= Hi then
               Check (To_U32 (Lp) = W, "Lerp identical to old C when the old value is inside the endpoints");
            else
               Div32_Over := Div32_Over + 1;
            end if;
         end;
      end loop;
   end Do_Lerp32;

   procedure Do_Lerp64 (F : File_Type; M : Natural) is
   begin
      for I in 1 .. M loop
         Read_Line (F);
         declare
            X  : constant Coord64 := Coord64 (LF (Next_Hex));
            Bx : constant Coord64 := Coord64 (LF (Next_Hex));
            Al : constant Alpha_Wide := Alpha_Wide (LF (Next_Hex));
            W  : constant Unsigned_64 := Next_Hex;
            R  : constant Long_Float := Lerp64_Raw (X, Bx, Al);
            Lp : constant Long_Float := Lerp64 (X, Bx, Al);
            Lo : constant Long_Float := Long_Float'Min (X, Bx);
            Hi : constant Long_Float := Long_Float'Max (X, Bx);
         begin
            Lerp64_Cases := Lerp64_Cases + 1;
            Check (To_U64 (R) = W, "Lerp64_Raw bits vs old JS lerp");
            Check (Lp >= Lo and then Lp <= Hi, "Lerp64 stays between endpoints");
            if Al = 0.0 then
               Check (Lp = X, "Lerp64 alpha 0 exact");
            end if;
            if Al = 1.0 then
               Check (Lp = Bx, "Lerp64 alpha 1 exact");
               if R /= Bx then
                  Div64_Alpha1 := Div64_Alpha1 + 1;
               end if;
            elsif R >= Lo and then R <= Hi then
               Check (To_U64 (Lp) = W, "Lerp64 identical to old JS when the old value is inside");
            else
               Div64_Over := Div64_Over + 1;
            end if;
         end;
      end loop;
   end Do_Lerp64;

   procedure Do_Fmod (F : File_Type; M : Natural) is
   begin
      for I in 1 .. M loop
         Read_Line (F);
         declare
            X : constant Fmod_Arg := Fmod_Arg (LF (Next_Hex));
            W : constant Unsigned_64 := Next_Hex;
            R : constant Long_Float := Fmod360 (X);
         begin
            Fmod_Cases := Fmod_Cases + 1;
            Check (To_U64 (R) = W, "Fmod360 bits vs JS %: x=" & Long_Float'Image (X)
                   & " got " & Long_Float'Image (R) & " want " & Long_Float'Image (LF (W)));
         end;
      end loop;
   end Do_Fmod;

   procedure Do_Angle (F : File_Type; M : Natural) is
   begin
      for I in 1 .. M loop
         Read_Line (F);
         declare
            A  : constant Angle_Deg := Angle_Deg (LF (Next_Hex));
            B  : constant Angle_Deg := Angle_Deg (LF (Next_Hex));
            Al : constant Alpha_Wide := Alpha_Wide (LF (Next_Hex));
            Wd : constant Unsigned_64 := Next_Hex;
            Wr : constant Unsigned_64 := Next_Hex;
            D  : constant Long_Float := Shortest_Delta (A, B);
            Rw : constant Long_Float := Blend_Angle_Deg_Raw (A, B, Al);
            R  : constant Long_Float := Blend_Angle_Deg (A, B, Al);
            E  : constant Long_Float := A + D;
            Lo : constant Long_Float := Long_Float'Min (A, E);
            Hi : constant Long_Float := Long_Float'Max (A, E);
         begin
            Angle_Cases := Angle_Cases + 1;
            Check (To_U64 (D) = Wd, "Shortest_Delta bits vs old blendAngleDeg: a=" & Long_Float'Image (A)
                   & " b=" & Long_Float'Image (B));
            Check (To_U64 (Rw) = Wr, "Blend_Angle_Deg_Raw bits vs old blendAngleDeg: a=" & Long_Float'Image (A)
                   & " b=" & Long_Float'Image (B));
            Check (R >= Lo and then R <= Hi and then R >= A - 180.0 and then R <= A + 180.0,
                   "Blend_Angle_Deg stays on the short arc (at most half a turn)");
            if Al = 0.0 then
               Check (R = A, "Blend_Angle_Deg alpha 0 exact");
            end if;
            if Al = 1.0 then
               Check (R = E and then To_U64 (R) = Wr, "Blend_Angle_Deg alpha 1 = a + delta, as old");
            elsif Rw >= Lo and then Rw <= Hi then
               Check (To_U64 (R) = Wr, "Blend_Angle_Deg identical to old JS when the old value is on the arc");
            else
               Angle_Over := Angle_Over + 1;
            end if;
         end;
      end loop;
   end Do_Angle;

   Match_Cases : Natural := 0;

   procedure Do_Match (F : File_Type; Count : Natural) is
   begin
      for I in 1 .. Count loop
         Read_Line (F);
         declare
            N    : constant Natural := Natural (Next_Int);
            Want : constant Long_Long_Integer := Next_Int;
            X    : constant Tick_Time := Tick_Time (LF (Next_Hex));
            M    : Match_Array (0 .. Valid_Tick (N) - 1);
         begin
            for K in 0 .. N - 1 loop
               M (Valid_Tick (K)) := (Start_Time => Tick_Time (LF (Next_Hex)),
                                      End_Time   => Tick_Time (LF (Next_Hex)));
            end loop;
            Match_Cases := Match_Cases + 1;
            Check (Long_Long_Integer (Match_Index_For_Time (M, X)) = Want,
                   "Match_Index_For_Time vs old JS matchIndexForTime");
         end;
      end loop;
   end Do_Match;

   procedure Run_Oracle (Path : String) is
      F : File_Type;
   begin
      Open (F, In_File, Path);
      loop
         Read_Line (F);
         declare
            Tag : constant String := Next_Word;
         begin
            if Tag = "SET" then
               Do_Set (F);
            elsif Tag = "LERP32" then
               Do_Lerp32 (F, Natural (Next_Int));
            elsif Tag = "LERP64" then
               Do_Lerp64 (F, Natural (Next_Int));
            elsif Tag = "FMOD" then
               Do_Fmod (F, Natural (Next_Int));
            elsif Tag = "ANGLE" then
               Do_Angle (F, Natural (Next_Int));
            elsif Tag = "MATCH" then
               Do_Match (F, Natural (Next_Int));
            elsif Tag = "END" then
               exit;
            else
               Check (False, "unknown oracle tag " & Tag);
               exit;
            end if;
         end;
      end loop;
      Close (F);
   end Run_Oracle;

begin
   if Ada.Command_Line.Argument_Count < 2 then
      Put_Line ("usage: test_tick_index <oracle-file> fast|contracts");
      Ada.Command_Line.Set_Exit_Status (2);
      return;
   end if;
   Contracts_Mode := Ada.Command_Line.Argument (2) = "contracts";

   Exhaustive;
   Alpha_Corners;
   if not Contracts_Mode then
      Big_Array;
   end if;
   Run_Oracle (Ada.Command_Line.Argument (1));

   Put_Line ("oracle: tick sets run =" & Natural'Image (Sets_Done) & " (skipped for the O(n) contract check:"
             & Natural'Image (Sets_Skipped) & "), frame queries =" & Natural'Image (Frame_Queries));
   Put_Line ("oracle: lerp32 =" & Natural'Image (Lerp32_Cases) & " lerp64 =" & Natural'Image (Lerp64_Cases)
             & " angle =" & Natural'Image (Angle_Cases) & " fmod =" & Natural'Image (Fmod_Cases));
   Put_Line ("oracle: match intervals cases =" & Natural'Image (Match_Cases));
   Put_Line ("angle blend: old value off the arc (clamped by the new code):" & Natural'Image (Angle_Over));
   Put_Line ("lerp divergences old-vs-new (intentional): 32-bit alpha=1 differs" & Natural'Image (Div32_Alpha1)
             & ", overshoot clamped" & Natural'Image (Div32_Over) & "; 64-bit alpha=1 differs"
             & Natural'Image (Div64_Alpha1) & ", overshoot clamped" & Natural'Image (Div64_Over));
   Put_Line ("TEST " & (if Contracts_Mode then "(contracts) " else "(fast) ") & "checks =" & Natural'Image (Checks)
             & " failures =" & Natural'Image (Failures));
   if Failures /= 0 then
      Ada.Command_Line.Set_Exit_Status (1);
   end if;
end Test_Tick_Index;

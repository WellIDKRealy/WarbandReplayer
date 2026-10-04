--  Tick_Index: tick lookup by time and the tickA/tickB interpolation fraction used by playback.
--
--  Port of the OLD engine's replay_worker.c:
--    find_tick_index_for_time   (~1188-1198)  -> Find_Tick_Index_For_Time  (and the pure search Last_At_Or_Before)
--    build_frame_at_time        (~1235-1248)  -> Locate / Alpha_For        (idxA, idxB, alpha)
--  Lerp and angle blending live in the child package Tick_Index.Blend.
--
--  Zero-footprint: Pure, no state, no standard-library units, no exceptions, no allocation.
--  All sizes / indexes are 64-bit (Tick_Pos); up to Max_Ticks = 2**31 ticks.
--
--  Floating point: times are IEEE binary64 (Long_Float), exactly like the old `double time` field.
--  Every Long_Float / Float that enters a contract is a range subtype with finite bounds, so
--  GNATprove proves the absence of overflow / NaN / Inf at every operation.
package Tick_Index
  with SPARK_Mode, Pure
is
   Max_Ticks : constant := 2 ** 31;

   --  Index type: -1 is the "no such tick" sentinel of Last_At_Or_Before.
   --  The range does not fit in 32 bits, so GNAT represents it in 64 bits.
   type Tick_Pos is range -1 .. Max_Ticks;
   for Tick_Pos'Size use 64;
   subtype Valid_Tick is Tick_Pos range 0 .. Max_Ticks - 1;

   --  A tick time / query time in seconds. +-1.0E19 covers every SQLite INTEGER (|x| < 2**63 ~ 9.22E18)
   --  converted to double. Callers (the wasm wrapper) must reject NaN/Inf and out-of-range queries
   --  explicitly; nothing in here ever clamps a time silently.
   subtype Tick_Time is Long_Float range -1.0E19 .. 1.0E19;

   --  Tick times indexed by tick index (old: g_ticks[i].time). Any lower bound is allowed.
   type Time_Array is array (Valid_Tick range <>) of Tick_Time;

   --  Interpolation fraction between tickA and tickB (old: `float alpha`).
   subtype Alpha_Type is Float range 0.0 .. 1.0;

   --  A battle / match time interval [Start_Time, End_Time] (old main.js: matches[i].startTime / endTime).
   type Match_Interval is record
      Start_Time : Tick_Time;
      End_Time   : Tick_Time;
   end record;
   type Match_Array is array (Valid_Tick range <>) of Match_Interval;

   No_Match : constant Tick_Pos := -1;

   function Contains (M : Match_Interval; X : Tick_Time) return Boolean is
     (X >= M.Start_Time and then X <= M.End_Time);

   -----------------------------------------------------------------------------------------------
   --  Sortedness (non-strict: whole-second ticks give many equal consecutive times).
   -----------------------------------------------------------------------------------------------

   function Sorted (T : Time_Array) return Boolean is
     (for all I in T'Range => (if I < T'Last then T (I) <= T (I + 1)))
   with Ghost;

   --  Executable validator for the Sorted precondition: a loader must call it on the tick table and report
   --  an explicit error when it is False (the old engine silently binary-searched whatever it was given).
   function Is_Sorted (T : Time_Array) return Boolean
   with Global => null, Post => Is_Sorted'Result = Sorted (T);

   --  Executable domain check for a time received from outside (False for NaN, +-Inf and anything
   --  outside +-1.0E19): callers must reject such queries explicitly before converting to Tick_Time.
   function In_Time_Domain (X : Long_Float) return Boolean is (X >= -1.0E19 and then X <= 1.0E19);

   -----------------------------------------------------------------------------------------------
   --  Search
   -----------------------------------------------------------------------------------------------

   --  Greatest tick index I with T (I) <= X; T'First - 1 when there is none (X before the first tick).
   --  (Non-empty T only: the old engine tests g_tick_count == 0 in its callers.)  The postcondition is
   --  the complete characterisation: for sorted T, tick J is at or before X exactly when J <= Result.
   --  This holds with duplicates (equal consecutive times): the LAST tick of a run of equal times <= X
   --  is returned.
   function Last_At_Or_Before (T : Time_Array; X : Tick_Time) return Tick_Pos
   with
     Global => null,
     Pre    => T'Length > 0 and then Sorted (T),
     Post   => Last_At_Or_Before'Result in T'First - 1 .. T'Last
               and then (for all J in T'Range =>
                           (T (J) <= X) = (J <= Last_At_Or_Before'Result));

   --  Faithful port of find_tick_index_for_time (old C, including its two fast paths); the old empty-table
   --  case (`return 0`) is not here: build_frame_at_time, its only caller, handles g_tick_count == 0 first.
   --    X <= T (first)    -> first tick   (NOTE: not the last of a leading run of equal times)
   --    X >= T (last)     -> last tick
   --    otherwise         -> greatest I with T (I) <= X
   function Find_Tick_Index_For_Time (T : Time_Array; X : Tick_Time) return Valid_Tick
   with
     Global => null,
     Pre    => T'Length > 0 and then Sorted (T),
     Post   =>
       Find_Tick_Index_For_Time'Result in T'Range
       and then (if X <= T (T'First) then Find_Tick_Index_For_Time'Result = T'First)
       and then (if X > T (T'First) and then X >= T (T'Last) then
                   Find_Tick_Index_For_Time'Result = T'Last)
       and then (if X > T (T'First) then
                   Find_Tick_Index_For_Time'Result = Last_At_Or_Before (T, X)
                   and then T (Find_Tick_Index_For_Time'Result) <= X
                   and then (if Find_Tick_Index_For_Time'Result < T'Last then
                               T (Find_Tick_Index_For_Time'Result + 1) > X));

   --  main.js matchIndexForTime: the FIRST match (in array order, intervals may overlap or be unsorted)
   --  whose closed interval contains X; No_Match (-1) when there is none.  No sortedness needed.
   function Match_Index_For_Time (M : Match_Array; X : Tick_Time) return Tick_Pos
   with
     Global => null,
     Post   =>
       (if Match_Index_For_Time'Result = No_Match then
          (for all I in M'Range => not Contains (M (I), X))
        else
          Match_Index_For_Time'Result in M'Range
          and then Contains (M (Match_Index_For_Time'Result), X)
          and then (for all J in M'First .. Match_Index_For_Time'Result - 1 =>
                      not Contains (M (J), X)));

   -----------------------------------------------------------------------------------------------
   --  Interpolation fraction
   -----------------------------------------------------------------------------------------------

   --  alpha of build_frame_at_time for tickA at Time_A, tickB at Time_B, playback time X:
   --      alpha = 0                                   if not (Time_B > Time_A)   (no division by zero)
   --      alpha = (float) ((X - Time_A) / (Time_B - Time_A)) clamped to [0, 1]   otherwise
   --  The postcondition is the complete piecewise definition.  The clamp of the old code is realised by
   --  the two outer cases (X at/before Time_A -> exactly 0.0, X at/after Time_B -> exactly 1.0) so that
   --  no division is evaluated outside the range where its quotient is provably in [0, 1].
   function Alpha_For (Time_A, Time_B, X : Tick_Time) return Alpha_Type
   with
     Global => null,
     Post   =>
       (if not (Time_B > Time_A) or else X <= Time_A then Alpha_For'Result = 0.0)
       and then (if Time_B > Time_A and then X >= Time_B then Alpha_For'Result = 1.0)
       and then (if Time_B > Time_A and then X > Time_A and then X < Time_B then
                   Alpha_For'Result = Float ((X - Time_A) / (Time_B - Time_A)));

   --  What build_frame_at_time computes before it touches any data: the two ticks to blend and alpha.
   type Frame_Pos is record
      Index_A : Valid_Tick;
      Index_B : Valid_Tick;
      Alpha   : Alpha_Type;
   end record;

   --  Precondition: at least one tick (old: `if (g_tick_count == 0) { clear outputs; return; }`).
   function Locate (T : Time_Array; X : Tick_Time) return Frame_Pos
   with
     Global => null,
     Pre    => T'Length > 0 and then Sorted (T),
     Post   =>
       Locate'Result.Index_A = Find_Tick_Index_For_Time (T, X)
       and then Locate'Result.Index_A in T'Range
       and then Locate'Result.Index_B in T'Range
       and then (if Locate'Result.Index_A < T'Last then
                   Locate'Result.Index_B = Locate'Result.Index_A + 1
                 else
                   Locate'Result.Index_B = Locate'Result.Index_A)
       and then Locate'Result.Alpha =
                  Alpha_For (T (Locate'Result.Index_A), T (Locate'Result.Index_B), X)
       --  consequences worth stating explicitly:
       and then (if T (Locate'Result.Index_B) = T (Locate'Result.Index_A) then
                   Locate'Result.Alpha = 0.0)
       and then (if X <= T (Locate'Result.Index_A) then Locate'Result.Alpha = 0.0);

end Tick_Index;

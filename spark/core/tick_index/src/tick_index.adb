with Tick_Index.Lemmas;

package body Tick_Index
  with SPARK_Mode
is

   -----------------------------------------------------------------------------------------------
   --  Is_Sorted
   -----------------------------------------------------------------------------------------------

   function Is_Sorted (T : Time_Array) return Boolean is
   begin
      for I in T'Range loop
         pragma Loop_Invariant
           (for all J in T'First .. I - 1 => (if J < T'Last then T (J) <= T (J + 1)));
         if I < T'Last and then T (I) > T (I + 1) then
            return False;
         end if;
      end loop;
      return True;
   end Is_Sorted;

   -----------------------------------------------------------------------------------------------
   --  Last_At_Or_Before: binary search on the half-open invariant
   --      every tick <= Lo is <= X,  every tick >= Hi is > X,  Lo < Hi.
   -----------------------------------------------------------------------------------------------

   function Last_At_Or_Before (T : Time_Array; X : Tick_Time) return Tick_Pos is
      Lo : Tick_Pos := T'First - 1;   --  Lo = T'First - 1, or T (Lo) <= X
      Hi : Tick_Pos := T'Last + 1;    --  Hi = T'Last + 1,  or T (Hi) >  X
   begin
      declare
         --  proof-only: the lemma is O(n**2) and must not run even in -gnata test builds
         pragma Assertion_Policy (Ghost => Ignore);
      begin
         Lemmas.Lemma_Sorted_Monotone (T);
      end;
      while Hi - Lo > 1 loop
         pragma Loop_Invariant (Lo >= T'First - 1 and then Hi <= T'Last + 1 and then Lo < Hi);
         pragma Loop_Invariant (for all J in T'Range => (if J <= Lo then T (J) <= X));
         pragma Loop_Invariant (for all J in T'Range => (if J >= Hi then T (J) > X));
         pragma Loop_Variant (Decreases => Hi - Lo);
         declare
            Mid : constant Tick_Pos := Lo + (Hi - Lo) / 2;
         begin
            if T (Mid) <= X then
               Lo := Mid;
            else
               Hi := Mid;
            end if;
         end;
      end loop;
      return Lo;
   end Last_At_Or_Before;

   -----------------------------------------------------------------------------------------------
   --  Find_Tick_Index_For_Time
   -----------------------------------------------------------------------------------------------

   function Find_Tick_Index_For_Time (T : Time_Array; X : Tick_Time) return Valid_Tick is
   begin
      if X <= T (T'First) then
         return T'First;                      --  old: if (t <= g_ticks[0].time) return 0;
      elsif X >= T (T'Last) then
         return T'Last;                       --  old: if (t >= g_ticks[n-1].time) return n-1;
      else
         declare
            R : constant Tick_Pos := Last_At_Or_Before (T, X);
         begin
            --  T (T'First) < X, so the tick T'First qualifies and R >= T'First;  R < T'Last since
            --  T (T'Last) > X.
            return R;
         end;
      end if;
   end Find_Tick_Index_For_Time;

   -----------------------------------------------------------------------------------------------
   --  Match_Index_For_Time
   -----------------------------------------------------------------------------------------------

   function Match_Index_For_Time (M : Match_Array; X : Tick_Time) return Tick_Pos is
   begin
      for I in M'Range loop
         pragma Loop_Invariant (for all J in M'First .. I - 1 => not Contains (M (J), X));
         if Contains (M (I), X) then
            return I;                           --  old: if (t >= start && t <= end) return i;
         end if;
      end loop;
      return No_Match;                          --  old: return -1;
   end Match_Index_For_Time;

   -----------------------------------------------------------------------------------------------
   --  Alpha_For
   -----------------------------------------------------------------------------------------------

   function Alpha_For (Time_A, Time_B, X : Tick_Time) return Alpha_Type is
   begin
      if not (Time_B > Time_A) then
         return 0.0;                          --  old: alpha stays 0.0f when timeB <= timeA
      elsif X <= Time_A then
         return 0.0;                          --  old: quotient <= 0 -> clamped to 0
      elsif X >= Time_B then
         return 1.0;                          --  old: quotient >= 1 -> clamped to 1
      else
         --  Time_A < X < Time_B: 0 < X - Time_A <= Time_B - Time_A, so the quotient is in (0, 1].
         return Float ((X - Time_A) / (Time_B - Time_A));
      end if;
   end Alpha_For;

   -----------------------------------------------------------------------------------------------
   --  Locate
   -----------------------------------------------------------------------------------------------

   function Locate (T : Time_Array; X : Tick_Time) return Frame_Pos is
      A : constant Valid_Tick := Find_Tick_Index_For_Time (T, X);
      B : constant Valid_Tick := (if A < T'Last then A + 1 else A);
   begin
      return (Index_A => A, Index_B => B, Alpha => Alpha_For (T (A), T (B), X));
   end Locate;

end Tick_Index;

pragma Assertion_Policy (Ghost => Ignore);

package body Tick_Index.Lemmas
  with SPARK_Mode
is

   -----------------------------------------------------------------------------------------------
   --  Lemma_Sorted_Monotone
   -----------------------------------------------------------------------------------------------

   procedure Lemma_Sorted_Monotone (T : Time_Array) is
   begin
      for I in T'Range loop
         --  everything starting before I is already related to everything after it
         pragma Loop_Invariant
           (for all A in T'First .. I - 1 =>
              (for all B in T'Range => (if A <= B then T (A) <= T (B))));
         for J in I .. T'Last loop
            pragma Loop_Invariant (for all B in I .. J - 1 => T (I) <= T (B));
            pragma Loop_Invariant (J = I or else T (I) <= T (J - 1));
            null;
         end loop;
         pragma Assert (for all B in I .. T'Last => T (I) <= T (B));
      end loop;
   end Lemma_Sorted_Monotone;

end Tick_Index.Lemmas;

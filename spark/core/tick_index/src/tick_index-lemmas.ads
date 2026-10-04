--  Proof-only lemmas for Tick_Index.  The whole unit is Ghost and its Ghost assertion policy is Ignore, so
--  none of it is ever executed or compiled into code, not even in -gnata test builds (the lemma is
--  O(n**2)).  GNATprove ignores the policy and proves it like any other code.
pragma Assertion_Policy (Ghost => Ignore);

package Tick_Index.Lemmas
  with SPARK_Mode, Ghost, Pure
is

   function Monotone (T : Time_Array) return Boolean is
     (for all I in T'Range => (for all J in T'Range => (if I <= J then T (I) <= T (J))));

   --  Adjacent sortedness implies the all-pairs form (proved by induction in the body).
   procedure Lemma_Sorted_Monotone (T : Time_Array)
   with Global => null, Pre => Sorted (T), Post => Monotone (T);

end Tick_Index.Lemmas;

--  Proof scaffolding of Snapshot_Swap (ghost only, never compiled into code, not part of the interface).
package Snapshot_Swap.Proofs
  with SPARK_Mode, Ghost, Pure
is
   --  The starting state satisfies the invariant (so every state reached by any sequence of
   --  operations is Valid, by the "Valid in, Valid out" postconditions).
   procedure Lemma_Initial_Valid
   with Post => Valid (Initial);

   --  Progress: when the producer holds nothing, a Free slot exists.  (Pigeonhole: the three
   --  slots cannot all be Published / In_Use, of which a Valid state has at most one each.)
   procedure Lemma_Free_Exists (S : Swap_State)
   with Pre => Valid (S) and then not Has_Slot (S, Writing), Post => Has_Slot (S, Free);

end Snapshot_Swap.Proofs;

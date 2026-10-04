with Snapshot_Swap.Proofs;

package body Snapshot_Swap
  with SPARK_Mode
is
   --  The lowest slot of kind K (callers only use it for kinds that have a slot).
   function Find_First (S : Swap_State; K : Slot_Kind) return Slot_Id
   with
     Global => null,
     Pre    => Has_Slot (S, K),
     Post   => S.Slots (Find_First'Result).Kind = K
               and then (for all I in Slot_Id => (if I < Find_First'Result then S.Slots (I).Kind /= K))
   is
      Result : Slot_Id := Slot_Id'Last;
   begin
      for I in Slot_Id loop
         pragma Loop_Invariant (for all J in Slot_Id => (if J < I then S.Slots (J).Kind /= K));
         if S.Slots (I).Kind = K then
            Result := I;
            exit;
         end if;
      end loop;
      return Result;
   end Find_First;

   procedure Producer_Begin (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id) is
   begin
      Slot := Slot_Id'First;
      if not Valid (S) then
         Status := Corrupt_State;
      elsif Has_Slot (S, Writing) then
         Status := Already_Writing;
      else
         Proofs.Lemma_Free_Exists (S);
         Slot := Find_First (S, Free);
         S.Slots (Slot) := (Kind => Writing, Seq => 0);
         Status := Ok;
      end if;
   end Producer_Begin;

   procedure Producer_Publish (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id) is
   begin
      Slot := Slot_Id'First;
      if not Valid (S) then
         Status := Corrupt_State;
      elsif not Has_Slot (S, Writing) then
         Status := Not_Writing;
      elsif S.Last_Seq = Seq_Number'Last then
         Status := Seq_Exhausted;
      else
         Slot := Find_First (S, Writing);
         if Has_Slot (S, Published) then
            S.Slots (Find_First (S, Published)) := Free_Info;
         end if;
         S.Last_Seq := S.Last_Seq + 1;
         S.Slots (Slot) := (Kind => Published, Seq => S.Last_Seq);
         Status := Ok;
      end if;
   end Producer_Publish;

   procedure Producer_Abort (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id) is
   begin
      Slot := Slot_Id'First;
      if not Valid (S) then
         Status := Corrupt_State;
      elsif not Has_Slot (S, Writing) then
         Status := Not_Writing;
      else
         Slot := Find_First (S, Writing);
         S.Slots (Slot) := Free_Info;
         Status := Ok;
      end if;
   end Producer_Abort;

   procedure Consumer_Acquire (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id) is
   begin
      Slot := Slot_Id'First;
      if not Valid (S) then
         Status := Corrupt_State;
      elsif Has_Slot (S, In_Use) then
         Status := Already_In_Use;
      elsif not Has_Slot (S, Published) then
         Status := Nothing_New;
      else
         Slot := Find_First (S, Published);
         S.Slots (Slot) := (Kind => In_Use, Seq => S.Last_Seq);
         Status := Ok;
      end if;
   end Consumer_Acquire;

   procedure Consumer_Release (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id) is
   begin
      Slot := Slot_Id'First;
      if not Valid (S) then
         Status := Corrupt_State;
      elsif not Has_Slot (S, In_Use) then
         Status := Not_In_Use;
      else
         Slot := Find_First (S, In_Use);
         S.Slots (Slot) := Free_Info;
         Status := Ok;
      end if;
   end Consumer_Release;

end Snapshot_Swap;

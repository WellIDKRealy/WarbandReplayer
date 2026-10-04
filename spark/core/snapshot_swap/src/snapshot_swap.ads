--  Snapshot_Swap: the frame-snapshot hand-off between the playback thread (producer) and the draw
--  side (consumer), as a SEQUENTIAL state machine over three snapshot slots.  The slots themselves
--  (the frame buffers) live elsewhere: this package only decides WHO may touch WHICH slot.
--  README.md opens with the guarantees; PROOF.md has the proof summary.
--
--  Producer: Producer_Begin -> (fill the slot) -> Producer_Publish   (or Producer_Abort).
--  Consumer: Consumer_Acquire -> (draw the slot) -> Consumer_Release.
--  "Latest wins": publishing a snapshot supersedes the previous unread one (its slot becomes Free).
--
--  Every operation is total: it works on ANY Swap_State, never raises, and says what happened in
--  Status.  Illegal use and corrupt states change nothing and return Slot = Slot_Id'First, which
--  is meaningful only when Status = Ok.  Interleavings of the two threads are NOT modelled here
--  (register item R4: the operations must be run one at a time).
package Snapshot_Swap
  with SPARK_Mode, Pure
is
   --  Three slots: at most one is being written, one is waiting (newest, unread) and one is held
   --  by the consumer, so a Free slot always exists for the producer (see Producer_Begin).
   Slot_Count : constant := 3;
   type Slot_Id is range 0 .. Slot_Count - 1;

   --  Sequence number of a published snapshot: 1, 2, 3, ...  (0 = none yet).  63 bits: publishing
   --  stops with Seq_Exhausted at the maximum, the counter can never wrap.
   type Seq_Number is range 0 .. 2 ** 63 - 1;

   type Slot_Kind is
     (Free,        --  nobody uses it
      Writing,     --  the producer fills it; the consumer cannot see it
      Published,   --  complete, the newest snapshot, not yet acquired
      In_Use);     --  held by the consumer (acquired, not yet released)

   --  Seq is 0 for Free / Writing slots and the snapshot's sequence number otherwise.
   type Slot_Info is record
      Kind : Slot_Kind;
      Seq  : Seq_Number;
   end record;

   Free_Info : constant Slot_Info := (Kind => Free, Seq => 0);

   type Slot_Array is array (Slot_Id) of Slot_Info;

   --  Last_Seq = the sequence number of the most recent publish (0 = none yet).
   type Swap_State is record
      Slots    : Slot_Array;
      Last_Seq : Seq_Number;
   end record;

   Initial : constant Swap_State :=
     (Slots => (others => (Kind => Free, Seq => 0)), Last_Seq => 0);

   type Status_Kind is
     (Ok,               --  done
      Nothing_New,      --  Consumer_Acquire: no Published snapshot is waiting
      Already_Writing,  --  Producer_Begin: the producer already holds a slot
      Not_Writing,      --  Producer_Publish / Producer_Abort: no Producer_Begin before
      Already_In_Use,   --  Consumer_Acquire: the consumer still holds a slot
      Not_In_Use,       --  Consumer_Release: the consumer holds nothing
      Seq_Exhausted,    --  Producer_Publish: Last_Seq is at its maximum, nothing published
      Corrupt_State);   --  State is not Valid: refused, State untouched

   function Has_Slot (S : Swap_State; K : Slot_Kind) return Boolean is
     (for some I in Slot_Id => S.Slots (I).Kind = K);

   function Set_Slot (S : Swap_State; I : Slot_Id; Info : Slot_Info) return Swap_State is
     ((S with delta Slots => (S.Slots with delta I => Info)));

   --  The invariant: exactly the states reachable from Initial.  (a) At most one Writing, one
   --  Published and one In_Use slot.  (b) Free / Writing slots carry Seq 0.  (c) The Published slot
   --  is the newest snapshot: Seq = Last_Seq.  (d) The In_Use slot has Seq in 1 .. Last_Seq and is
   --  older than the Published slot, or is itself the newest when none is waiting.
   function Valid (S : Swap_State) return Boolean is
     ((for all I in Slot_Id =>
         (case S.Slots (I).Kind is
            when Free | Writing => S.Slots (I).Seq = 0,
            when Published      => S.Slots (I).Seq = S.Last_Seq and then S.Last_Seq /= 0,
            when In_Use         => S.Slots (I).Seq in 1 .. S.Last_Seq
                                   and then (S.Slots (I).Seq < S.Last_Seq) = Has_Slot (S, Published)))
      and then
        (for all I in Slot_Id =>
           (for all J in Slot_Id =>
              (if I /= J and then S.Slots (I).Kind /= Free
               then S.Slots (I).Kind /= S.Slots (J).Kind))));

   --  Producer: take a Free slot (the lowest) to fill.  Never an In_Use or Published one.
   --  Always succeeds when the producer holds nothing and the state is Valid: with a Valid state
   --  the other two slots cannot both be occupied by the consumer and the waiting snapshot.
   procedure Producer_Begin (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id)
   with
     Global => null,
     Post   =>
       (if Valid (S'Old) then Valid (S))
       and then
         (if not Valid (S'Old)
          then Status = Corrupt_State and Slot = Slot_Id'First and S = S'Old
          elsif Has_Slot (S'Old, Writing)
          then Status = Already_Writing and Slot = Slot_Id'First and S = S'Old
          else Status = Ok
               and S'Old.Slots (Slot).Kind = Free
               and (for all I in Slot_Id => (if I < Slot then S'Old.Slots (I).Kind /= Free))
               and S = Set_Slot (S'Old, Slot, (Kind => Writing, Seq => 0)));

   --  Producer: the written slot becomes the newest Published snapshot, with sequence number
   --  Last_Seq + 1 (strictly increasing); the previously Published, unread one is superseded
   --  (Free).  The consumer's In_Use slot is untouched.
   procedure Producer_Publish (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id)
   with
     Global => null,
     Post   =>
       (if Valid (S'Old) then Valid (S))
       and then
         (if not Valid (S'Old)
          then Status = Corrupt_State and Slot = Slot_Id'First and S = S'Old
          elsif not Has_Slot (S'Old, Writing)
          then Status = Not_Writing and Slot = Slot_Id'First and S = S'Old
          elsif S'Old.Last_Seq = Seq_Number'Last
          then Status = Seq_Exhausted and Slot = Slot_Id'First and S = S'Old
          else Status = Ok
               and S'Old.Slots (Slot).Kind = Writing
               and S.Last_Seq = S'Old.Last_Seq + 1
               and S.Slots (Slot) = (Kind => Published, Seq => S.Last_Seq)
               and (for all I in Slot_Id =>
                      (if I /= Slot
                       then S.Slots (I) = (if S'Old.Slots (I).Kind = Published
                                           then Free_Info else S'Old.Slots (I)))));

   --  Producer: give the written slot up without publishing it (it becomes Free).
   procedure Producer_Abort (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id)
   with
     Global => null,
     Post   =>
       (if Valid (S'Old) then Valid (S))
       and then
         (if not Valid (S'Old)
          then Status = Corrupt_State and Slot = Slot_Id'First and S = S'Old
          elsif not Has_Slot (S'Old, Writing)
          then Status = Not_Writing and Slot = Slot_Id'First and S = S'Old
          else Status = Ok
               and S'Old.Slots (Slot).Kind = Writing
               and S = Set_Slot (S'Old, Slot, Free_Info));

   --  Consumer: take the NEWEST Published snapshot (the one with Seq = Last_Seq, the largest ever
   --  published) and mark it In_Use; never a Free, Writing or older slot.  Nothing_New when none waits.
   procedure Consumer_Acquire (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id)
   with
     Global => null,
     Post   =>
       (if Valid (S'Old) then Valid (S))
       and then
         (if not Valid (S'Old)
          then Status = Corrupt_State and Slot = Slot_Id'First and S = S'Old
          elsif Has_Slot (S'Old, In_Use)
          then Status = Already_In_Use and Slot = Slot_Id'First and S = S'Old
          elsif not Has_Slot (S'Old, Published)
          then Status = Nothing_New and Slot = Slot_Id'First and S = S'Old
          else Status = Ok
               and S'Old.Slots (Slot).Kind = Published
               and S'Old.Slots (Slot).Seq = S'Old.Last_Seq
               and S = Set_Slot (S'Old, Slot, (Kind => In_Use, Seq => S'Old.Last_Seq)));

   --  Consumer: give the held slot back (it becomes Free).
   procedure Consumer_Release (S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id)
   with
     Global => null,
     Post   =>
       (if Valid (S'Old) then Valid (S))
       and then
         (if not Valid (S'Old)
          then Status = Corrupt_State and Slot = Slot_Id'First and S = S'Old
          elsif not Has_Slot (S'Old, In_Use)
          then Status = Not_In_Use and Slot = Slot_Id'First and S = S'Old
          else Status = Ok
               and S'Old.Slots (Slot).Kind = In_Use
               and S = Set_Slot (S'Old, Slot, Free_Info));

end Snapshot_Swap;

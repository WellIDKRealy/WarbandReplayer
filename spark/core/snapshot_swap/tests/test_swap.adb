--  Native differential tests of Snapshot_Swap (not part of the proof project).
--
--    test_swap DIR MODE        DIR holds the files written by oracle.py, MODE is "fast" or "contracts"
--
--  1. Exhaustive: EVERY sequence of the 5 operations up to length 10 (12,207,030 steps) from the
--     initial state and again from a state 2 publishes below the sequence-number maximum, each step
--     compared (status, slot, complete state) with the naive Python model's transition table.
--  2. Every state of a bounded domain (52,288 states, valid and invalid, small and near 2**63 - 1):
--     Valid agrees with the model, every operation agrees with the model (invalid: Corrupt_State,
--     slot 0, state untouched).
--  3. Directed scenarios, written down by hand (the protocol in action, sequence-number saturation).
--  4. A long random walk against an independent shadow model (roles as plain variables): exclusivity
--     of slots, strictly increasing acquired sequence numbers, newest-wins, never blocked.
--  MODE "contracts" is built with -gnata (every contract, incl. Valid, runs): smaller workload.
with Ada.Command_Line;
with Ada.Text_IO;
with Snapshot_Swap; use Snapshot_Swap;

procedure Test_Swap is
   use Ada.Text_IO;

   type Op_Kind is (Begin_Op, Publish_Op, Abort_Op, Acquire_Op, Release_Op);
   type Count_Array is array (Natural range 0 .. 12) of Long_Long_Integer;

   Failures : Natural := 0;
   Checks   : Long_Long_Integer := 0;

   procedure Fail (Msg : String) is
   begin
      Failures := Failures + 1;
      if Failures <= 20 then
         Put_Line ("FAIL: " & Msg);
      end if;
   end Fail;

   procedure Apply (Op : Op_Kind; S : in out Swap_State; Status : out Status_Kind; Slot : out Slot_Id) is
   begin
      case Op is
         when Begin_Op   => Producer_Begin (S, Status, Slot);
         when Publish_Op => Producer_Publish (S, Status, Slot);
         when Abort_Op   => Producer_Abort (S, Status, Slot);
         when Acquire_Op => Consumer_Acquire (S, Status, Slot);
         when Release_Op => Consumer_Release (S, Status, Slot);
      end case;
   end Apply;

   function Kind_Char (K : Slot_Kind) return Character is
     (case K is when Free => 'F', when Writing => 'W', when Published => 'P', when In_Use => 'U');

   function Img (N : Long_Long_Integer) return String is
      S : constant String := Long_Long_Integer'Image (N);
   begin
      return S (S'First + 1 .. S'Last);
   end Img;

   --  "[F, P3, U2] 3": the slots (kind letter, then the sequence number when not 0) and Last_Seq.
   function Show (S : Swap_State) return String is
      R : String (1 .. 4096);
      N : Natural := 0;
      procedure Add (T : String) is
      begin
         R (N + 1 .. N + T'Length) := T;
         N := N + T'Length;
      end Add;
   begin
      Add ("[");
      for I in Slot_Id loop
         if I > Slot_Id'First then
            Add (", ");
         end if;
         Add ((1 => Kind_Char (S.Slots (I).Kind)));
         if S.Slots (I).Seq /= 0 then
            Add (Img (Long_Long_Integer (S.Slots (I).Seq)));
         end if;
      end loop;
      Add ("] " & Img (Long_Long_Integer (S.Last_Seq)));
      return R (1 .. N);
   end Show;

   -----------------------------------------------------------------------------------------------
   --  Reading oracle files
   -----------------------------------------------------------------------------------------------

   Line      : String (1 .. 8192);
   Line_Last : Natural;
   Pos       : Natural;

   procedure Start_Line is
   begin
      Pos := 1;
   end Start_Line;

   --  Next whitespace-separated integer of Line.
   function Next return Long_Long_Integer is
      First : Natural;
   begin
      while Pos <= Line_Last and then Line (Pos) = ' ' loop
         Pos := Pos + 1;
      end loop;
      First := Pos;
      while Pos <= Line_Last and then Line (Pos) /= ' ' loop
         Pos := Pos + 1;
      end loop;
      return Long_Long_Integer'Value (Line (First .. Pos - 1));
   end Next;

   --  Next token as a one-letter record tag.
   function Next_Tag return Character is
   begin
      while Line (Pos) = ' ' loop
         Pos := Pos + 1;
      end loop;
      Pos := Pos + 1;
      return Line (Pos - 1);
   end Next_Tag;

   function Next_State return Swap_State is
      S : Swap_State;
   begin
      for I in Slot_Id loop
         S.Slots (I).Kind := Slot_Kind'Val (Next);
         S.Slots (I).Seq := Seq_Number (Next);
      end loop;
      S.Last_Seq := Seq_Number (Next);
      return S;
   end Next_State;

   function Status_Of (N : Long_Long_Integer) return Status_Kind is (Status_Kind'Val (N));

   -----------------------------------------------------------------------------------------------
   --  1. Exhaustive enumeration against the model's transition table
   -----------------------------------------------------------------------------------------------

   type State_Vec is array (Natural range <>) of Swap_State;
   type State_Vec_Access is access State_Vec;

   type Transition is record
      Status : Status_Kind := Ok;
      Slot   : Integer := 0;     --  -1 = none
      Next   : Natural := 0;
   end record;
   type Trans_Vec is array (Natural range <>, Op_Kind range <>) of Transition;
   type Trans_Vec_Access is access Trans_Vec;

   Per_Depth : Count_Array := (others => 0);
   Table_States : State_Vec_Access;
   Table_Trans  : Trans_Vec_Access;
   Path         : array (1 .. 12) of Op_Kind;
   Max_Depth    : Natural;

   procedure Show_Path (D : Natural) is
      Msg : String (1 .. 200);
      N   : Natural := 0;
   begin
      for I in 1 .. D loop
         declare
            T : constant String := Op_Kind'Image (Path (I)) & " ";
         begin
            Msg (N + 1 .. N + T'Length) := T;
            N := N + T'Length;
         end;
      end loop;
      Fail ("  after " & Msg (1 .. N));
   end Show_Path;

   procedure Dfs (State : Swap_State; Model : Natural; Depth : Natural) is
      Next_S : Swap_State;
      St     : Status_Kind;
      Sl     : Slot_Id;
   begin
      if Depth = Max_Depth then
         return;
      end if;
      for Op in Op_Kind loop
         Next_S := State;
         Apply (Op, Next_S, St, Sl);
         Path (Depth + 1) := Op;
         Per_Depth (Depth + 1) := Per_Depth (Depth + 1) + 1;
         declare
            T : Transition renames Table_Trans (Model, Op);
         begin
            if St /= T.Status
              or else (St = Ok and then Integer (Sl) /= T.Slot)
              or else (St /= Ok and then Sl /= Slot_Id'First)
              or else Next_S /= Table_States (T.Next)
            then
               Fail ("enumeration mismatch: got " & Status_Kind'Image (St) & " slot" & Slot_Id'Image (Sl)
                     & " " & Show (Next_S) & ", model " & Status_Kind'Image (T.Status) & " slot"
                     & Integer'Image (T.Slot) & " " & Show (Table_States (T.Next)));
               Show_Path (Depth + 1);
               return;
            end if;
            Dfs (Next_S, T.Next, Depth + 1);
         end;
      end loop;
   end Dfs;

   procedure Exhaustive (File : String; Label : String) is
      F        : File_Type;
      N_States : Natural;
      Expected : Long_Long_Integer := 1;
      Total    : Long_Long_Integer := 0;
   begin
      Open (F, In_File, File);
      Get_Line (F, Line, Line_Last);
      Start_Line;
      if Next_Tag /= 'D' then
         Fail ("bad header in " & File);
      end if;
      while Line (Pos) /= ' ' loop        --  skip rest of the tag "DFS"
         Pos := Pos + 1;
      end loop;
      if Next /= Slot_Count then
         Fail ("slot count differs from the oracle");
      end if;
      declare
         Table_Depth : constant Long_Long_Integer := Next;
      begin
         N_States := Natural (Next);
         if Next /= Long_Long_Integer (Seq_Number'Last) then
            Fail ("sequence maximum differs from the oracle");
         end if;
         if Natural (Table_Depth) < Max_Depth then
            Fail ("oracle table is shallower than the enumeration");
         end if;
      end;
      Table_States := new State_Vec (0 .. N_States - 1);
      Table_Trans := new Trans_Vec (0 .. N_States - 1, Op_Kind'First .. Op_Kind'Last);
      declare
         Idx : Natural := 0;
      begin
         while not End_Of_File (F) loop
            Get_Line (F, Line, Line_Last);
            Start_Line;
            case Next_Tag is
               when 'S' =>
                  Table_States (Idx) := Next_State;
                  Idx := Idx + 1;
               when 'T' =>
                  declare
                     I  : constant Natural := Natural (Next);
                     Op : constant Op_Kind := Op_Kind'Val (Next);
                  begin
                     Table_Trans (I, Op).Status := Status_Of (Next);
                     Table_Trans (I, Op).Slot := Integer (Next);
                     Table_Trans (I, Op).Next := Natural (Next);
                  end;
               when others =>
                  Fail ("bad line in " & File);
            end case;
         end loop;
         if Idx /= N_States then
            Fail ("state count mismatch in " & File);
         end if;
      end;
      Close (F);

      Per_Depth := (others => 0);
      Dfs (Table_States (0), 0, 0);
      for D in 1 .. Max_Depth loop
         Expected := Expected * 5;
         Total := Total + Per_Depth (D);
         if Per_Depth (D) /= Expected then
            Fail ("depth" & Integer'Image (D) & ": visited" & Long_Long_Integer'Image (Per_Depth (D))
                  & " sequences, expected" & Long_Long_Integer'Image (Expected));
         end if;
      end loop;
      Checks := Checks + Total;
      Put_Line ("  " & Label & ": all" & Long_Long_Integer'Image (Total) & " steps of all sequences of length <="
                & Natural'Image (Max_Depth) & " over" & Natural'Image (N_States) & " model states match");
   end Exhaustive;

   -----------------------------------------------------------------------------------------------
   --  2. Bounded state domain: Valid and one step of every operation
   -----------------------------------------------------------------------------------------------

   procedure Domain (File : String) is
      F         : File_Type;
      N_States  : Natural := 0;
      N_Valid   : Natural := 0;
      S, S2, Nx : Swap_State;
      Want_Ok   : Boolean;
      St        : Status_Kind;
      Sl        : Slot_Id;
      Want_St   : Status_Kind;
      Want_Sl   : Integer;
   begin
      Open (F, In_File, File);
      while not End_Of_File (F) loop
         Get_Line (F, Line, Line_Last);
         Start_Line;
         if Next_Tag /= 'V' then
            Fail ("bad line in " & File);
         end if;
         S := Next_State;
         Want_Ok := Next = 1;
         N_States := N_States + 1;
         Checks := Checks + 1;
         if Valid (S) /= Want_Ok then
            Fail ("Valid disagrees with the model on " & Show (S));
         end if;
         if Want_Ok then
            N_Valid := N_Valid + 1;
         end if;
         for Op in Op_Kind loop
            if Want_Ok then
               Want_St := Status_Of (Next);
               Want_Sl := Integer (Next);
               Nx := Next_State;
            else
               Want_St := Corrupt_State;
               Want_Sl := -1;
               Nx := S;
            end if;
            S2 := S;
            Apply (Op, S2, St, Sl);
            Checks := Checks + 1;
            if St /= Want_St
              or else (St = Ok and then Integer (Sl) /= Want_Sl)
              or else (St /= Ok and then Sl /= Slot_Id'First)
              or else S2 /= Nx
            then
               Fail (Op_Kind'Image (Op) & " on " & Show (S) & ": got " & Status_Kind'Image (St)
                     & " " & Show (S2) & ", model " & Status_Kind'Image (Want_St) & " " & Show (Nx));
            end if;
         end loop;
      end loop;
      Close (F);
      Put_Line ("  domain:" & Natural'Image (N_States) & " states (" & Natural'Image (N_Valid)
                & " valid): Valid and all 5 operations match the model on every one");
   end Domain;

   -----------------------------------------------------------------------------------------------
   --  3. Directed scenarios
   -----------------------------------------------------------------------------------------------

   Cur : Swap_State := Initial;

   procedure Step (Op : Op_Kind; Want : Status_Kind; Want_Slot : Slot_Id; Want_State : String) is
      St : Status_Kind;
      Sl : Slot_Id;
   begin
      Checks := Checks + 1;
      Apply (Op, Cur, St, Sl);
      if St /= Want or else Sl /= Want_Slot or else Show (Cur) /= Want_State then
         Fail (Op_Kind'Image (Op) & ": got " & Status_Kind'Image (St) & " slot" & Slot_Id'Image (Sl) & " "
               & Show (Cur) & ", wanted " & Status_Kind'Image (Want) & " slot" & Slot_Id'Image (Want_Slot)
               & " " & Want_State);
      end if;
   end Step;

   procedure Scenarios is
      Max : constant String := Img (Long_Long_Integer (Seq_Number'Last));
      Pre : constant String := Img (Long_Long_Integer (Seq_Number'Last) - 1);
   begin
      --  A full life of the protocol: the producer is never blocked, the consumer gets the newest.
      Cur := Initial;
      Step (Acquire_Op, Nothing_New, 0, "[F, F, F] 0");
      Step (Release_Op, Not_In_Use, 0, "[F, F, F] 0");
      Step (Publish_Op, Not_Writing, 0, "[F, F, F] 0");
      Step (Abort_Op, Not_Writing, 0, "[F, F, F] 0");
      Step (Begin_Op, Ok, 0, "[W, F, F] 0");
      Step (Begin_Op, Already_Writing, 0, "[W, F, F] 0");
      Step (Acquire_Op, Nothing_New, 0, "[W, F, F] 0");        --  a slot being written is invisible
      Step (Publish_Op, Ok, 0, "[P1, F, F] 1");
      Step (Abort_Op, Not_Writing, 0, "[P1, F, F] 1");
      Step (Begin_Op, Ok, 1, "[P1, W, F] 1");                  --  never the waiting slot 0
      Step (Acquire_Op, Ok, 0, "[U1, W, F] 1");
      Step (Acquire_Op, Already_In_Use, 0, "[U1, W, F] 1");
      Step (Publish_Op, Ok, 1, "[U1, P2, F] 2");
      Step (Begin_Op, Ok, 2, "[U1, P2, W] 2");                 --  never the consumer's slot 0
      Step (Publish_Op, Ok, 2, "[U1, F, P3] 3");               --  P2 superseded, its slot is Free
      Step (Begin_Op, Ok, 1, "[U1, W, P3] 3");
      Step (Abort_Op, Ok, 1, "[U1, F, P3] 3");
      Step (Release_Op, Ok, 0, "[F, F, P3] 3");
      Step (Acquire_Op, Ok, 2, "[F, F, U3] 3");                --  the newest
      Step (Release_Op, Ok, 2, "[F, F, F] 3");
      Step (Acquire_Op, Nothing_New, 0, "[F, F, F] 3");
      Step (Release_Op, Not_In_Use, 0, "[F, F, F] 3");
      Step (Begin_Op, Ok, 0, "[W, F, F] 3");
      Step (Publish_Op, Ok, 0, "[P4, F, F] 4");

      --  Sequence-number saturation: the last number is handed out, then publishing is refused.
      Cur := (Slots => (others => (Kind => Free, Seq => 0)), Last_Seq => Seq_Number'Last - 1);
      Step (Begin_Op, Ok, 0, "[W, F, F] " & Pre);
      Step (Publish_Op, Ok, 0, "[P" & Max & ", F, F] " & Max);
      Step (Begin_Op, Ok, 1, "[P" & Max & ", W, F] " & Max);
      Step (Publish_Op, Seq_Exhausted, 0, "[P" & Max & ", W, F] " & Max);
      Step (Publish_Op, Seq_Exhausted, 0, "[P" & Max & ", W, F] " & Max);
      Step (Abort_Op, Ok, 1, "[P" & Max & ", F, F] " & Max);
      Step (Acquire_Op, Ok, 0, "[U" & Max & ", F, F] " & Max);
      Step (Begin_Op, Ok, 1, "[U" & Max & ", W, F] " & Max);
      Step (Publish_Op, Seq_Exhausted, 0, "[U" & Max & ", W, F] " & Max);
      Step (Release_Op, Ok, 0, "[F, W, F] " & Max);

      --  Corrupt states are refused untouched by every operation.
      declare
         Bad : constant array (1 .. 6) of Swap_State :=
           (1 => (Slots => ((Writing, 0), (Writing, 0), (Free, 0)), Last_Seq => 0),        --  two writers
            2 => (Slots => ((In_Use, 2), (Published, 2), (Free, 0)), Last_Seq => 2),       --  same number
            3 => (Slots => ((Free, 5), (Free, 0), (Free, 0)), Last_Seq => 5),              --  Free with a number
            4 => (Slots => ((Published, 1), (Free, 0), (Free, 0)), Last_Seq => 2),         --  waiting, not newest
            5 => (Slots => ((In_Use, 3), (Free, 0), (Free, 0)), Last_Seq => 2),            --  number > Last_Seq
            6 => (Slots => ((In_Use, 1), (In_Use, 2), (In_Use, 3)), Last_Seq => 3));       --  three held
      begin
         for B of Bad loop
            if Valid (B) then
               Fail ("corrupt state accepted: " & Show (B));
            end if;
            for Op in Op_Kind loop
               Cur := B;
               Step (Op, Corrupt_State, 0, Show (B));
            end loop;
         end loop;
      end;
   end Scenarios;

   -----------------------------------------------------------------------------------------------
   --  4. Long random walk against an independent shadow model
   -----------------------------------------------------------------------------------------------

   procedure Random_Walk (Steps : Long_Long_Integer) is
      type U64 is mod 2 ** 64;
      Rng : U64 := 16#9E3779B97F4A7C15#;

      function Rand (N : Positive) return Natural is
      begin
         Rng := Rng xor (Rng * 2 ** 13);
         Rng := Rng xor (Rng / 2 ** 7);
         Rng := Rng xor (Rng * 2 ** 17);
         return Natural ((Rng / 2 ** 11) mod U64 (N));
      end Rand;

      --  Shadow: roles as plain variables (slot = -1: none).
      Writer, Waiting, Reader : Integer := -1;
      Published_Count         : Long_Long_Integer := 0;
      Last_Acquired           : Long_Long_Integer := 0;
      Seen                    : array (Status_Kind) of Long_Long_Integer := (others => 0);
      S                       : Swap_State := Initial;
      Before                  : Swap_State;
      St                      : Status_Kind;
      Sl                      : Slot_Id;
      Op                      : Op_Kind;
      Want                    : Status_Kind;
   begin
      for N in 1 .. Steps loop
         Op := Op_Kind'Val (Rand (5));
         Before := S;
         Apply (Op, S, St, Sl);
         Seen (St) := Seen (St) + 1;
         case Op is
            when Begin_Op =>
               Want := (if Writer >= 0 then Already_Writing else Ok);
            when Publish_Op | Abort_Op =>
               Want := (if Writer < 0 then Not_Writing else Ok);
            when Acquire_Op =>
               Want := (if Reader >= 0 then Already_In_Use elsif Waiting < 0 then Nothing_New else Ok);
            when Release_Op =>
               Want := (if Reader < 0 then Not_In_Use else Ok);
         end case;
         if St /= Want then
            Fail ("walk step" & Long_Long_Integer'Image (N) & ": " & Op_Kind'Image (Op) & " gave "
                  & Status_Kind'Image (St) & ", shadow says " & Status_Kind'Image (Want));
            return;
         end if;
         if St /= Ok then
            if S /= Before or else Sl /= Slot_Id'First then
               Fail ("walk: a refused operation changed something");
               return;
            end if;
         else
            case Op is
               when Begin_Op =>
                  --  never the slot the consumer holds, never the waiting one
                  if Integer (Sl) = Reader or else Integer (Sl) = Waiting then
                     Fail ("walk: Begin handed out an occupied slot");
                     return;
                  end if;
                  Writer := Integer (Sl);
               when Publish_Op =>
                  if Integer (Sl) /= Writer then
                     Fail ("walk: Publish published a slot not being written");
                     return;
                  end if;
                  Published_Count := Published_Count + 1;
                  if Long_Long_Integer (S.Last_Seq) /= Published_Count
                    or else Long_Long_Integer (S.Slots (Sl).Seq) /= Published_Count
                  then
                     Fail ("walk: sequence numbers are not 1, 2, 3, ...");
                     return;
                  end if;
                  Waiting := Writer;
                  Writer := -1;
               when Abort_Op =>
                  if Integer (Sl) /= Writer then
                     Fail ("walk: Abort aborted a slot not being written");
                     return;
                  end if;
                  Writer := -1;
               when Acquire_Op =>
                  if Integer (Sl) /= Waiting or else Integer (Sl) = Writer then
                     Fail ("walk: Acquire took a slot that is not the waiting one");
                     return;
                  end if;
                  if Long_Long_Integer (S.Slots (Sl).Seq) /= Published_Count
                    or else Long_Long_Integer (S.Slots (Sl).Seq) <= Last_Acquired
                  then
                     Fail ("walk: Acquire did not return the newest, strictly newer snapshot");
                     return;
                  end if;
                  Last_Acquired := Long_Long_Integer (S.Slots (Sl).Seq);
                  Reader := Integer (Sl);
                  Waiting := -1;
               when Release_Op =>
                  if Integer (Sl) /= Reader then
                     Fail ("walk: Release released a slot that is not held");
                     return;
                  end if;
                  Reader := -1;
            end case;
         end if;
         if not Valid (S) then
            Fail ("walk: state became invalid: " & Show (S));
            return;
         end if;
      end loop;
      for K in Status_Kind loop
         if Seen (K) = 0 and then K not in Seq_Exhausted | Corrupt_State then
            Fail ("walk never produced " & Status_Kind'Image (K));
         end if;
      end loop;
      Checks := Checks + Steps;
      Put_Line ("  random walk:" & Long_Long_Integer'Image (Steps) & " steps, shadow model agrees, "
                & Img (Published_Count) & " snapshots published, "
                & Img (Seen (Nothing_New)) & " Nothing_New, "
                & Img (Seen (Already_Writing) + Seen (Not_Writing) + Seen (Already_In_Use) + Seen (Not_In_Use))
                & " refused misuses");
   end Random_Walk;

begin
   if Ada.Command_Line.Argument_Count /= 2 then
      Put_Line ("usage: test_swap DIR fast|contracts");
      Ada.Command_Line.Set_Exit_Status (2);
      return;
   end if;
   declare
      Dir  : constant String := Ada.Command_Line.Argument (1);
      Fast : constant Boolean := Ada.Command_Line.Argument (2) = "fast";
   begin
      Put_Line ("== snapshot_swap tests (" & Ada.Command_Line.Argument (2) & ") ==");
      Max_Depth := (if Fast then 10 else 7);
      Exhaustive (Dir & "/dfs_init.txt", "from Initial");
      Exhaustive (Dir & "/dfs_near_max.txt", "from Last_Seq = max - 2");
      Domain (Dir & "/states.txt");
      Scenarios;
      Put_Line ("  directed scenarios done");
      Random_Walk (if Fast then 5_000_000 else 50_000);
   end;
   Put_Line ("checks:" & Long_Long_Integer'Image (Checks) & ", failures:" & Natural'Image (Failures));
   if Failures = 0 then
      Put_Line ("PASS");
   else
      Put_Line ("FAIL");
      Ada.Command_Line.Set_Exit_Status (1);
   end if;
end Test_Swap;

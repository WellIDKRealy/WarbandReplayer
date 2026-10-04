--  Loader_Lifecycle.Job: the load job as ONE state machine, driven one event at a time.
--
--      Idle --Start--> Loading(Opening) -> Loading(Validating) -> Loading(Finding_Battles) -> Loading(Opening_Battle)
--                         Phase_Done          Phase_Done               Phase_Done          --Complete--> Ready
--
--  Cancel -> Cancelled, Fail(kind) -> Failed(kind), Watchdog_Timeout -> Failed(Worker_Died), Reset -> Idle.
--  Apply is total: every state and every event gives an explicit Outcome, and an Ignored or Illegal
--  event leaves the state exactly as it was.  The single table below is what the unit proves.
--  README.md has the same table in words; PROOF.md the proof summary.
package Loader_Lifecycle.Job
  with SPARK_Mode, Pure
is
   --  Counters are exact integers in 0 .. 2**53 - 1 (what a JS Number carries without loss).
   Max_Count : constant := 2 ** 53 - 1;
   subtype Count is Long_Long_Integer range 0 .. Max_Count;

   --  The stages of a load, always in this order, none skipped.
   type Phase is (Opening, Validating, Finding_Battles, Opening_Battle);

   type State_Kind is (Idle, Loading, Ready, Failed, Cancelled);

   --  Loading carries the real counters of the current phase (done <= total, by construction).
   type State (Kind : State_Kind := Idle) is record
      case Kind is
         when Loading =>
            Step  : Phase := Phase'First;
            Done  : Count := 0;
            Total : Count := 0;   --  0 = not announced yet
         when Failed =>
            Error : Failure_Kind := Internal;
         when Idle | Ready | Cancelled =>
            null;
      end case;
   end record
   with Dynamic_Predicate => (if Kind = Loading then Done <= Total);

   Initial : constant State := (Kind => Idle);
   Started : constant State := (Kind => Loading, Step => Phase'First, Done => 0, Total => 0);

   type Event_Kind is
     (Start,             --  the user chose a file
      Progress,          --  a worker reports Done of Total units in phase Step
      Phase_Done,        --  phase Step finished
      Complete,          --  the last phase finished: the first battle is open
      Fail,              --  something broke: Error says what (Cancelled_By_User counts as Cancel)
      Cancel,            --  the user pressed cancel
      Reset,             --  back to the start screen, from anywhere
      Watchdog_Timeout); --  the driver's timer: no accepted progress for too long

   --  Only the fields named in the Event_Kind comments are read; any 64-bit Done / Total is judged.
   type Event is record
      Kind  : Event_Kind;
      Step  : Phase := Phase'First;
      Done  : Long_Long_Integer := 0;
      Total : Long_Long_Integer := 0;
      Error : Error_Kind := Internal;
   end record;

   --  A progress report that cannot be true: a counter outside 0 .. Max_Count, or Done above Total.
   function Bad_Counters (E : Event) return Boolean is
     (E.Done not in Count or else E.Total not in Count or else E.Done > E.Total);

   --  Overall bar, 0 .. 1000: a quarter per phase plus the current phase's share (Done / Total).
   --  Capped at 999 while Loading: it reads 1000 only when Ready.
   subtype Permille is Integer range 0 .. 1000;

   function Progress_Permille (S : State) return Permille is
     (case S.Kind is
        when Ready                    => 1000,
        when Idle | Failed | Cancelled => 0,
        when Loading                  =>
          Integer'Min (999, (Phase'Pos (S.Step) * 1000
                             + (if S.Total = 0 then 0 else Integer (1000 * S.Done / S.Total))) / 4));

   procedure Apply (S : in out State; E : Event; R : out Outcome)
   with
     Global => null,
     Post   =>
       --  THE TABLE.  Within a row, the first line that matches decides.
       (case E.Kind is
          when Start =>
            --  a new job starts only when nothing is loaded or live (Ready needs an explicit Reset)
            (if S'Old.Kind in Idle | Failed | Cancelled then R = Applied and S = Started
             else R = Illegal and S = S'Old),
          when Progress =>
            (if S'Old.Kind /= Loading then R = Ignored and S = S'Old                  --  nothing is loading
             elsif Bad_Counters (E) or else E.Step > S'Old.Step                       --  impossible, or a phase not started
             then R = Illegal and S = S'Old
             elsif E.Step < S'Old.Step then R = Ignored and S = S'Old                 --  late report of an earlier phase
             elsif S'Old.Total /= 0 and then E.Total /= S'Old.Total                   --  the total is fixed once announced
             then R = Illegal and S = S'Old
             elsif E.Done < S'Old.Done                                                --  late or repeated: never go back
               or else (E.Done = S'Old.Done and E.Total = S'Old.Total)
             then R = Ignored and S = S'Old
             else R = Applied
                  and S = (Kind => Loading, Step => E.Step, Done => E.Done, Total => E.Total)),
          when Phase_Done =>
            (if S'Old.Kind /= Loading then R = Ignored and S = S'Old
             elsif E.Step > S'Old.Step then R = Illegal and S = S'Old
             elsif E.Step < S'Old.Step then R = Ignored and S = S'Old                 --  a repeat cannot skip a phase
             elsif S'Old.Step = Phase'Last                                            --  the last phase ends with Complete
               or else S'Old.Done /= S'Old.Total                                      --  work still outstanding
             then R = Illegal and S = S'Old
             else R = Applied
                  and S = (Kind => Loading, Step => Phase'Succ (S'Old.Step), Done => 0, Total => 0)),
          when Complete =>
            (if S'Old.Kind /= Loading then R = Ignored and S = S'Old
             elsif S'Old.Step = Phase'Last and then S'Old.Done = S'Old.Total
             then R = Applied and S = (Kind => Ready)
             else R = Illegal and S = S'Old),
          when Fail =>
            (if E.Error = Cancelled_By_User                                           --  exactly like Cancel
             then (if S'Old.Kind = Loading then R = Applied and S = (Kind => Cancelled)
                   else R = Ignored and S = S'Old)
             elsif S'Old.Kind in Loading | Ready                                      --  a worker may die after Ready too
             then R = Applied and S = (Kind => Failed, Error => E.Error)
             else R = Ignored and S = S'Old),                                         --  the first failure is kept
          when Cancel =>
            (if S'Old.Kind = Loading then R = Applied and S = (Kind => Cancelled)
             else R = Ignored and S = S'Old),
          when Reset =>
            (if S'Old.Kind = Idle then R = Ignored and S = S'Old
             else R = Applied and S = (Kind => Idle)),
          when Watchdog_Timeout =>
            (if S'Old.Kind = Loading then R = Applied and S = (Kind => Failed, Error => Worker_Died)
             else R = Ignored and S = S'Old))
       --  Properties that follow from the table (each is proved on its own as well):
       --  (1) Applied means changed, nothing else changes the state.
       and then (R = Applied) = (S /= S'Old)
       --  (2) Inside a phase the counters never go back and the total stays; a phase is left only when complete.
       and then (if S'Old.Kind = Loading and S.Kind = Loading
                 then (if S.Step = S'Old.Step
                       then S.Done >= S'Old.Done and (S'Old.Total = 0 or else S.Total = S'Old.Total)
                       else Phase'Pos (S.Step) = Phase'Pos (S'Old.Step) + 1
                            and S'Old.Done = S'Old.Total))
       --  (3) Ready is entered only by Complete, from the last phase with Done = Total.
       and then (if S.Kind = Ready and S'Old.Kind /= Ready
                 then E.Kind = Complete and then S'Old.Kind = Loading
                      and then S'Old.Step = Phase'Last and then S'Old.Done = S'Old.Total)
       --  (4) Only Start and Reset leave Failed and Cancelled.
       and then (if S'Old.Kind in Failed | Cancelled and E.Kind not in Start | Reset then S = S'Old)
       --  (5) A silent worker ends Loading in one step, and Cancel and Reset always get out of Loading.
       and then (if S'Old.Kind = Loading
                 then (if E.Kind = Watchdog_Timeout then S = (Kind => Failed, Error => Worker_Died))
                      and (if E.Kind = Cancel then S = (Kind => Cancelled))
                      and (if E.Kind = Reset then S = (Kind => Idle)))
       --  (6) The bar never goes back while loading, and is full only when Ready.
       and then (if S'Old.Kind = Loading and S.Kind in Loading | Ready
                 then Progress_Permille (S) >= Progress_Permille (S'Old))
       and then (Progress_Permille (S) = 1000) = (S.Kind = Ready);

end Loader_Lifecycle.Job;

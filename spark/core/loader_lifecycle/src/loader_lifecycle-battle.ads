--  Loader_Lifecycle.Battle: the status of ONE battle in the timeline, and the "may a frame be drawn" rule.
--
--      Not_Opened --Open--> Extracting --Extracted--> Ready        (Fail(kind) -> Damaged(kind), from Extracting or Ready)
--      Ready | Damaged --Re_Extract--> Extracting                  (the only way out of Damaged, besides Reset)
--
--  Same rules as Loader_Lifecycle.Job: Apply is total, an Ignored or Illegal event leaves the status as it
--  was, and the table below is what the unit proves.  Fail(Cancelled_By_User) counts as Cancel.
package Loader_Lifecycle.Battle
  with SPARK_Mode, Pure
is
   type Status_Kind is
     (Not_Opened,   --  nothing extracted yet
      Extracting,   --  being built from the source
      Ready,        --  extracted and validated: playable
      Damaged);     --  extraction or a later read failed: stays visible, never played

   type Status (Kind : Status_Kind := Not_Opened) is record
      case Kind is
         when Damaged =>
            Reason : Failure_Kind := Internal;
         when Not_Opened | Extracting | Ready =>
            null;
      end case;
   end record;

   type Event_Kind is
     (Open,         --  first request for this battle
      Re_Extract,   --  explicit "extract again" of a Ready or Damaged battle
      Extracted,    --  the extraction finished and validated
      Fail,         --  extraction or a later read failed: Reason says why
      Cancel,       --  the extraction was cancelled
      Reset);       --  the workspace was reset: forget everything

   --  Reason is read only for Fail.
   type Event is record
      Kind   : Event_Kind;
      Reason : Error_Kind := Internal;
   end record;

   procedure Apply (B : in out Status; E : Event; R : out Outcome)
   with
     Global => null,
     Post   =>
       --  THE TABLE.  Within a row, the first line that matches decides.
       (case E.Kind is
          when Open =>
            (if B'Old.Kind = Not_Opened then R = Applied and B = (Kind => Extracting)
             elsif B'Old.Kind = Damaged then R = Illegal and B = B'Old        --  a damaged battle is re-extracted explicitly
             else R = Ignored and B = B'Old),                                 --  already extracting or ready
          when Re_Extract =>
            (if B'Old.Kind in Ready | Damaged then R = Applied and B = (Kind => Extracting)
             elsif B'Old.Kind = Not_Opened then R = Illegal and B = B'Old     --  nothing to extract again: use Open
             else R = Ignored and B = B'Old),                                 --  already extracting
          when Extracted =>
            (if B'Old.Kind = Extracting then R = Applied and B = (Kind => Ready)
             else R = Ignored and B = B'Old),                                 --  stale result
          when Fail =>
            (if E.Reason = Cancelled_By_User                                  --  exactly like Cancel
             then (if B'Old.Kind = Extracting then R = Applied and B = (Kind => Not_Opened)
                   else R = Ignored and B = B'Old)
             elsif B'Old.Kind in Extracting | Ready                           --  a Ready battle can turn out damaged later
             then R = Applied and B = (Kind => Damaged, Reason => E.Reason)
             else R = Ignored and B = B'Old),                                 --  the first damage reason is kept
          when Cancel =>
            (if B'Old.Kind = Extracting then R = Applied and B = (Kind => Not_Opened)
             else R = Ignored and B = B'Old),
          when Reset =>
            (if B'Old.Kind = Not_Opened then R = Ignored and B = B'Old
             else R = Applied and B = (Kind => Not_Opened)))
       --  Properties that follow from the table (each is proved on its own as well):
       --  (1) Applied means changed, nothing else changes the status.
       and then (R = Applied) = (B /= B'Old)
       --  (2) Ready is entered only from Extracting, by Extracted.
       and then (if B.Kind = Ready and B'Old.Kind /= Ready
                 then E.Kind = Extracted and B'Old.Kind = Extracting)
       --  (3) Extracting is entered only by Open (from Not_Opened) or Re_Extract (from Ready or Damaged).
       and then (if B.Kind = Extracting and B'Old.Kind /= Extracting
                 then (E.Kind = Open and B'Old.Kind = Not_Opened)
                      or (E.Kind = Re_Extract and B'Old.Kind in Ready | Damaged))
       --  (4) Only Re_Extract and Reset leave Damaged.
       and then (if B'Old.Kind = Damaged and E.Kind not in Re_Extract | Reset then B = B'Old)
       --  (5) Cancel and Reset always get out of Extracting.
       and then (if B'Old.Kind = Extracting and E.Kind in Cancel | Reset then B.Kind = Not_Opened);

   --  A frame may be drawn only when the job is Ready AND this battle is Ready: never while loading,
   --  extracting, damaged, failed or cancelled.
   function May_Draw (J : Job.State; B : Status) return Boolean is
     (J.Kind = Job.Ready and then B.Kind = Ready);

end Loader_Lifecycle.Battle;

package body Loader_Lifecycle.Job
  with SPARK_Mode
is
   procedure Apply (S : in out State; E : Event; R : out Outcome) is
   begin
      R := Ignored;
      case E.Kind is
         when Start =>
            if S.Kind in Idle | Failed | Cancelled then
               S := Started;
               R := Applied;
            else
               R := Illegal;
            end if;

         when Progress =>
            if S.Kind = Loading then
               if Bad_Counters (E) or else E.Step > S.Step then
                  R := Illegal;
               elsif E.Step < S.Step then
                  null;
               elsif S.Total /= 0 and then E.Total /= S.Total then
                  R := Illegal;
               elsif E.Done < S.Done or else (E.Done = S.Done and E.Total = S.Total) then
                  null;
               else
                  S := (Kind => Loading, Step => E.Step, Done => E.Done, Total => E.Total);
                  R := Applied;
               end if;
            end if;

         when Phase_Done =>
            if S.Kind = Loading then
               if E.Step > S.Step then
                  R := Illegal;
               elsif E.Step < S.Step then
                  null;
               elsif S.Step = Phase'Last or else S.Done /= S.Total then
                  R := Illegal;
               else
                  S := (Kind => Loading, Step => Phase'Succ (S.Step), Done => 0, Total => 0);
                  R := Applied;
               end if;
            end if;

         when Complete =>
            if S.Kind = Loading then
               if S.Step = Phase'Last and then S.Done = S.Total then
                  S := (Kind => Ready);
                  R := Applied;
               else
                  R := Illegal;
               end if;
            end if;

         when Fail =>
            if E.Error = Cancelled_By_User then
               if S.Kind = Loading then
                  S := (Kind => Cancelled);
                  R := Applied;
               end if;
            elsif S.Kind in Loading | Ready then
               S := (Kind => Failed, Error => E.Error);
               R := Applied;
            end if;

         when Cancel =>
            if S.Kind = Loading then
               S := (Kind => Cancelled);
               R := Applied;
            end if;

         when Reset =>
            if S.Kind /= Idle then
               S := (Kind => Idle);
               R := Applied;
            end if;

         when Watchdog_Timeout =>
            if S.Kind = Loading then
               S := (Kind => Failed, Error => Worker_Died);
               R := Applied;
            end if;
      end case;
   end Apply;

end Loader_Lifecycle.Job;

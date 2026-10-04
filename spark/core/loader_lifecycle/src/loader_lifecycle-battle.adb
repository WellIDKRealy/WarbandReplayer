package body Loader_Lifecycle.Battle
  with SPARK_Mode
is
   procedure Apply (B : in out Status; E : Event; R : out Outcome) is
   begin
      R := Ignored;
      case E.Kind is
         when Open =>
            if B.Kind = Not_Opened then
               B := (Kind => Extracting);
               R := Applied;
            elsif B.Kind = Damaged then
               R := Illegal;
            end if;

         when Re_Extract =>
            if B.Kind in Ready | Damaged then
               B := (Kind => Extracting);
               R := Applied;
            elsif B.Kind = Not_Opened then
               R := Illegal;
            end if;

         when Extracted =>
            if B.Kind = Extracting then
               B := (Kind => Ready);
               R := Applied;
            end if;

         when Fail =>
            if E.Reason = Cancelled_By_User then
               if B.Kind = Extracting then
                  B := (Kind => Not_Opened);
                  R := Applied;
               end if;
            elsif B.Kind in Extracting | Ready then
               B := (Kind => Damaged, Reason => E.Reason);
               R := Applied;
            end if;

         when Cancel =>
            if B.Kind = Extracting then
               B := (Kind => Not_Opened);
               R := Applied;
            end if;

         when Reset =>
            if B.Kind /= Not_Opened then
               B := (Kind => Not_Opened);
               R := Applied;
            end if;
      end case;
   end Apply;

end Loader_Lifecycle.Battle;

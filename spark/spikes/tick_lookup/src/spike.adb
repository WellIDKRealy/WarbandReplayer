package body Spike with SPARK_Mode is
   function Last_At_Or_Before (T : Times; X : Long_Long_Integer) return Index is
      Lo : Index := T'First - 1;   --  T(Lo) <= X, or Lo = T'First - 1
      Hi : Index := T'Last + 1;    --  T(Hi) >  X, or Hi = T'Last + 1
   begin
      while Hi - Lo > 1 loop
         pragma Loop_Invariant (Lo >= T'First - 1 and Hi <= T'Last + 1 and Lo < Hi);
         pragma Loop_Invariant (if Lo >= T'First then T (Lo) <= X);
         pragma Loop_Invariant (if Hi <= T'Last then T (Hi) > X);
         pragma Loop_Variant (Decreases => Hi - Lo);
         declare
            Mid : constant Index := Lo + (Hi - Lo) / 2;
         begin
            if T (Mid) <= X then
               Lo := Mid;
            else
               Hi := Mid;
            end if;
         end;
      end loop;
      return Lo;
   end Last_At_Or_Before;
end Spike;

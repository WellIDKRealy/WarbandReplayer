package body Tar_Layout
  with SPARK_Mode => On
is

   function Grown_Capacity (Capacity : Count; Needed : Count) return Long_Long_Integer is
      Start : constant Count := (if Capacity = 0 then Initial_Capacity else Capacity);
      Cap   : Long_Long_Integer := Start;
   begin
      if Needed <= Capacity then
         return Capacity;
      end if;
      while Cap < Needed loop
         pragma Loop_Invariant (Cap >= Start);
         pragma Loop_Invariant (Is_Doubling_Of (Cap, Start));
         pragma Loop_Invariant (Cap = Start or else Cap / 2 < Needed);
         pragma Loop_Variant (Increases => Cap);
         Cap := Cap * 2;
      end loop;
      return Cap;
   end Grown_Capacity;

end Tar_Layout;

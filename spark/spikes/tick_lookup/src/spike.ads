package Spike with SPARK_Mode is
   type Index is range -1 .. 1_000_001;
   subtype Valid_Index is Index range 0 .. 1_000_000;
   type Times is array (Valid_Index range <>) of Long_Long_Integer;

   function Sorted (T : Times) return Boolean is
     (for all I in T'Range => (if I < T'Last then T (I) <= T (I + 1)))
   with Ghost;

   --  Greatest I with T(I) <= X; T'First - 1 if there is none.
   function Last_At_Or_Before (T : Times; X : Long_Long_Integer) return Index
     with Pre  => T'Length > 0 and then Sorted (T),
          Post => Last_At_Or_Before'Result in T'First - 1 .. T'Last
                  and then (if Last_At_Or_Before'Result >= T'First then
                              T (Last_At_Or_Before'Result) <= X)
                  and then (if Last_At_Or_Before'Result < T'Last then
                              T (Last_At_Or_Before'Result + 1) > X);
end Spike;

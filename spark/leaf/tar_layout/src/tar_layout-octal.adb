package body Tar_Layout.Octal
  with SPARK_Mode => On
is

   ---------------------------------------------------------------------------
   --  Ghost lemmas
   ---------------------------------------------------------------------------

   procedure Lemma_Pow8_Succ (N : Natural) is
   begin
      null;
   end Lemma_Pow8_Succ;

   procedure Lemma_Pow8_Mono (A : Natural; B : Natural) is
   begin
      if A < B then
         Lemma_Pow8_Mono (A, B - 1);
         Lemma_Pow8_Succ (B - 1);
      end if;
   end Lemma_Pow8_Mono;

   procedure Lemma_Pow8_Wire is
   begin
      null;
   end Lemma_Pow8_Wire;

   procedure Lemma_Shift_Succ (V : Count; N : Natural) is
   begin
      if N > 0 then
         Lemma_Shift_Succ (V / 8, N - 1);
      end if;
   end Lemma_Shift_Succ;

   procedure Lemma_Shift_Zero (V : Count; N : Natural) is
   begin
      if N > 0 then
         Lemma_Shift_Zero (V / 8, N - 1);
         Lemma_Pow8_Succ (N - 1);
      end if;
   end Lemma_Shift_Zero;

   procedure Lemma_Val_Of_Field (F : Byte_Array; V : Count) is
      D : constant Natural := Natural (F'Length) - 1;
      K : Natural := 0;
   begin
      Lemma_Shift_Zero (V, D);
      while K < D loop
         pragma Loop_Invariant (K <= D);
         pragma Loop_Invariant (Val (F, F'First, Count (K)) = Shift (V, D - K));
         Lemma_Shift_Succ (V, D - K - 1);
         pragma Assert (Is_Digit (F (F'First + Count (K))));
         pragma Assert (F (F'First + Count (K)) = Digit_Byte (V, D - 1 - K));
         K := K + 1;
      end loop;
   end Lemma_Val_Of_Field;

   procedure Lemma_Round_Trip (F : Byte_Array; V : Count) is
      R : constant Octal_Result := Get_Octal (F);
   begin
      Lemma_Val_Of_Field (F, V);
      pragma Assert (R.Ok);
      pragma Assert (Decodes (F, R.Value));
      pragma Assert (R.Value = V);
   end Lemma_Round_Trip;

   ---------------------------------------------------------------------------
   --  Put_Octal (old octal_field)
   ---------------------------------------------------------------------------

   procedure Put_Octal (F : in out Byte_Array; V : Count; Ok : out Boolean) is
      D : constant Natural := Natural (F'Length) - 1;
      R : Count := V;
      I : Natural := 0;
   begin
      --  fit test first, so that a value that does not fit leaves F untouched
      while I < D loop
         pragma Loop_Invariant (I <= D);
         pragma Loop_Invariant (R = Shift (V, I));
         Lemma_Shift_Succ (V, I);
         R := R / 8;
         I := I + 1;
      end loop;
      Lemma_Shift_Zero (V, D);
      Ok := R = 0;
      if not Ok then
         return;
      end if;

      F (F'Last) := 0;
      R := V;
      I := 0;
      while I < D loop
         pragma Loop_Invariant (I <= D);
         pragma Loop_Invariant (R = Shift (V, I));
         pragma Loop_Invariant (F (F'Last) = 0);
         pragma Loop_Invariant
           (for all J in Count range 0 .. Count (I) - 1 =>
              F (F'Last - 1 - J) = Digit_Byte (V, Natural (J)));
         F (F'Last - 1 - Count (I)) := Byte (48 + R mod 8);
         Lemma_Shift_Succ (V, I);
         R := R / 8;
         I := I + 1;
      end loop;
   end Put_Octal;

   ---------------------------------------------------------------------------
   --  Get_Octal (old parseOctalField)
   ---------------------------------------------------------------------------

   function Get_Octal (F : Byte_Array) return Octal_Result is
      D : Count := 0;
   begin
      while D < F'Length and then not Is_Terminator (F (F'First + D)) loop
         pragma Loop_Invariant (D <= F'Length);
         pragma Loop_Invariant
           (for all J in Count range 0 .. D - 1 => Is_Digit (F (F'First + J)));
         pragma Loop_Variant (Increases => D);
         if not Is_Digit (F (F'First + D)) then
            return (Ok => False, Value => 0);
         end if;
         D := D + 1;
      end loop;

      declare
         Acc : Count := 0;
         K   : Count := 0;
      begin
         while K < D loop
            pragma Loop_Invariant (K <= D);
            pragma Loop_Invariant (Acc = Val (F, F'First, K));
            pragma Loop_Invariant (Acc < Pow8 (Natural (K)));
            pragma Loop_Variant (Increases => K);
            Acc := 8 * Acc + (Count (F (F'First + K)) - 48);
            K := K + 1;
         end loop;
         Lemma_Pow8_Mono (Natural (D), Natural (F'Length));
         return (Ok => True, Value => Acc);
      end;
   end Get_Octal;

end Tar_Layout.Octal;

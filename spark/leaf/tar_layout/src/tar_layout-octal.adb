package body Tar_Layout.Octal
  with SPARK_Mode => On
is

   ---------------------------------------------------------------------------
   --  Ghost specification bodies and lemmas
   ---------------------------------------------------------------------------

   function Val (F : Byte_Array; First : Count; N : Count) return Count is
   begin
      if N = 0 then
         return 0;
      end if;
      declare
         Prev : constant Count := Val (F, First, N - 1);
      begin
         Lemma_Pow8_Succ (Natural (N) - 1);
         return 8 * Prev + (Count (F (First + (N - 1))) - 48);
      end;
   end Val;

   procedure Lemma_Pow8_Succ (N : Natural) is
   begin
      case N is
         when 0 => pragma Assert (Pow8 (1) = 8 * Pow8 (0));
         when 1 => pragma Assert (Pow8 (2) = 8 * Pow8 (1));
         when 2 => pragma Assert (Pow8 (3) = 8 * Pow8 (2));
         when 3 => pragma Assert (Pow8 (4) = 8 * Pow8 (3));
         when 4 => pragma Assert (Pow8 (5) = 8 * Pow8 (4));
         when 5 => pragma Assert (Pow8 (6) = 8 * Pow8 (5));
         when 6 => pragma Assert (Pow8 (7) = 8 * Pow8 (6));
         when 7 => pragma Assert (Pow8 (8) = 8 * Pow8 (7));
         when 8 => pragma Assert (Pow8 (9) = 8 * Pow8 (8));
         when 9 => pragma Assert (Pow8 (10) = 8 * Pow8 (9));
         when 10 => pragma Assert (Pow8 (11) = 8 * Pow8 (10));
         when 11 => pragma Assert (Pow8 (12) = 8 * Pow8 (11));
         when 12 => pragma Assert (Pow8 (13) = 8 * Pow8 (12));
         when 13 => pragma Assert (Pow8 (14) = 8 * Pow8 (13));
         when 14 => pragma Assert (Pow8 (15) = 8 * Pow8 (14));
         when 15 => pragma Assert (Pow8 (16) = 8 * Pow8 (15));
         when 16 => pragma Assert (Pow8 (17) = 8 * Pow8 (16));
         when 17 => pragma Assert (Pow8 (18) = 8 * Pow8 (17));
         when 18 => pragma Assert (Pow8 (19) = 8 * Pow8 (18));
         when 19 => pragma Assert (Pow8 (20) = 8 * Pow8 (19));
         when others => null;
      end case;
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

   procedure Lemma_Digit_Byte (V : Count; N : Natural) is
   begin
      null;
   end Lemma_Digit_Byte;

   procedure Lemma_Field_Digit (F : Byte_Array; V : Count; J : Count) is
   begin
      Lemma_Digit_Byte (V, Natural (F'Length - 2 - J));
   end Lemma_Field_Digit;

   procedure Lemma_Val_Of_Field (F : Byte_Array; V : Count) is
      D : constant Natural := Natural (F'Length) - 1;
      K : Natural := 0;
   begin
      Lemma_Shift_Zero (V, D);
      while K < D loop
         pragma Loop_Invariant (K <= D);
         pragma Loop_Invariant
           (for all I in Count range 0 .. Count (K) - 1 => Is_Digit (F (F'First + I)));
         pragma Loop_Invariant (Val (F, F'First, Count (K)) = Shift (V, D - K));
         Lemma_Field_Digit (F, V, Count (K));
         Lemma_Digit_Byte (V, D - 1 - K);
         Lemma_Shift_Succ (V, D - K - 1);
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

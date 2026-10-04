--  Tar_Layout.Octal: the numeric fields of a ustar header.
--
--  Port of replay_export.c octal_field() (writer) and main.js parseOctalField() (reader).
--
--  Field layout written by the old code (and by Put_Octal): a field of N bytes holds N-1
--  right-justified, zero-padded octal digits followed by one NUL.  (The checksum field is the one
--  exception, 6 digits + NUL + space; Tar_Layout.Header builds it from a 7-byte Put_Octal plus the
--  space.)  The old writer silently dropped the high digits of a value that did not fit; Put_Octal
--  reports that case and leaves the field untouched.
--
--  Reader (old parseOctalField): the digits are the bytes up to the first NUL or space; no digits
--  means 0.  The old code then called parseInt (s, 8), which turns garbage into NaN/negative
--  numbers; Get_Octal reports any non-octal byte before the terminator instead.
package Tar_Layout.Octal
  with SPARK_Mode => On, Pure
is

   Max_Width : constant := 20;   --  longest field handled: 19 digits + NUL (< 8**19 < 2**62)

   function Is_Digit (B : Byte) return Boolean is (B in 48 .. 55);       --  '0' .. '7'
   function Is_Terminator (B : Byte) return Boolean is (B = 0 or else B = 32);   --  NUL or space

   ---------------------------------------------------------------------------
   --  Ghost specification
   ---------------------------------------------------------------------------

   --  8 ** N (a table, so that provers see concrete numbers).
   function Pow8 (N : Natural) return Count is
     (case N is
         when 0  => 1,
         when 1  => 8,
         when 2  => 64,
         when 3  => 512,
         when 4  => 4_096,
         when 5  => 32_768,
         when 6  => 262_144,
         when 7  => 2_097_152,
         when 8  => 16_777_216,
         when 9  => 134_217_728,
         when 10 => 1_073_741_824,
         when 11 => 8_589_934_592,
         when 12 => 68_719_476_736,
         when 13 => 549_755_813_888,
         when 14 => 4_398_046_511_104,
         when 15 => 35_184_372_088_832,
         when 16 => 281_474_976_710_656,
         when 17 => 2_251_799_813_685_248,
         when 18 => 18_014_398_509_481_984,
         when 19 => 144_115_188_075_855_872,
         when others => 1_152_921_504_606_846_976)
   with Ghost, Pre => N <= 20;

   procedure Lemma_Pow8_Succ (N : Natural)
   with Ghost, Pre => N < 20, Post => Pow8 (N + 1) = 8 * Pow8 (N);

   --  V / 8**N, computed by repeated division by 8 (no variable divisor).
   function Shift (V : Count; N : Natural) return Count is
     (if N = 0 then V else Shift (V / 8, N - 1))
   with Ghost, Subprogram_Variant => (Decreases => N);

   --  The byte that holds the digit worth 8**N in the octal numeral of V.
   function Digit_Byte (V : Count; N : Natural) return Byte is
     (Byte (48 + Shift (V, N) mod 8))
   with Ghost;

   --  Numeral value of the N digits F (First .. First + N - 1), most significant first:
   --  Val (N) = 8 * Val (N - 1) + digit (N - 1), Val (0) = 0.
   function Val (F : Byte_Array; First : Count; N : Count) return Count
   with Ghost,
        Pre  => N <= Max_Width
                and then First >= F'First
                and then First + N - 1 <= F'Last
                and then (for all J in Count range 0 .. N - 1 => Is_Digit (F (First + J))),
        Post => Val'Result = (if N = 0 then 0
                              else 8 * Val (F, First, N - 1) + (Count (F (First + (N - 1))) - 48))
                and then Val'Result < Pow8 (Natural (N)),
        Subprogram_Variant => (Decreases => N);

   --  F holds the numeral of V in the old writer's layout: Length-1 digits (leading zeros),
   --  then one NUL, and V fits in those digits.
   function Octal_Field_Is (F : Byte_Array; V : Count) return Boolean is
     (F'Length in 1 .. Max_Width
      and then V < Pow8 (Natural (F'Length) - 1)
      and then F (F'Last) = 0
      and then (for all J in Count range 0 .. F'Length - 2 =>
                  F (F'First + J) = Digit_Byte (V, Natural (F'Length - 2 - J))))
   with Ghost;

   --  What parseOctalField reads: D leading digit bytes, then a terminator (or the end of the
   --  field), value = numeral of the D digits (0 for none).
   function Decodes (F : Byte_Array; V : Count) return Boolean is
     (for some D in Count range 0 .. F'Length =>
        (for all J in Count range 0 .. D - 1 => Is_Digit (F (F'First + J)))
        and then (D = F'Length or else Is_Terminator (F (F'First + D)))
        and then V = Val (F, F'First, D))
   with Ghost, Pre => F'Length in 1 .. Max_Width;

   --  A byte that is neither a digit nor a terminator occurs before the first terminator.
   function Bad_Digit (F : Byte_Array) return Boolean is
     (for some D in Count range 0 .. F'Length - 1 =>
        (for all J in Count range 0 .. D - 1 => Is_Digit (F (F'First + J)))
        and then not Is_Digit (F (F'First + D))
        and then not Is_Terminator (F (F'First + D)))
   with Ghost, Pre => F'Length in 1 .. Max_Width;

   ---------------------------------------------------------------------------
   --  Writer: old octal_field
   ---------------------------------------------------------------------------

   --  Writes V into the whole field F (F'Length bytes: F'Length-1 digits + NUL).
   --  Ok  <=> V fits in F'Length-1 octal digits; then F holds exactly its numeral.
   --  Not Ok: F is unchanged (the old code truncated silently).
   procedure Put_Octal (F : in out Byte_Array; V : Count; Ok : out Boolean)
   with
     Pre  => F'Length in 1 .. Max_Width,
     Post => Ok = (V < Pow8 (Natural (F'Length) - 1))
             and then (if Ok then Octal_Field_Is (F, V) else F = F'Old);

   ---------------------------------------------------------------------------
   --  Reader: old parseOctalField
   ---------------------------------------------------------------------------

   type Octal_Result is record
      Ok    : Boolean;
      Value : Count;
   end record;

   --  Ok: Value is what the digits up to the first NUL/space denote (0 for an empty field) and
   --  is below 8 ** F'Length.  Not Ok: a non-octal byte precedes the terminator (Value = 0).
   function Get_Octal (F : Byte_Array) return Octal_Result
   with
     Pre  => F'Length in 1 .. Max_Width,
     Post => (if Get_Octal'Result.Ok
              then Decodes (F, Get_Octal'Result.Value)
                   and then Get_Octal'Result.Value < Pow8 (Natural (F'Length))
              else Bad_Digit (F) and then Get_Octal'Result.Value = 0);

   ---------------------------------------------------------------------------
   --  Ghost lemmas
   ---------------------------------------------------------------------------

   procedure Lemma_Pow8_Mono (A : Natural; B : Natural)
   with Ghost, Pre => A <= B and then B <= 20, Post => Pow8 (A) <= Pow8 (B),
        Subprogram_Variant => (Decreases => B);

   procedure Lemma_Shift_Succ (V : Count; N : Natural)
   with Ghost, Pre => N < Natural'Last,
        Post => Shift (V, N + 1) = Shift (V, N) / 8,
        Subprogram_Variant => (Decreases => N);

   procedure Lemma_Shift_Zero (V : Count; N : Natural)
   with Ghost, Pre => N <= 20,
        Post => (Shift (V, N) = 0) = (V < Pow8 (N)),
        Subprogram_Variant => (Decreases => N);

   --  Digit_Byte is an ASCII octal digit holding the digit of V worth 8**N.
   procedure Lemma_Digit_Byte (V : Count; N : Natural)
   with Ghost,
        Post => Is_Digit (Digit_Byte (V, N))
                and then Count (Digit_Byte (V, N)) - 48 = Shift (V, N) mod 8;

   --  Position J (from the left) of a field in the old layout is the digit worth 8**(Length-2-J).
   procedure Lemma_Field_Digit (F : Byte_Array; V : Count; J : Count)
   with Ghost,
        Pre  => Octal_Field_Is (F, V) and then J <= F'Length - 2,
        Post => F (F'First + J) = Digit_Byte (V, Natural (F'Length - 2 - J))
                and then Is_Digit (F (F'First + J));

   --  The digits of a field in the old layout denote V.
   procedure Lemma_Val_Of_Field (F : Byte_Array; V : Count)
   with Ghost,
        Pre  => Octal_Field_Is (F, V),
        Post => Val (F, F'First, F'Length - 1) = V;

   --  decode (encode V) = V: a field written in the old layout is read back as the same value.
   procedure Lemma_Round_Trip (F : Byte_Array; V : Count)
   with Ghost,
        Pre  => Octal_Field_Is (F, V),
        Post => Get_Octal (F) = (Ok => True, Value => V);

   --  The 12-digit field limit: every value Get_Octal can return for a 12-byte field is a
   --  Wire_Size.
   procedure Lemma_Pow8_Wire
   with Ghost, Post => Pow8 (11) = Max_Octal_11 + 1 and then Pow8 (12) = Max_Octal_12 + 1
                       and then Pow8 (7) = 2_097_152 and then Pow8 (6) = 262_144;

end Tar_Layout.Octal;

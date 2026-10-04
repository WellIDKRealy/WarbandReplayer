--  Micro-benchmark for Sqlite_Header.Validate: nanoseconds per call.
--  usage: bench_sqlite_header [calls]      (default 100_000_000)
with Ada.Command_Line;
with Ada.Real_Time;
with Ada.Text_IO;
with Interfaces;
with Sqlite_Header; use Sqlite_Header;

procedure Bench_Sqlite_Header is
   use Interfaces;
   use type Ada.Real_Time.Time;

   N_Variants : constant := 64;
   type Variant is record
      H    : Header_Bytes;
      Len  : Header_Length;
      Size : File_Size;
   end record;
   Variants : array (0 .. N_Variants - 1) of Variant;

   procedure Put32 (H : in out Header_Bytes; Off : Word_Offset; V : Unsigned_32) is
   begin
      H (Off) := Byte (Shift_Right (V, 24)); H (Off + 1) := Byte (Shift_Right (V, 16) and 255);
      H (Off + 2) := Byte (Shift_Right (V, 8) and 255); H (Off + 3) := Byte (V and 255);
   end Put32;

   function Valid return Header_Bytes is
      H : Header_Bytes := (others => 0);
      M : constant String := "SQLite format 3";
   begin
      for I in 0 .. 14 loop H (I) := Byte (Character'Pos (M (M'First + I))); end loop;
      H (16) := 16; H (17) := 0; H (18) := 1; H (19) := 1; H (21) := 64; H (22) := 32; H (23) := 32;
      Put32 (H, 24, 7); Put32 (H, 28, 270_000); Put32 (H, 44, 4); Put32 (H, 56, 1); Put32 (H, 92, 7);
      return H;
   end Valid;

   Calls    : Long_Long_Integer := 100_000_000;
   Sink     : Unsigned_64 := 0;
   T0, T1   : Ada.Real_Time.Time;
   Valid_H  : constant Header_Bytes := Valid;
   Ok_Size  : constant File_Size := 270_000 * 4096;

   procedure Fold (R : Result) is
   begin
      if R.Valid then
         Sink := Sink + Unsigned_64 (R.Page_Count) + Unsigned_64 (R.Page_Size);
      else
         Sink := Sink + Unsigned_64 (Error_Kind'Pos (R.Error)) + 1;
      end if;
   end Fold;
begin
   if Ada.Command_Line.Argument_Count >= 1 then
      Calls := Long_Long_Integer'Value (Ada.Command_Line.Argument (1));
   end if;

   --  64 variants: valid headers (distinct page counts / sizes) and one defect of each kind
   for I in Variants'Range loop
      Variants (I) := (H => Valid_H, Len => 100, Size => Ok_Size + File_Size (I) * 4096);
      Put32 (Variants (I).H, 28, 270_000 + Unsigned_32 (I));
      case I mod 8 is
         when 1 => Variants (I).H (3) := 0;                             --  Bad_Magic
         when 2 => Variants (I).H (17) := 3;                            --  Bad_Page_Size
         when 3 => Variants (I).H (19) := 9;                            --  Bad_Version
         when 4 => Put32 (Variants (I).H, 44, 9);                       --  Bad_Schema_Format
         when 5 => Variants (I).Size := 4096 * 7;                       --  Truncated
         when 6 => Variants (I).Size := Ok_Size + 5;                    --  Size_Not_Page_Multiple
         when others => null;
      end case;
   end loop;

   --  (a) valid header only: the common case
   T0 := Ada.Real_Time.Clock;
   for I in 1 .. Calls loop
      Fold (Validate (Valid_H, 100, Ok_Size + File_Size (I mod 1024) * 4096));
   end loop;
   T1 := Ada.Real_Time.Clock;
   declare
      NS : constant Long_Float := Long_Float (Ada.Real_Time.To_Duration (T1 - T0)) * 1.0E9 / Long_Float (Calls);
   begin
      Ada.Text_IO.Put_Line ("valid header      :" & Long_Float'Image (NS) & " ns/call (" & Long_Long_Integer'Image (Calls) & " calls)");
      Ada.Text_IO.Put_Line ("                  :" & Long_Float'Image (1.0E3 / NS) & " M calls/s");
   end;

   --  (b) 64 mixed variants (1/4 valid, the rest errors of all kinds)
   T0 := Ada.Real_Time.Clock;
   for I in 1 .. Calls loop
      declare
         V : Variant renames Variants (Integer (I mod N_Variants));
      begin
         Fold (Validate (V.H, V.Len, V.Size));
      end;
   end loop;
   T1 := Ada.Real_Time.Clock;
   declare
      NS : constant Long_Float := Long_Float (Ada.Real_Time.To_Duration (T1 - T0)) * 1.0E9 / Long_Float (Calls);
   begin
      Ada.Text_IO.Put_Line ("mixed (64 variants):" & Long_Float'Image (NS) & " ns/call");
   end;
   Ada.Text_IO.Put_Line ("checksum " & Unsigned_64'Image (Sink));
end Bench_Sqlite_Header;

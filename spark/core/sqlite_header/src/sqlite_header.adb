with Sqlite_Header.Proofs;

package body Sqlite_Header
  with SPARK_Mode => On
is

   --  Big-endian 4-byte field (same definition as the ghost BE32; an expression function, so the
   --  provers see through it).
   function Word (H : Header_Bytes; At_Offset : Word_Offset) return Long_Long_Integer
   is (Long_Long_Integer (H (At_Offset)) * 2 ** 24 + Long_Long_Integer (H (At_Offset + 1)) * 2 ** 16
       + Long_Long_Integer (H (At_Offset + 2)) * 2 ** 8 + Long_Long_Integer (H (At_Offset + 3)));

   function Fail (K : Error_Kind) return Result
   is (Valid => False, Error => K);

   function Validate (Header : Header_Bytes; Length : Header_Length; Size : File_Size) return Result is
      Raw_Page_Size : constant Long_Long_Integer :=
        Long_Long_Integer (Header (16)) * 256 + Long_Long_Integer (Header (17));
      Page          : constant Long_Long_Integer := (if Raw_Page_Size = 1 then 65536 else Raw_Page_Size);
      In_Header     : constant Long_Long_Integer := Word (Header, 28);
      Counter_Valid : constant Boolean := Word (Header, 24) = Word (Header, 92);
      Schema_Format : constant Long_Long_Integer := Word (Header, 44);
      Encoding      : constant Long_Long_Integer := Word (Header, 56);
   begin
      if Length < Header_Size or else Size < Header_Size then
         return Fail (Too_Short);
      end if;

      --  "SQLite format 3" and NUL
      if Header (0) /= 16#53# or else Header (1) /= 16#51# or else Header (2) /= 16#4C#
        or else Header (3) /= 16#69# or else Header (4) /= 16#74# or else Header (5) /= 16#65#
        or else Header (6) /= 16#20# or else Header (7) /= 16#66# or else Header (8) /= 16#6F#
        or else Header (9) /= 16#72# or else Header (10) /= 16#6D# or else Header (11) /= 16#61#
        or else Header (12) /= 16#74# or else Header (13) /= 16#20# or else Header (14) /= 16#33#
        or else Header (15) /= 16#00#
      then
         return Fail (Bad_Magic);
      end if;

      case Page is
         when 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768 | 65536 => null;
         when others => return Fail (Bad_Page_Size);
      end case;
      if Long_Long_Integer (Header (20)) + 480 > Page then
         return Fail (Bad_Page_Size);
      end if;

      if (Header (18) /= 1 and then Header (18) /= 2) or else (Header (19) /= 1 and then Header (19) /= 2) then
         return Fail (Bad_Version);
      end if;

      if Header (21) /= 64 or else Header (22) /= 32 or else Header (23) /= 32 then
         return Fail (Bad_Payload_Fractions);
      end if;

      if Schema_Format < 1 or else Schema_Format > 4 then
         return Fail (Bad_Schema_Format);
      end if;

      if Encoding < 1 or else Encoding > 3 then
         return Fail (Bad_Text_Encoding);
      end if;

      declare
         Present : constant Long_Long_Integer := Size / Page;
         Claimed : constant Long_Long_Integer :=
           (if In_Header > 0 and then Counter_Valid then In_Header else Present);
      begin
         if Claimed > Present then
            return Fail (Truncated);
         end if;
         if Claimed = 0 then
            return Fail (Zero_Pages);
         end if;
         if Size mod Page /= 0 then
            return Fail (Size_Not_Page_Multiple);
         end if;
         Proofs.Lemma_Pages_Fit (Claimed, Page, Size);
         return (Valid      => True,
                 Page_Size  => Page,
                 Page_Count => Claimed,
                 Encoding   => Text_Encoding'Val (Encoding - 1),
                 Wal        => Header (19) = 2);
      end;
   end Validate;

end Sqlite_Header;

--  Sqlite_Header: validates the 100-byte SQLite database header against the file size, before SQLite
--  is asked anything (failure-modes.md section A: bad magic, truncated file, header damage,
--  page-count mismatch).  README.md = guarantees and error precedence, PROOF.md = proof summary.
--
--  Input : the first Length (0 .. 100) bytes of the file (Header; bytes at or after Length are
--          ignored) and the total file size in bytes.
--  Output: Ok (page size, page count, text encoding, wal flag) or exactly ONE typed error.
package Sqlite_Header
  with SPARK_Mode => On, Pure
is

   type Byte is mod 2 ** 8;

   Header_Size : constant := 100;
   subtype Header_Index is Natural range 0 .. Header_Size - 1;
   type Header_Bytes is array (Header_Index) of Byte;
   subtype Header_Length is Natural range 0 .. Header_Size;

   --  Sizes and counts are 64-bit: nothing is capped, nothing is truncated to 32 bits.
   subtype File_Size is Long_Long_Integer range 0 .. Long_Long_Integer'Last;
   subtype Page_Bytes is Long_Long_Integer range 512 .. 65536;
   subtype Page_Total is Long_Long_Integer range 1 .. Long_Long_Integer'Last / 512;

   type Text_Encoding is (UTF_8, UTF_16LE, UTF_16BE);

   --  Listed in precedence order: when several conditions hold, the first one is reported.
   type Error_Kind is
     (Too_Short,               --  fewer than 100 header bytes given, or the file itself is < 100 bytes
      Bad_Magic,               --  bytes 0-15 are not "SQLite format 3" and NUL
      Bad_Page_Size,           --  not 512, 1024 .. 32768 (or 1 = 65536), or page size - reserved < 480
      Bad_Version,             --  write version (byte 18) or read version (byte 19) is not 1 or 2
      Bad_Payload_Fractions,   --  bytes 21, 22, 23 are not 64, 32, 32
      Bad_Schema_Format,       --  schema format (bytes 44-47) is not 1 .. 4
      Bad_Text_Encoding,       --  text encoding (bytes 56-59) is not 1 .. 3
      Truncated,               --  the database has more pages than the file holds
      Zero_Pages,              --  the database has no page (file smaller than one page)
      Size_Not_Page_Multiple); --  the file size is not a whole number of pages

   type Result (Valid : Boolean := False) is record
      case Valid is
         when True =>
            Page_Size  : Page_Bytes;      --  bytes per page
            Page_Count : Page_Total;      --  pages of the database (>= 1)
            Encoding   : Text_Encoding;
            Wal        : Boolean;         --  read version 2: the database is meant to be used in WAL mode
         when False =>
            Error      : Error_Kind;
      end case;
   end record;

   ---------------------------------------------------------------------------
   --  Specification vocabulary (ghost): the header fields, decoded exactly as the SQLite file-format
   --  document defines them.  Used only by the contract below.
   ---------------------------------------------------------------------------

   Magic_Text : constant String := "SQLite format 3";   --  followed by one NUL byte

   subtype Word_Offset is Natural range 0 .. Header_Size - 4;

   --  Big-endian 4-byte field starting at an offset.
   function BE32 (H : Header_Bytes; At_Offset : Word_Offset) return Long_Long_Integer
   is (Long_Long_Integer (H (At_Offset)) * 2 ** 24 + Long_Long_Integer (H (At_Offset + 1)) * 2 ** 16
       + Long_Long_Integer (H (At_Offset + 2)) * 2 ** 8 + Long_Long_Integer (H (At_Offset + 3)))
   with Ghost;

   --  Bytes 0-15.
   function Magic_Ok (H : Header_Bytes) return Boolean
   is ((for all I in 0 .. 14 => Natural (H (I)) = Character'Pos (Magic_Text (Magic_Text'First + I)))
       and then H (15) = 0)
   with Ghost;

   --  Bytes 16-17 (big-endian; the value 1 means 65536).
   function Page_Size_Of (H : Header_Bytes) return Long_Long_Integer
   is (if H (16) = 0 and then H (17) = 1 then 65536
       else Long_Long_Integer (H (16)) * 256 + Long_Long_Integer (H (17)))
   with Ghost;

   --  Page size is a power of two from 512 to 65536, and the usable size (page size minus the
   --  reserved bytes per page, byte 20) is at least 480.
   function Page_Size_Ok (H : Header_Bytes) return Boolean
   is (Page_Size_Of (H) in 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768 | 65536
       and then Long_Long_Integer (H (20)) + 480 <= Page_Size_Of (H))
   with Ghost;

   --  Whole pages the file holds.
   function Pages_Present (H : Header_Bytes; Size : File_Size) return Long_Long_Integer
   is (Size / Page_Size_Of (H))
   with Ghost, Pre => Page_Size_Ok (H);

   --  Pages the database has: the in-header count (bytes 28-31) when it is positive and still valid
   --  (the version-valid-for number, bytes 92-95, equals the change counter, bytes 24-27), else
   --  as many as the file holds.
   function Pages_Claimed (H : Header_Bytes; Size : File_Size) return Long_Long_Integer
   is (if BE32 (H, 28) > 0 and then BE32 (H, 24) = BE32 (H, 92) then BE32 (H, 28)
       else Pages_Present (H, Size))
   with Ghost, Pre => Page_Size_Ok (H);

   ---------------------------------------------------------------------------
   --  Validate: total.  Every header, length and file size gives a result (no precondition beyond the
   --  parameter types, no exception, no run-time error).
   --
   --  The postcondition IS the specification: the first condition that holds names the error;
   --  when none holds the result is Ok with the decoded fields.  On top of that, an Ok database lies
   --  entirely inside the file: Page_Count * Page_Size <= file size.
   ---------------------------------------------------------------------------
   function Validate (Header : Header_Bytes; Length : Header_Length; Size : File_Size) return Result
   with Post =>
     (if Length < Header_Size or else Size < Header_Size then
         Validate'Result = (Valid => False, Error => Too_Short)
      elsif not Magic_Ok (Header) then
         Validate'Result = (Valid => False, Error => Bad_Magic)
      elsif not Page_Size_Ok (Header) then
         Validate'Result = (Valid => False, Error => Bad_Page_Size)
      elsif Header (18) not in 1 | 2 or else Header (19) not in 1 | 2 then
         Validate'Result = (Valid => False, Error => Bad_Version)
      elsif Header (21) /= 64 or else Header (22) /= 32 or else Header (23) /= 32 then
         Validate'Result = (Valid => False, Error => Bad_Payload_Fractions)
      elsif BE32 (Header, 44) not in 1 .. 4 then
         Validate'Result = (Valid => False, Error => Bad_Schema_Format)
      elsif BE32 (Header, 56) not in 1 .. 3 then
         Validate'Result = (Valid => False, Error => Bad_Text_Encoding)
      elsif Pages_Claimed (Header, Size) > Pages_Present (Header, Size) then
         Validate'Result = (Valid => False, Error => Truncated)
      elsif Pages_Claimed (Header, Size) = 0 then
         Validate'Result = (Valid => False, Error => Zero_Pages)
      elsif Size mod Page_Size_Of (Header) /= 0 then
         Validate'Result = (Valid => False, Error => Size_Not_Page_Multiple)
      else
         Validate'Result = (Valid      => True,
                            Page_Size  => Page_Size_Of (Header),
                            Page_Count => Pages_Claimed (Header, Size),
                            Encoding   => Text_Encoding'Val (BE32 (Header, 56) - 1),
                            Wal        => Header (19) = 2))
     and then
       (if Validate'Result.Valid then
           Validate'Result.Page_Count * Validate'Result.Page_Size <= Size);

end Sqlite_Header;

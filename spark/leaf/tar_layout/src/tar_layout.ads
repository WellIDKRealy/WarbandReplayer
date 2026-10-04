--  Tar_Layout: ustar header construction, size accounting and parsing for the battle export
--  bundle ("Export active battle ... tar.xz" / "Load Battle Export").
--
--  Port of replay_export.c (octal_field, tar_add_entry, tar_finish, tar_ensure) and main.js
--  (parseOctalField, parseTar).  See README.md for the contract <-> old behaviour mapping and
--  PROOF.md for the proof summary.
--
--  This root package holds the shared types and the pure size arithmetic (padding to 512, entry
--  size, archive size, buffer growth).  Children:
--    Tar_Layout.Octal   numeric header fields (octal_field / parseOctalField)
--    Tar_Layout.Header  the 512-byte ustar header (build, checksum)
--    Tar_Layout.Writer  tar_add_entry / tar_finish and the whole-bundle builder
--    Tar_Layout.Reader  parseTar as an entry cursor, and the parse (build E) = E theorem
package Tar_Layout
  with SPARK_Mode => On, Pure
is

   ---------------------------------------------------------------------------
   --  Types.  Every size, offset and count is 64-bit (Long_Long_Integer subtypes); nothing is
   --  32-bit and nothing is capped.  Max_Bytes = 2**62 keeps every intermediate sum far from
   --  Long_Long_Integer'Last.
   ---------------------------------------------------------------------------

   Block_Size : constant := 512;
   Max_Bytes  : constant := 2**62;

   subtype Count is Long_Long_Integer range 0 .. Max_Bytes;
   type Byte is mod 2**8;

   --  Buffers are zero-based by contract: every subprogram that takes one of the large buffers
   --  requires Buf'First = 0, so that an index is a byte offset.
   type Byte_Array is array (Count range <>) of Byte;

   Name_Size    : constant := 100;                --  ustar name field (old: namelen > 100 rejected)
   Max_Octal_11 : constant := 8**11 - 1;          --  largest value of an 11-digit field (size, mtime)
   Max_Octal_12 : constant := 8**12 - 1;          --  largest value of a 12-digit field (parser only)

   --  Entry data sizes the arithmetic below is defined on: whatever a 12-byte numeric header field
   --  can denote (the writer emits at most Max_Octal_11, the parser accepts up to Max_Octal_12).
   subtype Wire_Size is Count range 0 .. Max_Octal_12;

   ---------------------------------------------------------------------------
   --  Size accounting (old: tar_add_entry's `rem`/`pad` and tar_finish)
   ---------------------------------------------------------------------------

   --  Zero bytes appended after Size data bytes to reach a multiple of 512
   --  (old: rem = size % 512; if (rem != 0) pad = 512 - rem).
   function Padding (Size : Wire_Size) return Natural is
     (if Size mod Block_Size = 0 then 0 else Block_Size - Natural (Size mod Block_Size))
   with Post => Padding'Result < Block_Size
                and then (Size + Long_Long_Integer (Padding'Result)) mod Block_Size = 0
                and then (Size mod Block_Size = 0) = (Padding'Result = 0);

   --  Data size rounded up to a multiple of 512: exactly ceil (Size / 512) * 512.
   function Padded (Size : Wire_Size) return Count is
     (Size + Long_Long_Integer (Padding (Size)))
   with Post => Padded'Result = ((Size + (Block_Size - 1)) / Block_Size) * Block_Size
                and then Padded'Result >= Size
                and then Padded'Result - Size < Block_Size
                and then Padded'Result mod Block_Size = 0;

   --  Bytes one archive entry occupies: 512 header + data rounded up to 512.
   function Entry_Total (Size : Wire_Size) return Count is
     (Block_Size + Padded (Size))
   with Post => Entry_Total'Result = Block_Size + ((Size + (Block_Size - 1)) / Block_Size) * Block_Size
                and then Entry_Total'Result mod Block_Size = 0
                and then Entry_Total'Result >= Block_Size + Size;

   --  The two zero blocks closing every archive (old: tar_finish).
   End_Marker_Size : constant := 2 * Block_Size;

   ---------------------------------------------------------------------------
   --  Buffer growth (old: tar_ensure).  In C the arithmetic is size_t: on wasm32 `len + extra`
   --  and `newcap *= 2` wrap (the doubling loop never ends once it passes 2**31).  Here it is
   --  64-bit and total.
   ---------------------------------------------------------------------------

   Initial_Capacity : constant := 65_536;

   --  Ghost definition of "N is Start doubled zero or more times".
   function Is_Doubling_Of (N : Long_Long_Integer; Start : Count) return Boolean is
     (N = Start or else (N > 0 and then N mod 2 = 0 and then Is_Doubling_Of (N / 2, Start)))
   with Ghost, Subprogram_Variant => (Decreases => N);

   --  New capacity so that Needed bytes fit, exactly as the old loop computes it:
   --    * Needed <= Capacity                 : unchanged (the old code does not touch the buffer)
   --    * else start = Capacity (or 65536 for an empty buffer) doubled until >= Needed.
   --  Total for every Capacity and Needed in 0 .. 2**62; the result is below 2**63 (it may exceed
   --  Max_Bytes, which a caller must treat as "allocation impossible", never as a wrapped value).
   function Grown_Capacity (Capacity : Count; Needed : Count) return Long_Long_Integer
   with Post =>
     Grown_Capacity'Result >= Needed
     and then Grown_Capacity'Result >= Capacity
     and then (if Needed <= Capacity then Grown_Capacity'Result = Capacity
               else Is_Doubling_Of (Grown_Capacity'Result,
                                    (if Capacity = 0 then Initial_Capacity else Capacity))
                    and then (Grown_Capacity'Result =
                                (if Capacity = 0 then Initial_Capacity else Capacity)
                              or else Grown_Capacity'Result / 2 < Needed));

end Tar_Layout;

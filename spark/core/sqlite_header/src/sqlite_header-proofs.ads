--  Proof scaffolding for Sqlite_Header (ghost, never compiled into code, not part of the interface).
package Sqlite_Header.Proofs
  with SPARK_Mode => On, Pure, Ghost
is

   --  A page count that is at most "pages the file holds" fits inside the file, and the multiplication
   --  cannot overflow.
   procedure Lemma_Pages_Fit (Count : Long_Long_Integer; Page : Page_Bytes; Size : File_Size)
   with Pre  => Count in 0 .. Size / Page,
        Post => Count * Page <= Size;

   --  README guarantees 3-5 as a theorem: an Ok result means every documented constraint holds, and its
   --  page count is the claimed one.
   procedure Lemma_Ok_Means_Sane (Header : Header_Bytes; Length : Header_Length; Size : File_Size)
   with Pre  => Validate (Header, Length, Size).Valid,
        Post => Length = Header_Size
                and then Size >= Header_Size
                and then Magic_Ok (Header)
                and then Page_Size_Ok (Header)
                and then Header (18) in 1 | 2 and then Header (19) in 1 | 2
                and then Header (21) = 64 and then Header (22) = 32 and then Header (23) = 32
                and then BE32 (Header, 44) in 1 .. 4
                and then BE32 (Header, 56) in 1 .. 3
                and then Size mod Page_Size_Of (Header) = 0
                and then Pages_Claimed (Header, Size) >= 1
                and then Pages_Claimed (Header, Size) <= Pages_Present (Header, Size)
                and then Validate (Header, Length, Size).Page_Count = Pages_Claimed (Header, Size);

end Sqlite_Header.Proofs;

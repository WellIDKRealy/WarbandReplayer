--  Proof scaffolding for Sqlite_Header (ghost, never compiled into code, not part of the interface).
package Sqlite_Header.Proofs
  with SPARK_Mode => On, Pure, Ghost
is

   --  A page count that is at most "pages the file holds" fits inside the file, and the multiplication
   --  cannot overflow.
   procedure Lemma_Pages_Fit (Count : Long_Long_Integer; Page : Page_Bytes; Size : File_Size)
   with Pre  => Count in 0 .. Size / Page,
        Post => Count * Page <= Size;

end Sqlite_Header.Proofs;

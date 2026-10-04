package body Sqlite_Header.Proofs
  with SPARK_Mode => On
is

   procedure Lemma_Pages_Fit (Count : Long_Long_Integer; Page : Page_Bytes; Size : File_Size) is
      Quotient : constant Long_Long_Integer := Size / Page;
   begin
      pragma Assert (Quotient * Page <= Size);
      pragma Assert (Count * Page <= Quotient * Page);
   end Lemma_Pages_Fit;

   procedure Lemma_Ok_Means_Sane (Header : Header_Bytes; Length : Header_Length; Size : File_Size) is
   begin
      null;   --  every conjunct of the postcondition is a negated branch condition of Validate's
   end Lemma_Ok_Means_Sane;

end Sqlite_Header.Proofs;

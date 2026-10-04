--  Native differential tests for Sqlite_Header (not part of the proof project).
--
--  argv: <cases.txt> <real_headers.txt> [<replays-dir>] [small]
--
--  Compared against: (1) every committed oracle case (expected results come from tests/oracle.py, which
--  also checked each case against real SQLite), (2) the real replay files / their committed headers,
--  (3) MODEL below, a second implementation written in a different style (table of conditions, the
--  first one that holds wins), on exhaustive single-field sweeps, an exhaustive precedence matrix and
--  random headers.  Built with -gnata (MODE=contracts) every call also executes the postcondition.
with Ada.Characters.Handling;
with Ada.Command_Line;
with Ada.Directories;
with Ada.Streams.Stream_IO;
with Ada.Strings.Fixed;
with Ada.Strings.Unbounded;
with Ada.Text_IO;
with Interfaces;
with Sqlite_Header; use Sqlite_Header;

procedure Test_Sqlite_Header is
   use Interfaces;
   package TIO renames Ada.Text_IO;

   Failures : Natural := 0;
   Checks   : Long_Long_Integer := 0;
   Small    : Boolean := False;

   procedure Fail (Msg : String) is
   begin
      Failures := Failures + 1;
      if Failures <= 25 then
         TIO.Put_Line ("FAIL: " & Msg);
      end if;
   end Fail;

   ---------------------------------------------------------------------------
   --  Formatting (same text as oracle.py's fmt_result, upper-cased)
   ---------------------------------------------------------------------------
   function Img (N : Long_Long_Integer) return String is
      S : constant String := Long_Long_Integer'Image (N);
   begin
      return (if S (S'First) = ' ' then S (S'First + 1 .. S'Last) else S);
   end Img;

   function Fmt (R : Result) return String is
   begin
      if R.Valid then
         return "OK:" & Img (R.Page_Size) & ":" & Img (R.Page_Count) & ":" & Text_Encoding'Image (R.Encoding) & ":"
           & (if R.Wal then "1" else "0");
      else
         return Error_Kind'Image (R.Error);
      end if;
   end Fmt;

   ---------------------------------------------------------------------------
   --  MODEL: independent second implementation (modular arithmetic, bit tricks, array of conditions)
   ---------------------------------------------------------------------------
   function Model (H : Header_Bytes; L : Natural; S : Long_Long_Integer) return Result is
      function B (I : Natural) return Unsigned_64 is (Unsigned_64 (H (I)));
      function W (I : Natural) return Unsigned_64 is
        (Shift_Left (B (I), 24) or Shift_Left (B (I + 1), 16) or Shift_Left (B (I + 2), 8) or B (I + 3));
      Raw  : constant Unsigned_64 := Shift_Left (B (16), 8) or B (17);
      Page : constant Unsigned_64 := (if Raw = 1 then 65536 else Raw);
      Pow2 : constant Boolean := Page >= 512 and then Page <= 65536 and then (Page and (Page - 1)) = 0;
      Size : constant Unsigned_64 := Unsigned_64 (S);
      Cond : array (Error_Kind) of Boolean := (others => False);
      Magic : constant String := "SQLite format 3" & Character'Val (0);
   begin
      Cond (Too_Short) := L < 100 or else S < 100;
      for I in 0 .. 15 loop
         if Character'Pos (Magic (Magic'First + I)) /= Natural (H (I)) then
            Cond (Bad_Magic) := True;
         end if;
      end loop;
      Cond (Bad_Page_Size) := not Pow2 or else (Pow2 and then B (20) + 480 > Page);
      Cond (Bad_Version) := (H (18) < 1 or else H (18) > 2) or else (H (19) < 1 or else H (19) > 2);
      Cond (Bad_Payload_Fractions) := not (H (21) = 64 and then H (22) = 32 and then H (23) = 32);
      Cond (Bad_Schema_Format) := W (44) = 0 or else W (44) > 4;
      Cond (Bad_Text_Encoding) := W (56) = 0 or else W (56) > 3;
      declare
         Claimed : Unsigned_64 := 0;
      begin
         if Pow2 then
            Claimed := (if W (28) /= 0 and then W (24) = W (92) then W (28) else Size / Page);
            Cond (Truncated) := Claimed > Size / Page;
            Cond (Zero_Pages) := Claimed = 0;
            Cond (Size_Not_Page_Multiple) := Size mod Page /= 0;
         end if;
         for K in Error_Kind loop
            if Cond (K) then
               return (Valid => False, Error => K);
            end if;
         end loop;
         return (Valid      => True,
                 Page_Size  => Long_Long_Integer (Page),
                 Page_Count => Long_Long_Integer (Claimed),
                 Encoding   => (case W (56) is when 1 => UTF_8, when 2 => UTF_16LE, when others => UTF_16BE),
                 Wal        => H (19) = 2);
      end;
   end Model;

   ---------------------------------------------------------------------------
   --  Check one case against an expected text and the model
   ---------------------------------------------------------------------------
   procedure Check_Case (H : Header_Bytes; L : Header_Length; S : File_Size; Expect : String; What : String) is
      R : constant Result := Validate (H, L, S);
      M : constant Result := Model (H, L, S);
   begin
      Checks := Checks + 1;
      if Fmt (R) /= Fmt (M) then
         Fail (What & ": validator " & Fmt (R) & " /= model " & Fmt (M));
      end if;
      if Expect /= "" and then Fmt (R) /= Ada.Characters.Handling.To_Upper (Expect) then
         Fail (What & ": validator " & Fmt (R) & " /= expected " & Expect);
      end if;
      if R.Valid and then (R.Page_Count * R.Page_Size > S) then
         Fail (What & ": Ok but pages do not fit the file");
      end if;
   end Check_Case;

   procedure Check_Model (H : Header_Bytes; L : Header_Length; S : File_Size; What : String) is
   begin
      Check_Case (H, L, S, "", What);
   end Check_Model;

   ---------------------------------------------------------------------------
   --  Header construction helpers
   ---------------------------------------------------------------------------
   procedure Put32 (H : in out Header_Bytes; At_Offset : Word_Offset; V : Unsigned_64) is
   begin
      H (At_Offset)     := Byte (Shift_Right (V, 24) and 255);
      H (At_Offset + 1) := Byte (Shift_Right (V, 16) and 255);
      H (At_Offset + 2) := Byte (Shift_Right (V, 8) and 255);
      H (At_Offset + 3) := Byte (V and 255);
   end Put32;

   function Valid_Header (Page : Unsigned_64; Pages : Unsigned_64) return Header_Bytes is
      H : Header_Bytes := (others => 0);
      Magic : constant String := "SQLite format 3";
   begin
      for I in 0 .. 14 loop
         H (I) := Byte (Character'Pos (Magic (Magic'First + I)));
      end loop;
      if Page = 65536 then
         H (16) := 0; H (17) := 1;
      else
         H (16) := Byte (Shift_Right (Page, 8)); H (17) := Byte (Page and 255);
      end if;
      H (18) := 1; H (19) := 1; H (20) := 0;
      H (21) := 64; H (22) := 32; H (23) := 32;
      Put32 (H, 24, 7);        --  change counter
      Put32 (H, 28, Pages);    --  in-header page count
      Put32 (H, 44, 4);        --  schema format
      Put32 (H, 56, 1);        --  UTF-8
      Put32 (H, 92, 7);        --  version-valid-for
      Put32 (H, 96, 3045001);
      return H;
   end Valid_Header;

   function To_Size (Pages, Page : Unsigned_64) return File_Size is (File_Size (Pages * Page));

   ---------------------------------------------------------------------------
   --  PRNG (xorshift64*)
   ---------------------------------------------------------------------------
   State : Unsigned_64 := 16#9E3779B97F4A7C15#;
   function Rnd return Unsigned_64 is
   begin
      State := State xor Shift_Right (State, 12);
      State := State xor Shift_Left (State, 25);
      State := State xor Shift_Right (State, 27);
      return State * 16#2545F4914F6CDD1D#;
   end Rnd;
   function Below (N : Unsigned_64) return Unsigned_64 is (Rnd mod N);

   ---------------------------------------------------------------------------
   --  Hex / cases
   ---------------------------------------------------------------------------
   function Hex_Val (C : Character) return Natural is
     (case C is
         when '0' .. '9' => Character'Pos (C) - Character'Pos ('0'),
         when 'a' .. 'f' => Character'Pos (C) - Character'Pos ('a') + 10,
         when 'A' .. 'F' => Character'Pos (C) - Character'Pos ('A') + 10,
         when others     => 0);

   function Parse_Header (Hex : String) return Header_Bytes is
      H : Header_Bytes := (others => 0);
   begin
      if Hex'Length /= 200 then
         Fail ("bad header hex length" & Integer'Image (Hex'Length));
         return H;
      end if;
      for I in H'Range loop
         H (I) := Byte (Hex_Val (Hex (Hex'First + 2 * I)) * 16 + Hex_Val (Hex (Hex'First + 2 * I + 1)));
      end loop;
      return H;
   end Parse_Header;

   --  Splits a line at blanks.
   type Fields is array (1 .. 10) of Ada.Strings.Unbounded.Unbounded_String;
   procedure Split (Line : String; F : out Fields; N : out Natural) is
      use Ada.Strings.Unbounded;
      Start : Natural := Line'First;
   begin
      N := 0;
      F := (others => Null_Unbounded_String);
      for I in Line'First .. Line'Last + 1 loop
         if I > Line'Last or else Line (I) = ' ' then
            if I > Start and then N < F'Last then
               N := N + 1;
               F (N) := To_Unbounded_String (Line (Start .. I - 1));
            end if;
            Start := I + 1;
         end if;
      end loop;
   end Split;

   function Val (S : String) return Long_Long_Integer is (Long_Long_Integer'Value (S));

   procedure Apply_Edits (H : in out Header_Bytes; Edits : String) is
      I : Natural := Edits'First;
   begin
      if Edits = "-" then
         return;
      end if;
      while I <= Edits'Last loop
         declare
            Eq    : constant Natural := Ada.Strings.Fixed.Index (Edits (I .. Edits'Last), "=");
            Comma : Natural := Ada.Strings.Fixed.Index (Edits (I .. Edits'Last), ",");
            Off   : constant Natural := Natural'Value (Edits (I .. Eq - 1));
         begin
            if Comma = 0 then
               Comma := Edits'Last + 1;
            end if;
            declare
               Hex : constant String := Edits (Eq + 1 .. Comma - 1);
            begin
               for K in 0 .. Hex'Length / 2 - 1 loop
                  H (Off + K) := Byte (Hex_Val (Hex (Hex'First + 2 * K)) * 16 + Hex_Val (Hex (Hex'First + 2 * K + 1)));
               end loop;
            end;
            I := Comma + 1;
         end;
      end loop;
   end Apply_Edits;

   procedure Run_Cases (Path : String) is
      use Ada.Strings.Unbounded;
      F       : TIO.File_Type;
      Bases   : array (0 .. 99) of Header_Bytes := (others => (others => 0));
      Ids     : array (0 .. 99) of Unbounded_String;
      NB      : Natural := 0;
      NC      : Natural := 0;
      Fl      : Fields;
      N       : Natural;
   begin
      TIO.Open (F, TIO.In_File, Path);
      while not TIO.End_Of_File (F) loop
         declare
            Line : constant String := TIO.Get_Line (F);
         begin
            if Line'Length > 0 and then Line (Line'First) /= '#' then
               Split (Line, Fl, N);
               if To_String (Fl (1)) = "B" then
                  Ids (NB) := Fl (2);
                  Bases (NB) := Parse_Header (To_String (Fl (3)));
                  NB := NB + 1;
               elsif To_String (Fl (1)) = "C" and then N >= 7 then
                  declare
                     Base : Natural := 0;
                     H    : Header_Bytes;
                     Size : constant Long_Long_Integer := Val (To_String (Fl (4)));
                     Len  : constant Long_Long_Integer := Val (To_String (Fl (5)));
                  begin
                     for K in 0 .. NB - 1 loop
                        if Ids (K) = Fl (2) then
                           Base := K;
                        end if;
                     end loop;
                     H := Bases (Base);
                     Apply_Edits (H, To_String (Fl (3)));
                     Check_Case (H, Header_Length (Len), File_Size (Size), To_String (Fl (6)), "case " & Line);
                     NC := NC + 1;
                  end;
               end if;
            end if;
         end;
      end loop;
      TIO.Close (F);
      TIO.Put_Line ("oracle cases (python reference, verified against SQLite): " & Img (Long_Long_Integer (NC)) & " from " & Path);
      if NC = 0 then
         Fail ("no cases in " & Path);
      end if;
   end Run_Cases;

   procedure Run_Real_Headers (Path : String) is
      use Ada.Strings.Unbounded;
      F  : TIO.File_Type;
      Fl : Fields;
      N, Count : Natural := 0;
   begin
      TIO.Open (F, TIO.In_File, Path);
      while not TIO.End_Of_File (F) loop
         declare
            Line : constant String := TIO.Get_Line (F);
         begin
            if Line'Length > 0 and then Line (Line'First) /= '#' then
               Split (Line, Fl, N);
               Check_Case (Parse_Header (To_String (Fl (2))), 100, File_Size (Val (To_String (Fl (3)))),
                           To_String (Fl (4)), "real header " & Line (Line'First .. Line'First + 12));
               Count := Count + 1;
            end if;
         end;
      end loop;
      TIO.Close (F);
      TIO.Put_Line ("committed real-file headers: " & Img (Long_Long_Integer (Count)) & " (all must be Ok)");
      if Count /= 39 then
         Fail ("expected 39 real headers, found" & Natural'Image (Count));
      end if;
   end Run_Real_Headers;

   --  The 39 real replay files themselves (only when the directory exists).
   procedure Run_Real_Files (Dir : String) is
      S : Ada.Directories.Search_Type;
      E : Ada.Directories.Directory_Entry_Type;
      Count : Natural := 0;
   begin
      if not Ada.Directories.Exists (Dir) then
         TIO.Put_Line ("real replay directory absent, skipped: " & Dir);
         return;
      end if;
      Ada.Directories.Start_Search (S, Dir, "*.sqlite");
      while Ada.Directories.More_Entries (S) loop
         Ada.Directories.Get_Next_Entry (S, E);
         declare
            package SIO renames Ada.Streams.Stream_IO;
            Sz   : constant Long_Long_Integer :=
              Long_Long_Integer (Ada.Directories.Size (Ada.Directories.Full_Name (E)));
            FIO  : SIO.File_Type;
            Buf  : Ada.Streams.Stream_Element_Array (1 .. 100);
            Last : Ada.Streams.Stream_Element_Offset;
            H    : Header_Bytes := (others => 0);
         begin
            SIO.Open (FIO, SIO.In_File, Ada.Directories.Full_Name (E));
            SIO.Read (FIO, Buf, Last);
            SIO.Close (FIO);
            for I in 1 .. Natural (Last) loop
               H (I - 1) := Byte (Buf (Ada.Streams.Stream_Element_Offset (I)));
            end loop;
            Check_Case (H, Natural (Last), File_Size (Sz),
                        "OK:4096:" & Img (Sz / 4096) & ":UTF_8:0", "real file " & Ada.Directories.Simple_Name (E));
            Count := Count + 1;
         end;
      end loop;
      Ada.Directories.End_Search (S);
      TIO.Put_Line ("real replay files read directly: " & Natural'Image (Count) & " (each must be Ok, page size 4096, count = size/4096)");
      if Count /= 39 then
         Fail ("expected 39 real files, found" & Natural'Image (Count));
      end if;
   end Run_Real_Files;

   ---------------------------------------------------------------------------
   --  Sweeps
   ---------------------------------------------------------------------------
   Pages_Of : constant array (1 .. 8) of Unsigned_64 := (512, 1024, 2048, 4096, 8192, 16384, 32768, 65536);

   --  Every value of every header byte, on valid headers of every page size, several file sizes.
   procedure Sweep_Bytes is
      N : Long_Long_Integer := 0;
   begin
      for P of Pages_Of loop
         for Pages in Unsigned_64 range 1 .. 3 loop
            declare
               Base : constant Header_Bytes := Valid_Header (P, Pages);
               S0   : constant File_Size := To_Size (Pages, P);
            begin
               for Off in Header_Index loop
                  for V in Byte loop
                     declare
                        H : Header_Bytes := Base;
                     begin
                        H (Off) := V;
                        Check_Model (H, 100, S0, "byte" & Integer'Image (Off) & "=" & Byte'Image (V));
                        Check_Model (H, 100, S0 + 1, "byte+1");
                        Check_Model (H, 100, S0 - 1, "byte-1");
                        N := N + 3;
                     end;
                  end loop;
               end loop;
            end;
         end loop;
      end loop;
      TIO.Put_Line ("every value of every byte (8 page sizes x 3 page counts x 3 sizes): " & Img (N));
   end Sweep_Bytes;

   --  Page size field: all 65536 values x reserved bytes x file sizes
   procedure Sweep_Page_Size is
      N : Long_Long_Integer := 0;
      Reserved : constant array (1 .. 6) of Byte := (0, 1, 32, 33, 34, 255);
   begin
      for V in 0 .. (if Small then 4095 else 65535) loop
         for R of Reserved loop
            for Z in 1 .. 3 loop
               declare
                  H : Header_Bytes := Valid_Header (4096, 4);
                  S : constant File_Size :=
                    (case Z is when 1 => 4 * 4096, when 2 => 100, when others => Long_Long_Integer'Last);
               begin
                  H (16) := Byte (V / 256); H (17) := Byte (V mod 256); H (20) := R;
                  Check_Model (H, 100, S, "page size field" & Integer'Image (V));
                  N := N + 1;
               end;
            end loop;
         end loop;
      end loop;
      TIO.Put_Line ("page size field, all 65536 values x 6 reserved x 3 sizes: " & Img (N));
   end Sweep_Page_Size;

   --  4-byte fields: schema format, text encoding, change counter, valid-for, page count
   procedure Sweep_Words is
      N : Long_Long_Integer := 0;
      Vals : constant array (1 .. 20) of Unsigned_64 :=
        (0, 1, 2, 3, 4, 5, 6, 7, 8, 255, 256, 257, 65535, 65536, 16#1000000#, 16#7FFFFFFF#, 16#80000000#,
         16#FFFFFFFE#, 16#FFFFFFFF#, 16#01000001#);
      Offs : constant array (1 .. 5) of Word_Offset := (24, 28, 44, 56, 92);
   begin
      for P of Pages_Of loop
         for Off of Offs loop
            for V of Vals loop
               for Pages in Unsigned_64 range 0 .. 4 loop
                  declare
                     H : Header_Bytes := Valid_Header (P, 3);
                     S : constant File_Size := To_Size (Pages, P);
                  begin
                     Put32 (H, Off, V);
                     Check_Model (H, 100, S, "word" & Word_Offset'Image (Off) & "=" & Unsigned_64'Image (V));
                     Check_Model (H, 100, S + 7, "word, partial page");
                     N := N + 2;
                  end;
               end loop;
            end loop;
         end loop;
      end loop;
      TIO.Put_Line ("4-byte fields (24,28,44,56,92) x 20 values x sizes: " & Img (N));
   end Sweep_Words;

   --  Documented precedence, as an explicit expectation (not via the model): every subset of header
   --  defects, with and without Too_Short, with each of the three size defects.
   procedure Precedence_Matrix is
      N : Long_Long_Integer := 0;
      Expect_Order : constant array (1 .. 6) of Error_Kind :=
        (Bad_Magic, Bad_Page_Size, Bad_Version, Bad_Payload_Fractions, Bad_Schema_Format, Bad_Text_Encoding);
   begin
      for Subset in 0 .. 63 loop
         for Size_Defect in 0 .. 3 loop         --  0 none, 1 truncated, 2 zero pages, 3 not a multiple
            for Short in 0 .. 2 loop            --  0 fine, 1 fewer than 100 bytes given, 2 file < 100 bytes
               declare
                  H      : Header_Bytes := Valid_Header (4096, 4);
                  Size   : File_Size := 4 * 4096;
                  Len    : Header_Length := 100;
                  Expect : Error_Kind := Too_Short;
                  Have   : Boolean := False;
                  Exp_S  : Ada.Strings.Unbounded.Unbounded_String;
               begin
                  if Subset mod 2 /= 0 then H (3) := 0; end if;                    --  Bad_Magic
                  if (Subset / 2) mod 2 /= 0 then H (16) := 0; H (17) := 3; end if; --  Bad_Page_Size (3)
                  if (Subset / 4) mod 2 /= 0 then H (19) := 3; end if;              --  Bad_Version
                  if (Subset / 8) mod 2 /= 0 then H (22) := 33; end if;             --  Bad_Payload_Fractions
                  if (Subset / 16) mod 2 /= 0 then Put32 (H, 44, 0); end if;        --  Bad_Schema_Format
                  if (Subset / 32) mod 2 /= 0 then Put32 (H, 56, 4); end if;        --  Bad_Text_Encoding
                  case Size_Defect is
                     when 1 => Size := 3 * 4096 + 5;                                --  header says 4 pages
                     when 2 => Put32 (H, 28, 0); Size := 4095;                      --  untrusted count, < 1 page
                     when 3 => Put32 (H, 28, 0); Size := 4 * 4096 + 17;
                     when others => null;
                  end case;
                  if Short = 1 then Len := 99; elsif Short = 2 then Size := 99; end if;
                  --  the explicit expectation
                  if Short /= 0 then
                     Expect := Too_Short; Have := True;
                  else
                     for K in Expect_Order'Range loop
                        if not Have and then ((Subset / 2 ** (K - 1)) mod 2 /= 0) then
                           Expect := Expect_Order (K); Have := True;
                        end if;
                     end loop;
                     if not Have and then Size_Defect /= 0 then
                        Expect := (case Size_Defect is when 1 => Truncated, when 2 => Zero_Pages,
                                                       when others => Size_Not_Page_Multiple);
                        Have := True;
                     end if;
                  end if;
                  Exp_S := Ada.Strings.Unbounded.To_Unbounded_String
                    (if Have then Error_Kind'Image (Expect) else "OK:4096:4:UTF_8:0");
                  if not Have and then Size_Defect = 0 then
                     null;
                  end if;
                  Check_Case (H, Len, Size, Ada.Strings.Unbounded.To_String (Exp_S),
                              "precedence subset" & Integer'Image (Subset) & " size defect" & Integer'Image (Size_Defect)
                              & " short" & Integer'Image (Short));
                  N := N + 1;
               end;
            end loop;
         end loop;
      end loop;
      TIO.Put_Line ("precedence matrix (64 header-defect subsets x 4 size defects x 3 length states): " & Img (N));
   end Precedence_Matrix;

   --  Fewer bytes than 100, and the extreme sizes.
   procedure Lengths_And_Extremes is
      Sizes : constant array (1 .. 9) of File_Size :=
        (0, 1, 99, 100, 4096, 4097, 16#7FFFFFFF#, Long_Long_Integer'Last - 4095, Long_Long_Integer'Last);
      N : Long_Long_Integer := 0;
      Top : constant Long_Long_Integer := Long_Long_Integer'Last - (Long_Long_Integer'Last mod 4096);
   begin
      for L in Header_Length loop
         for S of Sizes loop
            declare
               H : constant Header_Bytes := Valid_Header (4096, 1);
               R : constant Result := Validate (H, L, S);
            begin
               Checks := Checks + 1; N := N + 1;
               if L < 100 or else S < 100 then
                  if not (not R.Valid and then R.Error = Too_Short) then Fail ("short case " & Fmt (R)); end if;
               end if;
               Check_Model (H, L, S, "length sweep");
            end;
         end loop;
      end loop;
      --  zeroed and 0xFF headers
      Check_Case ((others => 0), 100, 4096, "BAD_MAGIC", "all zero");
      Check_Case ((others => 255), 100, Long_Long_Integer'Last, "BAD_MAGIC", "all FF");
      Check_Case ((others => 0), 0, 0, "TOO_SHORT", "empty");
      --  maximal file, count derived from the size (counter != valid-for)
      declare
         H : Header_Bytes := Valid_Header (4096, 0);
      begin
         Check_Case (H, 100, Top, "OK:4096:" & Img (Top / 4096) & ":UTF_8:0", "max size, derived count");
         Check_Case (H, 100, Long_Long_Integer'Last, "SIZE_NOT_PAGE_MULTIPLE", "2**63-1");
         Put32 (H, 92, 8);        --  stale counter pair, count 0
         Check_Case (H, 100, Top, "OK:4096:" & Img (Top / 4096) & ":UTF_8:0", "max size, stale");
         H := Valid_Header (512, 0);
         Put32 (H, 28, 16#FFFFFFFF#);
         Check_Case (H, 100, Long_Long_Integer'Last - (Long_Long_Integer'Last mod 512),
                     "OK:512:4294967295:UTF_8:0", "max size, 2**32-1 pages trusted");
         Put32 (H, 28, 5);  --  trusted 5 pages, file holds 4 pages and a bit
         Check_Case (H, 100, 4 * 512 + 100, "TRUNCATED", "partial page does not count");
      end;
      --  smallest valid files: one page of every size
      for P of Pages_Of loop
         Check_Case (Valid_Header (P, 1), 100, File_Size (P),
                     "OK:" & Img (Long_Long_Integer (P)) & ":1:UTF_8:0", "one page");
         Check_Case (Valid_Header (P, 1), 100, File_Size (P) - 1, "TRUNCATED", "one page minus a byte");
      end loop;
      declare
         H : Header_Bytes := Valid_Header (512, 1);
      begin
         H (19) := 2; H (18) := 2; Put32 (H, 56, 3);
         Check_Case (H, 100, 512, "OK:512:1:UTF_16BE:1", "wal, utf-16be");
         Put32 (H, 56, 2); H (19) := 1;
         Check_Case (H, 100, 512, "OK:512:1:UTF_16LE:0", "utf-16le, write version 2 only");
         H (20) := 32;
         Check_Case (H, 100, 512, "OK:512:1:UTF_16LE:0", "usable size exactly 480");
         H (20) := 33;
         Check_Case (H, 100, 512, "BAD_PAGE_SIZE", "usable size 479");
      end;
      TIO.Put_Line ("length 0..100 x 9 sizes (0, 1, 99, 100, ..., 2**63-1) and extremes: " & Img (N));
   end Lengths_And_Extremes;

   --  Random headers: mutations of valid headers, random sizes around the page-count boundary.
   procedure Random_Differential (Count : Long_Long_Integer) is
      Ok_Seen, Err_Seen : Long_Long_Integer := 0;
      Kinds : array (Error_Kind) of Long_Long_Integer := (others => 0);
   begin
      for I in 1 .. Count loop
         declare
            P     : constant Unsigned_64 := Pages_Of (Integer (Below (8)) + 1);
            Pages : constant Unsigned_64 := Below (6);
            H     : Header_Bytes := Valid_Header (P, Pages);
            S     : File_Size;
            L     : Header_Length := 100;
         begin
            for K in 1 .. Below (4) loop
               case Below (8) is
                  when 0 => H (Integer (Below (100))) := Byte (Below (256));
                  when 1 => H (Integer (Below (100))) := H (Integer (Below (100))) xor Byte (Shift_Left (Unsigned_32'(1), Natural (Below (8))));
                  when 2 => Put32 (H, 28, (case Below (4) is when 0 => Pages, when 1 => Pages + 1, when 2 => 0, when others => Below (2 ** 32)));
                  when 3 => Put32 (H, 56, Below (6));
                  when 4 => Put32 (H, 44, Below (7));
                  when 5 => Put32 (H, 92, Below (3));
                  when 6 => H (16) := Byte (Below (256)); H (17) := Byte (Below (4));
                  when others => H (20) := Byte (Below (256));
               end case;
            end loop;
            case Below (6) is
               when 0 => S := File_Size (Below (2 ** 20));
               when 1 => S := File_Size (Pages * P) + File_Size (Below (3));
               when 2 => S := Long_Long_Integer'Last - Long_Long_Integer (Below (5000));
               when 3 => S := File_Size (Below (2 ** 40));
               when others => S := File_Size (Pages * P);
            end case;
            if Below (50) = 0 then
               L := Header_Length (Below (101));
            end if;
            declare
               R : constant Result := Validate (H, L, S);
            begin
               if R.Valid then Ok_Seen := Ok_Seen + 1; else Kinds (R.Error) := Kinds (R.Error) + 1; Err_Seen := Err_Seen + 1; end if;
            end;
            Check_Model (H, L, S, "random" & Long_Long_Integer'Image (I));
         end;
      end loop;
      TIO.Put_Line ("random differential vs model:" & Long_Long_Integer'Image (Count) & " headers; Ok" & Long_Long_Integer'Image (Ok_Seen)
                    & ", errors" & Long_Long_Integer'Image (Err_Seen));
      for K in Error_Kind loop
         TIO.Put_Line ("    " & Error_Kind'Image (K) & Long_Long_Integer'Image (Kinds (K)));
         if Kinds (K) = 0 then
            Fail ("random run never produced " & Error_Kind'Image (K));
         end if;
      end loop;
   end Random_Differential;

begin
   if Ada.Command_Line.Argument_Count < 2 then
      TIO.Put_Line ("usage: test_sqlite_header <cases.txt> <real_headers.txt> [<replays-dir>] [small]");
      Ada.Command_Line.Set_Exit_Status (2);
      return;
   end if;
   for I in 3 .. Ada.Command_Line.Argument_Count loop
      if Ada.Command_Line.Argument (I) = "small" then
         Small := True;
      end if;
   end loop;

   Run_Cases (Ada.Command_Line.Argument (1));
   Run_Real_Headers (Ada.Command_Line.Argument (2));
   if Ada.Command_Line.Argument_Count >= 3 and then Ada.Command_Line.Argument (3) /= "small" then
      Run_Real_Files (Ada.Command_Line.Argument (3));
   end if;
   Lengths_And_Extremes;
   Precedence_Matrix;
   Sweep_Bytes;
   Sweep_Words;
   Sweep_Page_Size;
   Random_Differential (if Small then 200_000 else 5_000_000);

   TIO.Put_Line ("checks executed:" & Long_Long_Integer'Image (Checks));
   if Failures = 0 then
      TIO.Put_Line ("OK: all checks passed");
   else
      TIO.Put_Line ("FAILED:" & Natural'Image (Failures) & " failure(s)");
      Ada.Command_Line.Set_Exit_Status (1);
   end if;
end Test_Sqlite_Header;

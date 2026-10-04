--  Native differential test of Recorder_Schema (not part of the proof project).
--    test_recorder_schema --dump                      print the required tables / columns / affinities
--    test_recorder_schema [--small] [--bench] FILE..  run case files (A = affinity, S/T/C/E = schema cases),
--                                                     then the built-in exhaustive / limit / fuzz tests
--  Contracts build (-gnata): every pre/postcondition of the unit is executed on every call, so each call
--  is also checked against the declarative specification.  --small shrinks the built-in workloads.
with Ada.Command_Line;
with Ada.Real_Time;
with Ada.Text_IO;
with Recorder_Schema; use Recorder_Schema;

procedure Test_Recorder_Schema is

   package TIO renames Ada.Text_IO;

   type U64 is mod 2 ** 64;
   Seed : U64 := 16#9E3779B97F4A7C15#;

   function Rand return U64 is
   begin
      Seed := Seed xor (Seed * 2 ** 13);
      Seed := Seed xor (Seed / 2 ** 7);
      Seed := Seed xor (Seed * 2 ** 17);
      return Seed;
   end Rand;

   function Rand_Below (N : Positive) return Natural is (Natural (Rand mod U64 (N)));

   Fails : Natural := 0;
   Small : Boolean := False;
   Bench : Boolean := False;

   procedure Fail (Msg : String) is
   begin
      Fails := Fails + 1;
      if Fails <= 20 then
         TIO.Put_Line ("FAIL: " & Msg);
      end if;
   end Fail;

   function Image (T : Text) return String is (T.Bytes (1 .. Natural (T.Length)));

   function Upper (X : String) return String is
      R : String := X;
   begin
      for K in R'Range loop
         if R (K) in 'a' .. 'z' then
            R (K) := Character'Val (Character'Pos (R (K)) - 32);
         end if;
      end loop;
      return R;
   end Upper;

   function Aff_Char (A : Affinity) return Character is
     (case A is
        when Integer_Affinity => 'I',
        when Text_Affinity    => 'T',
        when Blob_Affinity    => 'B',
        when Real_Affinity    => 'R',
        when Numeric_Affinity => 'N');

   function Render (R : Report) return String is
      Res : String (1 .. 1 + 1 + 9 + 1 + 61);
      P   : Positive := 3;
   begin
      Res (1) := (case R.Status is when Ok => 'O', when Mismatch => 'M', when Over_Limit => 'L');
      Res (2) := ' ';
      for T in Table_Id loop
         Res (P) := (if R.Problems.Missing_Table (T) then '1' else '0');
         P := P + 1;
      end loop;
      Res (P) := ' ';
      P := P + 1;
      for C in Column_Id loop
         Res (P) := (case R.Problems.Column (C) is
                       when No_Fault => '.', when Missing_Column => 'M', when Wrong_Affinity => 'W');
         P := P + 1;
      end loop;
      return Res;
   end Render;

   ---------------------------------------------------------------------------------------------
   --  Independent naive reference for the affinity rules (plain loops over a lower-cased copy)
   ---------------------------------------------------------------------------------------------

   function Ref_Affinity (D : String) return Character is
      L : String (1 .. D'Length);

      function Has (W : String) return Boolean is
      begin
         for I in L'Range loop
            if I + W'Length - 1 <= L'Last and then L (I .. I + W'Length - 1) = W then
               return True;
            end if;
         end loop;
         return False;
      end Has;
   begin
      for K in D'Range loop
         L (K - D'First + 1) :=
           (if D (K) in 'A' .. 'Z' then Character'Val (Character'Pos (D (K)) + 32) else D (K));
      end loop;
      if Has ("int") then
         return 'I';
      elsif Has ("char") or else Has ("clob") or else Has ("text") then
         return 'T';
      elsif D'Length = 0 or else Has ("blob") then
         return 'B';
      elsif Has ("real") or else Has ("floa") or else Has ("doub") then
         return 'R';
      else
         return 'N';
      end if;
   end Ref_Affinity;

   ---------------------------------------------------------------------------------------------
   --  The one big description, reused for every case (so stale data from earlier cases is the
   --  "garbage beyond the counts" the unit must ignore)
   ---------------------------------------------------------------------------------------------

   S : Schema_Description;

   procedure Garbage_Text (T : in out Text) is
   begin
      case Rand_Below (4) is
         when 0      => T.Length := Count (Rand_Below (200));
         when 1      => T.Length := Count (Rand_Below (70));
         when 2      => T.Length := Count (Rand mod 2 ** 62);
         when others => T.Length := Count (Rand_Below (5));
      end case;
      for K in T.Bytes'Range loop
         T.Bytes (K) := Character'Val (Rand_Below (256));
      end loop;
   end Garbage_Text;

   procedure Garbage_Column (C : in out Column_Info) is
   begin
      Garbage_Text (C.Name);
      Garbage_Text (C.Decl_Type);
   end Garbage_Column;

   procedure Garbage_Table (T : in out Table_Entry) is
   begin
      Garbage_Text (T.Name);
      T.Column_Count := Count (Rand mod 2 ** 62);
      for J in T.Columns'Range loop
         Garbage_Column (T.Columns (J));
      end loop;
   end Garbage_Table;

   procedure Garbage_All is
   begin
      S.Table_Count := Count (Rand mod 2 ** 62);
      for I in S.Tables'Range loop
         Garbage_Table (S.Tables (I));
      end loop;
   end Garbage_All;

   procedure Pad (T : in out Text) is
      N : constant Natural := Natural (Count'Min (T.Length, Max_Text));
   begin
      for K in N + 1 .. Max_Text loop
         T.Bytes (K) := Character'Val (Rand_Below (256));
      end loop;
   end Pad;

   --  Scribble over what the description does not define: the padding bytes after each stored text and
   --  the first slots beyond the stored counts (the rest keeps whatever earlier cases left there).
   procedure Scribble is
   begin
      for I in 1 .. Stored_Tables (S) loop
         Pad (S.Tables (I).Name);
         for J in 1 .. Stored_Columns (S.Tables (I)) loop
            Pad (S.Tables (I).Columns (J).Name);
            Pad (S.Tables (I).Columns (J).Decl_Type);
         end loop;
         if Stored_Columns (S.Tables (I)) < Max_Columns then
            Garbage_Column (S.Tables (I).Columns (Stored_Columns (S.Tables (I)) + 1));
         end if;
      end loop;
      for I in Stored_Tables (S) + 1 .. Natural'Min (Max_Tables, Stored_Tables (S) + 2) loop
         Garbage_Table (S.Tables (I));
      end loop;
   end Scribble;

   ---------------------------------------------------------------------------------------------
   --  Building descriptions in code
   ---------------------------------------------------------------------------------------------

   function Declared_Type (A : Affinity) return String is
     (case A is
        when Integer_Affinity => "INTEGER",
        when Text_Affinity    => "TEXT",
        when Real_Affinity    => "REAL",
        when Blob_Affinity    => "BLOB",
        when Numeric_Affinity => "NUMERIC");

   function Slot (T : Table_Id) return Positive is (Table_Id'Pos (T) + 1);

   --  The recorder schema exactly as lua/main.lua declares it: slots 1 .. 9 in Table_Id order.
   procedure Fill_Recorder is
   begin
      S.Table_Count := 9;
      for T in Table_Id loop
         declare
            E : Table_Entry renames S.Tables (Slot (T));
            N : Natural := 0;
         begin
            E.Name := Table_Name (T);
            for C in Column_Id loop
               if Column_Table (C) = T then
                  N := N + 1;
                  E.Columns (N).Name := Column_Name (C);
                  E.Columns (N).Decl_Type := Make (Declared_Type (Column_Affinity (C)));
               end if;
            end loop;
            E.Column_Count := Count (N);
         end;
      end loop;
      Scribble;
   end Fill_Recorder;

   Total_Calls : Natural := 0;

   function Run return Report is
   begin
      Total_Calls := Total_Calls + 1;
      return Check (S);
   end Run;

   procedure Expect (What : String; Want : Report) is
      Got : constant Report := Run;
   begin
      if Got /= Want then
         Fail (What & ": want " & Render (Want) & " got " & Render (Got));
      end if;
   end Expect;

   procedure Expect_Ok (What : String) is
   begin
      Expect (What, (Status => Ok, Problems => No_Problems));
   end Expect_Ok;

   procedure Expect_Limit (What : String) is
   begin
      Expect (What, (Status => Over_Limit, Problems => No_Problems));
   end Expect_Limit;

   ---------------------------------------------------------------------------------------------
   --  Case files
   ---------------------------------------------------------------------------------------------

   Line : String (1 .. 8192);
   Last : Natural;

   type Span is record
      First, Last : Natural;
   end record;
   type Span_Array is array (1 .. 8) of Span;
   Tok  : Span_Array;
   NTok : Natural;

   procedure Split is
      I : Natural := 1;
   begin
      NTok := 0;
      while I <= Last loop
         while I <= Last and then Line (I) = ' ' loop
            I := I + 1;
         end loop;
         exit when I > Last;
         NTok := NTok + 1;
         Tok (NTok).First := I;
         while I <= Last and then Line (I) /= ' ' loop
            I := I + 1;
         end loop;
         Tok (NTok).Last := I - 1;
      end loop;
   end Split;

   function Tk (N : Positive) return String is (Line (Tok (N).First .. Tok (N).Last));

   function Hex_Val (C : Character) return Natural is
     (case C is
        when '0' .. '9' => Character'Pos (C) - Character'Pos ('0'),
        when 'a' .. 'f' => Character'Pos (C) - Character'Pos ('a') + 10,
        when others     => Character'Pos (C) - Character'Pos ('A') + 10);

   function Hex_Byte (Hex : String; K : Positive) return Character is
     (Character'Val (16 * Hex_Val (Hex (Hex'First + 2 * (K - 1))) + Hex_Val (Hex (Hex'First + 2 * (K - 1) + 1))));

   --  Hex of the first min (Len, 64) bytes ('-' = none).
   procedure Set_Text (T : in out Text; Len : Count; Hex : String) is
      N : constant Natural := (if Hex = "-" then 0 else Hex'Length / 2);
   begin
      if N > Max_Text then
         Fail ("case file: text longer than 64 stored bytes");
         return;
      end if;
      for K in 1 .. N loop
         T.Bytes (K) := Hex_Byte (Hex, K);
      end loop;
      T.Length := Len;
   end Set_Text;

   Case_No, Affinity_Cases, Schema_Cases : Natural := 0;
   Out_Ok, Out_Mismatch, Out_Limit       : Natural := 0;

   procedure Affinity_Case is
      D : String (1 .. 256);
      N : Natural := 0;
      H : constant String := Tk (2);
   begin
      Affinity_Cases := Affinity_Cases + 1;
      if H /= "-" then
         for K in 1 .. H'Length / 2 loop
            N := N + 1;
            D (N) := Hex_Byte (H, K);
         end loop;
      end if;
      if Aff_Char (Affinity_Of (D (1 .. N))) /= Tk (3) (Tk (3)'First) then
         Fail ("affinity of hex " & H & ": want " & Tk (3) & " got " & Aff_Char (Affinity_Of (D (1 .. N))));
      end if;
   end Affinity_Case;

   procedure Read_Cases (Name : String) is
      F : TIO.File_Type;
   begin
      TIO.Open (F, TIO.In_File, Name);
      while not TIO.End_Of_File (F) loop
         TIO.Get_Line (F, Line, Last);
         Split;
         if NTok = 0 then
            null;
         elsif Tk (1) = "A" then
            Affinity_Case;
         elsif Tk (1) = "S" then
            Case_No := Case_No + 1;
            Schema_Cases := Schema_Cases + 1;
            declare
               Stored : constant Natural := Natural'Value (Tk (3));
            begin
               S.Table_Count := Count'Value (Tk (2));
               for I in 1 .. Stored loop
                  TIO.Get_Line (F, Line, Last);
                  Split;
                  declare
                     NLen   : constant Count := Count'Value (Tk (2));
                     NHex   : constant String := Tk (3);
                     CCount : constant Count := Count'Value (Tk (4));
                     NCols  : constant Natural := Natural'Value (Tk (5));
                  begin
                     S.Tables (I).Column_Count := CCount;
                     Set_Text (S.Tables (I).Name, NLen, NHex);
                     for J in 1 .. NCols loop
                        TIO.Get_Line (F, Line, Last);
                        Split;
                        Set_Text (S.Tables (I).Columns (J).Name, Count'Value (Tk (2)), Tk (3));
                        Set_Text (S.Tables (I).Columns (J).Decl_Type, Count'Value (Tk (4)), Tk (5));
                     end loop;
                  end;
               end loop;
            end;
            TIO.Get_Line (F, Line, Last);
            Split;
            if Tk (1) /= "E" then
               Fail ("case file: E line expected");
            else
               declare
                  Want : constant String := Tk (2) & ' ' & Tk (3) & ' ' & Tk (4);
                  Got  : constant Report := Run;
                  GotS : constant String := Render (Got);
               begin
                  case Got.Status is
                     when Ok         => Out_Ok := Out_Ok + 1;
                     when Mismatch   => Out_Mismatch := Out_Mismatch + 1;
                     when Over_Limit => Out_Limit := Out_Limit + 1;
                  end case;
                  if GotS /= Want then
                     Fail (Name & " schema case" & Natural'Image (Case_No) & ": want " & Want & " got " & GotS);
                  end if;
                  --  the same description with everything undefined scribbled over must give the same answer
                  Scribble;
                  if Render (Run) /= Want then
                     Fail (Name & " schema case" & Natural'Image (Case_No) & ": result changed after scribbling");
                  end if;
               end;
            end if;
         else
            Fail ("case file: unknown line " & Line (1 .. Natural'Min (Last, 40)));
         end if;
      end loop;
      TIO.Close (F);
   end Read_Cases;

   ---------------------------------------------------------------------------------------------
   --  Built-in tests
   ---------------------------------------------------------------------------------------------

   procedure Exhaustive_Affinity is
      Alphabet : constant String := "iNtcHarlobexfdu ";
      Max_Len  : constant Natural := (if Small then 4 else 5);
      Buf      : String (1 .. 8);
      Idx      : array (1 .. 8) of Natural;
      N        : Natural := 0;
   begin
      for Len in 0 .. Max_Len loop
         Idx := [others => 1];
         loop
            for K in 1 .. Len loop
               Buf (K) := Alphabet (Idx (K));
            end loop;
            N := N + 1;
            if Aff_Char (Affinity_Of (Buf (1 .. Len))) /= Ref_Affinity (Buf (1 .. Len)) then
               Fail ("exhaustive affinity of '" & Buf (1 .. Len) & "'");
            end if;
            declare
               K : Natural := 1;
            begin
               while K <= Len and then Idx (K) = Alphabet'Length loop
                  Idx (K) := 1;
                  K := K + 1;
               end loop;
               exit when K > Len;
               Idx (K) := Idx (K) + 1;
            end;
         end loop;
      end loop;
      TIO.Put_Line ("exhaustive affinity strings:" & Natural'Image (N));
   end Exhaustive_Affinity;

   function Word (K : Positive) return String is
     (case K is
        when 1 => "INT", when 2 => "char", when 3 => "CLOB", when 4 => "tExt", when 5 => "BLOB",
        when 6 => "real", when 7 => "FLOA", when 8 => "doub", when 9 => "x", when 10 => "NUMERIC",
        when 11 => "(10,2)", when 12 => " ", when 13 => "in", when others => "Te");

   procedure Random_Affinity is
      Rounds : constant Natural := (if Small then 3_000 else 150_000);
      Buf    : String (1 .. 4096);
   begin
      for R in 1 .. Rounds loop
         declare
            N : Natural := 0;
         begin
            for W in 1 .. Rand_Below (12) loop
               if Rand_Below (5) = 0 then
                  N := N + 1;
                  Buf (N) := Character'Val (Rand_Below (256));   --  raw byte, may be NUL or non-ASCII
               else
                  declare
                     Wd : constant String := Word (1 + Rand_Below (14));
                  begin
                     Buf (N + 1 .. N + Wd'Length) := Wd;
                     N := N + Wd'Length;
                  end;
               end if;
            end loop;
            if Rand_Below (50) = 0 then   --  long strings
               for K in 1 .. 3000 loop
                  N := N + 1;
                  Buf (N) := 'x';
               end loop;
               Buf (N - Rand_Below (2900)) := 'I';
            end if;
            if Aff_Char (Affinity_Of (Buf (1 .. N))) /= Ref_Affinity (Buf (1 .. N)) then
               Fail ("random affinity round" & Natural'Image (R));
            end if;
         end;
      end loop;
      TIO.Put_Line ("random affinity strings:" & Natural'Image (Rounds));
   end Random_Affinity;

   procedure Builtin_Schema_Tests is
      Saved : Table_Entry;
   begin
      Fill_Recorder;
      Expect_Ok ("recorder schema");

      --  extra tables / order are allowed
      S.Table_Count := 10;
      S.Tables (10) := S.Tables (1);
      S.Tables (10).Name := Make ("sqlite_sequence");
      Expect_Ok ("extra table");
      Saved := S.Tables (1);
      S.Tables (1) := S.Tables (9);
      S.Tables (9) := Saved;
      Expect_Ok ("tables reordered");
      Fill_Recorder;

      --  dropping each table / column, renaming, retyping gives exactly that one problem
      for T in Table_Id loop
         declare
            Keep : constant Table_Entry := S.Tables (Slot (T));
            Want : Report := (Status => Mismatch, Problems => No_Problems);
         begin
            S.Tables (Slot (T)).Name := Make ("Z" & Image (Keep.Name));
            Want.Problems.Missing_Table (T) := True;
            Expect ("drop " & Image (Keep.Name), Want);
            S.Tables (Slot (T)).Name := Make (Upper (Image (Keep.Name)));
            Expect_Ok ("upper-case table " & Image (Keep.Name));
            S.Tables (Slot (T)) := Keep;
         end;
      end loop;
      for C in Column_Id loop
         declare
            T    : constant Table_Id := Column_Table (C);
            E    : Table_Entry renames S.Tables (Slot (T));
            Keep : constant Table_Entry := E;
            J    : Positive := 1;
            Want : Report := (Status => Mismatch, Problems => No_Problems);
         begin
            while not Same_Name (E.Columns (J).Name, Column_Name (C)) loop
               J := J + 1;
            end loop;
            E.Columns (J).Name := Make (Upper (Image (Column_Name (C))));
            Expect_Ok ("upper-case column " & Image (Column_Name (C)));
            E.Columns (J).Name := Make (Image (Column_Name (C)) & "_");
            Want.Problems.Column (C) := Missing_Column;
            Expect ("rename " & Image (Column_Name (C)), Want);
            E.Columns (J) := Keep.Columns (J);
            for A in Affinity loop
               E.Columns (J).Decl_Type := Make (Declared_Type (A));
               if A = Column_Affinity (C) then
                  Expect_Ok ("same affinity " & Image (Column_Name (C)));
               else
                  Want.Problems.Column (C) := Wrong_Affinity;
                  Expect ("retype " & Image (Column_Name (C)) & " " & Declared_Type (A), Want);
               end if;
            end loop;
            E.Columns (J).Decl_Type := Make ("");
            Want.Problems.Column (C) := Wrong_Affinity;
            Expect ("no declared type " & Image (Column_Name (C)), Want);
            E := Keep;
            Expect_Ok ("restored " & Image (Column_Name (C)));
         end;
      end loop;

      --  empty list: every table missing, columns not reported separately
      S.Table_Count := 0;
      declare
         Want : Report := (Status => Mismatch, Problems => No_Problems);
      begin
         Want.Problems.Missing_Table := [others => True];
         Expect ("empty tables list", Want);
      end;
      Fill_Recorder;

      --  limits: one over, and the 64-bit extremes, each an explicit Over_Limit
      S.Table_Count := Max_Tables + 1;
      Expect_Limit ("257 tables");
      S.Table_Count := Count'Last;
      Expect_Limit ("Count'Last tables");
      Fill_Recorder;
      S.Tables (3).Column_Count := Max_Columns + 1;
      Expect_Limit ("65 columns");
      S.Tables (3).Column_Count := Count'Last;
      Expect_Limit ("Count'Last columns");
      Fill_Recorder;
      S.Tables (4).Name.Length := Max_Text + 1;
      Expect_Limit ("65-byte table name");
      Fill_Recorder;
      S.Tables (4).Columns (1).Name.Length := Count'Last;
      Expect_Limit ("huge column name");
      Fill_Recorder;
      S.Tables (4).Columns (1).Decl_Type.Length := Max_Text + 1;
      Expect_Limit ("65-byte declared type");
      Fill_Recorder;
      Expect_Ok ("restored");
      TIO.Put_Line ("built-in schema tests done");
   end Builtin_Schema_Tests;

   procedure Fuzz is
      Rounds : constant Natural := (if Small then 40 else 300);
   begin
      for R in 1 .. Rounds loop
         Garbage_All;
         declare
            Got : constant Report := Run;
         begin
            if Got.Status /= Mismatch and then Got.Problems /= No_Problems then
               Fail ("Ok / Over_Limit with problems");
            end if;
            if Got.Status = Mismatch and then Got.Problems = No_Problems then
               Fail ("Mismatch without problems");
            end if;
         end;
      end loop;
      --  in-limits path on garbage bytes: random small counts and lengths
      for R in 1 .. Rounds loop
         Garbage_All;
         S.Table_Count := Count (Rand_Below (30));
         for I in 1 .. Stored_Tables (S) loop
            S.Tables (I).Name.Length := Count (Rand_Below (30));
            S.Tables (I).Column_Count := Count (Rand_Below (30));
            for J in 1 .. Stored_Columns (S.Tables (I)) loop
               S.Tables (I).Columns (J).Name.Length := Count (Rand_Below (30));
               S.Tables (I).Columns (J).Decl_Type.Length := Count (Rand_Below (30));
            end loop;
         end loop;
         if Run.Status = Over_Limit then
            Fail ("small random description reported Over_Limit");
         end if;
      end loop;
      TIO.Put_Line ("fuzz rounds:" & Natural'Image (2 * Rounds));
   end Fuzz;

   ---------------------------------------------------------------------------------------------
   --  Benchmark
   ---------------------------------------------------------------------------------------------

   procedure Benchmark is
      use Ada.Real_Time;
      Sum  : Natural := 0;
      T0   : Time;
      Reps : constant Positive := 200_000;

      procedure Rate (Label : String; N : Positive; Start : Time; Unit : String; Per : Positive) is
         Secs : constant Long_Float := Long_Float (To_Duration (Clock - Start));
         Ns   : constant Long_Float := Secs * 1.0E9 / Long_Float (N);
      begin
         TIO.Put_Line ("BENCH " & Label & ":" & Natural'Image (Natural (Ns)) & " ns per " & Unit
                   & "  (" & Natural'Image (Natural (Long_Float (Per) * 1000.0 / Ns)) & " M" & Unit & "/s)");
      end Rate;
   begin
      Fill_Recorder;
      S.Table_Count := 10;
      S.Tables (10).Name := Make ("sqlite_sequence");
      S.Tables (10).Column_Count := 2;
      S.Tables (10).Columns (1) := (Name => Make ("name"), Decl_Type => Make (""));
      S.Tables (10).Columns (2) := (Name => Make ("seq"), Decl_Type => Make (""));
      if Check (S).Status /= Ok then
         Fail ("benchmark real schema should be Ok");
      end if;
      T0 := Clock;
      for R in 1 .. Reps loop
         S.Tables (1).Name.Bytes (1) := (if R mod 2 = 0 then 't' else 'T');   --  keep the input changing
         if Check (S).Status = Ok then
            Sum := Sum + 1;
         end if;
      end loop;
      Rate ("Check, real schema (10 tables, 61 required columns), Ok", Reps, T0, "check", 1);

      Fill_Recorder;
      S.Tables (9).Columns (16).Name := Make ("rider_idx");
      if Check (S).Status /= Mismatch then
         Fail ("benchmark mismatch schema should be Mismatch");
      end if;
      T0 := Clock;
      for R in 1 .. Reps loop
         S.Tables (1).Name.Bytes (1) := (if R mod 2 = 0 then 't' else 'T');
         if Check (S).Status = Mismatch then
            Sum := Sum + 1;
         end if;
      end loop;
      Rate ("Check, one Missing_Column", Reps, T0, "check", 1);

      --  worst case: 256 listed tables of 64 columns, the 9 required ones listed last
      Fill_Recorder;
      for I in reverse 1 .. 9 loop
         S.Tables (Max_Tables - 9 + I) := S.Tables (I);
      end loop;
      for I in 1 .. Max_Tables - 9 loop
         S.Tables (I).Name := Make ("pad" & Natural'Image (I));
         S.Tables (I).Column_Count := Max_Columns;
         for J in 1 .. Max_Columns loop
            S.Tables (I).Columns (J).Name := Make ("column_number_" & Natural'Image (J));
            S.Tables (I).Columns (J).Decl_Type := Make ("VARCHAR(255)");
         end loop;
      end loop;
      S.Table_Count := Max_Tables;
      if Check (S).Status /= Ok then
         Fail ("benchmark worst-case schema should be Ok");
      end if;
      T0 := Clock;
      for R in 1 .. 2_000 loop
         S.Tables (Max_Tables).Name.Bytes (1) := (if R mod 2 = 0 then 'a' else 'A');
         if Check (S).Status = Ok then
            Sum := Sum + 1;
         end if;
      end loop;
      Rate ("Check, worst case (256 tables x 64 columns, required last), Ok", 2_000, T0, "check", 1);
      T0 := Clock;
      for R in 1 .. 2_000 loop
         S.Tables (Max_Tables).Name.Bytes (1) := (if R mod 2 = 0 then 'a' else 'A');
         if Within_Limits (S) then
            Sum := Sum + 1;
         end if;
      end loop;
      Rate ("Within_Limits alone, 256 x 64", 2_000, T0, "scan", 1);

      declare
         Short : String := "INTEGER";
         Long  : String := "VARCHAR(255) NATIVE CHARACTER DECIMAL(10,5) UNSIGNED BIG TRAILERS!";
         Reps2 : constant Positive := 5_000_000;
      begin
         T0 := Clock;
         for R in 1 .. Reps2 loop
            Short (1) := (if R mod 2 = 0 then 'I' else 'i');
            Sum := Sum + Affinity'Pos (Affinity_Of (Short));
         end loop;
         Rate ("Affinity_Of ""INTEGER"" (7 bytes)", Reps2, T0, "call", 1);
         T0 := Clock;
         for R in 1 .. Reps2 / 5 loop
            Long (1) := (if R mod 2 = 0 then 'V' else 'v');
            Sum := Sum + Affinity'Pos (Affinity_Of (Long));
         end loop;
         Rate ("Affinity_Of " & Natural'Image (Long'Length) & "-byte type, full scan", Reps2 / 5, T0, "call", 1);
      end;
      TIO.Put_Line ("bench checksum" & Natural'Image (Sum));
   end Benchmark;

   procedure Dump is
   begin
      for C in Column_Id loop
         TIO.Put_Line (Image (Table_Name (Column_Table (C))) & ' ' & Image (Column_Name (C)) & ' '
                   & Aff_Char (Column_Affinity (C)));
      end loop;
   end Dump;

begin
   for A in 1 .. Ada.Command_Line.Argument_Count loop
      declare
         Arg : constant String := Ada.Command_Line.Argument (A);
      begin
         if Arg = "--dump" then
            Dump;
            return;
         elsif Arg = "--small" then
            Small := True;
         elsif Arg = "--bench" then
            Bench := True;
         end if;
      end;
   end loop;

   Garbage_All;
   for A in 1 .. Ada.Command_Line.Argument_Count loop
      declare
         Arg : constant String := Ada.Command_Line.Argument (A);
      begin
         if Arg'Length < 2 or else Arg (Arg'First .. Arg'First + 1) /= "--" then
            Read_Cases (Arg);
         end if;
      end;
   end loop;
   TIO.Put_Line ("case files: affinity cases" & Natural'Image (Affinity_Cases) & ", schema cases"
             & Natural'Image (Schema_Cases) & "  (Ok" & Natural'Image (Out_Ok) & ", Mismatch"
             & Natural'Image (Out_Mismatch) & ", Over_Limit" & Natural'Image (Out_Limit) & ")");
   Exhaustive_Affinity;
   Random_Affinity;
   Builtin_Schema_Tests;
   Fuzz;
   TIO.Put_Line ("Check calls:" & Natural'Image (Total_Calls));
   if Bench then
      Benchmark;
   end if;
   if Fails = 0 then
      TIO.Put_Line ("PASS");
   else
      TIO.Put_Line ("FAILED:" & Natural'Image (Fails) & " failure(s)");
      Ada.Command_Line.Set_Exit_Status (Ada.Command_Line.Failure);
   end if;
end Test_Recorder_Schema;

package body Recorder_Schema
  with SPARK_Mode
is

   function Make (S : String) return Text is
      T : Text;
   begin
      for K in 1 .. S'Length loop
         T.Bytes (K) := S (S'First + (K - 1));
         pragma Loop_Invariant (for all L in 1 .. K => T.Bytes (L) = S (S'First + (L - 1)));
      end loop;
      T.Length := Count (S'Length);
      return T;
   end Make;

   function Affinity_Of (Declared : String) return Affinity is
      Text_Seen : Boolean := False;
      Blob_Seen : Boolean := False;
      Real_Seen : Boolean := False;
   begin
      for I in Declared'Range loop
         if Matches_At (Declared, I, "int") then
            return Integer_Affinity;
         end if;
         if Matches_At (Declared, I, "char")
           or else Matches_At (Declared, I, "clob")
           or else Matches_At (Declared, I, "text")
         then
            Text_Seen := True;
         end if;
         if Matches_At (Declared, I, "blob") then
            Blob_Seen := True;
         end if;
         if Matches_At (Declared, I, "real")
           or else Matches_At (Declared, I, "floa")
           or else Matches_At (Declared, I, "doub")
         then
            Real_Seen := True;
         end if;
         pragma Loop_Invariant
           (not (for some J in Declared'First .. I => Matches_At (Declared, J, "int")));
         pragma Loop_Invariant
           (Text_Seen = (for some J in Declared'First .. I =>
                           Matches_At (Declared, J, "char") or else Matches_At (Declared, J, "clob")
                           or else Matches_At (Declared, J, "text")));
         pragma Loop_Invariant
           (Blob_Seen = (for some J in Declared'First .. I => Matches_At (Declared, J, "blob")));
         pragma Loop_Invariant
           (Real_Seen = (for some J in Declared'First .. I =>
                           Matches_At (Declared, J, "real") or else Matches_At (Declared, J, "floa")
                           or else Matches_At (Declared, J, "doub")));
      end loop;
      if Text_Seen then
         return Text_Affinity;
      elsif Declared'Length = 0 or else Blob_Seen then
         return Blob_Affinity;
      elsif Real_Seen then
         return Real_Affinity;
      else
         return Numeric_Affinity;
      end if;
   end Affinity_Of;

   function Table_Index (S : Schema_Description; T : Table_Id) return Natural is
      Name : constant Text := Table_Name (T);
   begin
      for I in 1 .. Stored_Tables (S) loop
         if Same_Name (S.Tables (I).Name, Name) then
            return I;
         end if;
         pragma Loop_Invariant (for all K in 1 .. I => not Same_Name (S.Tables (K).Name, Name));
      end loop;
      return 0;
   end Table_Index;

   function Column_Fault (Tbl : Table_Entry; C : Column_Id) return Fault_Kind is
      Name  : constant Text := Column_Name (C);
      Want  : constant Affinity := Column_Affinity (C);
      Found : Boolean := False;
      Right : Boolean := False;
   begin
      for J in 1 .. Stored_Columns (Tbl) loop
         if Same_Name (Tbl.Columns (J).Name, Name) then
            Found := True;
            if Declared_Affinity (Tbl.Columns (J).Decl_Type) = Want then
               Right := True;
            end if;
         end if;
         pragma Loop_Invariant
           (Found = (for some K in 1 .. J => Same_Name (Tbl.Columns (K).Name, Name)));
         pragma Loop_Invariant
           (Right = (for some K in 1 .. J =>
                       Same_Name (Tbl.Columns (K).Name, Name)
                       and then Declared_Affinity (Tbl.Columns (K).Decl_Type) = Want));
      end loop;
      return (if Right then No_Fault elsif Found then Wrong_Affinity else Missing_Column);
   end Column_Fault;

   function Check (S : Schema_Description) return Report is
      P : Problem_Set := No_Problems;
   begin
      if not Within_Limits (S) then
         return (Status => Over_Limit, Problems => No_Problems);
      end if;

      for T in Table_Id loop
         P.Missing_Table (T) := Table_Index (S, T) = 0;
         pragma Loop_Invariant
           (for all U in Table_Id'First .. T => P.Missing_Table (U) = (Table_Index (S, U) = 0));
      end loop;

      for C in Column_Id loop
         declare
            I : constant Natural := Table_Index (S, Column_Table (C));
         begin
            P.Column (C) := (if I = 0 then No_Fault else Column_Fault (S.Tables (I), C));
         end;
         pragma Loop_Invariant (for all U in Table_Id => P.Missing_Table (U) = (Table_Index (S, U) = 0));
         pragma Loop_Invariant
           (for all D in Column_Id'First .. C =>
              P.Column (D) =
                (if Table_Index (S, Column_Table (D)) = 0 then No_Fault
                 else Column_Fault (S.Tables (Table_Index (S, Column_Table (D))), D)));
      end loop;

      return (Status => (if P = No_Problems then Ok else Mismatch), Problems => P);
   end Check;

end Recorder_Schema;

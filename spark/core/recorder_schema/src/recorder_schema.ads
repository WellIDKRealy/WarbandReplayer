--  Recorder_Schema: does an opened SQLite database have the schema the frozen recorder (lua/main.lua)
--  writes?  Wrong / older / damaged schemas become an explicit typed Report instead of a crash later
--  (failure-modes.md A, "valid SQLite, wrong schema").  New unit, no counterpart in the old C/JS tree.
--
--  Input : a bounded description of what PRAGMA table_info returned for every table (Schema_Description).
--  Output: Check returns Ok, or Mismatch with one slot per requirement saying what is wrong, or
--          Over_Limit when the description does not fit the documented bounds.  Check is total.
--
--  Zero-footprint: Pure, no state, no standard-library units, no exceptions, no allocation, no
--  unconstrained results (nothing needs a secondary stack), no nested subprograms.  Sizes are 64-bit.
package Recorder_Schema
  with SPARK_Mode, Pure
is
   ---------------------------------------------------------------------------------------------
   --  Bounds of the input description
   ---------------------------------------------------------------------------------------------

   Max_Tables  : constant := 256;   --  tables listed
   Max_Columns : constant := 64;    --  columns listed per table
   Max_Text    : constant := 64;    --  bytes kept of a name or declared type

   subtype Count is Long_Long_Integer range 0 .. Long_Long_Integer'Last;

   ---------------------------------------------------------------------------------------------
   --  The description (what the SQLite binding fills in; every count and length is the TRUE one)
   ---------------------------------------------------------------------------------------------

   --  A byte string.  Length is the true length (it may exceed Max_Text); only the first
   --  Min (Length, Max_Text) bytes of Bytes are meaningful, the rest is ignored.
   type Text is record
      Length : Count := 0;
      Bytes  : String (1 .. Max_Text) := [others => ' '];
   end record;

   function Make (S : String) return Text
   with
     Pre  => S'Length <= Max_Text,
     Post => Make'Result.Length = Count (S'Length)
             and then (for all K in 1 .. S'Length => Make'Result.Bytes (K) = S (S'First + (K - 1)));

   --  One PRAGMA table_info row: the column name and its declared type text ('' when none).
   type Column_Info is record
      Name      : Text;
      Decl_Type : Text;
   end record;
   type Column_List is array (Positive range 1 .. Max_Columns) of Column_Info;

   --  One table.  Column_Count is the true number of columns; only the first Max_Columns are stored.
   type Table_Entry is record
      Name         : Text;
      Column_Count : Count := 0;
      Columns      : Column_List;
   end record;
   type Table_List is array (Positive range 1 .. Max_Tables) of Table_Entry;

   --  Table_Count is the true number of tables; only the first Max_Tables are stored.
   --  Entries beyond the stored counts are never looked at.
   type Schema_Description is record
      Table_Count : Count := 0;
      Tables      : Table_List;
   end record;

   function Stored_Tables (S : Schema_Description) return Natural is
     (Natural (Count'Min (S.Table_Count, Max_Tables)));
   function Stored_Columns (T : Table_Entry) return Natural is
     (Natural (Count'Min (T.Column_Count, Max_Columns)));

   --  True when nothing exceeds the bounds: at most Max_Tables tables, at most Max_Columns columns in
   --  each, and every name and declared type at most Max_Text bytes.
   function Within_Limits (S : Schema_Description) return Boolean is
     (S.Table_Count <= Max_Tables
      and then
        (for all I in 1 .. Stored_Tables (S) =>
           S.Tables (I).Name.Length <= Max_Text
           and then S.Tables (I).Column_Count <= Max_Columns
           and then
             (for all J in 1 .. Stored_Columns (S.Tables (I)) =>
                S.Tables (I).Columns (J).Name.Length <= Max_Text
                and then S.Tables (I).Columns (J).Decl_Type.Length <= Max_Text)));

   ---------------------------------------------------------------------------------------------
   --  Names: ASCII case-insensitive, as SQLite compares identifiers.  Other bytes compare exactly.
   ---------------------------------------------------------------------------------------------

   function Lower (C : Character) return Character is
     (if C in 'A' .. 'Z' then Character'Val (Character'Pos (C) + 32) else C);

   function Same_Name (A, B : Text) return Boolean is
     (A.Length = B.Length
      and then A.Length <= Max_Text
      and then (for all K in 1 .. Natural (A.Length) => Lower (A.Bytes (K)) = Lower (B.Bytes (K))));

   ---------------------------------------------------------------------------------------------
   --  SQLite type affinity (https://www.sqlite.org/datatype3.html, section 3.1)
   ---------------------------------------------------------------------------------------------

   type Affinity is (Integer_Affinity, Text_Affinity, Blob_Affinity, Real_Affinity, Numeric_Affinity);

   --  Word (lower case) starts at S (I), comparing the ASCII-lower-cased bytes of S.
   function Matches_At (S : String; I : Integer; Word : String) return Boolean is
     (I in S'Range
      and then Word'Length - 1 <= S'Last - I
      and then (for all K in 0 .. Word'Length - 1 => Lower (S (I + K)) = Word (Word'First + K)));

   --  S contains Word (lower case), ignoring ASCII case.
   function Contains (S : String; Word : String) return Boolean is
     (for some I in S'Range => Matches_At (S, I, Word));

   --  The words of the five rules (lower case; the rules ignore ASCII case).
   Kw_Int  : constant String := "int";
   Kw_Char : constant String := "char";
   Kw_Clob : constant String := "clob";
   Kw_Text : constant String := "text";
   Kw_Blob : constant String := "blob";
   Kw_Real : constant String := "real";
   Kw_Floa : constant String := "floa";
   Kw_Doub : constant String := "doub";

   --  The five rules in order: contains "INT" -> INTEGER; "CHAR" / "CLOB" / "TEXT" -> TEXT;
   --  "BLOB" or no declared type at all -> BLOB; "REAL" / "FLOA" / "DOUB" -> REAL; else NUMERIC.
   --  Total: any bytes, any length (an embedded NUL is an ordinary byte).
   function Affinity_Of (Declared : String) return Affinity
   with
     Post =>
       Affinity_Of'Result =
         (if Contains (Declared, Kw_Int) then Integer_Affinity
          elsif Contains (Declared, Kw_Char) or else Contains (Declared, Kw_Clob)
                or else Contains (Declared, Kw_Text) then Text_Affinity
          elsif Declared'Length = 0 or else Contains (Declared, Kw_Blob) then Blob_Affinity
          elsif Contains (Declared, Kw_Real) or else Contains (Declared, Kw_Floa)
                or else Contains (Declared, Kw_Doub) then Real_Affinity
          else Numeric_Affinity);

   --  Affinity of a stored declared type (only its stored bytes: see Text).
   function Declared_Affinity (T : Text) return Affinity is
     (Affinity_Of (T.Bytes (1 .. Natural (Count'Min (T.Length, Max_Text)))));

   ---------------------------------------------------------------------------------------------
   --  What the recorder writes (lua/main.lua CREATE TABLE statements; 9 tables, 61 columns)
   ---------------------------------------------------------------------------------------------

   type Table_Id is
     (Ticks, Events, Chats, Map_Switches, Score_Switches, Faction_Switches, Kills, Spawns, Agent_States);

   type Column_Id is
     (Ticks_Id, Ticks_Time, Ticks_Observer_Player_Id,
      Events_Id, Events_Tick_Id, Events_Event_Type, Events_Event_Order,
      Chats_Event_Id, Chats_Username, Chats_Team, Chats_Chat_Type, Chats_Message,
      Map_Switches_Event_Id, Map_Switches_Scene_No,
      Score_Switches_Event_Id, Score_Switches_Team_0_Score, Score_Switches_Team_1_Score,
      Faction_Switches_Event_Id, Faction_Switches_Team_0_Faction_Id, Faction_Switches_Team_0_Faction_Name,
      Faction_Switches_Team_1_Faction_Id, Faction_Switches_Team_1_Faction_Name,
      Kills_Event_Id, Kills_Type, Kills_Dead_Id, Kills_Dead_Name, Kills_Dead_X, Kills_Dead_Y, Kills_Dead_Z,
      Kills_Killer_Id, Kills_Killer_Name, Kills_Killer_X, Kills_Killer_Y, Kills_Killer_Z,
      Spawns_Event_Id, Spawns_Agent_Id, Spawns_Agent_Name, Spawns_Is_Human,
      Spawns_Pos_X, Spawns_Pos_Y, Spawns_Pos_Z, Spawns_Team, Spawns_Group_Id, Spawns_Class_Id,
      Spawns_Division_Id,
      Agent_States_Id, Agent_States_Tick_Id, Agent_States_Agent_Id,
      Agent_States_Pos_X, Agent_States_Pos_Y, Agent_States_Pos_Z, Agent_States_Yaw, Agent_States_Pitch,
      Agent_States_Hp, Agent_States_Attack_Action, Agent_States_Defend_Action,
      Agent_States_Wielded_Right, Agent_States_Wielded_Left, Agent_States_Ammo,
      Agent_States_Horse_Id, Agent_States_Rider_Id);

   function Table_Name (T : Table_Id) return Text is
     (case T is
        when Ticks            => Make ("ticks"),
        when Events           => Make ("events"),
        when Chats            => Make ("chats"),
        when Map_Switches     => Make ("map_switches"),
        when Score_Switches   => Make ("score_switches"),
        when Faction_Switches => Make ("faction_switches"),
        when Kills            => Make ("kills"),
        when Spawns           => Make ("spawns"),
        when Agent_States     => Make ("agent_states"));

   function Column_Table (C : Column_Id) return Table_Id is
     (case C is
        when Ticks_Id .. Ticks_Observer_Player_Id                  => Ticks,
        when Events_Id .. Events_Event_Order                       => Events,
        when Chats_Event_Id .. Chats_Message                       => Chats,
        when Map_Switches_Event_Id .. Map_Switches_Scene_No        => Map_Switches,
        when Score_Switches_Event_Id .. Score_Switches_Team_1_Score => Score_Switches,
        when Faction_Switches_Event_Id .. Faction_Switches_Team_1_Faction_Name => Faction_Switches,
        when Kills_Event_Id .. Kills_Killer_Z                      => Kills,
        when Spawns_Event_Id .. Spawns_Division_Id                 => Spawns,
        when Agent_States_Id .. Agent_States_Rider_Id              => Agent_States);

   function Column_Name (C : Column_Id) return Text is
     (case C is
        when Ticks_Id                            => Make ("id"),
        when Ticks_Time                          => Make ("time"),
        when Ticks_Observer_Player_Id            => Make ("observer_player_id"),
        when Events_Id                           => Make ("id"),
        when Events_Tick_Id                      => Make ("tick_id"),
        when Events_Event_Type                   => Make ("event_type"),
        when Events_Event_Order                  => Make ("event_order"),
        when Chats_Event_Id                      => Make ("event_id"),
        when Chats_Username                      => Make ("username"),
        when Chats_Team                          => Make ("team"),
        when Chats_Chat_Type                     => Make ("chat_type"),
        when Chats_Message                       => Make ("message"),
        when Map_Switches_Event_Id               => Make ("event_id"),
        when Map_Switches_Scene_No               => Make ("scene_no"),
        when Score_Switches_Event_Id             => Make ("event_id"),
        when Score_Switches_Team_0_Score         => Make ("team_0_score"),
        when Score_Switches_Team_1_Score         => Make ("team_1_score"),
        when Faction_Switches_Event_Id           => Make ("event_id"),
        when Faction_Switches_Team_0_Faction_Id  => Make ("team_0_faction_id"),
        when Faction_Switches_Team_0_Faction_Name => Make ("team_0_faction_name"),
        when Faction_Switches_Team_1_Faction_Id  => Make ("team_1_faction_id"),
        when Faction_Switches_Team_1_Faction_Name => Make ("team_1_faction_name"),
        when Kills_Event_Id                      => Make ("event_id"),
        when Kills_Type                          => Make ("type"),
        when Kills_Dead_Id                       => Make ("dead_id"),
        when Kills_Dead_Name                     => Make ("dead_name"),
        when Kills_Dead_X                        => Make ("dead_x"),
        when Kills_Dead_Y                        => Make ("dead_y"),
        when Kills_Dead_Z                        => Make ("dead_z"),
        when Kills_Killer_Id                     => Make ("killer_id"),
        when Kills_Killer_Name                   => Make ("killer_name"),
        when Kills_Killer_X                      => Make ("killer_x"),
        when Kills_Killer_Y                      => Make ("killer_y"),
        when Kills_Killer_Z                      => Make ("killer_z"),
        when Spawns_Event_Id                     => Make ("event_id"),
        when Spawns_Agent_Id                     => Make ("agent_id"),
        when Spawns_Agent_Name                   => Make ("agent_name"),
        when Spawns_Is_Human                     => Make ("is_human"),
        when Spawns_Pos_X                        => Make ("pos_x"),
        when Spawns_Pos_Y                        => Make ("pos_y"),
        when Spawns_Pos_Z                        => Make ("pos_z"),
        when Spawns_Team                         => Make ("team"),
        when Spawns_Group_Id                     => Make ("group_id"),
        when Spawns_Class_Id                     => Make ("class_id"),
        when Spawns_Division_Id                  => Make ("division_id"),
        when Agent_States_Id                     => Make ("id"),
        when Agent_States_Tick_Id                => Make ("tick_id"),
        when Agent_States_Agent_Id               => Make ("agent_id"),
        when Agent_States_Pos_X                  => Make ("pos_x"),
        when Agent_States_Pos_Y                  => Make ("pos_y"),
        when Agent_States_Pos_Z                  => Make ("pos_z"),
        when Agent_States_Yaw                    => Make ("yaw"),
        when Agent_States_Pitch                  => Make ("pitch"),
        when Agent_States_Hp                     => Make ("hp"),
        when Agent_States_Attack_Action          => Make ("attack_action"),
        when Agent_States_Defend_Action          => Make ("defend_action"),
        when Agent_States_Wielded_Right          => Make ("wielded_right"),
        when Agent_States_Wielded_Left           => Make ("wielded_left"),
        when Agent_States_Ammo                   => Make ("ammo"),
        when Agent_States_Horse_Id               => Make ("horse_id"),
        when Agent_States_Rider_Id               => Make ("rider_id"));

   --  The recorder declares every column INTEGER, TEXT or REAL.
   function Column_Affinity (C : Column_Id) return Affinity is
     (case C is
        when Events_Event_Type | Chats_Username | Chats_Team | Chats_Chat_Type | Chats_Message
           | Faction_Switches_Team_0_Faction_Name | Faction_Switches_Team_1_Faction_Name
           | Kills_Type | Kills_Dead_Name | Kills_Killer_Name | Spawns_Agent_Name | Spawns_Team
                                                              => Text_Affinity,
        when Kills_Dead_X | Kills_Dead_Y | Kills_Dead_Z | Kills_Killer_X | Kills_Killer_Y | Kills_Killer_Z
           | Spawns_Pos_X | Spawns_Pos_Y | Spawns_Pos_Z
           | Agent_States_Pos_X | Agent_States_Pos_Y | Agent_States_Pos_Z
           | Agent_States_Yaw | Agent_States_Pitch         => Real_Affinity,
        when others                                       => Integer_Affinity);

   ---------------------------------------------------------------------------------------------
   --  The result
   ---------------------------------------------------------------------------------------------

   type Status_Kind is (Ok, Mismatch, Over_Limit);

   type Fault_Kind is (No_Fault, Missing_Column, Wrong_Affinity);

   --  One slot per requirement, so a problem never needs a list and can never be dropped.
   type Table_Flags is array (Table_Id) of Boolean;
   type Column_Faults is array (Column_Id) of Fault_Kind;

   --  Missing_Table (T): table T is not listed (its columns are then not reported separately).
   --  Column (C): a column of a listed table is absent (Missing_Column) or present only with other
   --  affinities (Wrong_Affinity).
   type Problem_Set is record
      Missing_Table : Table_Flags   := [others => False];
      Column        : Column_Faults := [others => No_Fault];
   end record;

   No_Problems : constant Problem_Set :=
     (Missing_Table => [others => False], Column => [others => No_Fault]);

   type Report is record
      Status   : Status_Kind := Ok;
      Problems : Problem_Set;
   end record;

   ---------------------------------------------------------------------------------------------
   --  The check
   ---------------------------------------------------------------------------------------------

   --  Position of the FIRST listing of table T (0 = not listed).  A real database lists a name once.
   function Table_Index (S : Schema_Description; T : Table_Id) return Natural
   with
     Post =>
       Table_Index'Result <= Stored_Tables (S)
       and then
         (if Table_Index'Result = 0
          then (for all I in 1 .. Stored_Tables (S) => not Same_Name (S.Tables (I).Name, Table_Name (T)))
          else Same_Name (S.Tables (Table_Index'Result).Name, Table_Name (T))
               and then (for all I in 1 .. Table_Index'Result - 1 =>
                           not Same_Name (S.Tables (I).Name, Table_Name (T))));

   --  Missing_Column: no column of that name.  No_Fault: some column of that name has the affinity
   --  the recorder declares.  Wrong_Affinity: otherwise.
   function Column_Fault (Tbl : Table_Entry; C : Column_Id) return Fault_Kind
   with
     Post =>
       (Column_Fault'Result = Missing_Column)
         = not (for some J in 1 .. Stored_Columns (Tbl) => Same_Name (Tbl.Columns (J).Name, Column_Name (C)))
       and then
         (Column_Fault'Result = No_Fault)
           = (for some J in 1 .. Stored_Columns (Tbl) =>
                Same_Name (Tbl.Columns (J).Name, Column_Name (C))
                and then Declared_Affinity (Tbl.Columns (J).Decl_Type) = Column_Affinity (C));

   --  Total.  Over_Limit (nothing else reported) when the description exceeds the bounds; otherwise
   --  every table is looked up by Table_Index and every column of a listed table is judged by
   --  Column_Fault, and Status is Ok exactly when there is no problem.
   function Check (S : Schema_Description) return Report
   with
     Post =>
       (if not Within_Limits (S)
        then Check'Result = (Status => Over_Limit, Problems => No_Problems)
        else
          (for all T in Table_Id =>
             Check'Result.Problems.Missing_Table (T) = (Table_Index (S, T) = 0))
          and then
            (for all C in Column_Id =>
               Check'Result.Problems.Column (C) =
                 (if Table_Index (S, Column_Table (C)) = 0 then No_Fault
                  else Column_Fault (S.Tables (Table_Index (S, Column_Table (C))), C)))
          and then Check'Result.Status = (if Check'Result.Problems = No_Problems then Ok else Mismatch));
end Recorder_Schema;

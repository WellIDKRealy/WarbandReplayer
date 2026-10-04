--  Micro-benchmark of Snapshot_Swap (native, single thread): ns per operation and per full
--  hand-off cycle.  Built with run-time checks suppressed (-gnatp), like a proven unit in production.
with Ada.Real_Time; use Ada.Real_Time;
with Ada.Text_IO;
with Snapshot_Swap; use Snapshot_Swap;

procedure Bench is
   use Ada.Text_IO;
   Cycles : constant := 20_000_000;
   S      : Swap_State := Initial;
   St     : Status_Kind;
   Sl     : Slot_Id;
   Sum    : Long_Long_Integer := 0;
   T0, T1 : Time;

   function Ns_Per (Total : Time_Span; Count : Long_Long_Integer) return String is
      Ns : constant Long_Long_Integer := Long_Long_Integer (To_Duration (Total) * 1.0E9);
      X  : constant Long_Long_Integer := Ns * 100 / Count;     --  hundredths of ns
      Fr : constant String := Long_Long_Integer'Image (100 + X mod 100);
   begin
      return Long_Long_Integer'Image (X / 100) & "." & Fr (Fr'Last - 1 .. Fr'Last);
   end Ns_Per;
begin
   --  Full cycle: producer writes a frame, consumer takes the newest, draws, releases.
   T0 := Clock;
   for I in 1 .. Cycles loop
      Producer_Begin (S, St, Sl);
      Sum := Sum + Long_Long_Integer (Sl);
      Producer_Publish (S, St, Sl);
      Consumer_Acquire (S, St, Sl);
      Sum := Sum + Long_Long_Integer (Sl) + Long_Long_Integer (Status_Kind'Pos (St));
      Consumer_Release (S, St, Sl);
   end loop;
   T1 := Clock;
   Put_Line ("full cycle (Begin, Publish, Acquire, Release):" & Ns_Per (T1 - T0, Cycles) & " ns per cycle,"
             & Ns_Per (T1 - T0, 4 * Cycles) & " ns per operation");

   --  Producer running ahead of the consumer: Begin + Publish only (each Publish supersedes).
   S := Initial;
   T0 := Clock;
   for I in 1 .. Cycles loop
      Producer_Begin (S, St, Sl);
      Sum := Sum + Long_Long_Integer (Sl);
      Producer_Publish (S, St, Sl);
   end loop;
   T1 := Clock;
   Put_Line ("producer only (Begin, Publish):" & Ns_Per (T1 - T0, Cycles) & " ns per pair");

   --  Consumer polling an empty mailbox (the common case when the draw loop outruns the producer).
   S := Initial;
   T0 := Clock;
   for I in 1 .. 4 * Cycles loop
      Consumer_Acquire (S, St, Sl);
      Sum := Sum + Long_Long_Integer (Status_Kind'Pos (St));
   end loop;
   T1 := Clock;
   Put_Line ("Acquire polling Nothing_New:" & Ns_Per (T1 - T0, 4 * Cycles) & " ns per call");
   Put_Line ("checksum" & Long_Long_Integer'Image (Sum) & " last " & Seq_Number'Image (S.Last_Seq));
end Bench;

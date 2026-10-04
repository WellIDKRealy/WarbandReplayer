--  Native micro-benchmark of the camera_projection hot paths (assertions off, -O2):
--    bin_off/bench_camera_projection [iterations]
--  Each loop feeds its result back (the camera, or a running sum) so nothing is optimised away.
with Ada.Text_IO;       use Ada.Text_IO;
with Ada.Command_Line;
with Ada.Real_Time;     use Ada.Real_Time;
with Camera_Projection; use Camera_Projection;

procedure Bench_Camera_Projection is
   N : constant Natural :=
     (if Ada.Command_Line.Argument_Count >= 1 then Natural'Value (Ada.Command_Line.Argument (1)) else 20_000_000);
   C : Camera := Initial;
   S : Status;
   Acc : Long_Float := 0.0;
   T0  : Time;
   Sink : Natural := 0;

   procedure Report (Name : String; T : Time) is
      Secs : constant Duration := To_Duration (Clock - T);
      Ns   : constant Long_Float := Long_Float (Secs) * 1.0E9 / Long_Float (N);
   begin
      Put_Line (Name & ": " & Long_Float'Image (Ns) & " ns/call  ("
                & Long_Float'Image (1.0E3 / Ns) & " M calls/s)");
   end Report;
begin
   Set_Screen (C, 1920, 1080, S);

   T0 := Clock;
   for I in 1 .. N loop
      Pan (C, (if I mod 2 = 0 then 3.0 else -3.0), (if I mod 3 = 0 then 2.0 else -2.0), S);
      if S /= Ok then Sink := Sink + 1; end if;
   end loop;
   Report ("Pan             ", T0);

   T0 := Clock;
   for I in 1 .. N loop
      Apply_Zoom (C, (if I mod 2 = 0 then 100.0 else -100.0), S);
      if S /= Ok then Sink := Sink + 1; end if;
   end loop;
   Report ("Apply_Zoom      ", T0);

   Set_Key (C, 0, 1, S);
   Set_Key (C, 3, 1, S);
   T0 := Clock;
   for I in 1 .. N loop
      Advance (C, (if I mod 2 = 0 then 0.016 else -0.016), S);
      if S /= Ok then Sink := Sink + 1; end if;
   end loop;
   Report ("Advance (W+D)   ", T0);

   T0 := Clock;
   for I in 1 .. N loop
      Set_Map_Bounds (C, -100.0 - Float (I mod 7), 100.0, -50.0, 50.0 + Float (I mod 5), S);
      if S /= Ok then Sink := Sink + 1; end if;
   end loop;
   Report ("Set_Map_Bounds  ", T0);

   T0 := Clock;
   for I in 1 .. N loop
      Set_View_Shift (C, Float (I mod 100), -Float (I mod 50), S);
      if S /= Ok then Sink := Sink + 1; end if;
   end loop;
   Report ("Set_View_Shift  ", T0);

   T0 := Clock;
   for I in 1 .. N loop
      declare
         P : constant Screen_Point := World_To_Screen (C, Long_Float (I mod 1000) - 500.0, Long_Float (I mod 777) - 300.0);
      begin
         Acc := Acc + P.X + P.Y;
         if P.Outcome /= Ok then Sink := Sink + 1; end if;
      end;
   end loop;
   Report ("World_To_Screen ", T0);

   Put_Line ("(sink" & Natural'Image (Sink) & "  acc" & Long_Float'Image (Acc) & "  camera x" & Float'Image (C.X) & ")");
end Bench_Camera_Projection;

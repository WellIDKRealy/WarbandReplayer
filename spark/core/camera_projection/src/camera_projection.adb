package body Camera_Projection
  with SPARK_Mode
is

   procedure Set_Screen (C : in out Camera; Width, Height : Integer; S : out Status) is
   begin
      if Width in Screen_Size and then Height in Screen_Size then
         C.Width := Width;
         C.Height := Height;
         S := Ok;
      else
         S := Bad_Screen;
      end if;
   end Set_Screen;

   procedure Set_Map_Bounds (C : in out Camera; Min_X, Max_X, Min_Y, Max_Y : Float; S : out Status) is
      Input : constant Status :=
        Status'Max (Classify (Min_X, Max_X, Max_World), Classify (Min_Y, Max_Y, Max_World));
   begin
      S := Input;
      if Input /= Ok then
         return;
      end if;
      declare
         Lx : constant Coord := Min_X;
         Hx : constant Coord := Max_X;
         Ly : constant Coord := Min_Y;
         Hy : constant Coord := Max_Y;
         Span_X   : constant Float := abs (Hx - Lx);
         Span_Y   : constant Float := abs (Hy - Ly);
         Max_Span : constant Float := (if Span_X > Span_Y then Span_X else Span_Y);
         Zoom     : Zoom_Range := C.Zoom;
      begin
         if Max_Span > 0.0 then
            if Max_Span <= 4.0 then
               Zoom := 10.0;                 --  40 / Max_Span >= 10, clamped to 10 (see Fit_Zoom)
            else
               declare
                  Z : Float := 40.0 / Max_Span;
               begin
                  if Z < 0.05 then
                     Z := 0.05;
                  end if;
                  if Z > 10.0 then
                     Z := 10.0;
                  end if;
                  Zoom := Z;
               end;
            end if;
         end if;
         C.X := (Lx + Hx) / 2.0;
         C.Y := (Ly + Hy) / 2.0;
         C.Zoom := Zoom;
         C.Min_X := Lx;
         C.Max_X := Hx;
         C.Min_Y := Ly;
         C.Max_Y := Hy;
      end;
   end Set_Map_Bounds;

   procedure Apply_Zoom (C : in out Camera; Delta_Y : Float; S : out Status) is
   begin
      if Is_Finite (Delta_Y) then
         declare
            Z : Float := C.Zoom;
         begin
            if Delta_Y > 0.0 then
               Z := Z * 0.90;
            elsif Delta_Y < 0.0 then
               Z := Z * 1.10;
            end if;
            if Z < 0.02 then
               Z := 0.02;
            end if;
            if Z > 40.0 then
               Z := 40.0;
            end if;
            C.Zoom := Z;
         end;
         S := Ok;
      else
         S := Not_Finite;
      end if;
   end Apply_Zoom;

   procedure Pan (C : in out Camera; Dx, Dy : Float; S : out Status) is
      Input : constant Status := Classify (Dx, Dy, Max_Pixels);
   begin
      S := Input;
      if Input /= Ok then
         return;
      end if;
      declare
         Width    : constant Float := Float (C.Width);
         Height   : constant Float := Float (C.Height);
         World_Dx : constant Float :=
           ((Dx / Width) * (2.0 * Half_Width (C.Width, C.Height))) / C.Zoom;
         World_Dy : constant Float :=
           ((Dy / Height) * (2.0 * Half_Height (C.Width, C.Height))) / C.Zoom;
         Nx       : constant Float := C.X - World_Dx;
         Ny       : constant Float := C.Y + World_Dy;
      begin
         if abs Nx <= Max_World and then abs Ny <= Max_World then
            C.X := Nx;
            C.Y := Ny;
         else
            S := Out_Of_Range;
         end if;
      end;
   end Pan;

   procedure Set_View_Shift (C : in out Camera; X, Y : Float; S : out Status) is
      Input : constant Status := Classify (X, Y, Max_Shift);
   begin
      S := Input;
      if Input = Ok then
         C.Shift_X := X;
         C.Shift_Y := Y;
      end if;
   end Set_View_Shift;

   procedure Set_Key (C : in out Camera; Index, Pressed : Integer; S : out Status) is
   begin
      if Index in 0 .. 3 then
         C.Keys (Key'Val (Index)) := Pressed /= 0;
         S := Ok;
      else
         S := Bad_Key;
      end if;
   end Set_Key;

   procedure Advance (C : in out Camera; Dt : Float; S : out Status) is
      Input : constant Status := Classify (Dt, Max_Seconds);
   begin
      S := Input;
      if Input /= Ok then
         return;
      end if;
      declare
         Pan_Speed : constant Float := 35.0 / C.Zoom;
         X : Float := C.X;
         Y : Float := C.Y;
      begin
         if C.Keys (Key_W) then
            Y := Y + Pan_Speed * Dt;
         end if;
         if C.Keys (Key_S) then
            Y := Y - Pan_Speed * Dt;
         end if;
         if C.Keys (Key_A) then
            X := X - Pan_Speed * Dt;
         end if;
         if C.Keys (Key_D) then
            X := X + Pan_Speed * Dt;
         end if;
         if abs X <= Max_World and then abs Y <= Max_World then
            C.X := X;
            C.Y := Y;
         else
            S := Out_Of_Range;
         end if;
      end;
   end Advance;

   --  The two projections step by step.  Every intermediate has its own proved range (the world point,
   --  shift and camera are bounded, zoom <= 40, extent >= 30, width <= 65536), so each operator is checked
   --  on its own instead of as one nested float expression.
   function Project_X (C : Camera; Wx : Long_Float) return Screen_Coord is
      Xb : constant Long_Float := Extent_X (C.Width, C.Height);
      A  : constant Long_Float range -3.0E6 .. 3.0E6 := Wx + Long_Float (C.Shift_X);
      D  : constant Long_Float range -4.0E6 .. 4.0E6 := A - Long_Float (C.X);
      S  : constant Long_Float range -1.6E8 .. 1.6E8 := D * Long_Float (C.Zoom);
      N  : constant Long_Float range -5.4E6 .. 5.4E6 := S / Xb;
      U  : constant Long_Float range -5.5E6 .. 5.5E6 := N + 1.0;
      H  : constant Long_Float range -2.75E6 .. 2.75E6 := U / 2.0;
   begin
      return H * Long_Float (C.Width);
   end Project_X;

   function Project_Y (C : Camera; Wy : Long_Float) return Screen_Coord is
      Yb : constant Long_Float := Extent_Y (C.Width, C.Height);
      A  : constant Long_Float range -3.0E6 .. 3.0E6 := Wy + Long_Float (C.Shift_Y);
      D  : constant Long_Float range -4.0E6 .. 4.0E6 := A - Long_Float (C.Y);
      S  : constant Long_Float range -1.6E8 .. 1.6E8 := D * Long_Float (C.Zoom);
      N  : constant Long_Float range -5.4E6 .. 5.4E6 := S / Yb;
      U  : constant Long_Float range -5.5E6 .. 5.5E6 := 1.0 - N;
      H  : constant Long_Float range -2.75E6 .. 2.75E6 := U / 2.0;
   begin
      return H * Long_Float (C.Height);
   end Project_Y;

   function World_To_Screen (C : Camera; Wx, Wy : Long_Float) return Screen_Point is
      Input : constant Status := Classify (Wx, Wy, Max_World);
   begin
      if Input /= Ok then
         return (Outcome => Input, X => 0.0, Y => 0.0);
      end if;
      return (Outcome => Ok, X => Project_X (C, Wx), Y => Project_Y (C, Wy));
   end World_To_Screen;

end Camera_Projection;

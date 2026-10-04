--  Camera_Projection: the renderer's camera and its world <-> screen mapping.
--
--  Port of the OLD engine's
--    main.c  set_screen_dimensions, set_map_bounds, apply_zoom, pan_camera, set_view_shift,
--            set_key_state and the key-panning / aspect / x_bound part of render_frame (~61-241, 291-300)
--    main.js worldToScreen (~780)
--  The camera state is a value (type Camera) that the caller owns; the unit has no state of its own.
--
--  Arithmetic: the camera is IEEE binary32 exactly like the old wasm `float`s and every formula is the
--  old one operator for operator, so results are bit-identical to the old engine on every input the old
--  engine handled sanely.  The world -> screen mapping is binary64 exactly like the old JS.
--
--  Every operation is total.  An input the old code turned into inf/NaN (screen size 0, NaN or infinite
--  numbers from JS) or silently overflowed is REJECTED with a Status and the camera is left unchanged.
--  Inputs are accepted only inside the documented domains below; they keep every intermediate value
--  finite and give the error bound proved in Camera_Projection.Proofs.
with Ada.Unchecked_Conversion;

package Camera_Projection
  with SPARK_Mode, Pure
is
   ---------------------------------------------------------------------------------------------
   --  Domains and state
   ---------------------------------------------------------------------------------------------

   Max_World   : constant := 1.0E6;      --  |camera position|, |map bound|, |world point|
   Max_Shift   : constant := 2.0E6;      --  |view shift| (a camera position minus a battle centre)
   Max_Screen  : constant := 65_536;     --  canvas width / height in pixels, at least 1
   Max_Pixels  : constant := 1.0E6;      --  one mouse-drag delta
   Max_Seconds : constant := 1.0E6;      --  one frame time step

   subtype Coord is Float range -Max_World .. Max_World;
   subtype Shift is Float range -Max_Shift .. Max_Shift;
   subtype Zoom_Range is Float range 0.02 .. 40.0;        --  apply_zoom's clamp
   subtype Screen_Size is Integer range 1 .. Max_Screen;

   type Key is (Key_W, Key_A, Key_S, Key_D);              --  old set_key_state index 0 .. 3
   type Key_States is array (Key) of Boolean;

   --  Not_Finite: NaN or infinity.  Out_Of_Range: a finite number outside its domain (or a pan that would
   --  leave +-Max_World).  The order matters: when several arguments are bad the larger value is reported.
   type Status is (Ok, Out_Of_Range, Not_Finite, Bad_Screen, Bad_Key);

   --  Invariant, enforced by the component subtypes and proved at every assignment: all fields finite,
   --  Zoom within 0.02 .. 40, screen size at least 1x1.
   type Camera is record
      X, Y             : Coord      := 0.0;     --  camera centre; also the crosshair's world position
      Zoom             : Zoom_Range := 1.0;
      Shift_X, Shift_Y : Shift      := 0.0;     --  render-time offset: never part of X, Y, Zoom
      Width, Height    : Screen_Size;
      Min_X, Max_X     : Coord;                 --  map bounds (drawn as the white box)
      Min_Y, Max_Y     : Coord;
      Keys             : Key_States := (others => False);
   end record;

   --  The old globals' initial values (main.c:62-73).
   Initial : constant Camera :=
     (X => 0.0, Y => 0.0, Zoom => 1.0, Shift_X => 0.0, Shift_Y => 0.0,
      Width => 800, Height => 600,
      Min_X => -100.0, Max_X => 100.0, Min_Y => -100.0, Max_Y => 100.0,
      Keys => (others => False));

   ---------------------------------------------------------------------------------------------
   --  Input classification (what a JS number has to be to be accepted)
   ---------------------------------------------------------------------------------------------

   --  True unless X is a NaN or an infinity (IEEE exponent field all ones).
   function Is_Finite (X : Float) return Boolean;
   function Is_Finite (X : Long_Float) return Boolean;

   function Classify (X : Float; Limit : Float) return Status is
     (if not Is_Finite (X) then Not_Finite elsif abs X > Limit then Out_Of_Range else Ok);
   function Classify (X : Long_Float; Limit : Long_Float) return Status is
     (if not Is_Finite (X) then Not_Finite elsif abs X > Limit then Out_Of_Range else Ok);

   --  The worst class of two numbers (Not_Finite beats Out_Of_Range beats Ok).
   function Classify (A, B : Float; Limit : Float) return Status is
     (Status'Max (Classify (A, Limit), Classify (B, Limit)));
   function Classify (A, B : Long_Float; Limit : Long_Float) return Status is
     (Status'Max (Classify (A, Limit), Classify (B, Limit)));

   ---------------------------------------------------------------------------------------------
   --  Formulas of the old code (named so the contracts below read like the C)
   ---------------------------------------------------------------------------------------------

   --  render_frame / pan_camera: aspect = (float) w / (float) h;  x_bound = 30 (30 * aspect if aspect > 1),
   --  y_bound = 30 (30 / aspect otherwise).  The orthographic half-extents of the view in world units
   --  at zoom 1.
   function Aspect (W, H : Screen_Size) return Float is (Float (W) / Float (H));
   function Half_Width (W, H : Screen_Size) return Float is
     (if Aspect (W, H) > 1.0 then 30.0 * Aspect (W, H) else 30.0)
   with Post => Half_Width'Result in 30.0 .. 2.0E6;
   function Half_Height (W, H : Screen_Size) return Float is
     (if Aspect (W, H) > 1.0 then 30.0 else 30.0 / Aspect (W, H))
   with Post => Half_Height'Result in 30.0 .. 2.0E6;

   --  pan_camera: world delta of a pixel drag (the camera moves by -world_dx, +world_dy).
   function Pan_Dx (C : Camera; Dx : Float) return Float is
     (((Dx / Float (C.Width)) * (2.0 * Half_Width (C.Width, C.Height))) / C.Zoom)
   with Pre => abs Dx <= Max_Pixels;
   function Pan_Dy (C : Camera; Dy : Float) return Float is
     (((Dy / Float (C.Height)) * (2.0 * Half_Height (C.Width, C.Height))) / C.Zoom)
   with Pre => abs Dy <= Max_Pixels;

   --  render_frame key panning: pan_speed = 35 / zoom; W: y += speed * dt, S: y -= .., A: x -= .., D: x += ..
   --  applied in that order (the two keys of an axis do not necessarily cancel exactly in float).
   function Key_Moved_X (C : Camera; Dt : Float) return Float is
     (declare
        Step : constant Float := (35.0 / C.Zoom) * Dt;
        X1   : constant Float := (if C.Keys (Key_A) then C.X - Step else C.X);
      begin
        (if C.Keys (Key_D) then X1 + Step else X1))
   with Pre => abs Dt <= Max_Seconds;
   function Key_Moved_Y (C : Camera; Dt : Float) return Float is
     (declare
        Step : constant Float := (35.0 / C.Zoom) * Dt;
        Y1   : constant Float := (if C.Keys (Key_W) then C.Y + Step else C.Y);
      begin
        (if C.Keys (Key_S) then Y1 - Step else Y1))
   with Pre => abs Dt <= Max_Seconds;

   --  set_map_bounds: the longer side of the bounds, and the zoom that frames it.  Span 0 keeps the zoom.
   --  40 / span is clamped to 0.05 .. 10; for span <= 4 the quotient is >= 10 (IEEE division is monotone and
   --  40 / 4 = 10) so the clamp gives 10 exactly - written out so the tiny-span quotient never overflows.
   function Span (Lo_X, Hi_X, Lo_Y, Hi_Y : Coord) return Float is
     (Float'Max (abs (Hi_X - Lo_X), abs (Hi_Y - Lo_Y)));
   function Fit_Zoom (Old : Zoom_Range; S : Float) return Zoom_Range is
     (if S <= 0.0 then Old
      elsif S <= 4.0 then 10.0
      else Float'Max (0.05, Float'Min (10.0, 40.0 / S)))
   with Pre => S in 0.0 .. 2.0 * Max_World;

   --  apply_zoom: wheel up (delta_y < 0) zooms in by 1.1, wheel down by 0.9, then clamp to 0.02 .. 40.
   function Zoomed (Z : Zoom_Range; Delta_Y : Float) return Zoom_Range is
     (declare
        Z1 : constant Float := (if Delta_Y > 0.0 then Z * 0.90 elsif Delta_Y < 0.0 then Z * 1.10 else Z);
      begin
        Float'Max (0.02, Float'Min (40.0, Z1)));

   ---------------------------------------------------------------------------------------------
   --  Camera operations.  On any status except Ok the camera is unchanged.
   ---------------------------------------------------------------------------------------------

   --  set_screen_dimensions.  Bad_Screen unless 1 <= Width, Height <= Max_Screen.
   procedure Set_Screen (C : in out Camera; Width, Height : Integer; S : out Status)
   with
     Global => null,
     Post   =>
       (if Width in Screen_Size and then Height in Screen_Size then
          S = Ok and then C = (C'Old with delta Width => Width, Height => Height)
        else
          S = Bad_Screen and then C = C'Old);

   --  set_map_bounds: stores the bounds (either order), centres the camera on them and zooms to fit.
   --  The view shift is untouched.
   procedure Set_Map_Bounds (C : in out Camera; Min_X, Max_X, Min_Y, Max_Y : Float; S : out Status)
   with
     Global => null,
     Post   =>
       (if Status'Max (Classify (Min_X, Max_X, Max_World), Classify (Min_Y, Max_Y, Max_World)) /= Ok then
          S = Status'Max (Classify (Min_X, Max_X, Max_World), Classify (Min_Y, Max_Y, Max_World))
          and then C = C'Old
        else
          S = Ok
          and then C = (C'Old with delta
                          X => (Min_X + Max_X) / 2.0, Y => (Min_Y + Max_Y) / 2.0,
                          Zoom => Fit_Zoom (C'Old.Zoom, Span (Min_X, Max_X, Min_Y, Max_Y)),
                          Min_X => Min_X, Max_X => Max_X, Min_Y => Min_Y, Max_Y => Max_Y));

   --  apply_zoom.  Any finite delta is accepted (only its sign matters).
   procedure Apply_Zoom (C : in out Camera; Delta_Y : Float; S : out Status)
   with
     Global => null,
     Post   =>
       (if Is_Finite (Delta_Y) then
          S = Ok and then C = (C'Old with delta Zoom => Zoomed (C'Old.Zoom, Delta_Y))
        else
          S = Not_Finite and then C = C'Old);

   --  pan_camera (mouse drag by Dx, Dy pixels).  Out_Of_Range also when the camera would leave +-Max_World.
   procedure Pan (C : in out Camera; Dx, Dy : Float; S : out Status)
   with
     Global => null,
     Post   =>
       (if Classify (Dx, Dy, Max_Pixels) /= Ok then
          S = Classify (Dx, Dy, Max_Pixels) and then C = C'Old
        elsif abs (C'Old.X - Pan_Dx (C'Old, Dx)) <= Max_World
          and then abs (C'Old.Y + Pan_Dy (C'Old, Dy)) <= Max_World
        then
          S = Ok
          and then C = (C'Old with delta X => C'Old.X - Pan_Dx (C'Old, Dx),
                                         Y => C'Old.Y + Pan_Dy (C'Old, Dy))
        else
          S = Out_Of_Range and then C = C'Old);

   --  set_view_shift: only the render-time offset changes - X, Y and Zoom (what CURSOR_X/CURSOR_Y and every
   --  query see) are never touched.
   procedure Set_View_Shift (C : in out Camera; X, Y : Float; S : out Status)
   with
     Global => null,
     Post   =>
       (if Classify (X, Y, Max_Shift) = Ok then
          S = Ok and then C = (C'Old with delta Shift_X => X, Shift_Y => Y)
        else
          S = Classify (X, Y, Max_Shift) and then C = C'Old);

   --  set_key_state (index 0 .. 3 = W A S D; any non-zero Pressed counts as pressed).
   procedure Set_Key (C : in out Camera; Index, Pressed : Integer; S : out Status)
   with
     Global => null,
     Post   =>
       (if Index in 0 .. 3 then
          S = Ok
          and then C = (C'Old with delta
                          Keys => (C'Old.Keys with delta Key'Val (Index) => Pressed /= 0))
        else
          S = Bad_Key and then C = C'Old);

   --  The key-panning half of render_frame (Dt seconds with the keys currently held).
   procedure Advance (C : in out Camera; Dt : Float; S : out Status)
   with
     Global => null,
     Post   =>
       (if Classify (Dt, Max_Seconds) /= Ok then
          S = Classify (Dt, Max_Seconds) and then C = C'Old
        elsif abs Key_Moved_X (C'Old, Dt) <= Max_World and then abs Key_Moved_Y (C'Old, Dt) <= Max_World then
          S = Ok
          and then C = (C'Old with delta X => Key_Moved_X (C'Old, Dt), Y => Key_Moved_Y (C'Old, Dt))
        else
          S = Out_Of_Range and then C = C'Old);

   ---------------------------------------------------------------------------------------------
   --  World -> screen (main.js worldToScreen, JS doubles)
   ---------------------------------------------------------------------------------------------

   subtype Screen_Coord is Long_Float range -2.0E11 .. 2.0E11;

   --  The JS aspect handling in binary64.
   function Extent_X (W, H : Screen_Size) return Long_Float is
     (if Long_Float (W) / Long_Float (H) > 1.0 then 30.0 * (Long_Float (W) / Long_Float (H)) else 30.0)
   with Post => Extent_X'Result in 30.0 .. 2.0E6;
   function Extent_Y (W, H : Screen_Size) return Long_Float is
     (if Long_Float (W) / Long_Float (H) > 1.0 then 30.0 else 30.0 / (Long_Float (W) / Long_Float (H)))
   with Post => Extent_Y'Result in 30.0 .. 2.0E6;

   --  sx = (wx + shift - camX) * zoom;  px = (sx / xBound + 1) / 2 * width
   --  sy = (wy + shift - camY) * zoom;  py = (1 - sy / yBound) / 2 * height
   function Project_X (C : Camera; Wx : Long_Float) return Screen_Coord
   with
     Global => null,
     Pre    => abs Wx <= Max_World,
     Post   =>
       Project_X'Result =
         ((((Wx + Long_Float (C.Shift_X)) - Long_Float (C.X)) * Long_Float (C.Zoom))
          / Extent_X (C.Width, C.Height) + 1.0) / 2.0 * Long_Float (C.Width);
   function Project_Y (C : Camera; Wy : Long_Float) return Screen_Coord
   with
     Global => null,
     Pre    => abs Wy <= Max_World,
     Post   =>
       Project_Y'Result =
         (1.0 - (((Wy + Long_Float (C.Shift_Y)) - Long_Float (C.Y)) * Long_Float (C.Zoom))
                / Extent_Y (C.Width, C.Height)) / 2.0 * Long_Float (C.Height);

   type Screen_Point is record
      Outcome : Status := Ok;
      X, Y    : Screen_Coord := 0.0;
   end record;

   --  Total: a NaN / infinite / beyond-Max_World point is reported in Outcome (and X = Y = 0), never mapped.
   function World_To_Screen (C : Camera; Wx, Wy : Long_Float) return Screen_Point
   with
     Global => null,
     Post   =>
       (if Classify (Wx, Wy, Max_World) = Ok then
          World_To_Screen'Result = (Outcome => Ok, X => Project_X (C, Wx), Y => Project_Y (C, Wy))
        else
          World_To_Screen'Result = (Outcome => Classify (Wx, Wy, Max_World), X => 0.0, Y => 0.0));

private

   type Bits_32 is mod 2 ** 32;
   type Bits_64 is mod 2 ** 64;
   function To_Bits is new Ada.Unchecked_Conversion (Float, Bits_32);
   function To_Bits is new Ada.Unchecked_Conversion (Long_Float, Bits_64);

   function Is_Finite (X : Float) return Boolean is
     ((To_Bits (X) and 16#7F80_0000#) /= 16#7F80_0000#);
   function Is_Finite (X : Long_Float) return Boolean is
     ((To_Bits (X) and 16#7FF0_0000_0000_0000#) /= 16#7FF0_0000_0000_0000#);

end Camera_Projection;

package body Boundary_Segmentation
  with SPARK_Mode => On
is

   function Elem (B : Boundary_Array; K : Long_Long_Integer) return Tick_Index
   is (B (B'First + (K - 1)));

   function Nth (S : Span_Array; J : Long_Long_Integer) return Span
   is (S (S'First + (J - 1)));

   function Kept (B : Boundary_Array; K : Long_Long_Integer) return Boolean
   is (Keeps (Elem (B, K), Fold (B, K - 1).Last_Kept));

   procedure Lemma_Fold_Step (B : Boundary_Array; K : Long_Long_Integer) is
   begin
      null;
   end Lemma_Fold_Step;

   procedure Lemma_Nth_End_Step (B : Boundary_Array; K, J : Long_Long_Integer) is
   begin
      null;
   end Lemma_Nth_End_Step;

   procedure Lemma_Nth_End_Stable (B : Boundary_Array; K : Long_Long_Integer) is
   begin
      Lemma_Fold_Step (B, K);
      for J in 1 .. Fold (B, K - 1).Emitted loop
         pragma Loop_Invariant
           (for all X in 1 .. J =>
              X <= Fold (B, K).Emitted and then Nth_End (B, K, X) = Nth_End (B, K - 1, X));
         Lemma_Nth_End_Step (B, K, J);
      end loop;
   end Lemma_Nth_End_Stable;

   procedure Lemma_Nth_Start_Stable (B : Boundary_Array; K : Long_Long_Integer) is
   begin
      Lemma_Fold_Step (B, K);
      Lemma_Nth_End_Stable (B, K);
      for J in 1 .. Fold (B, K - 1).Emitted loop
         pragma Loop_Invariant
           (for all X in 1 .. J =>
              X <= Fold (B, K).Emitted and then Nth_Start (B, K, X) = Nth_Start (B, K - 1, X));
      end loop;
   end Lemma_Nth_Start_Stable;

   procedure Lemma_Merge (B : Boundary_Array; K : Long_Long_Integer) is
   begin
      if K >= 1 then
         Lemma_Fold_Step (B, K);
         Lemma_Merge (B, K - 1);
      end if;
   end Lemma_Merge;

   procedure Lemma_Merge_Rule (B : Boundary_Array; K : Long_Long_Integer) is
   begin
      Lemma_Merge (B, K - 1);
   end Lemma_Merge_Rule;

   procedure Lemma_Rejection (B : Boundary_Array; K : Long_Long_Integer) is
   begin
      Lemma_Merge (B, K - 1);
   end Lemma_Rejection;

   procedure Lemma_Last_End (B : Boundary_Array; K : Long_Long_Integer) is
   begin
      if K >= 1 then
         Lemma_Fold_Step (B, K);
         Lemma_Last_End (B, K - 1);
         if Fold (B, K).Emitted >= 1 then
            Lemma_Nth_End_Step (B, K, Fold (B, K).Emitted);
         end if;
      end if;
   end Lemma_Last_End;

   procedure Lemma_Emission (B : Boundary_Array; K, J : Long_Long_Integer) is
   begin
      Lemma_Fold_Step (B, K);
      Lemma_Nth_End_Step (B, K, J);
      pragma Assert
        (Emit_Pos (B, K, J) =
           (if Fold (B, K - 1).Emitted >= J then Emit_Pos (B, K - 1, J) else K));
      if Fold (B, K - 1).Emitted >= J then
         Lemma_Emission (B, K - 1, J);
         Lemma_Nth_End_Stable (B, K);
         Lemma_Nth_Start_Stable (B, K);
         pragma Assert (Nth_Start (B, K, J) = Nth_Start (B, K - 1, J));
      else
         pragma Assert (Fold (B, K - 1).Emitted = J - 1);
         pragma Assert (Fold (B, K).Emitted = J);
         pragma Assert (Kept (B, K));
         pragma Assert (Accepts (Elem (B, K), Fold (B, K - 1).Start));
         if J >= 2 then
            Lemma_Last_End (B, K - 1);
            Lemma_Nth_End_Stable (B, K);
            pragma Assert (Nth_End (B, K, J - 1) = Nth_End (B, K - 1, J - 1));
            pragma Assert (Nth_End (B, K - 1, J - 1) = Fold (B, K - 1).Last_End);
            pragma Assert (Nth_Start (B, K, J) = Fold (B, K - 1).Start);
         else
            pragma Assert (Fold (B, K - 1).Start = 0);
            pragma Assert (Nth_Start (B, K, J) = Fold (B, K - 1).Start);
         end if;
      end if;
   end Lemma_Emission;

   procedure Lemma_Increasing (N : Tick_Count; B : Boundary_Array; P, Q : Long_Long_Integer) is
   begin
      if P < Q then
         Lemma_Increasing (N, B, P, Q - 1);
         pragma Assert (Elem (B, Q - 1) < Elem (B, Q));
      end if;
   end Lemma_Increasing;

   procedure Lemma_Le_Last (N : Tick_Count; B : Boundary_Array; K : Long_Long_Integer) is
   begin
      for P in 1 .. K loop
         Lemma_Increasing (N, B, P, K);
         pragma Loop_Invariant (for all X in 1 .. P => Elem (B, X) <= Elem (B, K));
      end loop;
   end Lemma_Le_Last;

   procedure Lemma_Unskipped (N : Tick_Count; B : Boundary_Array; K : Long_Long_Integer) is
   begin
      if K >= 1 then
         Lemma_Unskipped (N, B, K - 1);
         Lemma_Fold_Step (B, K);
         Lemma_Le_Last (N, B, K);
      end if;
   end Lemma_Unskipped;

   procedure Lemma_Span_Props (N : Tick_Count; B : Boundary_Array; J : Long_Long_Integer) is
      Len : constant Long_Long_Integer := B'Length;
      P   : constant Long_Long_Integer := Emit_Pos (B, Len, J);
   begin
      Lemma_Emission (B, Len, J);
      Lemma_Unskipped (N, B, P - 1);
      for Q in 1 .. Len loop
         if P < Q then
            Lemma_Increasing (N, B, P, Q);
         end if;
         pragma Loop_Invariant
           (for all X in 1 .. Q => (if Elem (B, X) < Elem (B, P) then X < P));
      end loop;
      pragma Assert (Span_Props (N, B, J));
   end Lemma_Span_Props;

   procedure Lemma_Spec_Properties (N : Tick_Count; B : Boundary_Array) is
      Len  : constant Long_Long_Integer := B'Length;
      Main : constant Tick_Count := Main_Count (B);
   begin
      Lemma_Last_End (B, Len);
      Lemma_Unskipped (N, B, Len);
      for J in 1 .. Main loop
         Lemma_Span_Props (N, B, J);
         pragma Loop_Invariant (for all X in 1 .. J => Span_Props (N, B, X));
      end loop;
   end Lemma_Spec_Properties;

   --  Written spans equal the specification, so (by Lemma_Spec_Properties) each starts right after
   --  the previous one ends.  Kept as a separate ghost procedure so that the instantiation is
   --  pointwise (cheap for the provers) and erased from production builds.
   procedure Lemma_Contiguous
     (N : Tick_Count; B : Boundary_Array; Spans : Span_Array; W : Long_Long_Integer)
   with Ghost,
        Pre  => Valid_Input (N, B)
                and then W in 0 .. Spans'Length
                and then W <= Spec_Count (N, B)
                and then (for all J in 1 .. W =>
                            Nth (Spans, J).Start_Idx = Spec_Start (N, B, J)
                            and then Nth (Spans, J).End_Idx = Spec_End (N, B, J)),
        Post => (for all J in 2 .. W =>
                   Nth (Spans, J).Start_Idx =
                     Nth (Spans, J - 1).End_Idx + 1);

   procedure Lemma_Contiguous
     (N : Tick_Count; B : Boundary_Array; Spans : Span_Array; W : Long_Long_Integer) is
   begin
      pragma Assert (W <= Spans'Length);  --  (parameters are used by the contract)
      Lemma_Spec_Properties (N, B);
   end Lemma_Contiguous;

   procedure Segment
     (N          : Tick_Count;
      Boundaries : Boundary_Array;
      Spans      : in out Span_Array;
      Needed     : out Span_Count;
      Status     : out Status_Kind)
   is
      Cap       : constant Long_Long_Integer := Spans'Length;
      Len       : constant Long_Long_Integer := Boundaries'Length;
      Last_Kept : Kept_Idx := Sentinel;
      Start     : Tick_Count := 0;
      Count     : Span_Count := 0;
      Done      : Long_Long_Integer := 0;  --  boundary rows consumed so far
   begin
      if not Valid_Input (N, Boundaries) then
         Needed := 0;
         Status := Invalid_Input;
         return;
      end if;

      pragma Assert (Len <= Max_Ticks);

      while Done < Len loop
         pragma Loop_Invariant (Done in 0 .. Len);
         pragma Loop_Invariant (Valid_Input (N, Boundaries));
         pragma Loop_Invariant (Last_Kept = Fold (Boundaries, Done).Last_Kept);
         pragma Loop_Invariant (Start = Fold (Boundaries, Done).Start);
         pragma Loop_Invariant (Count = Fold (Boundaries, Done).Emitted);
         pragma Loop_Invariant
           (for all J in 1 .. Long_Long_Integer'Min (Count, Cap) =>
              Nth (Spans, J).Start_Idx = Nth_Start (Boundaries, Done, J)
              and then Nth (Spans, J).End_Idx = Nth_End (Boundaries, Done, J));
         pragma Loop_Invariant
           (if Count >= 1 then Nth_End (Boundaries, Done, Count) = Start - 1);
         pragma Loop_Invariant
           (for all X in Spans'First + Long_Long_Integer'Min (Count, Cap) .. Spans'Last =>
              Spans (X) = Spans'Loop_Entry (X));
         pragma Loop_Variant (Increases => Done);
         declare
            K   : constant Long_Long_Integer := Done + 1;
            Idx : constant Tick_Index := Elem (Boundaries, K);
         begin
            Lemma_Fold_Step (Boundaries, K);
            Lemma_Nth_End_Stable (Boundaries, K);
            Lemma_Nth_Start_Stable (Boundaries, K);
            if Keeps (Idx, Last_Kept) then
               Last_Kept := Idx;
               if Accepts (Idx, Start) then
                  if Count < Cap then
                     Spans (Spans'First + Count) := (Start_Idx => Start, End_Idx => Idx);
                  end if;
                  pragma Assert (Fold (Boundaries, K).Emitted = Count + 1);
                  pragma Assert (Nth_Start (Boundaries, K, Count + 1) = Start);
                  Lemma_Nth_End_Step (Boundaries, K, Count + 1);
                  Start := Idx + 1;
                  Count := Count + 1;
               end if;
            end if;
            Done := K;
         end;
      end loop;

      pragma Assert (Done = Len);
      pragma Assert (Count = Fold (Boundaries, Len).Emitted);
      pragma Assert (Start = Tail_Start (Boundaries));
      pragma Assert (Has_Tail (N, Boundaries) = (N - 1 - Start >= Min_Tail_Gap));

      declare
         Main_Spans : constant Span_Count := Count with Ghost;
      begin
         if N - 1 - Start >= Min_Tail_Gap then
            if Count < Cap then
               Spans (Spans'First + Count) := (Start_Idx => Start, End_Idx => N - 1);
            end if;
            Count := Count + 1;
         end if;

         pragma Assert (Count = Spec_Count (N, Boundaries));
         pragma Assert (Count <= Main_Spans + 1);
         pragma Assert
           (for all J in 1 .. Long_Long_Integer'Min (Main_Spans, Cap) =>
              Nth (Spans, J).Start_Idx = Spec_Start (N, Boundaries, J)
              and then Nth (Spans, J).End_Idx = Spec_End (N, Boundaries, J));
         pragma Assert
           (for all J in Main_Spans + 1 .. Long_Long_Integer'Min (Count, Cap) =>
              Nth (Spans, J).Start_Idx = Spec_Start (N, Boundaries, J)
              and then Nth (Spans, J).End_Idx = Spec_End (N, Boundaries, J));
         pragma Assert
           (for all J in 1 .. Long_Long_Integer'Min (Count, Cap) =>
              Nth (Spans, J).Start_Idx = Spec_Start (N, Boundaries, J)
              and then Nth (Spans, J).End_Idx = Spec_End (N, Boundaries, J));
      end;

      Lemma_Spec_Properties (N, Boundaries);
      Lemma_Contiguous (N, Boundaries, Spans, Long_Long_Integer'Min (Count, Cap));

      Needed := Count;
      Status := (if Count > Cap then Overflow else Ok);
   end Segment;

end Boundary_Segmentation;

--  Boundary_Segmentation: turns "boundary tick indexes" into battle spans.
--
--  Port of sql/default_boundary_detection.sql (the two folds + tail segment).  See README.md for
--  the contract <-> old behaviour mapping and PROOF.md for the proof summary.
--
--  Input : N (number of ticks) and the strictly increasing array of distinct boundary tick
--          indexes (positions in the ordered tick list, each in 0 .. N-1).
--  Output: ordered battle spans (start_idx, end_idx), contiguous, no cap.
package Boundary_Segmentation
  with SPARK_Mode => On, Pure
is

   ---------------------------------------------------------------------------
   --  Constants of the old algorithm (sql/default_boundary_detection.sql header)
   ---------------------------------------------------------------------------

   Skip_First    : constant := 5;           --  boundaries at idx < SKIP_FIRST are dropped
   Merge_Window  : constant := 15;          --  keep only if MORE than 15 past the last KEPT one
   Min_Match_Gap : constant := 10;          --  accept span iff end_idx - start_idx >= 10
   Min_Tail_Gap  : constant := 5;           --  tail iff last_idx - start_idx >= 5
   Sentinel      : constant := -1_000_000;  --  merge_fold's initial last_kept_idx

   ---------------------------------------------------------------------------
   --  Types.  All sizes and indexes are 64-bit; nothing is bounded by 32 bits and nothing is
   --  capped.  Max_Ticks (2**62) comfortably covers the required N up to 2**40 and boundary
   --  counts up to 2**31, and keeps every intermediate sum (idx + 15, idx + 1, ...) far away
   --  from Long_Long_Integer'Last.
   ---------------------------------------------------------------------------

   Max_Ticks : constant := 2**62;

   subtype Tick_Count is Long_Long_Integer range 0 .. Max_Ticks;
   subtype Tick_Index is Long_Long_Integer range 0 .. Max_Ticks - 1;
   subtype Position is Long_Long_Integer range 1 .. Max_Ticks;
   subtype Span_Count is Long_Long_Integer range 0 .. Max_Ticks + 1;

   type Boundary_Array is array (Position range <>) of Tick_Index;

   type Span is record
      Start_Idx : Tick_Index;
      End_Idx   : Tick_Index;
   end record;

   type Span_Array is array (Position range <>) of Span;

   type Status_Kind is
     (Ok,             --  all spans written, Needed <= Spans'Length
      Overflow,       --  Needed > Spans'Length: output too small (NOT truncated silently)
      Invalid_Input); --  boundaries not strictly increasing / not all < N: nothing computed

   ---------------------------------------------------------------------------
   --  Positions are counted, not indexed: row K (1 <= K <= B'Length) of the SQL's boundary_idx
   --  (its rn) is B (B'First + (K - 1)).  This keeps every contract independent of B'First.
   ---------------------------------------------------------------------------

   --  (Deliberately a function with a postcondition rather than an expression function: provers
   --  then see `Elem (B, J)` as a plain term, which makes the quantified contracts below cheap.)
   function Elem (B : Boundary_Array; K : Long_Long_Integer) return Tick_Index
   with Pre  => K in 1 .. B'Length,
        Post => Elem'Result = B (B'First + (K - 1));

   --  J-th entry (1-based) of an output array (ghost: only used in contracts and proofs).  Like Elem,
   --  a plain function with a postcondition so that provers see `Nth (S, J)` as a simple term in
   --  the quantified contracts.
   function Nth (S : Span_Array; J : Long_Long_Integer) return Span
   with Ghost,
        Pre  => J in 1 .. S'Length,
        Post => Nth'Result = S (S'First + (J - 1));

   ---------------------------------------------------------------------------
   --  Input validity (executable: callers can check untrusted data with it)
   ---------------------------------------------------------------------------

   --  The first K rows are strictly increasing and every one is a valid tick index (< N).
   function Valid_Prefix
     (N : Tick_Count; B : Boundary_Array; K : Long_Long_Integer) return Boolean
   is ((for all J in 1 .. K => Elem (B, J) < N)
       and then (for all J in 1 .. K - 1 => Elem (B, J) < Elem (B, J + 1)))
   with Pre => K in 0 .. B'Length;

   function Valid_Input (N : Tick_Count; B : Boundary_Array) return Boolean
   is (Valid_Prefix (N, B, B'Length));

   ---------------------------------------------------------------------------
   --  GHOST SPECIFICATION = literal transcription of the SQL.
   --
   --  Both recursive folds of the SQL are run, row by row, over the raw boundary rows.  The
   --  state after rows 1 .. K is Fold (B, K).
   ---------------------------------------------------------------------------

   subtype Kept_Idx is Long_Long_Integer range Sentinel .. Max_Ticks - 1;

   --  merge_fold row test:  CASE WHEN b.idx >= 5 AND b.idx > f.last_kept_idx + 15
   function Keeps (Idx : Tick_Index; Last_Kept : Kept_Idx) return Boolean
   is (Idx >= Skip_First and then Idx > Last_Kept + Merge_Window);

   --  seg_fold row test:    CASE WHEN m.idx - f.start_idx >= 10
   function Accepts (Idx : Tick_Index; Start : Tick_Count) return Boolean
   is (Idx - Start >= Min_Match_Gap);

   type Fold_State is record
      Last_Kept : Kept_Idx;
      --  merge_fold.last_kept_idx
      Start     : Tick_Count;
      --  seg_fold.start_idx
      Emitted   : Tick_Count;
      --  number of seg_fold rows with emit = 1
      Last_End  : Long_Long_Integer range -1 .. Max_Ticks - 1;
      --  COALESCE (MAX (end_idx) over emit = 1 rows, -1)  (last_accepted_end)
   end record
   with Ghost;

   Initial_State : constant Fold_State :=
     (Last_Kept => Sentinel, Start => 0, Emitted => 0, Last_End => -1)
   with Ghost;

   --  One raw boundary row through merge_fold, then (if kept) through seg_fold.
   function Step (S : Fold_State; Idx : Tick_Index) return Fold_State
   is (if Keeps (Idx, S.Last_Kept) then
         (if Accepts (Idx, S.Start) then
            (Last_Kept => Idx,
             Start     => Idx + 1,
             Emitted   => S.Emitted + 1,
             Last_End  => Long_Long_Integer'Max (S.Last_End, Idx))
          else
            (Last_Kept => Idx,
             Start     => S.Start,
             Emitted   => S.Emitted,
             Last_End  => S.Last_End))
       else S)
   with Ghost, Pre => S.Emitted < Max_Ticks;

   function Fold (B : Boundary_Array; K : Long_Long_Integer) return Fold_State
   is (if K = 0 then Initial_State else Step (Fold (B, K - 1), Elem (B, K)))
   with Ghost,
        Pre                => K in 0 .. B'Length,
        Post               => Fold'Result.Emitted <= K
                              and then Fold'Result.Last_End = Fold'Result.Start - 1
                              and then (if Fold'Result.Emitted = 0 then Fold'Result.Start = 0)
                              and then (if Fold'Result.Last_Kept = Sentinel then
                                          Fold'Result.Start = 0 and then Fold'Result.Emitted = 0
                                        else
                                          Fold'Result.Start <= Fold'Result.Last_Kept + 1),
        Subprogram_Variant => (Decreases => K);

   --  End idx of the J-th emitted (accepted) span after rows 1 .. K (1 <= J <= Emitted).
   function Nth_End (B : Boundary_Array; K, J : Long_Long_Integer) return Tick_Index
   is (if Fold (B, K - 1).Emitted >= J then Nth_End (B, K - 1, J) else Elem (B, K))
   with Ghost,
        Pre                => K in 0 .. B'Length
                              and then J in 1 .. Fold (B, K).Emitted,
        Subprogram_Variant => (Decreases => K);

   --  Unfolding lemmas (one step of the recursive definitions), usable by the proofs.
   procedure Lemma_Fold_Step (B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre  => K in 1 .. B'Length,
        Post => Fold (B, K) = Step (Fold (B, K - 1), Elem (B, K))
                and then Fold (B, K).Emitted >= Fold (B, K - 1).Emitted
                and then Fold (B, K).Emitted <= Fold (B, K - 1).Emitted + 1;

   procedure Lemma_Nth_End_Step (B : Boundary_Array; K, J : Long_Long_Integer)
   with Ghost,
        Pre  => K in 1 .. B'Length and then J in 1 .. Fold (B, K).Emitted,
        Post => Nth_End (B, K, J) =
                (if Fold (B, K - 1).Emitted >= J then Nth_End (B, K - 1, J) else Elem (B, K));

   --  Spans already emitted do not change when more rows are consumed.
   procedure Lemma_Nth_End_Stable (B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre  => K in 1 .. B'Length,
        Post => (for all J in 1 .. Fold (B, K - 1).Emitted =>
                   J <= Fold (B, K).Emitted
                   and then Nth_End (B, K, J) = Nth_End (B, K - 1, J));

   --  Start idx of the J-th emitted span: 0 for the first, else previous end + 1
   --  (SQL: LAG (end_idx + 1, 1, 0) OVER (ORDER BY rn)).
   function Nth_Start (B : Boundary_Array; K, J : Long_Long_Integer) return Tick_Count
   is (if J = 1 then 0 else Nth_End (B, K, J - 1) + 1)
   with Ghost,
        Pre => K in 0 .. B'Length
               and then J in 1 .. Fold (B, K).Emitted;

   procedure Lemma_Nth_Start_Stable (B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre  => K in 1 .. B'Length,
        Post => (for all J in 1 .. Fold (B, K - 1).Emitted =>
                   J <= Fold (B, K).Emitted
                   and then Nth_Start (B, K, J) = Nth_Start (B, K - 1, J));

   --  Tail segment of the SQL: starts at last_accepted_end + 1, ends at last_idx = N - 1, and
   --  exists iff last_idx - start_idx >= 5.
   function Tail_Start (B : Boundary_Array) return Tick_Count
   is (Fold (B, B'Length).Last_End + 1)
   with Ghost;

   function Has_Tail (N : Tick_Count; B : Boundary_Array) return Boolean
   is (N - 1 - Tail_Start (B) >= Min_Tail_Gap)
   with Ghost;

   --  Number of rows the SQL returns (accepted spans + tail).
   function Spec_Count (N : Tick_Count; B : Boundary_Array) return Span_Count
   is (Fold (B, B'Length).Emitted + (if Has_Tail (N, B) then 1 else 0))
   with Ghost;

   function Spec_Start (N : Tick_Count; B : Boundary_Array; J : Long_Long_Integer)
     return Tick_Count
   is (if J <= Fold (B, B'Length).Emitted then Nth_Start (B, B'Length, J) else Tail_Start (B))
   with Ghost, Pre => J in 1 .. Spec_Count (N, B);

   function Spec_End (N : Tick_Count; B : Boundary_Array; J : Long_Long_Integer)
     return Tick_Index
   is (if J <= Fold (B, B'Length).Emitted then Nth_End (B, B'Length, J) else N - 1)
   with Ghost, Pre => J in 1 .. Spec_Count (N, B);

   ---------------------------------------------------------------------------
   --  DECLARATIVE CHARACTERISATION of the specification (all proved, see PROOF.md).
   --  These lemmas say, in plain terms, what the folds above compute.
   ---------------------------------------------------------------------------

   --  Number of spans that end at a boundary (everything except the tail).
   function Main_Count (B : Boundary_Array) return Tick_Count
   is (Fold (B, B'Length).Emitted)
   with Ghost;

   --  Row K survives the merge pass (merge_fold's `keep` flag).
   function Kept (B : Boundary_Array; K : Long_Long_Integer) return Boolean
   with Ghost,
        Pre  => K in 1 .. B'Length,
        Post => Kept'Result = Keeps (Elem (B, K), Fold (B, K - 1).Last_Kept);

   --  Position of the last kept row among rows 1 .. K (0 if there is none).
   function Prev_Kept (B : Boundary_Array; K : Long_Long_Integer) return Long_Long_Integer
   is (if K = 0 then 0 elsif Kept (B, K) then K else Prev_Kept (B, K - 1))
   with Ghost,
        Pre                => K in 0 .. B'Length,
        Post               => Prev_Kept'Result in 0 .. K,
        Subprogram_Variant => (Decreases => K);

   --  MERGE PASS.  merge_fold's state is exactly "the last KEPT boundary" ...
   procedure Lemma_Merge (B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre                => K in 0 .. B'Length,
        Post               => Fold (B, K).Last_Kept =
                              (if Prev_Kept (B, K) = 0 then Sentinel
                               else Elem (B, Prev_Kept (B, K))),
        Subprogram_Variant => (Decreases => K);

   --  ... so a boundary is kept iff idx >= 5 and (nothing was kept before it or it is MORE than
   --  15 past the previously kept boundary).  Nothing else is ever kept.
   procedure Lemma_Merge_Rule (B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre  => K in 1 .. B'Length,
        Post => Kept (B, K) =
                (Elem (B, K) >= Skip_First
                 and then (Prev_Kept (B, K - 1) = 0
                           or else Elem (B, K) > Elem (B, Prev_Kept (B, K - 1)) + Merge_Window));

   --  The SQL header's "a rejected span is absorbed into the next" quirk, made exact: the ONLY
   --  kept boundary that seg_fold can ever reject is the very first kept one, and only when its
   --  idx is in SKIP_FIRST .. MIN_MATCH_GAP - 1 (= 5 .. 9).  Every other kept boundary is
   --  accepted, so apart from that case the spans are simply consecutive merged boundaries.
   procedure Lemma_Rejection (B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre  => K in 1 .. B'Length,
        Post => (if Kept (B, K) and then not Accepts (Elem (B, K), Fold (B, K - 1).Start) then
                   Prev_Kept (B, K - 1) = 0
                   and then Elem (B, K) in Skip_First .. Min_Match_Gap - 1);

   --  After rows 1 .. K, the last accepted end idx is the end of the Emitted-th span and the
   --  next span starts right after it.
   procedure Lemma_Last_End (B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre                => K in 0 .. B'Length,
        Post               => (if Fold (B, K).Emitted >= 1 then
                                 Nth_End (B, K, Fold (B, K).Emitted) = Fold (B, K).Last_End),
        Subprogram_Variant => (Decreases => K);

   --  Row at which the J-th accepted span is emitted (seg_fold's emit = 1 row number).
   function Emit_Pos (B : Boundary_Array; K, J : Long_Long_Integer) return Long_Long_Integer
   is (if Fold (B, K - 1).Emitted >= J then Emit_Pos (B, K - 1, J) else K)
   with Ghost,
        Pre                => K in 0 .. B'Length and then J in 1 .. Fold (B, K).Emitted,
        Post               => Emit_Pos'Result in 1 .. K,
        Subprogram_Variant => (Decreases => K);

   --  The J-th accepted span is emitted by exactly one kept row P = Emit_Pos: the row at which the
   --  seg_fold count goes from J - 1 to J.  Its end is that row's idx, its start is the start_idx
   --  *before* that row, and the row passes the >= MIN_MATCH_GAP test against that start.
   procedure Lemma_Emission (B : Boundary_Array; K, J : Long_Long_Integer)
   with Ghost,
        Pre                => K in 0 .. B'Length and then J in 1 .. Fold (B, K).Emitted,
        Post               =>
          (declare
              P : constant Long_Long_Integer := Emit_Pos (B, K, J);
           begin
              Fold (B, P - 1).Emitted = J - 1
              and then Fold (B, P).Emitted = J
              and then Kept (B, P)
              and then Elem (B, P) = Nth_End (B, K, J)
              and then Nth_Start (B, K, J) = Fold (B, P - 1).Start
              and then Accepts (Elem (B, P), Fold (B, P - 1).Start)),
        Subprogram_Variant => (Decreases => K);

   --  Valid input is sorted in the strong sense: row P < row Q  ==>  idx P < idx Q.
   procedure Lemma_Increasing (N : Tick_Count; B : Boundary_Array; P, Q : Long_Long_Integer)
   with Ghost,
        Pre                => Q in 1 .. B'Length and then P in 1 .. Q
                              and then Valid_Prefix (N, B, Q),
        Post               => (if P < Q then Elem (B, P) < Elem (B, Q)),
        Subprogram_Variant => (Decreases => Q);

   --  Consequently no row before K has a larger idx than row K.
   procedure Lemma_Le_Last (N : Tick_Count; B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre  => K in 1 .. B'Length and then Valid_Prefix (N, B, K),
        Post => (for all P in 1 .. K => Elem (B, P) <= Elem (B, K));

   --  SEGMENTATION PASS, completeness: at any time, every kept boundary at or after the current
   --  start_idx was rejected for being too close (< MIN_MATCH_GAP past start_idx); i.e. a span
   --  ends at the FIRST kept boundary that is >= MIN_MATCH_GAP past its start.
   procedure Lemma_Unskipped (N : Tick_Count; B : Boundary_Array; K : Long_Long_Integer)
   with Ghost,
        Pre                => K in 0 .. B'Length and then Valid_Prefix (N, B, K),
        Post               =>
          (for all P in 1 .. K =>
             (if Kept (B, P) and then Elem (B, P) >= Fold (B, K).Start then
                Elem (B, P) - Fold (B, K).Start < Min_Match_Gap)),
        Subprogram_Variant => (Decreases => K);

   --  What is true of the J-th accepted span (J in 1 .. Main_Count) of a valid input:
   --    * it is at least MIN_MATCH_GAP long,
   --    * it ends at a kept boundary, and
   --    * that boundary is the FIRST kept boundary >= MIN_MATCH_GAP past the span's start: every
   --      kept boundary in [start, end) was too close to the start.
   function Span_Props (N : Tick_Count; B : Boundary_Array; J : Long_Long_Integer) return Boolean
   is (Spec_End (N, B, J) - Spec_Start (N, B, J) >= Min_Match_Gap
       and then (for some P in 1 .. Long_Long_Integer (B'Length) =>
                   Kept (B, P) and then Elem (B, P) = Spec_End (N, B, J))
       and then (for all P in 1 .. Long_Long_Integer (B'Length) =>
                   (if Kept (B, P)
                       and then Elem (B, P) >= Spec_Start (N, B, J)
                       and then Elem (B, P) < Spec_End (N, B, J)
                    then Elem (B, P) - Spec_Start (N, B, J) < Min_Match_Gap)))
   with Ghost, Pre => J in 1 .. Main_Count (B);

   procedure Lemma_Span_Props (N : Tick_Count; B : Boundary_Array; J : Long_Long_Integer)
   with Ghost,
        Pre  => Valid_Input (N, B) and then J in 1 .. Main_Count (B),
        Post => Span_Props (N, B, J);

   --  Summary of the specification for valid input (J ranges over all SQL result rows).
   procedure Lemma_Spec_Properties (N : Tick_Count; B : Boundary_Array)
   with Ghost,
        Pre  => Valid_Input (N, B),
        Post =>
          --  rows are contiguous and ordered: the first starts at 0, each starts right after the
          --  previous one's end
          (if Spec_Count (N, B) >= 1 then Spec_Start (N, B, 1) = 0)
          and then (for all J in 2 .. Spec_Count (N, B) =>
                      Spec_Start (N, B, J) = Spec_End (N, B, J - 1) + 1)
          --  every accepted span (all rows but the tail): Span_Props
          and then (for all J in 1 .. Main_Count (B) => Span_Props (N, B, J))
          --  the tail row: exists iff last_idx - start_idx >= MIN_TAIL_GAP, ends at the last tick
          and then (if Has_Tail (N, B) then
                      Spec_Count (N, B) = Main_Count (B) + 1
                      and then Spec_End (N, B, Spec_Count (N, B)) = N - 1
                      and then Spec_End (N, B, Spec_Count (N, B))
                               - Spec_Start (N, B, Spec_Count (N, B)) >= Min_Tail_Gap
                    else
                      Spec_Count (N, B) = Main_Count (B))
          --  nothing is left over for the tail except boundaries that were too close to its start
          and then (for all P in 1 .. Long_Long_Integer (B'Length) =>
                      (if Kept (B, P) and then Elem (B, P) >= Tail_Start (B) then
                         Elem (B, P) - Tail_Start (B) < Min_Match_Gap));

   ---------------------------------------------------------------------------
   --  The algorithm.
   ---------------------------------------------------------------------------

   --  Segment: run the old boundary-detection algorithm.
   --
   --  Spans (Spans'First + J - 1) receives span J (J = 1, 2, ...).  There is NO cap: if the
   --  output array is too small the result is Status = Overflow (never silent truncation),
   --  Needed still holds the exact number of spans the algorithm produces (so the caller can
   --  retry with a larger array), and Spans holds the first Spans'Length spans.
   --  Invalid input (boundaries not strictly increasing, or some >= N) yields Invalid_Input
   --  with Spans untouched.
   --
   --  Postcondition, for valid input, with W = number of spans written = min (Needed, capacity):
   --    1. Needed, and every written span, EQUAL the ghost specification (the SQL folds);
   --    2. output entries beyond the written ones are untouched;
   --    3. consequences, stated directly on the output: spans are contiguous (first starts at
   --       idx 0, each starts right after the previous ends: strictly ordered, non-overlapping,
   --       no gaps); every span except the tail has end - start >= MIN_MATCH_GAP; the tail (if
   --       any) ends at the last tick N - 1 and has end - start >= MIN_TAIL_GAP.
   --  The declarative properties of the merge pass and of "first kept boundary >= start + 10"
   --  are the ghost lemmas above (Lemma_Merge_Rule, Lemma_Spec_Properties).
   procedure Segment
     (N          : Tick_Count;
      Boundaries : Boundary_Array;
      Spans      : in out Span_Array;
      Needed     : out Span_Count;
      Status     : out Status_Kind)
   with
     Post =>
       ((Status = Invalid_Input) = not Valid_Input (N, Boundaries))
       and then
         (if Status = Invalid_Input then
            Needed = 0 and then Spans = Spans'Old
          else
            --  1. equals the reference semantics
            Needed = Spec_Count (N, Boundaries)
            and then (Status = Overflow) = (Needed > Spans'Length)
            and then
              (for all J in 1 .. Long_Long_Integer'Min (Needed, Spans'Length) =>
                 Nth (Spans, J).Start_Idx = Spec_Start (N, Boundaries, J)
                 and then Nth (Spans, J).End_Idx = Spec_End (N, Boundaries, J))
            --  2. frame
            and then
              (for all K in Spans'First + Long_Long_Integer'Min (Needed, Spans'Length) ..
                            Spans'Last => Spans (K) = Spans'Old (K))
            --  3. consequences on the output
            and then
              (for all J in 1 .. Long_Long_Integer'Min (Needed, Spans'Length) =>
                 Nth (Spans, J).Start_Idx =
                   (if J = 1 then 0 else Nth (Spans, J - 1).End_Idx + 1)
                 and then
                   Nth (Spans, J).End_Idx
                   - Nth (Spans, J).Start_Idx
                   >= (if J <= Main_Count (Boundaries) then Min_Match_Gap else Min_Tail_Gap)
                 and then
                   (if J > Main_Count (Boundaries) then
                      Nth (Spans, J).End_Idx = N - 1)));

end Boundary_Segmentation;

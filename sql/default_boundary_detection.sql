-- Default battle-boundary detection - a SQL port of the original hardcoded C
-- heuristic (replay_worker.c's scan_matches(), a "port of main.js's
-- processDatabaseAndCompileMatches"), now user-modifiable. scan_matches()
-- itself is left in place as a fallback/reference during migration - see its
-- own comment - so this file's job is to be a faithful, swappable-in
-- replacement, not a reinterpretation.
--
-- Verified byte-identical to scan_matches()'s match list (start_tick_id,
-- end_tick_id pairs) against all 24 fixtures under testdata/replays_batch/
-- before this file was added to the pipeline - see the boundary-detection
-- section of ui_behavior_tests.js for the standing regression version of
-- that check.
--
-- Algorithm - two sequential passes over the same ordered "boundary tick,
-- converted to its position in the full ordered tick list" sequence
-- scan_matches() itself makes (constants match its #defines exactly):
--   1. merge pass - drop any boundary in the first SKIP_FIRST=5 ticks of the
--      replay, then collapse boundaries within MERGE_WINDOW=15 ticks of the
--      previously KEPT one into that one (i.e. keep a boundary only if it's
--      MORE than 15 ticks past the last kept boundary)
--   2. segmentation pass - walk the merged boundary list; a candidate battle
--      span [start_idx, end_idx] is only accepted if it's at least
--      MIN_MATCH_GAP=10 ticks long. A rejected/too-short span's boundary is
--      simply skipped - start_idx carries forward UNCHANGED to the next
--      candidate, so a rejected span is silently absorbed into whichever
--      span eventually follows it. This matches scan_matches() exactly, not
--      an improvement: it's what makes "is_battle=0 spans" a genuinely new
--      concept below, not something this default port produces on its own.
--   3. tail segment - whatever remains after the last accepted span is
--      emitted as one final battle if it's at least MIN_TAIL_GAP=5 ticks
--      long, with no upper boundary event required.
--
-- Output: one row per detected span, (start_tick_id, end_tick_id, start_time,
-- end_time, is_battle) - start_time/end_time are ticks.time for the same two
-- rows, included here (rather than a separate C-side lookup pass) since the
-- query already has every tick indexed by idx. is_battle=1 rows become real
-- battles, exactly as g_matches[] does today.
-- is_battle=0 rows are the new "skippable non-battle section" concept this
-- rework adds - this default port never emits any (matching scan_matches()'s
-- own behavior above), but a custom boundary-detection query can: e.g. one
-- that explicitly marks a pre-battle lobby/warmup period as is_battle=0
-- instead of letting it silently merge into the first real battle the way
-- this default does.
--
-- Known, accepted, deliberate non-fidelity: scan_matches() caps at 256 raw
-- boundary events (never found to matter on any real fixture) and 16
-- (MAX_MATCHES) emitted battles - this SQL has no such cap itself (the C
-- caller, scan_matches_via_sql, truncates the result set to MAX_MATCHES
-- instead). These are NOT equivalent for a file with >16 real detected
-- battles: found on one real fixture (testdata/replays_batch/
-- replayLog_2026-08-01_21-12-29.sqlite, 20 real matches) that
-- scan_matches()'s cap check (`g_match_count < MAX_MATCHES - 1`) stops the
-- merge/segmentation loop from even LOOKING at boundaries past the 15th
-- accepted match, so its own tail-segment step then silently merges
-- everything from there to the end of the file into ONE oversized final
-- "match" (2645 ticks vs. a normal few hundred) - a real bug in the legacy
-- algorithm, not intentional design (MAX_MATCHES's own comment says "up to
-- 15 real battles per file, +1 headroom", i.e. this fixture's length was
-- never anticipated). scan_matches_via_sql keeps the true first 16 real
-- matches in chronological order instead of one giant merged tail -
-- deliberately NOT byte-identical here, by choice, not oversight.
--
-- @CACHE manual
WITH RECURSIVE
all_ticks AS (
    SELECT id AS tick_id, time AS tick_time, ROW_NUMBER() OVER (ORDER BY id) - 1 AS idx
    FROM ticks
),
last_idx AS (SELECT MAX(idx) AS v FROM all_ticks),
boundary_raw AS (
    SELECT DISTINCT t.idx AS idx, t.tick_id AS tick_id
    FROM all_ticks t
    JOIN events e ON e.tick_id = t.tick_id
    WHERE e.event_type IN ('map_switch', 'score_switch', 'faction_switch')
),
boundary_idx AS (
    SELECT ROW_NUMBER() OVER (ORDER BY idx) AS rn, idx, tick_id FROM boundary_raw
),
-- Pass 1 (merge): last_kept_idx starts at a sentinel far below any real
-- index, so the first candidate only needs to clear the idx>=5 skip-first
-- check (mirrors scan_matches()'s `merged_count == 0 || ...` short circuit).
merge_fold(rn, last_kept_idx, keep_idx, keep) AS (
    SELECT 0, -1000000, NULL, 0
    UNION ALL
    SELECT
        b.rn,
        CASE WHEN b.idx >= 5 AND b.idx > f.last_kept_idx + 15 THEN b.idx ELSE f.last_kept_idx END,
        CASE WHEN b.idx >= 5 AND b.idx > f.last_kept_idx + 15 THEN b.idx ELSE NULL END,
        CASE WHEN b.idx >= 5 AND b.idx > f.last_kept_idx + 15 THEN 1 ELSE 0 END
    FROM merge_fold f
    JOIN boundary_idx b ON b.rn = f.rn + 1
),
merged AS (
    SELECT ROW_NUMBER() OVER (ORDER BY keep_idx) AS rn, keep_idx AS idx
    FROM merge_fold WHERE keep = 1
),
-- Pass 2 (segmentation): start_idx only advances past an ACCEPTED span
-- (end_idx + 1); a rejected candidate leaves start_idx untouched for the
-- next row, which is exactly what lets a too-short span get absorbed.
seg_fold(rn, start_idx, end_idx, emit) AS (
    SELECT 0, 0, NULL, 0
    UNION ALL
    SELECT
        m.rn,
        CASE WHEN m.idx - f.start_idx >= 10 THEN m.idx + 1 ELSE f.start_idx END,
        m.idx,
        CASE WHEN m.idx - f.start_idx >= 10 THEN 1 ELSE 0 END
    FROM seg_fold f
    JOIN merged m ON m.rn = f.rn + 1
),
accepted AS (
    SELECT
        LAG(end_idx + 1, 1, 0) OVER (ORDER BY rn) AS a_start_idx,
        end_idx AS a_end_idx
    FROM seg_fold WHERE emit = 1
),
last_accepted_end AS (
    SELECT COALESCE(MAX(end_idx), -1) AS v FROM seg_fold WHERE emit = 1
)
SELECT sa.tick_id AS start_tick_id, ea.tick_id AS end_tick_id,
       sa.tick_time AS start_time, ea.tick_time AS end_time, 1 AS is_battle
FROM accepted acc
JOIN all_ticks sa ON sa.idx = acc.a_start_idx
JOIN all_ticks ea ON ea.idx = acc.a_end_idx
UNION ALL
-- Tail segment.
SELECT sa.tick_id, ea.tick_id, sa.tick_time, ea.tick_time, 1
FROM (SELECT (SELECT v FROM last_accepted_end) + 1 AS start_idx) s
JOIN all_ticks sa ON sa.idx = s.start_idx
JOIN all_ticks ea ON ea.idx = (SELECT v FROM last_idx)
WHERE (SELECT v FROM last_idx) - s.start_idx >= 5
ORDER BY start_tick_id ASC;

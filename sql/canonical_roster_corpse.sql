-- Canonical definition of "roster + corpse state at a given tick", as a
-- single query, in a WITH RECURSIVE fold over ordered spawn/kill events.
--
-- This is the single source of truth for what replay_worker.c's
-- apply_roster_delta()/resync_roster_to() compute incrementally in C for
-- live 60fps playback (replay_worker.c, prepared statement text starting
-- "SELECT e.event_type, e.tick_id, ..." - kept byte-for-byte aligned with
-- the FROM/JOIN/WHERE clause below), and what testdata/ground_truth.py
-- executes directly as its test oracle. The C path stays fast (O(1) struct
-- mutation per event, incremental across calls); this query is the slow but
-- always-correct-by-construction equivalent, meant for one-shot uses only:
-- the debug SQL terminal, offline battle.db regeneration, and testing - NOT
-- the hot playback path. See scripts/gen_canonical_sql_header.py for how this
-- file becomes a compiled-in C string (and its own sha256, embedded in
-- exported battle.db files' _table_provenance table).
--
-- Bind parameters (named, not positional - see sqlite3_bind_parameter_index):
--   :from_tick - exclusive lower bound (matches C's `tick_id > ?1`)
--   :to_tick   - inclusive upper bound (matches C's `tick_id <= ?2`)
--
-- Semantics that MUST stay identical to the C path:
--   - Events are folded in `events.id` order (chronological), not tick_id
--     order - multiple events can share a tick_id, and id order is what
--     resolves ties the same way C's "ORDER BY e.id ASC" does.
--   - A spawn OVERWRITES that agent_id's roster entry outright (team,
--     is_human, spawn_event_id) - it does not merge with any prior entry.
--   - A kill's corpse gets the roster's CURRENT team for that agent_id at
--     the moment the kill is processed (i.e. whatever the most recent
--     earlier-processed spawn in THIS SAME fold set it to, or the default
--     below if none did).
--   - An agent_id that never appears in a 'spawn' row within this window
--     defaults to team=0 (NOT -1/"unknown") if killed anyway - this matches
--     C's RosterEntry.team being a plain `signed char` zeroed by memset()
--     before any delta is applied (replay_worker.c:108-114), not a
--     deliberately-chosen sentinel. Do not "fix" this default to -1 without
--     also changing the C struct's zero-init and every test fixture that
--     depends on today's behavior.
--
-- Output: exactly one row, two JSON columns:
--   roster   - JSON object keyed by agent_id (as a string, per JSON object
--              key rules): {"<agent_id>": {"active":1,"is_human":0|1,
--              "team":-1|0|1,"spawn_event_id":<int>}, ...}
--   corpses  - JSON array, one entry per kill IN FOLD ORDER (i.e. chronological):
--              [{"x":<real>,"y":<real>,"team":-1|0|1}, ...]
--
-- Known, accepted cost (see plan risk #1): one recursive step per
-- spawn/kill event, each doing a JSON serialize/deserialize of the growing
-- roster object - plausibly orders of magnitude slower per-row than the C
-- loop's O(1) struct mutation. Fine for one-shot terminal/regeneration use
-- against a single battle's event count; not intended for hot-path use.

WITH RECURSIVE
events_ordered AS (
    SELECT ROW_NUMBER() OVER (ORDER BY e.id) AS rn,
           e.event_type,
           CASE e.event_type WHEN 'spawn' THEN s.agent_id ELSE k.dead_id END AS agent_ref,
           s.is_human      AS is_human,
           s.team          AS spawn_team_text,
           s.event_id      AS spawn_event_id,
           k.dead_id       AS dead_id,
           k.dead_x        AS dead_x,
           k.dead_y        AS dead_y
    FROM events e
    LEFT JOIN spawns s ON e.event_type = 'spawn' AND s.event_id = e.id
    LEFT JOIN kills  k ON e.event_type = 'kill'  AND k.event_id = e.id
    WHERE e.tick_id > :from_tick AND e.tick_id <= :to_tick
      AND e.event_type IN ('spawn', 'kill')
),
fold(rn, roster, corpses) AS (
    SELECT 0, '{}', '[]'
    UNION ALL
    SELECT
        eo.rn,
        CASE WHEN eo.event_type = 'spawn' THEN
            json_set(f.roster, '$."' || eo.agent_ref || '"',
                json_object(
                    'active', 1,
                    'is_human', eo.is_human,
                    'team',
                        CASE eo.spawn_team_text
                            WHEN '0' THEN 0
                            WHEN '1' THEN 1
                            ELSE -1
                        END,
                    'spawn_event_id', eo.spawn_event_id
                ))
        ELSE f.roster END,
        CASE WHEN eo.event_type = 'kill' THEN
            json_insert(f.corpses, '$[#]',
                json_object(
                    'x', eo.dead_x,
                    'y', eo.dead_y,
                    'team', COALESCE(
                        json_extract(f.roster, '$."' || eo.dead_id || '".team'),
                        0)
                ))
        ELSE f.corpses END
    FROM fold f
    JOIN events_ordered eo ON eo.rn = f.rn + 1
)
SELECT roster, corpses FROM fold ORDER BY rn DESC LIMIT 1;

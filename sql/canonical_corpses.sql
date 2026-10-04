-- Canonical definition of permanent corpse markers, one row per kill, each
-- carrying the tick it happened at so a rendering query can scope to
-- "corpses that exist as of the tick currently being displayed"
-- (WHERE tick_id <= CURRENT_TICK()) - the tick-scoping the old C fast path
-- (frame_state_a, replay_worker.c's corpse_count_at_a snapshot) used to
-- provide by re-deriving every real tick change. Here it's just a plain
-- column filter, since every kill in the battle is a fixed, known point in
-- time - no per-tick re-derivation needed.
--
-- Self-contained spawn-validity CTE (not a join against a separately
-- materialized roster_history table): keeps this file usable on its own as
-- a single query, matching canonical_roster_corpse.sql's own convention,
-- and correct regardless of what order the caller happens to build tables
-- in. See canonical_roster_history.sql's own header comment for why a
-- LEAD() window answers "which spawn's team was active" without recursion.
--
-- Bind parameters (named, matching canonical_roster_corpse.sql's own
-- convention): :from_tick (exclusive lower bound), :to_tick (inclusive
-- upper bound).
--
-- Output: one row per kill - x, y, team (the roster's team for dead_id at
-- the moment of death, defaulting to 0 exactly like
-- canonical_roster_corpse.sql's own corpse team default - see that file's
-- header comment on why 0, not -1), tick_id.
WITH roster_intervals AS (
    SELECT
        agent_id,
        team,
        valid_from_tick,
        COALESCE(next_spawn_tick - 1, :to_tick) AS valid_to_tick
    FROM (
        SELECT
            s.agent_id,
            CASE s.team WHEN '0' THEN 0 WHEN '1' THEN 1 ELSE -1 END AS team,
            e.tick_id AS valid_from_tick,
            LEAD(e.tick_id) OVER (PARTITION BY s.agent_id ORDER BY s.event_id) AS next_spawn_tick
        FROM spawns s
        JOIN events e ON e.id = s.event_id
        WHERE e.tick_id > :from_tick AND e.tick_id <= :to_tick
    )
)
SELECT
    k.dead_x AS x,
    k.dead_y AS y,
    COALESCE(ri.team, 0) AS team,
    e.tick_id AS tick_id
FROM kills k
JOIN events e ON e.id = k.event_id
LEFT JOIN roster_intervals ri
    ON ri.agent_id = k.dead_id AND e.tick_id BETWEEN ri.valid_from_tick AND ri.valid_to_tick
WHERE e.tick_id > :from_tick AND e.tick_id <= :to_tick;

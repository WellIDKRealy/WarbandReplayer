-- Canonical definition of "which team/kind an agent_id belonged to, and for
-- which tick range" - the piece rendering actually needs per-tick, as a
-- plain windowed query, NOT a recursive fold. Position data itself never
-- needs deriving here: main.agent_states already holds a raw row per
-- (tick_id, agent_id) - the only thing NOT already sitting in a raw source
-- table is "which spawn's team assignment was active at a given tick",
-- since a respawn can reuse the same agent_id with a different team
-- mid-battle. That's answerable directly from spawns/events with a single
-- LEAD() window per agent_id's own spawn history - no per-event
-- accumulation required, unlike canonical_roster_corpse.sql's cumulative
-- "final roster/corpse state as of :to_tick" JSON summary (a different
-- question: that file answers "what's true at the very end", this one
-- answers "what was true at every tick along the way").
--
-- Bind parameters (named, matching canonical_roster_corpse.sql's own
-- convention): :from_tick (exclusive lower bound), :to_tick (inclusive
-- upper bound).
--
-- Output: one row per spawn event within the range, each row's
-- [valid_from_tick, valid_to_tick] the inclusive tick span that spawn's
-- team/is_human assignment was the active one for that agent_id (capped at
-- :to_tick for a unit that never respawned again within the window).
SELECT
    agent_id,
    team,
    is_human,
    spawn_event_id,
    valid_from_tick,
    COALESCE(next_spawn_tick - 1, :to_tick) AS valid_to_tick
FROM (
    SELECT
        s.agent_id,
        CASE s.team WHEN '0' THEN 0 WHEN '1' THEN 1 ELSE -1 END AS team,
        s.is_human,
        s.event_id AS spawn_event_id,
        e.tick_id AS valid_from_tick,
        LEAD(e.tick_id) OVER (PARTITION BY s.agent_id ORDER BY s.event_id) AS next_spawn_tick
    FROM spawns s
    JOIN events e ON e.id = s.event_id
    WHERE e.tick_id > :from_tick AND e.tick_id <= :to_tick
);

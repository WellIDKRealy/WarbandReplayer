-- Default rendering query: living agents layer. Ships SECOND in the default
-- list (after corpses, before chat) so living agents draw on top of any
-- corpse standing on the same spot - matches the pre-rework hardcoded order
-- exactly. Reproduces the old hardcoded per-team colors (main.c: team 0 ->
-- red, team 1 -> blue, anything else -> gray).
--
-- main.agent_states already holds a raw row per (tick_id, agent_id) - no
-- derivation needed for position itself, just a plain indexed lookup
-- (CURRENT_BATTLE_ROWID_LO()/HI() scopes it to this battle's own rowid
-- slice, the same partial-index-backed range the C engine's own
-- fetch_positions uses). b.roster_history (see
-- sql/canonical_roster_history.sql) supplies the one thing NOT already
-- sitting in a raw source table: which team/is_human this agent_id counts
-- as at the CURRENT tick specifically (a respawn can reuse the same
-- agent_id with a different team mid-battle).
--
-- row_key = spawn_event_id, NOT agent_id: this is what makes interpolation
-- (build_query_text_for_slot's tickA/tickB self-join, replay_worker.c)
-- correctly refuse to blend across a respawn boundary - if agent_id X died
-- at tickA and a DIFFERENT unit respawned into that same slot by tickB,
-- the tickB row carries a DIFFERENT spawn_event_id, so the join simply
-- finds no match (shows tickA's position with no interpolation) instead of
-- blending toward the new unit's position - the same correctness property
-- the old C engine's g_snap_a_spawn respawn guard used to enforce directly.
--
-- @KIND dots
-- @CACHE tick
-- @INTERPOLATE on
SELECT
    rh.spawn_event_id AS row_key,
    a.pos_x AS x, a.pos_y AS y,
    CASE rh.team WHEN 0 THEN 0.95 WHEN 1 THEN 0.25 ELSE 0.6 END AS color_r,
    CASE rh.team WHEN 0 THEN 0.25 WHEN 1 THEN 0.45 ELSE 0.6 END AS color_g,
    CASE rh.team WHEN 0 THEN 0.25 WHEN 1 THEN 0.95 ELSE 0.6 END AS color_b
FROM main.agent_states a
JOIN b.roster_history rh
    ON rh.agent_id = a.agent_id AND a.tick_id BETWEEN rh.valid_from_tick AND rh.valid_to_tick
WHERE a.id BETWEEN CURRENT_BATTLE_ROWID_LO() AND CURRENT_BATTLE_ROWID_HI()
  AND a.tick_id = CURRENT_TICK()
  AND rh.is_human = 1;

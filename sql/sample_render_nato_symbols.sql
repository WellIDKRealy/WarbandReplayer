-- Sample/template rendering query for the NATO APP-6 symbol kind (see
-- main.js's map-symbol-layer / NATO_UNIT_TYPE_MAP). NOT part of the default
-- rendering-query list (main.js's DEFAULT_RENDER_QUERIES) - ships disabled,
-- offered as the "Add Query" panel's nato_symbol template, so a user who
-- never opens the Rendering Queries panel sees no visual change.
--
-- Deliberately minimal: one symbol per currently-alive human agent, reading
-- unit_type/commander_name straight off the real spawns.class_id/agent_name
-- columns (see lua/msfiles/header_common.py's multi_troop_class_* enum -
-- Napoleonic Wars uses ids 10-23). No clustering, no group/formation
-- recognition, no echelon - one soldier, one symbol. Turning many soldiers
-- into one representative formation symbol is exactly the kind of query this
-- infrastructure is FOR, but that logic is future work authored live in this
-- same editor, not something this sample attempts.
--
-- Same main.agent_states JOIN b.roster_history pattern as
-- sql/default_render_living_agents.sql (see that file's own header comment
-- for why - frame_state_a/b no longer exist, this arbitrary/user-editable
-- "b" schema replaced them entirely), joined once more against spawns via
-- roster_history's own spawn_event_id to pick up class_id/agent_name -
-- exactly the columns raw position/roster data doesn't carry.
--
-- @KIND nato_symbol
-- @CACHE tick
-- @INTERPOLATE on
SELECT
    rh.spawn_event_id AS row_key,
    a.pos_x AS x, a.pos_y AS y,
    s.class_id AS unit_type,
    s.agent_name AS commander_name,
    '' AS aux_text
FROM main.agent_states a
JOIN b.roster_history rh
    ON rh.agent_id = a.agent_id AND a.tick_id BETWEEN rh.valid_from_tick AND rh.valid_to_tick
JOIN spawns s ON s.event_id = rh.spawn_event_id
WHERE a.id BETWEEN CURRENT_BATTLE_ROWID_LO() AND CURRENT_BATTLE_ROWID_HI()
  AND a.tick_id = CURRENT_TICK()
  AND rh.is_human = 1;

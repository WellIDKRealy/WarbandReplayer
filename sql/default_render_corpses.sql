-- Default rendering query: corpses layer. Ships FIRST in the default
-- rendering-query list so corpses are drawn (and thus layered) underneath
-- living agents, matching this project's pre-rework hardcoded draw order
-- (main.c's old render_frame() emitted corpses into agent_buffer before
-- living agents, and painted with no depth test - whatever's pushed first
-- ends up visually underneath). Reproduces the old hardcoded per-team corpse
-- colors exactly (main.c: team 0 -> dark red, team 1 -> dark blue, anything
-- else -> gray).
--
-- Reads b.corpses - an arbitrary, user-editable table (see
-- sql/canonical_corpses.sql and export_create_battledb_schema's own
-- comment in replay_export.c), not a fixed-schema C-populated one. Every
-- kill in the battle is derived once per battle switch (cached - see
-- replay_export.c's battle.db image cache), never re-derived per tick, so
-- this stays cheap even though the underlying data is a real, arbitrary
-- table rather than a hand-maintained C fast path. tick_id <= CURRENT_TICK()
-- is what scopes it to "corpses that exist as of the tick currently being
-- displayed" - the old C fast path used to provide that same scoping by
-- re-deriving every real tick change; here it's just a plain column filter
-- against data that's already fully materialized for the whole battle.
--
-- @KIND dots
-- @CACHE tick
-- @INTERPOLATE off
SELECT
    x, y,
    CASE team WHEN 0 THEN 0.45 WHEN 1 THEN 0.1  ELSE 0.6 END AS color_r,
    CASE team WHEN 0 THEN 0.1  WHEN 1 THEN 0.15 ELSE 0.6 END AS color_g,
    CASE team WHEN 0 THEN 0.1  WHEN 1 THEN 0.45 ELSE 0.6 END AS color_b
FROM b.corpses
WHERE tick_id <= CURRENT_TICK();

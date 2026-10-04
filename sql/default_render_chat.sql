-- Default rendering query: chat layer. Byte-identical to the query
-- refreshChatFromQuery() in main.js already ran directly before this
-- rework - moved here so it's editable/reorderable/exportable like every
-- other rendering query instead of being the one hardcoded exception.
--
-- @KIND chat
-- @CACHE tick
SELECT c.username, c.message, c.team
FROM chats c
JOIN events e ON c.event_id = e.id
WHERE e.tick_id >= CURRENT_BATTLE_TICK_START() AND e.tick_id <= CURRENT_TICK()
ORDER BY e.id ASC;

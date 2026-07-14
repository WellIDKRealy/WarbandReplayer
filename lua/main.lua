sqlite = require("lsqlite3")

-- Safely attempt to load LuaFileSystem (LFS) for embedded environments
local has_lfs, lfs = pcall(require, "lfs")

local date_str = os.date("%Y-%m-%d_%H-%M-%S")
local db = sqlite.open("replayLog_" .. date_str .. ".sqlite")

-- ------------------------------------------------------------------
-- Database Optimization & Schema Setup
-- ------------------------------------------------------------------
db:exec[[
	PRAGMA page_size = 4096;
	PRAGMA auto_vacuum = FULL;
	PRAGMA synchronous = OFF;
	PRAGMA journal_mode = MEMORY;
]]

db:exec[[
	CREATE TABLE IF NOT EXISTS ticks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		time INTEGER,
		observer_player_id INTEGER
	);
	
	CREATE TABLE IF NOT EXISTS events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tick_id INTEGER,
		event_type TEXT,
		event_order INTEGER,
		FOREIGN KEY(tick_id) REFERENCES ticks(id)
	);

	CREATE TABLE IF NOT EXISTS chats (
		event_id INTEGER,
		username TEXT,
		team TEXT,
		chat_type TEXT,
		message TEXT,
		FOREIGN KEY(event_id) REFERENCES events(id)
	);

	CREATE TABLE IF NOT EXISTS map_switches (
		event_id INTEGER,
		scene_no INTEGER,
		FOREIGN KEY(event_id) REFERENCES events(id)
	);

	CREATE TABLE IF NOT EXISTS score_switches (
		event_id INTEGER,
		team_0_score INTEGER,
		team_1_score INTEGER,
		FOREIGN KEY(event_id) REFERENCES events(id)
	);

	-- Updated schema to track faction ID changes and string name changes
	CREATE TABLE IF NOT EXISTS faction_switches (
		event_id INTEGER,
		team_0_faction_id INTEGER,
		team_0_faction_name TEXT,
		team_1_faction_id INTEGER,
		team_1_faction_name TEXT,
		FOREIGN KEY(event_id) REFERENCES events(id)
	);

	CREATE TABLE IF NOT EXISTS kills (
		event_id INTEGER,
		type TEXT,
		dead_id INTEGER,
		dead_name TEXT,
		dead_x REAL, dead_y REAL, dead_z REAL,
		killer_id INTEGER,
		killer_name TEXT,
		killer_x REAL, killer_y REAL, killer_z REAL,
		FOREIGN KEY(event_id) REFERENCES events(id)
	);

	CREATE TABLE IF NOT EXISTS spawns (
		event_id INTEGER,
		agent_id INTEGER,
		agent_name TEXT,
		is_human INTEGER,
		pos_x REAL, pos_y REAL, pos_z REAL,
		team TEXT,
		group_id INTEGER,
		class_id INTEGER,
		division_id INTEGER,
		FOREIGN KEY(event_id) REFERENCES events(id)
	);

	CREATE TABLE IF NOT EXISTS agent_states (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tick_id INTEGER,
		agent_id INTEGER,
		pos_x REAL, pos_y REAL, pos_z REAL,
		yaw REAL, pitch REAL,
		hp INTEGER,
		attack_action INTEGER, defend_action INTEGER,
		wielded_right INTEGER, wielded_left INTEGER,
		ammo INTEGER,
		horse_id INTEGER,
		rider_id INTEGER,
		FOREIGN KEY(tick_id) REFERENCES ticks(id)
	);
]]

-- ------------------------------------------------------------------
-- State Tracking
-- ------------------------------------------------------------------
local current_tick_id = 0
local event_order_counter = 0
local last_scene_no = -1

local last_score_0 = nil
local last_score_1 = nil
local last_faction_0 = nil
local last_faction_1 = nil

-- The complete sequential scene lookup map
local scenes_by_index = {}
local next_index = 0

local function create_event(event_type)
	event_order_counter = event_order_counter + 1
	local stmt = db:prepare("INSERT INTO events (tick_id, event_type, event_order) VALUES (?, ?, ?)")
	stmt:bind_values(current_tick_id, event_type, event_order_counter)
	stmt:step()
	local event_id = stmt:last_insert_rowid()
	stmt:finalize()
	return event_id
end

-- ------------------------------------------------------------------
-- Engine State Checkers
-- ------------------------------------------------------------------
local function check_map_switch()
	local scene_no = game.store_current_scene(0) or -1
	
	if scene_no ~= -1 and scene_no ~= last_scene_no then
		last_scene_no = scene_no
		
		local event_id = create_event("map_switch")
		local stmt = db:prepare("INSERT INTO map_switches (event_id, scene_no) VALUES (?, ?)")
		stmt:bind_values(event_id, scene_no)
		stmt:step()
		stmt:finalize()
	end
end

local function check_score_switch()
	local score_0 = game.team_get_score(0, 0) or 0
	local score_1 = game.team_get_score(0, 1) or 0

	if score_0 ~= last_score_0 or score_1 ~= last_score_1 then
		last_score_0 = score_0
		last_score_1 = score_1

		local event_id = create_event("score_switch")
		local stmt = db:prepare("INSERT INTO score_switches (event_id, team_0_score, team_1_score) VALUES (?, ?, ?)")
		stmt:bind_values(event_id, score_0, score_1)
		stmt:step()
		stmt:finalize()
	end
end

local function check_faction_switch()
	local fac_0 = game.team_get_faction(0, 0) or -1
	local fac_1 = game.team_get_faction(0, 1) or -1
	
	if fac_0 ~= last_faction_0 or fac_1 ~= last_faction_1 then
		last_faction_0 = fac_0
		last_faction_1 = fac_1
		
		local fac_0_name = "Unknown"
		local fac_1_name = "Unknown"
		
		if fac_0 ~= -1 then
			game.str_store_faction_name(0, fac_0)
			fac_0_name = game.sreg[0] or "Unknown"
		end
		if fac_1 ~= -1 then
			game.str_store_faction_name(1, fac_1)
			fac_1_name = game.sreg[1] or "Unknown"
		end
		
		local event_id = create_event("faction_switch")
		local stmt = db:prepare("INSERT INTO faction_switches (event_id, team_0_faction_id, team_0_faction_name, team_1_faction_id, team_1_faction_name) VALUES (?, ?, ?, ?, ?)")
		stmt:bind_values(event_id, fac_0, fac_0_name, fac_1, fac_1_name)
		stmt:step()
		stmt:finalize()
	end
end

-- ------------------------------------------------------------------
-- Game Hooks & Loop Events
-- ------------------------------------------------------------------
function game.OnChatMessageReceived(intPlayerNo, boolIsTeamChat, strMsg)
	game.str_store_player_username(0, intPlayerNo)
	local username = game.sreg[0]
	local team = game.player_get_team_no(0, intPlayerNo)

	if team == 2 then 
		team = "spectator"
	else
		team = tostring(team)
	end

	local chat_type = boolIsTeamChat and "team" or "global"
	
	local event_id = create_event("chat")
	local stmt = db:prepare("INSERT INTO chats (event_id, username, team, chat_type, message) VALUES (?, ?, ?, ?, ?)")
	stmt:bind_values(event_id, username, team, chat_type, strMsg)
	stmt:step()
	stmt:finalize()
end

function onKill()
	local dead = game.store_trigger_param(0, 1)
	local killer = game.store_trigger_param(0, 2)
	local wounded = game.store_trigger_param(0, 3)

	if killer == -1 or dead == -1 then return end

	local killer_non_player = game.agent_is_non_player(killer)
	local dead_non_player = game.agent_is_non_player(dead)

	local killer_name
	if killer_non_player then
		game.str_store_agent_name(0, killer)
		killer_name = game.sreg[0]
	else
		local player_id = game.agent_get_player_id(0, killer)
		game.str_store_player_username(0, player_id)
		killer_name = game.sreg[0]
	end

	local dead_name
	if dead_non_player then
		game.str_store_agent_name(0, dead)
		dead_name = game.sreg[0]
	else
		local player_id = game.agent_get_player_id(0, dead)
		game.str_store_player_username(0, player_id)
		dead_name = game.sreg[0]
	end

	game.agent_get_position(0, dead)
	local dead_x, dead_y, dead_z = game.preg[0].o.x, game.preg[0].o.y, game.preg[0].o.z
	
	game.agent_get_position(1, killer)
	local killer_x, killer_y, killer_z = game.preg[1].o.x, game.preg[1].o.y, game.preg[1].o.z

	local type_str = (wounded == 0) and "KILLED" or "WOUNDED"
	
	local event_id = create_event("kill")
	local stmt = db:prepare("INSERT INTO kills (event_id, type, dead_id, dead_name, dead_x, dead_y, dead_z, killer_id, killer_name, killer_x, killer_y, killer_z) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
	stmt:bind_values(event_id, type_str, dead, dead_name, dead_x, dead_y, dead_z, killer, killer_name, killer_x, killer_y, killer_z)
	stmt:step()
	stmt:finalize()
end

function onSpawn()
	local agent = game.store_trigger_param(0, 1)
	local is_human = game.agent_is_human(agent)
	local non_player = game.agent_is_non_player(agent)

	local agent_name
	if non_player then
		game.str_store_agent_name(0, agent)
		agent_name = game.sreg[0]
	else
		local player_id = game.agent_get_player_id(0, agent)
		game.str_store_player_username(0, player_id)
		agent_name = game.sreg[0]
	end

	game.agent_get_position(0, agent)
	local pos_x, pos_y, pos_z = game.preg[0].o.x, game.preg[0].o.y, game.preg[0].o.z

	local team, group, class, division = nil, nil, nil, nil

	if is_human then
		team = game.agent_get_team(0, agent)
		team = (team == 2) and "spectator" or tostring(team)
		group = game.agent_get_group(0, agent)
		class = game.agent_get_class(0, agent)
		division = game.agent_get_division(0, agent)
	end

	local event_id = create_event("spawn")
	local stmt = db:prepare("INSERT INTO spawns (event_id, agent_id, agent_name, is_human, pos_x, pos_y, pos_z, team, group_id, class_id, division_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
	stmt:bind_values(event_id, agent, agent_name, is_human and 1 or 0, pos_x, pos_y, pos_z, team, group, class, division)
	stmt:step()
	stmt:finalize()
end

function tick()
	db:exec("BEGIN TRANSACTION")

	local observer_player_id = game.multiplayer_get_my_player(0) or -1
	event_order_counter = 0

	local stmt_tick = db:prepare("INSERT INTO ticks (time, observer_player_id) VALUES (?, ?)")
	stmt_tick:bind_values(os.time(), observer_player_id)
	stmt_tick:step()
	current_tick_id = stmt_tick:last_insert_rowid()
	stmt_tick:finalize()
	
	check_map_switch()
	check_score_switch()
	check_faction_switch()
	
	local stmt_agent = db:prepare("INSERT INTO agent_states (tick_id, agent_id, pos_x, pos_y, pos_z, yaw, pitch, hp, attack_action, defend_action, wielded_right, wielded_left, ammo, horse_id, rider_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")

	for agent = 0, 1024 do
		if game.agent_is_active(agent) and game.agent_is_alive(agent) then
			game.agent_get_position(0, agent)
			local px, py, pz = game.preg[0].o.x, game.preg[0].o.y, game.preg[0].o.z
			local hp = game.store_agent_hit_points(0, agent, 1)
			
			local is_human = game.agent_is_human(agent)
			local yaw, pitch, atk, def, w_r, w_l, ammo, horse, rider = nil, nil, nil, nil, nil, nil, nil, nil, nil
			
			if is_human then
				game.agent_get_look_position(1, agent)
				local look_rot = game.preg[1].rot:getRot()
				pitch = look_rot.x
				yaw = look_rot.z

				atk = game.agent_get_attack_action(0, agent)
				def = game.agent_get_defend_action(0, agent)
				w_r = game.agent_get_wielded_item(0, agent, 0)
				w_l = game.agent_get_wielded_item(0, agent, 1)
				ammo = game.agent_get_ammo(0, agent, 1)
				horse = game.agent_get_horse(0, agent)
				
				if horse == -1 then horse = nil end
			else
				yaw = game.preg[0].rot:getRot().z
				rider = game.agent_get_rider(0, agent)
				
				if rider == -1 then rider = nil end
			end
			
			stmt_agent:bind_values(current_tick_id, agent, px, py, pz, yaw, pitch, hp, atk, def, w_r, w_l, ammo, horse, rider)
			stmt_agent:step()
			stmt_agent:reset()
		end
	end

	stmt_agent:finalize()
	db:exec("COMMIT")
end

function reset()
	db:exec("VACUUM")
end

templates = {
	"dm",
	"cb"
}

for k,v in pairs(templates) do
	game.addTrigger("mst_multiplayer_" .. v, game.const.ti_on_agent_killed_or_wounded, 0, 0, onKill)
	game.addTrigger("mst_multiplayer_" .. v, game.const.ti_on_agent_spawn, 0, 0, onSpawn)
	game.addTrigger("mst_multiplayer_" .. v, game.const.ti_before_mission_start, 0, 0, reset)
	game.addTrigger("mst_multiplayer_" .. v, 1, 0, 0, tick)
end

print("Loaded replay recorder")
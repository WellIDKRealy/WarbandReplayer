#!/usr/bin/env python3
"""Generates a small multi-battle .sqlite fixture matching the real
recorder schema (lua/main.lua) for testing replay_worker.c without
needing the full ~164MB real file. Two "matches" separated by a
map_switch boundary, a handful of agents, some kills/chats.
"""
import sqlite3
import os
import random

OUT = os.path.join(os.path.dirname(__file__), "synthetic_fixture.sqlite")
if os.path.exists(OUT):
    os.remove(OUT)

con = sqlite3.connect(OUT)
cur = con.cursor()

cur.executescript("""
CREATE TABLE ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER, observer_player_id INTEGER);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, tick_id INTEGER, event_type TEXT, event_order INTEGER, FOREIGN KEY(tick_id) REFERENCES ticks(id));
CREATE TABLE chats (event_id INTEGER, username TEXT, team TEXT, chat_type TEXT, message TEXT, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE map_switches (event_id INTEGER, scene_no INTEGER, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE score_switches (event_id INTEGER, team_0_score INTEGER, team_1_score INTEGER, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE faction_switches (event_id INTEGER, team_0_faction_id INTEGER, team_0_faction_name TEXT, team_1_faction_id INTEGER, team_1_faction_name TEXT, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE kills (event_id INTEGER, type TEXT, dead_id INTEGER, dead_name TEXT, dead_x REAL, dead_y REAL, dead_z REAL, killer_id INTEGER, killer_name TEXT, killer_x REAL, killer_y REAL, killer_z REAL, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE spawns (event_id INTEGER, agent_id INTEGER, agent_name TEXT, is_human INTEGER, pos_x REAL, pos_y REAL, pos_z REAL, team TEXT, group_id INTEGER, class_id INTEGER, division_id INTEGER, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE agent_states (id INTEGER PRIMARY KEY AUTOINCREMENT, tick_id INTEGER, agent_id INTEGER, pos_x REAL, pos_y REAL, pos_z REAL, yaw REAL, pitch REAL, hp INTEGER, attack_action INTEGER, defend_action INTEGER, wielded_right INTEGER, wielded_left INTEGER, ammo INTEGER, horse_id INTEGER, rider_id INTEGER, FOREIGN KEY(tick_id) REFERENCES ticks(id));
""")

random.seed(42)

def add_event(tick_id, event_type, order=0):
    cur.execute("INSERT INTO events(tick_id, event_type, event_order) VALUES (?,?,?)", (tick_id, event_type, order))
    return cur.lastrowid

NUM_AGENTS = 8
TICKS_PER_MATCH = 300
NUM_MATCHES = 2
TIME_START = 1700000000

tick_id_for_time = {}
agent_state = {}  # agent_id -> {team, is_human, alive}

t = TIME_START
tick_counter = 0

for match_idx in range(NUM_MATCHES):
    # map_switch boundary at the start of each match (skip for match 0 - "initial state")
    cur.execute("INSERT INTO ticks(time, observer_player_id) VALUES (?, 0)", (t,))
    boundary_tick = cur.lastrowid
    tick_counter += 1
    ev = add_event(boundary_tick, "map_switch")
    cur.execute("INSERT INTO map_switches(event_id, scene_no) VALUES (?,?)", (ev, 100 + match_idx))
    ev2 = add_event(boundary_tick, "faction_switch")
    cur.execute("INSERT INTO faction_switches(event_id, team_0_faction_id, team_0_faction_name, team_1_faction_id, team_1_faction_name) VALUES (?,?,?,?,?)",
                (ev2, 1, f"FactionA{match_idx}", 2, f"FactionB{match_idx}"))
    # score resets alongside the map/faction switch (realistic: all three
    # boundary event types cluster at an actual match transition, which is
    # what keeps them merged into ONE boundary in the segmentation algorithm -
    # a score_switch stranded mid-match would correctly (by design) be
    # detected as its own separate match transition).
    ev3 = add_event(boundary_tick, "score_switch")
    cur.execute("INSERT INTO score_switches(event_id, team_0_score, team_1_score) VALUES (?,?,?)", (ev3, 0, 0))
    t += 1

    # spawn all agents at match start
    agent_state = {}
    for aid in range(NUM_AGENTS):
        team = "0" if aid % 2 == 0 else "1"
        is_human = 1 if aid < 6 else 0
        ev = add_event(boundary_tick, "spawn")
        px, py = random.uniform(-50, 50), random.uniform(-50, 50)
        cur.execute("""INSERT INTO spawns(event_id, agent_id, agent_name, is_human, pos_x, pos_y, pos_z, team, group_id, class_id, division_id)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (ev, aid, f"Agent{aid}", is_human, px, py, 0.0, team, 0, 0, 0))
        agent_state[aid] = {"team": team, "is_human": is_human, "alive": True, "x": px, "y": py}

    # skip a few "initial state" ticks like the real recorder does
    for skip in range(6):
        cur.execute("INSERT INTO ticks(time, observer_player_id) VALUES (?, 0)", (t,))
        tick_counter += 1
        t += 1

    for i in range(TICKS_PER_MATCH):
        cur.execute("INSERT INTO ticks(time, observer_player_id) VALUES (?, 0)", (t,))
        tick_id = cur.lastrowid
        tick_id_for_time[t] = tick_id
        tick_counter += 1

        # move alive agents, write agent_states every tick
        for aid, st in agent_state.items():
            if not st["alive"]:
                continue
            st["x"] += random.uniform(-1, 1)
            st["y"] += random.uniform(-1, 1)
            cur.execute("""INSERT INTO agent_states(tick_id, agent_id, pos_x, pos_y, pos_z, yaw, pitch, hp,
                           attack_action, defend_action, wielded_right, wielded_left, ammo, horse_id, rider_id)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (tick_id, aid, st["x"], st["y"], 0.0, 0.0, 0.0, 100, 0, 0, -1, -1, 0, -1, -1))

        # occasional kill around the middle of the match
        if i == TICKS_PER_MATCH // 2:
            alive_ids = [a for a, s in agent_state.items() if s["alive"]]
            if len(alive_ids) >= 2:
                dead_id = alive_ids[0]
                killer_id = alive_ids[1]
                ev = add_event(tick_id, "kill")
                cur.execute("""INSERT INTO kills(event_id, type, dead_id, dead_name, dead_x, dead_y, dead_z,
                               killer_id, killer_name, killer_x, killer_y, killer_z) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (ev, "melee", dead_id, f"Agent{dead_id}",
                             agent_state[dead_id]["x"], agent_state[dead_id]["y"], 0.0,
                             killer_id, f"Agent{killer_id}",
                             agent_state[killer_id]["x"], agent_state[killer_id]["y"], 0.0))
                agent_state[dead_id]["alive"] = False

        # occasional chat
        if i % 80 == 0:
            ev = add_event(tick_id, "chat")
            cur.execute("INSERT INTO chats(event_id, username, team, chat_type, message) VALUES (?,?,?,?,?)",
                        (ev, f"Player{i%NUM_AGENTS}", "0" if i % 2 == 0 else "1", "team", f"gg tick {i}"))

        t += 1

con.commit()

cur.execute("SELECT COUNT(*) FROM ticks")
print("ticks:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM agent_states")
print("agent_states:", cur.fetchone()[0])
cur.execute("SELECT COUNT(*) FROM events")
print("events:", cur.fetchone()[0])
con.close()
print("wrote", OUT, os.path.getsize(OUT), "bytes")

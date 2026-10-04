#!/usr/bin/env python3
"""Bulk generator for LARGE synthetic replays (1 GB, 4 GB, ...) with the real recorder schema.

The recorder (lua/main.lua) is frozen, so the schema and pragmas are copied from it. Shape comes from the real corpus
(docs/real-data-profile.md): ~72 bytes of file per agent_states row, ~188 agent rows per tick, ~307 spawns per battle,
~515 ticks per battle, ~1.4 s per tick (whole-second times, many equal consecutive times).

  --shape many   : N battles (one map/faction/score boundary each), agents die and never respawn
  --shape giant  : ONE battle for the whole file, agents respawn (worst case: a single huge battle)

Usage:  make_large_fixture.py --out FILE --target-bytes 1073741824 [--shape many|giant] [--verify]
--verify runs sql/default_boundary_detection.sql on the result and checks the battle count (many: == battles; giant: == 1).
Deterministic for a given --seed. Output is NOT meant to be committed.
"""
import argparse
import os
import pathlib
import random
import sqlite3
import sys
import time

ROW_BYTES = 72
ALIVE_FRACTION = 0.61
FLUSH = 100_000

DDL = """
CREATE TABLE ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER, observer_player_id INTEGER);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, tick_id INTEGER, event_type TEXT, event_order INTEGER, FOREIGN KEY(tick_id) REFERENCES ticks(id));
CREATE TABLE chats (event_id INTEGER, username TEXT, team TEXT, chat_type TEXT, message TEXT, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE map_switches (event_id INTEGER, scene_no INTEGER, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE score_switches (event_id INTEGER, team_0_score INTEGER, team_1_score INTEGER, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE faction_switches (event_id INTEGER, team_0_faction_id INTEGER, team_0_faction_name TEXT, team_1_faction_id INTEGER, team_1_faction_name TEXT, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE kills (event_id INTEGER, type TEXT, dead_id INTEGER, dead_name TEXT, dead_x REAL, dead_y REAL, dead_z REAL, killer_id INTEGER, killer_name TEXT, killer_x REAL, killer_y REAL, killer_z REAL, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE spawns (event_id INTEGER, agent_id INTEGER, agent_name TEXT, is_human INTEGER, pos_x REAL, pos_y REAL, pos_z REAL, team TEXT, group_id INTEGER, class_id INTEGER, division_id INTEGER, FOREIGN KEY(event_id) REFERENCES events(id));
CREATE TABLE agent_states (id INTEGER PRIMARY KEY AUTOINCREMENT, tick_id INTEGER, agent_id INTEGER, pos_x REAL, pos_y REAL, pos_z REAL, yaw REAL, pitch REAL, hp INTEGER, attack_action INTEGER, defend_action INTEGER, wielded_right INTEGER, wielded_left INTEGER, ammo INTEGER, horse_id INTEGER, rider_id INTEGER, FOREIGN KEY(tick_id) REFERENCES ticks(id));
"""

SQL = {
    "ticks": "INSERT INTO ticks VALUES (?,?,?)",
    "events": "INSERT INTO events VALUES (?,?,?,?)",
    "spawns": "INSERT INTO spawns VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "kills": "INSERT INTO kills VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    "chats": "INSERT INTO chats VALUES (?,?,?,?,?)",
    "map_switches": "INSERT INTO map_switches VALUES (?,?)",
    "score_switches": "INSERT INTO score_switches VALUES (?,?,?)",
    "faction_switches": "INSERT INTO faction_switches VALUES (?,?,?,?,?)",
    "agent_states": "INSERT INTO agent_states VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
}


class Writer:
    def __init__(self, con):
        self.con = con
        self.buf = {k: [] for k in SQL}
        self.tick_id = 0
        self.event_id = 0
        self.state_id = 0
        self.t = 1_700_000_000
        self.frac = 0.0
        self.rows = 0

    def flush(self, force=False):
        for k, b in self.buf.items():
            if b and (force or len(b) >= FLUSH):
                self.con.executemany(SQL[k], b)
                b.clear()

    def tick(self):
        self.tick_id += 1
        self.frac += 1.4  # ~1.4 s per tick, whole-second times
        self.t += int(self.frac)
        self.frac -= int(self.frac)
        self.buf["ticks"].append((self.tick_id, self.t, 0))
        return self.tick_id

    def event(self, tick_id, etype, order=0):
        self.event_id += 1
        self.buf["events"].append((self.event_id, tick_id, etype, order))
        return self.event_id


def simulate(w, rng, ticks, agents, respawn, battle_idx):
    """One battle: boundary tick (map+faction+score switch), spawns, 6 warm-up ticks, then `ticks` playing ticks."""
    bt = w.tick()
    e = w.event(bt, "map_switch")
    w.buf["map_switches"].append((e, 100 + battle_idx % 40))
    e = w.event(bt, "faction_switch")
    w.buf["faction_switches"].append((e, 1, f"FactionA{battle_idx % 9}", 2, f"FactionB{battle_idx % 7}"))
    e = w.event(bt, "score_switch")
    w.buf["score_switches"].append((e, 0, 0))

    alive = {}  # slot -> [x, y, team]
    def spawn(slot, tick_id):
        team = slot & 1
        x, y = rng.uniform(-300, 300), rng.uniform(-300, 300)
        ev = w.event(tick_id, "spawn")
        w.buf["spawns"].append((ev, slot, f"Agent{slot}", 1 if slot < agents * 0.4 else 0, x, y, 0.0, str(team), 0, 0, 0))
        alive[slot] = [x, y, team]
    for slot in range(agents):
        spawn(slot, bt)
    for _ in range(6):
        w.tick()

    # death schedule: ~39% of agents die over the battle (matches ALIVE_FRACTION ~0.61 average presence)
    death_rate = (1.0 - ALIVE_FRACTION) * 2.0 / max(1, ticks)
    chat_every = max(1, ticks // 7)
    for i in range(ticks):
        tid = w.tick()
        sid = w.state_id
        buf = w.buf["agent_states"]
        for slot, st in alive.items():
            st[0] += rng.random() * 2 - 1
            st[1] += rng.random() * 2 - 1
            sid += 1
            buf.append((sid, tid, slot, st[0], st[1], 0.0, (sid % 360) * 1.0, 0.0, 100, 0, 0, -1, -1, 0, -1, -1))
        w.state_id = sid
        w.rows += len(alive)
        # deaths (and respawns in giant mode)
        if alive and rng.random() < death_rate * len(alive) / max(1, agents):
            n_dead = max(1, int(len(alive) * death_rate))
            for dead in rng.sample(list(alive), min(n_dead, len(alive))):
                killer = next(iter(alive))
                ev = w.event(tid, "kill")
                d, k = alive.pop(dead), alive.get(killer, [0.0, 0.0, 0])
                w.buf["kills"].append((ev, "melee", dead, f"Agent{dead}", d[0], d[1], 0.0, killer, f"Agent{killer}", k[0], k[1], 0.0))
                if respawn:
                    spawn(dead, tid)
        if i % chat_every == 0:
            ev = w.event(tid, "chat")
            w.buf["chats"].append((ev, f"Player{i % 17}", str(i & 1), "team", f"gg {i}"))
        w.flush()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--target-bytes", type=int, required=True)
    ap.add_argument("--shape", choices=["many", "giant"], default="many")
    ap.add_argument("--agents", type=int, default=300)
    ap.add_argument("--ticks-per-battle", type=int, default=515)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--verify", action="store_true")
    a = ap.parse_args()

    rows_target = a.target_bytes // ROW_BYTES
    per_tick = max(1, int(a.agents * ALIVE_FRACTION))
    if a.shape == "many":
        battles = max(1, rows_target // (a.ticks_per_battle * per_tick))
        ticks_per = a.ticks_per_battle
    else:
        battles = 1
        ticks_per = max(a.ticks_per_battle, rows_target // per_tick)

    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    con = sqlite3.connect(out)
    # same pragmas as lua/main.lua lines 13-16, plus a big cache for generation speed
    con.executescript("PRAGMA page_size=4096; PRAGMA auto_vacuum=FULL; PRAGMA synchronous=OFF; PRAGMA journal_mode=MEMORY; PRAGMA cache_size=-262144;")
    con.executescript(DDL)
    rng = random.Random(a.seed)
    w = Writer(con)
    t0 = time.time()
    con.execute("BEGIN")
    for b in range(battles):
        simulate(w, rng, ticks_per, a.agents, a.shape == "giant", b)
        if b % 10 == 0 or b == battles - 1:
            print(f"battle {b + 1}/{battles}  agent_states={w.rows:,}  {time.time() - t0:.0f}s", file=sys.stderr, flush=True)
    w.flush(force=True)
    con.execute("COMMIT")
    con.close()
    size = out.stat().st_size
    print(f"wrote {out} {size:,} bytes ({size / a.target_bytes:.2f} of target), battles={battles}, agent_states={w.rows:,}, ticks={w.tick_id:,}, {time.time() - t0:.0f}s")

    if a.verify:
        sql = (pathlib.Path(__file__).resolve().parent.parent / "sql" / "default_boundary_detection.sql").read_text()
        c = sqlite3.connect(f"file:{out}?mode=ro", uri=True)
        t1 = time.time()
        found = len(c.execute(sql).fetchall())
        c.close()
        ok = found == battles
        print(f"verify: old boundary SQL finds {found} battles (expected {battles}) in {time.time() - t1:.2f}s -> {'OK' if ok else 'MISMATCH'}")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

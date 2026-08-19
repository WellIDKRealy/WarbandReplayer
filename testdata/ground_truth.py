#!/usr/bin/env python3
"""
Ground-truth generator for verifying replay_worker.c's output WITHOUT rendering
anything. Checks replay_worker.c's algorithms against independent SQL:
  - scan_matches() - map/score/faction-switch boundary detection + merge/min-
    length rules (see tick_index_for_id/scan_matches in replay_worker.c).
    Reimplemented in Python here, since that merge/threshold logic has no SQL
    equivalent in the C engine either (it's a C loop over a SQL query there
    too - see the comment on scan_matches in replay_worker.c).
  - roster/corpse replay - NOT reimplemented in Python anymore. Runs
    sql/canonical_roster_corpse.sql directly, the same canonical definition
    replay_worker.c compiles in (see scripts/gen_canonical_sql_header.py) and
    that exported battle.db files hash into _table_provenance. This used to
    be a hand-written Python fold that independently reimplemented
    apply_roster_delta()'s single-pass, event-id-ordered semantics - kept in
    sync by hand, which is exactly the kind of drift this convergence is
    meant to close. Switching to the canonical SQL surfaced and fixed one
    real, previously-invisible-to-this-suite divergence: the old Python fold
    defaulted a killed-but-never-spawned-in-window agent's corpse team to -1,
    while the C engine's actual default (RosterEntry.team, zeroed by
    memset() before any delta is applied - replay_worker.c's roster struct)
    is 0. corpseCount-only comparisons never caught this; per-corpse team
    values weren't checked. The canonical SQL matches the real C behavior.
  - fetch_positions() - plain tick_id lookup against agent_states (the C
    engine's rowid-bisection is purely a locality/performance optimization,
    not a correctness-changing filter, so a plain tick_id match is an
    equivalent, simpler ground truth).
  - chat gating - cumulative count of chats(tick_id) in [match start, sample
    tick], matching replay_get_new_chat_count()'s tick-gated delivery.

Samples are taken at EXACT tick timestamps (not interpolated wall-clock
times), so alpha is always 0 and positions need no interpolation to compare -
this isolates "is the underlying data/logic right" from "is the interpolation
math right" (a separate, much smaller concern).

Usage: python ground_truth.py <sqlite_path> [samples_per_match] [out.json]
"""
import sqlite3
import sys
import json
import pathlib

MAX_AGENT_SLOTS = 1025
MAX_MATCHES = 16

CANONICAL_ROSTER_CORPSE_SQL = (
    pathlib.Path(__file__).resolve().parent.parent
    / "sql" / "canonical_roster_corpse.sql"
).read_text(encoding="utf-8")


def load_ticks(conn):
    return conn.execute("SELECT id, time FROM ticks ORDER BY id ASC").fetchall()


def tick_index_for_id(ticks, tick_id):
    lo, hi = 0, len(ticks) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if ticks[mid][0] == tick_id:
            return mid
        if ticks[mid][0] < tick_id:
            lo = mid + 1
        else:
            hi = mid - 1
    return lo if lo < len(ticks) else len(ticks) - 1


def scan_matches(conn, ticks):
    rows = conn.execute(
        "SELECT DISTINCT e.tick_id FROM events e "
        "WHERE e.event_type IN ('map_switch','score_switch','faction_switch') "
        "ORDER BY e.tick_id ASC"
    ).fetchall()
    boundary_indices = [tick_index_for_id(ticks, r[0]) for r in rows[:256]]

    merged = []
    for idx in boundary_indices:
        if idx < 5:
            continue
        if not merged or idx - merged[-1] > 15:
            merged.append(idx)

    matches = []
    start_idx = 0
    for idx in merged:
        if len(matches) >= MAX_MATCHES - 1:
            break
        end_idx = idx
        if end_idx - start_idx >= 10:
            matches.append({
                'start_tick_id': ticks[start_idx][0], 'end_tick_id': ticks[end_idx][0],
                'start_time': ticks[start_idx][1], 'end_time': ticks[end_idx][1],
            })
            start_idx = end_idx + 1
    if len(ticks) - 1 - start_idx >= 5 and len(matches) < MAX_MATCHES:
        matches.append({
            'start_tick_id': ticks[start_idx][0], 'end_tick_id': ticks[-1][0],
            'start_time': ticks[start_idx][1], 'end_time': ticks[-1][1],
        })
    return matches


def replay_roster_and_corpses(conn, from_tick, to_tick):
    """Runs sql/canonical_roster_corpse.sql - the same canonical definition
    replay_worker.c compiles in (see scripts/gen_canonical_sql_header.py) -
    and reshapes its two JSON columns into the (roster dict, corpses list)
    shape the rest of this file expects. See that .sql file's header comment
    for the exact semantics (event-id-ordered fold, spawn overwrites, corpse
    team = roster's current value for that agent_id at kill time, defaulting
    to 0 - not -1 - for an agent never spawned within [from_tick, to_tick])."""
    row = conn.execute(
        CANONICAL_ROSTER_CORPSE_SQL,
        {"from_tick": from_tick, "to_tick": to_tick}
    ).fetchone()
    roster_json, corpses_json = row
    raw_roster = json.loads(roster_json)
    corpses = json.loads(corpses_json)

    roster = {}
    for agent_id_str, r in raw_roster.items():
        agent_id = int(agent_id_str)
        if agent_id < 0 or agent_id >= MAX_AGENT_SLOTS:
            continue
        roster[agent_id] = {
            'active': bool(r['active']), 'is_human': bool(r['is_human']),
            'team': r['team'], 'spawn_event_id': r['spawn_event_id'],
        }
    return roster, corpses


def fetch_positions(conn, tick_id):
    rows = conn.execute(
        "SELECT agent_id, pos_x, pos_y FROM agent_states WHERE tick_id = ?", (tick_id,)
    ).fetchall()
    return {r[0]: (r[1], r[2]) for r in rows}


def ground_truth_for_sample(conn, match, match_idx, tick_id):
    from_tick = match['start_tick_id'] - 2
    roster, corpses = replay_roster_and_corpses(conn, from_tick, tick_id)
    positions = fetch_positions(conn, tick_id)

    agents = []
    for agent_id, r in roster.items():
        if not r['active'] or not r['is_human']:
            continue
        if agent_id not in positions:
            continue
        x, y = positions[agent_id]
        agents.append({'agent_id': agent_id, 'x': x, 'y': y, 'team': r['team']})
    agents.sort(key=lambda a: a['agent_id'])

    chat_hi = min(tick_id, match['end_tick_id'])
    chat_count = conn.execute(
        "SELECT COUNT(*) FROM chats c JOIN events e ON c.event_id = e.id "
        "WHERE e.tick_id >= ? AND e.tick_id <= ?",
        (match['start_tick_id'], chat_hi)).fetchone()[0]

    return {
        'matchIdx': match_idx, 'tick_id': tick_id, 'time': None,  # filled by caller
        'agentCount': len(agents), 'agents': agents,
        'corpseCount': len(corpses),
        'chatCount': chat_count,
    }


def main():
    if len(sys.argv) < 2:
        print("usage: ground_truth.py <sqlite_path> [samples_per_match] [out.json]")
        sys.exit(1)
    path = sys.argv[1]
    samples_per_match = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    out_path = sys.argv[3] if len(sys.argv) > 3 else 'ground_truth.json'

    conn = sqlite3.connect(path)
    ticks = load_ticks(conn)
    matches = scan_matches(conn, ticks)

    samples = []
    for mi, m in enumerate(matches):
        lo_idx = tick_index_for_id(ticks, m['start_tick_id'])
        hi_idx = tick_index_for_id(ticks, m['end_tick_id'])
        span = hi_idx - lo_idx
        if span < 2:
            continue
        # stay clear of the exact edges - boundary ticks can be sparse/empty
        # transition frames (confirmed separately, not what this checks).
        clear = max(1, span // 20)
        lo_s, hi_s = lo_idx + clear, hi_idx - clear
        if hi_s <= lo_s:
            lo_s, hi_s = lo_idx, hi_idx
        seen = set()
        for k in range(samples_per_match):
            idx = lo_s + round((hi_s - lo_s) * k / max(1, samples_per_match - 1))
            if idx in seen:
                continue
            seen.add(idx)
            tick_id, t = ticks[idx]
            s = ground_truth_for_sample(conn, m, mi, tick_id)
            s['time'] = t
            samples.append(s)

    result = {
        'file': path,
        'matchCount': len(matches),
        'matches': matches,
        'samples': samples,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=1)
    total_agents = sum(s['agentCount'] for s in samples)
    total_corpses = sum(s['corpseCount'] for s in samples)
    print(f"wrote {out_path}: {len(matches)} matches, {len(samples)} samples, "
          f"sum(agentCount)={total_agents} sum(corpseCount)={total_corpses}")


if __name__ == '__main__':
    main()

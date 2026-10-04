#!/usr/bin/env python3
"""Generate synthetic differential-test cases for boundary_segmentation.

For every case an in-memory SQLite DB with a `ticks` table and an `events` table is built (events of
type map_switch / score_switch / faction_switch at chosen ticks, plus decoy events of other types),
and the REAL sql/default_boundary_detection.sql is executed through Python's sqlite3.  The expected
spans are what that SQL returns, converted from tick ids back to tick indexes.

Only integers are written (N, boundary indexes, expected span indexes) - no replay data.

Output format (identical to boundary_cases.txt):
    CASE <name>
    N <ticks>
    B <boundary idx ...>          (strictly increasing; may be empty)
    E <start end start end ...>   (expected spans; may be empty)

Usage:
    gen_cases.py                  write synthetic_cases.txt (deterministic, seed fixed)
    gen_cases.py --check FILE     re-run the real SQL on the cases of FILE (first --limit cases) and
                                  verify its E lines (guards against the oracle going stale)
"""
import os
import random
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SQL_PATH = os.path.join(HERE, "..", "..", "..", "..", "sql", "default_boundary_detection.sql")
SQL = open(SQL_PATH, encoding="utf-8").read()
BOUNDARY_TYPES = ("map_switch", "score_switch", "faction_switch")
DECOY_TYPES = ("chat", "spawn", "kill", "other_switch")


def run_sql(n_ticks, tick_ids, boundary_events):
    """tick_ids: ascending list of tick ids (len == n_ticks).  boundary_events: list of
    (tick_id, event_type).  Returns list of (start_idx, end_idx) as computed by the real SQL."""
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE ticks (id INTEGER PRIMARY KEY, time REAL)")
    conn.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, tick_id INTEGER, event_type TEXT)")
    conn.executemany("INSERT INTO ticks VALUES (?, ?)", [(t, t * 0.01) for t in tick_ids])
    conn.executemany("INSERT INTO events (tick_id, event_type) VALUES (?, ?)", boundary_events)
    rows = conn.execute(SQL).fetchall()
    conn.close()
    pos = {t: i for i, t in enumerate(tick_ids)}
    # rows: (start_tick_id, end_tick_id, start_time, end_time, is_battle)
    out = []
    for r in rows:
        assert r[4] == 1
        out.append((pos[r[0]], pos[r[1]]))
    return out


def gen_boundaries(rng, n, style):
    """Return a sorted list of distinct boundary indexes in [0, n)."""
    if n == 0:
        return []
    if style == "empty":
        return []
    if style == "sparse":
        k = rng.randint(0, max(1, n // 40))
    elif style == "medium":
        k = rng.randint(0, max(1, n // 12))
    elif style == "dense":
        k = rng.randint(0, n)
    elif style == "clustered":
        # clusters of nearby boundaries exercise the 15-window merge and the >=10 span rule
        s = set()
        for _ in range(rng.randint(1, max(2, n // 25))):
            c = rng.randrange(n)
            for _ in range(rng.randint(1, 6)):
                v = c + rng.randint(-20, 20)
                if 0 <= v < n:
                    s.add(v)
        return sorted(s)
    elif style == "edge":
        # hammer the exact thresholds 4/5, 15/16, 9/10, 5/6 around a few anchors
        s = set()
        a = rng.randint(0, 8)
        s.add(a)
        cur = a
        for _ in range(rng.randint(2, 12)):
            cur += rng.choice([1, 4, 5, 9, 10, 11, 14, 15, 16, 17, 25, 26, 27])
            if cur < n:
                s.add(cur)
        if rng.random() < 0.5 and n > 0:
            s.add(n - 1)
        if rng.random() < 0.3 and n > 6:
            s.add(n - 1 - rng.choice([4, 5, 6, 10, 15, 16]))
        return sorted(v for v in s if 0 <= v < n)
    else:
        raise ValueError(style)
    k = min(k, n)
    return sorted(rng.sample(range(n), k))


def make_case(rng, idx):
    style = rng.choice(["empty", "sparse", "medium", "dense", "clustered", "clustered", "edge", "edge", "edge"])
    nsel = rng.random()
    if nsel < 0.15:
        n = rng.randint(0, 30)
    elif nsel < 0.6:
        n = rng.randint(0, 150)
    elif nsel < 0.95:
        n = rng.randint(100, 700)
    else:
        n = rng.randint(700, 3000)
    bs = gen_boundaries(rng, n, style)
    # tick ids: ascending, with gaps (ids are not equal to idx, as in real replays)
    tick_ids = []
    t = rng.randint(1, 1000)
    for _ in range(n):
        tick_ids.append(t)
        t += rng.choice([1, 1, 1, 2, 3, 7])
    events = []
    for b in bs:
        # one boundary tick may carry several boundary events (DISTINCT must collapse them)
        for _ in range(rng.choice([1, 1, 1, 2, 3])):
            events.append((tick_ids[b], rng.choice(BOUNDARY_TYPES)))
    for _ in range(rng.randint(0, max(1, n // 5))):
        if n:
            events.append((rng.choice(tick_ids), rng.choice(DECOY_TYPES)))
    rng.shuffle(events)
    expected = run_sql(n, tick_ids, events)
    return "synth_%05d_%s" % (idx, style), n, bs, expected


def fmt(name, n, bs, expected):
    flat = [str(v) for pair in expected for v in pair]
    return "CASE %s\nN %d\nB %s\nE %s\n" % (name, n, " ".join(map(str, bs)), " ".join(flat))


def parse(path):
    cases, cur = [], None
    for line in open(path, encoding="utf-8"):
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "CASE":
            cur = {"name": parts[1]}
            cases.append(cur)
        elif parts[0] == "N":
            cur["n"] = int(parts[1])
        elif parts[0] == "B":
            cur["b"] = list(map(int, parts[1:]))
        elif parts[0] == "E":
            e = list(map(int, parts[1:]))
            cur["e"] = list(zip(e[::2], e[1::2]))
    return cases


def check(path, limit):
    cases = parse(path)[:limit]
    bad = 0
    for c in cases:
        n = c["n"]
        tick_ids = [i * 2 + 100 for i in range(n)]  # arbitrary ascending ids
        events = [(tick_ids[b], "map_switch") for b in c["b"]]
        got = run_sql(n, tick_ids, events)
        if got != c["e"]:
            bad += 1
            print("STALE ORACLE:", c["name"])
    print("checked %d cases against the real SQL, %d mismatches" % (len(cases), bad))
    return 1 if bad else 0


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--check":
        limit = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 10**9
        sys.exit(check(sys.argv[2], limit))
    rng = random.Random(20260804)
    count = 2400
    out = os.path.join(HERE, "synthetic_cases.txt")
    with open(out, "w", encoding="utf-8") as f:
        for i in range(count):
            f.write(fmt(*make_case(rng, i)))
    print("wrote %d cases to %s" % (count, out))


if __name__ == "__main__":
    main()

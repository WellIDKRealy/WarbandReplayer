#!/usr/bin/env python3
"""Times the NEW per-battle pipeline (docs/PLAN.md) natively on a real replay, battle by battle:

  bisect   find the battle's agent_states rowid range by bisection on the primary key (no scan)
  extract  create R_k: copy that battle's rows of every table into its own SQLite file
  index    CREATE INDEX on R_k.agent_states(tick_id) and compute the map bounds (MIN/MAX)
  derive   create B_k: roster_history + corpses from sql/canonical_roster_history.sql / canonical_corpses.sql

Native SQLite is a lower bound for the wasm build; this validates the speed budgets (open an unopened battle <= 1.5 s,
extract-all) and the thread-pool justification (docs/justifications.md J3) before any wasm exists.
Usage: measure_extraction.py SOURCE.sqlite [--battles N] [--json out.json] [--keep DIR]
Boundaries come from the OLD engine's own SQL (sql/default_boundary_detection.sql), uncapped.
"""
import argparse
import json
import pathlib
import sqlite3
import statistics
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOUNDARY_SQL = (ROOT / "sql" / "default_boundary_detection.sql").read_text()
HISTORY_SQL = (ROOT / "sql" / "canonical_roster_history.sql").read_text()
CORPSES_SQL = (ROOT / "sql" / "canonical_corpses.sql").read_text()

# (table, filter on the source table s.<table> for a tick range [:a, :b])
CHILD = ["chats", "map_switches", "score_switches", "faction_switches", "kills", "spawns"]


def bisect_rowid(c, lo_id, hi_id, tick, upper):
    """smallest rowid with tick_id >= tick (upper=False) or > tick (upper=True), hi_id+1 if none."""
    lo, hi = lo_id, hi_id + 1
    while lo < hi:
        mid = (lo + hi) // 2
        row = c.execute("SELECT tick_id FROM agent_states WHERE id >= ? ORDER BY id LIMIT 1", (mid,)).fetchone()
        if row is None:
            hi = mid
            continue
        t = row[0]
        if (t > tick) if upper else (t >= tick):
            hi = mid
        else:
            lo = mid + 1
    return lo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--battles", type=int, default=0, help="only the first N battles (0 = all)")
    ap.add_argument("--json")
    ap.add_argument("--keep")
    a = ap.parse_args()

    src = pathlib.Path(a.source).resolve()
    work = pathlib.Path(a.keep) if a.keep else pathlib.Path(tempfile.mkdtemp(prefix="measure_extraction_"))
    work.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    ddl = [r[0] for r in c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]

    t = time.time()
    spans = c.execute(BOUNDARY_SQL).fetchall()
    t_boundary = time.time() - t
    if a.battles:
        spans = spans[: a.battles]
    id_lo, id_hi = c.execute("SELECT MIN(id), MAX(id) FROM agent_states").fetchone()
    print(f"{src.name}: {len(spans)} battles, boundary detection {t_boundary:.2f}s, agent_states ids {id_lo}..{id_hi}")

    rows_out = []
    for k, (st, et, _, _, _) in enumerate(spans):
        rec = {"battle": k, "start_tick": st, "end_tick": et}
        t0 = time.time()
        lo = bisect_rowid(c, id_lo, id_hi, st, upper=False)
        hi = bisect_rowid(c, id_lo, id_hi, et, upper=True) - 1
        rec["bisect_s"] = time.time() - t0
        rec["rows"] = max(0, hi - lo + 1)

        rpath = work / f"R_{k}.sqlite"
        bpath = work / f"B_{k}.sqlite"
        for p in (rpath, bpath):
            if p.exists():
                p.unlink()
        t0 = time.time()
        r = sqlite3.connect(rpath)
        r.executescript("PRAGMA page_size=4096; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;")
        for d in ddl:
            r.execute(d)
        r.execute("ATTACH DATABASE ? AS s", (f"file:{src}?mode=ro",)) if False else r.execute(f"ATTACH DATABASE 'file:{src}?mode=ro' AS s")
        r.execute("BEGIN")
        r.execute("INSERT INTO ticks SELECT * FROM s.ticks WHERE id BETWEEN ? AND ?", (st, et))
        r.execute("INSERT INTO events SELECT * FROM s.events WHERE tick_id BETWEEN ? AND ?", (st, et))
        for tbl in CHILD:
            r.execute(f"INSERT INTO {tbl} SELECT * FROM s.{tbl} WHERE event_id IN (SELECT id FROM events)")
        r.execute("INSERT INTO agent_states SELECT * FROM s.agent_states WHERE id BETWEEN ? AND ?", (lo, hi))
        r.execute("COMMIT")
        r.execute("DETACH DATABASE s")
        rec["extract_s"] = time.time() - t0

        t0 = time.time()
        r.execute("CREATE INDEX idx_as_tick ON agent_states(tick_id)")
        bounds = r.execute("SELECT MIN(pos_x), MAX(pos_x), MIN(pos_y), MAX(pos_y) FROM agent_states").fetchone()
        rec["index_bounds_s"] = time.time() - t0

        t0 = time.time()
        b = sqlite3.connect(bpath)
        b.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;")
        b.execute("CREATE TABLE roster_history (agent_id INTEGER, team INTEGER, is_human INTEGER, spawn_event_id INTEGER, valid_from_tick INTEGER, valid_to_tick INTEGER)")
        b.execute("CREATE TABLE corpses (x REAL, y REAL, team INTEGER, tick_id INTEGER)")
        params = {"from_tick": st - 2, "to_tick": et}
        b.executemany("INSERT INTO roster_history VALUES (?,?,?,?,?,?)", r.execute(HISTORY_SQL, params).fetchall())
        b.executemany("INSERT INTO corpses VALUES (?,?,?,?)", r.execute(CORPSES_SQL, params).fetchall())
        b.commit()
        rec["derive_s"] = time.time() - t0
        rec["open_total_s"] = rec["bisect_s"] + rec["extract_s"] + rec["index_bounds_s"] + rec["derive_s"]
        rec["r_bytes"] = rpath.stat().st_size
        rec["b_bytes"] = bpath.stat().st_size
        r.close()
        b.close()
        if not a.keep:
            rpath.unlink()
            bpath.unlink()
        rows_out.append(rec)
        if k % 10 == 0 or k == len(spans) - 1:
            print(f"  battle {k + 1}/{len(spans)} rows={rec['rows']:,} open_total={rec['open_total_s']:.2f}s", flush=True)

    if not rows_out:
        print(json.dumps({"file": src.name, "bytes": src.stat().st_size, "battles": 0, "boundary_detection_s": round(t_boundary, 2),
                          "note": "no battles detected (empty or too-short recording)"}, indent=2))
        return
    totals = [x["open_total_s"] for x in rows_out]
    summary = {
        "file": src.name, "bytes": src.stat().st_size, "battles": len(rows_out), "boundary_detection_s": round(t_boundary, 2),
        "open_battle_s": {"median": round(statistics.median(totals), 3), "p95": round(sorted(totals)[int(0.95 * (len(totals) - 1))], 3), "max": round(max(totals), 3)},
        "extract_all_single_thread_s": round(sum(totals), 1),
        "largest_battle_rows": max(x["rows"] for x in rows_out),
        "r_bytes_total": sum(x["r_bytes"] for x in rows_out), "b_bytes_total": sum(x["b_bytes"] for x in rows_out),
    }
    print(json.dumps(summary, indent=2))
    if a.json:
        pathlib.Path(a.json).write_text(json.dumps({"summary": summary, "battles": rows_out}, indent=2))


if __name__ == "__main__":
    main()

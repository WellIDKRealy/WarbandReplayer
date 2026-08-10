/*
 * Owns everything DB-related for the replay viewer: the load pipeline,
 * all SQL, the incremental roster/cursor algorithm, match segmentation,
 * chat cache, and the interpolated frame buffer. Never runs on the main
 * thread - only inside Web Workers, instantiated from replay_worker.wasm.
 *
 * JS is a thin stub: it hands raw file bytes to replay_feed_chunk, calls
 * replay_finish_load once, then drives playback via replay_advance_to_time/
 * replay_seek_to_time + reads the resulting frame/match/chat buffers
 * through the getters below. No SQL or tick bookkeeping happens in JS.
 */
#include "sqlite3.h"
#include "wasm_thread.h"
#include "wasm_layout.h"
#include <stdatomic.h>
#include <string.h>
#include <stdlib.h>

extern void heap_thread_init(int thread_id);
extern const sqlite3_mutex_methods *wasm_mutex_methods_get(void);
extern void js_log_string(const char *msg);

/* ---- constants -------------------------------------------------------- */
#define MAX_AGENT_SLOTS    1025  /* lua/main.lua: for agent = 0, 1024 do - a real engine limit on simultaneous living units */
#define MAX_MATCHES        16    /* up to 15 real battles per file, +1 headroom */
#define LOAD_CHUNK_SIZE    (1024 * 1024)
#define MAX_CHAT_ENTRIES   4096

static char g_last_error[256];
static void set_error(const char *msg) {
    int i = 0;
    if (msg) while (msg[i] && i < 255) { g_last_error[i] = msg[i]; i++; }
    g_last_error[i] = 0;
}
const char *replay_get_last_error(void) { return g_last_error; }

/* ---- load pipeline ------------------------------------------------------ */
static unsigned char g_load_chunk[LOAD_CHUNK_SIZE];
static sqlite3_vfs *g_vfs = 0;
static sqlite3_file *g_load_file = 0;
static sqlite3_int64 g_load_write_offset = 0;
static sqlite3 *g_db = 0;

int replay_begin_load(void) {
    g_vfs = sqlite3_vfs_find(0);
    if (!g_vfs) { set_error("no default vfs registered"); return -1; }
    g_load_file = (sqlite3_file *)sqlite3_malloc(g_vfs->szOsFile);
    if (!g_load_file) { set_error("out of memory allocating file handle"); return -2; }
    int outFlags = 0;
    int rc = g_vfs->xOpen(g_vfs, "main.db", g_load_file,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_MAIN_DB, &outFlags);
    if (rc != SQLITE_OK) { set_error("vfs xOpen failed for main.db"); return rc; }
    g_load_write_offset = 0;
    return 0;
}

unsigned char *replay_get_load_chunk_ptr(void) { return g_load_chunk; }

int replay_feed_chunk(int len) {
    if (!g_load_file) { set_error("replay_feed_chunk called before replay_begin_load"); return -1; }
    int rc = g_load_file->pMethods->xWrite(g_load_file, g_load_chunk, len, g_load_write_offset);
    if (rc != SQLITE_OK) { set_error("vfs xWrite failed (file exceeds Region A capacity?)"); return rc; }
    g_load_write_offset += len;
    return 0;
}

/* ---- tick index (loaded once at finish_load, binary-searched during playback) */
/* Time fields are `double`, not `float`: this project's tick.time values are
 * Unix timestamps (~1.7e9) - a 32-bit float only has ~7 significant decimal
 * digits, so distinct timestamps even tens of seconds apart silently
 * collapse to the same float value (confirmed empirically: 1700000000,
 * 1700000007, and 1700000020 all round to the identical float32). Position
 * values (small, roughly -100..100) stay float - only TIME needs double. */
typedef struct TickEntry { sqlite3_int64 id; double time; } TickEntry;
static TickEntry *g_ticks = 0;
static int g_tick_count = 0;

/* ---- match summaries ---------------------------------------------------- */
typedef struct MatchInfo {
    sqlite3_int64 start_tick_id, end_tick_id;
    double start_time, end_time;
    int scene_no;
    char faction_text[96];
    sqlite3_int64 rowid_lo, rowid_hi; /* this battle's own slice of agent_states, see replay_ensure_battle_ready */
} MatchInfo;
static MatchInfo g_matches[MAX_MATCHES];
static int g_match_count = 0;
static unsigned char g_battle_ready[MAX_MATCHES]; /* has this battle's agent_states rowid slice been resolved? */

int replay_get_match_count(void) { return g_match_count; }
double replay_get_match_start_time(int idx) { return (idx >= 0 && idx < g_match_count) ? g_matches[idx].start_time : 0.0; }
double replay_get_match_end_time(int idx) { return (idx >= 0 && idx < g_match_count) ? g_matches[idx].end_time : 0.0; }
int replay_get_match_scene_no(int idx) { return (idx >= 0 && idx < g_match_count) ? g_matches[idx].scene_no : 0; }
const char *replay_get_match_faction_ptr(int idx) {
    static const char empty[1] = "";
    return (idx >= 0 && idx < g_match_count) ? g_matches[idx].faction_text : empty;
}
double replay_get_total_start_time(void) { return g_tick_count > 0 ? g_ticks[0].time : 0.0; }
double replay_get_total_end_time(void) { return g_tick_count > 0 ? g_ticks[g_tick_count - 1].time : 0.0; }
/* raw tick_id bounds, for JS to hand to replay_prefetch_battle() - as double,
 * not sqlite3_int64: well within float64's exact-integer range for this
 * data (a few hundred thousand ticks at most), and avoids the wasm i64
 * JS/BigInt marshalling this codebase doesn't use anywhere else. */
double replay_get_match_start_tick_id(int idx) { return (idx >= 0 && idx < g_match_count) ? (double)g_matches[idx].start_tick_id : 0.0; }
double replay_get_match_end_tick_id(int idx) { return (idx >= 0 && idx < g_match_count) ? (double)g_matches[idx].end_tick_id : 0.0; }

/* ---- roster / incremental cursor ----------------------------------------- */
typedef struct RosterEntry {
    unsigned char active;
    unsigned char is_human;
    signed char team; /* 0, 1, or -1 (spectator/other) */
    sqlite3_int64 spawn_event_id;
} RosterEntry;
static RosterEntry g_roster[MAX_AGENT_SLOTS];
static sqlite3_int64 g_roster_synced_tick_id = -1;
static int g_active_match_index = -1;

/* Every kill within the current battle gets its own permanent corpse entry -
 * NOT indexed by agent_id (a reused engine slot: the same slot dies and
 * respawns many times over a battle, so a fixed g_corpses[agent_id] array
 * could only ever remember the *most recent* death per slot, silently
 * overwriting earlier ones). This is a growable list instead: every kill
 * appends, capacity doubles on demand, no ceiling on how many corpses one
 * battle can accumulate. Reset (not just at match boundaries but any time
 * resync_roster_to() does a full resync, e.g. a backward seek) and rebuilt
 * by replaying that match's kill events from its own start - see
 * resync_roster_to() and apply_roster_delta(). */
typedef struct CorpseEntry { float x, y; signed char team; } CorpseEntry;
static CorpseEntry *g_corpses = 0;
static int g_corpse_count = 0;
static int g_corpse_capacity = 0;

static void corpse_list_reset(void) { g_corpse_count = 0; }
static void corpse_list_add(float x, float y, signed char team) {
    if (g_corpse_count >= g_corpse_capacity) {
        int new_cap = g_corpse_capacity ? g_corpse_capacity * 2 : 256;
        CorpseEntry *nc = (CorpseEntry *)realloc(g_corpses, sizeof(CorpseEntry) * (size_t)new_cap);
        if (!nc) return; /* OOM: drop this corpse rather than crash, everything else keeps working */
        g_corpses = nc;
        g_corpse_capacity = new_cap;
    }
    g_corpses[g_corpse_count].x = x;
    g_corpses[g_corpse_count].y = y;
    g_corpses[g_corpse_count].team = team;
    g_corpse_count++;
}

/* prepared once in replay_finish_load, reused for the life of the session */
static sqlite3_stmt *g_stmt_roster_delta = 0; /* spawn+kill events in (tick_lo, tick_hi] */
static sqlite3_stmt *g_stmt_id_lookup = 0; /* tick_id of first agent_states row with id >= ?1 */

static signed char parse_team(const unsigned char *teamText) {
    if (!teamText) return -1;
    if (teamText[0] == '0' && teamText[1] == 0) return 0;
    if (teamText[0] == '1' && teamText[1] == 0) return 1;
    return -1;
}

static int find_match_for_tick(sqlite3_int64 tick_id) {
    for (int i = 0; i < g_match_count; i++) {
        if (tick_id >= g_matches[i].start_tick_id && tick_id <= g_matches[i].end_tick_id) return i;
    }
    return -1;
}

static int run_sql(const char *sql); /* defined below, near replay_finish_load */

static void append_i64(char *buf, int *pos, sqlite3_int64 v) {
    char tmp[24]; int n = 0;
    if (v < 0) { buf[(*pos)++] = '-'; v = -v; }
    if (v == 0) tmp[n++] = '0';
    while (v > 0) { tmp[n++] = '0' + (int)(v % 10); v /= 10; }
    while (n > 0) buf[(*pos)++] = tmp[--n];
}

/* agent_states has no upfront/global secondary index (see replay_finish_load)
 * - a CREATE INDEX, even a partial one filtered `WHERE tick_id BETWEEN lo AND
 * hi`, still requires a full base-table scan to evaluate the WHERE clause for
 * every row (tick_id has no index to seek through), so N per-battle "partial
 * by tick" indexes would cost N full scans, not one - worse than a single
 * upfront index, not better (measured: this was the first approach tried
 * here and it regressed real-file latency badly).
 *
 * Instead, each battle is pre-split into its own disjoint [rowid_lo,
 * rowid_hi] slice of agent_states via binary search over the table's own
 * built-in rowid B-tree (agent_states.id is INTEGER PRIMARY KEY AUTOINCREMENT,
 * i.e. IS the rowid, and rows are appended in tick order by the recorder, so
 * rowid is monotonic with tick_id - a precondition this bisection relies on).
 * Each probe is a `WHERE id >= ?` seek: O(log n) B-tree descent, never a
 * scan - ~2*log2(2.3M) =~ 44 point seeks total for one battle. Battle 10's
 * rows are never visited while resolving battle 5's range.
 *
 * Unlike tick_id, rowid IS always seekable (it's the table's own clustering
 * key), so `CREATE INDEX ... WHERE id BETWEEN lo AND hi` compiles to a
 * *bounded* scan of just that battle's rowid range, not a full-table one -
 * this is what actually makes the per-battle index cheap to build. The
 * matching query then binds the SAME literal [lo, hi] (not a parameter -
 * SQLite can only prove a partial index applies when the query's WHERE term
 * is exactly the index's WHERE term) so it can use that index for O(log n)
 * tick_id lookups within the battle, rather than a linear scan of the whole
 * rowid range per frame.
 *
 * Self-healing: fetch_positions() calls this itself before every query, so
 * correctness never depends on JS remembering to prefetch - prefetching
 * (replay_prefetch_battle() below, driven by replay-worker.js requesting
 * nearby battles ahead of the cursor, YouTube-buffering-style) only affects
 * *latency*, never correctness.
 *
 * The bisection/SQL-building helpers below take an explicit (sqlite3 *,
 * sqlite3_stmt *) rather than reaching for g_db/g_stmt_id_lookup, so the
 * SAME algorithm runs correctly from two different threads' two different
 * connections: replay_ensure_battle_ready() below (the single playback
 * thread's connection, g_db) and replay_prefetch_battle() further down (a
 * dedicated prefetch thread's OWN connection, opened fresh - never g_db,
 * which belongs exclusively to the playback thread and is not thread-safe
 * to share even under SQLITE_THREADSAFE=1, same reason readers each open
 * their own connection for bounds computation above).
 */
static int agent_states_rowid_span_on(sqlite3 *db, sqlite3_int64 *out_min, sqlite3_int64 *out_max) {
    sqlite3_stmt *stmt = 0;
    int ok = 0;
    if (sqlite3_prepare_v2(db, "SELECT MIN(id), MAX(id) FROM agent_states", -1, &stmt, 0) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_type(stmt, 0) != SQLITE_NULL) {
            *out_min = sqlite3_column_int64(stmt, 0);
            *out_max = sqlite3_column_int64(stmt, 1);
            ok = 1;
        }
        sqlite3_finalize(stmt);
    }
    return ok;
}

/* tick_id of the first agent_states row with id >= probe (rowid seek, O(log n)) */
static sqlite3_int64 tick_id_at_or_after_rowid_on(sqlite3_stmt *idlookup, sqlite3_int64 probe) {
    sqlite3_reset(idlookup);
    sqlite3_bind_int64(idlookup, 1, probe);
    if (sqlite3_step(idlookup) == SQLITE_ROW) return sqlite3_column_int64(idlookup, 0);
    return -1; /* probe is past the last row */
}

/* smallest rowid whose tick_id >= target_tick (rmax+1 if none) */
static sqlite3_int64 lower_bound_rowid_on(sqlite3_stmt *idlookup, sqlite3_int64 rmin, sqlite3_int64 rmax, sqlite3_int64 target_tick) {
    sqlite3_int64 lo = rmin, hi = rmax + 1;
    while (lo < hi) {
        sqlite3_int64 mid = lo + (hi - lo) / 2;
        sqlite3_int64 t = tick_id_at_or_after_rowid_on(idlookup, mid);
        if (t != -1 && t >= target_tick) hi = mid; else lo = mid + 1;
    }
    return lo;
}

/* smallest rowid whose tick_id > target_tick (rmax+1 if none) */
static sqlite3_int64 upper_bound_rowid_on(sqlite3_stmt *idlookup, sqlite3_int64 rmin, sqlite3_int64 rmax, sqlite3_int64 target_tick) {
    sqlite3_int64 lo = rmin, hi = rmax + 1;
    while (lo < hi) {
        sqlite3_int64 mid = lo + (hi - lo) / 2;
        sqlite3_int64 t = tick_id_at_or_after_rowid_on(idlookup, mid);
        if (t != -1 && t > target_tick) hi = mid; else lo = mid + 1;
    }
    return lo;
}

/* both callers need the exact same CREATE INDEX text (literal [lo,hi], not
 * bound params - see the block comment above) so the SELECT built with the
 * same literals is provably eligible to use it, whichever thread built it. */
static void build_battle_index_sql(char *sql, int matchIdx, sqlite3_int64 rowid_lo, sqlite3_int64 rowid_hi) {
    int p = 0;
    const char *idx_prefix = "CREATE INDEX IF NOT EXISTS idx_as_b";
    for (const char *c = idx_prefix; *c; c++) sql[p++] = *c;
    append_i64(sql, &p, matchIdx);
    const char *idx_mid = " ON agent_states(tick_id) WHERE id BETWEEN ";
    for (const char *c = idx_mid; *c; c++) sql[p++] = *c;
    append_i64(sql, &p, rowid_lo);
    const char *and_ = " AND ";
    for (const char *c = and_; *c; c++) sql[p++] = *c;
    append_i64(sql, &p, rowid_hi);
    sql[p] = 0;
}

static sqlite3_int64 g_as_rowid_min = -1, g_as_rowid_max = -1;
static sqlite3_stmt *g_stmt_agent_states_battle[MAX_MATCHES]; /* one per battle, prepared lazily against its own partial index */
/* has this battle's [rowid_lo, rowid_hi] been resolved yet - by g_db itself
 * (self-healing fallback) or by the read-only prefetch worker writing
 * directly into g_matches[] (see replay_prefetch_battle) - separate from
 * g_battle_ready, which additionally requires the index to exist and the
 * per-battle statement to be prepared, both g_db-only operations. */
static unsigned char g_bounds_known[MAX_MATCHES];

int replay_ensure_battle_ready(int matchIdx) {
    if (matchIdx < 0 || matchIdx >= g_match_count) return 0;
    if (g_battle_ready[matchIdx]) return 0;

    MatchInfo *m = &g_matches[matchIdx];
    if (!g_bounds_known[matchIdx]) {
        /* self-healing fallback: nobody prefetched this battle, resolve its
         * rowid slice ourselves (same bisection the prefetch worker would
         * have done, just on g_db - the only path when prefetch never ran). */
        if (g_as_rowid_min < 0) agent_states_rowid_span_on(g_db, &g_as_rowid_min, &g_as_rowid_max);
        m->rowid_lo = lower_bound_rowid_on(g_stmt_id_lookup, g_as_rowid_min, g_as_rowid_max, m->start_tick_id);
        sqlite3_int64 hi = upper_bound_rowid_on(g_stmt_id_lookup, g_as_rowid_min, g_as_rowid_max, m->end_tick_id) - 1;
        m->rowid_hi = (hi >= m->rowid_lo) ? hi : m->rowid_lo - 1; /* empty slice guard */
        g_bounds_known[matchIdx] = 1;
    }

    char sql[224];
    build_battle_index_sql(sql, matchIdx, m->rowid_lo, m->rowid_hi);
    if (run_sql(sql) != SQLITE_OK) return -1; /* CREATE INDEX IF NOT EXISTS - cheap no-op if replay_prefetch_battle() already built this one */

    char qsql[224];
    int p = 0;
    const char *q_prefix = "SELECT agent_id, pos_x, pos_y FROM agent_states WHERE id BETWEEN ";
    for (const char *c = q_prefix; *c; c++) qsql[p++] = *c;
    append_i64(qsql, &p, m->rowid_lo);
    const char *and_ = " AND ";
    for (const char *c = and_; *c; c++) qsql[p++] = *c;
    append_i64(qsql, &p, m->rowid_hi);
    const char *q_tail = " AND tick_id = ?1";
    for (const char *c = q_tail; *c; c++) qsql[p++] = *c;
    qsql[p] = 0;
    if (sqlite3_prepare_v2(g_db, qsql, -1, &g_stmt_agent_states_battle[matchIdx], 0) != SQLITE_OK) return -1;

    g_battle_ready[matchIdx] = 1;
    return 0;
}

/* Runs on a dedicated, persistent prefetch worker's OWN READONLY connection
 * (see wasm_layout.h's WASM_PREFETCH_THREAD_ID) - entirely local state (own
 * db handle, own statements) for the READ side of the work.
 *
 * Deliberately READ-ONLY, never a second writer: SQLite's rollback-journal
 * locking downgrades a write transaction back to SHARED (not fully
 * unlocked) once it commits - standard, documented behavior, not a bug -
 * so g_db (the single long-lived playback connection, which does its own
 * occasional CREATE INDEX) ends up holding SHARED *permanently* once it's
 * done its first write. A second connection trying to open its own write
 * transaction later sees shared_count > 1 forever and gets SQLITE_BUSY on
 * every attempt - measured directly via wasm_vfs_get_lock_trace() during
 * development: a prefetch connection opened SQLITE_OPEN_READWRITE could
 * bisect fine but its CREATE INDEX reliably failed (rc=5) the moment g_db
 * had written anything at all. There is only ever one writer for the
 * lifetime of this module (matches the ORIGINAL single-writer invariant:
 * g_db is "the one connection ever open in SQLITE_OPEN_READWRITE mode").
 *
 * So this function does only the part that's genuinely safe to parallelize
 * - the rowid bisection - and writes the result directly into g_matches[]
 * (a plain, non-TLS static: physically the SAME bytes across every worker
 * instance sharing this Memory, so the write is immediately visible to
 * g_db's own instance too, no message round-trip needed for the data
 * itself) plus g_bounds_known[matchIdx]. replay_ensure_battle_ready(),
 * still exclusively on g_db, then only has to do the actual (bounded, cheap)
 * CREATE INDEX + prepare - the one write every battle still needs, but now
 * without also paying for its own bisection when prefetch already did it.
 * A benign race with g_db's own self-healing bisection for the same battle
 * (if the cursor reaches it while this is still running) just means both
 * compute the same deterministic bounds redundantly - never a correctness
 * issue, only wasted work. */
int replay_prefetch_battle(int matchIdx, double start_tick_id_d, double end_tick_id_d) {
    if (matchIdx < 0 || matchIdx >= g_match_count) return -1;
    if (g_bounds_known[matchIdx]) return 0;
    sqlite3_int64 start_tick_id = (sqlite3_int64)start_tick_id_d;
    sqlite3_int64 end_tick_id = (sqlite3_int64)end_tick_id_d;

    sqlite3 *db = 0;
    if (sqlite3_open_v2("main.db", &db, SQLITE_OPEN_READONLY, 0) != SQLITE_OK) return -1;

    sqlite3_int64 rmin, rmax;
    if (!agent_states_rowid_span_on(db, &rmin, &rmax)) { sqlite3_close(db); return -2; }

    sqlite3_stmt *idlookup = 0;
    if (sqlite3_prepare_v2(db, "SELECT tick_id FROM agent_states WHERE id >= ?1 ORDER BY id ASC LIMIT 1", -1, &idlookup, 0) != SQLITE_OK) {
        sqlite3_close(db); return -3;
    }

    sqlite3_int64 rowid_lo = lower_bound_rowid_on(idlookup, rmin, rmax, start_tick_id);
    sqlite3_int64 hi = upper_bound_rowid_on(idlookup, rmin, rmax, end_tick_id) - 1;
    sqlite3_finalize(idlookup);
    sqlite3_close(db);

    MatchInfo *m = &g_matches[matchIdx];
    m->rowid_lo = rowid_lo;
    m->rowid_hi = (hi >= rowid_lo) ? hi : rowid_lo - 1;
    g_bounds_known[matchIdx] = 1;
    return 0;
}

/* apply every spawn/kill event with tick_id in (from_tick, to_tick] to the
 * roster, in chronological (event id) order - single pass so a kill sees
 * the roster state left by any spawn earlier in the SAME window. */
static void apply_roster_delta(sqlite3_int64 from_tick, sqlite3_int64 to_tick) {
    sqlite3_reset(g_stmt_roster_delta);
    sqlite3_bind_int64(g_stmt_roster_delta, 1, from_tick);
    sqlite3_bind_int64(g_stmt_roster_delta, 2, to_tick);

    while (sqlite3_step(g_stmt_roster_delta) == SQLITE_ROW) {
        const unsigned char *event_type = sqlite3_column_text(g_stmt_roster_delta, 0);
        sqlite3_int64 agent_id = sqlite3_column_int64(g_stmt_roster_delta, 2);
        if (agent_id < 0 || agent_id >= MAX_AGENT_SLOTS) continue;

        if (event_type && event_type[0] == 's') { /* spawn */
            int is_human = sqlite3_column_int(g_stmt_roster_delta, 3);
            const unsigned char *team_text = sqlite3_column_text(g_stmt_roster_delta, 4);
            sqlite3_int64 spawn_event_id = sqlite3_column_int64(g_stmt_roster_delta, 5);
            g_roster[agent_id].active = 1;
            g_roster[agent_id].is_human = (unsigned char)(is_human != 0);
            g_roster[agent_id].team = parse_team(team_text);
            g_roster[agent_id].spawn_event_id = spawn_event_id;
        } else { /* kill */
            sqlite3_int64 dead_id = sqlite3_column_int64(g_stmt_roster_delta, 6);
            double dead_x = sqlite3_column_double(g_stmt_roster_delta, 7);
            double dead_y = sqlite3_column_double(g_stmt_roster_delta, 8);
            if (dead_id >= 0 && dead_id < MAX_AGENT_SLOTS) {
                corpse_list_add((float)dead_x, (float)dead_y, g_roster[dead_id].team);
            }
        }
    }
}

/* bring the roster/corpse state to exactly `target_tick_id`. Incremental
 * (cost proportional to events crossed) when advancing forward within the
 * same match; a bounded resync from the match's own start tick otherwise
 * (arbitrary seek, backward scrub, or crossing into a different match) -
 * never a full-history rescan. */
static void resync_roster_to(sqlite3_int64 target_tick_id) {
    int target_match = find_match_for_tick(target_tick_id);
    sqlite3_int64 from_tick;

    if (target_match != g_active_match_index || target_tick_id < g_roster_synced_tick_id) {
        memset(g_roster, 0, sizeof(g_roster));
        corpse_list_reset(); /* rebuilt below by replaying this match's kills from its own start */
        g_active_match_index = target_match;
        /* -2, not -1: the boundary tick where THIS match's own spawn events
         * fire is recorded as the PREVIOUS match's tail tick (start_idx of
         * a match is always end_idx+1 of the one before it - matches the
         * original JS segmentation exactly), so it sits at start_tick_id-1.
         * A -1 lower bound would exclude it and leave the roster empty. */
        from_tick = (target_match >= 0) ? g_matches[target_match].start_tick_id - 2 : -1;
    } else {
        from_tick = g_roster_synced_tick_id;
    }

    if (target_tick_id > from_tick) apply_roster_delta(from_tick, target_tick_id);
    g_roster_synced_tick_id = target_tick_id;
}

/* ---- frame buffer (JS/wasm shared layout: [x,y,team, x,y,team, ...]) ----
 * Growable, not fixed-size: living units are capped at MAX_AGENT_SLOTS by
 * the game engine itself (a real limit, not one imposed here), but corpses
 * accumulate for the whole battle (see corpse_list_add above) and have no
 * such ceiling - a long, bloody battle can end up with far more corpses
 * than living slots. JS re-reads replay_get_frame_buffer_ptr() every frame
 * regardless, so a pointer that moves after a realloc is always safe. */
static float *g_frame_buffer = 0;
static int g_frame_buffer_capacity = 0;
static int g_frame_count = 0;
static double g_relative_time = 0.0;
static sqlite3_int64 g_current_tick_id = -1; /* tickA of the most recent build_frame_at_time() call - chat gates on this */

static void ensure_frame_buffer_capacity(int n) {
    if (n <= g_frame_buffer_capacity) return;
    int new_cap = g_frame_buffer_capacity ? g_frame_buffer_capacity * 2 : 2048;
    while (new_cap < n) new_cap *= 2;
    float *nb = (float *)realloc(g_frame_buffer, sizeof(float) * 3 * (size_t)new_cap);
    if (!nb) return; /* OOM: keep the old buffer/capacity, build_frame_at_time's out-count will just clamp to it */
    g_frame_buffer = nb;
    g_frame_buffer_capacity = new_cap;
}

float *replay_get_frame_buffer_ptr(void) { return g_frame_buffer; }
int replay_get_frame_count(void) { return g_frame_count; }
int replay_get_active_match_index(void) { return g_active_match_index; }
double replay_get_relative_time(void) { return g_relative_time; }

static int find_tick_index_for_time(double t) {
    if (g_tick_count == 0) return 0;
    if (t <= g_ticks[0].time) return 0;
    if (t >= g_ticks[g_tick_count - 1].time) return g_tick_count - 1;
    int lo = 0, hi = g_tick_count - 1;
    while (lo < hi) {
        int mid = (lo + hi + 1) / 2;
        if (g_ticks[mid].time <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
}

static float fetch_positions(sqlite3_int64 tick_id, float *out_x, float *out_y, unsigned char *out_present) {
    int matchIdx = find_match_for_tick(tick_id);
    if (matchIdx < 0) return 0.0f; /* tick outside any known match: nothing to fetch, nothing touched */
    replay_ensure_battle_ready(matchIdx); /* self-healing: resolves this battle's rowid slice + index on first access if not already prefetched */
    sqlite3_stmt *stmt = g_stmt_agent_states_battle[matchIdx];
    sqlite3_reset(stmt);
    sqlite3_bind_int64(stmt, 1, tick_id);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        sqlite3_int64 agent_id = sqlite3_column_int64(stmt, 0);
        if (agent_id < 0 || agent_id >= MAX_AGENT_SLOTS) continue;
        out_x[agent_id] = (float)sqlite3_column_double(stmt, 1);
        out_y[agent_id] = (float)sqlite3_column_double(stmt, 2);
        out_present[agent_id] = 1;
    }
    return 0.0f;
}

static float g_pos_a_x[MAX_AGENT_SLOTS], g_pos_a_y[MAX_AGENT_SLOTS];
static float g_pos_b_x[MAX_AGENT_SLOTS], g_pos_b_y[MAX_AGENT_SLOTS];
static unsigned char g_pos_a_present[MAX_AGENT_SLOTS], g_pos_b_present[MAX_AGENT_SLOTS];
/* Full roster snapshot at tickA - same reasoning as corpse_count_at_a above,
 * for the same root cause: the tickB lookahead resync below can overwrite
 * is_human/team/active for any agent_id that gets a NEW spawn event exactly
 * at tickB (e.g. a human's slot reused for a bot in the next match, right at
 * a match-boundary tick). The display loop must classify each agent using
 * its tickA state - what's actually being shown - not tickB's. Found the
 * same way as the corpse bug: ground_truth.py + verify_against_truth.html
 * caught a real file where agent_id 718 was a valid human unit at tickA but
 * got excluded because it respawned as a bot at tickB, right at a
 * match-boundary faction_switch. spawn_event_id is snapshotted separately
 * (not folded into this struct) because it's used differently: compared
 * against g_roster's CURRENT (post-tickB) value on purpose, to detect
 * whether a respawn happened in the A-B interpolation window at all. */
static unsigned char g_snap_a_active[MAX_AGENT_SLOTS];
static unsigned char g_snap_a_is_human[MAX_AGENT_SLOTS];
static signed char g_snap_a_team[MAX_AGENT_SLOTS];
static sqlite3_int64 g_snap_a_spawn[MAX_AGENT_SLOTS];

static void build_frame_at_time(double t) {
    if (g_tick_count == 0) { g_frame_count = 0; return; }
    int idxA = find_tick_index_for_time(t);
    int idxB = (idxA + 1 < g_tick_count) ? idxA + 1 : idxA;
    sqlite3_int64 tickA_id = g_ticks[idxA].id;
    sqlite3_int64 tickB_id = g_ticks[idxB].id;

    float alpha = 0.0f;
    if (g_ticks[idxB].time > g_ticks[idxA].time) {
        alpha = (float)((t - g_ticks[idxA].time) / (g_ticks[idxB].time - g_ticks[idxA].time));
        if (alpha < 0.0f) alpha = 0.0f;
        if (alpha > 1.0f) alpha = 1.0f;
    }

    resync_roster_to(tickA_id);
    /* Corpses are cumulative GLOBAL state (unlike positions, which get their
     * own separate a/b snapshots below) - the lookahead resync to tickB just
     * below exists purely to fetch tickB's positions for interpolation, but
     * it also advances the roster/corpse state through tickB's kill events.
     * Snapshotting the count here, before that lookahead runs, is what keeps
     * this frame's displayed corpses scoped to tickA (what's actually being
     * shown) instead of leaking in tickB's (one tick in the future). Found
     * via ground_truth.py + verify_against_truth.html: corpse counts were
     * consistently over by however many kills landed in exactly tickB. Living
     * units don't need this same guard - they're already gated on
     * g_pos_a_present, which a tickB-only spawn naturally fails. The
     * underlying g_corpses[]/g_corpse_count keep growing past this snapshot
     * (correct - next frame's incremental resync picks up right where this
     * left off), only what gets EMITTED this frame is capped. */
    int corpse_count_at_a = g_corpse_count;

    memset(g_snap_a_spawn, 0xFF, sizeof(g_snap_a_spawn)); /* -1 = "no snapshot" */
    memset(g_snap_a_active, 0, sizeof(g_snap_a_active));
    for (int i = 0; i < MAX_AGENT_SLOTS; i++) {
        if (!g_roster[i].active) continue;
        g_snap_a_spawn[i] = g_roster[i].spawn_event_id;
        g_snap_a_active[i] = 1;
        g_snap_a_is_human[i] = g_roster[i].is_human;
        g_snap_a_team[i] = g_roster[i].team;
    }

    memset(g_pos_a_present, 0, sizeof(g_pos_a_present));
    memset(g_pos_b_present, 0, sizeof(g_pos_b_present));
    fetch_positions(tickA_id, g_pos_a_x, g_pos_a_y, g_pos_a_present);

    resync_roster_to(tickB_id); /* cheap: incremental from tickA, already synced */
    fetch_positions(tickB_id, g_pos_b_x, g_pos_b_y, g_pos_b_present);

    ensure_frame_buffer_capacity(g_corpse_count + MAX_AGENT_SLOTS); /* corpses (unbounded) + every living slot, worst case */

    int out = 0;
    /* corpses first so they're drawn first - main.c's renderer paints in
     * buffer order with no depth test, so whatever's pushed first ends up
     * underneath. Living units come after so they're always on top of any
     * corpse standing on the same spot. */
    for (int i = 0; i < corpse_count_at_a; i++) {
        g_frame_buffer[out * 3 + 0] = g_corpses[i].x;
        g_frame_buffer[out * 3 + 1] = g_corpses[i].y;
        g_frame_buffer[out * 3 + 2] = (g_corpses[i].team == 0) ? 2.0f : (g_corpses[i].team == 1) ? 3.0f : 4.0f;
        out++;
    }
    for (int agent_id = 0; agent_id < MAX_AGENT_SLOTS; agent_id++) {
        if (!g_snap_a_active[agent_id] || !g_snap_a_is_human[agent_id]) continue;
        if (!g_pos_a_present[agent_id]) continue;

        float x = g_pos_a_x[agent_id], y = g_pos_a_y[agent_id];
        if (g_pos_b_present[agent_id] && g_snap_a_spawn[agent_id] == g_roster[agent_id].spawn_event_id) {
            x = x + (g_pos_b_x[agent_id] - x) * alpha;
            y = y + (g_pos_b_y[agent_id] - y) * alpha;
        }
        g_frame_buffer[out * 3 + 0] = x;
        g_frame_buffer[out * 3 + 1] = y;
        g_frame_buffer[out * 3 + 2] = (float)g_snap_a_team[agent_id]; /* -1, 0, or 1 - tickA's team, not tickB's */
        out++;
    }
    g_frame_count = out;
    g_current_tick_id = tickA_id; /* chat delivery (replay_get_new_chat_count) gates on this */

    g_relative_time = 0.0;
    if (g_active_match_index >= 0) g_relative_time = t - g_matches[g_active_match_index].start_time;
}

void replay_advance_to_time(double t) { build_frame_at_time(t); }
void replay_seek_to_time(double t) { build_frame_at_time(t); }

/* ---- chat cache (scoped to the active match, extended lazily) ---------- */
typedef struct ChatEntry {
    sqlite3_int64 tick_id;
    signed char team;
    char username[32];
    char message[160];
} ChatEntry;
static ChatEntry *g_chats = 0;
static int g_chat_count = 0;
static int g_chat_capacity = 0;
static int g_chat_scoped_match = -2; /* which match g_chats currently covers */
static int g_chat_read_cursor = 0;

static void copy_text(char *dst, int dstSize, const unsigned char *src) {
    int i = 0;
    if (src) while (src[i] && i < dstSize - 1) { dst[i] = (char)src[i]; i++; }
    dst[i] = 0;
}

static void load_chats_for_match(int match_idx) {
    g_chat_count = 0;
    g_chat_read_cursor = 0;
    g_chat_scoped_match = match_idx;
    if (match_idx < 0 || !g_db) return;

    sqlite3_stmt *stmt = 0;
    const char *sql = "SELECT e.tick_id, c.username, c.message, c.team "
                       "FROM chats c JOIN events e ON c.event_id = e.id "
                       "WHERE e.tick_id >= ?1 AND e.tick_id <= ?2 ORDER BY e.id ASC";
    if (sqlite3_prepare_v2(g_db, sql, -1, &stmt, 0) != SQLITE_OK) return;
    sqlite3_bind_int64(stmt, 1, g_matches[match_idx].start_tick_id);
    sqlite3_bind_int64(stmt, 2, g_matches[match_idx].end_tick_id);

    while (sqlite3_step(stmt) == SQLITE_ROW && g_chat_count < g_chat_capacity) {
        ChatEntry *e = &g_chats[g_chat_count];
        e->tick_id = sqlite3_column_int64(stmt, 0);
        copy_text(e->username, sizeof(e->username), sqlite3_column_text(stmt, 1));
        copy_text(e->message, sizeof(e->message), sqlite3_column_text(stmt, 2));
        e->team = parse_team(sqlite3_column_text(stmt, 3));
        g_chat_count++;
    }
    sqlite3_finalize(stmt);
}

/* returns the number of chat entries newly DUE since the last call - "due"
 * meaning their tick_id has actually been reached by playback
 * (g_current_tick_id, set every build_frame_at_time() call), not just
 * "loaded for this match". Without this gate, the whole match's chat log -
 * loaded all at once by load_chats_for_match() below - would all report as
 * "new" the instant the match becomes active, dumping every message into
 * the chat panel in one burst instead of as each was actually said. A
 * monotonic cursor either way (JS never re-scans, just drains what's due),
 * re-scoping the cache when the active match has changed. */
int replay_get_new_chat_count(void) {
    if (g_active_match_index != g_chat_scoped_match) load_chats_for_match(g_active_match_index);
    int due = g_chat_read_cursor;
    while (due < g_chat_count && g_chats[due].tick_id <= g_current_tick_id) due++;
    int n = due - g_chat_read_cursor;
    return n > 0 ? n : 0;
}
static int chat_ref(int i) { return g_chat_read_cursor + i; } /* index relative to the unread window */
const char *replay_get_chat_username_ptr(int i) {
    int idx = chat_ref(i);
    return (idx >= 0 && idx < g_chat_count) ? g_chats[idx].username : "";
}
const char *replay_get_chat_message_ptr(int i) {
    int idx = chat_ref(i);
    return (idx >= 0 && idx < g_chat_count) ? g_chats[idx].message : "";
}
int replay_get_chat_team(int i) {
    int idx = chat_ref(i);
    return (idx >= 0 && idx < g_chat_count) ? g_chats[idx].team : -1;
}
void replay_advance_chat_cursor(int count) {
    g_chat_read_cursor += count;
    if (g_chat_read_cursor > g_chat_count) g_chat_read_cursor = g_chat_count;
}

/* ---- one-time load finalization: indexes, tick index, match scan -------- */

static int run_sql(const char *sql) {
    char *errmsg = 0;
    int rc = sqlite3_exec(g_db, sql, 0, 0, &errmsg);
    if (rc != SQLITE_OK) { set_error(errmsg ? errmsg : "sql exec failed"); if (errmsg) sqlite3_free(errmsg); }
    return rc;
}

static int load_tick_index(void) {
    sqlite3_stmt *stmt = 0;
    if (sqlite3_prepare_v2(g_db, "SELECT COUNT(*) FROM ticks", -1, &stmt, 0) != SQLITE_OK) return -1;
    sqlite3_step(stmt);
    int count = sqlite3_column_int(stmt, 0);
    sqlite3_finalize(stmt);
    if (count <= 0) { set_error("replay database contains no ticks"); return -1; }

    g_ticks = (TickEntry *)malloc(sizeof(TickEntry) * (size_t)count);
    if (!g_ticks) { set_error("out of memory loading tick index"); return -1; }

    if (sqlite3_prepare_v2(g_db, "SELECT id, time FROM ticks ORDER BY id ASC", -1, &stmt, 0) != SQLITE_OK) return -1;
    int i = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW && i < count) {
        g_ticks[i].id = sqlite3_column_int64(stmt, 0);
        g_ticks[i].time = sqlite3_column_double(stmt, 1);
        i++;
    }
    sqlite3_finalize(stmt);
    g_tick_count = i;
    return 0;
}

/* mirrors main.js's getMatchStateAtTick: latest map_switch/faction_switch
 * at or before a given tick. */
static void resolve_match_meta(sqlite3_int64 tick_id, int *scene_no, char *faction_text, int faction_text_size) {
    sqlite3_stmt *stmt = 0;
    *scene_no = 0;
    faction_text[0] = 0;

    if (sqlite3_prepare_v2(g_db,
        "SELECT ms.scene_no FROM map_switches ms JOIN events e ON ms.event_id = e.id "
        "WHERE e.tick_id <= ?1 ORDER BY e.id DESC LIMIT 1", -1, &stmt, 0) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, tick_id);
        if (sqlite3_step(stmt) == SQLITE_ROW) *scene_no = sqlite3_column_int(stmt, 0);
        sqlite3_finalize(stmt);
    }

    if (sqlite3_prepare_v2(g_db,
        "SELECT fs.team_0_faction_name, fs.team_1_faction_name FROM faction_switches fs "
        "JOIN events e ON fs.event_id = e.id WHERE e.tick_id <= ?1 ORDER BY e.id DESC LIMIT 1",
        -1, &stmt, 0) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, tick_id);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            const unsigned char *a = sqlite3_column_text(stmt, 0);
            const unsigned char *b = sqlite3_column_text(stmt, 1);
            int n = 0;
            if (a) while (a[n] && n < faction_text_size - 5) { faction_text[n] = (char)a[n]; n++; }
            faction_text[n++] = ' '; faction_text[n++] = 'v'; faction_text[n++] = 's'; faction_text[n++] = ' ';
            if (b) { int m = 0; while (b[m] && n < faction_text_size - 1) { faction_text[n++] = (char)b[m]; m++; } }
            faction_text[n] = 0;
        }
        sqlite3_finalize(stmt);
    }
}

/* port of main.js's processDatabaseAndCompileMatches boundary segmentation:
 * scan map/score/faction_switch events, merge boundaries within 15 ticks of
 * each other, skip the first 5 ticks (initial state markers), require a
 * >=10 tick gap for a match, >=5 ticks for the tail segment. */
static int tick_index_for_id(sqlite3_int64 tick_id) {
    int lo = 0, hi = g_tick_count - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (g_ticks[mid].id == tick_id) return mid;
        if (g_ticks[mid].id < tick_id) lo = mid + 1; else hi = mid - 1;
    }
    return lo < g_tick_count ? lo : g_tick_count - 1;
}

static int scan_matches(void) {
    sqlite3_stmt *stmt = 0;
    if (sqlite3_prepare_v2(g_db,
        "SELECT DISTINCT e.tick_id FROM events e "
        "WHERE e.event_type IN ('map_switch','score_switch','faction_switch') ORDER BY e.tick_id ASC",
        -1, &stmt, 0) != SQLITE_OK) return -1;

    int boundary_indices[256];
    int boundary_count = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW && boundary_count < 256) {
        sqlite3_int64 tick_id = sqlite3_column_int64(stmt, 0);
        boundary_indices[boundary_count++] = tick_index_for_id(tick_id);
    }
    sqlite3_finalize(stmt);

    int merged[256], merged_count = 0;
    for (int i = 0; i < boundary_count; i++) {
        int idx = boundary_indices[i];
        if (idx < 5) continue;
        if (merged_count == 0 || idx - merged[merged_count - 1] > 15) {
            merged[merged_count++] = idx;
        }
    }

    g_match_count = 0;
    int start_idx = 0;
    for (int i = 0; i < merged_count && g_match_count < MAX_MATCHES - 1; i++) {
        int end_idx = merged[i];
        if (end_idx - start_idx >= 10) {
            MatchInfo *m = &g_matches[g_match_count];
            m->start_tick_id = g_ticks[start_idx].id;
            m->end_tick_id = g_ticks[end_idx].id;
            m->start_time = g_ticks[start_idx].time;
            m->end_time = g_ticks[end_idx].time;
            resolve_match_meta(m->start_tick_id, &m->scene_no, m->faction_text, sizeof(m->faction_text));
            g_match_count++;
            start_idx = end_idx + 1;
        }
    }
    if (g_tick_count - 1 - start_idx >= 5 && g_match_count < MAX_MATCHES) {
        MatchInfo *m = &g_matches[g_match_count];
        m->start_tick_id = g_ticks[start_idx].id;
        m->end_tick_id = g_ticks[g_tick_count - 1].id;
        m->start_time = g_ticks[start_idx].time;
        m->end_time = g_ticks[g_tick_count - 1].time;
        resolve_match_meta(m->start_tick_id, &m->scene_no, m->faction_text, sizeof(m->faction_text));
        g_match_count++;
    }
    return 0;
}

/* returns match count on success, negative error code on failure */
int replay_finish_load(void) {
    if (g_load_file) {
        g_load_file->pMethods->xClose(g_load_file);
        sqlite3_free(g_load_file);
        g_load_file = 0;
    }

    int rc = sqlite3_open_v2("main.db", &g_db, SQLITE_OPEN_READWRITE, 0);
    if (rc != SQLITE_OK) { set_error("sqlite3_open_v2 failed"); return -1; }

    if (run_sql("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;") != SQLITE_OK) return -2;

    /* agent_states gets NO secondary index, ever - it's ~99% of the row
     * count (2.3M of ~2.35M total rows in a real 15-battle file) and the
     * only table worth scoping per-battle at all; per-battle isolation for
     * it comes from rowid-range bisection instead, see
     * replay_ensure_battle_ready(). Every other table here is small enough
     * (hundreds to low thousands of rows total, across ALL battles) that a
     * plain full index is negligible. idx_spawns_agent_event (agent_id,
     * event_id) from an earlier pass is gone entirely: no query here ever
     * used it, and agent_id is a reused engine slot (0-1024) - an index
     * sorted by it would have interleaved every battle's rows into the same
     * B-tree pages, defeating per-battle isolation for no benefit. */
    if (run_sql(
        "CREATE INDEX idx_ticks_time ON ticks(time);"
        "CREATE INDEX idx_events_tick_id ON events(tick_id);"
        "CREATE INDEX idx_events_type_tick ON events(event_type, tick_id);"
        "CREATE INDEX idx_spawns_event_id ON spawns(event_id);"
        "CREATE INDEX idx_kills_event_id ON kills(event_id);"
        "CREATE INDEX idx_chats_event_id ON chats(event_id);"
        "CREATE INDEX idx_map_switches_event ON map_switches(event_id);"
        "CREATE INDEX idx_score_switches_event ON score_switches(event_id);"
        "CREATE INDEX idx_faction_switches_event ON faction_switches(event_id);"
    ) != SQLITE_OK) return -3;

    if (load_tick_index() != 0) return -4;
    if (scan_matches() != 0) return -5;

    g_chat_capacity = MAX_CHAT_ENTRIES;
    g_chats = (ChatEntry *)malloc(sizeof(ChatEntry) * (size_t)g_chat_capacity);
    if (!g_chats) { set_error("out of memory allocating chat cache"); return -6; }

    const char *roster_delta_sql =
        "SELECT e.event_type, e.tick_id, "
        "  CASE e.event_type WHEN 'spawn' THEN s.agent_id ELSE k.dead_id END AS agent_ref, "
        "  s.is_human, s.team, s.event_id, "
        "  k.dead_id, k.dead_x, k.dead_y "
        "FROM events e "
        "LEFT JOIN spawns s ON e.event_type='spawn' AND s.event_id = e.id "
        "LEFT JOIN kills k ON e.event_type='kill' AND k.event_id = e.id "
        "WHERE e.tick_id > ?1 AND e.tick_id <= ?2 AND e.event_type IN ('spawn','kill') "
        "ORDER BY e.id ASC";
    if (sqlite3_prepare_v2(g_db, roster_delta_sql, -1, &g_stmt_roster_delta, 0) != SQLITE_OK) {
        set_error("failed to prepare roster delta statement"); return -7;
    }

    if (sqlite3_prepare_v2(g_db,
        "SELECT tick_id FROM agent_states WHERE id >= ?1 ORDER BY id ASC LIMIT 1",
        -1, &g_stmt_id_lookup, 0) != SQLITE_OK) {
        set_error("failed to prepare id lookup statement"); return -9;
    }

    return g_match_count;
}

/* ---- parallel map-bounds computation (genuine reader-thread parallel work) --
 * main.js's old query computed bounds via a per-row correlated subquery
 * ("is this agent_id's most recent spawn as of this tick human") over all
 * of agent_states - expensive at 2M+ rows, and exactly the kind of
 * per-frame-shaped query this rewrite exists to get rid of. Bounds only
 * need to roughly frame the camera, so this drops the per-row human check
 * (bots and humans occupy the same battlefield) and instead splits the
 * tick range N ways across reader threads, each computing a partial
 * MIN/MAX over its own slice through its OWN connection - genuinely
 * concurrent SHARED-lock reads, not just backgrounded work. Each reader
 * MUST use its own sqlite3 connection/statements (TLS): SQLite does not
 * support concurrently stepping the same prepared statement from two
 * threads even under THREADSAFE=1, unlike the shared, read-only, never-
 * mutated-after-load g_ticks[] this function also touches. */
typedef struct BoundsSlot {
    _Atomic int ready;
    float min_x, max_x, min_y, max_y;
} BoundsSlot;

static BoundsSlot *region_c_bounds_slots(void) {
    return (BoundsSlot *)(void *)wasm_region_c_base();
}

void replay_reader_compute_bounds(int reader_idx, int reader_count) {
    BoundsSlot *slot = &region_c_bounds_slots()[reader_idx];
    slot->min_x = slot->min_y = 1e30f;
    slot->max_x = slot->max_y = -1e30f;

    if (g_tick_count == 0 || reader_count <= 0) { atomic_store(&slot->ready, 1); return; }

    int per = (g_tick_count + reader_count - 1) / reader_count;
    int lo_idx = reader_idx * per;
    int hi_idx = lo_idx + per - 1;
    if (lo_idx >= g_tick_count) { atomic_store(&slot->ready, 1); return; }
    if (hi_idx >= g_tick_count) hi_idx = g_tick_count - 1;
    sqlite3_int64 tick_lo = g_ticks[lo_idx].id, tick_hi = g_ticks[hi_idx].id;

    sqlite3 *db = 0;
    if (sqlite3_open_v2("main.db", &db, SQLITE_OPEN_READONLY, 0) != SQLITE_OK) {
        atomic_store(&slot->ready, 1); return;
    }
    sqlite3_stmt *stmt = 0;
    if (sqlite3_prepare_v2(db,
        "SELECT MIN(pos_x), MAX(pos_x), MIN(pos_y), MAX(pos_y) FROM agent_states "
        "WHERE tick_id >= ?1 AND tick_id <= ?2", -1, &stmt, 0) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, tick_lo);
        sqlite3_bind_int64(stmt, 2, tick_hi);
        if (sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_type(stmt, 0) != SQLITE_NULL) {
            slot->min_x = (float)sqlite3_column_double(stmt, 0);
            slot->max_x = (float)sqlite3_column_double(stmt, 1);
            slot->min_y = (float)sqlite3_column_double(stmt, 2);
            slot->max_y = (float)sqlite3_column_double(stmt, 3);
        }
        sqlite3_finalize(stmt);
    }
    sqlite3_close(db);
    atomic_store(&slot->ready, 1);
}

/* called once by the playback thread after JS has confirmed (via
 * postMessage from every reader) that all partial slots are populated -
 * no in-wasm waiting/polling needed, JS already knows when each reader
 * finished. */
static float g_map_min_x = -100.0f, g_map_max_x = 100.0f, g_map_min_y = -100.0f, g_map_max_y = 100.0f;
void replay_combine_bounds(int reader_count) {
    float minX = 1e30f, maxX = -1e30f, minY = 1e30f, maxY = -1e30f;
    BoundsSlot *slots = region_c_bounds_slots();
    int any = 0;
    for (int i = 0; i < reader_count; i++) {
        if (!atomic_load(&slots[i].ready)) continue;
        if (slots[i].min_x > slots[i].max_x) continue; /* empty slice */
        if (slots[i].min_x < minX) minX = slots[i].min_x;
        if (slots[i].max_x > maxX) maxX = slots[i].max_x;
        if (slots[i].min_y < minY) minY = slots[i].min_y;
        if (slots[i].max_y > maxY) maxY = slots[i].max_y;
        any = 1;
    }
    if (any) {
        g_map_min_x = minX - 10.0f; g_map_max_x = maxX + 10.0f;
        g_map_min_y = minY - 10.0f; g_map_max_y = maxY + 10.0f;
    }
}
float replay_get_map_min_x(void) { return g_map_min_x; }
float replay_get_map_max_x(void) { return g_map_max_x; }
float replay_get_map_min_y(void) { return g_map_min_y; }
float replay_get_map_max_y(void) { return g_map_max_y; }

/* layout ground-truth for JS bootstrap - lets replay-worker.js's TLS/stack
 * pool base constants be verified against the real linker-computed
 * addresses instead of hand-estimated ones. */
double wasm_debug_heap_base(void) { return (double)(size_t)&__heap_base; }
double wasm_debug_region_a_base(void) { return (double)(size_t)wasm_region_a_base(); }
double wasm_debug_region_c_base(void) { return (double)(size_t)wasm_region_c_base(); }
double wasm_debug_layout_end(void) { return (double)(size_t)wasm_layout_end(); }
/* load-bearing, not just diagnostic - replay-worker.js's bootstrap() calls
 * these to place each thread's stack/TLS, see the comment in wasm_layout.h. */
double wasm_debug_stack_pool_base(void) { return (double)(size_t)wasm_stack_pool_base(); }
double wasm_debug_tls_pool_base(void) { return (double)(size_t)wasm_tls_pool_base(); }

/* temporary diagnostic: does g_db (the playback connection) see an index
 * another connection built, without going through replay_ensure_battle_ready
 * at all - isolates "cross-connection visibility" from "bisection/prepare
 * cost" as the explanation for prefetch not being as cheap as expected. */
int replay_debug_index_visible(int matchIdx) {
    char sql[64];
    int p = 0;
    const char *prefix = "SELECT count(*) FROM sqlite_master WHERE name='idx_as_b";
    for (const char *c = prefix; *c; c++) sql[p++] = *c;
    append_i64(sql, &p, matchIdx);
    sql[p++] = '\''; sql[p] = 0;
    sqlite3_stmt *stmt = 0;
    int result = -1;
    if (sqlite3_prepare_v2(g_db, sql, -1, &stmt, 0) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) result = sqlite3_column_int(stmt, 0);
        sqlite3_finalize(stmt);
    }
    return result;
}

/* ---- thread entry point --------------------------------------------------
 * role: 0 = loader (does the write phase: load/index/tick-scan/match-scan,
 *       then continues as the playback thread), 1 = reader (parallel bounds
 *       computation only, then the JS side terminates the worker). */
void thread_main(int thread_id, int role) {
    wasm_thread_set_id(thread_id);
    heap_thread_init(thread_id);
    (void)role;
}

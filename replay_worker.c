/*
 * Owns everything DB-related for the replay viewer: the load pipeline,
 * all SQL, the incremental roster/cursor algorithm, match segmentation,
 * and the interpolated frame buffer. Never runs on the main thread - only
 * inside Web Workers, instantiated from replay_worker.wasm.
 *
 * JS is a thin stub: it hands raw file bytes to replay_feed_chunk, calls
 * replay_finish_load once, then drives playback via replay_advance_to_time/
 * replay_seek_to_time + reads the resulting frame/match buffers through the
 * getters below. No SQL or tick bookkeeping happens in JS. Chat is not part
 * of this at all - it's a plain SQL query main.js runs through the normal
 * SQL Terminal execution path (see replay_get_current_tick_id below).
 */
#include "sqlite3.h"
#include "wasm_thread.h"
#include "wasm_layout.h"
#include "sql/canonical_roster_corpse_sql.h"
#include "sql/default_boundary_detection_sql.h"
#include "sql/default_render_corpses_sql.h"
#include "sql/default_render_living_agents_sql.h"
#include "sql/default_render_chat_sql.h"
#include "sql/sample_render_nato_symbols_sql.h"
#include "replay_internal.h"
#include "sha256.h"
#include <stdatomic.h>
#include <string.h>
#include <stdlib.h>

extern void heap_thread_init(int thread_id);
extern const sqlite3_mutex_methods *wasm_mutex_methods_get(void);
extern void js_log_string(const char *msg);

/* ---- constants -------------------------------------------------------- */
#define MAX_AGENT_SLOTS    1025  /* lua/main.lua: for agent = 0, 1024 do - a real engine limit on simultaneous living units */
/* MAX_MATCHES itself lives in replay_internal.h now - replay_export.c's
 * roster/corpse summary cache (g_rc_cache) is sized off it too, and a
 * locally-duplicated constant would risk silently drifting out of sync. */
#define MAX_NONBATTLE_SPANS 16   /* see NonBattleSpan below - same headroom reasoning as MAX_MATCHES */
#define LOAD_CHUNK_SIZE    (1024 * 1024)

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
sqlite3 *g_db = 0; /* not static - shared with replay_export.c, see replay_internal.h */

/* ---- source file identity (Phase 4: manifest.json's source_replay block) --
 * sha256 is accumulated incrementally as replay_feed_chunk streams the file
 * in (a 20GB file can't be hashed as one buffer, and crypto.subtle.digest
 * has no streaming/update API - see sha256.h) and finalized once at the end
 * of replay_finish_load(). Filename/generated-at-time are the two pieces of
 * export metadata only JS genuinely has (the File object's name, and real
 * wall-clock time - this module's only clock_gettime() import is
 * performance.now()-based, not Unix epoch, see replay-worker.js), so JS
 * writes them in through the same "buffer JS fills, C reads" pattern
 * replay_get_load_chunk_ptr() already uses for file bytes - not a
 * departure from "logic lives in C", just the two raw inputs only JS has. */
#define SOURCE_FILENAME_BUF_SIZE 256
static sha256_ctx g_source_hash_ctx;
static char g_source_hash_hex[65];
static char g_source_filename[SOURCE_FILENAME_BUF_SIZE];
static double g_export_time_unix = 0;

unsigned char *replay_get_filename_buf_ptr(void) { return (unsigned char *)g_source_filename; }
int replay_set_filename_len(int len) {
    if (len < 0) len = 0;
    if (len > SOURCE_FILENAME_BUF_SIZE - 1) len = SOURCE_FILENAME_BUF_SIZE - 1;
    g_source_filename[len] = 0;
    return 0;
}
void replay_set_export_time_unix(double t) { g_export_time_unix = t; }
double replay_get_export_time_unix(void) { return g_export_time_unix; }
const char *replay_get_source_sha256_hex(void) { return g_source_hash_hex; }
const char *replay_get_source_filename(void) { return g_source_filename; }
double replay_get_source_size_bytes(void) { return (double)g_load_write_offset; }

int replay_begin_load(void) {
    sha256_init(&g_source_hash_ctx);
    g_vfs = sqlite3_vfs_find(0);
    if (!g_vfs) { set_error("no default vfs registered"); return -1; }
    g_load_file = (sqlite3_file *)sqlite3_malloc(g_vfs->szOsFile);
    if (!g_load_file) { set_error("out of memory allocating file handle"); return -2; }
    int outFlags = 0;
    int rc = g_vfs->xOpen(g_vfs, "main.db", g_load_file,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_MAIN_DB, &outFlags);
    if (rc != SQLITE_OK) { set_error("vfs xOpen failed for main.db"); return rc; }
    /* main.db is backed by a persistent OPFS file (see sqlite3_vfs_mem.c) -
     * unlike the fresh-per-load WebAssembly.Memory (which zeroes
     * everything, including the in-memory logical-size counter, for free),
     * bytes physically written to OPFS by a PREVIOUS load in this browser
     * session stay on disk until explicitly cleared. The logical-size
     * counter already bounds every read to what THIS load has actually
     * written, so stale trailing bytes from a bigger previous file are
     * harmless for correctness - this xTruncate is purely hygiene, so
     * repeatedly loading different files in one session doesn't leak
     * unbounded OPFS disk space. */
    rc = g_load_file->pMethods->xTruncate(g_load_file, 0);
    if (rc != SQLITE_OK) { set_error("vfs xTruncate(0) failed for main.db"); return rc; }
    g_load_write_offset = 0;
    return 0;
}

unsigned char *replay_get_load_chunk_ptr(void) { return g_load_chunk; }

int replay_feed_chunk(int len) {
    if (!g_load_file) { set_error("replay_feed_chunk called before replay_begin_load"); return -1; }
    int rc = g_load_file->pMethods->xWrite(g_load_file, g_load_chunk, len, g_load_write_offset);
    if (rc != SQLITE_OK) { set_error("vfs xWrite failed (file exceeds Region A capacity?)"); return rc; }
    sha256_update(&g_source_hash_ctx, g_load_chunk, (size_t)len);
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
/* MatchInfo itself now lives in replay_internal.h - shared verbatim with
 * replay_export.c, which needs a battle's resolved rowid_lo/rowid_hi too. */
static MatchInfo g_matches[MAX_MATCHES];
static int g_match_count = 0;
static unsigned char g_battle_ready[MAX_MATCHES]; /* has this battle's agent_states rowid slice been resolved? */

/* A "skippable, not a battle" span - the boundary-detection SQL's is_battle=0
 * rows (see sql/default_boundary_detection.sql and scan_matches_via_sql
 * below). The default query never emits any (it faithfully reproduces the
 * legacy C heuristic's behavior of silently absorbing a too-short span into
 * whichever battle follows it) - this exists for a CUSTOM boundary-detection
 * query that wants to mark, say, a lobby/warmup period explicitly instead. */
typedef struct NonBattleSpan { sqlite3_int64 start_tick_id, end_tick_id; } NonBattleSpan;
static NonBattleSpan g_nonbattle_spans[MAX_NONBATTLE_SPANS];
static int g_nonbattle_span_count = 0;
int replay_get_nonbattle_span_count(void) { return g_nonbattle_span_count; }
double replay_get_nonbattle_span_start_tick_id(int idx) { return (idx >= 0 && idx < g_nonbattle_span_count) ? (double)g_nonbattle_spans[idx].start_tick_id : 0.0; }
double replay_get_nonbattle_span_end_tick_id(int idx) { return (idx >= 0 && idx < g_nonbattle_span_count) ? (double)g_nonbattle_spans[idx].end_tick_id : 0.0; }

MatchInfo *replay_internal_get_match(int matchIdx) {
    return (matchIdx >= 0 && matchIdx < g_match_count) ? &g_matches[matchIdx] : 0;
}

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
int g_active_match_index = -1; /* not static - replay_export.c's on-demand replay.db/battle.db views read this, see replay_internal.h */

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

/* tick_id of the first agent_states row with id >= probe (rowid seek, O(log n)).
 * Confirmed via direct testing (a standalone native repro against this
 * exact sqlite3.c amalgamation): leaving idlookup sitting in SQLITE_ROW
 * (its LIMIT 1 means exactly one step() ever returns ROW, so a naive
 * "if (step()==ROW) return ..." without a trailing reset leaves the
 * statement ACTIVE/mid-VDBE between calls) makes SQLite refuse ANY
 * schema-changing statement (CREATE/DROP TABLE) ANYWHERE ELSE on this same
 * connection - including on totally unrelated attached schemas like "b"/
 * "bcN" - with SQLITE_LOCKED ("database table is locked"), for as long as
 * idlookup stays active. This is the real root cause a whole session's
 * worth of "database table is locked"/"table already exists" symptoms in
 * attach_battledb_view's schema_copy_all_tables trace back to: this
 * function (via lower_bound_rowid_on/upper_bound_rowid_on's binary search,
 * called from ensure_bounds_known/replay_ensure_battle_ready whenever a
 * battle's rowid bounds get resolved) leaves g_stmt_id_lookup active right
 * up until the next real tick_id_at_or_after_rowid_on call resets it - a
 * window that can span an intervening attach_battledb_view call for a
 * different battle. Always reset after reading the (at most one) row so
 * this statement is idle, not mid-VDBE, whenever it isn't actively being
 * stepped. */
static sqlite3_int64 tick_id_at_or_after_rowid_on(sqlite3_stmt *idlookup, sqlite3_int64 probe) {
    sqlite3_reset(idlookup);
    sqlite3_bind_int64(idlookup, 1, probe);
    sqlite3_int64 result = -1; /* probe is past the last row */
    if (sqlite3_step(idlookup) == SQLITE_ROW) result = sqlite3_column_int64(idlookup, 0);
    sqlite3_reset(idlookup);
    return result;
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

/* Shared "idx_as_b<matchIdx>" name-building - used by CREATE INDEX below,
 * DROP INDEX (replay_evict_battle), and the debug index-visibility getter
 * (replay_debug_index_visible) - one place builds this name instead of
 * three copies of the same "idx_as_b" + integer concatenation. */
static void append_battle_index_name(char *sql, int *p, int matchIdx) {
    const char *prefix = "idx_as_b";
    for (const char *c = prefix; *c; c++) sql[(*p)++] = *c;
    append_i64(sql, p, matchIdx);
}

/* both callers need the exact same CREATE INDEX text (literal [lo,hi], not
 * bound params - see the block comment above) so the SELECT built with the
 * same literals is provably eligible to use it, whichever thread built it. */
static void build_battle_index_sql(char *sql, int matchIdx, sqlite3_int64 rowid_lo, sqlite3_int64 rowid_hi) {
    int p = 0;
    const char *idx_prefix = "CREATE INDEX IF NOT EXISTS ";
    for (const char *c = idx_prefix; *c; c++) sql[p++] = *c;
    append_battle_index_name(sql, &p, matchIdx);
    const char *idx_mid = " ON agent_states(tick_id) WHERE id BETWEEN ";
    for (const char *c = idx_mid; *c; c++) sql[p++] = *c;
    append_i64(sql, &p, rowid_lo);
    const char *and_ = " AND ";
    for (const char *c = and_; *c; c++) sql[p++] = *c;
    append_i64(sql, &p, rowid_hi);
    sql[p] = 0;
}

/* DROP counterpart, used only by eviction (replay_evict_battle below) -
 * needs just the name, not the [lo,hi] bounds CREATE requires. */
static void build_battle_drop_index_sql(char *sql, int matchIdx) {
    int p = 0;
    const char *prefix = "DROP INDEX IF EXISTS ";
    for (const char *c = prefix; *c; c++) sql[p++] = *c;
    append_battle_index_name(sql, &p, matchIdx);
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

/* Memory-budgeted prefetch/eviction. 0 = unset = unlimited (matches the
 * pre-existing unbounded-growth behavior if JS never calls
 * replay_set_priming_budget_bytes - fail-open, not fail-closed). Compared
 * against replay_get_playback_heap_bytes() (thread 0's own live-allocation
 * count, goyslopless-c/lib/heap.c's heap_debug_bytes_inuse() - deliberately
 * NOT region/committed-address-space size, which only ever grows even after
 * an eviction frees payload bytes for reuse; see heap.c's comment on
 * g_heap_bytes_inuse for why that distinction matters here). */
static int g_priming_budget_bytes = 0;
static int g_evict_failures = 0; /* mirrors g_heap_extend_failures' role in heap.c - should stay 0 */

void replay_set_priming_budget_bytes(int bytes) { g_priming_budget_bytes = bytes; }
int replay_get_playback_heap_bytes(void) { return (int)heap_debug_bytes_inuse(); }

/* Which currently-ready battle is farthest in real elapsed time from
 * fromMatchIdx (excluding fromMatchIdx itself) - the eviction victim when
 * room needs to be made. Real time distance (MatchInfo.start_time), not
 * match-index distance: battles vary enough in duration (a skirmish vs a
 * siege) that a short battle three matches away can be closer in elapsed
 * time than a long one immediately adjacent. main.js's own prefetch fan-out
 * (pickPrefetchTarget/pickPrimeTarget) keeps using index-distance for FETCH
 * ORDER, which is a separately-tuned, unrelated concern - this is only for
 * deciding what to sacrifice. Returns -1 if nothing else is evictable.
 *
 * Also unconditionally excludes g_active_match_index (the battle
 * build_frame_at_time() is actually displaying right now, updated
 * synchronously in resync_roster_to() before every fetch_positions() call -
 * see replay_get_active_match_index()), not just fromMatchIdx. The two
 * usually agree (replay_ensure_battle_ready's self-heal call always passes
 * its own matchIdx, which resync_roster_to already set as active moments
 * earlier), but replay_try_prime_battle's currentMatchIdx comes from JS as a
 * cursor snapshot taken when the 'primeBattle' message was SENT, not when
 * it's processed - if the cursor has since moved (a fast scrub, or several
 * proactive primes queued back to back), that snapshot is stale and could
 * pick the battle now genuinely on screen as the "farthest away" victim.
 * Checking the always-current g_active_match_index here closes that race at
 * its one physical choke point instead of trying to keep every caller's
 * cursor snapshot fresh - confirmed via ui_behavior_tests.js's "active
 * battle is always ready under eviction pressure" check, which started
 * failing reproducibly once proactive priming got frequent enough (see
 * pickPrimeTarget's comment in main.js) to actually hit this window. */
static int pick_farthest_primed_battle(int fromMatchIdx) {
    if (fromMatchIdx < 0 || fromMatchIdx >= g_match_count) return -1;
    int victim = -1;
    double victim_dt = -1.0;
    double from_time = g_matches[fromMatchIdx].start_time;
    for (int i = 0; i < g_match_count; i++) {
        if (i == fromMatchIdx || i == g_active_match_index || !g_battle_ready[i]) continue;
        double dt = g_matches[i].start_time - from_time;
        if (dt < 0) dt = -dt;
        if (dt > victim_dt) { victim_dt = dt; victim = i; }
    }
    return victim;
}

/* Tears down one battle's index+statement so its heap allocation becomes
 * available for a later allocation to reuse (see g_heap_bytes_inuse's
 * comment in heap.c - this can never shrink the tab's actual memory
 * footprint, only bound future growth). No-op if the battle isn't ready.
 * Deliberately leaves g_bounds_known[matchIdx] set - the resolved
 * rowid_lo/rowid_hi cost two sqlite3_int64s and stay correct forever, no
 * need to re-bisect on a future re-prime. A failed DROP (e.g. losing a race
 * against a prefetch connection's brief SHARED lock - see
 * sqlite3_vfs_mem.c's lock state machine) isn't a correctness bug: whether
 * or not the drop actually happened, the next access's CREATE INDEX IF NOT
 * EXISTS + fresh sqlite3_prepare_v2 converge correctly either way, so this
 * only counts it (g_evict_failures) rather than retrying. */
int replay_evict_battle(int matchIdx) {
    if (!g_battle_ready[matchIdx]) return 0;
    sqlite3_finalize(g_stmt_agent_states_battle[matchIdx]);
    g_stmt_agent_states_battle[matchIdx] = 0;
    char sql[64];
    build_battle_drop_index_sql(sql, matchIdx);
    if (run_sql(sql) != SQLITE_OK) g_evict_failures++;
    g_battle_ready[matchIdx] = 0;
    return 0;
}

/* Bitmask of which battles are currently ready (index+statement built) -
 * MAX_MATCHES=16 fits comfortably in an int. The reporting channel for
 * eviction: NOT a "last evicted index" scalar (an earlier draft of this
 * feature had one) - build_frame_at_time() calls fetch_positions() twice
 * per frame (tickA/tickB, see below), so a boundary-straddling frame under
 * a tight budget could evict twice in one call, clobbering a single-slot
 * value before JS ever read the first one. A mask read on every relevant
 * message is idempotent and can't lose events no matter how many evictions
 * happened in between - JS diffs it against its own primedBattles Set. */
int replay_get_battle_ready_mask(void) {
    int mask = 0;
    for (int i = 0; i < g_match_count; i++) if (g_battle_ready[i]) mask |= (1 << i);
    return mask;
}

/* Resolves matchIdx's [rowid_lo, rowid_hi] agent_states slice if not already
 * known - the same bisection the prefetch worker would have done, just on
 * g_db (the only path when prefetch never ran). Deliberately just the
 * bisection, not the index-build/eviction that follows it in
 * replay_ensure_battle_ready() below - factored out so a read-only "what's
 * this battle's rowid range" query (the CURRENT_BATTLE_ROWID_LO/HI() SQL
 * functions, see common_finish_load_setup) can resolve it without the
 * heavier side effect of possibly evicting another battle just to answer a
 * read. */
static void ensure_bounds_known(int matchIdx) {
    if (g_bounds_known[matchIdx]) return;
    MatchInfo *m = &g_matches[matchIdx];
    if (g_as_rowid_min < 0) agent_states_rowid_span_on(g_db, &g_as_rowid_min, &g_as_rowid_max);
    m->rowid_lo = lower_bound_rowid_on(g_stmt_id_lookup, g_as_rowid_min, g_as_rowid_max, m->start_tick_id);
    sqlite3_int64 hi = upper_bound_rowid_on(g_stmt_id_lookup, g_as_rowid_min, g_as_rowid_max, m->end_tick_id) - 1;
    m->rowid_hi = (hi >= m->rowid_lo) ? hi : m->rowid_lo - 1; /* empty slice guard */
    g_bounds_known[matchIdx] = 1;
}

/* Shared memory-budget predicate - see replay_internal.h's own comment on
 * why replay_export.c's roster/corpse summary cache shares this exact check
 * rather than tracking a second, separate budget. */
int replay_is_over_priming_budget(void) {
    return g_priming_budget_bytes > 0 && replay_get_playback_heap_bytes() >= g_priming_budget_bytes;
}

/* Deliberately NOT chunked, despite this rework's plan originally scoping a
 * "chunk this CREATE INDEX into sub-ranges" phase to bound worst-case
 * per-RAF stall - benchmarked directly first (a temporary debug export
 * wrapping exactly this call in performance.now(), evict+rebuild via the
 * real production path, not an approximation) and found unnecessary:
 * single-shot CREATE INDEX for this project's largest real fixture's
 * biggest individual battles (250K-330K agent_states rows) measured 1-14ms
 * end to end, repeatedly - comfortably under one 60fps frame budget
 * (16.7ms), nowhere near the multi-second stalls the lag concern this
 * rework addresses was based on. Chunking would have required a much
 * larger, riskier change too: splitting this single WHERE id BETWEEN lo AND
 * hi index into N sub-range indexes would make fetch_positions()'s existing
 * full-range query (which needs the SAME literal [lo,hi] bounds as one
 * index to stay index-eligible at all - see this function's own bisection
 * comment above) stop matching any single index, silently falling back to a
 * full table scan on this project's hottest per-frame path - real risk for
 * zero measured benefit. The actual expensive, worth-hiding-from-the-
 * synchronous-path operation turned out to be the canonical roster/corpse
 * WITH RECURSIVE derivation (multiple real seconds on this same fixture,
 * confirmed via manual testing) - already addressed by the roster/corpse
 * summary cache (replay_export.c's g_rc_cache /
 * replay_prewarm_battle_summary) added earlier in this rework, which moves
 * that cost off the synchronous path the same way this function already
 * does for the (measured-cheap) agent_states index. */
int replay_ensure_battle_ready(int matchIdx) {
    if (matchIdx < 0 || matchIdx >= g_match_count) return 0;
    if (g_battle_ready[matchIdx]) return 0;

    /* Correctness-critical path (see fetch_positions()'s self-healing call
     * below) - this must always succeed regardless of memory pressure, but
     * still tries to stay under budget when it can: if already over budget,
     * free room by evicting whichever OTHER ready battle is farthest away
     * first. Purely best-effort - falls through to the unconditional build
     * below either way. This is "evict things... if needed to play the
     * battle" from the feature request. */
    if (replay_is_over_priming_budget()) {
        int victim = pick_farthest_primed_battle(matchIdx);
        if (victim >= 0) replay_evict_battle(victim);
    }

    MatchInfo *m = &g_matches[matchIdx];
    ensure_bounds_known(matchIdx);

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

/* Proactive-only counterpart to replay_ensure_battle_ready above, for
 * prefetch-ahead-of-cursor requests (never for the battle actually needed
 * right now - that always goes through replay_ensure_battle_ready directly,
 * which must always succeed). This one may decline: under a tight budget it
 * only evicts-and-builds when matchIdx would genuinely be a closer-to-
 * cursor thing to keep warm than whatever it would have to sacrifice -
 * otherwise it does nothing and reports back "declined" (see
 * replay-worker.js's runPrimeBattle). Without this check, proactively
 * priming a battle that's no closer than the eviction victim would just
 * evict-and-immediately-rebuild forever as the prefetch scheduler keeps
 * walking outward from the cursor - thrashing instead of making progress.
 * "It should stop" from the feature request. */
int replay_try_prime_battle(int matchIdx, int currentMatchIdx) {
    if (matchIdx < 0 || matchIdx >= g_match_count) return -1;
    if (g_battle_ready[matchIdx]) return 0;

    if (replay_is_over_priming_budget()) {
        int victim = pick_farthest_primed_battle(currentMatchIdx);
        double target_dt, victim_dt;
        if (currentMatchIdx >= 0 && currentMatchIdx < g_match_count) {
            target_dt = g_matches[matchIdx].start_time - g_matches[currentMatchIdx].start_time;
            if (target_dt < 0) target_dt = -target_dt;
        } else {
            target_dt = 0; /* no known cursor - treat matchIdx as maximally close, never worth evicting for */
        }
        if (victim < 0) return 1; /* nothing to evict, and building would grow past budget - decline */
        victim_dt = g_matches[victim].start_time - g_matches[currentMatchIdx].start_time;
        if (victim_dt < 0) victim_dt = -victim_dt;
        if (victim_dt <= target_dt) return 1; /* victim is no farther than matchIdx would be - not worth it, decline */
        replay_evict_battle(victim);
    }

    return replay_ensure_battle_ready(matchIdx);
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

/* ---- rendering-query engine (SQL-driven, replaces the old hardcoded
 * g_frame_buffer emission) ---------------------------------------------
 *
 * Phase 4 of the SQL-rendering rework: rendering reads from two compiled-in
 * default queries (sql/default_render_corpses.sql,
 * default_render_living_agents.sql) instead of the hardcoded corpse/living
 * emission loops this replaces - now reading main.agent_states directly
 * (joined against "b"'s own arbitrary, user-editable roster_history/corpses
 * tables for team/kind - see export_create_battledb_schema's own comment),
 * not a fixed C-populated staging table. A future phase makes this list
 * user-editable (the @KIND/@CACHE/@INTERPOLATE directives those two files
 * already carry as comments); this phase only has to prove the
 * query-driven path itself works, pixel-identical to the old hardcoded
 * one, for exactly these two.
 *
 * Two-stage per slot: the SQL side (ensure_render_query_rows) only re-runs
 * when tickA_id actually changes, producing tickA-and-optionally-tickB
 * rows; the blend side (blend_render_slot) runs every RAF (cheap - a plain
 * per-row lerp, no SQL), mirroring exactly what the OLD hardcoded
 * interpolation math already did, just generalized from "the agent_states
 * table" to "whichever rows this slot's query returned".
 *
 * Interpolation (@INTERPOLATE on, e.g. living_agents) is resolved by
 * running the query TWICE - once as-is (tickA), once with every
 * CURRENT_TICK() call textually replaced by CURRENT_TICK_B() (tickB) - and
 * LEFT JOINing the two on the query's own `row_key` column. The same
 * textual-substitution technique main.js already uses client-side for
 * nato_symbol's own tickB variant (buildNatoSymbolTickBQuery - see
 * sqlfn_current_tick_b's own comment), applied here on the C side instead
 * since @KIND=dots stays entirely server-side. This replaces an earlier
 * design (a LEFT JOIN against a dedicated rb.frame_state_b table) that
 * only worked because frame_state_a/b were themselves fixed, C-populated
 * tables - now that "b"'s schema is arbitrary and user-editable (see
 * replay_export.c's export_create_battledb_schema), there is no fixed
 * table shape left to join against; re-running the user's own query text
 * with the tick swapped is the general tool that works for ANY query. */
/* Phase 5: a real, dynamic, JS-editable list (up to MAX_RENDER_QUERIES) -
 * replacing Phase 4's fixed 2-slot corpses/living_agents pair. JS owns the
 * canonical ordered list (including @KIND=chat entries, which never reach
 * this engine at all - chat keeps using refreshChatFromQuery/
 * renderChatMessages, see main.js) and is the ONLY thing that parses
 * @KIND/@CACHE/@INTERPOLATE directive comments; this engine is handed
 * already-decided execution parameters (interpolate, shape) per slot rather
 * than parsing directives itself, and JS always resubmits the FULL ordered
 * dots-kind sublist (via replay_render_query_configure per slot +
 * replay_render_query_set_count to trim any now-unused trailing slots)
 * whenever the list changes at all - add/remove/reorder/edit/enable/disable
 * are all just "resubmit", never an incremental list-surgery primitive.
 * Small, infrequent list, so this is cheap and avoids an entire class of
 * index-shifting bugs a real insert/remove/move API would risk. */
#define MAX_RENDER_QUERIES 16
#define RENDER_QUERY_LAST_ERROR_SIZE 256

typedef struct RenderRow {
    float x, y, r, g, b;
    float bx, by;         /* tickB position, only meaningful if has_b */
    unsigned char has_b;
} RenderRow;

/* @CACHE modes, in increasing order of staleness-tolerance. RENDER_CACHE_TICK
 * (default) rebuilds whenever tickA_id changes - once per real tick, not
 * every RAF. RENDER_CACHE_LIVE bypasses that gate entirely, re-running every
 * single build_frame_at_time call - the explicit, UI-labeled perf-tradeoff
 * escape hatch for a query that reads something that changes every frame
 * without a tick changing (e.g. CURSOR_X()/CURSOR_Y()). RENDER_CACHE_NONE is
 * the opposite extreme: build once per active battle and never again
 * automatically, regardless of how many ticks pass - for a query whose
 * result is genuinely battle-wide rather than per-tick (a whole-battle
 * heatmap, a fixed start/end marker, anything scoped by
 * CURRENT_BATTLE_TICK_START()/END() rather than CURRENT_TICK()), where
 * re-deriving it on every tick change would just be wasted work recomputing
 * the identical answer. Values match the numbering replay_render_query_configure's
 * own `cache` parameter already used before RENDER_CACHE_NONE existed (0/1
 * were a plain tick/live boolean) - kept stable so old callers passing 0 or 1
 * keep meaning exactly what they always meant. */
#define RENDER_CACHE_TICK 0
#define RENDER_CACHE_LIVE 1
#define RENDER_CACHE_NONE 2

typedef struct RenderQuerySlot {
    char *sql;             /* malloc'd; NULL = slot unused */
    int interpolate;
    int shape;
    int enabled;
    int cache_mode;         /* RENDER_CACHE_TICK/LIVE/NONE - see that enum's own comment */
    sqlite3_int64 built_for_tick_id; /* cache key - see this section's own header comment. -1 = never built (or force-rebuild requested) */
    int built_for_match;    /* RENDER_CACHE_NONE's own second cache key - which battle the current rows were built for */
    RenderRow *rows;
    int rows_capacity, rows_count;
    float *out_buf;   /* [x,y,r,g,b] per point, blended - what JS actually reads */
    int out_capacity, out_count;
    char last_error[RENDER_QUERY_LAST_ERROR_SIZE];
    int last_error_offset; /* -1 = none, see sqlite3_error_offset()-based offsets elsewhere in this codebase */
} RenderQuerySlot;
static RenderQuerySlot g_render_slots[MAX_RENDER_QUERIES];
static int g_render_query_count = 0; /* how many of slots 0..count-1 are configured (may include disabled ones) */

static int render_slot_valid(int slotIdx) { return slotIdx >= 0 && slotIdx < g_render_query_count; }

int replay_get_render_slot_count(void) { return g_render_query_count; }
float *replay_get_render_buffer_ptr(int slotIdx) {
    return render_slot_valid(slotIdx) ? g_render_slots[slotIdx].out_buf : 0;
}
int replay_get_render_buffer_count(int slotIdx) {
    return (render_slot_valid(slotIdx) && g_render_slots[slotIdx].enabled) ? g_render_slots[slotIdx].out_count : 0;
}
int replay_get_render_shape(int slotIdx) {
    return render_slot_valid(slotIdx) ? g_render_slots[slotIdx].shape : 0;
}
const char *replay_render_query_get_last_error(int slotIdx) {
    return render_slot_valid(slotIdx) ? g_render_slots[slotIdx].last_error : "";
}
int replay_render_query_get_last_error_offset(int slotIdx) {
    return render_slot_valid(slotIdx) ? g_render_slots[slotIdx].last_error_offset : -1;
}

/* Every rendering query ends with a trailing ';' by normal SQL-file/editor
 * convention - fine on its own, but fatal once wrapped as a parenthesized
 * subquery below ("FROM (...;) q" is a syntax error, a semicolon can't
 * appear inside a parenthesized expression). Returns the length to use with
 * %.*s so the wrap below never includes it. Confirmed directly during Phase
 * 4 development: without this trim, prepare failed silently on every
 * interpolated query, making living agents render as permanently empty. */
static int sql_len_without_trailing_semicolon(const char *sql) {
    int len = (int)strlen(sql);
    while (len > 0 && (sql[len-1] == ' ' || sql[len-1] == '\n' || sql[len-1] == '\r' || sql[len-1] == '\t')) len--;
    if (len > 0 && sql[len-1] == ';') len--;
    return len;
}

/* Small self-contained copy of replay_export.c's identical helper - kept
 * separate rather than sharing plumbing across the module boundary for
 * something this size (same convention that file's own small helpers,
 * e.g. sha256_hex_of, already follow). */
static char *str_replace_all(const char *src, const char *find, const char *repl) {
    size_t find_len = strlen(find), repl_len = strlen(repl), src_len = strlen(src);
    size_t count = 0;
    for (const char *p = src; (p = strstr(p, find)) != 0; p += find_len) count++;
    size_t extra = (repl_len > find_len) ? (repl_len - find_len) : 0;
    char *out = (char *)malloc(src_len + count * extra + 1);
    if (!out) return 0;
    char *w = out;
    const char *r = src;
    const char *hit;
    while ((hit = strstr(r, find)) != 0) {
        size_t chunk = (size_t)(hit - r);
        memcpy(w, r, chunk); w += chunk;
        memcpy(w, repl, repl_len); w += repl_len;
        r = hit + find_len;
    }
    strcpy(w, r);
    return out;
}

/* Builds the actual text to prepare for slotIdx - the tickA/tickB
 * self-join (see this section's own header comment on why a textual
 * CURRENT_TICK()->CURRENT_TICK_B() rewrite, not a join against a fixed
 * table) if s->interpolate, else the slot's own text unchanged.
 *
 * RENDER_CACHE_NONE always skips the REAL tickB join, even with
 * @INTERPOLATE on: blend_render_slot's per-row lerp uses g_last_alpha,
 * which is recomputed fresh every RAF from the CURRENT tickA/tickB pair -
 * but a RENDER_CACHE_NONE slot's rows were captured once, from whatever
 * tickA/tickB pair happened to be current at build time, and never rebuilt
 * since. Confirmed directly: blending those long-stale bx/by values
 * against a freshly-computed, unrelated alpha doesn't hold still (the
 * whole point of "none") or track the real tick (the whole point of
 * interpolation) - it just drifts by a small, essentially arbitrary amount
 * every frame, silently wrong either way you'd want to read it.
 * Interpolation is a tick-to-tick blending concept; RENDER_CACHE_NONE's
 * rows are deliberately NOT tied to a tick, so there is no meaningful
 * tickB to interpolate toward - showing tickA's own value un-blended is
 * the only interpretation that stays actually correct.
 *
 * Still wraps with the SAME 8-column shape the real interpolated case
 * produces (just with fb.x/y/row_key hardcoded rather than a genuine
 * tickB subquery + join) rather than returning s->sql bare: the query's
 * own text still has a leading `row_key` column (required for the ordinary
 * interpolated case's join condition) that the outer wrapper strips down
 * to the plain x/y/color columns ensure_render_query_rows expects at fixed
 * indices - returning the raw, un-wrapped text here would leave row_key
 * sitting in column 0, silently shifting every column after it by one.
 * Caller must sqlite3_free() a non-null result. */
static char *build_query_text_for_slot(RenderQuerySlot *s) {
    if (!s->sql) return 0;
    if (!s->interpolate) return sqlite3_mprintf("%s", s->sql);
    int base_len = sql_len_without_trailing_semicolon(s->sql);
    char *tickA_text = sqlite3_mprintf("%.*s", base_len, s->sql);
    if (!tickA_text) return 0;
    if (s->cache_mode == RENDER_CACHE_NONE) {
        char *wrapped = sqlite3_mprintf(
            "SELECT q.x, q.y, q.color_r, q.color_g, q.color_b, 0.0, 0.0, 0 FROM (%s) q",
            tickA_text);
        sqlite3_free(tickA_text);
        return wrapped;
    }
    char *tickB_text = str_replace_all(tickA_text, "CURRENT_TICK()", "CURRENT_TICK_B()");
    if (!tickB_text) { sqlite3_free(tickA_text); return 0; }
    char *wrapped = sqlite3_mprintf(
        "SELECT q.x, q.y, q.color_r, q.color_g, q.color_b, fb.x, fb.y, (fb.row_key IS NOT NULL) "
        "FROM (%s) q LEFT JOIN (%s) fb ON fb.row_key = q.row_key",
        tickA_text, tickB_text);
    sqlite3_free(tickA_text);
    free(tickB_text);
    return wrapped;
}

static void render_query_set_error(RenderQuerySlot *s, const char *msg, int offset) {
    int i = 0;
    if (msg) while (msg[i] && i < RENDER_QUERY_LAST_ERROR_SIZE - 1) { s->last_error[i] = msg[i]; i++; }
    s->last_error[i] = 0;
    s->last_error_offset = offset;
}
static void render_query_clear_error(RenderQuerySlot *s) { s->last_error[0] = 0; s->last_error_offset = -1; }

/* Re-runs slotIdx's query only when tickA_id has actually changed since last
 * built - the expensive half, gated for the same reason build_frame_at_time's
 * own replay_ensure_db_view(2) call is (build_frame_at_time runs every RAF,
 * not just on real tick changes). "b" is guaranteed attached and populated
 * for the active battle by the time this runs - it's only ever called after
 * that same replay_ensure_db_view(2) call in build_frame_at_time below. */
static void ensure_render_query_rows(int slotIdx, sqlite3_int64 tickA_id) {
    RenderQuerySlot *s = &g_render_slots[slotIdx];
    if (!s->enabled || !s->sql) { s->rows_count = 0; return; }
    if (s->cache_mode == RENDER_CACHE_NONE) {
        if (s->built_for_tick_id != -1 && s->built_for_match == g_active_match_index) return;
    } else if (s->cache_mode == RENDER_CACHE_TICK && s->built_for_tick_id == tickA_id) {
        return;
    }
    s->built_for_tick_id = tickA_id;
    s->built_for_match = g_active_match_index;
    s->rows_count = 0;

    char *wrapped = build_query_text_for_slot(s);
    if (!wrapped) return;
    sqlite3_stmt *stmt = 0;
    int rc = sqlite3_prepare_v2(g_db, wrapped, -1, &stmt, 0);
    if (rc != SQLITE_OK) {
        render_query_set_error(s, sqlite3_errmsg(g_db), sqlite3_error_offset(g_db));
        sqlite3_free(wrapped);
        return;
    }
    sqlite3_free(wrapped);

    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (s->rows_count >= s->rows_capacity) {
            int new_cap = s->rows_capacity ? s->rows_capacity * 2 : 256;
            RenderRow *nr = (RenderRow *)realloc(s->rows, sizeof(RenderRow) * (size_t)new_cap);
            if (!nr) break;
            s->rows = nr;
            s->rows_capacity = new_cap;
        }
        RenderRow *row = &s->rows[s->rows_count++];
        row->x = (float)sqlite3_column_double(stmt, 0);
        row->y = (float)sqlite3_column_double(stmt, 1);
        row->r = (float)sqlite3_column_double(stmt, 2);
        row->g = (float)sqlite3_column_double(stmt, 3);
        row->b = (float)sqlite3_column_double(stmt, 4);
        // build_query_text_for_slot always wraps to this same 8-column
        // shape whenever s->interpolate is set (RENDER_CACHE_NONE included -
        // it hardcodes columns 5/6/7 to 0.0/0.0/0 rather than skipping the
        // wrap, see that function's own comment on why), so this check only
        // needs to mirror s->interpolate itself.
        if (s->interpolate) {
            row->has_b = (unsigned char)sqlite3_column_int(stmt, 7);
            row->bx = (float)sqlite3_column_double(stmt, 5);
            row->by = (float)sqlite3_column_double(stmt, 6);
        } else {
            row->has_b = 0;
        }
    }
    if (rc == SQLITE_DONE) render_query_clear_error(s);
    else render_query_set_error(s, sqlite3_errmsg(g_db), sqlite3_error_offset(g_db));
    sqlite3_finalize(stmt);
}

/* Cheap per-row lerp into the output buffer JS actually reads - runs every
 * RAF (via build_frame_at_time), never touches SQL. Mirrors the OLD
 * hardcoded living-agent interpolation math exactly:
 * x + (bx - x) * alpha, only applied when a tickB match exists. */
static void blend_render_slot(int slotIdx, float alpha) {
    RenderQuerySlot *s = &g_render_slots[slotIdx];
    if (s->rows_count > s->out_capacity) {
        int new_cap = s->out_capacity ? s->out_capacity * 2 : 256;
        while (new_cap < s->rows_count) new_cap *= 2;
        float *nb = (float *)realloc(s->out_buf, sizeof(float) * 5 * (size_t)new_cap);
        if (nb) { s->out_buf = nb; s->out_capacity = new_cap; }
    }
    int out = 0;
    for (int i = 0; i < s->rows_count && out < s->out_capacity; i++) {
        RenderRow *row = &s->rows[i];
        float x = row->x, y = row->y;
        if (row->has_b) {
            x = x + (row->bx - x) * alpha;
            y = y + (row->by - y) * alpha;
        }
        s->out_buf[out * 5 + 0] = x;
        s->out_buf[out * 5 + 1] = y;
        s->out_buf[out * 5 + 2] = row->r;
        s->out_buf[out * 5 + 3] = row->g;
        s->out_buf[out * 5 + 4] = row->b;
        out++;
    }
    s->out_count = out;
}

/* ---- Phase 5: JS-driven configuration of the render-query list --------- */

#define RENDER_QUERY_TEXT_BUF_SIZE 16384
static char g_render_query_text_buf[RENDER_QUERY_TEXT_BUF_SIZE];
unsigned char *replay_get_render_query_text_buf_ptr(void) { return (unsigned char *)g_render_query_text_buf; }

/* Sets slot[slotIdx]'s SQL text (from the shared buffer above, len bytes)
 * and execution parameters, validating the text immediately (a real
 * sqlite3_prepare_v2 - discarded right after, ensure_render_query_rows
 * prepares its own fresh statement on the next actual frame either way) so
 * the UI gets real error/offset feedback the moment a query is edited,
 * matching the same sqlite3_error_offset()-based reporting already used for
 * generator scripts/the SQL terminal elsewhere in this codebase. Always
 * forces a rebuild on the next frame regardless of validation outcome (a
 * failing query still needs its cached "empty" state applied - see
 * ensure_render_query_rows's own enabled/sql-null short-circuit). Grows
 * g_render_query_count if slotIdx is the next new slot; JS is responsible
 * for calling replay_render_query_set_count afterward if the list actually
 * got shorter (a slot being reconfigured never implies the list shrank). */
int replay_render_query_configure(int slotIdx, int len, int interpolate, int shape, int enabled, int cacheMode) {
    if (slotIdx < 0 || slotIdx >= MAX_RENDER_QUERIES) return -1;
    if (len < 0) len = 0;
    if (len > RENDER_QUERY_TEXT_BUF_SIZE - 1) len = RENDER_QUERY_TEXT_BUF_SIZE - 1;
    g_render_query_text_buf[len] = 0;

    RenderQuerySlot *s = &g_render_slots[slotIdx];
    free(s->sql);
    size_t slen = strlen(g_render_query_text_buf);
    s->sql = (char *)malloc(slen + 1);
    if (!s->sql) { render_query_set_error(s, "out of memory", -1); return -2; }
    memcpy(s->sql, g_render_query_text_buf, slen + 1);
    s->interpolate = interpolate;
    s->shape = shape;
    s->enabled = enabled;
    s->cache_mode = cacheMode;
    s->built_for_tick_id = -1; /* force rebuild on next frame regardless of tick */
    s->built_for_match = -1;
    s->rows_count = 0;
    s->out_count = 0; /* clear stale output immediately, don't wait for the next frame's rebuild */
    if (slotIdx + 1 > g_render_query_count) g_render_query_count = slotIdx + 1;

    char *wrapped = build_query_text_for_slot(s);
    if (wrapped) {
        sqlite3_stmt *stmt = 0;
        if (sqlite3_prepare_v2(g_db, wrapped, -1, &stmt, 0) != SQLITE_OK) {
            render_query_set_error(s, sqlite3_errmsg(g_db), sqlite3_error_offset(g_db));
        } else {
            render_query_clear_error(s);
        }
        sqlite3_finalize(stmt);
        sqlite3_free(wrapped);
    }
    return 0;
}

/* Trims any trailing slots a shorter list left stale (e.g. the user deleted
 * the last query in the list) - frees their SQL/rows/output. JS always
 * resubmits the full list in order via replay_render_query_configure first,
 * then calls this with the new true count; slots below newCount are left
 * completely untouched (their own next replay_render_query_configure call,
 * if any, handles them). */
void replay_render_query_set_count(int newCount) {
    if (newCount < 0) newCount = 0;
    if (newCount > MAX_RENDER_QUERIES) newCount = MAX_RENDER_QUERIES;
    for (int i = newCount; i < g_render_query_count; i++) {
        RenderQuerySlot *s = &g_render_slots[i];
        free(s->sql); s->sql = 0;
        free(s->rows); s->rows = 0; s->rows_capacity = 0; s->rows_count = 0;
        free(s->out_buf); s->out_buf = 0; s->out_capacity = 0; s->out_count = 0;
        s->built_for_tick_id = -1;
        s->enabled = 0;
        render_query_clear_error(s);
    }
    g_render_query_count = newCount;
}

/* Compiled-in defaults, exposed read-only so main.js can populate its
 * Rendering Queries panel (initial list AND "Reset to Defaults") from the
 * exact same source seed_default_render_queries() below uses - one
 * definition of "the defaults" (sql/default_render_*.sql, compiled in via
 * scripts/gen_canonical_sql_header.py), never a second hand-copied JS
 * literal that could drift from it. Index 0 = corpses, 1 = living_agents
 * (matches seed_default_render_queries()'s own slot assignment - both
 * actually pushed to this C engine); index 2 = chat, included here too even
 * though it's a JS-only kind that never reaches this engine at all (see
 * this file's own header comment on the render-query section) - main.js's
 * initDefaultRenderQueries builds its whole 3-entry list from ONE call to
 * this getter family, so chat's default text belongs here for the same
 * "one definition of the defaults" reason the other two are. */
int replay_get_default_render_query_count(void) { return 3; }
const char *replay_get_default_render_query_sql(int idx) {
    if (idx == 0) return DEFAULT_RENDER_CORPSES_SQL;
    if (idx == 1) return DEFAULT_RENDER_LIVING_AGENTS_SQL;
    if (idx == 2) return DEFAULT_RENDER_CHAT_SQL;
    return "";
}
int replay_get_default_render_query_interpolate(int idx) { return idx == 1; }
int replay_get_default_render_query_shape(int idx) { (void)idx; return 0; }

/* The @KIND nato_symbol sample/template (sql/sample_render_nato_symbols.sql) -
 * deliberately a SEPARATE getter from the defaults above, not a 4th default
 * index: it's not part of the initial list a fresh load seeds (a user who
 * never opens the Rendering Queries panel sees zero visual change - see that
 * .sql file's own header comment), only offered as a pre-filled template
 * when the panel's Kind control is switched to nato_symbol on an otherwise-
 * untouched new query (main.js's updateRenderQueryField). */
const char *replay_get_sample_nato_symbol_sql(void) { return SAMPLE_RENDER_NATO_SYMBOLS_SQL; }

/* Seeds slots 0/1 with the compiled-in default queries (corpses,
 * living_agents) via the exact same replay_render_query_configure() path JS
 * uses, so a fresh load renders correctly even before main.js's Rendering
 * Queries panel ever pushes anything of its own. Called once per load, from
 * replay_finish_load/replay_finish_load_battle_file - never from
 * build_frame_at_time, so a user who clears the list to zero queries stays
 * cleared for the rest of the session, exactly like generator-script
 * customization already persists until an explicit reset elsewhere in this
 * codebase. A harmless trial-prepare failure here ("b" isn't attached yet
 * on a brand new load - replay_ensure_db_view(2) only runs inside
 * build_frame_at_time, on the first real tick change) self-heals on the
 * very first real frame, same as any other configure-before-first-frame
 * call would. */
static void seed_default_render_queries(void) {
    size_t corpses_len = strlen(DEFAULT_RENDER_CORPSES_SQL);
    memcpy(g_render_query_text_buf, DEFAULT_RENDER_CORPSES_SQL,
           corpses_len < RENDER_QUERY_TEXT_BUF_SIZE ? corpses_len + 1 : RENDER_QUERY_TEXT_BUF_SIZE);
    replay_render_query_configure(0, (int)corpses_len, /*interpolate=*/0, /*shape=*/0, /*enabled=*/1, /*cacheMode=*/RENDER_CACHE_TICK);

    size_t living_len = strlen(DEFAULT_RENDER_LIVING_AGENTS_SQL);
    memcpy(g_render_query_text_buf, DEFAULT_RENDER_LIVING_AGENTS_SQL,
           living_len < RENDER_QUERY_TEXT_BUF_SIZE ? living_len + 1 : RENDER_QUERY_TEXT_BUF_SIZE);
    replay_render_query_configure(1, (int)living_len, /*interpolate=*/1, /*shape=*/0, /*enabled=*/1, /*cacheMode=*/RENDER_CACHE_TICK);

    replay_render_query_set_count(2);
}

static double g_relative_time = 0.0;
static sqlite3_int64 g_current_tick_id = -1; /* tickA of the most recent build_frame_at_time() call - backs CURRENT_TICK() (the SQL variable function) and replay_get_current_tick_id() */
static sqlite3_int64 g_current_tick_b_id = -1; /* tickB of the most recent build_frame_at_time() call - backs CURRENT_TICK_B(), read both by main.js's own nato_symbol tickB query (a JS-only kind - see sqlfn_current_tick_b's own comment) and by build_query_text_for_slot's C-side textual rewrite for @KIND=dots interpolation - the same technique, used on both sides of the JS/C boundary for the two different render surfaces */

int replay_get_active_match_index(void) { return g_active_match_index; }
double replay_get_relative_time(void) { return g_relative_time; }
/* Exposed so main.js can gate chat re-querying on "did the tick actually
 * change" instead of re-running the chat SQL query on every animation frame
 * (see main.js's refreshChatFromQuery) - a double, not int, because tick ids
 * are sqlite3_int64 and JS's Number safely covers that range anyway. */
double replay_get_current_tick_id(void) { return (double)g_current_tick_id; }

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

/* Phase 6: the same tickA/tickB blend fraction blend_render_slot() already
 * uses for @KIND=dots, exposed read-only so main.js's nato_symbol dom-overlay
 * (which never reaches this C engine at all - a JS-only kind, see this
 * section's own header comment) can blend ITS OWN tickA/tickB row pairs
 * every RAF with the exact same fraction, instead of re-deriving it from the
 * tick-time table client-side (which main.js doesn't otherwise need to keep
 * around at all). */
static float g_last_alpha = 0.0f;
float replay_get_last_alpha(void) { return g_last_alpha; }

/* Gates build_frame_at_time's replay_ensure_db_view(2) call to real tick
 * changes only - see that call site's own comment. */
static sqlite3_int64 g_battledb_synced_tick_id = -1;

static void build_frame_at_time(double t) {
    if (g_tick_count == 0) { for (int s = 0; s < g_render_query_count; s++) g_render_slots[s].out_count = 0; return; }
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
    g_last_alpha = alpha;

    resync_roster_to(tickA_id);

    memset(g_pos_a_present, 0, sizeof(g_pos_a_present));
    memset(g_pos_b_present, 0, sizeof(g_pos_b_present));
    fetch_positions(tickA_id, g_pos_a_x, g_pos_a_y, g_pos_a_present);

    resync_roster_to(tickB_id); /* cheap: incremental from tickA, already synced */
    fetch_positions(tickB_id, g_pos_b_x, g_pos_b_y, g_pos_b_present);

    // Ensures "b" (the arbitrary, user-editable Battle DB schema - see
    // replay_export.c's export_create_battledb_schema and
    // canonical_roster_history.sql/canonical_corpses.sql's own comments) is
    // attached and populated for the active battle before the render
    // queries below run - self-healing, same role sync_frame_state_tables
    // used to play for the now-removed rb schema. Gated on tickA_id
    // actually changing, NOT called every RAF: build_frame_at_time runs on
    // every RAF-driven 'frame' request (interpolation alpha needs fresh
    // eval every frame), and replay_ensure_db_view's own cache-key check
    // hashes the current derive SQL text on every call - real, avoidable
    // per-frame cost if this ran unconditionally. Ignored return value:
    // "b" not ready this frame just means the render queries below read 0
    // rows (main.agent_states itself is untouched either way) - self-heals
    // the next real tick change, exactly like the old sync always did.
    if (tickA_id != g_battledb_synced_tick_id) {
        g_battledb_synced_tick_id = tickA_id;
        replay_ensure_db_view(2);
    }
    g_current_tick_id = tickA_id; /* backs CURRENT_TICK() and replay_get_current_tick_id() - set before the render queries below in case a future custom query references it */
    g_current_tick_b_id = tickB_id; /* backs CURRENT_TICK_B() - see this section's own header comment above g_last_alpha */

    /* SQL-driven, JS-configured rendering-query list - see this section's
     * own header comment above (ensure_render_query_rows/blend_render_slot/
     * replay_render_query_configure). Slot order IS draw order - list order
     * is draw order, by construction (main.js resubmits slots 0..N-1 in the
     * user's own list order every time it changes). */
    for (int s = 0; s < g_render_query_count; s++) {
        ensure_render_query_rows(s, tickA_id);
        blend_render_slot(s, alpha);
    }

    g_relative_time = 0.0;
    if (g_active_match_index >= 0) g_relative_time = t - g_matches[g_active_match_index].start_time;
}

void replay_advance_to_time(double t) { build_frame_at_time(t); }
void replay_seek_to_time(double t) { build_frame_at_time(t); }

/* Chat has no dedicated cache/cursor here at all - main.js just runs a real
 * SQL query (chats JOIN events, gated by CURRENT_TICK()/CURRENT_BATTLE_TICK_START())
 * through the exact same SQL Terminal execution path a user's own query
 * uses, and fully re-renders the chat panel from the result every time. That
 * makes it trivially correct under scrubbing back and forth (a plain query
 * against "now" can never double-deliver a message the way a monotonic
 * advance-only cursor did) and means a live edit to the chats table via the
 * SQL Terminal shows up immediately, since it's reading the same live table
 * instead of a snapshot copied out at match-activation time. See main.js's
 * refreshChatFromQuery.*/

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

/* binary search for a tick_id's position in g_ticks[] - used by
 * replay_finish_load_battle_file() to resolve a MatchInfo's start/end times
 * from the tick_ids replay_meta stores (see below); the boundary-detection
 * path (scan_matches_via_sql) gets its own times straight from the SQL
 * result set instead, see sql/default_boundary_detection.sql. */
static int tick_index_for_id(sqlite3_int64 tick_id) {
    int lo = 0, hi = g_tick_count - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (g_ticks[mid].id == tick_id) return mid;
        if (g_ticks[mid].id < tick_id) lo = mid + 1; else hi = mid - 1;
    }
    return lo < g_tick_count ? lo : g_tick_count - 1;
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

/* SQL-driven battle-boundary detection - runs the user-modifiable
 * DEFAULT_BOUNDARY_DETECTION_SQL (sql/default_boundary_detection.sql, a
 * faithful port of this project's original hardcoded C heuristic, itself a
 * port of main.js's now-removed processDatabaseAndCompileMatches - or
 * whatever custom text has replaced it, see the boundary-detection
 * generator-script slot, mirroring replay_export.c's r/b DbViewState
 * pattern) and populates g_matches[]/g_nonbattle_spans[] from its result
 * rows instead of walking boundary_indices[]/merged[] in C.
 *
 * Verified against every fixture under testdata/replays_batch/ before this
 * replaced the real call sites: a standalone Python port of the original C
 * heuristic diffed against the raw SQL text (all 24 fixtures matched), then
 * end-to-end through this exact function in a real browser session
 * (23/24 byte-identical to the legacy g_matches[] the old algorithm
 * produced). The one exception, replayLog_2026-08-01_21-12-29.sqlite (20
 * real detected battles), is a DELIBERATE divergence, not a bug: see
 * sql/default_boundary_detection.sql's own comment on the MAX_MATCHES cap -
 * the legacy algorithm's cap check stopped it from even considering
 * boundaries past the 15th accepted match, so its tail-segment step merged
 * everything after that into one oversized final match (2645 ticks vs. a
 * normal few hundred). This function truncates to the true first
 * MAX_MATCHES real matches in chronological order instead. See the
 * boundary-detection section of ui_behavior_tests.js for the standing
 * regression coverage of both the normal-case parity and this documented
 * exception. */
typedef struct BoundarySpanRow {
    sqlite3_int64 start_tick_id, end_tick_id;
    double start_time, end_time;
    int is_battle;
} BoundarySpanRow;

static int scan_matches_via_sql(void) {
    sqlite3_stmt *stmt = 0;
    const char *sql = DEFAULT_BOUNDARY_DETECTION_SQL;
    if (sqlite3_prepare_v2(g_db, sql, -1, &stmt, 0) != SQLITE_OK) { set_error(sqlite3_errmsg(g_db)); return -1; }

    /* Phase 1: fully drain and finalize this statement into a plain array
     * BEFORE calling resolve_match_meta below - resolve_match_meta prepares
     * its own statements against g_db, and this query is a multi-CTE
     * WITH RECURSIVE (temp b-trees for the fold state) that must not have
     * other statements interleaved mid-step. Confirmed directly: calling
     * resolve_match_meta from inside this loop (interleaved with sqlite3_step
     * on `stmt`) made sqlite3_step intermittently fail on 2 of 24 real
     * fixtures - the original C heuristic this replaced avoided this same
     * trap by finalizing its own boundary-tick statement before its
     * merge/segmentation loop ran; this mirrors that same
     * collect-then-process shape. */
    BoundarySpanRow rows[MAX_MATCHES + MAX_NONBATTLE_SPANS];
    int row_count = 0;
    int rc;
    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        if (row_count < (int)(sizeof(rows) / sizeof(rows[0]))) {
            BoundarySpanRow *r = &rows[row_count++];
            r->start_tick_id = sqlite3_column_int64(stmt, 0);
            r->end_tick_id = sqlite3_column_int64(stmt, 1);
            r->start_time = sqlite3_column_double(stmt, 2);
            r->end_time = sqlite3_column_double(stmt, 3);
            r->is_battle = sqlite3_column_int(stmt, 4);
        }
    }
    if (rc != SQLITE_DONE) set_error(sqlite3_errmsg(g_db));
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE) return -1;

    /* Phase 2: stmt is gone now - safe to call resolve_match_meta (its own
     * independent prepare/step/finalize cycles) per accepted match. */
    g_match_count = 0;
    g_nonbattle_span_count = 0;
    for (int i = 0; i < row_count; i++) {
        BoundarySpanRow *r = &rows[i];
        if (r->is_battle) {
            if (g_match_count >= MAX_MATCHES) continue; /* see this function's own header comment on the one fixture this cap affects */
            MatchInfo *m = &g_matches[g_match_count];
            m->start_tick_id = r->start_tick_id;
            m->end_tick_id = r->end_tick_id;
            m->start_time = r->start_time;
            m->end_time = r->end_time;
            resolve_match_meta(m->start_tick_id, &m->scene_no, m->faction_text, sizeof(m->faction_text));
            g_match_count++;
        } else {
            if (g_nonbattle_span_count >= MAX_NONBATTLE_SPANS) continue;
            NonBattleSpan *s = &g_nonbattle_spans[g_nonbattle_span_count];
            s->start_tick_id = r->start_tick_id;
            s->end_tick_id = r->end_tick_id;
            g_nonbattle_span_count++;
        }
    }
    return 0;
}

/* Full "the database changed out from under us, forget every derived
 * replay-engine cache and rebuild lazily as before" reset - used after a
 * checkpoint ROLLBACK TO (sql_checkpoint_revert, sql_terminal.c), since an
 * arbitrary revert can touch anything: agent positions, tick times, match-
 * boundary events, roster spawns/kills. Rather than trying to patch each
 * downstream cache surgically, this tears all of them down and lets the
 * existing self-healing/lazy-rebuild machinery already used everywhere else
 * in this file (replay_ensure_battle_ready, resync_roster_to) redo the real
 * work on next access, against the now-current data - the same philosophy
 * as a fresh load, just without re-reading the tick/index-creation SQL that
 * never needed to change. */
void replay_invalidate_caches_after_revert(void) {
    replay_detach_generator_views(); // r/b/rb are stale relative to a changed main schema too
    for (int i = 0; i < g_match_count; i++) replay_evict_battle(i); // finalize statements, drop per-battle indexes
    memset(g_bounds_known, 0, sizeof(g_bounds_known)); // rowid bounds may have shifted, not just row content
    g_roster_synced_tick_id = (sqlite3_int64)0x7FFFFFFFFFFFFFFFLL; // forces a full roster rebuild on the next resync, any direction
    // "b" was just detached above (stale content, possibly a table that no
    // longer even exists until the next tick change re-attaches it fresh) -
    // without this reset, a revert that lands back on the SAME tickA_id it
    // was already "synced" for would wrongly skip re-syncing (sees no tick
    // change) and read stale/nonexistent "b" tables.
    g_battledb_synced_tick_id = -1;
    g_active_match_index = -1;
    free(g_ticks); g_ticks = 0; g_tick_count = 0;
    load_tick_index();
    scan_matches_via_sql();
    // RENDER_CACHE_NONE slots key their cache on battle index alone (see
    // ensure_render_query_rows), which a revert can defeat: it can change a
    // battle's own roster/kills/positions without changing WHICH battle
    // contains the current tick, so that cache key alone wouldn't notice.
    // RENDER_CACHE_TICK slots would self-heal anyway (g_battledb_synced_tick_id
    // reset above forces a real tick resync), but resetting every slot here
    // uniformly is simpler than reasoning about which modes strictly need it.
    for (int i = 0; i < g_render_query_count; i++) g_render_slots[i].built_for_tick_id = -1;
}

/* ---- SQL variable functions (SQL terminal "VARIABLES" feature) ----------
 * Real SQLite scalar functions (sqlite3_create_function), registered once
 * per g_db below - not text substitution, so they're usable anywhere a
 * value works (WHERE clauses, computed columns, nested expressions) and are
 * genuine SQL rather than a bespoke syntax layered on top. Every one reads
 * live state directly on each call, never cached - a query using
 * CURRENT_TICK() genuinely sees "the tick on screen right now" even while
 * the user is actively scrubbing with the terminal open. Deliberately NOT
 * registered with SQLITE_DETERMINISTIC: that flag tells SQLite the result
 * only depends on its (here, zero) arguments and is safe to constant-fold/
 * reuse within a statement - true for a real deterministic function, false
 * for all of these by design, so marking it would let SQLite silently reuse
 * a stale evaluation. */
static void sqlfn_current_tick(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    if (g_current_tick_id < 0) { sqlite3_result_null(ctx); return; }
    sqlite3_result_int64(ctx, g_current_tick_id);
}
static void sqlfn_current_time(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    sqlite3_result_double(ctx, g_relative_time);
}
/* See g_current_tick_b_id's own comment - lets a JS-only interpolatable
 * rendering query (nato_symbol) fetch its "tickB" row set by literally
 * re-running its own text with CURRENT_TICK() swapped for CURRENT_TICK_B()
 * (main.js's buildNatoSymbolTickBQuery), rather than needing a dedicated
 * frame_state_b-style table the way @KIND=dots has. */
static void sqlfn_current_tick_b(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    if (g_current_tick_b_id < 0) { sqlite3_result_null(ctx); return; }
    sqlite3_result_int64(ctx, g_current_tick_b_id);
}
static void sqlfn_current_battle(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    if (g_active_match_index < 0 || g_active_match_index >= g_match_count) { sqlite3_result_null(ctx); return; }
    sqlite3_result_text(ctx, g_matches[g_active_match_index].faction_text, -1, SQLITE_TRANSIENT);
}
static void sqlfn_current_battle_tick_start(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    if (g_active_match_index < 0 || g_active_match_index >= g_match_count) { sqlite3_result_null(ctx); return; }
    sqlite3_result_int64(ctx, g_matches[g_active_match_index].start_tick_id);
}
static void sqlfn_current_battle_tick_end(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    if (g_active_match_index < 0 || g_active_match_index >= g_match_count) { sqlite3_result_null(ctx); return; }
    sqlite3_result_int64(ctx, g_matches[g_active_match_index].end_tick_id);
}
/* The two ROWID variants resolve the bisection on demand (ensure_bounds_known,
 * just above replay_ensure_battle_ready) rather than requiring the battle to
 * already be fully "ready" (index + prepared statement built) - a read-only
 * variable lookup shouldn't have to pay for, or risk evicting another
 * primed battle to make room for, a full battle build it doesn't need. */
static void sqlfn_current_battle_rowid_lo(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    if (g_active_match_index < 0 || g_active_match_index >= g_match_count) { sqlite3_result_null(ctx); return; }
    ensure_bounds_known(g_active_match_index);
    sqlite3_result_int64(ctx, g_matches[g_active_match_index].rowid_lo);
}
static void sqlfn_current_battle_rowid_hi(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    if (g_active_match_index < 0 || g_active_match_index >= g_match_count) { sqlite3_result_null(ctx); return; }
    ensure_bounds_known(g_active_match_index);
    sqlite3_result_int64(ctx, g_matches[g_active_match_index].rowid_hi);
}
/* World-space position of the crosshair fixed at screen center - NOT the
 * mouse pointer. The camera is centered on (cam_x, cam_y) by construction
 * (main.c's ortho projection is built centered there), so the crosshair's
 * world position simply IS (cam_x, cam_y) - no inverse-projection math
 * needed. cam_x/cam_y themselves live in main.wasm, a separate WASM
 * instance/memory from this one (the graphics module vs. the SQL engine) -
 * main.js is the only thing that can see both, so it reads them and forwards
 * the value here via replay_set_cursor_world_pos() right before every query. */
static double g_cursor_world_x = 0.0, g_cursor_world_y = 0.0;
void replay_set_cursor_world_pos(double x, double y) { g_cursor_world_x = x; g_cursor_world_y = y; }
static void sqlfn_cursor_x(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    sqlite3_result_double(ctx, g_cursor_world_x);
}
static void sqlfn_cursor_y(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc; (void)argv;
    sqlite3_result_double(ctx, g_cursor_world_y);
}

typedef void (*sql_scalar_fn)(sqlite3_context *, int, sqlite3_value **);
static int register_sql_variable_functions(void) {
    static const struct { const char *name; sql_scalar_fn fn; } vars[] = {
        { "CURRENT_TICK",              sqlfn_current_tick },
        { "CURRENT_TICK_B",            sqlfn_current_tick_b },
        { "CURRENT_TIME",              sqlfn_current_time },
        { "CURRENT_BATTLE",            sqlfn_current_battle },
        { "CURRENT_BATTLE_TICK_START", sqlfn_current_battle_tick_start },
        { "CURRENT_BATTLE_TICK_END",   sqlfn_current_battle_tick_end },
        { "CURRENT_BATTLE_ROWID_LO",   sqlfn_current_battle_rowid_lo },
        { "CURRENT_BATTLE_ROWID_HI",   sqlfn_current_battle_rowid_hi },
        { "CURSOR_X",                  sqlfn_cursor_x },
        { "CURSOR_Y",                  sqlfn_cursor_y },
    };
    for (unsigned i = 0; i < sizeof(vars) / sizeof(vars[0]); i++) {
        if (sqlite3_create_function(g_db, vars[i].name, 0, SQLITE_UTF8, 0, vars[i].fn, 0, 0) != SQLITE_OK) {
            set_error("failed to register SQL variable function");
            return -1;
        }
    }
    return 0;
}

/* ---- live-edit-aware cache invalidation for replay.db/battle.db views ----
 * (replay_export.c's on-demand r/b schemas) - a monotonic counter bumped by
 * SQLite's own update hook on every row-level write to ANY table on this
 * connection. Deliberately a cheap counter, not a real content hash: hashing
 * actual row bytes on every write would cost real time against a
 * multi-million-row table for a feature that only needs to answer "has
 * ANYTHING changed since r/b was last built" - a monotonic generation number
 * answers that exactly as well as a content hash would, at zero marginal
 * cost per write. Paired with generator_sql_sha256-based staleness
 * (replay_export.c) to form the full (matchIdx, data_generation, sql_hash)
 * cache key those views are built against. */
static int g_data_generation = 0;
int replay_get_data_generation(void) { return g_data_generation; }
static void on_row_changed(void *pArg, int op, const char *zDb, const char *zTable, sqlite3_int64 rowid) {
    (void)pArg; (void)op; (void)rowid; (void)zTable;
    // Every write to the "b" schema is this engine's OWN derived output
    // (replay_export.c's attach_battledb_view/b_cache_compute populating
    // whatever arbitrary tables the derive script defines - roster_history,
    // corpses, or anything a user's own edited script adds), never an
    // independent "the user's SOURCE data changed" event this generation
    // counter exists to detect - "b" is always computed FROM main, so a
    // write to it can't be a cause, only an effect. Excluding the whole
    // schema by zDb (rather than, say, temporarily unregistering the hook
    // around those writes, or matching specific table names - not viable
    // now that "b"'s schema is arbitrary/user-editable) keeps this the one
    // place that decides what counts, instead of every writer needing to
    // know to suppress it. Also matters for correctness beyond just "b"
    // itself: without this, populating "b" would bump the counter and make
    // "r"'s own DbViewState.built_at_generation look stale too, forcing an
    // unnecessary rebuild of something nothing actually changed.
    //
    // The same reasoning extends to every "bcN" battle.db cache slot
    // (replay_export.c's bc_compute/bc_evict, one attached schema per
    // MAX_MATCHES index, named "bc0".."bc15" via bc_schema_name) - confirmed
    // via a real, hand-hit regression: background summary pre-warming for a
    // battle OTHER than the active one derives straight into its own bcN
    // schema (never into "b" - see bc_compute's own comment on why), but
    // without this exclusion those writes still bumped g_data_generation,
    // so a prewarm cycle landing between "select main" and "re-select
    // replay" in the SQL terminal made "r"'s cache look stale and forced a
    // pointless rebuild even though nothing about "r" (or "main", the
    // source data) had actually changed. No attached schema besides these
    // bcN slots starts with "bc", so a prefix check is unambiguous.
    if (zDb && (strcmp(zDb, "b") == 0 || (zDb[0] == 'b' && zDb[1] == 'c'))) return;
    g_data_generation++;
}

/* Shared by replay_finish_load() (a full multi-battle source upload) and
 * replay_finish_load_battle_file() (Phase 5: a single already-exported
 * battle's replay.db loaded directly) - both open the same OPFS-backed
 * main.db slot g_load_file just finished streaming into, need the same
 * pragmas/indexes/tick-index/prepared-statements, and only
 * diverge on how g_matches[]/g_match_count get populated afterward
 * (scan_matches_via_sql()'s boundary-detection SQL vs. reading replay.db's own
 * replay_meta table directly). Returns 0 on success, matching the negative
 * error-code convention the two callers already use. */
static int common_finish_load_setup(void) {
    if (g_load_file) {
        g_load_file->pMethods->xClose(g_load_file);
        sqlite3_free(g_load_file);
        g_load_file = 0;
    }

    int rc = sqlite3_open_v2("main.db", &g_db, SQLITE_OPEN_READWRITE, 0);
    if (rc != SQLITE_OK) { set_error("sqlite3_open_v2 failed"); return -1; }

    if (register_sql_variable_functions() != 0) return -13;
    g_data_generation = 0; /* fresh connection, fresh generation - see on_row_changed above */
    sqlite3_update_hook(g_db, on_row_changed, 0);

    /* temp_store=FILE (not MEMORY): the external sorter CREATE INDEX drives
     * over agent_states (2M+ rows) needs a real spill target once its
     * bounded in-memory working set is exceeded. temp_store=MEMORY makes
     * SQLite skip real temp files entirely and keep growing malloc'd
     * memory instead (confirmed: this is why elastic heap growth alone -
     * see goyslopless-c/lib/heap.c - was sufficient to get a real
     * CREATE INDEX working under a deliberately tiny starting heap during
     * testing) - fine for a normal machine with plenty of RAM, but directly
     * works against the 128MB-during-derivation target for a large enough
     * table, since heap growth is real committed RAM, not disk. FILE lets
     * the sorter spill to actual temp files instead, which sqlite3_vfs_mem.c
     * now backs with OPFS (is_opfs_temp mode) rather than a RAM buffer. */
    if (run_sql("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;") != SQLITE_OK) return -2;

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

    /* finalize the incremental source-file hash now that every chunk has
     * been fed through replay_feed_chunk() - see the field comment near
     * g_source_hash_ctx for why this can't happen any earlier. */
    { unsigned char digest[32]; sha256_final(&g_source_hash_ctx, digest); sha256_to_hex(digest, g_source_hash_hex); }

    /* journal_mode=OFF (set above) disables SQLite's rollback journal
     * *entirely* - not just the disk-write part of it, the whole
     * old-page-image bookkeeping that ROLLBACK/ROLLBACK TO SAVEPOINT
     * depends on. Left at OFF, Phase 5's SQL-terminal checkpoints
     * (sql_checkpoint_save/revert) would silently no-op: SAVEPOINT/
     * ROLLBACK TO both return SQLITE_OK with no error, but the data
     * genuinely never reverts - caught empirically running exactly that
     * checkpoint-then-revert sequence through the real terminal UI.
     * MEMORY mode keeps the journal in RAM instead of a file (so no new
     * disk I/O, unlike DELETE/TRUNCATE) while keeping real rollback
     * capability - switched here, AFTER the CREATE INDEX pass above, so
     * Phase 3's memory-bounded index-build behavior (the reason OFF was
     * used in the first place, see the big comment on the CREATE INDEX
     * block) is completely unaffected; only the interactive
     * querying/playback phase that follows needs rollback to work. */
    if (run_sql("PRAGMA journal_mode=MEMORY;") != SQLITE_OK) return -12;

    return 0;
}

/* returns match count on success, negative error code on failure */
int replay_finish_load(void) {
    int rc = common_finish_load_setup();
    if (rc != 0) return rc;
    if (scan_matches_via_sql() != 0) return -5;
    if (sql_checkpoint_init_baseline() != 0) return -6; /* "checkpoint #0 = initial state" - always exists from here on */
    seed_default_render_queries();
    return g_match_count;
}

/* Phase 5: load an already-exported single battle's replay.db directly,
 * streamed in via the SAME replay_begin_load()/replay_feed_chunk() calls
 * the full-source path uses (it's still just bytes landing in the OPFS
 * main.db slot) - only the "how do we know what the battle boundaries are"
 * step differs: instead of scan_matches_via_sql()'s boundary-detection SQL (which
 * needs the FULL multi-battle event history to find map/score/faction
 * switches), this reads the single row replay_export.c wrote into
 * replay_meta at export time. g_match_count is always exactly 1 here - an
 * exported battle file only ever contains the one battle it was exported
 * for, by construction (see replay_export.c's export_copy_replaydb_rows). */
int replay_finish_load_battle_file(void) {
    int rc = common_finish_load_setup();
    if (rc != 0) return rc;

    sqlite3_stmt *stmt = 0;
    if (sqlite3_prepare_v2(g_db, "SELECT start_tick_id, end_tick_id FROM replay_meta", -1, &stmt, 0) != SQLITE_OK) {
        set_error("failed to prepare replay_meta query - is this a valid exported replay.db?"); return -10;
    }
    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt);
        set_error("replay_meta table is empty - not a valid exported replay.db"); return -11;
    }
    sqlite3_int64 start_tick_id = sqlite3_column_int64(stmt, 0);
    sqlite3_int64 end_tick_id = sqlite3_column_int64(stmt, 1);
    sqlite3_finalize(stmt);

    g_match_count = 1;
    MatchInfo *m = &g_matches[0];
    memset(m, 0, sizeof(*m));
    m->start_tick_id = start_tick_id;
    m->end_tick_id = end_tick_id;
    m->start_time = g_ticks[tick_index_for_id(start_tick_id)].time;
    m->end_time = g_ticks[tick_index_for_id(end_tick_id)].time;
    resolve_match_meta(m->start_tick_id, &m->scene_no, m->faction_text, sizeof(m->faction_text));

    if (sql_checkpoint_init_baseline() != 0) return -12; /* "checkpoint #0 = initial state" - always exists from here on */
    seed_default_render_queries();
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
    const char *prefix = "SELECT count(*) FROM sqlite_master WHERE name='";
    for (const char *c = prefix; *c; c++) sql[p++] = *c;
    append_battle_index_name(sql, &p, matchIdx);
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

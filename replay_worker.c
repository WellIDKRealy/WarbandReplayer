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
#define MAX_MATCHES        16    /* up to 15 real battles per file, +1 headroom */
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
    if (g_priming_budget_bytes > 0 && replay_get_playback_heap_bytes() >= g_priming_budget_bytes) {
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

    if (g_priming_budget_bytes > 0 && replay_get_playback_heap_bytes() >= g_priming_budget_bytes) {
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
static sqlite3_int64 g_current_tick_id = -1; /* tickA of the most recent build_frame_at_time() call - backs CURRENT_TICK() (the SQL variable function) and replay_get_current_tick_id() */

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
    g_current_tick_id = tickA_id; /* backs CURRENT_TICK() and replay_get_current_tick_id() */

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
    (void)pArg; (void)op; (void)zDb; (void)zTable; (void)rowid;
    g_data_generation++;
}

/* Shared by replay_finish_load() (a full multi-battle source upload) and
 * replay_finish_load_battle_file() (Phase 5: a single already-exported
 * battle's replay.db loaded directly) - both open the same OPFS-backed
 * main.db slot g_load_file just finished streaming into, need the same
 * pragmas/indexes/tick-index/prepared-statements, and only
 * diverge on how g_matches[]/g_match_count get populated afterward
 * (scan_matches()'s boundary-event heuristic vs. reading replay.db's own
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
    if (scan_matches() != 0) return -5;
    return g_match_count;
}

/* Phase 5: load an already-exported single battle's replay.db directly,
 * streamed in via the SAME replay_begin_load()/replay_feed_chunk() calls
 * the full-source path uses (it's still just bytes landing in the OPFS
 * main.db slot) - only the "how do we know what the battle boundaries are"
 * step differs: instead of scan_matches()'s boundary-event heuristic (which
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

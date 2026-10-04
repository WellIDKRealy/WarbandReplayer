/*
 * Phase 4 battle export pipeline: replay.db (raw source rows scoped to one
 * battle, ids preserved verbatim) + battle.db (canonical-SQL-derived
 * snapshot + provenance) + manifest.json (JSON1), assembled into a minimal
 * ustar tar stream ready to hand to compress.wasm for xz compression.
 *
 * All three files live in ATTACHed "private" growable-buffer VFS databases
 * (sqlite3_vfs_mem.c's default mode for any filename other than "main.db"/
 * NULL - no new VFS code needed here) on top of the existing single g_db
 * connection, reusing replay_worker.c's already-proven rowid bisection
 * (m->rowid_lo/rowid_hi) to scope agent_states - the 2M+-row table - without
 * ever touching more than one battle's own slice of it.
 */
#include "replay_internal.h"
#include "sql/canonical_roster_corpse_sql.h"
#include "sql/canonical_roster_history_sql.h"
#include "sql/canonical_corpses_sql.h"
#include "sha256.h"
#include <string.h>
#include <stdlib.h>

#define EXPORT_FORMAT_VERSION 1

extern int wasm_vfs_get_private_buffer(sqlite3 *db, const char *zDbName, unsigned char **outData, sqlite3_int64 *outSize);

static char g_export_last_error[256];
static int g_export_last_error_offset = -1; /* byte offset into the failing SQL text, or -1 - see exec_sql */
static void export_set_error(const char *msg) {
    int i = 0;
    if (msg) while (msg[i] && i < 255) { g_export_last_error[i] = msg[i]; i++; }
    g_export_last_error[i] = 0;
    g_export_last_error_offset = -1;
}
const char *replay_export_get_last_error(void) { return g_export_last_error; }
int replay_export_get_last_error_offset(void) { return g_export_last_error_offset; }

/* Generator scripts (main text this offset is actually useful against - see
 * runGeneratorScript in main.js) always go through this one function, so
 * capturing sqlite3_error_offset() here alone covers them - internal setup
 * SQL fails the same way but has no line-numbered editor to point into.
 *
 * Deliberately NOT sqlite3_exec() (used here until directly confirmed
 * wrong): a generator script is routinely many statements long, and
 * sqlite3_exec() prepares each one by re-invoking sqlite3_prepare_v2() with
 * a pointer into the MIDDLE of the original text (wherever the previous
 * statement's own parsing left off) - sqlite3_error_offset() then returns an
 * offset relative to THAT statement's own start, not the original text's.
 * Confirmed directly: a syntax error near the end of a ~50-line script
 * consistently reported "line 1" - the offset was real, just relative to
 * the wrong origin. This loop prepares/steps/finalizes each statement
 * itself so the true origin (pSql - sql, distance already consumed by every
 * earlier statement) is always in hand to add back in. */
static int exec_sql(const char *sql) {
    const char *pSql = sql;
    while (pSql && *pSql) {
        sqlite3_stmt *stmt = 0;
        const char *pTail = 0;
        int rc = sqlite3_prepare_v2(g_db, pSql, -1, &stmt, &pTail);
        if (rc != SQLITE_OK) {
            export_set_error(sqlite3_errmsg(g_db));
            int localOffset = sqlite3_error_offset(g_db);
            if (localOffset >= 0) g_export_last_error_offset = (int)(pSql - sql) + localOffset;
            return rc;
        }
        if (!stmt) break; /* pTail is pure trailing whitespace/comment - nothing left to run */
        do { rc = sqlite3_step(stmt); } while (rc == SQLITE_ROW); /* discards row output, matching sqlite3_exec(...,cb=NULL,...) */
        if (rc != SQLITE_DONE) {
            export_set_error(sqlite3_errmsg(g_db));
            int localOffset = sqlite3_error_offset(g_db);
            if (localOffset >= 0) g_export_last_error_offset = (int)(pSql - sql) + localOffset;
            sqlite3_finalize(stmt);
            return rc;
        }
        sqlite3_finalize(stmt);
        pSql = pTail;
    }
    return SQLITE_OK;
}

static int exec_sql_free(char *sql) {
    if (!sql) { export_set_error("out of memory building SQL"); return SQLITE_NOMEM; }
    int rc = exec_sql(sql);
    sqlite3_free(sql);
    return rc;
}

/* Bounded immediate retry for the on-demand r/b views specifically (below) -
 * confirmed via direct testing: a write against g_db here can transiently
 * hit SQLITE_BUSY/SQLITE_LOCKED from the reader/prefetch threads' own brief
 * SHARED locks - the same accepted, low-frequency race already documented
 * on replay_evict_battle's DROP INDEX and replay_prefetch_battle's own
 * comment above. Normal playback's self-heal call tolerates this for free
 * simply by trying again on the next frame; a one-shot request/response
 * message (replay_ensure_db_view, driven by the SQL terminal's DB selector)
 * doesn't get that free retry, so it needs its own bounded one instead. No
 * real delay between attempts - this custom VFS (sqlite3_vfs_mem.c) has no
 * xSleep, so a genuine sqlite3_busy_timeout() isn't safely usable here -
 * but the contending lock is normally held for only one brief read step, so
 * immediate retries succeed quickly in practice; only give up (returning
 * the real error) after genuinely exhausting them. */
#define BUSY_RETRY_ATTEMPTS 20
static int exec_sql_retrying(const char *sql) {
    int rc = SQLITE_OK;
    for (int attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
        rc = exec_sql(sql);
        if (rc != SQLITE_BUSY && rc != SQLITE_LOCKED) break;
    }
    return rc;
}

/* exec_sql_free's retrying counterpart - every sqlite3_mprintf'd DROP
 * TABLE/CREATE TABLE this file issues (schema_drop_all_tables,
 * schema_copy_all_tables) goes through this, not the plain exec_sql_free,
 * for the identical reason exec_sql_retrying itself exists: a real,
 * hand-hit bug otherwise - these DDL statements are just as exposed to the
 * same transient reader/prefetch-thread SHARED-lock contention as anything
 * else touching g_db, and DROP/CREATE TABLE need a STRICTER (schema-level)
 * lock than plain INSERT/DELETE, making them if anything MORE likely to
 * transiently collide, not less - so skipping the retry here (as an
 * earlier version of this file did) was the opposite of what these calls
 * needed. */
static int exec_sql_retrying_free(char *sql) {
    if (!sql) { export_set_error("out of memory building SQL"); return SQLITE_NOMEM; }
    int rc = exec_sql_retrying(sql);
    sqlite3_free(sql);
    return rc;
}

/* ---- replay.db: schema + bounded extraction --------------------------- */

/* Table shapes copied verbatim from lua/main.lua's CREATE TABLE statements
 * (the recorder owns this schema, not the engine) - minus AUTOINCREMENT,
 * which only affects auto-generated ids, never explicit ones, and these
 * copies never generate new ids of their own. */
static int export_create_replaydb_schema(void) {
    // IF NOT EXISTS on every table: this function is now called
    // UNCONDITIONALLY on every attach_replaydb_view() call (not just the
    // first, see that function's own comment on why) - a no-op against an
    // already-populated "r", and self-healing against a "r" a checkpoint
    // ROLLBACK TO just rolled back to nonexistence (r is never detached
    // across a revert - see g_r_schema_created's own comment).
    return exec_sql_retrying(
        "CREATE TABLE IF NOT EXISTS r.ticks (id INTEGER PRIMARY KEY, time INTEGER, observer_player_id INTEGER);"
        "CREATE TABLE IF NOT EXISTS r.events (id INTEGER PRIMARY KEY, tick_id INTEGER, event_type TEXT, event_order INTEGER);"
        "CREATE TABLE IF NOT EXISTS r.chats (event_id INTEGER, username TEXT, team TEXT, chat_type TEXT, message TEXT);"
        "CREATE TABLE IF NOT EXISTS r.map_switches (event_id INTEGER, scene_no INTEGER);"
        "CREATE TABLE IF NOT EXISTS r.score_switches (event_id INTEGER, team_0_score INTEGER, team_1_score INTEGER);"
        "CREATE TABLE IF NOT EXISTS r.faction_switches (event_id INTEGER, team_0_faction_id INTEGER, team_0_faction_name TEXT, team_1_faction_id INTEGER, team_1_faction_name TEXT);"
        "CREATE TABLE IF NOT EXISTS r.kills (event_id INTEGER, type TEXT, dead_id INTEGER, dead_name TEXT, dead_x REAL, dead_y REAL, dead_z REAL, killer_id INTEGER, killer_name TEXT, killer_x REAL, killer_y REAL, killer_z REAL);"
        "CREATE TABLE IF NOT EXISTS r.spawns (event_id INTEGER, agent_id INTEGER, agent_name TEXT, is_human INTEGER, pos_x REAL, pos_y REAL, pos_z REAL, team TEXT, group_id INTEGER, class_id INTEGER, division_id INTEGER);"
        "CREATE TABLE IF NOT EXISTS r.agent_states (id INTEGER PRIMARY KEY, tick_id INTEGER, agent_id INTEGER, pos_x REAL, pos_y REAL, pos_z REAL, yaw REAL, pitch REAL, hp INTEGER, attack_action INTEGER, defend_action INTEGER, wielded_right INTEGER, wielded_left INTEGER, ammo INTEGER, horse_id INTEGER, rider_id INTEGER);"
        "CREATE TABLE IF NOT EXISTS r.replay_meta (format_version INTEGER, source_sha256 TEXT, match_index INTEGER, start_tick_id INTEGER, end_tick_id INTEGER);"
    );
}

/* Every copy is one INSERT INTO ... SELECT ... FROM main.<table> WHERE
 * <bound> - SQLite pulls rows from the SELECT cursor straight into the
 * INSERT, never materializing the whole result set first. agent_states (the
 * 2M+-row table) is scoped by rowid (id BETWEEN rowid_lo AND rowid_hi, the
 * existing bisection result) rather than a tick_id scan - everything else is
 * small enough (hundreds to low thousands of rows total, across ALL
 * battles) that a plain event_id-subquery filter is negligible. */
static int export_copy_replaydb_rows(sqlite3_int64 tick_lo, sqlite3_int64 tick_hi,
                                      sqlite3_int64 rowid_lo, sqlite3_int64 rowid_hi,
                                      int matchIdx, MatchInfo *m) {
    int rc;

    rc = exec_sql_free(sqlite3_mprintf(
        "INSERT INTO r.ticks SELECT * FROM main.ticks WHERE id BETWEEN %lld AND %lld", tick_lo, tick_hi));
    if (rc != SQLITE_OK) return rc;

    rc = exec_sql_free(sqlite3_mprintf(
        "INSERT INTO r.events SELECT * FROM main.events WHERE tick_id BETWEEN %lld AND %lld", tick_lo, tick_hi));
    if (rc != SQLITE_OK) return rc;

    static const char *event_keyed_tables[] = {
        "chats", "map_switches", "score_switches", "faction_switches", "kills", "spawns"
    };
    for (unsigned i = 0; i < sizeof(event_keyed_tables) / sizeof(event_keyed_tables[0]); i++) {
        rc = exec_sql_free(sqlite3_mprintf(
            "INSERT INTO r.%s SELECT * FROM main.%s WHERE event_id IN "
            "(SELECT id FROM main.events WHERE tick_id BETWEEN %lld AND %lld)",
            event_keyed_tables[i], event_keyed_tables[i], tick_lo, tick_hi));
        if (rc != SQLITE_OK) return rc;
    }

    rc = exec_sql_free(sqlite3_mprintf(
        "INSERT INTO r.agent_states SELECT * FROM main.agent_states WHERE id BETWEEN %lld AND %lld",
        rowid_lo, rowid_hi));
    if (rc != SQLITE_OK) return rc;

    rc = exec_sql_free(sqlite3_mprintf(
        "INSERT INTO r.replay_meta (format_version, source_sha256, match_index, start_tick_id, end_tick_id) "
        "VALUES (%d, %Q, %d, %lld, %lld)",
        EXPORT_FORMAT_VERSION, replay_get_source_sha256_hex(), matchIdx, m->start_tick_id, m->end_tick_id));
    return rc;
}

/* ---- battle.db: schema + canonical-SQL-derived snapshot ---------------- */

// Deliberately just _meta/_table_provenance here - roster_corpse_final and
// every other data table (roster_history, corpses, or whatever a user's own
// edited generator script decides to create) are NOT part of this fixed
// bootstrap schema. They're created by the derive script itself (see
// battledb_derive_default_sql()/export_derive_battledb() below) - the whole
// point being that "b"'s actual data schema is exactly as arbitrary and
// user-editable as its data, not a fixed C-side DDL contract the script's
// INSERTs merely have to conform to. See sql/canonical_roster_history.sql
// and sql/canonical_corpses.sql's own header comments for why the rendering
// engine no longer needs any C-populated fixed-schema table of its own
// (main.agent_states already has raw per-tick position rows; these two
// files derive only the small, per-battle-bounded pieces that aren't
// already sitting in a raw source table).
static int export_create_battledb_schema(void) {
    // IF NOT EXISTS on both: replay_export_battle's own reset (unlike the
    // interactive path's DELETE-then-reuse) was found to hit a real,
    // hand-caught "database table is locked" trying to DROP+recreate these
    // two specifically - some lingering reference to b._meta/
    // b._table_provenance blocks DROP TABLE even after
    // sql_terminal_finalize_stmt() and 20 retries, unlike the arbitrary
    // data tables (schema_drop_all_tables), which reset fine. Sidestepping
    // DROP entirely for just these two - IF NOT EXISTS here, DELETE FROM
    // (not DROP) to clear their rows at the call site - avoids the problem
    // instead of chasing its exact source, the same "no fixed-schema table
    // should need re-creating on every reset" property _meta/
    // _table_provenance already had before this rework (they're the one
    // truly fixed, non-arbitrary part of "b" - see this function's own
    // header comment).
    return exec_sql_retrying(
        "CREATE TABLE IF NOT EXISTS b._meta (key TEXT PRIMARY KEY, value TEXT);"
        "CREATE TABLE IF NOT EXISTS b._table_provenance (table_name TEXT PRIMARY KEY, generator_sql_sha256 TEXT, format_version INTEGER);"
    );
}

static int export_populate_battledb_meta(void) {
    char *sql = sqlite3_mprintf(
        "INSERT INTO b._meta (key, value) VALUES "
        "('format_version', %d), ('source_replay_sha256', %Q), ('generated_at_unix', %lld)",
        EXPORT_FORMAT_VERSION, replay_get_source_sha256_hex(), (sqlite3_int64)replay_get_export_time_unix());
    if (!sql) { export_set_error("out of memory building SQL"); return SQLITE_NOMEM; }
    int rc = exec_sql_retrying(sql);
    sqlite3_free(sql);
    return rc;
}

/* Strips a canonical file's trailing ';' (and trailing whitespace) so its
 * own SELECT text can be wrapped as a parenthesized subquery - mirrors
 * battledb_derive_default_sql()'s identical trim below, just without that
 * function's :from_tick/CURRENT_BATTLE_TICK_START()-style substitution
 * (this path binds the canonical file's own named params directly instead).
 * Caller must free() the result. */
static char *strip_trailing_semicolon(const char *sql) {
    size_t len = strlen(sql);
    while (len > 0 && (sql[len-1] == '\n' || sql[len-1] == '\r' || sql[len-1] == ' ' || sql[len-1] == '\t')) len--;
    if (len > 0 && sql[len-1] == ';') len--;
    char *out = (char *)malloc(len + 1);
    if (!out) return 0;
    memcpy(out, sql, len);
    out[len] = 0;
    return out;
}

/* Prepares "<insert_prefix> (<canonical file's own SELECT text>)" and binds
 * the canonical file's own named :from_tick/:to_tick params - present
 * regardless of how deep inside the appended SELECT text they sit, since
 * SQLite resolves named parameters across the whole prepared statement, not
 * per-subquery. Shared by all three canonical-file-backed derive steps
 * below (roster_corpse_final/roster_history/corpses) so there is exactly
 * one place that knows how to run "a canonical .sql file, bound, as an
 * INSERT". */
static int export_run_canonical_insert(const char *insert_prefix, const char *canonical_sql,
                                        sqlite3_int64 tick_lo, sqlite3_int64 tick_hi) {
    char *body = strip_trailing_semicolon(canonical_sql);
    if (!body) { export_set_error("out of memory building SQL"); return SQLITE_NOMEM; }
    char *sql = sqlite3_mprintf("%s\n%s\n)", insert_prefix, body);
    free(body);
    if (!sql) { export_set_error("out of memory building SQL"); return SQLITE_NOMEM; }
    sqlite3_stmt *stmt = 0;
    int rc = sqlite3_prepare_v2(g_db, sql, -1, &stmt, 0);
    sqlite3_free(sql);
    if (rc != SQLITE_OK) { export_set_error(sqlite3_errmsg(g_db)); return rc; }
    sqlite3_bind_int64(stmt, sqlite3_bind_parameter_index(stmt, ":from_tick"), tick_lo);
    sqlite3_bind_int64(stmt, sqlite3_bind_parameter_index(stmt, ":to_tick"), tick_hi);
    rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return (rc == SQLITE_DONE) ? SQLITE_OK : rc;
}

/* Creates and populates every data table battle.db's export carries -
 * roster_corpse_final (the cumulative "final state as of tick_hi" JSON
 * summary, unqualified against g_db so its bare `events`/`spawns`/`kills`
 * references resolve to "main" - see this function's own long-standing
 * reasoning below, unchanged) plus roster_history/corpses (the per-tick-
 * scoped, rendering-shaped tables - see their own .sql files' header
 * comments for why no recursion is needed for either). All three are
 * arbitrary, user-editable tables from "b"'s own point of view (see
 * export_create_battledb_schema's own comment) - this function just happens
 * to be where the FILE EXPORT path's copy of the same default derivation
 * lives, kept independent of the interactive terminal's own
 * battledb_derive_default_sql()/custom_sql path below by design (see this
 * function's own long-standing "left completely untouched" reasoning). */
static int export_derive_battledb(sqlite3_int64 tick_lo, sqlite3_int64 tick_hi) {
    int rc = exec_sql_retrying(
        "CREATE TABLE b.roster_corpse_final (from_tick INTEGER, to_tick INTEGER, roster_json TEXT, corpses_json TEXT);"
        "CREATE TABLE b.roster_history (agent_id INTEGER, team INTEGER, is_human INTEGER, spawn_event_id INTEGER, valid_from_tick INTEGER, valid_to_tick INTEGER);"
        "CREATE TABLE b.corpses (x REAL, y REAL, team INTEGER, tick_id INTEGER);"
    );
    if (rc != SQLITE_OK) { export_set_error("failed to create battle.db data tables"); return -1; }

    /* roster_corpse_final: unqualified against g_db (main), deliberately NOT
     * run against the freshly-built "r" schema - SQLite has no clean way to
     * redirect an unqualified table reference to a specific attached schema
     * without either detaching "main" (not possible - it's the connection's
     * primary db, not a real ATTACH) or textually rewriting the compiled-in
     * SQL (which would defeat the whole point of a single byte-identical
     * source of truth). Correctness is unaffected either way: the
     * :from_tick/:to_tick bind params already scope the fold to exactly
     * this battle's rows, and "main" contains a strict superset of what "r"
     * has for that same tick range - same predicate, same answer. */
    rc = export_run_canonical_insert(
        "INSERT INTO b.roster_corpse_final (from_tick, to_tick, roster_json, corpses_json) "
        "SELECT :from_tick, :to_tick, roster, corpses FROM (",
        CANONICAL_ROSTER_CORPSE_SQL, tick_lo, tick_hi);
    if (rc != SQLITE_OK) { export_set_error("failed to derive roster_corpse_final"); return -2; }

    rc = export_run_canonical_insert("INSERT INTO b.roster_history SELECT * FROM (",
        CANONICAL_ROSTER_HISTORY_SQL, tick_lo, tick_hi);
    if (rc != SQLITE_OK) { export_set_error("failed to derive roster_history"); return -3; }

    rc = export_run_canonical_insert("INSERT INTO b.corpses SELECT * FROM (",
        CANONICAL_CORPSES_SQL, tick_lo, tick_hi);
    if (rc != SQLITE_OK) { export_set_error("failed to derive corpses"); return -4; }

    return exec_sql_free(sqlite3_mprintf(
        "INSERT INTO b._table_provenance (table_name, generator_sql_sha256, format_version) VALUES "
        "('roster_corpse_final', %Q, %d), ('roster_history', %Q, %d), ('corpses', %Q, %d)",
        CANONICAL_ROSTER_CORPSE_SQL_SHA256, EXPORT_FORMAT_VERSION,
        CANONICAL_ROSTER_HISTORY_SQL_SHA256, EXPORT_FORMAT_VERSION,
        CANONICAL_CORPSES_SQL_SHA256, EXPORT_FORMAT_VERSION));
}

/* Forward declarations - defined further below (with the rest of the
 * on-demand generator-script machinery they belong to); the cache below
 * needs them directly to build derive text targeting an arbitrary schema
 * alias, for a battle that isn't necessarily g_active_match_index right
 * now (pre-warming ahead of the cursor). */
static char *str_replace_all(const char *src, const char *find, const char *repl);
static char *substitute_current_battle_ticks(const char *canonical_sql);

/* ---- battle.db cache: real, resident, per-battle table data, memory-
 * budget-driven multi-battle residency for the default derive script ----
 *
 * Unlike agent_states' per-battle partial INDEX (replay_ensure_battle_ready,
 * replay_worker.c), "b"'s derived data IS meaningfully pre-computable ahead
 * of time: it's a pure function of one battle's own tick range, entirely
 * independent of playback position within it. This is exactly the "buffer
 * as many battles as possible under a memory limit" residency the rework's
 * design calls for - genuine caching, not "recompute on every switch": a
 * battle visited once stays instantly available for the rest of the
 * session (until evicted under budget pressure), the same way a video
 * player keeps already-buffered seconds around instead of re-fetching them
 * every time playback crosses back over them.
 *
 * One PERMANENTLY-attached cache schema per match index ("bc0", "bc1", ...
 * "bc<MAX_MATCHES-1>", each its own private VFS file battle_cache_N.db),
 * lazily ATTACHed the first time that match is ever cached and never
 * DETACHed again - deliberately NOT sqlite3_serialize/deserialize (tried
 * first: sqlite3_deserialize fails reliably with SQLITE_BUSY here, since a
 * checkpoint SAVEPOINT is always open from the moment a database finishes
 * loading, and deserialize refuses to touch a schema mid-transaction), and
 * NOT DETACH-then-reATTACH of a shared alias either (a real, confirmed
 * SQLite behavior - see attach_battledb_view's own g_b_schema_created
 * comment on sqlite3_txn_state/SQLITE_TXN_READ never clearing after a
 * CREATE TABLE - means a schema that's ever had DDL run against it can
 * never be cleanly DETACHed again for the rest of the connection's
 * lifetime). Ordinary cross-schema `CREATE TABLE dst.x AS SELECT * FROM
 * src.x` copies, by contrast, are exactly what a SAVEPOINT is designed to
 * tolerate - fast (SQLite copies the underlying b-tree directly), fully
 * schema-agnostic (works for whatever arbitrary tables the derive script
 * actually creates - roster_history/corpses today, whatever a user's own
 * edited script adds tomorrow - discovered dynamically via sqlite_master,
 * never hardcoded table names), and never touches DETACH/ATTACH for "b"
 * itself at all.
 *
 * ONLY the DEFAULT derive script's output is ever cached (see
 * attach_battledb_view's own use_cache parameter) - a user's edited
 * custom_sql always re-derives fresh on every battle switch, unchanged
 * from before this cache existed. This keeps the cache correct without
 * needing to key it by script hash: the default script is what "the data
 * used for rendering" actually means here, and it's read-only compiled-in
 * text, so a cached copy of its output can never go stale for a reason
 * OTHER than the underlying source data changing (built_at_generation
 * already covers that) or the active battle changing (matchIdx indexing
 * already covers that). */
static int g_bc_attached[MAX_MATCHES];
static int g_bc_valid[MAX_MATCHES];
static int g_bc_built_at_generation[MAX_MATCHES];

static void bc_schema_name(int matchIdx, char *out, size_t outsz) {
    sqlite3_snprintf((int)outsz, out, "bc%d", matchIdx);
}

/* Lists every table currently in schemaName, one name per row - the one
 * primitive schema_drop_all_tables/schema_copy_all_tables below both build
 * on, so "b"/a cache slot's actual table set is always discovered live
 * (sqlite_master), never assumed from a hardcoded list - the arbitrary-
 * schema requirement this whole cache generalization exists for. Small,
 * fixed-size output (a battle.db derive script realistically creates a
 * handful of tables, not hundreds) - silently caps at maxNames rather than
 * risking unbounded allocation for something this size. */
#define SCHEMA_LIST_MAX_TABLES 64
#define SCHEMA_LIST_NAME_LEN 128
static int schema_list_tables(const char *schemaName, char names[][SCHEMA_LIST_NAME_LEN], int maxNames) {
    char *q = sqlite3_mprintf("SELECT name FROM %s.sqlite_master WHERE type='table'", schemaName);
    if (!q) return -1;
    sqlite3_stmt *stmt = 0;
    int rc = sqlite3_prepare_v2(g_db, q, -1, &stmt, 0);
    sqlite3_free(q);
    if (rc != SQLITE_OK) { export_set_error(sqlite3_errmsg(g_db)); return -1; }
    int n = 0;
    while (n < maxNames && sqlite3_step(stmt) == SQLITE_ROW) {
        const unsigned char *name = sqlite3_column_text(stmt, 0);
        if (!name) continue;
        size_t len = strlen((const char *)name);
        if (len >= SCHEMA_LIST_NAME_LEN) len = SCHEMA_LIST_NAME_LEN - 1;
        memcpy(names[n], name, len);
        names[n][len] = 0;
        n++;
    }
    sqlite3_finalize(stmt);
    return n;
}

/* DROP TABLE for every table currently in schemaName - the schema-agnostic
 * reset primitive both "b" (before a fresh derive) and a cache slot
 * (before re-deriving into it, or on eviction) share. %w quotes the
 * identifier (SQLite printf extension for SQL identifiers, distinct from
 * %Q/%q which quote string literals) - table names are engine-chosen
 * (roster_history, corpses, ...) or user-script-chosen, never external
 * input, but quoting costs nothing and removes any doubt. */
static int schema_drop_all_tables(const char *schemaName) {
    char names[SCHEMA_LIST_MAX_TABLES][SCHEMA_LIST_NAME_LEN];
    int n = schema_list_tables(schemaName, names, SCHEMA_LIST_MAX_TABLES);
    if (n < 0) return SQLITE_ERROR;
    for (int i = 0; i < n; i++) {
        // _meta/_table_provenance are "b"'s own fixed bootstrap tables
        // (export_create_battledb_schema), reset via DELETE, not DROP - see
        // attach_battledb_view's own comment. bc<N> cache slots never
        // contain these two names at all (build_default_derive_sql_for_schema
        // only ever creates the three arbitrary data tables), so this
        // exclusion is a no-op there, not schema-specific special-casing.
        if (strcmp(names[i], "_meta") == 0 || strcmp(names[i], "_table_provenance") == 0) continue;
        int rc = exec_sql_retrying_free(sqlite3_mprintf("DROP TABLE %s.%w", schemaName, names[i]));
        if (rc != SQLITE_OK) {
            char buf[160]; sqlite3_snprintf(sizeof(buf), buf, "DROP TABLE %s.%s failed: %s", schemaName, names[i], replay_export_get_last_error());
            export_set_error(buf);
            return rc;
        }
    }
    return SQLITE_OK;
}

/* Copies every table in srcSchema into dstSchema, which the CALLER is
 * responsible for having already emptied of same-named tables (every real
 * call site does this via schema_drop_all_tables immediately before) -
 * "AS SELECT *" infers the destination's column types from the source
 * table's own result set, so this works for whatever arbitrary shape the
 * source table actually has, no schema knowledge needed on this end.
 *
 * DROP TABLE IF EXISTS is bundled into the SAME statement string as the
 * CREATE, one exec_sql_retrying_free call per table (not two separate
 * calls - an earlier version tried that and reverted it, for adding
 * needless extra lock exposure). Self-healing, matching this file's own
 * established convention (export_create_battledb_schema,
 * build_default_derive_sql_for_schema): a transient SQLITE_BUSY/LOCKED
 * partway through a retry could in principle leave a partial table behind
 * depending on exactly where it failed, and folding the DROP into the same
 * retried statement text means every retry - including one after such a
 * leftover - starts by clearing it before recreating, so the operation is
 * genuinely idempotent under retry rather than merely "correct if the
 * first attempt happens to fully succeed". */
static int schema_copy_all_tables(const char *dstSchema, const char *srcSchema) {
    char names[SCHEMA_LIST_MAX_TABLES][SCHEMA_LIST_NAME_LEN];
    int n = schema_list_tables(srcSchema, names, SCHEMA_LIST_MAX_TABLES);
    if (n < 0) return SQLITE_ERROR;
    for (int i = 0; i < n; i++) {
        int rc = exec_sql_retrying_free(sqlite3_mprintf(
            "DROP TABLE IF EXISTS %s.%w; CREATE TABLE %s.%w AS SELECT * FROM %s.%w",
            dstSchema, names[i], dstSchema, names[i], srcSchema, names[i]));
        if (rc != SQLITE_OK) {
            char buf[256]; sqlite3_snprintf(sizeof(buf), buf, "CREATE TABLE %s.%s AS SELECT FROM %s.%s failed: %s", dstSchema, names[i], srcSchema, names[i], replay_export_get_last_error());
            export_set_error(buf);
            return rc;
        }
    }
    return SQLITE_OK;
}

static int bc_ensure_attached(int matchIdx) {
    if (g_bc_attached[matchIdx]) return SQLITE_OK;
    char name[16]; bc_schema_name(matchIdx, name, sizeof(name));
    char *sql = sqlite3_mprintf("ATTACH DATABASE 'battle_cache_%d.db' AS %s", matchIdx, name);
    if (!sql) { export_set_error("out of memory building SQL"); return SQLITE_NOMEM; }
    int rc = exec_sql_retrying(sql);
    sqlite3_free(sql);
    // Deliberately NOT PRAGMA %s.journal_mode=OFF - see attach_replaydb_view's
    // identical comment on "r": with the default journal mode, a checkpoint
    // ROLLBACK TO crossing this schema's own ATTACH point safely rolls it
    // back in place instead of leaving it broken, and it's never detached
    // (see replay_detach_generator_views) so this never needs re-attaching
    // either. Each bcN slot is a single battle's small roster/corpse
    // summary, not raw per-tick data, so real journal I/O is a non-issue.
    if (rc == SQLITE_OK) g_bc_attached[matchIdx] = 1;
    return rc;
}

static void bc_evict(int matchIdx) {
    if (matchIdx < 0 || matchIdx >= MAX_MATCHES || !g_bc_valid[matchIdx]) return;
    char name[16]; bc_schema_name(matchIdx, name, sizeof(name));
    schema_drop_all_tables(name); // best-effort - a failure here just means the next bc_compute's own drop retries it
    g_bc_valid[matchIdx] = 0;
}

/* Mirrors replay_worker.c's pick_farthest_primed_battle exactly (same
 * "farthest in real elapsed time from the cursor, excluding the active
 * battle" policy) but over g_bc_valid instead of g_battle_ready - kept as
 * its own small copy rather than reaching into replay_worker.c's private
 * statics (g_matches/g_battle_ready are file-local there), consistent with
 * how this file already keeps its own small helpers (e.g. sha256_hex_of)
 * rather than sharing plumbing across the module boundary for something
 * this size. */
static int bc_pick_victim(int fromMatchIdx) {
    int match_count = replay_get_match_count();
    if (fromMatchIdx < 0 || fromMatchIdx >= match_count) return -1;
    MatchInfo *from = replay_internal_get_match(fromMatchIdx);
    if (!from) return -1;
    int victim = -1;
    double victim_dt = -1.0;
    for (int i = 0; i < match_count; i++) {
        if (i == fromMatchIdx || i == g_active_match_index || !g_bc_valid[i]) continue;
        MatchInfo *m = replay_internal_get_match(i);
        if (!m) continue;
        double dt = m->start_time - from->start_time;
        if (dt < 0) dt = -dt;
        if (dt > victim_dt) { victim_dt = dt; victim = i; }
    }
    return victim;
}

/* Builds the default derive script targeting an ARBITRARY schema alias -
 * normally "b" (the live, actively-rendered-from schema), or a cache
 * slot's own alias like "bc3" when pre-warming a battle that isn't
 * currently active (see bc_compute below). The three canonical query
 * bodies (CURRENT_BATTLE_*()-substituted, schema-independent) are computed
 * once and reused for every schema this is called with - only the
 * CREATE/INSERT wrapping around them changes per call. Caller must
 * sqlite3_free() a non-null result; NULL only on real allocation failure. */
static char *g_roster_corpse_body = 0;
static char *g_roster_history_body = 0;
static char *g_corpses_body = 0;
static int ensure_derive_bodies_built(void) {
    if (g_roster_corpse_body && g_roster_history_body && g_corpses_body) return 1;
    if (!g_roster_corpse_body) g_roster_corpse_body = substitute_current_battle_ticks(CANONICAL_ROSTER_CORPSE_SQL);
    if (!g_roster_history_body) g_roster_history_body = substitute_current_battle_ticks(CANONICAL_ROSTER_HISTORY_SQL);
    if (!g_corpses_body) g_corpses_body = substitute_current_battle_ticks(CANONICAL_CORPSES_SQL);
    return g_roster_corpse_body && g_roster_history_body && g_corpses_body;
}
static char *build_default_derive_sql_for_schema(const char *schemaName) {
    if (!ensure_derive_bodies_built()) return 0;
    return sqlite3_mprintf(
        "-- Interactive, parameter-free rewrite of sql/canonical_roster_corpse.sql,\n"
        "-- sql/canonical_roster_history.sql, and sql/canonical_corpses.sql (the\n"
        "-- same canonical derivations ground_truth.py and the \"Export Battle\"\n"
        "-- pipeline both use) - editing THIS text (tables, indexes, or the\n"
        "-- SELECTs themselves) only affects what battle.db (b) shows here and\n"
        "-- what rendering queries read, never the canonical files or export.\n"
        // DROP TABLE IF EXISTS right before each CREATE - defensive/
        // idempotent, same reasoning as schema_copy_all_tables's own
        // identical pair (see that function's comment): dstSchema is
        // normally already clean by the time this runs, but self-healing
        // beats a confusing "table already exists" failure.
        "DROP TABLE IF EXISTS %s.roster_corpse_final;\n"
        "CREATE TABLE %s.roster_corpse_final (from_tick INTEGER, to_tick INTEGER, roster_json TEXT, corpses_json TEXT);\n"
        "DROP TABLE IF EXISTS %s.roster_history;\n"
        "CREATE TABLE %s.roster_history (agent_id INTEGER, team INTEGER, is_human INTEGER, spawn_event_id INTEGER, valid_from_tick INTEGER, valid_to_tick INTEGER);\n"
        "DROP TABLE IF EXISTS %s.corpses;\n"
        "CREATE TABLE %s.corpses (x REAL, y REAL, team INTEGER, tick_id INTEGER);\n"
        "INSERT INTO %s.roster_corpse_final (from_tick, to_tick, roster_json, corpses_json)\n"
        "SELECT CURRENT_BATTLE_TICK_START(), CURRENT_BATTLE_TICK_END(), roster, corpses FROM (\n%s\n);\n"
        "INSERT INTO %s.roster_history SELECT * FROM (\n%s\n);\n"
        "INSERT INTO %s.corpses SELECT * FROM (\n%s\n);\n",
        schemaName, schemaName, schemaName, schemaName, schemaName, schemaName,
        schemaName, g_roster_corpse_body,
        schemaName, g_roster_history_body, schemaName, g_corpses_body);
}

/* Derives the default script directly into matchIdx's own cache schema -
 * NEVER into "b" itself, even if matchIdx happens to be the active battle
 * (callers needing "b" populated go through attach_battledb_view's own
 * copy-from-cache path below instead) - this is what lets pre-warming run
 * fully in the background without ever disturbing whatever "b" is
 * currently showing live rendering queries, the same way a video player's
 * own read-ahead buffering never touches the frame currently on screen. */
static int bc_compute(int matchIdx) {
    if (bc_ensure_attached(matchIdx) != SQLITE_OK) return -1;
    char name[16]; bc_schema_name(matchIdx, name, sizeof(name));
    char *sql = build_default_derive_sql_for_schema(name);
    if (!sql) { export_set_error("out of memory building derive SQL"); return -1; }

    int prevActive = g_active_match_index; /* CURRENT_BATTLE_*() must resolve against THIS battle while deriving */
    g_active_match_index = matchIdx;
    int rc = schema_drop_all_tables(name); /* clear any stale prior content in this slot first */
    if (rc == SQLITE_OK) rc = exec_sql_retrying(sql);
    g_active_match_index = prevActive;
    sqlite3_free(sql);
    if (rc != SQLITE_OK) return -1;

    g_bc_valid[matchIdx] = 1;
    g_bc_built_at_generation[matchIdx] = replay_get_data_generation();
    return 0;
}

/* JS's cachedSummaryBattles Set is populated purely from this function's own
 * per-call responses (unlike primedBattles, which has a dedicated
 * readyMask/resyncLoadState mechanism precisely because g_battle_ready[] can
 * also be evicted by the CORRECTNESS-CRITICAL replay_ensure_battle_ready
 * path - a completely different call site JS doesn't control). g_bc_valid
 * is only ever written or evicted from inside this cache's own functions,
 * always JS-initiated - so the only staleness risk is "which victim, if
 * any, did THIS call evict", which this scalar answers instead of needing a
 * whole second bitmask-resync mechanism just for that. -1 = none evicted by
 * the most recent call. */
static int g_last_prewarm_evicted_match = -1;
int replay_get_last_prewarm_evicted_match(void) { return g_last_prewarm_evicted_match; }

/* Proactively caches matchIdx's battle.db data ahead of the cursor -
 * purely opportunistic, like replay_try_prime_battle (replay_worker.c),
 * never correctness-critical the way replay_ensure_battle_ready is (nothing
 * in normal playback depends on this cache - only attach_battledb_view's
 * own fast path, which self-heals by deriving fresh on a cache miss).
 * Shares g_priming_budget_bytes with agent_states priming (see
 * replay_internal.h) and mirrors replay_try_prime_battle's exact "decline
 * rather than evict something no farther away than the target would be"
 * policy, so proactive pre-warming can never thrash against itself. Returns
 * 1 if cached (already was, or just computed), 0 if declined, -1 on error.
 * currentMatchIdx: the cursor's battle right now, used only for the
 * decline-vs-evict distance comparison (mirrors replay_try_prime_battle's
 * own parameter). */
int replay_prewarm_battle_summary(int matchIdx, int currentMatchIdx) {
    g_last_prewarm_evicted_match = -1;
    int match_count = replay_get_match_count();
    if (matchIdx < 0 || matchIdx >= match_count || matchIdx >= MAX_MATCHES) return -1;
    if (g_bc_valid[matchIdx] && g_bc_built_at_generation[matchIdx] == replay_get_data_generation()) return 1;

    if (replay_is_over_priming_budget()) {
        int victim = bc_pick_victim(currentMatchIdx);
        MatchInfo *target = replay_internal_get_match(matchIdx);
        MatchInfo *cursor = (currentMatchIdx >= 0 && currentMatchIdx < match_count) ? replay_internal_get_match(currentMatchIdx) : 0;
        double target_dt = 0.0;
        if (cursor && target) { target_dt = target->start_time - cursor->start_time; if (target_dt < 0) target_dt = -target_dt; }
        if (victim < 0) return 0; /* nothing to evict, building would grow past budget - decline */
        MatchInfo *v = replay_internal_get_match(victim);
        double victim_dt = (cursor && v) ? (v->start_time - cursor->start_time) : 0.0;
        if (victim_dt < 0) victim_dt = -victim_dt;
        if (victim_dt <= target_dt) return 0; /* victim is no farther than matchIdx would be - not worth it, decline */
        bc_evict(victim);
        g_last_prewarm_evicted_match = victim;
    }

    return bc_compute(matchIdx) == 0 ? 1 : -1;
}

/* ---- on-demand replay.db/battle.db "views" for the SQL terminal ---------
 * Separate from replay_export_battle()'s bind-parameter-based mechanism
 * above (left completely untouched - still exactly what "Export Battle"
 * uses, so nothing here can risk that already-shipped, already-tested path).
 * These exist for the SQL terminal's live database selector: parameter-free
 * by design (using replay_worker.c's CURRENT_BATTLE_*() SQL functions
 * instead of C-injected bind values) specifically so the populate/derive SQL
 * is a plain string the user can see and edit live in the UI - there's no
 * external binding mechanism to thread a user-edited string through.
 * Always built for whichever battle is g_active_match_index right now (the
 * terminal's confirmed "follow the active battle" design) - never an
 * arbitrary matchIdx the way the export path takes, which is exactly what
 * keeps these two mechanisms safely independent. */

#define GENERATOR_SCRIPT_BUF_SIZE 16384
static char g_generator_script_buf[GENERATOR_SCRIPT_BUF_SIZE];
unsigned char *replay_get_generator_script_buf_ptr(void) { return (unsigned char *)g_generator_script_buf; }

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

/* replay.db's on-demand populate script: same 8 raw-copy INSERTs
 * export_copy_replaydb_rows() above does, rewritten parameter-free. "- 2" on
 * the tick lower bound matches resync_roster_to()'s own lower bound
 * (replay_worker.c) - the boundary tick where THIS battle's own spawn
 * events fire is recorded as the previous battle's tail tick. replay_meta
 * (provenance bookkeeping, not analysis data) is deliberately NOT part of
 * this editable text - see populate_replaydb_meta below, always runs fixed. */
static const char *replaydb_populate_default_sql(void) {
    static const char *const sql =
        "INSERT INTO r.ticks SELECT * FROM main.ticks WHERE id BETWEEN CURRENT_BATTLE_TICK_START() - 2 AND CURRENT_BATTLE_TICK_END();\n"
        "INSERT INTO r.events SELECT * FROM main.events WHERE tick_id BETWEEN CURRENT_BATTLE_TICK_START() - 2 AND CURRENT_BATTLE_TICK_END();\n"
        "INSERT INTO r.chats SELECT * FROM main.chats WHERE event_id IN (SELECT id FROM main.events WHERE tick_id BETWEEN CURRENT_BATTLE_TICK_START() - 2 AND CURRENT_BATTLE_TICK_END());\n"
        "INSERT INTO r.map_switches SELECT * FROM main.map_switches WHERE event_id IN (SELECT id FROM main.events WHERE tick_id BETWEEN CURRENT_BATTLE_TICK_START() - 2 AND CURRENT_BATTLE_TICK_END());\n"
        "INSERT INTO r.score_switches SELECT * FROM main.score_switches WHERE event_id IN (SELECT id FROM main.events WHERE tick_id BETWEEN CURRENT_BATTLE_TICK_START() - 2 AND CURRENT_BATTLE_TICK_END());\n"
        "INSERT INTO r.faction_switches SELECT * FROM main.faction_switches WHERE event_id IN (SELECT id FROM main.events WHERE tick_id BETWEEN CURRENT_BATTLE_TICK_START() - 2 AND CURRENT_BATTLE_TICK_END());\n"
        "INSERT INTO r.kills SELECT * FROM main.kills WHERE event_id IN (SELECT id FROM main.events WHERE tick_id BETWEEN CURRENT_BATTLE_TICK_START() - 2 AND CURRENT_BATTLE_TICK_END());\n"
        "INSERT INTO r.spawns SELECT * FROM main.spawns WHERE event_id IN (SELECT id FROM main.events WHERE tick_id BETWEEN CURRENT_BATTLE_TICK_START() - 2 AND CURRENT_BATTLE_TICK_END());\n"
        "INSERT INTO r.agent_states SELECT * FROM main.agent_states WHERE id BETWEEN CURRENT_BATTLE_ROWID_LO() AND CURRENT_BATTLE_ROWID_HI();\n";
    return sql;
}
const char *replay_get_default_replaydb_sql(void) { return replaydb_populate_default_sql(); }

static int populate_replaydb_meta(void) {
    MatchInfo *m = replay_internal_get_match(g_active_match_index);
    if (!m) return SQLITE_ERROR;
    char *sql = sqlite3_mprintf(
        "INSERT INTO r.replay_meta (format_version, source_sha256, match_index, start_tick_id, end_tick_id) "
        "VALUES (%d, %Q, %d, %lld, %lld)",
        EXPORT_FORMAT_VERSION, replay_get_source_sha256_hex(), g_active_match_index, m->start_tick_id, m->end_tick_id);
    if (!sql) { export_set_error("out of memory building SQL"); return SQLITE_NOMEM; }
    int rc = exec_sql_retrying(sql);
    sqlite3_free(sql);
    return rc;
}

/* Skips leading "-- ..." comment lines (and blank lines) to find where a
 * canonical .sql file's actual query text starts - a general, structural
 * scan rather than searching for a specific content marker. An earlier
 * version of this function searched for the literal substring
 * "WITH RECURSIVE\nevents_ordered" instead, which broke the day
 * canonical_roster_corpse.sql's OWN header comment happened to contain the
 * shorter phrase "WITH RECURSIVE fold over ordered..." as prose - strstr
 * found THAT occurrence first, and the resulting spliced-together text
 * choked SQLite's parser on "fold" being read as a CTE name ("near 'over':
 * syntax error", a real, confusing bug this scan can't reproduce. */
static const char *skip_leading_sql_comments(const char *sql) {
    const char *p = sql;
    for (;;) {
        while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
        if (p[0] == '-' && p[1] == '-') { while (*p && *p != '\n') p++; continue; }
        break;
    }
    return p;
}

/* A mechanical, on-the-fly substitution of a canonical file's own
 * :from_tick/:to_tick bind params for CURRENT_BATTLE_TICK_START()/END() -
 * NOT a hand-duplicated second copy of its logic. This matters: these files
 * are the single source of truth for THREE consumers (this app's C engine,
 * testdata/ground_truth.py's test oracle, and battle.db's own
 * _table_provenance hash) that must never drift apart - ground_truth.py
 * runs them directly with Python's sqlite3 bind-parameter support, so the
 * compiled-in CANONICAL_*_SQL constants and their :from_tick/:to_tick
 * mechanism stay completely untouched. This substituted copy exists ONLY
 * for the interactive, live-editable generator script feature. Strips the
 * trailing ';' too (and trailing whitespace) - the result becomes a
 * parenthesized subquery, which can't contain a statement terminator.
 * Caller must free() the result; NULL on allocation failure. */
static char *substitute_current_battle_ticks(const char *canonical_sql) {
    const char *body_start = skip_leading_sql_comments(canonical_sql);
    size_t blen = strlen(body_start);
    while (blen > 0 && (body_start[blen-1] == '\n' || body_start[blen-1] == '\r' || body_start[blen-1] == ' ' || body_start[blen-1] == '\t')) blen--;
    if (blen > 0 && body_start[blen-1] == ';') blen--;
    char *body = (char *)malloc(blen + 1);
    if (!body) return 0;
    memcpy(body, body_start, blen);
    body[blen] = 0;

    // "- 2", not bare CURRENT_BATTLE_TICK_START(): matches
    // resync_roster_to()'s own lower bound exactly (replay_worker.c) and
    // replay_export_battle()'s tick_lo = m->start_tick_id - 2 (same file,
    // "matches resync_roster_to()'s own lower bound"). Confirmed via direct
    // testing this was a real, silent bug without the offset - a battle's
    // own FIRST spawn event is recorded AT its start_tick_id, and the
    // canonical files' documented ":from_tick - exclusive lower bound"
    // contract (canonical_roster_corpse.sql's own header) means a bare
    // start_tick_id excludes that spawn outright, leaving roster_history
    // missing its first generation entirely - which starved every default
    // rendering query joined against it (main.agent_states has no matching
    // roster_history row for any tick before the battle's SECOND spawn
    // wave, if it has one at all).
    char *step1 = str_replace_all(body, ":from_tick", "(CURRENT_BATTLE_TICK_START() - 2)");
    free(body);
    if (!step1) return 0;
    char *step2 = str_replace_all(step1, ":to_tick", "CURRENT_BATTLE_TICK_END()");
    free(step1);
    return step2; /* NULL on failure, propagates naturally */
}

/* battle.db's on-demand derive script targeting "b" specifically - the
 * text shown/edited in the interactive Schema Explorer generator-script
 * editor, and what attach_battledb_view hashes for its own cache-key check
 * (replay_ensure_db_view). Thin wrapper around
 * build_default_derive_sql_for_schema (see that function's own comment,
 * and the battle.db cache's own header comment above it, for why the
 * SAME three query bodies now also back per-battle cache-slot derivation
 * via bc_compute, targeting "bc<N>" instead of "b") - built once, cached
 * (source text never changes at runtime), copied into a plain malloc'd
 * buffer since sqlite3_mprintf's own return is sqlite3_malloc'd. Falls
 * back to just the raw roster/corpse canonical text (still valid, just
 * param'd) if any allocation along the way fails - never returns NULL. */
static char *g_battledb_derive_default = 0;
static const char *battledb_derive_default_sql(void) {
    if (g_battledb_derive_default) return g_battledb_derive_default;

    char *wrapped = build_default_derive_sql_for_schema("b");
    if (!wrapped) return CANONICAL_ROSTER_CORPSE_SQL;

    size_t wlen = strlen(wrapped) + 1;
    char *final = (char *)malloc(wlen);
    if (final) memcpy(final, wrapped, wlen);
    sqlite3_free(wrapped);
    if (!final) return CANONICAL_ROSTER_CORPSE_SQL;

    g_battledb_derive_default = final;
    return g_battledb_derive_default;
}
const char *replay_get_default_battledb_sql(void) { return battledb_derive_default_sql(); }

/* Cache key per on-demand view: rebuild only when the active battle changes,
 * the underlying data changes (g_data_generation, replay_worker.c - bumped
 * by sqlite3_update_hook on any write, ANY table), or the generator script
 * text itself changes (its own sha256, extending _table_provenance's
 * existing "hash the query that produced this data" idea to actually gate a
 * rebuild instead of just recording it after the fact). All three matching
 * means the ATTACHed schema from last time is still valid and gets reused
 * untouched - this is the "smart, don't regenerate everything" mechanism. */
typedef struct DbViewState {
    int attached;
    int for_match;
    int built_at_generation;
    char built_sql_sha256[65];
    char *custom_sql; /* NULL = use the default; malloc'd once the user edits it */
} DbViewState;
static DbViewState g_r_view = { 0, -1, -1, "", 0 };
static DbViewState g_b_view = { 0, -1, -1, "", 0 };

static void sha256_hex_of(const char *text, char out_hex[65]) {
    sha256_ctx ctx; unsigned char digest[32];
    sha256_init(&ctx);
    sha256_update(&ctx, (const unsigned char *)text, strlen(text));
    sha256_final(&ctx, digest);
    sha256_to_hex(digest, out_hex);
}

// Whether 'r'/'b' currently carry the on-demand terminal's OWN schema,
// separately from DbViewState.attached (which tracks "is the CURRENT DATA
// still valid for this battle/script", reset far more often - see
// replay_ensure_db_view). ATTACH+CREATE TABLE only ever needs to happen
// ONCE per page session; every later rebuild just clears and repopulates
// the existing tables (attach_replaydb_view/attach_battledb_view below).
//
// This replaces an earlier detach-then-reattach-every-time design that hit
// a real, confirmed SQLite issue: immediately after CREATE TABLE runs
// against a freshly-ATTACHed schema, sqlite3_txn_state() for that schema
// reports SQLITE_TXN_READ and - empirically, even with an explicit COMMIT
// or with journal_mode left at its default - never returns to
// SQLITE_TXN_NONE afterward, which is exactly what DETACH DATABASE refuses
// to touch ("database X is locked"). The old detach_view() swallowed that
// failure (treating it as "wasn't attached"), so the following ATTACH then
// failed for real with "database X is already in use" - reliably, on every
// SECOND build of the same schema. Never detaching in the first place
// sidesteps the whole issue rather than working around its symptom.
//
// Reset to 0 wherever DbViewState.attached is ALSO reset for "someone else
// detached r/b out from under us" (replay_export_battle, which reuses these
// same schema names for its own unrelated files) - see its own comment.
static int g_r_schema_created = 0;
static int g_b_schema_created = 0;

static int attach_replaydb_view(const char *populate_sql) {
    // replay_ensure_battle_ready() itself has no busy-retry (see
    // exec_sql_retrying's comment above) - normal playback tolerates that by
    // just calling it again next frame; this one-shot path retries it
    // directly instead.
    int battle_ready = 0;
    for (int attempt = 0; attempt < BUSY_RETRY_ATTEMPTS && !battle_ready; attempt++) {
        battle_ready = (replay_ensure_battle_ready(g_active_match_index) >= 0);
    }
    if (!battle_ready) { export_set_error("failed to resolve battle rowid bounds (database busy)"); return -1; }

    export_set_error("");
    int rc = SQLITE_OK;
    if (!g_r_schema_created) {
        rc = exec_sql_retrying("ATTACH DATABASE 'replay_terminal.db' AS r");
        // Deliberately NOT PRAGMA r.journal_mode=OFF (contrast with agent_states'
        // own journal_mode=OFF in common_finish_load_setup, which is a real,
        // load-bearing performance choice for a 2M+-row table): confirmed via
        // direct testing that journal_mode=OFF is exactly what made a
        // checkpoint ROLLBACK TO crossing back over "r"'s own ATTACH point
        // leave it corrupted/inconsistent - with the DEFAULT journal mode,
        // SQLite correctly and safely rolls back r's schema/data in place
        // (proven: a fresh CREATE TABLE against it afterward just works, no
        // detach needed at all - see this file's own "never detach" comment
        // on g_r_schema_created below). "r" is small per battle (one
        // battle's own agent_states slice, not the whole source table), so
        // real journal I/O here is a non-issue.
        if (rc == SQLITE_OK) g_r_schema_created = 1;
    }
    // Unconditional (not just on first attach): export_create_replaydb_schema
    // is IF NOT EXISTS-based specifically so this is always safe to re-run -
    // a no-op against an already-populated "r" (the common case), and
    // self-healing against an "r" a checkpoint ROLLBACK TO just rolled back
    // to nonexistence (see g_r_schema_created's own comment - "r" is never
    // detached across a revert, so its tables can only be restored by
    // recreating them here, not by a fresh ATTACH). The DELETE pass below is
    // likewise unconditional now, for the same reason: a fresh CREATE TABLE
    // IF NOT EXISTS gives no signal on its own for "was this table just
    // created empty, or did it already have rows" - always clearing first is
    // correct and cheap either way.
    if (rc == SQLITE_OK) rc = export_create_replaydb_schema(); // shared with replay_export_battle - now itself retry-wrapped
    if (rc == SQLITE_OK) rc = exec_sql_retrying(
        "DELETE FROM r.ticks; DELETE FROM r.events; DELETE FROM r.chats; DELETE FROM r.map_switches; "
        "DELETE FROM r.score_switches; DELETE FROM r.faction_switches; DELETE FROM r.kills; "
        "DELETE FROM r.spawns; DELETE FROM r.agent_states; DELETE FROM r.replay_meta;"
    );
    if (rc == SQLITE_OK) rc = exec_sql_retrying(populate_sql);
    if (rc == SQLITE_OK) rc = populate_replaydb_meta();
    return rc == SQLITE_OK ? 0 : -2;
}

/* ATTACHes "b" (once ever - see g_b_schema_created) and gets its data ready
 * for g_active_match_index, via whichever of two paths applies:
 *   - use_cache (the UNMODIFIED default derive script): copy from this
 *     battle's own cache slot (bc<matchIdx> - see the battle.db cache's
 *     own header comment above) if resident, deriving into that slot
 *     first on a cache miss (bc_compute) - either way this branch ends
 *     with a plain cross-schema table copy into "b", ordinary SAVEPOINT-
 *     safe SQL, never a partially-applied derive.
 *   - a user-edited custom_sql: always reset "b" and derive fresh directly
 *     into it, same as before this cache existed - the cache only ever
 *     knows the default script's answer (see this cache's own header
 *     comment on why that's the right, simpler scope).
 * "b" itself is NEVER detached/re-ATTACHed to switch battles (a real,
 * confirmed SQLite behavior rules that out - see g_b_schema_created's own
 * comment below) - every battle switch is just DROP+re-copy/re-derive
 * against the SAME still-attached alias.
 *
 * sql_terminal_finalize_stmt() first: a real, hand-hit bug otherwise - the
 * SQL Terminal's own g_terminal_stmt genuinely persists between separate
 * queries (only finalized when the NEXT one starts - see that function's
 * own comment), so a user's last-run "SELECT ... FROM b.roster_history"
 * left sitting idle blocks THIS function's own DROP TABLE with "database
 * table is locked" - SQLite requires zero live references to a table's
 * schema to drop it, not just "nothing currently mid-step". Finalizing it
 * here means a stale terminal query can never block a real battle switch. */
static int attach_battledb_view(const char *derive_sql, int use_cache) {
    export_set_error("");
    sql_terminal_finalize_stmt();
    int rc = SQLITE_OK;
    if (!g_b_schema_created) {
        rc = exec_sql_retrying("ATTACH DATABASE 'battle_terminal.db' AS b");
        // Deliberately NOT PRAGMA b.journal_mode=OFF - see attach_replaydb_view's
        // identical comment on "r": confirmed via direct testing this is
        // exactly what made a checkpoint ROLLBACK TO crossing "b"'s own
        // ATTACH point leave it broken (a fresh ATTACH afterward failing
        // with "database b is already in use", since DETACH never actually
        // succeeds either way - see g_b_schema_created's own comment below).
        // With the default journal mode, SQLite safely rolls "b" back in
        // place, so it never needs detaching at all. "b" is tiny (a
        // per-battle roster/corpse summary, not raw per-tick data), so real
        // journal I/O here is a non-issue.
        if (rc == SQLITE_OK) g_b_schema_created = 1;
    }
    if (rc != SQLITE_OK) return -2;
    // Unconditional (not just on first attach) for the same reason
    // attach_replaydb_view's own export_create_replaydb_schema call is:
    // IF NOT EXISTS-based, so it's a no-op against an already-populated "b"
    // and self-healing against a "b" a checkpoint ROLLBACK TO just rolled
    // back to nonexistence.
    rc = export_create_battledb_schema(); // shared with replay_export_battle - now itself retry-wrapped
    if (rc != SQLITE_OK) return -2;

    rc = exec_sql_retrying("DELETE FROM b._meta; DELETE FROM b._table_provenance;");
    if (rc == SQLITE_OK) rc = schema_drop_all_tables("b"); // clears roster_history/corpses/roster_corpse_final (or whatever a user's script left) - never _meta/_table_provenance, deleted (not dropped) just above
    if (rc == SQLITE_OK) rc = export_populate_battledb_meta();
    if (rc != SQLITE_OK) return -2;

    if (use_cache && g_active_match_index >= 0 && g_active_match_index < MAX_MATCHES) {
        int matchIdx = g_active_match_index;
        if (g_bc_valid[matchIdx] && g_bc_built_at_generation[matchIdx] != replay_get_data_generation()) bc_evict(matchIdx);
        if (!g_bc_valid[matchIdx] && bc_compute(matchIdx) != 0) {
            return -2; // bc_compute's own exec_sql_retrying already set a real, specific error - don't clobber it
        }
        char name[16]; bc_schema_name(matchIdx, name, sizeof(name));
        rc = schema_copy_all_tables("b", name);
    } else {
        rc = exec_sql_retrying(derive_sql);
    }
    return rc == SQLITE_OK ? 0 : -2;
}

/* Called right before a checkpoint ROLLBACK TO (sql_terminal.c's
 * sql_checkpoint_revert) to invalidate every cache built on top of r/b/bc<N>,
 * since a revert can change spawns/kills/agent_states for any battle and
 * none of that fires sqlite3_update_hook (ROLLBACK TO doesn't trigger it),
 * so g_data_generation-based self-checks can't be trusted to catch this on
 * their own.
 *
 * Deliberately does NOT try to DETACH r/b/bc<N> anymore (an earlier version
 * did, and that was itself the bug - see the postmortem below). They stay
 * attached across the revert; ROLLBACK TO safely rolls their own
 * schema/data back in place instead, exactly like it does for "main" -
 * confirmed directly (a standalone repro against this project's own
 * sqlite3.c: ATTACH, CREATE TABLE, SAVEPOINT, more writes, ROLLBACK TO the
 * savepoint predating the ATTACH - the table is correctly gone afterward,
 * and a fresh CREATE TABLE against the same attached schema just works, no
 * corruption). The ONE thing that made that unsafe was r/b/bc<N> each
 * running under journal_mode=OFF (a real, deliberate performance choice for
 * main.agent_states' 2M+ rows, copy-pasted here without re-examining
 * whether it still applied) - OFF disables the rollback journal entirely,
 * so ROLLBACK TO genuinely couldn't reconstruct their prior state and left
 * them wherever the last individual statement happened to leave off.
 * Removing journal_mode=OFF from r/b/bc<N> (attach_replaydb_view/
 * attach_battledb_view/bc_ensure_attached) is what actually fixes this -
 * they're all small per-battle summaries, not the giant source table, so
 * real journal I/O here is a non-issue.
 *
 * Postmortem on the earlier DETACH-based version: DETACH DATABASE never
 * actually succeeds here in the first place, journal_mode notwithstanding -
 * once so much as one CREATE TABLE has run against a freshly-ATTACHed
 * schema, sqlite3_txn_state() for it reports SQLITE_TXN_WRITE and never
 * returns to SQLITE_TXN_NONE for the life of the connection (confirmed
 * directly, independent of journal_mode - see g_r_schema_created's own
 * comment above, which already documents this for the ordinary
 * battle-switch path). The old code here discarded that failure's return
 * code and reset g_r/b_schema_created / g_bc_attached[i] to 0 anyway,
 * making the NEXT attach_*_view/bc_ensure_attached call try to ATTACH an
 * alias that was - invisibly to the C code - still bound, which reliably
 * failed with "database X is already in use". Never attempting the detach
 * at all sidesteps this the same way the rest of this file already
 * sidesteps it for ordinary battle switches ("never detach in the first
 * place" - see g_r_schema_created's comment) rather than working around
 * its symptom a second time. g_bc_valid is still cleared for every slot
 * (not just previously-populated ones, for symmetry) so the next real use
 * of any battle re-derives its bc<N> cache fresh; g_r_view.attached/
 * g_b_view.attached are still cleared so the next replay_ensure_db_view
 * call re-derives r/b's own DATA (not their ATTACH, which never moved). */
void replay_detach_generator_views(void) {
    for (int i = 0; i < MAX_MATCHES; i++) g_bc_valid[i] = 0;
    g_r_view.attached = 0;
    g_b_view.attached = 0;
}

/* viewKind: 1 = replay.db (r), 2 = battle.db (b). Returns 0 if the existing
 * attached view was already valid and reused as-is, 1 if it was rebuilt,
 * negative on error (see replay_export_get_last_error()). */
int replay_ensure_db_view(int viewKind) {
    if (viewKind != 1 && viewKind != 2) { export_set_error("bad db view kind"); return -1; }
    if (g_active_match_index < 0) { export_set_error("no active battle"); return -1; }
    DbViewState *st = (viewKind == 1) ? &g_r_view : &g_b_view;
    const char *sql = st->custom_sql ? st->custom_sql
        : (viewKind == 1 ? replaydb_populate_default_sql() : battledb_derive_default_sql());
    char cur_hash[65]; sha256_hex_of(sql, cur_hash);

    if (st->attached && st->for_match == g_active_match_index
        && st->built_at_generation == replay_get_data_generation()
        && strcmp(st->built_sql_sha256, cur_hash) == 0) {
        return 0; /* still valid - nothing to do */
    }

    // No autocommit guard here anymore - confirmed directly that ATTACH
    // DATABASE inside an open SAVEPOINT is fine on its own; the real danger
    // (ROLLBACK TO crossing back over a still-attached ATTACH corrupts that
    // schema) is handled at the other end, in sql_checkpoint_revert
    // (sql_terminal.c), which detaches r/b before ever rolling back. That
    // makes checkpoints and these on-demand views fully independent instead
    // of one blocking the other.
    int rc = (viewKind == 1) ? attach_replaydb_view(sql) : attach_battledb_view(sql, st->custom_sql == 0);
    if (rc != 0) { st->attached = 0; return -4; }

    st->attached = 1;
    st->for_match = g_active_match_index;
    st->built_at_generation = replay_get_data_generation();
    memcpy(st->built_sql_sha256, cur_hash, 65);
    return 1;
}

/* Runs the script currently sitting in the generator-script buffer as the
 * view's new (session-only) custom generator text, then forces a rebuild
 * against it regardless of the cache key - an explicit user "Run" action, not
 * a passive cache check. */
int replay_run_generator_script(int viewKind, int len) {
    if (viewKind != 1 && viewKind != 2) { export_set_error("bad db view kind"); return -1; }
    if (len < 0) len = 0;
    if (len > GENERATOR_SCRIPT_BUF_SIZE - 1) len = GENERATOR_SCRIPT_BUF_SIZE - 1;
    g_generator_script_buf[len] = 0;

    DbViewState *st = (viewKind == 1) ? &g_r_view : &g_b_view;
    free(st->custom_sql);
    size_t slen = strlen(g_generator_script_buf);
    st->custom_sql = (char *)malloc(slen + 1);
    if (!st->custom_sql) { export_set_error("out of memory"); return -2; }
    memcpy(st->custom_sql, g_generator_script_buf, slen + 1);
    st->attached = 0; /* force rebuild below regardless of an otherwise-still-valid cache key */
    return replay_ensure_db_view(viewKind);
}

/* Drops any user-edited generator script, reverting to the built-in default
 * text, and rebuilds against it immediately. */
int replay_reset_generator_script(int viewKind) {
    if (viewKind != 1 && viewKind != 2) { export_set_error("bad db view kind"); return -1; }
    DbViewState *st = (viewKind == 1) ? &g_r_view : &g_b_view;
    free(st->custom_sql);
    st->custom_sql = 0;
    st->attached = 0;
    return replay_ensure_db_view(viewKind);
}

/* ---- manifest.json (JSON1) ---------------------------------------------- */

static char *g_manifest_json = 0; /* malloc'd, owned here, valid until the next export call */

static int export_build_manifest(int matchIdx, MatchInfo *m, sqlite3_int64 replaydb_size, sqlite3_int64 battledb_size) {
    char *sql = sqlite3_mprintf(
        "SELECT json_object("
        "'container_format_version', %d,"
        "'generated_at_unix', %lld,"
        "'source_replay', json_object('filename', %Q, 'sha256', %Q, 'size_bytes', %lld),"
        "'battle', json_object('match_index', %d, 'scene_no', %d, 'faction_text', %Q,"
        "  'start_time', %f, 'end_time', %f, 'start_tick_id', %lld, 'end_tick_id', %lld),"
        "'replay_db', json_object('format_version', %d, 'size_bytes', %lld),"
        "'battle_db', json_object('format_version', %d, 'size_bytes', %lld)"
        ")",
        EXPORT_FORMAT_VERSION, (sqlite3_int64)replay_get_export_time_unix(),
        replay_get_source_filename(), replay_get_source_sha256_hex(), (sqlite3_int64)replay_get_source_size_bytes(),
        matchIdx, m->scene_no, m->faction_text, m->start_time, m->end_time, m->start_tick_id, m->end_tick_id,
        EXPORT_FORMAT_VERSION, replaydb_size,
        EXPORT_FORMAT_VERSION, battledb_size);
    if (!sql) { export_set_error("out of memory building manifest SQL"); return -1; }

    sqlite3_stmt *stmt = 0;
    int rc = sqlite3_prepare_v2(g_db, sql, -1, &stmt, 0);
    sqlite3_free(sql);
    if (rc != SQLITE_OK) { export_set_error("failed to prepare manifest json_object query"); return -2; }
    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt); export_set_error("manifest json_object query produced no row"); return -3;
    }
    const unsigned char *json_text = sqlite3_column_text(stmt, 0);
    int json_len = sqlite3_column_bytes(stmt, 0);
    free(g_manifest_json);
    g_manifest_json = (char *)malloc((size_t)json_len + 1);
    if (!g_manifest_json) { sqlite3_finalize(stmt); export_set_error("out of memory copying manifest json"); return -4; }
    memcpy(g_manifest_json, json_text, (size_t)json_len);
    g_manifest_json[json_len] = 0;
    sqlite3_finalize(stmt);
    return 0;
}

/* ---- minimal ustar container --------------------------------------------
 * Basic POSIX ustar only (no GNU long-name extensions - our 3 entry names
 * are short and fixed, never need them). Verifiable with any real tar/xz. */

typedef struct TarBuilder {
    unsigned char *buf;
    size_t len;
    size_t capacity;
} TarBuilder;

static int tar_ensure(TarBuilder *t, size_t extra) {
    if (t->len + extra <= t->capacity) return 0;
    size_t newcap = t->capacity ? t->capacity : 65536;
    while (newcap < t->len + extra) newcap *= 2;
    unsigned char *nb = (unsigned char *)realloc(t->buf, newcap);
    if (!nb) return -1;
    t->buf = nb;
    t->capacity = newcap;
    return 0;
}

static void tar_append_bytes(TarBuilder *t, const void *data, size_t n) {
    if (n > 0) memcpy(t->buf + t->len, data, n);
    t->len += n;
}

/* writes (field_len - 1) right-justified zero-padded octal digits, then NUL */
static void octal_field(unsigned char *field, int field_len, unsigned long long value) {
    int digits = field_len - 1;
    field[digits] = 0;
    for (int i = digits - 1; i >= 0; i--) {
        field[i] = (unsigned char)('0' + (value & 7));
        value >>= 3;
    }
}

static int tar_add_entry(TarBuilder *t, const char *name, const unsigned char *data, sqlite3_int64 size) {
    size_t namelen = strlen(name);
    if (namelen > 100) return -1; /* not needed for our fixed entry names */

    unsigned char header[512];
    memset(header, 0, 512);
    memcpy(header, name, namelen);
    octal_field(header + 100, 8, 0644);                                   /* mode */
    octal_field(header + 108, 8, 0);                                      /* uid */
    octal_field(header + 116, 8, 0);                                      /* gid */
    octal_field(header + 124, 12, (unsigned long long)size);              /* size */
    octal_field(header + 136, 12, (unsigned long long)replay_get_export_time_unix()); /* mtime */
    memset(header + 148, ' ', 8);                                         /* chksum placeholder */
    header[156] = '0';                                                    /* typeflag: regular file */
    memcpy(header + 257, "ustar\0" "00", 8);                              /* magic[6] + version[2] */

    unsigned int sum = 0;
    for (int i = 0; i < 512; i++) sum += header[i];
    unsigned char chk[8];
    chk[6] = 0; chk[7] = ' ';
    unsigned int v = sum;
    for (int i = 5; i >= 0; i--) { chk[i] = (unsigned char)('0' + (v & 7)); v >>= 3; }
    memcpy(header + 148, chk, 8);

    if (tar_ensure(t, 512) != 0) return -2;
    tar_append_bytes(t, header, 512);

    if (size > 0) {
        if (tar_ensure(t, (size_t)size) != 0) return -3;
        tar_append_bytes(t, data, (size_t)size);
    }
    size_t rem = (size_t)size % 512;
    if (rem != 0) {
        size_t pad = 512 - rem;
        unsigned char zeros[512]; memset(zeros, 0, 512);
        if (tar_ensure(t, pad) != 0) return -4;
        tar_append_bytes(t, zeros, pad);
    }
    return 0;
}

static int tar_finish(TarBuilder *t) {
    unsigned char zeros[1024]; memset(zeros, 0, 1024);
    if (tar_ensure(t, 1024) != 0) return -1;
    tar_append_bytes(t, zeros, 1024);
    return 0;
}

/* ---- orchestration -------------------------------------------------------
 * exported to JS: replay_export_battle() drives the whole pipeline and
 * leaves the finished (uncompressed) tar bytes at replay_export_get_tar_ptr()
 * / replay_export_get_tar_len() for JS to hand to compress.wasm in bounded
 * chunks. */

static TarBuilder g_export_tar = {0, 0, 0};

unsigned char *replay_export_get_tar_ptr(void) { return g_export_tar.buf; }
double replay_export_get_tar_len(void) { return (double)g_export_tar.len; }

int replay_export_battle(int matchIdx) {
    if (matchIdx < 0 || matchIdx >= replay_get_match_count()) { export_set_error("bad match index"); return -1; }
    if (replay_ensure_battle_ready(matchIdx) < 0) { export_set_error("failed to resolve battle rowid bounds"); return -2; }
    MatchInfo *m = replay_internal_get_match(matchIdx);
    if (!m) { export_set_error("internal: match lookup failed"); return -3; }

    sqlite3_int64 tick_lo = m->start_tick_id - 2; /* matches resync_roster_to()'s own lower bound */
    sqlite3_int64 tick_hi = m->end_tick_id;

    /* Reset r/b in place for this export - deliberately NOT DETACH+re-ATTACH
     * (the old approach here, before "b" started carrying rendering-relevant
     * data written on nearly every real battle switch - see
     * attach_battledb_view's own g_b_schema_created comment on
     * sqlite3_txn_state/SQLITE_TXN_READ never clearing after a CREATE TABLE).
     * Once "b" is genuinely "always attached, always recently written to"
     * (true now, false when this DETACH dance was first written), that
     * DETACH DATABASE b call hits exactly that bug and fails with "database
     * b is already in use" on every single export attempt - a real
     * regression this rework surfaced, confirmed directly. schema_drop_all_
     * tables (the same schema-agnostic reset attach_battledb_view already
     * uses for "b") sidesteps it the same way: ordinary DROP TABLE, not a
     * DETACH, so a live SAVEPOINT never blocks it (also finalizing any
     * live SQL Terminal statement first - see sql_terminal_finalize_stmt's
     * own comment - a terminal query left open against r/b would otherwise
     * block THIS DROP TABLE the exact same way). If r/b aren't attached yet
     * at all (a session's very first export, before the terminal has ever
     * touched them), attach them fresh instead - same lazy-attach-once
     * pattern as attach_replaydb_view/attach_battledb_view themselves.
     * Either way, this also tears down the SQL terminal's own current view
     * of r/b (g_r_view.attached/g_b_view.attached reset) so its own
     * on-demand cache-key check rebuilds fresh next time it's used, rather
     * than trusting a schema this export just repurposed for itself. */
    sql_terminal_finalize_stmt();
    g_r_view.attached = 0; g_b_view.attached = 0;
    int rc0 = SQLITE_OK;
    if (g_r_schema_created) {
        rc0 = schema_drop_all_tables("r");
    } else {
        rc0 = exec_sql("ATTACH DATABASE 'replay_export.db' AS r");
        if (rc0 == SQLITE_OK) g_r_schema_created = 1;
    }
    if (rc0 == SQLITE_OK) {
        if (g_b_schema_created) {
            // schema_drop_all_tables deliberately EXCLUDES _meta/_table_provenance
            // (reset via DELETE, not DROP - see export_create_battledb_schema's
            // own comment on why DROP specifically hit a real, hand-caught
            // "database table is locked" for just these two).
            rc0 = exec_sql_retrying("DELETE FROM b._meta; DELETE FROM b._table_provenance;");
            if (rc0 == SQLITE_OK) rc0 = schema_drop_all_tables("b");
        } else {
            rc0 = exec_sql("ATTACH DATABASE 'battle_export.db' AS b");
            if (rc0 == SQLITE_OK) g_b_schema_created = 1;
        }
    }
    if (rc0 != SQLITE_OK) return -4;
    // Deliberately no PRAGMA journal_mode=OFF here (an earlier version set
    // it on both r and b) - see attach_replaydb_view's own comment on why
    // that's actively wrong for these two aliases specifically: it's what
    // made a checkpoint ROLLBACK TO crossing r/b's own ATTACH point corrupt
    // them instead of safely rolling back in place. Doubly so here, since
    // this function shares the exact same "r"/"b" alias names with the
    // interactive terminal's own attach_replaydb_view/attach_battledb_view
    // (different underlying files, same aliases, mutually exclusive
    // occupants - see this function's own comment above) - setting OFF here
    // would leak into whichever of those two uses the alias next, not just
    // this export. PRAGMA synchronous=OFF was never real to begin with
    // (confirmed directly - "Safety level may not be changed inside a
    // transaction" - it silently no-ops whenever a savepoint is open, which
    // checkpoint #0 always is by this point), so nothing of actual value is
    // lost by dropping this call entirely.

    if (export_create_replaydb_schema() != SQLITE_OK) return -6;
    if (export_copy_replaydb_rows(tick_lo, tick_hi, m->rowid_lo, m->rowid_hi, matchIdx, m) != SQLITE_OK) return -7;

    if (export_create_battledb_schema() != SQLITE_OK) return -8;
    if (export_populate_battledb_meta() != SQLITE_OK) return -9;
    if (export_derive_battledb(tick_lo, tick_hi) != SQLITE_OK) return -10;

    // Extract r/b as complete, correct database images via sqlite3_serialize
    // - NOT a direct wasm_vfs_get_private_buffer(g_db, ...) read of g_db's
    // own attached schemas' raw VFS buffer, and NOT sqlite3_backup into a
    // fresh connection either; both were tried first and both failed for
    // real, specific reasons worth recording:
    //   - wasm_vfs_get_private_buffer + sqlite3_db_cacheflush(): cacheflush
    //     is documented to flush "dirty pages... not currently in use", and
    //     ALSO documented that "page 1 of a database file is always in use"
    //     - i.e. NEVER flushed by that call, no matter what. Confirmed
    //     directly: the exported replay.db's page 1 came back all zero
    //     bytes (every OTHER page had real data) - "file is not a database"
    //     on reload, the header page was simply never written.
    //   - sqlite3_backup into a fresh sqlite3_open_v2() connection:
    //     sqlite3_backup_step() consistently returned SQLITE_BUSY against
    //     this VFS. Confirmed NOT a real lock conflict - private (non-OPFS)
    //     MemFiles' own xLock is a no-op stub that always succeeds
    //     (sqlite3_vfs_mem.c: "private file: never contended, always
    //     succeeds") - so this VFS's cross-connection story doesn't support
    //     sqlite3_backup's expectations, for a reason not worth chasing
    //     further given sqlite3_serialize is the more directly-appropriate
    //     API anyway.
    // sqlite3_serialize reads through SQLite's OWN pager/b-tree layer
    // directly (real API purpose: "give me this database's bytes exactly as
    // they stand right now") rather than the VFS's raw file buffer, so it's
    // unaffected by either problem above - correct and complete regardless
    // of transaction/journal_mode/page-1-in-use state. The caller owns the
    // returned buffers (sqlite3_malloc64'd - freed with sqlite3_free below,
    // not the ordinary free() other buffers in this file use).
    sqlite3_int64 replaydb_size = 0, battledb_size = 0;
    unsigned char *replaydb_data = sqlite3_serialize(g_db, "r", &replaydb_size, 0);
    if (!replaydb_data) { export_set_error("could not serialize replay_export.db"); return -11; }
    unsigned char *battledb_data = sqlite3_serialize(g_db, "b", &battledb_size, 0);
    if (!battledb_data) {
        sqlite3_free(replaydb_data);
        export_set_error("could not serialize battle_export.db"); return -12;
    }

    int mrc = export_build_manifest(matchIdx, m, replaydb_size, battledb_size);
    if (mrc == 0) {
        free(g_export_tar.buf); g_export_tar.buf = 0; g_export_tar.len = 0; g_export_tar.capacity = 0;
        if (tar_add_entry(&g_export_tar, "manifest.json", (const unsigned char *)g_manifest_json, (sqlite3_int64)strlen(g_manifest_json)) != 0) {
            export_set_error("tar: manifest.json entry failed"); mrc = -14;
        } else if (tar_add_entry(&g_export_tar, "replay.db", replaydb_data, replaydb_size) != 0) {
            export_set_error("tar: replay.db entry failed"); mrc = -15;
        } else if (tar_add_entry(&g_export_tar, "battle.db", battledb_data, battledb_size) != 0) {
            export_set_error("tar: battle.db entry failed"); mrc = -16;
        } else if (tar_finish(&g_export_tar) != 0) {
            export_set_error("tar: finish failed"); mrc = -17;
        }
    } else {
        mrc = -13;
    }
    // tar_add_entry copies these bytes into g_export_tar's own buffer - only
    // safe to free the serialized buffers AFTER that copy, regardless of
    // which step above failed.
    sqlite3_free(replaydb_data);
    sqlite3_free(battledb_data);
    if (mrc != 0) return mrc;

    exec_sql("DETACH DATABASE r; DETACH DATABASE b;");
    return 0;
}

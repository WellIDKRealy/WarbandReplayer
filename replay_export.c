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
#include "sha256.h"
#include <string.h>
#include <stdlib.h>

#define EXPORT_FORMAT_VERSION 1

extern int wasm_vfs_get_private_buffer(sqlite3 *db, const char *zDbName, unsigned char **outData, sqlite3_int64 *outSize);

static char g_export_last_error[256];
static void export_set_error(const char *msg) {
    int i = 0;
    if (msg) while (msg[i] && i < 255) { g_export_last_error[i] = msg[i]; i++; }
    g_export_last_error[i] = 0;
}
const char *replay_export_get_last_error(void) { return g_export_last_error; }

static int exec_sql(const char *sql) {
    char *errmsg = 0;
    int rc = sqlite3_exec(g_db, sql, 0, 0, &errmsg);
    if (rc != SQLITE_OK) { export_set_error(errmsg ? errmsg : "sql exec failed"); if (errmsg) sqlite3_free(errmsg); }
    return rc;
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

/* ---- replay.db: schema + bounded extraction --------------------------- */

/* Table shapes copied verbatim from lua/main.lua's CREATE TABLE statements
 * (the recorder owns this schema, not the engine) - minus AUTOINCREMENT,
 * which only affects auto-generated ids, never explicit ones, and these
 * copies never generate new ids of their own. */
static int export_create_replaydb_schema(void) {
    return exec_sql_retrying(
        "CREATE TABLE r.ticks (id INTEGER PRIMARY KEY, time INTEGER, observer_player_id INTEGER);"
        "CREATE TABLE r.events (id INTEGER PRIMARY KEY, tick_id INTEGER, event_type TEXT, event_order INTEGER);"
        "CREATE TABLE r.chats (event_id INTEGER, username TEXT, team TEXT, chat_type TEXT, message TEXT);"
        "CREATE TABLE r.map_switches (event_id INTEGER, scene_no INTEGER);"
        "CREATE TABLE r.score_switches (event_id INTEGER, team_0_score INTEGER, team_1_score INTEGER);"
        "CREATE TABLE r.faction_switches (event_id INTEGER, team_0_faction_id INTEGER, team_0_faction_name TEXT, team_1_faction_id INTEGER, team_1_faction_name TEXT);"
        "CREATE TABLE r.kills (event_id INTEGER, type TEXT, dead_id INTEGER, dead_name TEXT, dead_x REAL, dead_y REAL, dead_z REAL, killer_id INTEGER, killer_name TEXT, killer_x REAL, killer_y REAL, killer_z REAL);"
        "CREATE TABLE r.spawns (event_id INTEGER, agent_id INTEGER, agent_name TEXT, is_human INTEGER, pos_x REAL, pos_y REAL, pos_z REAL, team TEXT, group_id INTEGER, class_id INTEGER, division_id INTEGER);"
        "CREATE TABLE r.agent_states (id INTEGER PRIMARY KEY, tick_id INTEGER, agent_id INTEGER, pos_x REAL, pos_y REAL, pos_z REAL, yaw REAL, pitch REAL, hp INTEGER, attack_action INTEGER, defend_action INTEGER, wielded_right INTEGER, wielded_left INTEGER, ammo INTEGER, horse_id INTEGER, rider_id INTEGER);"
        "CREATE TABLE r.replay_meta (format_version INTEGER, source_sha256 TEXT, match_index INTEGER, start_tick_id INTEGER, end_tick_id INTEGER);"
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

static int export_create_battledb_schema(void) {
    return exec_sql_retrying(
        "CREATE TABLE b._meta (key TEXT PRIMARY KEY, value TEXT);"
        "CREATE TABLE b._table_provenance (table_name TEXT PRIMARY KEY, generator_sql_sha256 TEXT, format_version INTEGER);"
        "CREATE TABLE b.roster_corpse_final (from_tick INTEGER, to_tick INTEGER, roster_json TEXT, corpses_json TEXT);"
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

/* Runs the compiled-in canonical roster/corpse SQL (see
 * sql/canonical_roster_corpse.sql) unqualified against g_db - which
 * resolves its bare `events`/`spawns`/`kills` references to "main" (the
 * full source, still attached as g_db's primary db at export time). This is
 * deliberately NOT run against the freshly-built "r" schema: SQLite has no
 * clean way to redirect an unqualified table reference to a specific
 * attached schema without either detaching "main" (not possible - it's the
 * connection's primary db, not a real ATTACH) or textually rewriting the
 * compiled-in SQL (which would defeat the whole point of a single
 * byte-identical source of truth). Correctness is unaffected either way:
 * the :from_tick/:to_tick bind params already scope the fold to exactly
 * this battle's rows, and "main" contains a strict superset of what "r"
 * has for that same tick range - same predicate, same answer. Phase 5's
 * later regeneration-from-replay.db path will run this exact same
 * unqualified SQL text against a connection where replay.db legitimately
 * IS "main", naturally correct there too. */
static int export_derive_battledb(sqlite3_int64 tick_lo, sqlite3_int64 tick_hi) {
    sqlite3_stmt *stmt = 0;
    if (sqlite3_prepare_v2(g_db, CANONICAL_ROSTER_CORPSE_SQL, -1, &stmt, 0) != SQLITE_OK) {
        export_set_error("failed to prepare canonical roster/corpse SQL"); return -1;
    }
    sqlite3_bind_int64(stmt, sqlite3_bind_parameter_index(stmt, ":from_tick"), tick_lo);
    sqlite3_bind_int64(stmt, sqlite3_bind_parameter_index(stmt, ":to_tick"), tick_hi);
    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt); export_set_error("canonical SQL produced no row"); return -2;
    }
    const unsigned char *roster_json = sqlite3_column_text(stmt, 0);
    const unsigned char *corpses_json = sqlite3_column_text(stmt, 1);

    sqlite3_stmt *ins = 0;
    if (sqlite3_prepare_v2(g_db,
        "INSERT INTO b.roster_corpse_final (from_tick, to_tick, roster_json, corpses_json) VALUES (?1, ?2, ?3, ?4)",
        -1, &ins, 0) != SQLITE_OK) {
        sqlite3_finalize(stmt); export_set_error("failed to prepare battle.db insert"); return -3;
    }
    sqlite3_bind_int64(ins, 1, tick_lo);
    sqlite3_bind_int64(ins, 2, tick_hi);
    /* SQLITE_TRANSIENT copies the string bytes immediately, so it's safe to
     * finalize `stmt` (which owns roster_json/corpses_json) right after. */
    sqlite3_bind_text(ins, 3, (const char *)roster_json, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(ins, 4, (const char *)corpses_json, -1, SQLITE_TRANSIENT);
    int rc = sqlite3_step(ins);
    sqlite3_finalize(ins);
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE) { export_set_error("failed to insert derived battle.db row"); return -4; }

    return exec_sql_free(sqlite3_mprintf(
        "INSERT INTO b._table_provenance (table_name, generator_sql_sha256, format_version) VALUES ('roster_corpse_final', %Q, %d)",
        CANONICAL_ROSTER_CORPSE_SQL_SHA256, EXPORT_FORMAT_VERSION));
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

/* battle.db's on-demand derive script: a mechanical, on-the-fly substitution
 * of sql/canonical_roster_corpse.sql's :from_tick/:to_tick bind params for
 * CURRENT_BATTLE_TICK_START()/END() - NOT a hand-duplicated second copy of
 * the recursive CTE logic. This matters: that file is the single source of
 * truth for THREE consumers (this app's C engine, testdata/ground_truth.py's
 * test oracle, and battle.db's own _table_provenance hash) that must never
 * drift apart - ground_truth.py runs it directly with Python's sqlite3
 * bind-parameter support, so the compiled-in CANONICAL_ROSTER_CORPSE_SQL
 * constant and its :from_tick/:to_tick mechanism stay completely untouched.
 * This substituted copy exists ONLY for the interactive, live-editable
 * generator script feature - built fresh from the real canonical text on
 * first use, so editing it here can never desync from what export/
 * ground-truth actually run. */
static char *g_battledb_derive_default = 0; /* built once, cached (source text never changes at runtime) */
static const char *battledb_derive_default_sql(void) {
    if (g_battledb_derive_default) return g_battledb_derive_default;

    // "WITH RECURSIVE\nevents_ordered", not just "WITH RECURSIVE" - the file's
    // own header comment (canonical_roster_corpse.sql:2, "...in a WITH
    // RECURSIVE fold over ordered spawn/kill events.") contains that shorter
    // phrase INLINE as prose, and strstr found THAT occurrence first, not the
    // real CTE clause down at line 52 - confirmed directly: the resulting
    // "default battle.db script" text spliced in from the comment's "WITH
    // RECURSIVE fold over ordered..." onward, and SQLite's parser choked on
    // "fold" being read as a CTE name immediately followed by "over" where
    // "(" or "AS" was expected ("near 'over': syntax error" - the exact,
    // confusing symptom this real bug produced).
    const char *marker = strstr(CANONICAL_ROSTER_CORPSE_SQL, "WITH RECURSIVE\nevents_ordered");
    if (!marker) return CANONICAL_ROSTER_CORPSE_SQL; /* shouldn't happen - fail soft with the raw (still valid, just param'd) text */
    char *body = (char *)malloc(strlen(marker) + 1);
    if (!body) return CANONICAL_ROSTER_CORPSE_SQL;
    strcpy(body, marker);

    /* Strip the trailing ';' (and whitespace after it) - this text becomes a
     * parenthesized subquery below, which can't contain a statement
     * terminator. */
    size_t blen = strlen(body);
    while (blen > 0 && (body[blen-1] == '\n' || body[blen-1] == '\r' || body[blen-1] == ' ' || body[blen-1] == '\t')) body[--blen] = 0;
    if (blen > 0 && body[blen-1] == ';') body[--blen] = 0;

    char *step1 = str_replace_all(body, ":from_tick", "CURRENT_BATTLE_TICK_START()");
    free(body);
    if (!step1) return CANONICAL_ROSTER_CORPSE_SQL;
    char *step2 = str_replace_all(step1, ":to_tick", "CURRENT_BATTLE_TICK_END()");
    free(step1);
    if (!step2) return CANONICAL_ROSTER_CORPSE_SQL;

    static const char *const prefix =
        "-- Interactive, parameter-free rewrite of sql/canonical_roster_corpse.sql\n"
        "-- (the same canonical roster/corpse fold ground_truth.py and the\n"
        "-- \"Export Battle\" pipeline both use) - editing THIS text only affects\n"
        "-- what battle.db (b) shows here, never the canonical file or export.\n"
        "INSERT INTO b.roster_corpse_final (from_tick, to_tick, roster_json, corpses_json)\n"
        "SELECT CURRENT_BATTLE_TICK_START(), CURRENT_BATTLE_TICK_END(), roster, corpses FROM (\n";
    static const char *const suffix = "\n);\n";
    size_t prefix_len = strlen(prefix), step2_len = strlen(step2), suffix_len = strlen(suffix);
    char *wrapped = (char *)malloc(prefix_len + step2_len + suffix_len + 1);
    if (!wrapped) { free(step2); return CANONICAL_ROSTER_CORPSE_SQL; }
    memcpy(wrapped, prefix, prefix_len);
    memcpy(wrapped + prefix_len, step2, step2_len);
    memcpy(wrapped + prefix_len + step2_len, suffix, suffix_len);
    wrapped[prefix_len + step2_len + suffix_len] = 0;
    free(step2);

    g_battledb_derive_default = wrapped;
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
    int rc;
    if (!g_r_schema_created) {
        rc = exec_sql_retrying("ATTACH DATABASE 'replay_terminal.db' AS r; PRAGMA r.journal_mode=OFF; PRAGMA r.synchronous=OFF;");
        if (rc == SQLITE_OK) rc = export_create_replaydb_schema(); // shared with replay_export_battle - now itself retry-wrapped
        if (rc == SQLITE_OK) g_r_schema_created = 1;
    } else {
        rc = exec_sql_retrying(
            "DELETE FROM r.ticks; DELETE FROM r.events; DELETE FROM r.chats; DELETE FROM r.map_switches; "
            "DELETE FROM r.score_switches; DELETE FROM r.faction_switches; DELETE FROM r.kills; "
            "DELETE FROM r.spawns; DELETE FROM r.agent_states; DELETE FROM r.replay_meta;"
        );
    }
    if (rc == SQLITE_OK) rc = exec_sql_retrying(populate_sql);
    if (rc == SQLITE_OK) rc = populate_replaydb_meta();
    return rc == SQLITE_OK ? 0 : -2;
}

static int attach_battledb_view(const char *derive_sql) {
    export_set_error("");
    int rc;
    if (!g_b_schema_created) {
        rc = exec_sql_retrying("ATTACH DATABASE 'battle_terminal.db' AS b; PRAGMA b.journal_mode=OFF; PRAGMA b.synchronous=OFF;");
        if (rc == SQLITE_OK) rc = export_create_battledb_schema(); // shared with replay_export_battle - now itself retry-wrapped
        if (rc == SQLITE_OK) g_b_schema_created = 1;
    } else {
        rc = exec_sql_retrying("DELETE FROM b._meta; DELETE FROM b._table_provenance; DELETE FROM b.roster_corpse_final;");
    }
    if (rc == SQLITE_OK) rc = export_populate_battledb_meta(); // ditto
    if (rc == SQLITE_OK) rc = exec_sql_retrying(derive_sql);
    return rc == SQLITE_OK ? 0 : -2;
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

    if (!sqlite3_get_autocommit(g_db)) {
        export_set_error("cannot rebuild while a SQL terminal checkpoint is open - revert or release it first");
        return -3;
    }

    int rc = (viewKind == 1) ? attach_replaydb_view(sql) : attach_battledb_view(sql);
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

    if (!sqlite3_get_autocommit(g_db)) {
        export_set_error("cannot rebuild while a SQL terminal checkpoint is open - revert or release it first");
        return -3;
    }

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

    /* Clean up any previous export's ATTACHments first - harmless no-op
     * error ("no such database") on the very first call, or after a
     * previous call already detached at the end; ignored either way. This
     * also detaches the SQL terminal's own on-demand r/b views (above) if
     * either happened to be open - g_r_view/g_b_view.attached is reset here
     * so that on-demand cache-key check (replay_ensure_db_view) knows to
     * rebuild rather than trusting a schema this export just tore down, and
     * g_r/b_schema_created is reset alongside it so that rebuild does a real
     * ATTACH+CREATE TABLE again instead of assuming the schema this export
     * just detached is still there to DELETE FROM. */
    exec_sql("DETACH DATABASE r"); exec_sql("DETACH DATABASE b"); export_set_error("");
    g_r_view.attached = 0; g_b_view.attached = 0;
    g_r_schema_created = 0; g_b_schema_created = 0;

    if (exec_sql("ATTACH DATABASE 'replay_export.db' AS r; ATTACH DATABASE 'battle_export.db' AS b;") != SQLITE_OK) return -4;
    if (exec_sql("PRAGMA r.journal_mode=OFF; PRAGMA r.synchronous=OFF; PRAGMA b.journal_mode=OFF; PRAGMA b.synchronous=OFF;") != SQLITE_OK) return -5;

    if (export_create_replaydb_schema() != SQLITE_OK) return -6;
    if (export_copy_replaydb_rows(tick_lo, tick_hi, m->rowid_lo, m->rowid_hi, matchIdx, m) != SQLITE_OK) return -7;

    if (export_create_battledb_schema() != SQLITE_OK) return -8;
    if (export_populate_battledb_meta() != SQLITE_OK) return -9;
    if (export_derive_battledb(tick_lo, tick_hi) != SQLITE_OK) return -10;

    unsigned char *replaydb_data = 0; sqlite3_int64 replaydb_size = 0;
    unsigned char *battledb_data = 0; sqlite3_int64 battledb_size = 0;
    if (wasm_vfs_get_private_buffer(g_db, "r", &replaydb_data, &replaydb_size) != 0) {
        export_set_error("could not read back replay_export.db buffer"); return -11;
    }
    if (wasm_vfs_get_private_buffer(g_db, "b", &battledb_data, &battledb_size) != 0) {
        export_set_error("could not read back battle_export.db buffer"); return -12;
    }

    if (export_build_manifest(matchIdx, m, replaydb_size, battledb_size) != 0) return -13;

    free(g_export_tar.buf); g_export_tar.buf = 0; g_export_tar.len = 0; g_export_tar.capacity = 0;
    if (tar_add_entry(&g_export_tar, "manifest.json", (const unsigned char *)g_manifest_json, (sqlite3_int64)strlen(g_manifest_json)) != 0) {
        export_set_error("tar: manifest.json entry failed"); return -14;
    }
    if (tar_add_entry(&g_export_tar, "replay.db", replaydb_data, replaydb_size) != 0) {
        export_set_error("tar: replay.db entry failed"); return -15;
    }
    if (tar_add_entry(&g_export_tar, "battle.db", battledb_data, battledb_size) != 0) {
        export_set_error("tar: battle.db entry failed"); return -16;
    }
    if (tar_finish(&g_export_tar) != 0) { export_set_error("tar: finish failed"); return -17; }

    exec_sql("DETACH DATABASE r; DETACH DATABASE b;"); /* frees the private buffers now that the tar owns a copy */
    return 0;
}

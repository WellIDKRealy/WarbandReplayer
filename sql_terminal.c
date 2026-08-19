/*
 * Phase 5 debug SQL terminal: run arbitrary read/write SQL against g_db
 * (whatever's currently loaded - the full source or a directly-loaded
 * battle file, see replay_finish_load_battle_file()) and stream results
 * back a row at a time, plus in-session SAVEPOINT/ROLLBACK TO checkpoints.
 *
 * Row values are always read back via sqlite3_column_text() regardless of
 * their real storage type - SQLite converts any type to its text form on
 * request, which is exactly what a display grid wants; this schema has no
 * BLOB columns, so nothing meaningful is lost by not special-casing them.
 */
#include "replay_internal.h"
#include <string.h>

#define TERMINAL_QUERY_BUF_SIZE 8192

static char g_terminal_last_error[256];
static void terminal_set_error(const char *msg) {
    int i = 0;
    if (msg) while (msg[i] && i < 255) { g_terminal_last_error[i] = msg[i]; i++; }
    g_terminal_last_error[i] = 0;
}
const char *sql_terminal_get_last_error(void) { return g_terminal_last_error; }

static char g_terminal_query[TERMINAL_QUERY_BUF_SIZE];
static sqlite3_stmt *g_terminal_stmt = 0;

unsigned char *sql_terminal_get_query_buf_ptr(void) { return (unsigned char *)g_terminal_query; }

/* Prepares the query currently sitting in the query buffer (JS writes it
 * there the same way replay_get_load_chunk_ptr()'s buffer is filled).
 * Finalizes any previous statement first - only one query is ever "live"
 * at a time, matching a REPL's one-command-at-a-time model. Returns 0 on
 * success, -1 on a prepare error (bad SQL, unknown table, etc). */
int sql_terminal_run(int len) {
    if (g_terminal_stmt) { sqlite3_finalize(g_terminal_stmt); g_terminal_stmt = 0; }
    if (len < 0) len = 0;
    if (len > TERMINAL_QUERY_BUF_SIZE - 1) len = TERMINAL_QUERY_BUF_SIZE - 1;
    g_terminal_query[len] = 0;

    if (!g_db) { terminal_set_error("no database loaded"); return -1; }
    if (sqlite3_prepare_v2(g_db, g_terminal_query, -1, &g_terminal_stmt, 0) != SQLITE_OK) {
        terminal_set_error(sqlite3_errmsg(g_db));
        g_terminal_stmt = 0;
        return -1;
    }
    return 0;
}

int sql_terminal_column_count(void) { return g_terminal_stmt ? sqlite3_column_count(g_terminal_stmt) : 0; }
const char *sql_terminal_column_name(int i) {
    static const char empty[1] = "";
    if (!g_terminal_stmt) return empty;
    const char *n = sqlite3_column_name(g_terminal_stmt, i);
    return n ? n : empty;
}

/* 1 = row available (read columns now), 0 = done, -1 = error. A statement
 * with no result set (INSERT/UPDATE/DELETE/CREATE/SAVEPOINT/...) just steps
 * straight to 0 (SQLITE_DONE) with column_count()==0 - the terminal UI
 * shows "N rows" (0 here) same as any other query, no special-casing needed
 * on the JS side. */
int sql_terminal_step(void) {
    if (!g_terminal_stmt) { terminal_set_error("no query prepared"); return -1; }
    int rc = sqlite3_step(g_terminal_stmt);
    if (rc == SQLITE_ROW) return 1;
    if (rc == SQLITE_DONE) return 0;
    terminal_set_error(sqlite3_errmsg(g_db));
    return -1;
}

int sql_terminal_column_is_null(int i) {
    return g_terminal_stmt ? (sqlite3_column_type(g_terminal_stmt, i) == SQLITE_NULL) : 1;
}
const char *sql_terminal_column_text(int i) {
    static const char empty[1] = "";
    if (!g_terminal_stmt) return empty;
    const unsigned char *t = sqlite3_column_text(g_terminal_stmt, i);
    return t ? (const char *)t : empty;
}

/* ---- in-session checkpoints (SAVEPOINT / ROLLBACK TO) -------------------
 * Auto-numbered rather than user-named: the terminal UI shows a simple
 * "Checkpoint #3" list, and auto-numbering sidesteps needing another JS<->C
 * string buffer just for a name nobody's SQL actually needs to reference.
 * Deliberately in-session only, per the resolved design fork - these never
 * touch the loaded file itself, they're pure rollback-journal bookkeeping
 * that evaporates when the connection closes. */
static char g_checkpoint_last_error[256]; /* checkpoint ops share the terminal's error surface conceptually but keep their own buffer, since a failed SAVEPOINT shouldn't clobber a still-relevant query error a UI panel might be showing */
static void checkpoint_set_error(const char *msg) {
    int i = 0;
    if (msg) while (msg[i] && i < 255) { g_checkpoint_last_error[i] = msg[i]; i++; }
    g_checkpoint_last_error[i] = 0;
}
const char *sql_checkpoint_get_last_error(void) { return g_checkpoint_last_error; }

static int g_checkpoint_seq = 0;

/* Returns the new checkpoint's id (>= 1) on success, -1 on failure. */
int sql_checkpoint_save(void) {
    if (!g_db) { checkpoint_set_error("no database loaded"); return -1; }
    int id = g_checkpoint_seq + 1;
    char *sql = sqlite3_mprintf("SAVEPOINT cp%d", id);
    if (!sql) { checkpoint_set_error("out of memory"); return -1; }
    char *errmsg = 0;
    int rc = sqlite3_exec(g_db, sql, 0, 0, &errmsg);
    sqlite3_free(sql);
    if (rc != SQLITE_OK) {
        checkpoint_set_error(errmsg ? errmsg : "SAVEPOINT failed");
        if (errmsg) sqlite3_free(errmsg);
        return -1;
    }
    g_checkpoint_seq = id;
    return id;
}

/* Rolls back to (but does not release) checkpoint `id` - the checkpoint
 * itself stays open, so reverting to the same id again later still works,
 * matching SQLite's own ROLLBACK TO semantics (as opposed to RELEASE,
 * which this terminal never calls - checkpoints just accumulate for the
 * session, cheap for the bounded number of clicks a debug UI sees). */
int sql_checkpoint_revert(int id) {
    if (!g_db) { checkpoint_set_error("no database loaded"); return -1; }
    if (id < 1 || id > g_checkpoint_seq) { checkpoint_set_error("unknown checkpoint id"); return -1; }
    char *sql = sqlite3_mprintf("ROLLBACK TO cp%d", id);
    if (!sql) { checkpoint_set_error("out of memory"); return -1; }
    char *errmsg = 0;
    int rc = sqlite3_exec(g_db, sql, 0, 0, &errmsg);
    sqlite3_free(sql);
    if (rc != SQLITE_OK) {
        checkpoint_set_error(errmsg ? errmsg : "ROLLBACK TO failed");
        if (errmsg) sqlite3_free(errmsg);
        return -1;
    }
    return 0;
}

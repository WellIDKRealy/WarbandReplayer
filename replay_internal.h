#ifndef REPLAY_INTERNAL_H
#define REPLAY_INTERNAL_H
/* Shared between replay_worker.c (load/playback) and replay_export.c
 * (Phase 4 battle export pipeline) - the two are one logical module split
 * across files for size, not a real public/private library boundary, so
 * this just exposes the handful of symbols the export side needs instead
 * of duplicating them. */
#include "sqlite3.h"

#define MAX_MATCHES 16 /* up to 15 real battles per file, +1 headroom - shared so replay_export.c's g_bc_valid/g_bc_attached (the battle.db cache) stay sized identically to replay_worker.c's g_matches/g_battle_ready */

typedef struct MatchInfo {
    sqlite3_int64 start_tick_id, end_tick_id;
    double start_time, end_time;
    int scene_no;
    char faction_text[96];
    sqlite3_int64 rowid_lo, rowid_hi; /* this battle's own slice of agent_states, see replay_ensure_battle_ready */
} MatchInfo;

extern sqlite3 *g_db; /* the one long-lived read-write connection, main.db as primary */
extern int g_active_match_index; /* -1 = none yet; the battle replay.db/battle.db's on-demand views are built for, see replay_export.c */

int replay_ensure_battle_ready(int matchIdx);
int replay_get_match_count(void);
MatchInfo *replay_internal_get_match(int matchIdx);

const char *replay_get_source_sha256_hex(void); /* 64 hex chars + NUL, valid after replay_finish_load() */
const char *replay_get_source_filename(void);    /* JS-supplied via replay_get_filename_buf_ptr/replay_set_filename_len */
double replay_get_source_size_bytes(void);
double replay_get_export_time_unix(void);        /* JS-supplied via replay_set_export_time_unix, real Unix epoch seconds */
int replay_get_data_generation(void); /* monotonic write counter (sqlite3_update_hook), see replay_worker.c */

/* Checkpoint <-> replay engine integration (sql_terminal.c's
 * sql_checkpoint_revert calls both, in this order, around ROLLBACK TO). */
void replay_detach_generator_views(void);        /* replay_export.c - invalidates r/b/bcN caches before a revert (does NOT detach them - see its own comment on why) */
void replay_invalidate_caches_after_revert(void); /* replay_worker.c - rebuild tick/match/battle caches after a revert */

/* replay_export.c - ensures "b" is ATTACHed and populated (from cache or a
 * fresh derive) for whichever battle is g_active_match_index right now; a
 * cheap no-op if already valid for that battle/generation/script. Called
 * from replay_worker.c's build_frame_at_time on every real tick change (not
 * every RAF - see that call site's own comment) so default/user rendering
 * queries always have somewhere real to read from, the same self-healing
 * role sync_frame_state_tables used to play for the now-removed rb schema.
 * viewKind: 1 = replay.db (r), 2 = battle.db (b). Returns 0/1/negative, see
 * its own comment in replay_export.c. */
int replay_ensure_db_view(int viewKind);

/* sql_terminal.c - finalizes g_terminal_stmt if a query is currently sitting
 * idle-but-live (see that function's own comment) - replay_export.c's
 * attach_battledb_view calls this before resetting "b" so a stale terminal
 * query can never block a real battle switch's DROP TABLE. */
void sql_terminal_finalize_stmt(void);

/* replay_worker.c - shared memory-budget predicate (g_priming_budget_bytes
 * vs. heap_debug_bytes_inuse()), same one replay_ensure_battle_ready's
 * agent_states priming already uses - replay_export.c's roster/corpse
 * summary cache (replay_prewarm_battle_summary) shares this same budget
 * rather than getting a separate pool, since both are "memory spent making
 * battles near the cursor cheaper to reach", not two independent concerns. */
int replay_is_over_priming_budget(void);

int sql_checkpoint_init_baseline(void); /* sql_terminal.c - creates checkpoint #0; called once by replay_worker.c right after a load finishes */

#endif

#ifndef REPLAY_INTERNAL_H
#define REPLAY_INTERNAL_H
/* Shared between replay_worker.c (load/playback) and replay_export.c
 * (Phase 4 battle export pipeline) - the two are one logical module split
 * across files for size, not a real public/private library boundary, so
 * this just exposes the handful of symbols the export side needs instead
 * of duplicating them. */
#include "sqlite3.h"

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

#endif

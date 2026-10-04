/* Same code compiled native and wasm32-wasi: the per-battle pipeline (bisect, extract, index+bounds, derive) on a real replay.
   usage: bench_extract DB SPANS HISTORY_SQL CORPSES_SQL   (SPANS: "start_tick end_tick" per line) */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "sqlite3.h"

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }
static char *slurp(const char *p, long *n) {
  FILE *f = fopen(p, "rb"); if (!f) { perror(p); exit(2); }
  fseek(f, 0, SEEK_END); long len = ftell(f); fseek(f, 0, SEEK_SET);
  char *b = malloc(len + 1); if (fread(b, 1, len, f) != (size_t)len) exit(2);
  b[len] = 0; fclose(f); if (n) *n = len; return b;
}
static sqlite3 *g;
#define CK(x) do { int r_ = (x); if (r_ != SQLITE_OK && r_ != SQLITE_ROW && r_ != SQLITE_DONE) { fprintf(stderr, "sqlite error %d: %s (line %d)\n", r_, sqlite3_errmsg(g), __LINE__); exit(1); } } while (0)
static void exec(const char *sql) { char *e = 0; if (sqlite3_exec(g, sql, 0, 0, &e)) { fprintf(stderr, "exec failed: %s\n  %s\n", e, sql); exit(1); } }
static void execf(const char *fmt, sqlite3_int64 a, sqlite3_int64 b) { char *s = sqlite3_mprintf(fmt, a, b); exec(s); sqlite3_free(s); }

static sqlite3_int64 bisect(sqlite3_int64 lo_id, sqlite3_int64 hi_id, sqlite3_int64 tick, int upper) {
  sqlite3_stmt *st; CK(sqlite3_prepare_v2(g, "SELECT tick_id FROM s.agent_states WHERE id >= ?1 ORDER BY id LIMIT 1", -1, &st, 0));
  sqlite3_int64 lo = lo_id, hi = hi_id + 1;
  while (lo < hi) {
    sqlite3_int64 mid = lo + (hi - lo) / 2;
    sqlite3_reset(st); sqlite3_bind_int64(st, 1, mid);
    if (sqlite3_step(st) != SQLITE_ROW) { hi = mid; continue; }
    sqlite3_int64 t = sqlite3_column_int64(st, 0);
    if (upper ? t > tick : t >= tick) hi = mid; else lo = mid + 1;
  }
  sqlite3_finalize(st); return lo;
}

static void run_sql_into_b(const char *sql, const char *insert, sqlite3_int64 from, sqlite3_int64 to, int ncol) {
  sqlite3_stmt *q, *ins; CK(sqlite3_prepare_v2(g, sql, -1, &q, 0)); CK(sqlite3_prepare_v2(g, insert, -1, &ins, 0));
  int pf = sqlite3_bind_parameter_index(q, ":from_tick"), pt = sqlite3_bind_parameter_index(q, ":to_tick");
  if (pf) sqlite3_bind_int64(q, pf, from); if (pt) sqlite3_bind_int64(q, pt, to);
  exec("BEGIN");
  while (sqlite3_step(q) == SQLITE_ROW) {
    for (int i = 0; i < ncol; i++) sqlite3_bind_value(ins, i + 1, sqlite3_column_value(q, i));
    sqlite3_step(ins); sqlite3_reset(ins);
  }
  exec("COMMIT"); sqlite3_finalize(q); sqlite3_finalize(ins);
}

int main(int argc, char **argv) {
  if (argc < 5) { fprintf(stderr, "usage\n"); return 2; }
  long n; unsigned char *img = (unsigned char *)slurp(argv[1], &n);
  char *spans = slurp(argv[2], 0), *hist = slurp(argv[3], 0), *corp = slurp(argv[4], 0);
  /* DDL of the 9 recorder tables, read once */
  static char ddl[16][4096]; int nd = 0;
  { sqlite3 *d0; sqlite3_open(":memory:", &d0); g = d0; exec("ATTACH ':memory:' AS s");
    CK(sqlite3_deserialize(d0, "s", img, n, n, SQLITE_DESERIALIZE_READONLY));
    sqlite3_stmt *st; CK(sqlite3_prepare_v2(d0, "SELECT sql FROM s.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", -1, &st, 0));
    while (sqlite3_step(st) == SQLITE_ROW) strncpy(ddl[nd++], (const char *)sqlite3_column_text(st, 0), 4095);
    sqlite3_finalize(st); sqlite3_close(d0); }
  double t_bis = 0, t_ext = 0, t_idx = 0, t_der = 0; int battles = 0; sqlite3_int64 rows = 0;
  double t_all = now();
  for (char *line = spans; *line;) {
    long long st_t, et_t; char *nl = strchr(line, '\n'); if (sscanf(line, "%lld %lld", &st_t, &et_t) != 2) break;
    line = nl ? nl + 1 : line + strlen(line);
    sqlite3 *db; sqlite3_open(":memory:", &db); g = db;
    exec("PRAGMA temp_store=MEMORY; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; ATTACH ':memory:' AS s; ATTACH ':memory:' AS b;");
    CK(sqlite3_deserialize(db, "s", img, n, n, SQLITE_DESERIALIZE_READONLY));
    sqlite3_stmt *mm; CK(sqlite3_prepare_v2(db, "SELECT MIN(id), MAX(id) FROM s.agent_states", -1, &mm, 0)); sqlite3_step(mm);
    sqlite3_int64 id_lo = sqlite3_column_int64(mm, 0), id_hi = sqlite3_column_int64(mm, 1); sqlite3_finalize(mm);
    double a = now();
    sqlite3_int64 lo = bisect(id_lo, id_hi, st_t, 0), hi = bisect(id_lo, id_hi, et_t, 1) - 1;
    double b2 = now(); t_bis += b2 - a;
    for (int i = 0; i < nd; i++) exec(ddl[i]);
    exec("BEGIN");
    execf("INSERT INTO ticks SELECT * FROM s.ticks WHERE id BETWEEN %lld AND %lld", st_t, et_t);
    execf("INSERT INTO events SELECT * FROM s.events WHERE tick_id BETWEEN %lld AND %lld", st_t, et_t);
    const char *child[] = {"chats", "map_switches", "score_switches", "faction_switches", "kills", "spawns"};
    for (int i = 0; i < 6; i++) { char *q = sqlite3_mprintf("INSERT INTO %s SELECT * FROM s.%s WHERE event_id IN (SELECT id FROM events)", child[i], child[i]); exec(q); sqlite3_free(q); }
    execf("INSERT INTO agent_states SELECT * FROM s.agent_states WHERE id BETWEEN %lld AND %lld", lo, hi);
    exec("COMMIT");
    double c = now(); t_ext += c - b2;
    exec("CREATE INDEX idx_as_tick ON agent_states(tick_id)");
    sqlite3_stmt *bd; CK(sqlite3_prepare_v2(db, "SELECT MIN(pos_x), MAX(pos_x), MIN(pos_y), MAX(pos_y) FROM agent_states", -1, &bd, 0)); sqlite3_step(bd); sqlite3_finalize(bd);
    double d = now(); t_idx += d - c;
    exec("CREATE TABLE b.roster_history (agent_id INTEGER, team INTEGER, is_human INTEGER, spawn_event_id INTEGER, valid_from_tick INTEGER, valid_to_tick INTEGER); CREATE TABLE b.corpses (x REAL, y REAL, team INTEGER, tick_id INTEGER);");
    run_sql_into_b(hist, "INSERT INTO b.roster_history VALUES (?1,?2,?3,?4,?5,?6)", st_t - 2, et_t, 6);
    run_sql_into_b(corp, "INSERT INTO b.corpses VALUES (?1,?2,?3,?4)", st_t - 2, et_t, 4);
    t_der += now() - d; rows += hi - lo + 1; battles++;
    sqlite3_close(db);
  }
  double total = now() - t_all;
  printf("RESULT battles=%d rows=%lld total=%.3f bisect=%.3f extract=%.3f index_bounds=%.3f derive=%.3f per_battle_ms=%.1f\n",
         battles, (long long)rows, total, t_bis, t_ext, t_idx, t_der, 1000.0 * total / (battles ? battles : 1));
  return 0;
}

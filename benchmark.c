#include "ubench.h"

// Since your project overrides math.h in ./goyslopless-c/include/,
// cglm will automatically use your implementations of sinf, cosf, sqrtf, etc.
#include <cglm/cglm.h>
#include "sqlite3.h"
#include <stdlib.h>
#include <string.h>

#define NUM_ELEMENTS 100000

// Pre-allocate buffers to prevent WASM heap allocations during the benchmark
volatile vec3 vectors_in[NUM_ELEMENTS];
volatile vec3 vectors_out[NUM_ELEMENTS];
volatile mat4 matrices_out[NUM_ELEMENTS];
volatile versor quats_out[NUM_ELEMENTS];

#pragma GCC diagnostic push
// This ONLY ignores the dropped 'volatile' (or 'const') qualifier warning
#pragma GCC diagnostic ignored "-Wincompatible-pointer-types-discards-qualifiers"

// 1. Vector Normalization (Stresses: powf, sqrtf)
UBENCH(Graphics_cglm, VectorNormalize) {
  for (int j = 0; j < 100; j++) {
	for (int i = 0; i < NUM_ELEMENTS; i++) {
      // glm_vec3_normalize relies entirely on sqrtf (or your WASM f32.sqrt fallback)
      glm_vec3_normalize_to(vectors_in[i], vectors_out[i]);
	}
  }
}

// 2. 3D Euler Rotation Matrix (Stresses: sinf, cosf)
UBENCH(Graphics_cglm, EulerRotation) {
  vec3 angles = {0.5f, 1.2f, 0.3f}; // Pitch, Yaw, Roll
    
  for (int i = 0; i < NUM_ELEMENTS; i++) {
    // glm_euler_xyz intensely calls sinf and cosf to build the rotation matrix
    glm_euler_xyz(angles, matrices_out[i]);
        
    // Transform the vector using the generated matrix
    glm_mat4_mulv3(matrices_out[i], vectors_in[i], 1.0f, vectors_out[i]);
  }
}

// 3. Perspective Projection (Stresses: tanf)
UBENCH(Graphics_cglm, PerspectiveProjection) {
  for(int j = 0; j < 100; j++) {
	float fov = glm_rad(90.0f); // Uses your fmodf/fabs if glm_rad triggers it, but mostly constants
	float aspect = 16.0f / 9.0f;
	float nearZ = 0.1f;
	float farZ = 1000.0f;
    
	for (int i = 0; i < NUM_ELEMENTS; i++) {
      // glm_perspective directly relies on tanf(fov / 2)
      glm_perspective(fov, aspect, nearZ, farZ, matrices_out[i]);
	}
  }
}

// 4. View Matrix / LookAt (Stresses: sqrtf, cross products, f32 ops)
UBENCH(Graphics_cglm, CameraLookAt) {
  for(int j = 0; j < 100; j++) {
	vec3 up = {0.0f, 1.0f, 0.0f};
	vec3 target_offset = {1.0f, -0.5f, 2.0f};
    
	for (int i = 0; i < NUM_ELEMENTS; i++) {
      vec3 target;
      glm_vec3_add(vectors_in[i], target_offset, target);
        
      // glm_lookat stresses vector subtraction, cross products, and normalization (sqrtf)
      glm_lookat(vectors_in[i], target, up, matrices_out[i]);
	}
  }
}

// 5. Quaternion & Euler Conversions (Stresses: asinf, atan2f, sinf, cosf)
UBENCH(Graphics_cglm, QuatEulerConversions) {
  for (int i = 0; i < NUM_ELEMENTS; i++) {
    // Create an euler angle vector from our random inputs
    vec3 euler_in = { 
      vectors_in[i][0] * 0.01f, 
      vectors_in[i][1] * 0.01f, 
      vectors_in[i][2] * 0.01f 
    };
        
    // euler to quat uses sinf, cosf
    glm_euler_xyz_quat(euler_in, quats_out[i]);
        
    // quat to euler heavily stresses asinf and atan2f
	mat4 temp_rot;
	glm_quat_mat4(quats_out[i], temp_rot);
	glm_euler_angles(temp_rot, vectors_out[i]);
  }
}

#pragma GCC diagnostic pop

// ---------------------------------------------------------------------
// Allocator suites - validates the real boundary-tag free-list heap
// (goyslopless-c/lib/heap.c) that replaced the old 256KB bump/leak
// allocator, using churn patterns shaped like SQLite's actual allocation
// sizes (page buffers, VDBE registers, small B-tree cursor structs).
// ---------------------------------------------------------------------

UBENCH(Allocator, ChurnSmall) {
    void *ptrs[256];
    for (int iter = 0; iter < 200; iter++) {
        for (int i = 0; i < 256; i++) {
            size_t size = 16 + (size_t)((i * 37) % 240); // 16..256 bytes
            ptrs[i] = malloc(size);
        }
        for (int i = 0; i < 256; i++) free(ptrs[i]);
    }
}

UBENCH(Allocator, GrowFragmented) {
    // Interleave large/small allocations and free every other one, forcing
    // the allocator to actually coalesce/split rather than just bump-alloc.
    void *ptrs[128];
    for (int iter = 0; iter < 50; iter++) {
        for (int i = 0; i < 128; i++) {
            size_t size = (i % 4 == 0) ? 8192 : 32;
            ptrs[i] = malloc(size);
        }
        for (int i = 0; i < 128; i += 2) free(ptrs[i]);
        for (int i = 0; i < 128; i += 2) ptrs[i] = malloc(64);
        for (int i = 0; i < 128; i++) free(ptrs[i]);
    }
}

// ---------------------------------------------------------------------
// SQLite suites - measure the actual wins this project's rearchitecture
// depends on: indexes turning a full-table-scan lookup into a direct
// lookup, and an incremental delta-apply cursor turning an O(history)
// per-frame recompute into O(events crossed). Self-contained schemas
// here (not replay_worker.c's real one - that needs the WASM_THREADS/TLS
// heap this single-threaded benchmark build doesn't link) but faithfully
// representative of the same query shapes.
// ---------------------------------------------------------------------

#define BENCH_NUM_TICKS   2000
#define BENCH_AGENTS_PER_TICK 40
#define BENCH_NUM_SPAWNS  6000

static sqlite3 *bench_open_populated_db(int with_agent_states_index) {
    sqlite3 *db = 0;
    sqlite3_open(":memory:", &db);
    sqlite3_exec(db, "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;", 0, 0, 0);
    sqlite3_exec(db,
        "CREATE TABLE ticks(id INTEGER PRIMARY KEY, time INTEGER);"
        "CREATE TABLE agent_states(tick_id INTEGER, agent_id INTEGER, pos_x REAL, pos_y REAL);",
        0, 0, 0);

    sqlite3_exec(db, "BEGIN", 0, 0, 0);
    sqlite3_stmt *tickStmt = 0, *stateStmt = 0;
    sqlite3_prepare_v2(db, "INSERT INTO ticks(id,time) VALUES(?1,?1)", -1, &tickStmt, 0);
    sqlite3_prepare_v2(db, "INSERT INTO agent_states(tick_id,agent_id,pos_x,pos_y) VALUES(?1,?2,?3,?4)", -1, &stateStmt, 0);
    for (int t = 0; t < BENCH_NUM_TICKS; t++) {
        sqlite3_reset(tickStmt);
        sqlite3_bind_int(tickStmt, 1, t);
        sqlite3_step(tickStmt);
        for (int a = 0; a < BENCH_AGENTS_PER_TICK; a++) {
            sqlite3_reset(stateStmt);
            sqlite3_bind_int(stateStmt, 1, t);
            sqlite3_bind_int(stateStmt, 2, a);
            sqlite3_bind_double(stateStmt, 3, (double)a);
            sqlite3_bind_double(stateStmt, 4, (double)t);
            sqlite3_step(stateStmt);
        }
    }
    sqlite3_finalize(tickStmt);
    sqlite3_finalize(stateStmt);
    sqlite3_exec(db, "COMMIT", 0, 0, 0);

    if (with_agent_states_index) {
        sqlite3_exec(db, "CREATE INDEX idx_agent_states_tick ON agent_states(tick_id)", 0, 0, 0);
    }
    return db;
}

UBENCH(SQLite, CreateIndexCost) {
    sqlite3 *db = bench_open_populated_db(0);
    sqlite3_exec(db, "CREATE INDEX idx_agent_states_tick ON agent_states(tick_id)", 0, 0, 0);
    sqlite3_close(db);
}

UBENCH(SQLite, NaiveQuery_NoIndex) {
    sqlite3 *db = bench_open_populated_db(0);
    sqlite3_stmt *stmt = 0;
    sqlite3_prepare_v2(db, "SELECT pos_x, pos_y FROM agent_states WHERE tick_id = ?1", -1, &stmt, 0);
    // simulate 100 sequential frame lookups against the unindexed table -
    // this is the shape of the original per-frame query before indexing.
    for (int f = 0; f < 100; f++) {
        sqlite3_reset(stmt);
        sqlite3_bind_int(stmt, 1, f % BENCH_NUM_TICKS);
        while (sqlite3_step(stmt) == SQLITE_ROW) { /* drain */ }
    }
    sqlite3_finalize(stmt);
    sqlite3_close(db);
}

UBENCH(SQLite, IndexedQuery) {
    sqlite3 *db = bench_open_populated_db(1);
    sqlite3_stmt *stmt = 0;
    sqlite3_prepare_v2(db, "SELECT pos_x, pos_y FROM agent_states WHERE tick_id = ?1", -1, &stmt, 0);
    for (int f = 0; f < 100; f++) {
        sqlite3_reset(stmt);
        sqlite3_bind_int(stmt, 1, f % BENCH_NUM_TICKS);
        while (sqlite3_step(stmt) == SQLITE_ROW) { /* drain */ }
    }
    sqlite3_finalize(stmt);
    sqlite3_close(db);
}

static sqlite3 *bench_open_spawns_db(int with_index) {
    sqlite3 *db = 0;
    sqlite3_open(":memory:", &db);
    sqlite3_exec(db, "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;", 0, 0, 0);
    sqlite3_exec(db, "CREATE TABLE spawns(tick_id INTEGER, agent_id INTEGER)", 0, 0, 0);
    sqlite3_exec(db, "BEGIN", 0, 0, 0);
    sqlite3_stmt *stmt = 0;
    sqlite3_prepare_v2(db, "INSERT INTO spawns(tick_id,agent_id) VALUES(?1,?2)", -1, &stmt, 0);
    for (int i = 0; i < BENCH_NUM_SPAWNS; i++) {
        sqlite3_reset(stmt);
        sqlite3_bind_int(stmt, 1, (i * BENCH_NUM_TICKS) / BENCH_NUM_SPAWNS);
        sqlite3_bind_int(stmt, 2, i % 64);
        sqlite3_step(stmt);
    }
    sqlite3_finalize(stmt);
    sqlite3_exec(db, "COMMIT", 0, 0, 0);
    if (with_index) sqlite3_exec(db, "CREATE INDEX idx_spawns_tick ON spawns(tick_id)", 0, 0, 0);
    return db;
}

// "Naive": re-derive from-scratch (tick_id <= target) on every one of K
// simulated frame advances - what a per-frame full-history query does.
UBENCH(SQLite, FullReseek_PerFrame) {
    sqlite3 *db = bench_open_spawns_db(0);
    sqlite3_stmt *stmt = 0;
    sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM spawns WHERE tick_id <= ?1", -1, &stmt, 0);
    for (int step = 0; step < BENCH_NUM_TICKS; step += 4) {
        sqlite3_reset(stmt);
        sqlite3_bind_int(stmt, 1, step);
        sqlite3_step(stmt);
    }
    sqlite3_finalize(stmt);
    sqlite3_close(db);
}

// "Smart": indexed + bounded to (last_tick, target] - the incremental
// delta-apply shape replay_worker.c's roster cursor actually uses.
UBENCH(SQLite, IncrementalDelta_PerFrame) {
    sqlite3 *db = bench_open_spawns_db(1);
    sqlite3_stmt *stmt = 0;
    sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM spawns WHERE tick_id > ?1 AND tick_id <= ?2", -1, &stmt, 0);
    int last_tick = -1;
    for (int step = 0; step < BENCH_NUM_TICKS; step += 4) {
        sqlite3_reset(stmt);
        sqlite3_bind_int(stmt, 1, last_tick);
        sqlite3_bind_int(stmt, 2, step);
        sqlite3_step(stmt);
        last_tick = step;
    }
    sqlite3_finalize(stmt);
    sqlite3_close(db);
}

UBENCH_STATE();

int main(void) {
  // Generate deterministic pseudo-random geometry data
  for (int i = 0; i < NUM_ELEMENTS; i++) {
    vectors_in[i][0] = (float)(i % 100) * 0.1f - 5.0f;
    vectors_in[i][1] = (float)(i % 50)  * 0.2f - 5.0f;
    vectors_in[i][2] = (float)(i % 10)  * 1.5f + 0.1f; // Avoid zero length
  }
    
  return ubench_main(0, 0);
}

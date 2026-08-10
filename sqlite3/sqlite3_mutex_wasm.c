/*
 * Real sqlite3_mutex_methods for the multithreaded (-DSQLITE_THREADSAFE=1,
 * WASM_THREADS) replay_worker.wasm build, backed by wasm32 atomics
 * (-matomics). Registered once by the loader thread via
 *   sqlite3_config(SQLITE_CONFIG_MUTEX, wasm_mutex_methods_get());
 * before sqlite3_initialize() - and before any other worker touches any
 * SQLite API, since bootstrapping the mutex subsystem itself can't be
 * mutex-protected.
 *
 * Two mutex "shapes", per SQLite's own contract:
 *  - SQLITE_MUTEX_FAST / SQLITE_MUTEX_RECURSIVE: a fresh mutex per
 *    xMutexAlloc() call (one per open connection/BtShared/etc), served
 *    from a small fixed pool (claimed via atomic CAS on the slot's
 *    in-use flag, so concurrent allocation from multiple threads is
 *    itself race-free).
 *  - SQLITE_MUTEX_STATIC_*: a fixed singleton per kind, shared globally -
 *    same pointer returned every time for the same kind.
 *
 * Locking itself is a compare-exchange spin loop, not a real futex wait -
 * SQLite's critical sections here (page cache/B-tree bookkeeping) are
 * short, so spinning is simple and adequate; not worth the extra
 * complexity of memory.atomic.wait32/notify unless profiling shows real
 * contention.
 */
#include "sqlite3.h"
#include "wasm_thread.h"
#include <stdatomic.h>
#include <stddef.h>

#define WASM_MUTEX_POOL_SIZE   32 /* dynamically "allocated" fast/recursive mutexes */
#define WASM_MUTEX_STATIC_BASE 2  /* SQLITE_MUTEX_STATIC_MAIN */
#define WASM_MUTEX_STATIC_MAX  13 /* SQLITE_MUTEX_STATIC_VFS3, highest defined kind */
#define WASM_MUTEX_STATIC_COUNT (WASM_MUTEX_STATIC_MAX - WASM_MUTEX_STATIC_BASE + 1)

struct sqlite3_mutex {
    _Atomic int locked;   /* 0 = free, 1 = held */
    _Atomic int owner;    /* wasm_current_thread_id() of the holder, -1 if free */
    _Atomic int in_use;   /* pool bookkeeping only; always 1 for static mutexes */
    int depth;            /* recursion depth; only meaningful while locked */
    int is_recursive;
};

static struct sqlite3_mutex g_pool[WASM_MUTEX_POOL_SIZE];
static struct sqlite3_mutex g_static[WASM_MUTEX_STATIC_COUNT];

static int wasmMutexInit(void) { return SQLITE_OK; }
static int wasmMutexEnd(void) { return SQLITE_OK; }

static sqlite3_mutex *wasmMutexAlloc(int kind) {
    if (kind == SQLITE_MUTEX_FAST || kind == SQLITE_MUTEX_RECURSIVE) {
        for (int i = 0; i < WASM_MUTEX_POOL_SIZE; i++) {
            int expected = 0;
            if (atomic_compare_exchange_strong(&g_pool[i].in_use, &expected, 1)) {
                g_pool[i].locked = 0;
                g_pool[i].owner = -1;
                g_pool[i].depth = 0;
                g_pool[i].is_recursive = (kind == SQLITE_MUTEX_RECURSIVE);
                return &g_pool[i];
            }
        }
        return NULL; /* pool exhausted - would need a bigger WASM_MUTEX_POOL_SIZE */
    }

    int idx = kind - WASM_MUTEX_STATIC_BASE;
    if (idx < 0 || idx >= WASM_MUTEX_STATIC_COUNT) idx = 0; /* defensive clamp */
    struct sqlite3_mutex *m = &g_static[idx];
    m->is_recursive = 1; /* SQLite treats static mutexes as recursive-safe */
    m->in_use = 1;
    return m;
}

static void wasmMutexFree(sqlite3_mutex *m) {
    if (m >= g_pool && m < g_pool + WASM_MUTEX_POOL_SIZE) {
        atomic_store(&m->in_use, 0);
    }
    /* static mutexes are never freed */
}

static void wasmMutexEnter(sqlite3_mutex *m) {
    int me = wasm_current_thread_id();
    if (m->is_recursive && atomic_load(&m->owner) == me && atomic_load(&m->locked)) {
        m->depth++;
        return;
    }
    int expected;
    do {
        expected = 0;
    } while (!atomic_compare_exchange_weak(&m->locked, &expected, 1));
    atomic_store(&m->owner, me);
    m->depth = 1;
}

static int wasmMutexTry(sqlite3_mutex *m) {
    int me = wasm_current_thread_id();
    if (m->is_recursive && atomic_load(&m->owner) == me && atomic_load(&m->locked)) {
        m->depth++;
        return SQLITE_OK;
    }
    int expected = 0;
    if (atomic_compare_exchange_strong(&m->locked, &expected, 1)) {
        atomic_store(&m->owner, me);
        m->depth = 1;
        return SQLITE_OK;
    }
    return SQLITE_BUSY;
}

static void wasmMutexLeave(sqlite3_mutex *m) {
    m->depth--;
    if (m->depth > 0) return;
    atomic_store(&m->owner, -1);
    atomic_store(&m->locked, 0);
}

static int wasmMutexHeld(sqlite3_mutex *m) {
    return atomic_load(&m->locked) != 0 && atomic_load(&m->owner) == wasm_current_thread_id();
}

static int wasmMutexNotheld(sqlite3_mutex *m) {
    return !wasmMutexHeld(m);
}

static const sqlite3_mutex_methods wasm_mutex_methods = {
    wasmMutexInit, wasmMutexEnd, wasmMutexAlloc, wasmMutexFree,
    wasmMutexEnter, wasmMutexTry, wasmMutexLeave, wasmMutexHeld, wasmMutexNotheld
};

const sqlite3_mutex_methods *wasm_mutex_methods_get(void) {
    return &wasm_mutex_methods;
}

#ifndef _WASM_LAYOUT_H
#define _WASM_LAYOUT_H

#include "stddef.h"

/*
 * Fixed shared-memory layout for the replay_worker.wasm multithreaded
 * build. Everything below __heap_base (linker-provided: first free byte
 * after static data) is carved up once, up front, into non-overlapping
 * regions - no runtime memory.grow calls happen in this build at all
 * (only the single-threaded main.wasm/benchmark.wasm heap grows
 * dynamically; see heap.c), so two threads can never race over growing
 * shared memory.
 *
 *   [__heap_base .. +LOADER_HEAP)        thread 0's (loader) private heap
 *   [.. +N*WORKER_HEAP)                  threads 1..N's (reader/playback) private heaps
 *   [REGION_A_BASE .. +SIZE)             the loaded/indexed DB blob (frozen after load)
 *   [REGION_C_BASE .. +SIZE)             per-match result summaries written by reader workers
 *
 * The loader's heap is deliberately much bigger than the others: it's the
 * one thread that runs `CREATE INDEX` over the real schema's largest
 * table (agent_states, 2M+ rows in a real 15-battle file) - confirmed
 * empirically to need far more than a "just big enough for simple
 * queries" slab (SQLite's page cache + external sort/B-tree-build
 * scratch space during index creation genuinely needs tens to low
 * hundreds of MB at that row count). Reader/playback threads only ever
 * run simple bounded queries and stay small.
 */
#if defined(WASM_THREADS)

#define WASM_LOADER_HEAP_SIZE   (256u * 1024u * 1024u) /* thread 0: CREATE INDEX over 2M+ rows */
#define WASM_WORKER_HEAP_SIZE   (24u  * 1024u * 1024u) /* threads 1..N: simple bounded queries */
#define WASM_MAX_WORKER_THREADS 8u                     /* up to 8 readers (thread ids 1..8) */
#define WASM_PREFETCH_HEAP_SIZE (96u  * 1024u * 1024u) /* thread 9: prefetch - runs the same
                                                          * CREATE INDEX path as the loader, just
                                                          * scoped to one battle's rows instead of
                                                          * the whole table, so it needs more than a
                                                          * reader's 24MB but not the loader's 256MB */
#define WASM_PREFETCH_THREAD_ID 9

#define WASM_REGION_A_SIZE    (320u * 1024u * 1024u)  /* shared DB blob (+ index overhead) */
#define WASM_REGION_C_SIZE    (8u   * 1024u * 1024u)  /* shared per-match results */

extern unsigned char __heap_base;

static inline unsigned char *wasm_thread_heap_base(int thread_id) {
    if (thread_id <= 0) return &__heap_base;
    if (thread_id <= (int)WASM_MAX_WORKER_THREADS)
        return &__heap_base + (size_t)WASM_LOADER_HEAP_SIZE + (size_t)(thread_id - 1) * (size_t)WASM_WORKER_HEAP_SIZE;
    /* prefetch thread: its own slab, right after the last reader slab */
    return &__heap_base + (size_t)WASM_LOADER_HEAP_SIZE + (size_t)WASM_MAX_WORKER_THREADS * (size_t)WASM_WORKER_HEAP_SIZE;
}
static inline size_t wasm_thread_heap_size(int thread_id) {
    if (thread_id <= 0) return (size_t)WASM_LOADER_HEAP_SIZE;
    if (thread_id <= (int)WASM_MAX_WORKER_THREADS) return (size_t)WASM_WORKER_HEAP_SIZE;
    return (size_t)WASM_PREFETCH_HEAP_SIZE;
}

static inline unsigned char *wasm_region_a_base(void) {
    return &__heap_base + (size_t)WASM_LOADER_HEAP_SIZE + (size_t)WASM_MAX_WORKER_THREADS * (size_t)WASM_WORKER_HEAP_SIZE
           + (size_t)WASM_PREFETCH_HEAP_SIZE;
}
static inline unsigned char *wasm_region_c_base(void) {
    return wasm_region_a_base() + (size_t)WASM_REGION_A_SIZE;
}
static inline unsigned char *wasm_layout_end(void) {
    return wasm_region_c_base() + (size_t)WASM_REGION_C_SIZE;
}

/* JS-side per-thread stack/TLS pools (see replay-worker.js's bootstrap())
 * live here, past wasm_layout_end() - NOT as hand-picked JS constants. They
 * used to be hardcoded at 300MB/400MB "clear of" this layout by eyeball;
 * that estimate was wrong (this layout's own regions already reached
 * ~449-777MB with 8 reader slabs, before the prefetch slab even existed) and
 * the two silently overlapped for however long readers happened to not
 * allocate far enough into their slab to prove it. JS now reads these back
 * via wasm_debug_stack_pool_base()/wasm_debug_tls_pool_base() instead of
 * duplicating the arithmetic, so this can never drift out of sync again. */
#define WASM_MAX_THREAD_ID     (WASM_PREFETCH_THREAD_ID) /* highest thread_id ever used (loader=0, readers=1..8, prefetch=9) */
#define WASM_STACK_SLOT_SIZE   (4u  * 1024u * 1024u)
#define WASM_TLS_SLOT_SIZE     (64u * 1024u)

static inline unsigned char *wasm_stack_pool_base(void) { return wasm_layout_end(); }
static inline unsigned char *wasm_tls_pool_base(void) {
    return wasm_stack_pool_base() + (size_t)(WASM_MAX_THREAD_ID + 1) * (size_t)WASM_STACK_SLOT_SIZE;
}

#endif /* WASM_THREADS */

#endif

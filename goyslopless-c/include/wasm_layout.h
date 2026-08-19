#ifndef _WASM_LAYOUT_H
#define _WASM_LAYOUT_H

#include "stddef.h"

/*
 * Fixed shared-memory layout for the replay_worker.wasm multithreaded
 * build. Everything below __heap_base (linker-provided: first free byte
 * after static data) is carved up once, up front, into non-overlapping
 * regions.
 *
 *   [__heap_base .. +LOADER_HEAP)        thread 0's (loader) private heap
 *   [.. +N*WORKER_HEAP)                  threads 1..N's (reader/playback) private heaps
 *   [REGION_C_BASE .. +SIZE)             per-match result summaries written by reader workers
 *
 * The loaded/indexed DB blob used to live here too (the old "Region A",
 * 320MiB, a fixed shared RAM buffer holding the ENTIRE uploaded replay file
 * - the direct blocker for large files, see sqlite3_vfs_mem.c's OPFS-backed
 * MemFile mode which replaced it). It's gone from this layout entirely now:
 * the source file lives in OPFS (real backing storage, not linear memory),
 * fronted by a small _Thread_local page cache in sqlite3_vfs_mem.c that
 * needs no fixed region here since it's ordinary per-thread heap-adjacent
 * static storage, not a shared cross-thread mapping.
 *
 * Phase 6: these are NOMINAL starting sizes, not hard caps - every one of
 * them is just the address-space offset where the NEXT region starts, and
 * heap.c's heap_extend_threaded() already transparently grows any thread
 * past its nominal slab via additional disjoint regions (proven, not
 * theoretical: an 8MiB loader slab was deliberately stress-tested against a
 * real CREATE INDEX over 2.3M rows and passed 48/48 cases - see
 * MAX_HEAP_REGIONS's own history below). Since going over a nominal size
 * costs nothing but an extra region (a few dozen bytes of bookkeeping) and
 * a memory.grow call, these are sized to the SMALL, boring, common case,
 * not the large one - the 128MB-floor target this whole layout has to fit
 * inside depends on that: `wasm_layout_end()`'s total is what
 * --initial-memory has to cover up front (see the Makefile), and every
 * byte reserved here "just in case" is a byte that floor doesn't have.
 * Loader keeps the same 8MiB already proven safe by that stress test;
 * reader/prefetch shrink further since they were never the thing driving
 * the old, much larger numbers - nothing here changes what any thread can
 * eventually grow into, only what it starts with.
 */
#if defined(WASM_THREADS)

#define WASM_LOADER_HEAP_SIZE   (8u   * 1024u * 1024u) /* thread 0: CREATE INDEX over 2M+ rows - grows from here via heap_extend_threaded, proven down to exactly this size under real stress */
#define WASM_WORKER_HEAP_SIZE   (2u   * 1024u * 1024u) /* threads 1..N: simple bounded bisection queries, no CREATE INDEX */
#define WASM_MAX_WORKER_THREADS 8u                     /* up to 8 readers (thread ids 1..8) - an address-space ceiling, not a memory cost (unused slots are never grown into) */
#define WASM_PREFETCH_HEAP_SIZE (4u   * 1024u * 1024u) /* thread 9: prefetch - runs the same CREATE
                                                          * INDEX path as the loader, but scoped to
                                                          * one battle's rows, not the whole table -
                                                          * grows from here the same way the loader does */
#define WASM_PREFETCH_THREAD_ID 9

/* Real usage is 8 BoundsSlot structs (replay_worker.c's region_c_bounds_slots,
 * 20 bytes each = 160 bytes) - one per possible reader, written directly
 * (not grown into), so this can't rely on heap_extend_threaded like the
 * heap regions above. 4KiB is a page-ish round number with ~25x headroom,
 * not the 8MiB this used to reserve for a 160-byte array. */
#define WASM_REGION_C_SIZE    (4u   * 1024u)

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

static inline unsigned char *wasm_region_c_base(void) {
    return &__heap_base + (size_t)WASM_LOADER_HEAP_SIZE + (size_t)WASM_MAX_WORKER_THREADS * (size_t)WASM_WORKER_HEAP_SIZE
           + (size_t)WASM_PREFETCH_HEAP_SIZE;
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

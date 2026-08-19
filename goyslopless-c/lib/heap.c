#include "stdlib.h"
#include "string.h"
#include <stdint.h>

/*
 * Real heap allocator for the wasm32 bare-metal build, replacing the old
 * 256KB fixed bump arena (which never reclaimed anything - free() was a
 * no-op). Boundary-tag, single explicit free list, first-fit with
 * split/coalesce. Grows on demand via __builtin_wasm_memory_grow().
 *
 * Two layout modes, selected at compile time:
 *
 *  - Default (single-threaded targets: main.wasm, benchmark.wasm): one
 *    heap starting at the linker-provided __heap_base symbol (the first
 *    free byte after all static data), growing via memory.grow as needed.
 *    Always one contiguous region (nothing else shares this memory), so a
 *    grow always extends the SAME region's tail in place.
 *
 *  - WASM_THREADS (replay_worker.wasm): each thread gets its own fixed,
 *    non-overlapping slab up front (wasm_thread_heap_base/size,
 *    wasm_layout.h), like before - but unlike before, a thread whose slab
 *    fills up now grows via memory.grow too, same underlying primitive as
 *    the non-threaded path. The wrinkle: slabs sit back-to-back in the
 *    original fixed layout with no gap, so a thread can't extend its OWN
 *    slab in place (that address range already belongs to the NEXT
 *    thread's slab) - growth always lands at whatever the CURRENT total
 *    memory size happens to be, which is wherever the grow-ing thread's
 *    call to memory.grow put it, not adjacent to that thread's existing
 *    slab. So a threaded heap is a small LIST of disjoint regions (the
 *    original fixed slab, plus zero or more later growth regions), not one
 *    contiguous span - see HeapRegion/MAX_HEAP_REGIONS below. No extra
 *    lock around the grow call itself: memory.grow on a SHARED memory is
 *    specified to be safely callable concurrently from multiple threads,
 *    each getting back the correct previous size marking exactly where
 *    ITS new region begins (this is precisely why memory.grow returns the
 *    old size at all - it's the mechanism the spec provides for this).
 *    Confirmed via the threads proposal's own rationale, not assumed.
 *    Heap state itself is `_Thread_local` either way: under a shared
 *    WebAssembly.Memory, a plain (non-TLS) global would alias the *same*
 *    address across every worker instance, since linear memory - unlike
 *    wasm globals - really is one physical resource shared by all
 *    instances. TLS is the only way to get genuinely per-thread mutable
 *    state here, and since each thread only ever touches its OWN
 *    _Thread_local HeapState, there's no cross-thread race on the
 *    bookkeeping either - the grow call is the only shared-resource touch.
 */

#if defined(WASM_THREADS)
#include "wasm_layout.h" /* wasm_thread_heap_base/size - single source of truth for the layout */
#else
extern unsigned char __heap_base;
#endif

#define WASM_PAGE_SIZE   65536u
#define IN_USE_BIT       ((size_t)1)
#define ALIGN8(n)        (((n) + 7u) & ~(size_t)7u)

typedef struct FreeNode {
    struct FreeNode *prev;
    struct FreeNode *next;
} FreeNode;

#define MIN_PAYLOAD      (ALIGN8(sizeof(FreeNode)))
#define CHUNK_OVERHEAD   (sizeof(size_t) * 2u) /* header + footer */

#if defined(WASM_THREADS)
/* 16 here was a real bug, not a safety margin: a genuine CREATE INDEX over
 * a real 2M+-row table, forced to grow from a deliberately-shrunk 8MiB
 * starting slab, hit this cap with room to spare (confirmed empirically:
 * heap_debug_region_count()==16, heap_debug_extend_failures()>=1,
 * sqlite3_errmsg()=="query aborted" - a malloc() returning NULL mid-query
 * from SQLite's perspective, silently producing an INCOMPLETE index rather
 * than a hard load-time failure, since the failing allocation happened
 * inside a lazily-triggered per-battle index build during playback, not
 * the eagerly-checked initial load). 256 is generous headroom over what
 * that same investigation showed was actually needed once regions ALSO
 * grow in bigger increments (see the "pages < 4u" minimum below, raised
 * for the same reason) - each slot is just 8 bytes, so the array itself
 * costs 2KiB per thread regardless of how conservative this number is. */
#define MAX_HEAP_REGIONS 256
typedef struct HeapRegion {
    unsigned char *base;
    unsigned char *limit;
} HeapRegion;

typedef struct HeapState {
    HeapRegion regions[MAX_HEAP_REGIONS];
    int region_count;
    FreeNode *free_head;
    unsigned char initialized;
} HeapState;

static _Thread_local HeapState g_heap;

/* Which region (if any) contains this address - chunk_prev_phys/free() need
 * this to know the containing region's bounds, since a threaded heap is a
 * list of disjoint regions rather than one contiguous span. */
static HeapRegion *heap_region_containing(void *addr) {
    for (int i = 0; i < g_heap.region_count; i++) {
        if ((unsigned char *)addr >= g_heap.regions[i].base && (unsigned char *)addr < g_heap.regions[i].limit)
            return &g_heap.regions[i];
    }
    return NULL;
}
#else
typedef struct HeapState {
    unsigned char *region_base;
    unsigned char *region_limit;   /* hard ceiling for this heap's region */
    unsigned char *wilderness_end; /* end of the last carved-out chunk */
    FreeNode *free_head;
    unsigned char initialized;
} HeapState;

static HeapState g_heap;
#endif

/* ---- chunk helpers ---------------------------------------------------- */

static inline size_t *chunk_header(void *chunk_addr) { return (size_t *)chunk_addr; }

static inline size_t chunk_size(void *chunk_addr) {
    return *chunk_header(chunk_addr) & ~IN_USE_BIT;
}

static inline int chunk_inuse(void *chunk_addr) {
    return (*chunk_header(chunk_addr) & IN_USE_BIT) != 0;
}

static inline unsigned char *chunk_payload(void *chunk_addr) {
    return (unsigned char *)chunk_addr + sizeof(size_t);
}

static inline void *payload_chunk(void *payload) {
    return (unsigned char *)payload - sizeof(size_t);
}

static inline size_t *chunk_footer(void *chunk_addr) {
    return (size_t *)(chunk_payload(chunk_addr) + chunk_size(chunk_addr));
}

/* total on-wire size of a chunk (header+payload+footer) */
static inline size_t chunk_total(void *chunk_addr) {
    return CHUNK_OVERHEAD + chunk_size(chunk_addr);
}

static void chunk_set(void *chunk_addr, size_t payload_size, int inuse) {
    size_t tagged = payload_size | (inuse ? IN_USE_BIT : 0);
    *chunk_header(chunk_addr) = tagged;
    *chunk_footer(chunk_addr) = tagged;
}

/* Bytes actually handed out and not yet freed, for THIS thread - distinct
 * from region_count/the regions[] span (WASM_THREADS branch below), which
 * only ever grows (WASM linear memory can't shrink, so committed address
 * space is monotonic). This is the signal a memory-budget/eviction feature
 * needs: freeing a battle's SQLite index+statement via DROP INDEX/
 * sqlite3_finalize routes through free() below and genuinely lowers this
 * counter (the free-list chunk becomes available for a LATER allocation to
 * reuse), even though it can never lower region_count or hand memory back
 * to the browser. Declared here (shared by both build variants) rather than
 * inside the WASM_THREADS-only block below because malloc/free/realloc
 * below have one shared body for both variants - only heap_debug_
 * bytes_inuse() itself (declared further down, next to the other debug
 * getters) is WASM_THREADS-only, matching heap_debug_region_count()'s
 * existing precedent of only exposing introspection for the threaded build.
 * Adjusted at every place a chunk's in-use/free status actually changes:
 * malloc's two chunk_set(...,1) sites, free's chunk_set(...,0) site, and
 * realloc's in-place-grow-into-a-free-neighbor chunk_set sites (which
 * bypass malloc/free entirely). */
static _Thread_local size_t g_heap_bytes_inuse = 0;

static inline void *chunk_next_phys(void *chunk_addr) {
    return (unsigned char *)chunk_addr + chunk_total(chunk_addr);
}

/* NULL if chunk_addr is at the base of its containing region (no physical
 * predecessor - regions are disjoint under WASM_THREADS, see the top-of-file
 * comment, so "predecessor" only means anything within the SAME region). */
static void *chunk_prev_phys(void *chunk_addr) {
#if defined(WASM_THREADS)
    HeapRegion *r = heap_region_containing(chunk_addr);
    if (!r || (unsigned char *)chunk_addr <= r->base) return NULL;
#else
    if ((unsigned char *)chunk_addr <= g_heap.region_base) return NULL;
#endif
    size_t *prev_footer = (size_t *)((unsigned char *)chunk_addr - sizeof(size_t));
    size_t prev_size = *prev_footer & ~IN_USE_BIT;
    return (unsigned char *)chunk_addr - CHUNK_OVERHEAD - prev_size;
}

/* ---- free list (unordered, LIFO push - O(1) insert/remove) ------------ */

static void freelist_push(FreeNode *n) {
    n->prev = NULL;
    n->next = g_heap.free_head;
    if (g_heap.free_head) g_heap.free_head->prev = n;
    g_heap.free_head = n;
}

static void freelist_remove(FreeNode *n) {
    if (n->prev) n->prev->next = n->next; else g_heap.free_head = n->next;
    if (n->next) n->next->prev = n->prev;
}

static void free_chunk_push(void *chunk_addr) {
    freelist_push((FreeNode *)chunk_payload(chunk_addr));
}

static void free_chunk_remove(void *chunk_addr) {
    freelist_remove((FreeNode *)chunk_payload(chunk_addr));
}

/* ---- region setup ------------------------------------------------------ */

#if defined(WASM_THREADS)

void heap_thread_init(int thread_id) {
    unsigned char *base = wasm_thread_heap_base(thread_id);
    size_t slab_size = wasm_thread_heap_size(thread_id);
    g_heap.region_count = 1;
    g_heap.regions[0].base = base;
    g_heap.regions[0].limit = base + slab_size;
    g_heap.free_head = NULL;
    g_heap.initialized = 1;

    chunk_set(base, slab_size - CHUNK_OVERHEAD, 0);
    free_chunk_push(base);
}

/* Called when a thread's existing region(s) can't satisfy an allocation -
 * grows the SHARED WebAssembly.Memory (safe to call concurrently from
 * multiple threads with no extra lock, see the top-of-file comment) and
 * registers the newly-grown pages as a brand new region for THIS thread.
 * Unlike the non-threaded heap_extend, this can't assume the new pages are
 * adjacent to anything this thread already owns - they land at whatever
 * the global memory size happened to be the instant this thread's grow
 * call landed, which could be anywhere past the fixed layout depending on
 * what other threads have grown in the meantime. So: always a new region,
 * never an in-place extension of an existing one. */
/* Counts genuine grow failures (MAX_HEAP_REGIONS exhausted, or hit
 * --max-memory's ceiling) - see heap_debug_extend_failures below. A nonzero
 * count here after a real load is a real signal something needs tuning
 * (MAX_HEAP_REGIONS, the per-grow minimum, or --max-memory itself) - this
 * exact counter is what caught MAX_HEAP_REGIONS being too low in the first
 * place (a genuine CREATE INDEX over 2M+ rows hit it under a deliberately
 * shrunk starting heap, silently producing an incomplete index rather than
 * a hard load-time error, since the failing allocation was inside a
 * lazily-triggered per-battle index build during playback). */
static int g_heap_extend_failures = 0;

static int heap_extend_threaded(size_t min_bytes) {
    if (g_heap.region_count >= MAX_HEAP_REGIONS) { g_heap_extend_failures++; return 0; }

    size_t need = min_bytes + CHUNK_OVERHEAD;
    unsigned pages = (unsigned)((need + WASM_PAGE_SIZE - 1u) / WASM_PAGE_SIZE);
    /* Grow at least 4MiB (64 pages) at a time, not 256KiB - each grow call
     * becomes a brand new, never-merged-with-anything-else region (see the
     * top-of-file comment on why), so a too-small minimum here is what
     * actually caused the MAX_HEAP_REGIONS bug above: a real CREATE INDEX
     * needing on the order of 150-200MiB beyond an 8MiB starting slab took
     * enough 256KiB-at-a-time grows to exceed a 16-region cap outright.
     * 4MiB cuts that same growth to a few dozen regions at most - comfortably
     * inside the new 256-region headroom with real margin, not just a
     * bigger number chasing the same problem. */
    if (pages < 64u) pages = 64u;

    int prev_pages = __builtin_wasm_memory_grow(0, pages);
    if (prev_pages < 0) { g_heap_extend_failures++; return 0; } /* hit --max-memory's ceiling */

    unsigned char *new_base = (unsigned char *)(uintptr_t)((size_t)prev_pages * WASM_PAGE_SIZE);
    size_t new_bytes = (size_t)pages * WASM_PAGE_SIZE;

    int idx = g_heap.region_count++;
    g_heap.regions[idx].base = new_base;
    g_heap.regions[idx].limit = new_base + new_bytes;

    chunk_set(new_base, new_bytes - CHUNK_OVERHEAD, 0);
    free_chunk_push(new_base);
    return 1;
}

/* Debug introspection for the current thread's heap health - how many
 * regions it's grown into, and how many grow attempts have genuinely
 * failed (see g_heap_extend_failures above). Matches the existing
 * wasm_vfs_debug_shared_count-style precedent (sqlite3_vfs_mem.c) for
 * exposing internal state as a plain getter rather than a one-off. */
int heap_debug_region_count(void) { return g_heap.region_count; }
int heap_debug_extend_failures(void) { return g_heap_extend_failures; }
size_t heap_debug_bytes_inuse(void) { return g_heap_bytes_inuse; }

#else

static int heap_extend(size_t min_bytes) {
    size_t need = min_bytes + CHUNK_OVERHEAD;
    unsigned pages = (unsigned)((need + WASM_PAGE_SIZE - 1u) / WASM_PAGE_SIZE);
    if (pages < 4u) pages = 4u; /* grow at least 256KB at a time to avoid thrashing */

    int prev_pages = __builtin_wasm_memory_grow(0, pages);
    if (prev_pages < 0) return 0;

    unsigned char *new_chunk = g_heap.wilderness_end;
    size_t new_bytes = (size_t)pages * WASM_PAGE_SIZE;
    chunk_set(new_chunk, new_bytes - CHUNK_OVERHEAD, 0);
    g_heap.wilderness_end = new_chunk + new_bytes;
    g_heap.region_limit = g_heap.wilderness_end;

    /* coalesce with the physically-previous chunk if it's free (common:
     * the old wilderness tail was too small to satisfy the request) */
    void *prev = chunk_prev_phys(new_chunk);
    if (prev && !chunk_inuse(prev)) {
        free_chunk_remove(prev);
        size_t merged = chunk_size(prev) + CHUNK_OVERHEAD + chunk_size(new_chunk);
        chunk_set(prev, merged, 0);
        free_chunk_push(prev);
    } else {
        free_chunk_push(new_chunk);
    }
    return 1;
}

static void heap_lazy_init(void) {
    if (g_heap.initialized) return;
    g_heap.initialized = 1;
    g_heap.free_head = NULL;
    g_heap.region_base = &__heap_base;

    size_t total_mem = (size_t)__builtin_wasm_memory_size(0) * WASM_PAGE_SIZE;
    unsigned char *mem_end = (unsigned char *)(uintptr_t)total_mem;

    if (mem_end > g_heap.region_base + CHUNK_OVERHEAD + MIN_PAYLOAD) {
        size_t avail = (size_t)(mem_end - g_heap.region_base);
        chunk_set(g_heap.region_base, avail - CHUNK_OVERHEAD, 0);
        g_heap.wilderness_end = mem_end;
        g_heap.region_limit = mem_end;
        free_chunk_push(g_heap.region_base);
    } else {
        g_heap.wilderness_end = g_heap.region_base;
        g_heap.region_limit = g_heap.region_base;
    }
}

#endif /* WASM_THREADS */

/* ---- public API --------------------------------------------------------- */

void *malloc(size_t size) {
#if !defined(WASM_THREADS)
    heap_lazy_init();
#endif
    if (size == 0) return NULL;
    size_t need = ALIGN8(size);
    if (need < MIN_PAYLOAD) need = MIN_PAYLOAD;

    for (;;) {
        FreeNode *best = NULL;
        for (FreeNode *n = g_heap.free_head; n; n = n->next) {
            void *c = payload_chunk(n);
            if (chunk_size(c) >= need) { best = n; break; } /* first-fit */
        }

        if (best) {
            void *c = payload_chunk(best);
            size_t avail = chunk_size(c);
            free_chunk_remove(c);

            size_t remainder = avail - need;
            if (remainder >= CHUNK_OVERHEAD + MIN_PAYLOAD) {
                chunk_set(c, need, 1);
                g_heap_bytes_inuse += need;
                void *rem = chunk_next_phys(c);
                chunk_set(rem, remainder - CHUNK_OVERHEAD, 0);
                free_chunk_push(rem);
            } else {
                chunk_set(c, avail, 1); /* keep the small remainder inside this chunk */
                g_heap_bytes_inuse += avail;
            }
            return chunk_payload(c);
        }

#if defined(WASM_THREADS)
        if (!heap_extend_threaded(need)) return NULL; /* hit --max-memory - genuinely out of room */
#else
        if (!heap_extend(need)) return NULL;
#endif
        /* loop back and retry the search now that more space exists */
    }
}

void free(void *ptr) {
    if (!ptr) return;
    void *c = payload_chunk(ptr);
    size_t size = chunk_size(c);
    g_heap_bytes_inuse -= size; /* this call's own chunk, before any coalescing below grows `size` */

#if defined(WASM_THREADS)
    HeapRegion *r = heap_region_containing(c);
    unsigned char *region_limit = r ? r->limit : (unsigned char *)c + CHUNK_OVERHEAD + size;
    void *next = (unsigned char *)c + CHUNK_OVERHEAD + size < region_limit
                     ? chunk_next_phys(c)
                     : NULL;
#else
    void *next = (unsigned char *)c + CHUNK_OVERHEAD + size < g_heap.wilderness_end
                     ? chunk_next_phys(c)
                     : NULL;
#endif
    void *prev = chunk_prev_phys(c);

    if (next && !chunk_inuse(next)) {
        free_chunk_remove(next);
        size += CHUNK_OVERHEAD + chunk_size(next);
    }
    if (prev && !chunk_inuse(prev)) {
        free_chunk_remove(prev);
        size += CHUNK_OVERHEAD + chunk_size(prev);
        c = prev;
    }

    chunk_set(c, size, 0);
    free_chunk_push(c);
}

void *realloc(void *ptr, size_t size) {
    if (!ptr) return malloc(size);
    if (size == 0) { free(ptr); return NULL; }

    void *c = payload_chunk(ptr);
    size_t old_size = chunk_size(c);
    size_t need = ALIGN8(size);
    if (need < MIN_PAYLOAD) need = MIN_PAYLOAD;

    if (need <= old_size) return ptr;

    /* try growing in place into a free, physically-adjacent next chunk */
#if defined(WASM_THREADS)
    HeapRegion *r = heap_region_containing(c);
    unsigned char *region_limit = r ? r->limit : (unsigned char *)c + CHUNK_OVERHEAD + old_size;
    int has_next_in_region = (unsigned char *)c + CHUNK_OVERHEAD + old_size < region_limit;
#else
    int has_next_in_region = (unsigned char *)c + CHUNK_OVERHEAD + old_size < g_heap.wilderness_end;
#endif
    if (has_next_in_region) {
        void *next = chunk_next_phys(c);
        if (!chunk_inuse(next)) {
            size_t combined = old_size + CHUNK_OVERHEAD + chunk_size(next);
            if (combined >= need) {
                free_chunk_remove(next);
                size_t remainder = combined - need;
                if (remainder >= CHUNK_OVERHEAD + MIN_PAYLOAD) {
                    chunk_set(c, need, 1);
                    g_heap_bytes_inuse += (need - old_size);
                    void *rem = chunk_next_phys(c);
                    chunk_set(rem, remainder - CHUNK_OVERHEAD, 0);
                    free_chunk_push(rem);
                } else {
                    chunk_set(c, combined, 1);
                    g_heap_bytes_inuse += (combined - old_size);
                }
                return ptr;
            }
        }
    }

    void *new_ptr = malloc(size);
    if (new_ptr) {
        memcpy(new_ptr, ptr, old_size);
        free(ptr);
    }
    return new_ptr;
}

void *calloc(size_t nmemb, size_t size) {
    size_t total = nmemb * size;
    if (nmemb != 0 && total / nmemb != size) return NULL; /* overflow */
    void *p = malloc(total);
    if (p) memset(p, 0, total);
    return p;
}

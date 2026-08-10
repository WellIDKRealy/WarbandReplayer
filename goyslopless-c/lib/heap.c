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
 *
 *  - WASM_THREADS (replay_worker.wasm): each thread gets its own fixed,
 *    non-overlapping slab carved out of __heap_base + thread_id*SLAB_SIZE.
 *    No memory.grow at runtime - the whole layout (all thread slabs, plus
 *    the DB blob / results regions replay_worker.c manages separately) is
 *    reserved up front via `--initial-memory`/`--max-memory` linker flags,
 *    so two threads can never race over growing shared memory. Heap state
 *    itself is `_Thread_local`: under a shared WebAssembly.Memory, a plain
 *    (non-TLS) global would alias the *same* address across every worker
 *    instance, since linear memory - unlike wasm globals - really is one
 *    physical resource shared by all instances. TLS is the only way to get
 *    genuinely per-thread mutable state here.
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

typedef struct HeapState {
    unsigned char *region_base;
    unsigned char *region_limit;   /* hard ceiling for this heap's region */
    unsigned char *wilderness_end; /* end of the last carved-out chunk */
    FreeNode *free_head;
    unsigned char initialized;
} HeapState;

#if defined(WASM_THREADS)
static _Thread_local HeapState g_heap;
#else
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

static inline void *chunk_next_phys(void *chunk_addr) {
    return (unsigned char *)chunk_addr + chunk_total(chunk_addr);
}

/* NULL if chunk_addr is at region_base (no physical predecessor) */
static void *chunk_prev_phys(void *chunk_addr) {
    if ((unsigned char *)chunk_addr <= g_heap.region_base) return NULL;
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
    g_heap.region_base = base;
    g_heap.region_limit = base + slab_size;
    g_heap.wilderness_end = base + slab_size;
    g_heap.free_head = NULL;
    g_heap.initialized = 1;

    chunk_set(base, slab_size - CHUNK_OVERHEAD, 0);
    free_chunk_push(base);
}

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
                void *rem = chunk_next_phys(c);
                chunk_set(rem, remainder - CHUNK_OVERHEAD, 0);
                free_chunk_push(rem);
            } else {
                chunk_set(c, avail, 1); /* keep the small remainder inside this chunk */
            }
            return chunk_payload(c);
        }

#if defined(WASM_THREADS)
        return NULL; /* fixed slab exhausted - no growth for thread heaps */
#else
        if (!heap_extend(need)) return NULL;
        /* loop back and retry the search now that more space exists */
#endif
    }
}

void free(void *ptr) {
    if (!ptr) return;
    void *c = payload_chunk(ptr);
    size_t size = chunk_size(c);

    void *next = (unsigned char *)c + CHUNK_OVERHEAD + size < g_heap.wilderness_end
                     ? chunk_next_phys(c)
                     : NULL;
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
    if ((unsigned char *)c + CHUNK_OVERHEAD + old_size < g_heap.wilderness_end) {
        void *next = chunk_next_phys(c);
        if (!chunk_inuse(next)) {
            size_t combined = old_size + CHUNK_OVERHEAD + chunk_size(next);
            if (combined >= need) {
                free_chunk_remove(next);
                size_t remainder = combined - need;
                if (remainder >= CHUNK_OVERHEAD + MIN_PAYLOAD) {
                    chunk_set(c, need, 1);
                    void *rem = chunk_next_phys(c);
                    chunk_set(rem, remainder - CHUNK_OVERHEAD, 0);
                    free_chunk_push(rem);
                } else {
                    chunk_set(c, combined, 1);
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

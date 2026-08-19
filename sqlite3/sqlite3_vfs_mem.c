/*
 * Minimal in-memory VFS for SQLite compiled with SQLITE_OS_OTHER=1.
 *
 * There is no filesystem in this bare-metal wasm sandbox, so every "file"
 * SQLite opens (the main database, and any journal/wal it asks for) just
 * lives in a malloc'd, growable buffer for the lifetime of the process.
 * This is enough to run SQLite entirely in memory (":memory:" databases,
 * or on-disk-named databases that never actually touch disk) - it is NOT
 * a real filesystem: two "files" with the same name are independent, and
 * nothing survives process exit. If you need persistence, back xWrite/
 * xRead with calls into JS (IndexedDB, OPFS, etc.) instead.
 *
 * This file supplies the two entry points SQLite requires when built with
 * SQLITE_OS_OTHER=1 (see the "SQLITE_OS_OTHER" comment near the top of
 * sqlite3.c): sqlite3_os_init() and sqlite3_os_end().
 */
#include "sqlite3.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(WASM_THREADS)
#include "wasm_layout.h"
#include <stdatomic.h>
#include <stdint.h>
#endif

/* ---- in-memory "file" backing store -------------------------------- */

/*
 * Two backing modes, chosen per-open by xOpen's flags:
 *
 *  - Private (temp files, journals, and everything in the single-threaded
 *    main.wasm/benchmark.wasm builds): each open gets its own malloc'd,
 *    independently-growable buffer, exactly as before - genuinely
 *    per-connection scratch space, no cross-connection sharing wanted.
 *
 *  - OPFS (WASM_THREADS builds only, the literal filename "main.db"): every
 *    connection that opens main.db is reading/writing the SAME underlying
 *    file - a loader thread streams it in and occasionally extends it
 *    (later per-battle index builds via replay_ensure_battle_ready can fire
 *    at any time during playback, not just at initial load), while other
 *    threads (readers, prefetch) read it concurrently. That access pattern
 *    - one thread with ongoing, indefinitely-lived write capability,
 *    concurrent with other threads' ongoing reads - doesn't fit OPFS's
 *    "read-only" mode (which permits multiple concurrent handles, but only
 *    if EVERY open handle on the file is read-only - the loader's isn't) or
 *    its default "readwrite" mode (which permits only ONE handle, period,
 *    of ANY kind, while it's open). The mode that fits is
 *    "readwrite-unsafe": multiple concurrent handles allowed, but the spec
 *    explicitly leaves synchronization to the caller. This app already has
 *    exactly that synchronization - the SHARED/RESERVED/PENDING/EXCLUSIVE
 *    atomic lock state machine below (g_region_a_lock, memLockShared/
 *    memUnlockShared) already guarantees no writer holds >= RESERVED while
 *    any reader holds >= SHARED, which is precisely the invariant that
 *    makes "readwrite-unsafe" safe to use: every actual xRead/xWrite call
 *    only ever happens from a code path SQLite has already lock-gated.
 *    (Name kept as "g_region_a_lock"/"is_opfs" reuses the old RAM-backed
 *    "Region A" naming/flag for the same *role* - the one shared main.db
 *    resource - even though the backing storage itself is no longer a
 *    fixed RAM buffer.)
 *
 *    Backing storage is OPFS (navigator.storage.getDirectory(), a real
 *    synchronous per-Worker access handle - see replay-worker.js's
 *    bootstrap()), not a fixed-size RAM region, so there's no "whole file
 *    must fit in N MiB of linear memory" ceiling anymore. A small
 *    per-thread page cache (opfs_cache_*, this file) sits in front of it:
 *    write-through (every xWrite calls js_opfs_write immediately - a
 *    write-BACK cache would let a writer's dirty pages sit unflushed
 *    indefinitely, since PRAGMA synchronous=OFF means SQLite rarely if ever
 *    calls xSync, and other threads' reads only ever go through the real
 *    OPFS backing, never this thread's private cache - so write-back could
 *    leave writes invisible to other threads long after SQLite believes
 *    they've committed); read-cached, invalidated wholesale whenever this
 *    thread's lock transitions from below SHARED up to SHARED (the exact
 *    point SQLite's own protocol guarantees nothing changed underneath a
 *    *previous* SHARED episode, and the one moment a *stale* cache could
 *    have accumulated is right before this fresh acquisition).
 */

#if defined(WASM_THREADS)
typedef struct MemSharedLock {
    _Atomic int shared_count;   /* # connections currently holding >= SHARED */
    _Atomic int exclusive_kind; /* 0, or the one SQLITE_LOCK_{RESERVED,PENDING,EXCLUSIVE} held */
} MemSharedLock;

static MemSharedLock g_region_a_lock;
static _Atomic sqlite3_int64 g_region_a_size = 0;

int wasm_vfs_debug_shared_count(void) { return atomic_load(&g_region_a_lock.shared_count); }
int wasm_vfs_debug_exclusive_kind(void) { return atomic_load(&g_region_a_lock.exclusive_kind); }

/* ---- OPFS-backed page cache for the shared main.db -------------------
 * See the big comment above for why this exists and why it's write-through/
 * invalidate-on-fresh-SHARED-acquire rather than a normal write-back cache.
 * _Thread_local, same reasoning as heap.c's per-thread heap: a plain global
 * here would alias the same physical address across every Worker instance
 * sharing one WebAssembly.Memory. */
#define OPFS_PAGE_SIZE  4096u   /* matches lua/main.lua's PRAGMA page_size=4096 */
#define OPFS_CACHE_PAGES 8u     /* 8*(8+4096) = ~32KiB per thread - deliberately well under
                                 * WASM_TLS_SLOT_SIZE (64KiB, wasm_layout.h): this cache is
                                 * _Thread_local, and unlike the manually-carved heap/Region-C
                                 * regions, nothing here verifies the LINKER's actual computed
                                 * TLS block size (__tls_size) fits that hardcoded slot except
                                 * replay-worker.js's bootstrap() check against __tls_size at
                                 * runtime - leave real headroom rather than sizing this to
                                 * exactly fill the slot. */

typedef struct OpfsPageSlot {
    sqlite3_int64 page_no; /* -1 = empty slot */
    unsigned char data[OPFS_PAGE_SIZE];
} OpfsPageSlot;

static _Thread_local OpfsPageSlot g_opfs_cache[OPFS_CACHE_PAGES];
static _Thread_local int g_opfs_cache_ready = 0;
static _Thread_local unsigned g_opfs_clock = 0; /* round-robin eviction - see plan risk
                                                   * "page-cache eviction policy...starts as
                                                   * plain LRU" - this is simpler than real
                                                   * LRU (no per-access bookkeeping) and
                                                   * still bounded/correct; revisit if the
                                                   * bisection-heavy access pattern thrashes */

/* JS imports - see replay-worker.js's bootstrap() for the per-Worker OPFS
 * sync access handle these operate against. Both take/return plain byte
 * offsets/lengths against WASM linear memory pointers, matching this
 * project's existing extern-import convention (e.g. js_log_string). */
extern sqlite3_int64 js_opfs_read(void *dst, sqlite3_int64 offset, sqlite3_int64 len);
extern void js_opfs_write(const void *src, sqlite3_int64 offset, sqlite3_int64 len);
extern void js_opfs_truncate(sqlite3_int64 size);

/* Same idea, for exclusively-owned temp files (sorter spill, temp_store=FILE)
 * rather than the one shared main.db - each gets its OWN OPFS file, opened
 * on demand and identified by an opaque handle id JS hands back (there's no
 * meaningful filename from SQLite's side; it opens these with zName==NULL
 * and expects the VFS to pick something). No page cache in front of these -
 * unlike main.db's bisection-heavy read pattern, sorter spill is close to
 * pure sequential write-then-read-once, so a cache would mostly just add
 * bookkeeping without avoiding real OPFS round-trips. */
extern int js_opfs_temp_open(void);
extern sqlite3_int64 js_opfs_temp_read(int handleId, void *dst, sqlite3_int64 offset, sqlite3_int64 len);
extern void js_opfs_temp_write(int handleId, const void *src, sqlite3_int64 offset, sqlite3_int64 len);
extern void js_opfs_temp_truncate(int handleId, sqlite3_int64 size);
extern void js_opfs_temp_close(int handleId);

static void opfs_cache_init_if_needed(void) {
    if (g_opfs_cache_ready) return;
    for (unsigned i = 0; i < OPFS_CACHE_PAGES; i++) g_opfs_cache[i].page_no = -1;
    g_opfs_cache_ready = 1;
}

/* Called from memLockShared exactly when this thread's lock rises from
 * below SHARED to SHARED - see the big top-of-file comment for why that
 * point (not xOpen, not every read) is both necessary and sufficient. */
static void opfs_cache_invalidate_all(void) {
    opfs_cache_init_if_needed();
    for (unsigned i = 0; i < OPFS_CACHE_PAGES; i++) g_opfs_cache[i].page_no = -1;
}

static OpfsPageSlot *opfs_cache_find_only(sqlite3_int64 page_no) {
    for (unsigned i = 0; i < OPFS_CACHE_PAGES; i++) {
        if (g_opfs_cache[i].page_no == page_no) return &g_opfs_cache[i];
    }
    return 0;
}

/* Read-fills (or returns already-cached) the slot for `page_no`. Never
 * called for writes - see opfs_write_bytes, which is write-through and
 * only opportunistically touches an ALREADY-cached slot. */
static OpfsPageSlot *opfs_cache_load(sqlite3_int64 page_no) {
    opfs_cache_init_if_needed();
    OpfsPageSlot *hit = opfs_cache_find_only(page_no);
    if (hit) return hit;
    unsigned victim = g_opfs_clock % OPFS_CACHE_PAGES;
    g_opfs_clock++;
    OpfsPageSlot *slot = &g_opfs_cache[victim];
    slot->page_no = page_no;
    sqlite3_int64 got = js_opfs_read(slot->data, page_no * (sqlite3_int64)OPFS_PAGE_SIZE, (sqlite3_int64)OPFS_PAGE_SIZE);
    if (got < 0) got = 0;
    if ((sqlite3_int64)OPFS_PAGE_SIZE > got) {
        memset(slot->data + got, 0, (size_t)((sqlite3_int64)OPFS_PAGE_SIZE - got));
    }
    return slot;
}

static sqlite3_int64 opfs_read_bytes(void *dst, sqlite3_int64 offset, sqlite3_int64 amt) {
    unsigned char *out = (unsigned char *)dst;
    sqlite3_int64 remaining = amt, pos = offset;
    while (remaining > 0) {
        sqlite3_int64 page_no = pos / (sqlite3_int64)OPFS_PAGE_SIZE;
        sqlite3_int64 page_off = pos % (sqlite3_int64)OPFS_PAGE_SIZE;
        sqlite3_int64 chunk = (sqlite3_int64)OPFS_PAGE_SIZE - page_off;
        if (chunk > remaining) chunk = remaining;
        OpfsPageSlot *slot = opfs_cache_load(page_no);
        memcpy(out, slot->data + page_off, (size_t)chunk);
        out += chunk; pos += chunk; remaining -= chunk;
    }
    return amt;
}

/* Write-through: the real js_opfs_write call happens ONCE for the whole
 * range (not page-by-page - a 1MiB load-chunk write is one JS call, not
 * 256), then any slots ALREADY cached for the touched range get their copy
 * refreshed too (purely a same-thread read-after-write nicety - a cache
 * MISS on a later read would also see the fresh data, since the write
 * above already landed in the real OPFS backing by then). */
static void opfs_write_bytes(const void *src, sqlite3_int64 offset, sqlite3_int64 amt) {
    js_opfs_write(src, offset, amt);
    const unsigned char *in = (const unsigned char *)src;
    sqlite3_int64 remaining = amt, pos = offset;
    while (remaining > 0) {
        sqlite3_int64 page_no = pos / (sqlite3_int64)OPFS_PAGE_SIZE;
        sqlite3_int64 page_off = pos % (sqlite3_int64)OPFS_PAGE_SIZE;
        sqlite3_int64 chunk = (sqlite3_int64)OPFS_PAGE_SIZE - page_off;
        if (chunk > remaining) chunk = remaining;
        OpfsPageSlot *slot = opfs_cache_find_only(page_no);
        if (slot) memcpy(slot->data + page_off, in, (size_t)chunk);
        in += chunk; pos += chunk; remaining -= chunk;
    }
}

#ifdef WASM_VFS_LOCK_TRACE
static char g_lock_trace[2048];
static int g_lock_trace_len = 0;
static void trace_lock(const char *op, int lvl, int prior, int rc) {
    if (g_lock_trace_len > 2000) return;
    char buf[48];
    int n = 0;
    const char *s = op; while (*s) buf[n++] = *s++;
    buf[n++] = '('; buf[n++] = '0' + (prior % 10); buf[n++] = '-'; buf[n++] = '>';
    buf[n++] = '0' + (lvl % 10); buf[n++] = ')'; buf[n++] = '='; buf[n++] = '0' + ((rc < 0 ? -rc : rc) % 10);
    buf[n++] = ' '; buf[n] = 0;
    for (int i = 0; i < n && g_lock_trace_len < 2047; i++) g_lock_trace[g_lock_trace_len++] = buf[i];
    g_lock_trace[g_lock_trace_len] = 0;
}
const char *wasm_vfs_get_lock_trace(void) { return g_lock_trace; }

static char g_io_trace[2048];
static int g_io_trace_len = 0;
static void trace_io(const char *op, sqlite3_int64 ofst, int amt, sqlite3_int64 sizeAfter) {
    if (g_io_trace_len > 1950) return;
    char buf[64];
    int n = 0;
    const char *s = op; while (*s) buf[n++] = *s++;
    buf[n++] = '(';
    /* tiny decimal formatter - these values are always small in this test */
    long long vals[3] = { ofst, amt, sizeAfter };
    for (int v = 0; v < 3; v++) {
        long long x = vals[v];
        char tmp[16]; int tn = 0;
        if (x == 0) tmp[tn++] = '0';
        while (x > 0) { tmp[tn++] = '0' + (x % 10); x /= 10; }
        while (tn > 0) buf[n++] = tmp[--tn];
        buf[n++] = (v < 2) ? ',' : ')';
    }
    buf[n++] = ' '; buf[n] = 0;
    for (int i = 0; i < n && g_io_trace_len < 2047; i++) g_io_trace[g_io_trace_len++] = buf[i];
    g_io_trace[g_io_trace_len] = 0;
}
const char *wasm_vfs_get_io_trace(void) { return g_io_trace; }

void wasm_vfs_reset_traces(void) {
    g_lock_trace_len = 0; g_lock_trace[0] = 0;
    g_io_trace_len = 0; g_io_trace[0] = 0;
}

static unsigned char *g_debug_last_write_dataptr = 0;
unsigned long wasm_vfs_debug_last_write_dataptr(void) { return (unsigned long)(uintptr_t)g_debug_last_write_dataptr; }
#else
#define trace_lock(op, lvl, prior, rc) ((void)0)
#define trace_io(op, ofst, amt, sizeAfter) ((void)0)
#endif
#else
#define trace_io(op, ofst, amt, sizeAfter) ((void)0)
#endif

typedef struct MemFile {
    sqlite3_file base;    /* Base class - must be first field */
    unsigned char *data;   /* private mode only - ignored/unused in either OPFS mode */
    sqlite3_int64 size;     /* private mode: current size. is_opfs_temp mode: same field,
                             * reused - safe because temp files are single-thread-owned
                             * (no cross-thread readers), so no atomic/shared state needed,
                             * unlike is_opfs's g_region_a_size. */
    sqlite3_int64 capacity;
    int lock_level;        /* what level *this handle* currently holds */
#if defined(WASM_THREADS)
    int is_opfs;            /* 1 => OPFS-backed shared main.db mode (see the big comment above) */
    int is_opfs_temp;       /* 1 => OPFS-backed but exclusively-owned temp file (sorter spill,
                             * temp_store=FILE - see replay_worker.c's replay_finish_load) -
                             * no shared lock protocol needed, just its own OPFS handle. */
    int temp_handle_id;     /* js_opfs_temp_* calls key off this, not a filename */
#endif
} MemFile;

#if defined(WASM_THREADS)
static int memUnlockShared(MemFile *p, int lockType); /* defined below, needed by memClose */
#endif

static int memClose(sqlite3_file *pFile) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs) {
        /* On a real OS, closing a file descriptor implicitly releases every
         * lock it held - SQLite's own xClose callers don't always call
         * xUnlock(NONE) first, relying on that OS behavior for free. Our
         * VFS has no OS to do it for us: without this, a connection that
         * closes while still holding >= SHARED (e.g. a reader that never
         * explicitly dropped its lock) leaks its contribution to
         * g_region_a_lock.shared_count forever, and every future writer's
         * SHARED->EXCLUSIVE upgrade then permanently sees shared_count > 1
         * and gets SQLITE_BUSY even when nothing is actually still using
         * the shared main.db. (Found via wasm_vfs_get_lock_trace(): a
         * prefetch connection's CREATE INDEX repeatedly failed its
         * EXCLUSIVE upgrade with rc=5 after 8 short-lived reader
         * connections had come and gone from the earlier
         * parallel-bounds-computation pass.) */
        memUnlockShared(p, SQLITE_LOCK_NONE);
        return SQLITE_OK;
    }
    if (p->is_opfs_temp) {
        js_opfs_temp_close(p->temp_handle_id); /* closes AND deletes the backing OPFS file */
        return SQLITE_OK;
    }
#endif
    free(p->data);
    p->data = NULL;
    return SQLITE_OK;
}

static int memRead(sqlite3_file *pFile, void *buf, int iAmt, sqlite3_int64 iOfst) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs) {
        sqlite3_int64 size = atomic_load(&g_region_a_size);
        if (iOfst + iAmt > size) {
            sqlite3_int64 avail = size - iOfst;
            if (avail < 0) avail = 0;
            memset(buf, 0, (size_t)iAmt);
            if (avail > 0) opfs_read_bytes(buf, iOfst, avail);
            trace_io("Rshort", iOfst, iAmt, size);
            return SQLITE_IOERR_SHORT_READ;
        }
        opfs_read_bytes(buf, iOfst, iAmt);
        trace_io("R", iOfst, iAmt, size);
        return SQLITE_OK;
    }
    if (p->is_opfs_temp) {
        sqlite3_int64 size = p->size;
        if (iOfst + iAmt > size) {
            sqlite3_int64 avail = size - iOfst;
            if (avail < 0) avail = 0;
            memset(buf, 0, (size_t)iAmt);
            if (avail > 0) js_opfs_temp_read(p->temp_handle_id, buf, iOfst, avail);
            trace_io("Rshort", iOfst, iAmt, size);
            return SQLITE_IOERR_SHORT_READ;
        }
        js_opfs_temp_read(p->temp_handle_id, buf, iOfst, iAmt);
        trace_io("R", iOfst, iAmt, size);
        return SQLITE_OK;
    }
#endif
    sqlite3_int64 size = p->size;
    if (iOfst + iAmt > size) {
        sqlite3_int64 avail = size - iOfst;
        if (avail < 0) avail = 0;
        memset(buf, 0, (size_t)iAmt);
        if (avail > 0) memcpy(buf, p->data + iOfst, (size_t)avail);
        trace_io("Rshort", iOfst, iAmt, size);
        return SQLITE_IOERR_SHORT_READ;
    }
    memcpy(buf, p->data + iOfst, (size_t)iAmt);
    trace_io("R", iOfst, iAmt, size);
    return SQLITE_OK;
}

static int memGrow(MemFile *p, sqlite3_int64 needed) {
    if (needed <= p->capacity) return SQLITE_OK;
    sqlite3_int64 newCap = p->capacity ? p->capacity : 4096;
    while (newCap < needed) newCap *= 2;
    unsigned char *nd = realloc(p->data, (size_t)newCap);
    if (!nd) return SQLITE_NOMEM;
    memset(nd + p->capacity, 0, (size_t)(newCap - p->capacity));
    p->data = nd;
    p->capacity = newCap;
    return SQLITE_OK;
}

static int memWrite(sqlite3_file *pFile, const void *buf, int iAmt, sqlite3_int64 iOfst) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs) {
        opfs_write_bytes(buf, iOfst, iAmt);
#ifdef WASM_VFS_LOCK_TRACE
        g_debug_last_write_dataptr = (unsigned char *)buf;
#endif
        sqlite3_int64 newSize = iOfst + iAmt;
        sqlite3_int64 cur = atomic_load(&g_region_a_size);
        while (newSize > cur && !atomic_compare_exchange_weak(&g_region_a_size, &cur, newSize)) { /* retry */ }
        trace_io("W", iOfst, iAmt, atomic_load(&g_region_a_size));
        return SQLITE_OK;
    }
    if (p->is_opfs_temp) {
        js_opfs_temp_write(p->temp_handle_id, buf, iOfst, iAmt);
        if (iOfst + iAmt > p->size) p->size = iOfst + iAmt; /* single-owner - plain field, no atomic needed */
        trace_io("W", iOfst, iAmt, p->size);
        return SQLITE_OK;
    }
#endif
    int rc = memGrow(p, iOfst + iAmt);
    if (rc != SQLITE_OK) return rc;
    memcpy(p->data + iOfst, buf, (size_t)iAmt);
    if (iOfst + iAmt > p->size) p->size = iOfst + iAmt;
    return SQLITE_OK;
}

static int memTruncate(sqlite3_file *pFile, sqlite3_int64 size) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs) {
        js_opfs_truncate(size);
        atomic_store(&g_region_a_size, size);
        /* Cached pages beyond the new size are stale (their content no
         * longer exists in the file); simplest correct thing is to drop
         * this thread's whole cache rather than reason about which slots
         * straddle the new boundary - truncation is rare (once per load,
         * not a hot-path call), so this isn't a real cost. */
        opfs_cache_invalidate_all();
        trace_io("T", size, 0, size);
        return SQLITE_OK;
    }
    if (p->is_opfs_temp) {
        js_opfs_temp_truncate(p->temp_handle_id, size);
        p->size = size;
        trace_io("T", size, 0, size);
        return SQLITE_OK;
    }
#endif
    if (size < p->size) memset(p->data + size, 0, (size_t)(p->size - size));
    p->size = size;
    return SQLITE_OK;
}

static int memSync(sqlite3_file *pFile, int flags) {
    (void)pFile; (void)flags;
    /* Nothing to flush: private-mode files are already "durable" in RAM,
     * and OPFS-mode writes are write-through (see opfs_write_bytes) so
     * there's never anything buffered here either - both matter for the
     * same reason PRAGMA synchronous=OFF does (replay_worker.c's
     * replay_finish_load): this app doesn't need crash-safety durability,
     * only within-a-session correctness across threads, which write-through
     * already provides without waiting for an xSync call that
     * synchronous=OFF may never even issue. */
    return SQLITE_OK;
}

static int memFileSize(sqlite3_file *pFile, sqlite3_int64 *pSize) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs) { *pSize = atomic_load(&g_region_a_size); return SQLITE_OK; }
#endif
    *pSize = p->size;
    return SQLITE_OK;
}

#if defined(WASM_THREADS)
/*
 * SQLite's standard 5-state rollback-journal lock protocol (NONE < SHARED
 * < RESERVED < PENDING < EXCLUSIVE), enforced for real via g_region_a_lock
 * - this is what makes "loader finishes before readers start" an actual
 * invariant instead of a hoped-for convention. Only meaningful for shared
 * (Region A) files; private temp/journal files fall through to the
 * always-been-fine no-op path below (never contended - each open is its
 * own independent buffer).
 */
static int memLockShared(MemFile *p, int lockType) {
    MemSharedLock *L = &g_region_a_lock;
    int prior = p->lock_level;
    if (p->lock_level >= lockType) { trace_lock("L", lockType, prior, 0); return SQLITE_OK; }

    int rc;
    switch (lockType) {
    case SQLITE_LOCK_SHARED: {
        int ek = atomic_load(&L->exclusive_kind);
        if (ek == SQLITE_LOCK_PENDING || ek == SQLITE_LOCK_EXCLUSIVE) { rc = SQLITE_BUSY; break; }
        atomic_fetch_add(&L->shared_count, 1);
        p->lock_level = SQLITE_LOCK_SHARED;
        /* `prior < SQLITE_LOCK_SHARED` is guaranteed here (the early-return
         * at the top of this function already handled prior >= lockType) -
         * this is exactly the "fresh SHARED acquisition" point the OPFS
         * page cache's invalidation is keyed on. See the big comment near
         * opfs_cache_invalidate_all's definition for why this point is
         * both necessary and sufficient. */
        opfs_cache_invalidate_all();
        rc = SQLITE_OK;
        break;
    }
    case SQLITE_LOCK_RESERVED: {
        if (p->lock_level < SQLITE_LOCK_SHARED) { rc = SQLITE_MISUSE; break; }
        int expected = 0;
        if (!atomic_compare_exchange_strong(&L->exclusive_kind, &expected, SQLITE_LOCK_RESERVED)) { rc = SQLITE_BUSY; break; }
        p->lock_level = SQLITE_LOCK_RESERVED;
        rc = SQLITE_OK;
        break;
    }
    case SQLITE_LOCK_PENDING: {
        if (p->lock_level < SQLITE_LOCK_RESERVED) { rc = SQLITE_MISUSE; break; }
        atomic_store(&L->exclusive_kind, SQLITE_LOCK_PENDING); /* relabel - already mine */
        p->lock_level = SQLITE_LOCK_PENDING;
        rc = SQLITE_OK;
        break;
    }
    case SQLITE_LOCK_EXCLUSIVE: {
        /* SQLite may request EXCLUSIVE directly from RESERVED, without an
         * explicit intervening PENDING call - passing through PENDING is
         * implicit here, not a separately-observable step. */
        if (p->lock_level < SQLITE_LOCK_RESERVED) { rc = SQLITE_MISUSE; break; }
        if (atomic_load(&L->shared_count) > 1) { rc = SQLITE_BUSY; break; } /* other readers still active */
        atomic_store(&L->exclusive_kind, SQLITE_LOCK_EXCLUSIVE);
        p->lock_level = SQLITE_LOCK_EXCLUSIVE;
        rc = SQLITE_OK;
        break;
    }
    default:
        rc = SQLITE_MISUSE;
    }
    trace_lock("L", lockType, prior, rc);
    return rc;
}

static int memUnlockShared(MemFile *p, int lockType) {
    MemSharedLock *L = &g_region_a_lock;
    int prior = p->lock_level;
    if (p->lock_level <= lockType) { trace_lock("U", lockType, prior, 0); return SQLITE_OK; }

    if (p->lock_level >= SQLITE_LOCK_RESERVED && lockType < SQLITE_LOCK_RESERVED) {
        atomic_store(&L->exclusive_kind, 0);
    }
    if (p->lock_level >= SQLITE_LOCK_SHARED && lockType < SQLITE_LOCK_SHARED) {
        atomic_fetch_sub(&L->shared_count, 1);
    }
    p->lock_level = lockType;
    trace_lock("U", lockType, prior, 0);
    return SQLITE_OK;
}
#endif /* WASM_THREADS */

static int memLock(sqlite3_file *pFile, int lockType) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs) return memLockShared(p, lockType);
#endif
    p->lock_level = lockType; /* private file: never contended, always succeeds */
    return SQLITE_OK;
}
static int memUnlock(sqlite3_file *pFile, int lockType) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs) return memUnlockShared(p, lockType);
#endif
    p->lock_level = lockType;
    return SQLITE_OK;
}
static int memCheckReservedLock(sqlite3_file *pFile, int *pResOut) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs) {
        /* true iff some OTHER connection holds >= RESERVED */
        *pResOut = (p->lock_level < SQLITE_LOCK_RESERVED) &&
                   (atomic_load(&g_region_a_lock.exclusive_kind) != 0);
        return SQLITE_OK;
    }
#endif
    *pResOut = 0;
    return SQLITE_OK;
}
static int memFileControl(sqlite3_file *pFile, int op, void *pArg) {
    (void)pFile; (void)op; (void)pArg;
    return SQLITE_NOTFOUND;
}
static int memSectorSize(sqlite3_file *pFile) { (void)pFile; return 0; }
static int memDeviceCharacteristics(sqlite3_file *pFile) {
    (void)pFile;
    /* Safe to claim atomic/sequential/safe-append: there's no real disk,
     * writes just mutate a buffer, so none of the failure modes these
     * flags exist to warn about can happen here. */
    return SQLITE_IOCAP_ATOMIC
         | SQLITE_IOCAP_SEQUENTIAL
         | SQLITE_IOCAP_SAFE_APPEND
         | SQLITE_IOCAP_POWERSAFE_OVERWRITE;
}

static const sqlite3_io_methods memIoMethods = {
    1,                          /* iVersion */
    memClose,
    memRead,
    memWrite,
    memTruncate,
    memSync,
    memFileSize,
    memLock,
    memUnlock,
    memCheckReservedLock,
    memFileControl,
    memSectorSize,
    memDeviceCharacteristics,
    0, 0, 0, 0,                 /* xShm* - not needed, no WAL/shared-memory support */
    0, 0                        /* xFetch/xUnfetch - not needed */
};

/* ---- VFS methods ----------------------------------------------------- */

static int memOpen(sqlite3_vfs *pVfs, sqlite3_filename zName, sqlite3_file *pFile,
                    int flags, int *pOutFlags) {
    (void)pVfs;
    MemFile *p = (MemFile *)pFile;
    memset(p, 0, sizeof(MemFile));
    p->base.pMethods = &memIoMethods;
    p->lock_level = SQLITE_LOCK_NONE;
    trace_io(zName ? "OPEN" : "OPEN(null)", flags, 0, 0);

#if defined(WASM_THREADS)
    /* Bind to the shared OPFS-backed main.db by FILENAME, not by the
     * SQLITE_OPEN_MAIN_DB flag alone. That flag is not exclusive to "the
     * one source replay connection every thread shares" - sqlite3_open_v2()
     * sets it for any primary database a connection opens, and
     * sqlite3_attach() always ORs it in too (confirmed in sqlite3.c's
     * sqlite3Attach(), independent of the attached filename). Every thread
     * in this codebase happens to open the source replay as literally
     * "main.db" (see replay_worker.c's xOpen/sqlite3_open_v2 call sites) -
     * keying on that exact name is what actually captures "this is the one
     * shared source file", rather than "this happens to be a connection's/
     * ATTACH's primary db", which a second real database (e.g. an ATTACHed
     * replay.db/battle.db for the export pipeline) would otherwise satisfy
     * too and silently alias onto the same OPFS handle/lock state -
     * corrupting both. */
    if ((flags & SQLITE_OPEN_MAIN_DB) && zName && strcmp(zName, "main.db") == 0) {
        /* Every connection opening the main DB filename - the loader
         * (ongoing read-write) and every reader/prefetch connection
         * (read-only) alike - shares the SAME underlying OPFS file and the
         * SAME shared lock state, because it genuinely is the same
         * underlying data for all of them. No RAM buffer to size/point at
         * anymore (see opfs_read_bytes/opfs_write_bytes) - data/capacity
         * are meaningless in this mode. */
        p->is_opfs = 1;
        p->size = atomic_load(&g_region_a_size);
    } else if (!zName) {
        /* Anonymous temp file (SQLite passes zName==NULL and expects the
         * VFS to pick something) - the external sorter's spill files land
         * here now that replay_finish_load sets temp_store=FILE. Each gets
         * its own fresh OPFS file, single-thread-owned (no lock protocol
         * needed, unlike main.db - see the is_opfs_temp field comment on
         * MemFile), deleted on close per the VFS contract for this kind of
         * file regardless of whether SQLITE_OPEN_DELETEONCLOSE is set. */
        p->temp_handle_id = js_opfs_temp_open();
        if (p->temp_handle_id < 0) {
            /* Pool exhausted (OPFS_TEMP_POOL_SIZE in replay-worker.js) -
             * genuinely out of scratch file slots. Fall through to the
             * private malloc'd-buffer path below instead of hard-failing
             * the open outright: still correct (just RAM instead of OPFS
             * for this one file), and simpler than threading a real error
             * back through every caller. Should be rare - see the pool
             * size comment for why 4 is expected to be plenty. */
        } else {
            p->is_opfs_temp = 1;
            p->size = 0;
        }
    }
#endif

    if (pOutFlags) *pOutFlags = flags;
    return SQLITE_OK;
}

/* Phase 4 export pipeline: replay_export.c builds replay_export.db/
 * battle_export.db as plain ATTACHed databases, which fall through to the
 * "private" branch above (any filename other than "main.db"/NULL) - a
 * private, per-connection realloc'd buffer with no OPFS/sharing involved.
 * Once populated, the export code needs the raw bytes to embed in the tar;
 * sqlite3_file_control(..., SQLITE_FCNTL_FILE_POINTER, ...) is the standard
 * SQLite API for recovering a database connection's underlying sqlite3_file,
 * which we can safely cast back to MemFile here (this IS the TU that defines
 * it) since we already know these are private-mode files - not exposed to
 * OPFS-backed callers, this is only ever called with 'r'/'b'-style ATTACHed
 * export databases, never "main". */
int wasm_vfs_get_private_buffer(sqlite3 *db, const char *zDbName, unsigned char **outData, sqlite3_int64 *outSize) {
    sqlite3_file *pFile = 0;
    if (sqlite3_file_control(db, zDbName, SQLITE_FCNTL_FILE_POINTER, &pFile) != SQLITE_OK || !pFile) return -1;
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_opfs || p->is_opfs_temp) return -2; /* not a private-buffer file - caller error */
#endif
    *outData = p->data;
    *outSize = p->size;
    return 0;
}

static int memDelete(sqlite3_vfs *pVfs, const char *zName, int syncDir) {
    (void)pVfs; (void)zName; (void)syncDir;
    return SQLITE_OK; /* nothing persists, so "deleting" always trivially succeeds */
}

static int memAccess(sqlite3_vfs *pVfs, const char *zName, int flags, int *pResOut) {
    (void)pVfs; (void)zName; (void)flags;
    *pResOut = 0; /* no file ever "exists" ahead of being opened */
    return SQLITE_OK;
}

static int memFullPathname(sqlite3_vfs *pVfs, const char *zName, int nOut, char *zOut) {
    (void)pVfs;
    size_t len = strlen(zName);
    if (len >= (size_t)nOut) len = (size_t)nOut - 1;
    memcpy(zOut, zName, len);
    zOut[len] = '\0';
    return SQLITE_OK;
}

static int memRandomness(sqlite3_vfs *pVfs, int nByte, char *zOut) {
    (void)pVfs;
    /* No /dev/urandom in this environment. This xorshift32 PRNG is fine for
     * SQLite's internal uses (rowid perturbation, B-tree page cookies) but
     * is NOT cryptographically secure - don't rely on it for anything that
     * needs real security-grade randomness (e.g. don't build sqlite3_rekey
     * key material on top of this). Wire in a proper CSPRNG (e.g. the
     * browser's crypto.getRandomValues via a JS import) if you need that. */
    static unsigned int state = 0;
    if (state == 0) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        state = (unsigned int)(ts.tv_nsec ^ ts.tv_sec ^ 0x9E3779B9u);
        if (state == 0) state = 0x9E3779B9u;
    }
    for (int i = 0; i < nByte; i++) {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        zOut[i] = (char)(state & 0xFF);
    }
    return nByte;
}

static int memSleep(sqlite3_vfs *pVfs, int microseconds) {
    (void)pVfs;
    /* No real scheduler to yield to; just report the sleep as satisfied. */
    return microseconds;
}

static int memCurrentTime(sqlite3_vfs *pVfs, double *prNow) {
    (void)pVfs;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    /* Julian day number of the Unix epoch (1970-01-01) is 2440587.5. */
    *prNow = 2440587.5 + ((double)ts.tv_sec + ts.tv_nsec / 1.0e9) / 86400.0;
    return SQLITE_OK;
}

static int memGetLastError(sqlite3_vfs *pVfs, int nBuf, char *zBuf) {
    (void)pVfs;
    if (nBuf > 0) zBuf[0] = '\0';
    return 0;
}

static sqlite3_vfs memVfs = {
    1,                    /* iVersion (we only populate the version-1 methods) */
    sizeof(MemFile),      /* szOsFile */
    512,                  /* mxPathname */
    0,                    /* pNext - filled in by sqlite3_vfs_register */
    "goyslopless-mem",    /* zName */
    0,                    /* pAppData */
    memOpen,
    memDelete,
    memAccess,
    memFullPathname,
    0, 0, 0, 0,           /* xDlOpen/xDlError/xDlSym/xDlClose - dynamic loading isn't
                            * meaningful in a wasm sandbox; leave unset alongside
                            * SQLITE_OMIT_LOAD_EXTENSION at build time. */
    memRandomness,
    memSleep,
    memCurrentTime,
    memGetLastError,
    0                     /* xCurrentTimeInt64 - iVersion 1 doesn't need it */
};

/* ---- SQLITE_OS_OTHER entry points ------------------------------------ */

int sqlite3_os_init(void) {
    return sqlite3_vfs_register(&memVfs, 1 /* make it the default VFS */);
}

int sqlite3_os_end(void) {
    return SQLITE_OK;
}

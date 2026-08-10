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
 *  - Shared (WASM_THREADS builds only, SQLITE_OPEN_MAIN_DB opens): every
 *    connection that opens the main DB filename maps to the SAME fixed
 *    Region A (see wasm_layout.h) and the SAME shared lock state, because
 *    it really is the same underlying data for every connection - one
 *    loader thread writes it once, then N reader threads open it
 *    read-only. Region A never grows past its fixed reservation (no
 *    memory.grow races between threads); xWrite past capacity fails with
 *    SQLITE_FULL instead of silently corrupting whatever's next in memory.
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
    unsigned char *data;
    sqlite3_int64 size;
    sqlite3_int64 capacity;
    int lock_level;        /* what level *this handle* currently holds */
#if defined(WASM_THREADS)
    int is_shared;          /* 1 => Region A mode, ignores data/size/capacity above */
#endif
} MemFile;

#if defined(WASM_THREADS)
static int memUnlockShared(MemFile *p, int lockType); /* defined below, needed by memClose */
#endif

static int memClose(sqlite3_file *pFile) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_shared) {
        /* On a real OS, closing a file descriptor implicitly releases every
         * lock it held - SQLite's own xClose callers don't always call
         * xUnlock(NONE) first, relying on that OS behavior for free. Our
         * VFS has no OS to do it for us: without this, a connection that
         * closes while still holding >= SHARED (e.g. a reader that never
         * explicitly dropped its lock) leaks its contribution to
         * g_region_a_lock.shared_count forever, and every future writer's
         * SHARED->EXCLUSIVE upgrade then permanently sees shared_count > 1
         * and gets SQLITE_BUSY even when nothing is actually still using
         * Region A. (Found via wasm_vfs_get_lock_trace(): a prefetch
         * connection's CREATE INDEX repeatedly failed its EXCLUSIVE upgrade
         * with rc=5 after 8 short-lived reader connections had come and
         * gone from the earlier parallel-bounds-computation pass.) Region A
         * itself is never freed here - only this handle's claim on the lock
         * state is released, mirroring what a real OS's close() would do. */
        memUnlockShared(p, SQLITE_LOCK_NONE);
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
    sqlite3_int64 size = p->is_shared ? atomic_load(&g_region_a_size) : p->size;
#else
    sqlite3_int64 size = p->size;
#endif
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
    if (p->is_shared) {
        if (iOfst + iAmt > p->capacity) return SQLITE_FULL; /* fixed reservation, never grows */
        memcpy(p->data + iOfst, buf, (size_t)iAmt);
#ifdef WASM_VFS_LOCK_TRACE
        g_debug_last_write_dataptr = p->data;
#endif
        sqlite3_int64 newSize = iOfst + iAmt;
        sqlite3_int64 cur = atomic_load(&g_region_a_size);
        while (newSize > cur && !atomic_compare_exchange_weak(&g_region_a_size, &cur, newSize)) { /* retry */ }
        trace_io("W", iOfst, iAmt, atomic_load(&g_region_a_size));
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
    if (p->is_shared) {
        /* zero only the actual shrinking delta (relative to the real
         * current size, not the fixed 256MB capacity) - the previous
         * version zeroed everything up to `capacity` on every truncate
         * call, which both destroyed already-committed data whenever
         * SQLite truncated to a size smaller than data that had already
         * been written, and was needlessly slow. */
        sqlite3_int64 oldSize = atomic_load(&g_region_a_size);
        if (size < oldSize) memset(p->data + size, 0, (size_t)(oldSize - size));
        atomic_store(&g_region_a_size, size);
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
    return SQLITE_OK; /* nothing to flush - it's already "durable" in RAM */
}

static int memFileSize(sqlite3_file *pFile, sqlite3_int64 *pSize) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_shared) { *pSize = atomic_load(&g_region_a_size); return SQLITE_OK; }
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
    if (p->is_shared) return memLockShared(p, lockType);
#endif
    p->lock_level = lockType; /* private file: never contended, always succeeds */
    return SQLITE_OK;
}
static int memUnlock(sqlite3_file *pFile, int lockType) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_shared) return memUnlockShared(p, lockType);
#endif
    p->lock_level = lockType;
    return SQLITE_OK;
}
static int memCheckReservedLock(sqlite3_file *pFile, int *pResOut) {
    MemFile *p = (MemFile *)pFile;
#if defined(WASM_THREADS)
    if (p->is_shared) {
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
    if (flags & SQLITE_OPEN_MAIN_DB) {
        /* Every connection opening the main DB filename - the loader
         * (read-write, establishing content) and every reader (read-only,
         * afterward) alike - maps onto the SAME fixed Region A and the
         * SAME shared lock state, because it genuinely is the same
         * underlying data for all of them. */
        p->is_shared = 1;
        p->data = wasm_region_a_base();
        p->capacity = (sqlite3_int64)WASM_REGION_A_SIZE;
        p->size = atomic_load(&g_region_a_size);
    }
#endif

    if (pOutFlags) *pOutFlags = flags;
    return SQLITE_OK;
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

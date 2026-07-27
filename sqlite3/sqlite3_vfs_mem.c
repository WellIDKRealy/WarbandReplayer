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

/* ---- in-memory "file" backing store -------------------------------- */

typedef struct MemFile {
    sqlite3_file base;    /* Base class - must be first field */
    unsigned char *data;
    sqlite3_int64 size;
    sqlite3_int64 capacity;
} MemFile;

static int memClose(sqlite3_file *pFile) {
    MemFile *p = (MemFile *)pFile;
    free(p->data);
    p->data = NULL;
    return SQLITE_OK;
}

static int memRead(sqlite3_file *pFile, void *buf, int iAmt, sqlite3_int64 iOfst) {
    MemFile *p = (MemFile *)pFile;
    if (iOfst + iAmt > p->size) {
        sqlite3_int64 avail = p->size - iOfst;
        if (avail < 0) avail = 0;
        memset(buf, 0, (size_t)iAmt);
        if (avail > 0) memcpy(buf, p->data + iOfst, (size_t)avail);
        return SQLITE_IOERR_SHORT_READ;
    }
    memcpy(buf, p->data + iOfst, (size_t)iAmt);
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
    int rc = memGrow(p, iOfst + iAmt);
    if (rc != SQLITE_OK) return rc;
    memcpy(p->data + iOfst, buf, (size_t)iAmt);
    if (iOfst + iAmt > p->size) p->size = iOfst + iAmt;
    return SQLITE_OK;
}

static int memTruncate(sqlite3_file *pFile, sqlite3_int64 size) {
    MemFile *p = (MemFile *)pFile;
    if (size < p->size) memset(p->data + size, 0, (size_t)(p->size - size));
    p->size = size;
    return SQLITE_OK;
}

static int memSync(sqlite3_file *pFile, int flags) {
    (void)pFile; (void)flags;
    return SQLITE_OK; /* nothing to flush - it's already "durable" in RAM */
}

static int memFileSize(sqlite3_file *pFile, sqlite3_int64 *pSize) {
    *pSize = ((MemFile *)pFile)->size;
    return SQLITE_OK;
}

/* Locking is a no-op: everything lives in one wasm instance / one thread. */
static int memLock(sqlite3_file *pFile, int lockType)   { (void)pFile; (void)lockType; return SQLITE_OK; }
static int memUnlock(sqlite3_file *pFile, int lockType) { (void)pFile; (void)lockType; return SQLITE_OK; }
static int memCheckReservedLock(sqlite3_file *pFile, int *pResOut) {
    (void)pFile;
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
    (void)pVfs; (void)zName;
    MemFile *p = (MemFile *)pFile;
    memset(p, 0, sizeof(MemFile));
    p->base.pMethods = &memIoMethods;
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

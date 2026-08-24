// One script, four roles (parameterized by the init message), all sharing
// the same WebAssembly.Memory:
//   - 'loader': streams the file in, opens+indexes the DB, scans matches,
//     then continues running as the 'playback' role for the rest of the
//     session (no separate hand-off needed - there's no expensive
//     precompute phase blocking it from serving live queries immediately).
//   - 'reader': genuinely parallel, read-only work only (its own SQLite
//     connection - concurrently stepping someone else's prepared
//     statement isn't safe even under SQLITE_THREADSAFE=1). Reports back
//     and terminates once done.
//   - 'prefetch': one persistent worker, own READWRITE connection, own
//     (larger) heap slab. Builds not-yet-visited battles' indexes ahead of
//     the playback cursor - see runPrefetchBattle() below and main.js's
//     prefetch-near-cursor orchestration.
//
// This file is the entire replay engine's JS footprint for Worker-side
// logic: no SQL, no tick/match/roster bookkeeping happens here - it all
// happens in replay_worker.wasm. This script only does thread bootstrap,
// byte plumbing (file chunks in, frame buffers out), and message routing.

let instance = null;
let sharedMemory = null;
let role = null;
let threadId = -1;
let opfsHandle = null; // this thread's own FileSystemSyncAccessHandle onto the shared source replay file

// Set by the 'shutdown' message (see closeAllOpfsHandles/onmessage below) and
// checked after every await point in bootstrap(). Worker.terminate() does
// NOT guarantee synchronous release of a FileSystemSyncAccessHandle's lock -
// that's implementation-timing-dependent, and racing it against a fresh
// load's own createSyncAccessHandle() on the same fixed OPFS_MAIN_DB_NAME is
// exactly what throws NoModificationAllowedError ("No modification
// allowed"). The only spec-guaranteed deterministic release is calling
// .close() ourselves - main.js now does that (via a shutdown/shutdownComplete
// handshake) BEFORE calling .terminate(), instead of relying on terminate()'s
// implicit, non-deterministic cleanup.
let shuttingDown = false;

function closeAllOpfsHandles() {
  try { if (opfsHandle) opfsHandle.close(); } catch (err) { /* already closed/never opened - fine */ }
  opfsHandle = null;
  for (const slot of opfsTempPool) {
    try { slot.handle.close(); } catch (err) { /* already closed - fine */ }
  }
  opfsTempPool = [];
}

// Slot sizes only - must match WASM_STACK_SLOT_SIZE/WASM_TLS_SLOT_SIZE in
// wasm_layout.h (small and stable, unlike the pool *base* addresses, which
// shift whenever a heap region's size changes). The bases themselves are
// read back from the module after instantiation (wasm_debug_stack_pool_base/
// wasm_debug_tls_pool_base) instead of being hardcoded here - a previous
// version hand-computed them as fixed constants (300MB/400MB) and that
// estimate silently drifted out of sync with the real layout (verified: it
// ended up landing inside the reader thread heap slabs), which only didn't
// crash because readers' actual allocations stayed small enough to not
// reach the colliding bytes. Reading the real values removes that whole
// class of bug.
const TLS_SLOT_SIZE = 65536;
const STACK_SLOT_SIZE = 4 * 1024 * 1024;

// The one shared OPFS file backing the source replay's "main.db" (see the
// big comment in sqlite3_vfs_mem.c for why every thread opens its OWN
// handle in "readwrite-unsafe" mode rather than funneling I/O through a
// single owning thread: SQLite's existing SHARED/RESERVED/PENDING/EXCLUSIVE
// atomic lock protocol already provides the synchronization that mode
// leaves to the caller). Fixed name - deliberately NOT session-unique,
// since OPFS storage persists across page reloads; the loader truncates it
// to 0 at the start of every fresh load (see runLoader) so stale bytes from
// a previous session's file can never leak into or inflate a new one.
const OPFS_MAIN_DB_NAME = "replay_main.db";

// Confirmed via direct Selenium+Firefox testing (real file upload, not a
// mock): this app's normal startup burst - up to 8 reader threads plus the
// persistent prefetch thread, all requesting their own "readwrite-unsafe"
// createSyncAccessHandle() on the SAME OPFS file within milliseconds of
// each other, right after a load - is NOT reliably handled by Firefox's
// OPFS implementation the way Chrome's is. Readers surfaced it as an
// outright NoModificationAllowedError rejection (visible in the system log
// as "[Reader Worker Error] No modification allowed"); the prefetch worker
// under the identical load never sent 'ready' at all, consistent with its
// createSyncAccessHandle() call simply never settling rather than
// rejecting - so no simple catch-and-retry on rejection alone would have
// covered both failure modes. Retrying with jittered backoff handles the
// reject case and spreads retries out instead of recreating the same
// contention storm in lockstep; racing each attempt against a timeout
// converts a silent hang into a retriable failure too, so this can never
// wait forever regardless of which failure mode a given browser exhibits.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// maxAttempts defaults to 8 (the loader's own handle, and everyone's temp
// pool slots - genuinely critical-path, worth persisting through real
// transient contention). Callers on a browser-confirmed-permanently-
// unavailable path (reader/prefetch roles' main.db handle - see
// openOpfsHandle below) pass a much smaller count instead: retrying 8 times
// against Firefox's outright, immediate, every-single-attempt rejection
// just burns ~2s and 8 log lines to learn the same thing attempt 1 already
// answered, on every single page load. A couple of attempts still covers a
// genuinely transient failure on some other browser; it just stops paying
// the full 8-attempt cost for a failure mode already proven permanent here.
async function openSyncAccessHandleWithRetry(fileHandle, label, mode, maxAttempts) {
  maxAttempts = maxAttempts || 8;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const handle = await withTimeout(fileHandle.createSyncAccessHandle({ mode: mode || "readwrite-unsafe" }), 2000, label);
      if (attempt > 0) console.log(`[OPFS] ${label} succeeded on retry ${attempt + 1}/${maxAttempts}`);
      return handle;
    } catch (err) {
      lastErr = err;
      const backoffMs = 100 * (attempt + 1) + Math.random() * 150; // jittered - see comment above
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  console.log(`[OPFS] ${label} unavailable after ${maxAttempts} attempt(s): ${lastErr && lastErr.name} (${lastErr && lastErr.message})`);
  throw new Error(`${label}: createSyncAccessHandle failed after ${maxAttempts} attempts - ${lastErr && lastErr.message}`);
}

// Tried "read-only" mode for reader/prefetch roles here at one point,
// reasoning that it's spec-documented to coexist with a "readwrite-unsafe"
// writer. Directly disproved: it broke Chrome (previously working fine)
// without fixing Firefox - "read-only" mode's whole contract is a guarantee
// that NOTHING else holds write access, which a "readwrite-unsafe" handle
// (a *potential* writer, by definition) can never satisfy, in any spec-
// compliant browser. All threads use "readwrite-unsafe" - the only mode
// that coexists with itself - matching the original design.
//
// reader/prefetch roles get only 2 attempts, not the loader's 8: confirmed
// via direct Firefox testing that a second concurrent handle on this file is
// rejected immediately and permanently there (every attempt fails the same
// way, not just occasionally) - main.js's pickPrimeTarget() no longer
// depends on these roles succeeding at all (they're a pure speed
// optimization for browsers where concurrent OPFS access works;
// replay_try_prime_battle/replay_ensure_battle_ready self-heal bounds on
// g_db regardless), so there's nothing to gain from persisting through 8
// rounds of a failure already proven permanent, only wasted load time.
async function openOpfsHandle() {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(OPFS_MAIN_DB_NAME, { create: true });
  const attempts = role === "loader" ? 8 : 2;
  return await openSyncAccessHandleWithRetry(fileHandle, `main.db handle (thread ${threadId}, role ${role})`, "readwrite-unsafe", attempts);
}

// Exclusively-owned scratch files for SQLite's external sorter (temp_store
// FILE, see replay_worker.c's replay_finish_load) - one pool per thread,
// since each temp file is single-thread-owned and never shared, unlike
// main.db. Pre-created during bootstrap, not opened on demand: C's
// js_opfs_temp_open() is called synchronously from inside a VFS xOpen call,
// but createSyncAccessHandle() is only ever async - the only way to satisfy
// a synchronous "open" request from C is to already have the handle ready
// and just hand out a slot. Small pool (most threads - the parallel-bounds
// readers - never need one at all; only the loader/prefetch roles running
// CREATE INDEX genuinely do), each slot reused across opens/closes via
// truncate(0) rather than really deleted and recreated (avoids the same
// async problem on close too).
const OPFS_TEMP_POOL_SIZE = 4;
let opfsTempPool = []; // [{handle, inUse}, ...]

async function openOpfsTempPool(threadId) {
  const root = await navigator.storage.getDirectory();
  const pool = [];
  for (let i = 0; i < OPFS_TEMP_POOL_SIZE; i++) {
    const fileHandle = await root.getFileHandle(`replay_temp_${threadId}_${i}.tmp`, { create: true });
    const handle = await openSyncAccessHandleWithRetry(fileHandle, `temp pool slot ${i} (thread ${threadId})`);
    handle.truncate(0); // clean slate - a previous session may have left bytes here
    pool.push({ handle, inUse: false });
  }
  return pool;
}

async function bootstrap(memory, module, id) {
  sharedMemory = memory;
  threadId = id;

  // Must be open before WebAssembly.instantiate() below - the js_opfs_*
  // imports close over it, and thread_main() (called right after
  // instantiation, see the 'init' handler) can call into the VFS
  // immediately.
  opfsHandle = await openOpfsHandle();
  // A 'shutdown' can arrive while we were suspended awaiting the handle
  // above (see shuttingDown's comment) - bail out immediately rather than
  // finish standing up a worker that's already been told to go away, and
  // make sure the handle we just got IS actually released (the 'shutdown'
  // handler ran too early to see it).
  if (shuttingDown) { closeAllOpfsHandles(); return null; }
  opfsTempPool = await openOpfsTempPool(id);
  if (shuttingDown) { closeAllOpfsHandles(); return null; }

  const importObject = {
    env: {
      memory,
      js_log_string: (ptr) => {
        console.log(`[worker ${threadId}]`, readCstr(ptr));
      },
      clock_gettime: (clkId, tpPtr) => {
        // Use `memory` directly, not instance.exports.memory (which doesn't
        // exist anyway under --import-memory) - and this can be invoked
        // during wasm start-time init, before `instance` is assigned below.
        const dv = new DataView(memory.buffer);
        const ms = performance.now();
        dv.setInt32(tpPtr, Math.floor(ms / 1000), true);
        dv.setInt32(tpPtr + 4, Math.floor((ms % 1000) * 1e6), true);
        return 0;
      },
      // Backing for sqlite3_vfs_mem.c's OPFS-mode MemFile (main.db only -
      // see that file's big comment). All three operate directly on
      // SharedArrayBuffer-backed views into `memory` - confirmed empirically
      // (unlike e.g. TextDecoder.decode(), which refuses SharedArrayBuffer
      // views) that FileSystemSyncAccessHandle.read/write accept them fine,
      // no intermediate copy needed.
      //
      // offset/len/size are `sqlite3_int64` on the C side (a 20GB file needs
      // real 64-bit offsets, well past what a 32-bit param could address) -
      // wasm32 lowers those to genuine i64 values, which the WebAssembly JS
      // API always marshals as BigInt crossing the boundary in EITHER
      // direction (params arriving here, and whatever this function
      // returns) - never as a plain Number. `dstPtr`/`srcPtr` are pointers
      // (i32), so those stay plain Numbers. Every BigInt is converted with
      // Number(...) before use (safe/lossless here: even a 20GB offset is
      // far under Number.MAX_SAFE_INTEGER) and results are converted back
      // with BigInt(...) before returning.
      js_opfs_read: (dstPtr, offset, len) => {
        const n = Number(len);
        const view = new Uint8Array(memory.buffer, dstPtr, n);
        const got = opfsHandle.read(view, { at: Number(offset) });
        return BigInt(got);
      },
      js_opfs_write: (srcPtr, offset, len) => {
        const view = new Uint8Array(memory.buffer, srcPtr, Number(len));
        opfsHandle.write(view, { at: Number(offset) });
      },
      js_opfs_truncate: (size) => {
        opfsHandle.truncate(Number(size));
      },
      // Sorter scratch-file pool (see openOpfsTempPool above). js_opfs_temp_open
      // just claims the next free slot - the handle already exists, so this
      // stays synchronous, unlike opening a genuinely new OPFS file would be.
      js_opfs_temp_open: () => {
        for (let i = 0; i < opfsTempPool.length; i++) {
          if (!opfsTempPool[i].inUse) {
            opfsTempPool[i].inUse = true;
            return i;
          }
        }
        return -1; // pool exhausted - memOpen() below must check for this
      },
      js_opfs_temp_read: (handleId, dstPtr, offset, len) => {
        const view = new Uint8Array(memory.buffer, dstPtr, Number(len));
        const got = opfsTempPool[handleId].handle.read(view, { at: Number(offset) });
        return BigInt(got);
      },
      js_opfs_temp_write: (handleId, srcPtr, offset, len) => {
        const view = new Uint8Array(memory.buffer, srcPtr, Number(len));
        opfsTempPool[handleId].handle.write(view, { at: Number(offset) });
      },
      js_opfs_temp_truncate: (handleId, size) => {
        opfsTempPool[handleId].handle.truncate(Number(size));
      },
      js_opfs_temp_close: (handleId) => {
        opfsTempPool[handleId].handle.truncate(0); // "delete" - reused, not actually removed, see pool comment
        opfsTempPool[handleId].inUse = false;
      },
    },
  };

  instance = await WebAssembly.instantiate(module, importObject);
  const ex = instance.exports;

  // Verify the linker's actual computed per-thread TLS block size (every
  // _Thread_local variable in the module, combined - e.g. heap.c's g_heap
  // plus sqlite3_vfs_mem.c's OPFS page cache) still fits the hardcoded
  // TLS_SLOT_SIZE below, BEFORE calling __wasm_init_tls to lay threads out
  // at TLS_SLOT_SIZE-sized intervals. If a future change grows some
  // _Thread_local variable past this, __tls_size.value would exceed
  // TLS_SLOT_SIZE and this throws loudly instead of silently corrupting
  // the next thread's TLS block - the same class of bug
  // wasm_stack_pool_base()/wasm_tls_pool_base() already exist to prevent
  // for the stack/heap regions (see wasm_layout.h's comment on why those
  // are computed, not hardcoded).
  if (ex.__tls_size && ex.__tls_size.value > TLS_SLOT_SIZE) {
    throw new Error(
      `TLS overflow: module needs ${ex.__tls_size.value} bytes of thread-local ` +
      `storage per thread but TLS_SLOT_SIZE is only ${TLS_SLOT_SIZE} - raise ` +
      `TLS_SLOT_SIZE in replay-worker.js AND WASM_TLS_SLOT_SIZE in wasm_layout.h ` +
      `together, or shrink whichever _Thread_local variable grew.`
    );
  }

  const stackPoolBase = ex.wasm_debug_stack_pool_base();
  const tlsPoolBase = ex.wasm_debug_tls_pool_base();
  ex.__stack_pointer.value = stackPoolBase + id * STACK_SLOT_SIZE + STACK_SLOT_SIZE; // stack grows down from the top
  if (ex.__wasm_init_tls) ex.__wasm_init_tls(tlsPoolBase + id * TLS_SLOT_SIZE);

  return ex;
}

function readCstr(ptr) {
  if (!ptr) return "";
  const mem = new Uint8Array(sharedMemory.buffer);
  let end = ptr;
  while (mem[end] !== 0) end++;
  // TextDecoder refuses to read directly from a SharedArrayBuffer-backed view.
  return new TextDecoder().decode(Uint8Array.from(mem.subarray(ptr, end)));
}

async function runLoader(ex, data) {
  const CHUNK = 1024 * 1024;
  const chunkPtr = ex.replay_get_load_chunk_ptr();
  const mem8 = new Uint8Array(sharedMemory.buffer);

  const rcBegin = ex.replay_begin_load();
  if (rcBegin !== 0) {
    postMessage({ type: "error", role: "loader", message: readCstr(ex.replay_get_last_error()) });
    return;
  }

  // Filename is metadata only JS genuinely has (the File object's name) -
  // written into a C-owned buffer the same way file bytes are, for
  // manifest.json's source_replay.filename field (see replay_export.c).
  {
    const nameBytes = new TextEncoder().encode(data.file.name).subarray(0, 255);
    mem8.set(nameBytes, ex.replay_get_filename_buf_ptr());
    ex.replay_set_filename_len(nameBytes.length);
  }

  const file = data.file;
  const total = file.size;
  let loaded = 0;
  const stream = file.stream();
  const reader = stream.getReader();
  let carry = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    let buf = value;
    if (carry.length > 0) {
      const merged = new Uint8Array(carry.length + buf.length);
      merged.set(carry, 0);
      merged.set(buf, carry.length);
      buf = merged;
      carry = new Uint8Array(0);
    }

    let offset = 0;
    while (buf.length - offset >= CHUNK) {
      mem8.set(buf.subarray(offset, offset + CHUNK), chunkPtr);
      const rc = ex.replay_feed_chunk(CHUNK);
      if (rc !== 0) {
        postMessage({ type: "error", role: "loader", message: readCstr(ex.replay_get_last_error()) });
        return;
      }
      offset += CHUNK;
      loaded += CHUNK;
    }
    if (offset < buf.length) {
      carry = buf.subarray(offset);
    }
    postMessage({ type: "progress", loaded, total });
  }
  if (carry.length > 0) {
    mem8.set(carry, chunkPtr);
    const rc = ex.replay_feed_chunk(carry.length);
    if (rc !== 0) {
      postMessage({ type: "error", role: "loader", message: readCstr(ex.replay_get_last_error()) });
      return;
    }
    loaded += carry.length;
  }
  postMessage({ type: "progress", loaded, total });

  const matchCount = ex.replay_finish_load();
  if (matchCount < 0) {
    postMessage({ type: "error", role: "loader", message: readCstr(ex.replay_get_last_error()) });
    return;
  }

  const matches = [];
  for (let i = 0; i < matchCount; i++) {
    matches.push({
      startTime: ex.replay_get_match_start_time(i),
      endTime: ex.replay_get_match_end_time(i),
      sceneNo: ex.replay_get_match_scene_no(i),
      faction: readCstr(ex.replay_get_match_faction_ptr(i)),
      // raw tick_id bounds, for the prefetch worker (see main.js's
      // schedulePrefetch) - not used for display, only passed through to
      // replay_prefetch_battle().
      startTickId: ex.replay_get_match_start_tick_id(i),
      endTickId: ex.replay_get_match_end_tick_id(i),
    });
  }

  postMessage({
    type: "loaded",
    matchCount,
    matches,
    totalStart: ex.replay_get_total_start_time(),
    totalEnd: ex.replay_get_total_end_time(),
  });
}

// Phase 5: load an already-exported single battle's replay.db bytes
// directly (already decompressed + tar-extracted by main.js) rather than a
// full multi-battle source upload. Streams through the SAME replay_begin_load/
// replay_feed_chunk exports runLoader uses - just from an in-memory
// Uint8Array already in hand instead of a File's ReadableStream - and
// finishes via replay_finish_load_battle_file() instead of
// replay_finish_load(), then posts the identical 'loaded' shape so main.js's
// existing playback-start path (finishLoadAndStartPlayback etc.) needs no
// changes to handle either source.
async function runLoadBattleFile(ex, data) {
  const CHUNK = 1024 * 1024;
  const chunkPtr = ex.replay_get_load_chunk_ptr();

  const rcBegin = ex.replay_begin_load();
  if (rcBegin !== 0) {
    postMessage({ type: "error", role: "loader", message: readCstr(ex.replay_get_last_error()) });
    return;
  }

  const bytes = data.replayDbBytes;
  const total = bytes.length;
  let fed = 0;
  while (fed < total) {
    const n = Math.min(CHUNK, total - fed);
    // re-read sharedMemory.buffer fresh every iteration - memory.grow()
    // during feeding could detach a cached view for a large enough file.
    new Uint8Array(sharedMemory.buffer).set(bytes.subarray(fed, fed + n), chunkPtr);
    const rc = ex.replay_feed_chunk(n);
    if (rc !== 0) {
      postMessage({ type: "error", role: "loader", message: readCstr(ex.replay_get_last_error()) });
      return;
    }
    fed += n;
    postMessage({ type: "progress", loaded: fed, total });
  }

  const matchCount = ex.replay_finish_load_battle_file();
  if (matchCount < 0) {
    postMessage({ type: "error", role: "loader", message: readCstr(ex.replay_get_last_error()) });
    return;
  }

  const matches = [];
  for (let i = 0; i < matchCount; i++) {
    matches.push({
      startTime: ex.replay_get_match_start_time(i),
      endTime: ex.replay_get_match_end_time(i),
      sceneNo: ex.replay_get_match_scene_no(i),
      faction: readCstr(ex.replay_get_match_faction_ptr(i)),
      startTickId: ex.replay_get_match_start_tick_id(i),
      endTickId: ex.replay_get_match_end_tick_id(i),
    });
  }

  postMessage({
    type: "loaded",
    matchCount,
    matches,
    totalStart: ex.replay_get_total_start_time(),
    totalEnd: ex.replay_get_total_end_time(),
  });
}

function runReaderBounds(ex, data) {
  ex.replay_reader_compute_bounds(data.readerIdx, data.readerCount);
  postMessage({ type: "boundsReady", readerIdx: data.readerIdx });
}

function runCombineBounds(ex, data) {
  ex.replay_combine_bounds(data.readerCount);
  postMessage({
    type: "boundsCombined",
    minX: ex.replay_get_map_min_x(),
    maxX: ex.replay_get_map_max_x(),
    minY: ex.replay_get_map_min_y(),
    maxY: ex.replay_get_map_max_y(),
  });
}

// Phase 5: debug SQL terminal. Runs on the PLAYBACK worker (g_db) - same
// single-writer reasoning as runExportBattle/runPrimeBattle above; a query
// typed into the terminal sees exactly the live state playback itself is
// reading/writing. Rows stream back in bounded batches (sqlRows) rather
// than one giant postMessage, so a broad `SELECT *` over agent_states can't
// stall the worker's message loop or blow up structured-clone cost.
const SQL_ROW_BATCH_SIZE = 500;
// Shared by runSql (the user's own query, "sql*" message types) and
// runSchemaQuery (the schema explorer's background PRAGMA/sqlite_master
// probes, "schema*" message types) - both go through the exact same
// sql_terminal_run/step/column exports (sql_terminal.c only ever has ONE
// "live" statement at a time), but need to land in different UI state on
// the JS side, not overwrite each other - hence the separate message-type
// prefix rather than one shared "sql*" family. A schema refresh can never
// actually interleave with an in-flight runSql call at the C level either
// way: this whole function runs to completion synchronously within one
// worker message handler, so the next queued message (whichever it is)
// only starts once this one has fully returned.
//
// requestId is opaque here - just echoed back on every posted message
// unchanged. main.js now supports any number of independent SQL Terminal/
// Schema Explorer windows all sharing this one worker (still strictly
// serialized, per the above), and needs it to route each response back to
// whichever window's own request this was, or to the schema-probing promise
// that asked for it - see main.js's sqlRequestQueue/postSqlRequest.
function runSqlGeneric(ex, sql, msgPrefix, requestId) {
  const mem8 = new Uint8Array(sharedMemory.buffer);
  const queryBytes = new TextEncoder().encode(sql);
  const bufPtr = ex.sql_terminal_get_query_buf_ptr();
  mem8.set(queryBytes, bufPtr); // sql_terminal_run() itself clamps/truncates to its buffer size

  const rc = ex.sql_terminal_run(queryBytes.length);
  if (rc !== 0) {
    postMessage({ type: msgPrefix + "Error", requestId, message: readCstr(ex.sql_terminal_get_last_error()) });
    return;
  }

  const colCount = ex.sql_terminal_column_count();
  const columns = [];
  for (let i = 0; i < colCount; i++) columns.push(readCstr(ex.sql_terminal_column_name(i)));
  postMessage({ type: msgPrefix + "Columns", requestId, columns });

  let batch = [];
  let rowCount = 0;
  for (;;) {
    const stepRc = ex.sql_terminal_step();
    if (stepRc < 0) {
      postMessage({ type: msgPrefix + "Error", requestId, message: readCstr(ex.sql_terminal_get_last_error()) });
      return;
    }
    if (stepRc === 0) break;
    const row = new Array(colCount);
    for (let i = 0; i < colCount; i++) {
      row[i] = ex.sql_terminal_column_is_null(i) ? null : readCstr(ex.sql_terminal_column_text(i));
    }
    batch.push(row);
    rowCount++;
    if (batch.length >= SQL_ROW_BATCH_SIZE) {
      postMessage({ type: msgPrefix + "Rows", requestId, rows: batch });
      batch = [];
    }
  }
  if (batch.length > 0) postMessage({ type: msgPrefix + "Rows", requestId, rows: batch });
  postMessage({ type: msgPrefix + "Done", requestId, rowCount });
}

function runSql(ex, data) {
  // CURSOR_X()/CURSOR_Y() (replay_worker.c) read whatever was last set here -
  // main.js reads main.wasm's cam_x/cam_y (a separate WASM instance/memory)
  // and sends them along with every query, right before it's run.
  if (typeof data.cursorX === "number" && typeof data.cursorY === "number") {
    ex.replay_set_cursor_world_pos(data.cursorX, data.cursorY);
  }
  runSqlGeneric(ex, data.sql, "sql", data.requestId);
}

function runSchemaQuery(ex, data) {
  runSqlGeneric(ex, data.sql, "schema", data.requestId);
}

// ---- multi-database SQL terminal: replay.db/battle.db on-demand views ----
// viewKind: 1 = replay.db (r), 2 = battle.db (b) - matches replay_export.c's
// replay_ensure_db_view()/replay_run_generator_script() convention.
function runEnsureDbView(ex, data) {
  const rc = ex.replay_ensure_db_view(data.viewKind);
  if (rc < 0) postMessage({ type: "dbViewError", viewKind: data.viewKind, message: readCstr(ex.replay_export_get_last_error()) });
  else postMessage({ type: "dbViewReady", viewKind: data.viewKind, rebuilt: rc === 1 });
}

function runGeneratorScript(ex, data) {
  const mem8 = new Uint8Array(sharedMemory.buffer);
  const bytes = new TextEncoder().encode(data.sql);
  const bufPtr = ex.replay_get_generator_script_buf_ptr();
  mem8.set(bytes, bufPtr);
  const rc = ex.replay_run_generator_script(data.viewKind, bytes.length);
  if (rc < 0) postMessage({ type: "dbViewError", viewKind: data.viewKind, message: readCstr(ex.replay_export_get_last_error()) });
  else postMessage({ type: "dbViewReady", viewKind: data.viewKind, rebuilt: true });
}

function runResetGeneratorScript(ex, data) {
  const rc = ex.replay_reset_generator_script(data.viewKind);
  if (rc < 0) postMessage({ type: "dbViewError", viewKind: data.viewKind, message: readCstr(ex.replay_export_get_last_error()) });
  else postMessage({ type: "dbViewReady", viewKind: data.viewKind, rebuilt: true });
}

function runGetDefaultGeneratorSql(ex, data) {
  const ptr = data.viewKind === 1 ? ex.replay_get_default_replaydb_sql() : ex.replay_get_default_battledb_sql();
  postMessage({ type: "defaultGeneratorSql", viewKind: data.viewKind, sql: readCstr(ptr) });
}

function runCheckpointSave(ex) {
  const id = ex.sql_checkpoint_save();
  if (id < 0) postMessage({ type: "checkpointError", message: readCstr(ex.sql_checkpoint_get_last_error()) });
  else postMessage({ type: "checkpointSaved", id });
}
function runCheckpointRevert(ex, data) {
  const rc = ex.sql_checkpoint_revert(data.id);
  if (rc !== 0) postMessage({ type: "checkpointError", message: readCstr(ex.sql_checkpoint_get_last_error()) });
  else postMessage({ type: "checkpointReverted", id: data.id });
}

// temporary diagnostic - see replay_worker.c's replay_debug_index_visible
// and sqlite3_vfs_mem.c's WASM_VFS_LOCK_TRACE facility.
function runDebugIndexVisible(ex, data) {
  postMessage({ type: "debugIndexVisible", matchIdx: data.matchIdx, result: ex.replay_debug_index_visible(data.matchIdx) });
}
function runResetVfsTraces(ex) {
  ex.wasm_vfs_reset_traces();
  postMessage({ type: "vfsTracesReset" });
}
function runGetVfsTraces(ex) {
  postMessage({ type: "vfsTraces", lockTrace: readCstr(ex.wasm_vfs_get_lock_trace()), ioTrace: readCstr(ex.wasm_vfs_get_io_trace()) });
}
function runGetLockCounters(ex) {
  postMessage({ type: "lockCounters", sharedCount: ex.wasm_vfs_debug_shared_count(), exclusiveKind: ex.wasm_vfs_debug_exclusive_kind() });
}

function runFrame(ex, data) {
  if (data.seek) ex.replay_seek_to_time(data.time);
  else ex.replay_advance_to_time(data.time);

  const count = ex.replay_get_frame_count();
  const ptr = ex.replay_get_frame_buffer_ptr();
  // Copy out of shared memory into a plain, transferable buffer for postMessage.
  const floatView = new Float32Array(sharedMemory.buffer, ptr, count * 3);
  const out = new Float32Array(count * 3);
  out.set(floatView);

  postMessage(
    {
      type: "frame",
      buffer: out,
      count,
      activeMatchIndex: ex.replay_get_active_match_index(),
      relativeTime: ex.replay_get_relative_time(),
      // Chat is not delivered here at all - main.js runs a real SQL query
      // (gated by this) through the normal SQL Terminal path instead of a
      // frame-coupled push feed (see main.js's refreshChatFromQuery for why).
      currentTickId: ex.replay_get_current_tick_id(),
      // replay_seek_to_time/replay_advance_to_time above may have called
      // fetch_positions() -> replay_ensure_battle_ready(), which can evict a
      // farther-away battle to make room under a tight budget - this mask
      // is the source of truth main.js resyncs primedBattles against every
      // frame, so an eviction's loading-bar indicator fades correctly even
      // though nothing posted a dedicated "evicted" event for it.
      readyMask: ex.replay_get_battle_ready_mask(),
    },
    [out.buffer]
  );
}

// Phase 4: drives the whole export pipeline (replay_export.c) for one
// battle and hands the resulting uncompressed ustar tar bytes back to
// main.js, which either downloads them as-is (debug) or forwards them to
// compress.wasm for xz compression. Runs on the PLAYBACK worker (g_db) -
// same single-writer reasoning as runPrimeBattle above.
function runExportBattle(ex, data) {
  ex.replay_set_export_time_unix(Date.now() / 1000); // only JS has real wall-clock time, see replay_worker.c
  const rc = ex.replay_export_battle(data.matchIdx);
  if (rc !== 0) {
    postMessage({ type: "error", role: "export", message: readCstr(ex.replay_export_get_last_error()) });
    return;
  }
  const ptr = ex.replay_export_get_tar_ptr();
  const len = ex.replay_export_get_tar_len();
  const view = new Uint8Array(sharedMemory.buffer, ptr, len);
  const out = new Uint8Array(len);
  out.set(view); // copy out of shared memory before it's freed/reused by the next export
  postMessage({ type: "exported", matchIdx: data.matchIdx, tar: out }, [out.buffer]);
}

// 'prefetch': a dedicated, persistent worker with its own READWRITE SQLite
// connection (opened fresh inside replay_prefetch_battle - never touches the
// playback worker's g_db) and its own larger heap slab (thread id 9, see
// WASM_PREFETCH_THREAD_ID/WASM_PREFETCH_HEAP_SIZE in wasm_layout.h), used to
// build a not-yet-visited battle's index ahead of the playback cursor so the
// playback worker's own self-healing call is a cheap no-op by the time the
// user actually gets there. main.js drives it one request at a time, always
// re-targeting the battle nearest the current cursor.
function runPrefetchBattle(ex, data) {
  ex.replay_prefetch_battle(data.matchIdx, data.startTickId, data.endTickId);
  postMessage({ type: "prefetched", matchIdx: data.matchIdx });
}

// Runs on the PLAYBACK worker (g_db, the sole writer - see replay_prefetch_battle's
// comment in replay_worker.c for why there's only ever one). This is the
// other half of prefetching: replay_prefetch_battle() above only computes a
// battle's rowid bounds off-thread; someone still has to actually build its
// index, and that can only happen on g_db. main.js calls this ahead of the
// cursor, during a gap between frame requests, so the cost lands before the
// user scrubs there instead of exactly when they arrive - the CREATE INDEX
// itself is unavoidable (single-writer), only its *timing* is the thing
// being optimized here.
//
// Calls replay_try_prime_battle() (not replay_ensure_battle_ready() directly
// - that one's reserved for the correctness-critical self-healing path
// inside fetch_positions(), which must always succeed) - this one may
// legitimately decline under a tight memory budget, reported back as
// 'primingDeclined' rather than 'battlePrimed' so main.js's scheduler stops
// re-requesting the same target until something changes (see
// declinedPrimingBattles there). Either way, readyMask reflects the CURRENT
// state of every battle - including any eviction that just happened to make
// room - so main.js can resync its primedBattles Set from a single source of
// truth instead of trying to track individual evict events (see
// replay_get_battle_ready_mask's comment in replay_worker.c for why that
// matters).
function runPrimeBattle(ex, data) {
  const rc = ex.replay_try_prime_battle(data.matchIdx, data.currentMatchIdx);
  const readyMask = ex.replay_get_battle_ready_mask();
  if (rc === 1) {
    postMessage({ type: "primingDeclined", matchIdx: data.matchIdx, readyMask });
  } else {
    postMessage({ type: "battlePrimed", matchIdx: data.matchIdx, readyMask });
  }
}

// One-shot setup call, sent once right after 'loaded' (see main.js) - sets
// the soft memory ceiling replay_ensure_battle_ready()/replay_try_prime_battle()
// in replay_worker.c weigh against before building a new battle's index.
function runSetPrimingBudget(ex, data) {
  ex.replay_set_priming_budget_bytes(data.bytes);
}

onmessage = async (e) => {
  const data = e.data;
  try {
    // Checked before touching `instance` (still null during/before 'init')
    // and before the switch below, so this always works regardless of what
    // this worker was in the middle of. See shuttingDown's declaration for
    // why this exists instead of just letting main.js call .terminate().
    if (data.type === "shutdown") {
      shuttingDown = true;
      closeAllOpfsHandles();
      postMessage({ type: "shutdownComplete" });
      return;
    }

    if (data.type === "init") {
      role = data.role;
      const ex = await bootstrap(data.memory, data.module, data.threadId);
      if (shuttingDown) return; // bootstrap() bailed out and already closed everything
      const roleNum = role === "reader" ? 1 : role === "prefetch" ? 2 : 0;
      ex.thread_main(data.threadId, roleNum);
      postMessage({ type: "ready" });
      return;
    }

    const ex = instance.exports;
    switch (data.type) {
      case "load":
        await runLoader(ex, data);
        break;
      case "loadBattleFile":
        await runLoadBattleFile(ex, data);
        break;
      case "computeBounds":
        runReaderBounds(ex, data);
        break;
      case "combineBounds":
        runCombineBounds(ex, data);
        break;
      case "prefetchBattle":
        runPrefetchBattle(ex, data);
        break;
      case "primeBattle":
        runPrimeBattle(ex, data);
        break;
      case "setPrimingBudget":
        runSetPrimingBudget(ex, data);
        break;
      case "debugIndexVisible":
        runDebugIndexVisible(ex, data);
        break;
      case "resetVfsTraces":
        runResetVfsTraces(ex);
        break;
      case "getVfsTraces":
        runGetVfsTraces(ex);
        break;
      case "getLockCounters":
        runGetLockCounters(ex);
        break;
      case "heapDebug":
        postMessage({
          type: "heapDebug",
          regionCount: ex.heap_debug_region_count(),
          extendFailures: ex.heap_debug_extend_failures(),
          // Memory-budgeted priming diagnostics - added because diagnosing
          // "why isn't it priming more battles" previously meant reaching
          // into postMessage traffic ad hoc; a real debug getter is the
          // reliable way to answer that, not a one-off.
          playbackHeapBytes: ex.replay_get_playback_heap_bytes(),
          battleReadyMask: ex.replay_get_battle_ready_mask(),
          lastError: readCstr(ex.replay_get_last_error()),
        });
        break;
      case "frame":
        runFrame(ex, data);
        break;
      case "exportBattle":
        runExportBattle(ex, data);
        break;
      case "runSql":
        runSql(ex, data);
        break;
      case "checkpointSave":
        runCheckpointSave(ex);
        break;
      case "checkpointRevert":
        runCheckpointRevert(ex, data);
        break;
      case "schemaQuery":
        runSchemaQuery(ex, data);
        break;
      case "ensureDbView":
        runEnsureDbView(ex, data);
        break;
      case "runGeneratorScript":
        runGeneratorScript(ex, data);
        break;
      case "resetGeneratorScript":
        runResetGeneratorScript(ex, data);
        break;
      case "getDefaultGeneratorSql":
        runGetDefaultGeneratorSql(ex, data);
        break;
      default:
        postMessage({ type: "error", message: "unknown message type: " + data.type });
    }
  } catch (err) {
    console.log(`[worker ${threadId} role=${role}] error: ${err.message}`);
    postMessage({ type: "error", role, message: err.message, stack: err.stack });
  }
};

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

async function bootstrap(memory, module, id) {
  sharedMemory = memory;
  threadId = id;

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
    },
  };

  instance = await WebAssembly.instantiate(module, importObject);
  const ex = instance.exports;

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

  const chatMessages = [];
  const newChats = ex.replay_get_new_chat_count();
  for (let i = 0; i < newChats; i++) {
    chatMessages.push({
      username: readCstr(ex.replay_get_chat_username_ptr(i)),
      message: readCstr(ex.replay_get_chat_message_ptr(i)),
      team: ex.replay_get_chat_team(i),
    });
  }
  if (newChats > 0) ex.replay_advance_chat_cursor(newChats);

  postMessage(
    {
      type: "frame",
      buffer: out,
      count,
      activeMatchIndex: ex.replay_get_active_match_index(),
      relativeTime: ex.replay_get_relative_time(),
      chatMessages,
    },
    [out.buffer]
  );
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
function runPrimeBattle(ex, data) {
  ex.replay_ensure_battle_ready(data.matchIdx);
  postMessage({ type: "battlePrimed", matchIdx: data.matchIdx });
}

onmessage = async (e) => {
  const data = e.data;
  try {
    if (data.type === "init") {
      role = data.role;
      const ex = await bootstrap(data.memory, data.module, data.threadId);
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
      case "frame":
        runFrame(ex, data);
        break;
      default:
        postMessage({ type: "error", message: "unknown message type: " + data.type });
    }
  } catch (err) {
    postMessage({ type: "error", role, message: err.message, stack: err.stack });
  }
};

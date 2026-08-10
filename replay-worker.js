// One script, three roles (parameterized by the init message), all sharing
// the same WebAssembly.Memory:
//   - 'loader': streams the file in, opens+indexes the DB, scans matches,
//     then continues running as the 'playback' role for the rest of the
//     session (no separate hand-off needed - there's no expensive
//     precompute phase blocking it from serving live queries immediately).
//   - 'reader': genuinely parallel, read-only work only (its own SQLite
//     connection - concurrently stepping someone else's prepared
//     statement isn't safe even under SQLITE_THREADSAFE=1). Reports back
//     and terminates once done.
//
// This file is the entire replay engine's JS footprint for Worker-side
// logic: no SQL, no tick/match/roster bookkeeping happens here - it all
// happens in replay_worker.wasm. This script only does thread bootstrap,
// byte plumbing (file chunks in, frame buffers out), and message routing.

let instance = null;
let sharedMemory = null;
let role = null;
let threadId = -1;

const TLS_POOL_BASE = 400 * 1024 * 1024; // clear of the heap-slab/RegionA/RegionC layout (wasm_layout.h)
const TLS_SLOT_SIZE = 65536;
const STACK_POOL_BASE = 300 * 1024 * 1024;
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

  ex.__stack_pointer.value = STACK_POOL_BASE + id * STACK_SLOT_SIZE + STACK_SLOT_SIZE; // stack grows down from the top
  if (ex.__wasm_init_tls) ex.__wasm_init_tls(TLS_POOL_BASE + id * TLS_SLOT_SIZE);

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

onmessage = async (e) => {
  const data = e.data;
  try {
    if (data.type === "init") {
      role = data.role;
      const ex = await bootstrap(data.memory, data.module, data.threadId);
      ex.thread_main(data.threadId, role === "reader" ? 1 : 0);
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

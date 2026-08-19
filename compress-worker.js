// Thin wrapper around compress.wasm - the standalone, non-threaded xz/LZMA2
// encoder built from the vendored LZMA SDK (see lzma-sdk/NOTICE.md and
// compress_worker.c). Unlike replay-worker.js's module, compress.wasm is
// NOT built with --import-memory: it's a one-shot, per-battle-sized,
// single-connection tool with nothing to share across Workers, so it just
// owns and exports its own memory. Every byte access here goes through
// instance.exports.memory, never a JS-constructed WebAssembly.Memory - a
// real bug caught during development (see testdata/compress_test.html's
// history) when this file's original test scaffold assumed the opposite.

let instance = null;
let bootstrapPromise = null;

function readCstr(ptr) {
  const mem = new Uint8Array(instance.exports.memory.buffer);
  let end = ptr;
  while (mem[end] !== 0) end++;
  return new TextDecoder().decode(mem.subarray(ptr, end));
}

async function bootstrap() {
  if (instance) return instance;
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const module = await WebAssembly.compile(await (await fetch('compress.wasm', { cache: 'no-store' })).arrayBuffer());
      instance = await WebAssembly.instantiate(module, {});
      return instance;
    })();
  }
  return bootstrapPromise;
}

const CHUNK = 1024 * 1024;

// Shared by both directions: compress_begin()/compress_feed_chunk() are the
// same input-accumulation exports regardless of which of compress_finish()/
// decompress_finish() runs afterward - see compress_worker.c.
async function feedInput(ex, data, progressType) {
  ex.compress_begin(); // frees any previous call's input/output buffers - safe to reuse the instance across calls
  const chunkPtr = ex.compress_get_input_chunk_ptr();
  let fed = 0;
  while (fed < data.length) {
    const n = Math.min(CHUNK, data.length - fed);
    // re-read ex.memory.buffer fresh every iteration - memory.grow() during
    // feeding (goyslopless-c's elastic non-threaded heap) detaches the old
    // ArrayBuffer for a large enough input.
    new Uint8Array(ex.memory.buffer).set(data.subarray(fed, fed + n), chunkPtr);
    const rc = ex.compress_feed_chunk(n);
    if (rc !== 0) throw new Error('compress_feed_chunk failed: ' + readCstr(ex.compress_get_last_error()));
    fed += n;
    postMessage({ type: progressType, fed, total: data.length });
  }
}

function readOutput(ex) {
  const outPtr = ex.compress_get_output_ptr();
  const outLen = ex.compress_get_output_len();
  const out = new Uint8Array(outLen);
  out.set(new Uint8Array(ex.memory.buffer, outPtr, outLen));
  return out;
}

async function runCompress(data, dictSizeMiB) {
  const ex = (await bootstrap()).exports;
  await feedInput(ex, data, 'compressProgress');
  const rc = ex.compress_finish(dictSizeMiB || 24);
  if (rc !== 0) throw new Error('compress_finish failed: ' + readCstr(ex.compress_get_last_error()));
  return readOutput(ex);
}

async function runDecompress(data) {
  const ex = (await bootstrap()).exports;
  await feedInput(ex, data, 'decompressProgress');
  const rc = ex.decompress_finish();
  if (rc !== 0) throw new Error('decompress_finish failed: ' + readCstr(ex.compress_get_last_error()));
  return readOutput(ex);
}

onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === 'compress') {
      const out = await runCompress(d.data, d.dictSizeMiB);
      postMessage({ type: 'compressed', out }, [out.buffer]);
    } else if (d.type === 'decompress') {
      const out = await runDecompress(d.data);
      postMessage({ type: 'decompressed', out }, [out.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', message: err.message, stack: err.stack });
  }
};

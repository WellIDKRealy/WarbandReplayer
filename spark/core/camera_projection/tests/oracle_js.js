#!/usr/bin/env node
// JS side of the camera_projection differential oracle: the OLD main.js worldToScreen.
//
// Usage: node oracle_js.js <main.js> <seed> <count>      (cases are written to stdout)
//
// The reference code is the OLD main.js ITSELF: worldToScreen() is extracted from the source text at run
// time (no re-typed copy) and evaluated with JS Numbers (IEEE binary64) against a mock wasm instance whose
// get_cam_x/get_cam_y/get_cam_zoom return float32 values (Math.fround, like the wasm f32 getters) and a mock
// canvas.  One case per line, all numbers as raw IEEE bit patterns in hex (bit-exact comparison):
//     W H camX camY zoom shiftX shiftY  wx wy  px py
//     int int f32  f32  f32  f32    f32  f64 f64 f64 f64
'use strict';
const fs = require('fs');

const [, , mainJs, seedArg, countArg] = process.argv;
const src = fs.readFileSync(mainJs, 'utf8');
const m = src.match(/function worldToScreen\(wx, wy\) \{\n([\s\S]*?)\n\}\n/);
if (!m) { console.error('worldToScreen not found in ' + mainJs); process.exit(2); }
const body = m[1];
for (const needle of [
  'const sx = (wx + currentViewShiftX - camX) * camZoom;',
  'const sy = (wy + currentViewShiftY - camY) * camZoom;',
  'const aspect = canvas.width / canvas.height;',
  'if (aspect > 1.0) xBound *= aspect; else yBound /= aspect;',
  'const ndcX = sx / xBound, ndcY = sy / yBound;',
  'return { x: (ndcX + 1) / 2 * canvas.width, y: (1 - ndcY) / 2 * canvas.height };',
]) {
  if (!body.includes(needle)) { console.error('worldToScreen body changed (' + needle + '); oracle needs review'); process.exit(2); }
}
const make = new Function('wasmInstance', 'canvas', 'currentViewShiftX', 'currentViewShiftY',
  'return function worldToScreen(wx, wy) {\n' + body + '\n};');

const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const hex64 = (x) => { f64[0] = x; return u64[0].toString(16).padStart(16, '0'); };
const hex32 = (x) => { f32[0] = x; return u32[0].toString(16).padStart(8, '0'); };

// mulberry32
let a = (parseInt(seedArg, 10) >>> 0) || 1;
const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const logu = (lo, hi) => Math.exp(Math.log(lo) + rnd() * (Math.log(hi) - Math.log(lo)));
const sgn = () => (rnd() < 0.5 ? -1 : 1);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const sizes = [1, 2, 3, 600, 640, 800, 1080, 1366, 1920, 2560, 3840, 4096, 65535, 65536];
const size = () => (rnd() < 0.5 ? pick(sizes) : Math.max(1, Math.min(65536, Math.round(logu(1, 65536)))));
const coord = (lim) => {          // a world-ish number within +-lim
  const r = rnd();
  if (r < 0.05) return 0;
  if (r < 0.10) return sgn() * lim;
  if (r < 0.15) return -0;
  return sgn() * logu(1e-6, lim);
};

const count = parseInt(countArg, 10);
const out = [];
for (let i = 0; i < count; i++) {
  const W = size(), H = size();
  const camX = Math.fround(coord(1e6)), camY = Math.fround(coord(1e6));
  const zoom = Math.fround(rnd() < 0.1 ? pick([0.02, 40, 1]) : logu(0.02, 40));
  const shX = Math.fround(coord(2e6)), shY = Math.fround(coord(2e6));
  const wx = coord(1e6), wy = coord(1e6);
  const ws = make(
    { exports: { get_cam_x: () => camX, get_cam_y: () => camY, get_cam_zoom: () => zoom } },
    { width: W, height: H }, shX, shY);
  const r = ws(wx, wy);
  out.push([W, H, hex32(camX), hex32(camY), hex32(zoom), hex32(shX), hex32(shY),
            hex64(wx), hex64(wy), hex64(r.x), hex64(r.y)].join(' '));
}
process.stdout.write(out.join('\n') + '\n');

#!/usr/bin/env node
// JS side of the tick_index differential oracle.
//
// Usage: node oracle_js.js <main.js> <cases.json> <out.json>
//
// The reference code is the OLD main.js ITSELF: blendAngleDeg() and the position lerp of
// updateNatoSymbolTransform() are extracted from the source text at run time (no re-typed copy), so the
// oracle follows the old implementation by construction.  Everything is evaluated with JS Numbers
// (IEEE binary64) and returned as 64-bit hex patterns, so the comparison is bit-exact.
'use strict';
const fs = require('fs');

const [, , mainJs, casesPath, outPath] = process.argv;
const src = fs.readFileSync(mainJs, 'utf8');

// ---- blendAngleDeg: take the function text verbatim ------------------------------------------
const m = src.match(/function blendAngleDeg\(a, b, alpha\) \{\n([\s\S]*?)\n\}\n/);
if (!m) { console.error('blendAngleDeg not found in ' + mainJs); process.exit(2); }
const body = m[1];
if (!/let delta = \(\(b - a \+ 180\) % 360 \+ 360\) % 360 - 180;/.test(body) ||
    !/return a \+ delta \* alpha;/.test(body)) {
  console.error('blendAngleDeg body changed; oracle needs review'); process.exit(2);
}
const blend = new Function('a', 'b', 'alpha', body);
const deltaOnly = new Function('a', 'b', 'alpha', body.replace('return a + delta * alpha;', 'return delta;'));

// ---- the NATO position lerp (JS doubles): take the expression verbatim -----------------------
const lm = src.match(/const wx = rowB \? (rowA\.x \+ \(rowB\.x - rowA\.x\) \* alpha) : rowA\.x;/);
if (!lm) { console.error('wx lerp expression not found in ' + mainJs); process.exit(2); }
const lerpExpr = new Function('rowA', 'rowB', 'alpha', 'return ' + lm[1] + ';');

// ---- matchIndexForTime: function text verbatim ------------------------------------------------
const mm = src.match(/function matchIndexForTime\(t\) \{\n([\s\S]*?)\n\}\n/);
if (!mm) { console.error('matchIndexForTime not found in ' + mainJs); process.exit(2); }
if (!/matches\[i\]\.startTime/.test(mm[1]) || !/matches\[i\]\.endTime/.test(mm[1])) {
  console.error('matchIndexForTime body changed; oracle needs review'); process.exit(2);
}
const matchIdx = new Function('matches', 't', mm[1]);

// ---- fmod: JS `%` (the operator used by blendAngleDeg) --------------------------------------
const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const hex = (x) => { f64[0] = x; return u64[0].toString(16).padStart(16, '0'); };
const num = (h) => { u64[0] = BigInt('0x' + h); return f64[0]; };

const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const out = { lerp64: [], angle: [], fmod: [], match: [] };
for (const [x, bx, al] of cases.lerp64) {
  out.lerp64.push(hex(lerpExpr({ x: num(x) }, { x: num(bx) }, num(al))));
}
for (const [a, b, al] of cases.angle) {
  out.angle.push([hex(deltaOnly(num(a), num(b), num(al))), hex(blend(num(a), num(b), num(al)))]);
}
for (const x of cases.fmod) out.fmod.push(hex(num(x) % 360));
for (const [ivs, t] of cases.match) {
  const matches = ivs.map(([s, e]) => ({ startTime: num(s), endTime: num(e) }));
  out.match.push(matchIdx(matches, num(t)));
}
fs.writeFileSync(outPath, JSON.stringify(out));

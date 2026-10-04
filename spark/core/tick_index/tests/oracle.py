#!/usr/bin/env python3
"""Oracle generator for the tick_index differential tests.

Writes a text file of cases + expected results of the OLD implementation:
  * tick lookup + alpha  : a literal Python translation of replay_worker.c
                           find_tick_index_for_time / build_frame_at_time (checked against the real C code
                           by --check-c, which extracts those lines from replay_worker.c and compiles them);
  * 32-bit lerp          : Python float32 emulation of  x + (bx - x) * alpha  (blend_render_slot; also
                           checked against the real C line by --check-c);
  * 64-bit lerp, angle, fmod : the OLD main.js code itself, run by node (oracle_js.js).

Tick time arrays come from the real replays (SELECT time FROM ticks ORDER BY id) when the replay
directory exists; otherwise from the committed integer-only gap fixture oracle/tick_gaps.txt (derived
data: run-length encoded gaps between consecutive ticks, no absolute times, no names, no chat).
Real data is NEVER copied into the repository.

  oracle.py --out cases.txt [--replays DIR] [--seed N] [--main-js PATH]
  oracle.py --export-gaps oracle/tick_gaps.txt [--replays DIR]
  oracle.py --check-c cases.txt [--worker-c PATH]
"""
import argparse, glob, json, math, os, random, re, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
DEFAULT_REPLAYS = ('/tmp/claude-0/-home-user-WarbandReplayer/7d5d330f-4ddd-581f-b95d-49a16472cab6/'
                   'scratchpad/data/replays')
GAPS_FIXTURE = os.path.join(HERE, 'oracle', 'tick_gaps.txt')
GAP_BASE = 1_700_000_000   # absolute time given to gap-fixture arrays (arbitrary; nothing real)
QUERIES_PER_CLASS = 100_000


# ---- bit helpers -------------------------------------------------------------------------------
def b64(x):  return struct.unpack('<Q', struct.pack('<d', x))[0]
def f64(b):  return struct.unpack('<d', struct.pack('<Q', b))[0]
def b32(x):  return struct.unpack('<I', struct.pack('<f', x))[0]
_PD, _PF = struct.Struct('>d').pack, struct.Struct('>f').pack
def x64(x):  return _PD(x).hex()          # big-endian bytes == the IEEE bit pattern as 16 hex digits
def x32(x):  return _PF(x).hex()


def f32(x):
    """(float) x with round-to-nearest-even; overflow -> +-inf like C on IEEE hardware."""
    try:
        return struct.unpack('<f', struct.pack('<f', x))[0]
    except OverflowError:
        return math.copysign(math.inf, x)


# ---- the OLD C logic, literally ------------------------------------------------------------------
def old_find_tick_index_for_time(times, t):
    n = len(times)
    if n == 0:
        return 0
    if t <= times[0]:
        return 0
    if t >= times[n - 1]:
        return n - 1
    lo, hi = 0, n - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if times[mid] <= t:
            lo = mid
        else:
            hi = mid - 1
    return lo


def old_build_frame_at_time(times, t):
    """-> (idxA, idxB, alpha as float32 value, alpha_was_negative_zero)"""
    n = len(times)
    idxA = old_find_tick_index_for_time(times, t)
    idxB = idxA + 1 if idxA + 1 < n else idxA
    alpha = 0.0
    if times[idxB] > times[idxA]:
        alpha = f32((t - times[idxA]) / (times[idxB] - times[idxA]))
        if alpha < 0.0:
            alpha = 0.0
        if alpha > 1.0:
            alpha = 1.0
    negzero = alpha == 0.0 and math.copysign(1.0, alpha) < 0
    return idxA, idxB, alpha, negzero


def old_lerp32(x, bx, alpha):
    d = f32(bx - x)
    p = f32(d * alpha)
    return f32(x + p)


# ---- real data ---------------------------------------------------------------------------------
def load_real(replays):
    import sqlite3
    arrays = []
    for f in sorted(glob.glob(os.path.join(replays, '*.sqlite'))):
        c = sqlite3.connect('file:%s?mode=ro' % f, uri=True)
        ts = [float(r[0]) for r in c.execute('SELECT time FROM ticks ORDER BY id')]
        c.close()
        if ts:
            arrays.append(ts)
    return arrays


def sample_agents(replays, limit_files=3, per_file=4000):
    """A few thousand real (pos_x, pos_y, yaw) values for realistic lerp / angle inputs (not stored)."""
    import sqlite3
    xs, ys, yaws = [], [], []
    files = sorted(glob.glob(os.path.join(replays, '*.sqlite')), key=os.path.getsize)
    used = 0
    for f in files:
        if os.path.getsize(f) < 2_000_000 or os.path.getsize(f) > 60_000_000:
            continue
        c = sqlite3.connect('file:%s?mode=ro' % f, uri=True)
        for x, y, yaw in c.execute('SELECT pos_x, pos_y, yaw FROM agent_states WHERE id % 37 = 0 LIMIT ?',
                                   (per_file,)):
            if x is not None and y is not None and yaw is not None:
                xs.append(float(x)); ys.append(float(y)); yaws.append(float(yaw))
        c.close()
        used += 1
        if used >= limit_files:
            break
    return xs, ys, yaws


def export_gaps(arrays, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        fh.write('# tick_index test fixture: DERIVED integer-only data.\n'
                 '# One line per replay file: n_ticks then run-length encoded gaps (gap:count) between\n'
                 '# consecutive ticks.time values (whole seconds). No absolute times, no names, no chat.\n'
                 '# Regenerate: tests/oracle.py --export-gaps oracle/tick_gaps.txt\n')
        for ts in arrays:
            gaps = [int(ts[i + 1] - ts[i]) for i in range(len(ts) - 1)]
            runs = []
            for g in gaps:
                if runs and runs[-1][0] == g:
                    runs[-1][1] += 1
                else:
                    runs.append([g, 1])
            fh.write('%d %s\n' % (len(ts), ' '.join('%d:%d' % (g, c) for g, c in runs)))


def load_gaps(path):
    arrays = []
    with open(path) as fh:
        for line in fh:
            if line.startswith('#') or not line.strip():
                continue
            parts = line.split()
            n = int(parts[0])
            ts = [float(GAP_BASE)]
            for tok in parts[1:]:
                g, c = tok.split(':')
                g = int(g)
                for _ in range(int(c)):
                    ts.append(ts[-1] + g)
            assert len(ts) == n, (len(ts), n)
            arrays.append(ts)
    return arrays


# ---- query generation ------------------------------------------------------------------------
def nextafter(x, d):
    return math.nextafter(x, d)


def make_queries(ts, nq, rng):
    n = len(ts)
    t0, t1 = ts[0], ts[-1]
    span = max(t1 - t0, 1.0)
    qs = [-1.0e19, 1.0e19, 0.0, -0.0, t0 - 1.0, t0 - 1e-6, t0, t0 + 1e-6, t1 - 1e-6, t1, t1 + 1e-6, t1 + 1e6,
          nextafter(t0, -math.inf), nextafter(t0, math.inf), nextafter(t1, -math.inf), nextafter(t1, math.inf),
          t0 - 1e12, t1 + 1e12, t0 - span, t1 + span]
    # exactly on ticks and 1 ulp either side (covers runs of equal times and the first/last fast paths)
    k = min(n, max(1, nq // 4 // 3))
    idxs = range(n) if k >= n else rng.sample(range(n), k)
    for i in idxs:
        t = ts[i]
        qs += [t, nextafter(t, -math.inf), nextafter(t, math.inf)]
    # strictly between neighbouring ticks (and exactly on a tick when the neighbours are equal)
    specials = [0.25, 0.5, 0.75, 1.0 - 2.0 ** -30, 2.0 ** -30, 1.0 - 2.0 ** -52, 2.0 ** -52]
    while len(qs) < nq * 2 // 4 + 20 and n > 1:
        i = rng.randrange(n - 1)
        u = rng.choice(specials) if rng.random() < 0.5 else rng.random()
        qs.append(ts[i] + (ts[i + 1] - ts[i]) * u)
    # uniform reals over (and slightly beyond) the recorded interval, and whole seconds
    while len(qs) < nq * 3 // 4:
        qs.append(rng.uniform(t0 - 0.05 * span, t1 + 0.05 * span))
    while len(qs) < nq:
        qs.append(float(rng.randint(int(t0) - 5, int(t1) + 5)))
    rng.shuffle(qs)
    qs = [max(-1.0e19, min(1.0e19, q)) for q in qs]      # Tick_Time domain (the wrapper rejects the rest)
    return qs[:max(nq, 20)]


def classify(n):
    return 'tiny' if n < 100 else 'small' if n < 1000 else 'medium' if n < 10000 else 'huge'


def dupify(ts, rng):
    out = []
    for t in ts:
        out += [t] * rng.choice((1, 1, 2, 3, 4))
    return out


def synthetic_arrays(rng):
    arrs = []
    arrs.append(('synth', [1.7e9]))
    arrs.append(('synth', [1.7e9, 1.7e9 + 1]))
    arrs.append(('synth', [5.0, 5.0]))
    arrs.append(('synth', [5.0, 5.0, 5.0, 6.0, 6.0]))
    arrs.append(('synth', [0.0] * 64))
    arrs.append(('synth', [float(i // 3) for i in range(300)]))                # runs of 3 equal times
    arrs.append(('synth', sorted(float(rng.randint(0, 9)) for _ in range(400))))   # heavy duplication
    arrs.append(('synth', [float(i) for i in range(-50, 50)]))                 # negative times
    arrs.append(('synth', [-1.0e19, -1.0, 0.0, 1.0, 1.0e19]))                  # domain limits
    arrs.append(('synth', [9.99e18, 1.0e19]))
    arrs.append(('synth', [-1.0e19, -9.99e18]))
    arrs.append(('synth', [1.0e-310, 2.0e-310, 3.0e-310, 5.0e-310]))           # denormal times
    arrs.append(('synth', [0.0, 1.0e-300, 1.0e19]))
    arrs.append(('synth', [-1.0e-300, 0.0, 5e-324]))
    arrs.append(('synth', [1.0e10 + i * 0.5 for i in range(200)]))             # fractional tick times
    arrs.append(('synth', sorted(rng.uniform(-1e12, 1e12) for _ in range(5000))))
    return arrs


def write_sets(fh, sets, rng, stats):
    for cls, ts, nq in sets:
        qs = make_queries(ts, nq, rng)
        fh.write('SET %s %d %d\n' % (cls, len(ts), len(qs)))
        fh.write('\n'.join(x64(t) for t in ts) + '\n')
        lines = []
        alphas = []
        for q in qs:
            a, b, al, nz = old_build_frame_at_time(ts, q)
            if nz:
                stats['negzero'] += 1
            lines.append('%s %d %d %s' % (x64(q), a, b, x32(0.0 if al == 0.0 else al)))
            alphas.append(al)
        fh.write('\n'.join(lines) + '\n')
        stats['queries_' + cls] = stats.get('queries_' + cls, 0) + len(qs)
        stats['arrays_' + cls] = stats.get('arrays_' + cls, 0) + 1
        stats['ticks_' + cls] = stats.get('ticks_' + cls, 0) + len(ts)
        stats['alphas'] = alphas[:2000] + stats.get('alphas', [])[:8000]


def run_node(main_js, cases):
    with tempfile.TemporaryDirectory() as d:
        inp, outp = os.path.join(d, 'in.json'), os.path.join(d, 'out.json')
        with open(inp, 'w') as fh:
            json.dump(cases, fh)
        subprocess.run(['node', os.path.join(HERE, 'oracle_js.js'), main_js, inp, outp], check=True)
        with open(outp) as fh:
            return json.load(fh)


def match_cases(rng, arrays, count):
    """(intervals, t) cases for main.js matchIndexForTime: touching / overlapping / unsorted / empty lists."""
    cases = []
    for _ in range(count):
        n = rng.choice((0, 1, 1, 2, 3, 5, 8, 16))
        if arrays and rng.random() < 0.6:                       # battle-like intervals cut from a real tick table
            ts = rng.choice(arrays)
            cuts = sorted(rng.randrange(len(ts)) for _ in range(2 * n))
            ivs = [(ts[cuts[2 * i]], ts[cuts[2 * i + 1]]) for i in range(n)]
            if rng.random() < 0.3:                              # touching: end == next start
                ivs = [(ivs[i][0], ivs[i + 1][0]) for i in range(n - 1)] + ivs[-1:]
        else:
            ivs = [(rng.uniform(-1e3, 1e3), rng.uniform(-1e3, 1e3)) for _ in range(n)]
            ivs = [(a, b) if rng.random() < 0.8 else (b, a) for a, b in ivs]   # some empty (start > end)
        if rng.random() < 0.4:
            rng.shuffle(ivs)
        pool = [x for iv in ivs for x in iv]
        r = rng.random()
        if pool and r < 0.5:
            t = rng.choice(pool)
            t = rng.choice((t, nextafter(t, math.inf), nextafter(t, -math.inf)))
        elif pool and r < 0.8:
            t = rng.uniform(min(pool) - 5, max(pool) + 5)
        else:
            t = rng.choice((0.0, -0.0, 1e19, -1e19, rng.uniform(-1e4, 1e4)))
        cases.append((ivs, t))
    return cases


def gen(args):
    rng = random.Random(args.seed)
    if args.replays and os.path.isdir(args.replays):
        arrays = load_real(args.replays)
        source = 'real replays in ' + args.replays
        agents = sample_agents(args.replays)
    else:
        arrays = load_gaps(GAPS_FIXTURE)
        source = 'committed gap fixture ' + GAPS_FIXTURE
        agents = ([], [], [])
    if len(arrays) == 0:
        sys.exit('no tick arrays found')
    by_class = {}
    for ts in arrays:
        by_class.setdefault(classify(len(ts)), []).append(ts)
    sets = []
    for cls in ('tiny', 'small', 'medium', 'huge'):
        files = by_class.get(cls, [])
        for ts in files:
            sets.append((cls, ts, QUERIES_PER_CLASS // len(files) + 500))
    for cls in ('tiny', 'small', 'medium', 'huge'):     # equal consecutive times (not in the real corpus)
        files = by_class.get(cls, [])
        if files:
            ts = files[0] if cls != 'huge' else files[0][:20000]
            sets.append(('dup-' + cls, dupify(ts, rng), 15_000))
    for cls, ts in synthetic_arrays(rng):
        sets.append((cls, ts, 3000))

    stats = {'negzero': 0}
    xs, ys, yaws = agents
    with open(args.out, 'w') as fh:
        write_sets(fh, sets, rng, stats)
        alphas = [a for a in stats.pop('alphas')]

        # ---- 32-bit lerp (blend_render_slot) ------------------------------------------------
        pos = [f32(v) for v in (xs + ys)] or [f32(rng.uniform(-100, 100)) for _ in range(2000)]
        sp = [0.0, -0.0, 1.0, -1.0, 1e-8, -1e-8, 1e-30, -1e-30, 1e30, -1e30, 100.0, -100.0, 0.1, 0.3, 123.456,
              f32(1.0 + 2 ** -23), f32(1.0 - 2 ** -24), 3.4e-38, 1e-45, -1e-45]
        sp = [f32(v) for v in sp]
        sa = [f32(v) for v in (0.0, 1.0, 0.5, 1.0 - 2 ** -24, 2.0 ** -24, 1e-30, 1 / 3, 0.1, 0.99999994, 1e-45)]
        al_pool = sa + [a for a in alphas if 0.0 <= a <= 1.0][:1000]
        cases32 = [(x, bx, a) for x in sp for bx in sp for a in sa]
        for _ in range(30_000):
            x = rng.choice(pos); bx = rng.choice(pos) if rng.random() < 0.5 else f32(x + rng.uniform(-3, 3))
            cases32.append((x, bx, f32(rng.choice(al_pool)) if rng.random() < 0.5 else f32(rng.random())))
        fh.write('LERP32 %d\n' % len(cases32))
        fh.write('\n'.join('%s %s %s %s' % (x32(x), x32(bx), x32(a), x32(old_lerp32(x, bx, a)))
                           for x, bx, a in cases32) + '\n')

        # ---- JS cases ---------------------------------------------------------------------------
        sp64 = [0.0, -0.0, 1.0, -1.0, 1e-8, 1e-300, -1e-300, 1e150, -1e150, 100.0, -100.0, 0.1, 0.3, 5e-324,
                1.0 + 2 ** -52, 1.0 - 2 ** -53]
        sa64 = [0.0, 1.0, 0.5, 1.0 - 2 ** -53, 2.0 ** -53, 1e-300, 1 / 3, 0.1, 5e-324]
        lerp64 = [(x, bx, a) for x in sp64 for bx in sp64 for a in sa64]
        rawpos = (xs + ys) or [rng.uniform(-100, 100) for _ in range(2000)]
        for _ in range(30_000):
            x = rng.choice(rawpos); bx = rng.choice(rawpos) if rng.random() < 0.5 else x + rng.uniform(-3, 3)
            lerp64.append((x, bx, f32(rng.choice(al_pool)) if rng.random() < 0.5 else rng.random()))

        deg = [y * 180.0 / math.pi for y in yaws]
        spa = [0.0, -0.0, 90.0, -90.0, 180.0, -180.0, 270.0, 360.0, -360.0, 359.99999, 0.00001, 720.0, -720.0,
               1.0e9, -1.0e9, 1.0e9 - 1, -1.0e9 + 1, 45.0, 135.0, 225.0, 315.0,
               nextafter(180.0, 0.0), nextafter(180.0, 1e3), nextafter(-180.0, 0.0), nextafter(-180.0, -1e3),
               5e-324, -5e-324, 1e-300, 540.0, -540.0, 539.9999999, -539.9999999, 1080.0, 359.0, 1.0, -1.0]
        angle = [(a, b, al) for a in spa for b in spa for al in (0.0, 1.0, 0.5, 0.25)]
        pool = deg + spa
        for _ in range(45_000):
            r = rng.random()
            if r < 0.3:
                a, b = rng.uniform(-1e9, 1e9), rng.uniform(-1e9, 1e9)
            elif r < 0.6:
                a, b = rng.uniform(-720, 720), rng.uniform(-720, 720)
            elif r < 0.8:
                a = rng.choice(pool); b = a + rng.choice((rng.uniform(-200, 200), rng.choice((180.0, -180.0,
                                                          360.0, -360.0, 540.0, -540.0)) + rng.uniform(-1e-6, 1e-6)))
            else:
                a, b = rng.choice(pool), rng.choice(pool)
            a = max(-1e9, min(1e9, a)); b = max(-1e9, min(1e9, b))
            angle.append((a, b, rng.choice((0.0, 1.0, rng.random(), f32(rng.random())))))

        fm = [0.0, -0.0, 359.99999999999994, 360.0, -360.0, 720.0, -720.0, 719.9999999999999, 1080.0,
              4.0e9, -4.0e9, 3.9999999e9, 360.0 * 2 ** 23, 360.0 * 2 ** 23 - 1, 360.0 * 2 ** 23 + 1,
              360.0 * 2 ** 22, 5e-324, -5e-324, 1e-300]
        for k in list(range(-40, 41)) + [10 ** 6, -10 ** 6, 11_000_000, -11_000_000, 2 ** 23, -2 ** 23]:
            for e in (0.0, 1e-9, -1e-9):
                v = 360.0 * k + e
                fm += [v, nextafter(v, 1e10), nextafter(v, -1e10)]
        for _ in range(45_000):
            r = rng.random()
            fm.append(rng.uniform(-4e9, 4e9) if r < 0.4 else rng.uniform(-2000, 2000) if r < 0.8
                      else 360.0 * rng.randint(-11_000_000, 11_000_000) + rng.uniform(-1, 1))
        fm = [max(-4.0e9, min(4.0e9, v)) for v in fm]

        matches = match_cases(rng, arrays, 20_000)
        res = run_node(args.main_js, {
            'match': [([(x64(a), x64(b)) for a, b in ivs], x64(t)) for ivs, t in matches],
            'lerp64': [(x64(x), x64(bx), x64(a)) for x, bx, a in lerp64],
            'angle': [(x64(a), x64(b), x64(al)) for a, b, al in angle],
            'fmod': [x64(v) for v in fm]})
        for v, h in zip(fm, res['fmod']):                               # node's % must be C fmod
            assert h == x64(math.fmod(v, 360.0)) or (math.fmod(v, 360.0) == 0.0 and f64(int(h, 16)) == 0.0), v
        fh.write('LERP64 %d\n' % len(lerp64))
        fh.write('\n'.join('%s %s %s %s' % (x64(x), x64(bx), x64(a), r)
                           for (x, bx, a), r in zip(lerp64, res['lerp64'])) + '\n')
        fh.write('FMOD %d\n' % len(fm))
        fh.write('\n'.join('%s %s' % (x64(v), r) for v, r in zip(fm, res['fmod'])) + '\n')
        fh.write('ANGLE %d\n' % len(angle))
        fh.write('\n'.join('%s %s %s %s %s' % (x64(a), x64(b), x64(al), d, r)
                           for (a, b, al), (d, r) in zip(angle, res['angle'])) + '\n')
        fh.write('MATCH %d\n' % len(matches))
        fh.write('\n'.join('%d %d %s %s' % (len(ivs), r, x64(t), ' '.join('%s %s' % (x64(a), x64(b)) for a, b in ivs))
                           for (ivs, t), r in zip(matches, res['match'])) + '\n')
        fh.write('END\n')

    print('oracle: source = %s' % source, file=sys.stderr)
    print('oracle: %s' % ', '.join('%s=%s' % kv for kv in sorted(stats.items())), file=sys.stderr)
    print('oracle: lerp32=%d lerp64=%d angle=%d fmod=%d match=%d' % (len(cases32), len(lerp64), len(angle),
                                                                 len(fm), len(matches)), file=sys.stderr)


# ---- cross-check of the oracle against the REAL old C code ---------------------------------------
C_TEMPLATE = r'''/* generated by tick_index/tests/oracle.py --check-c: harness around VERBATIM lines of replay_worker.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
typedef long long sqlite3_int64;
typedef struct TickEntry { sqlite3_int64 id; double time; } TickEntry;
static TickEntry *g_ticks = 0;
static int g_tick_count = 0;
static float g_last_alpha = 0.0f;

@FIND@

static void old_frame(double t, int *oa, int *ob, float *oal) {
@FRAME@
    *oa = idxA; *ob = idxB; *oal = alpha;
}

typedef struct { float x, y, bx, by; } RenderRowLite;
static float old_lerp32(float x, float bx, float alpha) {
    RenderRowLite r; RenderRowLite *row = &r; r.bx = bx; r.by = bx;
@LERP@
    return x;
}

static uint64_t hx64(const char *s) { return strtoull(s, 0, 16); }
static double d_of(uint64_t b) { double d; memcpy(&d, &b, 8); return d; }
static float f_of(uint32_t b) { float f; memcpy(&f, &b, 4); return f; }
static uint32_t b_of(float f) { uint32_t b; memcpy(&b, &f, 4); return b; }

int main(int argc, char **argv) {
    FILE *fh = fopen(argv[1], "r");
    static char line[1024];
    long frames = 0, lerps = 0, bad = 0;
    while (fgets(line, sizeof line, fh)) {
        if (!strncmp(line, "SET ", 4)) {
            char cls[64]; int n, m;
            sscanf(line, "SET %63s %d %d", cls, &n, &m);
            g_ticks = (TickEntry *)malloc(sizeof(TickEntry) * (size_t)n);
            g_tick_count = n;
            for (int i = 0; i < n; i++) { fgets(line, sizeof line, fh); g_ticks[i].id = i; g_ticks[i].time = d_of(hx64(line)); }
            for (int i = 0; i < m; i++) {
                char tb[32]; int ea, eb; unsigned ealpha;
                fgets(line, sizeof line, fh);
                sscanf(line, "%31s %d %d %x", tb, &ea, &eb, &ealpha);
                int a, b; float al;
                old_frame(d_of(hx64(tb)), &a, &b, &al);
                if (al == 0.0f) al = 0.0f;   /* normalise -0.0 like the oracle */
                frames++;
                if (a != ea || b != eb || b_of(al) != ealpha) { if (bad++ < 10) fprintf(stderr, "C MISMATCH set %s query %s\n", cls, tb); }
            }
            free(g_ticks);
        } else if (!strncmp(line, "LERP32 ", 7)) {
            int m = atoi(line + 7);
            for (int i = 0; i < m; i++) {
                char xs[16], bs[16], as[16], rs[16];
                fgets(line, sizeof line, fh);
                sscanf(line, "%15s %15s %15s %15s", xs, bs, as, rs);
                float r = old_lerp32(f_of((uint32_t)hx64(xs)), f_of((uint32_t)hx64(bs)), f_of((uint32_t)hx64(as)));
                lerps++;
                if (b_of(r) != (uint32_t)hx64(rs)) { if (bad++ < 10) fprintf(stderr, "C MISMATCH lerp32 %s\n", line); }
            }
        }
    }
    printf("C-ORACLE: %ld frame queries and %ld lerp32 cases re-evaluated with the real old C code, %ld mismatches\n", frames, lerps, bad);
    return bad ? 1 : 0;
}
'''


def check_c(args):
    src = open(args.worker_c).read()
    m = re.search(r'static int find_tick_index_for_time\(double t\) \{.*?\n\}\n', src, re.S)
    if not m:
        sys.exit('find_tick_index_for_time not found')
    find = m.group(0)
    i0 = src.index('    int idxA = find_tick_index_for_time(t);')
    i1 = src.index('    g_last_alpha = alpha;') + len('    g_last_alpha = alpha;')
    frame = src[i0:i1]
    lm = re.search(r'^\s*x = x \+ \(row->bx - x\) \* alpha;\s*$', src, re.M)
    if not lm:
        sys.exit('x lerp line not found')
    code = (C_TEMPLATE.replace('@FIND@', find).replace('@FRAME@', frame).replace('@LERP@', lm.group(0)))
    with tempfile.TemporaryDirectory() as d:
        cpath, exe = os.path.join(d, 'oracle_check.c'), os.path.join(d, 'oracle_check')
        open(cpath, 'w').write(code)
        cc = '/usr/bin/gcc' if os.path.exists('/usr/bin/gcc') else 'gcc'
        subprocess.run([cc, '-O0', '-ffp-contract=off', '-fno-fast-math', '-o', exe, cpath], check=True)
        r = subprocess.run([exe, args.check_c])
        sys.exit(r.returncode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    ap.add_argument('--replays', default=os.environ.get('REPLAY_DIR', DEFAULT_REPLAYS))
    ap.add_argument('--seed', type=int, default=20260920)
    ap.add_argument('--main-js', default=os.path.join(ROOT, 'main.js'))
    ap.add_argument('--worker-c', default=os.path.join(ROOT, 'replay_worker.c'))
    ap.add_argument('--export-gaps')
    ap.add_argument('--check-c')
    args = ap.parse_args()
    if args.export_gaps:
        export_gaps(load_real(args.replays), args.export_gaps)
    elif args.check_c:
        check_c(args)
    else:
        gen(args)


if __name__ == '__main__':
    main()

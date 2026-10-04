#!/usr/bin/env python3
"""Dev-time oracle for sqlite_header (Python 3 + its sqlite3 module only).

  oracle.py gen   <cases.txt> <n> [seed]   write n mutation cases, check them against SQLite (slow, dev time)
  oracle.py check <cases.txt> [sample]     re-derive the reference result of every committed case and re-run
                                           a deterministic sample of them through real SQLite (about 1-2 s)
  oracle.py sweep                          every value of every one of the 100 header bytes, on three bases, through
                                           real SQLite (dev time, about 30 s)
  oracle.py real  <replays-dir> <out.txt>  header bytes + file size of every real replay (no payload is read
                                           beyond the first 100 bytes)

Three independent things are compared:
  * `reference()`  below: the header rules written straight from the SQLite file-format document;
  * the Ada validator (tests/test_sqlite_header.adb replays every case line and compares);
  * SQLite itself (sqlite3.connect + `select count(*) from sqlite_master` on the mutated file).

Relation to SQLite (see README, "SQLite is more lenient"): only these directions can be demanded.
  R1  a case whose error condition is one that SQLite rejects (`must_reject`) must fail in SQLite;
  R2  a case the validator accepts must open in SQLite, unless the header geometry no longer describes the
      database (fewer pages claimed than the db uses, another page size, another text encoding), which only
      SQLite's schema/b-tree layer can notice.
"""
import os, random, struct, sys, sqlite3, hashlib, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SHM = "/dev/shm" if os.path.isdir("/dev/shm") else "/tmp"
WORK = os.path.join(SHM, "sqlite_header_oracle_%d" % os.getpid())

MAGIC = b"SQLite format 3\x00"
KINDS = ["Too_Short", "Bad_Magic", "Bad_Page_Size", "Bad_Version", "Bad_Payload_Fractions",
         "Bad_Schema_Format", "Bad_Text_Encoding", "Truncated", "Zero_Pages", "Size_Not_Page_Multiple"]
ENC_NAMES = {1: "UTF_8", 2: "UTF_16LE", 3: "UTF_16BE"}


def u32(h, o):
    return struct.unpack(">I", h[o:o + 4])[0]


def reference(h, length, size):
    """Header rules, straight from https://www.sqlite.org/fileformat.html.  Returns ('ERR', kind) or
    ('OK', page_size, page_count, encoding_name, wal)."""
    if length < 100 or size < 100:
        return ("ERR", "Too_Short")
    if h[:16] != MAGIC:
        return ("ERR", "Bad_Magic")
    raw = struct.unpack(">H", h[16:18])[0]
    ps = 65536 if raw == 1 else raw
    if not (512 <= ps <= 65536 and (ps & (ps - 1)) == 0) or ps - h[20] < 480:
        return ("ERR", "Bad_Page_Size")
    if h[18] not in (1, 2) or h[19] not in (1, 2):
        return ("ERR", "Bad_Version")
    if (h[21], h[22], h[23]) != (64, 32, 32):
        return ("ERR", "Bad_Payload_Fractions")
    if not 1 <= u32(h, 44) <= 4:
        return ("ERR", "Bad_Schema_Format")
    enc = u32(h, 56)
    if not 1 <= enc <= 3:
        return ("ERR", "Bad_Text_Encoding")
    in_header = u32(h, 28)
    trusted = in_header > 0 and u32(h, 24) == u32(h, 92)
    present = size // ps
    claimed = in_header if trusted else present
    if claimed > present:
        return ("ERR", "Truncated")
    if claimed == 0:
        return ("ERR", "Zero_Pages")
    if size % ps:
        return ("ERR", "Size_Not_Page_Multiple")
    return ("OK", ps, claimed, ENC_NAMES[enc], h[19] == 2)


def fmt_result(r):
    return r[1] if r[0] == "ERR" else "OK:%d:%d:%s:%d" % (r[1], r[2], r[3], 1 if r[4] else 0)


def must_reject(h, size, kind):
    """True when SQLite itself is bound to reject a file with this header and size, whatever the rest."""
    if kind == "Too_Short":
        return 2 <= size < 100             # a 0- or 1-byte file is an empty database for SQLite
    if kind in ("Bad_Magic", "Bad_Page_Size", "Bad_Payload_Fractions"):
        return size >= 2
    if kind == "Bad_Version":
        return h[19] > 2                   # read version > 2: "cannot be read"; the rest SQLite tolerates
    if kind == "Bad_Schema_Format":
        return (u32(h, 44) & 0xFF) > 4     # SQLite keeps only the low byte of the field, and 0 counts as 1
    if kind == "Truncated":
        raw = struct.unpack(">H", h[16:18])[0]
        ps = 65536 if raw == 1 else raw
        return u32(h, 28) > -(-size // ps)  # SQLite counts a partial last page as a page
    return False                            # Bad_Text_Encoding, Zero_Pages, Size_Not_Page_Multiple


# ---------------------------------------------------------------------------------------------
# SQLite side
# ---------------------------------------------------------------------------------------------

def sqlite_opens(data):
    os.makedirs(WORK, exist_ok=True)
    p = os.path.join(WORK, "m.db")
    with open(p, "wb") as f:
        f.write(data)
    for ext in ("-journal", "-wal", "-shm"):
        try:
            os.remove(p + ext)
        except OSError:
            pass
    try:
        c = sqlite3.connect(p)
        c.execute("select count(*) from sqlite_master").fetchall()
        c.close()
        return True
    except sqlite3.Error:
        return False


ENC_PRAGMA = {1: "UTF-8", 2: "UTF-16le", 3: "UTF-16be"}


def make_synthetic(ps, enc, rows):
    os.makedirs(WORK, exist_ok=True)
    p = os.path.join(WORK, "base.db")
    if os.path.exists(p):
        os.remove(p)
    c = sqlite3.connect(p)
    c.execute("pragma encoding='%s'" % ENC_PRAGMA[enc])
    c.execute("pragma page_size=%d" % ps)
    c.execute("pragma auto_vacuum=full")
    c.execute("create table t(a integer primary key, b text, c integer)")
    c.execute("create table u(x text, y blob)")
    c.execute("create index ti on t(c)")
    for i in range(rows):
        c.execute("insert into t(b,c) values (?,?)", ("row %d " % i + "x" * (ps // 3), i * 7919 % 1000))
        c.execute("insert into u values (?,?)", ("u%d" % i, bytes(range(256)) * (ps // 512)))
    c.commit()
    c.close()
    with open(p, "rb") as f:
        return f.read()


class Base:
    def __init__(self, bid, data, real=False):
        self.id, self.data, self.real = bid, data, real
        self.header = bytes(data[:100])
        raw = struct.unpack(">H", self.header[16:18])[0]
        self.ps = 65536 if raw == 1 else raw
        self.pages = len(data) // self.ps
        self.enc = u32(self.header, 56)
        assert len(data) % self.ps == 0 and u32(self.header, 28) == self.pages


SYNTH = [(512, 1, 40), (512, 2, 30), (1024, 3, 30), (1024, 1, 40), (2048, 1, 30), (4096, 1, 30),
         (4096, 2, 20), (4096, 3, 20), (8192, 1, 12), (16384, 1, 6), (32768, 1, 4), (65536, 1, 3)]
SYNTH_WEIGHT = [6, 3, 3, 6, 4, 8, 2, 2, 3, 2, 1, 1]      # big pages cost more to write: pick them less often


def synthetic_bases():
    return [Base("S%d" % i, make_synthetic(*spec)) for i, spec in enumerate(SYNTH)]


def real_small_bases(replays):
    out = []
    if not replays or not os.path.isdir(replays):
        return out
    files = sorted((os.path.getsize(os.path.join(replays, f)), f) for f in os.listdir(replays) if f.endswith(".sqlite"))
    seen = set()
    for sz, f in files:
        if sz <= 400000 and sz not in seen:
            seen.add(sz)
            with open(os.path.join(replays, f), "rb") as fh:
                out.append(Base("R%d" % len(out), fh.read(), real=True))
    return out


# ---------------------------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------------------------
OFFSET_FIELDS = [(0, 1), (16, 2), (18, 1), (19, 1), (20, 1), (21, 1), (22, 1), (23, 1), (24, 4), (28, 4),
                 (44, 4), (56, 4), (92, 4)]
BORING = [(i, 1) for i in range(24, 100) if not (24 <= i < 32 or 44 <= i < 48 or 56 <= i < 60 or 92 <= i < 96)]
INTERESTING_BYTES = [0, 1, 2, 3, 4, 5, 31, 32, 33, 63, 64, 65, 255]


def set_bytes(h, off, bs):
    h[off:off + len(bs)] = bs


def mutate_header(rng, base):
    """Returns the list of (offset, bytes) edits of one case."""
    h = bytearray(base.header)
    edits = []

    def put(off, bs):
        bs = bytes(bs)
        edits.append((off, bs))
        set_bytes(h, off, bs)

    for _ in range(rng.choice([1, 1, 1, 2, 2, 3])):
        k = rng.random()
        if k < 0.18:                                    # random byte anywhere in the header
            o = rng.randrange(100)
            put(o, [rng.choice(INTERESTING_BYTES) if rng.random() < 0.5 else rng.randrange(256)])
        elif k < 0.26:                                  # bit flip
            o = rng.randrange(100)
            put(o, [h[o] ^ (1 << rng.randrange(8))])
        elif k < 0.34:                                  # page size field
            r = rng.random()
            if r < 0.4:
                v = rng.choice([1, 512, 1024, 2048, 4096, 8192, 16384, 32768])
            elif r < 0.7:
                v = rng.choice([0, 2, 256, 511, 513, 3000, 4095, 4097, 65535, 0x8001, 0x0100])
            else:
                v = rng.randrange(65536)
            put(16, struct.pack(">H", v))
        elif k < 0.40:                                  # reserved bytes per page
            put(20, [rng.choice([0, 1, 31, 32, 33, 34, 64, 255, rng.randrange(256)])])
        elif k < 0.46:                                  # version bytes
            put(rng.choice([18, 19]), [rng.choice([0, 1, 2, 3, 4, 255, rng.randrange(256)])])
        elif k < 0.51:                                  # payload fractions
            put(rng.choice([21, 22, 23]), [rng.choice([0, 31, 32, 33, 63, 64, 65, rng.randrange(256)])])
        elif k < 0.58:                                  # schema format
            put(44, struct.pack(">I", rng.choice([0, 1, 2, 3, 4, 5, 6, 255, 256, 2 ** 32 - 1, rng.randrange(2 ** 32)])))
        elif k < 0.66:                                  # text encoding
            put(56, struct.pack(">I", rng.choice([0, 1, 2, 3, 4, 5, 6, 7, 8, 2 ** 32 - 1, rng.randrange(2 ** 32)])))
        elif k < 0.80:                                  # page counts and the counter pair
            n = base.pages
            r = rng.random()
            if r < 0.55:
                put(28, struct.pack(">I", rng.choice([0, 1, 2, n - 1, n, n, n + 1, n + 2, n * 2, 2 ** 31, 2 ** 32 - 1,
                                                      rng.randrange(2 * n + 3), rng.randrange(2 ** 32)])))
            elif r < 0.75:                              # make the in-header count stale (counter != valid-for)
                put(92, struct.pack(">I", rng.randrange(2 ** 32)))
            elif r < 0.9:
                put(24, struct.pack(">I", rng.randrange(2 ** 32)))
            else:                                       # counter pair consistent but changed
                v = struct.pack(">I", rng.randrange(2 ** 32))
                put(24, v)
                put(92, v)
        elif k < 0.88:                                  # fields SQLite and the validator both ignore
            o, n = rng.choice(BORING)
            put(o, [rng.randrange(256) for _ in range(n)])
        elif k < 0.94:                                  # magic
            put(rng.randrange(16), [rng.randrange(256)])
        else:                                           # whole 4-byte word anywhere
            o = rng.randrange(97)
            put(o, struct.pack(">I", rng.randrange(2 ** 32)))
    return edits


def mutate_size(rng, base):
    """New file size (None = unchanged)."""
    n, ps, size = base.pages, base.ps, len(base.data)
    r = rng.random()
    if r < 0.60:
        return size
    if r < 0.70:
        return ps * rng.randrange(0, n + 1)                      # whole-page truncation
    if r < 0.80:
        return max(0, ps * rng.randrange(1, n + 1) - rng.randrange(1, ps))   # cut inside a page
    if r < 0.86:
        return rng.randrange(0, min(size, 400))                  # tiny
    if r < 0.90:
        return rng.randrange(0, size + 1)
    if r < 0.96:
        return size + ps * rng.randrange(1, 4)                   # whole pages appended (zeros)
    return size + rng.randrange(1, ps)                           # partial page appended


def apply_case(base, edits, size):
    data = bytearray(base.data)
    for off, bs in edits:
        data[off:off + len(bs)] = bs
    if size <= len(data):
        return bytes(data[:size])
    return bytes(data) + b"\x00" * (size - len(data))


def case_line(base, edits, size, length, expected, sqlite_ok):
    e = ",".join("%d=%s" % (o, bs.hex()) for o, bs in edits) or "-"
    return "C %s %s %d %d %s %s" % (base.id, e, size, length, fmt_result(expected),
                                    "-" if sqlite_ok is None else ("1" if sqlite_ok else "0"))


def parse_edits(s):
    if s == "-":
        return []
    return [(int(p.split("=")[0]), bytes.fromhex(p.split("=")[1])) for p in s.split(",")]


# ---------------------------------------------------------------------------------------------
# Relation check
# ---------------------------------------------------------------------------------------------

def explained_accept_failure(base, h, size, res):
    """Validator says Ok but SQLite fails: geometry of the header no longer matches the content."""
    ps, claimed, enc = res[1], res[2], res[3]
    return claimed < base.pages or ps != base.ps or enc != ENC_NAMES[base.enc]


class Stats:
    def __init__(self):
        self.n = 0
        self.verdict = collections.Counter()          # (validator kind or OK, sqlite ok?)
        self.must_reject_checked = collections.Counter()
        self.lenient = collections.Counter()          # validator error, SQLite opened it
        self.explained = collections.Counter()
        self.violations = []

    def record(self, base, h, size, length, res, sqlite_ok, line):
        self.n += 1
        key = res[1] if res[0] == "ERR" else "OK"
        self.verdict[(key, sqlite_ok)] += 1
        if res[0] == "ERR":
            if length < 100:
                return                                 # caller gave fewer bytes: not a property of the file
            if must_reject(h, size, key):
                self.must_reject_checked[key] += 1
                if sqlite_ok:
                    self.violations.append(("R1", line))
            elif sqlite_ok:
                self.lenient[key] += 1
        else:
            if not sqlite_ok:
                if explained_accept_failure(base, h, size, res):
                    self.explained["geometry changed"] += 1
                else:
                    self.violations.append(("R2", line))

    def report(self):
        print("cases:", self.n)
        print("%-24s %8s %8s" % ("validator", "sqlite ok", "sqlite fails"))
        for k in ["OK"] + KINDS:
            a, b = self.verdict[(k, True)], self.verdict[(k, False)]
            if a or b:
                print("%-24s %8d %8d" % (k, a, b))
        print("R1 (must-reject conditions that SQLite really rejected):", dict(self.must_reject_checked))
        print("validator stricter than SQLite (error kind: cases SQLite opened anyway):", dict(self.lenient))
        print("validator Ok, SQLite fails, explained by changed geometry:", dict(self.explained))
        print("VIOLATIONS:", len(self.violations))
        for v in self.violations[:10]:
            print("  ", v)


def real_headers(replays, out):
    lines = ["# real replay headers: first 100 bytes (hex) and file size; expected Ok"]
    for f in sorted(os.listdir(replays)):
        if f.endswith(".sqlite"):
            p = os.path.join(replays, f)
            with open(p, "rb") as fh:
                head = fh.read(100)
            res = reference(head, len(head), os.path.getsize(p))
            assert res[0] == "OK", (f, res)
            lines.append("H %s %d %s" % (head.hex(), os.path.getsize(p), fmt_result(res)))
    with open(out, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print("wrote", len(lines) - 1, "real headers to", out)


# ---------------------------------------------------------------------------------------------
def gen(out, n, seed, replays):
    rng = random.Random(seed)
    sb = synthetic_bases()
    rb = real_small_bases(replays)
    allb = sb + rb
    by_id = {b.id: b for b in allb}
    st = Stats()
    body = []
    for i in range(n):
        # real small files: ~7% of cases; synthetic: weighted by write cost
        if rb and rng.random() < 0.07:
            base = rng.choice(rb)
        else:
            base = rng.choices(sb, SYNTH_WEIGHT)[0]
        edits = mutate_header(rng, base) if rng.random() < 0.92 else []
        size = mutate_size(rng, base)
        data = apply_case(base, edits, size)
        # the Ada caller may give fewer than 100 bytes: model that in ~2% of cases
        length = 100 if rng.random() > 0.02 else rng.randrange(100)
        h = data[:100].ljust(100, b"\x00")
        res = reference(h, length, size)
        ok = sqlite_opens(data)
        line = case_line(base, edits, size, length, res, ok)
        st.record(base, h, size, length, res, ok, line)
        body.append(line)
    st.report()
    head = ["# sqlite_header oracle cases (generated by tests/oracle.py gen; seed %d). Only structure: header bytes and sizes." % seed,
            "# B <id> <header hex> <base file size>",
            "# C <base> <edits off=hex,..> <file size> <bytes given> <expected> <sqlite opened it: 1/0>"]
    for b in sb:
        head.append("B %s %s %d" % (b.id, b.header.hex(), len(b.data)))
    for b in rb:
        head.append("B %s %s %d" % (b.id, b.header.hex(), len(b.data)))
    with open(out, "w") as fh:
        fh.write("\n".join(head + body) + "\n")
    if st.violations:
        sys.exit(1)


def sweep():
    st = Stats()
    for base in synthetic_bases():
        if base.id not in ("S0", "S3", "S5", "S7", "S11"):      # 512 / 1024 / 4096 / 4096 UTF-16 / 65536
            continue
        for off in range(100):
            for v in range(256):
                data = bytearray(base.data)
                data[off] = v
                data = bytes(data)
                h = data[:100]
                res = reference(h, 100, len(data))
                st.record(base, h, len(data), 100, res, sqlite_opens(data), "%s %d=%02x" % (base.id, off, v))
    st.report()
    sys.exit(1 if st.violations else 0)


def load_cases(path):
    bases, cases = {}, []
    for ln in open(path):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        p = ln.split()
        if p[0] == "B":
            bases[p[1]] = (bytes.fromhex(p[2]), int(p[3]))
        elif p[0] == "C":
            cases.append(p)
    return bases, cases


def check(path, sample, replays):
    bases, cases = load_cases(path)
    sb = {b.id: b for b in synthetic_bases()}
    for bid, b in sb.items():                         # the generated bases must still be the committed ones
        assert b.header[16:24] == bases[bid][0][16:24] and len(b.data) == bases[bid][1], "base %s changed" % bid
    st = Stats()
    bad = 0
    pick = set(range(0, len(cases), max(1, len(cases) // sample))) if sample else set()
    for i, p in enumerate(cases):
        _, bid, e, size, length, exp, sq = p
        size, length = int(size), int(length)
        hb, fsize = bases[bid]
        h = bytearray(hb)
        edits = parse_edits(e)
        for off, bs in edits:
            h[off:off + len(bs)] = bs
        # headers beyond the file size are not part of the file
        res = reference(bytes(h), length, size)
        if fmt_result(res) != exp:
            bad += 1
            print("REFERENCE MISMATCH", " ".join(p), fmt_result(res))
        if i in pick and bid in sb:
            base = sb[bid]
            base_c = Base(base.id, base.data)
            data = apply_case(base_c, edits, size)
            ok = sqlite_opens(data)
            if ("1" if ok else "0") != sq:
                bad += 1
                print("SQLITE MISMATCH", " ".join(p), ok)
            st.record(base_c, bytes(data[:100]).ljust(100, b"\x00"), size, length, res, ok, " ".join(p))
    print("reference re-derived for %d cases; SQLite re-run on %d cases; relation violations: %d; mismatches: %d"
          % (len(cases), st.n, len(st.violations), bad))
    for v in st.violations[:5]:
        print("  ", v)
    sys.exit(1 if bad or st.violations else 0)


if __name__ == "__main__":
    a = sys.argv
    default_replays = os.environ.get("REPLAYS", "/tmp/claude-0/-home-user-WarbandReplayer/7d5d330f-4ddd-581f-b95d-49a16472cab6/scratchpad/data/replays")
    try:
        if a[1] == "gen":
            gen(a[2], int(a[3]), int(a[4]) if len(a) > 4 else 1, default_replays)
        elif a[1] == "check":
            check(a[2], int(a[3]) if len(a) > 3 else 1500, default_replays)
        elif a[1] == "sweep":
            sweep()
        elif a[1] == "real":
            real_headers(a[2], a[3])
        else:
            raise SystemExit(__doc__)
    finally:
        import shutil
        shutil.rmtree(WORK, ignore_errors=True)

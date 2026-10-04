#!/usr/bin/env python3
"""Oracle and case generator for the recorder_schema unit (dev-time only; real data is never copied).

    gen_cases.py affinity  OUT [N]        random declared types; expected affinity = SQLite's OWN resolution
    gen_cases.py mutations OUT [N] [SEED] schema mutations; expected result = independent Python reference
    gen_cases.py real      OUT [DIR]      PRAGMA table_info of every real replay (all must be Ok); falls back to
                                          the committed fixture real_schema_cases.txt when DIR is absent
    gen_cases.py recorder  DUMP           compare `test_recorder_schema dump` output with the CREATE TABLEs of
                                          lua/main.lua executed by SQLite itself
    gen_cases.py selfcheck                Python affinity rules vs SQLite vs a port of sqlite3AffinityType

Case file lines (all names / types are hex, '-' = empty; lengths are the TRUE lengths):
    A <type-hex> <I|T|B|R|N>                       affinity case
    S <table_count> <stored tables>                schema case ...
    T <name_len> <name-hex> <col_count> <stored cols>
    C <name_len> <name-hex> <type_len> <type-hex>
    E <O|M|L> <9 chars 0/1 = Missing_Table> <61 chars . M W = column fault>
"""
import glob
import os
import random
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN_LUA = os.path.join(HERE, "..", "..", "..", "..", "lua", "main.lua")
DEFAULT_REPLAYS = "/tmp/claude-0/-home-user-WarbandReplayer/7d5d330f-4ddd-581f-b95d-49a16472cab6/scratchpad/data/replays"
MAX_TABLES, MAX_COLUMNS, MAX_TEXT = 256, 64, 64

# --------------------------------------------------------------------------------------------
# the recorder's own schema, by running its own DDL through SQLite
# --------------------------------------------------------------------------------------------


def recorder_tables():
    """[(table, [(column, declared type)])] in DDL order, from lua/main.lua (CREATE TABLEs run by SQLite)."""
    src = open(MAIN_LUA, encoding="utf-8").read()
    blocks = [b for b in re.findall(r"db:exec\[\[(.*?)\]\]", src, re.S) if "CREATE TABLE" in b]
    assert blocks, "no CREATE TABLE block found in lua/main.lua"
    con = sqlite3.connect(":memory:")
    for b in blocks:
        con.executescript(b)
    out = []
    for (name,) in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by rowid").fetchall():
        out.append((name, [(r[1], r[2]) for r in con.execute('PRAGMA table_info("%s")' % name)]))
    return out


REQ = recorder_tables()
REQ_TABLES = [t for t, _ in REQ]
REQ_COLUMNS = [(t, c, ty) for t, cols in REQ for c, ty in cols]
assert len(REQ_TABLES) == 9 and len(REQ_COLUMNS) == 61, (len(REQ_TABLES), len(REQ_COLUMNS))

# --------------------------------------------------------------------------------------------
# affinity: the documented rules, SQLite's C algorithm (ported), and SQLite itself
# --------------------------------------------------------------------------------------------


def affinity_ref(t: bytes) -> str:
    """Section 3.1 of https://www.sqlite.org/datatype3.html, bytes, ASCII case folding only."""
    s = t.lower()
    if b"int" in s:
        return "I"
    if b"char" in s or b"clob" in s or b"text" in s:
        return "T"
    if len(s) == 0 or b"blob" in s:
        return "B"
    if b"real" in s or b"floa" in s or b"doub" in s:
        return "R"
    return "N"


def affinity_c_port(t: bytes) -> str:
    """sqlite3AffinityType (build.c) transliterated; '' -> BLOB as sqlite3AddColumn decides."""
    if not t:
        return "B"
    h, aff = 0, "N"
    for ch in t:
        if ch == 0:
            break
        c = ch + 32 if 65 <= ch <= 90 else ch
        h = ((h << 8) + c) & 0xFFFFFFFF
        if h == 0x63686172 or h == 0x636C6F62 or h == 0x74657874:  # char clob text
            aff = "T"
        elif h == 0x626C6F62 and aff in "NR":  # blob
            aff = "B"
        elif h == 0x7265616C and aff == "N":  # real
            aff = "R"
        elif h == 0x666C6F61 and aff == "N":  # floa
            aff = "R"
        elif h == 0x646F7562 and aff == "N":  # doub
            aff = "R"
        elif (h & 0xFFFFFF) == 0x696E74:  # int
            aff = "I"
            break
    return aff


VOCAB = ["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT", "UNSIGNED", "BIG", "INT2", "INT8",
         "CHARACTER", "VARCHAR", "NCHAR", "NATIVE", "VARYING", "CLOB", "TEXT", "BLOB", "REAL", "DOUBLE",
         "PRECISION", "FLOAT", "FLOA", "DOUB", "NUMERIC", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "POINT",
         "INTERVAL", "PRINT", "STRING", "CHARINT", "TEXTBLOB", "BLOBTEXT", "REALBLOB", "BLOBREAL", "FLOATING",
         "DOUBLEINT", "TIMESTAMP", "JSON", "UUID", "MONEY", "ANY", "OBJECT", "BYTES", "CHA", "TEX", "BLO",
         "REA", "IN", "NT", "CLO", "RE", "AL", "XTEXT", "CHAR", "CLOBBER"]
RESERVED = {"NOT", "NULL", "DEFAULT", "PRIMARY", "UNIQUE", "CHECK", "REFERENCES", "COLLATE", "CONSTRAINT",
            "GENERATED", "AS", "ON", "KEY"}


def rand_type_text(rng):
    toks = []
    for _ in range(rng.choice([1, 1, 1, 2, 2, 3, 4])):
        r = rng.random()
        if r < 0.65:
            tok = rng.choice(VOCAB)
        elif r < 0.85:
            tok = "".join(rng.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(rng.randint(1, 10)))
        else:
            a, b = rng.choice(VOCAB), rng.choice(VOCAB)
            tok = a + b
        tok = "".join(ch.upper() if rng.random() < 0.3 else ch.lower() for ch in tok) if rng.random() < 0.7 else tok
        toks.append(tok)
    s = " ".join(toks)
    r = rng.random()
    if r < 0.1:
        s += "(%d)" % rng.randint(1, 255)
    elif r < 0.15:
        s += "(%d,%d)" % (rng.randint(1, 30), rng.randint(0, 9))
    return s


def sqlite_affinity(type_text):
    """Affinity SQLite itself gives a column declared `type_text`; returns (reported type, class) or None if
    SQLite rejects it.  Probes: typeof of an inserted text '1' and integer 1 (TEXT/REAL/BLOB/INTEGER-or-NUMERIC),
    CAST('3.5' AS type) separates INTEGER from NUMERIC.  The reported type is what PRAGMA table_info returns."""
    con = sqlite3.connect(":memory:")
    try:
        con.execute("CREATE TABLE t(c %s)" % type_text)
    except sqlite3.Error:
        return None
    reported = con.execute("PRAGMA table_info(t)").fetchall()[0][2]
    con.execute("INSERT INTO t VALUES ('1')")
    con.execute("INSERT INTO t VALUES (1)")
    a, b = [r[0] for r in con.execute("SELECT typeof(c) FROM t ORDER BY rowid")]
    if (a, b) == ("text", "text"):
        cls = "T"
    elif (a, b) == ("real", "real"):
        cls = "R"
    elif (a, b) == ("text", "integer"):
        cls = "B"
    elif (a, b) == ("integer", "integer"):
        try:
            cast = con.execute("SELECT typeof(CAST('3.5' AS %s))" % reported).fetchone()[0]
        except sqlite3.Error:
            return None
        cls = "I" if cast == "integer" else "N"
        assert cast in ("integer", "real"), (type_text, cast)
    else:
        raise AssertionError((type_text, a, b))
    con.close()
    return reported, cls


def hx(b: bytes) -> str:
    return b.hex() if b else "-"


def gen_affinity(out, n=2600, seed=20260104):
    rng = random.Random(seed)
    cases, seen = [], set()
    cases.append("")  # the empty declared type ('' -> BLOB), straight from `CREATE TABLE t(c)`
    while len(cases) < n:
        r = sqlite_affinity(rand_type_text(rng))
        if r is None:
            continue
        cases.append(r[0])
        seen.add(r[0])
    # the fixed ones every reader expects
    for fixed in ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", "VARCHAR(20)", "DOUBLE PRECISION", "UNSIGNED BIG INT",
                  "NATIVE CHARACTER(70)", "FLOATING POINT", "DECIMAL(10,5)", "BOOLEAN", "DATETIME", "POINT", "int",
                  "Integer", "tExT"]:
        if fixed not in cases:
            cases.append(fixed)
    classes = {}
    with open(out, "w") as f:
        for t in cases:
            r = sqlite_affinity(t) if t else ("", "B")
            assert r is not None, t
            rep, cls = r
            tb = rep.encode()
            assert affinity_ref(tb) == cls, ("python rules vs SQLite", rep, affinity_ref(tb), cls)
            assert affinity_c_port(tb) == cls, ("C port vs SQLite", rep, affinity_c_port(tb), cls)
            classes[cls] = classes.get(cls, 0) + 1
            f.write("A %s %s\n" % (hx(tb), cls))
    print("affinity cases: %d  per class %s  (every case: SQLite == documented rules == C port)" % (len(cases), classes))


def selfcheck():
    rng = random.Random(7)
    alphabet = b"INTintCHARclobTEXTBLOBREALFLOADOUBxX ()_9\x00\xe2\x84\xaa\xff"
    n = 0
    for _ in range(300000):
        s = bytes(rng.choice(alphabet) for _ in range(rng.randint(0, 14)))
        if b"\x00" in s:  # C stops at NUL; the documented rules treat NUL as an ordinary byte (see README)
            continue
        assert affinity_ref(s) == affinity_c_port(s), s
        n += 1
    print("selfcheck: %d random byte strings, documented rules == sqlite3AffinityType port" % n)


# --------------------------------------------------------------------------------------------
# reference semantics of Check (independent of the Ada code)
# --------------------------------------------------------------------------------------------
# A text is (true_length, first-<=64-bytes).  A schema is
#   {"count": true table count, "tables": [stored tables]}, table = {"name": text, "ncols": true count, "cols": [stored], }
# column = {"name": text, "type": text}


def tx(b: bytes):
    return (len(b), b[:MAX_TEXT])


def same_name(t, req: bytes):
    return t[0] == len(req) and t[0] <= MAX_TEXT and t[1][: t[0]].lower() == req.lower()


def within_limits(d):
    if d["count"] > MAX_TABLES:
        return False
    for t in d["tables"]:
        if t["name"][0] > MAX_TEXT or t["ncols"] > MAX_COLUMNS:
            return False
        for c in t["cols"]:
            if c["name"][0] > MAX_TEXT or c["type"][0] > MAX_TEXT:
                return False
    return True


def check_ref(d):
    if not within_limits(d):
        return "L", "0" * 9, "." * 61
    missing, faults = [], []
    first = {}
    for tname in REQ_TABLES:
        idx = next((i for i, t in enumerate(d["tables"]) if same_name(t["name"], tname.encode())), None)
        first[tname] = idx
        missing.append("1" if idx is None else "0")
    for (tname, cname, ctype) in REQ_COLUMNS:
        idx = first[tname]
        if idx is None:
            faults.append(".")
            continue
        cols = [c for c in d["tables"][idx]["cols"] if same_name(c["name"], cname.encode())]
        want = affinity_ref(ctype.encode())
        if not cols:
            faults.append("M")
        elif any(affinity_ref(c["type"][1][: c["type"][0]]) == want for c in cols):
            faults.append(".")
        else:
            faults.append("W")
    status = "O" if all(m == "0" for m in missing) and all(f == "." for f in faults) else "M"
    return status, "".join(missing), "".join(faults)


def write_case(f, d):
    st, mt, cf = check_ref(d)
    f.write("S %d %d\n" % (d["count"], len(d["tables"])))
    for t in d["tables"]:
        f.write("T %d %s %d %d\n" % (t["name"][0], hx(t["name"][1]), t["ncols"], len(t["cols"])))
        for c in t["cols"]:
            f.write("C %d %s %d %s\n" % (c["name"][0], hx(c["name"][1]), c["type"][0], hx(c["type"][1])))
    f.write("E %s %s %s\n" % (st, mt, cf))
    return st


def table(name: bytes, cols):
    return {"name": tx(name), "cols": [{"name": tx(n), "type": tx(ty)} for n, ty in cols], "ncols": None}


def finalize(d, rng=None):
    """make stored lists consistent with the true counts: stored = first Max entries, counts = logical sizes
    (unless an override > the stored size was requested, in which case the lists are padded to the bound)."""
    tabs = d["tables"]
    count = d.get("count_override") or len(tabs)
    if count > MAX_TABLES:
        while len(tabs) < MAX_TABLES:
            tabs.append(table(b"pad%d" % len(tabs), [(b"c", b"INTEGER")]))
        tabs = tabs[:MAX_TABLES]
    else:
        count = len(tabs)
    for t in tabs:
        n = t.get("ncols_override") or len(t["cols"])
        if n > MAX_COLUMNS:
            while len(t["cols"]) < MAX_COLUMNS:
                t["cols"].append({"name": tx(b"padcol%d" % len(t["cols"])), "type": tx(b"INTEGER")})
            t["cols"] = t["cols"][:MAX_COLUMNS]
        else:
            n = len(t["cols"])
        t["ncols"] = n
    return {"count": count, "tables": tabs}


# --------------------------------------------------------------------------------------------
# mutations
# --------------------------------------------------------------------------------------------

TYPES = [b"INTEGER", b"INT", b"integer", b"BIGINT", b"UNSIGNED BIG INT", b"INTEGER(10)", b"TEXT", b"text", b"VARCHAR(20)",
         b"CLOB", b"NCHAR(55)", b"REAL", b"real", b"DOUBLE", b"DOUBLE PRECISION", b"FLOAT", b"FLOATING POINT", b"BLOB",
         b"", b"NUMERIC", b"DECIMAL(10,5)", b"BOOLEAN", b"DATE", b"DATETIME", b"POINT", b"CHARINT", b"TEXTBLOB",
         b"BLOBTEXT", b"REALBLOB", b"\xef\xbc\xa9\xef\xbc\xae\xef\xbc\xb4", b"IN\x00T", b"INT\x00", b" ", b"X" * 70,
         b"A" * 200 + b"INT"]
LOOKALIKE = {b"k": b"\xe2\x84\xaa", b"i": b"\xc4\xb1", b"s": b"\xc5\xbf", b"t": b"\xc5\xa7", b"e": b"\xc3\xa9"}
BIG_LENGTHS = [65, 66, 100, 1000, 10**6, 2**31 - 1, 2**31, 2**32, 2**62, 2**63 - 1]


def rand_name(rng):
    base = rng.choice(["x", "extra", "idx", "Notes", "a b", "", "é", "col", "sqlite_stat1", "T0"])
    return (base + str(rng.randint(0, 99))).encode() if rng.random() < 0.7 else base.encode()


def mut_text(rng, b: bytes) -> bytes:
    r = rng.randrange(9)
    if r == 0:
        return b + b"x"
    if r == 1:
        return b[:-1]
    if r == 2 and b:
        i = rng.randrange(len(b))
        return b[:i] + bytes([rng.randrange(256)]) + b[i + 1:]
    if r == 3:
        return b.upper()
    if r == 4:
        return b.swapcase()
    if r == 5:
        return b"".join(bytes([c]).upper() if rng.random() < 0.5 else bytes([c]) for c in b)
    if r == 6:
        for k, v in LOOKALIKE.items():
            if k in b:
                return b.replace(k, v, 1)
        return b + b"\xe2\x84\xaa"
    if r == 7:
        return b" " + b
    return b"" if rng.random() < 0.3 else b + b"\x00"


def mutate(rng, d):
    tabs = d["tables"]
    op = rng.choices(
        ["drop_table", "drop_col", "rename_table", "rename_col", "retype", "case_all", "extra_table", "extra_col",
         "shuffle", "inflate", "overcount_t", "overcount_c", "dup_table", "dup_col", "empty", "zero_cols", "big_type"],
        weights=[6, 8, 6, 8, 12, 6, 5, 5, 4, 5, 2, 2, 3, 3, 1, 2, 3])[0]
    if op == "empty":
        tabs.clear()
        return
    if not tabs:
        tabs.append(table(rand_name(rng), [(b"c", b"INT")]))
    ti = rng.randrange(len(tabs))
    t = tabs[ti]
    if op == "drop_table":
        del tabs[ti]
    elif op == "drop_col" and t["cols"]:
        del t["cols"][rng.randrange(len(t["cols"]))]
    elif op == "rename_table":
        t["name"] = tx(mut_text(rng, t["name"][1][: t["name"][0]] if t["name"][0] <= 64 else t["name"][1]))
    elif op == "rename_col" and t["cols"]:
        c = rng.choice(t["cols"])
        c["name"] = tx(mut_text(rng, c["name"][1][: c["name"][0]] if c["name"][0] <= 64 else c["name"][1]))
    elif op == "retype" and t["cols"]:
        c = rng.choice(t["cols"])
        c["type"] = tx(rng.choice(TYPES))
    elif op == "case_all":
        f = rng.choice([bytes.upper, bytes.lower, bytes.swapcase])
        for tt in tabs:
            if tt["name"][0] <= 64:
                tt["name"] = tx(f(tt["name"][1]))
            for c in tt["cols"]:
                if c["name"][0] <= 64:
                    c["name"] = tx(f(c["name"][1]))
    elif op == "extra_table":
        tabs.insert(rng.randrange(len(tabs) + 1),
                    table(rand_name(rng), [(rand_name(rng), rng.choice(TYPES)) for _ in range(rng.randint(0, 70))]))
    elif op == "extra_col":
        for _ in range(rng.choice([1, 1, 1, 2, 70])):
            t["cols"].insert(rng.randrange(len(t["cols"]) + 1), {"name": tx(rand_name(rng)), "type": tx(rng.choice(TYPES))})
    elif op == "shuffle":
        rng.shuffle(tabs)
        for tt in tabs:
            if rng.random() < 0.5:
                rng.shuffle(tt["cols"])
    elif op == "inflate":
        n = rng.choice(BIG_LENGTHS)
        pref = bytes(rng.randrange(256) for _ in range(MAX_TEXT))
        what = rng.randrange(3)
        if what == 0:
            t["name"] = (n, pref)
        elif t["cols"]:
            c = rng.choice(t["cols"])
            c["name" if what == 1 else "type"] = (n, pref)
    elif op == "big_type" and t["cols"]:
        c = rng.choice(t["cols"])
        c["type"] = (rng.choice(BIG_LENGTHS), b"INTEGER" + b" " * 57)
    elif op == "overcount_t":
        d["count_override"] = rng.choice([MAX_TABLES + 1, 300, 10**9, 2**62, 2**63 - 1])
    elif op == "overcount_c":
        t["ncols_override"] = rng.choice([MAX_COLUMNS + 1, 65, 1000, 2**40, 2**63 - 1])
    elif op == "dup_table":
        dup = table(t["name"][1][: t["name"][0]] if t["name"][0] <= 64 else b"dup", [(rand_name(rng), rng.choice(TYPES)) for _ in range(rng.randint(0, 5))])
        if rng.random() < 0.5:
            dup["name"] = tx(mut_text(rng, dup["name"][1][: dup["name"][0]]) if rng.random() < 0.3 else dup["name"][1])
        tabs.insert(rng.randrange(len(tabs) + 1), dup)
    elif op == "dup_col" and t["cols"]:
        c = rng.choice(t["cols"])
        t["cols"].insert(rng.randrange(len(t["cols"]) + 1), {"name": c["name"], "type": tx(rng.choice(TYPES))})
    elif op == "zero_cols":
        t["cols"].clear()


def clone(d):
    return {"tables": [{"name": t["name"], "cols": [dict(c) for c in t["cols"]], "ncols": None} for t in d["tables"]]}


def base_schema():
    tabs = [table(n.encode(), [(c.encode(), ty.encode()) for c, ty in cols]) for n, cols in REQ]
    tabs.insert(1, table(b"sqlite_sequence", [(b"name", b""), (b"seq", b"")]))
    return {"tables": tabs}


def gen_mutations(out, n=6000, seed=20260104):
    rng = random.Random(seed)
    base = base_schema()
    stats = {"O": 0, "M": 0, "L": 0}
    with open(out, "w") as f:
        # hand-made boundary cases first
        crafted = []
        d = clone(base); crafted.append(d)                                   # real schema
        crafted.append({"tables": []})                                      # empty tables list
        d = clone(base); d["count_override"] = MAX_TABLES + 1; crafted.append(d)
        d = clone(base); d["count_override"] = 2**63 - 1; crafted.append(d)
        d = clone(base)                                                      # exactly 256 tables, required ones last
        d["tables"] = [table(b"pad%d" % i, [(b"c", b"INT")]) for i in range(MAX_TABLES - len(d["tables"]))] + d["tables"]
        crafted.append(d)
        d = clone(base)                                                      # 257 tables (256 stored + true 257)
        d["tables"] = [table(b"pad%d" % i, [(b"c", b"INT")]) for i in range(MAX_TABLES + 1 - len(d["tables"]))] + d["tables"]
        crafted.append(d)
        d = clone(base); d["tables"][0]["cols"] += [{"name": tx(b"e%d" % i), "type": tx(b"")} for i in range(61)]; crafted.append(d)   # 64 columns
        d = clone(base); d["tables"][0]["cols"] += [{"name": tx(b"e%d" % i), "type": tx(b"")} for i in range(62)]; crafted.append(d)   # 65 columns
        d = clone(base); d["tables"][0]["name"] = (2**63 - 1, b"x" * 64); crafted.append(d)
        d = clone(base); d["tables"][0]["cols"][0]["name"] = (65, b"x" * 64); crafted.append(d)
        d = clone(base); d["tables"][0]["cols"][0]["name"] = (64, b"x" * 64); crafted.append(d)
        d = clone(base); d["tables"][0]["cols"][0]["type"] = (65, b"INTEGER" + b" " * 57); crafted.append(d)
        d = clone(base); d["tables"][0]["cols"][0]["type"] = tx(b"INTEGER" + b" " * 57); crafted.append(d)
        d = clone(base); d["tables"][0]["cols"][1]["name"] = tx(b"TIME"); crafted.append(d)
        d = clone(base); d["tables"][0]["cols"][1]["name"] = tx(b"t\xc4\xb1me"); crafted.append(d)
        d = clone(base); d["tables"].insert(0, table(b"TICKS", [(b"id", b"TEXT")])); crafted.append(d)   # first listing wins
        d = clone(base); d["tables"].append(table(b"ticks", [(b"id", b"TEXT")])); crafted.append(d)
        for d in crafted:
            stats[write_case(f, finalize(d))] += 1
        for _ in range(n):
            d = clone(base)
            for _ in range(rng.choice([0, 1, 1, 2, 2, 3, 4, 6])):
                mutate(rng, d)
            stats[write_case(f, finalize(d))] += 1
    print("mutation cases: %d  reference outcomes %s" % (sum(stats.values()), stats))


def gen_real(out, directory=DEFAULT_REPLAYS):
    files = sorted(glob.glob(os.path.join(directory, "*.sqlite")))
    if not files:
        fixture = os.path.join(HERE, "real_schema_cases.txt")
        open(out, "w").write(open(fixture).read())
        print("real replays not found (%s): using the committed fixture real_schema_cases.txt" % directory)
        return
    distinct = {}
    with open(out, "w") as f:
        for p in files:
            con = sqlite3.connect("file:%s?mode=ro" % p, uri=True)
            tabs = []
            for (name,) in con.execute("select name from sqlite_master where type='table' order by rowid").fetchall():
                tabs.append(table(name.encode(), [(r[1].encode(), r[2].encode()) for r in con.execute('PRAGMA table_info("%s")' % name.replace('"', '""'))]))
            con.close()
            d = finalize({"tables": tabs})
            st, _, _ = check_ref(d)
            assert st == "O", "reference says %s for %s" % (st, p)
            write_case(f, d)
            key = repr([(t["name"], [(c["name"], c["type"]) for c in t["cols"]]) for t in d["tables"]])
            distinct.setdefault(key, d)
    print("real replay schemas: %d files, %d distinct schema(s), reference says Ok for all" % (len(files), len(distinct)))
    fixture = os.path.join(HERE, "real_schema_cases.txt")
    if "--write-fixture" in sys.argv:
        with open(fixture, "w") as f:
            for d in distinct.values():
                write_case(f, d)
        print("wrote", fixture)


def check_dump(path):
    """`test_recorder_schema dump` prints: <table> <column> <affinity I|T|B|R|N>, 61 lines in Column_Id order."""
    got = [tuple(l.split()) for l in open(path).read().splitlines() if l.strip()]
    want = [(t, c, affinity_ref(ty.encode())) for t, c, ty in REQ_COLUMNS]
    assert len(got) == len(want) == 61, (len(got), len(want))
    assert got == want, [(g, w) for g, w in zip(got, want) if g != w]
    print("recorder tables: Ada requirements == lua/main.lua DDL as executed by SQLite (9 tables, 61 columns, affinities)")


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "affinity":
        gen_affinity(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2600)
    elif mode == "mutations":
        gen_mutations(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6000, int(sys.argv[4]) if len(sys.argv) > 4 else 20260104)
    elif mode == "real":
        gen_real(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else DEFAULT_REPLAYS)
    elif mode == "recorder":
        check_dump(sys.argv[2])
    elif mode == "selfcheck":
        selfcheck()
    else:
        raise SystemExit(__doc__)

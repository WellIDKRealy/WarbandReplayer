#!/usr/bin/env python3
"""Proof-is-not-vacuous check: each mutation of the body must make gnatprove FAIL.

  mutation_check.py [mutation-number ...]     (default: all; each run takes minutes on a busy machine)

Works on a copy of the unit in a temp directory; the real sources are never touched.  A surviving mutant
(gnatprove still exits 0) is a hole in the contract and is reported with exit status 1.
"""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
UNIT = os.path.dirname(HERE)
PROVE = os.path.join(UNIT, "..", "..", "tools", "prove.sh")

# (description, old text, new text) applied to src/sqlite_header.adb; each `old` occurs exactly once
MUTANTS = [
    ("truncated test off by one (>= instead of >)", "if Claimed > Present then", "if Claimed >= Present then"),
    ("usable size 479 instead of 480", "+ 480 > Page", "+ 479 > Page"),
    ("wal flag reads the write version", "Wal        => Header (19) = 2", "Wal        => Header (18) = 2"),
    ("schema format upper bound 5", "Schema_Format > 4", "Schema_Format > 5"),
    ("zero pages test wrong", "if Claimed = 0 then", "if Claimed = 1 then"),
    ("multiple-of-page test wrong", "if Size mod Page /= 0 then", "if Size mod Page > 1 then"),
    ("header count trusted without the counter check", "In_Header > 0 and then Counter_Valid", "In_Header > 0"),
    ("page size field decoded with the wrong weight", "Long_Long_Integer (Header (16)) * 256", "Long_Long_Integer (Header (16)) * 255"),
    ("65536 refused as a page size", "32768 | 65536 => null", "32768 => null"),
    ("value 1 not mapped to 65536", "(if Raw_Page_Size = 1 then 65536 else Raw_Page_Size)", "Raw_Page_Size"),
    ("encoding off by one", "Text_Encoding'Val (Encoding - 1)", "Text_Encoding'Val (Encoding mod 3)"),
    ("too-short test forgets the file size", "if Length < Header_Size or else Size < Header_Size then", "if Length < Header_Size then"),
    ("precedence: payload fractions tested before version",
     "      if (Header (18) /= 1 and then Header (18) /= 2) or else (Header (19) /= 1 and then Header (19) /= 2) then\n         return Fail (Bad_Version);\n      end if;\n\n      if Header (21) /= 64 or else Header (22) /= 32 or else Header (23) /= 32 then\n         return Fail (Bad_Payload_Fractions);\n      end if;\n",
     "      if Header (21) /= 64 or else Header (22) /= 32 or else Header (23) /= 32 then\n         return Fail (Bad_Payload_Fractions);\n      end if;\n\n      if (Header (18) /= 1 and then Header (18) /= 2) or else (Header (19) /= 1 and then Header (19) /= 2) then\n         return Fail (Bad_Version);\n      end if;\n"),
    ("magic: last byte not checked", "or else Header (15) /= 16#00#", ""),
    ("write version 0 accepted", "(Header (18) /= 1 and then Header (18) /= 2)", "(Header (18) > 2)"),
]


def run(i):
    desc, old, new = MUTANTS[i]
    tmp = tempfile.mkdtemp(prefix="mutant%d_" % i, dir=os.environ.get("TMPDIR", "/tmp"))
    try:
        for d in ("src",):
            shutil.copytree(os.path.join(UNIT, d), os.path.join(tmp, d))
        shutil.copy(os.path.join(UNIT, "sqlite_header.gpr"), tmp)
        p = os.path.join(tmp, "src", "sqlite_header.adb")
        s = open(p).read()
        assert s.count(old) == 1, "pattern for mutant %d must occur exactly once" % i
        open(p, "w").write(s.replace(old, new))
        r = subprocess.run([PROVE, tmp, "--timeout=10", "--prover=cvc5,z3"], capture_output=True, text=True)
        killed = r.returncode != 0
        print("mutant %2d %-60s %s" % (i, desc, "KILLED (gnatprove fails)" if killed else "SURVIVED  <-- contract hole"), flush=True)
        return killed
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    which = [int(a) for a in sys.argv[1:]] or range(len(MUTANTS))
    results = [run(i) for i in which]
    print("%d of %d mutants killed" % (sum(results), len(results)))
    sys.exit(0 if all(results) else 1)

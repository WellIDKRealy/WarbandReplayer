#!/bin/bash
# Native differential tests for sqlite_header.  Finishes in well under 10 seconds.
#   1. fast build      : oracle cases + real files + sweeps + 5M random headers (run-time checks on)
#   2. contracts build : -gnata, so every postcondition and the ghost specification are executed (small workload)
#   3. oracle freshness: oracle.py re-derives the reference result of every committed case and re-runs a sample
#                        of them through real SQLite (python3 sqlite3 module)
#   --bench            : additionally builds the run-time-checks-suppressed configuration and prints ns/call
set -uo pipefail
cd "$(dirname "$0")"
. ../../../tools/env.sh
REPLAYS=${REPLAYS:-/tmp/claude-0/-home-user-WarbandReplayer/7d5d330f-4ddd-581f-b95d-49a16472cab6/scratchpad/data/replays}
START=$(date +%s.%N)

gprbuild -q -P tests.gpr -XMODE=fast & BF=$!
gprbuild -q -P tests.gpr -XMODE=contracts & BC=$!
RC=0
wait $BF || RC=1
wait $BC || RC=1
[ $RC -eq 0 ] || { echo "BUILD FAILED"; exit 1; }

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
./obj/fast/test_sqlite_header cases.txt real_headers.txt "$REPLAYS" > "$OUT/fast" 2>&1 & PF=$!
./obj/contracts/test_sqlite_header cases.txt real_headers.txt "$REPLAYS" small > "$OUT/contracts" 2>&1 & PC=$!
python3 oracle.py check cases.txt 1500 > "$OUT/oracle" 2>&1 & PO=$!
wait $PF || RC=1
wait $PC || RC=1
wait $PO || RC=1

echo "== fast build (full workload) =="; cat "$OUT/fast"
echo "== contracts build (-gnata: postconditions + ghost specification executed) =="; cat "$OUT/contracts"
echo "== oracle freshness (python reference + real SQLite) =="; cat "$OUT/oracle"
if [ "${1:-}" = "--bench" ]; then
  gprbuild -q -P tests.gpr -XMODE=nochecks && echo "== benchmark (run-time checks suppressed, -O2) ==" && ./obj/nochecks/bench_sqlite_header
  echo "== benchmark (run-time checks on, -O2) ==" && ./obj/fast/bench_sqlite_header
fi
END=$(date +%s.%N)
printf 'elapsed %.1f s\n' "$(echo "$END - $START" | bc -l)"
if [ $RC -eq 0 ]; then echo "ALL TESTS PASSED"; else echo "TESTS FAILED"; exit 1; fi

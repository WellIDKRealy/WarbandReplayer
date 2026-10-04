#!/bin/bash
# Native differential tests for boundary_segmentation. Finishes in well under 10 seconds.
#   1. fast build   : golden (31 real) + synthetic (2400, oracle = REAL sql through sqlite3) cases,
#                     capacity/Overflow/Invalid_Input, 64-bit magnitudes, 2M battles, exhaustive small N
#   2. contracts    : same code compiled with -gnata so every postcondition, loop invariant and the
#                     GHOST specification (the SQL-transliterating folds) are executed (small workload,
#                     the ghost specification is cubic by construction)
#   3. oracle check : re-runs the real sql/default_boundary_detection.sql on the committed cases
#                     (the committed E lines must still be what the real SQL returns)
# The three parts run concurrently; their output is printed in order.
set -uo pipefail
cd "$(dirname "$0")"
. ../../../tools/env.sh
START=$(date +%s.%N)

gprbuild -q -P tests.gpr -XMODE=fast & BF=$!
gprbuild -q -P tests.gpr -XMODE=contracts & BC=$!
RC=0
wait $BF || RC=1
wait $BC || RC=1
[ $RC -eq 0 ] || { echo "BUILD FAILED"; exit 1; }

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
./obj/fast/test_segmentation boundary_cases.txt synthetic_cases.txt > "$OUT/fast" 2>&1 & PF=$!
./obj/contracts/test_segmentation boundary_cases.txt synthetic_cases.txt small > "$OUT/contracts" 2>&1 & PC=$!
( python3 gen_cases.py --check boundary_cases.txt && python3 gen_cases.py --check synthetic_cases.txt 60 ) \
  > "$OUT/oracle" 2>&1 & PO=$!
wait $PF || RC=1
wait $PC || RC=1
wait $PO || RC=1

echo "== fast build (full workload) =="; cat "$OUT/fast"
echo "== contracts build (-gnata: contracts + ghost spec executed) =="; cat "$OUT/contracts"
echo "== oracle freshness (real SQL) =="; cat "$OUT/oracle"
END=$(date +%s.%N)
printf 'elapsed %.1f s\n' "$(echo "$END - $START" | bc -l)"
if [ $RC -eq 0 ]; then echo "ALL TESTS PASSED"; else echo "TESTS FAILED"; exit 1; fi

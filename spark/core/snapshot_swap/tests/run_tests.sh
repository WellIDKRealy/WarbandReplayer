#!/bin/bash
# Differential + exhaustive tests of snapshot_swap.  Finishes in well under 10 seconds.
#   spark/core/snapshot_swap/tests/run_tests.sh
# 1. oracle.py (naive Python model) writes its tables into a temp dir and self-checks (literal
#    enumeration of every operation sequence up to length 6: model == table).
# 2. test_swap (built without contracts: every sequence up to length 10 from two start states, the
#    whole bounded state domain, directed scenarios, a 5M-step random walk; built with -gnata:
#    the same with every contract executed, smaller workload).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../../../tools/env.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/snapshot_swap_tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$HERE"
T0=$(date +%s.%N)

gprbuild -q -P tests.gpr -XCONTRACTS=off test_swap.adb &
B1=$!
gprbuild -q -P tests.gpr -XCONTRACTS=on test_swap.adb &
B2=$!
python3 oracle.py --out "$WORK" --literal 6
wait $B1
wait $B2

bin_off/test_swap "$WORK" fast
bin_on/test_swap "$WORK" contracts

echo "ALL TESTS PASSED in $(printf '%.1f' "$(echo "$(date +%s.%N) - $T0" | bc)") s"

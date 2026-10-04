#!/bin/bash
# Differential + exhaustive tests of the tick_index unit.  Finishes in well under 10 seconds.
#   spark/core/tick_index/tests/run_tests.sh
# Oracle source: the real replays in $REPLAY_DIR (default: the owner's scratch copy) when present,
# otherwise the committed derived fixture tests/oracle/tick_gaps.txt.  Real data is never copied here.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../../../tools/env.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tick_index_tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$HERE"
T0=$(date +%s.%N)

python3 oracle.py --out "$WORK/cases.txt"
python3 oracle.py --check-c "$WORK/cases.txt"

gprbuild -q -P tests.gpr -XCONTRACTS=off
gprbuild -q -P tests.gpr -XCONTRACTS=on

bin_off/test_tick_index "$WORK/cases.txt" fast
bin_on/test_tick_index "$WORK/cases.txt" contracts

echo "ALL TESTS PASSED in $(printf '%.1f' "$(echo "$(date +%s.%N) - $T0" | bc)") s"

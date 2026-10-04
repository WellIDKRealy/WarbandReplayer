#!/bin/bash
# Differential + property tests of the camera_projection unit against the OLD main.c and main.js.
# Finishes in well under 10 seconds.   spark/core/camera_projection/tests/run_tests.sh
#   * oracle.c includes the OLD main.c unmodified (clang -O1 -ffp-contract=off) and is linked into the test;
#   * oracle_js.js evaluates the OLD main.js worldToScreen (extracted from the source text) with node.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
. "$HERE/../../../tools/env.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/camera_projection_tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$HERE"
T0=$(date +%s.%N)
SEQS_FAST=${SEQS_FAST:-200000}
SEQS_CONTRACTS=${SEQS_CONTRACTS:-20000}

mkdir -p bin_oracle
clang -O1 -ffp-contract=off -Wall -I"$ROOT" -I"$HERE/include" -c oracle.c -o bin_oracle/oracle.o
node oracle_js.js "$ROOT/main.js" 7 150000 > "$WORK/js_cases.txt"

gprbuild -q -P tests.gpr -XCONTRACTS=off -XORACLE="$HERE/bin_oracle/oracle.o"
gprbuild -q -P tests.gpr -XCONTRACTS=on  -XORACLE="$HERE/bin_oracle/oracle.o"

bin_off/test_camera_projection fast "$SEQS_FAST" "$WORK/js_cases.txt" "${1:-}"
bin_on/test_camera_projection contracts "$SEQS_CONTRACTS" "$WORK/js_cases.txt"

echo "ALL TESTS PASSED in $(printf '%.1f' "$(echo "$(date +%s.%N) - $T0" | bc)") s"

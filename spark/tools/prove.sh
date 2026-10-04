#!/bin/bash
# Usage: spark/tools/prove.sh <unit-dir> [extra gnatprove args]
# Runs gnatprove on the single *.gpr in <unit-dir> (level 4, all checks) and exits non-zero unless the
# summary reports 0 unproved checks. Prints the summary table and any non-"info" messages.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/env.sh"
UNIT="$1"; shift
cd "$UNIT" || exit 2
GPR=$(ls *.gpr 2>/dev/null | grep -v '^tests' | head -1)
[ -n "$GPR" ] || { echo "no .gpr in $UNIT"; exit 2; }
gnatprove -P "$GPR" --level=4 --report=all --timeout=60 -j1 --warnings=continue "$@" 2>&1 \
  | grep -vE ': info: ' | grep -vE '^Phase [0-9] of'
OUT=$(ls obj/*/gnatprove/gnatprove.out obj/gnatprove/gnatprove.out 2>/dev/null | head -1)
[ -n "$OUT" ] || { echo "no gnatprove.out found"; exit 2; }
sed -n '/SPARK Analysis results/,/^max steps/p' "$OUT"
# last column of the "Total" row is the Unproved count ("." means 0)
UNPROVED=$(awk '/^Total /{print $NF}' "$OUT" | tail -1)
ASSUMES=$(grep -rE 'pragma[[:space:]]+Assume' src 2>/dev/null | grep -v '^\s*--' | wc -l)
echo "UNPROVED=${UNPROVED:-?}  PRAGMA_ASSUME_LINES=$ASSUMES"
[ "$UNPROVED" = "." ] || [ "$UNPROVED" = "0" ]

#!/bin/sh
# Full acceptance round: stock-like baseline + every launcher case, then verdicts.
#   sh round.sh <outdir>
# Run it in a foreground terminal: two detached (background) runs stalled
# every launcher-case page script for minutes while foreground runs did not.
OUT=${1:-results/round}
EXE=C:/Users/AnhDuong/Downloads/FireFox/obj-sg-release/dist/bin/invifox.exe
mkdir -p "$OUT"
node run.mjs --exe $EXE --baseline 1 --out "$OUT/baseline" > "$OUT/baseline.stdout" 2>&1
for c in win-default win-noise android-default android-noise; do
  node run.mjs --exe $EXE --args-file launcher-args.json --case $c --out "$OUT/$c" > "$OUT/$c.stdout" 2>&1
done
: > "$OUT/verdicts.txt"
for c in win-default win-noise android-default android-noise; do
  echo "=== $c" >> "$OUT/verdicts.txt"
  grep "^\[site\]" "$OUT/$c.stdout" | grep -v ": ok" >> "$OUT/verdicts.txt"
  node check.mjs "$OUT/$c" --baseline "$OUT/baseline" | grep -E "FAIL|passed" >> "$OUT/verdicts.txt"
done
echo DONE >> "$OUT/verdicts.txt"

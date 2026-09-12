#!/usr/bin/env bash
# Generic headless test runner for src/lib/sim (pure TypeScript, no DOM).
#   scripts/test-sim.sh                 -> compile + run every tests/**/*.test.ts
#   scripts/test-sim.sh tests/systems   -> only that folder
#   TEST_FILTER=cpa scripts/test-sim.sh -> node --test-name-pattern
# Compiles with tsc to CommonJS into .tmp/sim (keeps the repo tsconfig untouched)
# and runs node:test. Type errors in files outside the tested modules are
# reported but do not stop the run (tsc still emits).
set -u
cd "$(dirname "$0")/.."
OUT=.tmp/sim
DIR="${1:-tests}"
rm -rf "$OUT"
mkdir -p "$OUT"
FILES=$(find "$DIR" -name '*.test.ts' | sort)
if [ -z "$FILES" ]; then echo "no *.test.ts under $DIR"; exit 1; fi
# shellcheck disable=SC2086
npx tsc --module commonjs --moduleResolution node --target es2020 --lib es2022,dom,dom.iterable \
  --outDir "$OUT" --rootDir . --skipLibCheck --esModuleInterop --strict --types node \
  --resolveJsonModule --noEmitOnError false --ignoreConfig --ignoreDeprecations 6.0 $FILES
TSC_EXIT=$?
if [ $TSC_EXIT -ne 0 ]; then echo "(tsc reported errors, exit $TSC_EXIT — running emitted tests anyway)"; fi
JS=$(echo "$FILES" | sed -e "s#^#$OUT/#" -e 's#\.ts$#.js#')
if [ -n "${TEST_FILTER:-}" ]; then
  # shellcheck disable=SC2086
  node --test --test-name-pattern="$TEST_FILTER" $JS
else
  # shellcheck disable=SC2086
  node --test $JS
fi

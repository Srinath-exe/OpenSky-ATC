#!/usr/bin/env bash
# Run tests/engine/voice-stt.test.ts in its own build dir (scripts/test-sim.sh clears the shared .tmp/sim).
set -u
cd "$(dirname "$0")/../../.."
OUT=.tmp/stt-test; rm -rf "$OUT"; mkdir -p "$OUT"
npx tsc --module commonjs --moduleResolution node --target es2020 --lib es2022,dom,dom.iterable --outDir "$OUT" --rootDir . --skipLibCheck \
  --esModuleInterop --strict --types node --resolveJsonModule --noEmitOnError false --ignoreConfig --ignoreDeprecations 6.0 tests/engine/voice-stt.test.ts
node --test "$OUT/tests/engine/voice-stt.test.js"

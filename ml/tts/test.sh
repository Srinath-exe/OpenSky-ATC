#!/usr/bin/env bash
# Run tests/engine/voice-tts.test.ts like scripts/test-sim.sh does, in a private output dir (.tmp/sim is shared).
set -u
cd "$(dirname "$0")/../.."
OUT=ml/tts/.build-test
rm -rf "$OUT"; mkdir -p "$OUT"
npx tsc --module commonjs --moduleResolution node --target es2020 --lib es2022,dom,dom.iterable \
  --outDir "$OUT" --rootDir . --skipLibCheck --esModuleInterop --strict --types node \
  --resolveJsonModule --noEmitOnError false --ignoreConfig --ignoreDeprecations 6.0 tests/engine/voice-tts.test.ts || echo "(tsc reported errors - running the emitted js anyway)"
node --test "$OUT/tests/engine/voice-tts.test.js"

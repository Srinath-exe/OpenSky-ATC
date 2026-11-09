#!/usr/bin/env bash
# Compile the game's voice + sim code to CommonJS for the node scripts in ml/verify (own dir: other tools rebuild .tmp/ml).
set -eu
cd "$(dirname "$0")/../.."
OUT=ml/verify/.build
rm -rf "$OUT"; mkdir -p "$OUT"
npx tsc --module commonjs --moduleResolution node --target es2020 --lib es2022,dom,dom.iterable \
  --outDir "$OUT" --rootDir . --skipLibCheck --esModuleInterop --types node --resolveJsonModule \
  --noEmitOnError false --ignoreConfig --ignoreDeprecations 6.0 src/lib/voice/understand.ts src/lib/voice/verify.ts src/lib/voice/s1.ts > /dev/null || true
# the engine as committed (before the verifier signals), to prove the decode is unchanged (ml/verify/parity.cjs)
OLD=ml/verify/.build-old; rm -rf "$OLD"; mkdir -p "$OLD"
if git show HEAD:src/lib/voice/s1.ts > "$OLD/s1.ts" 2>/dev/null; then
  npx tsc "$OLD/s1.ts" --module commonjs --target es2020 --lib es2022,dom --outDir "$OLD" --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0 > /dev/null || true
fi
test -f "$OUT/src/lib/voice/understand.js" && echo "built $OUT"

#!/usr/bin/env bash
# Build and run the pilot-line exporter (ml/tts/lines.ts) in a private output dir (.tmp/sim and .tmp/ml are shared).
#   ICAOS=KJFK,EGLL SEEDS=1 MIN=12 OUT=ml/tts/data/lines_KJFK_EGLL.jsonl ml/tts/lines.sh
#   ml/tts/lines.sh normalize      (adds the TTS input to every line: ml/tts/normalize.ts -> ml/tts/data/lines_all.jsonl)
set -eu
cd "$(dirname "$0")/../.."
OUT_DIR=ml/tts/.build
mkdir -p "$OUT_DIR"
npx tsc --module commonjs --moduleResolution node --target es2020 --lib es2022,dom,dom.iterable \
  --outDir "$OUT_DIR" --rootDir . --skipLibCheck --esModuleInterop --strict --types node \
  --resolveJsonModule --noEmitOnError false --ignoreConfig --ignoreDeprecations 6.0 ml/tts/lines.ts ml/tts/normalize.ts || echo "(tsc reported errors - running the emitted js anyway)"
if [ "${1:-}" = normalize ]; then node "$OUT_DIR/ml/tts/normalize.js"; else node "$OUT_DIR/ml/tts/lines.js"; fi

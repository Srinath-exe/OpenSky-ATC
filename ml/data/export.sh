#!/usr/bin/env bash
# Build and run the dataset exporter (ml/data/export.ts). Compiles to .tmp/ml (separate from the test runner's .tmp/sim).
#   ICAOS=KJFK,EGLL SEEDS=1-4 MIN=40 OUT=ml/data/out/train.jsonl ml/data/export.sh
set -eu
cd "$(dirname "$0")/../.."
OUT_DIR=.tmp/ml
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"
npx tsc --module commonjs --moduleResolution node --target es2020 --lib es2022,dom,dom.iterable \
  --outDir "$OUT_DIR" --rootDir . --skipLibCheck --esModuleInterop --strict --types node \
  --resolveJsonModule --noEmitOnError false --ignoreConfig --ignoreDeprecations 6.0 ml/data/export.ts || echo "(tsc reported errors - running the emitted js anyway)"
node "$OUT_DIR/ml/data/export.js"

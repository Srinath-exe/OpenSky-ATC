#!/usr/bin/env bash
# Compile the engine parser + phraseology and the reward server into ml/rl/.build (own copy: ml/data/export.sh wipes .tmp/ml).
set -eu
cd "$(dirname "$0")/../.."
npx tsc --module commonjs --moduleResolution node --target es2020 --lib es2022,dom,dom.iterable \
  --outDir ml/rl/.build --rootDir . --skipLibCheck --esModuleInterop --strict --types node \
  --resolveJsonModule --noEmitOnError false --ignoreConfig --ignoreDeprecations 6.0 ml/rl/reward_server.ts

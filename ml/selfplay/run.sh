#!/usr/bin/env bash
# Self-play arena: bundles ml/selfplay/arena.ts with esbuild and runs it headless (CPU only, no model).
#   bash ml/selfplay/run.sh --airport EGLL --minutes 40 --seeds 6
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .tmp/selfplay
npx esbuild ml/selfplay/arena.ts --bundle --platform=node --format=cjs --log-level=warning --outfile=.tmp/selfplay/arena.cjs
node .tmp/selfplay/arena.cjs "$@"

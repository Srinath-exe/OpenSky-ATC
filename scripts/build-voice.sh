#!/usr/bin/env bash
# Compile the browser voice engine (src/lib/voice/s1.ts) to a plain ES module for the worker in public/voice/.
# Kept out of the Next bundle so the worker needs no bundler support. Run by scripts/deploy.sh before `next build`.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf public/voice/gen
npx tsc src/lib/voice/s1.ts --module es2020 --target es2020 --lib es2022,dom --outDir public/voice/gen --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0
# the demo page (/reports/voice-demo.html) runs the game's own decision path: repair + n-best, rules, model, verifier
node_modules/.bin/esbuild ml/report/demo_pipeline.ts --bundle --format=esm --target=es2020 --minify --log-level=warning --outfile=public/voice/gen/demo-pipeline.js
echo "built public/voice/gen/s1.js ($(wc -c < public/voice/gen/s1.js) bytes), demo-pipeline.js ($(wc -c < public/voice/gen/demo-pipeline.js) bytes)"

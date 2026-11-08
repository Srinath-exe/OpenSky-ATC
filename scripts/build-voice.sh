#!/usr/bin/env bash
# Compile the browser voice engine (src/lib/voice/s1.ts) to a plain ES module for the worker in public/voice/.
# Kept out of the Next bundle so the worker needs no bundler support. Run by scripts/deploy.sh before `next build`.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf public/voice/gen
npx tsc src/lib/voice/s1.ts --module es2020 --target es2020 --lib es2022,dom --outDir public/voice/gen --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0
echo "built public/voice/gen/s1.js ($(wc -c < public/voice/gen/s1.js) bytes)"

#!/usr/bin/env bash
# Speech-to-text benchmark driver (ml/stt/RESULTS2.md). Compiles the game modules it scores with to .tmp/stt.
#   bash ml/stt/bench2/run.sh build
#   bash ml/stt/bench2/run.sh tjs <clipdir> <out.jsonl> --model whisper-base.en [--prompt phrases] [--alts]
#   bash ml/stt/bench2/run.sh fw  <clipdir> <out.jsonl> --model base.en [--prompt phrases]
#   bash ml/stt/bench2/run.sh score <clipdir> <results.jsonl ...> [--out summary.json] [--details details.jsonl]
#   bash ml/stt/bench2/run.sh gold [ml/data/gold]      # the owner's recordings: shipped engine + candidates, one table
set -euo pipefail
cd "$(dirname "$0")/../../.."
B=ml/stt/bench2
build() {
  npx tsc src/app/api/voice/stt/engine.ts src/app/api/voice/stt/handler.ts $B/score.ts --module commonjs --target es2020 --lib es2022,dom --outDir .tmp/stt --rootDir . \
    --skipLibCheck --esModuleInterop --ignoreConfig --ignoreDeprecations 6.0 --types node --resolveJsonModule
}
cmd="${1:-}"; shift || true
case "$cmd" in
  build) build ;;
  tjs) [ -f .tmp/stt/src/app/api/voice/stt/engine.js ] || build; node $B/transcribe_tjs.cjs "$@" ;;
  fw) ml/stt/.venv/bin/python $B/transcribe_fw.py "$@" ;;
  score) build; node .tmp/stt/$B/score.js "$@" ;;
  gold)
    D="${1:-ml/data/gold}"; R="$B/results/gold"; mkdir -p "$R"; build
    node $B/gold_webspeech.cjs "$D" "$R/webspeech-google.jsonl"
    for m in "whisper-base.en" "moonshine-base" "moonshine-tiny"; do node $B/transcribe_tjs.cjs "$D" "$R/tjs-$m.jsonl" --model "$m" --alts; done
    node .tmp/stt/$B/score.js "$D" "$R"/*.jsonl --combo "webspeech-google>tjs-whisper-base.en,webspeech-google+tjs-whisper-base.en" \
      --out "$R/summary.json" --details "$R/details.jsonl" ;;
  *) sed -n 2,8p "$0"; exit 1 ;;
esac

#!/usr/bin/env bash
# After the Whistle queue: the shipped/on-device baselines on the Indian-accent proxy (2 threads).
set -u
cd "$(dirname "$0")/../../.."
while kill -0 "$1" 2>/dev/null; do sleep 10; done
B=ml/stt/bench2; R=$B/results; C=$B/clips_in
[ -f .tmp/stt/src/app/api/voice/stt/engine.js ] || bash $B/run.sh build
node $B/transcribe_tjs.cjs $C $R/edge-in-tjs-moonshine-base.jsonl --model moonshine-base --dec q8 --threads 2 --every 2
node $B/transcribe_tjs.cjs $C $R/edge-in-tjs-moonshine-tiny.jsonl --model moonshine-tiny --dec q8 --threads 2 --every 2
node $B/transcribe_tjs.cjs $C $R/edge-in-tjs-whisper-tiny.en.jsonl --model whisper-tiny.en --enc fp32 --dec q8 --alts --threads 2 --every 2

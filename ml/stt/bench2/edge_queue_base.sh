#!/usr/bin/env bash
# The browser baselines (transformers.js: Moonshine v1, Whisper tiny.en + callsign prompt) on the Indian-accent proxy,
# after the Moonshine v2 queue (one core). The US/UK set already has them (results/tjs-*.jsonl).
set -u
cd "$(dirname "$0")/../../.."
while kill -0 "${1:-0}" 2>/dev/null; do sleep 20; done
R=ml/stt/bench2/results
for m in moonshine-base moonshine-tiny whisper-tiny.en; do
  taskset -c 2 node ml/stt/bench2/transcribe_tjs.cjs ml/stt/bench2/clips_in $R/edge-in-tjs-$m.jsonl --model $m --every 2 --alts --threads 1
done

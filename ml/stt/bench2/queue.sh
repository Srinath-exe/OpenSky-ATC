#!/usr/bin/env bash
# Candidate transcriptions for the benchmark, resumable (each run skips clips already in its output).
#   bash ml/stt/bench2/queue.sh A|B|C      A: Whisper via transformers.js (2 threads)   B: Moonshine + faster-whisper base (1 thread)
#                                          C: the small models on a subset (clean + late, 2 threads)
set -u
cd "$(dirname "$0")/../../.."
B=ml/stt/bench2; C=$B/clips; R=$B/results; mkdir -p "$R"
[ -f .tmp/stt/src/app/api/voice/stt/engine.js ] || bash $B/run.sh build
case "${1:-}" in
  A)
    node $B/transcribe_tjs.cjs $C $R/tjs-whisper-base.en.jsonl --model whisper-base.en --enc fp32 --dec q8 --alts --threads 2 --every 2
    node $B/transcribe_tjs.cjs $C $R/tjs-whisper-tiny.en.jsonl --model whisper-tiny.en --enc fp32 --dec q8 --alts --threads 2 --every 2 ;;
  B)
    node $B/transcribe_tjs.cjs $C $R/tjs-moonshine-tiny.jsonl --model moonshine-tiny --dec q8 --threads 1
    node $B/transcribe_tjs.cjs $C $R/tjs-moonshine-base.jsonl --model moonshine-base --dec q8 --threads 1
    ml/stt/.venv/bin/python $B/transcribe_fw.py $C $R/fw-base.en.jsonl --model base.en --alts --threads 1 --every 2 ;;
  C)
    node $B/transcribe_tjs.cjs $C $R/tjs-whisper-small.en.jsonl --model whisper-small.en --enc q8 --dec q8 --alts --threads 2 --every 2 --cond clean,late
    ml/stt/.venv/bin/python $B/transcribe_fw.py $C $R/fw-small.en.jsonl --model small.en --alts --threads 2 --every 2 --cond clean,late
    ml/stt/.venv/bin/python $B/transcribe_fw.py $C $R/fw-distil-small.en.jsonl --model distil-small.en --alts --threads 2 --every 2 --cond clean,late ;;
  *) echo "usage: queue.sh A|B|C"; exit 1 ;;
esac

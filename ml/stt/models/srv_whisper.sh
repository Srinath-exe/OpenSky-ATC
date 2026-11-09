#!/usr/bin/env bash
# The shipped server engine (Whisper base.en, transformers.js, callsign prompt, 2-best) re-run at 3 threads after
# the candidate queue, on both clip sets, so its latency is measured under the same load as theirs.
#   bash ml/stt/models/srv_whisper.sh [queue-pid-to-wait-for]
cd "$(dirname "$0")/../../.."
[ -n "${1:-}" ] && while kill -0 "$1" 2>/dev/null; do sleep 20; done
exec 9>ml/stt/models/.queue.lock; flock 9   # after the candidate queue, never beside it
R=ml/stt/bench2/results
for set in clips clips_in; do
  out=$R/srv-tjs-whisper-base.en.jsonl; [ $set = clips_in ] && out=$R/srv-tjs-whisper-base.en.in.jsonl
  echo "== $(date +%T) whisper $set"
  node ml/stt/bench2/transcribe_tjs.cjs ml/stt/bench2/$set "$out" --model whisper-base.en --prompt phrases --alts --every 2 --threads 3 2>&1 | tail -n 1
done
echo "== $(date +%T) whisper done"

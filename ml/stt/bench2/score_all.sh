#!/usr/bin/env bash
# Final scoring of every candidate (3 processes in parallel, 1 thread each). Writes results/sum_{even,small,full}_*.json.
set -u
cd "$(dirname "$0")/../../.."
B=ml/stt/bench2; C=$B/clips; R=$B/results; S="node .tmp/stt/$B/score.js $C"
bash $B/run.sh build
( $S $R/webspeech-google.jsonl $R/tjs-whisper-base.en.jsonl --every 2 --combo "webspeech-google>tjs-whisper-base.en,webspeech-google+tjs-whisper-base.en" --out $R/sum_even_webspeech.json --details $R/det_even_webspeech.jsonl
  $S $R/webspeech-google.jsonl --out $R/sum_full_webspeech-google.json ) > $R/score1.log 2>&1 &
( for c in tjs-moonshine-base tjs-moonshine-tiny fw-base.en; do $S $R/$c.jsonl --every 2 --out $R/sum_even_$c.json --details $R/det_even_$c.jsonl; done
  for c in tjs-moonshine-base tjs-moonshine-tiny; do $S $R/$c.jsonl --out $R/sum_full_$c.json; done ) > $R/score2.log 2>&1 &
( $S $R/tjs-whisper-tiny.en.jsonl --every 2 --out $R/sum_even_tjs-whisper-tiny.en.json --details $R/det_even_tjs-whisper-tiny.en.jsonl
  while [ "$(wc -l < $R/fw-distil-small.en.jsonl 2>/dev/null || echo 0)" -lt 160 ]; do sleep 20; done
  $S $R/webspeech-google.jsonl $R/tjs-moonshine-base.jsonl $R/tjs-whisper-base.en.jsonl $R/fw-base.en.jsonl $R/tjs-whisper-small.en.jsonl $R/fw-small.en.jsonl $R/fw-distil-small.en.jsonl \
    --every 2 --cond clean,late --combo "webspeech-google>tjs-whisper-base.en" --out $R/sum_small_all.json ) > $R/score3.log 2>&1 &
wait
echo all-scored

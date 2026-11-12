#!/usr/bin/env bash
# After the Moonshine v2 queue: in-browser latency / RAM / download, headless Chromium, WASM (1 thread each).
set -u
cd "$(dirname "$0")/../../.."
while kill -0 "$1" 2>/dev/null; do sleep 10; done
B=ml/stt/bench2; R=$B/results
for v in "model=whistle" "model=whistle&alts=0" "model=base" "model=tiny"; do
  tag=$(echo "$v" | sed 's/model=//; s/&alts=0/-1best/')
  node $B/edge_browser.cjs $B/clips $R/edge-browser-$tag.jsonl "$v" --every 2 --limit 40
done
node $B/edge_browser.cjs $B/clips_in $R/edge-in-browser-whistle.jsonl "model=whistle" --every 2 --limit 40

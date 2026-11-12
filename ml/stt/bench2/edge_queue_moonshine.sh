#!/usr/bin/env bash
# Moonshine v2 streaming tiny/small on the common subset of both synthetic sets, one core (ml/stt/models/EDGE.md).
set -u
cd "$(dirname "$0")/../../.."
PY="taskset -c 2 ml/stt/venvs/moonshine/bin/python"; R=ml/stt/bench2/results
for a in tiny small; do
  $PY ml/stt/bench2/edge_moonshine.py ml/stt/bench2/clips    $R/edge-moonshine2-$a.jsonl    --arch $a --every 2 --alts
  $PY ml/stt/bench2/edge_moonshine.py ml/stt/bench2/clips_in $R/edge-in-moonshine2-$a.jsonl --arch $a --every 2 --alts
done

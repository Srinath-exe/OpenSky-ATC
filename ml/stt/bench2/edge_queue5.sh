#!/usr/bin/env bash
# After queue4: Whistle with the ATC command words added to the keyword list (ablation), 2 threads.
set -u
cd "$(dirname "$0")/../../.."
[ -n "${1:-}" ] && while kill -0 "$1" 2>/dev/null; do sleep 10; done
export CACTUS_TELEMETRY=0; PY=ml/stt/venvs/cactus/bin/python; R=ml/stt/bench2/results
$PY ml/stt/bench2/edge_cactus.py ml/stt/bench2/clips    $R/edge-whistle-kwp.jsonl    --every 2 --keywords phrases
$PY ml/stt/bench2/edge_cactus.py ml/stt/bench2/clips_in $R/edge-in-whistle-kwp.jsonl --every 2 --keywords phrases

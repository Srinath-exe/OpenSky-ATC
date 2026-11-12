#!/usr/bin/env bash
# Whistle on the common subset of both synthetic sets (ml/stt/models/EDGE.md).
set -u
cd "$(dirname "$0")/../../.."
PY=ml/stt/venvs/cactus/bin/python; R=ml/stt/bench2/results
export CACTUS_TELEMETRY=0
$PY ml/stt/bench2/edge_cactus.py ml/stt/bench2/clips    $R/edge-whistle-kw.jsonl    --every 2 --keywords names --alts
$PY ml/stt/bench2/edge_cactus.py ml/stt/bench2/clips_in $R/edge-in-whistle-kw.jsonl --every 2 --keywords names --alts
$PY ml/stt/bench2/edge_cactus.py ml/stt/bench2/clips    $R/edge-whistle-kwp.jsonl   --every 2 --keywords phrases
$PY ml/stt/bench2/edge_cactus.py ml/stt/bench2/clips_in $R/edge-in-whistle-kwp.jsonl --every 2 --keywords phrases

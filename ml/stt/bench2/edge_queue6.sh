#!/usr/bin/env bash
# After the browser runs: Phonon-2.5 English as LiteRT int8 (the phone build), 40 clips of each set, 1 thread.
set -u
cd "$(dirname "$0")/../../.."
[ -n "${1:-}" ] && while kill -0 "$1" 2>/dev/null; do sleep 10; done
PY=ml/stt/venvs/litert/bin/python; R=ml/stt/bench2/results
$PY ml/stt/bench2/edge_phonon_litert.py ml/stt/bench2/clips    $R/edge-phonon-litert.jsonl    --every 2 --limit 40 --threads 1
$PY ml/stt/bench2/edge_phonon_litert.py ml/stt/bench2/clips_in $R/edge-in-phonon-litert.jsonl --every 2 --limit 40 --threads 1

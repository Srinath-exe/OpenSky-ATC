#!/usr/bin/env bash
# Server-class STT candidates, one engine at a time, 3 threads (ml/stt/models/SERVER.md).
#   bash ml/stt/models/srv_queue.sh [engine ...]
# Outputs: ml/stt/bench2/results/srv-<name>.jsonl (US/UK bench, even ids) and srv-<name>.in.jsonl (Indian-accent proxy).
set -uo pipefail
cd "$(dirname "$0")/../../.."
# one queue at a time on this host (two agents once ran it together): a second copy exits at once
exec 9>ml/stt/models/.queue.lock; flock -n 9 || { echo "another srv_queue.sh holds ml/stt/models/.queue.lock"; exit 3; }
V=ml/stt/venvs; R=ml/stt/bench2/results; S=sherpa-onnx-nemo-parakeet
run() {   # name venv engine [flags]
  local name=$1 venv=$2 eng=$3; shift 3
  for set in clips clips_in; do
    local out=$R/srv-$name.jsonl; [ $set = clips_in ] && out=$R/srv-$name.in.jsonl
    echo "== $(date +%T) $name $set"
    $V/$venv/bin/python ml/stt/models/srv_run.py "$eng" ml/stt/bench2/$set "$out" --every 2 --threads 3 "$@" 2>&1 | grep -E '^\{' | tail -n 2
  done
}
want() { [ -z "$ALL" ] || [[ " $ALL " == *" $1 "* ]]; }
ALL="$*"
want phonon        && run phonon        fermion   phonon --hotwords
want p110-sherpa   && run p110-sherpa   onnx      "sherpa-${S}_tdt_transducer_110m-en-36000-int8:beam" --hotwords
want canary180     && run canary180     onnx      canary-onnxasr
want hima          && run hima          onnx      hima
want redux-sherpa  && run redux-sherpa  onnx      "sherpa-${S}-tdt-0.6b-redux-int8:beam" --hotwords
want ultra-sherpa  && run ultra-sherpa  onnx      "sherpa-${S}-tdt-0.6b-ultra-int8:beam" --hotwords
want redux-photon  && run redux-photon  moondream redux-photon
want ultra-onnxasr && run ultra-onnxasr onnx      ultra-onnxasr
want granite       && run granite       granite   granite
echo "== $(date +%T) queue done"

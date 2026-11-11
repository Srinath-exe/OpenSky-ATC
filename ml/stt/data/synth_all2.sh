#!/usr/bin/env bash
# Round 2 (ml/data/stt/synth2, coverage_lines.py): all engines at low priority, resumable.
cd "$(dirname "$0")/../../.."
export STT_SYNTH=synth2; L=ml/data/stt/synth2/logs; mkdir -p $L
run() { nice -n 19 "$@"; }
for k in 0 1 2 3 4; do run ml/tts/venvs/phonon/bin/python ml/stt/data/synth.py phonon --shard $k/5 > $L/phonon$k.log 2>&1 & done
# kokoro: on the GPU box (ml/gpu/remote/stt_kokoro.sh)
for k in 0 1; do run ml/tts/venvs/supertonic/bin/python ml/stt/data/synth.py supertonic --shard $k/2 > $L/supertonic$k.log 2>&1 & done
run ml/stt/.venv/bin/python ml/stt/data/synth.py paradee > $L/paradee.log 2>&1 &
wait
grep -h "^done" $L/*.log

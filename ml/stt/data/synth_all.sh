#!/usr/bin/env bash
# All four engines over ml/data/stt/synth/lines.jsonl at low priority (resumable: re-run to finish). Logs: ml/data/stt/synth/logs/.
cd "$(dirname "$0")/../../.."
L=ml/data/stt/synth/logs
run() { nice -n 19 "$@"; }
for k in 0 1 2; do run ml/stt/.venv/bin/python ml/stt/data/synth.py kokoro --shard $k/3 > $L/kokoro$k.log 2>&1 & done
for k in 0 1; do run ml/tts/venvs/phonon/bin/python ml/stt/data/synth.py phonon --shard $k/2 > $L/phonon$k.log 2>&1 & done
run ml/tts/venvs/supertonic/bin/python ml/stt/data/synth.py supertonic > $L/supertonic.log 2>&1 &
run ml/stt/.venv/bin/python ml/stt/data/synth.py paradee > $L/paradee.log 2>&1 &
wait
grep -h "^done" $L/*.log

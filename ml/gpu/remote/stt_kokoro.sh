#!/usr/bin/env bash
# GPU job: speak the Kokoro share of ml/data/stt/synth2/lines.jsonl on the GPU (4 processes share the card).
set -uo pipefail
cd /opt/atc/repo
[ -f /opt/pytorch/bin/activate ] && . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*"; }
sudo apt-get install -y -q espeak-ng > /dev/null 2>&1
pip install -q kokoro soundfile "misaki[en]" 2>&1 | grep -vE "already satisfied|WARNING" | tail -3
export STT_SYNTH=synth2; L=/opt/atc/results/kokoro; mkdir -p $L
say "kokoro start"
for k in 0 1 2 3; do python ml/stt/data/synth.py kokoro --shard $k/4 --threads 2 > $L/k$k.log 2>&1 & done
wait
say "kokoro $(grep -h '^done' $L/k*.log | tr '\n' ';')"
say "done"

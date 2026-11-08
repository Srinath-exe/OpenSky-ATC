#!/usr/bin/env bash
# Phase 4: does more airport variety close the unseen-airport gap? S1 2M on 11 airports (Sydney still held out).
cd /opt/atc/repo; R=/opt/atc/results; . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a $R/jobs.log; }
say "P4 s1-2m-11ap (d=192, 11 airports, Sydney held out)"
python ml/s1/train.py --data ml/data/out3/ds --tok ml/tokenizer/atc.json --out $R/s1-2m-11ap --d 192 --layers 4 --heads 6 --steps 6000 --batch 64 \
  --lr 2e-3 --eval-every 3000 --eval-n 200 --device cuda --bf16 --threads 2 > $R/s1-2m-11ap.log 2>&1
say "P4 s1-2m-11ap done: $(python3 -c "import json; d=json.load(open('$R/s1-2m-11ap/eval.json')); print('val', d['val']['exact'], 'sydney', d['test_airport']['exact'], 'sydney callsign', d['test_airport']['callsign'], 'sydney say-again fp', d['test_airport']['say_again_fp'])")"
touch $R/PHASE4-DONE

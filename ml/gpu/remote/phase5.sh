#!/usr/bin/env bash
# Phase 5: callsign-swap augmentation (every airline in the game, whatever the airports) -> unseen-airport accuracy.
cd /opt/atc/repo; R=/opt/atc/results; . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a $R/jobs.log; }
say "P5 s1-2m-11ap-swap (11 airports + airline swap, Sydney held out)"
python ml/s1/train.py --data ml/data/out4/ds --tok ml/tokenizer/atc.json --out $R/s1-2m-11ap-swap --d 192 --layers 4 --heads 6 --steps 6000 --batch 64 \
  --lr 2e-3 --eval-every 3000 --eval-n 200 --device cuda --bf16 --threads 2 > $R/s1-2m-11ap-swap.log 2>&1
say "P5 s1-2m-11ap-swap done: $(python3 -c "import json; d=json.load(open('$R/s1-2m-11ap-swap/eval.json')); print('val', d['val']['exact'], 'sydney', d['test_airport']['exact'], 'sydney callsign', d['test_airport']['callsign'], 'sydney say-again fp', d['test_airport']['say_again_fp'])")"
touch $R/PHASE5-DONE

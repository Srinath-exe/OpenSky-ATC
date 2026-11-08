#!/usr/bin/env bash
# Phase 6: pretrained + data engineering. E2 (LFM2.5-230M) on 11 airports + airline swap, Sydney still held out.
cd /opt/atc/repo; R=/opt/atc/results; . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a $R/jobs.log; }
for _ in $(seq 240); do [ -f $R/VLLM-DONE ] && break; sleep 15; done
say "P6 E2 LFM2.5-230M on 11 airports + airline swap"
python ml/e2/sft.py --model LiquidAI/LFM2.5-230M-Base --data ml/data/out4/ds --out $R/e2-lfm230m-11ap-swap --n-train 30000 --bs 16 --lr 5e-5 \
  --test ml/data/out4/ds/test_airport.jsonl > $R/e2-lfm230m-11ap-swap.log 2>&1
say "P6 done: $(grep FINAL $R/e2-lfm230m-11ap-swap.log | python3 -c "import sys, json; d=json.loads(sys.stdin.read().split('FINAL ',1)[1]); print('val', d['val']['exact'], 'sydney', d['test_airport']['exact'], 'sydney callsign', d['test_airport']['callsign'], 'ms', d['latency_gpu_batch1']['p50_ms'])")"
touch $R/PHASE6-DONE

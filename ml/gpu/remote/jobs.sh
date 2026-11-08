#!/usr/bin/env bash
# The GPU session's job queue (runs on the instance, started by `ml/gpu/gpu.sh jobs`). Two lanes share the L4:
#   lane A  S1 from scratch: v1 repro (GPU vs 43 min on CPU), then a size sweep on the 3x data when it arrives
#   lane B  Kev-0.8B: fine-tune on our ATC data, its own benchmark, then base vs fine-tuned on the 100 bake-off commands
#   lane C  (after B) the other System One models on the GPU, for real GPU latency
# Results land in /opt/atc/results; `ml/gpu/gpu.sh pull` copies them home. Every step logs a line to jobs.log.
set -uo pipefail
cd /opt/atc/repo
R=/opt/atc/results; mkdir -p "$R"
[ -f /opt/pytorch/bin/activate ] && . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*"; }
KEV=/opt/atc/kev; KPY=$KEV/.venv/bin/python

laneA() {
  say "A1 S1 v1 repro on GPU"
  python ml/s1/train.py --data ml/data/out/ds --tok ml/tokenizer/atc.json --out $R/s1-v1-gpu --d 192 --layers 4 --heads 6 \
    --steps 2000 --batch 32 --lr 2e-3 --eval-every 1000 --eval-n 200 --device cuda --bf16 --threads 2 > $R/s1-v1-gpu.log 2>&1
  say "A1 done: $(grep FINAL $R/s1-v1-gpu.log | cut -c1-200)"
  # size sweep on the 3x data; waits up to 60 min for it to be pushed (marker file written by the VPS after augment)
  for _ in $(seq 120); do [ -f ml/data/out2/ds/READY ] && break; sleep 30; done
  DS=ml/data/out2/ds; [ -f $DS/READY ] || { DS=ml/data/out/ds; say "A2 3x data not here, sweeping on v1 data"; }
  for cfg in "192 4 6 2e-3 s1-2m" "384 6 6 1e-3 s1-11m" "512 8 8 7e-4 s1-26m"; do
    set -- $cfg
    say "A2 $5 (d=$1 layers=$2) on $DS"
    python ml/s1/train.py --data $DS --tok ml/tokenizer/atc.json --out $R/$5 --d $1 --layers $2 --heads $3 --steps 4000 --batch 64 \
      --lr $4 --eval-every 2000 --eval-n 200 --device cuda --bf16 --threads 2 > $R/$5.log 2>&1
    say "A2 $5 done: $(grep FINAL $R/$5.log | cut -c1-220)"
  done
}

serve_kev() {  # $1 run/model, $2 port -> background server, waits until ready
  ( cd $KEV && KEV_DTYPE=bf16 setsid nohup $KPY -m kev.serve --run "$1" --port $2 --device cuda > $R/kev-serve-$2.log 2>&1 < /dev/null & )
  for _ in $(seq 120); do curl -s -o /dev/null http://127.0.0.1:$2/v1/models && return 0; sleep 5; done; return 1
}
stop_port() { local p; p=$(ss -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$p" ] && kill "$p"; sleep 3; }

laneB() {
  say "B1 Kev-0.8B fine-tune on 8,000 ATC examples"
  ( cd $KEV && $KPY -m kev.train --data /opt/atc/repo/ml/system1/out/kev-data/train.jsonl --base Qwen/Qwen3.5-0.8B-Base \
      --init_from jaredpalmer/kev-0.8b --epochs 1 --lr 5e-5 --batch 8 --accum 1 --dtype bf16 --device cuda --out $R/kev-atc-0.8b ) > $R/kev-train.log 2>&1
  say "B1 done: $(tail -n 2 $R/kev-train.log | tr '\n' ' ' | cut -c1-200)"
  say "B2 Kev benchmark on 300 held-out"
  ( cd $KEV && $KPY -m kev.benchmark --run $R/kev-atc-0.8b --data /opt/atc/repo/ml/system1/out/kev-data/heldout.jsonl --out $R/kev-atc-eval ) > $R/kev-bench.log 2>&1
  say "B2 done"
  say "B3 bake-off: Kev base vs fine-tuned on the GPU"
  if serve_kev jaredpalmer/kev-0.8b 8009; then
    python ml/system1/bench_all.py --model http --url http://127.0.0.1:8009 --name kev-0.8b --n 100 --device cuda > $R/bench-kev-base-gpu.log 2>&1
    stop_port 8009
  fi
  if serve_kev $R/kev-atc-0.8b 8010; then
    python ml/system1/bench_all.py --model http --url http://127.0.0.1:8010 --name kev-0.8b-atc --n 100 --device cuda > $R/bench-kev-atc-gpu.log 2>&1
    stop_port 8010
  fi
  say "B3 done: base $(head -1 $R/bench-kev-base-gpu.log | cut -c1-160) | atc $(head -1 $R/bench-kev-atc-gpu.log | cut -c1-160)"
  say "C bake-off on the GPU: d1, von, laya, qwen letters"
  for m in d1 von laya logits; do
    python ml/system1/bench_all.py --model $m --n 100 --device cuda > $R/bench-$m-gpu.log 2>&1
    say "C $m: $(grep -m1 '^{' $R/bench-$m-gpu.log | cut -c1-170)"
  done
}

say "jobs start on $(nvidia-smi --query-gpu=name --format=csv,noheader)"
laneA & A=$!
laneB & B=$!
wait $A $B
cp ml/system1/out/bench-*-gpu.json $R/ 2>/dev/null || true
say "ALL DONE"
touch $R/ALL-DONE

#!/usr/bin/env bash
# Lane B, second try: Kev-0.8B fine-tune with the memory settings Kev documents (batch 1, accumulate 8, gradient
# checkpointing), then its benchmark, the base-vs-fine-tuned bake-off, and the other System One models on the GPU.
set -uo pipefail
cd /opt/atc/repo
R=/opt/atc/results
[ -f /opt/pytorch/bin/activate ] && . /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a $R/jobs.log; }
KEV=/opt/atc/kev; KPY=$KEV/.venv/bin/python
serve_kev() {
  ( cd $KEV && KEV_DTYPE=bf16 setsid nohup $KPY -m kev.serve --run "$1" --port $2 --device cuda > $R/kev-serve-$2.log 2>&1 < /dev/null & )
  for _ in $(seq 60); do curl -s -o /dev/null http://127.0.0.1:$2/v1/models && return 0; grep -q Traceback $R/kev-serve-$2.log 2>/dev/null && return 1; sleep 5; done; return 1
}
stop_port() { local p; p=$(ss -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$p" ] && kill "$p"; sleep 3; }

say "B1' Kev-0.8B fine-tune on 3,000 examples (batch 1, accum 8, checkpointing)"
rm -rf $R/kev-atc-0.8b
( cd $KEV && $KPY -m kev.train --data /opt/atc/repo/ml/system1/out/kev-data/train3k.jsonl --base Qwen/Qwen3.5-0.8B-Base \
    --init_from jaredpalmer/kev-0.8b --epochs 1 --lr 5e-5 --batch 1 --accum 8 --checkpointing 1 --dtype bf16 --device cuda --out $R/kev-atc-0.8b ) > $R/kev-train.log 2>&1
say "B1' done (exit $?): $(grep -iE 'error|loss' $R/kev-train.log | tail -n 1 | cut -c1-180)"
say "B2 Kev benchmark on 300 held-out"
( cd $KEV && $KPY -m kev.benchmark --run $R/kev-atc-0.8b --data /opt/atc/repo/ml/system1/out/kev-data/heldout.jsonl --out $R/kev-atc-eval ) > $R/kev-bench.log 2>&1
say "B2 done: $(tail -n 3 $R/kev-bench.log | tr '\n' ' ' | cut -c1-200)"
if serve_kev $R/kev-atc-0.8b 8010; then
  python ml/system1/bench_all.py --model http --url http://127.0.0.1:8010 --name kev-0.8b-atc --n 100 --device cuda > $R/bench-kev-atc-gpu.log 2>&1
  stop_port 8010
  say "B3 fine-tuned: $(grep -m1 '^{' $R/bench-kev-atc-gpu.log | cut -c1-200)"
else
  say "B3 fine-tuned server did not start: $(grep -m1 -iE 'error' $R/kev-serve-8010.log | cut -c1-160)"
fi
say "C bake-off on the GPU: d1, von, laya, qwen letters"
for m in d1 von laya logits; do
  python ml/system1/bench_all.py --model $m --n 100 --device cuda > $R/bench-$m-gpu.log 2>&1
  say "C $m: $(grep -m1 '^{' $R/bench-$m-gpu.log | cut -c1-170) $(grep -m1 -E 'Error' $R/bench-$m-gpu.log | cut -c1-120)"
done
cp ml/system1/out/bench-*-gpu.json $R/ 2>/dev/null || true
say "LANE B2 DONE"; touch $R/LANEB-DONE

#!/usr/bin/env bash
# The whole experiment after mining: 3 GRPO variants in parallel (1 thread each), then the SFT control, then full evals.
#   BUDGET=1500 ml/rl/run_all.sh        (training CPU seconds per run, evals excluded)
set -u
cd "$(dirname "$0")"
PY=../.venv/bin/python
B=${BUDGET:-1500}
export OMP_NUM_THREADS=1
for R in exact shaped verifier; do
  $PY grpo.py --reward $R --out runs/grpo-$R --budget $B --lr 3e-5 --eval-every 60 > runs/grpo-$R.log 2>&1 &
  echo "grpo-$R pid $!"
done
wait
$PY sft.py --out runs/sft-control --budget $B --eval-every 100 > runs/sft-control.log 2>&1 &
SFT=$!
$PY evalrun.py --run runs/grpo-exact --ckpt runs/grpo-exact/model.pt --out runs/grpo-exact/eval_full.json > runs/grpo-exact/eval.log 2>&1 &
$PY evalrun.py --run runs/grpo-shaped --ckpt runs/grpo-shaped/model.pt --out runs/grpo-shaped/eval_full.json > runs/grpo-shaped/eval.log 2>&1
$PY evalrun.py --run runs/grpo-verifier --ckpt runs/grpo-verifier/model.pt --out runs/grpo-verifier/eval_full.json > runs/grpo-verifier/eval.log 2>&1
wait
$PY evalrun.py --run runs/sft-control --ckpt runs/sft-control/model.pt --out runs/sft-control/eval_full.json > runs/sft-control/eval.log 2>&1
echo ALL-DONE > runs/ALL-DONE

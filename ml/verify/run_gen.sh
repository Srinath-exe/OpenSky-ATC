#!/usr/bin/env bash
# Generator pass over the example sets, two 1-thread workers (the CPU is shared).
#   MODEL=public/models/s1/2m-swap-v1 ml/verify/run_gen.sh [sets...]   -> ml/verify/out/<model name>/<set>.gen.jsonl (+ .h.npy, gen-<set>.log)
set -eu
cd "$(dirname "$0")/../.."
MODEL=${MODEL:-public/models/s1/2m-swap-v1}
TAG=$(basename "$MODEL"); D=ml/verify/out/$TAG; mkdir -p "$D"
PY=ml/.venv/bin/python
SETS=("$@"); [ ${#SETS[@]} -eq 0 ] && SETS=(val stt trainA hardneg syd noisy trainB)
A=(); B=(); i=0
for s in "${SETS[@]}"; do if [ $((i % 2)) -eq 0 ]; then A+=("$s"); else B+=("$s"); fi; i=$((i + 1)); done
work() { for s in "$@"; do OMP_NUM_THREADS=1 $PY ml/verify/gen.py --model "$MODEL" --in ml/verify/out/$s.in.jsonl --out $D/$s.gen.jsonl --hidden --threads 1 > $D/gen-$s.log 2>&1; done; }
work "${A[@]}" & PA=$!
work "${B[@]}" & PB=$!
wait $PA $PB
echo done

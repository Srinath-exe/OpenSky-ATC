#!/usr/bin/env bash
# Export a trained run for the browser (int8) and score it on the free-wording sets through the game's own chain.
#   bash ml/s1/freeword/eval_model.sh ml/rl/runs/plain-v1 2m-plain-v1
set -euo pipefail
cd "$(dirname "$0")/../../.."
RUN=$1; NAME=$2
ml/.venv/bin/python ml/edge/export_web.py --run "$RUN" --name "s1/$NAME" --int8 --check 300 --data ml/data/out4/ds/val.jsonl | tail -3
for S in rows held indep; do
  [ -f ml/s1/freeword/$S.json ] || continue
  echo "== $S  (shipped model)"; python3 ml/s1/freeword/score.py ml/s1/freeword/$S.json --model public/models/s1/2m-grpo-v1 | tail -1
  cp ml/s1/freeword/$( [ $S = rows ] && echo result || echo $S.result ).json ml/s1/freeword/$S.base.json
  echo "== $S  ($NAME)";        python3 ml/s1/freeword/score.py ml/s1/freeword/$S.json --model public/models/s1/$NAME | tail -1
done

#!/usr/bin/env bash
# Phase 3: generalisation to an airport never trained on (Sydney). Kev base vs Kev fine-tuned on the same 100 Sydney
# commands; accuracy only (it may share the GPU with other jobs, so its timings are not reported).
set -uo pipefail
cd /opt/atc/repo
R=/opt/atc/results
. /opt/pytorch/bin/activate
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a $R/jobs.log; }
KEV=/opt/atc/kev; KPY=$KEV/.venv/bin/python
for _ in $(seq 240); do [ -f $R/LANEB-DONE ] && break; sleep 15; done
serve_kev() {
  ( cd $KEV && KEV_DTYPE=bf16 setsid nohup $KPY -m kev.serve --run "$1" --port $2 --device cuda > $R/kev-serve-$2.log 2>&1 < /dev/null & )
  for _ in $(seq 60); do curl -s -o /dev/null http://127.0.0.1:$2/v1/models && return 0; grep -q Traceback $R/kev-serve-$2.log 2>/dev/null && return 1; sleep 5; done; return 1
}
stop_port() { local p; p=$(ss -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); [ -n "$p" ] && kill "$p"; sleep 3; }
for pair in "jaredpalmer/kev-0.8b 8011 kev-0.8b-sydney" "$R/kev-atc-0.8b 8012 kev-0.8b-atc-sydney"; do
  set -- $pair
  say "P0 $3: Kev on the unseen airport"
  if serve_kev "$1" "$2"; then
    python ml/system1/bench_all.py --model http --url http://127.0.0.1:$2 --name "$3" --n 100 --data ml/data/out/ds/test_airport.jsonl > $R/bench-$3.log 2>&1
    say "P0 $3: $(grep -m1 '^{' $R/bench-$3.log | cut -c1-190)"
    stop_port "$2"
  else
    say "P0 $3: server did not start"
  fi
done
cp ml/system1/out/bench-kev*sydney*.json $R/ 2>/dev/null || true
touch $R/PHASE3-DONE

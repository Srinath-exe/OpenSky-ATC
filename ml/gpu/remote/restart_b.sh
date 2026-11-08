#!/usr/bin/env bash
# restart lane B on 3,000 Kev examples; kills the old trainer by PID (pkill -f would match this script's own args)
for p in $(pgrep -f "kev.trai[n]"); do kill "$p"; done
sleep 3
head -n 3000 /opt/atc/repo/ml/system1/out/kev-data/train.jsonl > /opt/atc/repo/ml/system1/out/kev-data/train3k.jsonl
cd /opt/atc/repo && setsid nohup bash ml/gpu/remote/laneB2.sh > /opt/atc/results/laneB2.log 2>&1 < /dev/null &
sleep 2; tail -n1 /opt/atc/results/jobs.log

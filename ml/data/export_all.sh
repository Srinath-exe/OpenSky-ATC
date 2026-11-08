#!/usr/bin/env bash
# Full export: one process per airport in parallel (compile once with export.sh first, or this script compiles).
#   SEEDS=1-4 MIN=40 ml/data/export_all.sh   -> ml/data/out/<ICAO>.jsonl
set -eu
cd "$(dirname "$0")/../.."
[ -f .tmp/ml/ml/data/export.js ] || { echo "compile first: ml/data/export.sh (ICAOS=KJFK MIN=1)"; exit 1; }
for A in ${AIRPORTS:-KJFK EGLL KLAX KSFO LFPG YSSY}; do
  mkdir -p ${OUTDIR:-ml/data/out}; ICAOS=$A OUT=${OUTDIR:-ml/data/out}/$A.jsonl node .tmp/ml/ml/data/export.js > ${OUTDIR:-ml/data/out}/$A.log 2>&1 &
done
wait
tail -n 3 ${OUTDIR:-ml/data/out}/*.log

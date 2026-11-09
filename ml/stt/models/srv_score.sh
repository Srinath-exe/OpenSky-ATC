#!/usr/bin/env bash
# Score the server-class candidates (ml/stt/models/SERVER.md) with bench2's scorer, after de-duplicating rows by wav
# (keep the last; two writers once appended to the same file). Copies go to $D, so the scorer's names are unchanged.
#   bash ml/stt/models/srv_score.sh <clipdir> <summary.json> <results.jsonl ...> [--combo "a+b,a>b"]
set -euo pipefail
cd "$(dirname "$0")/../../.."
dir=$1 out=$2; shift 2
D=${SRV_DEDUP:-ml/stt/models/.dedup}; rm -rf "$D"; mkdir -p "$D"
files=(); extra=()
while [ $# -gt 0 ]; do
  f=$1; shift
  if [[ $f == --* ]]; then extra+=("$f" "$1"); shift; continue; fi
  b=$(basename "$f")
  python3 -c 'import json,sys
rows={}
for l in open(sys.argv[1]):
    l=l.strip()
    if l: r=json.loads(l); rows[r["wav"]]=l
open(sys.argv[2],"w").write("\n".join(rows.values())+"\n")' "$f" "$D/$b"
  files+=("$D/$b")
done
S1_MODEL=2m-grpo-v1 bash ml/stt/bench2/run.sh score "$dir" "${files[@]}" "${extra[@]}" --every 2 --out "$out"

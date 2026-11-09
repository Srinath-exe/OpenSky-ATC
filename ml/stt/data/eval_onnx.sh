#!/usr/bin/env bash
# Score an exported Parakeet (int8 ONNX dir) in the game's own runtime (sherpa-onnx-node via engine.ts) against today's
# model: the owner's gold recordings (with the callsigns as hotwords, as in the game) and the ATCO2 1 h test set.
#   bash ml/stt/data/eval_onnx.sh <onnx_dir> <out_dir>
set -euo pipefail
cd "$(dirname "$0")/../../.."
D=$(realpath "$1"); O=$2; mkdir -p "$O"
[ -f .tmp/stt/src/app/api/voice/stt/engine.js ] || bash ml/stt/bench2/run.sh build
python3 - "$O" <<'PY'
import json, sys
O = sys.argv[1]
with open(f"{O}/gold_list.jsonl", "w") as f:
    for i, r in enumerate(map(json.loads, open("ml/data/stt/manifests/test_gold.jsonl"))):
        f.write(json.dumps({"id": f"g{i:02d}", "wav": r["audio_filepath"], "ctx": r["ctx"] or "", "text": r["text"], "line": r["line"], "icao": r["icao"]}) + "\n")
with open(f"{O}/atco2_list.jsonl", "w") as f:
    for r in map(json.loads, open("ml/data/stt/manifests/test_atco2.jsonl")):
        f.write(json.dumps({"id": r["audio_filepath"].rsplit("/", 1)[-1][:-4], "wav": r["audio_filepath"], "text": r["text"]}) + "\n")
PY
for set in gold atco2; do
  names=$([ $set = gold ] && echo --names || true)
  node ml/stt/data/check.cjs $O/${set}_list.jsonl $O/${set}_base.jsonl $names 2>&1 | tail -1
  OPENATC_STT_PARAKEET_DIR=$D node ml/stt/data/check.cjs $O/${set}_list.jsonl $O/${set}_tuned.jsonl $names 2>&1 | tail -1
done
ml/stt/.venv/bin/python - "$O" <<'PY'
import json, sys
sys.path.insert(0, "ml/stt/data"); from wer import wer_num
O = sys.argv[1]; res = {}
for s in ("gold", "atco2"):
    L = {r["id"]: r for r in map(json.loads, open(f"{O}/{s}_list.jsonl"))}
    for tag in ("base", "tuned"):
        H = {r["id"]: r.get("heard") or "" for r in map(json.loads, open(f"{O}/{s}_{tag}.jsonl"))}
        e = w = 0
        for k, r in L.items():
            if not r.get("text"): continue
            n = len(r["text"].split()); e += wer_num(r["text"], H.get(k, "")) * n; w += n
        res.setdefault(s, {})[tag] = round(e / w, 4)
json.dump(res, open(f"{O}/wer.json", "w"), indent=1); print(json.dumps(res))
PY

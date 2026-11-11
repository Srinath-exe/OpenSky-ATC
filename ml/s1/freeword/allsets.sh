#!/usr/bin/env bash
# Every free-wording exam through the game's chain with one command model: prints one summary line per set.
#   bash ml/s1/freeword/allsets.sh [public/models/s1/<name>]
cd "$(dirname "$0")/../../.."
M=${1:-public/models/s1/2m-grpo-v1}
export OMP_NUM_THREADS=1
python3 - "$M" <<'PY'
import json, subprocess, sys, collections
M = sys.argv[1]
sets = {"first": "ml/s1/freeword/rows.json", "held": "ml/s1/freeword/held.json", "indep": "ml/s1/freeword/indep.json",
        "stress": "ml/s1/freeword/stress.json", "e2e": "ml/s1/freeword/e2e.json", "stt_cov": "ml/s1/freeword/stt_cov.json",
        "gold": "/tmp/claude-0/-root-atc/fa3a93e9-08da-451c-86ae-c9816b78a7de/scratchpad/edge/gold_rows.json"}
res = {}
for name, f in sets.items():
    try: rows = json.load(open(f))
    except FileNotFoundError: continue
    r = subprocess.run(["node", ".tmp/gold/ml/stt/gold_chain.js", "chain", f, M], capture_output=True, text=True)
    out = {x["key"]: x for x in json.loads(r.stdout)}
    c = collections.Counter(); per = []
    for row in rows:
        x = out[row["key"]]; ch = x["chain"]; neg = row["line"] == "SAY AGAIN"
        if neg:
            ok = ch["decision"] != "sent" or (row.get("style") == "question_not_command" and ch["line"].split(" ", 1)[-1].startswith("Report"))
            c["neg"] += 1; c["neg_ok"] += ok; c["wrong"] += not ok
        else:
            c["cmd"] += 1
            if ch["decision"] == "sent": c["right" if ch["same"] else "wrong"] += 1
            elif ch["decision"] == "check" and ch["same"]: c["held_right"] += 1
            else: c["missed"] += 1
        per.append({"key": row["key"], "style": row.get("style"), "decision": ch["decision"], "same": ch["same"], "line": ch["line"], "want": row["line"]})
    res[name] = {"counts": dict(c), "rows": per}
    print(f"{name:8} commands {c['right']:3}/{c['cmd']:<3} right, {c['held_right']:2} held-right, {c['missed']:2} missed | non-commands refused {c['neg_ok']}/{c['neg']} | SENT WRONG {c['wrong']}", flush=True)
tag = M.rstrip("/").split("/")[-1]
json.dump(res, open(f"ml/s1/freeword/all.{tag}.json", "w"))
PY

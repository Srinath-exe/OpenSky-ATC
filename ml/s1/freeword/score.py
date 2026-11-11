"""Run the free-wording set through the game's own chain (ml/stt/gold_chain.ts) and print what happened per style.
    python3 ml/s1/freeword/score.py [rows.json] [--model public/models/s1/2m-grpo-v1]"""
import json, subprocess, sys, collections
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
rows_file = next((a for a in sys.argv[1:] if a.endswith(".json")), str(Path(__file__).parent / "rows.json"))
model = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else "public/models/s1/2m-grpo-v1"
rows = json.loads(Path(rows_file).read_text())
r = subprocess.run(["node", ".tmp/gold/ml/stt/gold_chain.js", "chain", rows_file, model], capture_output=True, text=True, cwd=ROOT)
if r.returncode: sys.exit(r.stderr[-2000:])
out = {x["key"]: x for x in json.loads(r.stdout)}
T = collections.defaultdict(lambda: collections.Counter()); detail = []
for row in rows:
    x = out[row["key"]]; ch = x["chain"]; neg = row["line"] == "SAY AGAIN"
    if not x["gold_ok"]: res = "badgold"
    elif ch["decision"] == "sent": res = "sent_right" if ch["same"] else "sent_wrong"
    elif ch["decision"] == "check": res = "held_right" if ch["same"] and not neg else "held"
    else: res = "not_understood"
    if neg and res in ("held", "not_understood"): res = "refused_ok"
    T[row["style"]][res] += 1; T["all"][res] += 1
    T[row["style"]]["rules_right"] += bool(x["l0"]["same"]) and not neg; T["all"]["rules_right"] += bool(x["l0"]["same"]) and not neg
    T[row["style"]]["model_right"] += bool(x["model"]["same"]) and not neg; T["all"]["model_right"] += bool(x["model"]["same"]) and not neg
    detail.append({**{k: row[k] for k in ("key", "style", "kind", "heard", "line")}, "result": res, "source": ch["source"], "got": ch["line"], "rules": x["l0"]["same"], "model": x["model"]["line"], "model_same": x["model"]["same"]})
cols = ["sent_right", "held_right", "sent_wrong", "held", "not_understood", "refused_ok", "badgold", "rules_right", "model_right"]
print(f"{'style':8}{'n':>5}" + "".join(f"{c:>16}" for c in cols))
for s in ("plain", "terse", "other", "multi", "chat", "all"):
    n = sum(v for k, v in T[s].items() if k not in ("rules_right", "model_right"))
    print(f"{s:8}{n:>5}" + "".join(f"{T[s][c]:>16}" for c in cols))
Path(rows_file).with_name(Path(rows_file).stem.replace("rows", "result") + ("" if "rows" in Path(rows_file).stem else ".result") + ".json").write_text(json.dumps({"table": {s: dict(T[s]) for s in T}, "rows": detail}, indent=1))

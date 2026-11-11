"""The independent exam: lines written by a separate author who never saw the training templates or the other test
sets (indep_src.json), joined with the gold prompts' situations.  python3 ml/s1/freeword/indep.py -> indep.json"""
import json, re
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; D = Path(__file__).parent
P = {p["id"]: p for p in json.loads((ROOT / "public/voice/gold-prompts.json").read_text())["prompts"]}
src = json.loads((D / "indep_src.json").read_text())
clean = lambda s: re.sub(r"\s+", " ", re.sub(r"[^a-z0-9' ]", " ", s.lower())).strip()
rows = []
for i, x in enumerate(src["commands"]):
    p = P.get(x["id"])
    if not p or p["line"] == "SAY AGAIN": continue
    rows.append({"key": f"i{i}", "style": "plain", "kind": p["kind"], "heard": clean(x["said"]), "ctx": p["ctx"], "line": p["line"], "icao": p["icao"]})
for i, x in enumerate(src["chat"]):
    p = P.get(x["id"])
    if p: rows.append({"key": f"ic{i}", "style": "chat", "kind": "chat", "heard": clean(x["said"]), "ctx": p["ctx"], "line": "SAY AGAIN", "icao": p["icao"]})
(D / "indep.json").write_text(json.dumps(rows, indent=1)); print(len(rows), "rows")

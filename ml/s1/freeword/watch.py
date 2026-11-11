"""Score every checkpoint of a running command-model fine-tune as it is saved, against the shipped model, through the
game's own chain. Writes ml/s1/freeword/candidates.json and prints one line per checkpoint. CPU, 1 thread.
    python3 ml/s1/freeword/watch.py ml/rl/runs/plain-v1 [--once]

Gate for a candidate to ship (checked again after the verifier refit):
  - free wording, independent exam: more commands sent right than the shipped model;
  - sent wrong does not rise on ANY set (independent exam, held-out, first set, the owner's recordings);
  - the owner's recordings: every command the shipped chain sends right is still sent right;
  - standard phraseology (model alone, from the training log): val, Sydney and recogniser transcripts within 1.5 points.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; D = Path(__file__).parent
RUN = Path(sys.argv[1]); ONCE = "--once" in sys.argv
BASE_RUN = ROOT / "ml/rl/runs/grpo-exact"
GOLD = Path("/tmp/claude-0/-root-atc/fa3a93e9-08da-451c-86ae-c9816b78a7de/scratchpad/edge/gold_rows.json")
SETS = {"indep": D / "indep.json", "stress": D / "stress.json", "held": D / "held.json", "first": D / "rows.json", "gold": GOLD}
OUT = D / f"candidates.{RUN.name}.json"
SHARED_BASE = D / "candidates.json"   # the shipped model's scores, shared by all runs
env = dict(os.environ, OMP_NUM_THREADS="1")


def score(rows_file, model_dir):
    r = subprocess.run(["node", ".tmp/gold/ml/stt/gold_chain.js", "chain", str(rows_file), str(model_dir)], capture_output=True, text=True, cwd=ROOT, env=env)
    if r.returncode: raise RuntimeError(r.stderr[-800:])
    out = {x["key"]: x for x in json.loads(r.stdout)}
    rows = json.loads(Path(rows_file).read_text()); t = {"n": 0, "right": 0, "wrong": 0, "neg_sent": 0}; right_keys = []
    for row in rows:
        x = out[row["key"]]; ch = x["chain"]; neg = row["line"] == "SAY AGAIN"
        if neg: t["neg_sent"] += ch["decision"] == "sent"; continue
        t["n"] += 1
        if ch["decision"] == "sent":
            if ch["same"]: t["right"] += 1; right_keys.append(row["key"])
            else: t["wrong"] += 1
    t["right_keys"] = right_keys
    return t


def log_val(step):
    best = None
    for l in open(ROOT / "ml/rl/runs" / f"{RUN.name}.log"):
        if l.startswith("{") and '"val"' in l:
            j = json.loads(l)
            if j["step"] <= step: best = j
    return {k: best[k]["exact"] for k in ("val", "sydney", "stt")} if best else None


def evaluate(tag, model_dir, step):
    res = {"tag": tag, "step": step, "sets": {k: score(v, model_dir) for k, v in SETS.items() if v.exists()}, "std": log_val(step) if step is not None else None}
    return res


def gate(c, b):
    why = []
    s, bs = c["sets"], b["sets"]
    if s["indep"]["right"] <= bs["indep"]["right"]: why.append(f"exam right {s['indep']['right']} <= {bs['indep']['right']}")
    for k in s:
        if s[k]["wrong"] > bs[k]["wrong"]: why.append(f"{k} wrong {s[k]['wrong']} > {bs[k]['wrong']}")
        if s[k]["neg_sent"] > bs[k]["neg_sent"]: why.append(f"{k} non-commands sent {s[k]['neg_sent']} > {bs[k]['neg_sent']}")
    lost = set(bs["gold"]["right_keys"]) - set(s["gold"]["right_keys"])
    if lost: why.append(f"owner recordings lost {sorted(lost)}")
    if c["std"] and b["std"]:
        for k in ("val", "sydney", "stt"):
            if c["std"][k] < b["std"][k] - 0.015: why.append(f"standard {k} {c['std'][k]} < {b['std'][k]}")
    return why


def line(c):
    s = c["sets"]
    return " | ".join(f"{k} {v['right']}/{v['n']} wrong {v['wrong']}" + (f" chat-sent {v['neg_sent']}" if v["neg_sent"] else "") for k, v in s.items()) + (f" | std {c['std']}" if c["std"] else "")


def main():
    state = json.loads(OUT.read_text()) if OUT.exists() else {}
    if "base" not in state and SHARED_BASE.exists():
        state = {"base": json.loads(SHARED_BASE.read_text())["base"], "candidates": []}
    if "base" not in state:
        state["base"] = evaluate("2m-grpo-v1 (shipped)", ROOT / "public/models/s1/2m-grpo-v1", None)
        state["base"]["std"] = log_val(0)
        state["candidates"] = []
        OUT.write_text(json.dumps(state, indent=1))
    print("base   ", line(state["base"]), flush=True)
    seen = {c["step"] for c in state["candidates"]}
    while True:
        ck = RUN / "model.pt"
        done = (RUN / "done.json").exists()
        step = None
        if ck.exists():
            steps = [json.loads(l)["step"] for l in open(RUN / "metrics.jsonl") if '"val"' in l]
            step = steps[-1] if steps else None
        if step and step not in seen and time.time() - ck.stat().st_mtime > 20:
            snap = ROOT / "ml/rl/runs" / f"{RUN.name}-s{step}"; snap.mkdir(exist_ok=True)
            shutil.copy(ck, snap / "model.pt"); shutil.copy((RUN / "config.json") if (RUN / "config.json").exists() else BASE_RUN / "config.json", snap / "config.json")
            name = f"s1-cand/{RUN.name}-s{step}"
            subprocess.run([str(ROOT / "ml/.venv/bin/python"), "ml/edge/export_web.py", "--run", str(snap), "--name", name, "--int8"], cwd=ROOT, env=env, capture_output=True, check=True)
            c = evaluate(f"{RUN.name}-s{step}", ROOT / "public/models" / name, step)
            c["gate"] = gate(c, state["base"]); c["pass"] = not c["gate"]
            state["candidates"].append(c); seen.add(step); OUT.write_text(json.dumps(state, indent=1))
            print(f"s{step:<6}", line(c), "| PASS" if c["pass"] else f"| no: {'; '.join(c['gate'])}", flush=True)
        if ONCE or (done and step in seen): break
        time.sleep(60)


if __name__ == "__main__":
    main()

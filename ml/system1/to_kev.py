"""Convert our ATC examples into Kev's fine-tune format (one System One request per line, with labels).

Same two questions as the bake-off (ml/system1/bench_all.py), so the fine-tuned model is scored like-for-like:
  aircraft     choice over the aircraft in the state (label = gold callsign)
  instruction  choice over 14 instruction kinds    (label = gold kind)

    python3 ml/system1/to_kev.py --data ml/data/out/ds --out ml/system1/out/kev-data --train 8000 --heldout 300
"""
import argparse, json, random, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_all import build, GOLD  # noqa: E402  (bench_all imports torch lazily inside adapters only)


def convert(ex):
    state, qs = build(ex)
    gold_cs = ex["line"].split()[0]
    if gold_cs not in qs["aircraft"]["criteria"]:
        return None
    qs["aircraft"]["label"] = gold_cs
    qs["instruction"]["label"] = GOLD[ex["kind"].split("+")[0]]
    return {"state": state, "questions": qs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/data/out/ds"); ap.add_argument("--out", default="ml/system1/out/kev-data")
    ap.add_argument("--train", type=int, default=8000); ap.add_argument("--heldout", type=int, default=300); ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    keep = lambda r: r["line"] != "SAY AGAIN" and GOLD.get(r["kind"].split("+")[0])
    tr = [json.loads(l) for l in open(Path(a.data) / "train.jsonl")]
    random.Random(a.seed).shuffle(tr)
    rows = [c for c in (convert(r) for r in tr if keep(r)) if c][: a.train]
    # held-out = validation rows AFTER the 100 the bake-off scores (same shuffle), so the bake-off set stays untouched
    va = [json.loads(l) for l in open(Path(a.data) / "val.jsonl")]
    random.Random(a.seed).shuffle(va)
    va = [r for r in va if keep(r)]
    held = [c for c in (convert(r) for r in va[100:100 + a.heldout]) if c]
    for name, data in (("train.jsonl", rows), ("heldout.jsonl", held)):
        with open(out / name, "w") as f:
            for r in data:
                f.write(json.dumps(r) + "\n")
    print(json.dumps({"train": len(rows), "heldout": len(held), "out": str(out)}))


if __name__ == "__main__":
    main()

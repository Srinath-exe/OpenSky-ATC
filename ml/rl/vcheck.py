"""How good is the label-free verifier as a judge? Checked against labels, never trained on.

  1. ranking: gold line vs another real command for the same state (val, first 3000 rows): how often gold scores higher
  2. on the start model's own predictions (fixed eval sets): AUC of the verifier score for "prediction is exactly right"

    python3 ml/rl/vcheck.py      -> ml/rl/runs/verifier_check.json
"""
import collections, json, random
from common import *  # noqa: F403
import rewards as R


def auc(pos, neg):
    if not pos or not neg:
        return None
    s = sorted([(x, 1) for x in pos] + [(x, 0) for x in neg])
    rank, i, r_pos = 1, 0, 0.0
    while i < len(s):
        j = i
        while j < len(s) and s[j][0] == s[i][0]:
            j += 1
        avg = (rank + rank + (j - i) - 1) / 2
        r_pos += avg * sum(1 for k in range(i, j) if s[k][1])
        rank += j - i; i = j
    return (r_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def main():
    threads(1)
    tok = BPE.load(TOK); eng = Engine(); rng = random.Random(0)
    rows = [json.loads(l) for l, _ in zip(open(DS / "val.jsonl"), range(3000))]
    by = collections.defaultdict(list)
    for r in rows:
        by[r["ctx"]].append(r["line"])
    alts = []
    for r in rows:
        c = [l for l in by[r["ctx"]] if norm_line(l) != norm_line(r["line"])]
        alts.append(rng.choice(c) if c else "SAY AGAIN")
    g, _ = R.score("verifier", eng, rows, [r["line"] for r in rows])
    a, _ = R.score("verifier", eng, rows, alts)
    out = {"rank_gold_over_alt": round(sum(x > y for x, y in zip(g, a)) / len(g), 4), "tie": round(sum(x == y for x, y in zip(g, a)) / len(g), 4), "n": len(g),
           "gold_mean": round(sum(g) / len(g), 3), "alt_mean": round(sum(a) / len(a), 3)}
    base = json.load(open(ROOT / "ml/rl/runs/baseline/eval_full.json"))
    S = eval_sets(tok, 1000)
    for key in ("val", "sydney", "stt"):
        exs = [ex for _, _, ex in S[key]]; preds = base["preds"][key]
        sc, _ = R.score("verifier", eng, exs, preds)
        pos = [s for s, ex, p in zip(sc, exs, preds) if p == norm_line(ex["line"])]
        neg = [s for s, ex, p in zip(sc, exs, preds) if p != norm_line(ex["line"])]
        hi_wrong = [(ex["said"], ex["line"], p, round(s, 2)) for s, ex, p in zip(sc, exs, preds) if p != norm_line(ex["line"]) and s >= 0.8]
        out[key] = {"auc": round(auc(pos, neg), 3), "right_mean": round(sum(pos) / len(pos), 3), "wrong_mean": round(sum(neg) / max(1, len(neg)), 3),
                    "wrong_but_high": len(hi_wrong), "wrong": len(neg), "examples_wrong_but_high": hi_wrong[:6]}
    json.dump(out, open(ROOT / "ml/rl/runs/verifier_check.json", "w"), indent=1)
    print(json.dumps({k: (v if not isinstance(v, dict) else {kk: vv for kk, vv in v.items() if kk != "examples_wrong_but_high"}) for k, v in out.items()}))
    eng.close()


if __name__ == "__main__":
    main()

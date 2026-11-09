"""Greedy accuracy on hard TRAIN prompts that no GRPO run sampled (the last 500 of the shuffled pool order; every GRPO
run used the same order and stopped before index 4,608). Separates "the policy got sharper, so T=1 samples look better"
from "greedy decoding got better on unseen hard cases". The SFT control trained on the whole pool, so for it these
rows are not held out (reported, but marked).

    python3 ml/rl/heldout_hard.py      -> ml/rl/runs/heldout_hard.json
"""
import json, random, sys
from common import *  # noqa: F403
from grpo import load_pool


def main():
    threads(1)
    tok = BPE.load(TOK)
    pool = load_pool(ROOT / "ml/rl/runs/hard.jsonl", tok)
    order = list(range(len(pool))); random.Random(0).shuffle(order)
    rows = [pool[i] for i in order[-500:]]
    f = ROOT / "ml/rl/runs/heldout_hard.json"
    out = json.load(open(f)) if f.exists() else {}
    out |= {"n": len(rows), "noisy": sum(r[2]["noise"] for r in rows)}
    for name in sys.argv[1:] or ["baseline", "grpo-exact", "grpo-shaped", "grpo-verifier", "sft-control"]:
        ck = ROOT / "ml/rl/runs" / name / "model.pt"
        if name != "baseline" and not ck.exists():
            continue
        m, _ = load_model(START, None if name == "baseline" else torch.load(ck, map_location="cpu"))
        out[name] = evaluate(m, tok, rows)
        print(name, out[name], flush=True)
    json.dump(out, open(f, "w"), indent=1)


if __name__ == "__main__":
    main()

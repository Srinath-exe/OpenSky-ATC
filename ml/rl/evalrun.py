"""Full fixed evaluation of one checkpoint: val (n=1000), Sydney (n=1000, unseen airport), real recogniser transcripts
(n=1000 = 5 recognisers x 200 clips). Constrained greedy decoding, exact + callsign. Saves per-row predictions so runs
can be compared row by row (examples fixed / broken).

    python3 ml/rl/evalrun.py --run ml/gpu/results/s1-2m-11ap-swap --out ml/rl/runs/baseline/eval_full.json
"""
import argparse, json
from common import *  # noqa: F403


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=str(START)); ap.add_argument("--ckpt", default=None); ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=1); ap.add_argument("--n", type=int, default=1000)
    a = ap.parse_args()
    threads(a.threads)
    tok = BPE.load(TOK)
    sd = torch.load(a.ckpt, map_location="cpu") if a.ckpt else None
    model, _ = load_model(a.run, sd)
    S = eval_sets(tok, a.n)
    res, preds = {}, {}
    for name, rows in S.items():
        r, p = evaluate(model, tok, rows, keep=True)
        res[name] = r; preds[name] = p
        print(name, json.dumps(r), flush=True)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump({"scores": res, "preds": preds}, open(a.out, "w"))


if __name__ == "__main__":
    main()

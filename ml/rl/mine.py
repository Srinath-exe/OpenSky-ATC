"""Mine hard prompts from TRAIN only (never val / Sydney / the recogniser transcripts).

Teacher-forced pass of the start model over a random slice of train, plus a noisy copy of each row (ml/rl/noise.py).
For every target token: margin = gold logit - best other logit (the callsign trie is not applied here, so this is a
conservative estimate). A row is "hard" when the smallest margin over its target tokens is < --margin: greedy is
either wrong (margin < 0) or barely right. Rows whose gold sequence is nearly impossible under the model (log-prob
< --floor) are kept for SFT but flagged, since sampling k=8 will never find them.

    python3 ml/rl/mine.py --n 24000 --out ml/rl/runs/hard.jsonl
"""
import argparse, json, random, time
from common import *  # noqa: F403
from noise import noisy


@torch.no_grad()
def score(model, rows, bs=32, pad=0):
    out = []
    for i in range(0, len(rows), bs):
        chunk = rows[i:i + bs]
        T = max(len(p) + len(t) for p, t, _ in chunk)
        x = torch.full((len(chunk), T), pad, dtype=torch.long)
        for b, (p, t, _) in enumerate(chunk):
            x[b, :len(p) + len(t)] = torch.tensor(p + t)
        logits = model(x)
        for b, (p, t, _) in enumerate(chunk):
            lg = logits[b, len(p) - 1:len(p) - 1 + len(t)]                   # predicts each target token
            gold = lg.gather(-1, torch.tensor(t)[:, None])[:, 0]
            other = lg.clone(); other[torch.arange(len(t)), torch.tensor(t)] = float("-inf")
            margin = gold - other.max(-1).values
            lp = torch.log_softmax(lg, -1).gather(-1, torch.tensor(t)[:, None])[:, 0]
            out.append((float(margin.min()), float(lp.sum())))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=24000); ap.add_argument("--margin", type=float, default=2.0); ap.add_argument("--floor", type=float, default=-15.0)
    ap.add_argument("--out", default=str(ROOT / "ml/rl/runs/hard.jsonl")); ap.add_argument("--threads", type=int, default=3); ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    threads(a.threads)
    tok = BPE.load(TOK); model, _ = load_model()
    rng = random.Random(a.seed)
    lines = open(DS / "train.jsonl").readlines()
    pick = rng.sample(range(len(lines)), a.n)
    raw = [json.loads(lines[i]) for i in pick]
    rows = []
    for ex in raw:
        rows.append(encode_ex(tok, dict(ex, noise=0)))
        nz = noisy(ex["said"], rng)
        if nz != ex["said"]:
            rows.append(encode_ex(tok, dict(ex, said=nz, noise=1)))
    t0 = time.time()
    rows.sort(key=lambda r: len(r[0]) + len(r[1]))                             # similar lengths per batch: less padding
    sc = score(model, rows)
    stats = {"scored": len(rows), "s": round(time.time() - t0)}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    n_hard = n_wrong = n_floor = 0
    with open(a.out, "w") as f:
        for (p, t, ex), (mg, lp) in zip(rows, sc):
            if mg < a.margin:
                n_hard += 1; n_wrong += mg < 0; n_floor += lp < a.floor
                f.write(json.dumps({**ex, "margin": round(mg, 3), "gold_lp": round(lp, 3)}) + "\n")
    stats |= {"hard": n_hard, "wrong_tf": n_wrong, "below_floor": n_floor,
              "hard_clean": sum(1 for (p, t, ex), (mg, _) in zip(rows, sc) if mg < a.margin and not ex["noise"]),
              "hard_noisy": sum(1 for (p, t, ex), (mg, _) in zip(rows, sc) if mg < a.margin and ex["noise"])}
    json.dump(stats, open(Path(a.out).with_suffix(".stats.json"), "w"), indent=1)
    print(json.dumps(stats))


if __name__ == "__main__":
    main()

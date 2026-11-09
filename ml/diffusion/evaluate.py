"""Accuracy grid for a trained diffusion LM: steps S x callsign constraint x schedule, on the fixed val and Sydney sets.

    python ml/diffusion/evaluate.py --run ml/diffusion/runs/dlm --n 1000 --threads 3

Sets: the first n rows of the same shuffled 2000-row lists ml/s1/train.py evaluates (seed 0), so AR eval.json numbers
are on the same examples. Writes <run>/grid.json and <run>/examples.json (a decoding trace for the report).
"""
import argparse, json, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / "s1")); sys.path.insert(0, str(HERE.parent / "tokenizer"))
import dlm  # noqa: E402
import torch  # noqa: E402
from bpe import BPE  # noqa: E402
from model import Config  # noqa: E402
from train import norm_line  # noqa: E402
from denoise import Vocab, denoise, denoise_cached, prefill_ctx, callsigns_of  # noqa: E402
from train_dlm import eval_sets  # noqa: E402


def lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def snap(line: str, callsigns) -> str:
    """Post-hoc constraint: a first word that is not a callsign in the state becomes the nearest one that is."""
    w = line.split()
    if not w or w[0] in callsigns or line == "SAY AGAIN" or not callsigns:
        return line
    best = min(callsigns, key=lambda c: lev(w[0], c))
    return " ".join([best] + w[1:])


def load(run):
    cfg = json.load(open(Path(run) / "config.json"))
    m = dlm.DLM(Config(**cfg["model"])); m.load_state_dict(torch.load(Path(run) / "model.pt", map_location="cpu")); m.eval()
    return m, cfg


def tally(preds, rows):
    hit = cs = 0
    for pred, (_, _, ex) in zip(preds, rows):
        gold = norm_line(ex["line"])
        hit += pred == gold; cs += pred.split()[:1] == gold.split()[:1]
    return {"exact": round(hit / len(rows), 4), "callsign": round(cs / len(rows), 4), "n": len(rows)}


def run_batched(model, vb, tok, rows, L, S, constraint, tau=None, bs=50):
    preds, nfes = [], []
    for i in range(0, len(rows), bs):
        chunk = rows[i:i + bs]
        cs = [callsigns_of(ex["ctx"]) for _, _, ex in chunk]
        outs, nfe, _ = denoise(model, vb, [p for p, _, _ in chunk], L, S, cs, "none" if constraint == "snap" else constraint, tau)
        for o, c in zip(outs, cs):
            p = norm_line(tok.decode(o))
            preds.append(snap(p, c) if constraint == "snap" else p)
        nfes += nfe
    r = tally(preds, rows); r["nfe"] = round(sum(nfes) / len(nfes), 2)
    return r, preds


def run_cached(model, vb, tok, rows, L, S, constraint, mode, tau=None):
    preds, nfes = [], []
    for prompt, _, ex in rows:
        cs = callsigns_of(ex["ctx"])
        ctx_ids = tok.encode("<ctx>" + ex["ctx"]); n_ctx = len(ctx_ids) if prompt[:len(ctx_ids)] == ctx_ids else 0
        if mode == "ctx" and n_ctx == 0:                  # context was truncated to fit: cache the prompt part we have
            n_ctx = prompt.index(tok.special["<said>"])
        kv = prefill_ctx(model, prompt[:n_ctx]) if mode == "ctx" else None
        o, nfe = denoise_cached(model, vb, prompt, L, S, cs, constraint, tau, mode, kv, n_ctx)
        preds.append(norm_line(tok.decode(o))); nfes.append(nfe)
    r = tally(preds, rows); r["nfe"] = round(sum(nfes) / len(nfes), 2)
    return r, preds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--n", type=int, default=1000); ap.add_argument("--n-cache", type=int, default=500)
    ap.add_argument("--threads", type=int, default=3); ap.add_argument("--full", action="store_true"); ap.add_argument("--only", nargs="*", default=None, help="e.g. span:8 none:8")
    ap.add_argument("--cache", action="store_true"); ap.add_argument("--cache-S", type=int, nargs="*", default=[4, 8, 24]); ap.add_argument("--taus", type=float, nargs="*", default=[0.9])
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    model, cfg = load(a.run)
    tok = BPE.load(cfg["args"]["tok"]); vb = Vocab(tok, model.mask_id); L = cfg["args"]["L"]
    val, test = eval_sets(tok, cfg["args"]["data"], cfg["args"]["max_len"])
    sets = {"val": val[:a.n], "sydney": test[:a.n]}
    Ss = [1, 2, 4, 8, L]
    grid = {"L": L, "n": a.n, "fixed": {}, "threshold": {}, "cache": {}, "too_long": {}}
    for name, rows in sets.items():
        grid["too_long"][name] = sum(len(tok.encode(" " + ex["line"])) >= L for _, _, ex in rows)
    t0 = time.time()
    plan = [("span", S) for S in Ss] + [("none", 8), ("first", 8)]      # snap comes free from "none"
    if a.full:
        plan += [("none", S) for S in Ss if S != 8]
    if a.only:
        plan = [(x.split(":")[0], int(x.split(":")[1])) for x in a.only]
    for name, rows in sets.items():
        for cons, S in plan:
            r, preds = run_batched(model, vb, tok, rows, L, S, cons)
            grid["fixed"][f"{name}|{cons}|{S}"] = r
            print(name, cons, S, r, f"{time.time() - t0:.0f}s", flush=True)
            if cons == "none":                            # snap = post-processing of the unconstrained outputs
                sn = [snap(p, callsigns_of(ex["ctx"])) for p, (_, _, ex) in zip(preds, rows)]
                rs = tally(sn, rows); rs["nfe"] = r["nfe"]
                grid["fixed"][f"{name}|snap|{S}"] = rs
        for tau in a.taus:
            r, _ = run_batched(model, vb, tok, rows, L, None, "span", tau)
            grid["threshold"][f"{name}|span|{tau}"] = r
            print(name, "tau", tau, r, flush=True)
    if a.cache:                                           # prompt-cache approximations (one example at a time)
        grid["n_cache"] = a.n_cache
        for name, rows in sets.items():
            rows = rows[:a.n_cache]
            for mode in ("prompt", "ctx"):
                for S in a.cache_S:
                    r, _ = run_cached(model, vb, tok, rows, L, S, "span", mode)
                    grid["cache"][f"{name}|{mode}|{S}"] = r
                    print(name, mode, S, r, f"{time.time() - t0:.0f}s", flush=True)
            r, _ = run_batched(model, vb, tok, rows, L, 8, "span")
            grid["cache"][f"{name}|exact|8"] = r
    json.dump(grid, open(Path(a.run) / "grid.json", "w"), indent=1)
    # decoding traces for the report: a few val examples at S = L and S = 4, constraint none
    traces = []
    for prompt, _, ex in val[:24]:
        for S in (L, 4):
            outs, nfe, tr = denoise(model, vb, [prompt], L, S, [callsigns_of(ex["ctx"])], "none", trace=True)
            traces.append({"said": ex["said"], "gold": ex["line"], "pred": tok.decode(outs[0]), "S": S, "nfe": nfe[0], "kind": ex["kind"],
                           "steps": [{"committed": s["committed"], "canvas": [None if t is None else tok.decode([t]) for t in s["canvas"]]} for s in tr]})
    json.dump(traces, open(Path(a.run) / "examples.json", "w"), indent=1)
    print("grid written", time.time() - t0)


if __name__ == "__main__":
    main()

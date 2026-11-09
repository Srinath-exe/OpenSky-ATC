"""Train the masked diffusion LM (MDLM / LLaDA objective) on the S1 data (ml/README.md module 8).

Per example:  t ~ U(0, 1)  (stratified across the batch, so every batch covers light and heavy masking)
              mask each answer-canvas token with probability t          (forward / noising process)
              loss = (1 / t) * sum over masked positions of cross-entropy / L
Why 1/t: the masked-diffusion ELBO (evidence lower bound: a bound on log p(answer) that can be optimised) integrates
the reconstruction error over all noise levels t. At small t only a few tokens are masked, so each one is weighted up;
the weighted sum is an upper bound on the answer's negative log-likelihood (MDLM, Sahoo et al. 2024; LLaDA 2025).

    python ml/diffusion/train_dlm.py --out ml/diffusion/runs/dlm --steps 3000 --batch 32 --threads 1
    python ml/diffusion/train_dlm.py --out ml/diffusion/runs/dlm-arinit --init-ar ml/gpu/results/s1-2m-11ap-swap/model.pt ...
"""
import argparse, json, math, os, random, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / "s1")); sys.path.insert(0, str(HERE.parent / "tokenizer"))
import dlm  # noqa: E402  (imports compat before torch)
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from bpe import BPE  # noqa: E402
from model import Config  # noqa: E402
from train import encode_file, norm_line  # noqa: E402  (ml/s1/train.py: identical eval rows)
from denoise import Vocab, denoise, callsigns_of  # noqa: E402

ROOT = HERE.parents[1]


def encode_train(tok, path, L, max_total, cache_path):
    """Prompts as one flat int16 array + offsets, answers as (N, L) canvases; cached on disk (both runs share it)."""
    if cache_path.exists():
        z = np.load(cache_path)
        return z["flat"], z["off"], z["ans"], int(z["dropped"])
    eos = tok.special["<eos>"]
    flat, off, ans, dropped = [], [0], [], 0
    for line in open(path):
        ex = json.loads(line)
        tgt = tok.encode(" " + ex["line"])
        if len(tgt) >= L:                          # does not fit the canvas with its <eos> (0.3% of lines)
            dropped += 1; continue
        said = tok.encode("<said> " + ex["said"] + "<cmd>")
        ctx_lines = ex["ctx"].split("\n")
        while True:
            ctx = tok.encode("<ctx>" + "\n".join(ctx_lines))
            if len(ctx) + len(said) + L <= max_total or len(ctx_lines) <= 2:
                break
            ctx_lines = ctx_lines[:-1]
        p = ctx + said
        flat.extend(p); off.append(len(flat)); ans.append(tgt + [eos] * (L - len(tgt)))
    flat, off, ans = np.array(flat, np.int16), np.array(off, np.int64), np.array(ans, np.int16)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(cache_path, flat=flat, off=off, ans=ans, dropped=dropped)
    return flat, off, ans, dropped


def eval_sets(tok, data, max_len, seed=0):
    """The same 2000-row val / test_airport lists, shuffled the same way, as ml/s1/train.py (so n=1000 sets match)."""
    rng = random.Random(seed)
    val = encode_file(tok, Path(data) / "val.jsonl", max_len, 2000)
    test = encode_file(tok, Path(data) / "test_airport.jsonl", max_len, 2000)
    rng.shuffle(val); rng.shuffle(test)
    return val, test


def score(model, vb, tok, rows, L, S, constraint, n, bs=50, tau=None):
    hit = cs_hit = 0; nfe_tot = 0
    rows = rows[:n]
    for i in range(0, len(rows), bs):
        chunk = rows[i:i + bs]
        outs, nfe, _ = denoise(model, vb, [p for p, _, _ in chunk], L, S, [callsigns_of(ex["ctx"]) for _, _, ex in chunk], constraint, tau)
        for o, (_, _, ex) in zip(outs, chunk):
            pred, gold = norm_line(tok.decode(o)), norm_line(ex["line"])
            hit += pred == gold; cs_hit += pred.split()[:1] == gold.split()[:1]
        nfe_tot += sum(nfe)
    k = len(rows)
    return {"exact": round(hit / k, 4), "callsign": round(cs_hit / k, 4), "nfe": round(nfe_tot / k, 2), "n": k}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "ml/data/out4/ds")); ap.add_argument("--tok", default=str(ROOT / "ml/tokenizer/atc.json"))
    ap.add_argument("--out", required=True); ap.add_argument("--init-ar", default=None)
    ap.add_argument("--d", type=int, default=192); ap.add_argument("--layers", type=int, default=4); ap.add_argument("--heads", type=int, default=6)
    ap.add_argument("--L", type=int, default=24); ap.add_argument("--max-len", type=int, default=448)
    ap.add_argument("--steps", type=int, default=3000); ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-3); ap.add_argument("--warmup", type=int, default=100); ap.add_argument("--wd", type=float, default=0.1)
    ap.add_argument("--eval-every", type=int, default=500); ap.add_argument("--eval-n", type=int, default=200); ap.add_argument("--eval-S", type=int, default=8)
    ap.add_argument("--threads", type=int, default=1); ap.add_argument("--seed", type=int, default=0); ap.add_argument("--eps", type=float, default=1e-3)
    ap.add_argument("--max-time", type=float, default=None, help="stop (and save) after this many seconds")
    ap.add_argument("--limit", type=int, default=None, help="train on the first N rows only (overfit sanity check)")
    ap.add_argument("--weight", default="elbo", choices=["elbo", "mean"], help="elbo: (1/t) * sum CE / L per example (MDLM/LLaDA); mean: plain mean CE over all masked tokens in the batch (lower variance, not an ELBO)")
    a = ap.parse_args()
    torch.manual_seed(a.seed); torch.set_num_threads(a.threads)
    rng = np.random.default_rng(a.seed)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    tok = BPE.load(a.tok)
    t0 = time.time()
    flat, off, ans, dropped = encode_train(tok, Path(a.data) / "train.jsonl", a.L, a.max_len + a.L, HERE / f"cache/train_L{a.L}.npz")
    val, test = eval_sets(tok, a.data, a.max_len, a.seed)
    if a.limit:
        ans = ans[:a.limit]
    N = len(ans)
    print(f"train {N} (dropped {dropped} lines longer than {a.L - 1} tokens) val {len(val)} test {len(test)} in {time.time() - t0:.0f}s", flush=True)

    c = Config(vocab=tok.size + 1, d=a.d, layers=a.layers, heads=a.heads, max_len=a.max_len + 64)
    if a.init_ar:
        model = dlm.DLM.from_ar(torch.load(a.init_ar, map_location="cpu"), c)
    else:
        model = dlm.DLM(c)
    vb = Vocab(tok, model.mask_id)
    print(f"model: {model.params() / 1e6:.3f} M parameters, init {'AR ' + a.init_ar if a.init_ar else 'random'}", flush=True)
    json.dump({"model": c.to_dict(), "args": vars(a), "params": model.params(), "train_rows": N, "dropped": dropped}, open(out / "config.json", "w"), indent=1)

    decay = [p for n, p in model.named_parameters() if p.dim() >= 2]; no_decay = [p for n, p in model.named_parameters() if p.dim() < 2]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": a.wd}, {"params": no_decay, "weight_decay": 0.0}], lr=a.lr, betas=(0.9, 0.95))
    sched = lambda s: min(1.0, (s + 1) / a.warmup) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, s / a.steps))))
    log = open(out / "metrics.jsonl", "w")
    perm, pi = rng.permutation(N), 0
    pad, L, B = tok.special["<pad>"], a.L, a.batch
    t_start, tokens = time.time(), 0
    for step in range(a.steps + 1):
        for g in opt.param_groups:
            g["lr"] = a.lr * sched(step)
        if pi + B > N:
            perm, pi = rng.permutation(N), 0
        idx = perm[pi:pi + B]; pi += B
        prompts = [flat[off[i]:off[i + 1]] for i in idx]
        T = max(len(p) for p in prompts) + L
        x = torch.full((B, T), pad, dtype=torch.long); km = torch.zeros(B, T, dtype=torch.bool)
        for b, p in enumerate(prompts):
            o = T - L - len(p); x[b, o:T - L] = torch.from_numpy(p.astype(np.int64)); km[b, o:] = True
        y = torch.from_numpy(ans[idx].astype(np.int64))                      # (B, L) clean canvas
        # forward process: stratified t in (eps, 1], then an independent mask per token
        t = (torch.rand(1) + torch.arange(B) / B) % 1.0
        t = a.eps + (1 - a.eps) * t
        m = torch.rand(B, L) < t[:, None]
        none = ~m.any(1)
        if none.any():                                                         # at least one masked token per example
            m[none, torch.randint(0, L, (int(none.sum()),))] = True
        x[:, T - L:] = torch.where(m, torch.full_like(y, model.mask_id), y)
        h = model.hidden(x, key_mask=km)
        logits = model.logits(h[:, T - L - 1:T - 1])                          # shift: position j-1 predicts canvas j
        ce = F.cross_entropy(logits.float().reshape(-1, logits.shape[-1]), y.reshape(-1), reduction="none").view(B, L)
        mf = m.float()
        if a.weight == "elbo":
            loss = ((ce * mf).sum(1) / t / L).mean()                           # ELBO-weighted
        else:
            loss = (ce * mf).sum() / mf.sum()                                  # every masked token counts the same
        opt.zero_grad(set_to_none=True); loss.backward()
        gn = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); tokens += x.numel()
        el = time.time() - t_start
        if step % 25 == 0:
            ce_m = float((ce * mf).sum().detach() / mf.sum())
            rec = {"step": step, "loss": round(loss.item(), 4), "ce_masked": round(ce_m, 4), "lr": round(opt.param_groups[0]["lr"], 6),
                   "grad_norm": round(float(gn), 3), "tok_s": round(tokens / max(el, 1e-9)), "elapsed_s": round(el)}
            print(json.dumps(rec), flush=True); log.write(json.dumps(rec) + "\n"); log.flush()
        stop = a.max_time is not None and el > a.max_time
        if step and (step % a.eval_every == 0 or step == a.steps or stop):
            model.eval()
            ev = {"step": step, "elapsed_s": round(el), "val": score(model, vb, tok, val, L, a.eval_S, "span", a.eval_n),
                  "val_none": score(model, vb, tok, val, L, a.eval_S, "none", a.eval_n)}
            model.train()
            print(json.dumps(ev), flush=True); log.write(json.dumps(ev) + "\n"); log.flush()
            torch.save(model.state_dict(), out / "model.pt")
        if stop:
            print(f"max-time reached at step {step}", flush=True)
            break
    json.dump({"steps_done": step, "train_s": round(time.time() - t_start)}, open(out / "done.json", "w"))
    print("DONE", step, round(time.time() - t_start), flush=True)


if __name__ == "__main__":
    main()

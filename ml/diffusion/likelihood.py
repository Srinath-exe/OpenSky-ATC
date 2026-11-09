"""Likelihood comparison: AR negative log-likelihood vs the diffusion ELBO bound, in nats per command (val, n rows).

AR:   -log p(line, <eos>) exactly, by the chain rule over the line tokens.
DLM:  E_t[ (1/t) * sum of CE over masked canvas positions ]  (Monte Carlo, K stratified t per example). The canvas is
      the line, <eos>, then <eos> padding, which follows from the line, so both numbers bound -log p(line) (the DLM one
      from above). This is how MDLM / LLaDA papers compare with AR models ("perplexity bound").

    python ml/diffusion/likelihood.py --ar ml/diffusion/runs/ar-matched --dlm ml/diffusion/runs/dlm --n 500
"""
import argparse, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / "s1")); sys.path.insert(0, str(HERE.parent / "tokenizer"))
import dlm  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from train_dlm import eval_sets  # noqa: E402
from evaluate import load  # noqa: E402


@torch.no_grad()
def ar_nll(model, rows, pad):
    tot = 0.0
    for p, t, _ in rows:
        x = torch.tensor([p + t])
        lg = model(x)[0, len(p) - 1:len(p) + len(t) - 1]
        tot += float(F.cross_entropy(lg.float(), torch.tensor(t), reduction="sum"))
    return tot / len(rows)


@torch.no_grad()
def dlm_elbo(model, tok, rows, L, K=8, bs=25, seed=0):
    g = torch.Generator().manual_seed(seed)
    eos, pad = tok.special["<eos>"], tok.special["<pad>"]
    tot, n = 0.0, 0
    for i in range(0, len(rows), bs):
        chunk = [r for r in rows[i:i + bs] if len(r[1]) <= L]       # r[1] = line tokens + <eos>
        B = len(chunk) * K
        T = max(len(p) for p, _, _ in chunk) + L
        x = torch.full((B, T), pad, dtype=torch.long); km = torch.zeros(B, T, dtype=torch.bool); y = torch.full((B, L), eos, dtype=torch.long)
        for b, (p, t, _) in enumerate(chunk):
            for k in range(K):
                r = b * K + k; o = T - L - len(p)
                x[r, o:T - L] = torch.tensor(p); km[r, o:] = True; y[r, :len(t)] = torch.tensor(t)
        u = torch.rand(len(chunk), 1, generator=g)
        t = ((u + torch.arange(K) / K) % 1.0).clamp_min(1e-3).reshape(-1)
        m = torch.rand(B, L, generator=g) < t[:, None]
        x[:, T - L:] = torch.where(m, torch.full_like(y, model.mask_id), y)
        lg = model.logits(model.hidden(x, key_mask=km)[:, T - L - 1:T - 1])
        ce = F.cross_entropy(lg.float().reshape(-1, lg.shape[-1]), y.reshape(-1), reduction="none").view(B, L)
        tot += float(((ce * m).sum(1) / t).sum()) / K; n += len(chunk)
    return tot / n


@torch.no_grad()
def dlm_ce_by_t(model, tok, rows, L, ts=(0.1, 0.3, 0.5, 0.7, 0.9, 1.0), bs=25, seed=0, shuffle_prompt=False):
    """Mean CE on masked canvas slots at fixed noise levels t. shuffle_prompt: pair each canvas with ANOTHER row's
    prompt; if the CE does not get worse, the model is not reading the prompt."""
    g = torch.Generator().manual_seed(seed)
    eos, pad = tok.special["<eos>"], tok.special["<pad>"]
    rows = [r for r in rows if len(r[1]) <= L]
    out = {}
    for tv in ts:
        num = den = 0.0
        for i in range(0, len(rows), bs):
            chunk = rows[i:i + bs]
            prompts = [p for p, _, _ in chunk]
            if shuffle_prompt:
                prompts = prompts[1:] + prompts[:1]
            B = len(chunk); T = max(len(p) for p in prompts) + L
            x = torch.full((B, T), pad, dtype=torch.long); km = torch.zeros(B, T, dtype=torch.bool); y = torch.full((B, L), eos, dtype=torch.long)
            for b, ((_, t, _), p) in enumerate(zip(chunk, prompts)):
                o = T - L - len(p); x[b, o:T - L] = torch.tensor(p); km[b, o:] = True; y[b, :len(t)] = torch.tensor(t)
            m = torch.rand(B, L, generator=g) < tv
            m[~m.any(1), 0] = True
            x[:, T - L:] = torch.where(m, torch.full_like(y, model.mask_id), y)
            lg = model.logits(model.hidden(x, key_mask=km)[:, T - L - 1:T - 1])
            ce = F.cross_entropy(lg.float().reshape(-1, lg.shape[-1]), y.reshape(-1), reduction="none").view(B, L)
            num += float((ce * m).sum()); den += float(m.sum())
        out[str(tv)] = round(num / den, 4)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ar", nargs="*", default=[]); ap.add_argument("--dlm", nargs="*", default=[]); ap.add_argument("--n", type=int, default=500)
    ap.add_argument("--threads", type=int, default=3); ap.add_argument("--out", default=str(HERE / "results/likelihood.json"))
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    tok = BPE.load(str(HERE.parents[1] / "ml/tokenizer/atc.json"))
    val, test = eval_sets(tok, str(HERE.parents[1] / "ml/data/out4/ds"), 448)
    res = {"n": a.n, "unit": "nats per command (line + <eos>)"}
    for run in a.ar:
        c = json.load(open(Path(run) / "config.json"))
        m = GPT(Config(**c["model"])); m.load_state_dict(torch.load(Path(run) / "model.pt", map_location="cpu")); m.eval()
        res[Path(run).name] = {"kind": "ar_nll", "val": round(ar_nll(m, val[:a.n], 0), 3), "sydney": round(ar_nll(m, test[:a.n], 0), 3)}
        print(Path(run).name, res[Path(run).name], flush=True)
    for run in a.dlm:
        m, cfg = load(run)
        L = cfg["args"]["L"]
        res[Path(run).name] = {"kind": "dlm_elbo", "val": round(dlm_elbo(m, tok, val[:a.n], L), 3), "sydney": round(dlm_elbo(m, tok, test[:a.n], L), 3),
                               "ce_by_t": dlm_ce_by_t(m, tok, val[:300], L), "ce_by_t_wrong_prompt": dlm_ce_by_t(m, tok, val[:300], L, shuffle_prompt=True)}
        print(Path(run).name, res[Path(run).name], flush=True)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()

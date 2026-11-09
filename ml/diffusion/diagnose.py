"""Small diagnostics for the report: AR-init accuracy before any diffusion training (step 0), and the random-init
model's masked CE split by slot type (end-of-line padding vs command tokens) at two masking levels.

    python ml/diffusion/diagnose.py --threads 1
"""
import argparse, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / "s1")); sys.path.insert(0, str(HERE.parent / "tokenizer"))
import dlm  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from bpe import BPE  # noqa: E402
from model import Config  # noqa: E402
from train_dlm import eval_sets, score  # noqa: E402
from evaluate import load  # noqa: E402
from denoise import Vocab  # noqa: E402


@torch.no_grad()
def ce_split(model, tok, rows, L, tv, bs=25, seed=0):
    g = torch.Generator().manual_seed(seed)
    eos, pad = tok.special["<eos>"], tok.special["<pad>"]
    acc = {"pad": [0.0, 0], "first_eos": [0.0, 0], "command": [0.0, 0]}
    rows = [r for r in rows if len(r[1]) <= L]
    for i in range(0, len(rows), bs):
        chunk = rows[i:i + bs]; B = len(chunk); T = max(len(p) for p, _, _ in chunk) + L
        x = torch.full((B, T), pad, dtype=torch.long); km = torch.zeros(B, T, dtype=torch.bool); y = torch.full((B, L), eos, dtype=torch.long)
        kind = torch.zeros(B, L, dtype=torch.long)                         # 0 pad, 1 first eos, 2 command token
        for b, (p, t, _) in enumerate(chunk):
            o = T - L - len(p); x[b, o:T - L] = torch.tensor(p); km[b, o:] = True; y[b, :len(t)] = torch.tensor(t)
            kind[b, :len(t) - 1] = 2; kind[b, len(t) - 1] = 1
        m = torch.rand(B, L, generator=g) < tv; m[~m.any(1), 0] = True
        x[:, T - L:] = torch.where(m, torch.full_like(y, model.mask_id), y)
        lg = model.logits(model.hidden(x, key_mask=km)[:, T - L - 1:T - 1])
        ce = F.cross_entropy(lg.float().reshape(-1, lg.shape[-1]), y.reshape(-1), reduction="none").view(B, L)
        for k, name in ((0, "pad"), (1, "first_eos"), (2, "command")):
            sel = m & (kind == k)
            acc[name][0] += float(ce[sel].sum()); acc[name][1] += int(sel.sum())
    return {k: round(s / max(1, n), 4) for k, (s, n) in acc.items()}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--threads", type=int, default=1); ap.add_argument("--runs", nargs="*", default=["dlm", "dlm-arinit"])
    a = ap.parse_args(); torch.set_num_threads(a.threads)
    tok = BPE.load(str(HERE.parents[1] / "ml/tokenizer/atc.json"))
    val, _ = eval_sets(tok, str(HERE.parents[1] / "ml/data/out4/ds"), 448)
    out = {}
    cfg = json.load(open(HERE / "runs/dlm/config.json"))
    m0 = dlm.DLM.from_ar(torch.load(HERE.parents[1] / "ml/gpu/results/s1-2m-11ap-swap/model.pt", map_location="cpu"), Config(**cfg["model"])); m0.eval()
    out["arinit_step0_val"] = score(m0, Vocab(tok, m0.mask_id), tok, val, 24, 8, "span", 200)
    print("step0", out["arinit_step0_val"], flush=True)
    for r in a.runs:
        m, c = load(HERE / "runs" / r)
        out[r] = {str(tv): ce_split(m, tok, val[:300], c["args"]["L"], tv) for tv in (0.1, 1.0)}
        print(r, out[r], flush=True)
    p = HERE / "results/diagnose.json"
    old = json.load(open(p)) if p.exists() else {}
    old.update(out); json.dump(old, open(p, "w"), indent=1)


if __name__ == "__main__":
    main()

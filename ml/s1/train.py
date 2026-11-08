"""Pre-train the S1 model from random weights (ml/README.md module 3).

Each example is one sequence:  <ctx> state <said> transcript <cmd> command line <eos>
The loss is computed ONLY on the command-line tokens (the prompt is given, not predicted). This is "loss masking",
the same thing SFT trainers do with chat templates.

    python3 ml/s1/train.py --data ml/data/out/ds --tok ml/tokenizer/atc.json --out ml/s1/runs/tiny \
        --d 192 --layers 4 --heads 6 --steps 1500 --batch 32 --lr 2e-3

On CPU this trains a ~2-5 M model in minutes; on a GPU raise --d/--layers/--steps (and use --device cuda --bf16).
Outputs: runs/<name>/model.pt, config.json, metrics.jsonl (loss curve + evals), eval.json (final scores).
"""
import argparse, json, math, os, random, sys, time
from pathlib import Path

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import compat  # noqa: F401  (Python 3.11rc shim, before torch)
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tokenizer"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import generate, prompt_text, CallsignTrie  # noqa: E402


def encode_file(tok, path, max_len, limit=None):
    rows = []
    for i, line in enumerate(open(path)):
        if limit and i >= limit:
            break
        ex = json.loads(line)
        tgt = tok.encode(" " + ex["line"]) + [tok.special["<eos>"]]
        said = tok.encode("<said> " + ex["said"] + "<cmd>")
        ctx_lines = ex["ctx"].split("\n")
        while True:                                   # drop context lines from the end until it fits
            ctx = tok.encode("<ctx>" + "\n".join(ctx_lines))
            if len(ctx) + len(said) + len(tgt) <= max_len or len(ctx_lines) <= 2:
                break
            ctx_lines = ctx_lines[:-1]
        prompt = ctx + said
        rows.append((prompt, tgt, ex))
    return rows


def batches(rows, bs, pad, rng):
    idx = list(range(len(rows)))
    while True:
        rng.shuffle(idx)
        for i in range(0, len(idx) - bs + 1, bs):
            chunk = [rows[j] for j in idx[i:i + bs]]
            T = max(len(p) + len(t) for p, t, _ in chunk)
            x = torch.full((bs, T), pad, dtype=torch.long); y = torch.full((bs, T), -100, dtype=torch.long)
            for b, (p, t, _) in enumerate(chunk):
                seq = p + t
                x[b, :len(seq)] = torch.tensor(seq)
                # predict token i+1 from position i; only the target positions count
                y[b, len(p) - 1:len(seq) - 1] = torch.tensor(t)
            yield x, y


def norm_line(s: str) -> str:
    return " ".join(s.upper().replace(",", " ").split())


@torch.no_grad()
def evaluate(model, tok, rows, n=300, constrain=True):
    model.eval()
    hit = cs_hit = sa_tp = sa_fp = sa_fn = 0
    ms = []
    for prompt, tgt, ex in rows[:n]:
        cs = [l.split()[0] for l in ex["ctx"].split("\n")[1:] if l.strip()]
        t0 = time.perf_counter()
        out = generate(model, tok, prompt, trie=CallsignTrie(tok, cs) if constrain else None)
        ms.append((time.perf_counter() - t0) * 1000)
        pred, gold = norm_line(tok.decode(out)), norm_line(ex["line"])
        hit += pred == gold
        cs_hit += pred.split()[:1] == gold.split()[:1]
        p_sa, g_sa = pred == "SAY AGAIN", gold == "SAY AGAIN"
        sa_tp += p_sa and g_sa; sa_fp += p_sa and not g_sa; sa_fn += g_sa and not p_sa
    model.train()
    k = max(1, min(n, len(rows)))
    ms.sort()
    return {"exact": round(hit / k, 4), "callsign": round(cs_hit / k, 4), "say_again_tp": sa_tp, "say_again_fp": sa_fp, "say_again_fn": sa_fn,
            "ms_p50": round(ms[len(ms) // 2], 1) if ms else None, "ms_p95": round(ms[int(len(ms) * .95)], 1) if ms else None, "n": k}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--tok", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--d", type=int, default=192); ap.add_argument("--layers", type=int, default=4); ap.add_argument("--heads", type=int, default=6)
    ap.add_argument("--max-len", type=int, default=448); ap.add_argument("--steps", type=int, default=1500); ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-3); ap.add_argument("--warmup", type=int, default=100); ap.add_argument("--wd", type=float, default=0.1)
    ap.add_argument("--eval-every", type=int, default=250); ap.add_argument("--eval-n", type=int, default=200)
    ap.add_argument("--limit", type=int, default=None); ap.add_argument("--device", default="cpu"); ap.add_argument("--bf16", action="store_true")
    ap.add_argument("--threads", type=int, default=os.cpu_count()); ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    torch.manual_seed(a.seed); torch.set_num_threads(a.threads)
    rng = random.Random(a.seed)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    tok = BPE.load(a.tok)
    t0 = time.time()
    train = encode_file(tok, Path(a.data) / "train.jsonl", a.max_len, a.limit)
    val = encode_file(tok, Path(a.data) / "val.jsonl", a.max_len, 2000)
    test = encode_file(tok, Path(a.data) / "test_airport.jsonl", a.max_len, 2000) if (Path(a.data) / "test_airport.jsonl").stat().st_size else []
    rng.shuffle(val); rng.shuffle(test)
    print(f"encoded train {len(train)} val {len(val)} test_airport {len(test)} in {time.time() - t0:.0f}s; mean len {sum(len(p) + len(t) for p, t, _ in train) / len(train):.0f}", flush=True)

    c = Config(vocab=tok.size, d=a.d, layers=a.layers, heads=a.heads, max_len=a.max_len + 64)
    model = GPT(c).to(a.device)
    print(f"model: {model.params() / 1e6:.2f} M parameters ({c.to_dict()})", flush=True)
    json.dump({"model": c.to_dict(), "args": vars(a), "params": model.params()}, open(out / "config.json", "w"), indent=1)

    decay = [p for n, p in model.named_parameters() if p.dim() >= 2]; no_decay = [p for n, p in model.named_parameters() if p.dim() < 2]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": a.wd}, {"params": no_decay, "weight_decay": 0.0}], lr=a.lr, betas=(0.9, 0.95))
    sched = lambda s: min(1.0, (s + 1) / a.warmup) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, s / a.steps))))  # warmup, cosine to 10%
    log = open(out / "metrics.jsonl", "w")
    it = batches(train, a.batch, tok.special["<pad>"], rng)
    t_start, tokens = time.time(), 0
    for step in range(a.steps + 1):
        for g in opt.param_groups:
            g["lr"] = a.lr * sched(step)
        x, y = next(it)
        x, y = x.to(a.device), y.to(a.device)
        with torch.autocast(device_type=a.device.split(":")[0], dtype=torch.bfloat16, enabled=a.bf16):
            logits = model(x)
        loss = F.cross_entropy(logits.float().view(-1, logits.shape[-1]), y.view(-1), ignore_index=-100)
        opt.zero_grad(set_to_none=True); loss.backward()
        gn = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); tokens += x.numel()
        if step % 25 == 0:
            el = time.time() - t_start
            rec = {"step": step, "loss": round(loss.item(), 4), "lr": round(opt.param_groups[0]["lr"], 6), "grad_norm": round(float(gn), 3), "tok_s": round(tokens / max(el, 1e-9)), "elapsed_s": round(el)}
            print(json.dumps(rec), flush=True); log.write(json.dumps(rec) + "\n"); log.flush()
        if step and (step % a.eval_every == 0 or step == a.steps):
            ev = {"step": step, "val": evaluate(model, tok, val, a.eval_n)}
            print(json.dumps(ev), flush=True); log.write(json.dumps(ev) + "\n"); log.flush()
            torch.save(model.state_dict(), out / "model.pt")
    final = {"val": evaluate(model, tok, val, 1000), "val_unconstrained": evaluate(model, tok, val, 300, constrain=False),
             "test_airport": evaluate(model, tok, test, 1000) if test else None, "params": model.params(), "train_s": round(time.time() - t_start)}
    json.dump(final, open(out / "eval.json", "w"), indent=1)
    print("FINAL", json.dumps(final), flush=True)


if __name__ == "__main__":
    main()

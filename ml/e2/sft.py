"""E2: supervised fine-tuning of a small pretrained LLM to write command lines (ml/README.md module 5).

Same task and data as the from-scratch S1 model: game state + transcript in, canonical command line out.
The difference is the starting point: a pretrained LLM that already knows English, numbers and airline names.

  prompt   "### State\n{ctx}\n### Heard\n{said}\n### Command\n"      (plain text, no chat template: fewer tokens)
  target   "{line}" + eos      loss on the target tokens only (loss masking, as in S1)
  --lora   train a LoRA adapter instead of all weights (rank 16 on the attention/MLP projections)

Scoring: exact command line + callsign on 1,000 validation and 1,000 unseen-airport examples, greedy decode, and the
GPU latency of one request at batch 1.

    python ml/e2/sft.py --model LiquidAI/LFM2.5-230M --data ml/data/out2/ds --out /opt/atc/results/e2-lfm230m --n-train 30000
"""
import argparse, json, math, random, time
from pathlib import Path

import torch


def prompt(ex):
    return f"### State\n{ex['ctx']}\n### Heard\n{ex['said']}\n### Command\n"


def norm_line(s):
    return " ".join(s.upper().replace(",", " ").split())


def load(path, n=None, seed=0):
    rows = [json.loads(l) for l in open(path)]
    random.Random(seed).shuffle(rows)
    return rows[:n] if n else rows


@torch.no_grad()
def evaluate(model, tok, rows, bs=32, max_new=40):
    model.eval(); tok.padding_side = "left"
    hit = cs = 0
    for i in range(0, len(rows), bs):
        chunk = rows[i:i + bs]
        enc = tok([prompt(r) for r in chunk], return_tensors="pt", padding=True).to(model.device)
        out = model.generate(**enc, max_new_tokens=max_new, do_sample=False, pad_token_id=tok.pad_token_id, eos_token_id=tok.eos_token_id)
        for r, o in zip(chunk, out[:, enc["input_ids"].shape[1]:]):
            pred = tok.decode(o, skip_special_tokens=True).split("\n")[0].strip()
            hit += norm_line(pred) == norm_line(r["line"]); cs += pred.split()[:1] == r["line"].split()[:1]
    model.train()
    return {"exact": round(hit / len(rows), 4), "callsign": round(cs / len(rows), 4), "n": len(rows)}


@torch.no_grad()
def latency(model, tok, rows, n=50):
    model.eval(); ms = []
    for r in rows[:n]:
        enc = tok([prompt(r)], return_tensors="pt").to(model.device)
        torch.cuda.synchronize(); t0 = time.perf_counter()
        model.generate(**enc, max_new_tokens=40, do_sample=False, pad_token_id=tok.pad_token_id, eos_token_id=tok.eos_token_id)
        torch.cuda.synchronize(); ms.append((time.perf_counter() - t0) * 1000)
    ms.sort(); return {"p50_ms": round(ms[len(ms) // 2], 1), "p95_ms": round(ms[int(len(ms) * .95)], 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="LiquidAI/LFM2.5-230M"); ap.add_argument("--data", default="ml/data/out2/ds")
    ap.add_argument("--val", default="ml/data/out/ds/val.jsonl", help="v1 validation, same as every other model")
    ap.add_argument("--test", default="ml/data/out/ds/test_airport.jsonl"); ap.add_argument("--out", required=True)
    ap.add_argument("--n-train", type=int, default=30000); ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--bs", type=int, default=16); ap.add_argument("--lr", type=float, default=5e-5); ap.add_argument("--lora", action="store_true")
    ap.add_argument("--max-len", type=int, default=768); ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    from transformers import AutoModelForCausalLM, AutoTokenizer
    torch.manual_seed(a.seed)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(a.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16).cuda()
    if a.lora:
        from peft import LoraConfig, get_peft_model
        model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM"))
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad); total = sum(p.numel() for p in model.parameters())
    print(json.dumps({"model": a.model, "params": total, "trainable": trainable, "lora": a.lora}), flush=True)

    train = load(Path(a.data) / "train.jsonl", a.n_train, a.seed)
    val = load(a.val, 1000, a.seed + 1); test = load(a.test, 1000, a.seed + 2)
    # tokenize: prompt ids + target ids, labels = -100 on the prompt
    ex = []
    for r in train:
        p = tok(prompt(r), add_special_tokens=False)["input_ids"]; t = tok(r["line"], add_special_tokens=False)["input_ids"] + [tok.eos_token_id]
        if len(p) + len(t) <= a.max_len:
            ex.append((p, t))
    mean_len = sum(len(p) + len(t) for p, t in ex) / len(ex)
    steps = int(math.ceil(len(ex) * a.epochs / a.bs))
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
    sched = lambda s: min(1.0, (s + 1) / 50) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps)))
    print(json.dumps({"examples": len(ex), "mean_tokens": round(mean_len), "steps": steps}), flush=True)
    log = open(out / "metrics.jsonl", "w"); t_start = time.time(); tokens = 0
    order = list(range(len(ex))); random.Random(a.seed).shuffle(order)
    model.train(); tok.padding_side = "right"
    for step in range(steps):
        for g in opt.param_groups:
            g["lr"] = a.lr * sched(step)
        idx = [order[(step * a.bs + k) % len(order)] for k in range(a.bs)]
        T = max(len(ex[i][0]) + len(ex[i][1]) for i in idx)
        x = torch.full((a.bs, T), tok.pad_token_id); y = torch.full((a.bs, T), -100); m = torch.zeros((a.bs, T), dtype=torch.long)
        for b, i in enumerate(idx):
            p, t = ex[i]; s = p + t
            x[b, :len(s)] = torch.tensor(s); y[b, len(p):len(s)] = torch.tensor(t); m[b, :len(s)] = 1
        loss = model(input_ids=x.cuda(), attention_mask=m.cuda(), labels=y.cuda()).loss
        opt.zero_grad(set_to_none=True); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step()
        tokens += int(m.sum())
        if step % 50 == 0 or step == steps - 1:
            rec = {"step": step, "loss": round(loss.item(), 4), "tok_s": round(tokens / (time.time() - t_start)), "elapsed_s": round(time.time() - t_start)}
            print(json.dumps(rec), flush=True); log.write(json.dumps(rec) + "\n"); log.flush()
    train_s = round(time.time() - t_start)
    res = {"model": a.model, "lora": a.lora, "params": total, "trainable": trainable, "train_examples": len(ex), "train_s": train_s,
           "val": evaluate(model, tok, val), "test_airport": evaluate(model, tok, test), "latency_gpu_batch1": latency(model, tok, val)}
    print("FINAL", json.dumps(res), flush=True)
    json.dump(res, open(out / "eval.json", "w"), indent=1)
    model.save_pretrained(out / "model"); tok.save_pretrained(out / "model")


if __name__ == "__main__":
    main()

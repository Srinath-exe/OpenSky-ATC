"""The control: the same CPU budget spent on plain supervised fine-tuning on the SAME hard pool, with labels.

If GRPO beats the baseline but not this, the gain came from "more training on hard cases", not from RL.
Loss-masked cross-entropy on the command tokens (as ml/s1/train.py), AdamW, warmup + cosine, grad clip 1.

    python3 ml/rl/sft.py --out ml/rl/runs/sft-control --budget 1800
"""
import argparse, json, math, random
from common import *  # noqa: F403
from train import batches


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True); ap.add_argument("--pool", default=str(ROOT / "ml/rl/runs/hard.jsonl"))
    ap.add_argument("--lr", type=float, default=2e-4); ap.add_argument("--batch", type=int, default=32); ap.add_argument("--wd", type=float, default=0.1)
    ap.add_argument("--budget", type=float, default=1800); ap.add_argument("--est-steps", type=int, default=1000, help="cosine horizon (steps that fit the budget)")
    ap.add_argument("--eval-every", type=int, default=100); ap.add_argument("--eval-n", type=int, default=200)
    ap.add_argument("--threads", type=int, default=1); ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    threads(a.threads); torch.manual_seed(a.seed); rng = random.Random(a.seed)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    json.dump(vars(a), open(out / "args.json", "w"), indent=1)
    tok = BPE.load(TOK)
    model, cfg = load_model()
    pool = [encode_ex(tok, json.loads(l)) for l in open(a.pool)]
    S = eval_sets(tok, a.eval_n)
    decay = [p for n, p in model.named_parameters() if p.dim() >= 2]; no_decay = [p for n, p in model.named_parameters() if p.dim() < 2]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": a.wd}, {"params": no_decay, "weight_decay": 0.0}], lr=a.lr, betas=(0.9, 0.95))
    horizon = [a.est_steps]       # re-estimated after 10 steps so the cosine ends when the CPU budget does
    sched = lambda s: min(1.0, (s + 1) / 30) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, s / horizon[0]))))
    log = open(out / "metrics.jsonl", "w")

    def do_eval(step, cpu):
        ev = {"step": step, "cpu_s": round(cpu), **{k: evaluate(model, tok, v) for k, v in S.items()}}
        print(json.dumps(ev), flush=True); log.write(json.dumps(ev) + "\n"); log.flush()

    do_eval(0, 0)
    it = batches(pool, a.batch, tok.special["<pad>"], rng)
    cpu = 0.0
    model.train()
    for step in range(1, 10 ** 6):
        c0 = proc_cpu_s()
        for g in opt.param_groups:
            g["lr"] = a.lr * sched(step)
        x, y = next(it)
        logits = model(x)
        loss = F.cross_entropy(logits.view(-1, logits.shape[-1]), y.view(-1), ignore_index=-100)
        opt.zero_grad(set_to_none=True); loss.backward()
        gn = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step()
        cpu += proc_cpu_s() - c0
        if step == 10:
            horizon[0] = max(20, int(a.budget / (cpu / 10)))
        if step % 10 == 0:
            rec = {"step": step, "cpu_s": round(cpu, 1), "loss": round(loss.item(), 4), "lr": round(opt.param_groups[0]["lr"], 7), "grad_norm": round(float(gn), 3)}
            log.write(json.dumps(rec) + "\n"); log.flush()
            if step % 50 == 0:
                print(json.dumps(rec), flush=True)
        if step % a.eval_every == 0:
            do_eval(step, cpu); model.train()
            torch.save(model.state_dict(), out / "model.pt")
        if cpu >= a.budget:
            break
    if step % a.eval_every:
        do_eval(step, cpu)
    torch.save(model.state_dict(), out / "model.pt")
    json.dump(cfg, open(out / "config.json", "w"), indent=1)
    json.dump({"steps": step, "cpu_s": round(cpu), "examples_seen": step * a.batch, "horizon": horizon[0]}, open(out / "done.json", "w"))
    print("DONE", step, round(cpu), flush=True)


if __name__ == "__main__":
    main()

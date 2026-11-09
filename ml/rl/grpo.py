"""GRPO (Group Relative Policy Optimisation) on the 2 M S1 model, from scratch, with the game engine as the reward.

    policy     the model being trained: a probability distribution over command lines given (state, transcript)
    reference  a frozen copy of the start model; the KL penalty keeps the policy close to it (the "leash")
    group      k sampled completions of the SAME prompt; their rewards are compared with each other
    advantage  how much better one sample did than its group: A = (r - mean(r_group)) / (std(r_group) + eps).
               No value network (that is the point of GRPO vs PPO): the group mean is the baseline.

One step:
  1. P prompts from the hard pool; for each, sample k lines at temperature T (callsign trie ON, see below)
  2. the engine parses every line; reward per line (ml/rl/rewards.py: exact | shaped | verifier)
  3. group-normalised advantages; groups whose rewards are all equal carry no signal and are skipped
  4. mu passes of the clipped surrogate (PPO clip on the ratio pi/pi_old) + beta * KL(pi || ref) per token (k3 estimator)

Callsign trie ON while sampling: the deployed decoder always applies it, so the policy we train is the constrained one,
and its log-probs (sampling, update, reference) are all taken from the same renormalised, masked distribution. With the
trie off, many samples would spend the group on aircraft that do not exist - a lesson the trie already enforces for free.

    python3 ml/rl/grpo.py --reward exact --out ml/rl/runs/grpo-exact --budget 1800
"""
import argparse, json, math, random, time
from common import *  # noqa: F403
import rewards as R


def load_pool(path, tok):
    rows = []
    for l in open(path):
        ex = json.loads(l)
        rows.append(encode_ex(tok, ex))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reward", choices=["exact", "shaped", "verifier"], required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--pool", default=str(ROOT / "ml/rl/runs/hard.jsonl"))
    ap.add_argument("--k", type=int, default=8); ap.add_argument("--P", type=int, default=16); ap.add_argument("--temp", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=3e-5); ap.add_argument("--beta", type=float, default=0.04); ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--mu", type=int, default=2); ap.add_argument("--adv-eps", type=float, default=0.05); ap.add_argument("--max-new", type=int, default=40)
    ap.add_argument("--budget", type=float, default=1800, help="training CPU seconds (this process + engine), evals excluded")
    ap.add_argument("--max-steps", type=int, default=100000); ap.add_argument("--eval-every", type=int, default=40); ap.add_argument("--eval-n", type=int, default=200)
    ap.add_argument("--threads", type=int, default=1); ap.add_argument("--seed", type=int, default=0); ap.add_argument("--no-trie", action="store_true")
    a = ap.parse_args()
    threads(a.threads); torch.manual_seed(a.seed); rng = random.Random(a.seed)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    json.dump(vars(a), open(out / "args.json", "w"), indent=1)
    tok = BPE.load(TOK)
    policy, cfg = load_model(); ref, _ = load_model()
    for p in ref.parameters():
        p.requires_grad_(False)
    pool = load_pool(a.pool, tok)
    S = eval_sets(tok, a.eval_n)
    eng = Engine()
    opt = torch.optim.AdamW(policy.parameters(), lr=a.lr, betas=(0.9, 0.99), weight_decay=0.0)
    log = open(out / "metrics.jsonl", "w")

    def do_eval(step, cpu):
        ev = {"step": step, "cpu_s": round(cpu), **{k: evaluate(policy, tok, v) for k, v in S.items()}}
        print(json.dumps(ev), flush=True); log.write(json.dumps(ev) + "\n"); log.flush()

    cpu = 0.0; e0 = eng.cpu_s()
    do_eval(0, 0)
    order = list(range(len(pool))); rng.shuffle(order); oi = 0
    examples = []          # a few (prompt, samples, rewards) groups for the report
    for step in range(1, a.max_steps + 1):
        c0 = proc_cpu_s(); ec0 = eng.cpu_s()
        batch = []
        for _ in range(a.P):
            if oi >= len(order):
                rng.shuffle(order); oi = 0
            batch.append(pool[order[oi]]); oi += 1
        # 1. rollouts
        policy.eval()
        groups, ents = [], []
        for prompt, tgt, ex in batch:
            outs, masks, ent = sample_group(policy, tok, prompt, ex["ctx"], k=a.k, temp=a.temp, max_new=a.max_new, constrain=not a.no_trie)
            groups.append((prompt, ex, outs, masks)); ents.append(ent)
        eos = tok.special["<eos>"]
        flat_ex, flat_line = [], []
        for prompt, ex, outs, masks in groups:
            for o in outs:
                flat_ex.append(ex); flat_line.append(tok.decode([t for t in o if t != eos]).strip())
        # 2. engine rewards
        rw, parsed = R.score(a.reward, eng, flat_ex, flat_line)
        ex_hit = [R.exact(e, l) for e, l in zip(flat_ex, flat_line)]
        # 3. advantages
        upd, n_tok, r_std = [], 0, []
        for gi, (prompt, ex, outs, masks) in enumerate(groups):
            r = torch.tensor(rw[gi * a.k:(gi + 1) * a.k])
            sd = float(r.std(unbiased=False)); r_std.append(sd)
            if sd < 1e-6:
                continue
            adv = (r - r.mean()) / (sd + a.adv_eps)
            with torch.no_grad():
                ref_lp, _ = completion_logprobs(ref, prompt, outs, masks, a.temp)
            upd.append([prompt, outs, masks, adv, ref_lp, None]); n_tok += sum(len(o) for o in outs)
            if len(examples) < 400 and rng.random() < 0.15:
                examples.append({"step": step, "said": ex["said"], "gold": ex["line"], "samples": [flat_line[gi * a.k + j] for j in range(a.k)],
                                 "r": [round(x, 3) for x in r.tolist()], "adv": [round(x, 2) for x in adv.tolist()]})
        # 4. clipped surrogate + KL, mu passes over the same rollouts
        policy.train()
        kl_m = clipfrac = 0.0; ratio_dev = 0.0
        for ep in range(a.mu if upd else 0):
            opt.zero_grad(set_to_none=True)
            kls, cf, rd = 0.0, 0.0, 0.0
            for g in upd:
                prompt, outs, masks, adv, ref_lp, old = g
                lp, valid = completion_logprobs(policy, prompt, outs, masks, a.temp)
                if old is None:
                    g[5] = old = lp.detach()
                ratio = torch.exp(lp - old)
                A = adv[:, None]
                pg = -torch.min(ratio * A, ratio.clamp(1 - a.clip, 1 + a.clip) * A)
                d = (ref_lp - lp)
                kl = torch.exp(d) - d - 1                                    # k3: unbiased, always >= 0
                loss = ((pg + a.beta * kl) * valid).sum() / n_tok
                loss.backward()
                kls += float((kl * valid).sum()); cf += float((((ratio - 1).abs() > a.clip).float() * valid).sum()); rd += float(((ratio - 1).abs() * valid).sum())
            gn = torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
            opt.step()
            kl_m, clipfrac, ratio_dev = kls / n_tok, cf / n_tok, rd / n_tok
        cpu += (proc_cpu_s() - c0) + (eng.cpu_s() - ec0)
        lens = [len(o) for _, _, outs, _ in groups for o in outs]
        rec = {"step": step, "cpu_s": round(cpu, 1), "reward_mean": round(sum(rw) / len(rw), 4), "reward_std_in_group": round(sum(r_std) / len(r_std), 4),
               "sample_exact": round(sum(ex_hit) / len(ex_hit), 4), "parse_rate": round(sum(p["ok"] for p in parsed) / len(parsed), 4),
               "say_again_rate": round(sum(norm_line(l) == "SAY AGAIN" for l in flat_line) / len(flat_line), 4),
               "groups_with_signal": len(upd), "kl": round(kl_m, 5), "entropy": round(sum(ents) / len(ents), 4), "len": round(sum(lens) / len(lens), 2),
               "clipfrac": round(clipfrac, 4), "ratio_dev": round(ratio_dev, 4), "grad_norm": round(float(gn), 3) if upd else 0.0}
        log.write(json.dumps(rec) + "\n"); log.flush()
        if step % 5 == 0:
            print(json.dumps(rec), flush=True)
        if step % a.eval_every == 0:
            do_eval(step, cpu)
            torch.save(policy.state_dict(), out / "model.pt")
        if cpu >= a.budget:
            break
    if step % a.eval_every:
        do_eval(step, cpu)
    torch.save(policy.state_dict(), out / "model.pt")
    json.dump(cfg, open(out / "config.json", "w"), indent=1)
    json.dump(examples, open(out / "examples.json", "w"))
    json.dump({"steps": step, "cpu_s": round(cpu), "engine_cpu_s": round(eng.cpu_s() - e0, 1), "prompts": step * a.P, "samples": step * a.P * a.k}, open(out / "done.json", "w"))
    eng.close()
    print("DONE", step, round(cpu), flush=True)


if __name__ == "__main__":
    main()

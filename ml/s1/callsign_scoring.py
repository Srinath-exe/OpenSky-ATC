"""Callsign choice by full likelihood vs the greedy trie (ml/s1/CALLSIGN_SCORING.md).

Greedy trie (shipped): the first output token is the arg-max among the valid callsign first tokens, then the next, ...
so the decoder commits to an airline prefix before the model has scored the digits.

Scored: every callsign in the state (plus " SAY AGAIN") is teacher-forced from the same <cmd> cache in one batched
forward. score = sum of its token log-probs + log P(word boundary | callsign), where the boundary is any token that
starts with a space or newline, or <eos>: without it " UAL12" would always beat " UAL123" (fewer tokens to pay for).
The arg-max is kept, the rest of the line is decoded greedily from its cache (first step restricted to a boundary).

Variants (all from the same forward, so the extra compute is shared):
  trie     the shipped decoder (ml/rl/common.greedy)
  sum      score with the boundary term                         <- the proposal
  sum_nb   score without the boundary term (shows why it is needed)
  mean     length-normalised: (sum) / (tokens + 1)
  beamK    beam search over the callsign trie, width K, same score (exactly simulated from the prefix scores)

    ml/.venv/bin/python ml/s1/callsign_scoring.py --run ml/gpu/results/s1-2m-11ap-swap --out ml/s1/results/cs_swap.json
"""
import argparse, json, math, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/rl"))
from common import *  # noqa: F401,F403,E402  (compat shim, torch, BPE, load_model, eval_sets, callsigns, norm_line)

BEAMS = (1, 2, 4, 8)


def boundary_ids(tok):
    ids = [i for i in range(tok.size) if (s := tok.decode([i])) and s[0] in " \n"]
    return sorted(set(ids + [tok.special["<eos>"]]))


@torch.no_grad()
def continue_greedy(model, tok, caches, logits, pos, bound_mask, max_new):
    """Greedy from a callsign's cache; the first token must be a word boundary (the callsign is complete)."""
    eos = tok.special["<eos>"]
    out = []
    logits = logits + bound_mask
    for _ in range(max_new):
        nxt = int(logits.argmax())
        if nxt == eos:
            break
        out.append(nxt)
        logits = model(torch.tensor([[nxt]]), caches, start=pos)[0, -1]; pos += 1
    return out


def beam_pick(seqs, pref, fin, K):
    """Beam search of width K over the trie of `seqs`. pref[p] = log P(prefix p) (tuple of ids), fin[i] = full score of
    seqs[i] (incl. boundary). Returns (picked index, nodes expanded = token positions the model would compute)."""
    full = {tuple(s): i for i, s in enumerate(seqs)}
    beam, best, best_i, nodes, depth = [()], -math.inf, -1, 0, 0
    maxL = max(len(s) for s in seqs)
    while beam and depth < maxL:
        kids = sorted({tuple(s[:depth + 1]) for s in seqs if len(s) > depth and tuple(s[:depth]) in set(beam)}, key=lambda p: -pref[p])
        beam = kids[:K]; nodes += len(beam); depth += 1
        for p in beam:
            if p in full and fin[full[p]] > best:
                best, best_i = fin[full[p]], full[p]
        # a finished hypothesis that already beats every live prefix ends the search (prefix scores only fall)
        if beam and best >= max(pref[p] for p in beam):
            break
    return best_i, nodes


def best_first(seqs, pref, fin, cap=None, norm=False):
    """Exact arg-max of `fin` by best-first search over the trie (what s1.ts does): every prefix score is an upper bound
    on the score of any callsign below it (log-probs are <= 0), so the first complete callsign popped from a max-queue
    is the best one. Each popped prefix costs one model step (its logits score its children and its word boundary).
    With `cap`, the search goes on until the runner-up is found or nothing left can come within `cap` of the best
    (margin reported as min(margin, cap)). norm=True: the arg-max of the length-normalised score fin / (len + 1), with
    the admissible bound pref(p) / (longest candidate below p + 1) (A*: pref <= 0, so a longer divisor only raises it).
    Returns (pick, margin, nodes stepped)."""
    import heapq
    full = {tuple(s): i for i, s in enumerate(seqs)}
    kids, lmax = {}, {}
    for s in seqs:
        for t in range(len(s) + 1):
            lmax[tuple(s[:t])] = max(lmax.get(tuple(s[:t]), 0), len(s))
        for t in range(len(s)):
            kids.setdefault(tuple(s[:t]), set()).add(tuple(s[:t + 1]))
    pri = (lambda p: pref[p] / (lmax[p] + 1)) if norm else (lambda p: pref[p])
    done = (lambda i: fin[i] / (len(seqs[i]) + 1)) if norm else (lambda i: fin[i])
    q = [(-pri(p), 0, p) for p in kids[()]]
    heapq.heapify(q)
    nodes, best, best_i = 0, None, -1
    while q:
        neg, kind, p = heapq.heappop(q)
        sc = -neg
        if kind == 1:                                   # a complete callsign (boundary scored)
            if best is None:
                best, best_i = sc, full[p]
                if cap is None:
                    return best_i, None, nodes
                continue
            return best_i, min(best - sc, cap), nodes
        if best is not None and sc < best - cap:
            break
        nodes += 1                                      # step this prefix's last token
        if p in full:
            heapq.heappush(q, (-done(full[p]), 1, p))
        for c in kids.get(p, ()):
            heapq.heappush(q, (-pri(c), 0, c))
    return best_i, (cap if best is not None else None), nodes


CAPS = (0, 2, 4, 8)
MCAPS = (0, 0.5, 1, 2)


@torch.no_grad()
def run_row(model, tok, prompt, ex, bound, bound_mask, max_new=48):
    eos = tok.special["<eos>"]
    cs = callsigns(ex["ctx"])
    caches0 = model.new_cache()
    logits0 = model(torch.tensor([prompt]), caches0, start=0)[0, -1]
    P = len(prompt)
    res = {}
    # --- trie (the shipped decoder, same as common.greedy but from the shared prompt cache)
    trie = CallsignTrie(tok, cs)
    caches = [dict(c) for c in caches0]
    logits, pos, out, on = logits0, P, [], True
    for _ in range(max_new):
        if on:
            a = trie.allowed(out)
            if a is None:
                on = False
            else:
                logits = mask_row(logits, a)
        nxt = int(logits.argmax())
        if nxt == eos:
            break
        out.append(nxt)
        logits = model(torch.tensor([[nxt]]), caches, start=pos)[0, -1]; pos += 1
    res["trie"] = {"line": norm_line(tok.decode(out)), "steps": len(out)}
    # --- every candidate teacher-forced in one batch from the <cmd> cache
    names = cs + ["SAY AGAIN"]
    seqs, idx = [], []
    for j, s in enumerate(trie.seqs):              # dedup identical token sequences (repeated callsigns)
        if s not in seqs:
            seqs.append(s); idx.append(j)
    B, L = len(seqs), max(len(s) for s in seqs)
    pad = torch.tensor([s + [0] * (L - len(s)) for s in seqs])
    ex_c = [{"k": c["k"].expand(B, -1, -1, -1), "v": c["v"].expand(B, -1, -1, -1)} for c in caches0]
    lg = model(pad, ex_c, start=P)                  # lg[b, t] predicts token t+1 of candidate b
    lp = torch.log_softmax(lg.float(), -1)
    first = torch.log_softmax(logits0.float(), -1)
    tok_lp, bnd = [], []
    pref = {(): 0.0}
    for b, s in enumerate(seqs):
        acc = [float(first[s[0]])] + [float(lp[b, t - 1, s[t]]) for t in range(1, len(s))]
        run = 0.0
        for t in range(len(s)):
            run += acc[t]; pref[tuple(s[:t + 1])] = run
        tok_lp.append(run)
        bnd.append(float(torch.logsumexp(lp[b, len(s) - 1, bound], 0)))
    nodes = len(pref) - 1                            # distinct prefixes = token positions with a shared-prefix trie
    tot = [t + b for t, b in zip(tok_lp, bnd)]
    scores = {"sum": tot, "sum_nb": tok_lp, "mean": [t / (len(s) + 1) for t, s in zip(tot, seqs)]}
    picks = {k: max(range(B), key=lambda i: v[i]) for k, v in scores.items()}
    beam_nodes = {}
    for K in BEAMS:
        picks[f"beam{K}"], beam_nodes[K] = beam_pick(seqs, pref, tot, K)
    bf, bfm = {}, {}
    for cap in CAPS:
        i, mg, nd = best_first(seqs, pref, tot, cap if cap else None)
        bf[cap] = {"nodes": nd, "margin": mg, "same": i == picks["sum"]}
    for cap in MCAPS:
        i, mg, nd = best_first(seqs, pref, tot, cap if cap else None, norm=True)
        bfm[cap] = {"nodes": nd, "margin": mg, "same": i == picks["mean"]}
    cont = {}
    for k, i in picks.items():
        if i not in cont:
            s = seqs[i]
            c = [dict(x) for x in caches0]
            lgs = model(torch.tensor([s]), c, start=P)[0, -1]
            cont[i] = continue_greedy(model, tok, c, lgs, P + len(s), bound_mask, max_new - len(s))
        line = norm_line(tok.decode(seqs[i] + cont[i]))
        steps = nodes if not k.startswith("beam") else beam_nodes[int(k[4:])]
        res[k] = {"line": line, "steps": steps + len(cont[i]), "passes": (len(seqs[i]) + len(cont[i]))}
    srt = sorted(tot, reverse=True)
    res["_meta"] = {"n_cand": B, "trie_nodes": nodes, "sum_tokens": sum(len(s) for s in seqs), "max_len": L,
                    "margin": (srt[0] - srt[1]) if B > 1 else 20.0, "picked": names[idx[picks["sum"]]], "bf": bf, "bfm": bfm,
                    "cont": len(cont[picks["sum"]]), "cont_mean": len(cont[picks["mean"]]),
                    "margin_mean": None if B < 2 else sorted((t / (len(s) + 1) for t, s in zip(tot, seqs)), reverse=True)[:2]}
    return res


def summarise(rows, golds, variant):
    n = len(rows); hit = cs = miss = false = 0; steps = 0
    for r, g in zip(rows, golds):
        p = r[variant]["line"]
        hit += p == g; cs += p.split()[:1] == g.split()[:1]
        miss += g == "SAY AGAIN" and p != "SAY AGAIN"; false += p == "SAY AGAIN" and g != "SAY AGAIN"
        steps += r[variant]["steps"]
    return {"exact": round(hit / n, 4), "callsign": round(cs / n, 4), "sa_missed": miss, "sa_false": false,
            "sa_gold": sum(g == "SAY AGAIN" for g in golds), "steps_mean": round(steps / n, 2), "n": n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=str(START)); ap.add_argument("--ckpt", default=None); ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=2); ap.add_argument("--n", type=int, default=1000)
    a = ap.parse_args()
    threads(a.threads)
    tok = BPE.load(TOK)
    model, _ = load_model(a.run, torch.load(a.ckpt, map_location="cpu") if a.ckpt else None)
    bound = torch.tensor(boundary_ids(tok))
    bound_mask = torch.full((model.c.vocab,), float("-inf")); bound_mask[bound] = 0
    S = eval_sets(tok, a.n)
    out = {"run": a.run, "ckpt": a.ckpt, "summary": {}, "rows": {}}
    variants = ["trie", "sum", "sum_nb", "mean"] + [f"beam{K}" for K in BEAMS]
    for name, rows in S.items():
        t0 = time.time(); R, G = [], []
        for i, (prompt, tgt, ex) in enumerate(rows):
            R.append(run_row(model, tok, prompt, ex, bound, bound_mask)); G.append(norm_line(ex["line"]))
            if i % 250 == 0:
                print(name, i, round(time.time() - t0, 1), flush=True)
        out["summary"][name] = {v: summarise(R, G, v) for v in variants}
        m = [r["_meta"] for r in R]
        out["summary"][name]["_cost"] = {"cand_mean": round(sum(x["n_cand"] for x in m) / len(m), 2),
                                         "trie_nodes_mean": round(sum(x["trie_nodes"] for x in m) / len(m), 2),
                                         "sum_tokens_mean": round(sum(x["sum_tokens"] for x in m) / len(m), 2),
                                         "max_len_mean": round(sum(x["max_len"] for x in m) / len(m), 2),
                                         **{f"best_first_cap{c}_steps_mean": round(sum(x["bf"][c]["nodes"] + x["cont"] for x in m) / len(m), 2) for c in CAPS},
                                         **{f"best_first_cap{c}_same_pick": sum(x["bf"][c]["same"] for x in m) for c in CAPS},
                                         **{f"astar_mean_cap{c}_steps_mean": round(sum(x["bfm"][c]["nodes"] + x["cont_mean"] for x in m) / len(m), 2) for c in MCAPS},
                                         **{f"astar_mean_cap{c}_same_pick": sum(x["bfm"][c]["same"] for x in m) for c in MCAPS}}
        out["rows"][name] = [{"gold": g, **{v: r[v]["line"] for v in variants}, "margin": r["_meta"]["margin"], "n_cand": r["_meta"]["n_cand"],
                              "margin_mean": r["_meta"]["margin_mean"]} for r, g in zip(R, G)]
        print(name, json.dumps(out["summary"][name]), flush=True)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(a.out, "w"))


if __name__ == "__main__":
    main()

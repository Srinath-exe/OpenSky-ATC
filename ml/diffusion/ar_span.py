"""Side experiment: is the diffusion model's callsign gain a diffusion property or a decoding trick?

The diffusion decoder's `span` constraint scores every callsign in the game state as a whole and keeps the best.
Here the same idea goes into the AR model: score each candidate callsign by its exact log-likelihood after the prompt
(plus a word boundary after it), keep the best, then decode the rest greedily. Compared with the greedy trie walk on
the same rows.

    python ml/diffusion/ar_span.py --run ml/gpu/results/s1-2m-11ap-swap --n 1000 --threads 2
"""
import argparse, json, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / "s1")); sys.path.insert(0, str(HERE.parent / "tokenizer"))
import dlm  # noqa: F401,E402
import torch  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import generate, prefill, CallsignTrie  # noqa: E402
from train import norm_line  # noqa: E402
from train_dlm import eval_sets  # noqa: E402
from denoise import Vocab, callsigns_of  # noqa: E402


@torch.no_grad()
def span_decode(model, tok, vb, prompt, callsigns):
    cache, n = prefill(model, prompt[:-1])                        # everything but the last prompt token
    best, best_s = None, -1e30
    for seq, is_say in vb.candidates(callsigns):
        c = [dict(x) for x in cache]
        x = torch.tensor([[prompt[-1]] + seq])                   # logits at row i predict token i+1
        lp = torch.log_softmax(model(x, c, start=n)[0].float(), -1)
        s = float(sum(lp[i, t] for i, t in enumerate(seq)))
        nxt = lp[len(seq)]
        s += float(nxt[vb.eos]) if is_say else float(torch.logsumexp(nxt[:tok.size].masked_fill(~vb.boundary[:tok.size], -1e30), -1))
        if s > best_s:
            best, best_s = (seq, is_say), s
    seq, is_say = best
    if is_say:
        return seq
    return seq + generate(model, tok, prompt + seq)


@torch.no_grad()
def span_decode_fast(model, tok, vb, prompt, callsigns, max_new=48):
    """Same result, game-ready cost: one prompt prefill, all candidates scored in ONE batched forward on top of the
    prompt cache, then greedy decoding continues from the winning row's cache."""
    cache, n = prefill(model, prompt[:-1])
    cands = vb.candidates(callsigns)
    B, m = len(cands), max(len(q) for q, _ in cands)
    c = [{"k": d["k"].expand(B, -1, -1, -1), "v": d["v"].expand(B, -1, -1, -1)} for d in cache]
    x = torch.full((B, m + 1), tok.special["<pad>"], dtype=torch.long)
    for i, (q, _) in enumerate(cands):
        x[i, :len(q) + 1] = torch.tensor([prompt[-1]] + q)            # right padding: causal, so it never matters
    lp = torch.log_softmax(model(x, c, start=n).float(), -1)
    bnd = ~vb.boundary[:tok.size]
    best, best_s = 0, -1e30
    for i, (q, is_say) in enumerate(cands):
        sc = float(lp[i, torch.arange(len(q)), torch.tensor(q)].sum())
        sc += float(lp[i, len(q), vb.eos]) if is_say else float(torch.logsumexp(lp[i, len(q)].masked_fill(bnd, -1e30), -1))
        if sc > best_s:
            best, best_s = i, sc
    q, is_say = cands[best]
    if is_say:
        return list(q)
    keep = n + len(q) + 1
    caches = [{"k": d["k"][best:best + 1, :, :keep], "v": d["v"][best:best + 1, :, :keep]} for d in c]
    logits, pos, out = lp[best, len(q)], keep, list(q)
    for _ in range(max_new):
        nxt = int(logits.argmax())
        if nxt == vb.eos:
            break
        out.append(nxt)
        logits = model(torch.tensor([[nxt]]), caches, start=pos)[0, -1]; pos += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--n", type=int, default=1000); ap.add_argument("--threads", type=int, default=2); ap.add_argument("--bench", type=int, default=0, help="also time trie vs fast span on the first N val rows")
    a = ap.parse_args(); torch.set_num_threads(a.threads)
    cfg = json.load(open(Path(a.run) / "config.json"))
    model = GPT(Config(**cfg["model"])); model.load_state_dict(torch.load(Path(a.run) / "model.pt", map_location="cpu")); model.eval()
    tok = BPE.load(str(HERE.parents[1] / "ml/tokenizer/atc.json")); vb = Vocab(tok, tok.size)
    val, test = eval_sets(tok, str(HERE.parents[1] / "ml/data/out4/ds"), 448)
    res = {"run": a.run, "n": a.n}
    for name, rows in (("val", val[:a.n]), ("sydney", test[:a.n])) if a.n else ():
        r = {"trie": [0, 0], "span": [0, 0]}; ms = {"trie": [], "span": []}
        for prompt, _, ex in rows:
            cs = callsigns_of(ex["ctx"]); gold = norm_line(ex["line"])
            t0 = time.perf_counter(); o1 = generate(model, tok, prompt, trie=CallsignTrie(tok, cs)); ms["trie"].append(time.perf_counter() - t0)
            t0 = time.perf_counter(); o2 = span_decode(model, tok, vb, prompt, cs); ms["span"].append(time.perf_counter() - t0)
            for k, o in (("trie", o1), ("span", o2)):
                p = norm_line(tok.decode(o)); r[k][0] += p == gold; r[k][1] += p.split()[:1] == gold.split()[:1]
        res[name] = {k: {"exact": round(v[0] / len(rows), 4), "callsign": round(v[1] / len(rows), 4),
                         "ms_p50": round(1000 * sorted(ms[k])[len(rows) // 2], 1)} for k, v in r.items()}
        print(name, res[name], flush=True)
    if a.bench:
        t = {"trie": [], "span_fast": []}; same = 0
        for prompt, _, ex in val[:a.bench]:
            cs = callsigns_of(ex["ctx"])
            t0 = time.perf_counter(); generate(model, tok, prompt, trie=CallsignTrie(tok, cs)); t["trie"].append(time.perf_counter() - t0)
            t0 = time.perf_counter(); o = span_decode_fast(model, tok, vb, prompt, cs); t["span_fast"].append(time.perf_counter() - t0)
            same += o == span_decode(model, tok, vb, prompt, cs)
        res["bench"] = {k: {"p50_ms": round(1000 * sorted(v)[len(v) // 2], 1), "p95_ms": round(1000 * sorted(v)[int(len(v) * .95)], 1)} for k, v in t.items()}
        res["bench"].update({"n": a.bench, "threads": a.threads, "fast_equals_slow": f"{same}/{a.bench}"})
        print("bench", res["bench"], flush=True)
    out = HERE / "results" / f"ar_span{'' if a.n else '_bench'}_{Path(a.run).name}.json"
    json.dump(res, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()

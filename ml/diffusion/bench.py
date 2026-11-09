"""Latency per command on CPU at 1 thread (a phone core / a browser WASM worker): AR with KV cache vs diffusion at each S.

    python ml/diffusion/bench.py --dlm ml/diffusion/runs/dlm --ar ml/diffusion/runs/ar-matched ml/gpu/results/s1-2m-11ap-swap --n 200

AR      kv      prompt prefilled at push-to-talk release, then one token per forward with the KV cache
        prefix  game state prefilled while the player talks; at release only transcript + answer run
DLM     exact   every step re-runs prompt + canvas (bidirectional: the prompt's keys/values depend on the canvas)
        prompt  prompt keys/values from step 1 are reused, later steps run only the canvas (approximation)
        ctx     game state encoded alone while the player talks (approximation), then as 'prompt'
Release latency is what the player waits for; the ctx prefill happens during speech and is reported separately.
"""
import argparse, json, statistics, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent / "s1")); sys.path.insert(0, str(HERE.parent / "tokenizer"))
import dlm  # noqa: E402
import torch  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import generate, prefill, CallsignTrie  # noqa: E402
from train import norm_line  # noqa: E402
from denoise import Vocab, denoise, denoise_cached, prefill_ctx, callsigns_of  # noqa: E402
from train_dlm import eval_sets  # noqa: E402
from evaluate import load  # noqa: E402


def ms(fn, *a, **k):
    t0 = time.perf_counter(); r = fn(*a, **k); return r, (time.perf_counter() - t0) * 1000


def q(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * p))]


def summary(xs):
    return {"p50_ms": round(statistics.median(xs), 2), "p95_ms": round(q(xs, .95), 2), "mean_ms": round(statistics.mean(xs), 2)}


def n_ctx_of(tok, prompt, ex):
    ids = tok.encode("<ctx>" + ex["ctx"])
    return len(ids) if prompt[:len(ids)] == ids else prompt.index(tok.special["<said>"])


@torch.no_grad()
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dlm", required=True); ap.add_argument("--ar", nargs="*", default=[]); ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--threads", type=int, default=1); ap.add_argument("--out", default=str(HERE / "results/bench.json"))
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    model, cfg = load(a.dlm)
    tok = BPE.load(cfg["args"]["tok"]); vb = Vocab(tok, model.mask_id); L = cfg["args"]["L"]
    val, _ = eval_sets(tok, cfg["args"]["data"], cfg["args"]["max_len"])
    rows = val[:a.n]
    res = {"n": len(rows), "threads": a.threads, "L": L, "ar": {}, "dlm": {}, "forward": {}}
    plen = [len(p) for p, _, _ in rows]; res["prompt_tokens_mean"] = round(statistics.mean(plen))
    for run in a.ar:
        c = json.load(open(Path(run) / "config.json"))
        ar = GPT(Config(**c["model"])); ar.load_state_dict(torch.load(Path(run) / "model.pt", map_location="cpu")); ar.eval()
        t_kv, t_pre, t_fill, olen, hit = [], [], [], [], 0
        for prompt, _, ex in rows:
            trie = CallsignTrie(tok, callsigns_of(ex["ctx"]))
            o, t1 = ms(generate, ar, tok, prompt, trie=trie)
            n = n_ctx_of(tok, prompt, ex)
            pre, tf = ms(prefill, ar, prompt[:n])
            o2, t2 = ms(generate, ar, tok, prompt, prefix=pre, trie=trie)
            t_kv.append(t1); t_pre.append(t2); t_fill.append(tf); olen.append(len(o) + 1)
            hit += norm_line(tok.decode(o)) == norm_line(ex["line"])
        res["ar"][Path(run).name] = {"kv": summary(t_kv), "prefix": summary(t_pre), "ctx_prefill": summary(t_fill),
                                     "forwards_mean": round(statistics.mean(olen), 2), "exact": round(hit / len(rows), 4)}
        print(Path(run).name, json.dumps(res["ar"][Path(run).name]), flush=True)
    # single-forward costs, to explain the totals
    p0 = rows[0][0]
    x = torch.tensor([p0 + [model.mask_id] * L])
    _, t_full = ms(model.hidden, x)
    keep = []; model.hidden(x, keep=keep)
    cache = [(k[:, :, :len(p0) - 1], v[:, :, :len(p0) - 1]) for k, v in keep]
    tc = [ms(model.hidden, x[:, len(p0) - 1:], start=len(p0) - 1, past=cache)[1] for _ in range(20)]
    tf = [ms(model.hidden, x)[1] for _ in range(20)]
    res["forward"] = {"prompt_plus_canvas_ms": round(statistics.median(tf), 2), "canvas_only_cached_ms": round(statistics.median(tc), 2),
                      "tokens_full": x.shape[1], "tokens_canvas": L + 1}
    print("forward", res["forward"], flush=True)
    for S in [1, 2, 4, 8, L, "tau0.9"]:
        tau = 0.9 if S == "tau0.9" else None
        Sv = None if tau else S
        for mode in ("exact", "prompt", "ctx"):
            ts, tfill, nfes, hit, agree = [], [], [], 0, 0
            for prompt, _, ex in rows:
                cs = callsigns_of(ex["ctx"])
                if mode == "exact":
                    (outs, nfe, _), t = ms(denoise, model, vb, [prompt], L, Sv, [cs], "span", tau)
                    o, nfe = outs[0], nfe[0]
                else:
                    n = n_ctx_of(tok, prompt, ex)
                    kv, t0 = ms(prefill_ctx, model, prompt[:n]) if mode == "ctx" else (None, 0)
                    (o, nfe), t = ms(denoise_cached, model, vb, prompt, L, Sv, cs, "span", tau, mode, kv, n)
                    tfill.append(t0)
                ts.append(t); nfes.append(nfe)
                hit += norm_line(tok.decode(o)) == norm_line(ex["line"])
            k = f"{S}|{mode}"
            res["dlm"][k] = {**summary(ts), "nfe": round(statistics.mean(nfes), 2), "exact": round(hit / len(rows), 4)}
            if tfill and mode == "ctx":
                res["dlm"][k]["ctx_prefill"] = summary(tfill)
            print(k, json.dumps(res["dlm"][k]), flush=True)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()

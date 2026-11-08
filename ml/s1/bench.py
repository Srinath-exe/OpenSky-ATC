"""Inference benchmark for a trained S1 model (ml/README.md module 4): what the KV cache and prefix caching buy.

Three ways to decode the same examples, same greedy output:
  no_cache   re-run the whole sequence for every generated token            (what you'd write first)
  kv_cache   prefill the prompt once, then one token per step              (every real inference engine)
  prefix     the game-state context was prefilled while the player was talking; at push-to-talk release only the
             transcript and the answer are computed                          (prefix caching, as in vLLM/SGLang)

    python3 ml/s1/bench.py --run ml/s1/runs/tiny --tok ml/tokenizer/atc.json --data ml/data/out/ds/val.jsonl --n 100
"""
import argparse, json, statistics, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent)); sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tokenizer"))
import compat  # noqa: F401,E402
import torch  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import generate, generate_no_cache, prefill, timed  # noqa: E402
from train import encode_file  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--tok", required=True); ap.add_argument("--data", required=True)
    ap.add_argument("--n", type=int, default=100); ap.add_argument("--threads", type=int, default=1)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)                       # 1 thread ~ a phone core / a browser WASM worker
    cfg = json.load(open(Path(a.run) / "config.json"))
    model = GPT(Config(**cfg["model"])); model.load_state_dict(torch.load(Path(a.run) / "model.pt", map_location="cpu")); model.eval()
    tok = BPE.load(a.tok)
    rows = encode_file(tok, a.data, cfg["args"]["max_len"], a.n)
    t = {"no_cache": [], "kv_cache": [], "prefix": [], "prefill_ctx": []}
    same = 0; plen = []; olen = []
    for prompt, _, ex in rows:
        ctx_ids = tok.encode("<ctx>" + ex["ctx"])
        n_ctx = len(ctx_ids) if prompt[:len(ctx_ids)] == ctx_ids else 0
        o1, ms1 = timed(generate_no_cache, model, tok, prompt)
        o2, ms2 = timed(generate, model, tok, prompt)
        pre, ms_pre = timed(prefill, model, prompt[:n_ctx]) if n_ctx else ((None, 0), 0)
        o3, ms3 = timed(generate, model, tok, prompt, prefix=pre if n_ctx else None)
        same += o1 == o2 == o3
        t["no_cache"].append(ms1); t["kv_cache"].append(ms2); t["prefix"].append(ms3); t["prefill_ctx"].append(ms_pre)
        plen.append(len(prompt)); olen.append(len(o2))
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(len(xs) * p))]
    res = {k: {"p50_ms": round(statistics.median(v), 2), "p95_ms": round(q(v, .95), 2)} for k, v in t.items()}
    res.update({"identical_outputs": f"{same}/{len(rows)}", "prompt_tokens_mean": round(statistics.mean(plen)), "output_tokens_mean": round(statistics.mean(olen), 1),
                "params": cfg["params"], "threads": a.threads})
    print(json.dumps(res, indent=1))
    json.dump(res, open(Path(a.run) / "bench.json", "w"), indent=1)


if __name__ == "__main__":
    main()

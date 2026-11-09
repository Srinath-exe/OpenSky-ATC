"""End-to-end check of the decoder as shipped (ml/s1/decode.generate_scored = src/lib/voice/s1.ts 'score' mode: A* on the
length-normalised score, runner-up budget, trie fallback) against the greedy trie, on the fixed eval sets.

    ml/.venv/bin/python ml/s1/callsign_e2e.py --tag swap                         (ml/gpu/results/s1-2m-11ap-swap)
    ml/.venv/bin/python ml/s1/callsign_e2e.py --tag grpo --ckpt ml/rl/runs/grpo-exact/model.pt
-> ml/s1/results/e2e_<tag>.json
"""
import argparse, json, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/rl"))
from common import *  # noqa: F401,F403,E402
from decode import generate_scored, boundary_ids, prefill  # noqa: E402
from callsign_report import mcnemar_p  # noqa: E402


@torch.no_grad()
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True); ap.add_argument("--ckpt", default=None); ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--n", type=int, default=1000)
    a = ap.parse_args()
    threads(a.threads)
    tok = BPE.load(TOK); model, _ = load_model(START, torch.load(a.ckpt, map_location="cpu") if a.ckpt else None)
    bound = boundary_ids(tok)
    res = {}
    for name, rows in eval_sets(tok, a.n).items():
        t0 = time.time(); out = []
        for prompt, tgt, ex in rows:
            cs = callsigns(ex["ctx"])
            ids, sr = generate_scored(model, tok, prompt, cs, bound=bound)
            out.append({"gold": norm_line(ex["line"]), "trie": norm_line(tok.decode(greedy(model, tok, prompt, ex["ctx"]))), "score": norm_line(tok.decode(ids)),
                        "steps": sr["nodes"], "margin": sr["margin"], "fallback": sr["best"] is None})
        n = len(out)
        ok = lambda r, v: r[v] == r["gold"]
        cs_ok = lambda r, v: r[v].split()[:1] == r["gold"].split()[:1]
        fx = sum(ok(r, "score") and not ok(r, "trie") for r in out); br = sum(ok(r, "trie") and not ok(r, "score") for r in out)
        st = sorted(r["steps"] for r in out)
        res[name] = {"n": n, "trie_exact": sum(ok(r, "trie") for r in out) / n, "score_exact": sum(ok(r, "score") for r in out) / n,
                     "trie_callsign": sum(cs_ok(r, "trie") for r in out) / n, "score_callsign": sum(cs_ok(r, "score") for r in out) / n,
                     "fixed": fx, "broken": br, "mcnemar_p": mcnemar_p(fx, br), "fallbacks": sum(r["fallback"] for r in out),
                     "search_steps_mean": sum(st) / n, "search_steps_p95": st[int(0.95 * n)], "search_steps_max": st[-1], "s": round(time.time() - t0, 1), "rows": out}
        print(name, json.dumps({k: v for k, v in res[name].items() if k != "rows"}), flush=True)
    json.dump(res, open(Path(__file__).parent / f"results/e2e_{a.tag}.json", "w"))


if __name__ == "__main__":
    main()

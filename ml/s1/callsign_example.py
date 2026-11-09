"""The worked example for ml/s1/CALLSIGN_SCORING.md and public/reports/voice-callsign.html: one Sydney row where the
greedy trie picks the wrong aircraft. Per candidate: every token's log-prob and the word boundary; the trie's first-step
distribution; the best-first search's pops in order.

    ml/.venv/bin/python ml/s1/callsign_example.py ["VOZ527 SPEED 210"]   -> ml/s1/results/example.json
"""
import heapq, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/rl"))
from common import *  # noqa: F401,F403,E402
import decode  # noqa: E402


@torch.no_grad()
def main():
    want = sys.argv[1] if len(sys.argv) > 1 else "VOZ527 SPEED 210"
    threads(1)
    tok = BPE.load(TOK); model, _ = load_model(START)
    bound = torch.tensor(decode.boundary_ids(tok))
    for prompt, tgt, ex in eval_sets(tok, 1000)["sydney"]:
        if norm_line(ex["line"]) == want:
            break
    else:
        raise SystemExit("row not found")
    cs = callsigns(ex["ctx"]); seqs = CallsignTrie(tok, cs).seqs; names = cs + ["SAY AGAIN"]
    caches = model.new_cache(); lg0 = model(torch.tensor([prompt]), caches, start=0)[0, -1]
    first = torch.log_softmax(lg0.float(), -1)
    B, L = len(seqs), max(len(s) for s in seqs)
    exc = [{"k": c["k"].expand(B, -1, -1, -1), "v": c["v"].expand(B, -1, -1, -1)} for c in caches]
    lp = torch.log_softmax(model(torch.tensor([s + [0] * (L - len(s)) for s in seqs]), exc, start=len(prompt)).float(), -1)
    cands = []
    for b, s in enumerate(seqs):
        t = [float(first[s[0]])] + [float(lp[b, k - 1, s[k]]) for k in range(1, len(s))]
        bd = float(torch.logsumexp(lp[b, len(s) - 1, bound], 0))
        cands.append({"cs": names[b], "pieces": [tok.decode([x]) for x in s], "lp": [round(x, 3) for x in t], "boundary": round(bd, 3),
                      "sum": round(sum(t) + bd, 3), "mean": round((sum(t) + bd) / (len(s) + 1), 3)})
    al = sorted({s[0] for s in seqs}); pa = torch.softmax(lg0[al].float(), 0)
    first_step = sorted(([tok.decode([a]), round(float(p), 4)] for a, p in zip(al, pa)), key=lambda x: -x[1])
    pops, orig = [], heapq.heappop

    def pop(q):
        it = orig(q)
        pops.append({"pri": round(-it[0], 3), "kind": "complete" if it[2] == 1 else "prefix", "text": tok.decode(list(it[3])), "lp": round(it[4], 3)})
        return it
    heapq.heappop = pop
    try:
        out, sr = decode.generate_scored(model, tok, prompt, cs)
    finally:
        heapq.heappop = orig
    trie = decode.generate(model, tok, prompt, trie=CallsignTrie(tok, cs))
    res = {"said": ex["said"], "gold": ex["line"], "callsigns": cs, "first_step": first_step, "candidates": sorted(cands, key=lambda r: -r["mean"]),
           "pops": pops, "steps": sr["nodes"], "margin": sr["margin"], "scored": tok.decode(out).strip(), "trie": tok.decode(trie).strip()}
    (Path(__file__).parent / "results").mkdir(exist_ok=True)
    json.dump(res, open(Path(__file__).parent / "results/example.json", "w"), indent=1)
    print(json.dumps({k: res[k] for k in ("said", "gold", "trie", "scored", "steps", "margin")}))


if __name__ == "__main__":
    main()

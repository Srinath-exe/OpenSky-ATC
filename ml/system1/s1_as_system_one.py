"""Our own 2 M-parameter S1 model, scored as a System One model on the bake-off questions.

aircraft      P(callsign | game state + transcript) for every callsign in the state: each candidate's tokens are
              scored by teacher forcing, then softmaxed across candidates. That is a typed "choice" with calibrated-
              looking probabilities, from a model that was trained only to write command lines.
instruction   the kind of the command line it writes (constrained greedy decode), mapped to the same 14 kinds.
Same 100 commands as ml/system1/bench_all.py (same shuffle seed and filter).

    python3 ml/system1/s1_as_system_one.py --n 100
"""
import argparse, json, random, re, statistics, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/s1")); sys.path.insert(0, str(ROOT / "ml/tokenizer")); sys.path.insert(0, str(ROOT / "ml/system1"))
import compat  # noqa: F401,E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import generate, CallsignTrie, prefill  # noqa: E402
from bench_all import GOLD  # noqa: E402

KIND_OF_LINE = [(r"^(FLY HEADING|TURN (LEFT|RIGHT)|HEADING)", "heading"), (r"^(ALTITUDE|CLIMB|DESCEND)", "altitude"), (r"^SPEED", "speed"),
                (r"^DIRECT", "direct"), (r"^CLEARED ILS", "ils"), (r"^CLEARED TO LAND", "clearedLand"), (r"^CLEARED FOR TAKEOFF", "takeoff"),
                (r"^LINE UP", "lineup"), (r"^TAXI", "taxi"), (r"^(PUSHBACK|START-UP|STARTUP)", "pushback"), (r"^HOLD (POSITION|SHORT)", "holdPosition"),
                (r"^CROSS", "cross"), (r"^CONTACT", "contact"), (r"^(ROGER|RADAR CONTACT|STANDBY|UNABLE)", "ack")]


def kind_of(line: str):
    rest = " ".join(line.upper().split()[1:])
    for pat, k in KIND_OF_LINE:
        if re.match(pat, rest):
            return k
    return None


@torch.no_grad()
def score_callsigns(model, tok, prompt, callsigns):
    """log P(" CS" | prompt) for each candidate, sharing the prompt's KV cache (prefix caching)."""
    cache, n = prefill(model, prompt[:-1])
    out = []
    for cs in callsigns:
        seq = [prompt[-1]] + tok.encode(" " + cs)
        caches = [dict(c) for c in cache]
        logits = model(torch.tensor([seq]), caches, start=n)[0]
        lp = F.log_softmax(logits[:-1], -1)
        out.append(float(sum(lp[i, t] for i, t in enumerate(seq[1:]))))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=str(ROOT / "ml/s1/runs/v1")); ap.add_argument("--tok", default=str(ROOT / "ml/tokenizer/atc.json"))
    ap.add_argument("--data", default=str(ROOT / "ml/data/out/ds/val.jsonl")); ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--seed", type=int, default=0); ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--fit-temp", action="store_true"); ap.add_argument("--fit-n", type=int, default=300)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    cfg = json.load(open(Path(a.run) / "config.json"))
    model = GPT(Config(**cfg["model"])); model.load_state_dict(torch.load(Path(a.run) / "model.pt", map_location="cpu")); model.eval()
    tok = BPE.load(a.tok)
    rows = [json.loads(l) for l in open(a.data)]
    random.Random(a.seed).shuffle(rows)
    rows = [r for r in rows if r["line"] != "SAY AGAIN" and GOLD.get(r["kind"].split("+")[0])][: a.n]
    # --- calibration: fit one temperature T on OTHER validation commands (never the 100 scored below) ---
    T = 1.0
    if a.fit_temp:
        pool = [json.loads(l) for l in open(a.data)]
        random.Random(a.seed).shuffle(pool)
        pool = [r for r in pool if r["line"] != "SAY AGAIN" and GOLD.get(r["kind"].split("+")[0])][a.n:a.n + a.fit_n]
        fit = []
        for ex in pool:
            cs = [l.split()[0] for l in ex["ctx"].split("\n")[1:] if l.strip()]
            g = ex["line"].split()[0]
            if g not in cs:
                continue
            fit.append((torch.tensor(score_callsigns(model, tok, tok.encode("<ctx>" + ex["ctx"] + "<said> " + ex["said"] + "<cmd>"), cs)), cs.index(g)))
        nll = lambda t: sum(float(-torch.log_softmax(lp / t, 0)[gi]) for lp, gi in fit) / len(fit)
        grid = [0.5 * 1.25 ** k for k in range(30)]
        T = min(grid, key=nll)
        print(json.dumps({"fit_examples": len(fit), "temperature": round(T, 2), "nll_T1": round(nll(1.0), 3), "nll_T": round(nll(T), 3)}))
    hit_a = hit_k = 0; ms = []; conf = {"right": [], "wrong": []}; fails = []
    for ex in rows:
        callsigns = [l.split()[0] for l in ex["ctx"].split("\n")[1:] if l.strip()]
        prompt = tok.encode("<ctx>" + ex["ctx"] + "<said> " + ex["said"] + "<cmd>")
        t0 = time.perf_counter()
        lps = score_callsigns(model, tok, prompt, callsigns)
        probs = torch.softmax(torch.tensor(lps) / T, 0)
        j = int(probs.argmax())
        line = tok.decode(generate(model, tok, prompt, trie=CallsignTrie(tok, callsigns))).strip()
        ms.append((time.perf_counter() - t0) * 1000)
        gold_cs, gold_k = ex["line"].split()[0], GOLD[ex["kind"].split("+")[0]]
        ok = callsigns[j] == gold_cs; hit_a += ok; hit_k += kind_of(line) == gold_k
        conf["right" if ok else "wrong"].append(float(probs[j]))
        if not ok and len(fails) < 6:
            fails.append(f"{ex['said']!r}: gold {gold_cs} got {callsigns[j]} ({float(probs[j]):.2f})")
    ms.sort()
    res = {"model": f"s1-own-{cfg['params'] / 1e6:.1f}M" + (f"-T{T:.1f}" if T != 1.0 else ""), "temperature": round(T, 2), "n": len(rows), "aircraft_acc": round(hit_a / len(rows), 3), "instruction_acc": round(hit_k / len(rows), 3),
           "ms_p50": round(ms[len(ms) // 2]), "ms_p95": round(ms[int(len(ms) * .95)]), "conf_right": round(statistics.mean(conf["right"]), 3) if conf["right"] else None,
           "conf_wrong": round(statistics.mean(conf["wrong"]), 3) if conf["wrong"] else None, "threads": a.threads}
    print(json.dumps(res))
    for f in fails:
        print("  ", f)
    out = ROOT / "ml/system1/out"; out.mkdir(parents=True, exist_ok=True)
    json.dump({"summary": res, "fails": fails}, open(out / ("bench-s1-own-calibrated.json" if T != 1.0 else "bench-s1-own.json"), "w"), indent=1)


if __name__ == "__main__":
    main()

"""The voice gate before / after the callsign search, on the same transcripts and the same (current) rules parser.

  before: the greedy-trie decoder (ml/verify/gen.py --decode trie) + the gate fitted on it (results/verify-model-trie-decoder.js,
          the compiled src/lib/voice/verify-model.ts from before the refit)
  after:  the shipped decoder (callsign by likelihood) + its refitted gate (public/models/verifier/roundtrip-v1/verifier.json)
  (both gates before the refit were exported with fit.py's mean/std bug, fixed with this refit; "before" is the gate as
  it ran in the game; after_export_bug = the new gate with the same bug, results/verifier-export-bug.json)

Population: transcripts the rules cannot parse (the model's job). Outcome per transcript as decideL1 + the gate decide it:
sent (right / wrong), check, say again, unparsed. Writes results/gate_<model>.json.

    ml/s1/gen_trie.sh <model> val syd stt noisy; node ml/verify/post.cjs <model>-trie val syd stt noisy   (first)
    ml/.venv/bin/python ml/s1/callsign_gate.py
"""
import json, math, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/verify"))
from fit import feature_map, veto, gated, ZCLIP  # noqa: E402

OUT = ROOT / "ml/verify/out"
SETS = ["val", "syd", "stt", "noisy"]


def score(m, f):
    x = [min(ZCLIP, max(-ZCLIP, (f[n] - mu) / sd)) for n, mu, sd in zip(m["features"], m["mean"], m["std"])]
    if m.get("hidden"):
        h = m["hidden"]; z = h["b2"]
        for w1, b1, w2 in zip(h["w1"], h["b1"], h["w2"]):
            a = b1 + sum(w * v for w, v in zip(w1, x))
            if a > 0:
                z += w2 * a
    else:
        z = m["b"] + sum(w * v for w, v in zip(m["w"], x))
    return 1 / (1 + math.exp(-z))


def outcomes(rows, gate):
    th = gate["thresholds"]; o = {"l1": 0, "sent_right": 0, "sent_wrong": 0, "check": 0, "say_again": 0, "say_again_right": 0, "unparsed": 0, "model_exact": 0, "say_again_bounced_correct": 0}
    for r in rows:
        if r["l0_ok"]:
            continue
        o["l1"] += 1; o["model_exact"] += r["correct"]
        if r["say"]:
            o["say_again"] += 1; o["say_again_right"] += r["gold_say"]
        elif not r["parsed"]:
            o["unparsed"] += 1
        elif not gated(r):
            o["check"] += 1                                  # callsign corrected by the rules: always checked
        else:
            p = score(gate, feature_map(r))
            if p >= th["send"] and not veto(r):
                o["sent_right" if r["correct"] else "sent_wrong"] += 1
            elif p < th["sayAgain"]:
                o["say_again"] += 1; o["say_again_right"] += r["gold_say"]; o["say_again_bounced_correct"] += r["correct"]
            else:
                o["check"] += 1
    return o


def main():
    old = json.loads(subprocess.check_output(["node", "-e", f"console.log(JSON.stringify(require({json.dumps(str(ROOT / 'ml/s1/results/verify-model-trie-decoder.js'))}).VERIFIERS))"]))
    new = json.load(open(ROOT / "public/models/verifier/roundtrip-v1/verifier.json"))["models"]
    # the same refit exported with fit.py's old mean/std bug (hidden-state statistics in place of the features'), for scale
    bp = ROOT / "ml/s1/results/verifier-export-bug.json"
    bug = json.load(open(bp))["models"] if bp.exists() else {}
    # the greedy-trie decoder with a gate refitted on its signals (fit.py fixed): isolates the decoder's own effect
    fixed_trie = {}
    for m in ("2m-swap-v1", "2m-grpo-v1"):
        fp = ROOT / f"ml/s1/results/gate-trie-decoder-fixed_{m}.json"
        if fp.exists():
            fixed_trie[f"/models/s1/{m}"] = json.load(open(fp))
    for m in ("2m-swap-v1", "2m-grpo-v1"):
        url = f"/models/s1/{m}"; res = {}
        for s in SETS:
            fb, fa = OUT / f"{m}-trie/{s}.feat.jsonl", OUT / f"{m}/{s}.feat.jsonl"
            if not fb.exists() or not fa.exists():
                continue
            B = [json.loads(l) for l in open(fb)]; A = [json.loads(l) for l in open(fa)]
            res[s] = {"before": outcomes(B, old[url]["full"]), "after": outcomes(A, new[url]["full"])}
            if url in bug:
                res[s]["after_export_bug"] = outcomes(A, bug[url]["full"])
            if url in fixed_trie:                      # greedy trie + a gate refitted on it with the fixed export
                res[s]["before_fixed_gate"] = outcomes(B, fixed_trie[url]["full"])
            b, a = res[s]["before"], res[s]["after"]
            print(m, s, "L1", b["l1"], "| model exact %.3f -> %.3f" % (b["model_exact"] / b["l1"], a["model_exact"] / a["l1"]),
                  "| sent right %d -> %d, wrong %d -> %d, check %d -> %d, say again %d -> %d" % (b["sent_right"], a["sent_right"], b["sent_wrong"], a["sent_wrong"], b["check"], a["check"], b["say_again"], a["say_again"]))
        json.dump(res, open(ROOT / f"ml/s1/results/gate_{m}.json", "w"), indent=1)


if __name__ == "__main__":
    main()

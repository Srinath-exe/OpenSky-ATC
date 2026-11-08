"""Score the GPU speech-to-text bake-off end to end (runs on the VPS after `ml/gpu/gpu.sh pull`).

For every recogniser:  WER against the spoken text, then the command it leads to
  L0         the rules parser alone on the transcript
  L1         our S1 model as the clean-up step (game state + transcript -> command line, constrained callsigns)
  L0 + L1    rules when they parse, the model otherwise (the planned production chain)

    python3 ml/stt/score.py --dir ml/gpu/results/stt --run ml/s1/runs/v1
"""
import argparse, json, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/s1")); sys.path.insert(0, str(ROOT / "ml/tokenizer")); sys.path.insert(0, str(ROOT / "ml/data"))
import compat  # noqa: F401,E402
import torch  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import generate, CallsignTrie  # noqa: E402
from augment import stt_normalise, words_to_digits  # noqa: E402


def wer(ref, hyp):
    # numbers in one form on both sides ("four two one" and "421" are the same words to a controller)
    r, h = words_to_digits(stt_normalise(ref).split()), words_to_digits(stt_normalise(hyp).split())
    d = [[i + j if i * j == 0 else 0 for j in range(len(h) + 1)] for i in range(len(r) + 1)]
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r)][len(h)], len(r)


def norm_line(s):
    return " ".join(s.upper().replace(",", " ").split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "ml/gpu/results/stt")); ap.add_argument("--run", default=str(ROOT / "ml/s1/runs/v1"))
    ap.add_argument("--tok", default=str(ROOT / "ml/tokenizer/atc.json"))
    a = ap.parse_args()
    d = Path(a.dir)
    clips = {c["i"]: c for c in json.load(open(d / "clips.json"))}
    cfg = json.load(open(Path(a.run) / "config.json"))
    model = GPT(Config(**cfg["model"])); model.load_state_dict(torch.load(Path(a.run) / "model.pt", map_location="cpu")); model.eval()
    tok = BPE.load(a.tok)
    summary = []
    for f in sorted(d.glob("*.json")):
        if f.name in ("clips.json", "scores.json"):
            continue
        res = json.load(open(f)); rows = res["rows"]
        rows_in = [{"heard": r["heard"], "line": clips[r["i"]]["line"], "ctx": clips[r["i"]]["ctx"]} for r in rows]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as t:
            json.dump(rows_in, t)
        l0 = json.loads(subprocess.run(["node", str(ROOT / "ml/stt/score_l0.cjs"), t.name], capture_output=True, text=True, check=True).stdout)
        we = wn = l0_hit = l1_hit = both = 0
        for r, s0, ri in zip(rows, l0, rows_in):
            e, n = wer(clips[r["i"]]["text"], r["heard"]); we += e; wn += n
            cs = [l.split()[0] for l in ri["ctx"].split("\n")[1:] if l.strip()]
            said = stt_normalise(r["heard"])
            pred = tok.decode(generate(model, tok, tok.encode("<ctx>" + ri["ctx"] + "<said> " + said + "<cmd>"), trie=CallsignTrie(tok, cs))).strip()
            l1 = norm_line(pred) == norm_line(ri["line"])
            l0_hit += s0["same"]; l1_hit += l1; both += s0["same"] or (not s0["ok"] and l1)
        n = len(rows); ms = sorted(r["ms"] for r in rows)
        s = {"model": res["model"], "n": n, "wer": round(we / wn, 3), "l0": round(l0_hit / n, 3), "l1": round(l1_hit / n, 3), "l0_l1": round(both / n, 3),
             "ms_p50": ms[n // 2], "ms_p95": ms[int(n * .95)]}
        summary.append(s); print(json.dumps(s), flush=True)
    json.dump(summary, open(d / "scores.json", "w"), indent=1)


if __name__ == "__main__":
    main()

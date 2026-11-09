"""Pick the controller lines the synthetic voices speak: ml/data/stt/synth/lines.jsonl.
    python3 ml/stt/data/make_lines.py [--n 12000] [--seed 7]
Source: the exporter's clean phrasings (ml/data/out*/<ICAO>.jsonl, "say" in ICAO and FAA style), never the S1 training
"said" texts (those carry simulated recogniser errors). Sydney (YSSY, the unseen test airport) and every line of the
owner's gold set are left out. Kinds are flattened (weight 1/sqrt(count), heading is 37 % of the source) and every line
gets one engine and one voice."""
import argparse, collections, glob, json, math, random, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent))
from textnorm import norm

ENGINES = {"phonon": 0.375, "kokoro": 0.375, "supertonic": 0.125, "paradee": 0.125}


def voices():
    import os
    hub = Path(os.path.expanduser("~/.cache/huggingface/hub"))
    ph = [json.loads(l) for l in open(next(hub.glob("models--gradium--phonon-voices/snapshots/*/voices.jsonl")))]
    ph_en = [v["name"] for v in ph if v["locale"] in ("en-us", "en-gb")]
    ph_acc = [v["name"] for v in ph if v["language"] in ("fr", "de", "es", "pt")]
    from huggingface_hub import list_repo_files
    ko = sorted(f[7:-3] for f in list_repo_files("hexgrad/Kokoro-82M") if f.startswith("voices/") and f[7] in "abhefip")
    return {"phonon": (ph_en, ph_acc), "kokoro": (ko, []), "supertonic": ([f"{g}{i}" for g in "MF" for i in range(1, 6)], []),
            "paradee": (["af_heart", "bf_isabella", "am_puck", "bm_fable"], [])}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=12000); ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=str(ROOT / "ml/data/stt/synth/lines.jsonl")); a = ap.parse_args()
    rnd = random.Random(a.seed)
    gold = {norm(p["said"]) for p in json.load(open(ROOT / "public/voice/gold-prompts.json"))["prompts"] if p.get("said")}
    rows = []
    for f in sorted(glob.glob(str(ROOT / "ml/data/out[0-9]*/*.jsonl"))):
        for l in open(f):
            r = json.loads(l)
            if "say" in r and r["icao"] != "YSSY": rows.append(r)
    kinds = collections.Counter(r["kind"] for r in rows)
    w = [1 / math.sqrt(kinds[r["kind"]]) for r in rows]
    picked, seen = [], set()
    order = sorted(range(len(rows)), key=lambda i: rnd.random() ** (1 / w[i]), reverse=True)   # weighted sample without replacement
    for i in order:
        r = rows[i]
        us = r["icao"][0] in "K"
        style = ("FAA" if rnd.random() < 0.8 else "ICAO") if us else ("ICAO" if rnd.random() < 0.85 else "FAA")
        say = r["say"].get(style) or next(iter(r["say"].values()))
        t = norm(say)
        if not t or t in gold or t in seen: continue
        seen.add(t); picked.append((r, style, say, t))
        if len(picked) >= a.n: break
    V = voices()
    eng = [e for e, share in ENGINES.items() for _ in range(round(share * len(picked)))]
    eng = (eng + ["kokoro"] * len(picked))[: len(picked)]; rnd.shuffle(eng)
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as fo:
        for k, ((r, style, say, t), e) in enumerate(zip(picked, eng)):
            main_v, acc = V[e]
            v = rnd.choice(acc) if acc and rnd.random() < 0.4 else rnd.choice(main_v)
            speed = round(rnd.uniform(0.95, 1.25), 2) if e in ("kokoro", "paradee") else 1.0
            fo.write(json.dumps({"id": f"s{k:05d}", "engine": e, "voice": v, "speed": speed, "say": say, "text": t, "style": style,
                                 "line": r["line"], "kind": r["kind"], "icao": r["icao"], "ctx": r["ctx"]}) + "\n")
    print(f"{len(picked)} lines -> {out}", collections.Counter(eng), collections.Counter(p[0]["kind"] for p in picked).most_common(8))


if __name__ == "__main__":
    main()

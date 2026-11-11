"""Round 2, error-driven batch: what round 1 still misses on real radio (ml/gpu/results/stt-ft/hyp_tuned_*) is the
phonetic alphabet in registrations ("Oscar Kilo Foxtrot Alfa Oscar"). Appends N lines (ids u00000...) to
ml/data/stt/synth2/lines.jsonl: every grammar template with a spelled registration, 3-5 letters, optional type prefix.
    ml/stt/.venv/bin/python ml/stt/data/coverage_extra.py [--n 2500]"""
import argparse, json, random, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import coverage_lines as C
from make_lines import voices
from textnorm import norm

ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=2500); a = ap.parse_args()
rnd = random.Random(23); f = C.ROOT / "ml/data/stt/synth2/lines.jsonl"
rows = [json.loads(l) for l in open(f)]
if any(r["id"].startswith("u") for r in rows): sys.exit("already appended")
seen = {r["text"] for r in rows}
F = C.Fill(rnd, ["Boswe"], ["x"]); V = voices(); out = []
def reg():
    k = rnd.random(); n = rnd.choice([3, 4, 5, 5, 5])
    letters = " ".join(w.title() for w in (rnd.choice(C.PH) for _ in range(n)))
    if k < 0.2: return f"{rnd.choice(['Cessna', 'Piper', 'Cirrus', 'Diamond', 'Helicopter', 'Citation', 'King Air', 'Robin'])} {letters}"
    if k < 0.4: return f"{F.d(str(rnd.randint(1, 99)))} {letters}" if rnd.random() < 0.5 else f"{letters} {F.d(str(rnd.randint(1, 99)))}"
    return letters
tpls = [t for t in C.TEMPLATES if t[1].startswith("{cs}")]
while len(out) < a.n:
    pos, tpl = rnd.choice(tpls)
    say = re.sub(r"\{(\w+)\}", lambda m: reg() if m.group(1) == "cs" else getattr(F, m.group(1))(), tpl)
    if "Boswe" in say: continue
    t = norm(say)
    if t in seen: continue
    seen.add(t); e = rnd.choices(["phonon", "paradee", "supertonic"], [0.7, 0.15, 0.15])[0]; mv, acc = V[e]
    out.append({"id": f"u{len(out):05d}", "engine": e, "voice": rnd.choice(acc) if acc and rnd.random() < 0.4 else rnd.choice(mv),
                "speed": round(rnd.uniform(0.95, 1.3), 2) if e == "paradee" else 1.0, "say": say, "text": t, "src": "extra", "pos": pos, "tag": "phonetic-reg"})
with open(f, "a") as fo:
    for r in out: fo.write(json.dumps(r) + "\n")
print(len(out), "lines appended;", out[0]["say"], "|", out[1]["say"])

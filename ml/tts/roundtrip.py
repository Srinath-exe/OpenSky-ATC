"""Does the pilot voice say the aviation lingo right? A round-trip intelligibility test, CPU only.

Pilot-style lines full of lingo (callsigns, flight levels, headings, runways, frequencies, QNH, squawks, fixes, ICAO
numbers "tree / fife / niner") are spoken by the game's pilot voice (Paradee-8M, four voices) and by a reference voice
(Kokoro-82M, much larger), then transcribed by the fine-tuned phone speech model. A word that the reference voice gets
across but Paradee does not is a word Paradee says badly: that is the case for training the voice, word by word.

    ml/stt/.venv/bin/python ml/tts/roundtrip.py synth   [--n 240]      # writes ml/tts/out/roundtrip/<engine>/*.wav + list.jsonl
    node ml/stt/data/check.cjs ml/tts/out/roundtrip/<engine>/list.jsonl ml/tts/out/roundtrip/<engine>/heard.jsonl   (OPENATC_STT_PARAKEET_DIR=...)
    ml/stt/.venv/bin/python ml/tts/roundtrip.py score
"""
import collections, glob, json, random, re, sys, wave
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/stt/data")); sys.path.insert(0, str(ROOT / "ml/tts")); sys.path.insert(0, str(ROOT / "ml/data"))
OUT = ROOT / "ml/tts/out/roundtrip"


def lines(n, seed=3):
    """Pilot readbacks built from exported game commands: the controller's phrase with the callsign moved to the end."""
    from augment import stt_normalise
    rng = random.Random(seed); by_kind = collections.defaultdict(list)
    for f in sorted(glob.glob(str(ROOT / "ml/data/out3/*.jsonl"))):
        for l in open(f):
            r = json.loads(l)
            if r["kind"] in ("heading", "altitude", "speed", "contact", "taxi", "ils", "direct", "hold", "takeoff", "clearedLand", "cross", "holdShort",
                             "startup", "pushback", "expectRunway", "radarContact", "exitAt", "windCheck"):
                by_kind[r["kind"]].append(r)
    out = []
    kinds = sorted(by_kind)
    while len(out) < n:
        k = kinds[len(out) % len(kinds)]; r = rng.choice(by_kind[k])
        v = "ICAO" if rng.random() < 0.6 else "FAA"
        phrase = r["say"].get(v) or r["say"]["ICAO"]
        head, _, rest = phrase.partition(",")
        said = f"{rest.strip().rstrip('.')}, {head.strip()}."
        said = said[0].upper() + said[1:]
        out.append({"id": f"r{len(out):04d}", "kind": k, "variant": v, "say": said, "text": stt_normalise(said)})
    return out


def synth(n):
    from synth import Paradee, PARADEE_VOICES
    from scipy.signal import resample_poly
    rows = lines(n)
    engines = {"paradee": (Paradee(threads=1), PARADEE_VOICES)}
    try:
        import torch; torch.set_num_threads(1)
        from kokoro import KPipeline, KModel
        m = KModel(repo_id="hexgrad/Kokoro-82M").eval()
        pipes = {l: KPipeline(lang_code=l, repo_id="hexgrad/Kokoro-82M", model=m) for l in "ab"}
        def kok(t, v, speed=1.0):
            return np.concatenate([r.audio.numpy() for r in pipes["b" if v[0] == "b" else "a"](t, voice=v, speed=speed) if r.audio is not None])
        engines["kokoro"] = (kok, ["af_heart", "bf_isabella", "am_puck", "bm_fable"])
    except Exception as e:  # noqa: BLE001
        print("kokoro unavailable:", e)
    for name, (say, voices) in engines.items():
        d = OUT / name; d.mkdir(parents=True, exist_ok=True)
        with open(d / "list.jsonl", "w") as f:
            for i, r in enumerate(rows):
                v = voices[i % len(voices)]
                x = np.asarray(say(r["say"], v, 1.0), dtype=np.float32).reshape(-1)
                x = resample_poly(x, 2, 3).astype(np.float32)   # 24 kHz -> 16 kHz
                p = d / f"{r['id']}.wav"
                with wave.open(str(p), "wb") as w:
                    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
                    w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
                f.write(json.dumps({**r, "wav": str(p), "voice": v}) + "\n")
        print(name, len(rows), "lines")


def score():
    from wer import wer_num, fold
    res = {}; words = {}
    for name in ("paradee", "kokoro"):
        d = OUT / name
        if not (d / "heard.jsonl").exists(): continue
        L = {r["id"]: r for r in map(json.loads, open(d / "list.jsonl"))}
        H = {r["id"]: r.get("heard") or "" for r in map(json.loads, open(d / "heard.jsonl"))}
        e = w = 0; per_kind = collections.defaultdict(lambda: [0, 0]); miss = collections.Counter(); seen = collections.Counter(); per_voice = collections.defaultdict(lambda: [0, 0])
        for k, r in L.items():
            ref, hyp = r["text"], H.get(k, "")
            n = len(ref.split()); x = wer_num(ref, hyp) * n; e += x; w += n
            per_kind[r["kind"]][0] += x; per_kind[r["kind"]][1] += n
            per_voice[r["voice"]][0] += x; per_voice[r["voice"]][1] += n
            fw = lambda s: (lambda f: f if isinstance(f, list) else f.split())(fold(s)); hw = collections.Counter(fw(hyp))
            for t in fw(ref):
                seen[t] += 1
                if hw[t] > 0: hw[t] -= 1
                else: miss[t] += 1
        res[name] = {"wer": round(100 * e / w, 2), "lines": len(L), "by_kind": {k: round(100 * a / b, 1) for k, (a, b) in sorted(per_kind.items())},
                     "by_voice": {k: round(100 * a / b, 1) for k, (a, b) in per_voice.items()}}
        words[name] = {t: (miss[t], seen[t]) for t in seen}
    if "paradee" in words and "kokoro" in words:   # words Paradee loses much more often than the reference voice
        worse = []
        for t, (m, s) in words["paradee"].items():
            km, ks = words["kokoro"].get(t, (0, 1))
            if s >= 4 and m / s - km / ks >= 0.15: worse.append({"word": t, "paradee_missed": f"{m}/{s}", "kokoro_missed": f"{km}/{ks}"})
        res["paradee_worse_words"] = sorted(worse, key=lambda x: -int(x["paradee_missed"].split("/")[0]))
    (OUT / "score.json").write_text(json.dumps(res, indent=1)); print(json.dumps(res, indent=1)[:3000])


if __name__ == "__main__":
    cmd = sys.argv[1]
    n = int(sys.argv[sys.argv.index("--n") + 1]) if "--n" in sys.argv else 240
    synth(n) if cmd == "synth" else score()

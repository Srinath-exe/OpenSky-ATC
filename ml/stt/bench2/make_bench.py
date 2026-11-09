"""Realistic speech-to-text benchmark (ml/stt/RESULTS2.md): game situations spoken by Kokoro on CPU, then degraded.

Each utterance is one (ctx, said, line) record from the voice dataset (ml/data/out4/ds): validation sessions at the
eleven training airports and the unseen airport (Sydney). It is spoken once (8 voices: American and British, female
and male; speed 0.9-1.3) and written in four conditions:

  clean   the TTS output with the silence a push-to-talk leaves around speech (0.25-0.45 s before, 0.3 s after)
  laptop  laptop microphone in a room: 120 Hz-7 kHz, light reverb (RT60 0.25-0.5 s), fan/pink noise at 15-25 dB SNR,
          level -14..-2 dB
  radio   VHF-style channel: band-pass 300-3400 Hz, soft compression, noise at 6-12 dB SNR
  late    the laptop clip with the recogniser starting late: lead silence and the first 150-400 ms of speech cut
          (the callsign is the first word, so this is what a slow Web Speech / microphone start costs)

    ml/stt/.venv/bin/python ml/stt/bench2/make_bench.py --n-val 100 --n-syd 60 --out ml/stt/bench2/clips
Writes <out>/<id>_<cond>.wav (16 kHz mono int16) and <out>/meta.jsonl.
"""
import argparse, json, random, re, time
from collections import defaultdict
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt, resample_poly, fftconvolve

ROOT = Path(__file__).resolve().parents[3]
VOICES = ["af_heart", "am_michael", "bf_emma", "bm_george", "af_bella", "am_adam", "bf_isabella", "bm_lewis"]
SR = 16000
DIG = "zero one two three four five six seven eight nine".split()
NUMW = set(DIG) | {"niner", "tree", "fife", "thousand", "hundred"}


def spoken(said: str) -> str:
    """What a controller says for a dataset transcript: no fillers, digits as words (thousands as 'four thousand'),
    and the dataset's simulated recogniser homophones ("one to six") put back to what was meant."""
    s = re.sub(r"\b(uh+|um+|ah+|er+)\b", " ", said)
    s = re.sub(r"(\d)\.(\d)", r"\1 decimal \2", s)

    def one(m):
        t = m.group(0); n = int(t)
        if n >= 1000 and n % 1000 == 0 and n < 100000:
            return f"{' '.join(DIG[int(d)] for d in str(n // 1000))} thousand"
        if n >= 1000 and n % 100 == 0:
            return f"{' '.join(DIG[int(d)] for d in str(n // 1000))} thousand {DIG[(n // 100) % 10]} hundred"
        return " ".join(DIG[int(d)] for d in t)
    s = re.sub(r"\d+", one, s)
    w = s.split()
    for i in range(1, len(w) - 1):
        if (w[i - 1] in NUMW or w[i - 1] in ("runway", "heading", "level", "speed", "squawk")) and w[i + 1] in NUMW:
            w[i] = {"to": "two", "too": "two", "for": "four", "won": "one", "ate": "eight"}.get(w[i], w[i])
    w = [{"won": "one", "ate": "eight", "write": "right"}.get(x, x) for x in w]
    return " ".join(w)


def pick(path: Path, n: int, rng: random.Random, per_kind: int):
    """n records, at most per_kind of a kind (heading is 40 % of the data), one per (session ctx, line)."""
    rows = [json.loads(l) for l in open(path)]
    rng.shuffle(rows)
    seen, by_kind, out = set(), defaultdict(int), []
    for r in rows:
        if r["line"] == "SAY AGAIN" or r["kind"] in ("sayAgain",):
            continue
        key = (r["ctx"].split("\n")[0], r["line"])
        if key in seen or by_kind[r["kind"]] >= per_kind:
            continue
        seen.add(key); by_kind[r["kind"]] += 1; out.append(r)
        if len(out) == n:
            break
    return out


def pink(n, rng):
    w = np.fft.rfft(rng.standard_normal(n)); f = np.arange(len(w)); f[0] = 1
    x = np.fft.irfft(w / np.sqrt(f), n); return x / (np.std(x) + 1e-9)


def active_rms(x):
    fr = x[: len(x) // 320 * 320].reshape(-1, 320); e = np.sqrt((fr ** 2).mean(1) + 1e-12)
    thr = max(e.max() * 0.1, 1e-4); return float(np.sqrt((fr[e > thr] ** 2).mean())) if (e > thr).any() else float(e.mean())


def add_noise(x, snr_db, rng, kind="pink"):
    nz = pink(len(x), rng) if kind == "pink" else rng.standard_normal(len(x))
    return x + nz * active_rms(x) / (10 ** (snr_db / 20))


def reverb(x, rt60, wet, rng):
    n = int(SR * rt60); t = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-6.9 * t / rt60); ir[0] = 0; ir /= np.sqrt((ir ** 2).sum()) + 1e-9
    y = fftconvolve(x, ir)[: len(x)]
    return (1 - wet) * x + wet * y * (active_rms(x) / (active_rms(y) + 1e-9))


def band(x, lo, hi):
    return sosfilt(butter(4, [lo, hi], btype="band", fs=SR, output="sos"), x)


def onset(x):
    fr = x[: len(x) // 160 * 160].reshape(-1, 160); e = np.sqrt((fr ** 2).mean(1))
    idx = np.nonzero(e > e.max() * 0.08)[0]; return int(idx[0] * 160) if len(idx) else 0


def degrade(speech, rng):
    """speech: clean TTS at 16 kHz, peak -3 dBFS, no padding -> dict cond -> (audio, info)."""
    lead, tail = int(SR * rng.uniform(0.25, 0.45)), int(SR * 0.3)
    clean = np.concatenate([np.zeros(lead), speech, np.zeros(tail)])
    out = {"clean": (clean, {})}
    # laptop
    rt, wet, snr, gain = rng.uniform(0.25, 0.5), rng.uniform(0.15, 0.3), rng.uniform(15, 25), rng.uniform(-14, -2)
    x = band(clean, 120, 7000); x = reverb(x, rt, wet, rng); x = add_noise(x, snr, rng, "pink")
    x = x + 0.002 * np.sin(2 * np.pi * 50 * np.arange(len(x)) / SR)
    lap = x * 10 ** (gain / 20)
    out["laptop"] = (lap, {"snr": round(snr, 1), "rt60": round(rt, 2), "gain_db": round(gain, 1)})
    # radio
    snr2, drive = rng.uniform(6, 12), rng.uniform(2, 4)
    y = band(clean, 300, 3400); y = np.tanh(drive * y / (np.abs(y).max() + 1e-9)) / np.tanh(drive) * 0.7
    y = add_noise(y, snr2, rng, "white" if rng.random() < 0.5 else "pink")
    out["radio"] = (y * 10 ** (rng.uniform(-6, 0) / 20), {"snr": round(snr2, 1)})
    # late start: the laptop clip from (speech onset + 150-400 ms)
    cut = int(SR * rng.uniform(0.15, 0.4))
    st = lead + onset(speech) + cut
    out["late"] = (lap[st:], {"cut_ms": round(cut / SR * 1000)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-val", type=int, default=100); ap.add_argument("--n-syd", type=int, default=60)
    ap.add_argument("--ds", default=str(ROOT / "ml/data/out4/ds")); ap.add_argument("--out", default=str(ROOT / "ml/stt/bench2/clips"))
    ap.add_argument("--seed", type=int, default=7); ap.add_argument("--threads", type=int, default=2)
    a = ap.parse_args()
    import torch
    torch.set_num_threads(a.threads)
    from kokoro import KPipeline
    rng = random.Random(a.seed)
    recs = [("val", r) for r in pick(Path(a.ds) / "val.jsonl", a.n_val, rng, 9)] + [("syd", r) for r in pick(Path(a.ds) / "test_airport.jsonl", a.n_syd, rng, 6)]
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    pipes = {"a": KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M"), "b": KPipeline(lang_code="b", repo_id="hexgrad/Kokoro-82M")}
    t0 = time.time()
    mf = out / "meta.jsonl"
    meta = [json.loads(l) for l in open(mf)] if mf.exists() else []
    have = {m["id"] for m in meta}
    with open(mf, "a") as fm:
        for i, (split, r) in enumerate(recs):
            v = VOICES[i % len(VOICES)]; speed = round(rng.uniform(0.9, 1.3), 2)
            if f"{i:04d}" in have:
                continue
            text = spoken(r["said"])
            parts = [np.asarray(au.numpy() if hasattr(au, "numpy") else au, dtype=np.float32) for _, _, au in pipes[v[0]](text, voice=v, speed=speed)]
            wav = resample_poly(np.concatenate(parts), 2, 3).astype(np.float64)
            wav = wav / (np.abs(wav).max() + 1e-9) * 0.7
            nrng = np.random.default_rng(a.seed * 100003 + i)
            for cond, (x, info) in degrade(wav, nrng).items():
                x = np.clip(x, -1, 1)
                name = f"{i:04d}_{cond}.wav"
                sf.write(out / name, (x * 32767).astype(np.int16), SR, subtype="PCM_16")
                m = {"id": f"{i:04d}", "cond": cond, "wav": name, "split": split, "icao": r["icao"], "kind": r["kind"], "voice": v, "speed": speed,
                     "text": text, "said": r["said"], "line": r["line"], "ctx": r["ctx"], "sec": round(len(x) / SR, 2), **info}
                meta.append(m); fm.write(json.dumps(m) + "\n")
            fm.flush()
            if i % 20 == 0:
                print(json.dumps({"i": i, "elapsed_s": round(time.time() - t0), "text": text}), flush=True)
    print(json.dumps({"utterances": len(recs), "clips": len(meta), "audio_s": round(sum(m["sec"] for m in meta)), "elapsed_s": round(time.time() - t0)}), flush=True)


if __name__ == "__main__":
    main()

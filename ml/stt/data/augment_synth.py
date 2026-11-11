"""One listening condition per synthetic clip (ml/data/stt/synth/audio -> ml/data/stt/synth/aug/<engine>/<id>.wav), so
the fine-tune does not learn studio-clean voices only. Deterministic per id, resumable.
    ml/stt/.venv/bin/python ml/stt/data/augment_synth.py
  clean 25 %   as synthesised, with 0-150 ms of room tone before and after
  radio 35 %   the game's radio chain (ml/tts/synth.py radio: 300-3400 Hz band-pass, compression, hiss, squelch), hiss -40..-26 dB
  laptop 25 %  pink-ish noise at 12-30 dB SNR, a little room echo (one reflection 8-25 ms), level -6..-20 dB
  phone 15 %   8 kHz telephone band (down to 8 kHz and back) plus light noise: the UWB-ATCC recordings sound like this"""
import hashlib, json, sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import lfilter, resample_poly

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "ml/tts"))
from synth import radio

import os
S = ROOT / "ml/data/stt" / os.environ.get("STT_SYNTH", "synth")
VARIANT = os.environ.get("STT_VARIANT", "")   # "b": a second, different condition per clip, in aug_b/
CONDS = [("clean", 25), ("radio", 35), ("laptop", 25), ("phone", 15)]


def cond_for(i):
    h = int(hashlib.md5((i + VARIANT).encode()).hexdigest(), 16) % 100
    if VARIANT:   # never the same condition as the first copy
        first = int(hashlib.md5(i.encode()).hexdigest(), 16) % 100; acc = 0; cf = None
        for c, p in CONDS:
            acc += p
            if first < acc: cf = c; break
        rest = [(c, p) for c, p in CONDS if c != cf]; h = h * sum(p for _, p in rest) // 100
        for c, p in rest:
            if h < p: return c
            h -= p
    for c, p in CONDS:
        if h < p: return c
        h -= p


def pink(n, rng):
    w = rng.standard_normal(n)
    return lfilter([0.049922035, -0.095993537, 0.050612699, -0.004408786], [1, -2.494956002, 2.017265875, -0.522189400], w)


def apply(x, cond, rng):
    sr = 16000
    pad = lambda: np.zeros(int(rng.uniform(0, 0.15) * sr), np.float32)
    x = np.concatenate([pad(), x, pad()])
    if cond == "radio":
        y = radio(x, sr=sr, seed=int(rng.integers(1 << 30)), noise_db=float(rng.uniform(-40, -26)), drive=float(rng.uniform(1.5, 3.5)))
    elif cond == "laptop":
        d = int(rng.uniform(0.008, 0.025) * sr); y = x.copy(); y[d:] += x[:-d] * rng.uniform(0.15, 0.4)
        n = pink(len(y), rng); snr = rng.uniform(12, 30)
        y = y + n / (np.std(n) + 1e-9) * np.std(y) * 10 ** (-snr / 20)
        y = y / (np.abs(y).max() + 1e-9) * 10 ** (rng.uniform(-20, -6) / 20)
    elif cond == "phone":
        y = resample_poly(resample_poly(x, 1, 2), 2, 1)[: len(x)]
        y = y + rng.standard_normal(len(y)) * np.std(y) * 10 ** (-rng.uniform(25, 40) / 20)
        y = y / (np.abs(y).max() + 1e-9) * 0.8
    else:
        y = x + rng.standard_normal(len(x)) * 10 ** (-70 / 20)
    return np.clip(y, -1, 1).astype(np.float32)


def main():
    rows = [json.loads(l) for l in open(S / "lines.jsonl")]
    done = skipped = 0
    for r in rows:
        src = S / "audio" / r["engine"] / f"{r['id']}.wav"; dst = S / ("aug_" + VARIANT if VARIANT else "aug") / r["engine"] / f"{r['id']}.wav"
        if not src.exists() or dst.exists(): skipped += 1; continue
        x, sr = sf.read(str(src), dtype="float32")
        rng = np.random.default_rng(int(hashlib.md5((r["id"] + VARIANT).encode()).hexdigest()[:8], 16))
        dst.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(dst), apply(x, cond_for(r["id"]), rng), 16000, subtype="PCM_16"); done += 1
    print(f"augmented {done}, skipped {skipped} (missing or done)")


if __name__ == "__main__":
    main()

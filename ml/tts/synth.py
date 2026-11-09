"""Pilot-voice synthesis for the TTS benchmark (ml/tts/RESULTS.md): Paradee-8M v1.2 (int8 ONNX) and Kokoro-82M, plus the
radio effect the game applies in the browser (src/components/atc/sound.ts), so offline clips sound like the game.

    ml/stt/.venv/bin/python ml/tts/synth.py  (imported by bench.py and samples.py)

Paradee: text -> misaki phonemes (American for af_/am_, British for bf_/bm_, as the package does) -> vocab ids between two
0 pads (at most 510) -> one ONNX graph (input_ids, speed, voice) -> 24 kHz float32. The model is read from
public/models/tts/paradee-8m-v1.2/ (the file the browser loads) or ml/tts/cache/paradee/onnx/.
"""
import json, os, re, time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SR = 24000
PARADEE_VOICES = ["af_heart", "bf_isabella", "am_puck", "bm_fable"]   # model order (config.json "voices")
MAX_PHONEMES = 510


def model_dir() -> Path:
    for d in (ROOT / "public/models/tts/paradee-8m-v1.2", ROOT / "ml/tts/cache/paradee"):
        if (d / "config.json").exists():
            return d
    raise FileNotFoundError("Paradee model not found (ml/tts/fetch.sh)")


_G2P = {}


def g2p(british: bool):
    if british not in _G2P:
        from misaki import en, espeak
        _G2P[british] = en.G2P(trf=False, british=british, fallback=espeak.EspeakFallback(british=british), unk="")
    return _G2P[british]


def phonemize(text: str, voice: str) -> str:
    return g2p(voice.startswith("b"))(text)[0]


class Paradee:
    def __init__(self, threads=1, onnx_name="paradee_int8.onnx"):
        import onnxruntime as ort
        d = model_dir()
        cfg = json.load(open(d / "config.json", encoding="utf-8"))
        self.vocab = cfg["vocab"]; self.voices = cfg["voices"]
        path = d / onnx_name if (d / onnx_name).exists() else d / "onnx" / onnx_name
        self.size = path.stat().st_size
        so = ort.SessionOptions(); so.intra_op_num_threads = threads; so.inter_op_num_threads = 1
        t0 = time.time()
        self.sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
        self.load_s = time.time() - t0

    def ids(self, ps: str):
        return [0] + [self.vocab[c] for c in ps if c in self.vocab][:MAX_PHONEMES] + [0]

    def from_phonemes(self, ps: str, voice="af_heart", speed=1.0) -> np.ndarray:
        feed = {"input_ids": np.array([self.ids(ps)], dtype=np.int64), "speed": np.array([speed], dtype=np.float32),
                "voice": np.array([self.voices.index(voice)], dtype=np.int64)}
        return self.sess.run(None, feed)[0][0].astype(np.float32)

    def __call__(self, text: str, voice="af_heart", speed=1.0):
        return self.from_phonemes(phonemize(text, voice), voice, speed)


class Kokoro:
    def __init__(self, threads=3):
        import torch
        torch.set_num_threads(threads)
        from kokoro import KPipeline, KModel
        t0 = time.time()
        self.model = KModel(repo_id="hexgrad/Kokoro-82M").eval()
        self.pipes = {l: KPipeline(lang_code=l, repo_id="hexgrad/Kokoro-82M", model=self.model) for l in "ab"}
        self.load_s = time.time() - t0

    def __call__(self, text: str, voice="af_heart", speed=1.0):
        parts = [r.audio.numpy() for r in self.pipes[voice[0]](text, voice=voice, speed=speed) if r.audio is not None]
        return np.concatenate(parts).astype(np.float32) if parts else np.zeros(0, np.float32)


# ── radio effect: the same chain as the browser (sound.ts radioChain) ──────────────────────────────────────────────
def _biquad(kind, f0, q, sr):
    """RBJ cookbook biquad (what WebAudio's BiquadFilterNode implements)."""
    w = 2 * np.pi * f0 / sr; a = np.sin(w) / (2 * q); c = np.cos(w)
    if kind == "lowpass":
        b = [(1 - c) / 2, 1 - c, (1 - c) / 2]
    else:
        b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    den = [1 + a, -2 * c, 1 - a]
    return np.array(b) / den[0], np.array(den) / den[0]


def radio(x: np.ndarray, sr=SR, seed=0, noise_db=-34.0, drive=2.5) -> np.ndarray:
    """Band-pass 300-3400 Hz (two high-pass + two low-pass biquads), soft compression (tanh drive), faint band-limited
    hiss under the speech, squelch click at the start and a squelch tail at the end."""
    from scipy.signal import lfilter
    rng = np.random.default_rng(seed)
    pad0, pad1 = int(0.06 * sr), int(0.12 * sr)
    y = np.concatenate([np.zeros(pad0), x / (np.abs(x).max() + 1e-9) * 0.9, np.zeros(pad1)])

    def bp(z):
        for kind, f in (("highpass", 300), ("highpass", 300), ("lowpass", 3400), ("lowpass", 3400)):
            b, a = _biquad(kind, f, 0.7071, sr); z = lfilter(b, a, z)
        return z
    y = bp(y)

    y = np.tanh(drive * y) / np.tanh(drive)
    hiss = bp(rng.standard_normal(len(y))) * 10 ** (noise_db / 20) * 3
    y = y * 0.8 + hiss

    def burst(n, decay):
        b = bp(rng.standard_normal(n)) * np.exp(-np.arange(n) / (decay * sr)); return b * 0.35
    k0, k1 = int(0.035 * sr), int(0.09 * sr)
    y[:k0] += burst(k0, 0.012)
    y[-k1:] += burst(k1, 0.04)
    return (y / max(1.0, np.abs(y).max() / 0.95)).astype(np.float32)


def write_wav(path, x, sr=SR):
    import soundfile as sf
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(x, -1, 1), sr, subtype="PCM_16")


def to16k(x):
    from scipy.signal import resample_poly
    return resample_poly(x, 2, 3).astype(np.float32)


def peak_norm(x, peak=0.89):
    return (x / (np.abs(x).max() + 1e-9) * peak).astype(np.float32)

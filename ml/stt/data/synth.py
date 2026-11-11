"""Speak ml/data/stt/synth/lines.jsonl with one engine: ml/data/stt/synth/audio/<engine>/<id>.wav (16 kHz mono 16-bit, clean;
noise / radio / speed are added at training time). Resumable (existing files are skipped), shardable.
    ml/stt/.venv/bin/python             ml/stt/data/synth.py kokoro   [--shard 0/3]
    ml/stt/.venv/bin/python             ml/stt/data/synth.py paradee
    ml/tts/venvs/phonon/bin/python      ml/stt/data/synth.py phonon   [--shard 0/2]
    ml/tts/venvs/supertonic/bin/python  ml/stt/data/synth.py supertonic
"""
import argparse, json, sys, time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
import os
D = ROOT / "ml/data/stt" / os.environ.get("STT_SYNTH", "synth")   # STT_SYNTH=synth2: round 2 (coverage_lines.py)


def resample(x, sr):
    if sr == 16000: return x.astype(np.float32)
    from math import gcd
    try:
        from scipy.signal import resample_poly
        g = gcd(16000, sr); return resample_poly(x, 16000 // g, sr // g).astype(np.float32)
    except ImportError:   # venvs without scipy: linear interpolation after a crude low-pass (3-tap average)
        if sr > 16000: x = np.convolve(x, np.ones(3) / 3, mode="same")
        t = np.arange(int(len(x) * 16000 / sr)) * sr / 16000
        return np.interp(t, np.arange(len(x)), x).astype(np.float32)


def engine(name, threads):
    if name == "kokoro":
        import torch; torch.set_num_threads(threads)
        from kokoro import KPipeline, KModel
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        m = KModel(repo_id="hexgrad/Kokoro-82M").to(dev).eval()
        pipes = {l: KPipeline(lang_code=l, repo_id="hexgrad/Kokoro-82M", model=m) for l in "ab"}
        def say(t, v, speed):
            parts = [r.audio.cpu().numpy() for r in pipes["b" if v[0] == "b" else "a"](t, voice=v, speed=speed) if r.audio is not None]
            return (np.concatenate(parts) if parts else np.zeros(0)), 24000
        return say
    if name == "paradee":
        sys.path.insert(0, str(ROOT / "ml/tts")); import synth as S
        m = S.Paradee(threads=threads)
        return lambda t, v, speed: (m(t, v, speed), 24000)
    if name == "phonon":
        import ptts; ptts.set_num_threads(threads)
        m = ptts.TTS("hf://gradium/phonon-31m-en", lang="en", quant="q8")
        def say(t, v, speed):
            with m.stream(t, voice=v) as audio:
                parts = [np.asarray(p, dtype=np.float32) for p in audio]; sr = audio.sample_rate
            return np.concatenate(parts), sr
        return say
    if name == "supertonic":
        from supertonic import TTS
        m = TTS(auto_download=True, intra_op_num_threads=threads, inter_op_num_threads=1)
        sr = getattr(m, "sample_rate", 44100); styles = {}
        def say(t, v, speed):
            if v not in styles: styles[v] = m.get_voice_style(voice_name=v)
            wav, _ = m.synthesize(t, voice_style=styles[v], lang="en"); return np.asarray(wav, dtype=np.float32).reshape(-1), sr
        return say
    raise SystemExit(f"unknown engine {name}")


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("engine"); ap.add_argument("--shard", default="0/1"); ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--limit", type=int); a = ap.parse_args()
    k, n = map(int, a.shard.split("/"))
    rows = [r for r in map(json.loads, open(D / "lines.jsonl")) if r["engine"] == a.engine][k::n][: a.limit]
    out = D / "audio" / a.engine; out.mkdir(parents=True, exist_ok=True)
    todo = [r for r in rows if not (out / f"{r['id']}.wav").exists()]
    print(f"{a.engine} shard {a.shard}: {len(rows)} lines, {len(todo)} to do", flush=True)
    say = engine(a.engine, a.threads); say("Roger.", rows[0]["voice"], 1.0)
    t0 = time.time(); audio_s = 0.0; fails = 0
    for i, r in enumerate(todo):
        try:
            x, sr = say(r["say"], r["voice"], r["speed"])
            x = resample(np.asarray(x, dtype=np.float32), sr)
            if len(x) < 8000 or not np.isfinite(x).all(): raise ValueError(f"bad audio ({len(x)} samples)")
            x = x / (np.abs(x).max() + 1e-9) * 0.89
            tmp = out / f"{r['id']}.tmp.wav"; sf.write(str(tmp), x, 16000, subtype="PCM_16"); tmp.rename(out / f"{r['id']}.wav")
            audio_s += len(x) / 16000
        except Exception as e:
            fails += 1; print(f"{r['id']} {r['voice']}: {e}", file=sys.stderr, flush=True)
        if (i + 1) % 100 == 0:
            el = time.time() - t0; print(f"{i + 1}/{len(todo)} {audio_s / el:.2f}x real time, {fails} failed, eta {el / (i + 1) * (len(todo) - i - 1) / 60:.0f} min", flush=True)
    print(f"done {len(todo) - fails}/{len(todo)}, {audio_s / 3600:.2f} h audio, {fails} failed", flush=True)


if __name__ == "__main__":
    main()

"""Other new tiny TTS models on the same 60 lines (ml/tts/RESULTS.md), written like bench.py's clips so that
`bench.py transcribe <name>` and `bench.py score` measure them the same way.

    ml/stt/.venv/bin/python ml/tts/others.py pivo       # empero-ai/PiVo-1.4M (ONNX, voice Pi), ml/tts/cache/pivo
    ml/stt/.venv/bin/python ml/tts/others.py leokani    # milliwattlabs/leokani-tts-7M int8 ONNX + espeak-ng, ml/tts/cache/leokani
    ml/tts/venvs/phonon/bin/python ml/tts/others.py phonon         # gradium/phonon-31m-en via the ptts package (q8)
    ml/tts/venvs/supertonic/bin/python ml/tts/others.py supertonic # Supertone/supertonic-3 via the supertonic package
One voice per model, 1 thread. Text: the ATC normaliser's output (`spoken`).
"""
import json, os, sys, time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ml/tts/out/bench"


def write16(path, x, sr):
    import soundfile as sf
    from math import gcd
    from scipy.signal import resample_poly
    if sr != 16000:
        g = gcd(16000, sr); x = resample_poly(x, 16000 // g, sr // g)
    x = np.asarray(x, dtype=np.float32); x = x / (np.abs(x).max() + 1e-9) * 0.89
    sf.write(str(path), x, 16000, subtype="PCM_16")


def main():
    name = sys.argv[1]
    rows = [json.loads(l) for l in open(ROOT / "ml/tts/data/bench60.jsonl")]
    t0 = time.time()
    if name == "pivo":
        sys.path.insert(0, str(ROOT / "ml/tts/cache/pivo"))
        from pivo import PiVo
        from pivo.text import lexicon
        import re
        m = PiVo(ROOT / "ml/tts/cache/pivo", threads=1); sr = m.sample_rate; voice = "Pi"
        cmu = lexicon()

        def override(w):
            """PiVo reads CMUdict words only: an unknown word is two dictionary words joined ("speedbird"), else spelled."""
            for i in range(len(w) - 2, 1, -1):
                if w[:i] in cmu and w[i:] in cmu:
                    return cmu[w[:i]][0] + cmu[w[i:]][0]
            return [p for c in w if c.isalpha() for p in cmu[c][0]]

        def synth(t):
            oov = {w.lower() for w in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)*", t) if w.lower() not in cmu}
            return m.synthesize(t, voice=voice, overrides={w: override(w) for w in oov} or None)
        size = sum((ROOT / "ml/tts/cache/pivo/onnx" / f).stat().st_size for f in ("encoder.onnx", "decoder.onnx", "conditioning.onnx", "vocoder_step.onnx"))
    elif name == "leokani":
        sys.path.insert(0, str(ROOT / "ml/tts/cache/leokani"))
        import leokani_onnx as L
        m = L.Leokani(str(ROOT / "ml/tts/cache/leokani"), L.MODELS["int8"], None, None, 1, "espeak", None); sr = L.SR; voice = "dala"
        synth = lambda t: m.synthesize(t, None, 1.0)
        size = (ROOT / "ml/tts/cache/leokani/leokani-tts-int8.onnx").stat().st_size
    elif name == "phonon":
        import ptts
        ptts.set_num_threads(1)
        m = ptts.TTS("hf://gradium/phonon-31m-en", lang="en", quant="q8"); voice = "Easton"
        sr = None
        def synth(t):
            with m.stream(t, voice=voice) as audio:
                parts = [np.asarray(p, dtype=np.float32) for p in audio]
                globals()["_sr"] = audio.sample_rate
            return np.concatenate(parts)
        size = 64512352
    elif name == "supertonic":
        from supertonic import TTS
        m = TTS(auto_download=True, intra_op_num_threads=1, inter_op_num_threads=1); voice = "M1"; style = m.get_voice_style(voice_name=voice)
        sr = getattr(m, "sample_rate", 44100)
        def synth(t):
            wav, _ = m.synthesize(t, voice_style=style, lang="en"); return np.asarray(wav, dtype=np.float32).reshape(-1)
        size = None
    else:
        raise SystemExit(name)
    load_s = time.time() - t0
    d = OUT / name; d.mkdir(parents=True, exist_ok=True)
    synth("Roger.")
    clips = []
    for r in rows:
        t1 = time.perf_counter(); x = synth(r["spoken"]); dt = time.perf_counter() - t1
        s = sr or globals().get("_sr", 24000)
        write16(d / f"{r['bench_id']:02d}_{voice}.wav", x, s)
        clips.append({"bench_id": r["bench_id"], "voice": voice, "g2p_s": 0.0, "synth_s": round(dt, 4), "audio_s": round(len(x) / s, 3)})
        print(f"{name} {r['bench_id']:2d} {dt:.3f}s for {len(x) / s:.2f}s", flush=True)
    meta = {"system": name, "threads": 1, "load_s": round(load_s, 2), "load_avg": [round(v, 1) for v in os.getloadavg()], "size_bytes": size, "sr": sr or globals().get("_sr")}
    json.dump({"meta": meta, "clips": clips}, open(d / "timing.json", "w"), indent=1)
    s = sum(c["synth_s"] for c in clips); au = sum(c["audio_s"] for c in clips)
    print(f"{name}: {au / s:.1f}x real time, {s / len(clips):.3f} s per line")


if __name__ == "__main__":
    main()

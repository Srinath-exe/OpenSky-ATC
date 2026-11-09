"""Listening page clips (public/reports/voice-tts-samples.html): each line in ml/tts/data/sample_lines.json read by the four
Paradee voices and by Kokoro af_heart, dry and through the game's radio effect (synth.radio).

    ml/stt/.venv/bin/python ml/tts/samples.py [--threads 2]
Writes public/reports/audio/tts/<line>_<model>-<voice>_{dry,radio}.wav (dry 24 kHz, radio 16 kHz) and
public/reports/audio/tts/samples.json. Lines are real readbacks exported from the engine (ml/tts/lines.sh).
"""
import argparse, json, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth  # noqa: E402

OUT = synth.ROOT / "public/reports/audio/tts"


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--threads", type=int, default=2); ap.add_argument("--no-kokoro", action="store_true")
    a = ap.parse_args()
    lines = json.load(open(synth.ROOT / "ml/tts/data/sample_lines.json"))
    OUT.mkdir(parents=True, exist_ok=True)
    p = synth.Paradee(threads=1)
    k = None if a.no_kokoro else synth.Kokoro(threads=a.threads)
    man = {"lines": [], "sr": synth.SR}
    for i, ln in enumerate(lines):
        row = {"id": i + 1, "text": ln["text"], "icao": ln.get("icao", ""), "note": ln.get("note", ""), "clips": []}
        jobs = [("paradee", v) for v in synth.PARADEE_VOICES] + ([("kokoro", "af_heart")] if k else [])
        for model, voice in jobs:
            t0 = time.time()
            ps = synth.phonemize(ln["text"], voice) if model == "paradee" else None
            x = p.from_phonemes(ps, voice) if model == "paradee" else k(ln["text"], voice)
            dt = time.time() - t0
            stem = f"l{i + 1}_{model}-{voice}"
            synth.write_wav(OUT / f"{stem}_dry.wav", synth.peak_norm(x))
            synth.write_wav(OUT / f"{stem}_radio.wav", synth.to16k(synth.radio(x, seed=i)), 16000)   # band-limited: 16 kHz is enough
            row["clips"].append({"model": model, "voice": voice, "dry": f"{stem}_dry.wav", "radio": f"{stem}_radio.wav",
                                 "dur_s": round(len(x) / synth.SR, 2), "synth_s": round(dt, 3), "phonemes": ps})
            print(f"{stem}: {len(x) / synth.SR:.2f} s audio in {dt:.2f} s", flush=True)
        man["lines"].append(row)
    old = OUT / "samples.json"
    if old.exists():   # keep clips other scripts added (ml/tts/audio8.py)
        man["extra"] = json.load(open(old)).get("extra", [])
    json.dump(man, open(old, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()

"""STT bake-off, step 1 (ml/README.md module 9): speak dataset commands into 16 kHz mono WAV clips.

Uses espeak-ng for now (robotic, but free and on this host). On the GPU box the same script will take a neural TTS
(Kokoro / Piper) with many voices. Each clip keeps its record (context, gold command line, AST) so the
recogniser + parser chain can be scored end to end.

    python3 ml/stt/make_clips.py ml/data/out/KJFK.jsonl --n 40 --out ml/stt/out/clips
"""
import argparse, json, random, subprocess, wave
from pathlib import Path

import numpy as np


def to_16k(path: Path):
    with wave.open(str(path)) as w:
        sr, n = w.getframerate(), w.getnframes()
        pcm = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    if sr != 16000:                                  # linear resample is fine for a smoke benchmark
        t = np.linspace(0, len(pcm) / sr, int(len(pcm) * 16000 / sr), endpoint=False)
        pcm = np.interp(t, np.arange(len(pcm)) / sr, pcm).astype(np.float32)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((np.clip(pcm, -1, 1) * 32767).astype(np.int16).tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+"); ap.add_argument("--n", type=int, default=40); ap.add_argument("--out", default="ml/stt/out/clips")
    ap.add_argument("--voice", default="en-us"); ap.add_argument("--speed", type=int, default=165); ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    rows = [json.loads(l) for p in a.inputs for l in open(p)]
    rng.shuffle(rows)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    meta = []
    for i, r in enumerate(rows[: a.n]):
        text = r["say"].get("FAA") or r["say"].get("ICAO")
        wav = out / f"{i:04d}.wav"
        subprocess.run(["espeak-ng", "-v", a.voice, "-s", str(a.speed), "-w", str(wav), text], check=True, capture_output=True)
        to_16k(wav)
        meta.append({"wav": wav.name, "text": text, "line": r["line"], "ctx": r["ctx"], "ast": r["ast"], "kind": r["kind"], "icao": r["icao"]})
    json.dump(meta, open(out / "meta.json", "w"), indent=1)
    print(f"{len(meta)} clips -> {out}")


if __name__ == "__main__":
    main()

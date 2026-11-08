"""Speech-to-text bake-off on realistic synthetic speech (runs on the GPU instance).

1. Speak N validation commands with Kokoro-82M (neural TTS), rotating voices and speeds; 16 kHz mono.
2. Transcribe every clip with each recogniser; Whisper also once with the callsigns on frequency as a text prompt
   (contextual biasing without training).
3. Write transcripts + timings to results/stt/<model>.json. Scoring (rules parser and our S1 model as the clean-up
   step) happens on the VPS: ml/stt/score.py.

    python ml/gpu/remote/stt_bench.py --n 200
"""
import argparse, json, random, re, time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[3]
OUT = Path("/opt/atc/results/stt"); OUT.mkdir(parents=True, exist_ok=True)
VOICES = ["af_heart", "am_michael", "bf_emma", "bm_george", "af_nicole", "am_fenrir"]


DIG = "zero one two three four five six seven eight nine".split()


def atc_words(text):
    """Speak numbers the way controllers do: thousands as 'four thousand', everything else digit by digit."""
    def one(m):
        t = m.group(0); n = int(t)
        if n >= 1000 and n % 1000 == 0 and n < 100000:
            return f"{' '.join(DIG[int(d)] for d in str(n // 1000))} thousand"
        if n >= 1000 and n % 100 == 0:
            return f"{' '.join(DIG[int(d)] for d in str(n // 1000))} thousand {DIG[(n // 100) % 10]} hundred"
        return " ".join(DIG[int(d)] for d in t)
    return re.sub(r"\d+", one, text)


def make_clips(n, seed=0):
    from kokoro import KPipeline
    from scipy.signal import resample_poly
    rows = [json.loads(l) for l in open(ROOT / "ml/data/out/ds/val.jsonl")]
    random.Random(seed).shuffle(rows)
    rows = [r for r in rows if r["line"] != "SAY AGAIN"][:n]
    # the clean engine phrase the transcript came from is not stored in ds; speak the FAA/ICAO-style transcript text
    pipes = {"a": KPipeline(lang_code="a"), "b": KPipeline(lang_code="b")}
    clips = []
    for i, r in enumerate(rows):
        v = VOICES[i % len(VOICES)]
        text = atc_words(re.sub(r"\b(uh|um|ah|er)\b", "", r["said"])).replace("  ", " ")
        audio = []
        for _, _, a in pipes[v[0]](text, voice=v, speed=random.Random(i).uniform(0.95, 1.2)):
            audio.append(a.numpy() if hasattr(a, "numpy") else np.asarray(a))
        wav24 = np.concatenate(audio).astype(np.float32)
        wav16 = resample_poly(wav24, 2, 3).astype(np.float32)
        np.save(OUT / f"clip{i:04d}.npy", wav16)
        clips.append({"i": i, "voice": v, "text": text, "line": r["line"], "ctx": r["ctx"], "kind": r["kind"], "sec": round(len(wav16) / 16000, 2)})
    json.dump(clips, open(OUT / "clips.json", "w"))
    return clips


def callsign_prompt(ctx):
    names = []
    for line in ctx.split("\n")[1:]:
        m = re.match(r"^\S+ (.+?) (ARR|DEP) ", line)
        if m:
            names.append(m.group(1).title())
    return "Air traffic control. Callsigns: " + ", ".join(names) + "."


def run_model(name, clips, prompt=False):
    from transformers import pipeline
    dev = 0 if torch.cuda.is_available() else -1
    kw = {"torch_dtype": torch.float16} if dev == 0 else {}
    asr = pipeline("automatic-speech-recognition", model=name, device=dev, **kw)
    out = []
    for c in clips:
        a = np.load(OUT / f"clip{c['i']:04d}.npy")
        gk = {}
        if prompt and "whisper" in name:
            ids = asr.tokenizer.get_prompt_ids(callsign_prompt(c["ctx"]), return_tensors="pt").to(asr.device)
            gk = {"generate_kwargs": {"prompt_ids": ids}}
        torch.cuda.synchronize() if dev == 0 else None
        t0 = time.perf_counter()
        text = asr({"raw": a, "sampling_rate": 16000}, **gk)["text"]
        torch.cuda.synchronize() if dev == 0 else None
        ms = (time.perf_counter() - t0) * 1000
        if prompt and "whisper" in name:   # whisper may echo the prompt; keep what follows it
            text = text.split("Callsigns:")[-1] if "Callsigns:" in text else text
        out.append({"i": c["i"], "heard": text.strip(), "ms": round(ms, 1)})
    tag = name.split("/")[-1] + ("+prompt" if prompt else "")
    json.dump({"model": tag, "rows": out}, open(OUT / f"{tag}.json", "w"))
    ms = sorted(r["ms"] for r in out)
    print(json.dumps({"model": tag, "n": len(out), "ms_p50": ms[len(ms) // 2], "ms_p95": ms[int(len(ms) * .95)]}), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--models", default="openai/whisper-large-v3-turbo,moonshine-ai/moonshine-streaming-small,moonshine-ai/moonshine-streaming-medium,Qwen/Qwen3-ASR-0.6B-hf,openai/whisper-base.en")
    a = ap.parse_args()
    clips = json.load(open(OUT / "clips.json")) if (OUT / "clips.json").exists() else make_clips(a.n)
    print(json.dumps({"clips": len(clips), "seconds": round(sum(c["sec"] for c in clips))}), flush=True)
    for m in a.models.split(","):
        for prompt in ([False, True] if "whisper-large" in m else [False]):
            try:
                run_model(m, clips, prompt)
            except Exception as e:  # one broken model must not stop the others
                print(json.dumps({"model": m, "prompt": prompt, "error": str(e)[:300]}), flush=True)


if __name__ == "__main__":
    main()

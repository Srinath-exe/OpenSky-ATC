"""Transcribe a clip set with faster-whisper (CTranslate2, int8 on CPU): the "separate STT service" option.
    ml/stt/.venv/bin/python ml/stt/bench2/transcribe_fw.py <clipdir> <out.jsonl> --model base.en [--prompt phrases|names|none] [--beam 1] [--alts]
Same prompt as the server engine (src/app/api/voice/stt/engine.ts buildPrompt); --alts adds the unprompted decode.
"""
import argparse, json, re, time
from pathlib import Path

import numpy as np
import soundfile as sf


def load_clips(d: Path):
    for name in ("meta.jsonl", "manifest.jsonl", "index.jsonl", "gold.jsonl", "clips.jsonl"):
        if (d / name).exists():
            rows = [json.loads(l) for l in open(d / name) if l.strip()]
            break
    else:
        rows = []
        for f in sorted(d.glob("*.json")):
            try:
                j = json.load(open(f)); j.setdefault("wav", j.get("audio") or j.get("file") or f.with_suffix(".wav").name); rows.append(j)
            except Exception:
                pass
    out = []
    for r in rows:
        wav = r.get("wav") or r.get("audio") or r.get("file") or r.get("path")
        p = Path(wav) if wav and Path(wav).is_absolute() else d / str(wav)
        if wav and p.exists() and (r.get("ctx") or r.get("context")):
            out.append({**r, "wav": wav, "path": p, "ctx": r.get("ctx") or r.get("context"), "cond": r.get("cond", "real")})
    return out


def names(ctx):
    return [m.group(1) for l in ctx.split("\n")[1:] if (m := re.match(r"^\S+ (.+?) (ARR|DEP) ", l))]


def build_prompt(ns, style="phrases"):
    seen, lst = set(), []
    for n in ns:
        n = n.strip().lower()
        if n and n not in seen:
            seen.add(n); lst.append(re.sub(r"\b[a-z]", lambda m: m.group(0).upper(), n))
    lst = lst[:24]
    if not lst or style == "none":
        return None
    if style == "names":
        return f"Air traffic control. Callsigns: {', '.join(lst)}."
    return f"Air traffic control. {', '.join(lst)}. Climb, descend and maintain flight level, turn left heading, reduce speed, cleared to land runway, contact tower."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir"); ap.add_argument("out"); ap.add_argument("--model", default="base.en"); ap.add_argument("--prompt", default="phrases")
    ap.add_argument("--beam", type=int, default=1); ap.add_argument("--alts", action="store_true"); ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--compute", default="int8"); ap.add_argument("--every", type=int, default=1); ap.add_argument("--cond", default=""); ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    from faster_whisper import WhisperModel
    t0 = time.time()
    m = WhisperModel(a.model, device="cpu", compute_type=a.compute, cpu_threads=a.threads, download_root=str(Path.home() / ".cache/openatc-stt/fw"))
    clips = [c for c in load_clips(Path(a.dir)) if (not a.cond or c["cond"] in a.cond.split(",")) and (a.every <= 1 or not str(c.get("id", "")).isdigit() or int(c["id"]) % a.every == 0)]
    if a.limit:
        clips = clips[: a.limit]
    out = Path(a.out); done = set()
    if out.exists():
        done = {json.loads(l)["wav"] for l in open(out) if l.strip()}
    print(json.dumps({"model": a.model, "load_s": round(time.time() - t0, 1), "clips": len(clips), "done": len(done)}), flush=True)
    with open(out, "a") as f:
        for i, c in enumerate(clips):
            if c["wav"] in done:
                continue
            audio, sr = sf.read(str(c["path"]), dtype="float32")
            if audio.ndim > 1:
                audio = audio[:, 0]
            if sr != 16000:
                from scipy.signal import resample_poly
                audio = resample_poly(audio, 16000, sr).astype(np.float32)
            prompt = build_prompt(names(c["ctx"]), a.prompt)
            t1 = time.perf_counter()
            def run(p):
                segs, _ = m.transcribe(audio, language="en", beam_size=a.beam, initial_prompt=p, condition_on_previous_text=False,
                                       without_timestamps=True, vad_filter=False, temperature=0.0)
                return " ".join(s.text.strip() for s in segs).strip()
            alts = [run(prompt)]
            if a.alts and prompt:
                alts.append(run(None))
            ms = (time.perf_counter() - t1) * 1000
            uniq = list(dict.fromkeys(x for x in alts if x))
            f.write(json.dumps({"wav": c["wav"], "heard": uniq[0] if uniq else "", "alts": uniq, "decodes": alts, "ms": round(ms), "sec": round(len(audio) / 16000, 2)}) + "\n"); f.flush()
            if i % 50 == 0:
                print(json.dumps({"i": i, "elapsed_s": round(time.time() - t0)}), flush=True)


if __name__ == "__main__":
    main()

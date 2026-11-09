"""Whistle (Cactus-Compute/whistle, 16.9 MB) through the cactus-compute Python package (the same C++ engine the
browser runs as WASM). Writes the bench JSONL rows (score.ts Row: wav, heard, alts, ms).
    CACTUS_TELEMETRY=0 ml/stt/venvs/cactus/bin/python ml/stt/bench2/edge_cactus.py <clipdir> <out.jsonl> \
        [--keywords none|names|phrases] [--alts] [--every 2] [--threads 2] [--limit N] [--cond clean,laptop]
--keywords names: the airline telephony of every aircraft on frequency (ctx); phrases: + ATC command words.
--alts: also decode without keywords (second guess for the n-best chain), the way the Whisper engines do.
"""
import argparse, json, os, re, sys, time, wave
from pathlib import Path
import numpy as np

PHRASES = ["flight level", "heading", "climb", "descend", "maintain", "reduce speed", "increase speed", "knots",
           "cleared to land", "cleared for takeoff", "line up and wait", "hold short", "runway", "taxi", "contact",
           "tower", "approach", "departure", "ground", "direct", "ILS", "localizer", "niner", "go around", "squawk"]


def load_clips(d: Path):
    for name in ("meta.jsonl", "manifest.jsonl", "index.jsonl", "gold.jsonl", "clips.jsonl"):
        f = d / name
        if f.exists():
            rows = [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
            return [r for r in rows if (d / r["wav"]).exists() and r.get("ctx") and r.get("line")]
    rows = []   # ml/data/gold: one sidecar .json per recording
    prompts = {}
    pf = Path(__file__).resolve().parents[3] / "public/voice/gold-prompts.json"
    if pf.exists():
        prompts = {p["id"]: p for p in json.loads(pf.read_text())["prompts"]}
    for f in sorted(d.glob("*.json")):
        try:
            j = json.loads(f.read_text())
        except Exception:
            continue
        if not isinstance(j, dict):
            continue
        p = {**prompts.get(j.get("id", f.stem), {}), **(j["prompt"] if isinstance(j.get("prompt"), dict) else {})}
        wav = j.get("wav") or j.get("audio") or j.get("file") or f.stem + ".wav"
        r = {**p, **j, "wav": wav, "ctx": j.get("ctx") or p.get("ctx"), "line": j.get("line") or p.get("line")}
        if (d / wav).exists() and r["ctx"] and r["line"]:
            rows.append(r)
    return rows


def read_wav(p: Path) -> np.ndarray:
    with wave.open(str(p)) as w:
        sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    x = np.frombuffer(raw, dtype={2: np.int16, 4: np.int32}[sw]).astype(np.float32) / (32768.0 if sw == 2 else 2147483648.0)
    x = x[::ch] if ch > 1 else x
    if sr != 16000:
        t = np.arange(0, len(x) * 16000 // sr) * (sr / 16000)
        x = np.interp(t, np.arange(len(x)), x).astype(np.float32)
    return np.ascontiguousarray(x, dtype=np.float32)


def names(ctx: str):
    out = []
    for line in ctx.split("\n")[1:]:
        m = re.match(r"^\S+ (.+?) (ARR|DEP) ", line)
        if m:
            n = re.sub(r"\s*\d+\s*$", "", m.group(1)).strip()   # "speedbird 50" -> "speedbird"
            if n and n not in out:
                out.append(n)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir"); ap.add_argument("out")
    ap.add_argument("--keywords", default="names"); ap.add_argument("--alts", action="store_true")
    ap.add_argument("--every", type=int, default=1); ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--limit", type=int, default=0); ap.add_argument("--cond", default="")
    ap.add_argument("--weights", default=None)
    a = ap.parse_args()
    import cactus   # here, so edge_moonshine.py can reuse the clip loader without it
    d = Path(a.dir)
    clips = load_clips(d)
    if a.cond:
        clips = [c for c in clips if c.get("cond") in a.cond.split(",")]
    if a.every > 1:
        clips = [c for c in clips if not c.get("id") or not str(c["id"]).isdigit() or int(c["id"]) % a.every == 0]
    if a.limit:
        clips = clips[: a.limit]
    done = set()
    if os.path.exists(a.out):
        done = {json.loads(l)["wav"] for l in open(a.out) if l.strip()}
    cactus.set_threads(a.threads)
    model = cactus.Whistle(weights=a.weights) if a.weights else cactus.Whistle()
    t0 = time.time()
    model.transcribe(np.zeros(16000, dtype=np.float32), language="en")
    print(json.dumps({"weights": model.weights, "load_s": round(time.time() - t0, 2), "clips": len(clips), "done": len(done)}), file=sys.stderr)
    n = 0
    with open(a.out, "a") as fo:
        for c in clips:
            if c["wav"] in done:
                continue
            audio = read_wav(d / c["wav"])
            kw = [] if a.keywords == "none" else names(c["ctx"]) + (PHRASES if a.keywords == "phrases" else [])
            s = time.time()
            r = model.transcribe(audio, language="en", keywords=kw or None)
            ms = round((time.time() - s) * 1000)
            alts = [r.get("text", "").strip()]
            more_ms = 0
            if a.alts and kw:
                s = time.time()
                r2 = model.transcribe(audio, language="en")
                more_ms = round((time.time() - s) * 1000)
                alts.append(r2.get("text", "").strip())
            uniq = list(dict.fromkeys(x for x in alts if x))
            fo.write(json.dumps({"wav": c["wav"], "heard": uniq[0] if uniq else "", "alts": uniq, "ms": ms, "moreMs": more_ms,
                                 "sec": round(len(audio) / 16000, 2), "ttft_ms": r.get("ttft_ms"), "kw": len(kw)}) + "\n")
            fo.flush()
            n += 1
            if n % 50 == 0:
                print(json.dumps({"n": n, "elapsed_s": round(time.time() - t0)}), file=sys.stderr)
    print(json.dumps({"finished": n, "elapsed_s": round(time.time() - t0)}), file=sys.stderr)


if __name__ == "__main__":
    main()

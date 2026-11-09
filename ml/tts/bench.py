"""TTS benchmark on 60 pilot lines (ml/tts/RESULTS.md): synthesis speed, and intelligibility as Whisper base.en word error.

    PY=ml/stt/.venv/bin/python
    $PY ml/tts/bench.py synth paradee            # Paradee int8, misaki G2P, 4 voices, 1 thread  -> ml/tts/out/bench/paradee/
    $PY ml/tts/bench.py synth kokoro --voices af_heart,bm_fable   # Kokoro-82M, 3 threads   -> ml/tts/out/bench/kokoro/
    $PY ml/tts/bench.py synth paradee-ph --phonemes ml/tts/data/bench60_ph_<g2p>.jsonl --name paradee-<g2p>
                                                 # Paradee from phonemes made by a browser G2P (ml/tts/g2p_eval.mjs)
    $PY ml/tts/bench.py radio paradee            # the same clips through the game's radio effect -> paradee-radio/
    $PY ml/tts/bench.py transcribe paradee       # faster-whisper base.en, no prompt, beam 5, 2 threads
    $PY ml/tts/bench.py score                    # WER table over every transcribed system -> ml/tts/out/bench/scores.json

Lines: ml/tts/data/bench60.jsonl (ml/tts/pick.py); the text read is `spoken`, the ATC normaliser's output
(src/lib/tts/pilotSpeech.ts), which is also the WER reference. Clips are written at 16 kHz for Whisper.
WER normalisation (both sides): lower case, punctuation and hyphens out, ICAO digits (tree/fife/niner) as digits,
every number (spoken or written: "one fifty-three", "153", "four thousand five hundred", "4,500") as single digits,
"decimal" = "point", spelled letters joined ("J F K" = "jfk"), a few split names joined ("speed bird" = "speedbird").
"""
import argparse, json, os, re, sys, time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth  # noqa: E402

ROOT = synth.ROOT
OUT = ROOT / "ml/tts/out/bench"
VOICES = ["af_heart", "am_puck", "bf_isabella", "bm_fable"]


def lines():
    return [json.loads(l) for l in open(ROOT / "ml/tts/data/bench60.jsonl")]


def load_avg():
    try:
        return [round(x, 1) for x in os.getloadavg()]
    except OSError:
        return None


def cmd_synth(a):
    rows = lines()
    name = a.name or a.system
    d = OUT / name; d.mkdir(parents=True, exist_ok=True)
    ph = {}
    if a.system == "paradee-ph":
        for l in open(a.phonemes):
            j = json.loads(l); ph[(j["bench_id"], j["voice"])] = j["phonemes"]
    if a.system.startswith("paradee"):
        eng = synth.Paradee(threads=a.threads)
    elif a.system == "kokoro":
        eng = synth.Kokoro(threads=a.threads)
    else:
        raise SystemExit(f"unknown system {a.system}")
    timing = []
    # warm-up (first call allocates)
    (eng.from_phonemes(synth.phonemize("Roger.", "af_heart"), "af_heart") if a.system.startswith("paradee") else eng("Roger.", "af_heart"))
    for r in rows:
        for v in (a.voices.split(",") if a.voices else VOICES):
            t0 = time.perf_counter()
            if a.system == "paradee":
                ps = synth.phonemize(r["spoken"], v); t1 = time.perf_counter(); x = eng.from_phonemes(ps, v)
            elif a.system == "paradee-ph":
                ps = ph[(r["bench_id"], v)]; t1 = time.perf_counter(); x = eng.from_phonemes(ps, v)
            else:
                ps = None; t1 = t0; x = eng(r["spoken"], v)
            t2 = time.perf_counter()
            synth.write_wav(d / f"{r['bench_id']:02d}_{v}.wav", synth.to16k(synth.peak_norm(x)), 16000)
            np.save(d / f"{r['bench_id']:02d}_{v}.npy", x) if a.keep24 else None
            timing.append({"bench_id": r["bench_id"], "voice": v, "g2p_s": round(t1 - t0, 4), "synth_s": round(t2 - t1, 4),
                           "audio_s": round(len(x) / synth.SR, 3), "phonemes": ps, "n_ph": len(ps) if ps else None})
        print(f"{name} {r['bench_id']:2d} {timing[-1]['synth_s']:.3f}s for {timing[-1]['audio_s']:.2f}s", flush=True)
    meta = {"system": name, "threads": a.threads, "load_avg": load_avg(), "load_s": round(eng.load_s, 2),
            "size_bytes": getattr(eng, "size", None)}
    json.dump({"meta": meta, "clips": timing}, open(d / "timing.json", "w"), indent=1, ensure_ascii=False)
    s = sum(t["synth_s"] for t in timing); au = sum(t["audio_s"] for t in timing)
    print(f"{name}: {len(timing)} clips, {s:.1f} s synth for {au:.1f} s audio = {au / s:.1f}x real time; load avg {meta['load_avg']}")


def cmd_radio(a):
    src = OUT / a.system; d = OUT / (a.name or f"{a.system}-radio"); d.mkdir(parents=True, exist_ok=True)
    want = set(a.voices.split(",")) if a.voices else None
    import soundfile as sf
    from scipy.signal import resample_poly
    for f in sorted(src.glob("*.wav")):
        if want and f.stem[3:] not in want:
            continue
        x, sr = sf.read(str(f), dtype="float32")
        x24 = resample_poly(x, 3, 2).astype(np.float32)
        synth.write_wav(d / f.name, synth.to16k(synth.radio(x24, seed=hash(f.stem) & 0xffff, noise_db=a.noise_db, drive=a.drive)), 16000)
    print(f"radio: {d}")


def cmd_transcribe(a):
    from faster_whisper import WhisperModel
    m = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=a.threads,
                     download_root=str(Path.home() / ".cache/openatc-stt/fw"))
    import soundfile as sf
    d = OUT / a.system; res = {}
    t0 = time.time()
    want = set(a.voices.split(",")) if a.voices else None
    for f in sorted(d.glob("*.wav")):
        if want and f.stem[3:] not in want:
            continue
        x, sr = sf.read(str(f), dtype="float32")   # 16 kHz mono; an array, not a path (this PyAV rejects faster-whisper's open())
        segs, _ = m.transcribe(x, language="en", beam_size=5, condition_on_previous_text=False, vad_filter=False)
        res[f.stem] = " ".join(s.text.strip() for s in segs).strip()
    json.dump(res, open(d / f"hyp_{a.model}.json", "w"), indent=1)
    print(f"{a.system}: {len(res)} clips transcribed in {time.time() - t0:.0f} s", flush=True)


# ── WER ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
DIG = {"zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "tree": 3, "four": 4, "five": 5, "fife": 5, "six": 6, "seven": 7,
       "eight": 8, "nine": 9, "niner": 9}
TEEN = {w: 10 + i for i, w in enumerate("ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split())}
TENS = {w: 10 * (i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}
JOIN = [("speed bird", "speedbird"), ("jet blue", "jetblue"), ("i fly", "ifly"), ("will co", "wilco"), ("push back", "pushback"),
        ("start up", "startup"), ("juliet", "juliett"), ("alfa", "alpha"), ("x ray", "xray"), ("kingsford", "kingsford"),
        ("sky dubai", "skydubai"), ("skydubai", "skydubai")]


def numbers(tokens):
    """Number words and digit strings -> single digits. "one fifty three" -> 1 5 3, "four thousand five hundred" -> 4 5 0 0."""
    out, i = [], 0
    while i < len(tokens):
        t = tokens[i]
        if re.fullmatch(r"\d+", t):
            out.append(t); i += 1; continue
        if t in DIG:
            out.append(str(DIG[t])); i += 1; continue
        if t in TEEN:
            out.append(str(TEEN[t])); i += 1; continue
        if t in TENS:
            v = TENS[t]
            if i + 1 < len(tokens) and tokens[i + 1] in DIG and DIG[tokens[i + 1]] > 0:
                v += DIG[tokens[i + 1]]; i += 1
            out.append(str(v)); i += 1; continue
        if t == "hundred" and out and out[-1].isdigit():
            out[-1] += "00"; i += 1; continue
        if t == "thousand" and out and out[-1].isdigit():
            # "four thousand five hundred" -> 4500; "four thousand" -> 4000
            if i + 2 < len(tokens) and tokens[i + 1] in DIG and tokens[i + 2] == "hundred":
                out[-1] += str(DIG[tokens[i + 1]]) + "00"; i += 3; continue
            out[-1] += "000"; i += 1; continue
        out.append(t); i += 1
    # adjacent digit groups form one number string, then split into single digits
    res = []
    for t in out:
        if t.isdigit():
            res.extend(list(t))
        else:
            res.append(t)
    return res


def norm(s):
    s = s.lower()
    s = re.sub(r"(\d),(\d)", r"\1\2", s)
    s = re.sub(r"(\d)\.(\d)", r"\1 point \2", s)
    s = s.replace("decimal", "point")
    s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", s)
    s = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", s)
    s = re.sub(r"[-‐–—/]", " ", s)
    s = re.sub(r"[^a-z0-9' ]", " ", s).replace("'", "")
    s = " " + " ".join(s.split()) + " "
    for a_, b_ in JOIN:
        s = s.replace(f" {a_} ", f" {b_} ")
    toks = s.split()
    # spelled letters ("j f k", "i l s") joined into one token
    j, prev_single = [], False
    for t in toks:
        single = len(t) == 1 and t.isalpha() and t != "a"
        if single and prev_single:
            j[-1] += t
        else:
            j.append(t)
        prev_single = single
    return numbers(j)


def wer_counts(ref, hyp):
    import jiwer
    o = jiwer.process_words(" ".join(ref) or "x", " ".join(hyp) or "x")
    return o.substitutions + o.deletions + o.insertions, len(ref)


def cmd_score(a):
    rows = {r["bench_id"]: r for r in lines()}
    out = {}
    for d in sorted(p for p in OUT.iterdir() if p.is_dir()):
        hf = d / f"hyp_{a.model}.json"
        if not hf.exists():
            continue
        hyp = json.load(open(hf))
        per_voice, errs, words, exact, worst = {}, 0, 0, 0, []
        for stem, h in hyp.items():
            bid, voice = int(stem[:2]), stem[3:]
            ref = norm(rows[bid]["spoken"]); hy = norm(h)
            e, n = wer_counts(ref, hy)
            errs += e; words += n; exact += e == 0
            pv = per_voice.setdefault(voice, [0, 0]); pv[0] += e; pv[1] += n
            if e:
                worst.append({"id": stem, "e": e, "ref": rows[bid]["spoken"], "hyp": h})
        tim = json.load(open(d / "timing.json")) if (d / "timing.json").exists() else None
        sp = None
        if tim:
            s = sum(t["synth_s"] for t in tim["clips"]); au = sum(t["audio_s"] for t in tim["clips"])
            sp = {"synth_s_per_line": round(s / len(tim["clips"]), 3), "x_realtime": round(au / s, 1), "audio_s_per_line": round(au / len(tim["clips"]), 2),
                  "threads": tim["meta"]["threads"], "load_avg": tim["meta"]["load_avg"],
                  "g2p_s_per_line": round(sum(t["g2p_s"] for t in tim["clips"]) / len(tim["clips"]), 4)}
        out[d.name] = {"clips": len(hyp), "wer": round(100 * errs / max(1, words), 2), "line_exact": round(100 * exact / max(1, len(hyp)), 1),
                       "per_voice": {v: round(100 * x[0] / max(1, x[1]), 2) for v, x in sorted(per_voice.items())}, "speed": sp,
                       "worst": sorted(worst, key=lambda w: -w["e"])[:12]}
        print(f"{d.name:24s} n={len(hyp):3d} WER {out[d.name]['wer']:5.2f}%  exact {out[d.name]['line_exact']:5.1f}%  {out[d.name]['per_voice']}  {sp or ''}")
    json.dump(out, open(OUT / "scores.json", "w"), indent=1, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd"); ap.add_argument("system", nargs="?", default="paradee")
    ap.add_argument("--threads", type=int, default=0); ap.add_argument("--phonemes"); ap.add_argument("--name")
    ap.add_argument("--model", default="base.en"); ap.add_argument("--keep24", action="store_true")
    ap.add_argument("--voices", default="", help="comma list (default: all four)")
    ap.add_argument("--drive", type=float, default=2.5, help="radio: tanh drive"); ap.add_argument("--noise-db", type=float, default=-34.0, help="radio: hiss level")
    a = ap.parse_args()
    if not a.threads:
        a.threads = {"synth": 3 if a.system == "kokoro" else 1, "transcribe": 2}.get(a.cmd, 1)
    {"synth": cmd_synth, "radio": cmd_radio, "transcribe": cmd_transcribe, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()

"""End to end on casual speech: the exam lines (independent, stress, held-out) spoken by four Kokoro voices, transcribed
by the game's speech model, then read by the game's chain. Measures what a player actually gets.
    ml/stt/.venv/bin/python ml/s1/freeword/speech_e2e.py synth
    OPENATC_STT_PARAKEET_DIR=... node ml/stt/data/check.cjs ml/s1/freeword/e2e/list.jsonl ml/s1/freeword/e2e/heard.jsonl
    ml/stt/.venv/bin/python ml/s1/freeword/speech_e2e.py rows      -> ml/s1/freeword/e2e.json (rows for allsets.sh)"""
import json, sys, wave
from pathlib import Path
import numpy as np
D = Path(__file__).parent; OUT = D / "e2e"
SETS = ["indep", "stress", "held"]
VOICES = ["af_heart", "bf_isabella", "am_puck", "bm_fable"]


def rows():
    out = []
    for s in SETS:
        for r in json.load(open(D / f"{s}.json")): out.append({**r, "key": f"{s}:{r['key']}", "set": s})
    return out


def synth():
    import torch; torch.set_num_threads(1)
    from kokoro import KPipeline, KModel
    from scipy.signal import resample_poly
    m = KModel(repo_id="hexgrad/Kokoro-82M").eval()
    pipes = {l: KPipeline(lang_code=l, repo_id="hexgrad/Kokoro-82M", model=m) for l in "ab"}
    OUT.mkdir(exist_ok=True)
    with open(OUT / "list.jsonl", "w") as f:
        for i, r in enumerate(rows()):
            v = VOICES[i % 4]
            x = np.concatenate([a.audio.numpy() for a in pipes["b" if v[0] == "b" else "a"](r["heard"], voice=v, speed=1.05) if a.audio is not None])
            x = resample_poly(x, 2, 3).astype(np.float32)
            p = OUT / f"{i:04d}.wav"
            with wave.open(str(p), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
            f.write(json.dumps({"id": f"{i:04d}", "wav": str(p), "text": r["heard"], "key": r["key"], "ctx": r["ctx"]}) + "\n")
    print("synth done")


def make_rows():
    H = {r["id"]: r.get("heard") or "" for r in map(json.loads, open(OUT / "heard.jsonl"))}
    L = list(map(json.loads, open(OUT / "list.jsonl"))); src = {r["key"]: r for r in rows()}
    out = []
    for x in L:
        r = dict(src[x["key"]]); r["said_text"] = r["heard"]; r["heard"] = H.get(x["id"], ""); out.append(r)
    json.dump(out, open(D / "e2e.json", "w"), indent=1)
    sys.path.insert(0, str(D.parents[1] / "stt/data")); from wer import wer_num
    n = sum(len(r["said_text"].split()) for r in out); e = sum(wer_num(r["said_text"], r["heard"]) * len(r["said_text"].split()) for r in out)
    print(len(out), "rows; speech-model word error on casual speech", round(100 * e / n, 2), "%")


if __name__ == "__main__":
    {"synth": synth, "rows": make_rows}[sys.argv[1]]()

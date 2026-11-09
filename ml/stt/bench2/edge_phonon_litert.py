"""Phonon-2.5 English as the phone would run it: litert-community/Phonon-2.5-English, int8 CPU encoder + int8 TDT
decoder through LiteRT (ai-edge-litert 2.3.0), greedy TDT decoding as in the card's reference script. A parity check of
the phone build against the server agent's reference run (results/srv-phonon.jsonl). No biasing (greedy TDT).
    ml/stt/venvs/litert/bin/python ml/stt/bench2/edge_phonon_litert.py <clipdir> <out.jsonl> [--every 2] [--limit 40] [--threads 1]
"""
import argparse, json, os, sys, time
from pathlib import Path
import numpy as np
from ai_edge_litert.interpreter import Interpreter
from tokenizers import Tokenizer
sys.path.insert(0, str(Path(__file__).resolve().parent))
from edge_cactus import load_clips, read_wav   # noqa: E402

M = Path(__file__).resolve().parents[1] / "models/edge-phonon-litert"
BUCKETS = {5: 504, 7.5: 752, 10: 1000, 15: 1504}
BLANK, EOS = 8192, 3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir"); ap.add_argument("out")
    ap.add_argument("--every", type=int, default=1); ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--threads", type=int, default=1)
    a = ap.parse_args()
    t0 = time.time()
    mel = {s: Interpreter(str(M / f"phonon25en_mel_{s}s.tflite"), num_threads=a.threads).get_signature_runner() for s in BUCKETS}
    encoder = Interpreter(str(M / "phonon25en_encoder_i8.tflite"), num_threads=a.threads)
    enc = {s: encoder.get_signature_runner(f"enc{s}") for s in BUCKETS}
    dec = Interpreter(str(M / "phonon25en_decoder_i8.tflite"), num_threads=1)
    predict, joint = dec.get_signature_runner("predict"), dec.get_signature_runner("joint")
    tok = Tokenizer.from_file(str(M / "tokenizer.json"))
    print(json.dumps({"load_s": round(time.time() - t0, 1)}), file=sys.stderr)

    def window(x):
        n = len(x)
        s = next(s for s, t in BUCKETS.items() if n <= 160 * t)
        audio = np.zeros((1, 160 * BUCKETS[s]), np.float32); audio[0, :n] = x
        m = mel[s](audio=audio, n_valid=np.array([n], np.int32))
        e = enc[s](features=m["features"], mel_mask=m["mel_mask"])["enc"][0]
        frames = int(m["frame_mask"].sum())
        st = predict(token=np.array([[BLANK]], np.int32), h=np.zeros((2, 1, 640), np.float32), c=np.zeros((2, 1, 640), np.float32))
        ids, t, steps, run = [], 0, 0, 0
        while t < frames and steps < 3750:
            steps += 1
            lg = joint(enc_frame=e[t:t + 1], dec_out=st["dec_out"])["logits"][0]
            k, d = int(np.argmax(lg[:8193])), int(np.argmax(lg[8193:]))
            if k == BLANK and d == 0:
                d = 1
            if k != BLANK:
                ids.append(k)
                if k == EOS:
                    break
                st = predict(token=np.array([[k]], np.int32), h=st["h_out"], c=st["c_out"])
            run = run + 1 if d == 0 else 0
            if run >= 10:
                d, run = 1, 0
            t += d
        return tok.decode(ids, skip_special_tokens=True)

    d = Path(a.dir)
    clips = [c for c in load_clips(d) if a.every <= 1 or not str(c.get("id", "")).isdigit() or int(c["id"]) % a.every == 0]
    if a.limit:
        clips = clips[: a.limit]
    with open(a.out, "w") as fo:
        for c in clips:
            x = read_wav(d / c["wav"])
            x = (np.round(x * 32767) / 32768).astype(np.float32)[: 160 * 1504]   # 16-bit values as the card's runner reads them
            s = time.time(); h = window(x).strip(); ms = round((time.time() - s) * 1000)
            fo.write(json.dumps({"wav": c["wav"], "heard": h, "alts": [h] if h else [], "ms": ms, "sec": round(len(x) / 16000, 2)}) + "\n")
    print(json.dumps({"finished": len(clips), "elapsed_s": round(time.time() - t0)}), file=sys.stderr)


if __name__ == "__main__":
    main()

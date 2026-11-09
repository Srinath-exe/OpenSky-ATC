"""Audio8-TTS-Realistic-Air (Edge0, 0.6B DualAR + 44.1 kHz codec, Apache-2.0) on this CPU: seconds per readback and
Whisper word error on a few of the benchmark lines, plus listening-page clips (ml/tts/RESULTS.md).

    ml/tts/venvs/audio8/bin/python ml/tts/audio8.py [--n 5] [--threads 3] [--samples 3]

The model's custom code (configuration/modeling/processing_arktts.py) was read before running: it only builds the model,
loads the weights (torch.load weights_only=True, safetensors) and generates. It is loaded from the local snapshot in
ml/tts/cache/audio8, so the reviewed files are the ones that run. No reference voice is used (no cloning).
Writes ml/tts/out/bench/audio8/<id>_default.wav (16 kHz, for bench.py transcribe/score) + timing.json, and with
--samples, public/reports/audio/tts/audio8_*.wav entries under "extra" in samples.json.
"""
import argparse, json, os, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SNAP = ROOT / "ml/tts/cache/audio8"


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=5); ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--samples", type=int, default=3); ap.add_argument("--ids", default="0,6,18,38,43")
    a = ap.parse_args()
    import numpy as np, soundfile as sf, torch
    from scipy.signal import resample_poly
    torch.set_num_threads(a.threads)
    from transformers import AutoModel, AutoProcessor
    t0 = time.time()
    proc = AutoProcessor.from_pretrained(str(SNAP), trust_remote_code=True)
    model = AutoModel.from_pretrained(str(SNAP), trust_remote_code=True, dtype=torch.float32).eval()
    load_s = time.time() - t0
    print(f"loaded in {load_s:.1f} s", flush=True)
    rows = {json.loads(l)["bench_id"]: json.loads(l) for l in open(ROOT / "ml/tts/data/bench60.jsonl")}
    ids = [int(x) for x in a.ids.split(",")][: a.n]
    out = ROOT / "ml/tts/out/bench/audio8"; out.mkdir(parents=True, exist_ok=True)
    clips = []
    for bid in ids:
        text = rows[bid]["spoken"]
        inputs = proc(text=[text], return_tensors="pt")
        t1 = time.time()
        with torch.inference_mode():
            g = model.generate(**inputs, max_new_tokens=400, temperature=0.7, top_p=0.9, top_k=50, do_sample=True, return_dict_in_generate=True)
            t2 = time.time()
            wav, lens = model.decode_audio(g.codes)
        t3 = time.time()
        x = wav[0, : int(lens[0])].float().cpu().numpy()
        sr = model.config.codec_sample_rate
        x16 = resample_poly(x, 160, 441).astype(np.float32)
        x16 = x16 / (np.abs(x16).max() + 1e-9) * 0.89
        sf.write(str(out / f"{bid:02d}_default.wav"), x16, 16000, subtype="PCM_16")
        np.save(out / f"{bid:02d}_default_44k.npy", x)
        c = {"bench_id": bid, "voice": "default", "text": text, "frames": int(g.codes.shape[-1]), "generate_s": round(t2 - t1, 2),
             "decode_s": round(t3 - t2, 2), "synth_s": round(t3 - t1, 2), "audio_s": round(len(x) / sr, 2), "g2p_s": 0.0}
        clips.append(c)
        print(json.dumps(c), flush=True)
    meta = {"system": "audio8", "threads": a.threads, "load_s": round(load_s, 1), "load_avg": [round(v, 1) for v in os.getloadavg()],
            "params_main": 601159424, "size_bytes": (SNAP / "model.safetensors").stat().st_size + (SNAP / "codec.pth").stat().st_size}
    json.dump({"meta": meta, "clips": clips}, open(out / "timing.json", "w"), indent=1)
    if a.samples:
        sys.path.insert(0, str(ROOT / "ml/tts")); import synth
        aud = ROOT / "public/reports/audio/tts"; man_p = aud / "samples.json"; man = json.load(open(man_p))
        man["extra"] = []
        for c in clips[: a.samples]:
            x = np.load(out / f"{c['bench_id']:02d}_default_44k.npy")
            x24 = resample_poly(x, 80, 147).astype(np.float32)
            f = f"audio8_{c['bench_id']:02d}_dry.wav"; synth.write_wav(aud / f, synth.peak_norm(x24))
            fr = f"audio8_{c['bench_id']:02d}_radio.wav"; synth.write_wav(aud / fr, synth.to16k(synth.radio(x24, seed=c["bench_id"])), 16000)
            note = f"{c['synth_s']:.0f} s on 3 CPU threads for {c['audio_s']:.1f} s of speech"
            man["extra"] += [{"model": "Audio8-TTS-Realistic-Air", "voice": "default voice, no reference", "kind": "Dry", "file": f, "text": c["text"], "note": note},
                             {"model": "Audio8-TTS-Realistic-Air", "voice": "default voice, no reference", "kind": "Radio", "file": fr, "text": c["text"], "note": ""}]
        man["extra_note"] = ("Audio8-TTS-Realistic-Air (Edge0, Apache-2.0) is a 0.6B-parameter DualAR model with a 44.1 kHz codec, 2.5 GB "
                             "of weights. It is far too big for the browser; it is here as a sense of what a large model sounds like, and "
                             "as a possible offline generator of training audio.")
        json.dump(man, open(man_p, "w"), indent=1, ensure_ascii=False)
        print("samples.json: extra", len(man["extra"]))


if __name__ == "__main__":
    main()

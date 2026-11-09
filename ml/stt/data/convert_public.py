"""Public ATC corpora (ml/data/stt/raw, fetch_public.py) -> 16 kHz mono 16-bit WAV + manifests in ml/data/stt/public/.
    ml/stt/.venv/bin/python ml/stt/data/convert_public.py
Manifest rows: {id, wav, text, duration, source, split, licence, use, role}. `text` is textnorm.norm of the corpus
transcript (already lower-case spoken words). role: controller / pilot / mixed (UWB-ATCC id suffix _AT / _PI / _PIAT),
controller for ATCOSIM, unknown for ATCO2."""
import glob, io, json, sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent))
from textnorm import norm

SRC = {
    "uwb_atcc": dict(licence="CC BY-NC-SA 4.0", use="train-nc"),
    "atcosim": dict(licence="ATCOSIM (free of charge; commercial use not granted)", use="train-nc"),
    "atco2_1h": dict(licence="ATCO2 end-user data agreement", use="eval-only"),
}
OUT = ROOT / "ml/data/stt/public"


def role(name, rid):
    if name == "uwb_atcc": return {"AT": "controller", "PI": "pilot"}.get(rid.rsplit("_", 1)[-1], "mixed")
    return "controller" if name == "atcosim" else "unknown"


def main():
    for name, meta in SRC.items():
        for split in ("train", "test"):
            files = sorted(glob.glob(str(ROOT / f"ml/data/stt/raw/{name}/data/{split}-*.parquet")))
            if not files: continue
            d = OUT / name / split; d.mkdir(parents=True, exist_ok=True)
            man = OUT / f"{name}_{split}.jsonl"; n = 0; secs = 0.0; skipped = 0
            with open(man, "w") as fo:
                for f in files:
                    for batch in pq.ParquetFile(f).iter_batches(batch_size=256):
                        for r in batch.to_pylist():
                            text = norm(r["text"] or "")
                            if not text: skipped += 1; continue
                            wav = d / f"{r['id']}.wav"
                            if not wav.exists():
                                x, sr = sf.read(io.BytesIO(r["audio"]["bytes"]), dtype="float32")
                                if x.ndim > 1: x = x.mean(axis=1)
                                if sr != 16000:
                                    from math import gcd
                                    g = gcd(16000, sr); x = resample_poly(x, 16000 // g, sr // g).astype(np.float32)
                                sf.write(str(wav), np.clip(x, -1, 1), 16000, subtype="PCM_16")
                                dur = len(x) / 16000
                            else:
                                dur = sf.info(str(wav)).duration
                            fo.write(json.dumps({"id": r["id"], "wav": str(wav.relative_to(ROOT)), "text": text, "duration": round(dur, 3), "source": name,
                                                 "split": split, "licence": meta["licence"], "use": meta["use"], "role": role(name, r["id"])}) + "\n")
                            n += 1; secs += dur
            print(f"{name} {split}: {n} clips, {secs / 3600:.2f} h, {skipped} empty -> {man.relative_to(ROOT)}", flush=True)


if __name__ == "__main__":
    main()

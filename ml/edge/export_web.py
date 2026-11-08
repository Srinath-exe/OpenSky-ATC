"""Export an S1 checkpoint for the browser (ml/README.md module 10, edge: browser).

Writes public/models/<name>/:
  model.json   config, tensor table (name, shape, offset, dtype, scale), tokenizer merges, specials, calibration T
  model.bin    the weights, little-endian: fp16, or int8 with one fp32 scale per output row (--int8)
The browser engine (src/lib/voice/s1.ts) reads exactly this. Quantization is measured, not assumed: --check runs the
dequantized weights through the PyTorch model on validation examples and reports exact-match against fp32.

    python3 ml/edge/export_web.py --run ml/gpu/results/s1-2m-11ap-swap --name s1-2m --int8 --check 300
"""
import argparse, json, struct, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/s1")); sys.path.insert(0, str(ROOT / "ml/tokenizer"))
import compat  # noqa: F401,E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from bpe import BPE, SPECIALS  # noqa: E402
from model import GPT, Config  # noqa: E402


def quantize(w: np.ndarray, int8: bool):
    if not int8 or w.ndim != 2:
        return w.astype(np.float16), "f16", None
    scale = np.maximum(np.abs(w).max(axis=1), 1e-8) / 127.0          # one scale per output row
    q = np.clip(np.round(w / scale[:, None]), -127, 127).astype(np.int8)
    return q, "i8", scale.astype(np.float32)


def dequant(q, dt, scale):
    return q.astype(np.float32) if dt == "f16" else q.astype(np.float32) * scale[:, None]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--name", default="s1-2m"); ap.add_argument("--tok", default=str(ROOT / "ml/tokenizer/atc.json"))
    ap.add_argument("--int8", action="store_true"); ap.add_argument("--temperature", type=float, default=1.0); ap.add_argument("--check", type=int, default=0)
    ap.add_argument("--data", default=str(ROOT / "ml/data/out/ds/val.jsonl"))
    a = ap.parse_args()
    cfg = json.load(open(Path(a.run) / "config.json"))
    sd = torch.load(Path(a.run) / "model.pt", map_location="cpu")
    out = ROOT / "public/models" / a.name; out.mkdir(parents=True, exist_ok=True)
    table, blobs, off = [], [], 0
    deq = {}
    for name, t in sd.items():
        w = t.float().numpy()
        q, dt, scale = quantize(w, a.int8)
        b = q.tobytes(); entry = {"name": name, "shape": list(w.shape), "offset": off, "dtype": dt, "bytes": len(b)}
        blobs.append(b); off += len(b)
        if scale is not None:
            sb = scale.tobytes(); entry["scale_offset"] = off; blobs.append(sb); off += len(sb)
        while off % 4:   # keep every tensor 4-byte aligned for Float32Array / Int8Array views
            blobs.append(b"\0"); off += 1
        table.append(entry); deq[name] = torch.from_numpy(dequant(q, dt, scale))
    (out / "model.bin").write_bytes(b"".join(blobs))
    tok = BPE.load(a.tok)
    meta = {"format": "atc-s1-web-1", "config": cfg["model"], "params": cfg["params"], "quant": "int8-rowwise" if a.int8 else "fp16",
            "temperature": a.temperature, "tensors": table, "specials": SPECIALS, "merges": tok.merges}
    (out / "model.json").write_text(json.dumps(meta))
    print(json.dumps({"out": str(out), "bin_MB": round(off / 1e6, 2), "quant": meta["quant"], "tensors": len(table)}))
    if a.check:
        from train import encode_file, evaluate
        m32 = GPT(Config(**cfg["model"])); m32.load_state_dict(sd); m32.eval()
        mq = GPT(Config(**cfg["model"])); mq.load_state_dict(deq); mq.eval()
        rows = encode_file(tok, a.data, cfg["args"]["max_len"], a.check)
        e32, eq = evaluate(m32, tok, rows, a.check), evaluate(mq, tok, rows, a.check)
        print(json.dumps({"fp32_exact": e32["exact"], f"{meta['quant']}_exact": eq["exact"], "n": e32["n"]}))
        json.dump({"fp32": e32, meta["quant"]: eq}, open(out / "quant_check.json", "w"), indent=1)


if __name__ == "__main__":
    main()

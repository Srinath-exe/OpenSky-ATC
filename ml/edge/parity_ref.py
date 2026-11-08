"""Reference outputs for the browser engine parity test: decode N validation examples in PyTorch using exactly the
weights in public/models/<name>/model.bin (dequantized the same way the browser does), save the token ids.

    python3 ml/edge/parity_ref.py --model public/models/s1-test --n 50 --out /tmp/ref.json
"""
import argparse, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/s1")); sys.path.insert(0, str(ROOT / "ml/tokenizer"))
import compat  # noqa: F401,E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import generate, CallsignTrie, prefill  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True); ap.add_argument("--n", type=int, default=50); ap.add_argument("--out", required=True)
    ap.add_argument("--data", default=str(ROOT / "ml/data/out/ds/val.jsonl"))
    a = ap.parse_args()
    meta = json.load(open(Path(a.model) / "model.json")); bin_ = (Path(a.model) / "model.bin").read_bytes()
    sd = {}
    for t in meta["tensors"]:
        n = int(np.prod(t["shape"]))
        if t["dtype"] == "f16":
            w = np.frombuffer(bin_, dtype=np.float16, count=n, offset=t["offset"]).astype(np.float32)
        else:
            q = np.frombuffer(bin_, dtype=np.int8, count=n, offset=t["offset"]).astype(np.float32)
            sc = np.frombuffer(bin_, dtype=np.float32, count=t["shape"][0], offset=t["scale_offset"])
            w = (q.reshape(t["shape"][0], -1) * sc[:, None]).reshape(-1)
        sd[t["name"]] = torch.from_numpy(w.reshape(t["shape"]).copy())
    m = GPT(Config(**meta["config"])); m.load_state_dict(sd); m.eval()
    tok = BPE([tuple(x) for x in meta["merges"]])
    rows = [json.loads(l) for l in open(a.data)][: a.n]
    out = []
    for ex in rows:
        cs = [l.split()[0] for l in ex["ctx"].split("\n")[1:] if l.strip()]
        ctx_ids = tok.encode("<ctx>" + ex["ctx"]); said_ids = tok.encode("<said> " + ex["said"] + "<cmd>")
        ids = generate(m, tok, ctx_ids + said_ids, prefix=prefill(m, ctx_ids), trie=CallsignTrie(tok, cs))
        out.append({"ctx": ex["ctx"], "said": ex["said"], "callsigns": cs, "ctx_ids": ctx_ids, "said_ids": said_ids, "tokens": ids, "line": tok.decode(ids).strip()})
    json.dump(out, open(a.out, "w"))
    print(json.dumps({"examples": len(out), "out": a.out}))


if __name__ == "__main__":
    main()

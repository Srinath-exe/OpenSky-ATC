"""The phone app's recogniser (mobile/tool/stt_bench.dart: sherpa-onnx streaming zipformer + hotwords) on the bench2 sets.
    ml/stt/venvs/cactus/bin/python ml/stt/bench2/edge_phone.py export <clipdir> <npydir> [--every 2]
    (cd mobile && dart run tool/stt_bench.dart --dir /opt/stt-models/zf-0626 --clips <npydir> --out <outdir> --threads 2)
    ml/stt/venvs/cactus/bin/python ml/stt/bench2/edge_phone.py import <npydir> <outdir>/<label>.json <results.jsonl>
"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
from edge_cactus import load_clips, read_wav   # noqa: E402


def export(clipdir, npydir, every):
    d, o = Path(clipdir), Path(npydir)
    o.mkdir(parents=True, exist_ok=True)
    clips = [c for c in load_clips(d) if every <= 1 or not str(c.get("id", "")).isdigit() or int(c["id"]) % every == 0]
    index = []
    for i, c in enumerate(clips):
        np.save(o / f"clip{i:04d}.npy", read_wav(d / c["wav"]).astype("<f4"))
        index.append({"i": i, "wav": c["wav"], "ctx": c["ctx"], "text": c.get("text", ""), "line": c["line"]})
    (o / "clips.json").write_text(json.dumps(index))
    print(f"{len(index)} clips -> {o}")


def imp(npydir, bench_json, out):
    idx = {c["i"]: c["wav"] for c in json.loads((Path(npydir) / "clips.json").read_text())}
    rows = json.loads(Path(bench_json).read_text())["rows"]
    with open(out, "w") as f:
        for r in rows:
            h = (r.get("heard") or "").strip()
            f.write(json.dumps({"wav": idx[r["i"]], "heard": h, "alts": [h] if h else [], "ms": r["ms"], "sec": r["audioMs"] / 1000}) + "\n")
    print(f"{len(rows)} rows -> {out}")


if __name__ == "__main__":
    a = sys.argv[1:]
    every = int(a[a.index("--every") + 1]) if "--every" in a else 1
    if a[0] == "export":
        export(a[1], a[2], every)
    else:
        imp(a[1], a[2], a[3])

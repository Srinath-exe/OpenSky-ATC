"""The phone app's recogniser (mobile/: sherpa-onnx streaming zipformer + hotwords) on the bench2 clip sets.
    prep:    ml/stt/venvs/cactus/bin/python ml/stt/bench2/edge_zf.py prep <clipdir> <workdir> [--every 2]
             -> <workdir>/clips.json + clipNNNN.npy (the format mobile/tool/stt_bench.dart reads)
    (cd mobile && dart run tool/stt_bench.dart --model zipformer-en-2023-06-26-int8 --dir /opt/stt-models/zf-0626 \
        --clips <workdir> --out <workdir>/out --threads 2)
    collect: ... edge_zf.py collect <workdir> <workdir>/out/<label>.json <out.jsonl>   -> bench JSONL rows
"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
from edge_cactus import load_clips, read_wav  # noqa: E402

cmd = sys.argv[1]
if cmd == "prep":
    d, w = Path(sys.argv[2]), Path(sys.argv[3]); w.mkdir(parents=True, exist_ok=True)
    every = int(sys.argv[sys.argv.index("--every") + 1]) if "--every" in sys.argv else 1
    clips = [c for c in load_clips(d) if every <= 1 or not str(c.get("id", "")).isdigit() or int(c["id"]) % every == 0]
    rows = []
    for i, c in enumerate(clips):
        np.save(w / f"clip{i:04d}.npy", read_wav(d / c["wav"]).astype("<f4"))
        rows.append({"i": i, "wav": c["wav"], "ctx": c["ctx"], "text": c.get("text", ""), "line": c["line"]})
    (w / "clips.json").write_text(json.dumps(rows))
    print(len(rows), "clips")
elif cmd == "collect":
    w = Path(sys.argv[2]); res = json.loads(Path(sys.argv[3]).read_text())
    by = {r["i"]: r["wav"] for r in json.loads((w / "clips.json").read_text())}
    with open(sys.argv[4], "w") as fo:
        for r in res["rows"]:
            fo.write(json.dumps({"wav": by[r["i"]], "heard": r["heard"], "alts": [r["heard"]] if r["heard"] else [], "ms": r["ms"],
                                 "computeMs": r.get("computeMs"), "sec": round(r.get("audioMs", 0) / 1000, 2)}) + "\n")
    print(len(res["rows"]), "rows")

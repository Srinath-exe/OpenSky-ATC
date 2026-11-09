"""Quick look at one set: single-feature AUROC / coverage at 1% risk (development aid for the round-trip features)."""
import json, sys
import numpy as np
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from fit import auroc, at_risk, feature_map, gated  # noqa: E402

name, tag = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "2m-swap-v1")
R = [json.loads(l) for l in open(f"ml/verify/out/{tag}/{name}.feat.jsonl")]
print(name, "rows", len(R), "l0 ok", sum(r["l0_ok"] for r in R))
for pop in ("all", "prod"):
    G = [r for r in R if gated(r) and (pop == "all" or not r["l0_ok"]) and not r["forced"]]
    y = np.array([r["correct"] for r in G]); print(pop, "gated", len(G), "wrong", int((~y).sum()))
    F = [feature_map(r) for r in G]
    for k in ["log_conf", "cs_margin", "log_ins_min_p", "rt_cs_num", "rt_cs_other", "rt_num_recall", "rt_num_extra", "rt_kw_recall", "rt_cover", "rt_seq", "rt_conflict"]:
        v = np.array([f[k] for f in F]) * (-1 if k in ("rt_cs_other", "rt_num_extra", "rt_conflict") else 1)
        print(f"  {k:16s} auroc {auroc(y, v):.3f} cov@1% {at_risk(y, v)[0]:.3f}")
    for k in ["s1_margin", "rt_score"]:
        v = np.array([r[k] for r in G]); print(f"  {k:16s} auroc {auroc(y, v):.3f} cov@1% {at_risk(y, v)[0]:.3f}")

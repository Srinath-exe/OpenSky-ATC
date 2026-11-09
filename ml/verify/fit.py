"""Fit and compare verifiers for the S1 voice model's proposals; write the shipped gate (ml/verify/RESULTS.md).

Inputs: ml/verify/out/<set>.feat.jsonl (ml/verify/post.cjs) and <set>.gen.h.npy (ml/verify/gen.py --hidden).
Fitting uses training-session sets only (trainA, trainB, hardneg); a 20 % group split of them (by game state) is the
dev set that picks the regulariser and the thresholds. val / syd / stt / noisy are only ever scored.

Outputs (one entry per S1 model, keyed by its URL /models/s1/<name>; other models' entries are kept):
  public/models/verifier/roundtrip-v1/verifier.json   the fitted gates (weights, feature names, thresholds) per S1 model
  src/lib/voice/verify-model.ts                  the same, as TypeScript constants (imported by understand.ts)
  ml/verify/out/<model>/results.json             every comparison number and curve (the report reads it)

    python3 ml/verify/fit.py --s1-model public/models/s1/2m-swap-v1
"""
import argparse, hashlib, json, math, re, sys
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ml/verify/out"
REPORT_SETS = ["val", "syd", "stt", "noisy"]
FIT_SETS = ["trainA", "trainB", "hardneg"]
RISK = 0.01           # at most 1 % of auto-sent commands wrong
ZCLIP = 5.0           # standardised features are clipped to +-5 (train and browser): no wild extrapolation out of range
SAY_MAX_CORRECT = 0.01  # at most 1 % of correct proposals may be bounced to "say again"

GEN = ["log_conf", "cs_margin", "log_p_say", "log_cs_min_full", "log_ins_min_p", "ins_lp", "ins_min_margin", "log_dig_min_p", "dig_margin", "log_rwy_min_p", "log_eos_p",
       "cs_lh_margin", "cs_lh"]   # the last two: the callsign search (s1.ts decodeScored, ml/s1/CALLSIGN_SCORING.md)
LH_CAP = 2.0                       # s1.ts marginCapNorm
RT = ["rt_cs_num", "rt_cs_name", "rt_cs_other", "rt_num_recall", "rt_num_extra", "rt_kw_recall", "rt_conflict", "rt_cover", "rt_seq", "rt_kw_miss", "rt_heard_miss", "rt_side_miss", "rt_rendered",
      "rt_cs_other_pos", "rt_cs_tie", "rt_num_full", "rt_cs_full"]


def lg(p):
    return math.log(max(p, 1e-6))


def clip(x, a, b):
    return min(b, max(a, x))


def feature_map(r):
    """Python twin of featureMap() in src/lib/voice/verify.ts (same names, same transforms)."""
    f = {"log_conf": lg(r["conf"]), "rt_cs_num": r["rt_csNum"], "rt_cs_name": r["rt_csName"], "rt_cs_other": r["rt_csOther"], "rt_num_recall": r["rt_numRecall"],
         "rt_num_extra": r["rt_numExtra"], "rt_kw_recall": r["rt_kwRecall"], "rt_conflict": r["rt_conflict"], "rt_cover": r["rt_cover"], "rt_seq": r["rt_seq"], "rt_kw_miss": r["rt_kwMiss"], "rt_heard_miss": r["rt_heardMiss"], "rt_side_miss": r["rt_sideMiss"], "rt_rendered": r["rt_rendered"],
         "rt_cs_other_pos": max(r["rt_csOther"], 0), "rt_cs_tie": 1.0 if r["rt_csOther"] > -0.05 else 0.0, "rt_num_full": 1.0 if r["rt_numRecall"] >= 1 else 0.0, "rt_cs_full": 1.0 if r["rt_csNum"] >= 0.9 else 0.0}
    f.update({"cs_margin": clip(r["cs_margin"], -5, 20), "log_p_say": lg(r["p_say"]), "log_cs_min_full": lg(r["cs_min_full"]), "log_ins_min_p": lg(r["ins_min_p"]),
              "ins_lp": clip(r["ins_lp"], -30, 0), "ins_min_margin": clip(r["ins_min_margin"], -5, 20), "log_dig_min_p": lg(r["dig_min_p"]),
              "dig_margin": clip(r["dig_margin"], -5, 20), "log_rwy_min_p": lg(r["rwy_min_p"]), "log_eos_p": lg(r["eos_p"])})
    # callsign search signals; absent (None) only when the trie decoder ran (prompt at the length limit): neutral values
    m, h = r.get("cs_lh_margin"), r.get("cs_lh")
    f.update({"cs_lh_margin": clip(m, -LH_CAP, LH_CAP) if m is not None and m == m else 0.0, "cs_lh": clip(h, -30, 0) if h is not None and h == h else -30.0})
    return f


def load(name, md):
    rows = [json.loads(l) for l in open(md / f"{name}.feat.jsonl")]
    hp = md / f"{name}.gen.h.npy"
    H = np.load(hp).astype(np.float32) if hp.exists() else None
    return rows, H


def veto(r):
    """Python twin of vetoOf() in src/lib/voice/verify.ts: near-certain disagreements, never auto-sent."""
    return r["rt_sideMiss"] > 0 or r["rt_conflict"] > 0 or r["rt_csOther"] > 0 or (r["rt_numRecall"] < 1 and r["rt_numExtra"] > 0)


def gated(r):
    """The proposals the gate decides on: parsed, not SAY AGAIN, callsign not corrected by the rules (that is always 'check')."""
    return r["parsed"] and not r["say"] and not r["fused"]


def auroc(y, s):
    y = np.asarray(y, bool); s = np.asarray(s, float)
    if y.all() or (~y).all():
        return float("nan")
    order = np.argsort(s, kind="mergesort"); ranks = np.empty(len(s)); ranks[order] = np.arange(1, len(s) + 1)
    # average ranks for ties
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, ranks); ranks = (sums / cnt)[inv]
    npos = y.sum(); nneg = len(y) - npos
    return float((ranks[y].sum() - npos * (npos + 1) / 2) / (npos * nneg))


def risk_coverage(y, s, pts=60):
    """Accept the top-k by score for every k: (coverage = share of all proposals accepted, risk = wrong among accepted)."""
    y = np.asarray(y, bool); order = np.argsort(-np.asarray(s, float), kind="mergesort"); ys = y[order]
    k = np.arange(1, len(ys) + 1); wrong = np.cumsum(~ys)
    cov = k / len(ys); risk = wrong / k
    idx = np.unique(np.linspace(0, len(ys) - 1, pts).astype(int))
    return [[round(float(cov[i]), 4), round(float(risk[i]), 4)] for i in idx]


def at_risk(y, s, risk=RISK):
    """Best operating point with selective risk <= `risk`: share of CORRECT proposals still auto-sent, and the threshold."""
    y = np.asarray(y, bool); s = np.asarray(s, float)
    order = np.argsort(-s, kind="mergesort"); ys = y[order]; ss = s[order]
    k = np.arange(1, len(ys) + 1); wrong = np.cumsum(~ys); r = wrong / k
    ok = np.where((r <= risk) & np.r_[ss[1:] != ss[:-1], True])[0]   # only cut between distinct scores
    if not len(ok):
        return 0.0, float("inf")
    i = ok.max()
    return float(np.cumsum(ys)[i] / max(ys.sum(), 1)), float(ss[i])


def ece(y, p, bins=10):
    """Expected calibration error: |predicted P(correct) - observed accuracy|, averaged over 10 confidence bins."""
    y = np.asarray(y, float); p = np.asarray(p, float); e = 0.0
    for b in range(bins):
        m = (p >= b / bins) & (p < (b + 1) / bins) if b < bins - 1 else (p >= b / bins)
        if m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(e)


def group_of(r):
    """Dev fold by command (airport + gold line), so the same command never sits on both sides of the split."""
    return int(hashlib.md5((str(r.get("icao")) + "|" + r["gold"]).encode()).hexdigest(), 16) % 5


class LR:
    def __init__(self, names, C):
        self.names, self.C = names, C

    def fit(self, X, y, w=None):
        self.mu = X.mean(0); self.sd = X.std(0) + 1e-6
        self.m = LogisticRegression(C=self.C, max_iter=2000).fit(np.clip((X - self.mu) / self.sd, -ZCLIP, ZCLIP), y, sample_weight=w)
        return self

    def p(self, X):
        return self.m.predict_proba(np.clip((X - self.mu) / self.sd, -ZCLIP, ZCLIP))[:, 1]

    def export(self, name, thresholds):
        return {"name": name, "features": self.names, "mean": [round(float(v), 6) for v in self.mu], "std": [round(float(v), 6) for v in self.sd],
                "w": [round(float(v), 6) for v in self.m.coef_[0]], "b": round(float(self.m.intercept_[0]), 6), "thresholds": thresholds}


def exported_score(m, x):
    """Python twin of verifierScore() in src/lib/voice/verify.ts, on one feature vector in m["features"] order."""
    zz = np.clip((np.asarray(x, float) - np.asarray(m["mean"])) / np.asarray(m["std"]), -ZCLIP, ZCLIP)
    if m.get("hidden"):
        h = m["hidden"]; a1 = np.maximum(np.asarray(h["w1"]) @ zz + np.asarray(h["b1"]), 0)
        v = h["b2"] + float(np.asarray(h["w2"]) @ a1)
    else:
        v = m["b"] + float(np.asarray(m["w"]) @ zz)
    return 1 / (1 + math.exp(-v))


def mat(rows, names):
    return np.array([[feature_map(r)[n] for n in names] for r in rows], dtype=np.float64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="roundtrip-v1"); ap.add_argument("--s1-model", default="public/models/s1/2m-swap-v1")
    a = ap.parse_args()
    tag = Path(a.s1_model).name; url = f"/models/s1/{tag}"; MD = OUT / tag
    data = {s: load(s, MD) for s in FIT_SETS + REPORT_SETS if (MD / f"{s}.feat.jsonl").exists()}
    # ---------- fitting data ----------
    fit_rows, fit_H = [], []
    for s in FIT_SETS:
        if s not in data:
            continue
        rows, H = data[s]
        for i, r in enumerate(rows):
            if gated(r):
                fit_rows.append(r); fit_H.append(H[i] if H is not None else None)
    g = np.array([group_of(r) for r in fit_rows]); dev = g == 0
    y_fit = np.array([r["correct"] for r in fit_rows])
    is_hn = np.array([r["forced"] for r in fit_rows])
    print(json.dumps({"fit_rows": len(fit_rows), "wrong": int((~y_fit).sum()), "hardneg": int(is_hn.sum()), "dev": int(dev.sum())}))
    # dev population that looks like production: the generator's own proposals (no hard negatives) where the rules failed
    dev_prod = dev & ~is_hn & np.array([not r["l0_ok"] for r in fit_rows])

    candidates = {}
    # (d) logistic regressions; pick C and whether to use hard negatives on dev (generator's own proposals only)
    def fit_lr(names, use_hn):
        best = None
        for C in (0.03, 0.1, 0.3, 1.0, 3.0):
            tr = ~dev & (~is_hn if not use_hn else np.ones_like(dev))
            m = LR(names, C).fit(mat([fit_rows[i] for i in np.where(tr)[0]], names), y_fit[tr])
            # picked on the production-like dev rows (rules failed, the generator's own proposals): ranking first
            pd = m.p(mat([fit_rows[i] for i in np.where(dev_prod)[0]], names))
            key = (auroc(y_fit[dev_prod], pd), at_risk(y_fit[dev_prod], pd)[0])
            if best is None or key > best[0]:
                best = (key, C)
        C = best[1]
        tr = (~is_hn if not use_hn else np.ones(len(fit_rows), bool))
        m_dev = LR(names, C).fit(mat([fit_rows[i] for i in np.where(tr & ~dev)[0]], names), y_fit[tr & ~dev])   # for thresholds
        m_all = LR(names, C).fit(mat([fit_rows[i] for i in np.where(tr)[0]], names), y_fit[tr])                 # shipped
        return m_dev, m_all, C, best[0]

    sel = {}
    for kind, names in (("lr_full", GEN + RT), ("lr_basic", ["log_conf"] + RT), ("lr_gen", GEN)):
        res = {hn: fit_lr(names, hn) for hn in (False, True)}
        hn = max(res, key=lambda k: res[k][3])
        sel[kind] = {"names": names, "hardneg": hn, "C": res[hn][2], "dev_cov_auroc": res[hn][3], "m_dev": res[hn][0], "m_all": res[hn][1]}
        print(json.dumps({"model": kind, "hardneg": hn, "C": res[hn][2], "dev": res[hn][3], "dev_other": res[not hn][3]}))

    # (d) a small MLP on the same features (16 hidden units): does a non-linear combination beat the linear one?
    names = sel["lr_full"]["names"]; use = np.ones(len(fit_rows), bool) if sel["lr_full"]["hardneg"] else ~is_hn
    Xa = mat([fit_rows[i] for i in np.where(use)[0]], names); mu, sd = Xa.mean(0), Xa.std(0) + 1e-6
    z = lambda X, m_, s_: np.clip((X - m_) / s_, -ZCLIP, ZCLIP)
    mlp = MLPClassifier(hidden_layer_sizes=(16,), alpha=1e-3, max_iter=400, random_state=0).fit(z(Xa, mu, sd), y_fit[use])
    mlp_pack = (mlp, mu, sd, names)
    ud = use & ~dev
    Xd = mat([fit_rows[i] for i in np.where(ud)[0]], names); mud, sdd = Xd.mean(0), Xd.std(0) + 1e-6
    mlp_dev = MLPClassifier(hidden_layer_sizes=(16,), alpha=1e-3, max_iter=400, random_state=0).fit(z(Xd, mud, sdd), y_fit[ud])
    p_dev_mlp = mlp_dev.predict_proba(z(mat([fit_rows[i] for i in np.where(dev_prod)[0]], names), mud, sdd))[:, 1]
    p_dev_lr = sel["lr_full"]["m_dev"].p(mat([fit_rows[i] for i in np.where(dev_prod)[0]], names))
    dev_cmp = {"lr": [auroc(y_fit[dev_prod], p_dev_lr), at_risk(y_fit[dev_prod], p_dev_lr)[0]], "mlp": [auroc(y_fit[dev_prod], p_dev_mlp), at_risk(y_fit[dev_prod], p_dev_mlp)[0]]}
    ship_mlp = dev_cmp["mlp"][0] > dev_cmp["lr"][0] + 0.005      # the MLP only if it ranks clearly better on dev
    print(json.dumps({"dev_prod_lr_vs_mlp": dev_cmp, "ship": "mlp" if ship_mlp else "lr"}))

    # (d) a head on the S1 trunk: logistic regression on the final-norm hidden states at <cmd> and at the last token
    trunk = None
    if all(h is not None for h in fit_H):
        Hf = np.stack(fit_H).astype(np.float64)
        best = None
        for C in (0.01, 0.03, 0.1):
            m = LogisticRegression(C=C, max_iter=3000)
            # own names: mu / sd above are the MLP's feature statistics, exported with the shipped gate below (reusing the
            # names here once shipped the hidden-state statistics as the gate's mean / std)
            tmu, tsd = Hf[~dev].mean(0), Hf[~dev].std(0) + 1e-6
            m.fit((Hf[~dev] - tmu) / tsd, y_fit[~dev])
            pd = m.predict_proba((Hf[dev_prod] - tmu) / tsd)[:, 1]
            key = (auroc(y_fit[dev_prod], pd), at_risk(y_fit[dev_prod], pd)[0])
            if best is None or key > best[0]:
                best = (key, C, m, tmu, tsd)
        trunk = best
        print(json.dumps({"model": "trunk_head", "C": best[1], "dev": best[0]}))

    def scores(rows, H):
        X = {n: mat(rows, sel[n]["names"]) for n in sel}
        out = {
            "a_conf": np.array([r["conf"] for r in rows]),
            "b_cs_margin": np.array([clip(r["cs_margin"], -5, 20) for r in rows]),
            "b_min_token_p": np.array([min(r["ins_min_p"], r["cs_min_full"]) for r in rows]),
            "b_digit_margin": np.array([clip(r["dig_margin"], -5, 20) for r in rows]),
            "b_s1_callsign_margin": np.array([clip(r.get("s1_margin", 0.0), -20, 40) for r in rows]),
            "b_lh_callsign_margin": np.array([feature_map(r)["cs_lh_margin"] for r in rows]),
            "c_round_trip": np.array([r["rt_score"] for r in rows]),
            "d_lr_gen": sel["lr_gen"]["m_all"].p(X["lr_gen"]),
            "d_lr_round_trip+conf": sel["lr_basic"]["m_all"].p(X["lr_basic"]),
            "d_lr_round_trip+gen": sel["lr_full"]["m_all"].p(X["lr_full"]),
        }
        m_, mu_, sd_, nm_ = mlp_pack
        out["d_mlp_round_trip+gen"] = m_.predict_proba(z(mat(rows, nm_), mu_, sd_))[:, 1]
        out["e_shipped"] = out[SHIP_BASE] - np.array([veto(r) for r in rows], float)
        if trunk is not None and H is not None:
            _, _, m, mu, sd = trunk
            out["d_trunk_head"] = m.predict_proba((H.astype(np.float64) - mu) / sd)[:, 1]
        return out

    # ---------- thresholds for the shipped model, from dev (production-like rows), with the dev-fitted twin ----------
    def thresholds(kind):
        idx = np.where(dev_prod)[0]
        if kind == "mlp":
            p = mlp_dev.predict_proba(z(mat([fit_rows[i] for i in idx], names), mud, sdd))[:, 1]
        else:
            p = sel[kind]["m_dev"].p(mat([fit_rows[i] for i in idx], sel[kind]["names"]))
        y = y_fit[idx]
        v = np.array([veto(fit_rows[i]) for i in idx], float)
        _, t_send = at_risk(y, p - v, RISK)        # vetoed proposals are never sent: rank them last
        pc = np.sort(p[y]); t_say = float(pc[int(len(pc) * SAY_MAX_CORRECT)]) if len(pc) else 0.0
        t_say = min(t_say, t_send * 0.5)
        return {"send": round(t_send, 4), "sayAgain": round(t_say, 4)}, {"dev_prod_n": int(len(idx)), "dev_prod_wrong": int((~y).sum())}

    th_full, dev_full = thresholds("mlp" if ship_mlp else "lr_full"); th_basic, dev_basic = thresholds("lr_basic")
    print(json.dumps({"thresholds_full": th_full, "thresholds_basic": th_basic, **dev_full}))
    SHIP_BASE = "d_mlp_round_trip+gen" if ship_mlp else "d_lr_round_trip+gen"
    SHIP = "e_shipped"
    if ship_mlp:
        full = {"name": f"{a.name}-{tag}-full", "features": names, "mean": [round(float(v), 6) for v in mu], "std": [round(float(v), 6) for v in sd], "w": [], "b": 0,
                "hidden": {"w1": [[round(float(v), 6) for v in row] for row in mlp.coefs_[0].T], "b1": [round(float(v), 6) for v in mlp.intercepts_[0]],
                           "w2": [round(float(v), 6) for v in mlp.coefs_[1][:, 0]], "b2": round(float(mlp.intercepts_[1][0]), 6)}, "thresholds": th_full}
    else:
        full = sel["lr_full"]["m_all"].export(f"{a.name}-{tag}-full", th_full)
    basic = sel["lr_basic"]["m_all"].export(f"{a.name}-{tag}-basic", th_basic)
    for g in (full, basic):
        assert len(g["mean"]) == len(g["std"]) == len(g["features"]), f"{g['name']}: {len(g['mean'])} means for {len(g['features'])} features"
    # the exported gate, scored the way verify.ts verifierScore() does, must give the in-process probabilities
    chk = fit_rows[:300]
    Xc = mat(chk, full["features"])
    p_in = mlp.predict_proba(z(Xc, mu, sd))[:, 1] if ship_mlp else sel["lr_full"]["m_all"].p(Xc)
    p_ex = np.array([exported_score(full, x) for x in Xc])
    assert np.abs(p_in - p_ex).max() < 1e-3, f"exported gate differs from the fitted one by {np.abs(p_in - p_ex).max():.4f}"

    # ---------- report ----------
    res = {"risk_target": RISK, "say_max_correct": SAY_MAX_CORRECT, "fit": {"rows": len(fit_rows), "wrong": int((~y_fit).sum()), "hardneg_rows": int(is_hn.sum()),
           "models": {k: {"hardneg": v["hardneg"], "C": v["C"], "dev_cov_auroc": v["dev_cov_auroc"], "features": v["names"]} for k, v in sel.items()},
           "trunk_C": trunk[1] if trunk else None}, "thresholds": {"full": th_full, "basic": th_basic}, "shipped_key": SHIP, "shipped_base": SHIP_BASE, "dev_lr_vs_mlp": dev_cmp, "sets": {}}
    for s in REPORT_SETS:
        if s not in data:
            continue
        rows, H = data[s]
        allr = rows
        gi = [i for i, r in enumerate(rows) if gated(r)]
        for pop in ("prod", "all"):
            ii = [i for i in gi if (not rows[i]["l0_ok"]) or pop == "all"]
            if not ii:
                continue
            R = [rows[i] for i in ii]; y = np.array([r["correct"] for r in R])
            sc = scores(R, H[ii] if H is not None else None)
            entry = {"n_rows": len(allr), "n_l1": sum(1 for r in allr if not r["l0_ok"]) if pop == "prod" else len(allr), "n_gated": len(R), "wrong": int((~y).sum()),
                     "error_rate": round(float((~y).mean()), 4), "scores": {}}
            for k, v in sc.items():
                cov, t = at_risk(y, v)
                entry["scores"][k] = {"auroc": round(auroc(y, v), 4), "cov_at_1pct": round(cov, 4), "curve": risk_coverage(y, v)}
            # the shipped gate at its fixed (dev-chosen) thresholds, and the old one (confidence >= 0.5)
            pf = sc[SHIP_BASE]; vt = sc["e_shipped"] < pf - 0.5
            def outcome(send, say):
                return {"sent": int(send.sum()), "sent_wrong": int((send & ~y).sum()), "risk": round(float((send & ~y).sum() / max(send.sum(), 1)), 4),
                        "coverage": round(float((send & y).sum() / max(y.sum(), 1)), 4),
                        "check_wrong": int((~send & ~say & ~y).sum()), "check_correct": int((~send & ~say & y).sum()),
                        "say_wrong": int((say & ~y).sum()), "say_correct": int((say & y).sum())}
            entry["shipped"] = outcome((pf >= th_full["send"]) & ~vt, pf < th_full["sayAgain"])
            entry["shipped"]["vetoed"] = int(((pf >= th_full["send"]) & vt).sum())
            entry["shipped"]["ece"] = round(ece(y, pf), 4)
            entry["baseline"] = outcome(sc["a_conf"] >= 0.5, np.zeros(len(y), bool))
            # whole L1 path including SAY AGAIN / unparsed / fused rows (production population only)
            if pop == "prod":
                L = [r for r in allr if not r["l0_ok"]]
                # "say again" transcripts (an aircraft not in the state, or no instruction): did the model say SAY AGAIN,
                # and when it proposed a command instead, what did the gate do with it?
                gp = {id(r): (float(p0), bool(v0)) for r, p0, v0 in zip(R, pf, vt)}
                miss = [r for r in L if r["gold_say"] and not r["say"]]
                sent = [r for r in miss if id(r) in gp and gp[id(r)][0] >= th_full["send"] and not gp[id(r)][1]]
                sayg = [r for r in miss if id(r) in gp and gp[id(r)][0] < th_full["sayAgain"]]
                entry["say_again"] = {"gold": sum(r["gold_say"] for r in L), "model_said": sum(r["gold_say"] and r["say"] for r in L), "missed": len(miss),
                                      "missed_sent": len(sent), "missed_say_again": len(sayg), "missed_check": len(miss) - len(sent) - len(sayg),
                                      "model_said_wrongly": sum(r["say"] and not r["gold_say"] for r in L)}
                entry["l1_exact"] = round(sum(r["correct"] for r in L) / max(len(L), 1), 4)
                entry["path"] = {"l1_rows": len(L), "model_say_again": sum(r["say"] for r in L), "say_again_right": sum(r["say"] and r["gold_say"] for r in L),
                                 "unparsed": sum((not r["say"]) and not r["parsed"] for r in L), "fused": sum(r["parsed"] and r["fused"] and not r["say"] for r in L),
                                 "fused_correct": sum(r["parsed"] and r["fused"] and r["correct"] for r in L)}
                # examples: wrong ones the baseline would send and the verifier stops; wrong ones still sent
                ex_caught, ex_missed = [], []
                for r, p0, c0, v0 in zip(R, pf, sc["a_conf"], vt):
                    if not r["correct"] and c0 >= 0.5 and (p0 < th_full["send"] or v0) and len(ex_caught) < 12:
                        ex_caught.append({"said": r["said"], "gold": r["gold"], "line": r["line"], "conf": round(c0, 3), "p": round(float(p0), 3),
                                          "gate": "say again" if p0 < th_full["sayAgain"] else "check", "veto": bool(v0)})
                    if not r["correct"] and p0 >= th_full["send"] and not v0 and len(ex_missed) < 12:
                        ex_missed.append({"said": r["said"], "gold": r["gold"], "line": r["line"], "conf": round(c0, 3), "p": round(float(p0), 3)})
                entry["caught"] = ex_caught; entry["missed"] = ex_missed
            res["sets"].setdefault(s, {})[pop] = entry
            print(json.dumps({"set": s, "pop": pop, "n": len(R), "err": entry["error_rate"],
                              "auroc": {k: v["auroc"] for k, v in entry["scores"].items()}, "cov@1%": {k: v["cov_at_1pct"] for k, v in entry["scores"].items()},
                              "shipped": entry["shipped"], "baseline": entry["baseline"]}))
    # STT per recogniser (production population)
    if "stt" in data:
        rows, _ = data["stt"]; per = {}
        for rec in sorted({r["rec"] for r in rows}):
            R = [r for r in rows if r["rec"] == rec and gated(r) and not r["l0_ok"]]
            y = np.array([r["correct"] for r in R]); p = scores(R, None)[SHIP]
            c = np.array([r["conf"] for r in R])
            per[rec] = {"n": len(R), "wrong": int((~y).sum()), "shipped_sent_wrong": int(((p >= th_full["send"]) & ~y).sum()), "shipped_sent": int((p >= th_full["send"]).sum()),
                        "baseline_sent_wrong": int(((c >= 0.5) & ~y).sum()), "baseline_sent": int((c >= 0.5).sum())}
        res["stt_per_recogniser"] = per
    # weights, for the report
    lw = sel["lr_full"]["m_all"].m.coef_[0]
    res["weights"] = {n: round(float(w), 4) for n, w in zip(names, lw)}     # the linear model's, for reading
    res["s1_model"] = url
    json.dump(res, open(MD / "results.json", "w"), indent=1)
    # registry: one gate per S1 model URL; the default is the model the game ships (S1_MODEL_URL in src/lib/voice/l1.ts)
    vdir = ROOT / "public/models/verifier" / a.name; vdir.mkdir(parents=True, exist_ok=True)
    vf = vdir / "verifier.json"
    reg = json.load(open(vf)) if vf.exists() else {}
    if reg.get("format") != "atc-voice-verifier-2":
        reg = {"format": "atc-voice-verifier-2", "models": {}}
    l1 = (ROOT / "src/lib/voice/l1.ts").read_text()
    reg["default"] = re.search(r"S1_MODEL_URL = '([^']+)'", l1).group(1)
    reg["models"][url] = {"full": full, "basic": basic, "fitted_on": {"sets": FIT_SETS, "rows": len(fit_rows), "risk_target": RISK, "say_max_correct": SAY_MAX_CORRECT}}
    json.dump(reg, open(vf, "w"), indent=1)
    if reg["default"] not in reg["models"]:
        print(json.dumps({"warning": f"no gate fitted yet for the shipped model {reg['default']}: understand.ts falls back to the first entry"}))
    ts = ROOT / "src/lib/voice/verify-model.ts"
    body = ",\n".join(f"  {json.dumps(u)}: {{\n    full: {json.dumps(m['full'])},\n    basic: {json.dumps(m['basic'])},\n  }}" for u, m in sorted(reg["models"].items()))
    default = reg["default"] if reg["default"] in reg["models"] else sorted(reg["models"])[0]
    ts.write_text("// GENERATED by ml/verify/fit.py from training-session data - do not edit; refit with ml/verify/refit.sh <model dir>.\n"
                  f"// Same weights as public/models/verifier/{a.name}/verifier.json: one gate per S1 model URL (thresholds differ per model).\n"
                  "import type { VerifierModel } from './verify';\n\n"
                  "/** full = round trip + the decoder's per-token signals (s1.ts Completion.signals); basic = round trip + confidence. */\n"
                  f"export const VERIFIERS: Record<string, {{ full: VerifierModel; basic: VerifierModel }}> = {{\n{body},\n}};\n\n"
                  "/** The gate for the model the game ships (S1_MODEL_URL when this was fitted); used when a result does not name its model. */\n"
                  f"export const VERIFIER_DEFAULT_URL = {json.dumps(default)};\n"
                  "export const VERIFIER_FULL: VerifierModel = VERIFIERS[VERIFIER_DEFAULT_URL].full;\n"
                  "export const VERIFIER_BASIC: VerifierModel = VERIFIERS[VERIFIER_DEFAULT_URL].basic;\n")
    print(json.dumps({"wrote": [str(vf), str(ts), str(MD / "results.json")], "model": url}))


if __name__ == "__main__":
    main()

"""Build public/reports/voice-diffusion.html from the run files (standalone HTML, inline CSS + SVG, no scripts).

    python3 ml/diffusion/build_report.py
"""
import html, json, math
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RUNS = HERE / "runs"
OUT = ROOT / "public/reports/voice-diffusion.html"


def jl(p):
    return [json.loads(l) for l in open(p)] if Path(p).exists() else []


def js(p, default=None):
    return json.load(open(p)) if Path(p).exists() else default


E = html.escape
M = {k: jl(RUNS / k / "metrics.jsonl") for k in ("ar-matched", "dlm", "dlm-arinit", "dlm-meanw")}
AR_EVAL = js(RUNS / "ar-matched/eval.json", {})
SHIP = js(ROOT / "ml/gpu/results/s1-2m-11ap-swap/eval.json", {})
G = js(RUNS / "dlm/grid.json", {})
GI = js(RUNS / "dlm-arinit/grid.json", {})
GM = js(RUNS / "dlm-meanw/grid.json", {})
DG = js(HERE / "results/diagnose.json", {})
EX = js(RUNS / "dlm/examples.json", [])
EXI = js(RUNS / "dlm-arinit/examples.json", [])
B = js(HERE / "results/bench.json", {})
LK = js(HERE / "results/likelihood.json", {})
DONE = {k: js(RUNS / k / "done.json", {}) for k in ("dlm", "dlm-arinit", "dlm-meanw")}
SUM = js(HERE / "results/summary.json", {})
AS = js(HERE / "results/ar_span_s1-2m-11ap-swap.json", {})
ASB = js(HERE / "results/ar_span_bench_s1-2m-11ap-swap.json", {}).get("bench", {})
L = G.get("L", 24)

COL = {"ar": "c-ar", "dlm": "c-dlm", "init": "c-init", "ship": "c-ship"}


def pct(x, d=1):
    return "–" if x is None else f"{100 * x:.{d}f}%"


# ---------------------------------------------------------------- charts
def line_chart(series, xs, ymin, ymax, yticks, yfmt, w=440, h=250, xlabel="", refs=(), xtick_labels=None, label_w=118):
    """series: [{name, cls, pts: [(x, y)], dash}], x positions are indices into xs (categorical, evenly spaced)
    or numbers (linear). refs: horizontal reference lines [{name, cls, y}]."""
    ml, mr, mt, mb = 40, label_w, 12, 34
    pw, ph = w - ml - mr, h - mt - mb
    numeric = xtick_labels is None
    if numeric:
        x0, x1 = min(xs), max(xs)
        X = lambda v: ml + (v - x0) / ((x1 - x0) or 1) * pw
    else:
        X = lambda v: ml + xs.index(v) / max(1, len(xs) - 1) * pw
    Y = lambda v: mt + (1 - (v - ymin) / (ymax - ymin)) * ph
    o = [f'<svg viewBox="0 0 {w} {h}" class="lc" role="img" preserveAspectRatio="xMinYMin meet">']
    for t in yticks:
        o.append(f'<line x1="{ml}" x2="{ml + pw}" y1="{Y(t):.1f}" y2="{Y(t):.1f}" class="grid"/>'
                 f'<text x="{ml - 6}" y="{Y(t) + 4:.1f}" class="tick" text-anchor="end">{E(yfmt(t))}</text>')
    ticks = xs if not numeric else xs
    for i, t in enumerate(ticks):
        lab = xtick_labels[i] if xtick_labels else str(t)
        o.append(f'<text x="{X(t):.1f}" y="{mt + ph + 16}" class="tick" text-anchor="middle">{E(lab)}</text>')
    if xlabel:
        o.append(f'<text x="{ml + pw / 2:.1f}" y="{h - 3}" class="tick axl" text-anchor="middle">{E(xlabel)}</text>')
    ends = []
    for r in refs:
        y = Y(r["y"])
        o.append(f'<line x1="{ml}" x2="{ml + pw}" y1="{y:.1f}" y2="{y:.1f}" class="ref {r["cls"]}"><title>{E(r["name"])}: {E(yfmt(r["y"]))}</title></line>')
        ends.append([y, r["name"], r["cls"], True])
    for s in series:
        pts = [(X(x), Y(y), x, y) for x, y in s["pts"] if y is not None]
        if not pts:
            continue
        d = " ".join(f"{'M' if i == 0 else 'L'}{px:.1f},{py:.1f}" for i, (px, py, _, _) in enumerate(pts))
        o.append(f'<path d="{d}" class="ln {s["cls"]}{" dash" if s.get("dash") else ""}"/>')
        for px, py, x, y in (pts if s.get("r", 4) else []):
            xl = xtick_labels[xs.index(x)] if xtick_labels else x
            o.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{s.get("r", 4)}" class="dot {s["cls"]}"><title>{E(s["name"])} · {E(str(xl))}: {E(yfmt(y))}</title></circle>')
        ends.append([pts[-1][1], s["name"], s["cls"], bool(s.get("dash"))])
    ends.sort(key=lambda e: e[0])                       # end labels, pushed apart so they never overlap
    for i in range(1, len(ends)):
        ends[i][0] = max(ends[i][0], ends[i - 1][0] + 14)
    for y, name, cls, ref in ends:
        o.append(f'<line x1="{ml + pw + 6}" x2="{ml + pw + 16}" y1="{y:.1f}" y2="{y:.1f}" class="key {cls}{" dash" if ref else ""}"/>'
                 f'<text x="{ml + pw + 20}" y="{y + 4:.1f}" class="lab">{E(name)}</text>')
    o.append("</svg>")
    return "".join(o)


def hbars(rows, vmax, unit="ms", fmt=lambda v: f"{v:.0f}"):
    """rows: [{label, sub, value, cls, tip}] -> HTML bar chart on one linear scale."""
    o = ['<div class="rows">']
    for r in rows:
        if r.get("head"):
            o.append(f'<div class="bhead">{E(r["head"])}</div>'); continue
        w = 100 * r["value"] / vmax
        o.append(f'<div class="brow" tabindex="0"><div class="blab">{E(r["label"])}<small>{E(r.get("sub", ""))}</small></div>'
                 f'<div class="track"><div class="fill {r["cls"]}" style="width:{w:.2f}%"></div><span class="tip">{E(r.get("tip", ""))}</span></div>'
                 f'<div class="val">{fmt(r["value"])} {unit}</div></div>')
    o.append("</div>")
    return "".join(o)


# ---------------------------------------------------------------- pieces
def tok_cell(t):
    if t is None:
        return '<span class="cell m">▒</span>'
    if t == "<eos>":
        return '<span class="cell e">⏎</span>'
    return f'<span class="cell">{E(t.replace(" ", "␣"))}</span>'


def strip(ex, title):
    gold_n = len(ex["steps"][-1]["canvas"])
    # positions worth showing: up to and including the first <eos>, plus one
    final = ex["steps"][-1]["canvas"]
    end = final.index("<eos>") + 1 if "<eos>" in final else gold_n
    show = min(gold_n, end + 1)
    o = [f'<div class="strip"><div class="strip-head"><h3>{E(title)}</h3><span class="note">said: “{E(ex["said"])}” → <code>{E(ex["pred"].strip())}</code>'
         f'{" ✓" if ex["pred"].strip().upper().split() == ex["gold"].upper().split() else " ✗ (gold " + E(ex["gold"]) + ")"}</span></div>']
    o.append('<div class="scroll"><table class="canvas"><thead><tr><th>step</th>' + "".join(f"<th>{j}</th>" for j in range(show)) + f'<th>+{gold_n - show}</th></tr></thead><tbody>')
    o.append("<tr><td class='sn'>0</td>" + "".join(f"<td>{tok_cell(None)}</td>" for _ in range(show)) + "<td class='rest'>▒</td></tr>")
    for i, s in enumerate(ex["steps"]):
        cells = []
        for j in range(show):
            c = tok_cell(s["canvas"][j])
            if j in s["committed"]:
                c = c.replace('class="cell', 'class="cell new')
            cells.append(f"<td>{c}</td>")
        rest = s["canvas"][show:]
        rest_txt = "⏎" if all(t == "<eos>" for t in rest) else ("▒" if all(t is None for t in rest) else "▒/⏎")
        o.append(f"<tr><td class='sn'>{i + 1}</td>{''.join(cells)}<td class='rest'>{rest_txt}</td></tr>")
    o.append("</tbody></table></div></div>")
    return "".join(o)


def pick_example(exs, S):
    good = [e for e in exs if e["S"] == S and e["pred"].strip().upper().split() == e["gold"].upper().split()]
    pref = [e for e in good if e["kind"] in ("altitude", "heading", "taxi", "speed") and len(e["gold"]) > 14]
    return (pref or good or [e for e in exs if e["S"] == S] or [None])[0]


def order_row(ex):
    """For an S = L decode (one token per step): the step at which each position was committed."""
    order = {}
    for i, s in enumerate(ex["steps"]):
        for j in s["committed"]:
            order.setdefault(j, i + 1)
    final = ex["steps"][-1]["canvas"]
    end = final.index("<eos>") + 1 if "<eos>" in final else len(final)
    o = ['<div class="scroll"><table class="canvas order"><tbody><tr><td class="sn">token</td>']
    o += [f"<td>{tok_cell(final[j])}</td>" for j in range(end)]
    o.append('</tr><tr><td class="sn">step</td>')
    o += [f'<td class="ord">{order.get(j, "fill")}</td>' for j in range(end)]
    o.append("</tr></tbody></table></div>")
    return "".join(o)


def diagram():
    """AR (one token per forward, left to right) vs masked diffusion (whole canvas, refined over steps)."""
    toks = ["␣AFR", "7", "0", "1", "␣Altitude", "␣7", "0", "0", "0", "⏎"]
    cw, ch, gap = 50, 26, 4
    def row(x0, y, cells, cls_fn):
        o = []
        for j, t in enumerate(cells):
            x = x0 + j * (cw + gap)
            c = cls_fn(j, t)
            o.append(f'<rect x="{x}" y="{y}" width="{cw}" height="{ch}" rx="5" class="dg {c}"/>')
            if t:
                o.append(f'<text x="{x + cw / 2}" y="{y + 17}" text-anchor="middle" class="dgt {c}">{E(t if len(t) < 8 else t[:6] + "…")}</text>')
        return "".join(o)
    W = 10 * (cw + gap) + 110
    o = [f'<svg viewBox="0 0 {W} 520" class="diagram" role="img" aria-label="Autoregressive versus masked diffusion decoding">']
    o.append('<text x="0" y="16" class="dgh">Autoregressive (S1): one forward pass per token, left to right</text>')
    ar_steps = [1, 2, 3, 4, 5, 10]
    y = 30
    for k in ar_steps:
        cells = toks[:k]
        o.append(f'<text x="0" y="{y + 17}" class="dgs">pass {k}</text>' if k != 10 else f'<text x="0" y="{y + 17}" class="dgs">pass 10</text>')
        o.append(row(70, y, cells + [""] * (10 - k), lambda j, t, k=k: "new" if j == k - 1 else ("on" if t else "off")))
        y += ch + 8
        if k == 5:
            o.append(f'<text x="{70 + 4 * (cw + gap) + cw / 2}" y="{y + 10}" text-anchor="middle" class="dgs">⋮</text>'); y += 16
    y += 22
    o.append(f'<text x="0" y="{y}" class="dgh">Masked diffusion: a fixed canvas of L slots, all predicted every pass; the surest are kept</text>')
    y += 14
    canv = [[None] * 10,
            [None, None, None, None, "␣Altitude", None, None, None, None, "⏎"],
            ["␣AFR", None, None, None, "␣Altitude", "␣7", "0", "0", "0", "⏎"],
            ["␣AFR", "7", "0", "1", "␣Altitude", "␣7", "0", "0", "0", "⏎"]]
    for k, cells in enumerate(canv):
        prev = canv[k - 1] if k else [None] * 10
        o.append(f'<text x="0" y="{y + 17}" class="dgs">{"start" if k == 0 else f"pass {k}"}</text>')
        o.append(row(70, y, ["▒" if t is None else t for t in cells],
                     lambda j, t, cells=cells, prev=prev: "mask" if cells[j] is None else ("new" if prev[j] is None else "on")))
        y += ch + 8
    o.append(f'<text x="0" y="{y + 18}" class="dgs">S = 3 passes here; S = 1 fills every slot from one pass, S = L keeps one token per pass. ▒ = [MASK], ⏎ = end of line.</text>')
    o.append("</svg>")
    return "".join(o).replace('viewBox="0 0 %d 520"' % W, f'viewBox="0 0 {W} {y + 30}"')


# ---------------------------------------------------------------- data views
def evals(name):
    return [(r["step"], r["val"]["exact"]) for r in M[name] if "val" in r]


def losses(name, key="loss", start=50):
    return [(r["step"], r[key]) for r in M[name] if key in r and "val" not in r and r["step"] >= start]


def smooth(pts, k=4):
    out = []
    for i in range(len(pts)):
        w = pts[max(0, i - k):i + 1]
        out.append((pts[i][0], sum(v for _, v in w) / len(w)))
    return out


def gfix(g, s, cons, S):
    return (g.get("fixed", {}).get(f"{s}|{cons}|{S}") or {})


def build():
    Ss = [1, 2, 4, 8, L]
    best = SUM.get("best", {})
    ar_v, ar_s = AR_EVAL.get("val", {}).get("exact"), (AR_EVAL.get("test_airport") or {}).get("exact")
    sh_v, sh_s = SHIP["val"]["exact"], SHIP["test_airport"]["exact"]
    d8v, d8s = gfix(G, "val", "span", 8).get("exact"), gfix(G, "sydney", "span", 8).get("exact")
    i8v, i8s = gfix(GI, "val", "span", 8).get("exact"), gfix(GI, "sydney", "span", 8).get("exact")
    n = G.get("n", 1000)
    steps = json.load(open(RUNS / "dlm/config.json"))["args"]["steps"] if (RUNS / "dlm/config.json").exists() else None
    batch = json.load(open(RUNS / "dlm/config.json"))["args"]["batch"] if (RUNS / "dlm/config.json").exists() else None
    t_ar = AR_EVAL.get("train_s"); t_dlm = DONE["dlm"].get("train_s"); t_init = DONE["dlm-arinit"].get("train_s")

    # accuracy vs training step
    acc_train = line_chart(
        [{"name": "AR (matched)", "cls": COL["ar"], "pts": evals("ar-matched")},
         {"name": "Diffusion, random init", "cls": COL["dlm"], "pts": evals("dlm")},
         {"name": "… with mean-CE loss", "cls": COL["dlm"], "pts": evals("dlm-meanw"), "dash": True},
         {"name": "Diffusion, AR init", "cls": COL["init"], "pts": [(0, DG["arinit_step0_val"]["exact"])] + evals("dlm-arinit") if "arinit_step0_val" in DG else evals("dlm-arinit")}],
        sorted({0, *[s for s, _ in evals("dlm")], *[s for s, _ in evals("ar-matched")]}), 0, 1, [0, .25, .5, .75, 1], lambda v: f"{100 * v:.0f}%",
        w=600, h=260, xlabel="training step (batch 32)", label_w=150)
    # loss curves: different units, so separate charts
    lc_ar = line_chart([{"name": "AR: CE per answer token", "cls": COL["ar"], "pts": smooth(losses("ar-matched")), "r": 0}],
                       [0, steps or 1500], 0, 3, [0, 1, 2, 3], lambda v: f"{v:.1f}", w=440, h=220, xlabel="step", label_w=8)
    lc_d = line_chart([{"name": "random init", "cls": COL["dlm"], "pts": smooth(losses("dlm")), "r": 0},
                       {"name": "AR init", "cls": COL["init"], "pts": smooth(losses("dlm-arinit")), "r": 0}],
                      [0, steps or 1500], 0, 3, [0, 1, 2, 3], lambda v: f"{v:.1f}", w=440, h=220, xlabel="step", label_w=90)
    # accuracy vs S
    def vs_s(setname, ar_ref, ship_ref, title):
        return line_chart(
            [{"name": "Diffusion, random", "cls": COL["dlm"], "pts": [(S, gfix(G, setname, "span", S).get("exact")) for S in Ss]},
             {"name": "Diffusion, AR init", "cls": COL["init"], "pts": [(S, gfix(GI, setname, "span", S).get("exact")) for S in Ss]}],
            Ss, 0, 1, [0, .25, .5, .75, 1], lambda v: f"{100 * v:.0f}%", w=440, h=250, xlabel=f"denoising steps S (canvas L = {L})",
            refs=[r for r in [{"name": "AR matched", "cls": COL["ar"], "y": ar_ref}, {"name": "AR shipped", "cls": COL["ship"], "y": ship_ref}] if r["y"] is not None],
            xtick_labels=[str(s) if s != L else f"{s} = L" for s in Ss], label_w=128)
    acc_s_val = vs_s("val", ar_v, sh_v, "val")
    acc_s_syd = vs_s("sydney", ar_s, sh_s, "Sydney")

    # constraint table
    cons_rows = []
    for cons, desc in [("none", "plain argmax"), ("first", "mask invalid first tokens"), ("snap", "post-hoc: nearest callsign in the state"), ("span", "score every callsign in the state, commit the best first")]:
        cells = []
        for g in (G, GI):
            for s in ("val", "sydney"):
                r = gfix(g, s, cons, 8)
                cells.append(f'<td class="n">{pct(r.get("exact"))}<small>{pct(r.get("callsign"), 0)} cs</small></td>')
        cons_rows.append(f"<tr><td><strong>{cons}</strong><small>{E(desc)}</small></td>{''.join(cells)}</tr>")
    ar_unc = AR_EVAL.get("val_unconstrained", {})

    # threshold schedule
    thr = []
    for g, nm in ((G, "random init"), (GI, "AR init")):
        for k, r in sorted(g.get("threshold", {}).items()):
            s, _, tau = k.split("|")
            thr.append(f'<tr><td>{nm}</td><td>{s}</td><td class="n">{tau}</td><td class="n">{pct(r["exact"])}</td><td class="n">{r["nfe"]:.2f}</td></tr>')

    # latency bars
    lat = []
    if B:
        vmax = max([v["p50_ms"] for v in B["dlm"].values()] + [v["kv"]["p50_ms"] for v in B["ar"].values()])
        rows = [{"head": "Autoregressive, KV cache, callsign trie"}]
        nm = {"ar-matched": "AR matched", "s1-2m-11ap-swap": "AR shipped"}
        for k, v in B["ar"].items():
            rows.append({"label": nm.get(k, k), "sub": f"{v['forwards_mean']:.1f} passes", "value": v["kv"]["p50_ms"], "cls": COL["ar"],
                         "tip": f"p50 {v['kv']['p50_ms']} ms · p95 {v['kv']['p95_ms']} ms · {v['forwards_mean']} forwards"})
            rows.append({"label": nm.get(k, k) + " + prefix", "sub": "state prefilled", "value": v["prefix"]["p50_ms"], "cls": COL["ar"] + " soft",
                         "tip": f"p50 {v['prefix']['p50_ms']} ms after release; state prefill {v['ctx_prefill']['p50_ms']} ms while talking"})
        for mode, title in (("exact", "Diffusion, exact (prompt re-read every pass)"), ("prompt", "Diffusion, prompt cache from pass 1 (approximate)"), ("ctx", "Diffusion, state cached while talking (approximate)")):
            rows.append({"head": title})
            for S in [1, 2, 4, 8, L, "tau0.9"]:
                v = B["dlm"].get(f"{S}|{mode}")
                if not v:
                    continue
                lab = f"S = {S}" if S != "tau0.9" else "τ = 0.9"
                rows.append({"label": lab, "sub": f"{v['nfe']:.1f} passes · {pct(v['exact'], 0)}", "value": v["p50_ms"], "cls": COL["dlm"] + ("" if mode == "exact" else " soft"),
                             "tip": f"p50 {v['p50_ms']} ms · p95 {v['p95_ms']} ms · {v['nfe']} passes · exact {pct(v['exact'])} (n={B['n']})"})
        lat = hbars(rows, vmax)

    # comparison table
    def lk(name, s):
        return (LK.get(name) or {}).get(s)
    bench_ar = B.get("ar", {}) if B else {}
    bd = B.get("dlm", {}) if B else {}
    comp = [
        ("AR, matched compute", "ml/s1/train.py", f"{steps} × {batch}", t_ar, AR_EVAL.get("val", {}), AR_EVAL.get("test_airport") or {}, (bench_ar.get("ar-matched") or {}).get("kv", {}).get("p50_ms"), lk("ar-matched", "val")),
        ("Diffusion, random init, S = 8", "train_dlm.py, 1/t ELBO weight", f"{steps} × {batch}", t_dlm, gfix(G, "val", "span", 8), gfix(G, "sydney", "span", 8), (bd.get("8|exact") or {}).get("p50_ms"), lk("dlm", "val")),
        ("Diffusion, random init, mean-CE loss, S = 8", "--weight mean", f"{steps} × {batch}", DONE["dlm-meanw"].get("train_s"), gfix(GM, "val", "span", 8), gfix(GM, "sydney", "span", 8), None, None),
        ("Diffusion, AR init, S = 8", "--init-ar shipped", f"{steps} × {batch} (+ the AR run)", t_init, gfix(GI, "val", "span", 8), gfix(GI, "sydney", "span", 8), (bd.get("8|prompt") or {}).get("p50_ms"), lk("dlm-arinit", "val")),
        ("Diffusion, AR init, S = " + str(L), "", "", None, gfix(GI, "val", "span", L), gfix(GI, "sydney", "span", L), (bd.get(f"{L}|prompt") or {}).get("p50_ms"), None),
        ("Diffusion, AR init, τ = 0.9", "threshold schedule", "", None, GI.get("threshold", {}).get("val|span|0.9", {}), GI.get("threshold", {}).get("sydney|span|0.9", {}), (bd.get("tau0.9|ctx") or {}).get("p50_ms"), None),
        ("AR shipped (ceiling)", "GPU L4", "6000 × 64", SHIP.get("train_s"), SHIP["val"], SHIP["test_airport"], (bench_ar.get("s1-2m-11ap-swap") or {}).get("kv", {}).get("p50_ms"), lk("s1-2m-11ap-swap", "val")),
        ("AR shipped + span-scored callsign", "ar_span.py, same weights", "6000 × 64", None, (AS.get("val") or {}).get("span", {}), (AS.get("sydney") or {}).get("span", {}), (ASB.get("span_fast") or {}).get("p50_ms"), None),
    ]
    comp_html = []
    for name, how, sb, ts, v, s, lat_ms, nll in comp:
        if not v:
            continue
        comp_html.append(f"<tr><td><strong>{E(name)}</strong><small>{E(how)}</small></td><td class='n'>{E(sb)}</td><td class='n'>{'–' if ts is None else f'{ts / 60:.0f} min'}</td>"
                         f"<td class='n'>{pct(v.get('exact'))}</td><td class='n'>{pct(v.get('callsign'))}</td><td class='n'>{pct(s.get('exact'))}</td><td class='n'>{pct(s.get('callsign'))}</td>"
                         f"<td class='n'>{'–' if lat_ms is None else f'{lat_ms:.0f} ms'}</td><td class='n'>{'–' if nll is None else f'{nll:.2f}'}</td></tr>")

    ex4 = pick_example(EXI, 4) or pick_example(EX, 4)
    exL = pick_example(EXI, L) or pick_example(EX, L)
    okL = {e["said"] for e in EXI if e["S"] == L and e["pred"].strip().upper().split() == e["gold"].upper().split()}
    exF = next((e for e in EXI if e["S"] == 4 and e["said"] in okL and e["pred"].strip().upper().split() != e["gold"].upper().split()
                and any(a == b for a, b in zip(e["pred"].split(), e["pred"].split()[1:]))), None)
    fw = B.get("forward", {}) if B else {}
    ctx_cache = G.get("cache", {})

    def cache_cell(g, s, mode, S):
        r = g.get("cache", {}).get(f"{s}|{mode}|{S}")
        return pct(r.get("exact")) if r else "–"

    V = SUM.get("verdict", {})
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Diffusion vs Autoregressive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>
:root {{
  --bg: #0e0f11; --surface: #141416; --raise: #1c1c1e; --line: rgba(255,255,255,.09); --line-strong: rgba(255,255,255,.16);
  --ink-1: #f4f4f5; --ink-2: #c4c5c8; --ink-3: #a0a1a6; --ink-4: #7f8086;
  --accent: #f5933f; --accent-tint: rgba(245,147,63,.14);
  --good: #57cd50; --good-tint: rgba(87,205,80,.13); --neutral-tint: rgba(255,255,255,.07);
  --c-ar: #3987e5; --c-dlm: #d95926; --c-init: #199e70; --c-ship: #8a8b91;
  --font: "DM Sans", "Helvetica Neue", Arial, sans-serif; --mono: "DM Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: dark;
}}
@media (prefers-color-scheme: light) {{ :root:not([data-theme="dark"]) {{
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12);
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --neutral-tint: rgba(20,20,24,.06);
  --c-ar: #2a78d6; --c-dlm: #eb6834; --c-init: #1baf7a; --c-ship: #77787e;
  color-scheme: light;
}} }}
:root[data-theme="light"] {{
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12);
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --neutral-tint: rgba(20,20,24,.06);
  --c-ar: #2a78d6; --c-dlm: #eb6834; --c-init: #1baf7a; --c-ship: #77787e;
  color-scheme: light;
}}
* {{ box-sizing: border-box; }}
html {{ -webkit-text-size-adjust: 100%; }}
body {{ margin: 0; background: var(--bg); color: var(--ink-2); font-family: var(--font); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 40px 72px; }}
.wrap {{ max-width: 960px; margin: 0 auto; display: grid; gap: 56px; }}
h1, h2, h3 {{ color: var(--ink-1); text-wrap: balance; margin: 0; font-weight: 600; letter-spacing: -.01em; }}
h1 {{ font-size: clamp(28px, 4.4vw, 40px); line-height: 1.12; }}
h2 {{ font-size: 22px; line-height: 1.25; }}
h3 {{ font-size: 15px; line-height: 1.35; }}
p {{ margin: 0; max-width: 70ch; }}
a {{ color: var(--accent); text-underline-offset: 2px; }}
code, .mono {{ font-family: var(--mono); font-size: .9em; }}
.eyebrow {{ font-size: 11.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }}
section {{ display: grid; gap: 18px; min-width: 0; }}
header {{ display: grid; gap: 16px; }}
.lede {{ font-size: 17px; max-width: 64ch; }}
.meta {{ display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--ink-3); font-size: 13px; }}
.note {{ font-size: 13px; color: var(--ink-3); }}
.card {{ background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 20px; display: grid; gap: 14px; min-width: 0; }}
.tiles {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }}
.tile {{ background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; display: grid; gap: 4px; align-content: start; }}
.tile .k {{ font-size: 12px; color: var(--ink-3); }}
.tile .v {{ font-size: 32px; line-height: 1.1; font-weight: 600; color: var(--ink-1); font-variant-numeric: tabular-nums; letter-spacing: -.02em; }}
.tile .v small {{ font-size: 15px; color: var(--ink-4); font-weight: 500; }}
.tile .s {{ font-size: 12.5px; color: var(--ink-3); }}
.tile.key {{ border-color: var(--accent); }}
.defs {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px 22px; margin: 0; }}
.defs div {{ display: grid; gap: 2px; }}
.defs dt {{ color: var(--ink-1); font-weight: 600; font-size: 14px; }}
.defs dd {{ margin: 0; font-size: 13.5px; color: var(--ink-3); line-height: 1.5; }}
.two {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }}
svg {{ display: block; width: 100%; height: auto; overflow: visible; }}
.lc .grid {{ stroke: var(--line); stroke-width: 1; }}
.lc .tick {{ fill: var(--ink-4); font-size: 11px; font-family: var(--font); font-variant-numeric: tabular-nums; }}
.lc .axl {{ fill: var(--ink-3); }}
.lc .lab {{ fill: var(--ink-2); font-size: 11.5px; font-family: var(--font); }}
.lc .ln {{ fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }}
.lc .ln.dash {{ stroke-dasharray: 5 4; }}
.lc .ref, .lc .key {{ stroke-width: 2; }}
.lc .ref {{ stroke-dasharray: 5 4; opacity: .9; }}
.lc .key.dash {{ stroke-dasharray: 3 2; }}
.lc .dot {{ stroke: var(--surface); stroke-width: 2; }}
.lc .dot:hover {{ r: 6; }}
.ln.c-ar, .ref.c-ar, .key.c-ar {{ stroke: var(--c-ar); }} .dot.c-ar {{ fill: var(--c-ar); }}
.ln.c-dlm, .key.c-dlm {{ stroke: var(--c-dlm); }} .dot.c-dlm {{ fill: var(--c-dlm); }}
.ln.c-init, .key.c-init {{ stroke: var(--c-init); }} .dot.c-init {{ fill: var(--c-init); }}
.ref.c-ship, .key.c-ship {{ stroke: var(--c-ship); }}
.legend {{ display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--ink-2); }}
.legend span {{ display: inline-flex; align-items: center; gap: 7px; }}
.legend i {{ width: 14px; height: 3px; border-radius: 2px; display: inline-block; }}
.legend i.c-ar {{ background: var(--c-ar); }} .legend i.c-dlm {{ background: var(--c-dlm); }} .legend i.c-init {{ background: var(--c-init); }}
.legend i.c-ship {{ background: repeating-linear-gradient(90deg, var(--c-ship) 0 4px, transparent 4px 7px); }}
.diagram .dg {{ stroke-width: 1; }}
.diagram .dg.off {{ fill: none; stroke: var(--line); stroke-dasharray: 3 3; }}
.diagram .dg.on {{ fill: var(--raise); stroke: var(--line-strong); }}
.diagram .dg.new {{ fill: var(--accent-tint); stroke: var(--accent); }}
.diagram .dg.mask {{ fill: var(--neutral-tint); stroke: var(--line); }}
.diagram .dgt {{ fill: var(--ink-1); font-family: var(--mono); font-size: 11.5px; }}
.diagram .dgt.mask {{ fill: var(--ink-4); }}
.diagram .dgh {{ fill: var(--ink-1); font-size: 13.5px; font-weight: 600; font-family: var(--font); }}
.diagram .dgs {{ fill: var(--ink-3); font-size: 11.5px; font-family: var(--font); }}
.strip {{ display: grid; gap: 8px; }}
.strip-head {{ display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline; }}
.scroll {{ overflow-x: auto; min-width: 0; }}
table {{ border-collapse: collapse; width: 100%; font-size: 13.5px; font-variant-numeric: tabular-nums; }}
th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }}
th {{ font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); font-weight: 600; }}
td.n {{ text-align: right; font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }}
td small, td.n small {{ display: block; color: var(--ink-4); font-size: 11px; font-family: var(--font); }}
td strong {{ color: var(--ink-1); font-weight: 600; }}
table.canvas {{ width: auto; }}
table.canvas td, table.canvas th {{ padding: 3px 2px; border: 0; text-align: center; }}
table.canvas th {{ font-size: 10px; color: var(--ink-4); letter-spacing: 0; }}
.sn {{ font-size: 11px; color: var(--ink-4); padding-right: 8px !important; text-align: right !important; white-space: nowrap; }}
.cell {{ display: inline-block; min-width: 34px; padding: 3px 5px; border-radius: 5px; font-family: var(--mono); font-size: 12px; color: var(--ink-1); background: var(--raise); border: 1px solid var(--line); white-space: nowrap; }}
.cell.m {{ color: var(--ink-4); background: var(--neutral-tint); }}
.cell.e {{ color: var(--ink-3); }}
.cell.new {{ background: var(--accent-tint); border-color: var(--accent); }}
.rest {{ font-size: 12px; color: var(--ink-4); }}
.ord {{ font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); }}
.rows {{ display: grid; gap: 7px; }}
.bhead {{ font-size: 12px; font-weight: 600; color: var(--ink-1); margin-top: 10px; }}
.brow {{ display: grid; grid-template-columns: 150px 1fr 70px; gap: 10px; align-items: center; position: relative; }}
.blab {{ font-size: 13px; color: var(--ink-1); line-height: 1.2; }}
.blab small {{ display: block; color: var(--ink-4); font-size: 11px; }}
.track {{ position: relative; height: 12px; }}
.fill {{ position: absolute; left: 0; top: 0; bottom: 0; border-radius: 0 4px 4px 0; min-width: 2px; }}
.fill.c-ar {{ background: var(--c-ar); }} .fill.c-dlm {{ background: var(--c-dlm); }}
.fill.soft {{ opacity: .6; }}
.val {{ font-family: var(--mono); font-size: 12.5px; text-align: right; color: var(--ink-2); }}
.tip {{ position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 3; background: var(--raise); color: var(--ink-1); border: 1px solid var(--line-strong); border-radius: 8px; padding: 5px 9px; font-size: 12px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .12s; }}
.brow:hover .tip, .brow:focus-visible .tip {{ opacity: 1; }}
.verdict {{ border-left: 3px solid var(--accent); padding: 4px 0 4px 16px; display: grid; gap: 10px; }}
ul.plain {{ margin: 0; padding-left: 18px; display: grid; gap: 6px; max-width: 74ch; }}
pre {{ background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; overflow-x: auto; font-size: 12.5px; color: var(--ink-2); margin: 0; }}
@media (max-width: 620px) {{ .brow {{ grid-template-columns: 100px 1fr 62px; }} }}
@media (prefers-reduced-motion: reduce) {{ .tip {{ transition: none; }} }}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="eyebrow">OpenATC · AI engineering log · module 8 · diffusion LMs</div>
  <h1>Diffusion vs autoregressive for voice commands</h1>
  <p class="lede">A 2 M-parameter masked diffusion language model, built from scratch out of the same transformer blocks, tokenizer and data as our
  autoregressive S1 model, trained with the same steps and batch size on the same CPU, and compared on the same {n} validation and {n} unseen-airport (Sydney) commands.</p>
  <div class="meta"><span>Code: <code>ml/diffusion/</code></span><span>Numbers: <code>ml/diffusion/RESULTS.md</code></span><span><a href="/reports/voice-ai.html">Voice AI report</a></span></div>
</header>

<section aria-labelledby="h-top">
  <div class="eyebrow">Result</div>
  <h2 id="h-top">{E(V.get("headline", ""))}</h2>
  <div class="tiles">
    <div class="tile"><div class="k">Val exact · AR, matched compute</div><div class="v">{pct(ar_v)}</div><div class="s">Sydney {pct(ar_s)}</div></div>
    <div class="tile key"><div class="k">Val exact · diffusion, same compute, S = 8</div><div class="v">{pct(d8v)}</div><div class="s">Sydney {pct(d8s)}</div></div>
    <div class="tile"><div class="k">Val exact · diffusion from the AR checkpoint, S = 8</div><div class="v">{pct(i8v)}</div><div class="s">Sydney {pct(i8s)}</div></div>
    <div class="tile"><div class="k">Val exact · shipped AR (ceiling)</div><div class="v">{pct(sh_v)}</div><div class="s">Sydney {pct(sh_s)} · 6000 × 64 on a GPU</div></div>
  </div>
  <p class="note">{E(V.get("sub", ""))}</p>
</section>

<section aria-labelledby="h-how">
  <div class="eyebrow">The idea</div>
  <h2 id="h-how">Two ways to write a command line</h2>
  <div class="card">{diagram()}</div>
  <dl class="defs">
    <div><dt>Autoregressive (AR)</dt><dd>Predict the next token from everything before it, append it, repeat. A causal mask stops each position seeing the future. One forward pass per output token; the KV cache makes each pass cheap.</dd></div>
    <div><dt>Masked diffusion LM</dt><dd>Start from a canvas of L [MASK] tokens and fill it in over S passes. Attention is bidirectional: every slot sees the prompt and every other slot, decided or not.</dd></div>
    <div><dt>Forward (masking) process</dt><dd>The corruption used in training: pick a noise level t between 0 and 1 and replace each answer token by [MASK] with probability t. t = 1 is pure noise (all masks).</dd></div>
    <div><dt>Denoising</dt><dd>The learned reverse step: given a partly masked canvas (and the prompt), predict the clean token at every masked slot at once.</dd></div>
    <div><dt>Low-confidence remasking</dt><dd>At each decoding pass keep only the most confident predictions; the others go back to [MASK] and are predicted again next pass, now conditioned on what was kept (LLaDA).</dd></div>
    <div><dt>Steps S</dt><dd>Passes over the canvas. S = 1 is fully parallel (every slot from one pass), S = L keeps one token per pass. Fewer steps = faster but each slot is guessed without seeing its neighbours.</dd></div>
  </dl>
</section>

<section aria-labelledby="h-strip">
  <div class="eyebrow">A real decode</div>
  <h2 id="h-strip">Masked → filled, one validation command</h2>
  <div class="card">
    {strip(ex4, "S = 4: about a quarter of the canvas is kept per pass (highlighted = kept this pass)") if ex4 else ""}
    {strip(exF, "Failure mode at S = 4: a word kept in the wrong slot is never taken back") + '<p class="note">In pass 3 the model kept ␣heading one slot too far right. Kept tokens are never remasked, and the last pass must fill every slot still open, so it had to put something between ␣Fly and ␣heading — and chose ␣heading again. With one token per pass (S = L) the same model lays the words down in order and gets this command right. Fewer steps means more forced, low-confidence commits like this one.</p>' if exF else ""}
    {('<div class="strip"><h3>S = L = ' + str(L) + ': one token per pass — the order the model chose</h3>' + order_row(exL) + '<p class="note">Low numbers were decided first. ⏎ positions are the end-of-line padding; once one is kept, the slots after it are filled with ⏎ for free (as in every training canvas), so a command needs only about as many passes as it has tokens.</p></div>') if exL else ""}
  </div>
</section>

<section aria-labelledby="h-train">
  <div class="eyebrow">Training · {steps} steps × batch {batch}, 1 CPU thread each, same data</div>
  <h2 id="h-train">Same compute, how far did each get?</h2>
  <p>Diffusion objective (MDLM / LLaDA): mask the answer at a random level t, score cross-entropy only on the masked slots, and <strong>weight by 1/t</strong>.
  That weighting comes from the ELBO (evidence lower bound): averaged over t it is an upper bound on the answer's negative log-likelihood, so minimising it pushes the likelihood up, as the AR loss does.
  Light masking (small t) gives few, easy targets, so each counts more.</p>
  <div class="card">
    <div class="legend"><span><i class="c-ar"></i>AR, matched</span><span><i class="c-dlm"></i>Diffusion, random init (dashed: mean-CE loss instead of the 1/t ELBO weight)</span><span><i class="c-init"></i>Diffusion, initialised from the shipped AR model</span></div>
    <h3>Validation exact match during training (n = 200, AR greedy + trie, diffusion S = 8 + span constraint)</h3>
    {acc_train}
  </div>
  <div class="two">
    <div class="card"><h3>AR training loss</h3><p class="note">Cross-entropy per answer token (nats), smoothed, from step 50.</p>{lc_ar}</div>
    <div class="card"><h3>Diffusion training loss</h3><p class="note">ELBO-weighted loss per canvas slot (nats), smoothed, from step 50. This is not the same unit as the AR loss, so compare the likelihoods below instead.</p>{lc_d}</div>
  </div>
  {likelihood_block()}
  {ce_t_block()}
</section>

<section aria-labelledby="h-steps">
  <div class="eyebrow">Accuracy vs steps · n = {n} each · span constraint</div>
  <h2 id="h-steps">How many passes does diffusion need?</h2>
  <div class="two">
    <div class="card"><h3>Validation (11 known airports)</h3>{acc_s_val}</div>
    <div class="card"><h3>Sydney (airport never seen in training)</h3>{acc_s_syd}</div>
  </div>
  <p class="note">{E(V.get("steps_note", ""))}</p>
  <details class="card"><summary>Threshold schedule (Fast-dLLM): keep every slot with p &gt; τ, at least one per pass</summary>
    <div class="scroll"><table><thead><tr><th>model</th><th>set</th><th>τ</th><th>exact</th><th>passes</th></tr></thead><tbody>{''.join(thr)}</tbody></table></div>
  </details>
</section>

<section aria-labelledby="h-cons">
  <div class="eyebrow">Constrained callsigns · S = 8 · n = {n}</div>
  <h2 id="h-cons">A trie needs left-to-right; diffusion needs another trick</h2>
  <p>The AR model walks a trie of the callsigns in the game state, so it can never name an aircraft that is not there. A diffusion model fills slots in any order, so we tried three alternatives.</p>
  <div class="card scroll"><table><thead><tr><th>constraint</th><th>random · val</th><th>random · Sydney</th><th>AR init · val</th><th>AR init · Sydney</th></tr></thead><tbody>{''.join(cons_rows)}</tbody></table>
  <p class="note">Exact match, with callsign accuracy below. For reference the matched AR model scores {pct(AR_EVAL.get('val', {}).get('exact'))} on val with its trie and {pct(ar_unc.get('exact'))} without it (n = {ar_unc.get('n', '–')}).</p></div>
  <p class="note">{E(V.get("cons_note", ""))}</p>
</section>

{ar_span_block()}

<section aria-labelledby="h-lat">
  <div class="eyebrow">Latency · CPU, 1 thread · n = {B.get('n', '–')} validation commands · median after push-to-talk release · diffusion = AR-init model, span constraint</div>
  <h2 id="h-lat">What the player waits for</h2>
  <div class="tiles">
    <div class="tile"><div class="k">One diffusion pass, prompt + canvas</div><div class="v">{fw.get('prompt_plus_canvas_ms', '–')}<small> ms</small></div><div class="s">{fw.get('tokens_full', '–')} tokens re-read</div></div>
    <div class="tile"><div class="k">One diffusion pass, canvas only (cached prompt)</div><div class="v">{fw.get('canvas_only_cached_ms', '–')}<small> ms</small></div><div class="s">{fw.get('tokens_canvas', '–')} tokens</div></div>
    <div class="tile"><div class="k">AR passes per command</div><div class="v">{(bench_ar.get('ar-matched') or {}).get('forwards_mean', '–')}</div><div class="s">prefill + one per token incl. ⏎</div></div>
  </div>
  <div class="card">{lat}</div>
  <p><strong>The prefix-cache question.</strong> In an AR model a token's keys and values never change once computed, because it cannot see later tokens: cache the prompt once and every later pass is one token.
  In a bidirectional model the prompt also attends to the canvas, so its keys and values change whenever the canvas changes. Caching them is an approximation, not an identity.
  We measured two: reuse the prompt's keys/values from pass 1 (Fast-dLLM's prefix cache) and encode the game state alone while the player is still talking.</p>
  <div class="card scroll"><table><thead><tr><th>prompt handling (AR-init model, span)</th><th>val S = 8</th><th>Sydney S = 8</th><th>val S = 4</th><th>val S = {L}</th><th>Sydney S = {L}</th></tr></thead><tbody>
    <tr><td><strong>exact</strong><small>re-read prompt + canvas every pass</small></td><td class="n">{cache_cell(GI, 'val', 'exact', 8)}</td><td class="n">{cache_cell(GI, 'sydney', 'exact', 8)}</td><td class="n">{pct(gfix(GI, 'val', 'span', 4).get('exact'))}*</td><td class="n">{pct(gfix(GI, 'val', 'span', L).get('exact'))}*</td><td class="n">{pct(gfix(GI, 'sydney', 'span', L).get('exact'))}*</td></tr>
    <tr><td><strong>prompt cache</strong><small>keys/values from pass 1, canvas-only after</small></td><td class="n">{cache_cell(GI, 'val', 'prompt', 8)}</td><td class="n">{cache_cell(GI, 'sydney', 'prompt', 8)}</td><td class="n">{cache_cell(GI, 'val', 'prompt', 4)}</td><td class="n">{cache_cell(GI, 'val', 'prompt', L)}</td><td class="n">{cache_cell(GI, 'sydney', 'prompt', L)}</td></tr>
    <tr><td><strong>state cache</strong><small>game state encoded alone while talking</small></td><td class="n">{cache_cell(GI, 'val', 'ctx', 8)}</td><td class="n">{cache_cell(GI, 'sydney', 'ctx', 8)}</td><td class="n">{cache_cell(GI, 'val', 'ctx', 4)}</td><td class="n">{cache_cell(GI, 'val', 'ctx', L)}</td><td class="n">{cache_cell(GI, 'sydney', 'ctx', L)}</td></tr>
  </tbody></table><p class="note">Cache rows and the exact S = 8 cells: the first {GI.get('n_cache', 500)} commands of each set. * = exact on all {n} (same sets, so a fair but not row-identical comparison). The random-init model is too weak for this test to mean anything.</p></div>
  <p class="note">{E(V.get("lat_note", ""))}</p>
</section>

<section aria-labelledby="h-table">
  <div class="eyebrow">Comparison · fixed sets, n = {n} val and n = {n} Sydney</div>
  <h2 id="h-table">All runs side by side</h2>
  <div class="card scroll"><table><thead><tr><th>model</th><th>steps × batch</th><th>train time</th><th>val exact</th><th>val callsign</th><th>Sydney exact</th><th>Sydney callsign</th><th>latency p50*</th><th>nats / cmd</th></tr></thead>
  <tbody>{''.join(comp_html)}</tbody></table>
  <p class="note">{E(V.get("matched_note", ""))}</p>
  <p class="note">* 1 thread, n = {B.get('n', '–')}: AR with KV cache; diffusion exact for random init (same cost), prompt cache for AR init, state cache for τ = 0.9; span-scored AR with all candidates in one batched pass. nats / cmd: AR exact NLL, diffusion ELBO bound (val, n = {LK.get('n', '–')}).</p></div>
</section>

<section aria-labelledby="h-verdict">
  <div class="eyebrow">Verdict</div>
  <h2 id="h-verdict">{E(V.get("title", ""))}</h2>
  <div class="verdict">{''.join(f"<p>{x}</p>" for x in V.get("points", []))}</div>
  <h3>When diffusion would win</h3>
  <ul class="plain">{''.join(f"<li>{x}</li>" for x in V.get("wins", []))}</ul>
  <h3>Next steps</h3>
  <ul class="plain">{''.join(f"<li>{x}</li>" for x in V.get("next", []))}</ul>
</section>

<section aria-labelledby="h-repro">
  <div class="eyebrow">Reproduce</div>
  <h2 id="h-repro">Commands</h2>
<pre>OMP_NUM_THREADS=1 python ml/s1/train.py --data ml/data/out4/ds --tok ml/tokenizer/atc.json --out ml/diffusion/runs/ar-matched \\
    --d 192 --layers 4 --heads 6 --steps {steps} --batch {batch} --lr 2e-3 --threads 1 --eval-every 250 --eval-n 200
OMP_NUM_THREADS=1 python ml/diffusion/train_dlm.py --out ml/diffusion/runs/dlm --steps {steps} --batch {batch} --threads 1 --eval-every 250
OMP_NUM_THREADS=1 python ml/diffusion/train_dlm.py --out ml/diffusion/runs/dlm-arinit --init-ar ml/gpu/results/s1-2m-11ap-swap/model.pt --steps {steps} --batch {batch} --threads 1 --eval-every 250
python ml/diffusion/evaluate.py --run ml/diffusion/runs/dlm --n 1000 --threads 3
python ml/diffusion/bench.py --dlm ml/diffusion/runs/dlm --ar ml/diffusion/runs/ar-matched ml/gpu/results/s1-2m-11ap-swap --n 200 --threads 1
python ml/diffusion/likelihood.py --ar ml/diffusion/runs/ar-matched ml/gpu/results/s1-2m-11ap-swap --dlm ml/diffusion/runs/dlm ml/diffusion/runs/dlm-arinit
python3 ml/diffusion/build_report.py</pre>
</section>
</div>
</body>
</html>
"""
    OUT.write_text(page)
    print("wrote", OUT, len(page))


def ar_span_block():
    if not AS:
        return ""
    v, y = AS["val"], AS["sydney"]
    tb, fb = ASB.get("trie", {}), ASB.get("span_fast", {})
    return f"""<section aria-labelledby="h-borrow">
  <div class="eyebrow">Borrowed back · shipped AR model · n = {AS['n']} each</div>
  <h2 id="h-borrow">The span trick works in the AR model too</h2>
  <p>Span scoring is not specific to diffusion: any model that can score a sequence can rank whole callsigns. In the shipped AR model, score each callsign in the state by its log-likelihood after the prompt (plus a word boundary), keep the best, then decode the rest greedily as before.</p>
  <div class="tiles">
    <div class="tile key"><div class="k">Val exact · trie → span</div><div class="v">{pct(v['trie']['exact'])} <small>→</small> {pct(v['span']['exact'])}</div><div class="s">callsign {pct(v['trie']['callsign'])} → {pct(v['span']['callsign'])}</div></div>
    <div class="tile key"><div class="k">Sydney exact · trie → span</div><div class="v">{pct(y['trie']['exact'])} <small>→</small> {pct(y['span']['exact'])}</div><div class="s">callsign {pct(y['trie']['callsign'])} → {pct(y['span']['callsign'])}</div></div>
    <div class="tile"><div class="k">Latency, 1 thread, p50 (n = {ASB.get('n', '–')})</div><div class="v">{tb.get('p50_ms', '–')} <small>→</small> {fb.get('p50_ms', '–')}<small> ms</small></div><div class="s">all candidates in one batched pass on the prompt cache; same output as scoring them one by one ({ASB.get('fast_equals_slow', '–')})</div></div>
  </div>
  <p class="note">Why it helps: the trie walks greedily, so a wrong first token (the airline) cannot be undone, and digits are chosen one at a time. Scoring complete callsigns compares them as wholes. Code: <code>ml/diffusion/ar_span.py</code>. This is the most useful result of the module for the game.</p>
</section>"""


def ce_t_block():
    d, di = LK.get("dlm", {}), LK.get("dlm-arinit", {})
    if "ce_by_t" not in d:
        return ""
    ts = [float(k) for k in d["ce_by_t"]]
    ser = lambda r, key: [(t, r.get(key, {}).get(str(t))) for t in ts]
    ymax = math.ceil(max(v for r in (d, di) for k in ("ce_by_t", "ce_by_t_wrong_prompt") for v in r.get(k, {}).values()) + .2)
    ch = line_chart([{"name": "random init", "cls": COL["dlm"], "pts": ser(d, "ce_by_t")},
                     {"name": "random, wrong prompt", "cls": COL["dlm"], "pts": ser(d, "ce_by_t_wrong_prompt"), "dash": True},
                     {"name": "AR init", "cls": COL["init"], "pts": ser(di, "ce_by_t")},
                     {"name": "AR init, wrong prompt", "cls": COL["init"], "pts": ser(di, "ce_by_t_wrong_prompt"), "dash": True}],
                    ts, 0, ymax, list(range(0, ymax + 1)), lambda v: f"{v:.1f}", w=600, h=250, xlabel="masking level t (fraction of the canvas hidden)",
                    xtick_labels=[f"{t:g}" for t in ts], label_w=150)
    return (f'<div class="card"><h3>Why the random-init model failed: is it reading the prompt?</h3>'
            f'<p class="note">Cross-entropy on masked slots at a fixed masking level (val, n = 300), with the right prompt and with another command\'s prompt. '
            f'If the two lines coincide, the prompt is being ignored: the model is guessing a typical command line from the visible canvas alone.</p>{ch}</div>')


def likelihood_block():
    if not LK:
        return ""
    rows = []
    names = {"ar-matched": ("AR, matched", "exact NLL"), "dlm": ("Diffusion, random init", "ELBO bound"), "dlm-arinit": ("Diffusion, AR init", "ELBO bound"),
             "s1-2m-11ap-swap": ("AR shipped", "exact NLL")}
    for k, (nm, kind) in names.items():
        if k in LK:
            rows.append(f"<tr><td><strong>{nm}</strong><small>{kind}</small></td><td class='n'>{LK[k]['val']:.2f}</td><td class='n'>{LK[k]['sydney']:.2f}</td></tr>")
    return (f'<div class="card scroll"><h3>Likelihood of the right command, in nats (lower is better; n = {LK["n"]})</h3><table><thead><tr><th>model</th><th>val</th><th>Sydney</th></tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table><p class="note">AR: −log p(line) by the chain rule. Diffusion: the ELBO, an upper bound on −log p(line), estimated with 8 noise levels per command. '
            f'This is how MDLM and LLaDA compare with AR models.</p></div>')


if __name__ == "__main__":
    build()

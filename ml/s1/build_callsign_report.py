"""Build public/reports/voice-callsign.html from the callsign-scoring results (ml/s1/CALLSIGN_SCORING.md).

    python3 ml/s1/build_callsign_report.py

Inputs (ml/s1/results/): summary.json (callsign_report.py), example.json (callsign_example.py), e2e_<tag>.json
(callsign_e2e.py), latency_<model>.json (callsign_latency.cjs), parity_ref.json; the verifier before / after:
gate_<model>.json (callsign_gate.py: the gate before / after on the same transcripts).
Static HTML, inline SVG, no script. Light + dark from the tokens of public/reports/voice-ai.html.
"""
import html, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
R = ROOT / "ml/s1/results"
OUT = ROOT / "public/reports/voice-callsign.html"
e = html.escape


def load(p):
    p = Path(p)
    return json.load(open(p)) if p.exists() else None


S = load(R / "summary.json")
EX = load(R / "example.json")
E2E = {t: load(R / f"e2e_{t}.json") for t in ("swap", "grpo")}
LAT = {m: load(R / f"latency_{m}.json") for m in ("2m-swap-v1", "2m-grpo-v1")}
PAR = load(R / "parity_ref.json")
VPAR = {m: load(ROOT / f"ml/verify/out/{m}/parity.json") for m in ("2m-swap-v1", "2m-grpo-v1")}
GATE = {m: load(R / f"gate_{m}.json") for m in ("2m-swap-v1", "2m-grpo-v1")}
MODELS = [("swap", "2m-swap-v1", "the first shipped model"), ("grpo", "2m-grpo-v1", "GRPO fine-tune")]
# the model the game ships (src/lib/voice/l1.ts S1_MODEL_URL): its numbers lead the page
SHIP_M = re.search(r"S1_MODEL_URL = '/models/s1/([^']+)'", (ROOT / "src/lib/voice/l1.ts").read_text()).group(1)
SHIP_T = next(t for t, m, _ in MODELS if m == SHIP_M)
SETS = [("val", "Validation", "11 training airports, held-out sessions"), ("sydney", "Sydney", "an airport the model never saw"),
        ("stt", "Real recognisers", "spoken commands through 5 speech-to-text models")]
pct = lambda x, d=1: f"{100 * x:.{d}f}%"
pf = lambda p: "p &lt; 0.001" if p < 0.001 else f"p = {p:.2f}" if p >= 0.01 else f"p = {p:.3f}"


def shipped(tag, s):
    """The shipped decoder's numbers: the end-to-end run when present, else the experiment's exact 'mean' variant."""
    e2 = E2E.get(tag)
    if e2 and s in e2:
        x = e2[s]
        return {"exact": x["score_exact"], "callsign": x["score_callsign"], "fixed": x["fixed"], "broken": x["broken"], "p": x["mcnemar_p"], "src": "e2e"}
    v = S[tag][s]; m = v["mean_vs_trie"]
    return {"exact": v["mean"]["exact"], "callsign": v["mean"]["callsign"], "fixed": m["fixed"], "broken": m["broken"], "p": m["p"], "src": "exp"}


# ---------------------------------------------------------------- figure 1: token costs of the candidates
def fig_costs():
    if not EX:
        return ""
    keep = ["VOZ527", "SAY AGAIN", "DAL817", "SIA820", "QFA71", "QFA76"]
    cands = [c for k in keep for c in EX["candidates"] if c["cs"] == k]
    W, left, right, rowh, top = 900, 150, 150, 46, 30
    span = W - left - right
    mx = max(-c["sum"] for c in cands)
    sc = span / mx
    out = [f'<svg viewBox="0 0 {W} {top + rowh * len(cands) + 34}" role="img" aria-labelledby="f1t f1d" class="svg">',
           '<title id="f1t">Cost of every token, per candidate callsign</title>',
           f'<desc id="f1d">Transcript "{e(EX["said"])}". Bars are minus log probability in nats, one segment per token plus the word boundary. '
           'VOZ527 costs 5.9 nats in total, the QFA candidates the trie started on cost 38 or more.</desc>']
    for t in range(0, int(mx) + 1, 10):
        x = left + t * sc
        out.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{top - 8}" y2="{top + rowh * len(cands) - 10}" class="grid"/>')
        out.append(f'<text x="{x:.1f}" y="{top + rowh * len(cands) + 8}" class="tick" text-anchor="middle">{t}</text>')
    out.append(f'<text x="{left + span / 2:.1f}" y="{top + rowh * len(cands) + 28}" class="tick" text-anchor="middle">nats (− log probability), lower is likelier</text>')
    for i, c in enumerate(cands):
        y = top + i * rowh
        cls = "win" if c["cs"] == EX["gold"].split()[0] else "trie" if c["cs"] == "QFA71" else "other"
        out.append(f'<text x="{left - 12}" y="{y + 15}" class="lab {cls}" text-anchor="end">{e(c["cs"])}</text>')
        x = left
        segs = [(p, -v) for p, v in zip(c["pieces"], c["lp"])] + [("␣", -c["boundary"])]
        for p, w in segs:
            ww = max(w * sc, 0.0)
            if ww >= 1.5:
                out.append(f'<rect x="{x:.1f}" y="{y}" width="{max(ww - 2, 1):.1f}" height="20" rx="3" class="seg {cls}"><title>{e(c["cs"])}: "{e(p.strip() or p)}" costs {w:.2f} nats (p = {pow(2.718281828, -w):.3g})</title></rect>')
                if ww > 34:
                    out.append(f'<text x="{x + ww / 2 - 1:.1f}" y="{y + 14.5}" class="seglab" text-anchor="middle">{e(p.strip() or p)}</text>')
            x += ww
        out.append(f'<text x="{W - right + 10}" y="{y + 15}" class="val">{-c["sum"]:.1f} nats · {-c["mean"]:.2f}/token</text>')
    out.append("</svg>")
    return "\n".join(out)


def fig_first():
    if not EX:
        return ""
    rows = EX["first_step"][:6]
    vo = next((p for t, p in EX["first_step"] if t.strip() == "VOZ"), None)
    if vo is not None and all(t.strip() != "VOZ" for t, _ in rows):
        rows = rows[:5] + [[" VOZ", vo]]
    h = []
    for t, p in rows:
        cls = "trie" if t.strip() == "QFA" else "win" if t.strip() == "VOZ" else "other"
        h.append(f'<div class="bar-row" tabindex="0"><span class="blab mono">{e(t.strip())}</span><div class="track"><div class="fill {cls}" style="width:{100 * p:.2f}%"></div></div>'
                 f'<span class="val">{pct(p)}</span><span class="tip">p("{e(t.strip())}" | allowed first tokens) = {p:.4f}</span></div>')
    return "\n".join(h)


def search_list():
    if not EX:
        return ""
    items, found = [], False
    for p in EX["pops"]:
        txt = p["text"].strip()
        if p["kind"] == "complete":
            items.append(f'<li class="done"><b>{e(txt)}</b> complete <span class="mono">{p["pri"]:+.2f}</span><small>every bound left is lower: this is the best</small></li>')
            found = True
            continue
        cls = "after" if found else ""
        items.append(f'<li class="{cls}"><span class="mono">{e(txt)}</span> <span class="mono dim">{p["pri"]:+.2f}</span></li>')
    return "\n".join(items)


# ---------------------------------------------------------------- figure 2: error rates, before / after
def fig_errors():
    groups = []
    for s, name, sub in SETS:
        pairs = []
        for tag, mname, mdesc in MODELS:
            if tag not in S:
                continue
            b = 1 - S[tag][s]["trie"]["exact"]; a = 1 - shipped(tag, s)["exact"]
            pairs.append((mname, b, a))
        bars = []
        for mname, b, a in pairs:
            for cls, v, lab in (("trie", b, "greedy trie"), ("win", a, "likelihood")):
                bars.append(f'<div class="bar-row" tabindex="0"><span class="blab">{e(mname)}</span><div class="track"><div class="fill {cls}" style="width:{100 * v / 0.25:.2f}%"></div></div>'
                            f'<span class="val">{pct(v)}</span><span class="tip">{e(name)}, {e(mname)}, {lab}: {pct(v)} of commands wrong (n = 1000)</span></div>')
        groups.append(f'<div class="group"><div class="lab">{e(name)}<small>{e(sub)}</small></div><div class="pair">{"".join(bars)}</div></div>')
    ticks = "".join(f'<span style="left:{100 * t / 0.25:.0f}%">{int(100 * t)}%</span>' for t in (0, 0.05, 0.10, 0.15, 0.20, 0.25))
    grid = "".join(f'<b style="left:{100 * t / 0.25:.0f}%"></b>' for t in (0, 0.05, 0.10, 0.15, 0.20, 0.25))
    return f'''<div class="plot"><div class="gridlines" aria-hidden="true">{grid}</div><div class="rows">{"".join(groups)}</div></div>
<div class="axis" aria-hidden="true"><span></span><div class="ticks">{ticks}</div></div>'''


def table_acc():
    rows = []
    for tag, mname, _ in MODELS:
        for s, name, _ in SETS:
            v = S[tag][s]; sh = shipped(tag, s)
            ex = lambda k: f'{pct(v[k]["exact"])} / {pct(v[k]["callsign"])}'
            mc = f'+{sh["fixed"]} −{sh["broken"]}, {pf(sh["p"])}' if sh["fixed"] is not None else "–"
            sa = lambda k: f'{v[k]["sa_missed"]} / {v[k]["sa_false"]}'
            rows.append(f'<tr><td>{e(mname)}</td><td>{e(name)}</td><td class="n">{ex("trie")}</td><td class="n">{ex("sum_nb")}</td><td class="n">{ex("sum")}</td>'
                        f'<td class="n">{ex("mean")}</td><td class="n"><strong>{pct(sh["exact"])} / {pct(sh["callsign"])}</strong></td><td class="n">{mc}</td>'
                        f'<td class="n">{sa("trie")} → {sa("mean")}</td></tr>')
    return "\n".join(rows)


# ---------------------------------------------------------------- figure 3: compute
def fig_cost():
    tag = SHIP_T
    rows = []
    for s, name, _ in SETS:
        c = S[tag][s]["cost"]; t = S[tag][s]
        e2 = E2E.get(tag) and E2E[tag].get(s)
        inst = t["mean"]["steps_mean"] - c["trie_nodes_mean"]          # continuation tokens after the callsign
        shipped_steps = (e2["search_steps_mean"] + inst) if e2 else c["astar_mean_cap2_steps_mean"]
        rows.append((name, [("trie", t["trie"]["steps_mean"], "greedy trie (before)"), ("win", shipped_steps, "best-first search (shipped)"),
                            ("other", t["beam4"]["steps_mean"], "beam search, width 4"), ("other", t["mean"]["steps_mean"], "every candidate, shared prefixes")]))
    mx = 60
    groups = []
    for name, bars in rows:
        bb = "".join(f'<div class="bar-row" tabindex="0"><span class="blab">{e(lab)}</span><div class="track"><div class="fill {cls}" style="width:{100 * v / mx:.2f}%"></div></div>'
                     f'<span class="val">{v:.1f}</span><span class="tip">{e(name)}: {v:.1f} model steps per command ({e(lab)})</span></div>' for cls, v, lab in bars)
        groups.append(f'<div class="group wide"><div class="lab">{e(name)}</div><div class="pair">{bb}</div></div>')
    ticks = "".join(f'<span style="left:{100 * t / mx:.0f}%">{t}</span>' for t in (0, 10, 20, 30, 40, 50, 60))
    grid = "".join(f'<b style="left:{100 * t / mx:.0f}%"></b>' for t in (0, 10, 20, 30, 40, 50, 60))
    return f'''<div class="plot wide"><div class="gridlines" aria-hidden="true">{grid}</div><div class="rows">{"".join(groups)}</div></div>
<div class="axis wide" aria-hidden="true"><span></span><div class="ticks">{ticks}</div></div>'''


def lat_tiles():
    t = []
    for m in ("2m-swap-v1", "2m-grpo-v1"):
        L = LAT.get(m)
        if L:
            t.append(f'<div class="tile"><div class="k">{e(m)}</div><div class="v">+{L["extra_ms_p50"]:.0f} ms <small>median</small></div>'
                     f'<div class="s">+{L["extra_ms_p95"]:.0f} ms at p95 · trie {L["trie_ms_p50"]:.0f} ms → {L["score_ms_p50"]:.0f} ms per complete() · n = {L["n"]}</div></div>')
    return "".join(t)


# ---------------------------------------------------------------- verifier before / after
def verifier_rows():
    """Per model and set: (as it ran) trie decoder + gate with the export bug, trie decoder + correctly exported gate,
    likelihood decoder + its gate (shipped). Sent and right as a share of the rules-failed transcripts, sent wrong as a count."""
    rows = []
    for tag, m, _ in MODELS:
        G = GATE.get(m)
        if not G:
            continue
        for s, name in (("val", "Validation"), ("syd", "Sydney"), ("stt", "Real recognisers"), ("noisy", "Heavy noise")):
            if s not in G:
                continue
            g = G[s]; n = g["before"]["l1"]
            cfg = [g["before"], g.get("before_fixed_gate"), g["after"]]
            right = " → ".join("–" if c is None else (f'<strong>{pct(c["sent_right"] / n)}</strong>' if c is g["after"] else pct(c["sent_right"] / n)) for c in cfg)
            wrong = " → ".join("–" if c is None else (f'<strong>{c["sent_wrong"]}</strong>' if c is g["after"] else str(c["sent_wrong"])) for c in cfg)
            say = " → ".join("–" if c is None else (f'<strong>{c["say_again"]}</strong>' if c is g["after"] else str(c["say_again"])) for c in cfg)
            rows.append(f'<tr><td>{e(m)}</td><td>{e(name)}</td><td class="n">{n}</td><td class="n">{pct(g["before"]["model_exact"] / n)} → <strong>{pct(g["after"]["model_exact"] / n)}</strong></td>'
                        f'<td class="n">{right}</td><td class="n">{wrong}</td><td class="n">{say}</td></tr>')
    return "\n".join(rows)


def fig_gate():
    """Sent right vs sent wrong, shipped model, Sydney + validation + real recognisers + noise pooled: the three configs."""
    G = GATE.get(SHIP_M)
    if not G or "before_fixed_gate" not in G.get("syd", {}):
        return ""
    sets = [s for s in ("val", "syd", "stt", "noisy") if s in G]
    tot = lambda k, f: sum(G[s][k][f] for s in sets)
    n = sum(G[s]["before"]["l1"] for s in sets)
    cfgs = [("before", "Greedy trie, gate as it ran (export bug)", "other"), ("before_fixed_gate", "Greedy trie, gate exported correctly", "trie"), ("after", "Likelihood decoder, refitted gate (shipped)", "win")]
    out = []
    for k, lab, cls in cfgs:
        r, w = tot(k, "sent_right"), tot(k, "sent_wrong")
        out.append(f'<div class="gate-row"><div class="glab">{e(lab)}</div>'
                   f'<div class="bar-row" tabindex="0"><span class="blab">sent, right</span><div class="track"><div class="fill {cls}" style="width:{100 * r / n:.2f}%"></div></div><span class="val">{pct(r / n)}</span><span class="tip">{r} of {n} transcripts the rules could not parse: sent, and the right command</span></div>'
                   f'<div class="bar-row" tabindex="0"><span class="blab">sent, wrong</span><div class="track"><div class="fill {cls} hatch" style="width:{100 * w / n:.2f}%"></div></div><span class="val">{pct(w / n)}</span><span class="tip">{w} of {n}: sent, but not the command that was said</span></div></div>')
    return f'<div class="rows">{"".join(out)}</div><p class="note">{SHIP_M} (the model the game ships), the four scored sets pooled ({n} transcripts the rules could not parse). Bars on one 0–100% scale of those transcripts.</p>'


def main():
    sw = S[SHIP_T]["sydney"]; shp = shipped(SHIP_T, "sydney")
    par = ""
    if PAR:
        par = f'{PAR["tokens_same_as_pytorch"]} of {PAR["n"]} Sydney commands token-for-token identical to <code>decode.generate_scored</code>, search signals equal'
    vpar = [f'{m}: {v["line_same_as_pytorch"]}/{v["n"]} lines, {v["signals_within_tolerance"]}/{v["n"]} signals' for m, v in VPAR.items() if v and "trie_tokens_same_as_committed_engine" in v]
    trie_same = [f'{v["trie_tokens_same_as_committed_engine"]}/{v["n"]}' for v in VPAR.values() if v and "trie_tokens_same_as_committed_engine" in v]
    vr = verifier_rows()
    doc = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Callsign by Likelihood</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>
/* Tokens: public/reports/voice-ai.html. Blue = the greedy trie (before), orange = likelihood (after), grey = other candidates. */
:root {{
  --bg: #0e0f11; --surface: #141416; --raise: #1c1c1e; --line: rgba(255,255,255,.09); --line-strong: rgba(255,255,255,.16);
  --ink-1: #f4f4f5; --ink-2: #c4c5c8; --ink-3: #a0a1a6; --ink-4: #7f8086;
  --accent: #f5933f; --accent-tint: rgba(245,147,63,.14);
  --s-before: #5b8fd6; --s-after: #d97626; --s-other: #55565c;
  --good: #57cd50; --good-tint: rgba(87,205,80,.13); --neutral-tint: rgba(255,255,255,.07);
  --font: "DM Sans", "Helvetica Neue", Arial, sans-serif; --mono: "DM Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: dark;
}}
@media (prefers-color-scheme: light) {{ :root:not([data-theme="dark"]) {{
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12);
  --s-before: #3f78c2; --s-after: #c8661a; --s-other: #b9b9bd;
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --neutral-tint: rgba(20,20,24,.06);
  color-scheme: light;
}} }}
:root[data-theme="light"] {{
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12);
  --s-before: #3f78c2; --s-after: #c8661a; --s-other: #b9b9bd;
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --neutral-tint: rgba(20,20,24,.06);
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
p, ul, ol {{ margin: 0; max-width: 68ch; }}
a {{ color: var(--accent); text-underline-offset: 2px; }}
a:focus-visible, [tabindex]:focus-visible, summary:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }}
code, .mono {{ font-family: var(--mono); font-size: .9em; }}
.eyebrow {{ font-size: 11.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }}
section {{ display: grid; gap: 18px; min-width: 0; }}
.lede {{ font-size: 17px; max-width: 62ch; }}
.meta {{ display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--ink-3); font-size: 13px; }}
header {{ display: grid; gap: 16px; }}
.headline {{ display: grid; grid-template-columns: auto 1fr; gap: 20px 28px; align-items: end; padding: 22px 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; }}
.big {{ font-size: clamp(40px, 7.5vw, 64px); line-height: 1; font-weight: 600; color: var(--ink-1); font-variant-numeric: tabular-nums; letter-spacing: -.03em; white-space: nowrap; }}
.big .from {{ color: var(--ink-4); }} .big .arrow {{ color: var(--ink-4); font-weight: 400; padding: 0 .12em; }}
@media (max-width: 620px) {{ .headline {{ grid-template-columns: 1fr; }} }}
.card {{ background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 20px; display: grid; gap: 14px; min-width: 0; }}
.chart-head {{ display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 20px; align-items: baseline; }}
.legend {{ display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--ink-2); }}
.legend span {{ display: inline-flex; align-items: center; gap: 7px; }}
.legend i {{ width: 12px; height: 8px; border-radius: 2px; display: inline-block; }}
.note {{ font-size: 13px; color: var(--ink-3); }}
/* SVG figure */
.svg {{ width: 100%; height: auto; display: block; font-family: var(--font); }}
.svg .grid {{ stroke: var(--line); stroke-width: 1; }}
.svg .tick {{ fill: var(--ink-4); font-size: 11px; font-variant-numeric: tabular-nums; }}
.svg .lab {{ fill: var(--ink-1); font-size: 13px; font-family: var(--mono); }}
.svg .val {{ fill: var(--ink-2); font-size: 12px; font-family: var(--mono); }}
.svg .seglab {{ fill: var(--bg); font-size: 11px; font-family: var(--mono); pointer-events: none; }}
.svg .seg.win {{ fill: var(--s-after); }} .svg .seg.trie {{ fill: var(--s-before); }} .svg .seg.other {{ fill: var(--s-other); }}
.svg .seg:hover {{ filter: brightness(1.15); }}
.figscroll {{ overflow-x: auto; min-width: 0; }} .figscroll .svg {{ min-width: 620px; }}
/* HTML bars */
.rows {{ display: grid; gap: 14px; }}
.group {{ display: grid; grid-template-columns: 120px 1fr; gap: 12px; align-items: center; }}
.group .lab {{ font-size: 13px; color: var(--ink-1); font-weight: 600; line-height: 1.25; }}
.group .lab small {{ display: block; font-weight: 400; color: var(--ink-3); font-size: 11.5px; }}
.pair {{ display: grid; gap: 3px; }}
.bar-row {{ position: relative; display: grid; grid-template-columns: 92px 1fr 56px; gap: 8px; align-items: center; cursor: default; }}
.blab {{ font-size: 11.5px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
.track {{ position: relative; height: 11px; }}
.fill {{ position: absolute; left: 0; top: 0; bottom: 0; border-radius: 0 4px 4px 0; min-width: 2px; }}
.fill.trie {{ background: var(--s-before); }} .fill.win {{ background: var(--s-after); }} .fill.other {{ background: var(--s-other); }}
.val {{ font-size: 12.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; text-align: right; font-family: var(--mono); }}
.tip {{ position: absolute; left: 100px; bottom: calc(100% + 6px); z-index: 3; background: var(--raise); color: var(--ink-1); border: 1px solid var(--line-strong); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; line-height: 1.4; white-space: nowrap; pointer-events: none; opacity: 0; transform: translateY(3px); transition: opacity .12s, transform .12s; box-shadow: 0 8px 24px rgba(0,0,0,.25); }}
.bar-row:hover .tip, .bar-row:focus-visible .tip {{ opacity: 1; transform: none; }}
.bar-row:hover .fill, .bar-row:focus-visible .fill {{ filter: brightness(1.12); }}
.plot {{ position: relative; }}
.gridlines {{ position: absolute; inset: 0 64px 0 232px; pointer-events: none; }}
.gridlines b {{ position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line); }}
.axis {{ display: grid; grid-template-columns: 232px 1fr; }}
.axis .ticks {{ position: relative; height: 16px; margin-right: 64px; font-size: 11px; color: var(--ink-4); font-variant-numeric: tabular-nums; }}
.axis .ticks span {{ position: absolute; transform: translateX(-50%); }}
.axis .ticks span:first-child {{ transform: none; }} .axis .ticks span:last-child {{ transform: translateX(-100%); }}
.group.wide .bar-row {{ grid-template-columns: 170px 1fr 56px; }} .plot.wide .gridlines {{ inset: 0 64px 0 310px; }} .axis.wide {{ grid-template-columns: 310px 1fr; }}
.first .bar-row {{ grid-template-columns: 56px 1fr 56px; }} .first .tip {{ left: 64px; }}
@media (max-width: 620px) {{
  .group {{ grid-template-columns: 1fr; gap: 6px; }} .gridlines {{ display: none; }}
  .axis {{ grid-template-columns: 100px 1fr; }} .axis.wide {{ grid-template-columns: 178px 1fr; }}
  .bar-row {{ grid-template-columns: 84px 1fr 52px; }} .group.wide .bar-row {{ grid-template-columns: 162px 1fr 52px; }}
}}
/* two columns */
.cols {{ display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }}
@media (max-width: 760px) {{ .cols {{ grid-template-columns: 1fr; }} }}
.said {{ font-size: 18px; color: var(--ink-1); }} .said .q {{ color: var(--ink-4); }}
.line-out {{ font-family: var(--mono); font-size: 14px; }} .line-out.trie {{ color: var(--s-before); }} .line-out.win {{ color: var(--s-after); }}
/* search pops */
ol.pops {{ list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; max-width: none; counter-reset: pop; }}
ol.pops li {{ counter-increment: pop; background: var(--neutral-tint); border: 1px solid var(--line); border-radius: 8px; padding: 3px 9px; font-size: 12.5px; }}
ol.pops li::before {{ content: counter(pop); color: var(--ink-4); font-size: 10.5px; margin-right: 6px; font-family: var(--mono); }}
ol.pops li.done {{ border-color: var(--s-after); background: var(--accent-tint); color: var(--ink-1); }}
ol.pops li.done small {{ display: block; color: var(--ink-3); font-size: 11px; }}
ol.pops li.after {{ border-style: dashed; }}
.dim {{ color: var(--ink-4); }}
.gate-row {{ display: grid; gap: 3px; }} .gate-row .glab {{ font-size: 13px; color: var(--ink-1); font-weight: 600; }}
.fill.hatch {{ background-image: repeating-linear-gradient(135deg, transparent 0 3px, var(--surface) 3px 5px); }}
/* tiles */
.tiles {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }}
.tile {{ background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: grid; gap: 4px; }}
.tile .k {{ font-size: 12px; color: var(--ink-3); font-family: var(--mono); }} .tile .v {{ font-size: 26px; color: var(--ink-1); font-weight: 600; font-variant-numeric: tabular-nums; }}
.tile .v small {{ font-size: 13px; color: var(--ink-3); font-weight: 400; }} .tile .s {{ font-size: 12.5px; color: var(--ink-3); }}
/* tables */
details.table {{ border-top: 1px solid var(--line); padding-top: 10px; }}
details.table summary {{ cursor: pointer; font-size: 13px; color: var(--ink-2); font-weight: 500; }}
.scroll {{ overflow-x: auto; min-width: 0; }}
table {{ border-collapse: collapse; width: 100%; font-size: 13.5px; font-variant-numeric: tabular-nums; }}
th, td {{ text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }}
th {{ font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); font-weight: 600; }}
td.n {{ text-align: right; font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }}
td strong {{ color: var(--ink-1); font-weight: 600; }}
ul.lessons {{ display: grid; gap: 10px; padding-left: 20px; }}
ul.lessons b {{ color: var(--ink-1); font-weight: 600; }}
</style>
</head>
<body>
<main class="wrap">
<header>
  <div class="eyebrow">OpenATC · voice model · decoding</div>
  <h1>Choosing the aircraft by likelihood, not one token at a time</h1>
  <p class="lede">The 2M-parameter voice model turns the game state and a transcript into a command line. It used to pick the callsign greedily, token by token, through a trie of the callsigns in the state. Now every callsign is scored by its full likelihood and the best one wins, found by an exact best-first search that costs one or two extra model steps.</p>
  <div class="headline">
    <div class="big"><span class="from">{pct(1 - sw["trie"]["exact"])}</span><span class="arrow">→</span>{pct(1 - shp["exact"])}</div>
    <p>Commands wrong at <b>Sydney</b>, an airport the model never saw ({SHIP_M}, the model the game ships; n = 1000). Callsign accuracy there went from {pct(sw["trie"]["callsign"])} to {pct(shp["callsign"])}. Same weights, no retraining: only the decoder changed.</p>
  </div>
  <div class="meta"><span>n = 1000 per set, paired rows, exact McNemar</span><span>both checkpoints (2m-swap-v1, 2m-grpo-v1)</span><span>browser engine: <code>src/lib/voice/s1.ts</code></span><span>write-up: <code>ml/s1/CALLSIGN_SCORING.md</code></span></div>
</header>

<section aria-labelledby="h-fail">
  <div class="eyebrow">The failure</div>
  <h2 id="h-fail">Greedy decoding commits to the airline before it reads the digits</h2>
  <p>A real Sydney row, decoded by 2m-swap-v1. The controller only said the flight number. The decoder's first token must be one of the callsigns' first tokens, and greedy picks the most likely one. At Sydney that is Qantas: most traffic is <code>QFA</code>, so the model's prior for <code>QFA</code> is high before any digit has been considered. Once <code>QFA</code> is chosen, the best the digits can do is <code>QFA71</code>, and the trie then stops constraining (a complete callsign), so the model carried on to <code>QFA717</code>, an aircraft that is not in the state.</p>
  <div class="cols">
    <div class="card">
      <div class="said"><span class="q">“</span>{e(EX["said"]) if EX else ""}<span class="q">”</span></div>
      <div class="note">Greedy trie: <span class="line-out trie">{e(EX["trie"]) if EX else ""}</span><br>Likelihood: <span class="line-out win">{e(EX["scored"]) if EX else ""}</span> (gold <code>{e(EX["gold"]) if EX else ""}</code>)</div>
      <h3>Step 1 of the greedy trie: p(first token), among the allowed ones</h3>
      <div class="rows first" style="gap:4px">{fig_first()}</div>
    </div>
    <div class="card">
      <h3>The state: {len(EX["callsigns"]) if EX else 0} aircraft</h3>
      <p class="note mono" style="line-height:1.9">{" · ".join(e(c) for c in EX["callsigns"]) if EX else ""}</p>
      <p class="note">The digits 5-2-7 point straight at <code>VOZ527</code>. The trie never asks, because by the time it reads digits it has already spent its one choice on the airline.</p>
    </div>
  </div>
  <div class="card">
    <div class="chart-head"><h3>What each candidate costs, token by token</h3>
      <div class="legend" aria-hidden="true"><span><i style="background:var(--s-after)"></i>gold, picked by likelihood</span><span><i style="background:var(--s-before)"></i>the trie's path</span><span><i style="background:var(--s-other)"></i>other candidates</span></div></div>
    <div class="figscroll">{fig_costs()}</div>
    <p class="note">Each segment is one token's − log probability (hover for the number); the last one, “␣”, is the word boundary: the probability that the callsign ends there. <code>QFA</code> is cheap (1.2 nats) but its digits cost 15 and 13 nats; <code>VOZ</code> is expensive (5.9 nats) and then every digit is free. Summed over the whole callsign, the gold one wins by 32 nats.</p>
  </div>
</section>

<section aria-labelledby="h-how">
  <div class="eyebrow">The decoder</div>
  <h2 id="h-how">Score the whole callsign, and search for the best one exactly</h2>
  <p><b>Score.</b> score(callsign) = Σ log p(token) over <code>" VOZ527"</code> + log p(word boundary after it). The boundary is any token that starts with a space, or <code>&lt;eos&gt;</code>. Without it <code>UAL12</code> would always beat <code>UAL123</code>, because a shorter prefix has fewer tokens to pay for. The shipped score is length-normalised: divided by (tokens + 1). It ties the plain sum on validation and Sydney, and wins on real recognisers, where the sum over-prefers the 2-token <code>SAY AGAIN</code> (table below).</p>
  <p><b>Search.</b> Scoring all ~14 candidates of a state means ~47 model steps (shared prefixes counted once) against ~4 for the greedy path. But log-probabilities are ≤ 0, so a prefix's score is an upper bound on every callsign below it. A max-queue over the trie can therefore stop at the first complete callsign it pops: nothing left can beat it. That is best-first search, A* when length-normalised (bound: prefix log-prob ÷ (longest callsign below it + 1)). It returns exactly the full-scoring argmax: same pick on all 6,000 eval rows.</p>
  <div class="card">
    <h3>The search on this row, in pop order (bound = log-prob per token, higher first)</h3>
    <ol class="pops">{search_list()}</ol>
    <p class="note">{EX["steps"] if EX else ""} model steps. The first {sum(1 for p in EX["pops"][:next(i for i, p in enumerate(EX["pops"]) if p["kind"] == "complete")] if p["kind"] == "prefix") if EX else ""} find the answer (the airlines the prior likes are tried first; one step each shows that the next digit does not fit). The dashed ones look for the runner-up, for the verifier's margin signal; that phase gets at most 4 steps, then the margin is reported as best minus the highest bound left ({EX["margin"]:.2f} here) — a lower bound, never an over-estimate.</p>
  </div>
  <p>In the browser the KV cache is branched per trie node: each stepped node's keys and values (4 layers × 2 × 192 floats) are saved, and before a node is stepped its ancestors' are copied back into positions P, P+1, … of the one preallocated cache. The arithmetic is the same <code>step()</code> as before, so the result is identical to a straight decode of that callsign.</p>
</section>

<section aria-labelledby="h-res">
  <div class="eyebrow">Results</div>
  <h2 id="h-res">Fewer wrong commands on every set, for both checkpoints</h2>
  <div class="card">
    <div class="chart-head"><h3>Commands wrong (exact match), n = 1000 per bar</h3>
      <div class="legend" aria-hidden="true"><span><i style="background:var(--s-before)"></i>greedy trie</span><span><i style="background:var(--s-after)"></i>likelihood (shipped decoder)</span></div></div>
    {fig_errors()}
    <p class="note">Same rows as every S1 eval (ml/rl/common.py eval_sets): validation and Sydney picked as ml/s1/train.py picks them, and 1,000 real speech-to-text transcripts. Rows paired, exact two-sided McNemar.</p>
    <details class="table"><summary>All variants as a table (exact / callsign)</summary><div class="scroll"><table>
      <thead><tr><th>Model</th><th>Set</th><th style="text-align:right">Greedy trie</th><th style="text-align:right">Sum, no boundary</th><th style="text-align:right">Sum</th><th style="text-align:right">Length-normalised</th><th style="text-align:right">Shipped decoder</th><th style="text-align:right">vs trie (fixed −broken)</th><th style="text-align:right">Say again missed / false</th></tr></thead>
      <tbody>{table_acc()}</tbody></table></div></details>
  </div>
  <p>Where it helps: callsign errors nearly vanish on validation and Sydney (≥ 99.4% right). On real recognisers the remaining errors are mostly in the instruction (a mis-heard number), which this change does not touch. The rows it breaks there are mostly <code>SAY AGAIN</code> answers to badly garbled transcripts, a safe failure: the player repeats the call.</p>
</section>

<section aria-labelledby="h-cost">
  <div class="eyebrow">Cost</div>
  <h2 id="h-cost">One or two extra model steps per command</h2>
  <div class="card">
    <h3>Model steps per command, after the transcript ({SHIP_M})</h3>
    {fig_cost()}
    <p class="note">A step is one token through the network at ~350 tokens of context. “Every candidate” counts shared prefixes once (a trie); beam search keeps the 4 best prefixes per depth. The shipped count includes the runner-up phase (≤ 4 steps) and the instruction tokens.</p>
  </div>
  <div class="tiles">{lat_tiles()}</div>
  <p class="note">Added complete() time in node (the browser engine, one thread), same rows decoded both ways in one process, on a shared 8-core host under load; absolute times on a desktop browser are lower. A search that would need more than 48 steps falls back to the greedy trie (bounded worst case).</p>
</section>

<section aria-labelledby="h-ver">
  <div class="eyebrow">Verifier</div>
  <h2 id="h-ver">The gate was refitted on the new decoder's signals</h2>
  <p>The decoder's per-token signals feed the verifier that decides send / check / say again. They are now taken along the chosen callsign's path (the trie margin can be negative when the likelihood overrules the greedy choice), and two are new: the chosen callsign's log-likelihood and its margin over the runner-up. The gate was refitted per model with <code>ml/verify/refit.sh</code>.</p>
  <p><b>A bug surfaced on the way.</b> <code>ml/verify/fit.py</code> reused the names <code>mu, sd</code> for the S1-trunk experiment, so the exported gate carried the 384 hidden-state means and deviations instead of its 28–30 feature statistics. The game standardised every feature with the wrong numbers: the gate that ran sent far more wrong commands than the report said. Fixed, and fit.py now asserts that the exported gate reproduces the fitted one. To separate the two effects, the greedy-trie decoder also got a correctly exported gate (middle row).</p>
  <div class="card"><h3>What the gate does with the model's proposals</h3>{fig_gate()}</div>
  {f"""<div class="card"><div class="scroll"><table>
    <thead><tr><th>Model</th><th>Set</th><th style="text-align:right">Rules failed</th><th style="text-align:right">Model + fusion right</th><th style="text-align:right">Sent and right</th><th style="text-align:right">Sent wrong</th><th style="text-align:right">Say again</th></tr></thead>
    <tbody>{vr}</tbody></table></div>
    <p class="note">Columns with arrows: greedy trie + gate as it ran → greedy trie + correctly exported gate (– where not fitted) → <strong>likelihood decoder + refitted gate</strong>. Same transcripts and rules parser (ml/s1/callsign_gate.py). Population: transcripts the rules could not parse. “Sent and right”: auto-sent and equal to the gold command, as a share of those transcripts; the rest are left in the bar (check) or answered with say again. Each gate is tuned for at most ~1% of auto-sent commands wrong on its training-session dev fold.</p></div>""" if vr else '<p class="note">Refit pending: see ml/verify/RESULTS.md.</p>'}
</section>

<section aria-labelledby="h-par">
  <div class="eyebrow">Parity</div>
  <h2 id="h-par">The browser decodes what PyTorch decodes</h2>
  <ul class="lessons">
    <li>{par or "PyTorch reference: pending"}.</li>
    <li>Verifier parity (<code>ml/verify/parity.cjs</code>, s1.ts vs <code>ml/verify/gen.py</code>): {", ".join(vpar) or "pending"}.</li>
    <li>The greedy trie is kept as <code>callsignMode = 'trie'</code>: token-for-token and confidence identical to the previously committed engine ({", ".join(trie_same) or "pending"}).</li>
  </ul>
</section>

<section aria-labelledby="h-learn">
  <div class="eyebrow">For an AI engineer</div>
  <h2 id="h-learn">What this teaches</h2>
  <ul class="lessons">
    <li><b>Greedy is a search with a horizon of one token.</b> Constrained decoding (grammars, JSON schemas, here a callsign trie) masks invalid tokens but still commits token by token. When the evidence comes late in the sequence, score whole sequences.</li>
    <li><b>A prior on the first token is how this fails.</b> The model knew <code>VOZ527</code> fit the digits; the decoder never asked. Accuracy went up 7 points at Sydney without touching the weights.</li>
    <li><b>Compare sequences fairly.</b> Sum of log-probs favours short candidates. A boundary term makes prefixes compete (<code>UAL12</code> vs <code>UAL123</code>); length normalisation removes the bias towards the 2-token <code>SAY AGAIN</code>.</li>
    <li><b>Bounds make exact search cheap.</b> Log-probs only fall as a sequence grows, so best-first / A* returns the exact argmax after a handful of steps when the model is confident. Beam search would cost twice as much and is only approximate.</li>
    <li><b>Change the decoder, refit what reads it.</b> The verifier was fitted on the old decoder's signals; new decoder, new distributions, new gate.</li>
    <li><b>The idea came from the diffusion experiment</b> (<a href="voice-diffusion.html">voice-diffusion</a>), where scoring every callsign by likelihood lifted the diffusion model's Sydney callsign accuracy from 91.9% to 99.1%. It carries over to the autoregressive model unchanged.</li>
  </ul>
</section>
<p class="note">Reproduce: <code>ml/s1/callsign_scoring.py</code> (variants, n = 1000 × 3 sets), <code>ml/s1/callsign_e2e.py</code> (shipped decoder end to end), <code>ml/s1/callsign_report.py</code>, <code>ml/s1/callsign_example.py</code>, <code>node ml/s1/callsign_latency.cjs</code>, <code>ml/verify/refit.sh</code>; this page: <code>python3 ml/s1/build_callsign_report.py</code>.</p>
</main>
</body>
</html>
'''
    OUT.write_text(doc)
    print(f"wrote {OUT} ({len(doc)} bytes)")


if __name__ == "__main__":
    main()

"""Build public/reports/voice-rl.html (standalone: inline CSS + SVG, no scripts) and print the numbers for RESULTS.md.

    python3 ml/rl/report.py
"""
import html, json, math
from collections import Counter
from common import *  # noqa: F403
import rewards as R

RUNS = [("baseline", "Start model", "--c0"), ("grpo-exact", "GRPO · exact", "--c1"), ("grpo-shaped", "GRPO · shaped", "--c2"),
        ("grpo-verifier", "GRPO · verifier", "--c3"), ("sft-control", "SFT control", "--c4")]
SETS = [("val", "Val", "known airports"), ("sydney", "Sydney", "unseen airport"), ("stt", "Real STT", "5 recognisers")]
RD = ROOT / "ml/rl/runs"
NOTES = {}   # filled at the bottom of this file once the numbers are in
esc = html.escape


def load(name):
    f = RD / name / "eval_full.json"
    return json.load(open(f)) if f.exists() else None


def metrics(name):
    f = RD / name / "metrics.jsonl"
    if not f.exists():
        return [], []
    rows = [json.loads(l) for l in open(f)]
    return [r for r in rows if "val" not in r], [r for r in rows if "val" in r]


def mcnemar_p(b, c):
    """Exact two-sided McNemar on discordant pairs (b fixed, c broken)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def pfmt(p):
    return "p<0.001" if p < 0.001 else f"p={p:.2f}" if p >= 0.01 else f"p={p:.3f}"


def ci(p, n):
    return 1.96 * math.sqrt(max(p * (1 - p), 1e-9) / n)


# ------------------------------------------------------------------ svg helpers
def line_chart(series, title, ylab, x_max=None, y_min=None, y_max=None, w=440, h=210, fmt="{:.2f}", note=""):
    pad_l, pad_r, pad_t, pad_b = 44, 12, 12, 30
    pts = [p for _, _, s in series for p in s]
    if not pts:
        return ""
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    x0, x1 = 0, x_max or max(xs) or 1
    lo = min(ys) if y_min is None else y_min; hi = max(ys) if y_max is None else y_max
    if hi - lo < 1e-9:
        hi = lo + 1
    X = lambda x: pad_l + (x - x0) / (x1 - x0) * (w - pad_l - pad_r)
    Y = lambda y: pad_t + (1 - (y - lo) / (hi - lo)) * (h - pad_t - pad_b)
    g = [f'<svg viewBox="0 0 {w} {h}" class="lc" role="img" aria-label="{esc(title)}">']
    for i in range(5):
        v = lo + (hi - lo) * i / 4
        g.append(f'<line x1="{pad_l}" x2="{w - pad_r}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="grid"/><text x="{pad_l - 6}" y="{Y(v) + 4:.1f}" class="tick" text-anchor="end">{fmt.format(v)}</text>')
    for i in range(5):
        v = x0 + (x1 - x0) * i / 4
        g.append(f'<text x="{X(v):.1f}" y="{h - 10}" class="tick" text-anchor="middle">{v / 60:.0f}</text>')
    g.append(f'<text x="{w - pad_r}" y="{h - 10}" class="tick" text-anchor="end" dy="0">{"" if True else ""}</text>')
    for name, color, s in series:
        if not s:
            continue
        d = " ".join(f"{'M' if i == 0 else 'L'}{X(x):.1f},{Y(y):.1f}" for i, (x, y) in enumerate(s))
        g.append(f'<path d="{d}" fill="none" stroke="var({color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>')
        if len(s) <= 40:
            for x, y in s:
                g.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="3.2" fill="var({color})" stroke="var(--surface)" stroke-width="1.5"><title>{esc(name)}: {fmt.format(y)} at {x / 60:.0f} CPU-min</title></circle>')
    g.append("</svg>")
    return f'<figure class="chart small"><figcaption><b>{esc(title)}</b><span>{esc(ylab)} · x = training CPU-minutes</span></figcaption>{"".join(g)}{f"<p class=note>{note}</p>" if note else ""}</figure>'


def ema(rows, key, a=0.15):
    out, m = [], None
    for r in rows:
        v = r[key]; m = v if m is None else (1 - a) * m + a * v
        out.append((r["cpu_s"], m))
    return out[::max(1, len(out) // 120)]


def legend(runs):
    return '<div class="legend">' + "".join(f'<span><i style="background:var({c})"></i>{esc(l)}</span>' for n, l, c in runs) + "</div>"


def bars(res, base):
    out = []
    for key, lab, sub in SETS:
        rows = []
        for n, l, c in RUNS:
            if not res.get(n):
                continue
            s = res[n]["scores"][key]; p = s["exact"]; e = ci(p, s["n"])
            extra = ""
            if n != "baseline" and base:
                fx, br = paired(base, res[n], key)
                extra = f" · fixed {fx}, broke {br}, McNemar {pfmt(mcnemar_p(fx, br))}"
            lo, hi = 60, 100
            wpct = max(0, (p * 100 - lo) / (hi - lo) * 100)
            el = max(0, (p - e) * 100 - lo) / (hi - lo) * 100; er = min(100, ((p + e) * 100 - lo) / (hi - lo) * 100)
            rows.append(f'<div class="bar-row" tabindex="0"><div class="track"><div class="fill" style="width:{wpct:.1f}%;background:var({c})"></div>'
                        f'<div class="err" style="left:{el:.1f}%;width:{max(0, er - el):.1f}%"></div></div><div class="val">{p * 100:.1f}</div>'
                        f'<div class="tip">{esc(l)}: {p * 100:.1f}% exact ±{e * 100:.1f} (95% CI), callsign {s["callsign"] * 100:.1f}%, n={s["n"]}{extra}</div></div>')
        out.append(f'<div class="group"><div class="lab">{lab}<small>{sub} · n={res["baseline"]["scores"][key]["n"]}</small></div><div class="pair">{"".join(rows)}</div></div>')
    ticks = "".join(f"<span style='left:{(v - 60) / 40 * 100:.0f}%'>{v}</span>" for v in (60, 70, 80, 90, 100))
    return f'<div class="rows">{"".join(out)}</div><div class="axis"><div></div><div class="ticks">{ticks}</div></div>'


def paired(base, run, key):
    S = EVAL[key]
    fx = br = 0
    for (p, t, ex), b, r in zip(S, base["preds"][key], run["preds"][key]):
        g = norm_line(ex["line"])
        fx += b != g and r == g; br += b == g and r != g
    return fx, br


def diff_examples(base, run, key, want, k=6):
    S = EVAL[key]; out = []
    for (p, t, ex), b, r in zip(S, base["preds"][key], run["preds"][key]):
        g = norm_line(ex["line"])
        if (want == "fixed" and b != g and r == g) or (want == "broken" and b == g and r != g):
            out.append((ex["said"], g, b, r))
    return out[:k]


def radio(rows, tag):
    if not rows:
        return '<p class="note">none</p>'
    h = []
    for said, gold, before, after in rows:
        h.append(f'<div class="tx"><div class="who">{tag}</div><div class="said">“{esc(said)}”</div>'
                 f'<div class="line"><em>label</em> {esc(gold)}</div><div class="line b"><em>before</em> {esc(before)}</div><div class="line a"><em>after</em> {esc(after)}</div></div>')
    return '<div class="radio">' + "".join(h) + "</div>"


DIAGRAM = """
<svg viewBox="0 0 900 300" class="diagram" role="img" aria-label="GRPO loop: policy samples a group, the engine scores it, advantages update the policy, a KL leash ties it to the frozen reference">
<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="var(--ink-3)"/></marker></defs>
<g class="box key"><rect x="20" y="40" width="170" height="92" rx="12"/><text x="105" y="70" class="t">Policy π</text><text x="105" y="92" class="s">S1 2 M, being trained</text><text x="105" y="110" class="s">state + transcript → line</text></g>
<g class="box"><rect x="250" y="20" width="190" height="132" rx="12"/><text x="345" y="46" class="t">Group of k = 8</text>
<text x="345" y="70" class="m">UPS973 Fly heading 102</text><text x="345" y="88" class="m">UPS973 Fly heading 102</text><text x="345" y="106" class="m">BAW963 Fly heading 102</text><text x="345" y="124" class="m">UPS973 Speed 102 …</text><text x="345" y="142" class="s">T = 1, callsign trie on</text></g>
<g class="box"><rect x="500" y="20" width="170" height="132" rx="12"/><text x="585" y="46" class="t">Game engine</text><text x="585" y="68" class="s">parseCommand → AST</text><text x="585" y="86" class="s">transmission → words</text><text x="585" y="112" class="m">r = 1, 1, 0, 0.3 …</text><text x="585" y="136" class="s">exact · shaped · verifier</text></g>
<g class="box"><rect x="730" y="20" width="150" height="132" rx="12"/><text x="805" y="46" class="t">Advantage</text><text x="805" y="72" class="m">A = (r − mean)</text><text x="805" y="90" class="m">/ (std + ε)</text><text x="805" y="114" class="s">better than its own</text><text x="805" y="130" class="s">group → positive</text></g>
<g class="box"><rect x="430" y="196" width="300" height="78" rx="12"/><text x="580" y="222" class="t">Clipped update</text><text x="580" y="244" class="m">min(ρA, clip(ρ, 0.8, 1.2)A) − β·KL</text><text x="580" y="262" class="s">ρ = π / π_old, 2 passes per batch</text></g>
<g class="box ref"><rect x="20" y="196" width="170" height="78" rx="12"/><text x="105" y="224" class="t">Reference</text><text x="105" y="246" class="s">frozen copy of the start</text><text x="105" y="262" class="s">model</text></g>
<path d="M190,86 L248,86" class="ln" marker-end="url(#ar)"/><path d="M440,86 L498,86" class="ln" marker-end="url(#ar)"/><path d="M670,86 L728,86" class="ln" marker-end="url(#ar)"/>
<path d="M805,152 L805,235 L732,235" class="ln" marker-end="url(#ar)"/><path d="M430,235 L300,235 L300,110 L192,110" class="ln" marker-end="url(#ar)"/>
<path d="M105,194 L105,134" class="ln dash" marker-end="url(#ar)"/><text x="116" y="170" class="s" text-anchor="start">KL leash</text>
<text x="305" y="180" class="s" text-anchor="start">new weights</text>
</svg>"""

CSS = """
:root {
  --bg: #0e0f11; --surface: #141416; --raise: #1c1c1e; --line: rgba(255,255,255,.09); --line-strong: rgba(255,255,255,.16);
  --ink-1: #f4f4f5; --ink-2: #c4c5c8; --ink-3: #a0a1a6; --ink-4: #7f8086;
  --accent: #f5933f; --accent-tint: rgba(245,147,63,.14); --good: #57cd50; --good-tint: rgba(87,205,80,.13); --bad: #e66767; --neutral-tint: rgba(255,255,255,.07);
  --c0: #8a8b90; --c1: #3987e5; --c2: #d95926; --c3: #199e70; --c4: #c98500;
  --font: "DM Sans", "Helvetica Neue", Arial, sans-serif; --mono: "DM Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12); --good: #23862b; --good-tint: rgba(35,134,43,.12); --bad: #c03a39; --neutral-tint: rgba(20,20,24,.06);
  --c0: #8f8e89; --c1: #2a78d6; --c2: #eb6834; --c3: #1baf7a; --c4: #eda100;
  color-scheme: light;
} }
:root[data-theme="light"] {
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12); --good: #23862b; --good-tint: rgba(35,134,43,.12); --bad: #c03a39; --neutral-tint: rgba(20,20,24,.06);
  --c0: #8f8e89; --c1: #2a78d6; --c2: #eb6834; --c3: #1baf7a; --c4: #eda100;
  color-scheme: light;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink-2); font-family: var(--font); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased;
  padding: 40px max(16px, env(safe-area-inset-right, 0px)) 72px max(16px, env(safe-area-inset-left, 0px)); }
.wrap { max-width: 960px; margin: 0 auto; display: grid; gap: 52px; }
h1, h2, h3 { color: var(--ink-1); margin: 0; font-weight: 600; letter-spacing: -.01em; text-wrap: balance; }
h1 { font-size: clamp(28px, 4.4vw, 40px); line-height: 1.12; } h2 { font-size: 22px; line-height: 1.25; } h3 { font-size: 15px; }
p { margin: 0; max-width: 70ch; }
code, .mono { font-family: var(--mono); font-size: .9em; }
a { color: var(--accent); }
.eyebrow { font-size: 11.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
section { display: grid; gap: 16px; min-width: 0; }
header { display: grid; gap: 14px; }
.lede { font-size: 17px; max-width: 64ch; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--ink-3); font-size: 13px; }
.headline { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; display: grid; gap: 4px; }
.stat .k { font-size: 12px; color: var(--ink-3); letter-spacing: .04em; }
.stat .v { font-size: 34px; color: var(--ink-1); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.02em; line-height: 1.1; }
.stat .v small { font-size: 15px; color: var(--ink-3); font-weight: 500; }
.stat .d { font-size: 13px; color: var(--ink-3); }
.verdict { padding: 14px 18px; border-left: 3px solid var(--accent); background: var(--accent-tint); border-radius: 0 12px 12px 0; color: var(--ink-1); max-width: none; }
.terms { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.term { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; font-size: 13.5px; line-height: 1.5; }
.term b { color: var(--ink-1); display: block; margin-bottom: 2px; }
.diagram { width: 100%; height: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 8px; }
.diagram .box rect { fill: var(--raise); stroke: var(--line-strong); }
.diagram .box.key rect { stroke: var(--accent); fill: var(--accent-tint); }
.diagram .box.ref rect { stroke-dasharray: 5 4; }
.diagram .t { fill: var(--ink-1); font: 600 15px var(--font); text-anchor: middle; }
.diagram .s { fill: var(--ink-3); font: 12px var(--font); text-anchor: middle; }
.diagram .m { fill: var(--ink-2); font: 11.5px var(--mono); text-anchor: middle; }
.diagram .ln { stroke: var(--ink-3); stroke-width: 1.6; fill: none; } .diagram .ln.dash { stroke-dasharray: 5 4; }
.chart { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 18px 18px 12px; display: grid; gap: 14px; min-width: 0; margin: 0; }
.chart-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 20px; align-items: baseline; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 7px; }
.legend i { width: 12px; height: 8px; border-radius: 2px; display: inline-block; }
.rows { display: grid; gap: 18px; }
.group { display: grid; grid-template-columns: 110px 1fr; gap: 12px; align-items: center; }
.group .lab { font-size: 13px; color: var(--ink-1); font-weight: 600; line-height: 1.25; }
.group .lab small { display: block; font-weight: 400; color: var(--ink-3); font-size: 11.5px; }
.pair { display: grid; gap: 3px; }
.bar-row { position: relative; display: grid; grid-template-columns: 1fr 52px; gap: 8px; align-items: center; }
.track { position: relative; height: 11px; }
.fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 0 4px 4px 0; min-width: 2px; }
.err { position: absolute; top: 4px; height: 3px; background: var(--ink-1); opacity: .35; border-radius: 2px; }
.val { font-size: 12.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; text-align: right; font-family: var(--mono); }
.tip { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 3; background: var(--raise); color: var(--ink-1); border: 1px solid var(--line-strong); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .12s; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
.bar-row:hover .tip, .bar-row:focus-visible .tip { opacity: 1; }
.axis { display: grid; grid-template-columns: 110px 1fr; gap: 12px; }
.axis .ticks { position: relative; height: 16px; margin-right: 60px; font-size: 11px; color: var(--ink-4); }
.axis .ticks span { position: absolute; transform: translateX(-50%); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.chart.small { padding: 14px 14px 8px; gap: 6px; }
.chart.small figcaption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; font-size: 13px; color: var(--ink-3); }
.chart.small figcaption b { color: var(--ink-1); font-weight: 600; }
.lc { width: 100%; height: auto; }
.lc .grid { stroke: var(--line); } .lc .tick { fill: var(--ink-4); font: 10.5px var(--font); }
.note { font-size: 13px; color: var(--ink-3); }
.radio { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 4px 0; }
.tx { display: grid; grid-template-columns: 70px 1fr; gap: 2px 14px; padding: 11px 18px; border-bottom: 1px solid var(--line); }
.tx:last-child { border-bottom: 0; }
.who { font-size: 10.5px; letter-spacing: .1em; font-weight: 600; color: var(--ink-3); padding-top: 3px; text-transform: uppercase; }
.said { color: var(--ink-1); overflow-wrap: anywhere; }
.line { grid-column: 2; font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); overflow-wrap: anywhere; }
.line em { font-style: normal; color: var(--ink-4); font-family: var(--font); font-size: 11.5px; display: inline-block; width: 52px; }
.line.a { color: var(--good); } .line.bad { color: var(--bad); }
.scroll { overflow-x: auto; min-width: 0; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); font-weight: 600; }
td.n { text-align: right; font-family: var(--mono); font-size: 12.5px; }
td strong { color: var(--ink-1); }
i.sw { display: inline-block; width: 10px; height: 8px; border-radius: 2px; margin-right: 7px; }
ul.plain { margin: 0; padding-left: 18px; display: grid; gap: 6px; max-width: 72ch; }
@media (max-width: 620px) { .group, .axis { grid-template-columns: 1fr; } .axis > div:first-child { display: none; } .tip { white-space: normal; width: 260px; } }
"""


def main():
    global EVAL
    tok = BPE.load(TOK)
    EVAL = eval_sets(tok, 1000)
    res = {n: load(n) for n, _, _ in RUNS}
    base = res["baseline"]
    mt = {n: metrics(n) for n, _, _ in RUNS[1:]}
    done = {n: json.load(open(RD / n / "done.json")) if (RD / n / "done.json").exists() else {} for n, _, _ in RUNS[1:]}
    stats = json.load(open(RD / "hard.stats.json")) if (RD / "hard.stats.json").exists() else {}
    grpo = [r for r in RUNS[1:4] if mt[r[0]][0]]

    # --- numbers table (also printed for RESULTS.md)
    table = []
    for n, l, c in RUNS:
        if not res.get(n):
            continue
        row = [l]
        for key, _, _ in SETS:
            s = res[n]["scores"][key]
            cell = f"{s['exact'] * 100:.1f} / {s['callsign'] * 100:.1f}"
            if n != "baseline":
                fx, br = paired(base, res[n], key); cell += f"  (+{fx} −{br}, {pfmt(mcnemar_p(fx, br))})"
            row.append(cell)
        d = done.get(n, {})
        row.append(f"{d.get('cpu_s', 0) / 60:.0f}" if d else "—")
        table.append(row)
    print("| run | val exact/callsign | Sydney | real STT | train CPU-min |\n|---|---|---|---|---|")
    for r in table:
        print("| " + " | ".join(r) + " |")

    # --- error types per run and set
    def kinds(n, key):
        c = Counter()
        for (p, t, ex), pred in zip(EVAL[key], res[n]["preds"][key]):
            g = norm_line(ex["line"])
            if pred == g:
                continue
            c["false SAY AGAIN" if pred == "SAY AGAIN" else "missed SAY AGAIN" if g == "SAY AGAIN" else "wrong aircraft" if pred.split()[:1] != g.split()[:1] else "wrong instruction"] += 1
        return c
    KINDS = ["wrong aircraft", "wrong instruction", "false SAY AGAIN", "missed SAY AGAIN"]
    err_rows = ""
    for key, lab, _ in SETS:
        for n, l, c in RUNS:
            if res.get(n):
                k = kinds(n, key)
                err_rows += f"<tr><td>{lab}</td><td><i class=sw style='background:var({c})'></i>{esc(l)}</td>" + "".join(f"<td class=n>{k[x]}</td>" for x in KINDS) + f"<td class=n><strong>{sum(k.values())}</strong></td></tr>"
    per_rec = ""
    recs = sorted({ex["src"] for _, _, ex in EVAL["stt"]})
    for n, l, c in RUNS:
        if res.get(n):
            hit = Counter(); cnt = Counter()
            for (p, t, ex), pred in zip(EVAL["stt"], res[n]["preds"]["stt"]):
                cnt[ex["src"]] += 1; hit[ex["src"]] += pred == norm_line(ex["line"])
            per_rec += f"<tr><td><i class=sw style='background:var({c})'></i>{esc(l)}</td>" + "".join(f"<td class=n>{hit[r] / cnt[r] * 100:.1f}</td>" for r in recs) + "</tr>"
    rec_head = "".join(f"<th>{esc(r.replace('stt:', ''))}</th>" for r in recs)
    hh = json.load(open(RD / "heldout_hard.json")) if (RD / "heldout_hard.json").exists() else {}
    hh_rows = ""
    for n, l, c in RUNS:
        key = n
        if key in hh:
            p = hh[key]["exact"]
            hh_rows += (f'<div class="bar-row" tabindex="0"><div class="track"><div class="fill" style="width:{p * 100:.1f}%;background:var({c})"></div></div><div class="val">{p * 100:.1f}</div>'
                        f'<div class="tip">{esc(l)}: {p * 100:.1f}% exact, callsign {hh[key]["callsign"] * 100:.1f}%, n={hh[key]["n"]}{" (SFT trained on these rows: not held out)" if n == "sft-control" else ""}</div></div>')
    vc = json.load(open(RD / "verifier_check.json")) if (RD / "verifier_check.json").exists() else {}

    # --- curves
    charts = []
    if grpo:
        charts.append(line_chart([(l, c, ema(mt[n][0], "reward_mean")) for n, l, c in grpo], "Mean reward of the samples", "smoothed, own reward scale", y_min=0, y_max=1))
        charts.append(line_chart([(l, c, ema(mt[n][0], "sample_exact")) for n, l, c in grpo], "Samples that are exactly right", "share of the k=8 samples, smoothed", y_min=0, y_max=1))
        charts.append(line_chart([(l, c, ema(mt[n][0], "kl")) for n, l, c in grpo], "KL to the reference", "per token, k3 estimate", y_min=0, fmt="{:.3f}"))
        charts.append(line_chart([(l, c, ema(mt[n][0], "entropy")) for n, l, c in grpo], "Sampling entropy", "nats per token", y_min=0, fmt="{:.2f}"))
        charts.append(line_chart([(l, c, ema(mt[n][0], "groups_with_signal")) for n, l, c in grpo], "Groups with any signal", "of 16 per step (all-equal rewards = no gradient)", y_min=0, y_max=16, fmt="{:.0f}"))
        charts.append(line_chart([(l, c, ema(mt[n][0], "len")) for n, l, c in grpo], "Completion length", "tokens; collapse to short lines would show here", y_min=0, fmt="{:.1f}"))
    evc = []
    for key, lab, sub in SETS:
        ser = [(l, c, [(e["cpu_s"], e[key]["exact"]) for e in mt[n][1]]) for n, l, c in RUNS[1:] if mt[n][1]]
        evc.append(line_chart(ser, f"{lab} exact during training", "fixed subset n=200", fmt="{:.2f}"))

    # --- hacking: high reward but wrong, from the logged groups
    hack_rows, hack_stats = [], []
    for n, l, c in grpo:
        f = RD / n / "examples.json"
        exs = json.load(open(f)) if f.exists() else []
        tot = hi_wrong = 0; picked = []; half = Counter()
        mid = max([g["step"] for g in exs] or [0]) / 2
        for g in exs:
            for s, r in zip(g["samples"], g["r"]):
                tot += 1
                wrong = norm_line(s) != norm_line(g["gold"])
                ph = "early" if g["step"] <= mid else "late"
                half[ph + "_n"] += 1
                if wrong and r >= 0.6:
                    hi_wrong += 1; half[ph] += 1
                    if len(picked) < 4 and all(p[3] != s for p in picked):
                        picked.append((g["said"], norm_line(g["gold"]), f"reward {r:.2f}", norm_line(s)))
        hack_stats.append((l, tot, hi_wrong, half["early"] / max(1, half["early_n"]), half["late"] / max(1, half["late_n"])))
        if picked:
            hack_rows.append(f"<h3>{esc(l)}</h3>" + "".join(
                f'<div class="radio"><div class="tx"><div class="who">heard</div><div class="said">“{esc(a)}”</div><div class="line"><em>label</em> {esc(b)}</div>'
                f'<div class="line bad"><em>{esc(c_)}</em> {esc(d)}</div></div></div>' for a, b, c_, d in picked))

    # --- best variant for examples
    def gain(n):
        return res[n]["scores"]["sydney"]["exact"] - base["scores"]["sydney"]["exact"] if res.get(n) else -9
    best = max([r for r in RUNS[1:4] if res.get(r[0])], key=lambda r: gain(r[0]), default=None)
    ex_html = ""
    for n, l, c in [RUNS[1], RUNS[3]]:
        if not res.get(n):
            continue
        fx = diff_examples(base, res[n], "stt", "fixed", 4) + diff_examples(base, res[n], "val", "fixed", 2)
        br = diff_examples(base, res[n], "sydney", "broken", 3) + diff_examples(base, res[n], "stt", "broken", 2)
        ex_html += f'<h3>{esc(l)}: fixed</h3>{radio(fx, "heard")}<h3>{esc(l)}: broken</h3>{radio(br, "heard")}'

    # --- throughput
    thr = []
    for n, l, c in RUNS[1:]:
        d = done.get(n)
        if not d:
            continue
        if "samples" in d:
            thr.append(f"<tr><td>{esc(l)}</td><td class=n>{d['steps']}</td><td class=n>{d['prompts']:,}</td><td class=n>{d['samples']:,}</td><td class=n>{d['cpu_s'] / 60:.0f}</td>"
                       f"<td class=n>{d['samples'] / d['cpu_s']:.1f}</td><td class=n>{d.get('engine_cpu_s', 0):.0f}</td></tr>")
        else:
            thr.append(f"<tr><td>{esc(l)}</td><td class=n>{d['steps']}</td><td class=n>{d['examples_seen']:,}</td><td class=n>—</td><td class=n>{d['cpu_s'] / 60:.0f}</td>"
                       f"<td class=n>{d['examples_seen'] / d['cpu_s']:.1f} ex/s</td><td class=n>—</td></tr>")

    tr = "".join("<tr>" + "".join(f"<td{' class=n' if i else ''}>{esc(x)}</td>" for i, x in enumerate(r)) + "</tr>" for r in table)
    bs = base["scores"]; ge = res["grpo-exact"]["scores"]; sc = res["sft-control"]["scores"]
    best_s = res[best[0]]["scores"] if best else bs
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex">
<title>Voice model RL</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=DM+Mono:wght@400;500&display=swap">
<style>{CSS}</style></head>
<body><div class="wrap">
<header>
<div class="eyebrow">OpenATC · voice model · reinforcement learning</div>
<h1>Does RL with the game engine as the reward improve the 2 M voice model?</h1>
<p class="lede">GRPO written from scratch on the S1 model, three reward designs scored by the engine's own parser, and a control that spends the same CPU on plain supervised fine-tuning of the same hard prompts.</p>
<div class="meta"><span>start: <code>s1-2m-11ap-swap</code> (2.03 M params)</span><span>CPU only, 1 thread per run</span><span>code: <code>ml/rl/</code></span><span>numbers: <code>ml/rl/RESULTS.md</code></span></div>
</header>
<section>
<div class="headline">
<div class="stat"><span class="k">REAL STT · EXACT</span><span class="v">{bs['stt']['exact'] * 100:.1f}<small> → {ge['stt']['exact'] * 100:.1f}</small></span><span class="d">start → GRPO exact · 1,000 Whisper / Moonshine transcripts</span></div>
<div class="stat"><span class="k">SFT CONTROL · REAL STT</span><span class="v">{sc['stt']['exact'] * 100:.1f}</span><span class="d">same CPU, same hard prompts, with labels</span></div>
<div class="stat"><span class="k">SYDNEY (UNSEEN) · EXACT</span><span class="v">{bs['sydney']['exact'] * 100:.1f}<small> → {min(res[n]['scores']['sydney']['exact'] for n in ('grpo-exact', 'grpo-shaped', 'grpo-verifier')) * 100:.1f}–{max(res[n]['scores']['sydney']['exact'] for n in ('grpo-exact', 'grpo-shaped', 'grpo-verifier')) * 100:.1f}</small></span><span class="d">flat for every variant (within noise)</span></div>
<div class="stat"><span class="k">VAL · EXACT</span><span class="v">{bs['val']['exact'] * 100:.1f}<small> → {ge['val']['exact'] * 100:.1f}</small></span><span class="d">known airports · GRPO exact</span></div>
</div>
<p class="verdict">VERDICT_PLACEHOLDER</p>
</section>
<section>
<h2>The loop</h2>
{DIAGRAM}
<div class="terms">
<div class="term"><b>Policy</b>the model being trained, seen as a probability distribution over command lines for a given state and transcript.</div>
<div class="term"><b>Group</b>k = 8 lines sampled for the same prompt. GRPO compares them with each other instead of training a value network.</div>
<div class="term"><b>Advantage</b>how much better a sample scored than its own group's mean, divided by the group's spread. Positive: make it more likely.</div>
<div class="term"><b>Clipped ratio</b>ρ = π_new / π_old per token, kept inside 0.8–1.2 (PPO) so one batch cannot move the policy far.</div>
<div class="term"><b>KL penalty</b>a cost (β = 0.04) on drifting from the frozen start model, so the policy keeps what pre-training taught it.</div>
<div class="term"><b>Reward hacking</b>the policy finds outputs that score well under the reward but are wrong; a leaky reward gets exploited, not obeyed.</div>
<div class="term"><b>SFT control</b>the same hard prompts and CPU spent on ordinary supervised training with the labels. It answers "was it RL, or just more training on hard cases?"</div>
<div class="term"><b>Callsign trie</b>on while sampling and in every log-prob: the deployed decoder always masks unknown aircraft, so that is the policy we train.</div>
</div>
</section>
<section>
<div class="chart-head"><h2>Accuracy before and after</h2>{legend([r for r in RUNS if res.get(r[0])])}</div>
<div class="chart">{bars(res, base)}<p class="note">Exact-match of the command line, constrained greedy decoding (the production decoder). Bars start at 60%. The thin dark line is the 95% interval; hover for callsign accuracy and the paired test against the start model (same rows: fixed vs broke).</p></div>
<div class="scroll"><table><tr><th>run</th><th>val exact / callsign</th><th>Sydney</th><th>real STT</th><th>train CPU-min</th></tr>{tr}</table></div>
</section>
<section>
<div class="chart-head"><h2>What kind of error went away</h2></div>
<div class="scroll"><table><tr><th>set</th><th>run</th><th>wrong aircraft</th><th>wrong instruction</th><th>false SAY AGAIN</th><th>missed SAY AGAIN</th><th>errors</th></tr>{err_rows}</table></div>
<p class="note">ERRORS_NOTE</p>
<div class="grid2">
<div class="chart"><div class="chart-head"><h3>Unseen hard train prompts, greedy</h3><span class="note">n={hh.get("n", 0)}, {hh.get("noisy", 0)} with extra STT-style noise</span></div><div class="pair">{hh_rows}</div><p class="note">HELDOUT_NOTE</p></div>
<div class="chart"><div class="chart-head"><h3>Real STT, per recogniser (exact %)</h3><span class="note">n=200 each</span></div><div class="scroll"><table><tr><th>run</th>{rec_head}</tr>{per_rec}</table></div></div>
</div>
</section>
<section>
<div class="chart-head"><h2>Training curves</h2>{legend(grpo)}</div>
<div class="grid2">{"".join(charts)}</div>
<div class="chart-head"><h3>Held-out accuracy during training</h3>{legend([r for r in RUNS[1:] if mt[r[0]][1]])}</div>
<div class="grid2">{"".join(evc)}</div>
</section>
<section>
<h2>Three rewards, all computed by the engine</h2>
<div class="terms">
<div class="term"><b>a · exact</b>1 if the sampled line equals the label, else 0. Clean but sparse: a group that is all right or all wrong teaches nothing.</div>
<div class="term"><b>b · shaped</b>parsed AST vs the label's AST: 0.1 parses + 0.4 right aircraft + 0.2 right command kind + 0.3 right values (share of matching fields).</div>
<div class="term"><b>c · verifier (no label)</b>0 unless it parses (unknown aircraft never parse) · +0.4 callsign heard in the transcript · +0.4 F1 between the engine's own spoken rendering of the command and the transcript (numbers double). SAY AGAIN = 0.7 when no aircraft was heard.</div>
</div>
<p class="note">VERIFIER_NOTE</p>
</section>
<section>
<h2>Examples fixed and broken</h2>
<p class="note">Rows of the fixed eval sets where the start model and the trained model disagree.</p>
{ex_html}
</section>
<section>
<h2>Reward hacking watch</h2>
<p class="note">HACK_NOTE</p>
<div class="scroll"><table><tr><th>reward</th><th>logged samples</th><th>wrong but reward ≥ 0.6</th><th>first half</th><th>second half</th></tr>{"".join(f"<tr><td>{esc(l)}</td><td class=n>{t:,}</td><td class=n>{h:,} ({h / max(1, t) * 100:.1f}%)</td><td class=n>{e * 100:.1f}%</td><td class=n>{la * 100:.1f}%</td></tr>" for l, t, h, e, la in hack_stats)}</table></div>
{"".join(hack_rows)}
</section>
<section>
<h2>Cost and throughput</h2>
<div class="scroll"><table><tr><th>run</th><th>steps</th><th>prompts / examples</th><th>samples</th><th>CPU-min</th><th>samples / CPU-s</th><th>engine CPU-s</th></tr>{"".join(thr)}</table></div>
<p class="note">THROUGHPUT_NOTE</p>
</section>
<section>
<h2>Next steps</h2>
NEXT_PLACEHOLDER
</section>
</div></body></html>"""
    for k, v in NOTES.items():
        page = page.replace(k, v.format(vc=vc, hh=hh, stats=stats))
    return page, res, mt, done, stats, hack_stats


NOTES = {
"VERDICT_PLACEHOLDER": "RL helped where the hard prompts were: on 1,000 real recogniser transcripts GRPO lifted exact match from 79.6% to 83.8% "
    "(53 rows fixed, 11 broken, p &lt; 0.001), mostly by picking the right aircraft. The SFT control, with the same CPU and the same prompts plus labels, "
    "reached 82.0%: GRPO-exact beats it on the same rows (33 vs 15, p = 0.013, one seed each). The label-free verifier reward did about as well as the "
    "labelled ones (83.4%). Sydney, the unseen airport, did not move for any method (86.2–87.1 vs 86.8): its errors are fix names and airlines the "
    "model has never seen, and RL can only reinforce answers it already samples. Not exported: the Sydney criterion was not met.",
"ERRORS_NOTE": "On real STT, GRPO cut wrong-aircraft errors from 74 to 44–46 with every reward but barely touched wrong instructions (89 → 84–88). "
    "SFT did the opposite mix: 60 wrong aircraft, 78 wrong instructions. "
    "The one regression worth watching: the shaped reward made the model less willing to say SAY AGAIN at Sydney (missed 3 → 11 of ~47), "
    "the dangerous direction, since a command then goes to an aircraft nobody called.",
"HELDOUT_NOTE": "Hard train prompts no GRPO run ever sampled: greedy accuracy 51% → 70–72%, so the higher training reward is not just a sharper "
    "sampler. SFT reached 75% here but trained on these exact rows.",
"VERIFIER_NOTE": "Checked against labels (never trained on): the verifier scores the gold line above another real command for the same state "
    "{vc[rank_gold_over_alt]:.1%} of the time (n={vc[n]:,}); on the start model's own predictions it separates right from wrong with AUC "
    "{vc[val][auc]:.2f} (val) / {vc[sydney][auc]:.2f} (Sydney) / {vc[stt][auc]:.2f} (real STT). Its blind spots: an unseen fix name is one token of the F1, "
    "so 'DIRECT HNNO' for 'direct ssyno' still scores 0.8 ({vc[sydney][wrong_but_high]} of {vc[sydney][wrong]} wrong Sydney predictions score ≥ 0.8), "
    "and climb/descend are ignored, so 'EXPEDITE CLIMB' for 'expedite descend' scores 1.0.",
"HACK_NOTE": "A leaky reward shows up as samples that are wrong but still score high. The shaped reward pays 0.6 for the right instruction to the "
    "wrong aircraft and 0.875 for a taxi to the wrong place; the verifier pays 0.98 for a doubled taxiway and 0.87 for a fix nobody said. Those holes "
    "were there from step one, but the policy did not grow into them in 20 CPU-minutes: the wrong-but-high share stayed flat (below), completion length "
    "stayed at ~10.4 tokens, and the SAY AGAIN rate fell rather than rose, so no collapse to short or safe commands. With β = 0.04 the KL leash "
    "reached only ~0.1 nats per token; longer or less-leashed runs would need the holes closed first.",
"THROUGHPUT_NOTE": "One GRPO step = 16 prompts × 8 samples ≈ 4.2 CPU-seconds on one shared core (the host had a load average of 10–25 from other jobs); "
    "the engine's share was 1.7–1.9 CPU-s per run, about 0.15%: parsing is free next to the model. CPU is the bottleneck. On an L4 (~$1/h) the "
    "16 × 8 rollouts would decode as one batch of 128 and the update is a few small matmuls, so a step should take ~0.1 s: the 20-minute run in "
    "~30 s, a full epoch of the 10.6k pool in about a minute, for cents. That would also make k = 16–32, several seeds and the 11 M model affordable.",
"NEXT_PLACEHOLDER": "<ul class=plain>"
    "<li>Decision for the lead: GRPO-exact is +4.2 on real STT and +1.3 on val, flat on Sydney. Its int8 export matches fp32 exactly "
    "(96.3% vs 96.3%, n=300, files in <code>ml/rl/runs/export-check-grpo-exact/</code>). To publish: <code>python3 ml/edge/export_web.py --run "
    "ml/rl/runs/grpo-exact --name s1/2m-grpo-v1 --int8 --check 300 --data ml/data/out4/ds/val.jsonl</code>. The policy is sharper (entropy 0.13 → 0.08), "
    "so re-check the confidence gate's calibration before switching.</li>"
    "<li>Sydney needs its own hard prompts: rename fixes and airlines consistently in state, transcript and label (as the airline swap does) so "
    "unseen names appear in training; then RL has correct copies to reinforce.</li>"
    "<li>Close the verifier holes before training on unlabelled speech: render with the aircraft's altitude from the state (climb vs descend), "
    "match fix names by spelling, weigh tokens the speaker never said more heavily.</li>"
    "<li>Seeds: 2–3 seeds of GRPO-exact and SFT to firm up 'RL beat SFT' (p = 0.013 is one seed each); then the usual recipe, SFT followed by GRPO.</li>"
    "<li>Move the loop to a GPU with batched rollouts (see above) and run a full epoch with k = 16.</li></ul>",
}


if __name__ == "__main__":
    page, *_ = main()
    out = ROOT / "public/reports/voice-rl.html"
    out.write_text(page)
    print("wrote", out, len(page))

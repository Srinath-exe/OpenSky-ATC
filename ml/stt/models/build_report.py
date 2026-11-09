"""Render public/reports/voice-stt-models.html from ml/stt/models/edge.json (on-device: browser + phone) and
ml/stt/models/server.json (server-side), whichever exist. Standalone HTML, inline SVG, light + dark with the tokens of
public/reports/voice-ai.html, no sideways scroll at 375 px.
    python3 ml/stt/models/build_report.py
Each part file: {"title", "updated", "lede", "headline": [{"value", "label"}], "rows": [row], "best": [str],
"shipped": [str], "failed": [str], "method": [str], "notes": [str]}. A row: {"name", "where", "runtime", "licence",
"sizeMB", "streaming", "biasing", "us": {"n", "exact", "wrong", "cs", "wer", "old"}, "in": {...},
"latency": str, "ram": str, "measured": str}; rates are 0-1. Unknown keys are ignored, missing ones are shown as "-".
"""
import html
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = ROOT / "public/reports/voice-stt-models.html"
PARTS = [("edge", "On the player's device: browser and phone"), ("server", "On the game's server")]
E = html.escape


def pct(x):
    return "-" if x is None else f"{100 * x:.1f}%"


def cell(v):
    if v is None or v == "":
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:g}"
    return E(str(v))


def bars(rows):
    """Exact command (new chain) per engine: US/UK set and Indian-accent proxy, one SVG per engine (scales to any width)."""
    out = []
    for r in rows:
        us, ind = (r.get("us") or {}), (r.get("in") or {})
        if us.get("exact") is None and ind.get("exact") is None:
            continue
        lines = []
        for k, (d, cls, lab) in enumerate([(us, "s-us", "US/UK"), (ind, "s-in", "Indian proxy")]):
            v = d.get("exact")
            w = 0 if v is None else max(0.4, 100 * v)
            y = 2 + k * 14
            lines.append(f'<rect class="{cls}" x="0" y="{y}" width="{w:.1f}%" height="10" rx="2"><title>{lab}: {pct(v)} exact (n={d.get("n", "-")})</title></rect>')
        vals = " · ".join(f'{lab} <b>{pct(d.get("exact"))}</b>' for d, lab in [(us, "US/UK"), (ind, "IN")])
        out.append(f'<div class="brow"><div class="blab">{E(r.get("name", "?"))} <small>{E(r.get("where", ""))}</small></div>'
                   f'<svg class="bsvg" width="100%" height="28" role="img" aria-label="{E(r.get("name", ""))}: {E(vals.replace("<b>", "").replace("</b>", ""))}">'
                   f'<line class="grid" x1="50%" x2="50%" y1="0" y2="28"/><line class="grid" x1="75%" x2="75%" y1="0" y2="28"/>{"".join(lines)}</svg>'
                   f'<div class="bval">{vals}</div></div>')
    if not out:
        return ""
    return ('<div class="chart"><div class="chart-head"><h3>Exact command, the game\'s whole chain (n-best + repair + S1)</h3>'
            '<div class="legend"><span><i class="s-us"></i>US/UK voices</span><span><i class="s-in"></i>Indian-accent proxy</span></div></div>'
            + "".join(out) + '<p class="note">Gridlines at 50% and 75%. Hover a bar for n.</p></div>')


def scatter(rows):
    """Accuracy (US/UK exact) against download size, log x: the size/accuracy trade-off in one picture."""
    pts = [(r.get("sizeMB"), (r.get("us") or {}).get("exact"), r.get("name", "")) for r in rows if r.get("plot", True)]
    pts = [(s, e, n) for s, e, n in pts if isinstance(s, (int, float)) and s > 0 and e is not None]
    if len(pts) < 2:
        return ""
    import math
    W, H, L, B, T, R = 360, 240, 40, 30, 12, 12
    lo, hi = 10, 2000
    ys = [e for _, e, _ in pts]
    y0, y1 = max(0.0, math.floor(min(ys) * 10 - 0.5) / 10), min(1.0, math.ceil(max(ys) * 10 + 0.5) / 10)
    X = lambda s: L + (math.log10(min(max(s, lo), hi)) - math.log10(lo)) / (math.log10(hi) - math.log10(lo)) * (W - L - R)
    Y = lambda e: H - B - (e - y0) / max(1e-6, y1 - y0) * (H - B - T)
    g = []
    for s in [10, 30, 100, 300, 1000]:
        g.append(f'<line class="grid" x1="{X(s):.1f}" x2="{X(s):.1f}" y1="{T}" y2="{H - B}"/><text class="tick" x="{X(s):.1f}" y="{H - B + 14}" text-anchor="middle">{s}</text>')
    k = y0
    while k <= y1 + 1e-9:
        g.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(k):.1f}" y2="{Y(k):.1f}"/><text class="tick" x="{L - 6}" y="{Y(k) + 4:.1f}" text-anchor="end">{round(100 * k)}%</text>')
        k += 0.1
    dots, keys = [], []
    for i, (s, e, n) in enumerate(sorted(pts, key=lambda t: (t[0], -t[1]))):
        dots.append(f'<circle class="dot" cx="{X(s):.1f}" cy="{Y(e):.1f}" r="7"><title>{E(n)}: {pct(e)}, {s:g} MB</title></circle>'
                    f'<text class="dnum" x="{X(s):.1f}" y="{Y(e) + 3.5:.1f}" text-anchor="middle">{i + 1}</text>')
        keys.append(f"<li><b>{i + 1}</b> {E(n)} <span class=\"mono\">{s:g} MB · {pct(e)}</span></li>")
    return (f'<figure class="chart"><div class="chart-head"><h3>Accuracy against download</h3></div>'
            f'<svg viewBox="0 0 {W} {H}" class="scatter" role="img" aria-label="Exact command on the US/UK set against download size">'
            f'{"".join(g)}{"".join(dots)}<text class="tick" x="{(L + W - R) / 2}" y="{H - 2}" text-anchor="middle">download, MB (log scale)</text></svg>'
            f'<ol class="keys">{"".join(keys)}</ol>'
            f'<figcaption class="note">Up and to the left is better. Exact command on the US/UK set; overlapping points are near-ties.</figcaption></figure>')


def table(rows):
    if not rows:
        return ""
    head = ("engine", "where / runtime", "n", "exact US/UK", "exact IN", "sent wrong US/UK · IN", "callsign US/UK", "WER US/UK · IN",
            "download", "latency", "RAM", "licence", "streaming", "biasing", "how measured")
    trs = []
    for r in rows:
        us, ind = (r.get("us") or {}), (r.get("in") or {})
        n = f'{us.get("n", "-")} · {ind.get("n", "-")}'
        trs.append("<tr>" + "".join([
            f'<td><strong>{E(r.get("name", "?"))}</strong></td>',
            f'<td>{cell(r.get("where"))}<br><small>{cell(r.get("runtime"))}</small></td>',
            f'<td class="n">{n}</td>',
            f'<td class="n">{pct(us.get("exact"))}</td>', f'<td class="n">{pct(ind.get("exact"))}</td>',
            f'<td class="n">{pct(us.get("wrong"))} · {pct(ind.get("wrong"))}</td>', f'<td class="n">{pct(us.get("cs"))}</td>',
            f'<td class="n">{pct(us.get("wer"))} · {pct(ind.get("wer"))}</td>',
            f'<td class="n">{cell(r.get("sizeMB"))}{" MB" if isinstance(r.get("sizeMB"), (int, float)) else ""}</td>',
            f'<td>{cell(r.get("latency"))}</td>', f'<td>{cell(r.get("ram"))}</td>', f'<td>{cell(r.get("licence"))}</td>',
            f'<td>{cell(r.get("streaming"))}</td>', f'<td>{cell(r.get("biasing"))}</td>', f'<td><small>{cell(r.get("measured"))}</small></td>']) + "</tr>")
    return ('<details class="table" open><summary>Every engine, every number</summary><div class="scroll"><table><thead><tr>'
            + "".join(f"<th>{h}</th>" for h in head) + "</tr></thead><tbody>" + "".join(trs) + "</tbody></table></div></details>")


def ul(title, items):
    if not items:
        return ""
    return f'<div class="block"><h3>{E(title)}</h3><ul>' + "".join(f"<li>{x}</li>" for x in items) + "</ul></div>"


# server.json is srv_summarize.py's output ({"engines": {...}, "latency_quiet": {...}, ...}) plus the report's text keys:
# its rows are built here, these engines in this order (name, where, latency_quiet key, cascade estimate key)
SERVER_ROWS = [
    ("srv-casc1-ultra-sherpa", "Parakeet Ultra, then Whisper (shipped)", "server, Node", None, "ultra-sherpa"),
    ("srv-tjs-whisper-base.en", "Whisper base.en (before)", "server, Node", "tjs-whisper-base.en-alts", None),
    ("srv-casc-granite", "Granite TurboCTC, then Whisper", "server", None, "granite"),
    ("srv-casc1-phonon", "Phonon-2.5-English, then Whisper", "server, Python sidecar", None, "phonon"),
    ("srv-casc-p110-sherpa", "Parakeet 110M, then Whisper", "server, Node", None, "p110-sherpa"),
    ("srv-casc-redux-sherpa", "Parakeet Redux, then Whisper", "server, Node", None, None),
    ("srv-granite", "Granite Speech 5.0 TurboCTC", "server, Python", "granite", None),
    ("srv-phonon", "Phonon-2.5-English", "server, Python sidecar", "phonon", None),
    ("srv-ultra-sherpa", "Parakeet Ultra int8", "server, Node", "ultra-sherpa", None),
    ("srv-redux-sherpa", "Parakeet Redux int8", "server, Node", "redux-sherpa", None),
    ("srv-ultra-onnxasr", "Parakeet Ultra int8 (onnx-asr, greedy)", "server, Python", "ultra-greedy", None),
    ("srv-redux-photon", "Parakeet Redux ternary (Photon)", "server, Python", None, None),
    ("srv-p110-sherpa", "Parakeet TDT-CTC 110M int8", "server, Node", "p110-sherpa", None),
    ("srv-hima", "Hima-ASR int8", "server, Python", "hima", None),
    ("srv-canary180", "Canary-180M-Flash int8", "server, Python", "canary180", None),
    ("nemo-salm-context", "Nemotron 3.5 Transcribe 30B (reference)", "GPU (L4)", None, None),
    ("webspeech-google", "Google Web Speech (reference)", "browser, Google", None, None),
]


def server_rows(d):
    eng, lat, est = d.get("engines", {}), d.get("latency_quiet", {}), d.get("latency_cascade_est", {})
    rows = []
    for key, name, where, lk, ek in SERVER_ROWS:
        e = eng.get(key)
        if not e:
            continue
        info = e.get("info") or {}
        first = eng.get(key.replace("srv-casc1-", "srv-").replace("srv-casc-", "srv-"), {}).get("info", {}) if "casc" in key else info
        acc = lambda a: None if not a or a.get("exact") is None else {"n": a.get("n"), "exact": a.get("exact"), "wrong": a.get("sent_wrong"),
                                                                       "cs": a.get("callsign"), "wer": a.get("wer"), "old": a.get("exact_rules_S1_raw")}
        if lk and lk in lat:
            q = lat[lk]; latency = f'p50 {q["p50"]} ms, p95 {q["p95"]} ms (quiet pass, n={q["n"]})'
        elif ek and ek in est:
            q = est[ek]; latency = f'~p50 {q["p50"]} ms, p95 {q["p95"]} ms (estimate; asks Whisper {round(100 * q["asks_whisper"])}%)'
        else:
            latency = None
        rss = (lat.get(lk) or {}).get("peak_rss_mb") if lk else None
        rows.append({"name": name, "where": where, "runtime": first.get("runtime") or first.get("model"), "licence": first.get("licence"),
                     "sizeMB": first.get("download_mb"), "biasing": first.get("biasing"), "streaming": "no",
                     "us": acc(e.get("us")), "in": acc(e.get("in")), "latency": latency, "ram": f"{rss} MB peak" if rss else None,
                     "measured": "game chain nbest+S1, ml/stt/models/srv_score.sh", "plot": "casc" not in key and "reference" not in name})
    return rows


def part(key, heading, d):
    hl = "".join(f'<div class="kpi"><div class="big">{E(str(h.get("value", "")))}</div><div class="klab">{E(str(h.get("label", "")))}</div></div>'
                 for h in d.get("headline", []))
    rows = d.get("rows", [])
    return (f'<section id="{key}"><div class="eyebrow">{E(heading)}</div><h2>{E(d.get("title", heading))}</h2>'
            + (f'<p class="lede">{d["lede"]}</p>' if d.get("lede") else "")
            + (f'<div class="kpis">{hl}</div>' if hl else "")
            + ul("Best", d.get("best")) + bars(rows) + scatter(rows) + table(rows)
            + ul("Shipped", d.get("shipped")) + ul("What failed or is blocked", d.get("failed"))
            + ul("Notes", d.get("notes")) + ul("How it was measured", d.get("method"))
            + (f'<p class="note">Updated {E(d["updated"])}. Source: <code>ml/stt/models/{key}.json</code>.</p>' if d.get("updated") else "")
            + "</section>")


CSS = """
:root { --bg:#0e0f11; --surface:#141416; --raise:#1c1c1e; --line:rgba(255,255,255,.09); --line-strong:rgba(255,255,255,.16);
  --ink-1:#f4f4f5; --ink-2:#c4c5c8; --ink-3:#a0a1a6; --ink-4:#7f8086; --accent:#f5933f; --accent-tint:rgba(245,147,63,.14);
  --s-before:#5b8fd6; --s-after:#d97626; --good:#57cd50; --good-tint:rgba(87,205,80,.13);
  --font:"DM Sans","Helvetica Neue",Arial,sans-serif; --mono:"DM Mono",ui-monospace,"SFMono-Regular",Menlo,monospace; color-scheme:dark; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  --bg:#f6f5f2; --surface:#fbfaf8; --raise:#efeeea; --line:rgba(20,20,24,.10); --line-strong:rgba(20,20,24,.18);
  --ink-1:#141416; --ink-2:#3c3d42; --ink-3:#56575d; --ink-4:#6c6d73; --accent:#b85a12; --accent-tint:rgba(200,102,26,.12);
  --s-before:#3f78c2; --s-after:#c8661a; --good:#23862b; --good-tint:rgba(35,134,43,.12); color-scheme:light; } }
:root[data-theme="light"] { --bg:#f6f5f2; --surface:#fbfaf8; --raise:#efeeea; --line:rgba(20,20,24,.10); --line-strong:rgba(20,20,24,.18);
  --ink-1:#141416; --ink-2:#3c3d42; --ink-3:#56575d; --ink-4:#6c6d73; --accent:#b85a12; --accent-tint:rgba(200,102,26,.12);
  --s-before:#3f78c2; --s-after:#c8661a; --good:#23862b; --good-tint:rgba(35,134,43,.12); color-scheme:light; }
* { box-sizing:border-box; } html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--ink-2); font-family:var(--font); font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased;
  padding:40px max(16px, env(safe-area-inset-right, 0px)) 72px max(16px, env(safe-area-inset-left, 0px)); overflow-wrap:anywhere; }
.wrap { max-width:960px; margin:0 auto; display:grid; gap:56px; min-width:0; }
h1,h2,h3 { color:var(--ink-1); margin:0; font-weight:600; letter-spacing:-.01em; text-wrap:balance; }
h1 { font-size:clamp(28px,4.4vw,40px); line-height:1.12; } h2 { font-size:22px; line-height:1.25; } h3 { font-size:15px; }
p { margin:0; max-width:68ch; } a { color:var(--accent); text-underline-offset:2px; }
code { font-family:var(--mono); font-size:.9em; }
.eyebrow { font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3); font-weight:600; }
section, header { display:grid; gap:18px; min-width:0; } .lede { font-size:17px; max-width:62ch; }
.meta { display:flex; flex-wrap:wrap; gap:8px 16px; color:var(--ink-3); font-size:13px; }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
.kpi { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:16px 18px; }
.big { font-size:clamp(30px,6vw,42px); line-height:1.05; font-weight:600; color:var(--ink-1); font-variant-numeric:tabular-nums; }
.klab { font-size:13px; color:var(--ink-3); margin-top:6px; }
.block ul { margin:8px 0 0; padding-left:20px; display:grid; gap:6px; max-width:76ch; }
.chart { margin:0; background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:18px 18px 14px; display:grid; gap:12px; min-width:0; }
.chart-head { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px 20px; align-items:baseline; }
.legend { display:flex; flex-wrap:wrap; gap:14px; font-size:13px; } .legend span { display:inline-flex; align-items:center; gap:7px; }
.legend i { width:12px; height:8px; border-radius:2px; display:inline-block; }
.s-us { fill:var(--s-before); background:var(--s-before); } .s-in { fill:var(--s-after); background:var(--s-after); }
.brow { display:grid; grid-template-columns:minmax(0,190px) minmax(0,1fr) auto; gap:4px 12px; align-items:center; }
.blab { font-size:13px; color:var(--ink-1); font-weight:600; line-height:1.25; } .blab small { display:block; color:var(--ink-3); font-weight:400; font-size:11.5px; }
.bval { font-family:var(--mono); font-size:12px; color:var(--ink-3); white-space:nowrap; } .bval b { color:var(--ink-1); font-weight:500; }
.bsvg { display:block; min-width:0; } .grid { stroke:var(--line); stroke-width:1; }
@media (max-width:620px) { .brow { grid-template-columns:minmax(0,1fr); } .bval { white-space:normal; } }
.scatter { width:100%; max-width:640px; height:auto; display:block; }
.tick { fill:var(--ink-4); font-size:10.5px; font-family:var(--font); } .dlab { fill:var(--ink-2); font-size:10.5px; font-family:var(--font); }
.dot { fill:var(--accent); stroke:var(--surface); stroke-width:1.5; opacity:.9; } .dnum { fill:var(--bg); font-size:9px; font-weight:700; font-family:var(--font); pointer-events:none; }
.keys { margin:0; padding:0; list-style:none; display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:4px 16px; font-size:12.5px; }
.keys b { display:inline-grid; place-items:center; width:18px; height:18px; border-radius:50%; background:var(--accent); color:var(--bg); font-size:10px; margin-right:4px; }
.keys .mono { color:var(--ink-3); font-family:var(--mono); font-size:11.5px; }
.note { font-size:13px; color:var(--ink-3); }
details.table { border-top:1px solid var(--line); padding-top:10px; min-width:0; } details.table summary { cursor:pointer; font-size:13px; font-weight:500; }
.scroll { overflow-x:auto; min-width:0; max-width:100%; }
table { border-collapse:collapse; width:100%; font-size:13px; font-variant-numeric:tabular-nums; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; min-width:84px; }
th { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink-3); font-weight:600; }
td.n { text-align:right; font-family:var(--mono); font-size:12px; white-space:nowrap; } td strong { color:var(--ink-1); }
small { color:var(--ink-3); }
"""


def main():
    parts = []
    for key, heading in PARTS:
        f = HERE / f"{key}.json"
        if f.exists():
            d = json.loads(f.read_text())
            if "rows" not in d and "engines" in d:
                d["rows"] = server_rows(d)
            parts.append((key, heading, d))
    if not parts:
        raise SystemExit("no ml/stt/models/edge.json or server.json yet")
    nav = " · ".join(f'<a href="#{k}">{E(h)}</a>' for k, h, _ in parts)
    body = "".join(part(k, h, d) for k, h, d in parts)
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><title>Speech-to-text models</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>{CSS}</style></head><body><main class="wrap">
<header><div class="eyebrow">OpenATC · voice · November 2026</div><h1>Which speech-to-text model, where</h1>
<p class="lede">The newest small speech recognisers, scored by what the game does with their output: the command it would send.
Same clips as <a href="voice-stt.html">round two</a> (synthetic speech: US/UK voices in four conditions, and Kokoro's Hindi voices reading the
same English as a proxy for an Indian accent), the same chain (n-best, repair, the S1 model 2m-grpo-v1, the verifier).</p>
<div class="meta"><span>{nav}</span><span><a href="index.html">all reports</a></span></div></header>
{body}
</main></body></html>
"""
    OUT.write_text(page)
    print(f"wrote {OUT} ({len(page) // 1024} KB; parts: {', '.join(k for k, _, _ in parts)})")


if __name__ == "__main__":
    main()

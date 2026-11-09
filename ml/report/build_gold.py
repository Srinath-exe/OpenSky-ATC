"""Build public/reports/voice-gold.html: how the real-voice gold set works, what is in it, the dry run on synthetic
speech, and (once recorded) the owner's own voice. Static HTML, no JS; rebuilt by ml/stt/score_gold.py after scoring.

    python3 ml/report/build_gold.py
"""
import collections, html, json, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROMPTS = ROOT / "public/voice/gold-prompts.json"
DRY = ROOT / "ml/stt/out/gold-dry/scores.json"
GOLD = ROOT / "ml/data/gold"
REAL = GOLD / "scores/scores.json"
CEILING = ROOT / "ml/stt/out/gold-ceiling.json"
OUT = ROOT / "public/reports/voice-gold.html"

e = html.escape

CSS = """
:root {
  --bg: #0e0f11; --surface: #141416; --raise: #1c1c1e; --line: rgba(255,255,255,.09); --line-strong: rgba(255,255,255,.16);
  --ink-1: #f4f4f5; --ink-2: #c4c5c8; --ink-3: #a0a1a6; --ink-4: #7f8086;
  --accent: #f5933f; --accent-tint: rgba(245,147,63,.14);
  --s-val: #5b8fd6; --s-syd: #d97626; --s-free: #a685e2;
  --s-l0: #5b8fd6; --s-chain: #d97626;
  --d-right: #57cd50; --d-wrong: #ef6f6c; --d-check: #e2b33c; --d-again: #7f8086;
  --good: #57cd50; --good-tint: rgba(87,205,80,.13); --neutral-tint: rgba(255,255,255,.07);
  --font: "DM Sans", "Helvetica Neue", Arial, sans-serif; --mono: "DM Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12);
  --s-val: #3f78c2; --s-syd: #c8661a; --s-free: #7d5cc4; --s-l0: #3f78c2; --s-chain: #c8661a;
  --d-right: #23862b; --d-wrong: #c62828; --d-check: #a8780f; --d-again: #8a8b90;
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --neutral-tint: rgba(20,20,24,.06);
  color-scheme: light;
} }
:root[data-theme="light"] {
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12);
  --s-val: #3f78c2; --s-syd: #c8661a; --s-free: #7d5cc4; --s-l0: #3f78c2; --s-chain: #c8661a;
  --d-right: #23862b; --d-wrong: #c62828; --d-check: #a8780f; --d-again: #8a8b90;
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --neutral-tint: rgba(20,20,24,.06);
  color-scheme: light;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink-2); font-family: var(--font); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 40px 72px; }
.wrap { max-width: 960px; margin: 0 auto; display: grid; gap: 56px; }
h1, h2, h3 { color: var(--ink-1); text-wrap: balance; margin: 0; font-weight: 600; letter-spacing: -.01em; }
h1 { font-size: clamp(28px, 4.4vw, 40px); line-height: 1.12; }
h2 { font-size: 22px; line-height: 1.25; }
h3 { font-size: 15px; line-height: 1.35; }
p { margin: 0; max-width: 68ch; }
a { color: var(--accent); text-underline-offset: 2px; }
code, .mono { font-family: var(--mono); font-size: .9em; }
.eyebrow { font-size: 11.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; min-width: 0; }
header { display: grid; gap: 16px; }
.lede { font-size: 17px; max-width: 62ch; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--ink-3); font-size: 13px; }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; white-space: nowrap; border: 1px solid var(--line-strong); color: var(--ink-2); background: var(--neutral-tint); }
.pill.next { color: var(--accent); background: var(--accent-tint); border-color: transparent; }
.pill.done { color: var(--good); background: var(--good-tint); border-color: transparent; }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; display: grid; gap: 2px; min-width: 0; }
.tile .v { font-size: 30px; font-weight: 600; color: var(--ink-1); font-variant-numeric: tabular-nums; letter-spacing: -.02em; line-height: 1.1; }
.tile .k { font-size: 13px; color: var(--ink-3); }
.tile i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: 1px; }
.card, .chart { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 20px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
.chart-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 20px; align-items: baseline; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 7px; }
.legend i { width: 12px; height: 8px; border-radius: 2px; display: inline-block; }
.rows { display: grid; gap: 7px; }
.r { display: grid; grid-template-columns: 150px minmax(0, 1fr) 54px; gap: 12px; align-items: center; min-width: 0; }
.r .lab { font-size: 13px; color: var(--ink-1); line-height: 1.25; overflow-wrap: anywhere; }
.r .lab small { display: block; color: var(--ink-3); font-size: 11.5px; }
.r .val { font-size: 12.5px; font-family: var(--mono); text-align: right; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.stack { display: flex; height: 12px; gap: 2px; min-width: 0; }
.stack b { display: block; height: 100%; border-radius: 2px; min-width: 2px; }
.pair { display: grid; gap: 3px; }
.bar { height: 10px; border-radius: 0 4px 4px 0; min-width: 2px; }
.pairrow { display: grid; grid-template-columns: minmax(0, 1fr) 54px; gap: 8px; align-items: center; }
.r.tall { align-items: start; }
.note { font-size: 13px; color: var(--ink-3); }
@media (max-width: 620px) { .r { grid-template-columns: 96px minmax(0, 1fr) 44px; gap: 8px; } .r.tall { grid-template-columns: 96px minmax(0, 1fr) !important; } }
.flow { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 26px; }
.node { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 13px; display: grid; gap: 4px; align-content: start; min-width: 0; }
.node h3 { font-size: 14px; }
.node p { font-size: 12.5px; color: var(--ink-3); line-height: 1.45; }
.node .tag { font-family: var(--mono); font-size: 11px; color: var(--ink-4); overflow-wrap: anywhere; }
.node.key { border-color: var(--accent); background: linear-gradient(var(--accent-tint), var(--accent-tint)), var(--surface); }
.node:not(:last-child)::after { content: "→"; position: absolute; right: -19px; top: 50%; transform: translateY(-50%); color: var(--ink-4); }
@media (max-width: 900px) { .flow { grid-template-columns: repeat(3, minmax(0, 1fr)); } .node:nth-child(3)::after { content: "↓"; right: auto; left: 50%; top: auto; bottom: -24px; transform: translateX(-50%); } }
@media (max-width: 600px) { .flow { grid-template-columns: 1fr; } .node:not(:last-child)::after { content: "↓"; right: auto; left: 24px; top: auto; bottom: -23px; transform: none; } }
.scroll { overflow-x: auto; min-width: 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-3); font-weight: 600; white-space: nowrap; }
td.n { text-align: right; font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
td.best { color: var(--ink-1); font-weight: 600; }
td code { color: var(--ink-1); overflow-wrap: anywhere; }
.fail { display: grid; gap: 2px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
.fail:last-child { border-bottom: 0; }
.fail .h { color: var(--ink-1); }
.fail .g { font-family: var(--mono); font-size: 12.5px; color: var(--ink-3); overflow-wrap: anywhere; }
.fail .g b { color: var(--d-right); font-weight: 500; } .fail .g s { color: var(--d-wrong); text-decoration: none; }
.empty { border: 1px dashed var(--line-strong); border-radius: 16px; padding: 22px; display: grid; gap: 12px; }
.empty ol { margin: 0; padding-left: 20px; display: grid; gap: 6px; font-size: 14px; }
pre { margin: 0; background: var(--raise); border-radius: 10px; padding: 12px 14px; overflow-x: auto; font-family: var(--mono); font-size: 12.5px; color: var(--ink-1); line-height: 1.5; }
details summary { cursor: pointer; font-size: 13px; color: var(--ink-2); font-weight: 500; }
"""


def pctf(v, d=0):
    return "–" if v is None else f"{v * 100:.{d}f}%"


def legend(items):
    return '<div class="legend" aria-hidden="true">' + "".join(f'<span><i style="background:var({c})"></i>{e(t)}</span>' for c, t in items) + "</div>"


def composition(prompts):
    by = collections.defaultdict(collections.Counter)
    for p in prompts:
        by[p["kind"]][p["group"]] += 1
    kinds = sorted(by, key=lambda k: (-sum(by[k].values()), k))
    mx = max(sum(c.values()) for c in by.values())
    rows = []
    for k in kinds:
        c = by[k]; n = sum(c.values())
        segs = "".join(f'<b style="width:{100 * c[g] / mx:.2f}%;background:var({col})" title="{e(lab)}: {c[g]}"></b>'
                       for g, col, lab in (("val", "--s-val", "validation"), ("sydney", "--s-syd", "Sydney"), ("free", "--s-free", "own way")) if c[g])
        rows.append(f'<div class="r" role="listitem"><div class="lab">{e(k)}</div><div class="stack">{segs}</div><div class="val">{n}</div></div>')
    return "".join(rows)


def airports(prompts):
    c = collections.Counter(p["icao"] for p in prompts if p["group"] != "sydney")
    return ", ".join(f"{k} {v}" for k, v in sorted(c.items()))


def decision_rows(summary):
    rows = []
    for s in summary:
        segs = [("--d-right", s["sent_right"], "sent, right"), ("--d-wrong", s["sent_wrong"], "sent, wrong"), ("--d-check", s["check"], "left to check"), ("--d-again", s["say_again"], "say again")]
        bars = "".join(f'<b style="width:{100 * v:.2f}%;background:var({c})" title="{e(t)}: {pctf(v)}"></b>' for c, v, t in segs if v)
        rows.append(f'<div class="r" role="listitem"><div class="lab">{e(s["recogniser"])}</div><div class="stack">{bars}</div><div class="val">{pctf(s["sent_right"])}</div></div>')
    return "".join(rows)


def exact_rows(summary):
    rows = []
    for s in summary:
        pairs = "".join(f'<div class="pairrow"><div class="bar" style="width:{100 * (v or 0):.2f}%;background:var({c})" title="{e(t)}"></div><div class="val">{pctf(v)}</div></div>'
                        for c, v, t in (("--s-l0", s["l0"], "rules alone"), ("--s-chain", s["chain"], "rules + model")))
        wer = "" if s["wer"] is None else f'<small>WER {pctf(s["wer"], 1)}</small>'
        rows.append(f'<div class="r tall" role="listitem" style="grid-template-columns:150px minmax(0, 1fr)"><div class="lab">{e(s["recogniser"])}{wer}</div><div class="pair">{pairs}</div></div>')
    return "".join(rows)


def table(summary):
    best = max((s["chain"] or 0) for s in summary)
    head = "<tr><th>Recogniser</th><th>n</th><th>WER</th><th>Callsign rules</th><th>Callsign chain</th><th>Exact rules</th><th>Exact chain</th><th>Sent right</th><th>Sent wrong</th><th>To check</th><th>Say again</th><th>Model alone</th><th>STT ms</th></tr>"
    body = ""
    for s in summary:
        cells = [s["n"], pctf(s["wer"], 1), pctf(s["cs_l0"]), pctf(s["cs_chain"]), pctf(s["l0"]), pctf(s["chain"]), pctf(s["sent_right"]), pctf(s["sent_wrong"]),
                 pctf(s["check"]), pctf(s["say_again"]), pctf(s["model"]), "–" if s["ms_p50"] is None else f'{s["ms_p50"]:.0f}']
        body += f'<tr><td>{e(s["recogniser"])}</td>' + "".join(f'<td class="n{" best" if i == 5 and s["chain"] == best else ""}">{v}</td>' for i, v in enumerate(cells)) + "</tr>"
    return f'<div class="scroll"><table><thead>{head}</thead><tbody>{body}</tbody></table></div>'


def rank(s):
    """Best recogniser: most exact commands, then fewest sent wrong, then lowest WER."""
    return (s["chain"] or 0, -(s["sent_wrong"] or 0), -(s["wer"] if s["wer"] is not None else 1))


def failures(doc, n=8):
    real = [s for s in doc["summary"] if not s["recogniser"].startswith("text")]
    if not real:
        return ""
    best = max(real, key=rank)["recogniser"]
    fs = [f for f in doc["failures"] if f["recogniser"] == best][:n]
    if not fs:
        return f'<p class="note">{e(best)}: no failures.</p>'
    out = []
    for f in fs:
        ref = f["said"] or f"(own words) {f['intent']}"
        conf = "" if f["confidence"] is None else f' · conf {f["confidence"]:.2f}'
        out.append(f'<div class="fail"><div class="h">“{e(f["heard"])}”</div><div class="g">read: {e(ref)}</div>'
                   f'<div class="g">gold <b>{e(f["gold"])}</b> · got <s>{e(f["got"] or "nothing")}</s> · {e(f["decision"])}{conf}</div></div>')
    return f'<h3>Where {e(best)} + the chain went wrong ({len([f for f in doc["failures"] if f["recogniser"] == best])})</h3><div>' + "".join(out) + "</div>"


def results(doc, title_id):
    s = doc["summary"]
    groups = ""
    for g, label in (("val", "Validation airports"), ("sydney", "Sydney (unseen airport)"), ("free", "Own words (free phrasing)")):
        if g in doc.get("by_group", {}):
            groups += f'<details><summary>{e(label)}: {len(doc["by_group"][g]) and doc["by_group"][g][0]["n"]} clips</summary>{table(doc["by_group"][g])}</details>'
    return f"""
  <div class="chart">
    <div class="chart-head"><h3 id="{title_id}">Exact command: rules alone vs rules + model</h3>{legend([("--s-l0", "Rules (L0)"), ("--s-chain", "Rules + S1 model (shipped chain)")])}</div>
    <div class="rows" role="list">{exact_rows(s)}</div>
    <p class="note">Exact = the command the chain ends with has the same parsed AST as the prompt's command, whatever the gate decided. WER compares numbers in one form on both sides ("four two one" = "421").</p>
  </div>
  <div class="chart">
    <div class="chart-head"><h3>What the game would do with it</h3>{legend([("--d-right", "Sent, right"), ("--d-wrong", "Sent, wrong"), ("--d-check", "Left in the bar to check"), ("--d-again", "Say again")])}</div>
    <div class="rows" role="list">{decision_rows(s)}</div>
    <p class="note">Sent = passed the confidence gate in <code>understandVoice</code>. "Sent, wrong" is the number that has to stay near zero; a wrong command left in the bar costs the player a glance.</p>
  </div>
  <details open><summary>All numbers</summary>{table(s)}</details>
  {groups}
  {failures(doc)}"""


def main(argv=None):
    doc = json.load(open(PROMPTS)); prompts = doc["prompts"]
    dry = json.load(open(DRY)) if DRY.exists() else None
    real = json.load(open(REAL)) if REAL.exists() else None
    ceil = json.load(open(CEILING)) if CEILING.exists() else None
    n_rec = len([p for p in prompts if (GOLD / f"{p['id']}.wav").exists()])
    g = collections.Counter(p["group"] for p in prompts)
    kinds = len({p["kind"] for p in prompts})
    built = time.strftime("%-d %b %Y")
    if real:
        best = max((s for s in real["summary"] if not s["recogniser"].startswith("text")), key=rank)
        headline = f'<div class="tiles"><div class="tile"><span class="v">{real["clips"]}</span><span class="k">clips of your voice scored</span></div><div class="tile"><span class="v">{pctf(best["chain"])}</span><span class="k">exact command, {e(best["recogniser"])} + chain</span></div><div class="tile"><span class="v">{pctf(best["sent_wrong"], 1)}</span><span class="k">sent wrong (the safety number)</span></div><div class="tile"><span class="v">{pctf(best["wer"], 1)}</span><span class="k">word error rate, scripted prompts</span></div></div>'
        voice = f'<p>Scored {e(real["built"])}: {real["clips"]} clips, {real["seconds"]:.0f} s of audio, model <code>{e(real["model"])}</code>.</p>' + results(real, "h-real")
    else:
        headline = f'<div class="tiles"><div class="tile"><span class="v">{n_rec} / {len(prompts)}</span><span class="k">prompts recorded</span></div><div class="tile"><span class="v">{pctf(max(s["chain"] for s in dry["summary"] if not s["recogniser"].startswith("text")) if dry else None)}</span><span class="k">best exact command on synthetic speech (dry run)</span></div><div class="tile"><span class="v">0</span><span class="k">real-voice numbers so far</span></div></div>'
        voice = f"""<div class="empty"><span class="pill next">Waiting for recordings · {n_rec} of {len(prompts)}</span>
      <p>This section fills in when the clips are scored. The same charts as the dry run above, split into validation airports, Sydney and own words, and the clips each recogniser got wrong.</p>
      <ol><li>Open <code>/voice/record.html#k=…</code> (the key is in <code>ml/data/gold/.key</code> on the server) in Chrome or Edge, so the browser recogniser runs too.</li>
      <li>Read the 100 prompts; about 15 minutes. Any prefix of the set is already a fair mix.</li>
      <li>On the server: <code>ml/.venv/bin/python ml/stt/score_gold.py score</code> (CPU, about 10 minutes for 100 clips). It rebuilds this page.</li></ol></div>"""
    ceil_tile = ""
    if ceil:
        ceil_tile = (f'<div class="tile"><span class="v">{ceil["chain"]} / {ceil["n"]}</span><span class="k">read prompts the chain gets right from a perfect transcript '
                     f'(rules alone {ceil["l0"]}, sent wrong {ceil["sent_wrong"]}): the ceiling</span></div>')
    dry_html = ""
    if dry:
        dry_html = f"""
<section aria-labelledby="h-dry">
  <div class="eyebrow">Dry run · synthetic speech</div>
  <h2 id="h-dry">The pipeline, proven on {dry["clips"]} Kokoro clips</h2>
  <p>Kokoro-82M clips from the GPU bake-off (six voices), posted through the real API handler into a temp gold directory and scored exactly like a recording. These are not your voice: they check that storage, recognisers, rules, model and report all work, and give the synthetic baseline to compare with.</p>
  {results(dry, "h-dry-exact")}
  <p class="note">"text (perfect STT)" feeds the prompt text itself: the ceiling for the rules and the model when the recogniser is perfect. Built {e(dry["built"])}, model <code>{e(dry["model"])}</code>.</p>
</section>"""
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>OpenATC Voice Gold Set</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>{CSS}</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="eyebrow">OpenATC · AI engineering log · {e(built)}</div>
  <h1>Real-voice gold set</h1>
  <p class="lede">So far every voice number came from synthetic speech. This is the yardstick for a real voice: 100 fixed prompts, recorded once on a phone or laptop, then scored with several recognisers and the same rules and model the game ships.</p>
  <div class="meta"><span>Record: <code>/voice/record.html</code> (needs the key)</span><span>Score: <code>ml/stt/score_gold.py</code></span><span>How-to: <code>ml/stt/GOLD.md</code></span><span><a href="/reports/voice-ai.html">Voice AI plan</a></span><span><a href="/reports/voice-demo.html">Try the model</a></span></div>
  {headline}
</header>

<section aria-labelledby="h-how">
  <div class="eyebrow">How it works</div>
  <h2 id="h-how">From your microphone to a score</h2>
  <div class="flow" role="list">
    <div class="node" role="listitem"><span class="tag">record.html</span><h3>Microphone</h3><p>Hold to talk. The game's 16 kHz capture worklet, same echo / noise / gain settings. Web Speech runs live beside it.</p></div>
    <div class="node" role="listitem"><span class="tag">16 kHz mono WAV + JSON</span><h3>Clip</h3><p>PCM WAV, plus what the browser heard, its alternatives, the mic settings and the take number.</p></div>
    <div class="node" role="listitem"><span class="tag">POST /api/voice/gold</span><h3>Server</h3><p>Secret key in a header, WAV format and sizes checked, filename from the prompt id. Stored in <code>ml/data/gold</code>, never in git.</p></div>
    <div class="node" role="listitem"><span class="tag">CPU · 2 threads</span><h3>Recognisers</h3><p>Whisper base (with and without the callsigns as a prompt), Moonshine tiny and base, plus the stored browser transcript.</p></div>
    <div class="node key" role="listitem"><span class="tag">understand.ts in node</span><h3>Rules, then model</h3><p>The shipped chain: rules parser, else the int8 S1 model, callsign fusion and the confidence gate.</p></div>
    <div class="node" role="listitem"><span class="tag">scores.json · .md · this page</span><h3>Scores</h3><p>WER, callsign, exact command, what the game would do, and every miss.</p></div>
  </div>
</section>

<section aria-labelledby="h-set">
  <div class="eyebrow">The prompt set</div>
  <h2 id="h-set">100 prompts, fixed and seeded</h2>
  <div class="tiles">
    <div class="tile"><span class="v"><i style="background:var(--s-val)"></i>{g["val"]}</span><span class="k">validation sessions, 11 airports: read aloud</span></div>
    <div class="tile"><span class="v"><i style="background:var(--s-syd)"></i>{g["sydney"]}</span><span class="k">Sydney, the airport the model never saw: read aloud</span></div>
    <div class="tile"><span class="v"><i style="background:var(--s-free)"></i>{g["free"]}</span><span class="k">own words: only the intent is shown</span></div>
    <div class="tile"><span class="v">{kinds}</span><span class="k">command kinds, including 3 “say again” traps</span></div>
    {ceil_tile}
  </div>
  <div class="chart">
    <div class="chart-head"><h3>Prompts per command kind</h3>{legend([("--s-val", "Validation"), ("--s-syd", "Sydney"), ("--s-free", "Own words")])}</div>
    <div class="rows" role="list">{composition(prompts)}</div>
    <p class="note">Slots per kind grow with the square root of how common the kind is in the data: common kinds get more, rare ones still get one. The sentences are the engine's own phrasing (FAA wording at US airports, ICAO elsewhere), so the right command is known exactly. Phrases the rules read as a different command are left out (the engine says “give way to the Qantas, then continue” for a single give-way, and names a turn direction the AI left open in cancel-approach), so those two kinds are not in the set. Recording order interleaves the groups (each block of 10 = 6 validation, 3 Sydney, 1 own words). Validation airports: {e(airports(prompts))}.</p>
  </div>
</section>
{dry_html}

<section aria-labelledby="h-real-title">
  <div class="eyebrow">Your voice</div>
  <h2 id="h-real-title">Real speech</h2>
  {voice}
</section>

<section aria-labelledby="h-run">
  <div class="eyebrow">Commands</div>
  <h2 id="h-run">Record, score, rebuild</h2>
<pre>ml/.venv/bin/python ml/stt/score_gold.py prompts     # rebuild the prompt set (seeded; already done)
ml/.venv/bin/python ml/stt/score_gold.py score       # every clip in ml/data/gold -> scores + this page
ml/.venv/bin/python ml/stt/score_gold.py dryrun      # the same pipeline on Kokoro clips
python3 ml/report/build_gold.py                      # this page only</pre>
</section>

</div>
</body>
</html>
"""
    OUT.write_text(page)
    print(f"wrote {OUT} ({len(page) // 1024} KB; {n_rec} recorded, dry run {'yes' if dry else 'no'}, real {'yes' if real else 'no'})")


if __name__ == "__main__":
    main(sys.argv[1:])

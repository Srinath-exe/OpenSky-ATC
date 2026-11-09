"""Writes the listening page public/reports/voice-tts-samples.html from public/reports/audio/tts/samples.json
(ml/tts/samples.py, plus the Audio8 clips ml/tts/audio8.py adds under "extra"). Standalone: no script, no fetch.

    python3 ml/tts/samples_page.py
"""
import html, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUD = ROOT / "public/reports/audio/tts"
man = json.load(open(AUD / "samples.json"))
VOICE = {"af_heart": "US female", "am_puck": "US male", "bf_isabella": "UK female", "bm_fable": "UK male"}
ORDER = [("paradee", "af_heart"), ("paradee", "am_puck"), ("paradee", "bf_isabella"), ("paradee", "bm_fable"), ("kokoro", "af_heart")]
e = html.escape


def player(src, label):
    return f'<audio controls preload="none" src="audio/tts/{e(src)}" aria-label="{e(label)}"></audio>'


def row(model, voice, clip, text):
    name = "Paradee-8M" if model == "paradee" else "Kokoro-82M"
    tag = "" if model == "paradee" else '<span class="ref">reference</span>'
    lab = f"{name} {voice}"
    return f'''<div class="row{' kok' if model != 'paradee' else ''}">
  <div class="who"><b>{name}</b>{tag}<span>{e(voice)} · {VOICE.get(voice, '')}</span></div>
  <div class="pl"><span class="k">Dry</span>{player(clip["dry"], f"{lab}, dry: {text}")}</div>
  <div class="pl"><span class="k">Radio</span>{player(clip["radio"], f"{lab}, radio: {text}")}</div>
</div>'''


cards = []
for ln in man["lines"]:
    clips = {(c["model"], c["voice"]): c for c in ln["clips"]}
    rows = "\n".join(row(m, v, clips[(m, v)], ln["text"]) for m, v in ORDER if (m, v) in clips)
    cards.append(f'''<article class="card">
  <div class="head"><span class="num">{ln["id"]:02d}</span><span class="icao">{e(ln.get("icao", ""))}</span><span class="note">{e(ln.get("note", ""))}</span></div>
  <p class="said">“{e(ln["text"])}”</p>
  <div class="rows">{rows}</div>
</article>''')

extra = man.get("extra", [])
extra_html = ""
if extra:
    groups = {}
    for x in extra:
        groups.setdefault(x["text"], []).append(x)
    ex_cards = []
    for i, (text, xs) in enumerate(groups.items()):
        dry = next((x for x in xs if x.get("kind") == "Dry"), xs[0]); rad = next((x for x in xs if x.get("kind") == "Radio"), None)
        note = next((x.get("note") for x in xs if x.get("note")), "")
        ex_cards.append(f'''<article class="card">
  <div class="head"><span class="num">A{i + 1}</span><span class="note">{e(note)}</span></div>
  <p class="said">“{e(text)}”</p>
  <div class="rows"><div class="row">
  <div class="who"><b>Audio8 Realistic Air</b><span>{e(dry.get("voice", ""))}</span></div>
  <div class="pl"><span class="k">Dry</span>{player(dry["file"], "Audio8, dry: " + text)}</div>
  {f'<div class="pl"><span class="k">Radio</span>{player(rad["file"], "Audio8, radio: " + text)}</div>' if rad else ""}
</div></div>
</article>''')
    extra_html = f'''<section>
  <h2>A big model for comparison</h2>
  <p>{e(man.get("extra_note", ""))}</p>
  <div class="cards">{"".join(ex_cards)}</div>
</section>'''

page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Pilot Voice Samples</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>
/* Same tokens as voice-ai.html: dark first, like the game. */
:root {{
  --bg: #0e0f11; --surface: #141416; --raise: #1c1c1e; --line: rgba(255,255,255,.09); --line-strong: rgba(255,255,255,.16);
  --ink-1: #f4f4f5; --ink-2: #c4c5c8; --ink-3: #a0a1a6; --ink-4: #7f8086;
  --accent: #f5933f; --accent-tint: rgba(245,147,63,.14); --neutral-tint: rgba(255,255,255,.07);
  --font: "DM Sans", "Helvetica Neue", Arial, sans-serif; --mono: "DM Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: dark;
}}
@media (prefers-color-scheme: light) {{ :root:not([data-theme="dark"]) {{
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12); --neutral-tint: rgba(20,20,24,.06);
  color-scheme: light;
}} }}
:root[data-theme="light"] {{
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12); --neutral-tint: rgba(20,20,24,.06);
  color-scheme: light;
}}
* {{ box-sizing: border-box; }}
html {{ -webkit-text-size-adjust: 100%; }}
body {{ margin: 0; background: var(--bg); color: var(--ink-2); font-family: var(--font); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 40px 72px; }}
.wrap {{ max-width: 960px; margin: 0 auto; display: grid; gap: 40px; }}
h1, h2 {{ color: var(--ink-1); margin: 0; font-weight: 600; letter-spacing: -.01em; text-wrap: balance; }}
h1 {{ font-size: clamp(28px, 4.4vw, 40px); line-height: 1.12; }}
h2 {{ font-size: 22px; line-height: 1.25; }}
p {{ margin: 0; max-width: 68ch; }}
a {{ color: var(--accent); text-underline-offset: 2px; }}
a:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }}
code {{ font-family: var(--mono); font-size: .9em; }}
.eyebrow {{ font-size: 11.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }}
header, section {{ display: grid; gap: 14px; min-width: 0; }}
.lede {{ font-size: 17px; max-width: 62ch; }}
.meta {{ display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--ink-3); font-size: 13px; }}
.cards {{ display: grid; gap: 16px; }}
.card {{ background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; display: grid; gap: 12px; min-width: 0; }}
.head {{ display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }}
.num {{ font-family: var(--mono); font-size: 12px; color: var(--ink-4); }}
.icao {{ font-family: var(--mono); font-size: 12px; color: var(--ink-3); }}
.note {{ font-size: 12.5px; color: var(--ink-3); }}
.said {{ color: var(--ink-1); font-size: 16px; line-height: 1.45; overflow-wrap: anywhere; }}
.rows {{ display: grid; gap: 0; border-top: 1px solid var(--line); }}
.row {{ display: grid; grid-template-columns: 170px minmax(0, 1fr) minmax(0, 1fr); gap: 6px 14px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); min-width: 0; }}
.row:last-child {{ border-bottom: 0; }}
.row.kok .who b {{ color: var(--ink-2); }}
.who {{ display: grid; gap: 0; font-size: 13px; line-height: 1.35; min-width: 0; }}
.who b {{ color: var(--ink-1); font-weight: 600; }}
.who span {{ color: var(--ink-3); font-size: 12px; font-family: var(--mono); }}
.ref {{ justify-self: start; font-family: var(--font) !important; font-size: 11px !important; font-weight: 600; letter-spacing: .02em; color: var(--accent) !important; background: var(--accent-tint); border-radius: 999px; padding: 0 8px; margin: 2px 0; }}
.pl {{ display: grid; grid-template-columns: 44px minmax(0, 1fr); align-items: center; gap: 8px; min-width: 0; }}
.pl.wide {{ grid-column: span 2; }}
.k {{ font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-4); font-weight: 600; }}
audio {{ width: 100%; min-width: 0; height: 36px; display: block; }}
.x-said {{ grid-column: 1 / -1; font-size: 13.5px; color: var(--ink-2); }}
.x-said span {{ color: var(--ink-3); }}
footer {{ font-size: 13px; color: var(--ink-3); display: grid; gap: 8px; }}
@media (max-width: 720px) {{
  .row {{ grid-template-columns: minmax(0, 1fr); }}
  .pl.wide {{ grid-column: auto; }}
}}
</style>
</head>
<body>
<main class="wrap">
<header>
  <span class="eyebrow">OpenATC · pilot voices</span>
  <h1>Pilot voices: listen</h1>
  <p class="lede">Eight readbacks taken from the game's own phraseology, each read by the four voices of Paradee-8M v1.2, the 8.5 MB model that is meant to run in your browser, and by Kokoro-82M, the 82M-parameter model it was distilled from. Each clip comes dry and through the radio effect the game will use.</p>
  <div class="meta"><span>Paradee int8 ONNX, CPU</span><span>Kokoro-82M, PyTorch CPU</span><span>Radio: 300–3400 Hz band-pass, soft compression, faint hiss, squelch clicks</span></div>
  <p class="meta">Measurements (speed, word error rate, browser latency) are in the <a href="voice-tts.html">pilot voice report</a>.</p>
</header>
<section class="cards" aria-label="Readbacks">
{chr(10).join(cards)}
</section>
{extra_html}
<footer>
  <p>The same callsign always gets the same voice in the game; here every line is read by every voice so you can compare them. Each audio file loads only when you press play.</p>
  <p>Paradee-8M v1.2 by Sahil Mahendrakar and Kokoro-82M by hexgrad are Apache-2.0. Clips made by <code>ml/tts/samples.py</code>.</p>
</footer>
</main>
</body>
</html>
'''
(ROOT / "public/reports/voice-tts-samples.html").write_text(page)
print("wrote public/reports/voice-tts-samples.html", len(page), "bytes,", sum(len(l["clips"]) for l in man["lines"]) * 2 + len(extra), "players")

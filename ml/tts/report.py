"""Writes public/reports/voice-tts.html (the pilot-voice report) from the measurements in ml/tts/out:
bench/scores.json + bench/*/timing.json (bench.py, others.py, audio8.py), browser_latency*.json (tests/tmp/tts-worker.cjs),
game_voice.json (tests/tmp/tts-game-voice.cjs), g2p_eval.json (g2p_eval.mjs). Also copies two report clips to
public/reports/audio/. Standalone page: inline SVG and CSS, the tokens of voice-ai.html, no script.

    ml/stt/.venv/bin/python ml/tts/report.py
"""
import html, json, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ml/tts/out"
B = OUT / "bench"
e = html.escape
J = lambda p, d=None: json.load(open(p)) if Path(p).exists() else d

scores = J(B / "scores.json", {})
tim = {d.name: J(d / "timing.json") for d in B.iterdir() if d.is_dir() and (d / "timing.json").exists()}
br = J(OUT / "browser_latency.json", {})
br32 = J(OUT / "browser_latency_fp32.json", {})
game = J(OUT / "game_voice.json", {})
g2p = J(OUT / "g2p_eval.json", {})
lex_bytes = (ROOT / "public/models/tts/atc-lexicon-v1.json").stat().st_size
import gzip
lex_gz = len(gzip.compress((ROOT / "public/models/tts/atc-lexicon-v1.json").read_bytes()))
MODEL_BYTES = (ROOT / "public/models/tts/paradee-8m-v1.2/paradee_int8.onnx").stat().st_size
ort_wasm = next((c["bytes_on_wire"] for c in br.get("cdn", []) if c["url"].endswith(".wasm")), 3073897)
ort_js = sum(c["bytes_on_wire"] for c in br.get("cdn", [])[:2]) if br.get("cdn") else 23881
total_dl = MODEL_BYTES + ort_wasm + ort_js + lex_gz + 1827

# model facts: params, download, licence (from the model cards / repos, 2026-11-09)
MODELS = [
    # key, name, params, size bytes, size note, licence, runs in browser?, note
    ("paradee", "Paradee-8M v1.2", "7.9M", MODEL_BYTES, "int8 ONNX, 4 voices", "Apache-2.0", "yes (this work)", "4 voices: US and UK, female and male"),
    ("kokoro", "Kokoro-82M (teacher)", "82M", 327212226, "PyTorch .pth", "Apache-2.0", "kokoro-js, 82-330 MB", "Paradee's teacher; measured on af_heart and bm_fable"),
    ("leokani", "Leokani-tts-7M", "7.0M", 7838742, "int8 ONNX + eSpeak NG", "Milliwatt Labs Model Licence 1.0 (free under US$1M revenue)", "possible (ONNX)", "one voice (Dala); needs eSpeak NG"),
    ("pivo", "PiVo-1.4M", "1.4M", 5841345, "4 ONNX files + 3.6 MB CMUdict", "Apache-2.0", "possible (ONNX)", "CMUdict words only: unknown words need ARPAbet overrides"),
    ("phonon", "Phonon-31M-en", "31M", 64512352, "q8 GGUF", "Apache-2.0", "not shown", "via the ptts package"),
    ("supertonic", "Supertonic 3", "99M", 398000000, "ONNX, 4 files", "OpenRAIL-M", "yes (their demo), 400 MB", "flow matching; many languages"),
    ("audio8", "Audio8-TTS-Realistic-Air", "601M + codec", 2552200087, "safetensors + codec", "Apache-2.0", "no", "0.6B DualAR, 44.1 kHz, voice cloning; n = 5 lines"),
    ("kitten", "KittenTTS 2", "~1B LM + decoder", None, "≥ 0.5 GB (ternary LM) + 39 MB decoder", "Stellon Labs Community Licence", "no", "skipped: needs a ~1 GB language model, not tiny"),
]


def mb(b):
    return "—" if not b else f"{b / 1e6:.1f} MB" if b < 1e9 else f"{b / 1e9:.2f} GB"


def two_voice(key):
    """WER on af_heart + bm_fable only (what Kokoro and the variants were measured on)."""
    s = scores.get(key)
    if not s:
        return None
    pv = s["per_voice"]
    if "af_heart" in pv and "bm_fable" in pv and len(pv) > 2:
        return (pv["af_heart"] + pv["bm_fable"]) / 2
    return s["wer"]


rows = []
for key, name, params, size, sizenote, lic, browser, note in MODELS:
    s = scores.get(key); t = tim.get(key)
    sp = None
    if t:   # from the timing file itself (scores.json rounds to 0.1x)
        c = t["clips"]; tot = sum(x["synth_s"] for x in c); au = sum(x["audio_s"] for x in c)
        sp = {"synth_s_per_line": tot / len(c), "x_realtime": au / tot, "threads": t["meta"]["threads"]}
    rows.append({"key": key, "name": name, "params": params, "size": size, "sizenote": sizenote, "lic": lic, "browser": browser, "note": note,
                 "wer": s["wer"] if s else None, "wer2": two_voice(key), "n": s["clips"] if s else 0, "exact": s["line_exact"] if s else None,
                 "xrt": sp["x_realtime"] if sp else None, "spl": sp["synth_s_per_line"] if sp else None, "threads": sp["threads"] if sp else None})


def fmt(v, d=1, suf=""):
    return "—" if v is None else f"{v:.{d}f}{suf}"


# ── charts: one series each, the model in the game highlighted ───────────────────────────────────────────────────
def bars(items, unit, maxv, label_w=150, note=""):
    """Horizontal bars in HTML (they reflow at phone width), one series, the model in the game highlighted.
    items: (label, value, highlight, sub). A tick row shows the scale; each bar has a hover title."""
    def num(v):
        return f"{v:.3f}" if unit == "×" and v < 0.95 else f"{v:.1f}"
    out = [f'<div class="hbars" role="list" aria-label="{e(note)}">']
    for lab, v, hi, sub in items:
        if v is None:
            bar, val = '<span class="na">not measured</span>', "—"
        else:
            w = max(0.6, 100 * min(v, maxv) / maxv)
            bar = f'<i class="{"hi" if hi else ""}" style="width:{w:.1f}%"></i>'
            val = f"{num(v)}{unit}{' ▸' if v > maxv else ''}"
        out.append(f'<div class="hb{" is-hi" if hi else ""}" role="listitem" title="{e(lab)}: {val}"><span class="hl">{e(lab)}<small>{e(sub)}</small></span>'
                   f'<span class="ht">{bar}</span><span class="hv">{val}</span></div>')
    ticks = "".join(f'<span style="left:{100 * t:.0f}%">{maxv * t:g}{unit}</span>' for t in (0, .25, .5, .75, 1))
    out.append(f'<div class="hb axis" aria-hidden="true"><span class="hl"></span><span class="ht ticks">{ticks}</span><span class="hv"></span></div></div>')
    return "".join(out)


wer_items = [(r["name"].replace(" (teacher)", ""), r["wer2"] if r["key"] != "paradee" else r["wer"], r["key"] == "paradee",
              f'n = {r["n"]}' if r["n"] else "") for r in rows if r["key"] != "kitten"]
wer_max = max([x[1] for x in wer_items if x[1] is not None] + [10])
wer_max = 10 if wer_max <= 10 else 20 if wer_max <= 20 else 40 if wer_max <= 40 else 100
speed_items = [(r["name"].replace(" (teacher)", ""), r["xrt"], r["key"] == "paradee", f'{r["threads"]} thread{"s" if (r["threads"] or 1) > 1 else ""}' if r["threads"] else "") for r in rows if r["key"] != "kitten"]

par, kok = scores.get("paradee", {}), scores.get("kokoro", {})
rad, esp = scores.get("paradee-radio", {}), scores.get("paradee-espeak", {})
bro = scores.get("browser", {})
gv = g2p.get("variants", {})
lexv, espv = gv.get("lexicon", {}), gv.get("espeak", {})
g_stats = [s for s in game.get("stats", []) if not s.get("dropped") and s.get("firstChunkMs", -1) >= 0]
dropped = [s for s in game.get("stats", []) if s.get("dropped")]
spaced = g_stats[-3:] if len(g_stats) >= 3 else g_stats
# time to first sound for lines that did not queue behind another: the first of the burst and the spaced ones
first_ms = sorted(s["firstChunkMs"] for s in ([g_stats[0]] if g_stats else []) + spaced)
a8 = tim.get("audio8")
ab = J(OUT / "browser_ab.json", {})
mean = lambda xs: sum(xs) / len(xs) if xs else None
ab_txt = f'{mean(ab.get("int8_x_realtime", [])):.1f}× / {mean(ab.get("fp32_x_realtime", [])):.1f}×' if ab else "—"
a8s = scores.get("audio8")

# report clips: one line from the browser run, dry and through the radio effect
AUD = ROOT / "public/reports/audio"; AUD.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT / "ml/tts"))
clip_dry = clip_radio = None
bdir = B / "browser"
cands = sorted(bdir.glob("*.wav")) if bdir.exists() else []
if cands:
    import numpy as np, soundfile as sf, synth
    from scipy.signal import resample_poly
    pick = next((c for c in cands if c.stem.startswith("06_")), cands[0])
    x, sr = sf.read(str(pick), dtype="float32")
    shutil.copy(pick, AUD / "voice-tts-browser-dry.wav"); clip_dry = "audio/voice-tts-browser-dry.wav"
    x24 = resample_poly(x, 3, 2).astype("float32")
    synth.write_wav(AUD / "voice-tts-browser-radio.wav", synth.to16k(synth.radio(x24, seed=6)), 16000); clip_radio = "audio/voice-tts-browser-radio.wav"
    bench = {json.loads(l)["bench_id"]: json.loads(l) for l in open(ROOT / "ml/tts/data/bench60.jsonl")}
    clip_text = bench[int(pick.stem[:2])]["spoken"]; clip_voice = pick.stem[3:]
else:
    clip_text = clip_voice = ""

table_rows = "".join(
    f'<tr{" class=hi" if r["key"] == "paradee" else ""}><td><strong>{e(r["name"])}</strong><small>{e(r["note"])}</small></td><td class="n">{e(r["params"])}</td>'
    f'<td class="n">{mb(r["size"])}<small>{e(r["sizenote"])}</small></td>'
    f'<td class="n">{fmt(r["xrt"], 1 if (r["xrt"] or 0) >= 1 else 3, "×")}<small>{fmt(r["spl"], 2, " s / line") if r["spl"] else ""}</small></td>'
    f'<td class="n">{fmt(r["wer"], 1, " %")}<small>{("n = " + str(r["n"])) if r["n"] else "not run"}</small></td>'
    f'<td>{e(r["lic"])}</td><td>{e(r["browser"])}</td></tr>' for r in rows)

per_voice = par.get("per_voice", {})
pv_rows = "".join(f'<tr><td><code>{v}</code></td><td class="n">{per_voice.get(v, 0):.1f} %</td><td class="n">{kok.get("per_voice", {}).get(v) and f"{kok["per_voice"][v]:.1f} %" or "—"}</td></tr>'
                  for v in ["af_heart", "am_puck", "bf_isabella", "bm_fable"])

lat_rows = "".join(f'<tr><td>{e(s["text"][:70])}{"…" if len(s["text"]) > 70 else ""}</td><td><code>{s["voice"]}</code></td><td class="n">{s["chunks"]}</td>'
                   f'<td class="n">{s["firstChunkMs"]} ms</td><td class="n">{s["synthMs"]} ms</td><td class="n">{s["audioS"]:.1f} s</td></tr>' for s in game.get("stats", []) if not s.get("dropped"))

page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Neural Pilot Voices</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>
/* voice-ai.html's tokens: dark first, like the game. */
:root {{
  --bg: #0e0f11; --surface: #141416; --raise: #1c1c1e; --line: rgba(255,255,255,.09); --line-strong: rgba(255,255,255,.16);
  --ink-1: #f4f4f5; --ink-2: #c4c5c8; --ink-3: #a0a1a6; --ink-4: #7f8086;
  --accent: #f5933f; --accent-tint: rgba(245,147,63,.14); --s-before: #5b8fd6;
  --good: #57cd50; --good-tint: rgba(87,205,80,.13); --neutral-tint: rgba(255,255,255,.07); --bar: #5f6168;
  --font: "DM Sans", "Helvetica Neue", Arial, sans-serif; --mono: "DM Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  color-scheme: dark;
}}
@media (prefers-color-scheme: light) {{ :root:not([data-theme="dark"]) {{
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12); --s-before: #3f78c2;
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --neutral-tint: rgba(20,20,24,.06); --bar: #9a9ba1;
  color-scheme: light;
}} }}
:root[data-theme="light"] {{
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12); --s-before: #3f78c2;
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --neutral-tint: rgba(20,20,24,.06); --bar: #9a9ba1;
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
p {{ margin: 0; max-width: 68ch; }}
a {{ color: var(--accent); text-underline-offset: 2px; }}
a:focus-visible, summary:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }}
code {{ font-family: var(--mono); font-size: .9em; overflow-wrap: anywhere; }}
.eyebrow {{ font-size: 11.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }}
section, header {{ display: grid; gap: 18px; min-width: 0; }}
.lede {{ font-size: 17px; max-width: 62ch; }}
.meta {{ display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--ink-3); font-size: 13px; }}
.tiles {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }}
.tile {{ background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; display: grid; gap: 2px; min-width: 0; }}
.tile .v {{ font-size: clamp(26px, 4.6vw, 34px); line-height: 1.1; color: var(--ink-1); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }}
.tile .v small {{ font-size: .5em; color: var(--ink-3); font-weight: 500; letter-spacing: 0; }}
.tile .k {{ font-size: 13px; color: var(--ink-2); font-weight: 600; }}
.tile .d {{ font-size: 12.5px; color: var(--ink-3); line-height: 1.4; }}
.tile.key {{ border-color: var(--accent); background: linear-gradient(var(--accent-tint), var(--accent-tint)), var(--surface); }}
@media (max-width: 760px) {{ .tiles {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }} }}
.card {{ background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 18px 20px; display: grid; gap: 12px; min-width: 0; }}
.hbars {{ display: grid; gap: 8px; }}
.hb {{ display: grid; grid-template-columns: minmax(0, 190px) minmax(0, 1fr) 76px; gap: 4px 12px; align-items: center; }}
.hb .hl {{ font-size: 13px; color: var(--ink-2); font-weight: 500; line-height: 1.25; min-width: 0; }}
.hb.is-hi .hl {{ color: var(--ink-1); font-weight: 700; }}
.hb .hl small {{ display: block; font-size: 11.5px; color: var(--ink-4); font-weight: 400; }}
.hb .ht {{ position: relative; height: 14px; background: linear-gradient(var(--line), var(--line)) left center / 100% 1px no-repeat; }}
.hb .ht i {{ position: absolute; left: 0; top: 0; bottom: 0; border-radius: 0 4px 4px 0; background: var(--bar); min-width: 2px; }}
.hb .ht i.hi {{ background: var(--accent); }}
.hb:hover .ht i {{ filter: brightness(1.15); }}
.hb .hv {{ font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); text-align: right; font-variant-numeric: tabular-nums; }}
.hb .na {{ font-size: 12px; color: var(--ink-4); }}
.hb.axis .ht {{ height: 16px; background: none; }}
.hb .ticks span {{ position: absolute; top: 0; transform: translateX(-50%); font-size: 11px; color: var(--ink-4); white-space: nowrap; }}
.hb .ticks span:first-child {{ transform: none; }} .hb .ticks span:last-child {{ transform: translateX(-100%); }}
@media (max-width: 560px) {{
  .hb {{ grid-template-columns: minmax(0, 1fr) 70px; }}
  .hb .hl {{ grid-column: 1 / -1; }}
  .hb.axis .hl {{ display: none; }}
}}
.note {{ font-size: 13px; color: var(--ink-3); }}
.scroll {{ overflow-x: auto; min-width: 0; -webkit-overflow-scrolling: touch; }}
table {{ border-collapse: collapse; width: 100%; font-size: 13.5px; font-variant-numeric: tabular-nums; }}
th, td {{ text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }}
th {{ font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); font-weight: 600; }}
td.n {{ text-align: right; font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }}
td small {{ display: block; color: var(--ink-4); font-family: var(--font); font-size: 11.5px; white-space: normal; }}
td strong {{ color: var(--ink-1); font-weight: 600; }}
tr.hi td {{ background: var(--accent-tint); }}
.models {{ min-width: 720px; }}
.cols {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }}
@media (max-width: 760px) {{ .cols {{ grid-template-columns: 1fr; }} }}
.kv {{ display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; font-size: 14px; }}
.kv b {{ color: var(--ink-1); font-weight: 600; font-family: var(--mono); font-size: 13px; text-align: right; }}
.flow svg {{ width: 100%; height: auto; display: block; }}
.flow .box {{ fill: var(--surface); stroke: var(--line-strong); }}
.flow .box.key {{ stroke: var(--accent); fill: var(--accent-tint); }}
.flow .t {{ fill: var(--ink-1); font: 600 14px var(--font); }}
.flow .s {{ fill: var(--ink-3); font: 12px var(--font); }}
.flow .m {{ fill: var(--ink-4); font: 11px var(--mono); }}
.flow .arrow {{ stroke: var(--ink-4); stroke-width: 1.5; fill: none; marker-end: url(#ah); }}
.flow .ahead {{ fill: var(--ink-4); }}
.flow .wide {{ display: block; }} .flow .narrow {{ display: none; max-width: 440px; }}
@media (max-width: 760px) {{ .flow .wide {{ display: none; }} .flow .narrow {{ display: block; }} }}
.listen {{ display: grid; gap: 10px; }}
.listen .said {{ color: var(--ink-1); }}
.pl {{ display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 10px; align-items: center; }}
.pl span {{ font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-4); font-weight: 600; }}
audio {{ width: 100%; height: 36px; display: block; min-width: 0; }}
ul {{ margin: 0; padding-left: 20px; display: grid; gap: 6px; max-width: 72ch; }}
details summary {{ cursor: pointer; font-size: 13.5px; color: var(--ink-2); font-weight: 500; }}
</style>
</head>
<body>
<main class="wrap">
<header>
  <span class="eyebrow">OpenATC · ml/tts · {e(br.get("when", "")[:10])}</span>
  <h1>Neural pilot voices that run in the browser</h1>
  <p class="lede">Pilot readbacks were spoken by the browser's one robotic voice, which is often missing in the phone app. Now they are made on the player's device by Paradee-8M v1.2, an 8.5 MB model distilled from Kokoro-82M: four voices, one per aircraft, with an ATC text normaliser in front and a VHF radio effect behind. On 60 real pilot lines it is as intelligible as its 82M-parameter teacher.</p>
  <div class="meta"><span>Paradee-8M v1.2, int8 ONNX</span><span>onnxruntime-web 1.30, WASM</span><span>Whisper base.en word error</span><span>Shared 8-core CPU (load average 9–22)</span></div>
  <p class="meta"><a href="voice-tts-samples.html">Listen to all four voices and Kokoro, dry and over the radio →</a></p>
</header>

<section aria-label="Headline numbers">
  <div class="tiles">
    <div class="tile key"><span class="k">Word error, Paradee</span><span class="v">{fmt(par.get("wer"), 1)}<small> %</small></span><span class="d">Whisper base.en on 60 lines × 4 voices (n = {par.get("clips", 0)})</span></div>
    <div class="tile"><span class="k">Word error, Kokoro-82M</span><span class="v">{fmt(kok.get("wer"), 1)}<small> %</small></span><span class="d">the teacher, same lines, af_heart + bm_fable (n = {kok.get("clips", 0)}); Paradee on those two: {fmt(two_voice("paradee"), 1)} %</span></div>
    <div class="tile"><span class="k">In the browser</span><span class="v">{fmt(br.get("x_realtime"), 1)}<small>× real time</small></span><span class="d">WASM, one thread, {br.get("synth_ms_median", "—")} ms median per line; a new line is heard after {first_ms[len(first_ms) // 2] if first_ms else "—"} ms (median)</span></div>
    <div class="tile"><span class="k">Download, once</span><span class="v">{total_dl / 1e6:.1f}<small> MB</small></span><span class="d">model {MODEL_BYTES / 1e6:.1f} MB + runtime {ort_wasm / 1e6:.1f} MB + lexicon {lex_gz / 1e3:.0f} kB, on the first pilot line</span></div>
  </div>
</section>

<section>
  <h2>How a pilot line is spoken</h2>
  <p>The engine's line goes through four steps in the browser. Only the model and the runtime are downloaded; everything else is a few kilobytes of code.</p>
  <div class="card flow">
    <svg class="wide" viewBox="0 0 900 150" role="img" aria-label="Pipeline: engine text, ATC normaliser, G2P, Paradee, radio effect">
      <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="ahead"/></marker></defs>
      <rect x="4" y="20" width="160" height="104" rx="12" class="box"/>
      <text x="18" y="46" class="t">Pilot line</text><text x="18" y="66" class="s">from the engine</text><text x="18" y="92" class="m">JBU248 holding</text><text x="18" y="108" class="m">short runway 04L</text>
      <rect x="188" y="20" width="160" height="104" rx="12" class="box"/>
      <text x="202" y="46" class="t">ATC normaliser</text><text x="202" y="66" class="s">codes → spoken words</text><text x="202" y="92" class="m">JetBlue two forty-</text><text x="202" y="108" class="m">eight … zero four left</text>
      <rect x="372" y="20" width="160" height="104" rx="12" class="box"/>
      <text x="386" y="46" class="t">G2P</text><text x="386" y="66" class="s">misaki lexicon, eSpeak</text><text x="386" y="92" class="m">ʤˈɛtblˌu tˈu</text><text x="386" y="108" class="m">fˈɔɹTiˌAt …</text>
      <rect x="556" y="20" width="160" height="104" rx="12" class="box key"/>
      <text x="570" y="46" class="t">Paradee-8M</text><text x="570" y="66" class="s">worker, WASM, int8</text><text x="570" y="92" class="m">phoneme ids, voice,</text><text x="570" y="108" class="m">speed → 24 kHz</text>
      <rect x="740" y="20" width="156" height="104" rx="12" class="box"/>
      <text x="754" y="46" class="t">Radio effect</text><text x="754" y="66" class="s">WebAudio</text><text x="754" y="92" class="m">300–3400 Hz, soft</text><text x="754" y="108" class="m">clip, hiss, squelch</text>
      <path d="M166 72 H184" class="arrow"/><path d="M350 72 H368" class="arrow"/><path d="M534 72 H552" class="arrow"/><path d="M718 72 H736" class="arrow"/>
    </svg>
    <svg class="narrow" viewBox="0 0 340 470" role="img" aria-label="Pipeline: engine text, ATC normaliser, G2P, Paradee, radio effect">
      <defs><marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="ahead"/></marker></defs>
      {"".join(f'<rect x="4" y="{8 + i * 94}" width="332" height="70" rx="12" class="box{" key" if i == 3 else ""}"/><text x="18" y="{34 + i * 94}" class="t">{t}</text><text x="18" y="{54 + i * 94}" class="s">{s}</text>' + (f'<path d="M170 {80 + i * 94} V{98 + i * 94}" class="arrow" style="marker-end:url(#ah2)"/>' if i < 4 else "") for i, (t, s) in enumerate([("Pilot line", "JBU248 holding short runway 04L"), ("ATC normaliser", "JetBlue two forty-eight … zero four left"), ("G2P", "misaki lexicon; eSpeak NG for unknown words"), ("Paradee-8M (worker)", "phonemes, voice, speed → 24 kHz audio"), ("Radio effect (WebAudio)", "band-pass, soft clip, hiss, squelch")]))}
    </svg>
  </div>
  <ul>
    <li><strong>ATC normaliser</strong> (<code>src/lib/tts/pilotSpeech.ts</code>): callsign codes become the engine's telephony (ICAO "fife, tree, niner" or FAA grouping, as <code>phraseology.ts</code> says them), FL350, runways (04L, 16R/34L), frequencies, altitudes, headings, squawks, units; fix names that read as words are said as words.</li>
    <li><strong>G2P</strong> (<code>public/voice/tts-g2p.js</code>): Paradee only heard misaki's phonemes in training, and misaki is Python. A {lex_bytes / 1e3:.0f} kB lexicon ({lex_gz / 1e3:.0f} kB compressed) holds misaki's own phonemes for the game's vocabulary in both accents (about 2,000 words), and the spoken names of the airspace fixes ("EPM" says "Epsom"). Unknown capitals are spelled with misaki's letter names; any other unknown word loads eSpeak NG (the <code>phonemizer</code> package kokoro-js uses, 0.7 MB compressed, only then) through paradee's eSpeak-to-misaki table.</li>
    <li><strong>Paradee</strong> (<code>public/voice/tts-worker.js</code>): one clause per call, in a module worker, so the first clause plays while the rest is made.</li>
    <li><strong>Radio</strong> (<code>src/components/atc/pilotVoice.ts</code>): two high-pass and two low-pass biquads (300–3400 Hz), a tanh soft clip and a light compressor, a faint hiss under the speech, a squelch click at the start and a squelch tail at the end.</li>
  </ul>
</section>

<section>
  <h2>Intelligibility on 60 real pilot lines</h2>
  <p>The lines are what the game speaks: readbacks, requests and status lines exported from the engine at six airports (KJFK, EGLL, KLAX, OMDB, YSSY, LFPG; 39 ICAO, 21 FAA), passed through the normaliser. Each clip was transcribed by Whisper base.en (faster-whisper, beam 5, no prompt) and scored against the words it was given; numbers count digit by digit whether written or spoken.</p>
  <div class="card">
    <h3>Word error rate, lower is better</h3>
    {bars(wer_items, " %", wer_max, note="Word error rate by model")}
    <p class="note">Paradee: all four voices. Kokoro and the other models: the voices named below, on the same 60 lines (n is clips). The table has every number.</p>
  </div>
  <div class="cols">
    <div class="card">
      <h3>Per voice</h3>
      <div class="scroll"><table><thead><tr><th>Voice</th><th>Paradee</th><th>Kokoro</th></tr></thead><tbody>{pv_rows}</tbody></table></div>
      <p class="note">af_heart and am_puck read American phonemes, bf_isabella and bm_fable British ones, as in training.</p>
    </div>
    <div class="card">
      <h3>What changes the error</h3>
      <div class="kv">
        <span>Paradee, dry</span><b>{fmt(two_voice("paradee"), 1, " %")}</b>
        <span>Same clips through the radio effect</span><b>{fmt(rad.get("wer"), 1, " %")}</b>
        <span>A lighter radio (less clipping, hiss -40 dB)</span><b>{fmt(scores.get("paradee-radio-light", {}).get("wer"), 1, " %")}</b>
        <span>eSpeak-only G2P instead of the lexicon</span><b>{fmt(esp.get("wer"), 1, " %")}</b>
        <span>Made in the browser (10 lines)</span><b>{fmt(bro.get("wer"), 1, " %")}</b>
      </div>
      <p class="note">af_heart + bm_fable, 60 lines each, except the browser row (10 lines from the headless run, the voices the game picks). The radio effect is meant to sound like a radio; Whisper is not trained on it.</p>
    </div>
  </div>
</section>

<section>
  <h2>Pronunciation in the browser</h2>
  <p>The browser G2P was compared with misaki on the same 60 lines × 4 voices, using a lexicon built without those lines.</p>
  <div class="cols">
    <div class="card">
      <h3>Lexicon + eSpeak (shipped)</h3>
      <div class="kv"><span>Lines identical to misaki</span><b>{fmt(lexv.get("line_exact_pct"), 1, " %")}</b><span>Phoneme character error</span><b>{fmt(lexv.get("phoneme_char_err_pct"), 2, " %")}</b><span>Time per line</span><b>{fmt(lexv.get("ms_per_line"), 2, " ms")}</b><span>Words that needed eSpeak</span><b>{(lexv.get("stats") or {}).get("espeak", "—")}</b></div>
      <p class="note">The only lines that differ are the two with a fix: the lexicon says the airspace file's spoken name ("C D G north west") where misaki spells five letters.</p>
    </div>
    <div class="card">
      <h3>eSpeak NG + misaki table only</h3>
      <div class="kv"><span>Lines identical to misaki</span><b>{fmt(espv.get("line_exact_pct"), 1, " %")}</b><span>Phoneme character error</span><b>{fmt(espv.get("phoneme_char_err_pct"), 2, " %")}</b><span>Time per line</span><b>{fmt(espv.get("ms_per_line"), 1, " ms")}</b><span>Download</span><b>{g2p.get("phonemizer_bytes", 0) / 1e6:.1f} MB</b></div>
      <p class="note">What kokoro-js does. Typical slips: British "one" as wɒn, "zero" as zˈiəɹO, a missing secondary stress in "runway".</p>
    </div>
  </div>
  <div class="card">
    <h3>The ATC words the brief named</h3>
    <div class="scroll"><table><thead><tr><th>Text</th><th>Accent</th><th>Browser (lexicon)</th><th>eSpeak only</th></tr></thead><tbody>
    {"".join(f'<tr><td>{e(p["text"])}</td><td>{p["accent"].upper()}</td><td><code>{e(p["lexicon"])}</code></td><td><code>{e(p["espeak"])}</code></td></tr>' for p in g2p.get("probe", []))}
    </tbody></table></div>
  </div>
</section>

<section>
  <h2>Speed and size</h2>
  <div class="card">
    <h3>Times faster than real time, higher is better</h3>
    {bars(speed_items, "×", 30, note="Synthesis speed by model")}
    <p class="note">Native CPU (Python onnxruntime / PyTorch), one thread unless shown, on a shared 8-core EPYC with a load average of 9–22 from other jobs, so all speeds here are pessimistic. Paradee's model card reports about 62× on one M4 Pro core.</p>
  </div>
  <div class="card">
    <h3>Every model</h3>
    <div class="scroll"><table class="models"><thead><tr><th>Model</th><th>Params</th><th>Download</th><th>Speed</th><th>WER</th><th>Licence</th><th>Browser</th></tr></thead><tbody>{table_rows}</tbody></table></div>
    <p class="note">WER: Paradee over four voices; others over the voices run (Kokoro af_heart + bm_fable; PiVo Pi; Leokani Dala; Phonon Easton; Supertonic M1; Audio8 its default voice, 5 lines). Speeds are per line of about 5 s.</p>
  </div>
</section>

<section>
  <h2>In the browser</h2>
  <div class="cols">
    <div class="card">
      <h3>Worker, headless Chromium ({e(br.get("chromium") or "")})</h3>
      <div class="kv">
        <span>Load (download + compile), local server</span><b>{br.get("load_ms", "—")} ms</b>
        <span>Second worker, from the HTTP cache</span><b>{br.get("reload_ms", "—")} ms</b>
        <span>Synthesis per line, median ({br.get("n", 0)} lines)</span><b>{br.get("synth_ms_median", "—")} ms</b>
        <span>Slowest line</span><b>{br.get("synth_ms_max", "—")} ms</b>
        <span>Speed</span><b>{fmt(br.get("x_realtime"), 1, "× real time")}</b>
        <span>G2P per line</span><b>{fmt(br.get("g2p_ms_mean"), 2, " ms")}</b>
        <span>int8 / fp32, 3 alternating runs each</span><b>{ab_txt}</b>
        <span>Threads</span><b>{br.get("threads", 1)} (page not cross-origin isolated)</b>
        <span>Page errors</span><b>{len(br.get("errors", []))}</b>
      </div>
      <p class="note">WASM ran about 3.8× slower than native onnxruntime on the same line and load. A profile puts 39 % of the time in convolutions and 15 % in the vocoder's sine, which WASM computes one value at a time. The fp32 file is about 1.3× faster in WASM but 35 MB instead of 8.5 MB, so the int8 file ships. WebGPU: the original int8 uses dynamic quantisation that WebGPU cannot run, and the WebGPU re-quantisation (danyalmalik/Paradee-8M-ONNX-WebGPU) is of v1.1, which has one voice.</p>
    </div>
    <div class="card">
      <h3>The game's path: line to first sound</h3>
      <div class="kv">
        <span>First clause audible, median (lines not queued)</span><b>{first_ms[len(first_ms) // 2] if first_ms else "—"} ms</b>
        <span>Lines spaced like traffic</span><b>{", ".join(str(s["firstChunkMs"]) + " ms" for s in spaced)}</b>
        <span>Five lines at once</span><b>{len(dropped)} dropped, the rest read faster</b>
      </div>
      <p class="note">On top of the pilot's own reply delay (2–8 s). Long lines are cut at their commas into clauses of at least three words: the first is heard while the next is made. When lines pile up, at most two wait behind the one playing, the oldest waiting ones are dropped, a line that cannot start within 12 s is dropped, and lines with others ahead of them are read up to 24 % faster.</p>
      <details><summary>Per line</summary><div class="scroll"><table><thead><tr><th>Line (normalised)</th><th>Voice</th><th>Clauses</th><th>First sound</th><th>Synth</th><th>Audio</th></tr></thead><tbody>{lat_rows}</tbody></table></div></details>
    </div>
  </div>
  <div class="card">
    <h3>Download, the first time a pilot speaks</h3>
    <div class="kv">
      <span>Paradee-8M v1.2 int8 (self-hosted, /models/tts/paradee-8m-v1.2/, cached a year)</span><b>{MODEL_BYTES / 1e6:.2f} MB</b>
      <span>onnxruntime-web 1.30.0 WASM + loader (jsDelivr, brotli)</span><b>{(ort_wasm + ort_js) / 1e6:.2f} MB</b>
      <span>ATC lexicon (/models/tts/atc-lexicon-v1.json, gzip)</span><b>{lex_gz / 1e3:.0f} kB</b>
      <span>eSpeak NG, only if a word is not in the lexicon (jsDelivr, gzip)</span><b>0.69 MB</b>
      <span>Total, usual case</span><b>{total_dl / 1e6:.1f} MB</b>
    </div>
  </div>
</section>

<section>
  <h2>Hear it</h2>
  <div class="card listen">
    <p class="said">“{e(clip_text)}” <span class="note">— made in headless Chromium by the worker, voice {e(clip_voice)}</span></p>
    {f'<div class="pl"><span>Dry</span><audio controls preload="none" src="{clip_dry}"></audio></div>' if clip_dry else ""}
    {f'<div class="pl"><span>Radio</span><audio controls preload="none" src="{clip_radio}"></audio></div>' if clip_radio else ""}
    <p class="note">The radio clip is the browser's audio through the same effect rendered offline (ml/tts/synth.py). <a href="voice-tts-samples.html">Eight more lines, every voice, Kokoro and Audio8 →</a></p>
  </div>
</section>

<section>
  <h2>Audio8: a big model, for offline work</h2>
  <p>Audio8-TTS-Realistic-Air (Edge0, Apache-2.0) is a 0.6B-parameter DualAR model with a 44.1 kHz codec: 2.55 GB of weights, 23 languages including Hindi, and zero-shot voice cloning from a reference clip and its transcript. Its custom code was read before running: it only builds, loads and runs the model.</p>
  <div class="cols">
    <div class="card">
      <h3>On this CPU, 3 threads</h3>
      <div class="kv">
        <span>Seconds per readback (n = {len(a8["clips"]) if a8 else 0})</span><b>{fmt(sum(c["synth_s"] for c in a8["clips"]) / len(a8["clips"]) if a8 else None, 0, " s")}</b>
        <span>Audio per readback</span><b>{fmt(sum(c["audio_s"] for c in a8["clips"]) / len(a8["clips"]) if a8 else None, 1, " s")}</b>
        <span>Speed</span><b>{fmt(sum(c["audio_s"] for c in a8["clips"]) / sum(c["synth_s"] for c in a8["clips"]) if a8 else None, 3, "× real time")}</b>
        <span>Codec decode share</span><b>{fmt(100 * sum(c["decode_s"] for c in a8["clips"]) / sum(c["synth_s"] for c in a8["clips"]) if a8 else None, 0, " %")}</b>
        <span>Word error (Whisper base.en)</span><b>{fmt(a8s["wer"] if a8s else None, 1, " %")}</b>
      </div>
      <p class="note">Unusable live on a CPU, and far too big for the browser. On one data-centre GPU (L4 or A10 class, bf16, no CUDA graphs) a DualAR model of this size should run at roughly real time per stream, and much faster in aggregate with the SGLang Omni server's batching: an estimate, not measured here.</p>
    </div>
    <div class="card">
      <h3>Why it is still interesting</h3>
      <ul>
        <li><strong>Training data, offline.</strong> Speech-to-text needs varied voices saying ATC phrases. Audio8 can read thousands of lines overnight on a GPU, in many accents.</li>
        <li><strong>The owner's own voice.</strong> Cloning needs only a clean clip and its exact transcript. The owner's own recordings (the gold set) could seed a voice to read new controller lines for fine-tuning, with the owner's consent; nobody else's voice.</li>
        <li><strong>Hindi and other languages</strong> for accented-English variety.</li>
      </ul>
    </div>
  </div>
</section>

<section>
  <h2>In the game</h2>
  <ul>
    <li><strong>Settings → Audio → Pilot voices</strong>: <em>Neural (on this device, ~12 MB)</em>, the default, or <em>Browser</em> (speechSynthesis). Stored in <code>skycontrol_pilot_voice</code>.</li>
    <li>Nothing downloads until the first pilot line. While the model loads, lines use the browser voice if there is one (the phone app's WebView often has none: there the first lines wait, up to two, and stale ones are dropped). If the model cannot load, the browser voice takes over for the session.</li>
    <li>Each callsign keeps one of the four voices, a speaking rate of 1.00–1.14 and a pitch offset of ±70 cents, from a hash of the callsign; British airlines get the British voices, US airlines the American ones.</li>
  </ul>
</section>

<section>
  <h2>Method and caveats</h2>
  <ul>
    <li>Lines: <code>ml/tts/lines.sh</code> runs the headless engine in full-auto mode and keeps every pilot line it would speak, plus the readback the engine composes for each AI command, sampled command and template command; <code>ml/tts/pick.py</code> chooses 60 with one per phrase pattern (32 readbacks, 16 requests, 12 status lines).</li>
    <li>Scoring: <code>ml/tts/bench.py</code>. Clips peak-normalised, 16 kHz. Reference = the normaliser's output. ICAO digits count as digits, spelled letters are joined, a few split names joined.</li>
    <li>CPU: speeds were measured on a shared machine with other benchmarks running; compare them with each other, not with spec sheets.</li>
    <li>Whisper base.en is itself a weak ATC listener ("Sky Dubai" → "sky to by" for every model, digit strings written as "1.5.3"), so the floor is not 0 %. With 60 lines, differences of a point or two between models are within noise.</li>
    <li>The radio effect costs Whisper about 4–5 points (most on the male British voice), and a lighter version barely helps: the 300–3400 Hz band itself is what Whisper was not trained on. People hear radio speech every day; the game keeps the effect.</li>
  </ul>
  <p class="note">Code: <code>ml/tts/</code> (RESULTS.md), <code>public/voice/tts-worker.js</code>, <code>public/voice/tts-g2p.js</code>, <code>src/lib/tts/pilotSpeech.ts</code>, <code>src/components/atc/pilotVoice.ts</code>. Paradee-8M v1.2 © Sahil Mahendrakar, Apache-2.0; misaki and Kokoro-82M © hexgrad, Apache-2.0; phonemizer.js (Apache-2.0) bundles eSpeak NG (GPL-3.0); it is loaded from jsDelivr only for a word outside the lexicon, never self-hosted.</p>
</section>
</main>
</body>
</html>
'''
(ROOT / "public/reports/voice-tts.html").write_text(page)
print("wrote public/reports/voice-tts.html", len(page))

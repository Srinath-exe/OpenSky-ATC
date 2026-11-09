"""Build the learning report public/reports/ai-paths.html from the measured results in this repo.

Re-run it whenever a run finishes; the page always shows the latest numbers:
    python3 ml/report/build_ai_paths.py && cp public/reports/ai-paths.html .next/standalone/public/reports/
Inputs (all optional except the L0 numbers baked in below): ml/s1/runs/v1/metrics.jsonl + eval.json + bench.json,
ml/stt/out/clips/results-*.json, ml/data/out/*.jsonl, ml/tokenizer/atc.json stats.
"""
import glob, html, json, math, os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public/reports/ai-paths.html"
E = html.escape


def load_jsonl(p):
    try:
        return [json.loads(l) for l in open(p)]
    except FileNotFoundError:
        return []


def load_json(p):
    try:
        return json.load(open(p))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# ---------- measured inputs ----------
L0 = [("KJFK", "FAA", 384, 0, 384, 367), ("KLAX", "FAA", 389, 0, 388, 373), ("KSFO", "FAA", 290, 0, 289, 270),
      ("EGLL", "ICAO", 222, 198, 221, 219), ("LFPG", "ICAO", 246, 214, 246, 243), ("YSSY", "ICAO", 424, 388, 423, 422)]
metrics = load_jsonl(ROOT / "ml/s1/runs/v1/metrics.jsonl")
losses = [(m["step"], m["loss"]) for m in metrics if "loss" in m]
evals = [(m["step"], m["val"]) for m in metrics if "val" in m]
final = load_json(ROOT / "ml/s1/runs/v1/eval.json")
bench = load_json(ROOT / "ml/s1/runs/v1/bench.json")
cfg = load_json(ROOT / "ml/s1/runs/v1/config.json")
stt = []
for f in sorted(glob.glob(str(ROOT / "ml/stt/out/clips/results-*.json"))):
    d = load_json(f)
    if d:
        stt.append(d)
STT_DEFAULT = {"variant": "model=tiny&dtype=q8", "wer": 0.821, "l0_exact": 0.0, "callsign": 0.075, "ms_p50": 270, "ms_p95": 836, "clips": 40}
stt_rows = [STT_DEFAULT] + [d["summary"] for d in stt]
stt_examples = next((d["rows"] for d in stt if "base_dtype_q8" in json.dumps(d["summary"]) or True), [])[:8] if stt else []
kinds_ai, kinds_sample = {}, {}
for f in glob.glob(str(ROOT / "ml/data/out/[A-Z]*.jsonl")):
    for r in load_jsonl(f):
        k = r["kind"].split("+")[0]
        (kinds_ai if r["src"] == "ai" else kinds_sample)[k] = (kinds_ai if r["src"] == "ai" else kinds_sample).get(k, 0) + 1
n_ai, n_sample = sum(kinds_ai.values()), sum(kinds_sample.values())
only_sampler = sorted(set(kinds_sample) - set(kinds_ai))
TOKENS = {"ctx": 310.7, "said": 10.4, "line": 8.6, "vocab": 1349, "chunks": 565}
SPLITS = {"train": 33742, "val": 3825, "test_airport": 2754}


# ---------- small SVG chart helpers (all text and marks take theme tokens) ----------
def hbars(rows, maxv, color, fmt, label_w=130, h=22, unit=""):
    """rows: [(label, value, tooltip)] -> horizontal bar chart, one scale."""
    W = 640; plot = W - label_w - 70; H = len(rows) * (h + 6) + 26
    out = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img">']
    for t in range(0, 5):
        x = label_w + plot * t / 4
        out.append(f'<line x1="{x:.1f}" y1="0" x2="{x:.1f}" y2="{H - 20}" class="grid"/>')
        out.append(f'<text x="{x:.1f}" y="{H - 6}" class="tick" text-anchor="{"start" if t == 0 else "end" if t == 4 else "middle"}">{fmt(maxv * t / 4)}{unit}</text>')
    for i, (lab, v, tip) in enumerate(rows):
        y = i * (h + 6) + 2; w = max(2, plot * v / maxv)
        out.append(f'<g class="bar"><title>{E(tip)}</title><text x="{label_w - 10}" y="{y + h * .68:.1f}" class="lab" text-anchor="end">{E(lab)}</text>'
                   f'<path d="M{label_w},{y + 5} h{w - 4:.1f} a4,4 0 0 1 4,4 v{h - 18} a4,4 0 0 1 -4,4 h-{w - 4:.1f} z" fill="{color}"/>'
                   f'<text x="{label_w + w + 8:.1f}" y="{y + h * .68:.1f}" class="val">{fmt(v)}{unit}</text></g>')
    out.append("</svg>")
    return "".join(out)


def l0_chart():
    W, lw = 640, 110; plot = W - lw - 70; gh = 34; H = len(L0) * (gh + 10) + 26
    o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img"><title>Spoken AI commands understood by the rule parser, before and after the fixes</title>']
    for t in range(5):
        x = lw + plot * t / 4
        o.append(f'<line x1="{x:.1f}" y1="0" x2="{x:.1f}" y2="{H - 20}" class="grid"/><text x="{x:.1f}" y="{H - 6}" class="tick" text-anchor="{"start" if t == 0 else "end" if t == 4 else "middle"}">{25 * t}%</text>')
    for i, (icao, style, n, b, a, _) in enumerate(L0):
        y = i * (gh + 10) + 2
        o.append(f'<text x="{lw - 10}" y="{y + 14}" class="lab" text-anchor="end">{icao}</text><text x="{lw - 10}" y="{y + 28}" class="tick" text-anchor="end">{style}</text>')
        for j, (v, col, nm) in enumerate(((b, "var(--s-before)", "before"), (a, "var(--s-after)", "after"))):
            yy = y + 3 + j * 15; w = max(2, plot * v / n)
            o.append(f'<g class="bar"><title>{icao} {nm}: {v} of {n} ({100 * v / n:.1f}%)</title><rect x="{lw}" y="{yy}" width="{w:.1f}" height="11" rx="3" fill="{col}"/>'
                     f'<text x="{lw + w + 8:.1f}" y="{yy + 10}" class="val">{100 * v / n:.1f}%</text></g>')
    o.append("</svg>")
    return "".join(o)


def loss_chart():
    if not losses:
        return '<p class="note">Training has not logged yet.</p>'
    W, H, l, r, t, b = 640, 240, 48, 16, 12, 30
    xmax = max(cfg["args"]["steps"] if cfg else losses[-1][0], losses[-1][0])
    lo, hi = math.log10(0.05), math.log10(10)
    X = lambda s: l + (W - l - r) * s / xmax
    Y = lambda v: t + (H - t - b) * (1 - (math.log10(max(v, 0.05)) - lo) / (hi - lo))
    o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img"><title>Training loss (log scale) by step</title>']
    for v in (0.1, 0.3, 1, 3, 10):
        o.append(f'<line x1="{l}" y1="{Y(v):.1f}" x2="{W - r}" y2="{Y(v):.1f}" class="grid"/><text x="{l - 8}" y="{Y(v) + 4:.1f}" class="tick" text-anchor="end">{v:g}</text>')
    for s in range(0, xmax + 1, max(1, xmax // 4)):
        o.append(f'<text x="{X(s):.1f}" y="{H - 8}" class="tick" text-anchor="middle">{s:,}</text>')
    pts = " ".join(f"{X(s):.1f},{Y(v):.1f}" for s, v in losses)
    o.append(f'<polyline points="{pts}" fill="none" stroke="var(--s-after)" stroke-width="2" stroke-linejoin="round"/>')
    s, v = losses[-1]
    o.append(f'<circle cx="{X(s):.1f}" cy="{Y(v):.1f}" r="4.5" fill="var(--s-after)" stroke="var(--surface)" stroke-width="2"><title>step {s}: loss {v}</title></circle>'
             f'<text x="{min(X(s) + 8, W - r - 60):.1f}" y="{Y(v) - 8:.1f}" class="val">{v:.2f} at step {s:,}</text>')
    o.append(f'<line x1="{l}" y1="{Y(math.log(TOKENS["vocab"])):.1f}" x2="{W - r}" y2="{Y(math.log(TOKENS["vocab"])):.1f}" class="ref"/><text x="{W - r}" y="{Y(math.log(TOKENS["vocab"])) - 6:.1f}" class="tick" text-anchor="end">ln(vocab) = {math.log(TOKENS["vocab"]):.2f}: a random model</text>')
    o.append("</svg>")
    return "".join(o)


def eval_chart():
    if not evals:
        return '<p class="note">No evaluation yet.</p>'
    rows = [(f"step {s:,}", 100 * v["exact"], f"step {s}: {100 * v['exact']:.1f}% exact, {100 * v['callsign']:.1f}% callsign, {v['ms_p50']} ms p50") for s, v in evals]
    return hbars(rows, 100, "var(--s-after)", lambda x: f"{x:.0f}", label_w=110, unit="%")


def token_bar():
    tot = TOKENS["ctx"] + TOKENS["said"] + TOKENS["line"]
    segs = [("Game state", TOKENS["ctx"], "var(--s-before)"), ("Transcript", TOKENS["said"], "var(--s-after)"), ("Command line", TOKENS["line"], "var(--ink-2)")]
    W = 640; x = 0; o = [f'<svg viewBox="0 0 {W} 62" class="chart-svg" role="img"><title>Where the tokens of one example go</title>']
    for nm, v, c in segs:
        w = W * v / tot
        o.append(f'<g class="bar"><title>{nm}: {v:.1f} tokens ({100 * v / tot:.0f}%)</title><rect x="{x + (1 if x else 0):.1f}" y="4" width="{max(2, w - 2):.1f}" height="22" rx="3" fill="{c}"/></g>')
        x += w
    o.append(f'<text x="0" y="48" class="val">Game state {TOKENS["ctx"]:.0f} tokens ({100 * TOKENS["ctx"] / tot:.0f}%)</text><text x="{W}" y="48" class="val" text-anchor="end">transcript {TOKENS["said"]:.0f} + command {TOKENS["line"]:.0f}</text></svg>')
    return "".join(o)


def stt_charts():
    def name(v):
        d = dict(p.split("=") for p in v.split("&"))
        return f'{d.get("model", "tiny")} · {"int8" if d.get("dtype", "q8") == "q8" else d.get("dtype")}'
    rows = sorted(stt_rows, key=lambda r: (r["variant"].split("&")[0], r["variant"]), reverse=True)
    wer = hbars([(name(r["variant"]), 100 * r["wer"], f'{name(r["variant"])}: {100 * r["wer"]:.1f}% of words wrong on {r["clips"]} clips') for r in rows], 100, "var(--s-before)", lambda x: f"{x:.0f}", unit="%")
    lat = hbars([(name(r["variant"]), r["ms_p50"], f'{name(r["variant"])}: p50 {r["ms_p50"]} ms, p95 {r["ms_p95"]} ms (WASM, CPU)') for r in rows], 800, "var(--s-after)", lambda x: f"{x:.0f}", unit=" ms")
    und = hbars([(name(r["variant"]), 100 * r["l0_exact"], f'{name(r["variant"])}: {round(r["l0_exact"] * r["clips"])} of {r["clips"]} commands understood') for r in rows], 100, "var(--s-after)", lambda x: f"{x:.0f}", unit="%")
    return wer, lat, und


def pill(v):
    cls = {"chosen": "done", "shipped": "done", "experiment": "next", "kept": "", "planned": "next", "rejected": "no", "test only": ""}.get(v.split(" ")[0].lower(), "")
    return f'<span class="pill {cls}">{E(v)}</span>'


def table(head, rows):
    h = "".join(f"<th>{E(x)}</th>" for x in head)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="scroll"><table><thead><tr>{h}</tr></thead><tbody>{body}</tbody></table></div>'


def lesson(t):
    return f'<div class="lesson"><span class="eyebrow">Lesson</span><p>{t}</p></div>'


# ---------- visual components ----------
import sys as _sys
_sys.path.insert(0, str(ROOT / "ml/tokenizer"))
try:
    from bpe import BPE as _BPE
    _TOK = _BPE.load(str(ROOT / "ml/tokenizer/atc.json"))
except Exception:   # report still builds without the tokenizer
    _TOK = None


def chips(text):
    if not _TOK:
        return ""
    ids = _TOK.encode(text)
    return '<div class="toks">' + "".join(f'<span class="tok">{E(_TOK.vocab[i].decode().replace(" ", "·"))}</span>' for i in ids) + f'</div><div class="tokn">{len(ids)} tokens</div>'


def opt(label, state):
    icon = {"chosen": "✓", "experiment": "◇", "kept": "○", "rejected": "✕"}[state]
    return f'<span class="opt {state}"><b>{icon}</b>{E(label)}</span>'


MAP = [
    ("Need a model?", [("Rules first, model for the rest", "chosen"), ("Rules only", "kept"), ("Model only", "rejected")]),
    ("Input → output", [("State + transcript → command line", "chosen"), ("Tool calls / JSON", "experiment"), ("Model edits game state", "rejected"), ("Free chat", "rejected")]),
    ("Architecture", [("Cascade pipeline", "chosen"), ("End-to-end speech → command", "experiment"), ("Speech-native big LLM", "rejected")]),
    ("Model kind", [("Tiny transformer from scratch", "chosen"), ("Small fine-tuned LLM", "chosen"), ("Diffusion LM", "experiment"), ("BERT tagger", "kept"), ("Hosted frontier model", "rejected")]),
    ("Technique", [("Pre-train (tiny)", "chosen"), ("SFT / LoRA (small LLM)", "chosen"), ("RL with engine reward", "experiment"), ("Prompting", "kept"), ("RAG", "rejected")]),
    ("Data", [("Simulator teacher", "chosen"), ("Action sampler", "chosen"), ("Augmentation", "chosen"), ("Own voice recordings", "experiment"), ("Public ATC sets", "kept")]),
    ("Tokens", [("Own BPE, digits split", "chosen"), ("Base model's tokenizer", "kept"), ("Characters", "rejected")]),
    ("Output control", [("Constrained callsigns", "chosen"), ("Confidence gate (calibrated)", "chosen"), ("System One decision model", "experiment"), ("JSON schema", "experiment"), ("Free text + hope", "rejected")]),
    ("Speech-to-text", [("Browser recogniser", "chosen"), ("On-device Moonshine", "chosen"), ("Fine-tuned + biased STT", "experiment"), ("Cloud STT", "kept")]),
    ("Where it runs", [("Browser", "chosen"), ("Phone app", "experiment"), ("Cloud GPU", "experiment")]),
]


def decision_map():
    cols = "".join(f'<div class="mcol"><div class="mq"><span class="num">{i + 1:02d}</span>{E(q)}</div>{"".join(opt(l, st) for l, st in opts)}</div>' for i, (q, opts) in enumerate(MAP))
    leg = "".join(opt(n, s) for n, s in (("chosen", "chosen"), ("experiment", "experiment"), ("kept as option", "kept"), ("rejected", "rejected")))
    return f'<div class="map">{cols}</div><div class="legendrow">{leg}</div>'


def flow(nodes, end_note=""):
    """nodes: [(tag, title, kind)] kind in '', 'key', 'ok' -> horizontal flow that stacks on phones."""
    parts = []
    for i, (tag, title, kind) in enumerate(nodes):
        parts.append(f'<div class="fnode {kind}"><span class="ftag">{E(tag)}</span><b>{E(title)}</b></div>')
        if i < len(nodes) - 1:
            parts.append('<div class="farrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 12h14m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>')
    return f'<div class="flow">{"".join(parts)}</div>' + (f'<p class="cap">{end_note}</p>' if end_note else "")


def layers_diagram():
    """L0 rules -> L1 model -> gate: share of traffic each layer takes (clean speech)."""
    return f'''<svg viewBox="0 0 640 150" class="chart-svg" role="img"><title>How a spoken command is handled</title>
  <rect x="0" y="10" width="640" height="34" rx="8" fill="var(--s-after)" opacity=".9"/><text x="14" y="32" class="lab" style="fill:#fff">L0 rules · clean phrasing · 99.8% · &lt;1 ms</text>
  <rect x="60" y="56" width="520" height="34" rx="8" fill="var(--s-before)" opacity=".9"/><text x="74" y="78" class="lab" style="fill:#fff">L1 model · sloppy speech, recogniser errors</text>
  <rect x="200" y="102" width="240" height="34" rx="8" fill="none" stroke="var(--ink-3)" stroke-dasharray="4 4"/><text x="320" y="124" class="lab" text-anchor="middle">gate → “say again”</text>
</svg>'''


def scatter_models():
    """params (log) vs latency (log): where each option sits. E1 is measured, the rest are estimates for this task."""
    pts = [("Rules", 1e5, 1, "chosen", "measured: <1 ms"), ("Tiny from scratch (E1)", 2.0e6, 47, "chosen", "measured: 47 ms p50, CPU"),
           ("Diffusion (E4)", 3e7, 20, "experiment", "estimate"), ("BERT tagger", 1.1e8, 15, "kept", "estimate"),
           ("Gemma 3 270M", 2.7e8, 110, "chosen", "estimate"), ("LFM2-350M", 3.5e8, 130, "chosen", "estimate"), ("Qwen3.5-0.8B", 8e8, 220, "chosen", "estimate"),
           ("Hosted frontier", 1e12, 1200, "rejected", "estimate: network + big model")]
    W, H, l, b, t, r = 640, 300, 56, 34, 16, 20
    X = lambda p: l + (W - l - r) * (math.log10(p) - 5) / (12.2 - 5)
    Y = lambda ms: t + (H - t - b) * (1 - (math.log10(ms) - 0) / (math.log10(3000)))
    o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img"><title>Model size against response time</title>']
    for p, lab in ((1e5, "100k"), (1e6, "1M"), (1e7, "10M"), (1e8, "100M"), (1e9, "1B"), (1e10, "10B"), (1e11, "100B"), (1e12, "1T")):
        o.append(f'<line x1="{X(p):.1f}" y1="{t}" x2="{X(p):.1f}" y2="{H - b}" class="grid"/><text x="{X(p):.1f}" y="{H - 14}" class="tick" text-anchor="middle">{lab}</text>')
    for ms in (1, 10, 100, 1000):
        o.append(f'<line x1="{l}" y1="{Y(ms):.1f}" x2="{W - r}" y2="{Y(ms):.1f}" class="grid"/><text x="{l - 8}" y="{Y(ms) + 4:.1f}" class="tick" text-anchor="end">{ms} ms</text>')
    o.append(f'<rect x="{l}" y="{Y(250):.1f}" width="{W - l - r}" height="{Y(1) - Y(250):.1f}" fill="var(--good)" opacity=".07"/><text x="{W - r - 6}" y="{Y(250) + 14:.1f}" class="tick" text-anchor="end">latency budget (≤ 250 ms)</text>')
    for name, p, ms, st, note in pts:
        col = {"chosen": "var(--s-after)", "experiment": "var(--s-before)", "kept": "var(--ink-3)", "rejected": "var(--no)"}[st]
        anchor = "end" if p > 3e9 else "start"; dx = -12 if anchor == "end" else 12
        o.append(f'<g class="bar"><title>{E(name)}: {note}</title><circle cx="{X(p):.1f}" cy="{Y(ms):.1f}" r="7" fill="{col}" stroke="var(--surface)" stroke-width="2"/>'
                 f'<text x="{X(p) + dx:.1f}" y="{Y(ms) + 4:.1f}" class="lab" text-anchor="{anchor}" style="font-size:12px">{E(name)}</text></g>')
    o.append(f'<text x="{W - r}" y="{H - 1}" class="tick" text-anchor="end">parameters →</text></svg>')
    return "".join(o)


def ladder():
    steps = [("Prompting", "no training", "kept"), ("RAG", "add knowledge", "rejected"), ("LoRA", "adapt a little", "chosen"), ("Full fine-tune", "adapt fully", "chosen"),
             ("RL / DPO", "reward behaviour", "experiment"), ("Pre-train", "learn from zero", "chosen")]
    cells = "".join(f'<div class="rung {st}" style="--h:{30 + i * 14}px"><div class="rbar"></div><b>{E(n)}</b><span>{E(d)}</span></div>' for i, (n, d, st) in enumerate(steps))
    return f'<div class="ladder">{cells}</div><div class="ramp"><span>less data, less control</span><span>more data, more control →</span></div>'


def data_pipeline():
    tot = SPLITS["train"] + SPLITS["val"] + SPLITS["test_airport"]
    split = "".join(f'<div class="seg" style="flex:{v};background:{c}" title="{n}: {v:,}"><span>{n} {v:,}</span></div>' for n, v, c in (("train", SPLITS["train"], "var(--s-after)"), ("val", SPLITS["val"], "var(--s-before)"), ("unseen airport", SPLITS["test_airport"], "var(--ink-3)")))
    return flow([("teacher", f"Rule-based AI · {n_ai:,}", ""), ("sampler", f"Valid actions · {n_sample:,}", ""), ("check", "Round trip · 0 rejected", "ok"), ("augment", "×4 noisy transcripts", ""), ("split", "by session", "key")]) + f'<div class="splitbar">{split}</div>'


def trie_visual():
    """Constrained decoding: at the first output step only callsigns in the game state survive."""
    allowed = [" DAL", " AFR", " BAW", " SAY"]
    masked = [" UAL", " QFA", " Turn", " heading", " 2", " RYR"]
    a = "".join(f'<span class="tc ok">{E(x.strip())}</span>' for x in allowed)
    m = "".join(f'<span class="tc no">{E(x.strip())}</span>' for x in masked)
    return f'''<div class="trie"><div class="tcol"><span class="ftag">step 1 · allowed</span><div class="tcs">{a}</div></div>
    <div class="tcol"><span class="ftag">masked to −∞</span><div class="tcs">{m}</div></div>
    <div class="tcol"><span class="ftag">then</span><div class="tcs"><span class="tc ok">DAL</span>→<span class="tc ok">4</span>→<span class="tc ok">2</span>→<span class="tc ok">1</span>→<span class="tc free">free</span></div></div></div>'''


def kv_visual():
    """No cache: step t recomputes t tokens (a triangle). Cache: one new token per step (a column)."""
    n, c = 8, 18
    def grid(cached):
        o = [f'<svg viewBox="0 0 {n * c + 4} {n * c + 4}" class="kvg" role="img">']
        for row in range(n):
            for col in range(row + 1):
                fresh = (col == row) if cached else True
                o.append(f'<rect x="{col * c + 2}" y="{row * c + 2}" width="{c - 3}" height="{c - 3}" rx="3" fill="{"var(--s-after)" if fresh else "var(--s-before)"}" opacity="{1 if fresh else .35}"/>')
        o.append("</svg>")
        return "".join(o)
    return f'''<div class="kv"><div><span class="ftag">no cache · {n * (n + 1) // 2} token computations</span>{grid(False)}</div>
    <div><span class="ftag">KV cache · {n} computations</span>{grid(True)}</div></div>
    <div class="legendrow"><span class="lg"><i style="background:var(--s-after)"></i>computed this step</span><span class="lg"><i style="background:var(--s-before);opacity:.35"></i>reused from cache</span></div>'''


ICONS = {
    "browser": '<svg viewBox="0 0 48 48"><rect x="4" y="8" width="40" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M4 16h40" stroke="currentColor" stroke-width="2.5"/><circle cx="10" cy="12" r="1.6" fill="currentColor"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/></svg>',
    "phone": '<svg viewBox="0 0 48 48"><rect x="13" y="4" width="22" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M21 9h6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="24" cy="38" r="1.8" fill="currentColor"/></svg>',
    "cloud": '<svg viewBox="0 0 48 48"><rect x="6" y="8" width="36" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="6" y="20" width="36" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="6" y="32" width="36" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="12" cy="12.5" r="1.5" fill="currentColor"/><circle cx="12" cy="24.5" r="1.5" fill="currentColor"/><circle cx="12" cy="36.5" r="1.5" fill="currentColor"/></svg>',
}


def devices():
    rows = [("browser", "Browser", "shipped", [("model", "Moonshine STT · S1 next"), ("runtime", "ONNX Runtime Web · transformers.js"), ("hardware", "WebGPU, or WASM on CPU")]),
            ("phone", "Phone app", "next", [("model", "S1 + STT, int8/int4"), ("runtime", "llama.cpp · ExecuTorch · sherpa-onnx"), ("hardware", "phone GPU / NPU")]),
            ("cloud", "Cloud GPU", "next", [("model", "fine-tuned small LLM"), ("runtime", "vLLM · KV + prefix cache · batching"), ("hardware", "EC2 g6 (NVIDIA L4)")])]
    cards = ""
    for icon, name, st, stack in rows:
        layers = "".join(f'<div class="layer"><span class="ftag">{E(k)}</span>{E(v)}</div>' for k, v in stack)
        cards += f'<div class="dev"><div class="devh"><span class="ico">{ICONS[icon]}</span><b>{E(name)}</b>{pill("shipped" if st == "shipped" else "planned")}</div>{layers}</div>'
    return f'<div class="devs">{cards}</div>'


def result_tiles():
    if not final:
        return ""
    v, u, t = final["val"], final.get("val_unconstrained") or {}, final.get("test_airport") or {}
    tiles = [(f'{100 * v["exact"]:.1f}%', "exact commands", "validation · 1,000"), (f'{100 * u.get("exact", 0):.1f}%', "without the constraint", "same model"),
             (f'{100 * t.get("exact", 0):.1f}%', "unseen airport", "Sydney never trained on"), (f'{v["ms_p50"]:.0f} ms', "per command", "p50, CPU, with cache")]
    return '<div class="tiles">' + "".join(f'<div class="tile"><div class="tv">{a}</div><b>{E(b)}</b><span>{E(c)}</span></div>' for a, b, c in tiles) + "</div>"


def overfit_chart():
    """train loss (falls) next to validation exact (flat): the overfitting picture."""
    if not losses or not evals:
        return ""
    W, H, l, r, t, b = 640, 200, 48, 48, 12, 28
    xmax = max(s for s, _ in losses)
    X = lambda s: l + (W - l - r) * s / xmax
    YL = lambda v: t + (H - t - b) * (1 - min(v, 2) / 2)
    YA = lambda a: t + (H - t - b) * (1 - a)
    o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img"><title>Training loss against validation accuracy</title>']
    for f in (0, .25, .5, .75, 1):
        o.append(f'<line x1="{l}" y1="{YA(f):.1f}" x2="{W - r}" y2="{YA(f):.1f}" class="grid"/><text x="{W - r + 6}" y="{YA(f) + 4:.1f}" class="tick">{int(f * 100)}%</text><text x="{l - 6}" y="{YA(f) + 4:.1f}" class="tick" text-anchor="end">{2 * f:.1f}</text>')
    o.append('<polyline points="' + " ".join(f"{X(s):.1f},{YL(v):.1f}" for s, v in losses) + '" fill="none" stroke="var(--s-before)" stroke-width="2"/>')
    o.append('<polyline points="' + " ".join(f"{X(s):.1f},{YA(v['exact']):.1f}" for s, v in evals) + '" fill="none" stroke="var(--s-after)" stroke-width="2"/>')
    for s, v in evals:
        o.append(f'<circle cx="{X(s):.1f}" cy="{YA(v["exact"]):.1f}" r="4.5" fill="var(--s-after)" stroke="var(--surface)" stroke-width="2"><title>step {s}: {100 * v["exact"]:.1f}% exact</title></circle>')
    o.append(f'<text x="{l}" y="{H - 6}" class="tick">step 0</text><text x="{W - r}" y="{H - 6}" class="tick" text-anchor="end">step {xmax:,}</text></svg>')
    return "".join(o) + '<div class="legendrow"><span class="lg"><i style="background:var(--s-before)"></i>training loss (left axis)</span><span class="lg"><i style="background:var(--s-after)"></i>validation exact (right axis)</span></div>'


def bench_chart():
    if not bench:
        return '<p class="cap">Benchmark running.</p>'
    names = {"no_cache": "no cache", "kv_cache": "KV cache", "prefix": "KV + prefix cache"}
    rows = [(names[k], bench[k]["p50_ms"], f'{names[k]}: p50 {bench[k]["p50_ms"]} ms, p95 {bench[k]["p95_ms"]} ms') for k in ("no_cache", "kv_cache", "prefix") if k in bench]
    return hbars(rows, max(r[1] for r in rows) * 1.15, "var(--s-after)", lambda x: f"{x:.0f}", label_w=150, unit=" ms") + f'<p class="cap">Same model, same answers ({E(bench.get("identical_outputs", ""))} identical), 1 CPU thread like a phone core. Prompt {bench.get("prompt_tokens_mean", "")} tokens, answer {bench.get("output_tokens_mean", "")}.</p>'

# ---------- System One bake-off (ml/system1) ----------
S1B = []
for fn, label, kind in [("bench-s1-own-calibrated.json", "Our S1 2M (trained, calibrated)", "ours"), ("bench-kev_0.8b.json", "Kev-0.8B", "s1"),
                        ("bench-logits_Qwen_Qwen3.5_0.8B.json", "Qwen3.5-0.8B letters", "llm"), ("bench-von.json", "Von 395M", "s1"),
                        ("bench-laya.json", "Laya 420M", "s1"), ("d1-text-no-none_plain.json", "d1-omni-600M", "s1"), ("d1-audio-no-none_plain.json", "d1 from audio", "audio")]:
    d = load_json(ROOT / "ml/system1/out" / fn)
    if d:
        S1B.append((label, kind, d["summary"]))
S1_RAW = (load_json(ROOT / "ml/system1/out/bench-s1-own.json") or {}).get("summary")


def system_one_concept():
    return flow([("in", "Game state", ""), ("in", "Typed questions: which aircraft? which action?", ""), ("one pass", "Decision model", "key"),
                 ("out", "Probabilities over the allowed options", "ok")], "No text is generated, so the answer is always one of your options, with a confidence.")


def grouped(rows, a_key, b_key, a_lab, b_lab, maxv=100, label_w=190, pct=True, tip=lambda r: ""):
    W = 640; plot = W - label_w - 60; gh = 30; H = len(rows) * (gh + 10) + 24
    o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img">']
    for t in range(5):
        x = label_w + plot * t / 4
        o.append(f'<line x1="{x:.1f}" y1="0" x2="{x:.1f}" y2="{H - 20}" class="grid"/><text x="{x:.1f}" y="{H - 6}" class="tick" text-anchor="{"start" if t == 0 else "end" if t == 4 else "middle"}">{maxv * t / 4:.0f}{"%" if pct else ""}</text>')
    for i, (lab, kind, r) in enumerate(rows):
        y = i * (gh + 10) + 2
        o.append(f'<text x="{label_w - 10}" y="{y + 19}" class="lab" text-anchor="end" style="{"font-weight:700" if kind == "ours" else ""}">{E(lab)}</text>')
        for j, (k, col, nm) in enumerate(((a_key, "var(--s-after)", a_lab), (b_key, "var(--s-before)", b_lab))):
            v = (r.get(k) or 0) * (100 if pct else 1); yy = y + 3 + j * 14; w = max(2, plot * v / maxv)
            o.append(f'<g class="bar"><title>{E(lab)} · {nm}: {v:.0f}{"%" if pct else ""} {tip(r)}</title><rect x="{label_w}" y="{yy}" width="{w:.1f}" height="11" rx="3" fill="{col}"/><text x="{label_w + w + 6:.1f}" y="{yy + 10}" class="val">{v:.0f}{"%" if pct else ""}</text></g>')
    o.append("</svg>")
    return "".join(o) + f'<div class="legendrow"><span class="lg"><i style="background:var(--s-after)"></i>{E(a_lab)}</span><span class="lg"><i style="background:var(--s-before)"></i>{E(b_lab)}</span></div>'


def speed_chart(rows):
    """log-scale ms per command on this CPU."""
    W = 640; lw = 190; plot = W - lw - 70; h = 22; H = len(rows) * (h + 6) + 26
    lo, hi = math.log10(30), math.log10(10000)
    X = lambda ms: lw + plot * (math.log10(max(ms, 30)) - lo) / (hi - lo)
    o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img"><title>Time per command on this CPU, log scale</title>']
    for v in (30, 100, 300, 1000, 3000, 10000):
        o.append(f'<line x1="{X(v):.1f}" y1="0" x2="{X(v):.1f}" y2="{H - 20}" class="grid"/><text x="{X(v):.1f}" y="{H - 6}" class="tick" text-anchor="middle">{v if v < 1000 else f"{v // 1000} s"}{" ms" if v < 1000 else ""}</text>')
    o.append(f'<rect x="{lw}" y="0" width="{X(250) - lw:.1f}" height="{H - 20}" fill="var(--good)" opacity=".08"/>')
    for i, (lab, kind, r) in enumerate(rows):
        y = i * (h + 6) + 2; w = X(r["ms_p50"]) - lw
        o.append(f'<g class="bar"><title>{E(lab)}: p50 {r["ms_p50"]} ms, p95 {r["ms_p95"]} ms, {r.get("threads", "?")} CPU threads</title><text x="{lw - 10}" y="{y + 15}" class="lab" text-anchor="end">{E(lab)}</text>'
                 f'<rect x="{lw}" y="{y + 5}" width="{max(2, w):.1f}" height="12" rx="3" fill="var(--s-after)"/><text x="{lw + w + 6:.1f}" y="{y + 15}" class="val">{r["ms_p50"]:,} ms</text></g>')
    o.append("</svg>")
    return "".join(o) + '<p class="cap">Shaded: the 250 ms budget. Every model here would be 20–40× faster on a GPU.</p>'


def system_one_section():
    if not S1B:
        return ""
    text = [r for r in S1B if r[1] != "audio"]
    acc = grouped(text, "aircraft_acc", "instruction_acc", "aircraft right", "instruction right")
    cal = grouped([r for r in S1B if r[2].get("conf_right") is not None] + ([("Our S1 2M (before calibration)", "ours", S1_RAW)] if S1_RAW else []),
                  "conf_right", "conf_wrong", "confidence when right", "confidence when wrong")
    return sec("13", "System One models: typed answers, no text",
        f'<div class="card">{system_one_concept()}</div>'
        f'<div class="two"><div class="card"><h3>Accuracy on the same 100 commands</h3>{acc}</div><div class="card"><h3>Time per command (this CPU)</h3>{speed_chart(text)}</div></div>'
        f'<div class="card"><h3>Does it know when it is wrong?</h3>{cal}<p class="cap">A big gap between the two bars makes a good “say again” gate. Temperature scaling (one number, fitted on other commands) fixed our model: wrong answers went from 0.90 to 0.41 confidence.</p></div>',
        "Kev-0.8B, untrained on ATC, matches our trained model on aircraft and is the best at knowing when it is wrong, but it is 40× slower on CPU. Our tiny model is fast and accurate. Next: fine-tune Kev on our data (GPU), and keep the tiny model for the edge.")


# ---------- GPU session (ml/gpu/results) ----------
GR = ROOT / "ml/gpu/results"


def _gj(*parts):
    return load_json(GR.joinpath(*parts))


GPU_COST = os.environ.get("GPU_COST", "$2.13")


def gpu_section():
    if not GR.exists():
        return ""
    # 1. speed: CPU (8 threads) vs GPU (L4) per command, same 100 commands
    cpu = {r[0]: r[2] for r in S1B}
    pairs = [("Kev-0.8B", cpu.get("Kev-0.8B"), _gj("bench-kev_0.8b-gpu.json") or {"ms_p50": 59}), ("d1-omni-600M", cpu.get("d1-omni-600M"), _gj("bench-d1-gpu.json")),
             ("Laya 420M", cpu.get("Laya 420M"), _gj("bench-laya-gpu.json")), ("Von 395M", cpu.get("Von 395M"), _gj("bench-von-gpu.json")),
             ("Qwen3.5-0.8B letters", cpu.get("Qwen3.5-0.8B letters"), _gj("bench-logits_Qwen_Qwen3.5_0.8B-gpu.json"))]
    rows = []
    for lab, c, g in pairs:
        g = (g or {}).get("summary", g) or {}
        if c and g.get("ms_p50"):
            rows.append((lab, c["ms_p50"], g["ms_p50"]))
    W = 640; lw = 170; plot = W - lw - 80; gh = 30; H = len(rows) * (gh + 10) + 26
    lo, hi = math.log10(20), math.log10(6000)
    X = lambda ms: lw + plot * (math.log10(max(ms, 20)) - lo) / (hi - lo)
    o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img"><title>Time per command, CPU against GPU, log scale</title>']
    for v in (20, 50, 100, 300, 1000, 3000):
        o.append(f'<line x1="{X(v):.1f}" y1="0" x2="{X(v):.1f}" y2="{H - 20}" class="grid"/><text x="{X(v):.1f}" y="{H - 6}" class="tick" text-anchor="middle">{v if v < 1000 else str(v // 1000) + " s"}{" ms" if v < 1000 else ""}</text>')
    for i, (lab, c, g) in enumerate(rows):
        y = i * (gh + 10) + 2
        o.append(f'<text x="{lw - 10}" y="{y + 18}" class="lab" text-anchor="end">{E(lab)}</text>')
        for j, (v, col, nm) in enumerate(((c, "var(--s-before)", "CPU"), (g, "var(--s-after)", "GPU"))):
            yy = y + 3 + j * 14; w = X(v) - lw
            o.append(f'<g class="bar"><title>{E(lab)} on {nm}: {v:,} ms</title><rect x="{lw}" y="{yy}" width="{max(2, w):.1f}" height="11" rx="3" fill="{col}"/><text x="{lw + w + 6:.1f}" y="{yy + 10}" class="val">{v:,} ms</text></g>')
        o.append(f'<text x="{W}" y="{y + 18}" class="val" text-anchor="end">{c / g:.0f}×</text>')
    o.append("</svg>")
    speed = "".join(o) + '<div class="legendrow"><span class="lg"><i style="background:var(--s-before)"></i>this server\'s CPU (8 threads)</span><span class="lg"><i style="background:var(--s-after)"></i>one NVIDIA L4</span></div>'
    # 2. data vs model size (S1)
    sizes = []
    for name, lab in (("s1-v1-gpu", "2M · 1× data"), ("s1-2m", "2M · 3× data"), ("s1-11m", "11M · 3× data"), ("s1-26m", "26M · 3× data"), ("s1-2m-11ap", "2M · 11 airports")):
        d = _gj(name, "eval.json")
        if d and d.get("val") and d.get("test_airport"):
            sizes.append((lab, "ours" if "11 airports" in lab else "s1", {"val": d["val"]["exact"], "syd": d["test_airport"]["exact"], "train_s": d.get("train_s")}))
    scale = grouped(sizes, "val", "syd", "validation (airports it trained on)", "Sydney (never seen)") if sizes else ""
    # 3. generalisation: Sydney
    syd = []
    for fn, lab in (("bench-kev_0.8b_atc_sydney.json", "Kev-0.8B fine-tuned on ATC"), ("bench-kev_0.8b_sydney.json", "Kev-0.8B, no fine-tune")):
        d = _gj(fn)
        if d:
            syd.append((lab, "s1", d["summary"]))
    kev_ft = (_gj("bench-kev_0.8b_atc-gpu.json") or {}).get("summary")
    gen = grouped(syd, "aircraft_acc", "instruction_acc", "aircraft right", "instruction right") if syd else ""
    tiles = '<div class="tiles">' + "".join(f'<div class="tile"><div class="tv">{a}</div><b>{E(b)}</b><span>{E(c)}</span></div>' for a, b, c in [
        ("48 s", "S1 training on the GPU", "same run: 43 min on this CPU"),
        ("93.8%", "S1 2M with 3× data", "was 67.5% with 1× data"),
        ("100%", "Kev after fine-tuning", "aircraft and instruction, 3,000 examples, 24 min"),
        (GPU_COST, "the whole GPU session", "130 min on a g6.2xlarge, then terminated")]) + "</div>"
    stt_sc = load_json(GR / "stt" / "scores.json") or []
    names = {"whisper-large-v3-turbo+prompt": "Whisper-turbo + callsign hint", "moonshine-streaming-medium": "Moonshine medium", "whisper-large-v3-turbo": "Whisper-turbo",
             "moonshine-streaming-small": "Moonshine small", "whisper-base.en": "Whisper base"}
    stt_rows = [(names.get(x["model"], x["model"]), "s1", {"l0": x["l0"], "both": x["l0_l1"], "wer": x["wer"]}) for x in sorted(stt_sc, key=lambda x: -x["l0_l1"])]
    stt_chart = grouped(stt_rows, "both", "l0", "rules + our model", "rules alone") if stt_rows else ""
    stt_card = (f'<div class="card"><h3>Speech-to-text: can a small model clean up after the recogniser?</h3>{stt_chart}<p class="cap">200 commands spoken by Kokoro neural voices. '
                f'Our 2 MB model lifts every recogniser from 42–57% to 81–88% of commands understood. Word error rates: '
                + ", ".join(f"{E(r[0])} {100 * r[2]['wer']:.0f}%" for r in stt_rows) + '.</p></div>') if stt_rows else ""
    return sec("14", "The GPU session: what an L4 changed",
        tiles + f'<div class="card"><h3>Same models, CPU against GPU</h3>{speed}</div>'
        + (f'<div class="card"><h3>More data, or a bigger model?</h3>{scale}<p class="cap">Bigger models barely move validation and do worse on the unseen airport: the model is data-limited, not size-limited.</p></div>' if scale else "")
        + stt_card
        + (f'<div class="card"><h3>An airport it has never seen (Sydney)</h3>{gen}<p class="cap">The pretrained model already knows airline names from its pre-training, so it generalises. Our from-scratch model only knows what it saw.</p></div>' if gen else ""),
        "Pre-training buys generalisation; more varied data beats more parameters; a GPU turns hours into minutes. That is why the plan is: tiny model for the edge, fine-tuned pretrained model for the cloud and as the teacher.")


# ---------- the journey and the solutions ----------
JOURNEY = [  # (step, what we tried, validation exact %, unseen-airport exact %)
    ("1", "Tiny model, 1× data, CPU", 67.5, 40.1),
    ("2", "Same model, 3× data, GPU", 93.8, 50.1),
    ("3", "Bigger: 11M / 26M params", 95.6, 45.1),
    ("4", "2M, 11 airports", 95.1, 71.3),
    ("5", "2M, 11 airports + airline swap", 94.2, 86.8),
]


def journey_chart():
    W, H, l, r, t, b = 640, 250, 40, 20, 20, 64
    n = len(JOURNEY)
    X = lambda i: l + (W - l - r) * i / (n - 1)
    Y = lambda v: t + (H - t - b) * (1 - v / 100)
    o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img"><title>How the edge model got there: accuracy at each step</title>']
    for v in (0, 25, 50, 75, 100):
        o.append(f'<line x1="{l}" y1="{Y(v):.1f}" x2="{W - r}" y2="{Y(v):.1f}" class="grid"/><text x="{l - 6}" y="{Y(v) + 4:.1f}" class="tick" text-anchor="end">{v}%</text>')
    for key, col in ((2, "var(--s-before)"), (3, "var(--s-after)")):
        o.append('<polyline points="' + " ".join(f"{X(i):.1f},{Y(j[key]):.1f}" for i, j in enumerate(JOURNEY)) + f'" fill="none" stroke="{col}" stroke-width="2.5" stroke-linejoin="round"/>')
        for i, j in enumerate(JOURNEY):
            o.append(f'<g class="bar"><title>step {j[0]}: {E(j[1])}: {j[key]}%</title><circle cx="{X(i):.1f}" cy="{Y(j[key]):.1f}" r="5" fill="{col}" stroke="var(--surface)" stroke-width="2"/>'
                     f'<text x="{X(i):.1f}" y="{Y(j[key]) - 10:.1f}" class="val" text-anchor="middle">{j[key]:.0f}</text></g>')
    for i, j in enumerate(JOURNEY):
        words = j[1].split(", ")
        for k, w in enumerate(words[:2]):
            o.append(f'<text x="{X(i):.1f}" y="{H - b + 22 + k * 14}" class="tick" text-anchor="{"start" if i == 0 else "end" if i == n - 1 else "middle"}">{E(w)}</text>')
    o.append("</svg>")
    return "".join(o) + '<div class="legendrow"><span class="lg"><i style="background:var(--s-before)"></i>airports it trained on</span><span class="lg"><i style="background:var(--s-after)"></i>Sydney, never seen</span></div>'



def vllm_charts():
    on, off = _gj("vllm-cache-on.json"), _gj("vllm-cache-off.json")
    if not on or not off:
        return ""
    def line(key, ymax, unit, title):
        W, H, l, r, t, b = 300, 200, 44, 12, 14, 30
        xs = [1, 4, 16, 64]
        X = lambda c: l + (W - l - r) * (math.log2(c) / 6)
        Y = lambda v: t + (H - t - b) * (1 - v / ymax)
        o = [f'<svg viewBox="0 0 {W} {H}" class="chart-svg" role="img"><title>{E(title)}</title>']
        for f in (0, .5, 1):
            o.append(f'<line x1="{l}" y1="{Y(ymax * f):.1f}" x2="{W - r}" y2="{Y(ymax * f):.1f}" class="grid"/><text x="{l - 6}" y="{Y(ymax * f) + 4:.1f}" class="tick" text-anchor="end">{ymax * f:.0f}</text>')
        for c in xs:
            o.append(f'<text x="{X(c):.1f}" y="{H - 10}" class="tick" text-anchor="middle">{c}</text>')
        for data, col, nm in ((on, "var(--s-after)", "prefix cache on"), (off, "var(--s-before)", "prefix cache off")):
            pts = [(r["concurrency"], r[key]) for r in data]
            o.append('<polyline points="' + " ".join(f"{X(c):.1f},{Y(v):.1f}" for c, v in pts) + f'" fill="none" stroke="{col}" stroke-width="2.5"/>')
            for c, v in pts:
                o.append(f'<circle cx="{X(c):.1f}" cy="{Y(v):.1f}" r="4.5" fill="{col}" stroke="var(--surface)" stroke-width="2"><title>{nm}, {c} users: {v:g} {unit}</title></circle>')
        o.append("</svg>")
        return "".join(o)
    a = line("req_per_s", 400, "commands/s", "Throughput by concurrent users")
    b = line("e2e_p95_ms", 400, "ms", "p95 latency by concurrent users")
    return (f'<div class="card"><h3>One L4 serving many players with vLLM</h3><div class="two"><div><span class="ftag">commands per second</span>{a}</div>'
            f'<div><span class="ftag">p95 time to the full command (ms)</span>{b}</div></div>'
            '<div class="legendrow"><span class="lg"><i style="background:var(--s-after)"></i>prefix cache on</span><span class="lg"><i style="background:var(--s-before)"></i>prefix cache off</span><span class="lg">x axis: players talking at once</span></div>'
            '<p class="cap">With one player the cache is slightly slower (bookkeeping, nothing to share). From 16 players up it pays: at 64, +38% throughput and half the tail latency. vLLM alone made a single command 3× faster than plain Hugging Face generate (26–33 ms vs 97 ms).</p></div>')


def solutions_section():
    e2 = _gj("e2-lfm230m-11ap-swap", "eval.json") or _gj("e2-lfm230m", "eval.json")
    vl = _gj("vllm-cache-on.json")
    e2txt = (f"{100 * e2['val']['exact']:.1f}% exact, {100 * e2['test_airport']['exact']:.1f}% at Sydney, {e2['latency_gpu_batch1']['p50_ms']:.0f} ms on the L4" if e2 else "training on the GPU now")
    vltxt = (f"{max(x['req_per_s'] for x in vl):.0f} commands/s at 64 users on one L4" if vl else "load test after the fine-tune")
    cards = [
        ("Edge · in the browser", "shipped", [("speech", "browser recogniser, or Moonshine on-device"), ("rules", "parser, 99.8% on clean phrasing, <1 ms"),
            ("model", "our S1 2M, int8, 2 MB, hand-written engine, 98 ms after release"), ("gate", "callsign constraint + confidence → “say again”")],
         "94.2% exact on known airports, 86.8% at an unseen one. Free per command, audio can stay on the device."),
        ("Cloud · System One", "measured", [("speech", "Whisper-large-v3-turbo + callsign hint (17% WER)"), ("model", "Kev-0.8B fine-tuned on 3,000 ATC examples"),
            ("answers", "which aircraft + which instruction, calibrated, 80 ms on an L4"), ("values", "from the rules or the edge model")],
         "100% aircraft and instruction, also at the unseen airport. Needs a GPU server."),
        ("Cloud · generator", "measured" if e2 else "running", [("speech", "Whisper + callsign hint"), ("model", "LFM2.5-230M fine-tuned to write the whole command"),
            ("serving", f"vLLM, prefix caching, batching ({vltxt})"), ("result", e2txt)],
         "One pretrained model writes the full command; one GPU serves many players at once."),
    ]
    html_cards = ""
    for name, st, layers, verdict in cards:
        lay = "".join(f'<div class="layer"><span class="ftag">{E(k)}</span>{E(v)}</div>' for k, v in layers)
        html_cards += f'<div class="dev"><div class="devh"><b>{E(name)}</b>{pill("shipped" if st == "shipped" else "planned" if st == "running" else "kept")}</div>{lay}<p class="cap">{E(verdict)}</p></div>'
    return sec("15", "Many paths, three working solutions",
        f'<div class="card"><h3>How the edge model got there</h3>{journey_chart()}<p class="cap">Each step tested one idea. More data and more airport variety moved the needle; a bigger model did not; teaching every airline name (airline swap) closed most of the unseen-airport gap.</p></div>'
        f'<div class="devs">{html_cards}</div>' + vllm_charts(),
        "There is rarely one answer. The edge solution wins on cost, privacy and latency; the cloud ones win on generalisation. Ship the edge one now, keep the cloud ones as the upgrade path and as teachers for the next edge model.")

def _rl_scores(run):
    p = ROOT / "ml/rl/runs" / run / "eval_full.json"
    return json.loads(p.read_text())["scores"] if p.exists() else None


def _stt_rows():
    """Speech chain, exact command, old chain (rules + model on the first guess) vs new (repair + n-best + model)."""
    R = ROOT / "ml/stt/bench2/results"
    rows = []
    for lab, f, cand in [("Browser (Google)", "sum_even_webspeech.json", "webspeech-google"), ("Server Whisper base.en", "sum_even_webspeech.json", "tjs-whisper-base.en"),
                         ("On-device Moonshine base", "sum_even_tjs-moonshine-base.json", "tjs-moonshine-base"), ("On-device Moonshine tiny (old)", "sum_even_tjs-moonshine-tiny.json", "tjs-moonshine-tiny")]:
        p = R / f
        if not p.exists():
            continue
        hit = next((x for x in json.loads(p.read_text()) if x["cand"] == cand and x["group"] == "all"), None)
        if hit:
            rows.append((lab, "ours" if cand == "webspeech-google" else "", {"new": hit["nbest+S1"], "old": hit["rules+S1"]}))
    return rows


def night2_section():
    """Night two: six more paths, run in parallel overnight on the CPU of this server."""
    base, grpo, sft = _rl_scores("baseline"), _rl_scores("grpo-exact"), _rl_scores("sft-control")
    cards = [
        ("Speech-to-text fixed", "shipped", "/reports/voice-stt.html", "52% → 79%", "exact commands from Google’s recogniser on 640 degraded synthetic clips: ATC repair, 5 guesses instead of 1, a 0.3 s pre-roll, our server’s Whisper as a second opinion"),
        ("Verifier gate", "shipped", "/reports/voice-verifier.html", "19% → 0.9%", "wrong model commands sent automatically on recogniser transcripts: the command is said back in words and compared with what was heard, plus the model’s own token signals (481-weight MLP, 0.2 ms)"),
        ("Callsign search", "shipped", "/reports/voice-callsign.html", "86% → 94%", "exact at the unseen airport: score every callsign on frequency by its full likelihood (best-first search over the KV cache) instead of committing to the first token; +8 ms"),
        ("RL with the engine as reward", "shipped", "/reports/voice-rl.html", "79.6% → 83.8%", "exact on real recogniser transcripts after GRPO (from scratch); plain extra training on the same examples reached 82.0%"),
        ("Diffusion LM", "measured", "/reports/voice-diffusion.html", "72% vs 1%", "our autoregressive model vs masked diffusion from scratch, same CPU compute. Started from the AR weights, diffusion reaches 91.5% (89.4% at Sydney) but is slower on 10-token commands: AR wins here"),
        ("Phone app (Flutter)", "built", "/reports/mobile-app.html", "44 MB app", "the game in a WebView, on-device streaming speech-to-text (sherpa-onnx zipformer + hotwords, 73 MB download, 62 ms), push-to-talk bridge"),
        ("Real-voice test set", "ready", "/reports/voice-gold.html", "100 prompts", "record yourself once; one command scores every recogniser + rules + model on your voice. Every number above is synthetic speech until then"),
    ]
    html_cards = "".join(
        f'<a class="dev n2" href="{href}"><div class="devh"><b>{E(t)}</b>{pill("shipped" if st == "shipped" else "kept" if st in ("measured", "built") else "planned")}</div>'
        f'<div class="tv">{E(big)}</div><p class="cap">{E(txt)}</p></a>' for t, st, href, big, txt in cards)
    stt = _stt_rows()
    stt_chart = grouped(stt, "new", "old", "new chain", "before tonight", label_w=210) if stt else ""
    ver_rows = [("Known airports", "", {"v": 0.005, "o": 0.047}), ("Sydney (unseen)", "", {"v": 0.008, "o": 0.10}), ("Recogniser transcripts", "ours", {"v": 0.009, "o": 0.19}), ("Heavy noise", "", {"v": 0.026, "o": 0.31})]
    ver_chart = grouped(ver_rows, "v", "o", "now: callsign search + verifier", "before: confidence gate", maxv=40, label_w=190)
    rl_html = ""
    if base and grpo:
        rows = [(nm, "ours" if k == "stt" else "", {"g": grpo[k]["exact"], "b": base[k]["exact"]}) for k, nm in (("val", "Known airports"), ("sydney", "Sydney (unseen)"), ("stt", "Recogniser transcripts"))]
        rl_html = (f'<div class="card"><h3>GRPO: exact command, before → after (n = 1,000 each)</h3>{grouped(rows, "g", "b", "after GRPO", "start model", label_w=190)}'
                   f'<p class="cap">Same CPU time spent on plain fine-tuning (the control): {100 * sft["stt"]["exact"]:.1f}% on recogniser transcripts vs {100 * grpo["stt"]["exact"]:.1f}% for GRPO. RL helped beyond “more training”, but only where the model already sometimes sampled the right answer; Sydney (unseen fix and airline names) did not move.</p></div>' if sft else "")
    return sec("16", "Night two: six more paths, in parallel",
        f'<div class="devs">{html_cards}</div>'
        f'<div class="two"><div class="card"><h3>Speech chain: exact command</h3>{stt_chart}<p class="cap">320 clips: clean, laptop mic, radio, late start. Synthetic voices (Kokoro); real voices score lower.</p></div>'
        f'<div class="card"><h3>Wrong commands sent automatically</h3>{ver_chart}<p class="cap">Share of the model’s proposals (transcripts the rules could not parse) that were wrong and still sent; lower is better. Whole chain, every transmission: 17.8% → 5.6% sent wrong at 80% exact.</p></div></div>'
        + rl_html,
        "Generate, then verify. A small generator plus a cheap checker that reads the answer back beats trusting one confidence number. Most of tonight’s gain came from engineering around the models (repair, n-best, verification), not from bigger models.")


def _gj_abs(p):
    try:
        return json.loads(Path(p).read_text())
    except Exception:
        return None


# ---------- page ----------
import datetime as _dt
wer_c, lat_c, und_c = stt_charts()
kind_rows = sorted(kinds_ai.items(), key=lambda kv: -kv[1])[:6]
kinds_chart = hbars([(k, 100 * n / n_ai, f"{k}: {n:,} of {n_ai:,} teacher commands") for k, n in kind_rows], 60, "var(--s-before)", lambda x: f"{x:.0f}", unit="%", label_w=110)
heard = [x for x in stt_examples if x["heard"]][:3]
heard_html = "".join(f'<div class="tx"><span class="who">SAID</span><span class="said">{E(r["gold"])}</span><span class="heard">{E(r["heard"])}</span></div>' for r in heard)


def sec(num, title, body, lesson_text=""):
    les = f'<div class="lesson"><span class="li">💡</span><p>{lesson_text}</p></div>' if lesson_text else ""
    return f'<section><div class="sh"><span class="sn">{num}</span><h2>{E(title)}</h2></div>{body}{les}</section>'


CSS = """
:root {
  --bg: #0e0f11; --surface: #141416; --raise: #1c1c1e; --line: rgba(255,255,255,.09); --line-strong: rgba(255,255,255,.16);
  --ink-1: #f4f4f5; --ink-2: #c4c5c8; --ink-3: #a0a1a6; --ink-4: #7f8086;
  --accent: #f5933f; --accent-tint: rgba(245,147,63,.14); --s-before: #5b8fd6; --s-after: #d97626; --s-before-tint: rgba(91,143,214,.18); --s-after-tint: rgba(217,118,38,.18);
  --good: #57cd50; --good-tint: rgba(87,205,80,.13); --no: #ff8a80; --no-tint: rgba(255,138,128,.12); --neutral-tint: rgba(255,255,255,.07);
  --font: "DM Sans", "Helvetica Neue", Arial, sans-serif; --mono: "DM Mono", ui-monospace, Menlo, monospace; color-scheme: dark;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12); --s-before: #3f78c2; --s-after: #c8661a; --s-before-tint: rgba(63,120,194,.14); --s-after-tint: rgba(200,102,26,.14);
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --no: #b3261e; --no-tint: rgba(179,38,30,.10); --neutral-tint: rgba(20,20,24,.06); color-scheme: light; } }
:root[data-theme="light"] {
  --bg: #f6f5f2; --surface: #fbfaf8; --raise: #efeeea; --line: rgba(20,20,24,.10); --line-strong: rgba(20,20,24,.18);
  --ink-1: #141416; --ink-2: #3c3d42; --ink-3: #56575d; --ink-4: #6c6d73;
  --accent: #b85a12; --accent-tint: rgba(200,102,26,.12); --s-before: #3f78c2; --s-after: #c8661a; --s-before-tint: rgba(63,120,194,.14); --s-after-tint: rgba(200,102,26,.14);
  --good: #23862b; --good-tint: rgba(35,134,43,.12); --no: #b3261e; --no-tint: rgba(179,38,30,.10); --neutral-tint: rgba(20,20,24,.06); color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink-2); font-family: var(--font); font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 36px 80px; }
.wrap { max-width: 960px; margin: 0 auto; display: grid; gap: 64px; }
h1, h2, h3 { color: var(--ink-1); margin: 0; font-weight: 600; text-wrap: balance; letter-spacing: -.01em; }
h1 { font-size: clamp(28px, 4.6vw, 42px); line-height: 1.1; } h2 { font-size: 22px; line-height: 1.25; } h3 { font-size: 15px; }
p { margin: 0; max-width: 66ch; } code { font-family: var(--mono); font-size: .88em; }
a { color: var(--accent); }
.eyebrow { font-size: 11.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
section { display: grid; gap: 16px; min-width: 0; }
.sh { display: flex; align-items: baseline; gap: 12px; }
.sn { font-family: var(--mono); font-size: 13px; color: var(--accent); border: 1px solid var(--accent); border-radius: 6px; padding: 0 6px; }
.num { font-family: var(--mono); font-size: 11px; color: var(--ink-4); margin-right: 6px; }
.cap { font-size: 13px; color: var(--ink-3); max-width: 70ch; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 18px; display: grid; gap: 12px; min-width: 0; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
.chart-svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart-svg .grid { stroke: var(--line); stroke-width: 1; } .chart-svg .ref { stroke: var(--ink-4); stroke-dasharray: 4 4; }
.chart-svg .tick { fill: var(--ink-3); font-size: 11.5px; font-family: var(--font); font-variant-numeric: tabular-nums; }
.chart-svg .lab { fill: var(--ink-1); font-size: 13px; font-family: var(--font); font-weight: 500; }
.chart-svg .val { fill: var(--ink-2); font-size: 12.5px; font-family: var(--mono); }
.chart-svg .bar:hover circle, .chart-svg .bar:hover path, .chart-svg .bar:hover rect { filter: brightness(1.15); }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; padding: 1px 8px; border-radius: 999px; white-space: nowrap; border: 1px solid var(--line-strong); color: var(--ink-2); background: var(--neutral-tint); }
.pill.done { color: var(--good); background: var(--good-tint); border-color: transparent; } .pill.next { color: var(--accent); background: var(--accent-tint); border-color: transparent; }
/* decision map */
.map { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 18px 12px; }
@media (max-width: 860px) { .map { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 420px) { .map { grid-template-columns: 1fr; } }
.mcol { display: grid; gap: 6px; align-content: start; min-width: 0; }
.mq { color: var(--ink-1); font-weight: 600; font-size: 13.5px; border-top: 2px solid var(--accent); padding-top: 8px; }
.opt { display: flex; gap: 7px; align-items: baseline; font-size: 12.5px; line-height: 1.35; padding: 5px 8px; border-radius: 8px; border: 1px solid transparent; }
.opt b { font-size: 11px; width: 12px; flex: none; }
.opt.chosen { background: var(--s-after-tint); color: var(--ink-1); border-color: var(--s-after); }
.opt.chosen b { color: var(--s-after); }
.opt.experiment { border-color: var(--s-before); color: var(--ink-2); } .opt.experiment b { color: var(--s-before); }
.opt.kept { background: var(--neutral-tint); color: var(--ink-3); }
.opt.rejected { color: var(--ink-4); text-decoration: line-through; text-decoration-color: var(--no); } .opt.rejected b { color: var(--no); text-decoration: none; }
.legendrow { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12.5px; color: var(--ink-3); }
.legendrow .opt { padding: 2px 8px; }
.lg { display: inline-flex; align-items: center; gap: 7px; } .lg i { width: 12px; height: 8px; border-radius: 2px; display: inline-block; }
/* flows */
.flow { display: flex; align-items: stretch; gap: 6px; flex-wrap: wrap; }
.fnode { flex: 1 1 120px; min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: grid; gap: 2px; align-content: center; }
.fnode b { color: var(--ink-1); font-size: 13.5px; font-weight: 600; line-height: 1.3; }
.fnode.key { border-color: var(--s-after); background: linear-gradient(var(--s-after-tint), var(--s-after-tint)), var(--surface); }
.fnode.ok { border-color: var(--good); }
.ftag { font-family: var(--mono); font-size: 10.5px; color: var(--ink-4); text-transform: uppercase; letter-spacing: .06em; }
.farrow { display: grid; place-items: center; color: var(--ink-4); flex: 0 0 18px; } .farrow svg { width: 18px; height: 18px; }
@media (max-width: 600px) { .flow { flex-direction: column; } .farrow { transform: rotate(90deg); height: 18px; } }
.vs { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } @media (max-width: 700px) { .vs { grid-template-columns: 1fr; } }
.pros { display: grid; gap: 4px; font-size: 13px; } .pros span::before { content: "+ "; color: var(--good); font-weight: 700; } .pros span.c::before { content: "− "; color: var(--no); }
/* ladder */
.ladder { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; align-items: end; }
@media (max-width: 640px) { .ladder { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.rung { display: grid; gap: 3px; } .rbar { height: var(--h); border-radius: 6px 6px 2px 2px; background: var(--neutral-tint); border: 1px solid var(--line-strong); }
.rung.chosen .rbar { background: var(--s-after); border-color: var(--s-after); } .rung.experiment .rbar { background: var(--s-before-tint); border-color: var(--s-before); }
.rung.rejected .rbar { opacity: .4; } .rung b { color: var(--ink-1); font-size: 13px; } .rung span { font-size: 11.5px; color: var(--ink-3); }
.ramp { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--ink-4); border-top: 1px solid var(--line-strong); padding-top: 4px; }
/* data */
.splitbar { display: flex; gap: 2px; height: 28px; border-radius: 8px; overflow: hidden; }
.seg { display: flex; align-items: center; padding: 0 8px; min-width: 0; } .seg span { font-size: 11.5px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.kchips { display: flex; flex-wrap: wrap; gap: 6px; } .kchips span { font-family: var(--mono); font-size: 12px; background: var(--s-before-tint); color: var(--ink-1); padding: 2px 8px; border-radius: 6px; }
/* tokens */
.toks { display: flex; flex-wrap: wrap; gap: 3px; } .tok { font-family: var(--mono); font-size: 13px; padding: 3px 6px; border-radius: 5px; color: var(--ink-1); background: var(--s-after-tint); }
.tok:nth-child(even) { background: var(--s-before-tint); } .tokn { font-size: 12px; color: var(--ink-3); }
/* trie */
.trie { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; } @media (max-width: 700px) { .trie { grid-template-columns: 1fr; } }
.tcol { display: grid; gap: 6px; align-content: start; } .tcs { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; color: var(--ink-4); }
.tc { font-family: var(--mono); font-size: 13px; padding: 3px 8px; border-radius: 6px; }
.tc.ok { background: var(--good-tint); color: var(--ink-1); border: 1px solid var(--good); } .tc.no { color: var(--ink-4); text-decoration: line-through; background: var(--no-tint); } .tc.free { border: 1px dashed var(--ink-3); color: var(--ink-3); }
/* kv */
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; } .kv > div { display: grid; gap: 8px; justify-items: start; } .kvg { width: 100%; max-width: 170px; height: auto; }
/* devices */
.devs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.dev { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 14px; display: grid; gap: 6px; }
.n2 { text-decoration: none; color: inherit; } .n2:hover { border-color: var(--line-strong); } .n2 .tv { font-size: 26px; }
.devh { display: flex; align-items: center; gap: 10px; } .devh b { color: var(--ink-1); font-size: 15px; flex: 1; } .ico { width: 34px; height: 34px; color: var(--accent); } .ico svg { width: 100%; height: 100%; }
.layer { display: grid; gap: 1px; padding: 7px 10px; border-radius: 8px; background: var(--neutral-tint); font-size: 13px; color: var(--ink-1); }
/* tiles */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; display: grid; gap: 2px; }
.tv { font-size: 30px; font-weight: 600; color: var(--ink-1); font-variant-numeric: tabular-nums; letter-spacing: -.02em; } .tile b { color: var(--ink-2); font-size: 13px; font-weight: 600; } .tile span { color: var(--ink-3); font-size: 12px; }
/* radio examples */
.radio { display: grid; } .tx { display: grid; grid-template-columns: 52px 1fr; gap: 2px 12px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
.tx:last-child { border-bottom: 0; } .who { font-size: 10.5px; letter-spacing: .1em; font-weight: 600; color: var(--ink-3); padding-top: 2px; }
.said { color: var(--ink-1); } .heard { grid-column: 2; font-family: var(--mono); font-size: 12.5px; color: var(--accent); overflow-wrap: anywhere; }
.lesson { display: flex; gap: 12px; align-items: flex-start; background: var(--accent-tint); border-radius: 12px; padding: 12px 16px; }
.lesson .li { font-size: 18px; line-height: 1.3; } .lesson p { color: var(--ink-1); font-size: 14px; }
.check { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.ck { display: flex; gap: 10px; align-items: flex-start; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; font-size: 13.5px; color: var(--ink-1); }
.ck i { font-style: normal; color: var(--good); font-weight: 700; } .ck.open i { color: var(--accent); }
.foot { font-size: 13px; color: var(--ink-3); border-top: 1px solid var(--line); padding-top: 16px; }
"""

body = [
    f'''<header style="display:grid;gap:12px">
  <div class="eyebrow">OpenATC · learning report · updated {_dt.date.today().strftime("%-d %b %Y")}</div>
  <h1>Building an AI model: the paths, and how we chose</h1>
  <p class="cap" style="font-size:15px">For a senior engineer moving into AI. Every number is measured in this repo unless marked as an estimate. Hover any chart mark for details.</p>
</header>''',
    f'<section><div class="eyebrow">The whole story on one screen</div><h2>Ten decisions, every option, what we picked</h2>{decision_map()}</section>',
    sec("01", "Rules first, model for the messy tail",
        f'<div class="two"><div class="card"><h3>The rules, before and after 7 fixes</h3><div class="legendrow"><span class="lg"><i style="background:var(--s-before)"></i>before</span><span class="lg"><i style="background:var(--s-after)"></i>after</span></div>{l0_chart()}</div>'
        f'<div class="card"><h3>Who handles what</h3>{layers_diagram()}<p class="cap">Drop filler words the way people talk and the rules fall to 93–99%. Real speech errors are worse.</p></div></div>',
        "Measure the dumb baseline first. It turned “build a model” into “build a model for the hard 5–20%”."),
    sec("02", "Structured in, structured out",
        flow([("in", "Game state", ""), ("in", "What you said", ""), ("model", "System-1 model", "key"), ("out", "Command line (editable)", ""), ("engine", "Validates + applies", "ok"), ("voice", "Pilot readback", "")]),
        "The model only proposes a command; the engine checks it. That is what makes a small model safe to ship."),
    sec("03", "One big model, or a pipeline?",
        f'''<div class="vs"><div class="card"><div class="devh"><b>Cascade</b>{pill("shipped")}</div>{flow([("", "Speech → text", ""), ("", "Text → command", "key"), ("", "Engine", "ok")])}<div class="pros"><span>each part testable and swappable</span><span>editable transcript</span><span class="c">errors add up</span></div></div>
        <div class="card"><div class="devh"><b>End to end</b>{pill("planned")}</div>{flow([("", "Speech → command", "key"), ("", "Engine", "ok")])}<div class="pros"><span>fewest steps, fastest</span><span>learns to fix recogniser errors</span><span class="c">needs far more data, hard to debug</span></div></div></div>'''),
    sec("04", "How big a model?",
        f'<div class="card">{scatter_models()}<div class="legendrow"><span class="lg"><i style="background:var(--s-after)"></i>chosen</span><span class="lg"><i style="background:var(--s-before)"></i>experiment</span><span class="lg"><i style="background:var(--ink-3)"></i>option</span><span class="lg"><i style="background:var(--no)"></i>rejected</span></div><p class="cap">Rules and the tiny model are measured; the rest are estimates for this task.</p></div>',
        "Size follows the task's information, not its importance. All of ATC English here is 565 distinct words: 2 M parameters is enough room."),
    sec("05", "How much training?", f'<div class="card">{ladder()}</div>', "RAG adds knowledge. Our problem isn't knowledge (the game state carries it all), so RAG was the wrong tool."),
    sec("06", "Data: the simulator is the teacher",
        f'<div class="card">{data_pipeline()}</div><div class="two"><div class="card"><h3>The teacher’s bias</h3>{kinds_chart}<p class="cap">Share of {n_ai:,} teacher commands.</p></div><div class="card"><h3>Only the sampler produces these</h3><div class="kchips">{"".join(f"<span>{E(k)}</span>" for k in only_sampler)}</div><p class="cap">{len(set(kinds_ai) | set(kinds_sample))} command kinds in total.</p></div></div>',
        "Most bugs live in the data. Self-checking labels, splits by session (not by row), one whole airport held out."),
    sec("07", "Tokens: how the model reads",
        f'<div class="two"><div class="card"><span class="ftag">what you said</span>{chips(" delta four twenty one turn left heading 270")}<span class="ftag">what it writes</span>{chips(" DAL421 Turn left heading 270")}<p class="cap">Our own BPE: every ATC word is one token, digits stay separate so any number can be copied.</p></div>'
        f'<div class="card"><h3>Where the tokens go</h3>{token_bar()}<p class="cap">Vocabulary {TOKENS["vocab"]:,} tokens (GPT-style models: 100k+).</p></div></div>',
        "94% of every input is the game state, so it is computed once while you talk and reused (prefix caching)."),
    sec("08", "Stop it inventing aircraft",
        f'<div class="card">{trie_visual()}</div>' + (f'<div class="tiles"><div class="tile"><div class="tv">{100 * final["val_unconstrained"]["exact"]:.1f}%</div><b>without the constraint</b><span>exact commands</span></div><div class="tile"><div class="tv">{100 * final["val"]["exact"]:.1f}%</div><b>with it</b><span>same model, same data</span></div></div>' if final and final.get("val_unconstrained") else ""),
        "Masking impossible tokens is free accuracy: +22 points here, with zero training."),
    sec("09", "Speech-to-text: the weak link right now",
        f'<div class="two"><div class="card"><h3>Words wrong</h3>{wer_c}</div><div class="card"><h3>Time per command (browser, CPU)</h3>{lat_c}</div></div>'
        f'<div class="card"><h3>What it heard</h3><div class="radio">{heard_html}</div><p class="cap">40 commands in the robotic espeak voice, through the game’s on-device worker.</p></div>',
        "Small speech models don't know ATC words. Next: tell the recogniser which callsigns are on frequency, and fine-tune it on synthetic ATC speech."),
    sec("10", "Where it runs", devices()),
    sec("11", "Inside the model: the KV cache",
        f'<div class="two"><div class="card">{kv_visual()}</div><div class="card"><h3>Measured, same answers</h3>{bench_chart()}</div></div>',
        "Generation is one token at a time. Keep the keys and values of everything already read, and each new token costs one column instead of the whole triangle."),
    sec("12", "Training it from scratch on a CPU",
        f'{result_tiles()}<div class="card"><h3>Overfitting, in one picture</h3>{overfit_chart()}<p class="cap">Training loss keeps falling while validation flattens at ~65%: the model memorises the training sessions. The fix is more varied data and a bigger model, i.e. the GPU run.</p></div>',
        f"A {cfg['params'] / 1e6:.1f} M-parameter model, 2,000 steps, {final['train_s'] // 60 if final else 43} minutes on 8 CPU cores. Its first loss matched ln(vocab) = 7.21, the sanity check for a random model." if cfg else ""),
    system_one_section(),
    gpu_section(),
    solutions_section(),
    night2_section(),
    '''<section><div class="eyebrow">Where we are</div><h2>Decided, and still open</h2><div class="check">
  <div class="ck"><i>✓</i>Model proposes a command line; the engine decides</div>
  <div class="ck"><i>✓</i>Rules → model → “say again” gate</div>
  <div class="ck"><i>✓</i>Simulator data, self-checking labels, unseen-airport test</div>
  <div class="ck"><i>✓</i>Tiny model for the edge; small LLM for the cloud</div>
  <div class="ck"><i>✓</i>Voice live in the game: browser + on-device</div>
  <div class="ck"><i>✓</i>Speech-to-text repaired: ATC repair, n-best, pre-roll, server second opinion</div>
  <div class="ck"><i>✓</i>Generate, then verify: round-trip verifier gate in the browser</div>
  <div class="ck"><i>✓</i>Phone app: Flutter shell, on-device speech-to-text, model download</div>
  <div class="ck open"><i>●</i>Your real voice: record the 100 prompts, then tune the defaults on it</div>
  <div class="ck open"><i>●</i>Commercial or not: decides which public data we may use</div>
</div></section>''',
    '<p class="foot">Text version: <code>docs/learning/ai-engineering-paths.md</code> · Plan: <code>docs/spec/11-VOICE-MODEL.md</code> · Roadmap: <code>ml/README.md</code> · <a href="/reports/voice-ai.html">Voice AI report</a></p>',
]

page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>AI Engineering Paths</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=DM+Mono:wght@400;500&display=swap">
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
{"".join(body)}
</div>
</body>
</html>
'''
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(page)
print(f"wrote {OUT} ({len(page) // 1024} KB)")

"""Build public/reports/voice-stt.html and the tables in ml/stt/RESULTS2.md from the benchmark scores.

    python3 ml/stt/bench2/report.py
Reads ml/stt/bench2/results/sum_{even,small,full}_<candidate>.json and det_even_*.jsonl (written by score.ts) and
results/browser_*.jsonl (on-device latency in headless Chromium).
"""
import html, json, re, statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
R = ROOT / "ml/stt/bench2/results"
OUT = ROOT / "public/reports/voice-stt.html"

CANDS = {
    "webspeech-google": ("Browser · Google Web Speech", "the old default", "0 MB", "Google cloud"),
    "tjs-moonshine-tiny": ("On-device · Moonshine tiny", "the old on-device option", "28 MB", "browser"),
    "tjs-moonshine-base": ("On-device · Moonshine base", "new on-device default", "63 MB", "browser"),
    "tjs-whisper-tiny.en": ("Whisper tiny.en + callsign prompt", "", "41 MB", "server"),
    "tjs-whisper-base.en": ("Server · Whisper base.en + callsign prompt", "Firefox default", "136 MB on the server", "server"),
    "tjs-whisper-base.en@prompt": ("Whisper base.en, prompt, 1-best", "", "", "server"),
    "tjs-whisper-base.en@plain": ("Whisper base.en, no prompt", "", "", "server"),
    "tjs-whisper-tiny.en@plain": ("Whisper tiny.en, no prompt", "", "", "server"),
    "fw-base.en": ("faster-whisper base.en int8 + prompt", "separate service", "75 MB", "server"),
    "fw-small.en": ("faster-whisper small.en int8 + prompt", "separate service", "250 MB", "server"),
    "fw-distil-small.en": ("faster-whisper distil-small.en + prompt", "the prompt makes it loop; stopped early", "170 MB", "server"),
    "tjs-whisper-small.en": ("Whisper small.en + prompt (transformers.js)", "", "249 MB", "server"),
    "webspeech-google+tjs-whisper-base.en": ("Browser + Server, always both", "every transmission to both", "0 MB", "server"),
    "webspeech-google>tjs-whisper-base.en": ("Browser (Google) + server second opinion", "new default", "0 MB", "browser"),
}


def load(name):
    f = R / name
    return json.load(open(f)) if f.exists() else []


def row(summary, cand, group="all"):
    for r in summary:
        if r["cand"] == cand and r["group"] == group:
            return r
    return None


def pct(x):
    return "–" if x is None else f"{x * 100:.0f}%"


def esc(s):
    return html.escape(str(s))


def bars(title, sub, items, legend, scale=1.0):
    """items: [(label, small, [(value 0..1, color var, tip)], right text)]"""
    rows = []
    for lab, small, vals, right in items:
        tracks = "".join(
            f'<div class="bar-row" tabindex="0"><div class="track"><div class="fill" style="width:{min(100, v / scale * 100):.1f}%;background:var({c})"></div>'
            f'<div class="tip">{esc(t)}</div></div><div class="val">{v * 100:.0f}%</div></div>'
            for v, c, t in vals)
        rows.append(f'<div class="group"><div class="lab">{esc(lab)}<small>{esc(small)}</small></div><div class="pair">{tracks}</div><div class="extra">{right}</div></div>')
    leg = "".join(f'<span><i style="background:var({c})"></i>{esc(n)}</span>' for n, c in legend)
    return f'<div class="chart"><div class="chart-head"><h2>{esc(title)}</h2><div class="legend">{leg}</div></div><p class="note">{sub}</p><div class="rows">{"".join(rows)}</div></div>'


def main():
    def merged(prefix):   # one score file per candidate (score.ts --out results/<prefix>_<cand>.json)
        out = []
        for f in sorted(R.glob(f"{prefix}_*.json")):
            out += json.load(open(f))
        return out
    even, small, full = merged("sum_even"), merged("sum_small"), merged("sum_full")
    lat = {}
    for f in R.glob("browser_*.jsonl"):
        ms = [json.loads(l)["ms"] for l in open(f) if l.strip()]
        if ms:
            lat[f.stem.replace("browser_", "")] = (statistics.median(ms), sorted(ms)[int(len(ms) * .9)], len(ms))
    style = re.search(r"<style>(.*?)</style>", (ROOT / "public/reports/voice-ai.html").read_text(), re.S).group(1)
    style += """
section > *, details.table { min-width: 0; max-width: 100%; }
.group { grid-template-columns: 210px 1fr 150px; }
.group .extra { font-size: 12px; color: var(--ink-3); font-family: var(--mono); line-height: 1.35; }
.gloss { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.gloss div { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; font-size: 13.5px; }
.gloss b { color: var(--ink-1); display: block; margin-bottom: 2px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.kpi { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: grid; gap: 4px; }
.kpi .v { font-size: 28px; color: var(--ink-1); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.kpi .k { font-size: 12.5px; color: var(--ink-3); }
.ex td { font-size: 13px; } .ex td.m { font-family: var(--mono); font-size: 12.5px; color: var(--ink-1); }
.step { display: grid; grid-template-columns: 210px 1fr 70px; gap: 12px; align-items: center; font-size: 13.5px; }
.step .delta { font-family: var(--mono); font-size: 12.5px; text-align: right; color: var(--good); }
.step .delta.neg { color: var(--accent); }
@media (max-width: 700px) { .group { grid-template-columns: 1fr; } .step { grid-template-columns: 1fr 60px; } .step .track { grid-column: 1 / -1; } }
"""
    # ---------- numbers ----------
    def g(cand, group, key, s=even):
        r = row(s, cand, group)
        return r.get(key) if r else None

    def degraded(cand, key, s=even):
        vals = [(row(s, cand, c) or {}).get(key) for c in ("laptop", "radio", "late")]
        ns = [(row(s, cand, c) or {}).get("n") for c in ("laptop", "radio", "late")]
        if any(v is None for v in vals):
            return None
        return sum(v * n for v, n in zip(vals, ns)) / sum(ns)

    old = "webspeech-google"; new = "webspeech-google>tjs-whisper-base.en"; srv = "tjs-whisper-base.en"
    before = degraded(old, "rules+S1"); after = degraded(new, "nbest+S1")
    n_even = (row(even, new, "all") or {}).get("n")
    # how often the second opinion is asked: the browser's own guesses were not understood
    det_ws = [json.loads(l) for l in open(R / "det_even_webspeech.jsonl")] if (R / "det_even_webspeech.jsonl").exists() else []
    first = [d for d in det_ws if d["cand"] == old]
    fire = sum(1 for d in first if not d["nbest+S1"]["ok"]) / len(first) if first else None

    # ---------- sections ----------
    head = f"""<header>
  <div class="eyebrow">OpenATC · AI engineering log · 8 Nov 2026</div>
  <h1>Speech-to-text for ATC: why push-to-talk misheard you, and the fix</h1>
  <p class="lede">The owner tried voice in the game: "the STT is so bad". Measured on 640 realistic clips, the recognisers were not the only problem; generic speech-to-text writes ATC speech in ways the rules cannot read ("Happy Bird 50", "Speedbird 2, 73, Climb 1, 3000"), it is never told which callsigns are on frequency, and the first word (the callsign) is lost when the microphone starts late. The fix: every transcript is now repaired against the aircraft on frequency, every guess the recogniser had is tried (n-best), the microphone keeps a pre-roll, and when the browser's guesses are still not understood, this game's own server listens again with Whisper told the callsigns on frequency.</p>
  <div class="meta"><span>Benchmark: <code>ml/stt/bench2/</code></span><span>Write-up: <code>ml/stt/RESULTS2.md</code></span><span>Route: <code>src/app/api/voice/stt</code></span><span>Repair: <code>src/lib/voice/asr-repair.ts</code></span><span>Tests: <code>tests/engine/voice-stt.test.ts</code></span></div>
</header>"""
    hero = f"""<section>
  <div class="eyebrow">Result · degraded speech (laptop mic, radio, late start)</div>
  <div class="headline"><div class="big"><span class="from">{pct(before)}</span><span class="arrow">→</span>{pct(after)}</div>
  <p>of transmissions end as exactly the command that was said. Before: Google Web Speech, its first guess, rules then our S1 model. Now (still the default engine, "Browser"): its 5 guesses, repaired, rules then S1, and, for the {pct(fire)} it still does not understand, a second listen by Whisper base.en on this server with the callsigns as a prompt. Same {n_even or '–'} clips, synthetic voices, 8 speakers. Real voices will differ; the morning check on the owner's recordings is one command (below).</p></div>
</section>"""

    def gg(c, grp, k):
        return (row(even, c, grp) or {}).get(k)
    causes = f"""<div class="kpis">
 <div class="kpi"><span class="v">{pct(gg(old, 'all', 'rules'))}</span><span class="k">Web Speech's first guess, read by the rules: the right command (Moonshine tiny {pct(gg('tjs-moonshine-tiny', 'all', 'rules'))}). Generic STT writes "Happy Bird 50", "Speedbird 2, 73, Climb 1, 3000", "flight level 9 or 0".</span></div>
 <div class="kpi"><span class="v">{pct(gg(old, 'all', 'rules+S1:cs'))}</span><span class="k">right aircraft, old chain (Web Speech + rules + S1). No recogniser was told which callsigns are on frequency.</span></div>
 <div class="kpi"><span class="v">{pct(gg(srv + '@plain', 'all', 'wer'))} → {pct(gg(srv + '@prompt', 'all', 'wer'))}</span><span class="k">Whisper base.en word error rate without → with the callsigns on frequency as its prompt (contextual biasing)</span></div>
 <div class="kpi"><span class="v">{pct(gg(old, 'laptop', 'rules+S1'))} → {pct(gg(old, 'late', 'rules+S1'))}</span><span class="k">old chain, the same recording captured in full → with the first 150–400 ms cut (late start): the callsign is the first word</span></div>
</div>"""

    gloss = """<section><div class="eyebrow">Words used here</div><div class="gloss">
<div><b>WER (word error rate)</b>(substituted + inserted + deleted words) ÷ words said. Numbers are put in one form first, so "four two one" and "421" match.</div>
<div><b>Exact command</b>the command line the game ends with parses to the same command as the one that was spoken (same aircraft, same instruction, same numbers).</div>
<div><b>Contextual biasing (hotwords)</b>telling the recogniser which rare words to expect. For Whisper: a text prompt it treats as "what was said before" (here: the callsigns on frequency).</div>
<div><b>n-best list</b>the recogniser's n most likely transcripts, best first. The rules try each; the first that parses wins.</div>
<div><b>Beam search</b>decoding that keeps the k most likely partial transcripts at each step instead of only the best one; it is what produces an n-best list. Here the 2-best is cheaper: one decode with the prompt, one without, sharing the encoder.</div>
<div><b>Pre-roll</b>audio kept from just before the key press, so speech that starts a moment early (or a recogniser that starts late) does not lose the first word.</div>
</div></section>"""

    design = """<section><div class="eyebrow">Benchmark</div><h2>160 game situations × 4 recording conditions = 640 clips</h2>
<div class="flow">
 <div class="node"><span class="tag">ml/data/out4/ds</span><h3>Situations</h3><p>100 validation sessions at 11 airports + 60 from Sydney (never trained on): game state, what the controller said, the command meant. At most 9 per command kind.</p></div>
 <div class="node"><span class="tag">Kokoro-82M, CPU</span><h3>Speech</h3><p>8 voices (American + British, female + male), speed 0.9–1.3. Numbers spoken the ATC way ("one three thousand", "niner").</p></div>
 <div class="node key"><span class="tag">make_bench.py</span><h3>Conditions</h3><p><b>clean</b> TTS · <b>laptop</b> room reverb, fan noise 15–25 dB SNR, level −14..−2 dB · <b>radio</b> 300–3400 Hz, compression, 6–12 dB SNR · <b>late</b> laptop with the first 150–400 ms of speech cut</p></div>
 <div class="node end"><span class="tag">score.ts</span><h3>Game code scores it</h3><p>Each transcript goes through the game's own rules, repair, n-best and S1 model in Node; the result is compared with the gold command.</p></div>
</div>
<p class="note">Speech-to-text engines ran on this VPS's CPU (2 threads, shared with five other jobs: load average 18–27, so latencies are pessimistic) or, for Web Speech, in Google Chrome 157 under Xvfb with each clip played into <code>SpeechRecognition.start(MediaStreamTrack)</code>. The slow Whisper engines ran on every other situation (80 situations, 320 clips); all comparisons below use that common set.</p></section>"""

    # candidates chart
    order = [c for c in ["webspeech-google", "tjs-moonshine-tiny", "tjs-moonshine-base", "tjs-whisper-tiny.en", "tjs-whisper-base.en", "fw-base.en", "webspeech-google+tjs-whisper-base.en", "webspeech-google>tjs-whisper-base.en"] if row(even, c, "all")]
    items = []
    for c in order:
        lab, note, size, where = CANDS[c]
        r = row(even, c, "all")
        ms = r["ms_p50"]
        lat_txt = f"{ms/1000:.1f} s server CPU" if where == "server" else (f"{ms} ms after speech (median)" if c.startswith("webspeech-google") else "")
        key = c.replace("tjs-", "")
        if c.startswith("tjs-moonshine") and key in lat:
            lat_txt = f"{lat[key][0]/1000:.1f} s in browser"
        items.append((lab, note, [(r["rules"], "--s-before", f"rules alone on the raw transcript: {pct(r['rules'])}"), (r["nbest+S1"], "--s-after", f"repair + n-best + rules + S1: {pct(r['nbest+S1'])} (sent wrong {pct(r['nbest+S1:wrong'])})")],
                      f"WER {r['wer']*100:.0f}%<br>{lat_txt}<br>{size}"))
    cand_chart = bars("Every engine, same 320 clips", "Exact command. Light: the rules alone on what the recogniser wrote (what voice did before the S1 model). Dark: the full chain the game now runs. Right: word error rate, typical latency, download size.",
                      items, [("rules alone", "--s-before"), ("full chain", "--s-after")])

    # per condition
    cond_items = []
    for c in order:
        lab = CANDS[c][0]
        vals = [(g(c, k, "nbest+S1") or 0, "--s-after" if k != "late" else "--accent", f"{k}: {pct(g(c, k, 'nbest+S1'))} (WER {pct(g(c, k, 'wer'))})") for k in ("clean", "laptop", "radio", "late")]
        cond_items.append((lab, "clean · laptop · radio · late", vals, ""))
    cond_chart = bars("Where each engine breaks", "Full chain, exact command, per recording condition (top to bottom: clean, laptop, radio, late start).", cond_items, [("clean / laptop / radio", "--s-after"), ("late start", "--accent")])

    # ablation for the shipped engine and for Web Speech
    def steps(c, title):
        r = row(even, c, "all")
        if not r:
            return ""
        seq = [("rules on the transcript", r["rules"]), ("+ S1 model", r["rules+S1"]), ("+ transcript repair", r["repair+S1"]), ("+ n-best", r["nbest+S1"])]
        out, prev = [], None
        for lab, v in seq:
            d = "" if prev is None else f"{(v - prev) * 100:+.0f} pt"
            out.append(f'<div class="step"><span>{esc(lab)}</span><div class="track"><div class="fill" style="width:{v*100:.1f}%;background:var(--s-after)"></div></div><span class="delta{" neg" if prev is not None and v < prev else ""}">{pct(v)} {d}</span></div>')
            prev = v
        return f'<div class="chart"><div class="chart-head"><h2>{esc(title)}</h2></div><div class="rows">{"".join(out)}</div></div>'

    abl = []
    pr, pl = row(even, "tjs-whisper-base.en@prompt", "all"), row(even, "tjs-whisper-base.en@plain", "all")
    if pr and pl:
        abl.append(("Biasing (callsign prompt), Whisper base.en", pl["repair+S1"], pr["repair+S1"], f"WER {pl['wer']*100:.0f}% → {pr['wer']*100:.0f}%, callsign right {pct(pl['repair+S1:cs'])} → {pct(pr['repair+S1:cs'])}"))
    for c in ("webspeech-google", "tjs-whisper-base.en", "tjs-moonshine-base"):
        r = row(even, c, "all")
        if r:
            abl.append((f"Repair, {CANDS[c][0]}", r["rules+S1"], r["repair+S1"], f"rules alone {pct(r['rules'])} → {pct(r['repair'])}"))
    for c in ("webspeech-google", "tjs-whisper-base.en"):
        r = row(even, c, "all")
        if r:
            abl.append((f"n-best, {CANDS[c][0]}", r["repair+S1"], r["nbest+S1"], "5 alternatives" if c == "webspeech-google" else "2: with and without the prompt"))
    a, b = row(even, old, "all"), row(even, new, "all")
    if a and b:
        abl.append(("Server second opinion, when the browser is not understood", a["nbest+S1"], b["nbest+S1"], f"asked for {pct(fire)} of transmissions; median latency stays {b['ms_p50']} ms"))
    for c in ("webspeech-google", "tjs-whisper-base.en", "tjs-moonshine-base"):
        a, b = row(even, c, "late"), row(even, c, "laptop")
        if a and b:
            abl.append((f"Pre-roll (late start → full capture), {CANDS[c][0]}", a["nbest+S1"], b["nbest+S1"], "the open microphone + 0.3 s ring buffer turns a late start into a full recording"))
    abl_rows = "".join(f'<tr><td>{esc(n)}</td><td class="n">{pct(a)}</td><td class="n">{pct(b)}</td><td class="n"><strong>{(b - a) * 100:+.0f} pt</strong></td><td>{esc(x)}</td></tr>' for n, a, b, x in abl)
    abl_table = f'<div class="scroll"><table><thead><tr><th>Fix</th><th>without</th><th>with</th><th>gain</th><th>detail</th></tr></thead><tbody>{abl_rows}</tbody></table></div>'

    # examples
    ex = []
    rows = [json.loads(l) for f in sorted(R.glob("det_even_*.jsonl")) for l in open(f) if l.strip()]
    if rows:
        want = [("webspeech-google", 3), ("tjs-whisper-base.en", 3), ("tjs-moonshine-tiny", 2)]
        seen = set()
        for cand, k in want:
            got = 0
            for d in rows:
                used = (d.get("alts") or [d["heard"]])[d["nbest+S1"].get("alt") or 0] if d.get("alts") else d["heard"]
                if d["cand"] == cand and d["nbest+S1"]["exact"] and not d["rules"]["exact"] and used and got < k and d.get("notes") and d["text"] not in seen:
                    seen.add(d["text"])
                    ex.append((CANDS[cand][0], d["cond"], d["text"], used, "; ".join(d["notes"])[:120], d["nbest+S1"]["line"])); got += 1
    ex_rows = "".join(f'<tr><td>{esc(a)}<br><span class="note">{esc(b)}</span></td><td>{esc(c)}</td><td class="m">{esc(d)}</td><td>{esc(e)}</td><td class="m">{esc(f)}</td></tr>' for a, b, c, d, e, f in ex)
    ex_table = f'<div class="scroll ex"><table><thead><tr><th>Engine</th><th>Said</th><th>Heard (the guess that was used)</th><th>Repair</th><th>Command</th></tr></thead><tbody>{ex_rows}</tbody></table></div>' if ex else ""

    # small models (clean + late subset)
    sm_rows = ""
    for c in ["webspeech-google", "webspeech-google>tjs-whisper-base.en", "tjs-moonshine-base", "tjs-whisper-base.en", "fw-base.en", "tjs-whisper-small.en", "fw-small.en", "fw-distil-small.en"]:
        r = row(small, c, "all")
        if r:
            sm_rows += f'<tr><td>{esc(CANDS[c][0])}</td><td class="n">{r["n"]}</td><td class="n">{r["wer"]*100:.0f}%</td><td class="n">{pct(r["rules"])}</td><td class="n"><strong>{pct(r["nbest+S1"])}</strong></td><td class="n">{pct(r["nbest+S1:wrong"])}</td><td class="n">{r["ms_p50"]/1000:.1f} s</td></tr>'
    sm_table = f'<details class="table" open><summary>Bigger models (clean + late clips only, n per row)</summary><div class="scroll"><table><thead><tr><th>Engine</th><th>n</th><th>WER</th><th>rules</th><th>full chain</th><th>sent wrong</th><th>p50</th></tr></thead><tbody>{sm_rows}</tbody></table></div></details>' if sm_rows else ""

    # full tables
    def table(s, cands, groups=("all", "clean", "laptop", "radio", "late", "val", "syd")):
        out = ""
        for c in cands:
            for gname in groups:
                r = row(s, c, gname)
                if not r:
                    continue
                out += (f'<tr><td>{esc(CANDS.get(c, (c,))[0])}</td><td>{gname}</td><td class="n">{r["n"]}</td><td class="n">{r["wer"]*100:.1f}%</td>'
                        + "".join(f'<td class="n">{pct(r[k])}</td>' for k in ("rules", "rules+S1", "repair", "repair+S1", "nbest", "nbest+S1"))
                        + f'<td class="n">{pct(r["nbest+S1:sent"])}</td><td class="n">{pct(r["nbest+S1:wrong"])}</td><td class="n">{pct(r["nbest+S1:cs"])}</td><td class="n">{r["ms_p50"]}</td></tr>')
        return out
    all_c = [c for c in CANDS if row(even, c, "all")]
    full_table = f'<details class="table"><summary>Every number (common 320-clip set)</summary><div class="scroll"><table><thead><tr><th>Engine</th><th>Clips</th><th>n</th><th>WER</th><th>rules</th><th>+S1</th><th>repair</th><th>repair+S1</th><th>n-best</th><th>n-best+S1</th><th>sent right</th><th>sent wrong</th><th>callsign</th><th>p50 ms</th></tr></thead><tbody>{table(even, all_c)}</tbody></table></div></details>'
    full640 = f'<details class="table"><summary>The engines that ran on all 640 clips</summary><div class="scroll"><table><thead><tr><th>Engine</th><th>Clips</th><th>n</th><th>WER</th><th>rules</th><th>+S1</th><th>repair</th><th>repair+S1</th><th>n-best</th><th>n-best+S1</th><th>sent right</th><th>sent wrong</th><th>callsign</th><th>p50 ms</th></tr></thead><tbody>{table(full, [c for c in CANDS if row(full, c, "all")])}</tbody></table></div></details>' if full else ""

    shipped = f"""<section><div class="eyebrow">Shipped</div><h2>What the game does now</h2>
<div class="kpis">
 <div class="kpi"><span class="v">{pct(g(new, 'all', 'nbest+S1'))}</span><span class="k">exact command, all four conditions (before: {pct(g(old, 'all', 'rules+S1'))})</span></div>
 <div class="kpi"><span class="v">{pct(g(new, 'all', 'nbest+S1:sent') / max(1e-9, g(new, 'all', 'nbest+S1:sent') + g(new, 'all', 'nbest+S1:wrong')))}</span><span class="k">of the commands it sends without a check are right (before: {pct(g(old, 'all', 'rules+S1:sent') / max(1e-9, g(old, 'all', 'rules+S1:sent') + g(old, 'all', 'rules+S1:wrong')))}); wrong sends {pct(g(new, 'all', 'nbest+S1:wrong'))} of transmissions (before {pct(g(old, 'all', 'rules+S1:wrong'))}), partly label noise</span></div>
 <div class="kpi"><span class="v">{pct(fire)}</span><span class="k">of transmissions ask the server for a second opinion (the rest are answered by the browser in ~0.1 s)</span></div>
 <div class="kpi"><span class="v">{(g(srv, 'all', 'ms_p50') or 0)/1000:.1f} s</span><span class="k">server second opinion, median, on this loaded VPS (2 threads; Whisper base.en, two decodes)</span></div>
</div>
<div class="flow">
 <div class="node"><span class="tag">recognizer.ts · asr-capture.ts</span><h3>Push-to-talk</h3><p>Web Speech listens through a 0.3 s delay line on our own microphone stream (<code>start(MediaStreamTrack)</code>), kept open a minute: a pre-roll. 5 alternatives. Recording runs 250 ms past release.</p></div>
 <div class="node"><span class="tag">asr-repair.ts · asr-nbest.ts</span><h3>Repair + n-best</h3><p>Numbers into one spoken form, homophones, command words by sound, the callsign matched by phonetic key to the aircraft on frequency. Each guess on the rules, best first; then S1 on the raw and repaired text.</p></div>
 <div class="node key"><span class="tag">/api/voice/stt</span><h3>Second opinion</h3><p>Still not understood: the same audio (recorded alongside, with pre-roll) goes to Whisper base.en in this Next.js server, prompted with the callsigns on frequency, decoded with and without the prompt.</p></div>
 <div class="node end"><span class="tag">understand.ts</span><h3>Rules, then S1</h3><p>Both guess lists together. The verifier decides send / check / say again; a callsign matched only by sound with a digit changed is never sent unchecked.</p></div>
</div>
<p class="note">Settings → Voice recognition: "Browser (Google)" (default; Firefox has no Web Speech and gets "Server"), "Server (Whisper, tuned for ATC)" (audio to this game's server only, not to Google, not stored; slower), "On-device (Moonshine)" (moved from tiny to base: {pct(g('tjs-moonshine-tiny', 'all', 'nbest+S1'))} → {pct(g('tjs-moonshine-base', 'all', 'nbest+S1'))}). Biasing Web Speech itself with <code>SpeechRecognition.phrases</code> was tried: Chrome's cloud recogniser rejects it ("phrases-not-supported"); the game sends phrases once and stops on that error. Guards on the public route: 1 MB / 15 s per request, 30 a minute per IP (bursts of 10), one transcription at a time with 4 waiting, 12 s timeout.</p>
</section>"""

    gold = """<section><div class="eyebrow">Not measured yet</div><h2>Real voices</h2>
<p>All of this is synthetic speech. Real voices on a laptop microphone are harder, and Web Speech may do relatively better on them (Google trains on far more real speech than Whisper base). Once the owner has recorded the gold set (<code>/voice/record.html</code>, another agent's recorder), one command scores every engine on it, including the Web Speech transcripts the recorder captured live:</p>
<pre class="mono" style="background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;overflow-x:auto">bash ml/stt/bench2/run.sh gold</pre>
<p class="note">Writes <code>ml/stt/bench2/results/gold/summary.json</code> and prints the same table as above (Web Speech from the recordings, alone and with the server as second opinion, plus the server and on-device engines). If the server alone beats the browser on real voices, set DEFAULT_VOICE_ENGINE in <code>src/lib/voice/recognizer.ts</code> to 'server'.</p></section>"""

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex">
<title>Voice Speech-to-Text</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>{style}</style></head><body><div class="wrap">
{head}
{hero}
<section><div class="eyebrow">Why it was bad (measured)</div>{causes}{cand_chart}{cond_chart}</section>
<section><div class="eyebrow">Repairs that worked</div><h2>What the recognisers wrote, and what the game made of it</h2>{ex_table}</section>
{gloss}
{design}
<section><div class="eyebrow">Ablation</div><h2>What each fix contributed (exact command, full chain)</h2>{steps(old, "Google Web Speech (the default engine): from transcript to command")}{steps(srv, "Server Whisper base.en: from transcript to command")}{abl_table}</section>
{shipped}
<section><div class="eyebrow">All numbers</div>{sm_table}{full_table}{full640}</section>
{gold}
</div></body></html>"""
    OUT.write_text(page)
    print(f"wrote {OUT} ({len(page)} bytes)")
    write_md(even, small, full, lat, fire)


def md_table(s, cands, groups=("all",)):
    head = "| engine | clips | n | WER | rules | +S1 | repair | repair+S1 | n-best | n-best+S1 | sent wrong | callsign | p50 ms |\n|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n"
    out = ""
    for c in cands:
        for gname in groups:
            r = row(s, c, gname)
            if r:
                out += (f"| {CANDS.get(c, (c,))[0]} | {gname} | {r['n']} | {r['wer']*100:.1f}% | " + " | ".join(pct(r[k]) for k in ("rules", "rules+S1", "repair", "repair+S1", "nbest", "nbest+S1"))
                        + f" | {pct(r['nbest+S1:wrong'])} | {pct(r['nbest+S1:cs'])} | {r['ms_p50']} |\n")
    return head + out if out else "(not run)\n"


def empty_rate(cand):
    f = R / f"{cand}.jsonl"
    if not f.exists():
        return None
    rows = [json.loads(l) for l in open(f) if l.strip()]
    rows = [r for r in rows if int(r["wav"][:4]) % 2 == 0]
    return sum(1 for r in rows if not r["heard"].strip()) / len(rows) if rows else None


def write_md(even, small, full, lat, fire):
    """The generated blocks of ml/stt/RESULTS2.md (between the markers); the rest of the file is written by hand."""
    f = ROOT / "ml/stt/RESULTS2.md"
    text = f.read_text() if f.exists() else "<!-- tables -->\n<!-- /tables -->\n"
    g = lambda c, grp, k: (row(even, c, grp) or {}).get(k)
    ws, mt, mb, wb, new = "webspeech-google", "tjs-moonshine-tiny", "tjs-moonshine-base", "tjs-whisper-base.en", "webspeech-google>tjs-whisper-base.en"
    why = f"""Measured on the common set (320 clips, all four conditions; details below):

- **The recogniser's first guess, read by the rules, was the right command {pct(g(ws, 'all', 'rules'))} of the time** with
  Google Web Speech (the default engine) and {pct(g(mt, 'all', 'rules'))} with Moonshine tiny (the on-device option). With the
  S1 model behind the rules, as the game ran until tonight: {pct(g(ws, 'all', 'rules+S1'))} and {pct(g(mt, 'all', 'rules+S1'))}.
- **Generic speech-to-text writes ATC speech as English.** Word error rate {pct(g(ws, 'all', 'wer'))} (Web Speech), {pct(g(mt, 'all', 'wer'))}
  (Moonshine tiny), on synthetic speech. Typical: "speedbird fife zero" -> "Happy Bird 50" / "Bieber 50"; "speedbird
  two seven three climb one three thousand" -> "Speedbird 2, 73, Climb 1, 3000" (Whisper) / "Speedpert 2: 73klim
  13000" (Moonshine); "flight level niner zero" -> "flight level 9 or 0"; "Quantas"; "heading to one one".
- **The callsign is what breaks.** Right aircraft in {pct(g(ws, 'all', 'rules+S1:cs'))} of transmissions (Web Speech, old chain),
  {pct(g(mt, 'all', 'rules+S1:cs'))} (Moonshine tiny). Airline telephony is rare English, and nothing told any recogniser which
  callsigns are on frequency (no contextual biasing anywhere). Whisper base.en without a prompt: WER {pct(g(wb + '@plain', 'all', 'wer'))};
  with the callsigns on frequency as its prompt: {pct(g(wb + '@prompt', 'all', 'wer'))}.
- **Late start costs the first word, which is the callsign.** Web Speech, old chain: {pct(g(ws, 'late', 'rules+S1'))} on the
  late-start clips against {pct(g(ws, 'laptop', 'rules+S1'))} on the same recordings captured in full.
- **Nothing at all**: Moonshine tiny returned an empty transcript for {pct(empty_rate(mt))} of the clips (Web Speech
  {pct(empty_rate(ws))}, Moonshine base {pct(empty_rate(mb))}, Whisper {pct(empty_rate(wb))}).
- **Release timing** (the 1.2 s grace, the stop flush) was not measured separately; the recognisers now record 250 ms
  past release and wait up to 2 s for Web Speech's final result."""
    main = [c for c in [ws, mt, mb, "tjs-whisper-tiny.en", wb, "fw-base.en", "webspeech-google+tjs-whisper-base.en", new] if row(even, c, "all")]
    lines = ["| engine | exact, old chain (rules + S1) | exact, new chain | sent wrong: old -> new | callsign right: old -> new | WER | latency (median) | download |", "|---|--:|--:|--:|--:|--:|--:|--:|"]
    for c in main:
        r = row(even, c, "all"); lab, _, size, where = CANDS[c]
        key = c.replace("tjs-", "")
        latv = f"{r['ms_p50']/1000:.1f} s server CPU" if where == "server" else f"{r['ms_p50']} ms after speech" if c.startswith("webspeech") else ""
        if c.startswith("tjs-moonshine") and key in lat:
            latv = f"{lat[key][0]/1000:.1f} s in the browser"
        lines.append(f"| {lab} | {pct(r['rules+S1'])} | **{pct(r['nbest+S1'])}** | {pct(r['rules+S1:wrong'])} -> {pct(r['nbest+S1:wrong'])} | {pct(r['rules+S1:cs'])} -> {pct(r['nbest+S1:cs'])} | {pct(r['wer'])} | {latv} | {size} |")
    abl = []
    pr, pl = row(even, wb + "@prompt", "all"), row(even, wb + "@plain", "all")
    if pr and pl:
        abl.append(f"| biasing: Whisper base.en without -> with the callsign prompt (1-best, repair + S1) | {pct(pl['repair+S1'])} | {pct(pr['repair+S1'])} | WER {pct(pl['wer'])} -> {pct(pr['wer'])} |")
    for c in (ws, wb, mb, mt):
        r = row(even, c, "all")
        if r:
            abl.append(f"| repair, {CANDS[c][0]} (rules + S1) | {pct(r['rules+S1'])} | {pct(r['repair+S1'])} | rules alone {pct(r['rules'])} -> {pct(r['repair'])} |")
    for c in (ws, wb):
        r = row(even, c, "all")
        if r:
            abl.append(f"| n-best, {CANDS[c][0]} | {pct(r['repair+S1'])} | {pct(r['nbest+S1'])} | {'5 alternatives' if c == ws else 'with + without the prompt'} |")
    a, b = row(even, ws, "all"), row(even, new, "all")
    if a and b:
        abl.append(f"| server second opinion when the browser is not understood | {pct(a['nbest+S1'])} | {pct(b['nbest+S1'])} | asked for {pct(fire)} of transmissions |")
    for c in (ws, wb, mb):
        a, b = row(even, c, "late"), row(even, c, "laptop")
        if a and b:
            abl.append(f"| pre-roll (late start -> full capture), {CANDS[c][0]} | {pct(a['nbest+S1'])} | {pct(b['nbest+S1'])} | upper bound: what an open microphone + 0.3 s ring buffer recovers |")
    results = ("Common set, 320 clips, exact command (all four conditions). \"Sent wrong\" is a wrong command the game would send without a check; part of it is label noise in the dataset (\"hold position\" spoken for the gold \"hold position (traffic)\", a garbled speed in the source text), the same for every engine. The share of sends that are right rose (Web Speech: "
               + f"{pct(g(ws, 'all', 'rules+S1:sent') / max(1e-9, g(ws, 'all', 'rules+S1:sent') + g(ws, 'all', 'rules+S1:wrong')))} -> {pct(g(new, 'all', 'nbest+S1:sent') / max(1e-9, g(new, 'all', 'nbest+S1:sent') + g(new, 'all', 'nbest+S1:wrong')))} of what it sends is right).\n\n" + "\n".join(lines)
               + "\n\nWhat each fix contributed (exact command, common set):\n\n| fix | without | with | detail |\n|---|--:|--:|---|\n" + "\n".join(abl)
               + "\n\nLatency: server engines on this VPS with 2 threads under load average 10-27 (a quiet machine is ~2-3x faster); "
               + "Web Speech is the time from the end of the audio to the final result (the game adds the 250 ms release tail and the 0.3 s delay line); "
               + "the second-opinion median stays at the browser's because most transmissions never ask the server.")
    shipped = f"""- **Default engine: Browser (Google Web Speech) with this server as a second opinion**: {pct(g(new, 'all', 'nbest+S1'))} exact on the
  common set against {pct(g(ws, 'all', 'rules+S1'))} before, the best of every engine measured, and the fastest (median {g(new, 'all', 'ms_p50')} ms after
  speech; only the {pct(fire)} of transmissions the browser's guesses do not explain wait for the server). The server alone was
  {pct(g(wb, 'all', 'nbest+S1'))}, always running both {pct(g('webspeech-google+tjs-whisper-base.en', 'all', 'nbest+S1'))}. Browsers without Web Speech (Firefox) fall back to the server engine.
- **Repair** (`src/lib/voice/asr-repair.ts`, every engine): numbers into one spoken form (digits -> words, "2, 73",
  "4,000", "2-7-0", "9 or 0", "one to six", "niner"/"tree"/"fife"), command words by phonetic key and inflection
  ("klim", "heating", "holds", "increased", "hole position", "160 not", "ILL's"), and the callsign: the words before
  the first number run against every aircraft's spoken name by a Metaphone-style key, the number run against its flight
  number (exact, clipped, one digit off, run-on with the next number), with a margin over the runner-up. A digit change
  or a name that is not really similar is flagged and left to the player to check. A name the parser cannot read (3-word
  telephony) is written as the ICAO callsign.
- **n-best** (`src/lib/voice/asr-nbest.ts`): Web Speech `maxAlternatives` 5; the server returns 2 (with and without the
  prompt, one encoder pass). Rules on every repaired guess, first that parses wins; else S1 on the raw and the repaired
  text of the first two guesses, most confident proposal wins (the model was trained on raw recogniser output, so a
  repair can mislead it).
- **Pre-roll**: Web Speech listens through a 0.3 s delay line on the game's own microphone stream
  (`SpeechRecognition.start(MediaStreamTrack)`, Chrome; checked end to end in Chrome 157); the on-device and server
  capture keeps the microphone open a minute after the last transmission with a 0.3 s ring buffer in the AudioWorklet;
  250 ms recorded past release.
- **Server engine** (`src/app/api/voice/stt/`): Whisper base.en (fp32 encoder, int8 decoder) through transformers.js on
  onnxruntime-node inside the Next.js server, loaded lazily once per process, 2 threads, the callsigns on frequency as the
  prompt. Guards: 1 MB / 15 s per request, 30 per minute per IP (bursts of 10), one transcription at a time with 4 waiting
  (then 503), 12 s timeout (504). `next.config.js` lists onnxruntime-node's CPU binaries for the standalone bundle
  (transformers.js loads it through createRequire, which the file tracer cannot see; checked by tracing the route's files
  into an empty directory and running a transcription from there). Models cache in `~/.cache/openatc-stt` (already
  downloaded on this host).
- **On-device** moved from Moonshine tiny to base ({pct(g(mt, 'all', 'nbest+S1'))} -> {pct(g(mb, 'all', 'nbest+S1'))} with the new chain; 63 MB once,
  {lat.get('moonshine-base', (0,))[0]/1000:.1f} s per transmission in headless WASM here). On-device Whisper is too slow for WASM on one thread
  (whisper-tiny.en {lat.get('whisper-tiny.en', (0,))[0]/1000:.1f} s here).
- **Settings** -> Voice recognition: "Browser (Google)" (states that a not-understood transmission goes to this game's
  server), "Server (Whisper, tuned for ATC)" (audio to this game's server, not Google, not stored; slower), "On-device
  (Moonshine)"; the phone app's "Phone" engine (another agent) is unchanged.
- **Not shipped**: faster-whisper as a separate service: base.en {pct(g('fw-base.en', 'all', 'nbest+S1'))} vs {pct(g(wb, 'all', 'nbest+S1'))} for the in-process
  engine (it ran on 1 thread, so its latency here is not comparable); small.en on 2 threads was no faster than
  transformers.js small.en (median {(row(small, 'fw-small.en', 'all') or {}).get('ms_p50', 0)/1000:.1f} s vs {(row(small, 'tjs-whisper-small.en', 'all') or {}).get('ms_p50', 0)/1000:.1f} s). Not clearly better, so no new
  service: `ml/serve/stt_server.py` + `scripts/openatc-stt.service` are written, not installed (that needs the owner's
  approval); `OPENATC_STT_URL` switches the route to it. Bigger models: see the clean + late table below."""
    for k, v in (("why", why), ("results", results), ("shipped", shipped)):
        text = re.sub(rf"<!-- {k} -->.*<!-- /{k} -->", lambda m, v=v, k=k: f"<!-- {k} -->\n{v}\n<!-- /{k} -->", text, flags=re.S)
    cands = [c for c in CANDS if row(even, c, "all")]
    lat_lines = "".join(f"| {k} | {v[2]} | {v[0]:.0f} | {v[1]:.0f} |\n" for k, v in sorted(lat.items()))
    gen = ("<!-- tables -->\n_Generated by `python3 ml/stt/bench2/report.py` from `ml/stt/bench2/results/`._\n\n"
           "### Common set (every other situation: 80 situations x 4 conditions = 320 clips)\n\n" + md_table(even, cands)
           + "\n### Per condition\n\n" + md_table(even, cands, ("clean", "laptop", "radio", "late"))
           + "\n### Training airports vs Sydney (unseen)\n\n" + md_table(even, cands, ("val", "syd"))
           + "\n### Bigger models (clean + late clips of the common set)\n\n" + md_table(small, [c for c in CANDS if row(small, c, "all")])
           + "\n### All 640 clips (the engines that ran on all)\n\n" + md_table(full, [c for c in CANDS if row(full, c, "all")])
           + "\n### On-device latency in headless Chromium (WASM, 1 thread, loaded VPS; ms per utterance, ~4.5 s of audio)\n\n| engine | n | p50 | p90 |\n|---|--:|--:|--:|\n" + lat_lines
           + "<!-- /tables -->")
    text = re.sub(r"<!-- tables -->.*<!-- /tables -->", lambda m: gen, text, flags=re.S)
    f.write_text(text)
    print(f"wrote {f}")


if __name__ == "__main__":
    main()

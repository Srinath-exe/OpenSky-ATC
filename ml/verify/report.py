"""Build public/reports/voice-verifier.html and ml/verify/RESULTS.md from ml/verify/out/results.json (ml/verify/fit.py).

    python3 ml/verify/report.py
"""
import html, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ml/verify/out"
import re as _re
DEFAULT = _re.search(r"S1_MODEL_URL = '([^']+)'", (ROOT / "src/lib/voice/l1.ts").read_text()).group(1)
TAG = DEFAULT.rsplit("/", 1)[-1]
R = json.load(open(OUT / TAG / "results.json"))
PAR = json.load(open(OUT / TAG / "parity.json")) if (OUT / TAG / "parity.json").exists() else None
BENCH = json.load(open(OUT / TAG / "bench.json")) if (OUT / TAG / "bench.json").exists() else None
REG = json.load(open(ROOT / "public/models/verifier/roundtrip-v1/verifier.json"))
VER = REG["models"][DEFAULT]
# every S1 model with a fitted gate, for the side-by-side table (the shipped one first)
MODELS = sorted((json.load(open(f)) for f in OUT.glob("*/results.json")), key=lambda x: (x.get("s1_model") != DEFAULT, x.get("s1_model", "")))
SETS = [("stt", "Real recognisers", "Kokoro speech through 5 speech-to-text models"), ("noisy", "Heavy noise", "val commands, STT-style damage"),
        ("syd", "Sydney", "an airport S1 never saw"), ("val", "Validation", "11 training airports, held-out sessions")]
CANDS = [("a_conf", "a. Confidence (today's gate)"), ("b_cs_margin", "b. Callsign trie margin"), ("b_min_token_p", "b. Lowest token probability"),
         ("b_digit_margin", "b. Digit-token margin"), ("b_s1_callsign_margin", "b. System One callsign margin"), ("b_lh_callsign_margin", "b. Callsign likelihood margin (search)"), ("c_round_trip", "c. Round trip (hand weights)"),
         ("d_lr_gen", "d. Logistic reg., decoder signals"), ("d_lr_round_trip+conf", "d. Logistic reg., round trip + confidence"),
         ("d_lr_round_trip+gen", "d. Logistic reg., round trip + decoder"), ("d_mlp_round_trip+gen", "d. Small MLP (16 units), round trip + decoder"), ("d_trunk_head", "d. Head on the S1 trunk"), ("e_shipped", "e. MLP + veto rules")]
SHIP = R.get("shipped_key", "e_shipped")
# six lines (the palette's validated count): today's gate, best free signal, round trip, the two combiners, shipped last
CHART = ["a_conf", "b_min_token_p", "c_round_trip", "d_lr_round_trip+gen", "d_mlp_round_trip+gen", SHIP]
NAME = dict(CANDS)
e = html.escape


def pct(x, d=1):
    return "–" if x is None else f"{x * 100:.{d}f}%"


def svg_rc(curves, ymax=0.2):
    """Risk-coverage lines for one set: x = coverage (share of proposals auto-sent), y = risk (wrong among them)."""
    W, H, L, B, T, Rr = 440, 250, 44, 30, 10, 10
    pw, ph = W - L - Rr, H - T - B
    X = lambda c: L + c * pw
    Y = lambda r: T + ph - min(r, ymax) / ymax * ph
    s = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="risk-coverage curves" class="rc">']
    for t in [0, 0.05, 0.1, 0.15, 0.2]:
        if t <= ymax:
            s.append(f'<line x1="{L}" x2="{W - Rr}" y1="{Y(t):.1f}" y2="{Y(t):.1f}" class="grid"/><text x="{L - 6}" y="{Y(t) + 4:.1f}" class="tick" text-anchor="end">{"≥" if t >= ymax else ""}{int(t * 100)}%</text>')
    for c in [0, 0.25, 0.5, 0.75, 1]:
        s.append(f'<text x="{X(c):.1f}" y="{H - 10}" class="tick" text-anchor="middle">{int(c * 100)}%</text>')
    s.append(f'<line x1="{L}" x2="{W - Rr}" y1="{Y(0.01):.1f}" y2="{Y(0.01):.1f}" class="target"/><text x="{W - Rr}" y="{Y(0.01) - 4:.1f}" class="tick" text-anchor="end">1% wrong</text>')
    for i, k in enumerate(CHART):
        if k not in curves:
            continue
        pts = " ".join(f"{X(c):.1f},{Y(r):.1f}" for c, r in curves[k]["curve"])
        s.append(f'<polyline points="{pts}" class="s s{i + 1}{" ship" if k == SHIP else ""}"><title>{e(NAME[k])}: AUROC {curves[k]["auroc"]:.3f}, '
                 f'{pct(curves[k]["cov_at_1pct"])} of correct commands auto-sent at ≤1% wrong</title></polyline>')
    s.append("</svg>")
    return "".join(s)


def legend():
    return '<div class="legend">' + "".join(f'<span><i class="k{i + 1}"></i>{e(NAME[k])}</span>' for i, k in enumerate(CHART)) + "</div>"


def compare_section():
    """S1 checkpoints side by side, each with the gate fitted for it (same procedure, its own thresholds)."""
    if len(MODELS) < 2:
        return ""
    cols = [("val", "Validation"), ("syd", "Sydney"), ("stt", "Real recognisers")]
    head = "<tr><th>S1 model (gate thresholds)</th>" + "".join(f'<th class="n">{t}<br><small>exact · sent @1% · wrong sent (fixed) · say-again missed</small></th>' for _, t in cols) + "</tr>"
    rows = []
    for m in MODELS:
        th = m["thresholds"]["full"]
        cells = []
        for s, _ in cols:
            p = m["sets"].get(s, {}).get("prod")
            if not p:
                cells.append('<td class="n">–</td>'); continue
            sa = p.get("say_again", {})
            miss = f'{sa.get("missed", 0)} of {sa.get("gold", 0)} (sent {sa.get("missed_sent", 0)})' if sa.get("gold") else "n/a"
            cells.append(f'<td class="n">{pct(p.get("l1_exact"))} · <b>{pct(p["scores"]["e_shipped"]["cov_at_1pct"])}</b> · {p["shipped"]["sent_wrong"]} ({pct(p["shipped"]["risk"])}) · {miss}</td>')
        name = m.get("s1_model", "?").rsplit("/", 1)[-1] + (" (shipped)" if m.get("s1_model") == DEFAULT else "")
        rows.append(f'<tr{" class=ship" if m.get("s1_model") == DEFAULT else ""}><td>{e(name)}<br><small class="mono">send ≥ {th["send"]:.3f} · say again &lt; {th["sayAgain"]:.3f}</small></td>{"".join(cells)}</tr>')
    return f"""<section>
  <div class="eyebrow">S1 checkpoints</div>
  <h2>Each S1 model with its own gate</h2>
  <p>The gate is refitted per model (<code>ml/verify/refit.sh public/models/s1/&lt;name&gt;</code>) and keyed by the model URL, so switching <code>S1_MODEL_URL</code> picks up the matching thresholds. Columns, on transcripts the rules could not parse: share of them the model gets exactly right (say again included) · share of correct proposals auto-sent at ≤ 1% wrong (best threshold on that set) · wrong commands sent at the fixed dev thresholds · “say again” transcripts where the model proposed a command instead, and how many of those the gate still sent.</p>
  <div class="scroll"><table>{head}{"".join(rows)}</table></div>
</section>"""


def main():
    sets = R["sets"]
    th = R["thresholds"]["full"]
    stt = sets.get("stt", {}).get("prod")
    # ---- headline ----
    hb, hs = stt["baseline"], stt["shipped"]
    head = (f'<div class="headline"><div class="big">{hb["sent_wrong"]}<span class="arrow">→</span>{hs["sent_wrong"]}</div>'
            f'<p>wrong commands sent on their own, out of {stt["n_gated"]} model proposals on real recogniser transcripts the rules could not parse '
            f'(today\'s confidence gate → the verifier). The verifier still sends <b>{pct(hs["coverage"], 0)}</b> of the correct ones '
            f'(today: {pct(hb["coverage"], 0)}); the rest wait in the command bar for one keypress.</p></div>')
    # ---- examples ----
    def tx(rows, caught):
        out = []
        for r in rows[:8]:
            how = (" · veto → check" if r.get("veto") and r["gate"] != "say again" else " · " + r["gate"]) if caught else " · sent"
            tag = f'<em>conf {r["conf"]:.2f} → verifier {r["p"]:.2f}{how}</em>'
            out.append(f'<div class="tx"><div class="who">{e(r["set"].split()[0].upper())}</div><div class="said">“{e(r["said"])}”</div>'
                       f'<div class="line"><span>{e(r["line"])}</span><em>meant</em><span class="gold">{e(r["gold"])}</span>{tag}</div></div>')
        return '<div class="radio">' + "".join(out) + "</div>"
    def mix(key, per=2):   # a few from each set, real recognisers first
        out = []
        for s, t, _ in SETS:
            out += [{**x, "set": t} for x in sets.get(s, {}).get("prod", {}).get(key, [])[:per]]
        return out
    caught, missed = mix("caught"), mix("missed")
    # ---- tables ----
    def auroc_table(pop):
        h = "<tr><th>Score for “the proposal is correct”</th>" + "".join(f'<th class="n">{e(t)}<br><small>AUROC · sent @1%</small></th>' for s, t, _ in SETS if s in sets) + "</tr>"
        rows = []
        for k, label in CANDS:
            cells = []
            for s, _, _ in SETS:
                if s not in sets or pop not in sets[s]:
                    continue
                v = sets[s][pop]["scores"].get(k)
                cells.append(f'<td class="n">{v["auroc"]:.3f} · {pct(v["cov_at_1pct"], 0)}</td>' if v else '<td class="n">–</td>')
            strong = ' class="ship"' if k == SHIP else ""
            rows.append(f"<tr{strong}><td>{e(label)}{' (shipped)' if k == SHIP else ''}</td>{''.join(cells)}</tr>")
        ns = "".join(f'<td class="n">n={sets[s][pop]["n_gated"]}, {sets[s][pop]["wrong"]} wrong ({pct(sets[s][pop]["error_rate"])})</td>' for s, _, _ in SETS if s in sets and pop in sets[s])
        return f'<div class="scroll"><table>{h}{"".join(rows)}<tr class="foot"><td>proposals scored</td>{ns}</tr></table></div>'

    def outcome_table():
        h = "<tr><th>Set (rules failed → model)</th><th>Gate</th><th class='n'>sent</th><th class='n'>sent wrong</th><th class='n'>correct sent</th><th class='n'>check (wrong / correct)</th><th class='n'>say again (wrong / correct)</th></tr>"
        rows = []
        for s, t, _ in SETS:
            p = sets.get(s, {}).get("prod")
            if not p:
                continue
            for g, lab in (("baseline", "confidence ≥ 0.5"), ("shipped", "verifier")):
                o = p[g]
                rows.append(f'<tr{" class=ship" if g == "shipped" else ""}><td>{e(t) if g == "baseline" else ""}</td><td>{lab}</td><td class="n">{o["sent"]}</td><td class="n">{o["sent_wrong"]} ({pct(o["risk"])})</td>'
                            f'<td class="n">{pct(o["coverage"])}</td><td class="n">{o["check_wrong"]} / {o["check_correct"]}</td><td class="n">{o["say_wrong"]} / {o["say_correct"]}</td></tr>')
        return f'<div class="scroll"><table>{h}{"".join(rows)}</table></div>'

    charts = "".join(f'<figure class="panel"><figcaption><b>{e(t)}</b> <span>{e(d)} · {sets[s]["prod"]["n_gated"]} proposals, {pct(sets[s]["prod"]["error_rate"])} wrong</span></figcaption>{svg_rc(sets[s]["prod"]["scores"])}</figure>'
                     for s, t, d in SETS if s in sets and "prod" in sets[s])
    per = R.get("stt_per_recogniser", {})
    per_rows = "".join(f'<tr><td>{e(k)}</td><td class="n">{v["n"]}</td><td class="n">{v["wrong"]}</td><td class="n">{v["baseline_sent_wrong"]} of {v["baseline_sent"]}</td><td class="n">{v["shipped_sent_wrong"]} of {v["shipped_sent"]}</td></tr>' for k, v in per.items())
    w = sorted(R["weights"].items(), key=lambda kv: -abs(kv[1]))
    wmax = max(abs(v) for _, v in w) or 1
    wrows = "".join(f'<div class="w"><span class="mono">{e(k)}</span><span class="wbar"><b class="{"pos" if v > 0 else "neg"}" style="width:{abs(v) / wmax * 100:.0f}%"></b></span><span class="mono n">{v:+.2f}</span></div>' for k, v in w[:12])
    par = ""
    if PAR:
        if "trie_tokens_same_as_committed_engine" in PAR:    # parity.cjs since the callsign search (ml/s1/CALLSIGN_SCORING.md)
            par = (f'<p class="note">Parity on {PAR["n"]} transcripts: the engine\'s default decoder (callsign by likelihood) produced the same line as PyTorch in {PAR["line_same_as_pytorch"]} '
                   f'and every signal matched PyTorch within tolerance in {PAR["signals_within_tolerance"]}; its greedy-trie mode produced the same tokens and confidence as the committed engine in '
                   f'{PAR["trie_tokens_same_as_committed_engine"]}. complete() {PAR["complete_ms_p50_new"]} ms vs {PAR["complete_ms_p50_trie"]} ms in trie mode (node, median).</p>')
        else:
            par = (f'<p class="note">Decode unchanged: on {PAR["n"]} transcripts the engine with the new signals produced the same tokens and confidence as the committed engine in {PAR["tokens_same_as_committed_engine"]} of {PAR["n"]}, '
                   f'the same line as PyTorch in {PAR["line_same_as_pytorch"]}, and every signal matched PyTorch within tolerance in {PAR["signals_within_tolerance"]}. '
                   f'Model step with signals {PAR["complete_ms_p50_new"]} ms vs {PAR["complete_ms_p50_committed"]} ms without (node, median).</p>')
    fit = R["fit"]
    hid = VER["full"].get("hidden")
    nweights = (len(hid["w1"]) * len(hid["w1"][0]) + 2 * len(hid["b1"]) + 1) if hid else len(VER["full"]["w"]) + 1
    kb = round((ROOT / "src/lib/voice/verify-model.ts").stat().st_size / 1024 / max(len(REG["models"]), 1))
    cost = (f'{BENCH["verifier_extra_ms_p50"]:.2f} ms median for the verifier (round trip + model; whole decision {BENCH["decide_ms_p50"]:.2f} ms, node, {BENCH["n"]} real-recogniser proposals)'
            if BENCH else 'well under 1 ms')
    body = f"""
<header>
  <div class="eyebrow">OpenATC · voice model · verifier</div>
  <h1>Teaching the voice model to know when it is wrong</h1>
  <p class="lede">The in-browser S1 model turns what you said into a command. Sometimes it is <b>confidently wrong</b>. A cheap verifier now checks every proposal against what was heard, and decides: send it, let you check it, or ask you to say again.</p>
  {head}
</header>

<section>
  <div class="eyebrow">The problem</div>
  <h2>High confidence is not the same as right</h2>
  <div class="radio"><div class="tx"><div class="who">DEMO</div><div class="said">“973 fly heading 102”</div>
  <div class="line"><span>BAW963 Fly heading 102</span><em>model confidence 97% · would go to the wrong aircraft (UPS973 was meant)</em></div></div>
  <div class="tx"><div class="who">WHISPER</div><div class="said">“Japan Air 88819 Right Taxi”</div>
  <div class="line"><span>JAL888 Taxi RWY 09R</span><em>model confidence 100% · the wrong runway (19 right was said)</em></div></div></div>
  <p>The model's confidence is the probability of the callsign tokens it chose, so it measures how sure the decoder was, not whether the line agrees with the words. A second, independent check is needed: the cheapest one is to say the command back and compare.</p>
</section>

<section>
  <div class="eyebrow">How it works</div>
  <h2>Generator, then verifier</h2>
  <div class="flow">
    <div class="node"><span class="tag">STT</span><h3>Transcript</h3><p>“speedbird nine six three turn heading one zero two please”</p></div>
    <div class="node"><span class="tag">L0 · rules</span><h3>Parser</h3><p>Parses 50–75% of transcripts on its own (those are sent, no model).</p></div>
    <div class="node"><span class="tag">L1 · S1 2M</span><h3>Generator</h3><p>Writes the command line, callsign constrained to aircraft in the state. Also returns per-token <i>signals</i>.</p></div>
    <div class="node key end rowend"><span class="tag">verify.ts</span><h3>Verifier</h3><p>Round trip + signals → {"small MLP (16 units)" if "mlp" in R.get("shipped_base", "") else "logistic regression"} → P(correct), then veto rules.</p></div>
  </div>
  <div class="flow two">
    <div class="node"><span class="tag">round trip</span><h3>Say it back</h3><p>The engine's own phraseology renders the proposal (ICAO + FAA, FL + feet); both sides are normalised (“one zero two” → 102) and aligned: flight number, airline name, every number, left/right, and whether another aircraft fits better.</p></div>
    <div class="node"><span class="tag">signals</span><h3>Decoder evidence</h3><p>Callsign margin in the constrained trie, lowest token probability, digit-token margin, P(SAY AGAIN). Free: same decode, no extra steps.</p></div>
    <div class="node end"><span class="tag">gate</span><h3>Three outcomes</h3><p><b>send</b> P ≥ {th["send"]:.2f} and no veto · <b>check</b> (left in the bar) · <b>say again</b> P &lt; {th["sayAgain"]:.2f}. Vetoes (a heard runway side missing, left↔right, another aircraft fits the words better, a number nobody said) and a callsign the rules had to correct are always <b>check</b>.</p></div>
  </div>
  <p class="note">Cost after release: {cost}. The weights ({len(VER["full"]["features"])} features, {nweights} numbers, ~{kb} KB) are compiled into the page: no download. The S1 decode only reads probabilities it already computes.</p>
</section>

<section>
  <div class="eyebrow">Comparison</div>
  <h2>Risk–coverage: how many correct commands go out at a given error rate</h2>
  <p><b>Risk–coverage curve</b>: sort proposals by a score, auto-send the top share (coverage, x) and measure the share of those that are wrong (risk, y). Lower and further right is better; the dashed line is the 1% target. Only proposals the rules could not parse are counted (what the gate sees in the game).</p>
  {legend()}
  <div class="panels">{charts}</div>
  <p><b>AUROC</b>: the probability that a randomly picked correct proposal scores higher than a randomly picked wrong one (0.5 = coin flip, 1 = perfect ranking). <b>Sent @1%</b>: share of correct proposals still auto-sent at the best threshold that keeps wrong ones ≤ 1% of what is sent (chosen on each set itself, so it compares scores, not thresholds).</p>
  {auroc_table("prod")}
  <details class="table"><summary>Same table over every transcript (including the ones the rules parse, where the model would not even run)</summary>{auroc_table("all")}</details>
</section>

<section>
  <div class="eyebrow">Operating point</div>
  <h2>The shipped gate, at thresholds fixed before looking at these sets</h2>
  <p>Thresholds come from a held-out fifth of the training-session data: send when P(correct) ≥ {th["send"]:.3f} (the lowest value with ≤ 1% wrong there), say again below {th["sayAgain"]:.3f} (at most {pct(R["say_max_correct"], 0)} of correct proposals). Every row below is a set the verifier never trained on.</p>
  {outcome_table()}
  <p class="note"><b>Calibration</b> (do 80% predictions come true 80% of the time?) — expected calibration error of the shipped P(correct) on the real-recogniser set: {pct(stt["shipped"].get("ece"))}.</p>
  <details class="table"><summary>Per recogniser (real speech-to-text, rules failed)</summary><div class="scroll"><table><tr><th>Recogniser</th><th class="n">proposals</th><th class="n">wrong</th><th class="n">today: wrong sent</th><th class="n">verifier: wrong sent</th></tr>{per_rows}</table></div></details>
</section>

{compare_section()}

<section>
  <div class="eyebrow">Examples</div>
  <h2>Wrong proposals the old gate would have sent, now stopped</h2>
  {tx(caught, True)}
  <h2>Still sent wrong</h2>
  {tx(missed, False) if missed else '<p>None in these sets.</p>'}
  <p class="note">Many “misses” are transcripts that lost the information (a misheard digit the round trip cannot see, or a gold line the words do not support): no check on the words can catch those; the readback is the safety net.</p>
</section>

<section>
  <div class="eyebrow">What the linear model learned</div>
  <h2>Logistic-regression weights (standardised features)</h2>
  <div class="weights">{wrows}</div>
  <p class="note">Positive = evidence the proposal is right. The shipped combiner is the {"MLP" if "mlp" in R.get("shipped_base", "") else "regression"} (it ranked better on the dev fold: AUROC {R["dev_lr_vs_mlp"]["mlp"][0]:.3f} vs {R["dev_lr_vs_mlp"]["lr"][0]:.3f}); the linear weights are shown because they can be read. Fitted on {fit["rows"]} training-session proposals ({fit["wrong"]} wrong; {fit["hardneg_rows"]} perturbed hard negatives were tried and {"used" if fit["models"]["lr_full"]["hardneg"] else "not used: they did not help on dev"}).</p>
  {par}
</section>

<section>
  <div class="eyebrow">Reproduce</div>
  <p><code>ml/verify/refit.sh [public/models/s1/&lt;name&gt;]</code> rebuilds everything on this page for a new S1 checkpoint (CPU, about an hour): generator pass, labels with the game's own parser, fit, thresholds into <code>src/lib/voice/verify-model.ts</code>, parity check, this report. Details: <code>ml/verify/RESULTS.md</code>.</p>
</section>
"""
    css = (ROOT / "ml/verify/report.css").read_text()
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Voice Verifier</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
<style>{css}</style>
</head>
<body><main class="wrap viz">{body}</main></body>
</html>
"""
    (ROOT / "public/reports/voice-verifier.html").write_text(page)
    write_md()
    print("wrote public/reports/voice-verifier.html, ml/verify/RESULTS.md")


NOTES = """
## How it was measured

- **Generator pass** (`ml/verify/gen.py`): the shipped int8 web weights, dequantized exactly like `src/lib/voice/s1.ts`,
  greedy constrained decode on the tidied transcript (fillers removed, as `understand()` does), plus the per-token
  signals and, for comparison only, a System One style score of every callsign by teacher forcing (batched).
- **Labels** (`ml/verify/post.cjs`): the game's own code. Rules first (L0); the model only counts where they fail.
  Then `decideL1()` (the production function): rules-callsign fusion, parse, canonical line. Correct = final AST equals
  the gold AST. Parse context from the state text (callsigns + altitudes; no taxiway/fix lists, so the parser is lenient).
- **Fitting** only on training sessions: trainA (S1's own training transcripts), trainB (fresh transcripts of training
  records, half with STT-style damage), hardneg (gold line perturbed: other callsign in the state, a digit, runway side,
  turn direction, a dropped part; teacher-forced). Model selection and thresholds on a 20 % fold of those, grouped by
  command. val / Sydney / real STT / heavy noise are only scored.
- **Cost**: `node ml/verify/bench.cjs` (decideL1 incl. round trip + model, per proposal) and `ml/verify/parity.cjs`.

## Design notes

- The round trip renders with `transmission()` and a minimal phrase context (no aircraft state, unknown transition
  altitude): ICAO + FAA wording, flight levels and feet. Verbs that depend on aircraft state (climb/descend,
  reduce/increase) are neutral; climb vs descend is checked against the altitude in the state instead.
- The heard side undoes recogniser habits seen in the GPU bake-off: split numbers ("4-9-8", "2:18", "9 78"),
  "25R" as one token, "wright", "ills", "whole position", a possessive "7's"; frequencies, wind and QNH are dropped
  (the parser ignores them and the render does not know them).
- Words are compared in order and counted (longest common subsequence): a taxi route "echo echo foxtrot" is not
  "echo foxtrot".
- A callsign the rules had to correct (fusion) always goes to check, as before.
- `verifier: null` in `understandVoice()` options restores the old confidence gate; a worker without signals uses the
  basic model (round trip + confidence).
- Since the callsign search (`ml/s1/CALLSIGN_SCORING.md`) the S1 decoder picks the callsign by likelihood; its signals
  are taken along the chosen path and `cs_lh_margin` / `cs_lh` were added. Its `'trie'` mode (or an older worker)
  sends NaN for them, so the full gate cannot score and the basic gate decides.
- Fixed with that refit: fit.py reused `mu, sd` for the trunk-head experiment, so every exported MLP gate before it
  carried the 384 hidden-state statistics as its feature mean / std, and the game standardised the features with the
  wrong numbers (the numbers in this file were computed in-process and were right; the browser's were not).
  fit.py now asserts that the exported gate reproduces the fitted one. Effect on the game: `ml/s1/CALLSIGN_SCORING.md`.

## What did not work / was skipped

- The exact System One callsign margin (score every callsign by teacher forcing) is a strong signal when the greedy
  trie path disagrees with the best full callsign, but costs ~N_callsigns x 3 extra token steps in the browser
  (~50-100 ms with 15 aircraft), over budget; the free trie margin and the round trip's "another aircraft fits better"
  cover most of it.
- A head on the S1 trunk (logistic regression on the final-norm hidden states at <cmd> and at the last token, 384
  numbers) was clearly worse than the cheap features (AUROC ~0.67-0.76): the generator's hidden state does not encode
  "I copied the wrong digits" linearly. Not shipped.
- The MLP and the logistic regression are close; the MLP won on the dev fold and was shipped, but it is not better on
  every report set (Sydney and real STT rank slightly better with the regression). Both stay in `fit.py`.
- Hard negatives (perturbed gold lines) did not improve the dev ranking of the combiners (they are easy for the decoder
  features: a forced wrong token has a low probability), so the shipped model is fitted without them; they were
  useful to check the veto rules' precision.
- Not reaching 1 % on the hardest sets: on real STT the fixed gate sends ~1.2-1.6 % wrong and on the synthetic
  heavy-noise set ~3-3.6 %. Most of what still goes out is a transcript that itself says the wrong thing (a misheard digit,
  "increased speed to 300" for 230): the words agree with the command, so no check on the words can see it.
- No GPU was used; everything ran on 2 CPU threads (generator pass ~1 h for ~60k examples on a loaded host). A GPU would
  make the generator pass minutes and allow a learned cross-encoder verifier trained on far more negatives.
- The demo page (`public/reports/voice-demo.html`) still shows the old decision: it runs only the S1 worker, and the
  verifier needs the parser + phraseology in the page (a bundled `verify.ts` + `understand.ts`; `tsc` alone emits
  extension-less imports the browser cannot load). Change needed: bundle `decideL1` into `public/voice/gen/` (or into
  the worker) and replace the page's `v = ...` verdict line with `decideL1(u, r, ctx, 0)`.

- The model itself answers SAY AGAIN to some valid real-STT commands (26 of 491 for 2m-swap-v1, 20 for 2m-grpo-v1);
  the gate cannot undo that (it only sees proposals). GRPO misses more real "say again" transcripts (Sydney 49 of 426
  vs 24), but the gate still sends none of them (they fail the round trip: the named aircraft is not in the state).

## Refit

`ml/verify/refit.sh [public/models/s1/<name>]` (one command, CPU, about an hour).
"""


def write_md():
    sets = R["sets"]; th = R["thresholds"]
    L = ["# Voice verifier: results", "", f"Generated by `ml/verify/report.py` from `ml/verify/out/<model>/results.json` (`ml/verify/fit.py`). Numbers below: the shipped S1 model `{DEFAULT}` unless the table says otherwise. Report: `public/reports/voice-verifier.html`.", "",
         "Question: of the S1 model's proposals, which are correct? Gate each into send / check (left in the bar) / say again. "
         "Headline metric: share of correct proposals still auto-sent when at most 1% of auto-sent commands are wrong.", "",
         "## Sets (scored, never fitted)", "",
         "| set | what | transcripts | rules failed (model runs) | gated proposals | wrong |", "|---|---|---:|---:|---:|---:|"]
    for s, t, d in SETS:
        if s in sets and "prod" in sets[s]:
            p = sets[s]["prod"]
            L.append(f"| {s} | {d} | {p['n_rows']} | {p['n_l1']} | {p['n_gated']} | {p['wrong']} ({pct(p['error_rate'])}) |")
    L += ["", "Gated = parsed, not SAY AGAIN, callsign not corrected by the rules (corrected ones always go to check). "
          "Labels: final command AST equals the gold AST (the game's parser, `ml/verify/post.cjs`).", "",
          "## AUROC and coverage at <=1% wrong (rules-failed proposals)", "",
          "| score | " + " | ".join(t for s, t, _ in SETS if s in sets) + " |", "|---|" + "---:|" * sum(1 for s, _, _ in SETS if s in sets)]
    for k, label in CANDS:
        cells = []
        for s, _, _ in SETS:
            if s in sets:
                v = sets[s]["prod"]["scores"].get(k)
                cells.append(f"{v['auroc']:.3f} / {pct(v['cov_at_1pct'], 0)}" if v else "–")
        L.append(f"| {label}{' **(shipped)**' if k == SHIP else ''} | " + " | ".join(cells) + " |")
    L += ["", f"## Shipped gate (thresholds from the training dev fold: send >= {th['full']['send']}, say again < {th['full']['sayAgain']}; basic model without decoder signals: {th['basic']})", "",
          "| set | gate | sent | sent wrong | correct sent | check wrong/correct | say again wrong/correct |", "|---|---|---:|---:|---:|---:|---:|"]
    for s, t, _ in SETS:
        if s in sets:
            for g in ("baseline", "shipped"):
                o = sets[s]["prod"][g]
                L.append(f"| {s} | {'confidence >= 0.5' if g == 'baseline' else 'verifier'} | {o['sent']} | {o['sent_wrong']} ({pct(o['risk'])}) | {pct(o['coverage'])} | {o['check_wrong']}/{o['check_correct']} | {o['say_wrong']}/{o['say_correct']} |")
    if len(MODELS) > 1:
        L += ["", "## S1 checkpoints side by side (each with its own fitted gate; rules-failed transcripts)", "",
              "| model | set | L1 exact | correct sent @<=1% wrong (best threshold) | wrong sent at fixed thresholds | correct sent (fixed) | say-again missed (sent) |", "|---|---|---:|---:|---:|---:|---:|"]
        for m in MODELS:
            for s_ in ("val", "syd", "stt"):
                p = m["sets"].get(s_, {}).get("prod")
                if not p:
                    continue
                sa = p.get("say_again", {})
                L.append(f"| {m.get('s1_model', '?').rsplit('/', 1)[-1]} (send >= {m['thresholds']['full']['send']}) | {s_} | {pct(p.get('l1_exact'))} | {pct(p['scores']['e_shipped']['cov_at_1pct'])} | "
                         f"{p['shipped']['sent_wrong']} ({pct(p['shipped']['risk'])}) | {pct(p['shipped']['coverage'])} | {sa.get('missed', 0)} of {sa.get('gold', 0)} ({sa.get('missed_sent', 0)}) |")
    if PAR:
        L += ["", "## Parity (decode unchanged, signals match PyTorch)", "", "```", json.dumps(PAR), "```"]
    L += ["", NOTES.strip()]
    L += ["", "## Fit", "", "```", json.dumps(R["fit"], indent=1), "```", ""]
    (ROOT / "ml/verify/RESULTS.md").write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    main()

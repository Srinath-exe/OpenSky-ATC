"""Build public/reports/voice-demo.html: try the in-browser voice model on real game situations (no game needed).

The page uses the same worker and model files as the game (/voice/s1-worker.js, S1_MODEL_URL in src/lib/voice/l1.ts) and the game's decision code
(public/voice/gen/demo-pipeline.js, bundled from ml/report/demo_pipeline.ts). Examples are
real speech-recogniser outputs from the GPU bake-off and Sydney transcripts (an airport the model never trained on).
    python3 ml/report/build_demo.py examples.json
"""
import html, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ex = json.load(open(sys.argv[1]))
page = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex">
<title>Voice Model Demo</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=DM+Mono:wght@400;500&display=swap">
<style>
:root { --bg:#0e0f11; --surface:#141416; --raise:#1c1c1e; --line:rgba(255,255,255,.09); --line-strong:rgba(255,255,255,.16); --ink-1:#f4f4f5; --ink-2:#c4c5c8; --ink-3:#a0a1a6; --ink-4:#7f8086;
  --accent:#f5933f; --accent-tint:rgba(245,147,63,.14); --good:#57cd50; --good-tint:rgba(87,205,80,.13); --warn:#f5c33f; --warn-tint:rgba(245,195,63,.13); --no:#ff8a80; --no-tint:rgba(255,138,128,.12);
  --font:"DM Sans","Helvetica Neue",Arial,sans-serif; --mono:"DM Mono",ui-monospace,Menlo,monospace; color-scheme:dark; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --bg:#f6f5f2; --surface:#fbfaf8; --raise:#efeeea; --line:rgba(20,20,24,.10); --line-strong:rgba(20,20,24,.18); --ink-1:#141416; --ink-2:#3c3d42; --ink-3:#56575d; --ink-4:#6c6d73;
  --accent:#b85a12; --accent-tint:rgba(200,102,26,.12); --good:#23862b; --good-tint:rgba(35,134,43,.12); --warn:#8a6400; --warn-tint:rgba(160,120,0,.12); --no:#b3261e; --no-tint:rgba(179,38,30,.10); color-scheme:light; } }
:root[data-theme="light"] { --bg:#f6f5f2; --surface:#fbfaf8; --raise:#efeeea; --line:rgba(20,20,24,.10); --line-strong:rgba(20,20,24,.18); --ink-1:#141416; --ink-2:#3c3d42; --ink-3:#56575d; --ink-4:#6c6d73;
  --accent:#b85a12; --accent-tint:rgba(200,102,26,.12); --good:#23862b; --good-tint:rgba(35,134,43,.12); --warn:#8a6400; --warn-tint:rgba(160,120,0,.12); --no:#b3261e; --no-tint:rgba(179,38,30,.10); color-scheme:light; }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink-2); font-family:var(--font); font-size:15px; line-height:1.5;
  padding-left:max(16px, env(safe-area-inset-left,0px)); padding-right:max(16px, env(safe-area-inset-right,0px)); padding-block:32px 64px; }
.wrap { max-width:880px; margin:0 auto; display:grid; gap:22px; } h1 { color:var(--ink-1); font-size:clamp(26px,4vw,34px); margin:0; font-weight:600; letter-spacing:-.01em; }
.eyebrow { font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3); font-weight:600; } p { margin:0; max-width:68ch; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:16px 18px; display:grid; gap:12px; min-width:0; }
.row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
select, input[type=text] { font:inherit; color:var(--ink-1); background:var(--raise); border:1px solid var(--line-strong); border-radius:10px; padding:10px 12px; min-width:0; }
select { width:100%; } .saved { color:var(--good); } .opts { display:grid; grid-template-columns:auto 1fr; gap:8px 10px; align-items:center; } .opts select { width:auto; max-width:100%; } input[type=text] { flex:1 1 320px; font-family:var(--mono); font-size:14px; }
button { font:inherit; font-weight:600; border-radius:10px; padding:10px 16px; border:1px solid var(--line-strong); background:var(--raise); color:var(--ink-1); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#16100a; } button:disabled { opacity:.5; cursor:default; }
button.mic[data-on="1"] { background:var(--no-tint); border-color:var(--no); }
button:focus-visible, select:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.chips { display:flex; flex-wrap:wrap; gap:6px; } .chip { font-family:var(--mono); font-size:12.5px; padding:3px 8px; border-radius:6px; background:var(--accent-tint); color:var(--ink-1); }
.chip span { color:var(--ink-3); margin-left:6px; font-family:var(--font); }
.k { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-4); font-weight:600; }
.out { display:grid; grid-template-columns:120px 1fr; gap:8px 14px; align-items:baseline; } .out .v { font-family:var(--mono); color:var(--ink-1); overflow-wrap:anywhere; }
.verdict { display:inline-flex; gap:6px; align-items:center; font-weight:600; font-size:13px; padding:3px 10px; border-radius:999px; }
.verdict.send { color:var(--good); background:var(--good-tint); } .verdict.edit { color:var(--warn); background:var(--warn-tint); } .verdict.again { color:var(--no); background:var(--no-tint); }
.bar { height:8px; border-radius:4px; background:var(--line); overflow:hidden; max-width:240px; } .bar i { display:block; height:100%; background:var(--accent); }
.cap { font-size:13px; color:var(--ink-3); } .status { font-size:13px; color:var(--ink-3); font-family:var(--mono); }
</style></head><body><div class="wrap">
<div class="eyebrow">OpenATC · voice model · runs in your browser</div>
<h1>Talk to the model</h1>
<p>This is the 2 MB model that sits behind the rules in the game's push-to-talk. Pick a real situation, then use what a speech recogniser heard, type your own messy version, or speak it (Chrome or Edge). Everything runs on your device.</p>
<div class="card">
  <label class="k" for="ex">Situation</label>
  <select id="ex"></select>
  <div><div class="k" style="margin-bottom:6px">Aircraft on frequency (callsign · what you say)</div><div class="chips" id="ac"></div></div>
</div>
<div class="card">
  <label class="k" for="said">What was heard</label>
  <div class="row"><input type="text" id="said" autocomplete="off" spellcheck="false"><button class="mic" id="mic" title="Hold to talk">🎙 Hold to talk</button><button class="primary" id="go">Understand</button></div>
  <div class="row opts"><label class="k" for="eng">Recogniser</label><select id="eng"><option value="browser+server">Browser, then our server if not understood (the game's default)</option><option value="browser">Browser only (Google)</option><option value="server">Our server only (Whisper, told the callsigns)</option></select>
    <label class="k" for="acc">Your accent</label><select id="acc"></select></div>
  <div class="cap" id="heardby"></div>
  <div class="status" id="status">Loading the model (2 MB)…</div>
</div>
<div class="card" id="result" hidden>
  <div class="out">
    <span class="k">Command</span><span class="v" id="line"></span>
    <span class="k">Expected</span><span class="v" id="gold"></span>
    <span class="k">Path</span><span class="cap" id="path"></span>
    <span class="k">Confidence</span><span><div class="bar"><i id="confbar"></i></div><span class="cap" id="conf"></span></span>
    <span class="k">Decision</span><span id="verdict"></span>
    <span class="k">Timing</span><span class="cap" id="ms"></span>
  </div>
</div>
<p class="cap">How it works: when you pick a situation, the model reads the game state into its KV cache (in the game this happens while you are still talking). Pressing Understand runs the same code as push-to-talk in the game: the transcript is repaired (ATC words, callsign matched by sound to the aircraft on frequency), the rules try it first, and only when they cannot parse it does the model write the command (first tokens restricted to callsigns that exist). A verifier then says the command back in words and compares it with what was heard: sure → sent; doubtful → left in the command bar to check; no matching aircraft → “say again”. Speaking uses the browser’s recogniser with its 5 best guesses. <a href="/reports/ai-paths.html" style="color:var(--accent)">How we built it</a></p>
</div>
<script type="module">
import { decide, createMicCapture, postStt, biasNames, saveAttempt, diagKey, VOICE_ACCENTS, defaultAccent } from '/voice/gen/demo-pipeline.js';
const MODEL = '__MODEL__';
const EX = __EXAMPLES__;
const $ = (id) => document.getElementById(id);
const w = new Worker('/voice/s1-worker.js', { type: 'module' });
let seq = 0; const call = (m) => new Promise((res) => { const id = ++seq; const h = (e) => { if (e.data.id === id) { w.removeEventListener('message', h); res(e.data); } }; w.addEventListener('message', h); w.postMessage({ ...m, id }); });
let ready = false, cur = null, prefillMs = null;
EX.forEach((e, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `${i + 1}. ${e.label}: “${e.said.slice(0, 60)}${e.said.length > 60 ? '…' : ''}”`; $('ex').appendChild(o); });
function callsigns(ctx) { return ctx.split('\n').slice(1).map((l) => l.split(' ')[0]).filter(Boolean); }
function showAircraft(ctx) {
  $('ac').innerHTML = ctx.split('\n').slice(1).map((l) => { const m = l.match(/^(\S+) (.+?) (ARR|DEP) /); return m ? `<span class="chip">${m[1]}<span>${m[2]}</span></span>` : ''; }).join('');
}
async function select(i) {
  cur = EX[i]; $('said').value = cur.said; showAircraft(cur.ctx); $('result').hidden = true;
  if (!ready) return;
  const r = await call({ type: 'prefill', ctx: cur.ctx }); prefillMs = r.ms; $('status').textContent = `Game state read into the KV cache in ${Math.round(r.ms)} ms. Press Understand.`;
}
async function understand(alts) {
  if (!ready || !cur) return;
  const typed = $('said').value.trim(); if (!typed) return;
  const guesses = alts && alts.length ? alts : [typed];
  $('go').disabled = true;
  // the worker is the in-browser model (L1); everything else is the game's own code (demo-pipeline.js)
  let modelMs = null;
  const l1 = { complete: async (said, cs, ctx) => { const r = await call({ type: 'complete', said, callsigns: cs, ctx }); modelMs = r.ms; return { ...r, model: MODEL }; } };
  const t0 = performance.now();
  const v = await decide(guesses, cur.ctx, l1);
  const totalMs = performance.now() - t0;
  $('go').disabled = false;
  v.__meta = { typed, guesses, totalMs, modelMs };
  show(v);
  return v;
}
function show(v) {
  const { typed, guesses, totalMs, modelMs } = v.__meta; let conf = null;
  const norm = (s) => (s || '').toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  $('result').hidden = false; $('line').textContent = v.line || '(nothing)';
  const same = norm(v.line) === norm(cur.gold);
  $('gold').textContent = typed === cur.said ? `${cur.gold}${same ? '  ✓ match' : '  ✗ different'}` : '(your own transcript)';
  conf = v.confidence == null ? null : v.confidence;
  const pct = conf == null ? 0 : Math.round(conf * 100); $('confbar').style.width = pct + '%';
  $('conf').textContent = v.source === 'L0' ? ' rules: certain' : conf == null ? ' –' : ` ${pct}% (model + verifier)`;
  const path = v.source === 'L0' ? 'Rules understood it (no model needed)' : v.source === 'L1' ? 'Rules could not parse it: the model wrote the command, the verifier checked it' : 'Not understood';
  $('path').textContent = path + (v.heard && norm(v.heard) !== norm(typed) ? ` · read as “${v.heard}”` : '') + (v.notes && v.notes.length ? ` · repair: ${v.notes.join(', ')}` : '') + (guesses.length > 1 ? ` · guess ${v.alt + 1} of ${guesses.length}` : '');
  const d = v.ok ? ['send', 'Sent to the aircraft'] : v.sayAgain ? ['again', 'Say again'] : ['edit', 'Left in the command bar to check'];
  $('verdict').innerHTML = `<span class="verdict ${d[0]}">${d[1]}</span>` + (v.error && !v.ok ? `<span class="cap"> ${v.error.replace(/[<>&]/g, '')}</span>` : '');
  $('ms').textContent = `${Math.round(totalMs)} ms after you finished${modelMs != null ? ` (model ${Math.round(modelMs)} ms)` : ''}; the game state was read earlier in ${Math.round(prefillMs ?? 0)} ms`;
}
$('ex').addEventListener('change', (e) => select(+e.target.value));
$('go').addEventListener('click', () => understand());
$('said').addEventListener('keydown', (e) => { if (e.key === 'Enter') understand(); });
// microphone: the same engines as the game (browser recogniser in your accent, our server's Whisper as a second opinion)
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private */ } } };
VOICE_ACCENTS.forEach((a) => { const o = document.createElement('option'); o.value = a.value; o.textContent = a.label; $('acc').appendChild(o); });
$('acc').value = store.get('skycontrol_voice_accent')?.replace(/"/g, '') || defaultAccent();
$('eng').value = store.get('atc-demo-engine') || 'browser+server';
$('acc').addEventListener('change', () => store.set('skycontrol_voice_accent', JSON.stringify($('acc').value)));
$('eng').addEventListener('change', () => store.set('atc-demo-engine', $('eng').value));
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let mic = null; try { mic = createMicCapture(); } catch { mic = null; }
let rec = null, txt = '', alts = [], recording = false, audioP = null;
const names = () => (cur ? biasNames({ text: cur.ctx }) : []);
const startMic = () => {
  if (recording) return; recording = true; $('mic').dataset.on = '1'; txt = ''; alts = []; $('heardby').textContent = 'Listening…';
  const eng = $('eng').value;
  if (mic && eng !== 'browser') mic.start().catch((e) => { $('heardby').textContent = 'Microphone: ' + e; });
  if (eng !== 'server' && SR) {
    rec = new SR(); rec.lang = $('acc').value; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 5;
    rec.onresult = (e) => { const res = Array.from(e.results); txt = res.map((r) => r[0].transcript).join(' '); $('said').value = txt;
      const n = Math.max(...res.map((r) => r.length)); alts = Array.from({ length: n }, (_, k) => res.map((r) => (r[k] || r[0]).transcript).join(' ')); };
    rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') $('heardby').textContent = 'Browser recogniser: ' + e.error; };
    try { rec.start(); } catch { /* already running */ }
  }
};
const stopMic = async () => {
  if (!recording) return; recording = false; $('mic').dataset.on = '0';
  const eng = $('eng').value;
  audioP = mic && eng !== 'browser' ? mic.stop() : Promise.resolve(null);
  if (rec) { const r = rec; rec = null; await new Promise((ok) => { const t = setTimeout(ok, 2000); r.onend = () => { clearTimeout(t); ok(); }; try { r.stop(); } catch { ok(); } }); }
  const browserAlts = eng === 'server' ? [] : [...new Set(alts.filter(Boolean))];
  let serverAlts = [];
  const askServer = async () => {
    const a = await audioP; if (!a || a.length < 16000 * 0.25) return [];
    $('heardby').textContent = 'Asking our server…';
    try { return (await postStt(a, names())).alternatives; } catch (e) { $('heardby').textContent = 'Server: ' + e.message; return []; }
  };
  if (eng === 'server') { serverAlts = await askServer(); $('said').value = serverAlts[0] || ''; }
  let v = browserAlts.length || serverAlts.length ? await understand(eng === 'server' ? serverAlts : browserAlts) : null;
  if (eng === 'browser+server' && (!v || !v.ok)) {
    serverAlts = await askServer();
    if (serverAlts.length) { if (!$('said').value.trim()) $('said').value = serverAlts[0]; const v2 = await understand(serverAlts); if (v2 && (!v || v2.ok || (v2.confidence ?? 0) > (v.confidence ?? 0))) v = v2; else if (v) show(v); }
  }
  $('heardby').innerHTML = (browserAlts.length ? `Browser heard: “${esc(browserAlts[0])}”${browserAlts.length > 1 ? ` (+${browserAlts.length - 1} other guesses)` : ''}` : (eng === 'server' ? '' : 'Browser heard nothing')) +
    (serverAlts.length ? `<br>Server heard: “${esc(serverAlts[0])}”` : '') + (diagKey() ? '<br><span class="saved">Saved for tuning (your key is in this browser)</span>' : '');
  if (diagKey()) audioP.then((a) => saveAttempt(a, { page: 'demo', engine: eng, accent: $('acc').value, ctx: cur && cur.ctx,
    transcripts: { ...(browserAlts.length ? { browser: browserAlts } : {}), ...(serverAlts.length ? { server: serverAlts } : {}) },
    heard: v && v.heard, line: v && v.line, ok: v && v.ok, source: v && v.source, sayAgain: v && v.sayAgain, error: v && v.error, confidence: v && v.confidence,
    expected: cur && cur.gold, example: +$('ex').value })).catch(() => undefined);
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
if (!SR && !mic) { $('mic').disabled = true; $('mic').title = 'No microphone access in this browser: type instead'; }
$('mic').addEventListener('pointerdown', (e) => { e.preventDefault(); startMic(); });
['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => $('mic').addEventListener(t, () => { void stopMic(); }));
(async () => {
  const t0 = performance.now(); const r = await call({ type: 'load', url: MODEL });
  if (r.type === 'error') { $('status').textContent = 'Could not load the model: ' + r.message; return; }
  ready = true; $('status').textContent = `Model loaded in ${Math.round(performance.now() - t0)} ms.`;
  await select(0);
})();
</script></body></html>
"""
out = ROOT / "public/reports/voice-demo.html"
model_url = re.search(r"S1_MODEL_URL = '([^']+)'", (ROOT / "src/lib/voice/l1.ts").read_text()).group(1)   # same model as the game
out.write_text(page.replace("__EXAMPLES__", json.dumps(ex)).replace("__MODEL__", model_url))
print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(ex)} examples)")

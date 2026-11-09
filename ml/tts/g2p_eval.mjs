// Browser G2P vs misaki on the 60 benchmark lines (ml/tts/RESULTS.md). Runs the worker's own G2P module in node.
//   node ml/tts/g2p_eval.mjs
// Reference: misaki's phonemes per (line, voice) from ml/tts/out/bench/paradee/timing.json (bench.py synth paradee).
// Variants: lexicon  = public/voice/tts-g2p.js with ml/tts/out/lexicon_eval.json (built without the 60 lines) + eSpeak
//           espeak   = eSpeak NG (phonemizer 1.2.1) on the whole sentence + paradee's toMisaki (kokoro-js + misaki.js)
// Writes ml/tts/data/bench60_ph_<variant>.jsonl for bench.py synth paradee-ph, and ml/tts/out/g2p_eval.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// public/voice/*.js are browser modules (the repo's package.json is CommonJS): import the source as a data: URL
const g2pSrc = fs.readFileSync(path.join(ROOT, 'public/voice/tts-g2p.js'));
const { AtcG2P, espeakSentence } = await import('data:text/javascript;base64,' + g2pSrc.toString('base64'));
const PHON = path.join(ROOT, 'ml/tts/cache/npm/phonemizer-1.2.1/package/dist/phonemizer.js');
const lexPath = process.argv[2] || path.join(ROOT, 'ml/tts/out/lexicon_eval.json');
const lex = JSON.parse(fs.readFileSync(lexPath, 'utf8'));
const lines = fs.readFileSync(path.join(ROOT, 'ml/tts/data/bench60.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ref = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'ml/tts/out/bench/paradee/timing.json'), 'utf8')).clips.map((c) => [`${c.bench_id}_${c.voice}`, c.phonemes]));
const VOICES = ['af_heart', 'am_puck', 'bf_isabella', 'bm_fable'];

let tLoad = performance.now();
const { phonemize } = await import(pathToFileURL(PHON).href);
await phonemize('warm up', 'en-us');
tLoad = performance.now() - tLoad;

function lev(a, b) {
  a = [...a]; b = [...b];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const words = (s) => s.split(/\s+/).filter(Boolean);

const variants = {
  lexicon: (() => { const g = new AtcG2P(lex, async () => phonemize); return { g, run: (t, br) => g.phonemize(t, br) }; })(),
  espeak: { g: null, run: (t, br) => espeakSentence(t, br, phonemize) },
};
const report = { espeak_load_ms: Math.round(tLoad), phonemizer_bytes: fs.statSync(PHON).size, lexicon_bytes: fs.statSync(lexPath).size, variants: {} };
for (const [name, v] of Object.entries(variants)) {
  const rows = []; let chars = 0, edits = 0, exact = 0, wordsN = 0, wordErr = 0, ms = 0;
  const diffs = [];
  for (const l of lines) for (const voice of VOICES) {
    const t0 = performance.now();
    const ps = await v.run(l.spoken, voice.startsWith('b'));
    ms += performance.now() - t0;
    const r = ref.get(`${l.bench_id}_${voice}`);
    const e = lev(ps, r); edits += e; chars += [...r].length; exact += ps === r ? 1 : 0;
    const rw = words(r), pw = words(ps); wordsN += rw.length;
    for (let i = 0; i < rw.length; i++) if (rw[i] !== pw[i]) wordErr++;
    if (ps !== r && diffs.length < 400) {
      for (let i = 0; i < Math.max(rw.length, pw.length); i++) if (rw[i] !== pw[i]) diffs.push(`${voice[0]}: ${l.spoken.split(' ')[i] ?? '?'}  misaki ${rw[i]}  ours ${pw[i]}`);
    }
    rows.push({ bench_id: l.bench_id, voice, phonemes: ps });
  }
  fs.writeFileSync(path.join(ROOT, `ml/tts/data/bench60_ph_${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const n = rows.length;
  report.variants[name] = {
    n, line_exact_pct: +(100 * exact / n).toFixed(1), phoneme_char_err_pct: +(100 * edits / chars).toFixed(2), word_mismatch_pct: +(100 * wordErr / wordsN).toFixed(2),
    ms_per_line: +(ms / n).toFixed(2), stats: v.g ? v.g.stats : null,
    top_diffs: Object.entries(diffs.reduce((m, d) => ((m[d] = (m[d] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 25),
  };
  console.log(name, JSON.stringify(report.variants[name], null, 0).slice(0, 1600));
}
// the ATC words the brief names, both accents, both G2P paths vs misaki
const probe = ['niner', 'Speedbird', 'flight level', 'runway two seven left', 'fife', 'tree', 'wilco', 'Shamrock seven two'];
report.probe = [];
for (const t of probe) for (const br of [false, true]) {
  report.probe.push({ text: t, accent: br ? 'gb' : 'us', lexicon: await variants.lexicon.run(t, br), espeak: await variants.espeak.run(t, br) });
}
fs.writeFileSync(path.join(ROOT, 'ml/tts/out/g2p_eval.json'), JSON.stringify(report, null, 1));
console.log(report.probe.map((p) => `${p.accent} ${p.text}: lexicon ${p.lexicon} | espeak ${p.espeak}`).join('\n'));

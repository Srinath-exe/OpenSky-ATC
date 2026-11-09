// complete() latency of the browser engine, callsign by likelihood ('score', default) vs the greedy trie, on the same
// rows (val + Sydney + real recognisers from ml/verify/out/*.in.jsonl), alternating which runs first, after warm-up.
//   ml/verify/build.sh && node ml/s1/callsign_latency.cjs [model=2m-grpo-v1] [n=150]  -> ml/s1/results/latency_<model>.json
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { S1Model } = require(path.join(ROOT, process.env.S1_BUILD || 'ml/verify/.build/src/lib/voice/s1.js'));
const name = process.argv[2] || '2m-grpo-v1', N = +(process.argv[3] || 150);
const dir = path.join(ROOT, 'public/models/s1', name);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')); const bin = fs.readFileSync(path.join(dir, 'model.bin'));
const m = new S1Model(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const rd = (f) => fs.readFileSync(path.join(ROOT, 'ml/verify/out', f), 'utf8').trim().split('\n').map(JSON.parse);
const pick = (a, k) => { const st = Math.floor(a.length / k); return Array.from({ length: k }, (_, i) => a[i * st]); };
const rows = [...pick(rd('val.in.jsonl'), N / 3 | 0), ...pick(rd('syd.in.jsonl'), N / 3 | 0), ...pick(rd('stt.in.jsonl'), N / 3 | 0)];
const FILLER = /\b(uh+|um+|erm|er|ah+|hmm+)\b/gi;
const T = [], S = [], D = [], nS = [], nT = []; let same = 0;
rows.forEach((ex, i) => {
  const cs = ex.ctx.split('\n').slice(1).filter((l) => l.trim()).map((l) => l.split(' ')[0]);
  const said = ex.said.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  m.prefill(ex.ctx);
  let a, b;
  if (i % 2) { a = m.complete(said, cs, 48, 'trie'); b = m.complete(said, cs, 48, 'score'); } else { b = m.complete(said, cs, 48, 'score'); a = m.complete(said, cs, 48, 'trie'); }
  if (i < 6) return;   // warm-up (JIT)
  T.push(a.ms); S.push(b.ms); D.push(b.ms - a.ms); nS.push(b.signals.nSearch); nT.push(a.tokens.length); same += a.line === b.line;
});
const q = (x, f) => [...x].sort((p, r) => p - r)[Math.min(x.length - 1, Math.floor(x.length * f))]; const mean = (x) => x.reduce((p, r) => p + r, 0) / x.length;
let load = null; try { load = +fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]; } catch { /* not linux */ }
const r = { model: name, n: T.length, trie_ms_p50: +q(T, 0.5).toFixed(1), score_ms_p50: +q(S, 0.5).toFixed(1), extra_ms_p50: +q(D, 0.5).toFixed(1), extra_ms_p95: +q(D, 0.95).toFixed(1),
  extra_ms_mean: +mean(D).toFixed(1), extra_ms_max: +Math.max(...D).toFixed(1), search_steps_mean: +mean(nS).toFixed(2), search_steps_p95: q(nS, 0.95), trie_out_tokens_mean: +mean(nT).toFixed(2),
  same_line: same, loadavg: load };
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', `latency_${name}.json`), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r));

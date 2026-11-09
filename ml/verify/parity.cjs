// Proof that the browser decodes what PyTorch decodes and computes the same signals the verifier was fitted on
// (ml/verify/gen.py), and that the first decoder is unchanged.
//   node ml/verify/parity.cjs [n=200] [model dir]
// For n examples (val + stt + noisy): s1.ts in 'trie' mode vs the committed s1.ts (tokens + confidence identical);
// s1.ts in its default mode (callsign by likelihood, ml/s1/CALLSIGN_SCORING.md) vs PyTorch (gen.py line, token count,
// every signal within tolerance); complete() time of both modes on the same rows.
//   node ml/verify/parity.cjs --ref <ref.json> [model dir]     tokens vs ml/edge/parity_ref.py (decode.generate_scored)
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const NEW = require(path.join(__dirname, '.build/src/lib/voice/s1.js'));
const OLD = fs.existsSync(path.join(__dirname, '.build-old/s1.js')) ? require(path.join(__dirname, '.build-old/s1.js')) : null;
if (process.argv[2] === '--ref') return refParity(process.argv[3], process.argv[4] || 'public/models/s1/2m-grpo-v1');
const n = Number(process.argv[2] || 200);
const dir = path.resolve(ROOT, process.argv[3] || 'public/models/s1/2m-swap-v1');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'model.bin')); const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const mNew = new NEW.S1Model(meta, buf), mOld = OLD ? new OLD.S1Model(meta, buf) : null;
const OUT = path.join(__dirname, 'out'), MD = path.join(OUT, path.basename(dir));
const take = (set, k) => {
  if (!fs.existsSync(path.join(MD, `${set}.gen.jsonl`))) return [];
  const ins = fs.readFileSync(path.join(OUT, `${set}.in.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const gen = fs.readFileSync(path.join(MD, `${set}.gen.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const step = Math.max(1, Math.floor(Math.min(ins.length, gen.length) / k));
  const out = []; for (let i = 0; i < Math.min(ins.length, gen.length) && out.length < k; i += step) out.push([ins[i], gen[i]]); return out;
};
const rows = [...take('val', Math.ceil(n * 0.5)), ...take('stt', Math.ceil(n * 0.25)), ...take('noisy', Math.ceil(n * 0.25))];
const FILLER = /\b(uh+|um+|erm|er|ah+|hmm+)\b/gi;
const PAIRS = [['csMargin', 'cs_margin', 0.05], ['pSay', 'p_say', 1e-3], ['csMinFull', 'cs_min_full', 1e-3], ['insMinP', 'ins_min_p', 1e-3], ['insLp', 'ins_lp', 0.01],
  ['insMinMargin', 'ins_min_margin', 0.05], ['digMinP', 'dig_min_p', 1e-3], ['digMargin', 'dig_margin', 0.05], ['rwyMinP', 'rwy_min_p', 1e-3], ['eosP', 'eos_p', 1e-3], ['nTok', 'n_tok', 0],
  ['csLh', 'cs_lh', 1e-3], ['csLhMargin', 'cs_lh_margin', 1e-3], ['nSearch', 'n_search', 0]];
let same = 0, sameOld = 0, sigOk = 0; const maxErr = {}; const ms = [], msOld = [], msTrie = [];
for (const [ex, g] of rows) {
  const cs = ex.ctx.split('\n').slice(1).filter((l) => l.trim()).map((l) => l.split(' ')[0]);
  const said = ex.said.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  mNew.prefill(ex.ctx); const t = mNew.complete(said, cs, 48, 'trie'); msTrie.push(t.ms);
  mNew.prefill(ex.ctx); const a = mNew.complete(said, cs); ms.push(a.ms);
  if (mOld) { mOld.prefill(ex.ctx); const b = mOld.complete(said, cs); msOld.push(b.ms); if (JSON.stringify(t.tokens) === JSON.stringify(b.tokens) && t.confidence === b.confidence) sameOld++; else console.log('OLD/NEW(trie) DIFF', said, t.line, b.line); }
  if (a.line === g.line && a.tokens.length === g.n_tok) same++; else console.log('TORCH DIFF', JSON.stringify(said), a.line, '|', g.line);
  let ok = true;
  for (const [k, pk, tol] of PAIRS) {
    const tsv = a.signals[k], pyv = g[pk];
    // probabilities compared in absolute terms, margins/log-probs absolute too (float32 vs float32 on the same weights)
    const e = Math.abs(tsv - pyv); maxErr[k] = Math.max(maxErr[k] || 0, e);
    if (e > Math.max(tol, tol * Math.abs(pyv))) { ok = false; }
  }
  if (ok) sigOk++;
}
const q = (x, f) => [...x].sort((p, r) => p - r)[Math.min(x.length - 1, Math.floor(x.length * f))];
const med = (x) => q(x, 0.5);
const extra = ms.map((v, i) => v - msTrie[i]);
console.log(JSON.stringify({ n: rows.length, trie_tokens_same_as_committed_engine: mOld ? sameOld : 'n/a', line_same_as_pytorch: same, signals_within_tolerance: sigOk,
  max_abs_err: Object.fromEntries(Object.entries(maxErr).map(([k, v]) => [k, +v.toPrecision(3)])), complete_ms_p50_new: +med(ms).toFixed(1), complete_ms_p50_trie: +med(msTrie).toFixed(1),
  extra_ms_p50: +med(extra).toFixed(1), extra_ms_p95: +q(extra, 0.95).toFixed(1), complete_ms_p50_committed: mOld ? +med(msOld).toFixed(1) : null }));

function refParity(refPath, mdir) {
  const d = path.resolve(ROOT, mdir);
  const mt = JSON.parse(fs.readFileSync(path.join(d, 'model.json'), 'utf8')); const bb = fs.readFileSync(path.join(d, 'model.bin'));
  const m = new NEW.S1Model(mt, bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength));
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  let ok = 0, lh = 0;
  for (const r of ref) {
    m.prefill(r.ctx); const c = m.complete(r.said, r.callsigns, 48, r.decode === 'trie' ? 'trie' : 'score');
    if (JSON.stringify(c.tokens) === JSON.stringify(r.tokens)) ok++; else console.log('DIFF', JSON.stringify(r.said), c.line, '|', r.line);
    if (r.decode !== 'trie' && Math.abs(c.signals.csLh - r.cs_lh) < 1e-3 && Math.abs(c.signals.csLhMargin - r.cs_lh_margin) < 1e-3 && c.signals.nSearch === r.n_search) lh++;
  }
  console.log(JSON.stringify({ n: ref.length, decode: ref[0] && ref[0].decode, tokens_same_as_pytorch: ok, search_signals_same: lh }));
}

// Parakeet (the game's server recogniser, src/app/api/voice/stt/engine.ts) over a list of clips, for the quality filter
// and the baseline: rows {id, wav, ctx?} -> out.jsonl {id, heard, ms}. Resumable. Build first: bash ml/stt/bench2/run.sh build
//   node ml/stt/data/check.cjs <list.jsonl> <out.jsonl> [--names]   (--names: the callsigns on frequency as hotwords, as the game does)
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
process.chdir(ROOT);
const { transcribeParakeet, parakeetReady } = require(path.join(ROOT, '.tmp/stt/src/app/api/voice/stt/engine.js'));
function readWav(f) {
  const b = fs.readFileSync(f); let o = 12, data = null, ch = 1, bits = 16;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); bits = b.readUInt16LE(o + 22); }
    if (id === 'data') { data = b.subarray(o + 8, o + 8 + n); break; }
    o += 8 + n + (n & 1);
  }
  if (!data || bits !== 16) throw new Error(`unsupported wav ${f}`);
  const n = data.length / 2 / ch, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * ch) / 32768;
  return x;
}
(async () => {
  const [list, out] = process.argv.slice(2), useNames = process.argv.includes('--names');
  if (!parakeetReady()) throw new Error('Parakeet model files missing');
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const rows = fs.readFileSync(list, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !done.has(r.id));
  const fo = fs.openSync(out, 'a'); const t0 = Date.now(); let k = 0;
  for (const r of rows) {
    const names = useNames && r.ctx ? r.ctx.split('\n').slice(1).map((l) => (l.match(/^\S+ (.+?) (ARR|DEP) /) || [])[1]).filter(Boolean) : [];
    try { const t = Date.now(); const res = await transcribeParakeet(readWav(r.wav), { names }); fs.writeSync(fo, JSON.stringify({ id: r.id, heard: res.text, ms: Date.now() - t }) + '\n'); }
    catch (e) { fs.writeSync(fo, JSON.stringify({ id: r.id, heard: null, error: String(e).slice(0, 200) }) + '\n'); }
    if (++k % 200 === 0) console.error(`${k}/${rows.length} ${((Date.now() - t0) / k).toFixed(0)} ms/clip`);
  }
  console.error(`done ${k}`);
})().catch((e) => { console.error(e); process.exit(1); });

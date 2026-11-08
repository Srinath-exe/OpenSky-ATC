// STT bake-off, step 2: run the game's own on-device recogniser (public/voice/stt-worker.js) on the clips in headless
// Chromium, then score each transcript through the rule parser (L0) against the gold command.
//   node ml/stt/browser_bench.cjs ml/stt/out/clips [http://127.0.0.1:3005]
// Needs the TS sources compiled to .tmp/ml (ml/data/export.sh does that).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const { parseCommand } = require(path.join(ROOT, '.tmp/ml/src/lib/sim/commands.js'));

const dir = path.resolve(process.argv[2] || 'ml/stt/out/clips');
const base = process.argv[3] || 'http://127.0.0.1:3005';
const variant = process.argv[4] || '';   // e.g. 'model=base&dtype=fp32'
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

function pcm16(file) {
  const b = fs.readFileSync(file); let o = 12;
  while (o < b.length) { const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4); if (id === 'data') { o += 8; const out = new Array(n / 2); for (let i = 0; i < n / 2; i++) out[i] = b.readInt16LE(o + i * 2) / 32768; return out; } o += 8 + n; }
  return [];
}
const norm = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (/hdg|inbound/i.test(k) ? 'H' : Math.round(v)) : v));
const words = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = words(ref), h = words(hyp); const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { err: d[r.length][h.length], n: r.length };
}

(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage();
  await page.goto(`${base}/reports/voice-ai.html`);
  await page.evaluate((v) => new Promise((res, rej) => {
    window.__w = new Worker('/voice/stt-worker.js' + (v ? '?' + v : ''), { type: 'module' });
    window.__w.onmessage = (e) => { if (e.data.type === 'ready') { window.__dev = e.data.device; res(); } if (e.data.type === 'error') rej(e.data.message); };
    window.__w.postMessage({ type: 'load' });
  }), variant);
  let we = 0, wn = 0, ok = 0, csOk = 0; const ms = []; const rows = [];
  for (const m of meta) {
    const audio = pcm16(path.join(dir, m.wav));
    const r = await page.evaluate((a) => new Promise((res) => {
      const f = new Float32Array(a); window.__w.onmessage = (e) => { if (e.data.type === 'result' || e.data.type === 'error') res(e.data); };
      window.__w.postMessage({ type: 'transcribe', id: 1, audio: f }, [f.buffer]);
    }), audio);
    const text = r.text || '';
    const aircraft = m.ctx.split('\n').slice(1).map((l) => ({ callsign: l.split(' ')[0] }));
    const p = parseCommand(text.replace(/[.!?]+$/, ''), { aircraft });
    const good = p.ok && norm(p.ast) === norm(m.ast);
    const w = wer(m.text, text); we += w.err; wn += w.n; ok += good; csOk += !!(p.callsign && p.callsign === m.ast.callsign); ms.push(r.ms);
    rows.push({ gold: m.text, heard: text, parsed: good, line: m.line, ms: r.ms });
  }
  ms.sort((a, b) => a - b);
  const res = { variant: variant || 'model=tiny&dtype=q8', device: await page.evaluate(() => window.__dev), clips: meta.length, wer: +(we / wn).toFixed(3), l0_exact: +(ok / meta.length).toFixed(3), callsign: +(csOk / meta.length).toFixed(3), ms_p50: ms[ms.length >> 1], ms_p95: ms[Math.floor(ms.length * 0.95)] };
  console.log(JSON.stringify(res));
  for (const r of rows.slice(0, 12)) console.log(`${r.parsed ? 'OK ' : '-- '} ${r.gold}\n     heard: ${r.heard}`);
  fs.writeFileSync(path.join(dir, `results-${(variant || 'default').replace(/[^a-z0-9]+/gi, '_')}.json`), JSON.stringify({ summary: res, rows }, null, 1));
  await browser.close();
})();

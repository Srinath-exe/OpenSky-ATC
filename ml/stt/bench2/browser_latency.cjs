// On-device engines in headless Chromium (public/voice/stt-worker.js, WASM: no WebGPU adapter headless, and the site
// is not cross-origin isolated, so WASM runs single-threaded, as it does for players today).
// Serves public/ on a private port for the run (no change to the live site).
//   node ml/stt/bench2/browser_latency.cjs <clipdir> <out.jsonl> "model=base" [--limit 40] [--cond clean,late] [--every 2]
// Prints the memory of the browser's processes (PSS, MB: Chromium's own tree, before the worker, after the model is
// ready, after the last clip) and the median / p95 transcription time.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { loadClips, readWav, namesFromCtx } = require('./clips.cjs');
const ROOT = path.resolve(__dirname, '../../..');
const argv = process.argv.slice(2);
const [dir, out, variant] = argv;
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const limit = Number(opt('limit', '40'));
const conds = opt('cond', '') ? opt('cond').split(',') : null;
const every = Number(opt('every', '1'));
/** PSS (MB) of every process descended from this one (the Chromium tree playwright launched). */
function treePssMb() {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(Number(d)); } catch { /* gone */ }
  }
  let kb = 0; const todo = [...(kids.get(process.pid) || [])];
  while (todo.length) {
    const p = todo.pop(); todo.push(...(kids.get(p) || []));
    try { const m = fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m); if (m) kb += Number(m[1]); } catch { /* gone */ }
  }
  return Math.round(kb / 1024);
}
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>stt bench</title>'); return; }
  const f = path.join(ROOT, 'public', path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--disable-gpu'] });
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  const mem0 = treePssMb();
  const t0 = Date.now();
  const ready = await page.evaluate((v) => new Promise((res, rej) => {
    window.__w = new Worker('/voice/stt-worker.js?' + v, { type: 'module' });
    window.__w.onmessage = (e) => { if (e.data.type === 'ready') res(e.data); if (e.data.type === 'error') rej(e.data.message); };
    window.__w.onerror = (e) => rej('worker error ' + (e.message || ''));
    window.__w.postMessage({ type: 'load' });
  }), variant);
  const memReady = treePssMb();
  console.error(JSON.stringify({ variant, ready, loadS: Math.round((Date.now() - t0) / 1000), pssMb: { page: mem0, ready: memReady } }));
  const clips = loadClips(dir).filter((c) => (!conds || conds.includes(c.cond)) && (every <= 1 || !c.id || Number(c.id) % every === 0)).slice(0, limit);
  const msAll = [];
  const fd = fs.openSync(out, 'w');
  for (const c of clips) {
    const audio = Array.from(readWav(c.path));
    const r = await page.evaluate(([a, names]) => new Promise((res) => {
      const f = new Float32Array(a); window.__w.onmessage = (e) => { if (e.data.type === 'result' || e.data.type === 'error') res(e.data); };
      window.__w.postMessage({ type: 'transcribe', id: 1, audio: f, names }, [f.buffer]);
    }), [audio, namesFromCtx(c.ctx)]);
    fs.writeSync(fd, JSON.stringify({ wav: c.wav, heard: r.text || '', alts: r.alternatives || [], ms: r.ms, device: r.device, sec: +(audio.length / 16000).toFixed(2), error: r.message }) + '\n');
    if (typeof r.ms === 'number') msAll.push(r.ms);
  }
  fs.closeSync(fd);
  msAll.sort((a, b) => a - b);
  console.error(JSON.stringify({ variant, n: msAll.length, ms_p50: msAll[msAll.length >> 1], ms_p95: msAll[Math.floor(msAll.length * 0.95)], pssMb: { page: mem0, ready: memReady, end: treePssMb() } }));
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });

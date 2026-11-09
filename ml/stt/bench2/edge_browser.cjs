// On-device engines in headless Chromium, with download size and RAM (ml/stt/models/EDGE.md). Same worker the game
// uses (public/voice/stt-worker.js), WASM: headless Chromium on this GPU-less server has no WebGPU adapter, and the
// site is not cross-origin isolated, so onnxruntime-web runs single-threaded (as for players today); the Cactus engine
// is a single-threaded build anyway.
//   node ml/stt/bench2/edge_browser.cjs <clipdir> <out.jsonl> "model=whistle" [--every 2] [--limit 40] [--cond clean,laptop]
// out.jsonl: the bench rows (wav, heard, alts, ms); <out>.summary.json: load time, bytes downloaded, RAM, latency.
// RAM = PSS of every process of this Chromium (smaps_rollup), sampled every 250 ms: baseline (blank page), after the
// model is ready, and the peak while transcribing.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { loadClips, readWav, namesFromCtx } = require('./clips.cjs');
const ROOT = path.resolve(__dirname, '../../..');
const argv = process.argv.slice(2);
const [dir, out, variant] = argv;
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const limit = Number(opt('limit', '40'));
const every = Number(opt('every', '1'));
const conds = opt('cond', '') ? opt('cond').split(',') : null;
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>stt bench</title>'); return; }
  const f = path.join(ROOT, 'public', path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

/** PIDs of this Chromium: descendants of the browser process (found by its unique profile directory). */
function chromePids(profile) {
  const ps = execSync('ps -eo pid=,ppid=,args=', { maxBuffer: 1 << 24 }).toString().trim().split('\n').map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m ? { pid: +m[1], ppid: +m[2], args: m[3] } : null; }).filter(Boolean);
  const roots = ps.filter((p) => p.args.includes(profile) && !/^(ps|sh|bash)\b/.test(p.args)).map((p) => p.pid);
  const set = new Set(roots);
  for (let grew = true; grew;) { grew = false; for (const p of ps) if (!set.has(p.pid) && set.has(p.ppid)) { set.add(p.pid); grew = true; } }
  return [...set];
}
function pssMB(pids) {
  let kb = 0;
  for (const pid of pids) { try { const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m); if (m) kb += +m[1]; } catch { /* gone */ } }
  return Math.round(kb / 1024);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync('/tmp/edge-browser-');
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, args: ['--disable-gpu'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  let bytes = 0; const files = {};
  ctx.on('requestfinished', async (req) => {
    try { const s = await req.sizes(); const u = req.url(); if (!u.startsWith(base)) { bytes += s.responseBodySize; files[u.split('?')[0].split('/').slice(-1)[0]] = s.responseBodySize; } } catch { /* ignore */ }
  });
  await page.goto(`${base}/`);
  const pids = () => chromePids(profile);
  const ramBase = pssMB(pids());
  let peak = 0; const tick = setInterval(() => { peak = Math.max(peak, pssMB(pids())); }, 250);
  const t0 = Date.now();
  const ready = await page.evaluate((v) => new Promise((res, rej) => {
    window.__w = new Worker('/voice/stt-worker.js?' + v, { type: 'module' });
    window.__w.onmessage = (e) => { if (e.data.type === 'ready') res(e.data); if (e.data.type === 'error') rej(e.data.message); };
    window.__w.onerror = (e) => rej('worker error ' + (e.message || ''));
    window.__w.postMessage({ type: 'load' });
  }), variant);
  const loadS = (Date.now() - t0) / 1000;
  const ramReady = pssMB(pids()); peak = Math.max(peak, ramReady);
  console.error(JSON.stringify({ variant, ready, loadS, downloadedMB: +(bytes / 1e6).toFixed(1), ramBase, ramReady }));
  let clips = loadClips(dir).filter((c) => (!conds || conds.includes(c.cond)) && (every <= 1 || !c.id || Number(c.id) % every === 0));
  if (limit) clips = clips.slice(0, limit);
  const fd = fs.openSync(out, 'w');
  const ms = [];
  for (const c of clips) {
    const audio = Array.from(readWav(c.path));
    const r = await page.evaluate(([a, names]) => new Promise((res) => {
      const f = new Float32Array(a); window.__w.onmessage = (e) => { if (e.data.type === 'result' || e.data.type === 'error') res(e.data); };
      window.__w.postMessage({ type: 'transcribe', id: 1, audio: f, names }, [f.buffer]);
    }), [audio, namesFromCtx(c.ctx)]);
    ms.push(r.ms);
    fs.writeSync(fd, JSON.stringify({ wav: c.wav, heard: r.text || '', alts: r.alternatives || [], ms: r.ms, device: r.device, sec: +(audio.length / 16000).toFixed(2), error: r.message }) + '\n');
  }
  fs.closeSync(fd);
  clearInterval(tick);
  const sorted = [...ms].sort((a, b) => a - b), q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const secs = clips.map((c) => readWav(c.path).length / 16000);
  const summary = { variant, device: ready.device, clips: clips.length, loadS, readyMs: ready.ms, downloadedMB: +(bytes / 1e6).toFixed(1), files,
    ramBaseMB: ramBase, ramReadyMB: ramReady, ramPeakMB: peak, ramModelMB: peak - ramBase,
    msP50: q(0.5), msP90: q(0.9), msMean: Math.round(ms.reduce((s, x) => s + x, 0) / ms.length), audioSecMean: +(secs.reduce((s, x) => s + x, 0) / secs.length).toFixed(2),
    load: fs.readFileSync('/proc/loadavg', 'utf8').trim() };
  fs.writeFileSync(out.replace(/\.jsonl$/, '') + '.summary.json', JSON.stringify(summary, null, 1));
  console.error(JSON.stringify(summary));
  await ctx.close(); server.close();
  fs.rmSync(profile, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });

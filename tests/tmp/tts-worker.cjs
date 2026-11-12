// Neural pilot voice worker in headless Chromium (public/voice/tts-worker.js): serves public/ on a local port, loads the
// worker (Paradee int8 on onnxruntime-web WASM, misaki lexicon G2P), synthesises N benchmark readbacks (already through
// the ATC normaliser: ml/tts/data/bench60.jsonl `spoken`, voices from voiceFor), and reports load and per-line times.
// Writes the browser's audio to ml/tts/out/bench/browser/<id>_<voice>.wav (16 kHz) for Whisper scoring (bench.py), and a
// summary to ml/tts/out/browser_latency.json.     node tests/tmp/tts-worker.cjs [N=10] [--cold-twice]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const N = Number(process.argv[2] || 10);
const MODEL = process.argv.includes('--fp32') ? 'fp32' : 'int8';
const lines = fs.readFileSync(path.join(ROOT, 'ml/tts/data/bench60.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.onnx': 'application/octet-stream', '.html': 'text/html' };
const bytes = {};
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/__tts.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>tts</title>'); }
  const f = u === '/models/tts/paradee-8m-v1.2/paradee.onnx' ? path.join(ROOT, 'ml/tts/cache/paradee/onnx/paradee.onnx') : path.join(ROOT, 'public', u);   // fp32: test only
  if (!f.startsWith(path.join(ROOT, 'public')) && !f.endsWith('/paradee.onnx') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const b = fs.readFileSync(f); bytes[u] = b.length;
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
  res.end(b);
});
function wav16(pcm24) {           // 24 kHz float -> 16 kHz int16 wav (linear interpolation; the audio is for Whisper only)
  const n = Math.floor(pcm24.length * 2 / 3), out = Buffer.alloc(44 + n * 2);
  let peak = 1e-9; for (const v of pcm24) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) { const x = i * 1.5, j = Math.floor(x), f = x - j; const v = ((pcm24[j] ?? 0) * (1 - f) + (pcm24[j + 1] ?? 0) * f) / peak * 0.89; out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2); }
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  return out;
}
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errors = [], net = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  p.on('response', async r => { try { const h = await r.allHeaders(); net.push({ url: r.url(), status: r.status(), len: Number(h['content-length'] || 0), enc: h['content-encoding'] || '' }); } catch { /* ignore */ } });
  await p.goto(base + '/__tts.html');
  const items = lines.slice(0, N).map((l, i) => ({ id: l.bench_id, text: l.spoken, voice: l.voice.voice, speed: l.voice.speed }));
  items.model = MODEL;
  const r = await p.evaluate(async ({ items, model }) => {
    items.model = model;
    const w = new Worker('/voice/tts-worker.js', { type: 'module' });
    const wait = (id) => new Promise((res) => { const h = (e) => { if (e.data.id === id) { w.removeEventListener('message', h); res(e.data); } }; w.addEventListener('message', h); });
    const t0 = performance.now();
    w.postMessage({ type: 'load', id: 'L', model: items.model });
    const ready = await wait('L');
    const loadMs = performance.now() - t0;
    const out = [];
    for (const it of items) {
      const t1 = performance.now();
      w.postMessage({ type: 'speak', id: it.id, text: it.text, voice: it.voice, speed: it.speed });
      const a = await wait(it.id);
      const wall = performance.now() - t1;
      if (a.type !== 'audio') { out.push({ id: it.id, error: a.message || a.type }); continue; }
      let ss = 0; for (const v of a.pcm) ss += v * v;
      out.push({ id: it.id, voice: it.voice, wall_ms: Math.round(wall), synth_ms: a.ms, g2p_ms: a.g2pMs, audio_s: +(a.pcm.length / a.sr).toFixed(2), rms: +Math.sqrt(ss / Math.max(1, a.pcm.length)).toFixed(4), phonemes: a.phonemes, pcm: Array.from(a.pcm) });
    }
    // a second, warm load of the same worker is instant; a fresh worker re-reads the (HTTP-cached) model
    const w2 = new Worker('/voice/tts-worker.js', { type: 'module' });
    const t2 = performance.now();
    await new Promise((res) => { w2.onmessage = (e) => { if (e.data.id === 'L2') res(e.data); }; w2.postMessage({ type: 'load', id: 'L2' }); });
    const reloadMs = performance.now() - t2;
    return { ready, loadMs: Math.round(loadMs), reloadMs: Math.round(reloadMs), out, isolated: self.crossOriginIsolated, ua: navigator.userAgent };
  }, { items, model: MODEL });
  const dir = path.join(ROOT, MODEL === 'fp32' ? 'ml/tts/out/bench/browser-fp32' : 'ml/tts/out/bench/browser'); fs.mkdirSync(dir, { recursive: true });
  for (const o of r.out) if (o.pcm) { fs.writeFileSync(path.join(dir, `${String(o.id).padStart(2, '0')}_${o.voice}.wav`), wav16(o.pcm)); delete o.pcm; }
  const ok = r.out.filter(o => !o.error);
  const synth = ok.map(o => o.synth_ms).sort((a, b) => a - b), audio = ok.reduce((s, o) => s + o.audio_s, 0);
  const cdn = net.filter(x => /jsdelivr/.test(x.url)).map(x => ({ url: x.url.replace(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, ''), status: x.status, bytes_on_wire: x.len, enc: x.enc }));
  const summary = {
    when: new Date().toISOString(), chromium: r.ua.match(/Chrome\/[\d.]+/)?.[0], threads: r.ready.threads, cross_origin_isolated: r.isolated,
    load_ms: r.loadMs, worker_ready_ms: r.ready.ms, reload_ms: r.reloadMs, n: ok.length, errors: errors.concat(r.out.filter(o => o.error).map(o => `${o.id}: ${o.error}`)),
    synth_ms_median: synth[Math.floor(synth.length / 2)], synth_ms_max: synth[synth.length - 1], synth_ms_mean: Math.round(synth.reduce((s, x) => s + x, 0) / Math.max(1, synth.length)),
    audio_s_total: +audio.toFixed(2), x_realtime: +(audio * 1000 / synth.reduce((s, x) => s + x, 0)).toFixed(1),
    g2p_ms_mean: +(ok.reduce((s, o) => s + o.g2p_ms, 0) / Math.max(1, ok.length)).toFixed(2),
    local_bytes: bytes, cdn, lines: r.out, load_avg: require('os').loadavg().map(x => +x.toFixed(1)),
  };
  summary.model = MODEL;
  fs.writeFileSync(path.join(ROOT, `ml/tts/out/browser_latency${MODEL === 'fp32' ? '_fp32' : ''}.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ ...summary, lines: summary.lines.map(o => `${o.id} ${o.voice} synth ${o.synth_ms} ms wall ${o.wall_ms} ms audio ${o.audio_s} s rms ${o.rms}${o.error ? ' ERROR ' + o.error : ''}`) }, null, 1));
  await b.close(); server.close();
  process.exit(summary.errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

// The in-browser voice model, end to end in headless Chromium against the live server: load the 2 MB int8 model in
// the worker, prefill a real game state, complete messy transcripts, check the command lines and the timings.
//   node tests/tmp/s1-browser-check.cjs [base] [ref.json]
const fs = require('fs');
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:3005';
const ref = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).slice(0, 30);
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${base}/reports/voice-ai.html`);
  const r = await p.evaluate(async (rows) => {
    const w = new Worker('/voice/s1-worker.js', { type: 'module' });
    let id = 0; const call = (m) => new Promise((res) => { const my = ++id; const h = (e) => { if (e.data.id === my) { w.removeEventListener('message', h); res(e.data); } }; w.addEventListener('message', h); w.postMessage({ ...m, id: my }); });
    const t0 = performance.now(); const ready = await call({ type: 'load', url: '/models/s1/2m-swap-v1' }); const loadMs = performance.now() - t0;
    if (ready.type === 'error') return { error: ready.message };
    const out = []; const pre = []; const comp = [];
    for (const r of rows) {
      const a = await call({ type: 'prefill', ctx: r.ctx }); pre.push(a.ms);
      const c = await call({ type: 'complete', said: r.said, callsigns: r.callsigns }); comp.push(c.ms);
      out.push({ said: r.said, got: c.line, want: r.line, conf: c.confidence });
    }
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    return { loadMs: Math.round(loadMs), prefill_p50: Math.round(med(pre)), complete_p50: Math.round(med(comp)), out };
  }, ref);
  if (r.error) { console.log('ERROR', r.error); process.exit(1); }
  const norm = (s) => s.toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  const ok = r.out.filter((o) => norm(o.got) === norm(o.want)).length;
  console.log(JSON.stringify({ n: r.out.length, exact: ok, load_ms: r.loadMs, prefill_ms_p50: r.prefill_p50, complete_ms_p50: r.complete_p50, page_errors: errs.length }));
  for (const o of r.out.slice(0, 4)) console.log(`  "${o.said}" -> ${o.got}  (${o.conf.toFixed(3)})`);
  await b.close();
})();

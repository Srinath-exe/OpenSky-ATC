// Live site: the Paradee pilot-voice worker loads and speaks one readback per voice.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:3005/reports/index.html');
  const r = await p.evaluate(async () => {
    const w = new Worker('/voice/tts-worker.js', { type: 'module' });
    let id = 0; const call = (m) => new Promise((res) => { const my = ++id; const h = (e) => { if (e.data.id === my) { w.removeEventListener('message', h); res(e.data); } }; w.addEventListener('message', h); w.postMessage({ ...m, id: my }); });
    const t0 = performance.now(); const ready = await call({ type: 'load' }); const loadMs = Math.round(performance.now() - t0);
    if (ready.type === 'error') return { error: ready.message };
    const out = [];
    for (const voice of [0, 1, 2, 3]) {
      const a = await call({ type: 'speak', text: 'Descend and maintain flight level one two zero, Speedbird two seven three.', voice, speed: 1.05 });
      out.push(a.type === 'audio' ? { voice, sec: +(a.pcm.length / a.sr).toFixed(2), ms: Math.round(a.ms) } : { voice, error: a.message });
    }
    return { loadMs, threads: ready.threads, out };
  });
  console.log(JSON.stringify(r)); console.log('page errors', errs.length, errs.slice(0, 2)); await b.close();
})();

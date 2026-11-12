// Load the on-device STT worker in headless Chromium against the live server; transcribe a synthetic clip.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  p.on('console', m => console.log('console', m.text()));
  await p.goto('http://127.0.0.1:3005/reports/voice-ai.html');
  const r = await p.evaluate(() => new Promise((resolve) => {
    const w = new Worker('/voice/stt-worker.js', { type: 'module' });
    const t0 = performance.now(); let last = 0;
    w.onerror = (e) => resolve({ error: 'worker error ' + (e.message || '') });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { last = m.loaded; return; }
      if (m.type === 'ready') { const a = new Float32Array(16000 * 2); for (let i = 0; i < a.length; i++) a[i] = 0.1 * Math.sin(i / 8) * (i % 4000 < 2000 ? 1 : 0); w.postMessage({ type: 'transcribe', id: 1, audio: a }); resolve.ready = m; return; }
      if (m.type === 'result') resolve({ ready: resolve.ready, result: m, totalMs: Math.round(performance.now() - t0) });
      if (m.type === 'error') resolve({ error: m.message });
    };
    w.postMessage({ type: 'load' });
    setTimeout(() => resolve({ error: 'timeout', lastBytes: last }), 170000);
  }));
  console.log(JSON.stringify(r));
  await b.close();
})();

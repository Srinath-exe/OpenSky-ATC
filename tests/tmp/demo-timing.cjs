const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.addInitScript(() => {
    const W = window.Worker; window.__log = [];
    window.Worker = function (...a) { const w = new W(...a); const post = w.postMessage.bind(w);
      w.postMessage = (m, ...r) => { window.__log.push([performance.now(), 'send', m.type, (m.said || '').slice(0, 40)]); return post(m, ...r); };
      w.addEventListener('message', (e) => window.__log.push([performance.now(), 'recv', e.data.type, e.data.ms])); return w; };
  });
  await p.goto('http://127.0.0.1:3005/reports/voice-demo.html');
  await p.waitForFunction(() => /KV cache/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  await p.selectOption('#ex', '9');
  await p.waitForFunction(() => window.__log.filter((x) => x[1] === 'recv' && x[2] === 'prefilled').length >= 2, null, { timeout: 60000 });
  const t0 = await p.evaluate(() => performance.now());
  await p.click('#go'); await p.waitForSelector('#result:not([hidden])');
  const log = await p.evaluate((t0) => window.__log.filter((x) => x[0] >= t0).map((x) => [Math.round(x[0] - t0), x[1], x[2], x[3]]), t0);
  console.log(JSON.stringify(log)); console.log(await p.evaluate(() => document.getElementById('ms').textContent));
  await b.close();
})();

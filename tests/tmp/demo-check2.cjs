// Demo page against a server: every example + two typed cases, through the game's own decision pipeline.
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:3005';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(`${base}/reports/voice-demo.html`);
  await p.waitForFunction(() => /KV cache/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const n = await p.evaluate(() => document.getElementById('ex').options.length);
  const get = () => p.evaluate(() => ({ said: document.getElementById('said').value, line: document.getElementById('line').textContent, gold: document.getElementById('gold').textContent, path: document.getElementById('path').textContent, verdict: document.getElementById('verdict').textContent, ms: document.getElementById('ms').textContent }));
  let ok = 0;
  for (let i = 0; i < n; i++) {
    await p.selectOption('#ex', String(i));
    await p.waitForFunction(() => /KV cache/.test(document.getElementById('status').textContent));
    await p.evaluate(() => { document.getElementById('result').hidden = true; });
    await p.click('#go'); await p.waitForSelector('#result:not([hidden])');
    const r = await get(); if (/✓/.test(r.gold)) ok++;
    console.log(JSON.stringify(r));
  }
  for (const t of ['uh delta two eighteen for turn left heading to seven zero', 'speed bird nine six descend flight level niner zero']) {
    await p.fill('#said', t); await p.evaluate(() => { document.getElementById('result').hidden = true; }); await p.click('#go'); await p.waitForSelector('#result:not([hidden])');
    console.log(JSON.stringify(await get()));
  }
  console.log(`match ${ok}/${n}`, 'page errors', errs.length, errs.slice(0, 3));
  await b.close();
})();

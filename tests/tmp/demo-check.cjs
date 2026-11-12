const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('https://openatc.aeon-labs.site/reports/voice-demo.html');
  await p.waitForFunction(() => /KV cache/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const res = [];
  for (const i of [0, 3, 8, 11]) {
    await p.selectOption('#ex', String(i));
    await p.waitForFunction(() => /KV cache/.test(document.getElementById('status').textContent));
    await p.click('#go'); await p.waitForSelector('#result:not([hidden])');
    res.push(await p.evaluate(() => ({ said: document.getElementById('said').value, line: document.getElementById('line').textContent, gold: document.getElementById('gold').textContent, verdict: document.getElementById('verdict').textContent, ms: document.getElementById('ms').textContent })));
  }
  await p.fill('#said', 'uh delta two eighteen for turn left heading to seven zero'); await p.click('#go');
  res.push(await p.evaluate(() => ({ said: document.getElementById('said').value, line: document.getElementById('line').textContent, verdict: document.getElementById('verdict').textContent })));
  for (const r of res) console.log(JSON.stringify(r));
  console.log('page errors', errs.length); await b.close();
})();

const { chromium, devices } = require('playwright');
const OUT = process.env.OUT, BASE = process.env.BASE || 'https://openatc.aeon-labs.site';
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  for (const [name, url, wait] of [['landing', '/', 6000], ['start', '/start', 4000], ['learn', '/learn', 6000], ['play', '/play?icao=KSFO', 15000], ['settings', '/settings', 3000]]) {
    errs.length = 0;
    await p.goto(BASE + url, { timeout: 120000, waitUntil: 'domcontentloaded' }).catch((e) => errs.push('goto ' + e.message.slice(0, 80)));
    await p.waitForTimeout(wait);
    const ov = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth }));
    await p.screenshot({ path: `${OUT}/ph-${name}.png` });
    console.log(name, JSON.stringify(ov), errs.join(' | '));
  }
  await b.close();
})();

const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 800, height: 450 } });
  p.on('console', (m) => { const t = m.text(); if (/THREE|ERROR|error|shader/i.test(t)) console.log(m.type(), t.slice(0, 1500)); });
  await p.goto('http://localhost:3007/map3d?icao=KSFO&quality=high', { timeout: 180000 });
  await p.waitForSelector('[data-testid="world-map"][data-status="ready"]', { timeout: 240000 });
  await p.evaluate(() => window.__worldWx({ cloudCover: 0.5 })); await p.waitForTimeout(4000);
  await b.close();
})();

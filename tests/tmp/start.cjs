const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto('http://localhost:3007/start', { timeout: 180000 }); await p.waitForTimeout(3000);
  await p.screenshot({ path: 'tests/tmp/start.jpg', type: 'jpeg', quality: 80, fullPage: true });
  await p.goto('http://localhost:3007/', { timeout: 180000 }); await p.waitForTimeout(3000);
  console.log('root title', await p.title(), 'play links', await p.$$eval('a[href="/start"]', (a) => a.length));
  await b.close();
})();

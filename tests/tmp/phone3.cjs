const { chromium, devices } = require('playwright');
const OUT = process.env.OUT, BASE = 'https://openatc.aeon-labs.site';
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const p = await ctx.newPage(); p.on('pageerror', (e) => console.log('ERR', e.message.slice(0, 160)));
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(5000); await p.screenshot({ path: `${OUT}/ph3-land.png` });
  await p.goto(BASE + '/start', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(4000);
  await p.evaluate(() => document.querySelector('[data-testid="home-runways"]')?.scrollIntoView()); await p.waitForTimeout(500); await p.screenshot({ path: `${OUT}/ph3-start.png` });
  await p.goto(BASE + '/learn', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(5000);
  await p.getByText(/take the frequency/i).first().click().catch(() => {});
  await p.waitForTimeout(2000); await p.getByText(/^skip/i).first().click().catch(() => console.log('no skip'));
  await p.waitForTimeout(4000); await p.screenshot({ path: `${OUT}/ph3-seats.png` });
  await p.goto(BASE + '/play?icao=KSFO', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(10000); await p.screenshot({ path: `${OUT}/ph3-play.png` });
  await b.close();
})();

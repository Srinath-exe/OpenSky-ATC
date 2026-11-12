const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto('http://localhost:3007/play?airport=KSFO', { timeout: 180000 });
  await p.waitForSelector('[data-testid="look-picker"]', { timeout: 240000 }); await p.waitForTimeout(1500);
  await p.screenshot({ path: 'tests/tmp/picker.jpg', type: 'jpeg', quality: 80 });
  await p.click('[data-testid="look-cinematic"]'); await p.click('[data-testid="look-picker-confirm"]').catch(async () => { await p.getByRole('button', { name: /Use Cinematic/ }).click(); });
  await p.waitForTimeout(1000);
  console.log('stored', await p.evaluate(() => localStorage.getItem('skycontrol_world_look')), 'picker gone', !(await p.$('[data-testid="look-picker"]')));
  await b.close();
})();

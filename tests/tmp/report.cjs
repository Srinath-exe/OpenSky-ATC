const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('https://openatc.aeon-labs.site/settings', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000);
  await p.evaluate(() => setTimeout(() => { throw new Error('TEST crash from launch check') }, 0)); await p.waitForTimeout(1500);
  await p.getByRole('tab', { name: /about/i }).click(); await p.getByTestId('set-report').click();
  await p.getByTestId('report-note').fill('TEST report from the launch check, please ignore');
  await p.getByRole('button', { name: /send report/i }).click(); await p.waitForTimeout(2000);
  console.log('dialog:', await p.getByText(/on its way/i).count() ? 'sent' : 'NOT sent');
  await b.close();
})();

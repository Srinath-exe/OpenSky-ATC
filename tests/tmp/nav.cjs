const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: Number(process.env.W || 1536), height: 800 }, deviceScaleFactor: 2 });
  await p.addInitScript(() => { localStorage.setItem('skycontrol_world_look', 'standard'); });
  await p.goto('http://localhost:3007/play?airport=KSFO', { timeout: 180000 });
  await p.waitForSelector('nav, header', { timeout: 120000 }); await p.waitForTimeout(8000);
  const box = await p.evaluate(() => { const r = document.querySelector('[class*="NavBar-module"][class*="nav"]')?.getBoundingClientRect() || document.querySelector('header')?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; });
  console.log(JSON.stringify(box));
  await p.screenshot({ path: process.env.OUT || 'tests/tmp/nav.png', clip: { x: Number(process.env.CX || 700), y: 0, width: Number(process.env.CW || 836), height: 64 } });
  // report vertical centres of the right-group children
  console.log(await p.evaluate(() => { const r = document.querySelector('[class*="right"]'); const c = document.querySelector('[class*="center"]'); const out = []; for (const g of [c, r]) if (g) for (const el of g.querySelectorAll(':scope > *')) { const b = el.getBoundingClientRect(); out.push(`${(el.className||'').toString().slice(0,40)} top=${b.top.toFixed(1)} h=${b.height.toFixed(1)} mid=${(b.top+b.height/2).toFixed(1)}`); } return out.join('\n'); }));
  await b.close();
})();

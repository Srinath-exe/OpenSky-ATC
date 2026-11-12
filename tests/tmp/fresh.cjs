const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
  p.on('pageerror', (e) => console.log('ERR', e.message)); p.on('console', (m) => { if (m.type() === 'error' || /setup|refused/.test(m.text())) console.log('console', m.text().slice(0, 300)); });
  await p.goto('http://localhost:3007/learn?quality=low', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await p.waitForFunction(() => !!window.__coach && !!window.__atcSim?.engine, null, { timeout: 180000 });
  const r = await p.evaluate(() => {
    const e = window.__atcSim.engine; const out = [];
    for (const id of ['g-stop', 'g-giveway', 'g-cross', 'g-handoff']) {
      window.__coach.open(id, { fresh: true }); window.__coach.begin();
      const a = e.find('DLH455'); out.push(`${id}: ${a ? a.phase + ' ' + Math.round(a.speed) + 'kt d' + Math.round(a.distAlong) + ' hs ' + a.holdShortRunway : 'none'} others ${JSON.stringify((window.__coach.live?.ctx.others ?? []).map((o) => o + ':' + (e.find(o)?.phase ?? 'missing')))}`);
    }
    return out.join('\n');
  });
  console.log(r);
  await b.close();
})();

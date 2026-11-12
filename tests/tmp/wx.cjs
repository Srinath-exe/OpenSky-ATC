const { chromium } = require('playwright');
const OUT = process.env.OUT || '/tmp/claude-0/-root-atc/1c29601f-c5ea-405d-9c01-805c701fe12b/scratchpad/wx';
const SHOTS = JSON.parse(process.env.SHOTS);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => console.log('ERR', e.message)); p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
  await p.goto('http://localhost:3007/map3d?icao=KSFO&quality=high', { timeout: 180000 });
  await p.waitForSelector('[data-testid="world-map"][data-status="ready"]', { timeout: 240000 }); await p.waitForTimeout(3000);
  await p.addStyleTag({ content: '[data-testid="world-toolbar"],[data-testid="world-wind"],[class*="hint"]{display:none!important}' });
  for (const s of SHOTS) {
    await p.evaluate((s) => {
      const e = window.__atcSim.engine; const pts = []; for (const [id, n] of e.air.nodes) for (const ed of n.edges) if (ed.taxiway === 'W') pts.push(e.nodeXY(id));
      const c = { x: pts.reduce((a, q) => a + q.x, 0) / pts.length, y: pts.reduce((a, q) => a + q.y, 0) / pts.length };
      window.__atcSim.centerOnXY(c); window.__worldCam(s.yaw ?? 1.45, s.pitch ?? 0.2, s.dist ?? 900);
      window.__worldWx(s.wx || null); window.__worldLook(s.look || 'standard');
      document.querySelector(`[data-testid="world-time-${s.t || 'day'}"]`).click();
    }, s);
    await p.waitForTimeout(s.wait || 2500);
    await p.screenshot({ path: `${OUT}/${s.n}.jpg`, type: 'jpeg', quality: 85, timeout: 120000 });
    console.log('shot', s.n);
  }
  await b.close();
})();

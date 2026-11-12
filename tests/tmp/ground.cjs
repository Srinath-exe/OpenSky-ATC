// Plays the Ground missions in the real page like a player: each mission's suggested call, through the store's command
// line (with its undo window), the next mission opened from the completion card. Logs where the 747 is at each start.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1400, height: 860 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.addInitScript(() => { try { localStorage.setItem('skycontrol_tutor_v1', '{}'); localStorage.setItem('skycontrol_world_look', 'standard'); } catch {} });
  await p.goto('http://localhost:3007/learn?quality=low', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await p.waitForSelector('[data-testid="page-learn"][data-ready="true"]', { timeout: 180000 });
  await p.waitForFunction(() => !!window.__coach && !!window.__atcSim?.engine, null, { timeout: 120000 });
  const st = () => p.evaluate(() => { const c = window.__coach, e = window.__atcSim.engine, a = e.find('DLH455'); return { ch: c.state.chapter?.id, stage: c.state.stage, met: [...c.state.met], cur: c.current()?.id, say: c.phrase(c.current()), ac: a ? `${a.phase}/${a.pushback.stage} ${Math.round(a.speed)}kt d${Math.round(a.distAlong)}/${a.path ? Math.round(a.path.total) : '-'}` : 'none', others: c.state.chapter ? Object.fromEntries((window.__coach.live?.ctx.others ?? []).map((o) => [o, !!e.find(o)])) : {} }; });
  const ids = ['g-push', 'g-taxi', 'g-stop', 'g-giveway', 'g-cross', 'g-handoff'];
  await p.evaluate(() => window.__coach.open('g-push'));
  for (const id of ids) {
    await p.waitForTimeout(800);
    if ((await st()).stage === 'story') await p.evaluate(() => window.__coach.begin());
    await p.waitForTimeout(1200);
    const s0 = await st(); const t0 = Date.now(); console.log(`\n== ${id} START`, JSON.stringify(s0));
    let lastSay = '';
    while (Date.now() - t0 < 150000) {
      const s = await st();
      if (s.stage === 'done') { console.log(`   done in ${((Date.now() - t0) / 1000).toFixed(0)} s`, s.ac); break; }
      if (s.say && s.say !== lastSay) { lastSay = s.say; console.log(`   ${((Date.now() - t0) / 1000).toFixed(0)}s say: ${s.say}  [${s.ac}]`); await p.evaluate((t) => window.__atcSim.command(t), s.say); }
      await p.waitForTimeout(1000);
    }
    const s1 = await st(); if (s1.stage !== 'done') { console.log('   STUCK', JSON.stringify(s1)); }
    const nx = ids[ids.indexOf(id) + 1]; if (nx) await p.evaluate((i) => window.__coach.open(i), nx);
  }
  await b.close();
})();

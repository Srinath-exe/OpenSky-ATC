const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  await p.goto('http://localhost:3007/map3d?icao=KSFO&quality=high', { timeout: 180000 });
  await p.waitForSelector('[data-testid="world-map"][data-status="ready"]', { timeout: 240000 });
  const variants = ['gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); }', 'gl_FragColor = vec4(vec3(texture2D(tDepth, vUv).x), 1.0); }', 'gl_FragColor = vec4(fract(W.xz / 1000.0), 0.0, 1.0); }'];
  await p.evaluate(() => window.__worldWx({ cloudCover: 0.5 }));
  for (let i = 0; i < variants.length; i++) {
    await p.evaluate((v) => { const m = window.__weatherPass.mat; if (!m.userData.orig) m.userData.orig = m.fragmentShader; const s = m.userData.orig; const k = s.lastIndexOf('gl_FragColor = vec4(c, 1.0);'); m.fragmentShader = s.slice(0, k) + v; m.needsUpdate = true; }, variants[i]);
    await p.waitForTimeout(2500); await p.screenshot({ path: `tests/tmp/dbg${i}.jpg`, type: 'jpeg', quality: 70 });
  }
  await b.close();
})();

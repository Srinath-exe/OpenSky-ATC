// Every report at phone and desktop width, both themes: horizontal overflow and page errors.
const { chromium } = require('playwright');
const pages = ['index', 'ai-paths', 'voice-ai', 'voice-demo', 'voice-stt', 'voice-verifier', 'voice-rl', 'voice-diffusion', 'voice-callsign', 'voice-gold', 'mobile-app'];
(async () => {
  const b = await chromium.launch();
  for (const scheme of ['dark', 'light']) for (const w of [375, 1280]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 800 }, colorScheme: scheme });
    for (const name of pages) {
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(`http://127.0.0.1:3005/reports/${name}.html`, { waitUntil: 'load' });
      const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bg: getComputedStyle(document.body).backgroundColor }));
      if (r.sw > r.cw + 1 || errs.length) console.log(`${scheme} ${w} ${name}: overflow ${r.sw - r.cw}px, errors ${errs.length} ${errs[0] || ''}`);
      await p.close();
    }
    await ctx.close();
  }
  console.log('done'); await b.close();
})();

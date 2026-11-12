// Listening page check (public/reports/voice-tts.html): no horizontal scroll at 375 / 1280 px in light and dark,
// every <audio> has a source that exists, and one clip loads and reports a duration.  node tests/tmp/tts-report-check.cjs
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const file = path.resolve(__dirname, '../../public/reports/voice-tts.html');
  const b = await chromium.launch();
  for (const scheme of ['dark', 'light']) for (const width of [375, 1280]) {
    const p = await b.newPage({ viewport: { width, height: 800 }, colorScheme: scheme });
    const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.goto('file://' + file);
    const r = await p.evaluate(async () => {
      const a = [...document.querySelectorAll('audio')];
      const first = a[0]; first.preload = 'auto'; first.load();
      await new Promise(res => { first.onloadedmetadata = res; setTimeout(res, 4000); });
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, n: a.length, srcs: a.map(x => x.getAttribute('src')), dur: first.duration, bg: getComputedStyle(document.body).backgroundColor };
    });
    const missing = r.srcs.filter(s => !fs.existsSync(path.resolve(path.dirname(file), s)));
    console.log(scheme, width, 'scroll', r.sw, '/', r.cw, 'players', r.n, 'missing', missing.length, 'first dur', r.dur && r.dur.toFixed(2), 'bg', r.bg, 'errors', errs.length);
    await p.close();
  }
  await b.close();
})();

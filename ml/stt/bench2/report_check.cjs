// Layout check for public/reports/voice-stt.html: no horizontal overflow at phone width, no console errors, both themes.
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const [w, scheme] of [[390, 'light'], [390, 'dark'], [1200, 'dark']]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 }, colorScheme: scheme });
    const errs = []; p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto('file://' + path.resolve(__dirname, '../../../public/reports/voice-stt.html'));
    const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.body.scrollHeight,
      wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.scroll')).slice(0, 5).map((e) => e.tagName + '.' + e.className) }));
    console.log(JSON.stringify({ w, scheme, ...r, errs: errs.filter((e) => !/fonts\.g/.test(e)) }));
    await p.close();
  }
  await b.close();
})();

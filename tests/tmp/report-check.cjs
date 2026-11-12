const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const [w, scheme] of [[1280, 'dark'], [390, 'dark'], [390, 'light']]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 }, colorScheme: scheme });
    const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto('http://127.0.0.1:3005/reports/ai-paths.html', { waitUntil: 'networkidle' });
    const r = await p.evaluate(() => {
      const over = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.right > window.innerWidth + 1 && !el.closest('.scroll'); }).slice(0, 5).map(el => el.className || el.tagName);
      return { docW: document.documentElement.scrollWidth, winW: window.innerWidth, h: document.documentElement.scrollHeight, overflow: over, svgs: document.querySelectorAll('svg').length, sections: document.querySelectorAll('section').length };
    });
    console.log(w, scheme, JSON.stringify(r), errs.length ? 'ERR ' + errs.join(' | ') : 'no errors');
    await p.close();
  }
  await b.close();
})();

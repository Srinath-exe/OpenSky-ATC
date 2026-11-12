const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 375, height: 800 } });
  for (const name of process.argv.slice(2)) {
    const p = await ctx.newPage(); await p.goto(`http://127.0.0.1:3005/reports/${name}.html`);
    const r = await p.evaluate(() => { const W = document.documentElement.clientWidth; const out = [];
      for (const el of document.querySelectorAll('body *')) { const rc = el.getBoundingClientRect(); if (rc.right > W + 1 && rc.width > 0) { let par = el.parentElement, inScroll = false; while (par) { const ox = getComputedStyle(par).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { inScroll = true; break; } par = par.parentElement; } if (!inScroll) out.push(`${el.tagName.toLowerCase()}.${(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || ''} right=${Math.round(rc.right)} w=${Math.round(rc.width)} text="${(el.textContent || '').trim().slice(0, 40)}"`); } }
      return out.slice(0, 6); });
    console.log(name); r.forEach((x) => console.log('  ', x)); await p.close();
  }
  await b.close();
})();

// Demo page microphone through our server's Whisper, with a fake mic playing a clip; checks the live-attempt save.
const { chromium } = require('playwright');
const [wav, key] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] });
  const ctx = await b.newContext({ permissions: ['microphone'] }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:3005/reports/voice-demo.html');
  await p.evaluate((k) => localStorage.setItem('atc-gold-key', k), key);
  await p.reload();
  await p.waitForFunction(() => /KV cache/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  await p.selectOption('#eng', 'server');
  const box = await p.locator('#mic').boundingBox();
  await p.mouse.move(box.x + 5, box.y + 5); await p.mouse.down(); await p.waitForTimeout(4500); await p.mouse.up();
  await p.waitForFunction(() => /Server heard|Server:/.test(document.getElementById('heardby').textContent), null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  console.log(JSON.stringify(await p.evaluate(() => ({ heardby: document.getElementById('heardby').innerText, line: document.getElementById('line').textContent, verdict: document.getElementById('verdict').textContent }))));
  console.log('errors', errs);
  await b.close();
})();

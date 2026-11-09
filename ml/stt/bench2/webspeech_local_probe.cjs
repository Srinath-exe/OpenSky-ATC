// Does Chrome's on-device Web Speech (processLocally, needed for `phrases` biasing) exist here? Tries available()/install().
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const CHROME = path.resolve(__dirname, '../../../ml/stt/chrome/root/opt/google/chrome/chrome');
(async () => {
  const server = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><button id=b>x</button>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--use-fake-ui-for-media-stream'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const before = await page.evaluate(async () => { const SR = window.SpeechRecognition || window.webkitSpeechRecognition; try { return await SR.available({ langs: ['en-US'], processLocally: true }); } catch (e) { return 'err ' + e; } });
  console.log('available:', before);
  if (before === 'downloadable') {
    await page.click('#b');
    const inst = await page.evaluate(async () => { const SR = window.SpeechRecognition || window.webkitSpeechRecognition; try { return await SR.install({ langs: ['en-US'], processLocally: true }); } catch (e) { return 'err ' + e; } });
    console.log('install:', inst);
    for (let i = 0; i < 60; i++) {
      const st = await page.evaluate(async () => { const SR = window.SpeechRecognition || window.webkitSpeechRecognition; return SR.available({ langs: ['en-US'], processLocally: true }); });
      if (st !== 'downloading') { console.log('after:', st); break; }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });

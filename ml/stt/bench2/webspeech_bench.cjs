// Web Speech (Google's recogniser in Chrome) on the benchmark clips: Google Chrome (ml/stt/chrome, extracted from the
// official .deb, not installed) under Xvfb; each clip is played into SpeechRecognition.start(MediaStreamTrack).
// The audio goes to Google, as it does for players who pick "Browser".
//   xvfb-run -a node ml/stt/bench2/webspeech_bench.cjs <clipdir> <out.jsonl> [--phrases] [--limit N] [--cond clean,late]
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { loadClips, namesFromCtx } = require('./clips.cjs');
const ROOT = path.resolve(__dirname, '../../..');
const argv = process.argv.slice(2);
const [dir, out] = argv;
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const limit = Number(opt('limit', '100000'));
const conds = opt('cond', '') ? opt('cond').split(',') : null;
const phrases = argv.includes('--phrases');
const CHROME = path.join(ROOT, 'ml/stt/chrome/root/opt/google/chrome/chrome');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/clip/')) { const f = path.join(path.resolve(dir), path.basename(decodeURIComponent(u.pathname.slice(6)))); if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'audio/wav' }); fs.createReadStream(f).pipe(res); return; } }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>webspeech bench</title>');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  const clips = loadClips(dir).filter((c) => !conds || conds.includes(c.cond)).slice(0, limit);
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).wav) : []);
  const fd = fs.openSync(out, 'a');
  for (const c of clips) {
    if (done.has(c.wav)) continue;
    const r = await page.evaluate(async ([url, names, usePhrases]) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const ac = new AudioContext();
      const buf = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const dst = ac.createMediaStreamDestination();
      const src = ac.createBufferSource(); src.buffer = buf;
      // a little silence after the clip, as a player holds the key a moment
      src.connect(dst);
      const sr = new SR(); sr.lang = 'en-US'; sr.continuous = true; sr.interimResults = false; sr.maxAlternatives = 5;
      let phraseErr = null;
      if (usePhrases && window.SpeechRecognitionPhrase) {
        try { sr.phrases = [...names.map((n) => new SpeechRecognitionPhrase(n, 5)), ...['flight level', 'heading', 'descend and maintain', 'climb and maintain', 'cleared to land', 'cleared for takeoff', 'contact tower', 'niner'].map((p) => new SpeechRecognitionPhrase(p, 2))]; } catch (e) { phraseErr = String(e); }
      }
      const finals = []; let err = null;
      const t0 = performance.now(); let tEnd = 0;
      const done = new Promise((res) => { sr.onend = () => res(); });
      sr.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) finals[i] = Array.from({ length: e.results[i].length }, (_, k) => e.results[i][k].transcript.trim()); };
      sr.onerror = (e) => { err = e.error; };
      try { sr.start(dst.stream.getAudioTracks()[0]); } catch (e) { return { error: 'start: ' + String(e) }; }
      await new Promise((r) => setTimeout(r, 150));
      src.start();
      await new Promise((r) => { src.onended = r; });
      tEnd = performance.now();
      await new Promise((r) => setTimeout(r, 300));   // the release tail
      sr.stop();
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      const n = Math.max(1, ...finals.filter(Boolean).map((a) => a.length));
      const alts = [...new Set(Array.from({ length: n }, (_, k) => finals.filter(Boolean).map((a) => a[k] ?? a[0]).join(' ').trim()).filter(Boolean))];
      void ac.close();
      return { heard: alts[0] || '', alts, ms: Math.round(performance.now() - tEnd - 300), error: err, phraseErr };
    }, [`${base}/clip/${encodeURIComponent(c.wav)}`, namesFromCtx(c.ctx), phrases]);
    fs.writeSync(fd, JSON.stringify({ wav: c.wav, ...r }) + '\n');
    if (r.error && /network|not-allowed|service-not-allowed|language/.test(String(r.error))) { console.error('stopping:', r.error); break; }
  }
  fs.closeSync(fd);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });

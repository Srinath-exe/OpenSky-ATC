// End-to-end check of the game's recognisers in Google Chrome (Xvfb) with a WAV as the microphone:
//   browser  src/lib/voice/recognizer.ts createBrowserRecognizer (Web Speech, delay-line pre-roll, n-best)
//   server   src/lib/voice/asr-server.ts createServerRecognizer -> POST /api/voice/stt -> handler.ts + engine.ts (real model)
//   local    createLocalRecognizer -> public/voice/stt-worker.js
// The recogniser modules are compiled to ES modules in .tmp/stt-web; a local HTTP server stands in for Next.
//   xvfb-run -a node ml/stt/bench2/recognizer_e2e.cjs <clip.wav> browser|browser+server|server|local [names...]
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../../..');
const [wav, engine = 'browser', ...names] = process.argv.slice(2);
const WEB = path.join(ROOT, '.tmp/stt-web');
execSync(`npx tsc src/lib/voice/recognizer.ts src/lib/voice/asr-server.ts --module es2020 --target es2020 --lib es2022,dom --outDir ${WEB} --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0`, { cwd: ROOT, stdio: 'inherit' });
for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.js'))) fs.writeFileSync(path.join(WEB, f), fs.readFileSync(path.join(WEB, f), 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"));
const { handleStt, RateLimiter, Gate } = require(path.join(ROOT, '.tmp/stt/src/app/api/voice/stt/handler.js'));
const { transcribe } = require(path.join(ROOT, '.tmp/stt/src/app/api/voice/stt/engine.js'));
const deps = { limiter: new RateLimiter(), gate: new Gate(1), transcribe: (a, n, alts) => transcribe(a, { names: n, alternatives: alts }) };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/voice/stt') {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handleStt(new Request('http://x/api/voice/stt', { method: 'POST', body: Buffer.concat(chunks), headers: req.headers }), deps);
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); return;
  }
  const f = u.pathname.startsWith('/web/') ? path.join(WEB, path.basename(u.pathname)) : path.join(ROOT, 'public', path.normalize(u.pathname));
  if (u.pathname !== '/' && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); fs.createReadStream(f).pipe(res); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>e2e</title><button id=b>ptt</button>');
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sec = (fs.statSync(wav).size - 44) / 32000;
  const browser = await chromium.launch({ executablePath: path.join(ROOT, 'ml/stt/chrome/root/opt/google/chrome/chrome'), headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(wav)}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('console', (m) => console.error('page:', m.text()));
  await page.goto(`${base}/`);
  await page.click('#b');
  const r = await page.evaluate(async ([engine, names, sec]) => {
    const srv = await import('/web/asr-server.js'), rcg = await import('/web/recognizer.js');
    const rec = engine === 'server' ? srv.createServerRecognizer() : engine === 'local' ? rcg.createLocalRecognizer(undefined, 'base')
      : engine === 'browser+server' ? srv.withServerSecondOpinion(rcg.createBrowserRecognizer()) : rcg.createBrowserRecognizer();
    const partials = []; const errors = [];
    rec.onPartial = (t) => partials.push(t); rec.onError = (m) => errors.push(m);
    rec.setHints?.(names);
    if (engine === 'local') await new Promise((r) => setTimeout(r, 25000));   // model download + warm-up
    const t0 = performance.now();
    rec.start();
    await new Promise((r) => setTimeout(r, sec * 1000 + 400));
    const tRel = performance.now();
    const text = await rec.stop();
    const second = rec.secondOpinion ? await rec.secondOpinion() : null;
    return { text, alternatives: rec.alternatives, second, partials: partials.slice(-4), errors, releaseToTextMs: Math.round(performance.now() - tRel), heldMs: Math.round(tRel - t0) };
  }, [engine, names, sec]);
  console.log(JSON.stringify({ engine, wav: path.basename(wav), ...r }));
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });

// The game's neural pilot voice path in headless Chromium: bundles src/components/atc/pilotVoice.ts (normaliser, voice
// choice, worker, queue, radio chain) with esbuild into a test page served next to public/, then sends engine-style
// pilot lines (codes and all) the way sound.speak() does: five lines at once to exercise drop / shorten, then lines
// spaced like real traffic. Reports time to first audio per line, dropped lines and page errors.
//   node tests/tmp/tts-game-voice.cjs        (writes ml/tts/out/game_voice.json)
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
(async () => {
  const entry = `
    import { NeuralPilotVoice } from '${ROOT}/src/components/atc/pilotVoice';
    window.runVoice = async (burst, spaced) => {
      const ctx = new AudioContext(); await ctx.resume();
      const out = ctx.createGain(); out.connect(ctx.destination);
      const v = new NeuralPilotVoice(() => ({ ctx, out }));
      const t0 = performance.now();
      const ok = await v.load();
      const loadMs = performance.now() - t0;
      if (!ok) return { ok, error: v.error };
      for (const [t, cs, vr] of burst) v.say(t, cs, vr);
      await new Promise(r => setTimeout(r, 15000));
      for (const [t, cs, vr] of spaced) { v.say(t, cs, vr); await new Promise(r => setTimeout(r, 6000)); }
      await new Promise(r => setTimeout(r, 4000));
      return { ok, loadMs: Math.round(loadMs), state: v.state, stats: v.stats, ctxTime: ctx.currentTime };
    };`;
  const r = await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2020' });
  const js = r.outputFiles[0].text;
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><script>${js}</script>`); }
    const f = path.join(ROOT, 'public', u);
    if (!f.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : /\.json$/.test(f) ? 'application/json' : 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  const burst = [
    ['Descend flight level seven zero, Speedbird four zero.', 'BAW40', 'ICAO'],
    ['JBU248 holding short runway 04L', 'JBU248', 'FAA'],
    ['Radar contact, altimeter three zero two one, ILS zero six left, Qantas eight eighty.', 'QFA880', 'FAA'],
    ['DLH153 contact Heathrow Tower 118.500', 'DLH153', 'ICAO'],
    ['Cleared to land runway two seven left, Shamrock seven two.', 'EIN72', 'ICAO'],
  ];
  const spaced = [
    ['Heathrow Ground, Sky Dubai two niner fife, stand fife four fife Lima, request pushback, information Alpha.', 'FDB295', 'ICAO'],
    ['UAE761 climbing FL120 heading 275', 'UAE761', 'ICAO'],
    ['Right heading one niner zero, Speedbird two four eight.', 'BAW248', 'ICAO'],
  ];
  const res = await p.evaluate(([a, bb]) => window.runVoice(a, bb), [burst, spaced]);
  res.errors = errors; res.load_avg = require('os').loadavg().map(x => +x.toFixed(1));
  fs.writeFileSync(path.join(ROOT, 'ml/tts/out/game_voice.json'), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  await b.close(); server.close();
  process.exit(errors.length || !res.ok ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

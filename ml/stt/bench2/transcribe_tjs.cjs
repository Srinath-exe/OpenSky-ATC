// Transcribe a clip set with the server engine (src/app/api/voice/stt/engine.ts, transformers.js on onnxruntime-node).
// The same ONNX files the browser downloads, so accuracy carries over to the on-device engines (latency does not:
// see browser_latency.cjs).
//   npx tsc ... (ml/stt/bench2/run.sh compiles the engine to .tmp/stt)
//   node ml/stt/bench2/transcribe_tjs.cjs <clipdir> <out.jsonl> --model whisper-base.en [--enc fp32 --dec q8] [--prompt none|names|phrases] [--alts] [--cond clean,late] [--limit N]
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const { transcribe, sttConfig, loadEngine } = require(path.join(ROOT, '.tmp/stt/src/app/api/voice/stt/engine.js'));
const { loadClips, readWav, namesFromCtx } = require('./clips.cjs');

const argv = process.argv.slice(2);
const [dir, out] = argv;
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const has = (k) => argv.includes(`--${k}`);
const config = { ...sttConfig(), model: opt('model', 'whisper-base.en'), encoder: opt('enc', 'fp32'), decoder: opt('dec', 'q8'), threads: Number(opt('threads', '2')) };
const prompt = opt('prompt', config.model.startsWith('moonshine') ? 'none' : 'phrases');
const conds = opt('cond', '') ? opt('cond').split(',') : null;
const limit = Number(opt('limit', '0')) || Infinity;
const every = Number(opt('every', '1'));   // --every 2: utterances with an even id only (the common subset of the slow engines)

(async () => {
  let clips = loadClips(dir).filter((c) => (!conds || conds.includes(c.cond)) && (every <= 1 || !c.id || Number(c.id) % every === 0));
  if (Number.isFinite(limit)) clips = clips.slice(0, limit);
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).wav) : []);
  const t0 = Date.now();
  const e = await loadEngine(config);
  console.error(JSON.stringify({ model: config.model, enc: config.encoder, dec: config.decoder, prompt, loadMs: e.loadMs, clips: clips.length, done: done.size }));
  const fd = fs.openSync(out, 'a');
  let n = 0;
  for (const c of clips) {
    if (done.has(c.wav)) continue;
    const audio = readWav(c.path);
    const r = await transcribe(audio, { names: namesFromCtx(c.ctx), alternatives: has('alts'), prompt, config });
    fs.writeSync(fd, JSON.stringify({ wav: c.wav, heard: r.text, alts: r.alternatives, decodes: r.decodes, ms: r.ms, sec: +(audio.length / 16000).toFixed(2) }) + '\n');
    if (++n % 50 === 0) console.error(JSON.stringify({ n, elapsed_s: Math.round((Date.now() - t0) / 1000) }));
  }
  fs.closeSync(fd);
  console.error(JSON.stringify({ finished: n, elapsed_s: Math.round((Date.now() - t0) / 1000) }));
})().catch((err) => { console.error(err); process.exit(1); });

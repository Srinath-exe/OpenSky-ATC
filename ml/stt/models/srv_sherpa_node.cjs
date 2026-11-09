// The sherpa-onnx engines inside Node (sherpa-onnx-node, prebuilt addon; no Python): same model, same hotwords as
// srv_run.py, to show the server could run it in-process and what it costs there (ml/stt/models/SERVER.md).
//   NODE_PATH=<dir with node_modules> node ml/stt/models/srv_sherpa_node.cjs <modeldir> <clipdir> <out.jsonl> [--every 2] [--limit N] [--threads 3] [--score 1.5] [--greedy]
const fs = require('fs');
const path = require('path');
const sherpa = require('sherpa-onnx-node');
const { loadClips, readWav, namesFromCtx } = require('../bench2/clips.cjs');

const argv = process.argv.slice(2);
const [mdir, dir, out] = argv;
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const every = Number(opt('every', '2')), limit = Number(opt('limit', '0')) || Infinity, threads = Number(opt('threads', '3'));
const greedy = argv.includes('--greedy');
const f = (pre) => path.join(mdir, fs.readdirSync(mdir).sort().find((x) => x.startsWith(pre) && x.endsWith('.onnx')));
const hwFile = path.join(mdir, 'hotwords.srv.txt'), vocab = path.join(mdir, 'bpe.vocab.srv');   // written by srv_run.py
const config = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: f('encoder'), decoder: f('decoder'), joiner: f('joiner') }, tokens: path.join(mdir, 'tokens.txt'),
    numThreads: threads, provider: 'cpu', modelType: 'nemo_transducer', ...(greedy ? {} : { modelingUnit: 'bpe', bpeVocab: vocab }) },
  decodingMethod: greedy ? 'greedy_search' : 'modified_beam_search', maxActivePaths: 4,
  ...(greedy ? {} : { hotwordsFile: hwFile, hotwordsScore: Number(opt('score', '1.5')) }),
};
const hotwords = (ctx) => {
  const seen = [];
  for (const n of namesFromCtx(ctx)) { const w = n.split(' ').filter((t) => !/^\d+$/.test(t)).join(' ').trim(); if (w && !seen.includes(w)) seen.push(w); }
  const title = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return seen.slice(0, 25).flatMap((w) => [...new Set([w.toLowerCase(), title(w)])]).join('/');
};
const t0 = Date.now();
const rec = new sherpa.OfflineRecognizer(config);
const loadMs = Date.now() - t0;
let clips = loadClips(dir).filter((c) => every <= 1 || !c.id || Number(c.id) % every === 0);
if (Number.isFinite(limit)) clips = clips.slice(0, limit);
const decode = (audio, hw) => {
  const s = hw ? rec.createStream(hw) : rec.createStream();
  s.acceptWaveform({ samples: audio, sampleRate: 16000 });
  rec.decode(s);
  return rec.getResult(s).text.trim();
};
decode(readWav(clips[0].path), null);   // warm-up
const fd = fs.openSync(out, 'w');
for (const c of clips) {
  const audio = readWav(c.path);
  const hw = greedy ? null : hotwords(c.ctx);
  let t = process.hrtime.bigint(); const a = decode(audio, hw); const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const row = { wav: c.wav, heard: a, alts: a ? [a] : [], decodes: [a], ms: Math.round(ms), sec: +(audio.length / 16000).toFixed(2) };
  if (hw) {
    t = process.hrtime.bigint(); const b = decode(audio, null); const msB = Number(process.hrtime.bigint() - t) / 1e6;
    Object.assign(row, { alts: [a, b].filter((x, i, arr) => x && arr.indexOf(x) === i), decodes: [a, b], ms_plain: Math.round(msB) });
  }
  fs.writeSync(fd, JSON.stringify(row) + '\n');
}
fs.closeSync(fd);
const meta = { engine: 'sherpa-onnx-node', model: path.basename(mdir), threads, loadMs, clips: clips.length, rssMb: Math.round(process.memoryUsage().rss / 1048576), elapsedS: Math.round((Date.now() - t0) / 1000) };
fs.writeFileSync(out + '.run.json', JSON.stringify(meta));
console.error(JSON.stringify(meta));

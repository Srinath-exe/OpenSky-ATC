// Neural pilot voice worker (ml/tts/RESULTS.md): Paradee-8M v1.2 (int8 ONNX, 8.5 MB, four voices) on onnxruntime-web
// (WASM, single thread unless the page is cross-origin isolated). Text arrives already through the ATC normaliser
// (src/lib/tts/pilotSpeech.ts), one sentence per message; G2P is public/voice/tts-g2p.js (misaki lexicon + eSpeak).
//   in:  {type:'load', id, model?} | {type:'speak', id, text, voice, speed} | {type:'cancel', id}
//        model 'fp32' loads paradee.onnx (35 MB; not deployed, for tests/tmp/tts-worker.cjs); default the int8 file
//   out: {type:'ready', id, ms, threads, warmMs} | {type:'audio', id, pcm (Float32Array, transferred), sr, ms, g2pMs, phonemes}
//        {type:'cancelled', id} | {type:'error', id, message}
// Messages run in order; a speak whose id was cancelled before its turn is skipped. Nothing downloads before 'load'.
import { AtcG2P } from './tts-g2p.js';

const ORT_VER = '1.30.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
const MODEL_DIR = '/models/tts/paradee-8m-v1.2/';
const LEXICON = '/models/tts/atc-lexicon-v1.json';
const PHONEMIZER = 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js';
const MAX_PHONEMES = 510;

let ort = null, session = null, vocab = null, voices = null, g2p = null, loading = null;
const cancelled = new Set();
let chain = Promise.resolve();

async function getBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function load(variant) {
  const t0 = performance.now();
  ort = await import(`${ORT_BASE}ort.wasm.min.mjs`);
  ort.env.wasm.wasmPaths = ORT_BASE;
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.wasm.numThreads = threads;
  const [model, cfg, lex] = await Promise.all([
    getBytes(MODEL_DIR + (variant === 'fp32' ? 'paradee.onnx' : 'paradee_int8.onnx')),
    fetch(MODEL_DIR + 'config.json').then((r) => { if (!r.ok) throw new Error(`config.json: HTTP ${r.status}`); return r.json(); }),
    fetch(LEXICON).then((r) => { if (!r.ok) throw new Error(`lexicon: HTTP ${r.status}`); return r.json(); }),
  ]);
  vocab = cfg.vocab; voices = cfg.voices;
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  g2p = new AtcG2P(lex, async () => (await import(PHONEMIZER)).phonemize);
  // warm-up: ORT's first run allocates and compiles (~150 ms more than later runs); pay it here, not on the first
  // pilot line. Lexicon words only, so it never fetches eSpeak. A failure here does not fail the load.
  const w0 = performance.now();
  try { await speak({ text: 'Roger, wilco.', voice: voices[0], speed: 1 }); } catch { /* the first real line pays it */ }
  return { ms: Math.round(performance.now() - t0), threads, warmMs: Math.round(performance.now() - w0) };
}

async function speak(m) {
  const t0 = performance.now();
  const british = String(m.voice).startsWith('b');
  const phonemes = await g2p.phonemize(String(m.text || ''), british);
  const t1 = performance.now();
  const ids = [0];
  for (const ch of phonemes) { const v = vocab[ch]; if (v != null) ids.push(v); if (ids.length > MAX_PHONEMES) break; }
  ids.push(0);
  if (ids.length <= 2) return { pcm: new Float32Array(0), g2pMs: t1 - t0, ms: 0, phonemes };
  const vi = Math.max(0, voices.indexOf(m.voice));
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]),
    speed: new ort.Tensor('float32', Float32Array.of(Math.max(0.6, Math.min(1.6, Number(m.speed) || 1))), [1]),
    voice: new ort.Tensor('int64', BigInt64Array.of(BigInt(vi)), [1]),
  };
  const out = await session.run(feeds);
  const wav = out.waveform ?? out[session.outputNames[0]];
  const pcm = new Float32Array(wav.data);        // copy: the tensor's buffer belongs to the session
  return { pcm, g2pMs: t1 - t0, ms: performance.now() - t1, phonemes };
}

function handle(m) {
  if (m.type === 'load') {
    loading = loading || load(m.model).catch((err) => { loading = null; throw err; });   // a failed load can be retried
    return loading.then((r) => postMessage({ type: 'ready', id: m.id, ...r }));
  }
  if (m.type === 'speak') {
    if (cancelled.delete(m.id)) { postMessage({ type: 'cancelled', id: m.id }); return; }
    return (loading || Promise.reject(new Error('not loaded'))).then(() => speak(m)).then((r) => {
      postMessage({ type: 'audio', id: m.id, pcm: r.pcm, sr: 24000, ms: Math.round(r.ms), g2pMs: Math.round(r.g2pMs * 10) / 10, phonemes: r.phonemes }, [r.pcm.buffer]);
    });
  }
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'cancel') { if (cancelled.size > 256) cancelled.clear(); cancelled.add(m.id); return; }
  chain = chain.then(() => handle(m)).catch((err) => {
    postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  });
};

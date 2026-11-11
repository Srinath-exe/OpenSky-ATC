// On-device speech-to-text worker (docs/spec/11-VOICE-MODEL.md §2.1, ml/stt/RESULTS2.md, ml/stt/models/EDGE.md).
// The model downloads once and is cached by the browser; audio never leaves the device.
//   ?model=whistle (Cactus-Compute/whistle, Apache-2.0: 16.9 MB weights + the Cactus engine as WebAssembly, 1.3 MB;
//     biased with the airline names on frequency by the engine's keyword search)
//   | tiny | base (Moonshine through transformers.js, MIT; default base)
//   | whisper-tiny.en | whisper-base.en (Whisper through transformers.js, MIT; biased with the callsigns on frequency as a
//     text prompt, the same as the server engine src/app/api/voice/stt/engine.ts)
//   &dtype=q8|fp32|q4 (transformers.js WASM weights) &device=wasm (force) &alts=1 (Whistle: a second decode without keywords)
//   in:  { type: 'load' } | { type: 'transcribe', id, audio: Float32Array (16 kHz mono), names?: string[] }
//   out: { type: 'progress', file, loaded, total } | { type: 'ready', device, ms } | { type: 'result', id, text, alternatives, ms } | { type: 'error', id?, message }
const TJS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
// pinned revisions: the engine release 4.1.0 and the weights the cactus-compute 4.1.0 Python package uses (same bytes as
// the benchmark, ml/stt/bench2/edge_cactus.py)
const CACTUS_WASM = 'https://huggingface.co/Cactus-Compute/cactus/resolve/4e822c9036be2eb0e47ef556df32a818bb1572ef/releases/4.1.0/wasm/';
const WHISTLE_CACT = 'https://huggingface.co/Cactus-Compute/whistle/resolve/741118687e1f008f06d1351a402a731274789790/whistle.cact';

const Q = new URLSearchParams(self.location.search);
const NAME = Q.get('model') || 'base';
const WHISTLE = NAME === 'whistle';
const WHISPER = NAME.startsWith('whisper');
// model=atc-<name>: a model this site hosts at /models/stt/<name>/ (the onnx-community layout; ml/stt/train_moonshine.py export)
const OURS = NAME.startsWith('atc-') ? NAME.slice(4).replace(/[^a-z0-9._-]/gi, '') : '';
const MODEL = OURS || (WHISPER ? `onnx-community/${NAME}` : `onnx-community/moonshine-${NAME === 'tiny' ? 'tiny' : 'base'}-ONNX`);
const WASM_DTYPE = Q.get('dtype') || 'q8';
const SECOND = Q.get('alts') === '1';   // Whistle: also decode without keywords (doubles the time; names-only keywords + this second guess scored below one decode with the ATC words)
let T = null;        // transformers.js, imported only for the engines that use it
let asr = null;      // Moonshine: the pipeline. Whisper: { processor, tokenizer, model, ids }. Whistle: the Cactus module
let loading = null;
let device = 'wasm';
const progress = (file, loaded, total) => postMessage({ type: 'progress', file, loaded, total });

async function tjs() {
  if (!T) {
    T = await import(TJS_URL);
    // our models are fetched like hub models, from this site: /models/stt/<name>/<file> (the local-model path skips the processor files)
    if (OURS) { T.env.allowLocalModels = false; T.env.remoteHost = new URL('/models/stt/', self.location.origin).href; T.env.remotePathTemplate = '{model}/'; }
    else T.env.allowLocalModels = false;
  }
  return T;
}

async function loadWhisper(dev, dtype, progress_callback) {
  const { AutoProcessor, AutoTokenizer, AutoModelForSpeechSeq2Seq } = await tjs();
  const [processor, tokenizer, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL, { progress_callback }),
    AutoTokenizer.from_pretrained(MODEL, { progress_callback }),
    AutoModelForSpeechSeq2Seq.from_pretrained(MODEL, { device: dev, dtype, progress_callback }),
  ]);
  const id = (s) => Number(tokenizer.encode(s, { add_special_tokens: false })[0]);
  if (!model.forward_params.includes('encoder_outputs')) model.forward_params = [...model.forward_params, 'encoder_outputs'];
  return { processor, tokenizer, model, ids: { prev: id('<|startofprev|>'), sot: id('<|startoftranscript|>'), nots: id('<|notimestamps|>') } };
}

/** GET with download progress, kept in the Cache API so the next visit downloads nothing (works without it too). */
async function fetchCached(url, file) {
  let cache = null;
  try {
    cache = await caches.open('openatc-stt-v1');
    const hit = await cache.match(url);
    if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); progress(file, b.length, b.length); return b; }
  } catch { cache = null; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const parts = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    progress(file, loaded, Math.max(total, loaded));
  }
  const bytes = new Uint8Array(loaded);
  let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  try { await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* quota: fine */ }
  return bytes;
}

/** Whistle: the Cactus engine (Emscripten, single-threaded WASM with SIMD) and the .cact weights. */
async function loadWhistle() {
  const [js, wasm, cact] = await Promise.all([fetchCached(CACTUS_WASM + 'cactus.js', 'cactus.js'), fetchCached(CACTUS_WASM + 'cactus.wasm', 'cactus.wasm'), fetchCached(WHISTLE_CACT, 'whistle.cact')]);
  // cactus.js is a classic script that defines `createCactus`; a module worker imports it through a blob URL
  const url = URL.createObjectURL(new Blob([new TextDecoder().decode(js), '\nexport default createCactus;\n'], { type: 'text/javascript' }));
  const createCactus = (await import(url)).default;
  URL.revokeObjectURL(url);
  const M = await createCactus({ wasmBinary: wasm });
  const p = M._malloc(cact.length);
  M.HEAPU8.set(cact, p);
  // unsigned long long size: a BigInt when the build passes i64 natively, else (lo, hi)
  const rc = M._cactus_load.length >= 3 ? M._cactus_load(p, cact.length, 0) : M._cactus_load(p, BigInt(cact.length));
  M._free(p);   // the engine keeps its own copy
  if (rc < 0) throw new Error(`whistle: ${M.ccall('cactus_last_error', 'string', [], [])}`);
  return M;
}

/** -> the engine's JSON ({ text, language, ttft_ms, decode_tps }). keywords: phrases the beam search is biased towards. */
function whistleRun(audio, keywords) {
  const M = asr;
  const n = audio.length;
  const cap = Math.max(1 << 16, Math.ceil(n / 16000) * 4096);
  const pcm = M._malloc(n * 4), out = M._malloc(cap);
  try {
    new Float32Array(M.HEAPU8.buffer, pcm, n).set(audio);
    const rc = M.ccall('cactus_transcribe', 'number', ['number', 'number', 'string', 'string', 'number', 'number', 'number'],
      [pcm, n, 'en', keywords.length ? keywords.join('\n') : null, 0, out, cap]);
    if (rc < 0) throw new Error(`whistle: ${M.ccall('cactus_last_error', 'string', [], [])}`);
    const b = M.HEAPU8.subarray(out, out + cap), end = b.indexOf(0);
    return JSON.parse(new TextDecoder().decode(b.slice(0, end < 0 ? cap : end)));
  } finally { M._free(pcm); M._free(out); }
}

async function load() {
  // `loading` resolves only after the warm-up run, so no transcription starts while the warm-up uses the session
  if (loading) return loading;
  loading = (async () => {
    const t0 = performance.now();
    if (WHISTLE) {
      asr = await loadWhistle();
      device = 'wasm';
    } else {
      const progress_callback = (p) => { if (p.status === 'progress') progress(p.file, p.loaded, p.total); };
      const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(await navigator.gpu.requestAdapter().catch(() => null));
      const make = async (dev, dtype) => WHISPER ? loadWhisper(dev, dtype, progress_callback) : (await tjs()).pipeline('automatic-speech-recognition', MODEL, { device: dev, dtype, progress_callback });
      try {
        if (!hasGpu || Q.get('device') === 'wasm') throw new Error('no WebGPU');
        asr = await make('webgpu', { encoder_model: 'fp32', decoder_model_merged: 'q4' });
        device = 'webgpu';
      } catch {
        asr = await make('wasm', WASM_DTYPE);
        device = 'wasm';
      }
    }
    // warm-up: the first run compiles kernels; do it before the player's first transmission
    await transcribe(new Float32Array(16000), []);
    postMessage({ type: 'ready', device, ms: Math.round(performance.now() - t0) });
    return asr;
  })();
  // a failed load is not cached: the next push-to-talk tries again
  loading.catch(() => { loading = null; });
  return loading;
}

const HALLUCINATION = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|\[.*\]|\(.*\))$/i;
const clean = (s) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return HALLUCINATION.test(x) ? '' : x; };
const title = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
function buildPrompt(names) {
  const list = [...new Set((names || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean))].slice(0, 24).map(title);
  return list.length ? `Air traffic control. ${list.join(', ')}. Climb, descend and maintain flight level, turn left heading, reduce speed, cleared to land, contact tower.` : '';
}
/** Whistle keywords: the airline telephony on frequency without the flight numbers ("speedbird 50" -> "speedbird"),
 *  then the ATC command words (with them: exact command 61.6 -> 64.4% US/UK, 61.9 -> 66.9% Indian proxy, one decode;
 *  ml/stt/models/EDGE.md). */
const ATC_WORDS = ['flight level', 'heading', 'climb', 'descend', 'maintain', 'reduce speed', 'increase speed', 'knots',
  'cleared to land', 'cleared for takeoff', 'line up and wait', 'hold short', 'runway', 'taxi', 'contact', 'tower', 'approach',
  'departure', 'ground', 'direct', 'ILS', 'localizer', 'niner', 'go around', 'squawk'];
function keywordsFrom(names) {
  const airlines = [...new Set((names || []).map((n) => String(n).toLowerCase().replace(/[\d\s]+$/, '').trim()).filter(Boolean))].slice(0, 40);
  return [...airlines, ...ATC_WORDS];
}

/** -> { text, alternatives } (Whisper: with the callsign prompt, then without it, sharing one encoder pass;
 *  Whistle: one decode biased towards the airline names and ATC words). */
async function transcribe(audio, names) {
  if (WHISTLE) {
    const kw = keywordsFrom(names);
    const alts = [clean(whistleRun(audio, kw).text)];
    if (SECOND && audio.length > 16000 * 0.5) alts.push(clean(whistleRun(audio, []).text));
    const uniq = [...new Set(alts.filter(Boolean))];
    return { text: uniq[0] || '', alternatives: uniq };
  }
  if (!WHISPER) { const out = await asr(audio, { max_new_tokens: Math.min(96, Math.ceil(audio.length / 16000) * 8 + 8) }); const t = clean(out && out.text); return { text: t, alternatives: t ? [t] : [] }; }
  const { processor, tokenizer, model, ids } = asr;
  const { input_features } = await processor(audio);
  const { encoder_outputs } = await model._prepare_encoder_decoder_kwargs_for_generation({ inputs_tensor: input_features, model_inputs: { input_features }, model_input_name: 'input_features', generation_config: model.generation_config });
  const decode = async (prompt) => {
    const p = prompt ? tokenizer.encode(` ${prompt}`, { add_special_tokens: false }).slice(-200) : [];
    const init = p.length ? [ids.prev, ...p, ids.sot, ids.nots] : [ids.sot, ids.nots];
    const out = await model.generate({ inputs: input_features, encoder_outputs, decoder_input_ids: init, max_new_tokens: 64 });
    const text = clean(tokenizer.decode(out.tolist()[0].map(Number).slice(init.length), { skip_special_tokens: true }));
    return prompt && text && prompt.toLowerCase().includes(text.toLowerCase()) && text.split(' ').length > 3 ? '' : text;
  };
  const prompt = buildPrompt(names);
  const alts = [await decode(prompt)];
  if (prompt) alts.push(await decode(''));
  const uniq = [...new Set(alts.filter(Boolean))];
  return { text: uniq[0] || '', alternatives: uniq };
}

let queue = Promise.resolve();
self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') { await load(); return; }
    if (m.type === 'transcribe') {
      await load();
      // one inference session: transcriptions run one after another (two quick transmissions never overlap)
      const run = queue.then(async () => {
        const t0 = performance.now();
        const r = await transcribe(m.audio, m.names);
        postMessage({ type: 'result', id: m.id, text: r.text, alternatives: r.alternatives, ms: Math.round(performance.now() - t0), device });
      });
      queue = run.catch(() => undefined);
      await run;
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
};

// On-device speech-to-text worker (docs/spec/11-VOICE-MODEL.md §2.1, ml/stt/RESULTS2.md).
// transformers.js on WebGPU, falling back to WASM; the model downloads once and is cached by the browser; audio never
// leaves the device.
//   ?model=tiny|base (Moonshine, MIT; default base) | whisper-tiny.en | whisper-base.en (Whisper, MIT; biased with the
//   callsigns on frequency as a text prompt, the same as the server engine src/app/api/voice/stt/engine.ts)
//   &dtype=q8|fp32|q4 (WASM weights) &device=wasm (force)
//   in:  { type: 'load' } | { type: 'transcribe', id, audio: Float32Array (16 kHz mono), names?: string[] }
//   out: { type: 'progress', file, loaded, total } | { type: 'ready', device, ms } | { type: 'result', id, text, alternatives, ms } | { type: 'error', id?, message }
import { pipeline, env, AutoProcessor, AutoTokenizer, AutoModelForSpeechSeq2Seq } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

const Q = new URLSearchParams(self.location.search);
const NAME = Q.get('model') || 'base';
const WHISPER = NAME.startsWith('whisper');
const MODEL = WHISPER ? `onnx-community/${NAME}` : `onnx-community/moonshine-${NAME === 'tiny' ? 'tiny' : 'base'}-ONNX`;
const WASM_DTYPE = Q.get('dtype') || 'q8';
env.allowLocalModels = false;
let asr = null;      // Moonshine: the pipeline. Whisper: { processor, tokenizer, model, ids }
let loading = null;
let device = 'wasm';

async function loadWhisper(dev, dtype, progress_callback) {
  const [processor, tokenizer, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL, { progress_callback }),
    AutoTokenizer.from_pretrained(MODEL, { progress_callback }),
    AutoModelForSpeechSeq2Seq.from_pretrained(MODEL, { device: dev, dtype, progress_callback }),
  ]);
  const id = (s) => Number(tokenizer.encode(s, { add_special_tokens: false })[0]);
  if (!model.forward_params.includes('encoder_outputs')) model.forward_params = [...model.forward_params, 'encoder_outputs'];
  return { processor, tokenizer, model, ids: { prev: id('<|startofprev|>'), sot: id('<|startoftranscript|>'), nots: id('<|notimestamps|>') } };
}

async function load() {
  // `loading` resolves only after the warm-up run, so no transcription starts while the warm-up uses the session
  if (loading) return loading;
  loading = (async () => {
    const t0 = performance.now();
    const progress_callback = (p) => { if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); };
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(await navigator.gpu.requestAdapter().catch(() => null));
    const make = (dev, dtype) => WHISPER ? loadWhisper(dev, dtype, progress_callback) : pipeline('automatic-speech-recognition', MODEL, { device: dev, dtype, progress_callback });
    try {
      if (!hasGpu || Q.get('device') === 'wasm') throw new Error('no WebGPU');
      asr = await make('webgpu', { encoder_model: 'fp32', decoder_model_merged: 'q4' });
      device = 'webgpu';
    } catch {
      asr = await make('wasm', WASM_DTYPE);
      device = 'wasm';
    }
    // warm-up: the first run compiles kernels; do it before the player's first transmission
    await transcribe(new Float32Array(16000), []);
    postMessage({ type: 'ready', device, ms: Math.round(performance.now() - t0) });
    return asr;
  })();
  return loading;
}

const HALLUCINATION = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|\[.*\]|\(.*\))$/i;
const clean = (s) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return HALLUCINATION.test(x) ? '' : x; };
const title = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
function buildPrompt(names) {
  const list = [...new Set((names || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean))].slice(0, 24).map(title);
  return list.length ? `Air traffic control. ${list.join(', ')}. Climb, descend and maintain flight level, turn left heading, reduce speed, cleared to land runway, contact tower.` : '';
}

/** -> { text, alternatives } (Whisper: with the callsign prompt, then without it, sharing one encoder pass). */
async function transcribe(audio, names) {
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

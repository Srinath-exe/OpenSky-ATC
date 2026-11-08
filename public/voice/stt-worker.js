// On-device speech-to-text worker (docs/spec/11-VOICE-MODEL.md §2.1, ml/README.md module 10 "Edge: browser").
// Moonshine tiny (MIT) through transformers.js on WebGPU, falling back to WASM. The model (~28 MB quantized) downloads
// once and is cached by the browser; audio never leaves the device.
//   in:  { type: 'load' } | { type: 'transcribe', id, audio: Float32Array (16 kHz mono) }
//   out: { type: 'progress', file, loaded, total } | { type: 'ready', device, ms } | { type: 'result', id, text, ms } | { type: 'error', id?, message }
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

// ?model=tiny|base & dtype=q8|fp32|q4 select the variant (the game uses the defaults; the bake-off script varies them)
const Q = new URLSearchParams(self.location.search);
const MODEL = `onnx-community/moonshine-${Q.get('model') === 'base' ? 'base' : 'tiny'}-ONNX`;
const WASM_DTYPE = Q.get('dtype') || 'q8';
env.allowLocalModels = false;
let asr = null;
let loading = null;
let device = 'wasm';

async function load() {
  if (asr) return asr;
  if (loading) return loading;
  loading = (async () => {
    const t0 = performance.now();
    const progress_callback = (p) => { if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); };
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(await navigator.gpu.requestAdapter().catch(() => null));
    try {
      if (!hasGpu || Q.get('device') === 'wasm') throw new Error('no WebGPU');
      asr = await pipeline('automatic-speech-recognition', MODEL, { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback });
      device = 'webgpu';
    } catch {
      asr = await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm', dtype: WASM_DTYPE, progress_callback });
      device = 'wasm';
    }
    // warm-up: the first run compiles kernels; do it before the player's first transmission
    await asr(new Float32Array(16000));
    postMessage({ type: 'ready', device, ms: Math.round(performance.now() - t0) });
    return asr;
  })();
  return loading;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') { await load(); return; }
    if (m.type === 'transcribe') {
      const model = await load();
      const t0 = performance.now();
      const out = await model(m.audio, { max_new_tokens: 64 });
      postMessage({ type: 'result', id: m.id, text: (out && out.text ? out.text : '').trim(), ms: Math.round(performance.now() - t0), device });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
};

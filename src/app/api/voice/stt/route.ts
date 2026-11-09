/*
  /api/voice/stt — server speech-to-text for push-to-talk (ml/stt/RESULTS2.md, Settings "Server").

  POST  audio (raw PCM16LE 16 kHz or WAV), X-STT-Names: the callsigns on frequency  →  { text, alternatives, ms, model }
  GET   → { ok, model, loaded, busy }      GET ?warm=1 → also starts loading the model (Settings does this on select)

  Runs inside this Next.js server (no separate service): Whisper via transformers.js on onnxruntime-node, loaded once
  per process on first use, 2 inference threads (OPENATC_STT_MODEL / _THREADS / _CACHE override). Guards in handler.ts.
  OPENATC_STT_URL (optional) forwards the audio to a separate faster-whisper service instead (ml/serve/stt_server.py,
  scripts/openatc-stt.service: not installed; it needs the owner's approval).
*/
import { handleStt, RateLimiter, Gate, clientKey } from './handler';
import { transcribe, sttConfig, loadEngine } from './engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const g = globalThis as unknown as { __openatcStt?: { limiter: RateLimiter; gate: Gate; warm: RateLimiter; loaded: boolean } };
const state = (g.__openatcStt ??= { limiter: new RateLimiter(), gate: new Gate(1), warm: new RateLimiter(6, 3), loaded: false });

export async function POST(req: Request): Promise<Response> {
  return handleStt(req, {
    limiter: state.limiter,
    gate: state.gate,
    transcribe: async (audio, names, alternatives) => {
      if (process.env.OPENATC_STT_URL) return forward(process.env.OPENATC_STT_URL, audio, names, alternatives);
      const r = await transcribe(audio, { names, alternatives });
      state.loaded = true;
      return { text: r.text, alternatives: r.alternatives, ms: r.ms, model: r.model };
    },
  });
}

async function forward(base: string, audio: Float32Array, names: string[], alternatives: boolean) {
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32768)));
  const res = await fetch(`${base.replace(/\/+$/, '')}/transcribe`, {
    method: 'POST', body: new Uint8Array(pcm.buffer), signal: AbortSignal.timeout(11_000),
    headers: { 'content-type': 'audio/l16', 'x-stt-names': encodeURIComponent(JSON.stringify(names)), 'x-stt-alts': alternatives ? '1' : '0' },
  });
  if (!res.ok) throw new Error(`stt service HTTP ${res.status}`);
  const j = await res.json() as { text: string; alternatives: string[]; ms: number; model: string };
  state.loaded = true;
  return { text: j.text, alternatives: j.alternatives, ms: j.ms, model: j.model };
}

export async function GET(req: Request): Promise<Response> {
  const c = sttConfig();
  const url = new URL(req.url);
  if (url.searchParams.get('warm') && !state.loaded && !process.env.OPENATC_STT_URL && state.warm.take(clientKey(req.headers))) {
    void loadEngine(c).then(() => { state.loaded = true; }).catch(() => undefined);
  }
  return new Response(JSON.stringify({ ok: true, model: c.model, loaded: state.loaded, busy: state.gate.busy }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/*
  /api/voice/stt — server speech-to-text for push-to-talk (ml/stt/RESULTS2.md, ml/stt/models/SERVER.md, Settings "Server").

  POST  audio (raw PCM16LE 16 kHz or WAV), X-STT-Names: the callsigns on frequency, ?engine=parakeet|whisper
        →  { text, alternatives, ms, model }
  GET   → { ok, model, first, loaded, busy }      GET ?warm=1 → also starts loading the models (Settings does this on select)

  Runs inside this Next.js server (no separate service), two engines (engine.ts), loaded once per process on first use,
  2 inference threads (OPENATC_STT_THREADS, at most 3), one transcription at a time for both:
    parakeet  the first pass (default; OPENATC_STT_FIRST=whisper makes Whisper the default again). Answered by Whisper
              when its model files are not in ~/.cache/openatc-stt/parakeet-ultra-int8 (engine.ts has the copy step).
    whisper   asked by the client only when the game cannot understand Parakeet's guesses (asr-server.ts cascadeStt).
  OPENATC_STT_URL (optional) forwards Whisper's requests to a separate faster-whisper service instead (ml/serve/stt_server.py,
  scripts/openatc-stt.service: not installed; it needs the owner's approval).
*/
import { handleStt, firstEngine, clientKey, sttState } from './handler';
import type { SttEngineId } from './handler';
import { transcribe, sttConfig, loadEngine, transcribeParakeet, loadParakeet, parakeetReady, PARAKEET_MODEL } from './engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const state = sttState();

/** Parakeet when asked for and its files are in place; otherwise Whisper (its model name in the reply tells the client). */
function engineFor(asked: SttEngineId): SttEngineId {
  if (asked !== 'parakeet' || parakeetReady()) return asked;
  if (!state.warned) { state.warned = true; console.warn('[stt] Parakeet model files missing (see src/app/api/voice/stt/engine.ts): Whisper answers instead'); }
  return 'whisper';
}

export async function POST(req: Request): Promise<Response> {
  return handleStt(req, {
    limiter: state.limiter,
    gate: state.gate,
    transcribe: async (audio, names, alternatives, asked) => {
      const engine = engineFor(asked);
      if (engine === 'whisper' && process.env.OPENATC_STT_URL) return forward(process.env.OPENATC_STT_URL, audio, names, alternatives);
      const r = engine === 'parakeet' ? await transcribeParakeet(audio, { names }) : await transcribe(audio, { names, alternatives });
      state.loaded[engine] = true;
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
  state.loaded.whisper = true;
  return { text: j.text, alternatives: j.alternatives, ms: j.ms, model: j.model };
}

export async function GET(req: Request): Promise<Response> {
  const c = sttConfig();
  const first = engineFor(firstEngine());
  const url = new URL(req.url);
  const cold = !state.loaded.whisper || (first === 'parakeet' && !state.loaded.parakeet);
  if (url.searchParams.get('warm') && cold && state.warm.take(clientKey(req.headers))) {
    // the first pass, then Whisper (asked for ~1 in 4 commands): one at a time, so a load does not slow the other
    void (async () => {
      if (first === 'parakeet' && !state.loaded.parakeet) { await loadParakeet(); state.loaded.parakeet = true; }
      if (!process.env.OPENATC_STT_URL && !state.loaded.whisper) { await loadEngine(c); state.loaded.whisper = true; }
    })().catch(() => undefined);
  }
  const model = first === 'parakeet' ? PARAKEET_MODEL : c.model;
  return new Response(JSON.stringify({ ok: true, model, first, loaded: state.loaded[first], busy: state.gate.busy }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

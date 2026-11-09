/*
  /api/voice/stt/stream — push-to-talk sent while it is spoken (../stream.ts has the how and why).

  POST  a chunk of raw PCM16LE 16 kHz (≤ 64 KB), headers:
          X-STT-Sid    the transmission's id (8-32 [a-z0-9]), X-STT-Seq  0, 1, 2, ... in order,
          X-STT-Names  the callsigns on frequency (first chunk), X-STT-End  1 on the last chunk (may be empty)
        → { partial, sec }   or, on the last chunk, { text, alternatives, model, segments, sec, modelMs, tailModelMs, waitMs }
  Parakeet only (Whisper is the whole-recording fallback on /api/voice/stt). 501 when Parakeet's files are missing: the
  client then sends the whole recording as before.
*/
import { clientKey, sttState, RateLimiter, decodeAudio, parseNames, GateFull } from '../handler';
import { transcribeParakeet, parakeetReady } from '../engine';
import { SttStream, StreamStore, STREAM_LIMITS } from '../stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const g = globalThis as unknown as { __openatcSttStreams?: StreamStore };
const store = (g.__openatcSttStreams ??= new StreamStore());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function POST(req: Request): Promise<Response> {
  const t0 = Date.now();
  const st = sttState();
  const sid = req.headers.get('x-stt-sid') || '';
  const seq = Number(req.headers.get('x-stt-seq'));
  const end = req.headers.get('x-stt-end') === '1';
  if (!/^[a-z0-9]{8,32}$/.test(sid) || !Number.isInteger(seq) || seq < 0) return json({ error: 'bad stream headers' }, 400);
  if (!parakeetReady()) return json({ error: 'streaming needs the Parakeet model' }, 501);
  const len = Number(req.headers.get('content-length') || 0);
  if (len > STREAM_LIMITS.maxChunkBytes) return json({ error: 'chunk too large' }, 413);
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > STREAM_LIMITS.maxChunkBytes) return json({ error: 'chunk too large' }, 413);
  const pcm = body.length ? decodeAudio(body, 'audio/l16') : new Float32Array(0);
  if (typeof pcm === 'string') return json({ error: pcm }, 415);

  let s = store.get(sid);
  if (seq === 0 && !s) {
    st.streams ??= new RateLimiter(STREAM_LIMITS.sessionsPerMinute, 8);
    if (!st.streams.take(clientKey(req.headers))) return json({ error: 'too many requests' }, 429);
    s = new SttStream(parseNames(req.headers.get('x-stt-names')), async (audio, names) => {
      const r = await st.gate.run(() => transcribeParakeet(audio, { names }));
      st.loaded.parakeet = true;
      return { text: r.text, ms: r.ms, model: r.model };
    });
    if (!store.create(sid, s)) return json({ error: 'speech server busy, try again' }, 503);
  }
  if (!s) return json({ error: 'unknown or expired stream' }, 404);
  if (seq !== s.seq) return json({ error: `expected chunk ${s.seq}` }, 409);
  s.seq++;
  s.push(pcm);
  if (!end) return json({ partial: s.partial(), sec: +s.seconds.toFixed(2), serverMs: Date.now() - t0 });
  try {
    const r = await Promise.race([s.end(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 12_000))]);
    if (r.failed) console.warn(`[stt stream] ${r.failed} of ${r.segments} phrases failed: ${[...new Set(s.errors)].join('; ')}`);
    return json({ ...r, serverMs: Date.now() - t0 });
  } catch (err) {
    if (err instanceof GateFull) return json({ error: 'speech server busy, try again' }, 503);
    return json({ error: err instanceof Error && err.message === 'timeout' ? 'speech recognition timed out' : `speech recognition failed: ${String(err)}` }, 504);
  } finally { store.delete(sid); }
}

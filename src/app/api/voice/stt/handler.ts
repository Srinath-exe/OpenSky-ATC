/*
  /api/voice/stt request handling, kept apart from route.ts so it can be tested without Next (tests/engine/voice-stt.test.ts).

  The site is public, so the endpoint is guarded:
    size      body ≤ 1 MB and ≤ 15 s of 16 kHz audio (a transmission is 2-6 s)
    rate      per client IP (nginx sets X-Real-IP): 30 transcriptions a minute, bursts of 10
    load      one transcription at a time (2 inference threads), at most 4 waiting; beyond that 503 "busy"
    time      12 s per request, then 504 (the model keeps the CPU it already has; no pile-up behind it)
  Audio: raw 16-bit little-endian PCM at 16 kHz (Content-Type audio/l16 or application/octet-stream) or a 16 kHz WAV.
  Biasing: X-STT-Names = encodeURIComponent(JSON.stringify(["speedbird 963", ...])), the callsigns on frequency.
  Engine: ?engine=parakeet|whisper or X-STT-Engine; without one, OPENATC_STT_FIRST (default parakeet; whisper = Whisper
  only, as before the cascade). Both engines share the guards above and the one inference slot.
*/

export const STT_LIMITS = { maxBytes: 1_000_000, maxSeconds: 15, minSeconds: 0.2, perMinute: 30, burst: 10, queue: 4, timeoutMs: 12_000, maxNames: 40 };

/** Token bucket per key: `burst` requests at once, refilled at `perMinute`. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private swept = 0;
  constructor(private perMinute = STT_LIMITS.perMinute, private burst = STT_LIMITS.burst, private maxKeys = 5000) {}
  take(key: string, now = Date.now()): boolean {
    // bounded memory: idle keys are swept at most once a minute; past maxKeys the oldest keys go first (Map keeps insertion order)
    if (this.buckets.size > this.maxKeys && now - this.swept > 60_000) {
      this.swept = now;
      for (const [k, v] of this.buckets) if (now - v.at > 120_000) this.buckets.delete(k);
      for (const k of this.buckets.keys()) { if (this.buckets.size <= this.maxKeys) break; this.buckets.delete(k); }
    }
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.burst, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60_000) * this.perMinute); b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  }
}

/** Runs jobs one (or `max`) at a time with a bounded queue. */
export class Gate {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private max = 1, private queue = STT_LIMITS.queue) {}
  get busy(): number { return this.running + this.waiting.length; }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      if (this.waiting.length >= this.queue) throw new GateFull();
      await new Promise<void>((r) => this.waiting.push(r));   // the finishing job hands its slot over: running is not decremented
    } else this.running++;
    try { return await job(); } finally { const next = this.waiting.shift(); if (next) next(); else this.running--; }
  }
}
export class GateFull extends Error { constructor() { super('busy'); } }

/** 16 kHz mono audio from the request body: raw PCM16LE, or a WAV (16-bit PCM or 32-bit float, mono, 16 kHz). */
export function decodeAudio(buf: Uint8Array, contentType: string): Float32Array | string {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const isWav = buf.length >= 12 && String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === 'RIFF' && String.fromCharCode(buf[8], buf[9], buf[10], buf[11]) === 'WAVE';
  if (!isWav) {
    if (contentType && !/audio\/l16|application\/octet-stream|audio\/pcm/i.test(contentType)) return `unsupported content type ${contentType}`;
    if (buf.length % 2) return 'odd byte count for 16-bit PCM';
    const out = new Float32Array(buf.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
    return out;
  }
  let o = 12; let fmt: { tag: number; ch: number; sr: number; bits: number } | null = null;
  while (o + 8 <= buf.length) {
    const id = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]); const n = dv.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 24 <= buf.length) fmt = { tag: dv.getUint16(o + 8, true), ch: dv.getUint16(o + 10, true), sr: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    if (id === 'data') {
      if (!fmt) return 'WAV without fmt chunk';
      if (fmt.sr !== 16000 || fmt.ch !== 1) return `WAV must be 16 kHz mono (got ${fmt.sr} Hz, ${fmt.ch} ch)`;
      const len = Math.min(n, buf.length - o - 8);
      if (fmt.bits === 16) { const out = new Float32Array(len >> 1); for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(o + 8 + i * 2, true) / 32768; return out; }
      if (fmt.bits === 32 && fmt.tag === 3) { const out = new Float32Array(len >> 2); for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(o + 8 + i * 4, true); return out; }
      return `unsupported WAV format (${fmt.bits}-bit, tag ${fmt.tag})`;
    }
    o += 8 + n + (n & 1);
  }
  return 'WAV without data chunk';
}

/** Spoken callsigns from the X-STT-Names header: letters, digits and spaces only, capped in number and length. */
export function parseNames(header: string | null): string[] {
  if (!header) return [];
  let v: unknown;
  try { v = JSON.parse(decodeURIComponent(header)); } catch { return []; }
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).slice(0, STT_LIMITS.maxNames);
}

export type SttEngineId = 'parakeet' | 'whisper';

/** The server's first pass: OPENATC_STT_FIRST=whisper restores Whisper alone; anything else is Parakeet. */
export function firstEngine(env: Record<string, string | undefined> = process.env): SttEngineId {
  return env.OPENATC_STT_FIRST?.trim().toLowerCase() === 'whisper' ? 'whisper' : 'parakeet';
}

/** The engine a request asks for (?engine= first, then X-STT-Engine), else the server's first pass. */
export function pickEngine(req: Request, env: Record<string, string | undefined> = process.env): SttEngineId {
  let asked: string | null = null;
  try { asked = new URL(req.url).searchParams.get('engine'); } catch { /* relative url */ }
  const v = (asked || req.headers.get('x-stt-engine') || '').trim().toLowerCase();
  return v === 'parakeet' || v === 'whisper' ? v : firstEngine(env);
}

export function clientKey(h: Headers): string {
  return h.get('x-real-ip') || h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}

async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await reader.cancel(); } catch { /* closed */ } return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface SttDeps {
  transcribe: (audio: Float32Array, names: string[], alternatives: boolean, engine: SttEngineId) => Promise<{ text: string; alternatives: string[]; ms: number; model: string }>;
  limiter: RateLimiter;
  gate: Gate;
  timeoutMs?: number;
  /** For OPENATC_STT_FIRST (tests pass their own). */
  env?: Record<string, string | undefined>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handleStt(req: Request, deps: SttDeps): Promise<Response> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > STT_LIMITS.maxBytes) return json({ error: `audio too large (max ${STT_LIMITS.maxBytes} bytes)` }, 413);
  if (!deps.limiter.take(clientKey(req.headers))) return json({ error: 'too many requests' }, 429);
  const body = await readLimited(req, STT_LIMITS.maxBytes);
  if (!body) return json({ error: `audio too large (max ${STT_LIMITS.maxBytes} bytes)` }, 413);
  const audio = decodeAudio(body, req.headers.get('content-type') || '');
  if (typeof audio === 'string') return json({ error: audio }, 415);
  const sec = audio.length / 16000;
  if (sec > STT_LIMITS.maxSeconds) return json({ error: `audio too long (max ${STT_LIMITS.maxSeconds} s)` }, 413);
  if (sec < STT_LIMITS.minSeconds) return json({ text: '', alternatives: [], ms: 0, model: null });
  const names = parseNames(req.headers.get('x-stt-names'));
  const alternatives = req.headers.get('x-stt-alts') !== '0';
  const engine = pickEngine(req, deps.env);
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    let answered = false;   // set when the request has already been answered (timeout): a queued job is then skipped
    const job = deps.gate.run(async () => {
      if (answered) throw new Error('abandoned');
      const q = Date.now() - t0; return { ...(await deps.transcribe(audio, names, alternatives, engine)), queueMs: q };
    });
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { answered = true; rej(new Error('timeout')); }, deps.timeoutMs ?? STT_LIMITS.timeoutMs); });
    job.catch(() => undefined);
    const r = await Promise.race([job, timeout]);
    return json({ ...r, sec: +sec.toFixed(2) });
  } catch (err) {
    if (err instanceof GateFull) return json({ error: 'speech server busy, try again' }, 503);
    if (err instanceof Error && err.message === 'timeout') return json({ error: 'speech recognition timed out' }, 504);
    return json({ error: `speech recognition failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  } finally { if (timer) clearTimeout(timer); }
}

/** One state per server process, shared by /api/voice/stt and /api/voice/stt/stream (one transcription at a time for both). */
export type SttLoaded = Record<SttEngineId, boolean>;
export interface SttState { limiter: RateLimiter; gate: Gate; warm: RateLimiter; loaded: SttLoaded; warned?: boolean; streams?: RateLimiter }
export function sttState(): SttState {
  const g = globalThis as unknown as { __openatcStt?: SttState };
  const st = (g.__openatcStt ??= { limiter: new RateLimiter(), gate: new Gate(1), warm: new RateLimiter(6, 3), loaded: { parakeet: false, whisper: false } });
  if (typeof st.loaded !== 'object') st.loaded = { parakeet: false, whisper: false };   // a dev server's state from before the cascade
  return st;
}

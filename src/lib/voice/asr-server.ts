/*
  Server recogniser (Settings "Server"): push-to-talk audio is posted to this site's own /api/voice/stt
  (src/app/api/voice/stt), which knows the callsigns on frequency. Two engines there, asked in turn (cascadeStt):
  Parakeet first (~0.4 s, the callsigns as hotwords); only when the game cannot understand its guesses does the same
  audio go to Whisper (~1.3 s, the callsigns as a prompt, two guesses), and both lists are then read together
  (ml/stt/models/SERVER.md "Cascades": 78.1% / 85.6% exact on US/UK / the Indian-accent proxy, against 76.9% / 78.8%
  for Whisper alone; Whisper is needed for ~1 command in 4). Audio goes to this game's server, not to Google, and is
  not stored.
*/
import type { Recognizer } from './recognizer';
import { createMicCapture, micCaptureAvailable, toPcm16 } from './asr-capture';

export const STT_URL = '/api/voice/stt';

export function serverSpeechAvailable(): boolean { return micCaptureAvailable() && typeof fetch !== 'undefined'; }

export interface ServerStatus { lastMs: number | null; model: string | null; error: string | null }

export type SttEngine = 'parakeet' | 'whisper';
export interface SttReply { text: string; alternatives: string[]; ms: number | null; model: string | null }

/**
 * POST one utterance to the server -> its guesses (best first). Throws with the server's message.
 * `engine` unset: the server's first pass (Parakeet, unless the server is set to Whisper alone: OPENATC_STT_FIRST).
 */
export async function postStt(audio: Float32Array, names: string[], engine?: SttEngine, timeoutMs = 15000): Promise<SttReply> {
  const ctl = new AbortController(); const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(engine ? `${STT_URL}?engine=${engine}` : STT_URL, {
      method: 'POST', body: toPcm16(audio.length > 16000 * 15 ? audio.subarray(0, 16000 * 15) : audio)   /* keep the start: the callsign comes first */, signal: ctl.signal,
      headers: { 'content-type': 'audio/l16', 'x-stt-names': encodeURIComponent(JSON.stringify(names)), 'x-stt-alts': '1' },
    });
    const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    const alternatives = Array.isArray(j.alternatives) ? j.alternatives.filter((x: unknown): x is string => typeof x === 'string') : [];
    return { text: String(j.text ?? ''), alternatives, ms: j.ms ?? null, model: j.model ?? null };
  } catch (err) {
    throw ctl.signal.aborted ? new Error('timed out') : err;
  } finally { window.clearTimeout(timer); }
}

/** What the game made of some guesses (asr-nbest.ts HeardResult). */
export interface Understood { ok: boolean; confidence?: number | null }

/** Of two readings of one transmission, the later one wins when it is understood or more confident (CommLog's rule). */
export function better<U extends Understood>(first: U | null, second: U | null): U | null {
  if (!first || !second) return first ?? second;
  return second.ok || (second.confidence ?? 0) > (first.confidence ?? 0) ? second : first;
}

const interleave = (a: string[], b: string[]) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]]).flat().filter((x): x is string => !!x);

/**
 * The server's engines in turn: Parakeet first; only when `understand` does not accept its guesses is the same audio
 * sent to Whisper, and both lists are then read together (Parakeet's first, interleaved: the benchmark's rule), the
 * better reading winning. `asked`: Parakeet's reply when the caller already has it (the Server recogniser asks on
 * release). A failed request counts as no guesses. `alts`: every server guess, in the order asked (for the log).
 */
export async function cascadeStt<U extends Understood>(audio: Float32Array, names: string[], understand: (alts: string[]) => Promise<U | null>,
  opts: { post?: typeof postStt; asked?: SttReply } = {}): Promise<{ result: U | null; alts: string[]; error: string | null }> {
  const post = opts.post ?? postStt;
  let error: string | null = null;
  const ask = (engine?: SttEngine) => post(audio, names, engine).catch((err) => { error = err instanceof Error ? err.message : String(err); return null; });
  const p = opts.asked ?? await ask();
  const pa = p?.alternatives ?? [];
  const first = !opts.asked && pa.length ? await understand(pa) : null;
  // understood, or the server's first pass already was Whisper (set so, or Parakeet's files are missing)
  if (first?.ok || /^whisper/i.test(p?.model ?? '')) return { result: first, alts: pa, error };
  const w = await ask('whisper');
  const wa = w?.alternatives ?? [];
  if (!wa.length) return { result: first, alts: pa, error };
  return { result: better(first, await understand(interleave(pa, wa))), alts: [...pa, ...wa], error };
}

/**
 * Web Speech with this server as a second opinion: the transmission is also recorded here (asr-capture, pre-roll), and
 * only when none of the browser's guesses is understood does the game send that audio to /api/voice/stt
 * (`secondOpinion()`: Parakeet, then Whisper when still not understood; cascadeStt).
 */
export function withServerSecondOpinion(rec: Recognizer): Recognizer {
  if (!serverSpeechAvailable()) return rec;
  const mic = createMicCapture();
  let names: string[] = [];
  let audio: Promise<Float32Array> | null = null;
  void fetch(`${STT_URL}?warm=1`, { cache: 'no-store' }).catch(() => undefined);   // the models load before they are needed
  const start = rec.start.bind(rec), stop = rec.stop.bind(rec), setHints = rec.setHints?.bind(rec);
  rec.setHints = (n: string[]) => { names = n.slice(0, 40); setHints?.(n); };
  rec.start = () => { audio = null; mic.start().catch(() => undefined); start(); };
  rec.stop = () => { audio = mic.stop().catch(() => new Float32Array(0)); return stop(); };
  rec.secondOpinion = async (understand) => {
    const a = audio ? await audio : null;
    if (!a || a.length < 16000 * 0.25) return { result: null, alts: [] };
    rec.onPartial?.('Checking with the server…');
    return cascadeStt(a, names, understand);
  };
  rec.lastAudio = async () => (audio ? await audio : null);
  return rec;
}

export function createServerRecognizer(onStatus?: (s: ServerStatus) => void): Recognizer | null {
  if (!serverSpeechAvailable()) return null;
  const mic = createMicCapture();
  let names: string[] = [];
  const status: ServerStatus = { lastMs: null, model: null, error: null };
  let last: Float32Array | null = null;
  let reply: SttReply | null = null;   // the first pass's answer for `last` (null: the request failed)
  // load the models on the server now, not at the first transmission
  void fetch(`${STT_URL}?warm=1`, { cache: 'no-store' }).then((r) => r.json()).then((j) => { status.model = j.model ?? null; onStatus?.({ ...status }); }).catch(() => undefined);

  const self: Recognizer = {
    kind: 'server',
    onPartial: null,
    onError: null,
    alternatives: [],
    setHints(n: string[]) { names = n.slice(0, 40); },
    start() {
      self.alternatives = [];
      if (!mic.isOpen) self.onPartial?.('Microphone starting…');
      mic.start().then(() => self.onPartial?.('Listening…'))
        .catch((err) => self.onError?.(/denied|not ?allowed/i.test(String(err)) ? 'Microphone access was blocked. Allow it in the browser to talk.' : `Microphone: ${String(err)}`));
    },
    lastAudio: async () => last,
    // not understood: Whisper on the same audio, read together with the first pass's guesses (cascadeStt)
    async secondOpinion(understand) {
      if (!last || !reply || last.length < 16000 * 0.25) return { result: null, alts: [] };
      self.onPartial?.('Checking again…');
      return cascadeStt(last, names, understand, { asked: reply });
    },
    async stop() {
      const audio = await mic.stop(); last = audio; reply = null;
      if (audio.length < 16000 * 0.25) return '';
      self.onPartial?.('Transcribing…');
      try {
        const r = await postStt(audio, names);
        status.lastMs = r.ms; status.model = r.model ?? status.model; status.error = null; onStatus?.({ ...status });
        self.alternatives = r.alternatives; reply = r;
        return r.text;
      } catch (err) {
        status.error = err instanceof Error ? err.message : String(err); onStatus?.({ ...status });
        self.onError?.(`Speech server: ${status.error}`);
        return '';
      }
    },
  };
  return self;
}

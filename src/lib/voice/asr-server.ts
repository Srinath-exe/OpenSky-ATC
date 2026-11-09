/*
  Server recogniser (Settings "Server"): push-to-talk audio is posted to this site's own /api/voice/stt, where Whisper
  transcribes it with the callsigns on frequency as a biasing prompt (src/app/api/voice/stt). It returns two guesses
  (with and without the prompt) for the n-best step (asr-nbest.ts). Audio goes to this game's server, not to Google,
  and is not stored.
*/
import type { Recognizer } from './recognizer';
import { createMicCapture, micCaptureAvailable, toPcm16 } from './asr-capture';

export const STT_URL = '/api/voice/stt';

export function serverSpeechAvailable(): boolean { return micCaptureAvailable() && typeof fetch !== 'undefined'; }

export interface ServerStatus { lastMs: number | null; model: string | null; error: string | null }

/** POST one utterance to the server engine -> its guesses (best first). Throws with the server's message. */
export async function postStt(audio: Float32Array, names: string[], timeoutMs = 15000): Promise<{ text: string; alternatives: string[]; ms: number | null; model: string | null }> {
  const ctl = new AbortController(); const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(STT_URL, {
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

/**
 * Web Speech with this server as a second opinion: the transmission is also recorded here (asr-capture, pre-roll), and
 * only when none of the browser's guesses is understood does the game send that audio to /api/voice/stt
 * (`secondOpinion()`); both guess lists then go through the n-best step together.
 */
export function withServerSecondOpinion(rec: Recognizer): Recognizer {
  if (!serverSpeechAvailable()) return rec;
  const mic = createMicCapture();
  let names: string[] = [];
  let audio: Promise<Float32Array> | null = null;
  void fetch(`${STT_URL}?warm=1`, { cache: 'no-store' }).catch(() => undefined);   // the model loads before it is needed
  const start = rec.start.bind(rec), stop = rec.stop.bind(rec), setHints = rec.setHints?.bind(rec);
  rec.setHints = (n: string[]) => { names = n.slice(0, 40); setHints?.(n); };
  rec.start = () => { audio = null; mic.start().catch(() => undefined); start(); };
  rec.stop = () => { audio = mic.stop().catch(() => new Float32Array(0)); return stop(); };
  rec.secondOpinion = async () => {
    const a = audio ? await audio : null;
    if (!a || a.length < 16000 * 0.25) return [];
    rec.onPartial?.('Checking with the server…');
    try { return (await postStt(a, names)).alternatives; } catch { return []; }
  };
  return rec;
}

export function createServerRecognizer(onStatus?: (s: ServerStatus) => void): Recognizer | null {
  if (!serverSpeechAvailable()) return null;
  const mic = createMicCapture();
  let names: string[] = [];
  const status: ServerStatus = { lastMs: null, model: null, error: null };
  // load the model on the server now, not at the first transmission
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
    async stop() {
      const audio = await mic.stop();
      if (audio.length < 16000 * 0.25) return '';
      self.onPartial?.('Transcribing…');
      try {
        const r = await postStt(audio, names);
        status.lastMs = r.ms; status.model = r.model ?? status.model; status.error = null; onStatus?.({ ...status });
        self.alternatives = r.alternatives;
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

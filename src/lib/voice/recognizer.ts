/*
  Voice input — speech-to-text backends behind one small interface (docs/spec/11-VOICE-MODEL.md §1, §2.1).

  `browser`: the Web Speech API (Chrome / Edge / Safari). No download, works today; Chrome sends the audio to its
  cloud recogniser, Safari recognises on device. It is the E0 baseline and the fallback.
  A local backend (Moonshine / Whisper in a Web Worker, WebGPU or WASM) plugs in here with the same interface.

  Push-to-talk drives it: start() on PTT down, stop() on release; the final transcript arrives through onFinal
  (a short grace period lets the recogniser flush the last words).
  `server`: src/lib/voice/asr-server.ts (Parakeet, then Whisper, on this site's server, biased with the callsigns on frequency).
*/
import { createMicCapture, isSilent } from './asr-capture';
import { silentMessage } from './asr-server';
import type { Understood } from './asr-server';

export interface Recognizer {
  readonly kind: VoiceEngine;
  start(): void;
  /** Stop listening; resolves with the final transcript ('' when nothing was heard). */
  stop(): Promise<string>;
  onPartial: ((text: string) => void) | null;
  onError: ((message: string) => void) | null;
  /** n-best of the last stop(), best first (engines that give more than one guess; src/lib/voice/asr-nbest.ts). */
  alternatives?: string[];
  /** The callsigns on frequency as spoken ("speedbird 963"), set on PTT down: biasing for engines that support it. */
  setHints?(names: string[]): void;
  /** A second reading of the last utterance by the server's engines, asked only when the first guesses were not
   *  understood (asr-server.ts cascadeStt): `understand` reads a list of guesses; the best reading comes back with every
   *  guess the server made. */
  secondOpinion?<U extends Understood>(understand: (alts: string[]) => Promise<U | null>): Promise<{ result: U | null; alts: string[] }>;
  /** The last transmission's audio (16 kHz mono) when this recogniser records it itself, for the owner's live-attempt log. */
  lastAudio?(): Promise<Float32Array | null>;
}

type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart?: (() => void) | null;
  /** Contextual biasing (Chrome 14x+): phrases the recogniser should prefer. */
  phrases?: unknown[];
};

function srConstructor(): (new () => SR) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserSpeechAvailable(): boolean { return srConstructor() != null; }

export function localSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined' && typeof AudioWorkletNode !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** 'native': the OpenATC phone app's on-device recogniser over the JS bridge (only offered inside the app). */
export type VoiceEngine = 'browser' | 'local' | 'server' | 'native';

/** Chosen on the owner's real recordings (ml/data/gold, 2026-11-09): through the game's cleanup and rules, Parakeet on
 *  the server read 15 of 15 commands right (14 by the rules alone), the browser's recogniser (Google) 9 of 15. On
 *  synthetic speech Web Speech + server had led (ml/stt/RESULTS2.md), real voices reversed it. The server streams while
 *  the controller talks, so the text is ready ~0.2-0.4 s after release. */
export const DEFAULT_VOICE_ENGINE: VoiceEngine = 'server';

/** Status of the on-device model for the UI: download progress, then ready (with the backend it runs on). */
export interface LocalStatus { state: 'idle' | 'loading' | 'ready' | 'error'; progress: number; device: string; lastMs: number | null; message: string }

/** On-device recogniser: mic -> AudioWorklet (16 kHz, 0.3 s pre-roll; asr-capture.ts) -> Moonshine in a Web Worker.
 *  Not streaming: the utterance is transcribed when push-to-talk is released. `?model=base` on the worker selects
 *  Moonshine base (the default since ml/stt/RESULTS2.md: tiny missed too many callsigns). The page URL can pick another
 *  on-device model to try: `?stt-model=whistle` (Cactus Whistle, 18 MB, keyword-biased with the airline names and ATC
 *  words; a quarter of the download, but 3-8 points less accurate than Moonshine base, ml/stt/models/EDGE.md), `tiny`,
 *  `whisper-tiny.en`. */
export function createLocalRecognizer(onStatus?: (s: LocalStatus) => void, model: 'base' | 'tiny' | 'whistle' = 'base'): Recognizer | null {
  if (!localSpeechAvailable()) return null;
  const status: LocalStatus = { state: 'idle', progress: 0, device: '', lastMs: null, message: '' };
  const emit = (p: Partial<LocalStatus>) => { Object.assign(status, p); onStatus?.({ ...status }); };
  const asked = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('stt-model') : null;
  const pick = asked && (['base', 'tiny', 'whistle', 'whisper-tiny.en', 'whisper-base.en'].includes(asked) || /^atc-[a-z0-9._-]+$/i.test(asked)) ? asked : model;   // atc-<name>: a model this site hosts (/models/stt/<name>/)
  const worker = new Worker(`/voice/stt-worker.js?model=${pick}`, { type: 'module' });
  const files = new Map<string, { loaded: number; total: number }>();
  const pending = new Map<number, (text: string) => void>();
  let nextId = 1;
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === 'progress') {
      files.set(m.file, { loaded: m.loaded, total: m.total });
      let l = 0, t = 0; files.forEach((f) => { l += f.loaded; t += f.total; });
      emit({ state: 'loading', progress: t ? l / t : 0 });
    } else if (m.type === 'ready') emit({ state: 'ready', progress: 1, device: m.device, message: '' });
    else if (m.type === 'result') { emit({ lastMs: m.ms, device: m.device }); self.alternatives = Array.isArray(m.alternatives) ? m.alternatives : m.text ? [m.text] : []; pending.get(m.id)?.(m.text); pending.delete(m.id); }
    else if (m.type === 'error') { emit({ state: 'error', message: m.message }); self.onError?.(`On-device speech model: ${m.message}`); if (m.id) { pending.get(m.id)?.(''); pending.delete(m.id); } }
  };
  emit({ state: 'loading' });
  worker.postMessage({ type: 'load' });
  const mic = createMicCapture();
  let names: string[] = [];

  const self: Recognizer = {
    kind: 'local',
    onPartial: null,
    onError: null,
    alternatives: [],
    setHints(n: string[]) { names = n.slice(0, 40); },
    start() {
      self.alternatives = [];
      if (!mic.isOpen) self.onPartial?.('Microphone starting…');
      mic.start().then(() => { self.onPartial?.(status.state === 'ready' ? 'Listening (on-device)…' : `Listening… voice model ${Math.round(status.progress * 100)}%`); })
        .catch((err) => { self.onError?.(/denied|not ?allowed/i.test(String(err)) ? 'Microphone access was blocked. Allow it in the browser to talk.' : `Microphone: ${String(err)}`); });
    },
    async stop() {
      const audio = await mic.stop();
      if (audio.length < 16000 * 0.25) return '';
      if (isSilent(audio)) { self.onError?.(silentMessage()); return ''; }
      self.onPartial?.('Transcribing…');
      const id = nextId++;
      return new Promise<string>((resolve) => { pending.set(id, resolve); worker.postMessage({ type: 'transcribe', id, audio, names }, [audio.buffer]); });
    },
  };
  return self;
}

/** ATC phrases worth a boost on top of the callsigns (Web Speech contextual biasing). */
const ATC_PHRASES = ['flight level', 'heading', 'descend and maintain', 'climb and maintain', 'cleared to land', 'cleared for takeoff',
  'line up and wait', 'hold short', 'contact tower', 'contact approach', 'contact departure', 'contact ground', 'niner', 'squawk',
  'reduce speed', 'turn left heading', 'turn right heading', 'ILS approach', 'go around', 'taxi via', 'cross runway', 'expedite', 'roger'];
let phrasesSupported: boolean | null = null;   // null = not tried; false after 'phrases-not-supported'

const PREROLL_S = 0.3;

/** English accents the browser recogniser has its own models for (Google: en-IN, en-GB, ...). The accent matters more
 *  than anything else for Web Speech on a non-US voice, so it is a setting (Settings -> Voice accent). */
export const VOICE_ACCENTS: { value: string; label: string }[] = [
  { value: 'en-US', label: 'US English' }, { value: 'en-GB', label: 'UK English' }, { value: 'en-IN', label: 'Indian English' },
  { value: 'en-AU', label: 'Australian English' }, { value: 'en-CA', label: 'Canadian English' }, { value: 'en-IE', label: 'Irish English' },
  { value: 'en-NZ', label: 'New Zealand English' }, { value: 'en-ZA', label: 'South African English' }, { value: 'en-SG', label: 'Singapore English' },
];
/** The browser's first English locale we have a model for, else US English. */
export function defaultAccent(): string {
  const langs = typeof navigator !== 'undefined' ? [...(navigator.languages ?? []), navigator.language].filter(Boolean) : [];
  for (const l of langs) { const hit = VOICE_ACCENTS.find((a) => a.value.toLowerCase() === String(l).toLowerCase()); if (hit) return hit.value; }
  return 'en-US';
}

/** Web Speech API recogniser. One utterance per start()/stop(). Keeps up to 5 alternatives (n-best) and, where the
 *  browser supports it (Chrome 14x+ `SpeechRecognition.phrases`, on-device recognition only), biases towards the
 *  callsigns on frequency.
 *  Pre-roll: the recogniser listens to our own microphone stream through a 0.3 s delay line
 *  (`start(MediaStreamTrack)`, Chrome 13x+; older browsers ignore the argument and use the default microphone).
 *  The line stays open for a minute after the last transmission, so neither the recogniser's start-up nor a word begun
 *  just before the key press cuts the callsign, which is the first word. */
export function createBrowserRecognizer(lang = 'en-US'): Recognizer | null {
  const Ctor = srConstructor();
  if (!Ctor) return null;
  let sr: SR | null = null;
  let flushPending: (() => void) | null = null;   // the previous transmission's delayed stop, while it waits
  // per transmission: a quick re-press must not mix into the previous one, which is still flushing
  type Utt = { finals: string[][]; interim: string; ended: (() => void) | null };
  let utt: Utt = { finals: [], interim: '', ended: null };
  let names: string[] = [];
  const PhraseCtor = typeof window !== 'undefined' ? (window as unknown as { SpeechRecognitionPhrase?: new (p: string, boost: number) => unknown }).SpeechRecognitionPhrase : undefined;
  const joined = (u: Utt, k: number) => `${u.finals.filter(Boolean).map((alts) => alts[k] ?? alts[0]).join(' ')} ${u.interim}`.replace(/\s+/g, ' ').trim();
  let line: { ctx: AudioContext; stream: MediaStream; track: MediaStreamTrack } | null = null;
  let idle: number | null = null;
  let session = 0, active = false, lastTrack: MediaStreamTrack | null = null;
  const lineOk = typeof AudioContext !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const openLine = async (): Promise<MediaStreamTrack> => {
    if (line && line.track.readyState === 'live') { await line.ctx.resume(); return line.track; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext();
    const delay = ctx.createDelay(1); delay.delayTime.value = PREROLL_S;
    const dst = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(stream).connect(delay); delay.connect(dst);
    await ctx.resume();
    line = { ctx, stream, track: dst.stream.getAudioTracks()[0] };
    return line.track;
  };
  const closeLineSoon = () => {
    if (idle) window.clearTimeout(idle);
    idle = window.setTimeout(() => { line?.stream.getTracks().forEach((t) => t.stop()); void line?.ctx.close(); line = null; }, 60000);
  };
  const begin = (track: MediaStreamTrack | null = lastTrack) => {
    lastTrack = track;
    const u = utt;
    const cur = new Ctor();
    sr = cur;
    cur.lang = lang; cur.continuous = true; cur.interimResults = true; cur.maxAlternatives = 5;
    if (PhraseCtor && phrasesSupported !== false && 'phrases' in cur) {
      try { cur.phrases = [...names.map((n) => new PhraseCtor(n, 5)), ...ATC_PHRASES.map((p) => new PhraseCtor(p, 2))]; } catch { phrasesSupported = false; }
    }
    cur.onresult = (e) => {
      u.interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) u.finals[i] = Array.from({ length: r.length }, (_, k) => r[k].transcript.trim()); else u.interim += r[0].transcript;
      }
      if (u === utt) self.onPartial?.(joined(u, 0));
    };
    cur.onaudiostart = () => { if (u === utt && !u.finals.length && !u.interim) self.onPartial?.('Listening…'); };
    cur.onerror = (e) => {
      if (e.error === 'phrases-not-supported') {   // e.g. cloud recognition: retry once without biasing
        phrasesSupported = false;
        if (sr === cur) { cur.onend = null; try { begin(); } catch { /* ignore */ } }
        return;
      }
      if (e.error !== 'no-speech' && e.error !== 'aborted') self.onError?.(e.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in the browser to talk.' : `Speech recognition error: ${e.error}`);
    };
    cur.onend = () => { if (phrasesSupported === null && cur.phrases?.length) phrasesSupported = true; u.ended?.(); u.ended = null; };
    if (track) (cur.start as (t?: MediaStreamTrack) => void)(track); else cur.start();
  };
  const self: Recognizer = {
    kind: 'browser',
    onPartial: null,
    onError: null,
    alternatives: [],
    setHints(n: string[]) { names = n.slice(0, 40); },
    start() {
      try { sr?.abort(); } catch { /* not running */ }
      flushPending?.();   // a re-press during the previous release tail: that recogniser stops now, with what it has
      utt = { finals: [], interim: '', ended: null }; self.alternatives = [];
      self.onPartial?.('Microphone starting…');
      if (idle) window.clearTimeout(idle);
      const mine = ++session; active = true;
      const go = (track: MediaStreamTrack | null) => { if (active && mine === session) { try { begin(track); } catch (err) { self.onError?.(String(err)); } } };
      if (lineOk) openLine().then(go, () => go(null)); else go(null);
    },
    stop() {
      active = false;
      if (lineOk) closeLineSoon();
      const cur = sr, u = utt;
      if (!cur) return Promise.resolve('');
      sr = null;
      return new Promise<string>((resolve) => {
        const finish = () => {
          const n = Math.max(1, ...u.finals.filter(Boolean).map((a) => a.length));
          self.alternatives = [...new Set(Array.from({ length: n }, (_, k) => joined(u, k)).filter(Boolean))];
          resolve(joined(u, 0));
        };
        // a short tail after release so the last word is not cut (plus the delay line), then let the recogniser flush
        // (never hang the bar)
        const stopNow = () => {
          flushPending = null; window.clearTimeout(tail);
          const timer = window.setTimeout(finish, 2000);
          u.ended = () => { window.clearTimeout(timer); finish(); };
          try { cur.stop(); } catch { window.clearTimeout(timer); finish(); }
        };
        const tail = window.setTimeout(stopNow, 250 + (lastTrack ? PREROLL_S * 1000 : 0));
        flushPending = stopNow;
      });
    },
  };
  return self;
}

// ---- native: the phone app (mobile/, Flutter) records and transcribes on the device; this page only gets text ----
// Bridge (mobile/lib/src/bridge/protocol.dart): page -> app via the `OpenATCNative` JavaScriptChannel,
// app -> page via `openatc-native` CustomEvents on window.

type NativeChannel = { postMessage(message: string): void };
/** What the app posts back. `ms` = PTT release -> final text, measured on the phone. */
export type NativeEvent =
  | { type: 'hello'; state: 'loading' | 'ready' | 'no-model' | 'error'; model?: { id: string; name?: string; version?: string } | null; hotwords?: boolean; streaming?: boolean; appVersion?: string }
  | { type: 'started'; id: number }
  | { type: 'partial'; id: number; text: string }
  | { type: 'final'; id: number; text: string; ms: number; computeMs: number; audioMs: number; rtf: number; model: string }
  | { type: 'error'; id: number | null; code: string; message: string };
export const NATIVE_EVENT = 'openatc-native';

function nativeChannel(): NativeChannel | null {
  if (typeof window === 'undefined') return null;
  const ch = (window as unknown as { OpenATCNative?: NativeChannel }).OpenATCNative;
  return ch && typeof ch.postMessage === 'function' ? ch : null;
}

/** True inside the OpenATC phone app with a speech model installed. */
export function nativeSpeechAvailable(): boolean { return nativeChannel() != null; }

export interface NativeStatus { state: 'unknown' | 'loading' | 'ready' | 'no-model' | 'error'; model: string; lastMs: number | null; lastRtf: number | null }

/** Push-to-talk through the phone app: start() asks the app to open the mic (with the callsigns on frequency as
 *  hotwords), stop() resolves with the app's final transcript. Audio never reaches the page. */
export function createNativeRecognizer(onStatus?: (s: NativeStatus) => void, timeoutMs = 8000): Recognizer | null {
  const ch = nativeChannel();
  if (!ch) return null;
  const status: NativeStatus = { state: 'unknown', model: '', lastMs: null, lastRtf: null };
  const emit = (p: Partial<NativeStatus>) => { Object.assign(status, p); onStatus?.({ ...status }); };
  const send = (m: Record<string, unknown>) => { try { ch.postMessage(JSON.stringify({ v: 1, ...m })); } catch (err) { self.onError?.(`Phone app: ${String(err)}`); } };
  let nextId = 1;
  let current = 0;
  let hints: string[] = [];
  const waiting = new Map<number, (text: string) => void>();
  // a final can arrive before stop() asks for it (the app ends the utterance itself): keep it until stop() collects it
  const early = new Map<number, string>();
  const settle = (id: number, text: string) => {
    const w = waiting.get(id);
    if (w) { waiting.delete(id); w(text); return; }
    early.set(id, text); if (early.size > 8) early.delete(early.keys().next().value as number);
  };

  window.addEventListener(NATIVE_EVENT, (ev: Event) => {
    const m = (ev as CustomEvent<NativeEvent>).detail;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'hello') emit({ state: m.state, model: m.model?.id ?? '' });
    else if (m.type === 'partial') { if (m.id === current) self.onPartial?.(m.text); }
    else if (m.type === 'final') { emit({ lastMs: m.ms, lastRtf: m.rtf }); settle(m.id, m.text.trim()); }
    else if (m.type === 'error') {
      if (m.id == null || m.id === current) self.onError?.(m.message);
      if (m.id != null) settle(m.id, '');
    }
  });
  send({ type: 'hello' });

  const self: Recognizer = {
    kind: 'native',
    onPartial: null,
    onError: null,
    setHints(names: string[]) { hints = names; },
    start() {
      current = nextId++;
      self.onPartial?.(status.state === 'loading' ? 'Listening… (phone speech model still loading)' : 'Listening (on the phone)…');
      send({ type: 'start', id: current, hotwords: hints, callsigns: [] });
    },
    stop() {
      const id = current;
      if (!id) return Promise.resolve('');
      if (early.has(id)) { const t = early.get(id) ?? ''; early.delete(id); send({ type: 'stop', id }); return Promise.resolve(t); }
      return new Promise<string>((resolve) => {
        const timer = window.setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); self.onError?.('The phone app did not return a transcript.'); resolve(''); } }, timeoutMs);
        waiting.set(id, (text) => { window.clearTimeout(timer); resolve(text); });
        send({ type: 'stop', id });
      });
    },
  };
  return self;
}

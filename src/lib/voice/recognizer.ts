/*
  Voice input — speech-to-text backends behind one small interface (docs/spec/11-VOICE-MODEL.md §1, §2.1).

  `browser`: the Web Speech API (Chrome / Edge / Safari). No download, works today; Chrome sends the audio to its
  cloud recogniser, Safari recognises on device. It is the E0 baseline and the fallback.
  A local backend (Moonshine / Whisper in a Web Worker, WebGPU or WASM) plugs in here with the same interface.

  Push-to-talk drives it: start() on PTT down, stop() on release; the final transcript arrives through onFinal
  (a short grace period lets the recogniser flush the last words).
*/

export interface Recognizer {
  readonly kind: 'browser' | 'local';
  start(): void;
  /** Stop listening; resolves with the final transcript ('' when nothing was heard). */
  stop(): Promise<string>;
  onPartial: ((text: string) => void) | null;
  onError: ((message: string) => void) | null;
}

type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
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

export type VoiceEngine = 'browser' | 'local';

/** Status of the on-device model for the UI: download progress, then ready (with the backend it runs on). */
export interface LocalStatus { state: 'idle' | 'loading' | 'ready' | 'error'; progress: number; device: string; lastMs: number | null; message: string }

/** On-device recogniser: mic -> AudioWorklet (16 kHz) -> Moonshine in a Web Worker. Not streaming: the utterance is
 *  transcribed when push-to-talk is released (Moonshine tiny takes ~0.1-0.3 s for a few seconds of speech). */
export function createLocalRecognizer(onStatus?: (s: LocalStatus) => void): Recognizer | null {
  if (!localSpeechAvailable()) return null;
  const status: LocalStatus = { state: 'idle', progress: 0, device: '', lastMs: null, message: '' };
  const emit = (p: Partial<LocalStatus>) => { Object.assign(status, p); onStatus?.({ ...status }); };
  const worker = new Worker('/voice/stt-worker.js', { type: 'module' });
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
    else if (m.type === 'result') { emit({ lastMs: m.ms, device: m.device }); pending.get(m.id)?.(m.text); pending.delete(m.id); }
    else if (m.type === 'error') { emit({ state: 'error', message: m.message }); self.onError?.(`On-device speech model: ${m.message}`); if (m.id) { pending.get(m.id)?.(''); pending.delete(m.id); } }
  };
  emit({ state: 'loading' });
  worker.postMessage({ type: 'load' });

  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let stream: MediaStream | null = null;
  let chunks: Float32Array[] = [];
  let idleTimer: number | null = null;
  let starting: Promise<void> | null = null;

  const openMic = async () => {
    if (ctx && node) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('/voice/capture-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'atc-capture');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => { chunks.push(e.data); };
    src.connect(node);
  };
  // the microphone stays open for a minute after the last transmission (no permission / start-up delay in a busy
  // session), then it is released so the browser's recording indicator goes off
  const closeMicSoon = () => {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => { stream?.getTracks().forEach((t) => t.stop()); void ctx?.close(); ctx = null; node = null; stream = null; }, 60000);
  };

  const self: Recognizer = {
    kind: 'local',
    onPartial: null,
    onError: null,
    start() {
      chunks = [];
      if (idleTimer) window.clearTimeout(idleTimer);
      starting = openMic().then(async () => { await ctx?.resume(); node?.port.postMessage({ recording: true }); self.onPartial?.(status.state === 'ready' ? 'Listening (on-device)…' : `Listening… voice model ${Math.round(status.progress * 100)}%`); })
        .catch((err) => { self.onError?.(/denied|not ?allowed/i.test(String(err)) ? 'Microphone access was blocked. Allow it in the browser to talk.' : `Microphone: ${String(err)}`); });
    },
    async stop() {
      await starting;
      node?.port.postMessage({ recording: false });
      closeMicSoon();
      // let the worklet's last frames arrive
      await new Promise((r) => window.setTimeout(r, 60));
      const n = chunks.reduce((s, c) => s + c.length, 0);
      if (n < 16000 * 0.25) return '';
      const audio = new Float32Array(n); let o = 0; for (const c of chunks) { audio.set(c, o); o += c.length; }
      chunks = [];
      self.onPartial?.('Transcribing…');
      const id = nextId++;
      return new Promise<string>((resolve) => { pending.set(id, resolve); worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]); });
    },
  };
  return self;
}

/** Web Speech API recogniser. One utterance per start()/stop(). */
export function createBrowserRecognizer(lang = 'en-US'): Recognizer | null {
  const Ctor = srConstructor();
  if (!Ctor) return null;
  let sr: SR | null = null;
  let finals: string[] = [];
  let interim = '';
  let ended: (() => void) | null = null;
  const self: Recognizer = {
    kind: 'browser',
    onPartial: null,
    onError: null,
    start() {
      try { sr?.abort(); } catch { /* not running */ }
      finals = []; interim = '';
      sr = new Ctor();
      sr.lang = lang; sr.continuous = true; sr.interimResults = true; sr.maxAlternatives = 1;
      sr.onresult = (e) => {
        interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finals[i] = r[0].transcript; else interim += r[0].transcript;
        }
        self.onPartial?.(`${finals.filter(Boolean).join(' ')} ${interim}`.trim());
      };
      sr.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') self.onError?.(e.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in the browser to talk.' : `Speech recognition error: ${e.error}`); };
      sr.onend = () => { ended?.(); ended = null; };
      try { sr.start(); } catch (err) { self.onError?.(String(err)); }
    },
    stop() {
      const cur = sr;
      if (!cur) return Promise.resolve('');
      return new Promise<string>((resolve) => {
        const finish = () => { resolve(`${finals.filter(Boolean).join(' ')} ${interim}`.replace(/\s+/g, ' ').trim()); };
        const timer = window.setTimeout(finish, 1200);          // never hang the command bar on a silent recogniser
        ended = () => { window.clearTimeout(timer); finish(); };
        try { cur.stop(); } catch { window.clearTimeout(timer); finish(); }
        sr = null;
      });
    },
  };
  return self;
}

/*
  Microphone capture for the on-device and server recognisers (ml/stt/RESULTS2.md "pre-roll").

  mic -> AudioWorklet (public/voice/capture-worklet.js) at 16 kHz -> Float32 frames. The microphone opens on the first
  push-to-talk and stays open for a minute after the last one, so later transmissions start instantly; while it is
  open the worklet keeps the last 0.3 s (pre-roll), which is prepended when recording starts. Release keeps
  recording for a short tail (250 ms) so the last syllable is not cut by a quick release, unless the speaker was
  already quiet for 200 ms. start(onAudio) also hands the frames over as they arrive (streaming, asr-stream.ts).

  Digital silence: one Windows Chrome delivered exact zeros through the 16 kHz context while Web Speech heard the
  speech (ml/data/gold v01-v04, 2026-11-09). A transmission of pure zeros moves this browser one step down a ladder,
  remembered in localStorage: 0 = 16 kHz context, 1 = the microphone's own rate (resampled here), 2 = that and no
  browser voice processing. Silent audio is never sent to a recogniser (Whisper invents words for it).
*/

export interface MicCapture {
  /** Start recording (opens the microphone the first time). Resolves once audio is flowing. `onAudio` receives the
   *  transmission as it is recorded (16 kHz, pre-roll first) for streaming recognition; only when the context runs at
   *  16 kHz (capture mode 0), otherwise it is never called and the caller sends the whole recording. */
  start(onAudio?: (pcm: Float32Array) => void): Promise<void>;
  /** Stop after `tailMs` (skipped when the last LOUD_GAP_MS were quiet: the speaker had already finished), return the
   *  utterance (16 kHz mono, pre-roll included). */
  stop(tailMs?: number): Promise<Float32Array>;
  /** The last stop(): the tail actually waited (ms). */
  readonly lastTailMs: number;
  /** The microphone is open (a transmission starts without delay). */
  readonly isOpen: boolean;
}

export function micCaptureAvailable(): boolean {
  return typeof window !== 'undefined' && typeof AudioWorkletNode !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

const RATE = 16000;

/** Pure digital silence (every sample below one 16-bit step): a broken capture path, not a quiet room. */
export function isSilent(a: Float32Array): boolean {
  if (a.length < RATE * 0.25) return false;
  for (let i = 0; i < a.length; i++) if (a[i] > 3e-5 || a[i] < -3e-5) return false;
  return true;
}

/** A frame louder than -40 dBFS (mean square) is speech for the release tail; quiet for LOUD_GAP_MS at release = done. */
const LOUD = 1e-4;
const LOUD_GAP_MS = 200;

const LADDER_KEY = 'atc-mic-mode';
const MAX_MODE = 2;
let mode = (() => { try { const v = Number(localStorage.getItem(LADDER_KEY)); return v >= 0 && v <= MAX_MODE ? Math.floor(v) : 0; } catch { return 0; } })();

/** What the last transmission's capture looked like (for the live-attempt log and the recorder). */
export interface MicInfo { mode: number; rate: number; ctxState: string; trackMuted: boolean | null; trackState: string | null; silent: boolean; peak: number; trackRate: number | null; next?: number }
let info: MicInfo | null = null;
export function micInfo(): MicInfo | null { return info; }

/** Box low-pass + linear decimation to 16 kHz (only when the browser will not run a 16 kHz AudioContext). */
function resample(x: Float32Array, from: number): Float32Array {
  if (from === RATE) return x;
  const r = from / RATE, n = Math.floor(x.length / r), out = new Float32Array(n), w = Math.max(1, Math.round(r));
  for (let i = 0; i < n; i++) { const c = Math.floor(i * r); let s = 0, k = 0; for (let j = c; j < c + w && j < x.length; j++) { s += x[j]; k++; } out[i] = k ? s / k : 0; }
  return out;
}

export function createMicCapture(opts: { preroll?: number; idleCloseMs?: number } = {}): MicCapture {
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let stream: MediaStream | null = null;
  // one session per transmission: frames go to the current one, so a quick re-press during the previous release
  // tail starts a fresh utterance instead of clearing (and then cutting) it
  let cur: { chunks: Float32Array[]; onAudio?: (pcm: Float32Array) => void; lastLoud: number } | null = null;
  let lastTailMs = 0;
  let idleTimer: number | null = null;
  let starting: Promise<void> | null = null;
  let rate = RATE;
  let src: MediaStreamAudioSourceNode | null = null;   // held: a collected source node goes quiet

  const shut = () => { stream?.getTracks().forEach((t) => t.stop()); void ctx?.close(); ctx = null; node = null; stream = null; src = null; };
  const open = async () => {
    if (ctx && node) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: mode >= 2 ? true : { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try { ctx = mode >= 1 ? new AudioContext() : new AudioContext({ sampleRate: RATE }); src = ctx.createMediaStreamSource(stream); }
    catch { void ctx?.close(); ctx = new AudioContext(); src = ctx.createMediaStreamSource(stream); }   // Firefox: no resampling source
    rate = ctx.sampleRate;
    await ctx.audioWorklet.addModule('/voice/capture-worklet.js');
    node = new AudioWorkletNode(ctx, 'atc-capture', { processorOptions: { preroll: opts.preroll ?? 0.3 } });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const c = cur, f = e.data; if (!c) return;
      c.chunks.push(f);
      let p = 0; for (let i = 0; i < f.length; i++) p += f[i] * f[i];
      if (p / f.length > LOUD) c.lastLoud = performance.now();
      if (c.onAudio && rate === RATE) c.onAudio(f);
    };
    src.connect(node);
  };
  const closeSoon = () => {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(shut, opts.idleCloseMs ?? 60000);
  };

  return {
    get isOpen() { return !!(ctx && node); },
    get lastTailMs() { return lastTailMs; },
    start(onAudio?: (pcm: Float32Array) => void) {
      cur = { chunks: [], onAudio, lastLoud: 0 };
      if (idleTimer) window.clearTimeout(idleTimer);
      starting = open().then(async () => { await ctx?.resume(); node?.port.postMessage({ recording: true }); });
      return starting;
    },
    async stop(tailMs = 250) {
      const mine = cur;
      try { await starting; } catch { return new Float32Array(0); }
      // the release tail only when the speaker may still be finishing a word (loud within the last LOUD_GAP_MS)
      if (mine && performance.now() - mine.lastLoud > LOUD_GAP_MS) tailMs = 0;
      lastTailMs = tailMs;
      if (tailMs > 0) await new Promise((r) => window.setTimeout(r, tailMs));
      // a new transmission started during the tail: it owns the worklet now, so only this one's frames are taken
      if (cur === mine) {
        node?.port.postMessage({ recording: false });
        closeSoon();
        await new Promise((r) => window.setTimeout(r, 40));   // the worklet's last frames (one every 8 ms)
        cur = null;
      }
      const chunks = mine?.chunks ?? [];
      const n = chunks.reduce((s, c) => s + c.length, 0);
      const audio = new Float32Array(n); let o = 0; for (const c of chunks) { audio.set(c, o); o += c.length; }
      const out = resample(audio, rate);
      const track = stream?.getAudioTracks()[0];
      let peak = 0; for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > peak) peak = v; }
      const silent = isSilent(out);
      info = { mode, rate, ctxState: ctx?.state ?? 'closed', trackMuted: track ? track.muted : null, trackState: track?.readyState ?? null, silent,
        peak: Math.round(peak * 1e4) / 1e4, trackRate: track?.getSettings?.().sampleRate ?? null };
      // pure zeros: rebuild one step down the ladder for the next transmission (unless a new one already owns it)
      if (silent && mode < MAX_MODE && cur === null) {
        mode++; info.next = mode;
        try { localStorage.setItem(LADDER_KEY, String(mode)); } catch { /* private mode */ }
        if (idleTimer) window.clearTimeout(idleTimer);
        shut();
      }
      return out;
    },
  };
}

/** 16-bit little-endian PCM bytes (what /api/voice/stt takes as audio/l16). */
export function toPcm16(audio: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(audio.length * 2));
  for (let i = 0; i < audio.length; i++) { const s = Math.max(-1, Math.min(1, audio[i])); out.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true); }
  return out.buffer;
}

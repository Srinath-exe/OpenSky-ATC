// ============================================================
//  Neural pilot voices (ml/tts/RESULTS.md): Paradee-8M v1.2 in a Web Worker (public/voice/tts-worker.js), played
//  through WebAudio with a VHF radio effect. Used by sound.ts when "Pilot voices" is Neural.
//
//    text --speakableAtc--> words --speechChunks--> clauses --worker (G2P + Paradee)--> 24 kHz PCM --radio--> master
//
//  - Lazy: the worker and the ~12 MB of model + runtime load on the first line, never before.
//  - Each callsign keeps one voice, rate and pitch (voiceFor: hash of the callsign).
//  - One line at a time, clauses back to back (the first clause plays while the rest is synthesised). At most two
//    lines wait behind the one playing (or about to); older waiting lines are dropped, a line that could not start
//    within 12 s is dropped, and a line queued behind others is read a little faster (8 % per line ahead, up to 24 %).
//  - If the model cannot load, state becomes 'failed' and sound.ts falls back to speechSynthesis.
//  Browser-only; nothing runs at import.
// ============================================================
import { speakableAtc, speechChunks, voiceFor } from '../../lib/tts/pilotSpeech';
import type { PhraseVariant } from '../../lib/sim/phraseology';

export type NeuralState = 'idle' | 'loading' | 'ready' | 'failed';

interface Chunk { id: number; buf: AudioBuffer | null; failed: boolean; sentAt: number; synthMs?: number }
interface Line { chunks: Chunk[]; detune: number; at: number; next: number; stat: NeuralLineStat }

/** Per-line timings of the last lines (tests and the report read them through sound.neuralStats()). */
export interface NeuralLineStat { text: string; voice: string; chunks: number; firstChunkMs: number; synthMs: number; audioS: number; dropped?: boolean }

const MAX_WAITING = 2;
const STALE_MS = 12_000;
const LOAD_TIMEOUT_MS = 90_000;
const LINE_GAP_S = 0.3;
const CLAUSE_GAP_S = 0.06;

export class NeuralPilotVoice {
  state: NeuralState = 'idle';
  error = '';
  readonly stats: NeuralLineStat[] = [];

  private worker: Worker | null = null;
  private seq = 0;
  private chunkOf = new Map<number, { line: Line; chunk: Chunk }>();
  private queue: Line[] = [];
  private current: Line | null = null;
  private cursor = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private loadWaiters: ((ok: boolean) => void)[] = [];
  private chain: { input: GainNode; noise: GainNode } | null = null;
  private noiseBuf: AudioBuffer | null = null;

  constructor(private audio: () => { ctx: AudioContext; out: AudioNode } | null) {}

  /** Start loading (idempotent). Resolves true when the model is ready, false if it failed. */
  load(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.state === 'failed') return Promise.resolve(false);
    const p = new Promise<boolean>((res) => this.loadWaiters.push(res));
    if (this.state === 'loading') return p;
    if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') { this.fail('no Worker / WebAssembly'); return p; }
    this.state = 'loading';
    try {
      this.worker = new Worker('/voice/tts-worker.js', { type: 'module' });
    } catch (e) { this.fail(String(e)); return p; }
    const timer = setTimeout(() => { if (this.state === 'loading') this.fail('load timed out'); }, LOAD_TIMEOUT_MS);
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    this.worker.onerror = (e) => { clearTimeout(timer); this.fail(e.message || 'worker error'); };   // a dead worker: fall back for good
    this.worker.postMessage({ type: 'load', id: ++this.seq });
    p.then(() => clearTimeout(timer));
    return p;
  }

  /** Queue a pilot line. False when it cannot be played now (not ready, or audio locked): the caller falls back. */
  say(text: string, callsign: string | undefined, variant: PhraseVariant = 'ICAO'): boolean {
    if (this.state !== 'ready' || !this.worker) return false;
    const a = this.audio(); if (!a || a.ctx.state !== 'running') return false;
    const words = speakableAtc(text, variant);
    const parts = speechChunks(words);
    if (!parts.length) return true;
    const pv = voiceFor(callsign || text.split(/[ ,]/)[0] || '');
    const backlog = this.queue.length + (this.current ? 1 : 0);
    const speed = Math.round(pv.speed * (1 + 0.08 * Math.min(3, backlog)) * 1000) / 1000;   // stacked lines: read faster
    const stat: NeuralLineStat = { text: words, voice: pv.voice, chunks: parts.length, firstChunkMs: -1, synthMs: 0, audioS: 0 };
    const line: Line = { chunks: [], detune: pv.detune, at: now(), next: 0, stat };
    for (const t of parts) {
      const id = ++this.seq;
      const chunk: Chunk = { id, buf: null, failed: false, sentAt: now() };
      line.chunks.push(chunk);
      this.chunkOf.set(id, { line, chunk });
      this.worker.postMessage({ type: 'speak', id, text: t, voice: pv.voice, speed });
    }
    this.stats.push(stat);
    if (this.stats.length > 40) this.stats.splice(0, this.stats.length - 40);
    this.queue.push(line);
    // too many waiting: drop the oldest, but never the line about to start (its first clause is being synthesised)
    const keep = MAX_WAITING + (this.current ? 0 : 1);
    while (this.queue.length > keep) this.drop(this.queue.splice(this.current ? 0 : 1, 1)[0]);
    this.pump();
    return true;
  }

  /** Silence everything queued (setting off, sound off, session reset). Lines already sounding finish their clause. */
  stop(): void {
    for (const l of this.queue) this.drop(l);
    this.queue = [];
    if (this.current && this.current.next < this.current.chunks.length) {
      for (const c of this.current.chunks.slice(this.current.next)) this.cancelChunk(c);
      this.scheduleReady();                                          // closes the line (squelch tail) so the queue moves on
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────
  private fail(msg: string): void {
    this.state = 'failed'; this.error = msg;
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
    for (const w of this.loadWaiters.splice(0)) w(false);
    this.queue = []; this.current = null;
  }

  private onMessage(m: { type: string; id: number; pcm?: Float32Array; sr?: number; ms?: number; message?: string }): void {
    if (m.type === 'ready') { this.state = 'ready'; for (const w of this.loadWaiters.splice(0)) w(true); return; }
    if (m.type === 'error' && this.state === 'loading') { this.fail(m.message || 'load failed'); return; }
    const ref = this.chunkOf.get(m.id);
    if (!ref) return;                                                // cancelled or dropped
    this.chunkOf.delete(m.id);
    const { chunk, line } = ref;
    if (m.type === 'audio' && m.pcm) {
      chunk.synthMs = now() - chunk.sentAt;
      chunk.buf = this.toBuffer(m.pcm, m.sr ?? 24000, line.stat.voice);
      if (!chunk.buf) chunk.failed = true;
      line.stat.synthMs += m.ms ?? 0; line.stat.audioS += m.pcm.length / (m.sr ?? 24000);
    } else chunk.failed = true;
    if (line === this.current) this.scheduleReady(); else this.pump();
  }

  /** Trim the model's leading / trailing near-silence, as an AudioBuffer at one level per voice (af_heart comes out
   *  about 4 dB quieter than the others), never above -0.5 dBFS. Clauses of a line keep the same gain. */
  private toBuffer(pcm: Float32Array, sr: number, voice: string): AudioBuffer | null {
    const a = this.audio(); if (!a || !pcm.length) return null;
    let peak = 0; for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 1e-4) return null;
    const thr = peak * 0.02;
    let s = 0, e = pcm.length - 1;
    while (s < e && Math.abs(pcm[s]) < thr) s++;
    while (e > s && Math.abs(pcm[e]) < thr) e--;
    s = Math.max(0, s - Math.round(sr * 0.02)); e = Math.min(pcm.length - 1, e + Math.round(sr * 0.05));
    const n = e - s + 1, g = Math.min(voice === 'af_heart' ? 1.6 : 1.0, 0.95 / peak);
    const buf = a.ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = pcm[s + i] * g;
    return buf;
  }

  private cancelChunk(c: Chunk): void {
    if (!c.buf && !c.failed && this.chunkOf.has(c.id)) { this.worker?.postMessage({ type: 'cancel', id: c.id }); this.chunkOf.delete(c.id); }
    c.failed = true;
  }

  private drop(l: Line): void {
    for (const c of l.chunks) this.cancelChunk(c);
    l.stat.dropped = true;
  }

  private pump(): void {
    if (this.current) return;
    while (this.queue.length && now() - this.queue[0].at > STALE_MS) this.drop(this.queue.shift()!);
    const l = this.queue[0];
    if (!l) return;
    const first = l.chunks[0];
    if (!first.buf && !first.failed) return;                         // wait for its first clause
    this.queue.shift();
    const a = this.audio(); if (!a) return;
    this.current = l;
    this.cursor = Math.max(a.ctx.currentTime + 0.03, this.cursor);
    l.stat.firstChunkMs = Math.round(now() - l.at);
    this.squelch(this.cursor, 0.035, 0.012);
    this.cursor += 0.04;
    this.scheduleReady();
  }

  private scheduleReady(): void {
    const l = this.current, a = this.audio(); if (!l || !a) return;
    const chain = this.radio(a.ctx, a.out);
    const rate = Math.pow(2, l.detune / 1200);
    while (l.next < l.chunks.length) {
      const c = l.chunks[l.next];
      if (c.failed) { l.next++; continue; }
      if (!c.buf) return;                                            // the next clause is still being synthesised
      const at = Math.max(this.cursor, a.ctx.currentTime + 0.02);
      try {
        const src = a.ctx.createBufferSource();
        src.buffer = c.buf; src.detune.value = l.detune;
        src.connect(chain.input);
        src.start(at);
        src.onended = () => { try { src.disconnect(); } catch { /* ignore */ } };
        this.hiss(at, c.buf.duration / rate);
      } catch { /* ignore */ }
      this.cursor = at + c.buf.duration / rate + (l.next < l.chunks.length - 1 ? CLAUSE_GAP_S : 0);
      l.next++;
    }
    // the whole line is scheduled: squelch tail, then the next line after a short gap
    this.squelch(this.cursor, 0.09, 0.04);
    const end = this.cursor + 0.1 + LINE_GAP_S;
    this.cursor = end;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => { this.endTimer = null; this.current = null; this.pump(); }, Math.max(0, (end - a.ctx.currentTime) * 1000));
  }

  /** Band-pass 300-3400 Hz (two high-pass + two low-pass biquads), soft clip, light compression. Built once. */
  private radio(ctx: AudioContext, out: AudioNode): { input: GainNode; noise: GainNode } {
    if (this.chain) return this.chain;
    const input = ctx.createGain(); input.gain.value = 0.9;
    const bq = (type: BiquadFilterType, f: number) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = 0.7071; return b; };
    const hp1 = bq('highpass', 300), hp2 = bq('highpass', 300), lp1 = bq('lowpass', 3400), lp2 = bq('lowpass', 3400);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024); const k = 2.5;
    for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
    shaper.curve = curve; shaper.oversample = '2x';
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.15;
    const gain = ctx.createGain(); gain.gain.value = 0.85;
    const noise = ctx.createGain(); noise.gain.value = 1;
    input.connect(hp1); noise.connect(hp1); hp1.connect(hp2); hp2.connect(lp1); lp1.connect(lp2); lp2.connect(shaper); shaper.connect(comp); comp.connect(gain); gain.connect(out);
    this.chain = { input, noise };
    return this.chain;
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf;
    const n = ctx.sampleRate, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    let seed = 0x2545f491;
    for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = (seed / 4294967296) * 2 - 1; }
    this.noiseBuf = buf;
    return buf;
  }

  /** Faint band-limited hiss under the speech (about -34 dB). */
  private hiss(at: number, dur: number): void {
    const a = this.audio(); if (!a) return;
    try {
      const src = a.ctx.createBufferSource(); src.buffer = this.noiseBuffer(a.ctx); src.loop = true;
      const g = a.ctx.createGain(); g.gain.value = 0.02;
      src.connect(g); g.connect(this.radio(a.ctx, a.out).noise);
      src.start(at, Math.random() * 0.5); src.stop(at + dur + CLAUSE_GAP_S);
      src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }

  /** Squelch: a short noise burst, exponentially decaying (open at the start of a line, the tail at its end). */
  private squelch(at: number, dur: number, decay: number): void {
    const a = this.audio(); if (!a) return;
    try {
      const src = a.ctx.createBufferSource(); src.buffer = this.noiseBuffer(a.ctx);
      const g = a.ctx.createGain();
      g.gain.setValueAtTime(0.3, at); g.gain.setTargetAtTime(0.0001, at, decay);
      src.connect(g); g.connect(this.radio(a.ctx, a.out).noise);
      src.start(at, Math.random() * 0.5); src.stop(at + dur);
      src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

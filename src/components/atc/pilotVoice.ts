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
//  - The first clause is kept short (speechChunks: cut after the pilot's callsign or at an early comma), since it is
//    what the player waits for.
//  - prefetch(): a readback's text is known when the controller transmits, seconds before the pilot answers
//    (engine pilotDelayS: 2-4 s airborne, 4-8 s on the ground), so it is synthesised then and say() finds it ready.
//  - If the model cannot load, state becomes 'failed' and sound.ts falls back to speechSynthesis.
//  Browser-only; nothing runs at import.
// ============================================================
import { speakableAtc, speechChunks, voiceFor } from '../../lib/tts/pilotSpeech';
import type { PhraseVariant } from '../../lib/sim/phraseology';

export type NeuralState = 'idle' | 'loading' | 'ready' | 'failed';

interface Chunk { id: number; buf: AudioBuffer | null; failed: boolean; sentAt: number; synthMs?: number; modelMs?: number; readyAt?: number }
interface Line { chunks: Chunk[]; detune: number; at: number; next: number; stat: NeuralLineStat; hooks?: LineHooks; ended?: boolean }

/** Per-line timing (performance.now() milliseconds), for latency pages and tests: say(text, callsign, variant, hooks). */
export interface LineStart {
  calledAt: number;        // say() was called
  startedAt: number;       // the first clause's speech starts playing (AudioContext time, output latency included; the squelch opens 40 ms before)
  firstChunkMs: number;    // startedAt - calledAt: what the listener waits
  firstReadyMs: number;    // say() -> the first clause's audio was ready (0 when prefetched and done)
  firstSynthMs: number;    // the worker's inference time for the first clause
  prefetched: boolean;     // the first clause came from prefetch()
}
export interface LineEnd { endedAt: number; synthMs: number; audioS: number; chunks: number }
export interface LineHooks { onStart?: (t: LineStart) => void; onEnd?: (t: LineEnd) => void }

/** Per-line timings of the last lines (tests and the report read them through sound.neuralStats()). */
export interface NeuralLineStat { text: string; voice: string; chunks: number; firstChunkMs: number; synthMs: number; audioS: number; dropped?: boolean; prefetched?: number }

const MAX_WAITING = 2;
const STALE_MS = 12_000;
const LOAD_TIMEOUT_MS = 90_000;
const LINE_GAP_S = 0.3;
const CLAUSE_GAP_S = 0.06;
const PREFETCH_TTL_MS = 60_000;
const PREFETCH_MAX = 12;   // clauses

/** A clause synthesised ahead of its line (prefetch): in flight (`pcm` null) or done. */
interface Prefetched { id: number; at: number; pcm: Float32Array | null; sr: number; ms: number; failed: boolean }

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
  private prefetched = new Map<string, Prefetched>();   // key: voice|speed|clause
  private prefetchIds = new Map<number, string>();

  /** The clauses a line is read as, with its voice and speed (say() and prefetch() must agree). */
  private plan(text: string, callsign: string | undefined, variant: PhraseVariant, backlog: number) {
    const words = speakableAtc(text, variant);
    const lead = callsign ? speakableAtc(callsign, variant) : undefined;
    const parts = speechChunks(words, undefined, undefined, lead);
    const pv = voiceFor(callsign || text.split(/[ ,]/)[0] || '');
    const speed = Math.round(pv.speed * (1 + 0.08 * Math.min(3, backlog)) * 1000) / 1000;   // stacked lines: read faster
    return { words, parts, pv, speed, key: (t: string) => `${pv.voice}|${speed}|${t}` };
  }

  /** Synthesise a line that will be said soon (a readback the pilot answers with in a few seconds), at the speed of an
   *  idle channel. say() with the same text, callsign and variant uses it; unused clauses expire. */
  prefetch(text: string, callsign: string | undefined, variant: PhraseVariant = 'ICAO'): void {
    if (this.state !== 'ready' || !this.worker) return;
    const t = now();
    for (const [k, p] of this.prefetched) if (t - p.at > PREFETCH_TTL_MS) this.forget(k, p);
    const { parts, pv, speed, key } = this.plan(text, callsign, variant, 0);
    for (const part of parts) {
      const k = key(part);
      if (this.prefetched.has(k)) continue;
      while (this.prefetched.size >= PREFETCH_MAX) { const [ok, op] = this.prefetched.entries().next().value as [string, Prefetched]; this.forget(ok, op); }
      const id = ++this.seq;
      this.prefetched.set(k, { id, at: t, pcm: null, sr: 24000, ms: 0, failed: false });
      this.prefetchIds.set(id, k);
      this.worker.postMessage({ type: 'speak', id, text: part, voice: pv.voice, speed });
    }
  }

  private forget(k: string, p: Prefetched): void {
    this.prefetched.delete(k); this.prefetchIds.delete(p.id);
    if (!p.pcm && !p.failed) this.worker?.postMessage({ type: 'cancel', id: p.id });   // not started yet: skip it
  }

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
  say(text: string, callsign: string | undefined, variant: PhraseVariant = 'ICAO', hooks?: LineHooks): boolean {
    if (this.state !== 'ready' || !this.worker) return false;
    const a = this.audio(); if (!a || a.ctx.state !== 'running') return false;
    const backlog = this.queue.length + (this.current ? 1 : 0);
    const { words, parts, pv, speed, key } = this.plan(text, callsign, variant, backlog);
    if (!parts.length) return true;
    const stat: NeuralLineStat = { text: words, voice: pv.voice, chunks: parts.length, firstChunkMs: -1, synthMs: 0, audioS: 0 };
    const line: Line = { chunks: [], detune: pv.detune, at: now(), next: 0, stat, hooks };
    for (const t of parts) {
      const pre = this.prefetched.get(key(t));
      if (pre) {                                                     // synthesised ahead (prefetch): done or in flight
        this.prefetched.delete(key(t)); this.prefetchIds.delete(pre.id);
        const chunk: Chunk = { id: pre.id, buf: null, failed: pre.failed, sentAt: pre.at, ...(pre.pcm ? { readyAt: line.at } : {}) };
        line.chunks.push(chunk);
        stat.prefetched = (stat.prefetched ?? 0) + 1;
        if (pre.pcm) this.fill(chunk, line, pre.pcm, pre.sr, pre.ms);
        else if (!pre.failed) this.chunkOf.set(pre.id, { line, chunk });
        continue;
      }
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
    for (const [k, p] of [...this.prefetched]) this.forget(k, p);
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
    this.prefetched.clear(); this.prefetchIds.clear();
  }

  private onMessage(m: { type: string; id: number; pcm?: Float32Array; sr?: number; ms?: number; message?: string }): void {
    if (m.type === 'ready') { this.state = 'ready'; for (const w of this.loadWaiters.splice(0)) w(true); return; }
    if (m.type === 'error' && this.state === 'loading') { this.fail(m.message || 'load failed'); return; }
    const pk = this.prefetchIds.get(m.id);
    if (pk) {                                                        // a prefetched clause no line has claimed yet
      this.prefetchIds.delete(m.id);
      const p = this.prefetched.get(pk);
      if (p) { if (m.type === 'audio' && m.pcm) { p.pcm = m.pcm; p.sr = m.sr ?? 24000; p.ms = m.ms ?? 0; } else p.failed = true; }
      return;
    }
    const ref = this.chunkOf.get(m.id);
    if (!ref) return;                                                // cancelled or dropped
    this.chunkOf.delete(m.id);
    const { chunk, line } = ref;
    if (m.type === 'audio' && m.pcm) this.fill(chunk, line, m.pcm, m.sr ?? 24000, m.ms ?? 0);
    else { chunk.failed = true; if (line === this.current) this.scheduleReady(); else this.pump(); }
  }

  /** A clause's audio arrived (or was prefetched): buffer it and play what can play. */
  private fill(chunk: Chunk, line: Line, pcm: Float32Array, sr: number, ms: number): void {
    chunk.synthMs = now() - chunk.sentAt; chunk.modelMs = ms; chunk.readyAt = Math.max(chunk.readyAt ?? now(), line.at);
    chunk.buf = this.toBuffer(pcm, sr, line.stat.voice);
    if (!chunk.buf) chunk.failed = true;
    line.stat.synthMs += ms; line.stat.audioS += pcm.length / sr;
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
      if (l.next === 0 && l.hooks?.onStart) {
        const startedAt = this.perfAt(a.ctx, at);
        try { l.hooks.onStart({ calledAt: l.at, startedAt, firstChunkMs: startedAt - l.at, firstReadyMs: (c.readyAt ?? l.at) - l.at, firstSynthMs: c.modelMs ?? 0, prefetched: c.sentAt < l.at }); } catch { /* caller's problem */ }
      }
      this.cursor = at + c.buf.duration / rate + (l.next < l.chunks.length - 1 ? CLAUSE_GAP_S : 0);
      l.next++;
    }
    // the whole line is scheduled: squelch tail, then the next line after a short gap
    if (!l.ended) {
      l.ended = true;
      try { l.hooks?.onEnd?.({ endedAt: this.perfAt(a.ctx, this.cursor), synthMs: l.stat.synthMs, audioS: l.stat.audioS, chunks: l.chunks.length }); } catch { /* caller's problem */ }
    }
    this.squelch(this.cursor, 0.09, 0.04);
    const end = this.cursor + 0.1 + LINE_GAP_S;
    this.cursor = end;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => { this.endTimer = null; this.current = null; this.pump(); }, Math.max(0, (end - a.ctx.currentTime) * 1000));
  }

  /** AudioContext time -> performance.now() ms (getOutputTimestamp includes the output latency). */
  private perfAt(ctx: AudioContext, t: number): number {
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime != null && ts.performanceTime != null && ts.performanceTime > 0) return ts.performanceTime + (t - ts.contextTime) * 1000;
    return now() + (t - ctx.currentTime) * 1000;
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

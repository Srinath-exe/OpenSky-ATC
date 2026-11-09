/*
  Streaming push-to-talk for /api/voice/stt/stream (pure logic, no Next imports; route in ./stream/route.ts).

  The browser sends the transmission while it is being spoken, ~0.3 s at a time. A phrase that ends in a pause
  ("Speedbird 327 ... climb flight level 80") is transcribed by Parakeet straight away, while the controller is still
  talking; when the button is let go only the last phrase is left to transcribe, and the phrases are joined. Without
  this, recording, upload and the whole-transmission decode all start at release (~1 s).

  Pauses: a 20 ms energy detector. The noise floor is the 10th percentile of every frame's level so far (pre-roll and
  pauses), speech starts SPEECH_DB above it and only ends below QUIET_DB above it (hysteresis, so the soft end of a word
  is not a pause). A phrase is cut in the middle of a pause of PAUSE_MS after at least MIN_SPEECH_MS of speech, never
  shorter than MIN_SEG_S; the last phrase is always decoded. If the joined text is not understood the client asks for
  the whole recording again (asr-server.ts).
*/

export const STREAM_LIMITS = { maxSeconds: 15, maxChunkBytes: 64_000, maxSessions: 64, idleMs: 20_000, sessionsPerMinute: 20 };

const RATE = 16000;
const FRAME = 320;            // 20 ms
const PAUSE_MS = 350;         // silence that ends a phrase
const SPEECH_DB = 14;         // speech starts this far above the noise floor
const QUIET_DB = 7;           // ... and continues until it drops below this
const MIN_SPEECH_MS = 300;    // speech needed before a pause counts
const MIN_SEG_S = 0.8;        // shorter phrases wait for the next one

export type Transcribe = (audio: Float32Array, names: string[]) => Promise<{ text: string; ms: number; model: string }>;

interface Segment { start: number; end: number; text: string | null; ms: number; done: Promise<void> }

export interface StreamFinal {
  text: string; alternatives: string[]; model: string | null;
  /** phrases decoded; seconds of audio; model time of every phrase; model time after the last chunk arrived */
  segments: number; sec: number; modelMs: number; tailModelMs: number; waitMs: number;
  /** phrases whose decode failed (the client then sends the whole recording) */
  failed: number;
}

export class SttStream {
  private bufs: Float32Array[] = [];
  private n = 0;                  // samples received
  private scanned = 0;            // samples run through the pause detector
  private cut = 0;                // start of the phrase being spoken
  private hist = new Uint32Array(200);   // frame levels, 0.5 dB bins from -100 dBFS
  private frames = 0;
  private inSpeech = false;
  private speechRun = 0;          // ms of speech since `cut`
  private silentRun = 0;          // ms of silence after the last speech frame
  private segs: Segment[] = [];
  private model: string | null = null;
  lastSeen = Date.now();
  seq = 0;
  /** why phrases failed (the route logs them) */
  readonly errors: string[] = [];
  ended = false;

  constructor(private names: string[], private transcribe: Transcribe) {}

  get seconds(): number { return this.n / RATE; }

  /** Text of the phrases finished so far (for the live display). */
  partial(): string { return this.segs.filter((s) => s.text).map((s) => s.text).join(' ').trim(); }

  push(pcm: Float32Array): void {
    this.lastSeen = Date.now();
    if (!pcm.length || this.ended) return;
    const room = STREAM_LIMITS.maxSeconds * RATE - this.n;
    if (room <= 0) return;
    const add = pcm.length > room ? pcm.subarray(0, room) : pcm;
    this.bufs.push(add); this.n += add.length;
    this.scan();
  }

  /** The button was let go: decode what is left, wait for every phrase, join. */
  async end(): Promise<StreamFinal> {
    this.ended = true; this.lastSeen = Date.now();
    const t0 = Date.now();
    const tail = this.n - this.cut;
    let tailSeg: Segment | null = null;
    // the last phrase, always (a missed word costs more than decoding a bit of silence)
    if (tail >= 0.2 * RATE || (tail > 0 && this.segs.length === 0)) tailSeg = this.decode(this.cut, this.n);
    await Promise.all(this.segs.map((s) => s.done));
    const text = this.partial();
    return {
      text, alternatives: text ? [text] : [], model: this.model, segments: this.segs.length, sec: +(this.n / RATE).toFixed(2),
      modelMs: this.segs.reduce((a, s) => a + s.ms, 0), tailModelMs: tailSeg?.ms ?? 0, waitMs: Date.now() - t0, failed: this.errors.length,
    };
  }

  /** The whole recording (the client's fallback asks for it through /api/voice/stt instead; kept for tests). */
  audio(): Float32Array {
    const out = new Float32Array(this.n); let o = 0;
    for (const b of this.bufs) { out.set(b, o); o += b.length; }
    return out;
  }

  private sample(i: number): number {
    // bufs are appended in order; find the buffer holding sample i (frames are scanned forwards, so walk from a cursor)
    let o = this.cursorOff, k = this.cursorBuf;
    if (i < o) { o = 0; k = 0; }
    while (k < this.bufs.length && i >= o + this.bufs[k].length) { o += this.bufs[k].length; k++; }
    this.cursorOff = o; this.cursorBuf = k;
    return this.bufs[k][i - o];
  }
  private cursorOff = 0;
  private cursorBuf = 0;

  private scan(): void {
    while (this.scanned + FRAME <= this.n) {
      let e = 0;
      for (let i = this.scanned; i < this.scanned + FRAME; i++) { const v = this.sample(i); e += v * v; }
      const db = 10 * Math.log10(e / FRAME + 1e-12);
      this.hist[Math.max(0, Math.min(199, Math.floor((db + 100) * 2)))]++; this.frames++;
      const noise = this.noiseFloor();
      this.inSpeech = this.inSpeech ? db > noise + QUIET_DB : db > Math.max(noise + SPEECH_DB, -60);
      const speech = this.inSpeech;
      this.scanned += FRAME;
      if (speech) { this.speechRun += 20; this.silentRun = 0; continue; }
      this.silentRun += 20;
      if (this.silentRun >= PAUSE_MS && this.speechRun >= MIN_SPEECH_MS) {
        const at = this.scanned - Math.round((this.silentRun / 2 / 1000) * RATE);   // the middle of the pause
        if ((at - this.cut) / RATE >= MIN_SEG_S) {
          this.decode(this.cut, at);
          this.cut = at; this.speechRun = 0;
        }
      }
    }
  }

  /** 10th percentile of the frame levels so far (-70 dBFS until there are 10 frames). */
  private noiseFloor(): number {
    if (this.frames < 10) return -70;
    let k = Math.ceil(this.frames * 0.1);
    for (let b = 0; b < 200; b++) { k -= this.hist[b]; if (k <= 0) return b / 2 - 100; }
    return -70;
  }

  private decode(start: number, end: number): Segment {
    const audio = new Float32Array(end - start);
    for (let i = start; i < end; i++) audio[i - start] = this.sample(i);
    const seg: Segment = { start, end, text: null, ms: 0, done: Promise.resolve() };
    seg.done = this.transcribe(audio, this.names)
      .then((r) => { seg.text = r.text.trim().replace(/[.?!]+$/, ''); seg.ms = r.ms; this.model = r.model; })
      .catch((e) => { seg.text = ''; this.errors.push(e instanceof Error ? e.message : String(e)); });
    this.segs.push(seg);
    return seg;
  }
}

/** Live sessions by id, dropped after STREAM_LIMITS.idleMs without a chunk. */
export class StreamStore {
  private map = new Map<string, SttStream>();
  get(id: string): SttStream | undefined { this.sweep(); return this.map.get(id); }
  create(id: string, s: SttStream): boolean {
    this.sweep();
    if (this.map.size >= STREAM_LIMITS.maxSessions) return false;
    this.map.set(id, s); return true;
  }
  delete(id: string): void { this.map.delete(id); }
  private sweep(): void {
    const now = Date.now();
    for (const [k, s] of this.map) if (now - s.lastSeen > STREAM_LIMITS.idleMs) this.map.delete(k);
  }
}

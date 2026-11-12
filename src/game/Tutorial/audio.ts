'use client'
/*
  The tutorial's sound (files from scripts/learn_audio.mjs, made with ElevenLabs): the narrator and the radio voices
  (with word timings for synced captions), effects, and a music bed that ducks under the voice. Web Audio, unlocked by
  the player's first click. Radio lines go through a band-pass and a little grit, with a squelch either side.
*/
const BASE = '/learn/audio'

export interface LineInfo { dur: number; radio: boolean; words: Array<[string, number, number]> }
interface Index { lines: Record<string, LineInfo>; sfx: Record<string, { loop: boolean }>; music: Record<string, unknown> }
export interface Playing { id: string; start: number; dur: number; stop: () => void }

const MUTE_KEY = 'atc.tutor.muted'

class Sound {
  ctx: AudioContext | null = null
  index: Index | null = null
  private bufs = new Map<string, Promise<AudioBuffer | null>>()
  private master!: GainNode
  private musicBus!: GainNode
  private voBus!: GainNode
  private sfxBus!: GainNode
  analyser: AnalyserNode | null = null
  private loops = new Map<string, AudioBufferSourceNode>()
  private voCount = 0
  muted = false
  private listeners = new Set<() => void>()

  constructor() { if (typeof window !== 'undefined') try { this.muted = localStorage.getItem(MUTE_KEY) === '1' } catch { /* private mode */ } }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }

  async loadIndex(): Promise<Index | null> {
    if (this.index) return this.index
    try { this.index = await (await fetch(`${BASE}/index.json`)).json() } catch { this.index = null }
    return this.index
  }
  line(id: string): LineInfo | null { return this.index?.lines[id] ?? null }

  /** Call from a click: makes the audio graph. */
  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AC(); this.ctx = ctx
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 1; this.master.connect(ctx.destination)
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.55; this.musicBus.connect(this.master)
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 0.8; this.sfxBus.connect(this.master)
    this.voBus = ctx.createGain(); this.voBus.gain.value = 1
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = 0.6
    this.voBus.connect(this.analyser); this.voBus.connect(this.master)
  }
  get now(): number { return this.ctx?.currentTime ?? 0 }

  setMuted(m: boolean): void {
    this.muted = m; try { localStorage.setItem(MUTE_KEY, m ? '1' : '0') } catch { /* */ }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05)
    for (const l of this.listeners) l()
  }

  private buffer(file: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx; if (!ctx) return Promise.resolve(null)
    let p = this.bufs.get(file)
    if (!p) { p = fetch(`${BASE}/${file}`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).catch(() => null); this.bufs.set(file, p) }
    return p
  }
  /** Fetch and decode ahead (after unlock). */
  preload(ids: string[]): void { for (const id of ids) void this.buffer(this.fileOf(id)) }
  private fileOf(id: string): string { return id.startsWith('sfx:') ? `sfx-${id.slice(4)}.mp3` : id.startsWith('music:') ? `music-${id.slice(6)}.mp3` : `${id}.mp3` }

  /** A voice line, now or at a context time; radio lines get the radio sound. The music ducks under it. */
  async say(id: string, at = 0): Promise<Playing | null> {
    const ctx = this.ctx; if (!ctx) return null
    const b = await this.buffer(`${id}.mp3`); if (!b) return null
    const info = this.line(id)
    const start = Math.max(ctx.currentTime + 0.02, at || 0)
    const src = ctx.createBufferSource(); src.buffer = b
    let tail: AudioNode = src
    if (info?.radio) {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 420
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2900
      const sh = ctx.createWaveShaper(); const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(x * 2.2) } sh.curve = curve
      const g = ctx.createGain(); g.gain.value = 0.9
      src.connect(hp); hp.connect(lp); lp.connect(sh); sh.connect(g); tail = g
      void this.sfx('squelch', start - 0.12, 0.5); void this.sfx('squelch', start + b.duration + 0.02, 0.4)
    }
    tail.connect(this.voBus)
    src.start(start)
    this.duck(start, start + b.duration)
    return { id, start, dur: b.duration, stop: () => { try { src.stop() } catch { /* */ } } }
  }
  private duck(t0: number, t1: number): void {
    const ctx = this.ctx!; const g = this.musicBus.gain
    this.voCount++
    g.cancelScheduledValues(t0); g.setTargetAtTime(0.22, t0 - 0.05, 0.08)
    window.setTimeout(() => { this.voCount--; if (this.voCount <= 0 && this.ctx) g.setTargetAtTime(0.55, this.ctx.currentTime, 0.4) }, Math.max(0, (t1 - ctx.currentTime) * 1000 + 150))
  }

  async sfx(name: string, at = 0, gain = 1): Promise<Playing | null> {
    const ctx = this.ctx; if (!ctx) return null
    const b = await this.buffer(`sfx-${name}.mp3`); if (!b) return null
    const src = ctx.createBufferSource(); src.buffer = b
    const g = ctx.createGain(); g.gain.value = gain; src.connect(g); g.connect(this.sfxBus)
    const start = Math.max(ctx.currentTime + 0.01, at || 0); src.start(start)
    return { id: name, start, dur: b.duration, stop: () => { try { src.stop() } catch { /* */ } } }
  }

  /** A looping bed (the music or the airport hum), faded in; off fades it out. */
  async loop(id: string, on: boolean, gain = 1, fade = 1.5): Promise<void> {
    const ctx = this.ctx; if (!ctx) return
    const cur = this.loops.get(id)
    if (!on) { if (cur) { const g = (cur as unknown as { _g: GainNode })._g; g.gain.setTargetAtTime(0, ctx.currentTime, fade / 3); window.setTimeout(() => { try { cur.stop() } catch { /* */ } }, fade * 1000 + 200); this.loops.delete(id) } return }
    if (cur) return
    const b = await this.buffer(this.fileOf(id)); if (!b || this.loops.has(id)) return
    const src = ctx.createBufferSource(); src.buffer = b; src.loop = true
    const g = ctx.createGain(); g.gain.value = 0; g.gain.setTargetAtTime(gain, ctx.currentTime, fade / 3)
    src.connect(g); g.connect(id.startsWith('music:') ? this.musicBus : this.sfxBus); src.start()
    ;(src as unknown as { _g: GainNode })._g = g
    this.loops.set(id, src)
  }

  /** 0..1 loudness of the voices right now (for waveforms and glows). */
  level(): number {
    const a = this.analyser; if (!a) return 0
    const d = new Uint8Array(a.fftSize); a.getByteTimeDomainData(d)
    let s = 0; for (let i = 0; i < d.length; i++) { const v = (d[i] - 128) / 128; s += v * v }
    return Math.min(1, Math.sqrt(s / d.length) * 4)
  }
  bands(n: number): number[] {
    const a = this.analyser; if (!a) return new Array(n).fill(0)
    const d = new Uint8Array(a.frequencyBinCount); a.getByteFrequencyData(d)
    const out: number[] = []; const step = Math.floor(d.length * 0.6 / n)
    for (let i = 0; i < n; i++) { let m = 0; for (let k = 0; k < step; k++) m = Math.max(m, d[i * step + k]); out.push(m / 255) }
    return out
  }
}

export const sound = new Sound()

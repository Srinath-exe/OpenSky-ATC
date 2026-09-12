// ============================================================
//  Sound — tiny WebAudio synth cues (UX 04 §7.3) + pilot TTS.
//
//  No assets: every cue is synthesised on demand (sine / triangle / square
//  oscillators through a master gain, a short filtered-noise burst for the
//  squelch click). Everything is gated by `enabled` (settings.sound); TTS is
//  gated separately by `tts` (settings.tts) and speaks pilot lines through
//  speechSynthesis. SSR-safe: nothing touches the DOM until a cue plays in a
//  browser. The AudioContext is created lazily and resumed on the first user
//  gesture (autoplay policy) - `unlock()` is also wired to pointerdown/keydown.
//
//  Cue catalogue (UX §7.3, kept deliberately small and quiet, <= 120 ms UI,
//  alerts longer): transmit click, readback chime, request ping, handoff
//  chirp, alert tones by severity (info blip / warning double blip / critical
//  two-tone), emergency 3-beep + two-note siren, resolve chime, error buzz,
//  undo rewind, score up / down, pause / resume.
// ============================================================
import type { AlertSeverity } from '../../lib/sim/types';

export type SoundCue =
  | 'transmit' | 'readback' | 'request' | 'handoff' | 'resolve' | 'error' | 'undo'
  | 'alert-info' | 'alert-warning' | 'alert-critical' | 'emergency'
  | 'score-up' | 'score-down' | 'pause' | 'resume' | 'select' | 'tick';

type Wave = OscillatorType;

interface ToneOpts { type?: Wave; gain?: number; attack?: number; release?: number; at?: number; to?: number }

/** UI cues stay quiet (<= -18 dBFS); alerts and the emergency siren may go louder. */
const UI_GAIN = 0.12;
const ALERT_GAIN = 0.22;

class SoundEngine {
  /** Master switch (settings.sound). */
  enabled = false;
  /** Pilot-line text-to-speech (settings.tts). */
  tts = false;
  /** 0..1 master volume. */
  volume = 0.8;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private unlocked = false;
  private listenersInstalled = false;
  private speechQueued = 0;
  /** Real-time throttle so identical cues do not stack (ms per cue). */
  private lastPlayed = new Map<SoundCue, number>();

  // ── configuration ──────────────────────────────────────────────────────────
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.stopSpeech();
    if (on) this.installUnlock();
  }
  setTTS(on: boolean): void { this.tts = on; if (!on) this.stopSpeech(); }
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  /** Resume the AudioContext after a user gesture (autoplay policy). Safe to call any time. */
  unlock(): void {
    const ctx = this.context(); if (!ctx) return;
    if (ctx.state === 'suspended') { ctx.resume().then(() => { this.unlocked = true; }).catch(() => { /* not yet allowed */ }); }
    else this.unlocked = true;
  }

  /** Whether audio can actually be heard right now (context running). */
  get ready(): boolean { return !!this.ctx && this.ctx.state === 'running'; }

  // ── cues ───────────────────────────────────────────────────────────────────
  play(cue: SoundCue): void {
    if (!this.enabled) return;
    const ctx = this.context(); if (!ctx) return;
    if (ctx.state !== 'running') { this.unlock(); if ((ctx.state as AudioContextState) !== 'running') return; }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const minGap = cue === 'tick' ? 40 : cue.startsWith('alert') || cue === 'emergency' ? 400 : 90;
    const last = this.lastPlayed.get(cue) ?? -Infinity;
    if (now - last < minGap) return;
    this.lastPlayed.set(cue, now);
    const t = ctx.currentTime;
    switch (cue) {
      case 'transmit':   this.noise(0.03, 0.10, t); this.tone(1800, 0.02, { type: 'square', gain: 0.05, at: t }); break;
      case 'readback':   this.tone(660, 0.09, { at: t, gain: UI_GAIN }); this.tone(830, 0.11, { at: t + 0.09, gain: UI_GAIN }); break;
      case 'request':    this.tone(1046, 0.14, { at: t, gain: UI_GAIN, release: 0.12 }); break;
      case 'handoff':    this.tone(880, 0.06, { at: t, gain: UI_GAIN, to: 1320 }); break;
      case 'select':     this.tone(1200, 0.03, { type: 'triangle', at: t, gain: 0.06 }); break;
      case 'tick':       this.tone(2400, 0.012, { type: 'square', at: t, gain: 0.03 }); break;
      case 'resolve':    this.tone(523, 0.07, { at: t, gain: UI_GAIN }); this.tone(659, 0.07, { at: t + 0.07, gain: UI_GAIN }); this.tone(784, 0.12, { at: t + 0.14, gain: UI_GAIN }); break;
      case 'error':      this.tone(180, 0.12, { type: 'sawtooth', at: t, gain: 0.07 }); break;
      case 'undo':       this.tone(600, 0.08, { type: 'triangle', at: t, gain: UI_GAIN, to: 300 }); break;
      case 'score-up':   this.tone(523, 0.07, { at: t, gain: 0.09 }); this.tone(659, 0.10, { at: t + 0.07, gain: 0.09 }); break;
      case 'score-down': this.tone(120, 0.15, { at: t, gain: 0.14, type: 'sine' }); break;
      case 'pause':      this.tone(440, 0.06, { at: t, gain: UI_GAIN, to: 330 }); break;
      case 'resume':     this.tone(330, 0.06, { at: t, gain: UI_GAIN, to: 440 }); break;
      case 'alert-info': this.tone(880, 0.08, { at: t, gain: UI_GAIN }); break;
      case 'alert-warning': this.tone(600, 0.09, { type: 'triangle', at: t, gain: ALERT_GAIN }); this.tone(600, 0.09, { type: 'triangle', at: t + 0.14, gain: ALERT_GAIN }); break;
      case 'alert-critical':
        // STCA two-tone 800/1000 Hz, 0.5 s
        for (let i = 0; i < 4; i++) this.tone(i % 2 ? 1000 : 800, 0.12, { type: 'square', at: t + i * 0.125, gain: ALERT_GAIN * 0.6 });
        break;
      case 'emergency':
        // 3 beeps then a two-note siren
        for (let i = 0; i < 3; i++) this.tone(740, 0.09, { type: 'square', at: t + i * 0.16, gain: ALERT_GAIN * 0.6 });
        this.tone(600, 0.35, { type: 'triangle', at: t + 0.55, gain: ALERT_GAIN, to: 900 });
        this.tone(900, 0.35, { type: 'triangle', at: t + 0.90, gain: ALERT_GAIN, to: 600 });
        break;
    }
  }

  /** Alert tone by severity (UX §5.1). */
  alert(severity: AlertSeverity): void {
    this.play(severity === 'critical' ? 'alert-critical' : severity === 'warning' ? 'alert-warning' : 'alert-info');
  }

  // ── TTS ────────────────────────────────────────────────────────────────────
  /** Speak a pilot line (only when both `enabled` and `tts`). */
  speak(text: string, opts: { who?: 'PILOT' | 'ATC' | 'SYS' | 'AI'; force?: boolean } = {}): void {
    if (!opts.force && (!this.enabled || !this.tts)) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return;
    const synth = window.speechSynthesis; if (!synth) return;
    const clean = text.replace(/\b[A-Z]{4,}\b/g, w => w.toLowerCase()).replace(/\s+/g, ' ').trim();
    if (!clean) return;
    try {
      if (this.speechQueued > 4) { synth.cancel(); this.speechQueued = 0; }
      const u = new SpeechSynthesisUtterance(clean);
      const pilot = opts.who !== 'ATC';
      u.rate = pilot ? 1.08 : 1.0;
      u.pitch = pilot ? 0.9 : 1.05;
      u.volume = Math.max(0, Math.min(1, this.volume));
      this.speechQueued++;
      const done = () => { this.speechQueued = Math.max(0, this.speechQueued - 1); };
      u.onend = done; u.onerror = done;
      synth.speak(u);
    } catch { /* speech unavailable */ }
  }

  stopSpeech(): void {
    try { if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* ignore */ }
    this.speechQueued = 0;
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.ctx = ctx; this.master = master;
      this.installUnlock();
      return ctx;
    } catch {
      return null;
    }
  }

  private installUnlock(): void {
    if (this.listenersInstalled || typeof window === 'undefined') return;
    this.listenersInstalled = true;
    const once = () => {
      this.unlock();
      if (this.unlocked || this.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', once);
        window.removeEventListener('keydown', once);
      }
    };
    try {
      window.addEventListener('pointerdown', once, { passive: true });
      window.addEventListener('keydown', once, { passive: true });
    } catch { /* ignore */ }
  }

  private tone(freq: number, dur: number, o: ToneOpts = {}): void {
    const ctx = this.ctx, master = this.master; if (!ctx || !master) return;
    try {
      const at = o.at ?? ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = o.type ?? 'sine';
      osc.frequency.setValueAtTime(freq, at);
      if (o.to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), at + dur);
      const gain = o.gain ?? UI_GAIN;
      const attack = o.attack ?? 0.005;
      const release = o.release ?? Math.min(0.06, dur * 0.5);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + attack);
      g.gain.setValueAtTime(gain, at + Math.max(attack, dur - release));
      g.gain.linearRampToValueAtTime(0.0001, at + dur);
      osc.connect(g); g.connect(master);
      osc.start(at); osc.stop(at + dur + 0.02);
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }

  /** Short band-passed noise burst (squelch click). */
  private noise(dur: number, gain: number, at: number): void {
    const ctx = this.ctx, master = this.master; if (!ctx || !master) return;
    try {
      const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let seed = 0x9e3779b9;
      for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; data[i] = ((seed / 4294967296) * 2 - 1) * (1 - i / n); }
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(at); src.stop(at + dur + 0.01);
      src.onended = () => { try { src.disconnect(); bp.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }
}

/** Singleton (module-level; the store configures it from settings). */
export const sound = new SoundEngine();

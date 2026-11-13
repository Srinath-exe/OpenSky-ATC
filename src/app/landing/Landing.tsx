'use client';
// The landing page: one loop of SFO, rendered offline with raea from the game's own airport data and scrubbed by the
// scroll. The last frame is the first, so the scroll wraps and the film never ends: radar -> approach -> landing ->
// taxi in on the controller's route -> across the apron to a 747 pushing back -> its route, spoken -> take-off ->
// back up to the radar. HTML on top: data blocks on the traffic (tracks.json, projected with the film's camera),
// taxiway names on the routes, the chapter copy, a HUD.
import * as React from 'react';
import Link from 'next/link';
import s from './landing.module.css';

const BASE = '/landing/sfo';
const ASSET_V = '7';
// frame sizes: l 480 (the first look, every frame, any link), m 960 (phones, slow links), f 1600 (desktop)
const TIERS = ['', 'l', 'm', 'f'] as const;
const N = 1440, SUB = 3, FW = 1920, FH = 1080;   // film frames, film frames per story frame, frame size
// story frames that take more scroll: the outro holds while its ways into the game are on screen
// scroll per frame: the taxi-in a little quicker (seen from higher up), the outro held longer
const WARP: [number, number, number][] = [[216, 260, 0.6], [452, 476, 2.6]];
const CUM = (() => { const c = new Float64Array(481); for (let i = 0; i < 480; i++) { const f = i + 0.5; c[i + 1] = c[i] + WARP.reduce((w, [a, b, k]) => (f >= a && f < b ? k : w), 1); } return c; })();
/** scroll fraction (0..1) -> film fraction (0..1) */
const unwarp = (u: number) => { const x = Math.min(1, Math.max(0, u)) * CUM[480]; let lo = 0, hi = 480; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (CUM[m] <= x) lo = m; else hi = m; } return (lo + (x - CUM[lo]) / (CUM[lo + 1] - CUM[lo] || 1)) / 480; };

const SITE = {
  icao: 'KSFO', iata: 'SFO', arr: '28R', dep: '1R', clock: 3 * 3600 + 41 * 60 + 12,
  atis: 'ATIS B · WIND 280/16 · ILS 28R · DEP 1R',
  stats: [[4, 'runways'], [246, 'taxiways'], [295, 'stands'], [177, 'hold-short points']] as [number, string][],
  approach: ['ASA331 HDG 250 THEN DESCEND 3000', 'SJX12 CLEARED ILS 28R', 'SJX12 CONTACT TOWER'],
  land: ['Starwalker one-two, wind two-eight-zero at one-six, runway two-eight right, cleared to land.', 'Cleared to land two-eight right, Starwalker one-two.'],
  push: 'DLH455 PUSHBACK APPROVED',
  voice: 'DLH455 RWY 1R TAXI VIA M4 M1',
  gnd: 'GND 121.80',
  takeoff: ['Lufthansa four-five-five, wind two-eight-zero at one-six, runway one right, cleared for take-off.', 'Cleared for take-off one right, Lufthansa four-five-five.'],
  strips: [['hero', 'SJX12', 'A359'], ['dep', 'DLH455', 'B744'], ['a1', 'ASA331', 'A320']] as [string, string, string][],
};

type Row = [number, number, number, number, number, number, number]; // ac index, x, y, ft, kt, phase, px length
interface Tracks {
  w: number; h: number; n: number; ch: Record<string, [number, number]>; phases: string[]; anchors: string[];
  ac: { id: string; cs: string; type: string; kind: 'arr' | 'dep'; airline?: string }[];
  f: Row[][]; an: (0 | [number, number])[][]; cam: number[]; t: number[]; sp: number[];
  instr: { who: 'hero' | 'dep'; cs: string; words: { w: string; f: number; twy: boolean }[]; segs: { name: string; s0: number; s1: number; f: number }[]; L: number }[];
  ip: number[][];
}
// when each controller's taxi instruction is on screen (story frames)
const TX_ON: Record<string, [number, number]> = { hero: [201, 262], dep: [304, 352] };

// the outro's ways in: a seat at SFO, or another field
const OUTRO_SEATS: [string, string, string][] = [['ground', 'Ground', 'Pushbacks and taxi routes'], ['tower', 'Tower', 'Runways: land them, launch them'], ['approach', 'Approach', 'Vector and sequence the arrivals']];

// story frames (0..480); the film has SUB frames per story frame
const CHAPTERS: { key: string; name: string; range: [number, number] }[] = [
  { key: 'scope', name: 'Radar', range: [0, 44] },
  { key: 'field', name: 'The airport', range: [44, 96] },
  { key: 'approach', name: 'Approach', range: [96, 146] },
  { key: 'final', name: 'Landing', range: [146, 212] },
  { key: 'taxiin', name: 'Taxi in', range: [212, 262] },
  { key: 'push', name: 'Pushback', range: [262, 304] },
  { key: 'route', name: 'Taxi out', range: [304, 352] },
  { key: 'takeoff', name: 'Take-off', range: [352, 404] },
  { key: 'ai', name: 'AI seat', range: [404, 448] },
  { key: 'outro', name: 'Play', range: [448, 480] },
];

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
const fmtFt = (ft: number) => ft.toLocaleString('en-US');
const mod = (a: number, n: number) => ((a % n) + n) % n;

class FilmEngine {
  private root: HTMLElement; private stage: HTMLElement; private film: HTMLElement; private canvas: HTMLCanvasElement; private ctx: CanvasRenderingContext2D;
  private tracks: Tracks | null = null;
  private blobs: (Blob | null)[] = new Array(N).fill(null);
  private have = new Uint8Array(N);                 // the sharpest size fetched per frame (0 none, 1 l, 2 m, 3 f)
  private bmps = new Map<number, ImageBitmap>();
  private bmpTier = new Map<number, number>();
  private decoding = new Set<number>();
  private reqd = new Set<number>();                 // frame * 4 + size, in flight
  private queue: number[] = []; private inflight = 0; private loaded = 0;
  private screenTier = 3;                           // what the screen can show: 2 on phones, 3 on desktop
  private bw = -1;                                  // measured download rate, bytes/s (-1 until the first frames are in)
  private cur = 0; private target = 0; private last = 0; private raf = 0; private dead = false; private lastScroll = 0;
  private cw = 0; private ch = 0; private dpr = 1; private scale = 1; private ox = 0; private oy = 0;
  private tags: HTMLElement[] = []; private tagText: string[] = [];
  private anchors: HTMLElement[] = [];
  private els: Record<string, HTMLElement | null> = {};
  private copy: { el: HTMLElement; a: number; b: number; c: number; d: number }[] = [];
  private bars: HTMLElement[] = [];
  private counts: { el: HTMLElement; n: number; copy: HTMLElement }[] = [];
  private typed: { el: HTMLElement; full: string; a: number; b: number; n: number }[] = [];
  private drawn = -1; private drawnT = -1; private firstDrawn = false;
  private lastText: Record<string, string> = {};
  private tx: { who: string; words: { el: HTMLElement; f: number; seg: number }[]; box: HTMLElement }[] = [];
  private signAt: Record<string, number> = {};

  constructor(root: HTMLElement) {
    this.root = root;
    this.stage = root.querySelector('[data-stage]') as HTMLElement;
    this.film = root.querySelector('[data-film]') as HTMLElement;
    this.canvas = root.querySelector('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
    this.screenTier = Math.min(window.innerWidth, 1920) * Math.min(window.devicePixelRatio || 1, 2) < 1100 ? 2 : 3;
    // before anything is measured, the browser's own estimate of the link (Chrome, Android) caps the size
    const conn = (navigator as unknown as { connection?: { effectiveType?: string; saveData?: boolean; downlink?: number } }).connection;
    if (conn?.saveData || /(^|-)2g/.test(conn?.effectiveType ?? '')) this.bw = 150e3;
    else if (conn?.effectiveType === '3g') this.bw = 600e3;
    this.tags = Array.from(root.querySelectorAll('[data-tag]')) as HTMLElement[];
    this.tagText = this.tags.map(() => '');
    this.anchors = Array.from(root.querySelectorAll('[data-anchor]')) as HTMLElement[];
    this.bars = Array.from(root.querySelectorAll('[data-wave] i')) as HTMLElement[];
    for (const k of ['callout', 'calloutText', 'chIdx', 'chName', 'clock', 'alt', 'altTape', 'loader', 'loaderPct', 'hudAlt', 'hudIas', 'hudDist', 'hudAlt2', 'hudIas2', 'touch', 'strips', 'toggles', 'progress', 'scrollCue', 'latency', 'routeLabels', 'tx', 'txWords'])
      this.els[k] = root.querySelector(`[data-el="${k}"]`);
    this.counts = (Array.from(root.querySelectorAll('[data-count]')) as HTMLElement[]).map((el) => ({ el, n: Number(el.dataset.count), copy: el.closest('[data-copy]') as HTMLElement }));
    this.typed = (Array.from(root.querySelectorAll('[data-type]')) as HTMLElement[]).map((el) => { const [a, b] = (el.dataset.type || '0,1').split(',').map(Number); return { el, full: el.textContent || '', a, b, n: -1 }; });
    this.copy = (Array.from(root.querySelectorAll('[data-copy]')) as HTMLElement[]).map((el) => { const [a, b, c, d] = (el.dataset.copy || '0,0,0,0').split(',').map(Number); return { el, a, b, c, d }; });
    this.resize = this.resize.bind(this); this.onScroll = this.onScroll.bind(this); this.tick = this.tick.bind(this);
    window.addEventListener('resize', this.resize); this.root.addEventListener('scroll', this.onScroll, { passive: true });
    this.resize(); this.onScroll(); this.cur = this.target;
    fetch(`${BASE}/tracks.json?v=${ASSET_V}`).then((r) => r.json()).then((t: Tracks) => { this.tracks = t; this.makeRouteLabels(t); this.makeTx(t); }).catch(() => {});
    const seen = new Set<number>();
    for (const st of [32, 16, 8, 4, 2, 1]) for (let i = 0; i < N; i += st) if (!seen.has(i)) { seen.add(i); this.queue.push(i); }
    for (let k = 0; k < 6; k++) this.pump();
    this.raf = requestAnimationFrame(this.tick);
  }
  destroy() { this.dead = true; cancelAnimationFrame(this.raf); window.removeEventListener('resize', this.resize); this.root.removeEventListener('scroll', this.onScroll); this.bmps.forEach((b) => b.close()); this.bmps.clear(); }

  // the taxiway names on the two routes, made once the tracks say which there are
  private makeRouteLabels(t: Tracks) {
    const box = this.els.routeLabels; if (!box) return;
    for (const key of t.anchors) {
      if (!key.startsWith('H:') && !key.startsWith('D:')) continue;
      const el = document.createElement('div'); el.dataset.anchor = key; el.className = `${s.twy} ${key.startsWith('H:') ? s.twyH : s.twyD}`; el.style.opacity = '0';
      el.innerHTML = `<span>${key.slice(2)}</span>`; box.appendChild(el); this.anchors.push(el);
    }
  }
  // the controller's taxi instructions, a word at a time; the taxiways as the yellow-on-black signs they are on the field
  private makeTx(t: Tracks) {
    const box = this.els.txWords; if (!box || !t.instr) return;
    for (const I of t.instr) {
      const line = document.createElement('span'); line.className = s.txLine; line.dataset.who = I.who;
      const words: { el: HTMLElement; f: number; seg: number }[] = [];
      let seg = 0;
      for (const w of I.words) {
        const el = document.createElement('span'); el.className = w.twy ? `${s.w} ${s.wTwy}` : s.w; el.textContent = w.w;
        line.appendChild(el); words.push({ el, f: w.f, seg: w.twy ? seg++ : -1 });
        if (w.twy) this.signAt[`${I.who === 'hero' ? 'H' : 'D'}:${w.w}`] = w.f;
      }
      box.appendChild(line); this.tx.push({ who: I.who, words, box: line });
    }
  }
  private url(i: number, t: number) { return `${BASE}/${TIERS[t]}/${pad(i, 4)}.webp?v=${ASSET_V}`; }
  /** The sharpest size worth fetching now: the screen's, lowered while the measured link is slow (it rises again when it
   *  speeds up). Below ~0.35 MB/s the small frames only; below ~1.2 MB/s the 960s. */
  private targetTier(): number {
    if (this.bw < 0) return this.screenTier;
    return Math.min(this.screenTier, this.bw < 350e3 ? 1 : this.bw < 1.2e6 ? 2 : 3);
  }
  private free(i: number, t: number) { return this.have[i] < t && !this.reqd.has(i * 4 + t); }
  /** What to fetch next: the small frame of everything near the playhead first (so scrubbing always shows a picture),
   *  then those frames at the target size, then the small frames of the whole film, then the rest at the target size. */
  private nextJob(): [number, number] | null {
    const c = Math.round(mod(this.target, 1) * N); const T = this.targetTier();
    for (let d = 0; d < 70; d++) for (const i of [mod(c + d, N), mod(c - (d >> 1), N)]) if (this.have[i] === 0 && this.free(i, 1)) return [i, 1];
    if (T > 1) for (let d = 0; d < 36; d++) for (const i of [mod(c + d, N), mod(c - (d >> 1), N)]) if (this.free(i, T)) return [i, T];
    while (this.queue.length && this.have[this.queue[0]] > 0) this.queue.shift();
    for (const i of this.queue) if (this.free(i, 1)) return [i, 1];
    if (T > 1) for (let d = 0; d < N / 2; d++) for (const i of [mod(c + d, N), mod(c - d, N)]) if (this.free(i, T)) return [i, T];
    return null;
  }
  private pump() {
    if (this.dead || this.inflight >= 6) return;
    const job = this.nextJob(); if (!job) return;
    const [i, t] = job; const key = i * 4 + t; const t0 = performance.now();
    this.reqd.add(key); this.inflight++;
    const par = this.inflight;
    fetch(this.url(i, t)).then((r) => (r.ok ? r.blob() : Promise.reject(r.status))).then((b) => {
      // the link's rate: this transfer's, times the transfers sharing it, smoothed
      const ms = Math.max(1, performance.now() - t0); const rate = (b.size * Math.max(1, par)) / (ms / 1000);
      this.bw = this.bw < 0 ? rate : this.bw * 0.85 + rate * 0.15;
      if (t > this.have[i]) { if (this.have[i] === 0) this.loaded++; this.have[i] = t; this.blobs[i] = b; }
    })
      .catch(() => {})
      .finally(() => { this.reqd.delete(key); this.inflight--; this.pump(); });
  }
  private decode(i: number) {
    i = mod(i, N);
    if (this.decoding.has(i) || !this.blobs[i]) return;
    if (this.bmps.has(i) && (this.bmpTier.get(i) ?? 0) >= this.have[i]) return;   // decoded at the best size there is
    const t = this.have[i]; this.decoding.add(i);
    createImageBitmap(this.blobs[i]!).then((b) => {
      if (this.dead) { b.close(); return; }
      const old = this.bmps.get(i); this.bmps.set(i, b); this.bmpTier.set(i, t); old?.close();
      if (this.drawn === i) this.drawn = -1;      // a sharper copy of what is on screen: draw it again
    }).catch(() => {}).finally(() => this.decoding.delete(i));
  }
  private nearestBmp(i: number): number {
    if (this.bmps.has(i)) return i;
    for (let d = 1; d < N / 2; d++) { if (this.bmps.has(mod(i - d, N))) return mod(i - d, N); if (this.bmps.has(mod(i + d, N))) return mod(i + d, N); }
    return -1;
  }
  private resize() {
    const r = this.stage.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.cw = Math.round(r.width * this.dpr); this.ch = Math.round(r.height * this.dpr);
    this.canvas.width = this.cw; this.canvas.height = this.ch;
    this.scale = Math.max(r.width / FW, r.height / FH);
    this.ox = (r.width - FW * this.scale) / 2; this.oy = (r.height - FH * this.scale) / 2;
    this.drawn = -1;
  }
  private span() { return this.film.offsetHeight - this.root.clientHeight; }
  private onScroll() {
    const max = this.span();
    const y = this.root.scrollTop - this.film.offsetTop;
    // the loop: at the end of the film the scroll jumps back a whole film (frame N is frame 0), the playhead with it
    if (y >= max - 1 && max > 0) {
      this.root.scrollTop -= max - 2; this.cur -= 1; this.target = unwarp((this.root.scrollTop - this.film.offsetTop) / max); return;
    }
    this.target = unwarp(Math.max(0, y / Math.max(1, max)));
    this.lastScroll = performance.now();
  }
  private tick(now: number) {
    if (this.dead) return;
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000); this.last = now;
    // at rest, the playhead settles on the nearest whole frame, so what you stop on is one sharp frame
    let goal = this.target;
    if (now - this.lastScroll > 140) goal = Math.round(this.target * N) / N;
    const k = 1 - Math.exp(-dt * 14);
    this.cur += (goal - this.cur) * k;
    if (Math.abs(goal - this.cur) * N < 0.02) this.cur = goal;
    const fr = mod(this.cur, 1) * N;
    const i0 = Math.floor(fr), t = fr - i0;
    const dir = this.target >= this.cur ? 1 : -1;
    for (let d = -6; d <= 28; d++) this.decode(i0 + d * dir);
    if (this.bmps.size > 90) for (const [j, b] of this.bmps) { const dd = Math.min(Math.abs(j - i0), N - Math.abs(j - i0)); if (dd > 44) { b.close(); this.bmps.delete(j); this.bmpTier.delete(j); } }
    this.pump();
    this.draw(i0, t);
    this.overlay(fr);
    this.raf = requestAnimationFrame(this.tick);
  }
  private draw(i0: number, t: number) {
    const a = this.nearestBmp(i0); if (a < 0) return;
    const i1 = mod(i0 + 1, N);
    const tt = this.bmps.has(i1) && a === i0 && t > 0.02 ? Math.round(t * 64) / 64 : 0;
    if (a === this.drawn && tt === this.drawnT) return;
    const c = this.ctx; const dw = FW * this.scale * this.dpr, dh = FH * this.scale * this.dpr; const x = this.ox * this.dpr, y = this.oy * this.dpr;
    c.globalAlpha = 1; c.drawImage(this.bmps.get(a)!, x, y, dw, dh);
    if (tt > 0) { c.globalAlpha = tt; c.drawImage(this.bmps.get(i1)!, x, y, dw, dh); c.globalAlpha = 1; }
    this.drawn = a; this.drawnT = tt;
    if (!this.firstDrawn) { this.firstDrawn = true; this.root.dataset.ready = '1'; }
  }
  private txt(key: string, el: HTMLElement | null | undefined, v: string) { if (!el || this.lastText[key] === v) return; this.lastText[key] = v; el.textContent = v; }
  private sx(x: number) { return this.ox + x * this.scale; }
  private sy(y: number) { return this.oy + y * this.scale; }

  private overlay(ff: number) {
    const fr = ff / SUB; const T = this.tracks; const E = this.els;
    if (E.loader) { const p = Math.min(1, this.loaded / 30); E.loader.style.opacity = this.firstDrawn ? '0' : '1'; this.txt('lp', E.loaderPct, `${Math.round(p * 100)}%`); }
    for (const c of this.copy) {
      const p = c.a === c.b ? 1 - smooth(c.c, c.d, fr) : smooth(c.a, c.b, fr) * (1 - smooth(c.c, c.d, fr));
      const q = Math.round(p * 1000) / 1000;
      if (c.el.dataset.p !== String(q)) { c.el.dataset.p = String(q); c.el.style.setProperty('--p', String(q)); c.el.style.visibility = q <= 0 ? 'hidden' : 'visible'; c.el.style.pointerEvents = q > 0.6 ? 'auto' : 'none'; }
      c.el.style.setProperty('--lp', smooth(c.a, c.b + (c.c - c.b) * 0.5, fr).toFixed(3));
    }
    for (const c of this.counts) { const lp = Number(c.copy.style.getPropertyValue('--lp') || 0); const v = String(Math.round(c.n * (1 - Math.pow(1 - lp, 3)))); if (c.el.textContent !== v) c.el.textContent = v; }
    for (const y of this.typed) {
      const n = Math.round(clamp((fr - y.a) / (y.b - y.a)) * y.full.length);
      if (n !== y.n) { y.n = n; y.el.textContent = y.full.slice(0, n); y.el.dataset.done = n >= y.full.length ? '1' : n > 0 ? '0' : ''; }
    }
    const ci = Math.max(0, CHAPTERS.findIndex((c) => fr >= c.range[0] && fr < c.range[1]));
    this.txt('ci', E.chIdx, `${pad(ci + 1)} / ${pad(CHAPTERS.length)}`);
    this.txt('cn', E.chName, CHAPTERS[ci].name);
    if (E.progress) Array.from(E.progress.children).forEach((seg, i) => { const [a, b] = CHAPTERS[i].range; (seg.firstElementChild as HTMLElement).style.transform = `scaleX(${clamp((fr - a) / (b - a))})`; seg.classList.toggle(s.segOn, i === ci); });
    if (E.scrollCue) E.scrollCue.style.opacity = String((1 - smooth(2, 14, fr)) * (this.cur < 0.5 ? 1 : 0));
    if (!T) return;
    const i0 = Math.min(N - 1, Math.floor(ff)), i1 = mod(i0 + 1, N), t = ff - i0;
    const secs = T.t[i0] + (T.t[i1] - T.t[i0]) * t; const base = SITE.clock + secs;
    this.txt('clk', E.clock, `${pad((base / 3600) % 24)}:${pad((base / 60) % 60)}:${pad(base % 60)}Z`);
    const alt = T.cam[i0] + (T.cam[i1] - T.cam[i0]) * t;
    this.txt('alt', E.alt, `${fmtFt(Math.round(alt / 10) * 10)}`);
    if (E.altTape) E.altTape.style.transform = `translateY(${((Math.log10(Math.max(30, alt)) - 1.5) * 220).toFixed(1)}px)`;
    // data blocks: which traffic each chapter labels
    const key = CHAPTERS[ci].key;
    const edge = (a: number, b: number) => smooth(a, a + 5, fr) * (1 - smooth(b - 5, b, fr));
    const mode = key === 'scope' || key === 'outro' || (key === 'field' && fr < 70) ? 'radar' : key;
    const fade = key === 'scope' ? 1 - smooth(39, 44, fr) : key === 'outro' ? smooth(452, 460, fr) : edge(CHAPTERS[ci].range[0], CHAPTERS[ci].range[1]);
    const A = T.f[i0], B = T.f[i1];
    const rows = A.map((r) => { const q = B.find((b) => b[0] === r[0]); return { r, x: q ? r[1] + (q[1] - r[1]) * t : r[1], y: q ? r[2] + (q[2] - r[2]) * t : r[2] }; });
    const id = (r: Row) => T.ac[r[0]].id;
    const want = rows.filter(({ r }) => {
      const ac = T.ac[r[0]];
      if (mode === 'radar') return r[3] > 0;
      if (mode === 'approach') return ac.kind === 'arr' && r[3] > 0;
      if (mode === 'final' || mode === 'taxiin') return id(r) === 'hero';
      if (mode === 'push') return (id(r) === 'dep' || id(r) === 'hero' || id(r) === 'a1') && r[6] > 8;
      if (mode === 'route' || mode === 'takeoff') return id(r) === 'dep';
      return false;
    }).slice(0, this.tags.length);
    let used = 0;
    for (const { r, x, y } of want) {
      const el = this.tags[used]; const ac = T.ac[r[0]]; const ph = T.phases[r[5]];
      const X = this.sx(x), Y = this.sy(y);
      if (X < -40 || X > window.innerWidth + 40 || Y < -40 || Y > window.innerHeight + 40) continue;
      let html: string;
      if (mode === 'radar') html = `<b>${ac.cs}</b><span>${pad(Math.round(r[3] / 100), 3)} ${pad(Math.round(r[4] / 10), 2)}</span>`;
      else if (mode === 'approach') html = `<b>${ac.cs}</b><em>${ac.type}</em><span>${fmtFt(Math.round(r[3] / 10) * 10)} ft · ${r[4]} kt</span><span class="${s.ph}">${ph}</span>`;
      else if (mode === 'final') html = `<b>${ac.cs}</b><em>${ac.type} · ${ac.airline}</em><span class="${s.ph}">${fr < 200 ? `CLEARED TO LAND ${SITE.arr}` : `LANDED ${SITE.arr}`}</span>`;
      else html = `<b>${ac.cs}</b><em>${ac.type}</em><span class="${s.ph}">${ph}</span>`;
      if (this.tagText[used] !== html) { this.tagText[used] = html; el.querySelector('div')!.innerHTML = html; }
      el.dataset.kind = ac.kind; el.dataset.mode = mode;
      el.style.transform = `translate3d(${X.toFixed(1)}px, ${Y.toFixed(1)}px, 0)`;
      el.style.opacity = fade.toFixed(3);
      used++;
    }
    for (let j = used; j < this.tags.length; j++) if (this.tags[j].style.opacity !== '0') this.tags[j].style.opacity = '0';
    // anchors and route labels
    const AN = T.an[i0], AN1 = T.an[i1];
    const show = (k: string) => {
      if (k.startsWith('H:')) return smooth(this.signAt[k] ?? 212, (this.signAt[k] ?? 212) + 1.2, fr) * (1 - smooth(256, 262, fr));
      if (k.startsWith('D:')) return smooth(this.signAt[k] ?? 310, (this.signAt[k] ?? 310) + 1.2, fr) * (1 - smooth(346, 352, fr));
      if (k.startsWith('G')) return edge(128, 196);
      return ({ ARR: edge(96, 212), CITY: edge(100, 212), TWR: edge(262, 352), DEP: edge(304, 404), JFK: mode === 'radar' ? fade : 0, '5NM': edge(406, 446), '13NM': edge(406, 446), '10NM': edge(0, 44) + smooth(452, 462, fr) } as Record<string, number>)[k] || 0;
    };
    this.anchors.forEach((el) => {
      const k = el.dataset.anchor!; const ix = T.anchors.indexOf(k); const p = AN[ix], q = AN1[ix]; const o = show(k);
      if (!p || o <= 0.001) { if (el.style.opacity !== '0') el.style.opacity = '0'; return; }
      const x = q ? p[0] + (q[0] - p[0]) * t : p[0], y = q ? p[1] + (q[1] - p[1]) * t : p[1];
      el.style.transform = `translate3d(${this.sx(x).toFixed(1)}px, ${this.sy(y).toFixed(1)}px, 0)`; el.style.opacity = o.toFixed(3);
    });
    // the numbers of the landing and the take-off
    const hero = rows.find((r) => id(r.r) === 'hero'), dep = rows.find((r) => id(r.r) === 'dep');
    if (hero) { this.txt('ha', E.hudAlt, fmtFt(Math.max(0, Math.round(hero.r[3] / 10) * 10))); this.txt('hi', E.hudIas, String(hero.r[4])); this.txt('hd', E.hudDist, hero.r[3] > 0 ? (Math.max(0, hero.r[3] - 50) / 318).toFixed(1) : '0.0'); }
    if (dep) { this.txt('ha2', E.hudAlt2, fmtFt(Math.max(0, Math.round(dep.r[3] / 10) * 10))); this.txt('hi2', E.hudIas2, String(dep.r[4])); }
    // the radio altimeter's callouts on the way down
    if (E.callout && hero) {
      const CALL: [number, string][] = [[1000, '1000'], [500, '500'], [400, '400'], [300, '300'], [200, 'MINIMUMS'], [100, '100'], [50, '50'], [40, '40'], [30, '30'], [20, '20'], [10, 'RETARD'], [0, '']];
      const ft = hero.r[3]; let shown = '', o = 0, sc = 1;
      if (fr > 150 && fr < 202 && ft > 0) for (let i = 0; i < CALL.length - 1; i++) {
        const [hi, txt] = CALL[i], lo = CALL[i + 1][0];
        if (ft <= hi && ft > lo) { const q = (hi - ft) / (hi - lo); shown = txt; o = 1 - smooth(0.75, 1, q); sc = 1.22 - 0.22 * smooth(0, 0.3, q); break; }
      }
      this.txt('co', E.calloutText, shown);
      E.callout.style.opacity = o.toFixed(3); E.callout.style.transform = `scale(${sc.toFixed(3)})`;
      E.callout.dataset.kind = shown === 'MINIMUMS' || shown === 'RETARD' ? 'warn' : '';
    }
    if (E.touch) { const o = smooth(197, 200, fr) * (1 - smooth(210, 216, fr)); E.touch.style.opacity = o.toFixed(3); E.touch.style.setProperty('--k', smooth(198, 208, fr).toFixed(3)); }
    if (E.strips) (Array.from(E.strips.querySelectorAll('[data-strip]')) as HTMLElement[]).forEach((el) => {
      const ix = T.ac.findIndex((a) => a.id === el.dataset.strip); const r = A.find((q) => q[0] === ix);
      const st = r ? T.phases[r[5]] : el.dataset.last || 'AT GATE'; el.dataset.last = st;
      const b = el.querySelector('[data-st]') as HTMLElement; if (b && b.textContent !== st) { b.textContent = st; el.classList.remove(s.flash); void el.offsetWidth; el.classList.add(s.flash); }
    });
    // voice: the waveform while the instruction is spoken, then the time to the readback
    const vp = clamp((fr - 305) / 8.5); const talk = vp > 0 && vp < 1 ? Math.sin(vp * Math.PI) : 0;
    this.bars.forEach((b, i) => { const n = 0.25 + 0.75 * Math.abs(Math.sin(i * 1.7 + fr * 1.9) * Math.cos(i * 0.6 + fr * 0.77)); b.style.transform = `scaleY(${(0.06 + talk * n).toFixed(3)})`; });
    if (E.latency) E.latency.style.setProperty('--l', smooth(316, 325, fr).toFixed(3));
    // the transmission: words pop in on their frames; the taxiway the aircraft is on now is lit
    if (E.tx && T && T.ip) {
      const ipr = T.ip[Math.min(T.ip.length - 1, Math.round(ff))] || [];
      let shown = 0;
      this.tx.forEach((x, ix) => {
        const [a, b] = TX_ON[x.who]; const o = smooth(a, a + 1.5, fr) * (1 - smooth(b - 4, b, fr));
        x.box.style.display = o > 0.001 ? '' : 'none'; if (o <= 0.001) return;
        shown = Math.max(shown, o);
        const I = T.instr[ix]; const sa = ipr[ix] ?? -1;
        let on = -1; if (sa >= 0) I.segs.forEach((g, j) => { if (sa >= g.s0 - 0.5 && sa < g.s1 - 0.5 && fr >= g.f) on = j; });
        for (const w of x.words) {
          const k = smooth(w.f - 0.05, w.f + 0.55, fr);
          const back = 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2);
          const st = `${k.toFixed(3)}|${back.toFixed(3)}`;
          if (w.el.dataset.st !== st) { w.el.dataset.st = st; w.el.style.opacity = k.toFixed(3); w.el.style.transform = `translateY(${((1 - k) * 10).toFixed(1)}px) scale(${(0.72 + 0.28 * back).toFixed(3)})`; }
          if (w.seg >= 0) { const v = w.seg === on ? '1' : on >= 0 && w.seg < on ? 'p' : ''; if ((w.el.dataset.on || '') !== v) w.el.dataset.on = v; }
        }
      });
      E.tx.style.opacity = shown.toFixed(3);
    }
    if (E.toggles) { E.toggles.dataset.tower = fr < 418 ? 'you' : 'ai'; E.toggles.dataset.app = fr < 428 ? 'ai' : fr < 436 ? 'you' : 'ai'; }
  }
}

export default function Landing() {
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (!ref.current) return;
    const e = new FilmEngine(ref.current);
    return () => e.destroy();
  }, []);
  const L = (i: number, children: React.ReactNode, cls = '') => <span className={`${s.line} ${cls}`} style={{ ['--i' as string]: i }}>{children}</span>;
  const radio = (who: string, text: string, frames: string, pilot = false) => (
    <span className={s.rx}><i className={pilot ? s.plt : ''}>{who}</i><q className={s.type} data-type={frames}>{text}</q></span>
  );
  return (
    <main ref={ref} className={s.root}>
      <header className={s.nav}>
        <Link href="/" className={s.brand} aria-label="SKYCONTROL">
          <svg viewBox="0 0 24 24" aria-hidden="true" className={s.logo}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="5.5" /><path d="M12 12 L19 5" /></svg>
          SKYCONTROL
        </Link>
        <div className={s.navMid}>
          <span className={s.live}><i />{SITE.icao}</span>
          <span data-el="chIdx" className={s.navIdx}>01 / 10</span>
          <span data-el="chName" className={s.navName}>Radar</span>
        </div>
        <Link href="/start" className={s.navCta}>Play</Link>
      </header>

      <section data-film className={s.film}>
        <div data-stage className={s.stage}>
          <canvas className={s.canvas} aria-hidden="true" />
          <div className={s.shade} aria-hidden="true" />

          <div className={s.tags} aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} data-tag className={s.tag} style={{ opacity: 0 }}><i className={s.tagDot} /><i className={s.tagLead} /><div className={s.tagBox} /></div>
            ))}
            {[['ARR', `RWY ${SITE.arr}`], ['DEP', `RWY ${SITE.dep}`], ['TWR', `${SITE.iata} TOWER`], ['CITY', 'SAN FRANCISCO'], ['JFK', SITE.icao], ['5NM', 'TOWER · 5 NM'], ['13NM', 'APPROACH · 13 NM'], ['10NM', '10 NM']].map(([k, label]) => (
              <div key={k} data-anchor={k} className={`${s.anchor} ${k === '5NM' ? s.anTwr : k === '13NM' ? s.anApp : ''}`} style={{ opacity: 0 }}><span>{label}</span></div>
            ))}
            <div data-el="routeLabels" />
            {[4, 3, 2, 1].map((d) => (
              <div key={d} data-anchor={`G${d}`} className={`${s.anchor} ${s.anGate}`} style={{ opacity: 0 }}><span>{d} NM · {fmtFt(Math.round((d * 318 + 50) / 10) * 10)} FT</span></div>
            ))}
          </div>

          <div className={s.hudLeft} aria-hidden="true">
            <span data-el="clock">03:41:12Z</span>
            <span>{SITE.atis}</span>
          </div>
          <div className={s.altBox} aria-hidden="true">
            <div className={s.altWin}><div data-el="altTape" className={s.altTape}>{Array.from({ length: 40 }, (_, i) => <i key={i} />)}</div></div>
            <span className={s.altVal}><b data-el="alt">86,940</b> FT</span>
            <span className={s.altCap}>CAMERA</span>
          </div>
          <div data-el="progress" className={s.progress} aria-hidden="true">
            {CHAPTERS.map((c) => <div key={c.key} className={s.seg}><i /><span>{c.name}</span></div>)}
          </div>
          <div data-el="scrollCue" className={s.cue} aria-hidden="true"><span>Scroll to fly</span><i /></div>

          <div className={s.copyWrap}>
            <article data-copy="0,0,26,42" className={`${s.copy} ${s.hero}`}>
              {L(0, `Air traffic control simulator · ${SITE.icao}`, s.eyebrow)}
              <h1 className={s.h1}>{L(1, 'Take the')} {L(2, 'frequency')} {L(3, `at ${SITE.iata}.`)}</h1>
              {L(4, <>Vector it, sequence it, land it. Push it, taxi it, launch it. Real traffic into San Francisco International, in your browser, <em>with your voice</em>.</>, s.lead)}
              <span className={`${s.line} ${s.ctaRow}`} style={{ ['--i' as string]: 5 }}>
                <Link href="/start" className={s.ctaPrimary}>Play now</Link>
                <span className={s.ctaNote}>Free · no install · scroll, it loops</span>
              </span>
            </article>

            <article data-copy="50,64,84,95" className={s.copy}>
              {L(0, '01 · The airport', s.eyebrow)}
              <h2 className={s.h2}>{L(1, `The real ${SITE.iata},`)} {L(2, 'every line of it.')}</h2>
              {L(3, 'Built from OpenStreetMap: the runways, every taxiway, every stand and hold-short line. Taxi routes are found on the real network, with turns a 747 can actually make.', s.body)}
              <span className={`${s.line} ${s.stats}`} style={{ ['--i' as string]: 4 }}>
                {SITE.stats.map(([n, l]) => <span key={l} className={s.stat}><b data-count={n} className={s.count}>0</b>{l}</span>)}
              </span>
            </article>

            <article data-copy="100,112,136,145" className={s.copy}>
              {L(0, '02 · Approach', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Build the line')} {L(2, 'into 28 Right.')}</h2>
              {L(3, 'Turn arrivals off the downwind, descend them through each other, slot them onto the ILS at 30° or less. Three miles or a thousand feet, more behind a heavy.', s.body)}
              <span className={`${s.line} ${s.cmds}`} style={{ ['--i' as string]: 4 }}>{SITE.approach.map((c) => <code key={c}>{c}</code>)}</span>
            </article>

            <article data-copy="152,164,204,211" className={s.copy}>
              {L(0, '03 · Tower', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Cleared to land.')}</h2>
              <span className={`${s.line} ${s.radio}`} style={{ ['--i' as string]: 2 }}>
                {radio('TWR', SITE.land[0], '160,184')}
                {radio('SJX12', SITE.land[1], '186,198', true)}
              </span>
              <span className={`${s.line} ${s.hudNums}`} style={{ ['--i' as string]: 3 }}>
                <span><small>ALT</small><b data-el="hudAlt">1,200</b><small>FT</small></span>
                <span><small>IAS</small><b data-el="hudIas">140</b><small>KT</small></span>
                <span><small>THR</small><b data-el="hudDist">3.2</b><small>NM</small></span>
              </span>
            </article>
            <div data-el="callout" className={s.callout} style={{ opacity: 0 }} aria-hidden="true"><span data-el="calloutText" /></div>
            <div data-el="touch" className={s.touch} style={{ opacity: 0 }} aria-hidden="true"><i /><span>TOUCHDOWN · RWY {SITE.arr}</span></div>
            <div data-el="tx" className={s.tx} style={{ opacity: 0 }} aria-hidden="true">
              <span className={s.txHead}><i />{SITE.gnd}</span>
              <span data-el="txWords" className={s.txWords} />
            </div>

            <article data-copy="216,226,252,261" className={s.copy}>
              {L(0, '04 · Ground', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'The way in,')} {L(2, 'decided.')}</h2>
              {L(3, 'Ground picks the route on the real taxiway network. Each taxiway’s centreline lights come on as the controller names it, and the aircraft follows the greens: off the runway, across the parallel, onto the stand.', s.body)}
            </article>

            <article data-copy="268,278,294,303" className={s.copy}>
              {L(0, '05 · Pushback', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Across the apron,')} {L(2, 'a 747 wants out.')}</h2>
              <span className={`${s.line} ${s.cmds}`} style={{ ['--i' as string]: 3 }}><code>{SITE.push}</code></span>
              <span data-el="strips" className={`${s.line} ${s.strips}`} style={{ ['--i' as string]: 4 }}>
                {SITE.strips.map(([id, cs, ty]) => <span key={id} data-strip={id} className={s.strip}><b>{cs}</b><em>{ty}</em><i data-st>AT GATE</i></span>)}
              </span>
            </article>

            <article data-copy="305,312,344,351" className={s.copy}>
              {L(0, '06 · Voice', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Say it.')} {L(2, 'It lights up.')}</h2>
              {L(3, 'Hold the key and give the taxi instruction the way a controller would. It is read while you speak, the taxiway lights come on along the route, and the pilot reads it back.', s.body)}
              <span className={`${s.line} ${s.voice}`} style={{ ['--i' as string]: 4 }}>
                <span className={s.ptt}><kbd>SPACE</kbd><span data-wave className={s.wave}>{Array.from({ length: 36 }, (_, i) => <i key={i} />)}</span></span>
                <code className={s.parsed} data-type="313,316">{SITE.voice}</code>
                <span data-el="latency" className={s.latency}>
                  <span style={{ ['--w' as string]: 0.3 }}><i />speech</span>
                  <span style={{ ['--w' as string]: 0.3 }}><i />command</span>
                  <span style={{ ['--w' as string]: 0.4 }}><i />pilot voice</span>
                  <b>≈ 1.1 s from release to readback</b>
                </span>
              </span>
            </article>

            <article data-copy="356,364,396,403" className={s.copy}>
              {L(0, '07 · Tower', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Cleared for take-off.')}</h2>
              <span className={`${s.line} ${s.radio}`} style={{ ['--i' as string]: 2 }}>
                {radio('TWR', SITE.takeoff[0], '357,372')}
                {radio('DLH455', SITE.takeoff[1], '374,384', true)}
              </span>
              <span className={`${s.line} ${s.hudNums}`} style={{ ['--i' as string]: 3 }}>
                <span><small>ALT</small><b data-el="hudAlt2">0</b><small>FT</small></span>
                <span><small>IAS</small><b data-el="hudIas2">0</b><small>KT</small></span>
              </span>
            </article>

            <article data-copy="408,416,440,447" className={s.copy}>
              {L(0, '08 · Two seats', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Work one seat.')} {L(2, 'Hand the AI the other.')}</h2>
              {L(3, 'Tower runs the ground and the runways, Approach runs the sky. Either can be you or the AI, and you can swap mid-session.', s.body)}
              <span data-el="toggles" className={`${s.line} ${s.toggles}`} style={{ ['--i' as string]: 4 }} data-tower="you" data-app="ai">
                <span className={s.seat} data-seat="tower"><b>Tower</b><span className={s.sw}><i>You</i><i>AI</i></span></span>
                <span className={s.seat} data-seat="app"><b>Approach</b><span className={s.sw}><i>You</i><i>AI</i></span></span>
              </span>
              {L(5, '24 full-traffic test sessions at JFK with the AI on both seats: zero losses of separation.', s.fine)}
            </article>

            <article data-copy="452,462,600,601" className={`${s.copy} ${s.outro}`}>
              {L(0, 'Free · in your browser · no install', s.eyebrow)}
              <h2 className={s.h1}>{L(1, 'Your scope.')} {L(2, 'Your sky.')}</h2>
              <span className={`${s.line} ${s.ctaRow}`} style={{ ['--i' as string]: 3 }}>
                <Link href="/learn" className={s.ctaPrimary}>New here? Learn the ropes</Link>
                <Link href={`/play?icao=${SITE.icao}`} className={s.ctaGhost}>Jump in at {SITE.iata}</Link>
              </span>
              <span className={`${s.line} ${s.seats}`} style={{ ['--i' as string]: 4 }}>
                {OUTRO_SEATS.map(([pos, name, what]) => (
                  <Link key={pos} href={`/play?icao=${SITE.icao}&position=${pos}`} className={s.seatCard}><b>{name}</b><span>{what}</span></Link>
                ))}
              </span>
              <span className={`${s.line} ${s.ctaRow}`} style={{ ['--i' as string]: 5 }}>
                <Link href="/start" className={s.ctaLink}>Set up your own shift</Link>
                <Link href="/settings" className={s.ctaLink}>Voice &amp; settings</Link>
                <a href="https://huggingface.co/srinath-exe/skycontrol-atc-command-2m" target="_blank" rel="noopener noreferrer" className={s.ctaLink}>Open model on Hugging Face</a>
                <span className={s.ctaNote}>keep scrolling and it loops</span>
              </span>
            </article>
          </div>

          <div data-el="loader" className={s.loader} aria-hidden="true"><i /><span>Tuning the scope <b data-el="loaderPct">0%</b></span></div>
        </div>
      </section>
    </main>
  );
}

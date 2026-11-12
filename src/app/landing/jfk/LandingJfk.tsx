'use client';
// ARCHIVE (2026-11-09): the first cut of the landing page, a 480-frame film of JFK (rendered offline with raea from the game's own airport data) scrubbed by
// the scroll, with live HTML on top: data blocks that sit on the aircraft (tracks.json is projected with the film's
// camera), the chapter copy, a HUD and the motion graphics for each part of the game.
import * as React from 'react';
import Link from 'next/link';
import s from './landing.module.css';

const N = 480;
const FW = 1600, FH = 900;
const ASSET_V = '1';

type Row = [number, number, number, number, number, number, number]; // ac index, x, y, ft, kt, phase, px length
interface Tracks {
  w: number; h: number; n: number; ch: Record<string, [number, number]>; phases: string[]; anchors: string[];
  ac: { id: string; cs: string; type: string; kind: 'arr' | 'dep'; airline?: string }[];
  f: Row[][]; an: (0 | [number, number])[][]; cam: number[]; t: number[]; sp: number[];
}

const CHAPTERS: { key: string; name: string; range: [number, number] }[] = [
  { key: 'scope', name: 'Radar', range: [0, 56] },
  { key: 'field', name: 'The airport', range: [56, 130] },
  { key: 'approach', name: 'Approach', range: [130, 205] },
  { key: 'final', name: 'Tower', range: [205, 292] },
  { key: 'ground', name: 'Ground', range: [292, 362] },
  { key: 'voice', name: 'Voice', range: [362, 412] },
  { key: 'ai', name: 'AI seat', range: [412, 452] },
  { key: 'outro', name: 'Play', range: [452, 480] },
];

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
const fmtFt = (ft: number) => ft.toLocaleString('en-US');

// ---------------- the engine: frames, scroll, overlays (imperative, outside React) ----------------
class FilmEngine {
  private root: HTMLElement; private stage: HTMLElement; private film: HTMLElement; private canvas: HTMLCanvasElement; private ctx: CanvasRenderingContext2D;
  private tracks: Tracks | null = null;
  private blobs: (Blob | null)[] = new Array(N).fill(null);
  private bmps = new Map<number, ImageBitmap>();
  private decoding = new Set<number>();
  private queue: number[] = []; private inflight = 0; private loaded = 0;
  private set: 'f' | 'm';
  private cur = 0; private target = 0; private last = 0; private raf = 0; private dead = false;
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

  constructor(root: HTMLElement) {
    this.root = root;
    this.stage = root.querySelector('[data-stage]') as HTMLElement;
    this.film = root.querySelector('[data-film]') as HTMLElement;
    this.canvas = root.querySelector('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
    const small = Math.min(window.innerWidth, 1920) * Math.min(window.devicePixelRatio || 1, 2) < 1300;
    this.set = small ? 'm' : 'f';
    this.tags = Array.from(root.querySelectorAll('[data-tag]')) as HTMLElement[];
    this.tagText = this.tags.map(() => '');
    this.anchors = Array.from(root.querySelectorAll('[data-anchor]')) as HTMLElement[];
    this.bars = Array.from(root.querySelectorAll('[data-wave] i')) as HTMLElement[];
    for (const k of ['hud', 'chIdx', 'chName', 'clock', 'alt', 'altTape', 'bracket', 'bracketLine', 'bracketLabel', 'loader', 'loaderPct', 'hudAlt', 'hudIas', 'hudDist', 'touch', 'strips', 'toggles', 'progress', 'scrollCue', 'latency'])
      this.els[k] = root.querySelector(`[data-el="${k}"]`);
    this.counts = (Array.from(root.querySelectorAll('[data-count]')) as HTMLElement[]).map((el) => ({ el, n: Number(el.dataset.count), copy: el.closest('[data-copy]') as HTMLElement }));
    this.typed = (Array.from(root.querySelectorAll('[data-type]')) as HTMLElement[]).map((el) => { const [a, b] = (el.dataset.type || '0,1').split(',').map(Number); return { el, full: el.textContent || '', a, b, n: -1 }; });
    this.copy = (Array.from(root.querySelectorAll('[data-copy]')) as HTMLElement[]).map((el) => {
      const [a, b, c, d] = (el.dataset.copy || '0,0,0,0').split(',').map(Number); return { el, a, b, c, d };
    });
    this.resize = this.resize.bind(this); this.onScroll = this.onScroll.bind(this); this.tick = this.tick.bind(this);
    window.addEventListener('resize', this.resize); this.root.addEventListener('scroll', this.onScroll, { passive: true });
    this.resize(); this.onScroll(); this.cur = this.target;
    fetch(`/landing/jfk/tracks.json?v=${ASSET_V}`).then((r) => r.json()).then((t: Tracks) => { this.tracks = t; }).catch(() => {});
    // coarse to fine: every 32nd frame first, then 16th, 8th, ... so any scroll position has something close
    const seen = new Set<number>();
    for (const st of [32, 16, 8, 4, 2, 1]) for (let i = 0; i < N; i += st) if (!seen.has(i)) { seen.add(i); this.queue.push(i); }
    for (let k = 0; k < 6; k++) this.pump();
    this.raf = requestAnimationFrame(this.tick);
  }
  destroy() { this.dead = true; cancelAnimationFrame(this.raf); window.removeEventListener('resize', this.resize); this.root.removeEventListener('scroll', this.onScroll); this.bmps.forEach((b) => b.close()); this.bmps.clear(); }

  private url(i: number) { return `/landing/jfk/${this.set}/${pad(i, 4)}.webp?v=${ASSET_V}`; }
  private nextIndex(): number {
    // frames near the playhead first (ahead before behind), then the coarse-to-fine queue
    const c = Math.round(this.target * (N - 1));
    for (let d = 0; d < 48; d++) for (const i of [c + d, c - d]) if (i >= 0 && i < N && !this.blobs[i] && !this.reqd.has(i)) return i;
    while (this.queue.length) { const i = this.queue.shift()!; if (!this.blobs[i] && !this.reqd.has(i)) return i; }
    return -1;
  }
  private reqd = new Set<number>();
  private pump() {
    if (this.dead || this.inflight >= 6) return;
    const i = this.nextIndex(); if (i < 0) return;
    this.reqd.add(i); this.inflight++;
    fetch(this.url(i)).then((r) => (r.ok ? r.blob() : Promise.reject(r.status))).then((b) => { this.blobs[i] = b; this.loaded++; })
      .catch(() => { this.reqd.delete(i); })
      .finally(() => { this.inflight--; this.pump(); });
  }
  private decode(i: number) {
    if (i < 0 || i >= N || this.bmps.has(i) || this.decoding.has(i) || !this.blobs[i]) return;
    this.decoding.add(i);
    createImageBitmap(this.blobs[i]!).then((b) => { if (this.dead) { b.close(); return; } this.bmps.set(i, b); }).catch(() => {}).finally(() => this.decoding.delete(i));
  }
  private nearestBmp(i: number): number {
    if (this.bmps.has(i)) return i;
    for (let d = 1; d < N; d++) { if (this.bmps.has(i - d)) return i - d; if (this.bmps.has(i + d)) return i + d; }
    return -1;
  }
  private resize() {
    const r = this.stage.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.cw = Math.round(r.width * this.dpr); this.ch = Math.round(r.height * this.dpr);
    this.canvas.width = this.cw; this.canvas.height = this.ch;
    // cover fit, keeping the film's centre (portrait screens see the middle)
    this.scale = Math.max(r.width / FW, r.height / FH);
    this.ox = (r.width - FW * this.scale) / 2; this.oy = (r.height - FH * this.scale) / 2;
    this.drawn = -1;
  }
  private onScroll() {
    const max = this.film.offsetHeight - this.root.clientHeight;
    const y = this.root.scrollTop - this.film.offsetTop;
    this.target = clamp(y / Math.max(1, max));
  }
  private tick(now: number) {
    if (this.dead) return;
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000); this.last = now;
    // inertia: the film eases toward the scroll position
    const k = 1 - Math.exp(-dt * 9);
    this.cur += (this.target - this.cur) * k;
    if (Math.abs(this.target - this.cur) < 0.00002) this.cur = this.target;
    const fr = this.cur * (N - 1);
    const i0 = Math.floor(fr), t = fr - i0;
    // keep a window of decoded frames around the playhead, drop the rest
    const dir = this.target >= this.cur ? 1 : -1;
    for (let d = -4; d <= 14; d++) this.decode(i0 + d * dir);
    if (this.bmps.size > 64) for (const [j, b] of this.bmps) if (Math.abs(j - i0) > 32) { b.close(); this.bmps.delete(j); }
    this.pump();
    this.draw(i0, t);
    this.overlay(fr);
    this.raf = requestAnimationFrame(this.tick);
  }
  private draw(i0: number, t: number) {
    const a = this.nearestBmp(i0); if (a < 0) return;
    const exactB = this.bmps.has(i0 + 1) && a === i0;
    const tt = exactB ? Math.round(t * 32) / 32 : 0;
    if (a === this.drawn && tt === this.drawnT) return;
    const c = this.ctx; const dw = FW * this.scale * this.dpr, dh = FH * this.scale * this.dpr; const x = this.ox * this.dpr, y = this.oy * this.dpr;
    c.globalAlpha = 1; c.drawImage(this.bmps.get(a)!, x, y, dw, dh);
    if (tt > 0) { c.globalAlpha = tt; c.drawImage(this.bmps.get(i0 + 1)!, x, y, dw, dh); c.globalAlpha = 1; }
    this.drawn = a; this.drawnT = tt;
    if (!this.firstDrawn) { this.firstDrawn = true; this.root.dataset.ready = '1'; }
  }
  private txt(key: string, el: HTMLElement | null | undefined, v: string) { if (!el || this.lastText[key] === v) return; this.lastText[key] = v; el.textContent = v; }
  private sx(x: number) { return this.ox + x * this.scale; }
  private sy(y: number) { return this.oy + y * this.scale; }

  private overlay(fr: number) {
    const T = this.tracks; const E = this.els;
    // loader
    if (E.loader) { const p = Math.min(1, this.loaded / 30); E.loader.style.opacity = this.firstDrawn ? '0' : '1'; this.txt('lp', E.loaderPct, `${Math.round(p * 100)}%`); }
    // chapter copy: --p in 0..1 (in, hold, out)
    for (const c of this.copy) {
      const p = c.a === c.b ? 1 - smooth(c.c, c.d, fr) : smooth(c.a, c.b, fr) * (1 - smooth(c.c, c.d, fr));
      const q = Math.round(p * 1000) / 1000;
      if (c.el.dataset.p !== String(q)) { c.el.dataset.p = String(q); c.el.style.setProperty('--p', String(q)); c.el.style.visibility = q <= 0 ? 'hidden' : 'visible'; c.el.style.pointerEvents = q > 0.6 ? 'auto' : 'none'; }
      const lp = smooth(c.a, c.b + (c.c - c.b) * 0.5, fr); c.el.style.setProperty('--lp', lp.toFixed(3));
    }
    for (const c of this.counts) { const lp = Number(c.copy.style.getPropertyValue('--lp') || 0); const v = String(Math.round(c.n * (1 - Math.pow(1 - lp, 3)))); if (c.el.textContent !== v) c.el.textContent = v; }
    for (const y of this.typed) {
      const n = Math.round(clamp((fr - y.a) / (y.b - y.a)) * y.full.length);
      if (n !== y.n) { y.n = n; y.el.textContent = y.full.slice(0, n); y.el.dataset.done = n >= y.full.length ? '1' : n > 0 ? '0' : ''; }
    }
    // HUD: chapter, progress, clock, altitude
    const ci = Math.max(0, CHAPTERS.findIndex((c) => fr >= c.range[0] && fr < c.range[1]));
    const chIdx = fr >= N - 1 ? CHAPTERS.length - 1 : ci;
    this.txt('ci', E.chIdx, `${pad(chIdx + 1)} / ${pad(CHAPTERS.length)}`);
    this.txt('cn', E.chName, CHAPTERS[chIdx].name);
    if (E.progress) Array.from(E.progress.children).forEach((seg, i) => { const [a, b] = CHAPTERS[i].range; (seg.firstElementChild as HTMLElement).style.transform = `scaleX(${clamp((fr - a) / (b - a))})`; seg.classList.toggle(s.segOn, i === chIdx); });
    if (E.scrollCue) E.scrollCue.style.opacity = String(1 - smooth(2, 14, fr));
    if (!T) return;
    const i0 = Math.min(N - 1, Math.floor(fr)), i1 = Math.min(N - 1, i0 + 1), t = fr - i0;
    const secs = T.t[i0] + (T.t[i1] - T.t[i0]) * t; const base = 23 * 3600 + 41 * 60 + 12 + secs;
    this.txt('clk', E.clock, `${pad((base / 3600) % 24)}:${pad((base / 60) % 60)}:${pad(base % 60)}Z`);
    const alt = T.cam[i0] + (T.cam[i1] - T.cam[i0]) * t;
    this.txt('alt', E.alt, `${fmtFt(Math.round(alt / 10) * 10)}`);
    if (E.altTape) E.altTape.style.transform = `translateY(${((Math.log10(Math.max(30, alt)) - 1.5) * 220).toFixed(1)}px)`;
    // data blocks
    const chKey = CHAPTERS[ci].key;
    const edge = (a: number, b: number) => smooth(a, a + 6, fr) * (1 - smooth(b - 6, b, fr));
    const mode = chKey === 'scope' || chKey === 'outro' ? 'radar' : chKey === 'field' ? (fr < 112 ? 'radar' : 'none') : chKey;
    const fade = edge(CHAPTERS[ci].range[0], CHAPTERS[ci].range[1]) * (chKey === 'scope' ? 1 : 1) * (chKey === 'outro' ? smooth(456, 466, fr) : 1);
    const A = T.f[i0], B = T.f[i1];
    const rows: { r: Row; x: number; y: number }[] = [];
    for (const r of A) {
      const q = B.find((b) => b[0] === r[0]);
      const x = q ? r[1] + (q[1] - r[1]) * t : r[1], y = q ? r[2] + (q[2] - r[2]) * t : r[2];
      rows.push({ r, x, y });
    }
    let used = 0;
    const want = rows.filter(({ r }) => {
      const ac = T.ac[r[0]]; const ph = T.phases[r[5]];
      if (mode === 'radar') return r[3] > 0 || ac.id === 'hero';
      if (mode === 'approach') return ac.kind === 'arr' && r[3] > 0;
      if (mode === 'final' || mode === 'voice') return ac.id === 'hero';
      if (mode === 'ground') return r[3] < 50 && r[6] > 10 && ph !== 'AT GATE';
      return false;
    }).sort((a, b) => (T.ac[a.r[0]].id === 'hero' ? -1 : 0) - (T.ac[b.r[0]].id === 'hero' ? -1 : 0)).slice(0, this.tags.length);
    for (const { r, x, y } of want) {
      const el = this.tags[used]; const ac = T.ac[r[0]]; const ph = T.phases[r[5]];
      const X = this.sx(x), Y = this.sy(y);
      if (X < -40 || X > window.innerWidth + 40 || Y < -40 || Y > window.innerHeight + 40) continue;
      let html: string;
      const kind = ac.kind;
      if (mode === 'radar') html = `<b>${ac.cs}</b><span>${pad(Math.round(r[3] / 100), 3)} ${pad(Math.round(r[4] / 10), 2)}</span>`;
      else if (mode === 'approach') html = `<b>${ac.cs}</b><em>${ac.type}</em><span>${fmtFt(Math.round(r[3] / 10) * 10)} ft · ${r[4]} kt</span><span class="${s.ph}">${ph}</span>`;
      else if (mode === 'final') html = `<b>${ac.cs}</b><em>${ac.type}</em><span class="${s.ph}">${fr < 262 ? 'CLEARED TO LAND 31R' : 'LANDED 31R'}</span>`;
      else if (mode === 'voice') html = `<b>${ac.cs}</b><span class="${s.ph}">TAXI STAND B20B</span>`;
      else html = `<b>${ac.cs}</b><em>${ac.type}</em><span class="${s.ph}">${ph}</span>`;
      if (this.tagText[used] !== html) { this.tagText[used] = html; el.querySelector('div')!.innerHTML = html; }
      el.dataset.kind = kind; el.dataset.mode = mode;
      el.style.transform = `translate3d(${X.toFixed(1)}px, ${Y.toFixed(1)}px, 0)`;
      el.style.opacity = fade.toFixed(3);
      used++;
    }
    for (let j = used; j < this.tags.length; j++) if (this.tags[j].style.opacity !== '0') this.tags[j].style.opacity = '0';
    // anchors
    const AN = T.an[i0], AN1 = T.an[i1];
    const showA: Record<string, number> = {
      '31R': edge(130, 236), MANHATTAN: edge(140, 236), TWR: edge(296, 412), JFK: mode === 'radar' ? fade : 0, '5NM': edge(416, 452), '13NM': edge(416, 452), '31L': edge(300, 360), '10NM': edge(0, 60) + smooth(456, 466, fr),
    };
    this.anchors.forEach((el) => {
      const key = el.dataset.anchor!; const ix = T.anchors.indexOf(key); const p = AN[ix], q = AN1[ix];
      const o = showA[key] || 0;
      if (!p || o <= 0.001) { if (el.style.opacity !== '0') el.style.opacity = '0'; return; }
      const x = q ? p[0] + (q[0] - p[0]) * t : p[0], y = q ? p[1] + (q[1] - p[1]) * t : p[1];
      el.style.transform = `translate3d(${this.sx(x).toFixed(1)}px, ${this.sy(y).toFixed(1)}px, 0)`; el.style.opacity = o.toFixed(3);
    });
    // spacing bracket between DAL220 and JBU623 on the approach
    const br = E.bracket;
    if (br) {
      const h = rows.find((r) => T.ac[r.r[0]].id === 'hero'), b = rows.find((r) => T.ac[r.r[0]].id === 'a2');
      const o = edge(140, 202);
      if (h && b && o > 0) {
        const x1 = this.sx(h.x), y1 = this.sy(h.y), x2 = this.sx(b.x), y2 = this.sy(b.y);
        E.bracketLine!.setAttribute('d', `M${x1.toFixed(1)},${(y1 + 22).toFixed(1)} L${x1.toFixed(1)},${(y1 + 34).toFixed(1)} L${x2.toFixed(1)},${(y2 + 34).toFixed(1)} L${x2.toFixed(1)},${(y2 + 22).toFixed(1)}`);
        const sp = T.sp[i0] + (T.sp[i1] - T.sp[i0]) * t;
        this.txt('sp', E.bracketLabel, `${sp.toFixed(1)} NM`);
        (E.bracketLabel as HTMLElement).style.transform = `translate3d(${((x1 + x2) / 2).toFixed(1)}px, ${((y1 + y2) / 2 + 44).toFixed(1)}px, 0)`;
        br.style.opacity = o.toFixed(3);
      } else br.style.opacity = '0';
    }
    // final: the hero's numbers, touchdown
    const hero = rows.find((r) => T.ac[r.r[0]].id === 'hero');
    if (hero) {
      this.txt('ha', E.hudAlt, fmtFt(Math.max(0, Math.round(hero.r[3] / 10) * 10)));
      this.txt('hi', E.hudIas, String(hero.r[4]));
      this.txt('hd', E.hudDist, hero.r[3] > 0 ? (Math.max(0, hero.r[3] - 50) / 318).toFixed(1) : '0.0');
    }
    if (E.touch) { const o = smooth(258, 262, fr) * (1 - smooth(278, 288, fr)); E.touch.style.opacity = o.toFixed(3); E.touch.style.setProperty('--k', smooth(259, 272, fr).toFixed(3)); }
    // ground: the strips follow the real phases
    if (E.strips) (Array.from(E.strips.querySelectorAll('[data-strip]')) as HTMLElement[]).forEach((el) => {
      const ix = T.ac.findIndex((a) => a.id === el.dataset.strip); const r = A.find((q) => q[0] === ix);
      const st = r ? T.phases[r[5]] : el.dataset.last || 'AT GATE'; el.dataset.last = st;
      const box = el.querySelector('[data-st]') as HTMLElement; if (box && box.textContent !== st) { box.textContent = st; el.classList.remove(s.flash); void el.offsetWidth; el.classList.add(s.flash); }
    });
    // voice: waveform while talking, latency bar after release
    const vp = clamp((fr - 366) / 18);
    const talk = vp > 0 && vp < 1 ? Math.sin(vp * Math.PI) : 0;
    this.bars.forEach((b, i) => { const n = 0.25 + 0.75 * Math.abs(Math.sin(i * 1.7 + fr * 0.9) * Math.cos(i * 0.6 + fr * 0.37)); b.style.transform = `scaleY(${(0.06 + talk * n).toFixed(3)})`; });
    if (E.latency) E.latency.style.setProperty('--l', smooth(386, 398, fr).toFixed(3));
    // ai: the seats flip
    if (E.toggles) { const k = fr; E.toggles.dataset.tower = k < 426 ? 'you' : 'ai'; E.toggles.dataset.app = k < 436 ? 'ai' : k < 444 ? 'you' : 'ai'; }
  }
}

// ---------------- the page ----------------
export default function LandingJfk() {
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (!ref.current) return;
    const e = new FilmEngine(ref.current);
    return () => e.destroy();
  }, []);
  const L = (i: number, children: React.ReactNode, cls = '') => <span className={`${s.line} ${cls}`} style={{ ['--i' as string]: i }}>{children}</span>;
  return (
    <main ref={ref} className={s.root}>
      <header className={s.nav}>
        <Link href="/landing/jfk" className={s.brand} aria-label="SKYCONTROL">
          <svg viewBox="0 0 24 24" aria-hidden="true" className={s.logo}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="5.5" /><path d="M12 12 L19 5" /></svg>
          SKYCONTROL
        </Link>
        <div className={s.navMid}>
          <span className={s.live}><i />KJFK</span>
          <span data-el="chIdx" className={s.navIdx}>01 / 08</span>
          <span data-el="chName" className={s.navName}>Radar</span>
        </div>
        <Link href="/" className={s.navCta}>Play JFK</Link>
      </header>

      <section data-film className={s.film}>
        <div data-stage className={s.stage}>
          <canvas className={s.canvas} aria-hidden="true" />
          <div className={s.shade} aria-hidden="true" />

          {/* data blocks on the traffic */}
          <div className={s.tags} aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} data-tag className={s.tag} style={{ opacity: 0 }}><i className={s.tagDot} /><i className={s.tagLead} /><div className={s.tagBox} /></div>
            ))}
            {[['31R', 'RWY 31R'], ['31L', 'RWY 31L'], ['TWR', 'JFK TOWER'], ['MANHATTAN', 'MANHATTAN'], ['JFK', 'KJFK'], ['5NM', 'TOWER · 5 NM'], ['13NM', 'APPROACH · 13 NM'], ['10NM', '10 NM']].map(([k, label]) => (
              <div key={k} data-anchor={k} className={`${s.anchor} ${k === '5NM' ? s.anTwr : k === '13NM' ? s.anApp : ''}`} style={{ opacity: 0 }}><span>{label}</span></div>
            ))}
            <div data-el="bracket" className={s.bracket} style={{ opacity: 0 }}>
              <svg className={s.bracketSvg}><path data-el="bracketLine" d="" /></svg>
              <span data-el="bracketLabel" className={s.bracketLabel}>3.9 NM</span>
            </div>
          </div>

          {/* HUD */}
          <div className={s.hudLeft} aria-hidden="true">
            <span data-el="clock">23:41:12Z</span>
            <span>ATIS K · WIND 310/12 · ILS 31R · DEP 31L</span>
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

          {/* chapter copy (data-copy = in-start, in-end, out-start, out-end, in film frames) */}
          <div className={s.copyWrap}>
            <article data-copy="0,0,26,46" className={`${s.copy} ${s.hero}`}>
              {L(0, 'Air traffic control simulator · KJFK', s.eyebrow)}
              <h1 className={s.h1}>{L(1, 'Take the')} {L(2, 'frequency')} {L(3, 'at JFK.')}</h1>
              {L(4, <>Vector it, sequence it, land it. Push it, taxi it, launch it. Real traffic into New York's busiest gateway, in your browser, <em>with your voice</em>.</>, s.lead)}
              <span className={`${s.line} ${s.ctaRow}`} style={{ ['--i' as string]: 5 }}>
                <Link href="/" className={s.ctaPrimary}>Play JFK now</Link>
                <span className={s.ctaNote}>Free · no install · scroll to see how it plays</span>
              </span>
            </article>

            <article data-copy="62,78,114,128" className={s.copy}>
              {L(0, '01 · The airport', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'The real JFK,')} {L(2, 'every line of it.')}</h2>
              {L(3, 'Built from OpenStreetMap: the runways, every taxiway, every stand and hold-short line. Taxi routes are found on the real network, with turns a 777 can actually make.', s.body)}
              <span className={`${s.line} ${s.stats}`} style={{ ['--i' as string]: 4 }}>
                {[[4, 'runways'], [174, 'taxiways'], [300, 'stands'], [233, 'hold-short points']].map(([n, l]) => (
                  <span key={l} className={s.stat}><b data-count={n} className={s.count}>0</b>{l}</span>
                ))}
              </span>
            </article>

            <article data-copy="136,150,190,202" className={s.copy}>
              {L(0, '02 · Approach', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Build the line')} {L(2, 'into 31 Right.')}</h2>
              {L(3, 'Turn arrivals off the downwind, descend them through each other, slot them onto the ILS at 30° or less. Three miles or a thousand feet, more behind a heavy.', s.body)}
              <span className={`${s.line} ${s.cmds}`} style={{ ['--i' as string]: 4 }}>
                <code>JBU623 HDG 340 THEN DESCEND 3000</code>
                <code>DAL220 CLEARED ILS 31R</code>
                <code>DAL220 CONTACT TOWER</code>
              </span>
            </article>

            <article data-copy="212,226,278,290" className={s.copy}>
              {L(0, '03 · Tower', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Cleared to land.')}</h2>
              <span className={`${s.line} ${s.radio}`} style={{ ['--i' as string]: 2 }}>
                <span className={s.rx}><i>TWR</i><q className={s.type} data-type="224,250">Delta two-twenty, wind three-one-zero at one-two, runway three-one right, cleared to land.</q></span>
                <span className={s.rx}><i className={s.plt}>DAL220</i><q className={s.type} data-type="252,270">Cleared to land three-one right, Delta two-twenty.</q></span>
              </span>
              <span className={`${s.line} ${s.hudNums}`} style={{ ['--i' as string]: 3 }}>
                <span><small>ALT</small><b data-el="hudAlt">1,200</b><small>FT</small></span>
                <span><small>IAS</small><b data-el="hudIas">140</b><small>KT</small></span>
                <span><small>THR</small><b data-el="hudDist">3.2</b><small>NM</small></span>
              </span>
            </article>
            <div data-el="touch" className={s.touch} style={{ opacity: 0 }} aria-hidden="true"><i /><span>TOUCHDOWN · RWY 31R</span></div>

            <article data-copy="298,312,348,360" className={s.copy}>
              {L(0, '04 · Ground', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Then the hard part:')} {L(2, 'the ground.')}</h2>
              {L(3, 'Pushbacks into live taxi lanes, runway crossings, hold-shorts, take-offs threaded between arrivals. Every conflict is scored.', s.body)}
              <span data-el="strips" className={`${s.line} ${s.strips}`} style={{ ['--i' as string]: 4 }}>
                {[['d2', 'DAL400', 'A320', 'B20A'], ['d3', 'JBU1001', 'A320', 'A2A'], ['d1', 'AFR7', 'B77W', 'S']].map(([id, cs, ty, st]) => (
                  <span key={id} data-strip={id} className={s.strip}><b>{cs}</b><em>{ty} · {st}</em><i data-st>AT GATE</i></span>
                ))}
              </span>
            </article>

            <article data-copy="364,372,402,411" className={s.copy}>
              {L(0, '05 · Voice', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Just talk.')}</h2>
              {L(2, 'Hold the key and say it the way a controller would. Your words are recognised while you speak, read as a clearance, and the pilot reads it back in their own voice.', s.body)}
              <span className={`${s.line} ${s.voice}`} style={{ ['--i' as string]: 3 }}>
                <span className={s.ptt}><kbd>SPACE</kbd><span data-wave className={s.wave}>{Array.from({ length: 36 }, (_, i) => <i key={i} />)}</span></span>
                <q className={s.type} data-type="368,384">Delta two-twenty, taxi to stand bravo two-zero bravo.</q>
                <code className={s.parsed} data-type="385,390">DAL220 TAXI STAND B20B</code>
                <span data-el="latency" className={s.latency}>
                  <span style={{ ['--w' as string]: 0.3 }}><i />speech</span>
                  <span style={{ ['--w' as string]: 0.3 }}><i />command</span>
                  <span style={{ ['--w' as string]: 0.4 }}><i />pilot voice</span>
                  <b>≈ 1.1 s from release to readback</b>
                </span>
              </span>
            </article>

            <article data-copy="414,421,444,451" className={s.copy}>
              {L(0, '06 · Two seats', s.eyebrow)}
              <h2 className={s.h2}>{L(1, 'Work one seat.')} {L(2, 'Hand the AI the other.')}</h2>
              {L(3, 'Tower runs the ground and the runways, Approach runs the sky. Either can be you or the AI, and you can swap mid-session.', s.body)}
              <span data-el="toggles" className={`${s.line} ${s.toggles}`} style={{ ['--i' as string]: 4 }} data-tower="you" data-app="ai">
                <span className={s.seat} data-seat="tower"><b>Tower</b><span className={s.sw}><i>You</i><i>AI</i></span></span>
                <span className={s.seat} data-seat="app"><b>Approach</b><span className={s.sw}><i>You</i><i>AI</i></span></span>
              </span>
              {L(5, '24 full-traffic test sessions at JFK with the AI on both seats: zero losses of separation.', s.fine)}
            </article>

            <article data-copy="456,468,600,601" className={`${s.copy} ${s.outro}`}>
              {L(0, 'Free · in your browser · KJFK now, more airports soon', s.eyebrow)}
              <h2 className={s.h1}>{L(1, 'Your scope.')} {L(2, 'Your sky.')}</h2>
              <span className={`${s.line} ${s.ctaRow}`} style={{ ['--i' as string]: 3 }}>
                <Link href="/" className={s.ctaPrimary}>Take the frequency</Link>
                <Link href="/settings" className={s.ctaGhost}>Settings &amp; voice</Link>
              </span>
            </article>
          </div>

          <div data-el="loader" className={s.loader} aria-hidden="true"><i /><span>Tuning the scope <b data-el="loaderPct">0%</b></span></div>
        </div>
      </section>

      <section className={s.after}>
        <div className={s.grid}>
          {[
            ['Real airport', 'JFK from OpenStreetMap: runways, taxiways, stands, hold-short lines. Taxi routing on the real graph.'],
            ['Two seats', 'Tower (ground and runways) and Approach (the sky). You or the AI on each, switchable at any time.'],
            ['Your voice', 'Push to talk. Streaming speech recognition, a command model for ATC phraseology, pilots who read back.'],
            ['Real rules', 'Separation, wake turbulence on final, ILS intercepts, runway crossings, go-arounds, emergencies.'],
            ['Scored', 'Every loss of separation, wake encounter, ground conflict and long delay counts against you.'],
            ['3D and radar', 'A 3D world view of the airport and a radar scope for the approach, in the browser.'],
          ].map(([h, p], i) => (
            <div key={h} className={s.card}><span className={s.cardIdx}>{pad(i + 1)}</span><h3>{h}</h3><p>{p}</p></div>
          ))}
        </div>
        <div className={s.final}>
          <h2>Ready when you are.</h2>
          <Link href="/" className={s.ctaPrimary}>Play JFK now</Link>
        </div>
        <footer className={s.footer}><span>SKYCONTROL</span><span>Film rendered from the game's own JFK data.</span></footer>
      </section>
    </main>
  );
}

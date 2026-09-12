'use client';
// ============================================================
//  ApproachView — the APPROACH position scope (00-MASTER-PLAN §2.4, 04 §2.2 /
//  §4, 01 A10). A DPR-aware canvas painted by render.ts every animation frame
//  straight from `sim` (never through React), a RadarCamera for pan / zoom /
//  follow, and a thin DOM layer for the pieces that must be real elements:
//  the wind / ATIS / range corner chip, the map toolbar, the drag-vector
//  confirm bubble, the hover tooltip, measure readouts and the edge arrow.
//
//  Every gesture ends in the store: select / hover, transmit('action-heading'
//  | 'action-direct' | 'action-ils' | 'action-altitude'), updateSettings
//  (rings), pushToast. The view registers itself as the 'radar' projector so
//  the test API's screenPos / centerOn / camera work (05 §3.2).
// ============================================================
import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { sim, useSim, useSimVersion } from '../simStore';
import type { SimEngine } from '@/lib/sim/engine';
import { isAirborne } from '@/lib/sim/aircraft';
import { stageLabel } from '@/lib/sim/stage';
import { advance, angleDelta, NM_TO_M } from '@/lib/sim/projection';
import type { XY } from '@/lib/sim/projection';
import { coordToXY } from '@/lib/airspace/eairport';
import { distAlongFwd, gsAltFt, ILS_CONST } from '@/lib/sim/ils';
import type { AircraftState } from '@/lib/sim/types';
import { Button, Dial, Icon, IconButton, Kbd, cx, usePrefersReducedMotion } from '@/design';
import styles from './ApproachView.module.css';
import { RadarCamera } from './camera';
import { readTheme } from './theme';
import type { RadarTheme } from './theme';
import { PositionHistory } from './history';
import { LabelPlacer } from './labels';
import { paint, ilsUnderCursor } from './render';
import type { Frame, HitGeometry, Measure, HeadingDrag, ProjectedRoute } from './render';
import { magnetic, trueFromMag, hdg3, bearingTrue, distNM } from './geometry';
import { installRadarApi } from './api';
import type { ApproachViewApi, RangePreset } from './api';

// ── constants ──────────────────────────────────────────────────────────────────
const HIT_PX = 16;          // select radius (05 §3.2)
const DRAG_PX = 12;         // drag-to-heading threshold (04 §4)
const MEASURE_PX = 6;       // right-drag becomes a measure after this
const FIX_SNAP_PX = 18;     // drop onto a fix (04 §4)
const HOVER_MS = 150;
const BUBBLE_TTL_MS = 8000;
const ZOOM_STEP = 1.25;
const ALT_STEP = 1000;
const ALT_MIN = 1000;
const ALT_MAX = 45000;
const EDGE_INSET = 28;

// ── view-side state (tiny external store; the RAF loop never re-renders React) ──
export type Draft =
  | { kind: 'heading'; id: number; hdgTrue: number; dir: 'L' | 'R' | null; anchor: XY }
  | { kind: 'direct'; id: number; fix: string; anchor: XY }
  | { kind: 'ils'; id: number; runway: string; anchor: XY }
  | { kind: 'altitude'; id: number; ft: number; anchor: null };

interface UiState {
  follow: boolean;
  measureTool: boolean;
  range: RangePreset | null;
  ringsCentre: 'field' | 'selected';
  draft: Draft | null;
  /** Bumped whenever the bubble's auto-dismiss timer restarts (replays the drain bar). */
  ttlKey: number;
  tooltipId: number | null;
  measures: Measure[];
  hasLive: boolean;
  /** Half of the shorter screen edge in NM (the chip's range readout). */
  visibleNM: number;
  noAirspace: boolean;
}

class ViewStore {
  state: UiState = { follow: false, measureTool: false, range: null, ringsCentre: 'field', draft: null, ttlKey: 0, tooltipId: null, measures: [], hasLive: false, visibleNM: 0, noAirspace: false };
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  patch(p: Partial<UiState>): void {
    let changed = false;
    for (const k of Object.keys(p) as Array<keyof UiState>) if (!Object.is(this.state[k], p[k])) { changed = true; break; }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
}

type PointerMode = 'idle' | 'pan' | 'vector' | 'measure' | 'armed-vector' | 'armed-select' | 'armed-measure' | 'armed-context';
interface PointerState {
  mode: PointerMode;
  pointerId: number;
  button: number;
  startX: number; startY: number;
  lastX: number; lastY: number;
  /** Aircraft under the pointer at pointerdown (armed-vector / armed-select / armed-context). */
  id: number | null;
  /** Measure start (world) and its aircraft, if the press landed on one. */
  startWorld: XY | null;
  startId: number | null;
  /** Click-click measure: first point set, waiting for the second. */
  clickA: { xy: XY; id: number | null } | null;
}
const IDLE: PointerState = { mode: 'idle', pointerId: -1, button: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, id: null, startWorld: null, startId: null, clickA: null };

interface Els {
  bubble: HTMLElement | null;
  tooltip: HTMLElement | null;
  dragPill: HTMLElement | null;
  edge: HTMLElement | null;
  edgeIcon: HTMLElement | null;
  live: HTMLElement | null;
  measures: Array<HTMLElement | null>;
}

const fmtAlt = (ft: number) => (ft >= 18000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${Math.round(ft).toLocaleString('en-US')} ft`);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ══════════════════════════════════════════════════════════════════════════════
//  Controller: owns the camera, the RAF loop, input and every DOM-side update
// ══════════════════════════════════════════════════════════════════════════════
class RadarController {
  readonly cam = new RadarCamera();
  readonly ui = new ViewStore();
  readonly els: Els = { bubble: null, tooltip: null, dragPill: null, edge: null, edgeIcon: null, live: null, measures: [] };
  reducedMotion = false;

  private history = new PositionHistory();
  private placer = new LabelPlacer();
  private theme: RadarTheme | null = null;
  private wrap: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private lastNow = 0;
  private dpr = 1;
  private fontsReady = false;
  private hit: HitGeometry | null = null;
  private ptr: PointerState = { ...IDLE };
  private drag: HeadingDrag | null = null;
  private liveMeasure: Measure | null = null;
  private hoverTimer = 0;
  private hoverId: number | null = null;
  private bubbleTimer = 0;
  private lastEngine: SimEngine | null = null;
  private routes: ProjectedRoute[] = [];
  private boundary: XY[] | null = null;
  private fitted = false;
  private unregister: (() => void) | null = null;
  private lastVisibleNM = -1;

  // ── lifecycle ────────────────────────────────────────────────────────────────
  mount(wrap: HTMLDivElement, canvas: HTMLCanvasElement): void {
    this.wrap = wrap; this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.theme = readTheme(wrap);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onWindowKey, true);
    const ready = typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve();
    ready.then(() => { this.fontsReady = true; }).catch(() => { this.fontsReady = true; });
    this.unregister = sim.registerProjector('radar', this.project, this.centerOnXY, () => this.cam.view(), {
      setCamera: (c) => { if ('x' in c) { this.cam.set(c.x, c.y, c.zoom); this.ui.patch({ range: null }); } },
      size: () => (this.cam.width > 1 ? { w: this.cam.width, h: this.cam.height } : null),
    });
    installRadarApi(this.api());
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  unmount(): void {
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.ro?.disconnect(); this.ro = null;
    this.canvas?.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onWindowKey, true);
    window.clearTimeout(this.hoverTimer); window.clearTimeout(this.bubbleTimer);
    this.unregister?.(); this.unregister = null;
    installRadarApi(null);
    if (this.hoverId != null) sim.hover(null);
    this.wrap = null; this.canvas = null; this.ctx = null;
  }

  private resize(): void {
    const wrap = this.wrap, canvas = this.canvas; if (!wrap || !canvas) return;
    const w = Math.max(1, Math.round(wrap.clientWidth)), h = Math.max(1, Math.round(wrap.clientHeight));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * this.dpr); canvas.height = Math.round(h * this.dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    this.cam.width = w; this.cam.height = h;
    if (!this.fitted) this.fitScene(false);
  }

  // ── projector (test API + panels) ────────────────────────────────────────────
  private project = (xy: XY): { x: number; y: number } | null => {
    if (!this.canvas || this.cam.width <= 1) return null;
    const s = this.cam.toScreen(xy);
    return { x: s.x, y: s.y };
  };
  private centerOnXY = (xy: XY): void => {
    this.cam.centerOn(xy, undefined, this.animate());
    this.setFollow(false, true);
    this.ui.patch({ range: null });
  };
  private animate(): boolean { return !sim.testMode && !this.reducedMotion; }

  // ── scene (per airport) ──────────────────────────────────────────────────────
  private ensureScene(e: SimEngine): void {
    if (e === this.lastEngine) return;
    this.lastEngine = e;
    this.history.clear();
    this.placer = new LabelPlacer();
    this.hit = null;
    this.drag = null; this.liveMeasure = null; this.ptr = { ...IDLE };
    this.ui.patch({ measures: [], hasLive: false, draft: null, tooltipId: null, follow: false, noAirspace: !sim.radar });
    this.cam.follow = null;
    const ap = sim.airspace;
    this.routes = [];
    this.boundary = null;
    if (ap) {
      for (const r of [...ap.sids, ...ap.stars]) {
        const pts = r.waypoints.map(w => e.proj.toXY(w.lat, w.lng));
        if (pts.length > 1) this.routes.push({ name: r.name, kind: r.kind, runways: r.runways, beacon: r.beacon ?? null, pts });
      }
      const b = ap.airspace.boundary.map(c => coordToXY(c, e.proj));
      if (b.length > 2) this.boundary = b;
    }
    this.fitted = false;
    this.fitScene(false);
  }

  /** Fit the whole TMA (range preset "30"). */
  private fitScene(animateFit: boolean): void {
    const e = sim.engine; if (!e || this.cam.width <= 1) return;
    const centre = sim.radar ? sim.radar.centerXY : e.centerXY;
    const radiusM = sim.radar ? sim.radar.radiusM : e.airspaceRadiusM;
    this.cam.fitRadius(centre, radiusM, animateFit);
    this.fitted = true;
    this.ui.patch({ range: '30' });
  }

  // ── frame loop ───────────────────────────────────────────────────────────────
  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const ctx = this.ctx, t = this.theme; if (!ctx || !t) return;
    const dtMs = Math.min(100, now - this.lastNow); this.lastNow = now;
    const W = this.cam.width, H = this.cam.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const e = sim.engine;
    if (!e || !this.fontsReady) { ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H); return; }
    this.ensureScene(e);

    // follow: track the selection; a manual pan (cam.follow reset by panBy) turns it off with a toast
    const ui = this.ui.state;
    if (ui.follow) {
      if (this.cam.follow == null) { this.ui.patch({ follow: false }); sim.pushToast({ kind: 'info', text: 'Follow off', duration: 2500 }); }
      else if (sim.selectedId !== this.cam.follow) { this.cam.follow = sim.selectedId; if (sim.selectedId == null) this.ui.patch({ follow: false }); }
    }
    const followed = this.cam.follow != null ? e.byId(this.cam.follow) : undefined;
    this.cam.step(now, dtMs, followed ? followed.pos : null);
    if (this.cam.follow != null && !followed) { this.cam.follow = null; this.ui.patch({ follow: false }); }

    this.history.update(e.aircraft, e.time);
    this.syncMeasures(e);

    const visibleNM = Math.round((Math.min(W, H) / 2) / this.cam.pxPerNM);
    if (visibleNM !== this.lastVisibleNM) { this.lastVisibleNM = visibleNM; this.ui.patch({ visibleNM }); }

    const draft = this.ui.state.draft;
    const frame: Frame = {
      ctx, t, cam: this.cam, now, engine: e, radar: sim.radar, airspace: sim.airspace, routes: this.routes, boundary: this.boundary,
      fieldXY: { x: 0, y: 0 }, position: sim.position, selectedId: sim.selectedId, hoveredId: this.drag ? null : sim.hoveredId,
      showRings: sim.settings.showRings, ringsCentre: this.ui.state.ringsCentre, history: this.history, placer: this.placer,
      alerts: sim.alerts(), stageOf: (a) => sim.stageOf(a), drag: this.drag,
      draftHeading: draft && draft.kind === 'heading' ? { id: draft.id, hdgTrue: draft.hdgTrue, dir: draft.dir } : null,
      measures: this.ui.state.measures, liveMeasure: this.liveMeasure, reducedMotion: this.reducedMotion,
    };
    this.hit = paint(frame);
    this.updateOverlays(e, this.hit);
  };

  /** Measure endpoints that were dropped on an aircraft follow it (time-to-point at its ground speed). */
  private syncMeasures(e: SimEngine): void {
    const upd = (m: Measure): Measure => {
      let a = m.a, b = m.b, aId = m.aId, bId = m.bId, changed = false;
      if (aId != null) { const ac = e.byId(aId); if (ac) { if (ac.pos.x !== a.x || ac.pos.y !== a.y) { a = { x: ac.pos.x, y: ac.pos.y }; changed = true; } } else { aId = null; changed = true; } }
      if (bId != null) { const ac = e.byId(bId); if (ac) { if (ac.pos.x !== b.x || ac.pos.y !== b.y) { b = { x: ac.pos.x, y: ac.pos.y }; changed = true; } } else { bId = null; changed = true; } }
      return changed ? { a, b, aId, bId } : m;
    };
    const ms = this.ui.state.measures;
    let any = false;
    const next = ms.map(m => { const n = upd(m); if (n !== m) any = true; return n; });
    if (any) this.ui.patch({ measures: next });
    if (this.liveMeasure) this.liveMeasure = upd(this.liveMeasure);
  }

  private updateOverlays(e: SimEngine, hit: HitGeometry): void {
    const W = this.cam.width, H = this.cam.height;
    // measure readouts (DOM pills positioned at the line midpoints)
    const mids = hit.measureMid;
    const n = this.ui.state.measures.length;
    for (let i = 0; i < n; i++) {
      const el = this.els.measures[i]; const m = mids[i];
      if (!el || !m) continue;
      el.style.left = `${m.x}px`; el.style.top = `${m.y}px`;
      if (el.textContent !== m.text) el.textContent = m.text;
    }
    const live = this.els.live; const lm = mids[n];
    if (live) { if (lm) { live.hidden = false; live.style.left = `${lm.x}px`; live.style.top = `${lm.y}px`; if (live.textContent !== lm.text) live.textContent = lm.text; } else live.hidden = true; }

    // drag readout at the cursor
    const dp = this.els.dragPill;
    if (dp) {
      if (this.drag && this.ptr.mode === 'vector') {
        dp.hidden = false;
        dp.style.left = `${this.ptr.lastX}px`; dp.style.top = `${this.ptr.lastY}px`;
        dp.dataset.snap = this.drag.snap ? '1' : '0';
        const text = this.drag.snap ? (this.drag.snap.kind === 'fix' ? `Direct ${this.drag.snap.name}` : `ILS ${this.drag.snap.runway}`) : `HDG ${hdg3(magnetic(this.drag.hdgTrue, e.magVar))}${this.drag.dir ? ` ${this.drag.dir}` : ''}`;
        if (dp.textContent !== text) dp.textContent = text;
      } else dp.hidden = true;
    }

    // hover tooltip: 16 px below-right of the symbol, clamped inside the scope
    const tip = this.els.tooltip;
    if (tip) {
      const id = this.ui.state.tooltipId;
      const s = id != null ? hit.symbols.get(id) : undefined;
      if (s && !this.drag) {
        const r = tip.getBoundingClientRect();
        tip.style.left = `${clamp(s.x + 16, 8, Math.max(8, W - r.width - 8))}px`;
        tip.style.top = `${clamp(s.y + 16, 8, Math.max(8, H - r.height - 8))}px`;
      }
    }

    // draft bubble: anchored at the release point (or the aircraft for the altitude draft)
    const bubble = this.els.bubble;
    const draft = this.ui.state.draft;
    if (bubble && draft) {
      const anchor = draft.anchor ?? e.byId(draft.id)?.pos;
      if (anchor) {
        const s = this.cam.toScreen(anchor);
        const r = bubble.getBoundingClientRect();
        bubble.style.left = `${clamp(s.x + 18, 8, Math.max(8, W - r.width - 8))}px`;
        bubble.style.top = `${clamp(s.y - 24, 8, Math.max(8, H - r.height - 8))}px`;
      }
    }

    // edge arrow toward an off-screen selected aircraft
    const edge = this.els.edge;
    if (edge) {
      const sel = sim.selectedId != null ? hit.symbols.get(sim.selectedId) : undefined;
      const off = sel && (sel.x < 0 || sel.y < 0 || sel.x > W || sel.y > H);
      if (off && sel) {
        const cx = W / 2, cy = H / 2;
        const dx = sel.x - cx, dy = sel.y - cy;
        const sx = (W / 2 - EDGE_INSET) / Math.max(1e-6, Math.abs(dx)), sy = (H / 2 - EDGE_INSET) / Math.max(1e-6, Math.abs(dy));
        const k = Math.min(sx, sy);
        edge.hidden = false;
        edge.style.left = `${cx + dx * k - 16}px`; edge.style.top = `${cy + dy * k - 16}px`;
        if (this.els.edgeIcon) this.els.edgeIcon.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
      } else edge.hidden = true;
    }
  }

  // ── hit testing ──────────────────────────────────────────────────────────────
  private pick(sx: number, sy: number): number | null {
    const hit = this.hit; if (!hit) return null;
    let best = HIT_PX, id: number | null = null;
    for (const [k, s] of hit.symbols) { const d = Math.hypot(s.x - sx, s.y - sy); if (d < best) { best = d; id = k; } }
    if (id != null) return id;
    for (const [k, r] of hit.labels) if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return k;
    return null;
  }
  private local(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas?.getBoundingClientRect();
    return r ? { x: ev.clientX - r.left, y: ev.clientY - r.top } : { x: ev.clientX, y: ev.clientY };
  }
  private setCursor(c: 'pointer' | 'grabbing' | 'crosshair' | 'vector' | null): void {
    if (!this.wrap) return;
    if (c) this.wrap.dataset.cursor = c; else delete this.wrap.dataset.cursor;
  }
  private idleCursor(hoverId: number | null): void {
    this.setCursor(this.ui.state.measureTool || this.ptr.clickA ? 'crosshair' : hoverId != null ? 'pointer' : null);
  }

  // ── pointer input ────────────────────────────────────────────────────────────
  onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const e = sim.engine; if (!e || !this.canvas) return;
    this.canvas.focus({ preventScroll: true });
    const { x, y } = this.local(ev);
    const id = this.pick(x, y);
    const world = this.cam.toWorld(x, y);
    const base: PointerState = { ...IDLE, pointerId: ev.pointerId, button: ev.button, startX: x, startY: y, lastX: x, lastY: y, id, startWorld: world, startId: id, clickA: this.ptr.clickA };
    this.canvas.setPointerCapture(ev.pointerId);
    this.hideTooltip();

    // measure: right button, shift + left, or the armed click-click tool
    if (ev.button === 2 || (ev.button === 0 && ev.shiftKey) || (ev.button === 0 && this.ui.state.measureTool)) {
      const a = id != null ? e.byId(id) : undefined;
      const start = a ? { x: a.pos.x, y: a.pos.y } : world;
      if (ev.button === 0 && this.ui.state.measureTool && !ev.shiftKey) {
        // click-click: first click sets A, second click closes the measure
        if (this.ptr.clickA) {
          this.commitMeasure({ a: this.ptr.clickA.xy, b: start, aId: this.ptr.clickA.id, bId: a ? a.id : null });
          this.ptr = { ...base, clickA: null };
        } else {
          this.ptr = { ...base, mode: 'armed-measure', startWorld: start, startId: a ? a.id : null, clickA: { xy: start, id: a ? a.id : null } };
        }
        this.setCursor('crosshair');
        return;
      }
      this.ptr = { ...base, mode: ev.button === 2 && id != null ? 'armed-context' : 'armed-measure', startWorld: start, startId: a ? a.id : null };
      this.setCursor('crosshair');
      return;
    }
    if (ev.button !== 0) return;

    if (id != null) {
      sim.select(id);
      const a = e.byId(id);
      this.ptr = { ...base, mode: a && isAirborne(a) ? 'armed-vector' : 'armed-select' };
      this.setCursor('pointer');
      return;
    }
    // empty scope: deselect, start a pan
    if (this.ui.state.draft) this.cancelDraft();
    sim.select(null);
    this.ptr = { ...base, mode: 'pan' };
    this.cam.beginDrag(performance.now());
    this.setCursor('grabbing');
  };

  onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const e = sim.engine; if (!e) return;
    const { x, y } = this.local(ev);
    const p = this.ptr;
    const moved = Math.hypot(x - p.startX, y - p.startY);
    p.lastX = x; p.lastY = y;
    switch (p.mode) {
      case 'idle': case 'armed-select': {
        const id = this.pick(x, y);
        this.setHover(id);
        this.idleCursor(id);
        return;
      }
      case 'pan':
        return; // handled by handleMove (needs the raw delta)
      case 'armed-vector':
        if (moved > DRAG_PX && p.id != null) { p.mode = 'vector'; this.setHover(null); this.setCursor('vector'); this.updateDrag(e, x, y); }
        return;
      case 'vector':
        this.updateDrag(e, x, y);
        return;
      case 'armed-measure': case 'armed-context':
        if (moved > MEASURE_PX && p.startWorld) {
          p.mode = 'measure';
          this.liveMeasure = { a: p.startWorld, b: this.cam.toWorld(x, y), aId: p.startId, bId: null };
          this.ui.patch({ hasLive: true });
        }
        return;
      case 'measure': {
        if (!this.liveMeasure) return;
        const id = this.pick(x, y);
        const a = id != null && id !== p.startId ? e.byId(id) : undefined;
        this.liveMeasure = { ...this.liveMeasure, b: a ? { x: a.pos.x, y: a.pos.y } : this.cam.toWorld(x, y), bId: a ? a.id : null };
        return;
      }
    }
  };

  onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    const e = sim.engine;
    const p = this.ptr;
    const { x, y } = this.local(ev);
    if (this.canvas?.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
    switch (p.mode) {
      case 'pan':
        this.cam.endDrag(performance.now());
        break;
      case 'vector':
        if (e && this.drag) this.releaseDrag(e, this.drag, this.cam.toWorld(x, y));
        this.drag = null;
        break;
      case 'measure':
        if (this.liveMeasure && Math.hypot(x - p.startX, y - p.startY) > MEASURE_PX) this.commitMeasure(this.liveMeasure);
        this.liveMeasure = null; this.ui.patch({ hasLive: false });
        p.clickA = null; // a drag-measure never leaves a dangling click-click start
        break;
      case 'armed-context':
        if (e && p.id != null) this.openQuickMenu(e, p.id, x, y, ev.clientX, ev.clientY);
        break;
      case 'armed-measure':
        if (p.clickA) { this.ptr = { ...IDLE, clickA: p.clickA }; this.setCursor('crosshair'); return; }
        break;
      default: break;
    }
    this.ptr = { ...IDLE, clickA: p.clickA };
    const id = this.pick(x, y);
    this.setHover(id, true); // re-arm the tooltip timer after a press (the press cancelled it)
    this.idleCursor(id);
  };

  onPointerCancel = (): void => {
    this.drag = null; this.liveMeasure = null;
    if (this.ui.state.hasLive) this.ui.patch({ hasLive: false });
    this.ptr = { ...IDLE };
    this.idleCursor(null);
  };
  onPointerLeave = (): void => { if (this.ptr.mode === 'idle') { this.setHover(null); this.idleCursor(null); } };
  onContextMenu = (ev: React.MouseEvent): void => { ev.preventDefault(); };
  onDoubleClick = (ev: React.MouseEvent<HTMLCanvasElement>): void => {
    const { x, y } = this.local(ev);
    if (this.pick(x, y) != null) return;
    this.cam.zoomBy(ev.shiftKey ? 1 / ZOOM_STEP / ZOOM_STEP : ZOOM_STEP * ZOOM_STEP, x, y);
    this.ui.patch({ range: null });
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const e = sim.engine; if (!e) return;
    const { x, y } = this.local(ev);
    // wheel over the selected airborne target: altitude draft ±1000 ft (04 §4)
    const id = this.pick(x, y);
    if (id != null && id === sim.selectedId) {
      const a = e.byId(id);
      if (a && isAirborne(a)) { this.stepAltitudeDraft(a, ev.deltaY < 0 ? ALT_STEP : -ALT_STEP); return; }
    }
    const f = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.cam.zoomBy(f, x, y);
    this.ui.patch({ range: null });
  };

  /** Pan by the pointer delta (called from the React move handler with explicit deltas). */
  private panDelta(dx: number, dy: number): void { this.cam.panBy(dx, dy, performance.now()); this.ui.patch({ range: null }); }

  // ── drag-to-heading ──────────────────────────────────────────────────────────
  private updateDrag(e: SimEngine, x: number, y: number): void {
    const p = this.ptr; if (p.id == null) return;
    const a = e.byId(p.id); if (!a) { p.mode = 'idle'; this.drag = null; return; }
    const cursor = this.cam.toWorld(x, y);
    const hdgTrue = bearingTrue(a.pos, cursor);
    let snap: HeadingDrag['snap'] = null;
    if (this.hit) {
      let best = FIX_SNAP_PX;
      for (const f of this.hit.fixes) { const d = Math.hypot(f.x - x, f.y - y); if (d < best) { best = d; snap = { kind: 'fix', name: f.name, xy: f.xy }; } }
    }
    if (!snap) { const rwy = ilsUnderCursor(e, cursor); if (rwy) snap = { kind: 'ils', runway: rwy }; }
    this.drag = { id: a.id, cursor, hdgTrue, dir: this.drag?.dir ?? null, snap };
  }

  private releaseDrag(e: SimEngine, d: HeadingDrag, at: XY): void {
    const a = e.byId(d.id); if (!a) return;
    let draft: Draft;
    if (d.snap?.kind === 'fix') draft = { kind: 'direct', id: a.id, fix: d.snap.name, anchor: at };
    else if (d.snap?.kind === 'ils') draft = { kind: 'ils', id: a.id, runway: d.snap.runway, anchor: at };
    else {
      const mag = magnetic(d.hdgTrue, e.magVar);
      draft = { kind: 'heading', id: a.id, hdgTrue: trueFromMag(mag, e.magVar), dir: d.dir, anchor: at };
    }
    if (sim.settings.instantVectors) { this.send(draft); return; }
    this.openDraft(draft);
  }

  private stepAltitudeDraft(a: AircraftState, delta: number): void {
    const cur = this.ui.state.draft;
    const base = cur && cur.kind === 'altitude' && cur.id === a.id ? cur.ft : (a.cmdAltitude ?? Math.round(a.altitude / 1000) * 1000);
    const ft = clamp(Math.round((base + delta) / 100) * 100, ALT_MIN, ALT_MAX);
    this.openDraft({ kind: 'altitude', id: a.id, ft, anchor: null });
  }

  private openDraft(d: Draft): void {
    this.ui.patch({ draft: d, ttlKey: this.ui.state.ttlKey + 1, tooltipId: null });
    this.armBubbleTimer();
  }
  private armBubbleTimer(): void {
    window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => { if (this.ui.state.draft) this.cancelDraft(); }, BUBBLE_TTL_MS);
  }
  private touchDraft(patch: Partial<Draft>): void {
    const d = this.ui.state.draft; if (!d) return;
    this.ui.patch({ draft: { ...d, ...patch } as Draft, ttlKey: this.ui.state.ttlKey + 1 });
    this.armBubbleTimer();
  }

  cancelDraft = (): void => {
    window.clearTimeout(this.bubbleTimer);
    if (this.ui.state.draft) this.ui.patch({ draft: null });
  };
  sendDraft = (): boolean => {
    const d = this.ui.state.draft; if (!d) return false;
    this.cancelDraft();
    return this.send(d);
  };
  private send(d: Draft): boolean {
    const e = sim.engine; if (!e) return false;
    const a = e.byId(d.id); if (!a) return false;
    switch (d.kind) {
      case 'heading': { const mag = magnetic(d.hdgTrue, e.magVar); sim.transmit('action-heading', { heading: trueFromMag(mag, e.magVar), dir: d.dir }, a); return true; }
      case 'direct': sim.transmit('action-direct', { fix: d.fix }, a); return true;
      case 'ils': sim.transmit('action-ils', { runway: d.runway, approachType: 'ILS' }, a); return true;
      case 'altitude': sim.transmit('action-altitude', { altitude: d.ft }, a); return true;
    }
  }
  setDraftTurn = (dir: 'L' | 'R' | null): void => {
    if (this.drag) this.drag = { ...this.drag, dir };
    const d = this.ui.state.draft;
    if (d && d.kind === 'heading') this.touchDraft({ dir: d.dir === dir ? null : dir });
  };
  setDraftHeadingMag = (mag: number): void => {
    const e = sim.engine; const d = this.ui.state.draft;
    if (!e || !d || d.kind !== 'heading') return;
    this.touchDraft({ hdgTrue: trueFromMag(mag, e.magVar) });
  };
  stepDraftAltitude = (delta: number): void => {
    const e = sim.engine; const d = this.ui.state.draft;
    if (!e || !d || d.kind !== 'altitude') return;
    const a = e.byId(d.id); if (!a) return;
    this.stepAltitudeDraft(a, delta);
  };

  // ── measures ─────────────────────────────────────────────────────────────────
  private commitMeasure(m: Measure): void {
    if (distNM(m.a, m.b) < 0.05) return;
    this.ui.patch({ measures: [...this.ui.state.measures, m] });
  }
  removeMeasure = (i: number): void => { this.ui.patch({ measures: this.ui.state.measures.filter((_, k) => k !== i) }); };
  clearMeasures = (): void => {
    this.liveMeasure = null;
    this.ptr = { ...IDLE };
    this.ui.patch({ measures: [], hasLive: false });
    this.idleCursor(null);
  };
  toggleMeasure = (): void => {
    const on = !this.ui.state.measureTool;
    this.ptr = { ...IDLE };
    this.ui.patch({ measureTool: on });
    this.idleCursor(null);
  };

  // ── hover ────────────────────────────────────────────────────────────────────
  private setHover(id: number | null, force = false): void {
    if (id === this.hoverId && !force) return;
    this.hoverId = id;
    sim.hover(id);
    window.clearTimeout(this.hoverTimer);
    if (id == null) { if (this.ui.state.tooltipId != null) this.ui.patch({ tooltipId: null }); return; }
    this.hoverTimer = window.setTimeout(() => { if (this.hoverId === id && this.ptr.mode === 'idle' && !this.ui.state.draft) this.ui.patch({ tooltipId: id }); }, HOVER_MS);
  }
  private hideTooltip(): void { window.clearTimeout(this.hoverTimer); if (this.ui.state.tooltipId != null) this.ui.patch({ tooltipId: null }); }

  private openQuickMenu(e: SimEngine, id: number, x: number, y: number, clientX: number, clientY: number): void {
    sim.select(id);
    window.dispatchEvent(new CustomEvent('atc:quick-menu', { detail: { x, y, clientX, clientY, kind: 'aircraft', id, at: e.time } }));
  }

  // ── camera actions (toolbar / shell API) ─────────────────────────────────────
  zoomIn = (): void => { this.cam.zoomBy(ZOOM_STEP); this.ui.patch({ range: null }); };
  zoomOut = (): void => { this.cam.zoomBy(1 / ZOOM_STEP); this.ui.patch({ range: null }); };
  setRange = (p: RangePreset): void => {
    const e = sim.engine; if (!e) return;
    const centre = sim.radar ? sim.radar.centerXY : e.centerXY;
    const full = sim.radar ? sim.radar.radiusM : e.airspaceRadiusM;
    this.setFollow(false, true);
    const anim = this.animate();
    if (p === 'final') {
      const end = e.activeEnds('arr').find(r => r.status === 'open') ?? e.activeEnds('arr')[0];
      const rw = end ? (sim.radar?.runways.find(r => r.name === end.name) ?? null) : null;
      const ils = end ? e.ilsRunways.find(r => r.name === end.name) : undefined;
      const thr = rw ? rw.thr : ils ? ils.thrXY : (end ? e.thresholdXY(end.name) : null);
      const course = rw ? rw.course : ils ? ils.rwdHdg : end ? end.headingTrue : null;
      if (thr && course != null) {
        const c = advance(thr, (course + 180) % 360, 5 * NM_TO_M);
        this.cam.fitRadius(c, 6.5 * NM_TO_M, anim);
        this.ui.patch({ range: 'final' });
        return;
      }
      this.cam.fitRadius(centre, 10 * NM_TO_M, anim);
      this.ui.patch({ range: '10' });
      return;
    }
    const r = p === '30' ? full : p === '15' ? 15 * NM_TO_M : 10 * NM_TO_M;
    this.cam.fitRadius(centre, r, anim);
    this.ui.patch({ range: p });
  };
  centerOnField = (): void => {
    const e = sim.engine; if (!e) return;
    this.centerOnXY(sim.radar ? sim.radar.centerXY : e.centerXY);
  };
  centerOn = (id: number): void => { sim.centerOn(id); };
  toggleRings = (): void => { sim.updateSettings({ showRings: !sim.settings.showRings }); };
  setRingsCentre = (c: 'field' | 'selected'): void => { this.ui.patch({ ringsCentre: c }); };
  toggleFollow = (): void => { this.setFollow(!this.ui.state.follow, false); };
  private setFollow(on: boolean, silent: boolean): void {
    if (on) {
      if (sim.selectedId == null) { if (!silent) sim.pushToast({ kind: 'info', text: 'Select an aircraft to follow', duration: 2500 }); return; }
      this.cam.follow = sim.selectedId;
      this.ui.patch({ follow: true, range: null });
    } else {
      const was = this.ui.state.follow;
      this.cam.follow = null;
      this.ui.patch({ follow: false });
      if (was && !silent) sim.pushToast({ kind: 'info', text: 'Follow off', duration: 2500 });
    }
  }

  // ── keyboard ─────────────────────────────────────────────────────────────────
  /** Canvas-focused keys: zoom, nudge, follow, home, Esc for measures. */
  onKeyDown = (ev: React.KeyboardEvent<HTMLCanvasElement>): void => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const W = this.cam.width, H = this.cam.height, k = this.cam.k;
    switch (ev.key) {
      case '+': case '=': this.zoomIn(); break;
      case '-': case '_': this.zoomOut(); break;
      case 'ArrowLeft': this.cam.centerOn({ x: this.cam.x - (W * 0.1) / k, y: this.cam.y }, undefined, false); this.ui.patch({ range: null, follow: false }); break;
      case 'ArrowRight': this.cam.centerOn({ x: this.cam.x + (W * 0.1) / k, y: this.cam.y }, undefined, false); this.ui.patch({ range: null, follow: false }); break;
      case 'ArrowUp': this.cam.centerOn({ x: this.cam.x, y: this.cam.y + (H * 0.1) / k }, undefined, false); this.ui.patch({ range: null, follow: false }); break;
      case 'ArrowDown': this.cam.centerOn({ x: this.cam.x, y: this.cam.y - (H * 0.1) / k }, undefined, false); this.ui.patch({ range: null, follow: false }); break;
      case 'f': case 'F': if (!ev.shiftKey) this.toggleFollow(); else return; break;
      case 'Home': this.centerOnField(); break;
      case 'Escape':
        if (this.ui.state.measures.length || this.ui.state.measureTool || this.ptr.clickA) { this.clearMeasures(); if (this.ui.state.measureTool) this.ui.patch({ measureTool: false }); break; }
        return;
      default: return;
    }
    ev.preventDefault(); ev.stopPropagation();
  };

  /** Window-level (capture): L / R while dragging or with a heading draft, Enter sends, Esc cancels the bubble. */
  private onWindowKey = (ev: KeyboardEvent): void => {
    const target = ev.target as HTMLElement | null;
    const inInput = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    const dragging = this.ptr.mode === 'vector' && !!this.drag;
    const draft = this.ui.state.draft;
    if (!dragging && !draft) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if ((ev.key === 'l' || ev.key === 'L') && !inInput && (dragging || draft?.kind === 'heading')) { this.setDraftTurn('L'); }
    else if ((ev.key === 'r' || ev.key === 'R') && !inInput && (dragging || draft?.kind === 'heading')) { this.setDraftTurn('R'); }
    else if (ev.key === 'Enter' && draft && !inInput) { this.sendDraft(); }
    else if (ev.key === 'Escape' && draft) { this.cancelDraft(); }
    else if (ev.key === 'Escape' && dragging) { this.drag = null; this.ptr = { ...IDLE }; this.idleCursor(null); }
    else return;
    ev.preventDefault(); ev.stopPropagation();
  };

  // ── shell API (api.ts) ───────────────────────────────────────────────────────
  private api(): ApproachViewApi {
    return {
      zoomIn: this.zoomIn, zoomOut: this.zoomOut, setRange: this.setRange, range: () => this.ui.state.range,
      toggleRings: this.toggleRings, toggleFollow: this.toggleFollow, following: () => this.ui.state.follow,
      toggleMeasure: this.toggleMeasure, measuring: () => this.ui.state.measureTool, clearMeasures: this.clearMeasures,
      centerOn: this.centerOn, centerOnField: this.centerOnField,
      cancelDraft: this.cancelDraft, sendDraft: this.sendDraft, hasDraft: () => !!this.ui.state.draft, setDraftTurn: this.setDraftTurn,
    };
  }

  /** React move handler wrapper: the pan case needs the raw delta, everything else the position. */
  handleMove = (ev: React.PointerEvent<HTMLCanvasElement>): void => {
    if (this.ptr.mode === 'pan') {
      const { x, y } = this.local(ev);
      this.panDelta(x - this.ptr.lastX, y - this.ptr.lastY);
      this.ptr.lastX = x; this.ptr.lastY = y;
      return;
    }
    this.onPointerMove(ev);
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  React
// ══════════════════════════════════════════════════════════════════════════════
function useUi<T>(ctrl: RadarController, selector: (s: UiState) => T): T {
  return useSyncExternalStore(ctrl.ui.subscribe, () => selector(ctrl.ui.state), () => selector(ctrl.ui.state));
}

export default function ApproachView() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<RadarController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = new RadarController();
  const ctrl = ctrlRef.current;
  const reduced = usePrefersReducedMotion();
  ctrl.reducedMotion = reduced;

  useEffect(() => {
    if (!wrap.current || !canvas.current) return;
    ctrl.mount(wrap.current, canvas.current);
    return () => ctrl.unmount();
  }, [ctrl]);

  const measures = useUi(ctrl, s => s.measures);
  const noAirspace = useUi(ctrl, s => s.noAirspace);
  const icao = useSim(s => s.icao);

  return (
    <div ref={wrap} className={styles.wrap} data-testid="radar-view">
      <canvas
        ref={canvas}
        className={styles.canvas}
        data-testid="radar-canvas"
        tabIndex={0}
        role="application"
        aria-label="Approach radar scope"
        onPointerDown={ctrl.onPointerDown}
        onPointerMove={ctrl.handleMove}
        onPointerUp={ctrl.onPointerUp}
        onPointerCancel={ctrl.onPointerCancel}
        onPointerLeave={ctrl.onPointerLeave}
        onContextMenu={ctrl.onContextMenu}
        onDoubleClick={ctrl.onDoubleClick}
        onKeyDown={ctrl.onKeyDown}
      />
      <CornerChip ctrl={ctrl} />
      <Toolbar ctrl={ctrl} />
      {noAirspace && icao ? <div className={styles.note} data-testid="radar-no-airspace"><Icon name="info" size={14} />No radar airspace for {icao} — arrivals join on short final</div> : null}
      {measures.map((_, i) => (
        <button
          key={i}
          type="button"
          className={cx(styles.pill, styles.measurePill)}
          data-testid={`map-measure-${i}`}
          aria-label={`Remove measure ${i + 1}`}
          ref={el => { ctrl.els.measures[i] = el; }}
          onClick={() => ctrl.removeMeasure(i)}
        />
      ))}
      <span className={styles.pill} data-testid="map-measure-live" hidden ref={el => { ctrl.els.live = el; }} />
      <span className={styles.dragPill} data-testid="map-hdg-readout" hidden ref={el => { ctrl.els.dragPill = el; }} />
      <EdgeArrow ctrl={ctrl} />
      <HoverTooltip ctrl={ctrl} />
      <DraftBubble ctrl={ctrl} />
    </div>
  );
}

// ── corner chip: wind arrow · ATIS letter · wind · active arrival runways · range ──
function CornerChip({ ctrl }: { ctrl: RadarController }) {
  const wx = useSim(s => {
    const w = s.weather(); const at = s.atis();
    return { letter: at?.letter ?? null, dir: w ? w.windDirTrue : 0, kts: w ? w.windKt : 0, gust: w ? w.gustKt : 0, magVar: s.engine?.magVar ?? 0, arr: s.runways().filter(r => r.activeArr).map(r => r.name).join('/'), loaded: !!s.engine };
  });
  const range = useUi(ctrl, s => s.range);
  const visibleNM = useUi(ctrl, s => s.visibleNM);
  if (!wx.loaded) return null;
  const calm = wx.kts < 1;
  const dirMag = magnetic(wx.dir, wx.magVar);
  const rangeText = range === 'final' ? 'Final' : `${visibleNM} nm`;
  return (
    <div className={styles.chip} data-testid="radar-chip" aria-label="Wind, ATIS and range">
      <span key={wx.letter ?? '-'} className={styles.chipLetter} data-bump="1" data-testid="radar-chip-atis">{wx.letter ?? '—'}</span>
      <span className={styles.chipArrow} style={{ transform: `rotate(${calm ? 0 : (dirMag + 180) % 360}deg)` }} aria-hidden="true">
        <Icon name="arrow-up" size={14} />
      </span>
      <span className={calm ? styles.chipCalm : undefined} data-testid="radar-chip-wind" data-value={`${dirMag}/${wx.kts}`}>
        {calm ? 'CALM' : `${hdg3(dirMag)}/${String(Math.round(wx.kts)).padStart(2, '0')}`}
        {!calm && wx.gust > 0 ? <span className={styles.chipGust}> G{Math.round(wx.gust)}</span> : null}
      </span>
      {wx.arr ? <><span className={styles.chipSep}>·</span><span className={styles.chipRwy} data-testid="radar-chip-rwy">{wx.arr}</span></> : null}
      <span className={styles.chipSep}>·</span>
      <span data-testid="radar-chip-range" data-value={visibleNM}>{rangeText}</span>
    </div>
  );
}

// ── toolbar: zoom, follow, rings, measure, centre + range presets ────────────────
const PRESETS: Array<{ id: RangePreset; label: string; title: string }> = [
  { id: '30', label: '30', title: 'Full airspace' }, { id: '15', label: '15', title: '15 nm' }, { id: '10', label: '10', title: '10 nm' }, { id: 'final', label: 'FNL', title: 'Final approach area' },
];
function Toolbar({ ctrl }: { ctrl: RadarController }) {
  const follow = useUi(ctrl, s => s.follow);
  const measureTool = useUi(ctrl, s => s.measureTool);
  const range = useUi(ctrl, s => s.range);
  const ringsCentre = useUi(ctrl, s => s.ringsCentre);
  const rings = useSim(s => s.settings.showRings);
  const hasSel = useSim(s => s.selectedId != null);
  return (
    <div className={styles.toolbar} data-testid="radar-toolbar">
      <div className={styles.presets} role="group" aria-label="Range">
        {PRESETS.map(p => (
          <button key={p.id} type="button" className={styles.presetBtn} title={p.title} aria-pressed={range === p.id} data-testid={`radar-tool-range-${p.id}`} onClick={() => ctrl.setRange(p.id)}>{p.label}</button>
        ))}
      </div>
      {rings ? (
        <div className={cx(styles.presets, styles.ringsCentre)} role="group" aria-label="Ring centre">
          <button type="button" className={styles.presetBtn} title="Rings centred on the field" aria-pressed={ringsCentre === 'field'} data-testid="radar-tool-rings-centre-field" onClick={() => ctrl.setRingsCentre('field')}>FLD</button>
          <button type="button" className={styles.presetBtn} title="Rings centred on the selected aircraft" aria-pressed={ringsCentre === 'selected'} disabled={!hasSel} data-testid="radar-tool-rings-centre-selected" onClick={() => ctrl.setRingsCentre('selected')}>SEL</button>
        </div>
      ) : null}
      <div className={styles.tools}>
        <IconButton size={44} variant="map" label="Zoom in" icon={<Icon name="plus" />} testId="radar-tool-zoom-in" onClick={ctrl.zoomIn} />
        <IconButton size={44} variant="map" label="Zoom out" icon={<Icon name="minus" />} testId="radar-tool-zoom-out" onClick={ctrl.zoomOut} />
        <IconButton size={44} variant="map" label={follow ? 'Stop following' : 'Follow selected aircraft'} icon={<Icon name="locate-fixed" />} active={follow} accentIcon={follow} testId="radar-tool-follow" data-state={follow ? 'on' : 'off'} onClick={ctrl.toggleFollow} />
        <IconButton size={44} variant="map" label={rings ? 'Hide range rings' : 'Show range rings'} icon={<Icon name="circle" />} active={rings} testId="radar-tool-rings" data-state={rings ? 'on' : 'off'} onClick={ctrl.toggleRings} />
        <IconButton size={44} variant="map" label={measureTool ? 'Measure tool off' : 'Measure tool'} icon={<Icon name="crosshair" />} active={measureTool} testId="radar-tool-measure" data-state={measureTool ? 'on' : 'off'} onClick={ctrl.toggleMeasure} />
        <IconButton size={44} variant="map" label="Centre on the field" icon={<Icon name="compass" />} testId="radar-tool-centre" onClick={ctrl.centerOnField} />
      </div>
    </div>
  );
}

// ── edge arrow toward an off-screen selected aircraft ───────────────────────────
function EdgeArrow({ ctrl }: { ctrl: RadarController }) {
  const sel = useSim(s => s.selectedId);
  return (
    <button
      type="button"
      className={styles.edgeArrow}
      data-testid="map-edge-arrow"
      aria-label="Pan to the selected aircraft"
      hidden
      ref={el => { ctrl.els.edge = el; ctrl.els.edgeIcon = el ? (el.firstElementChild as HTMLElement | null) : null; }}
      onClick={() => { if (sel != null) ctrl.centerOn(sel); }}
    >
      <Icon name="navigation" size={16} />
    </button>
  );
}

// ── hover tooltip (04 §4): callsign · type/wake · stage · alt/GS/hdg · targets · pending · REQ ──
function HoverTooltip({ ctrl }: { ctrl: RadarController }) {
  const id = useUi(ctrl, s => s.tooltipId);
  useSimVersion();
  const e = sim.engine;
  const a = id != null && e ? e.byId(id) : undefined;
  if (!a || !e) return null;
  const air = isAirborne(a);
  const st = stageLabel(sim.stageOf(a));
  const mag = e.magVar;
  const req = a.requests.find(r => r.answeredAt == null);
  const emerg = a.emergency && a.emergency.status !== 'resolved' ? a.emergency : null;
  const pend = a.pendingCmds.length ? a.pendingCmds[a.pendingCmds.length - 1] : null;
  const tgtAlt = a.cmdAltitude != null && Math.abs(a.cmdAltitude - a.altitude) > 150 ? a.cmdAltitude : null;
  const tgtSpd = a.cmdIas != null && Math.abs(a.cmdIas - a.speed) > 12 ? a.cmdIas : null;
  const tgtHdg = air && a.navMode === 'heading' && Math.abs(angleDelta(a.heading, a.targetHeading)) > 2 ? a.targetHeading : null;
  return (
    <div className={styles.tooltip} data-testid="map-tooltip" data-callsign={a.callsign} ref={el => { ctrl.els.tooltip = el; }}>
      <div className={styles.tipTitle}>
        <span>{a.callsign}</span>
        <span className={styles.tipDim}>{a.perf.icaoCode}/{a.wakeCategory === 'SUPER' ? 'J' : a.wakeCategory[0]}</span>
        <span className={cx(styles.tipDim, emerg && styles.tipEm)}>{emerg ? emerg.level : st.short}</span>
      </div>
      {air ? (
        <div className={styles.tipNum}>
          {fmtAlt(a.altitude)}{tgtAlt != null ? <span className={styles.tipDim}> {tgtAlt > a.altitude ? '▲' : '▼'} {fmtAlt(tgtAlt)}</span> : null}
          <span className={styles.tipDim}> · </span>{Math.round(a.speed)} kt{tgtSpd != null ? <span className={styles.tipDim}> {tgtSpd > a.speed ? '▲' : '▼'} {tgtSpd}</span> : null}
          <span className={styles.tipDim}> · </span>HDG {hdg3(magnetic(a.heading, mag))}{tgtHdg != null ? <span className={styles.tipDim}> → {hdg3(magnetic(tgtHdg, mag))}</span> : null}
        </div>
      ) : (
        <div className={styles.tipDim}>{a.plan.gateRef ? `Stand ${a.plan.gateRef}` : 'On the ground'}{a.plan.runway ? ` · RWY ${a.plan.runway}` : ''}{a.plan.taxiRoute?.length ? ` · via ${a.plan.taxiRoute.join(' ')}` : ''}</div>
      )}
      {pend ? <div className={styles.tipDim}>Pending · {pend.kind}{pend.condition ? ' (conditional)' : ''}</div> : null}
      {req ? <div className={styles.tipReq}>REQ · {req.text}</div> : null}
    </div>
  );
}

// ── draft bubble: heading (with dial) / direct / ILS / altitude ─────────────────
function DraftBubble({ ctrl }: { ctrl: RadarController }) {
  const draft = useUi(ctrl, s => s.draft);
  const ttlKey = useUi(ctrl, s => s.ttlKey);
  useSimVersion();
  const e = sim.engine;
  const a = draft && e ? e.byId(draft.id) : undefined;
  if (!draft || !a || !e) return null;
  const mag = e.magVar;
  const root = draft.kind === 'heading' ? 'map-hdg-bubble' : draft.kind === 'direct' ? 'map-dct-bubble' : draft.kind === 'ils' ? 'map-ils-bubble' : 'map-alt-bubble';
  const title = draft.kind === 'heading' ? 'Vector' : draft.kind === 'direct' ? 'Direct' : draft.kind === 'ils' ? 'Approach' : 'Altitude';

  let phrase: React.ReactNode = null;
  let note: React.ReactNode = null;
  let noteTone: 'ok' | 'warn' | 'err' = 'ok';
  if (draft.kind === 'heading') {
    const m = magnetic(draft.hdgTrue, mag);
    phrase = <>{draft.dir ? `turn ${draft.dir === 'L' ? 'left' : 'right'} heading ` : 'fly heading '}<strong>{hdg3(m)}</strong></>;
    const delta = Math.abs(angleDelta(a.heading, draft.hdgTrue));
    note = `${Math.round(delta)}° turn from ${hdg3(magnetic(a.heading, mag))}`;
    if (a.ilsCaptured || a.ilsArmed) { note = 'Cancels the ILS clearance'; noteTone = 'warn'; }
  } else if (draft.kind === 'direct') {
    const fix = e.beacons.find(b => b.id === draft.fix);
    phrase = <>direct <strong>{draft.fix}</strong></>;
    if (fix) note = `${distNM(a.pos, fix).toFixed(1)} nm · ${hdg3(magnetic(bearingTrue(a.pos, fix), mag))}°`;
  } else if (draft.kind === 'ils') {
    const ils = e.ilsRunways.find(r => r.name === draft.runway);
    phrase = <>cleared ILS <strong>{draft.runway}</strong></>;
    if (ils) {
      const intercept = Math.abs(angleDelta(a.heading, ils.locCourse));
      const along = Math.max(0, distAlongFwd(a.pos, ils));
      const gsAlt = gsAltFt(along, ils);
      const above = a.altitude - gsAlt;
      const parts: string[] = [`intercept ${Math.round(intercept)}°`, above > 0 ? `${Math.round(above / 100) * 100} ft above GS` : `${Math.round(-above / 100) * 100} ft below GS`];
      note = parts.join(' · ');
      if (intercept > ILS_CONST.interceptDeg || above > ILS_CONST.aboveGsFt) noteTone = 'warn';
      if (intercept > 90) { note = 'Heading away from the localizer'; noteTone = 'err'; }
    }
  } else {
    const up = draft.ft > a.altitude;
    phrase = <>{up ? 'climb to ' : 'descend to '}<strong>{fmtAlt(draft.ft)}</strong></>;
    note = `now ${fmtAlt(a.altitude)}${a.cmdAltitude != null ? ` · cleared ${fmtAlt(a.cmdAltitude)}` : ''}`;
  }

  return (
    <div className={cx(styles.bubble, draft.kind !== 'heading' && styles.bubbleCompact)} data-testid={root} data-kind={draft.kind} role="dialog" aria-label={`${title} for ${a.callsign}`} ref={el => { ctrl.els.bubble = el; }}>
      <div className={styles.bubbleHead}>
        <span className={styles.bubbleTitle}>{title}</span>
        <span className={styles.bubbleCs}>{a.callsign}</span>
      </div>
      <div className={styles.bubbleBody}>
        {draft.kind === 'heading' ? (
          <Dial size={120} value={magnetic(draft.hdgTrue, mag)} current={magnetic(a.heading, mag)} turn={draft.dir === 'L' ? 'left' : draft.dir === 'R' ? 'right' : 'auto'} onChange={ctrl.setDraftHeadingMag} quickSteps={[]} onGlass testId={`${root}-dial`} />
        ) : null}
        <div className={styles.bubbleReadout}>
          <div className={styles.bubblePhrase}>{phrase}</div>
          {draft.kind === 'heading' ? (
            <div className={styles.bubbleTurn}>
              <Button size="sm" variant="secondary" selected={draft.dir === 'L'} aria-pressed={draft.dir === 'L'} testId={`${root}-left`} onClick={() => ctrl.setDraftTurn('L')}>L</Button>
              <Button size="sm" variant="secondary" selected={draft.dir === 'R'} aria-pressed={draft.dir === 'R'} testId={`${root}-right`} onClick={() => ctrl.setDraftTurn('R')}>R</Button>
            </div>
          ) : null}
          {draft.kind === 'altitude' ? (
            <div className={styles.bubbleSteps}>
              <Button size="sm" variant="secondary" tabular iconLeft={<Icon name="arrow-up" size={14} />} testId={`${root}-up`} onClick={() => ctrl.stepDraftAltitude(ALT_STEP)}>1,000</Button>
              <Button size="sm" variant="secondary" tabular iconLeft={<Icon name="arrow-down" size={14} />} testId={`${root}-down`} onClick={() => ctrl.stepDraftAltitude(-ALT_STEP)}>1,000</Button>
            </div>
          ) : null}
          {note ? <div className={cx(styles.bubbleNote, noteTone === 'warn' && styles.bubbleWarn, noteTone === 'err' && styles.bubbleErr)}>{note}</div> : null}
        </div>
      </div>
      <div className={styles.bubbleFoot}>
        <Button size="sm" variant="ghost" iconRight={<Kbd>Esc</Kbd>} testId={`${root}-cancel`} onClick={ctrl.cancelDraft}>Cancel</Button>
        <Button size="sm" variant="accent" iconRight={<Kbd>Enter</Kbd>} testId={`${root}-send`} onClick={ctrl.sendDraft}>Send</Button>
      </div>
      <div className={styles.bubbleRing} aria-hidden="true"><span key={ttlKey} /></div>
    </div>
  );
}

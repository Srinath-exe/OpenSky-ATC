// ============================================================
//  Overlay renderer — draws everything that is not base-map pavement:
//  runway status tints + thresholds + IDs, tower final corridors, hold-short
//  bars, stands, service stations, taxiway designators, routes, vehicles,
//  aircraft silhouettes, data blocks, rings, drag-to-heading geometry.
//
//  Design: 01 §5 / A10 / A21. Colours: tokens via readCanvasPalette().
//  Performance: static geometry is pre-packed in unit mercator (geometry.ts);
//  per frame we run one affine transform per point, reuse scratch objects and
//  typed arrays, and cache projected routes per DrivePath.
// ============================================================
import type { SimEngine } from '@/lib/sim/engine';
import type { AircraftState, DrivePath, GateState, RunwayState } from '@/lib/sim/types';
import { getShape, drawShape } from '@/lib/sim/aircraftShapes';
import { isAirborne } from '@/lib/sim/aircraft';
import { DEG, type XY } from '@/lib/sim/projection';
import type { CanvasPalette } from './colors';
import { fontOf } from './colors';
import type { GroundGeometry, GRunwayEnd } from './geometry';
import type { FrameCam } from './mercator';
import { mercFromXY, packXY, toScreen } from './mercator';
import type { GroundLayers, PlayerPosition, GroundTheme } from './bridge';
import { drawGlyph, glyphKindFor } from './glyphs';

const NM = 1852;
const KT = 1852 / 3600;
const MIN_AC_LEN_PX = 15;
const MAX_AC_LEN_PX = 900;
const HIT_MIN_PX = 14;
const BLOCK_H = 24;
const BLOCK_PAD = 10;
const LEADER = 18;
const ANGLES = [-45, -135, 45, 135, -90, 90, 0, 180]; // 45° up-right first; screen angles (deg from +x, y down)

export interface DragState {
  id: number;
  /** current cursor CSS px */
  x: number;
  y: number;
  /** true heading under the cursor */
  hdgTrue: number;
  dir: 'L' | 'R' | null;
  active: boolean;
}

export interface AcHit { id: number; x: number; y: number; r: number; lx: number; ly: number; lw: number; lh: number; visible: boolean; airborne: boolean; callsign: string }
export interface VehHit { id: string; x: number; y: number; r: number; visible: boolean }

export interface FrameInput {
  cam: FrameCam;
  /** performance.now() ms */
  now: number;
  position: PlayerPosition;
  theme: GroundTheme;
  layers: GroundLayers;
  showRings: boolean;
  selectedId: number | null;
  hoveredId: number | null;
  selectedVehicleId: string | null;
  hoveredVehicleId: string | null;
  drag: DragState | null;
  version: number;
  /** Player selected a heading-drag direction key while dragging. */
  reducedMotion: boolean;
  /** Map area covered by floating chrome (strip bay / command panel), CSS px — edge markers stay inside the uncovered part. */
  insets?: { left: number; right: number; top: number; bottom: number };
}

interface Placed { x: number; y: number; w: number; h: number }

const scratch = { x: 0, y: 0 };
const scratchM = { x: 0, y: 0 };
const scratch2 = { x: 0, y: 0 };

function hdg3(h: number): string { return String(((Math.round(h) % 360) + 360) % 360 || 360).padStart(3, '0'); }
function ownsPosition(a: AircraftState, position: PlayerPosition): boolean {
  if (position === 'approach') return a.onFrequency === 'approach' || a.onFrequency === 'departure';
  return a.onFrequency === position;
}
function mmss(s: number): string { const m = Math.floor(s / 60), r = Math.max(0, Math.round(s - m * 60)); return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; }

export class GroundRenderer {
  readonly acHits: AcHit[] = [];
  readonly vehHits: VehHit[] = [];
  /** Off-screen selected aircraft direction (for the edge arrow), null when on screen / none. */
  edge: { x: number; y: number; angle: number; callsign: string } | null = null;

  private routeCache = new WeakMap<DrivePath, Float64Array>();
  private textW = new Map<string, number>();
  private gateByRef = new Map<string, GateState>();
  private gateVersion = -1;
  private heldNodes = new Set<string>();
  private placed: Placed[] = [];
  private labelCells = new Set<string>();
  private pairLines: Array<[number, number]> = [];

  constructor(private p: CanvasPalette) {}

  setPalette(p: CanvasPalette) { this.p = p; this.textW.clear(); }

  // ── measuring ─────────────────────────────────────────────────────────────
  private measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
    const k = font + '|' + text;
    let w = this.textW.get(k);
    if (w === undefined) {
      if (this.textW.size > 4000) this.textW.clear();
      ctx.font = font; w = ctx.measureText(text).width; this.textW.set(k, w);
    }
    return w;
  }

  private onScreen(cam: FrameCam, x: number, y: number, pad = 80): boolean {
    return x > -pad && y > -pad && x < cam.w + pad && y < cam.h + pad;
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y); ctx.lineTo(x + w - rr, y); ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr); ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h); ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr); ctx.arcTo(x, y, x + rr, y, rr); ctx.closePath();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Frame
  // ══════════════════════════════════════════════════════════════════════════
  draw(ctx: CanvasRenderingContext2D, engine: SimEngine, geom: GroundGeometry, f: FrameInput): void {
    const cam = f.cam;
    ctx.clearRect(0, 0, cam.w, cam.h);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.textBaseline = 'middle';

    if (this.gateVersion !== f.version || this.gateByRef.size !== engine.gates.length) {
      this.gateByRef.clear();
      for (const g of engine.gates) this.gateByRef.set(g.ref, g);
      this.gateVersion = f.version;
    }
    const aircraft = engine.aircraft;
    this.heldNodes.clear();
    for (const a of aircraft) if (a.holdShortNode && a.speed < 1.5 && !isAirborne(a)) this.heldNodes.add(a.holdShortNode);

    this.drawRunways(ctx, engine, geom, f);
    if (f.position === 'tower' && f.layers.corridor) this.drawCorridors(ctx, engine, geom, f);
    if (f.layers.holdBars) this.drawHoldBars(ctx, geom, f);
    this.drawStands(ctx, engine, geom, f);
    this.drawStations(ctx, geom, f);
    if (f.layers.taxiwayLabels) this.drawTaxiLabels(ctx, geom, f);
    if (f.showRings) this.drawRings(ctx, engine, geom, f);
    this.drawRoutes(ctx, engine, aircraft, f);
    if (f.layers.vehicles || f.position === 'ground') this.drawVehicles(ctx, engine, aircraft, f);
    this.drawAircraft(ctx, engine, aircraft, f);
    this.drawConflictLines(ctx, engine, f);
    this.drawDataBlocks(ctx, engine, f);
    if (f.drag) this.drawDrag(ctx, engine, f);
  }

  // ── runways ───────────────────────────────────────────────────────────────
  private drawRunways(ctx: CanvasRenderingContext2D, engine: SimEngine, geom: GroundGeometry, f: FrameInput) {
    const cam = f.cam, p = this.p;
    const pulse = f.reducedMotion ? 0.8 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin((f.now / 1200) * Math.PI * 2));
    for (const rw of geom.runways) {
      const rs = engine.runwayState(rw.ends[0].name) ?? engine.runwayState(rw.ends[1].name);
      if (!rs) continue;
      // strip polygon
      const pts = rw.poly;
      let allOff = true;
      const sx: number[] = [], sy: number[] = [];
      for (let i = 0; i < 4; i++) { toScreen(cam, pts[i].x, pts[i].y, scratch); sx.push(scratch.x); sy.push(scratch.y); if (this.onScreen(cam, scratch.x, scratch.y, 400)) allOff = false; }
      if (allOff) continue;
      const occupied = rs.occupiedBy.length > 0;
      const status = rs.status;
      let fill: string | null = null, edge: string | null = null, dash = false, label: string | null = null, labelColor = p.text3;
      if (status === 'closed') { fill = p.redTint12; edge = p.redBorder25; label = 'CLOSED'; labelColor = p.red; }
      else if (status === 'sterile') { fill = p.orangeTint08; edge = p.orangeBorder; dash = true; label = 'STERILE'; labelColor = p.orange; }
      else if (status === 'inspection') { fill = p.w04; edge = p.w25; dash = true; label = 'INSPECTION'; labelColor = p.text2; }
      else if (occupied && f.position === 'ground') { fill = p.orangeTint04; }
      if (fill) {
        ctx.beginPath(); ctx.moveTo(sx[0], sy[0]); for (let i = 1; i < 4; i++) ctx.lineTo(sx[i], sy[i]); ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
        if (status === 'closed') {
          // diagonal hatch
          ctx.save(); ctx.clip();
          ctx.strokeStyle = p.redBorder25; ctx.lineWidth = 1;
          const step = 14;
          const minX = Math.min(...sx), maxX = Math.max(...sx), minY = Math.min(...sy), maxY = Math.max(...sy);
          const span = (maxX - minX) + (maxY - minY);
          ctx.beginPath();
          for (let d = -span; d < span; d += step) { ctx.moveTo(minX + d, minY); ctx.lineTo(minX + d + (maxY - minY), maxY); }
          ctx.stroke(); ctx.restore();
        }
      }
      if (edge) {
        ctx.beginPath(); ctx.moveTo(sx[0], sy[0]); for (let i = 1; i < 4; i++) ctx.lineTo(sx[i], sy[i]); ctx.closePath();
        ctx.strokeStyle = edge; ctx.lineWidth = 1; ctx.setLineDash(dash ? [6, 4] : []); ctx.stroke(); ctx.setLineDash([]);
      }
      // occupancy band (A21 tower: 2px --orange @.6 along the runway while occupied) — pulses .6→1
      if (occupied && status !== 'closed') {
        ctx.save(); ctx.globalAlpha = pulse;
        ctx.strokeStyle = p.orange60; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx[0], sy[0]); ctx.lineTo(sx[1], sy[1]); ctx.moveTo(sx[2], sy[2]); ctx.lineTo(sx[3], sy[3]); ctx.stroke();
        ctx.restore();
      }
      // wake timer (tower): thin orange arc-less label near the centre
      if (label && cam.zoom >= 12.5) {
        toScreen(cam, rw.centre.x, rw.centre.y, scratch);
        ctx.save(); ctx.translate(scratch.x, scratch.y);
        let rot = rw.hdg - 90; if (rot > 90 && rot < 270) rot -= 180; if (rot < -90) rot += 180;
        ctx.rotate(rot * DEG);
        ctx.font = fontOf(p, 500, 10); ctx.textAlign = 'center';
        ctx.fillStyle = labelColor; ctx.fillText(label.split('').join(' '), 0, -RUNWAY_HALF_PX(cam) - 8);
        ctx.restore();
      }
      // thresholds + IDs
      if (cam.zoom >= 12.5) for (const e of rw.ends) this.drawEnd(ctx, e, rs, f);
    }
  }

  private drawEnd(ctx: CanvasRenderingContext2D, e: GRunwayEnd, rs: RunwayState, f: FrameInput) {
    const cam = f.cam, p = this.p;
    toScreen(cam, e.bar[0].x, e.bar[0].y, scratch); toScreen(cam, e.bar[1].x, e.bar[1].y, scratch2);
    if (!this.onScreen(cam, (scratch.x + scratch2.x) / 2, (scratch.y + scratch2.y) / 2, 120)) return;
    // threshold bar 2px white .55
    ctx.strokeStyle = p.w55; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(scratch.x, scratch.y); ctx.lineTo(scratch2.x, scratch2.y); ctx.stroke();
    // runway ID, rotated to heading (reads from the approach side)
    toScreen(cam, e.label.x, e.label.y, scratch);
    ctx.save(); ctx.translate(scratch.x, scratch.y); ctx.rotate(e.labelRot * DEG);
    const size = cam.zoom >= 15 ? 13 : 11;
    ctx.font = fontOf(p, 500, size); ctx.textAlign = 'center';
    const end = f.position === 'tower' ? rs : null;
    const active = end ? (end.activeArr || end.activeDep) : true;
    ctx.fillStyle = active ? p.w55 : p.w25;
    ctx.fillText(e.name, 0, 0);
    ctx.restore();
  }

  // ── tower final corridors (10 NM, 1 NM ticks) ─────────────────────────────
  private drawCorridors(ctx: CanvasRenderingContext2D, engine: SimEngine, geom: GroundGeometry, f: FrameInput) {
    const cam = f.cam, p = this.p;
    for (const rs of engine.runwayStates()) {
      if (!rs.activeArr || rs.status === 'closed') continue;
      const e = geom.endByName.get(rs.name); if (!e) continue;
      toScreen(cam, e.thr.x, e.thr.y, scratch);
      const x0 = scratch.x, y0 = scratch.y;
      const last = e.corridor[e.corridor.length - 1];
      toScreen(cam, last.x, last.y, scratch2);
      ctx.strokeStyle = p.lime; ctx.lineWidth = 2; ctx.setLineDash([10, 6]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(scratch2.x, scratch2.y); ctx.stroke(); ctx.setLineDash([]);
      // ticks every NM (perpendicular), labels every 2 NM
      const px = e.perpXY.x, py = -e.perpXY.y; // XY→screen flips y
      ctx.strokeStyle = p.lime50; ctx.lineWidth = 1;
      ctx.font = fontOf(p, 400, 11); ctx.fillStyle = p.text5; ctx.textAlign = 'left';
      for (let i = 0; i < e.corridor.length; i++) {
        toScreen(cam, e.corridor[i].x, e.corridor[i].y, scratch);
        if (!this.onScreen(cam, scratch.x, scratch.y, 20)) continue;
        const nm = i + 1; const t = nm % 2 === 0 ? 7 : 4;
        ctx.beginPath(); ctx.moveTo(scratch.x - px * t, scratch.y - py * t); ctx.lineTo(scratch.x + px * t, scratch.y + py * t); ctx.stroke();
        if (nm % 2 === 0) ctx.fillText(`${nm}`, scratch.x + px * 10 + 2, scratch.y + py * 10);
      }
      // arrivals inside the corridor: distance tag at the aircraft's foot on the centreline
      const arr = engine.arrivalOnFinal(rs.name, 10);
      if (arr) {
        const a = arr.a;
        mercFromXY(engine.proj, a.pos.x, a.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
        ctx.fillStyle = p.lime; ctx.beginPath(); ctx.arc(scratch.x, scratch.y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // ── hold-short bars ───────────────────────────────────────────────────────
  private drawHoldBars(ctx: CanvasRenderingContext2D, geom: GroundGeometry, f: FrameInput) {
    const cam = f.cam, p = this.p;
    if (cam.zoom < 13.2) return;
    const showTaxiHolds = cam.zoom >= 15.2;
    for (const h of geom.holds) {
      if (!h.runway && !showTaxiHolds) continue;
      toScreen(cam, h.bar[0].x, h.bar[0].y, scratch); toScreen(cam, h.bar[1].x, h.bar[1].y, scratch2);
      if (!this.onScreen(cam, scratch.x, scratch.y, 40)) continue;
      const lit = this.heldNodes.has(h.nodeId);
      ctx.save();
      if (lit) { ctx.strokeStyle = p.orange; ctx.lineWidth = 3; ctx.shadowColor = p.orange; ctx.shadowBlur = 10; }
      else if (h.entryEnd) { ctx.strokeStyle = p.orange90; ctx.lineWidth = 2.5; }
      else if (h.runway) { ctx.strokeStyle = p.orange60; ctx.lineWidth = 2; }
      else { ctx.strokeStyle = p.orange40; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); }
      ctx.beginPath(); ctx.moveTo(scratch.x, scratch.y); ctx.lineTo(scratch2.x, scratch2.y); ctx.stroke();
      ctx.restore();
      if (lit && cam.zoom >= 14) {
        // held marker: small "HOLD" caps under the bar
        const mx = (scratch.x + scratch2.x) / 2, my = (scratch.y + scratch2.y) / 2;
        ctx.font = fontOf(p, 500, 10); ctx.textAlign = 'center'; ctx.fillStyle = p.orange;
        ctx.fillText(h.entryEnd ? `HOLD ${h.entryEnd}` : (h.runwayEnds[0] ? `HOLD ${h.runwayEnds[0]}` : 'HOLD'), mx, my + 12);
      }
    }
  }

  // ── stands ────────────────────────────────────────────────────────────────
  private drawStands(ctx: CanvasRenderingContext2D, engine: SimEngine, geom: GroundGeometry, f: FrameInput) {
    const cam = f.cam, p = this.p;
    if (cam.zoom < 13.6) return;
    const r = cam.zoom >= 16 ? 4 : cam.zoom >= 14.5 ? 3.2 : 2.4;
    const labels = f.layers.standLabels && cam.zoom >= 15.6;
    const font = fontOf(p, 400, cam.zoom >= 17 ? 11 : 10);
    const sel = f.selectedId != null ? engine.byId(f.selectedId) : undefined;
    const selStand = sel ? (sel.reservedStand ?? sel.plan.gateRef ?? null) : null;
    this.labelCells.clear();
    for (const s of geom.stands) {
      toScreen(cam, s.m.x, s.m.y, scratch);
      if (!this.onScreen(cam, scratch.x, scratch.y, 20)) continue;
      const g = this.gateByRef.get(s.ref);
      let fill = p.bg3, ring = p.w25;
      if (g?.closed) { fill = p.redTint24; ring = p.redBorder; }
      else if (g?.occupiedBy != null) { fill = p.text2; ring = p.w25; }
      else if (g?.reservedFor != null) { fill = p.orangeTint30; ring = p.orange60; }
      const isSel = selStand != null && s.ref === selStand;
      if (isSel) {
        ctx.fillStyle = p.puckFill; ctx.beginPath(); ctx.arc(scratch.x, scratch.y, 10, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = p.puckRing; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(scratch.x, scratch.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = ring; ctx.lineWidth = 1; ctx.stroke();
      if (labels || isSel) {
        const cell = `${Math.floor(scratch.x / 28)}:${Math.floor((scratch.y + 12) / 14)}`;
        if (!isSel && this.labelCells.has(cell)) continue;
        this.labelCells.add(cell);
        ctx.font = font; ctx.textAlign = 'center';
        ctx.fillStyle = isSel ? p.text1 : g?.occupiedBy != null ? p.text2 : p.text3;
        ctx.fillText(s.ref, scratch.x, scratch.y + r + 8);
      }
    }
  }

  // ── service stations ──────────────────────────────────────────────────────
  private drawStations(ctx: CanvasRenderingContext2D, geom: GroundGeometry, f: FrameInput) {
    const cam = f.cam, p = this.p;
    if (cam.zoom < 12.8) return;
    for (const s of geom.stations) {
      toScreen(cam, s.m.x, s.m.y, scratch);
      if (!this.onScreen(cam, scratch.x, scratch.y, 30)) continue;
      ctx.beginPath(); ctx.arc(scratch.x, scratch.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = p.pinMutedFill; ctx.fill(); ctx.strokeStyle = p.w25; ctx.lineWidth = 1; ctx.stroke();
      ctx.save(); ctx.translate(scratch.x, scratch.y);
      drawGlyph(ctx, s.kind === 'arff' ? 'arff' : s.kind === 'tug' ? 'tug' : s.kind === 'fuel' ? 'fuel' : s.kind === 'deice' ? 'deice' : s.kind === 'ambulance' ? 'ambulance' : 'ops', 13, p.pinMutedGlyph);
      ctx.restore();
      if (cam.zoom >= 14.4) {
        ctx.font = fontOf(p, 500, 10); ctx.textAlign = 'center'; ctx.fillStyle = p.text3;
        ctx.fillText(s.label.split('').join(' '), scratch.x, scratch.y + 20);
      }
    }
  }

  // ── taxiway designators ───────────────────────────────────────────────────
  private drawTaxiLabels(ctx: CanvasRenderingContext2D, geom: GroundGeometry, f: FrameInput) {
    const cam = f.cam, p = this.p;
    if (cam.zoom < 14.2) return;
    const font = fontOf(p, 500, 11);
    ctx.font = font; ctx.textAlign = 'center';
    this.labelCells.clear();
    const cellPx = cam.zoom >= 16.5 ? 160 : 240;
    for (const l of geom.labels) {
      toScreen(cam, l.m.x, l.m.y, scratch);
      if (!this.onScreen(cam, scratch.x, scratch.y, 10)) continue;
      const cx = Math.floor(scratch.x / cellPx), cy = Math.floor(scratch.y / cellPx);
      const key = `${l.name}:${cx}:${cy}`;
      if (this.labelCells.has(key)) continue;
      this.labelCells.add(key);
      const w = this.measure(ctx, font, l.name) + 10;
      ctx.save(); ctx.translate(scratch.x, scratch.y); ctx.rotate(l.rot * DEG);
      this.roundRect(ctx, -w / 2, -8, w, 16, 8);
      ctx.fillStyle = p.tagBg; ctx.fill();
      ctx.fillStyle = p.text2; ctx.font = font; ctx.textAlign = 'center';
      ctx.fillText(l.name, 0, 0.5);
      ctx.restore();
    }
  }

  // ── range rings (ground 250/500 m from selected; tower 1/2/4 NM from thresholds) ──
  private drawRings(ctx: CanvasRenderingContext2D, engine: SimEngine, geom: GroundGeometry, f: FrameInput) {
    const cam = f.cam, p = this.p;
    // Design 01 A21 lists no radius ring for Ground / Tower: when the player turns rings on they are drawn as faint
    // A10-style guides (1 px, --chart-grid, static 2/6 dash) so they never compete with the corridor ticks or the traffic.
    ctx.strokeStyle = p.chartGrid; ctx.lineWidth = 1; ctx.setLineDash([2, 6]); ctx.lineDashOffset = 0;
    ctx.font = fontOf(p, 400, 11); ctx.fillStyle = p.text5; ctx.textAlign = 'left';
    const ring = (x: number, y: number, rm: number, label: string) => {
      const r = rm * cam.pxPerM; if (r < 8 || r > 6000) return;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(label, x + r * 0.7071 + 4, y - r * 0.7071 - 4);
    };
    if (f.position === 'tower') {
      for (const rs of engine.runwayStates()) {
        if (!rs.activeArr || rs.status === 'closed') continue;
        const e = geom.endByName.get(rs.name); if (!e) continue;
        toScreen(cam, e.thr.x, e.thr.y, scratch);
        for (const nm of [1, 2, 4]) ring(scratch.x, scratch.y, nm * NM, `${nm} NM`);
      }
    } else if (f.selectedId != null) {
      const a = engine.byId(f.selectedId);
      if (a) {
        mercFromXY(engine.proj, a.pos.x, a.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
        for (const m of [250, 500]) ring(scratch.x, scratch.y, m, `${m} m`);
      }
    }
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
  }

  // ── routes ────────────────────────────────────────────────────────────────
  private packedRoute(engine: SimEngine, path: DrivePath): Float64Array {
    let arr = this.routeCache.get(path);
    if (!arr) { arr = packXY(engine.proj, path.pts); this.routeCache.set(path, arr); }
    return arr;
  }

  private strokeRemaining(ctx: CanvasRenderingContext2D, engine: SimEngine, a: AircraftState, f: FrameInput): boolean {
    const path = a.path; if (!path || path.pts.length < 2) return false;
    const cam = f.cam;
    const arr = this.packedRoute(engine, path);
    let i = 0; while (i < path.cum.length && path.cum[i] < a.distAlong) i++;
    if (i >= path.pts.length) return false;
    mercFromXY(engine.proj, a.pos.x, a.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
    ctx.beginPath(); ctx.moveTo(scratch.x, scratch.y);
    for (; i < path.pts.length; i++) { toScreen(cam, arr[i * 2], arr[i * 2 + 1], scratch); ctx.lineTo(scratch.x, scratch.y); }
    return true;
  }

  private pointAlong(engine: SimEngine, path: DrivePath, at: number, out: XY): boolean {
    const cum = path.cum, pts = path.pts;
    if (!pts.length) return false;
    let i = 1; while (i < cum.length && cum[i] < at) i++;
    if (i >= pts.length) { mercFromXY(engine.proj, pts[pts.length - 1].x, pts[pts.length - 1].y, out); return true; }
    const a = pts[i - 1], b = pts[i]; const seg = cum[i] - cum[i - 1] || 1; const t = Math.max(0, Math.min(1, (at - cum[i - 1]) / seg));
    mercFromXY(engine.proj, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, out); return true;
  }

  private drawRoutes(ctx: CanvasRenderingContext2D, engine: SimEngine, aircraft: AircraftState[], f: FrameInput) {
    const cam = f.cam, p = this.p;
    for (const a of aircraft) {
      const isSel = a.id === f.selectedId, isHover = a.id === f.hoveredId;
      if (!isSel && !isHover) continue;
      if (!isAirborne(a)) {
        if (!a.path) continue;
        ctx.save();
        if (isSel) { ctx.shadowColor = p.bg0; ctx.shadowBlur = 6; ctx.strokeStyle = p.text1; ctx.lineWidth = 3; }
        else { ctx.strokeStyle = p.w35; ctx.lineWidth = 2; }
        if (a.path.kind === 'pushback') ctx.setLineDash([6, 4]);
        if (this.strokeRemaining(ctx, engine, a, f)) ctx.stroke();
        ctx.restore();
        // hold-short places on the remaining path
        if (isSel && a.path.holds) {
          for (const h of a.path.holds) {
            if (h.at < a.distAlong - 5) continue;
            if (!this.pointAlong(engine, a.path, h.at, scratchM)) continue;
            toScreen(cam, scratchM.x, scratchM.y, scratch);
            // tangent
            this.pointAlong(engine, a.path, Math.max(0, h.at - 8), scratch2 as unknown as XY);
            const t2 = { x: 0, y: 0 }; toScreen(cam, scratch2.x, scratch2.y, t2);
            let dx = scratch.x - t2.x, dy = scratch.y - t2.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
            const half = 9;
            ctx.save(); ctx.strokeStyle = p.orange; ctx.lineWidth = 3; ctx.shadowColor = p.orange; ctx.shadowBlur = 6;
            ctx.beginPath(); ctx.moveTo(scratch.x - dy * half, scratch.y + dx * half); ctx.lineTo(scratch.x + dy * half, scratch.y - dx * half); ctx.stroke(); ctx.restore();
            if (cam.zoom >= 14) {
              ctx.font = fontOf(p, 500, 10); ctx.textAlign = 'center'; ctx.fillStyle = p.orange;
              ctx.fillText(h.isDepartureEntry ? `${h.runway}` : `X ${h.runway}`, scratch.x, scratch.y - 12);
            }
          }
        }
      } else {
        // airborne: heading vector (1 min), direct-to line, ILS line to threshold
        mercFromXY(engine.proj, a.pos.x, a.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
        const x0 = scratch.x, y0 = scratch.y;
        const len = a.speed * KT * 60 * cam.pxPerM;
        ctx.strokeStyle = isSel ? p.w45 : p.w35; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + Math.sin(a.heading * DEG) * len, y0 - Math.cos(a.heading * DEG) * len); ctx.stroke();
        if (isSel) {
          let tgt: XY | null = null;
          if (a.directTargetXY) tgt = a.directTargetXY;
          else if (a.assignedRunway && (a.ilsArmed || a.ilsCaptured)) tgt = engine.thresholdXY(a.assignedRunway);
          if (tgt) {
            mercFromXY(engine.proj, tgt.x, tgt.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch2);
            ctx.save(); ctx.strokeStyle = p.text1; ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.globalAlpha = 0.8;
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(scratch2.x, scratch2.y); ctx.stroke(); ctx.restore();
          }
        }
      }
    }
  }

  // ── vehicles ──────────────────────────────────────────────────────────────
  private drawVehicles(ctx: CanvasRenderingContext2D, engine: SimEngine, aircraft: AircraftState[], f: FrameInput) {
    const cam = f.cam, p = this.p;
    const vehicles = engine.fleet.list();
    this.vehHits.length = 0;
    const flash = f.reducedMotion ? true : Math.floor(f.now / 250) % 2 === 0;
    // vehicles parked at the same station are fanned out around the pin so they never stack
    const stationSlot = new Map<string, number>();
    for (const v of vehicles) {
      const isSel = v.id === f.selectedVehicleId, isHover = v.id === f.hoveredVehicleId;
      const active = v.state !== 'standby';
      if (!f.layers.vehicles && !active && !isSel) continue;
      // tug attached to an aircraft: draw at the nose, rotated with the aircraft
      let ax: number | null = null, ay: number | null = null, rot = 0;
      const towing = v.type === 'tug' ? aircraft.find(a => a.pushback.tugId === v.id && (a.pushback.stage === 'tug_attach' || a.pushback.stage === 'pushing' || a.pushback.stage === 'paused' || a.pushback.stage === 'tug_disconnect')) : undefined;
      if (towing) {
        const shape = getShape(towing.perf.icaoCode);
        const nose = { x: towing.pos.x + Math.sin(towing.heading * DEG) * (shape.lengthM / 2 + 6), y: towing.pos.y + Math.cos(towing.heading * DEG) * (shape.lengthM / 2 + 6) };
        mercFromXY(engine.proj, nose.x, nose.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
        ax = scratch.x; ay = scratch.y; rot = towing.heading;
      } else {
        mercFromXY(engine.proj, v.pos.x, v.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
        ax = scratch.x; ay = scratch.y; rot = v.heading;
        if (!active) {
          const slot = stationSlot.get(v.stationNodeId) ?? 0; stationSlot.set(v.stationNodeId, slot + 1);
          if (slot > 0) { const ang = (slot - 1) * (Math.PI / 3) - Math.PI / 2; const rr = 24; ax += Math.cos(ang) * rr; ay += Math.sin(ang) * rr; }
          else { ay += 24; }
        }
      }
      const visible = this.onScreen(cam, ax, ay, 30);
      this.vehHits.push({ id: v.id, x: ax, y: ay, r: 12, visible });
      if (!visible) continue;
      // route ahead (dotted)
      if ((v.state === 'enroute' || v.state === 'returning') && v.path && v.path.pts.length > 1) {
        const arr = this.packedRoute(engine, v.path);
        let i = 0; while (i < v.path.cum.length && v.path.cum[i] < v.distAlong) i++;
        ctx.save(); ctx.strokeStyle = isSel ? p.w45 : p.w25; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(ax, ay);
        for (; i < v.path.pts.length; i++) { toScreen(cam, arr[i * 2], arr[i * 2 + 1], scratch); ctx.lineTo(scratch.x, scratch.y); }
        ctx.stroke(); ctx.restore();
      }
      // follow-me leader line to its aircraft
      if (v.type === 'followme' && v.target?.kind === 'aircraft' && active) {
        const a = engine.byId(v.target.id);
        if (a) {
          mercFromXY(engine.proj, a.pos.x, a.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch2);
          ctx.save(); ctx.strokeStyle = p.lime; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(scratch2.x, scratch2.y); ctx.stroke(); ctx.restore();
        }
      }
      // disc
      const responding = (v.type === 'arff' || v.type === 'ambulance') && active && engine.fleet.isResponding(v.id);
      const R = isSel || isHover ? 12 : 10;
      let fill = p.pinMutedFill, ring = p.w25, glyph = p.text3;
      if (v.state === 'enroute') { fill = p.orangeTint30; ring = p.orange60; glyph = p.text1; }
      else if (v.state === 'onscene') { fill = p.redTint24; ring = p.redBorder55; glyph = p.text1; }
      else if (v.state === 'returning') { fill = p.bg3; ring = p.w18; glyph = p.text2; }
      if (towing) { fill = p.bg3; ring = p.w35; glyph = p.text1; }
      ctx.save();
      if (responding) { ctx.shadowColor = flash ? p.red : p.text1; ctx.shadowBlur = 12; ring = flash ? p.red : p.text1; }
      ctx.beginPath(); ctx.arc(ax, ay, R, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = ring; ctx.lineWidth = responding ? 1.5 : 1; ctx.stroke();
      ctx.restore();
      // heading tick when moving
      if (v.speed > 1 || towing) {
        const hx = Math.sin(rot * DEG), hy = -Math.cos(rot * DEG);
        ctx.strokeStyle = ring; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(ax + hx * (R + 1), ay + hy * (R + 1)); ctx.lineTo(ax + hx * (R + 6), ay + hy * (R + 6)); ctx.stroke();
      }
      ctx.save(); ctx.translate(ax, ay); drawGlyph(ctx, glyphKindFor(v.type), 12, glyph); ctx.restore();
      // selection ring
      if (isSel) {
        ctx.save(); ctx.strokeStyle = p.w45; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.lineDashOffset = f.reducedMotion ? 0 : -((f.now / 1000) * 4) % 8;
        ctx.beginPath(); ctx.arc(ax, ay, R + 7, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      // label
      if (active || isSel || isHover) {
        let text = v.callsign.toUpperCase();
        if (v.target && active && v.state !== 'returning') {
          const t = v.target;
          const dest = t.kind === 'runway' ? `RWY ${t.runway}` : t.kind === 'aircraft' ? t.callsign : t.kind === 'stand' ? `STAND ${t.ref}` : t.kind === 'point' ? 'POINT' : 'STATION';
          text += `  ${dest}`;
        } else if (v.state === 'returning') text += '  RTB';
        const eta = v.etaAt != null && v.state === 'enroute' ? Math.max(0, v.etaAt - engine.time) : null;
        const font = fontOf(p, 500, 10);
        const w = this.measure(ctx, font, text) + (eta != null ? this.measure(ctx, font, ` ${mmss(eta)}`) + 6 : 0) + 14;
        const lx = ax + R + 6, ly = ay - 10;
        this.roundRect(ctx, lx, ly, w, 20, 10); ctx.fillStyle = p.dataBlock; ctx.fill();
        ctx.font = font; ctx.textAlign = 'left'; ctx.fillStyle = v.state === 'onscene' ? p.red : v.state === 'enroute' ? p.text1 : p.text2;
        ctx.fillText(text, lx + 7, ly + 10.5);
        if (eta != null) { ctx.fillStyle = p.orange; ctx.fillText(` ${mmss(eta)}`, lx + 7 + this.measure(ctx, font, text) + 4, ly + 10.5); }
      }
    }
  }

  // ── aircraft silhouettes ──────────────────────────────────────────────────
  private drawAircraft(ctx: CanvasRenderingContext2D, engine: SimEngine, aircraft: AircraftState[], f: FrameInput) {
    const cam = f.cam, p = this.p;
    const hits = this.acHits; hits.length = 0;
    const pulse = f.reducedMotion ? 1 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin((f.now / 1200) * Math.PI * 2));
    const crawl = f.reducedMotion ? 0 : -((f.now / 1000) * 4) % 8;
    let edgeSet = false; this.edge = null;
    // draw order: others → hovered → selected
    const order = aircraft.slice().sort((a, b) => (a.id === f.selectedId ? 2 : a.id === f.hoveredId ? 1 : 0) - (b.id === f.selectedId ? 2 : b.id === f.hoveredId ? 1 : 0));
    for (const a of order) {
      mercFromXY(engine.proj, a.pos.x, a.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
      const x = scratch.x, y = scratch.y;
      const air = isAirborne(a);
      const shape = getShape(a.perf.icaoCode);
      let lenPx = shape.lengthM * cam.pxPerM;
      const k = Math.max(1, MIN_AC_LEN_PX / Math.max(1e-3, lenPx));
      lenPx = Math.min(MAX_AC_LEN_PX, lenPx * k);
      const isSel = a.id === f.selectedId, isHover = a.id === f.hoveredId && !isSel;
      let eff = (lenPx / shape.lengthM) * (isHover ? 1.15 : 1);
      const radPx = Math.max(shape.spanM / 2, shape.lengthM / 2) * eff;
      const visible = this.onScreen(cam, x, y, radPx + 40);
      const hit = hits[hits.length] = { id: a.id, x, y, r: Math.max(HIT_MIN_PX, radPx), lx: 0, ly: 0, lw: 0, lh: 0, visible, airborne: air, callsign: a.callsign };
      if (isSel && !this.onScreen(cam, x, y, 0) && !edgeSet) {
        edgeSet = true;
        const cx = cam.w / 2, cy = cam.h / 2; const dx = x - cx, dy = y - cy; const ang = Math.atan2(dy, dx);
        const m = 28; const ins = f.insets ?? { left: 0, right: 0, top: 0, bottom: 0 };
        const tx = Math.max(ins.left + m, Math.min(cam.w - ins.right - m, cx + Math.cos(ang) * 10000)), ty = Math.max(ins.top + m, Math.min(cam.h - ins.bottom - m, cy + Math.sin(ang) * 10000));
        this.edge = { x: tx, y: ty, angle: ang / DEG, callsign: a.callsign };
      }
      if (!visible) continue;
      const stage = engine.stageOf(a);
      const mine = ownsPosition(a, f.position);
      const parked = stage === 'parked' || stage === 'arrived';
      const emerg = !!a.emergency && a.emergency.status !== 'resolved';
      const conflict = !!a.conflict;
      let alpha = mine ? 1 : 0.45;
      if (parked && mine) alpha = 0.85;
      ctx.save();
      ctx.globalAlpha = alpha;
      // shadow (subtle drop; grows with altitude)
      const off = air ? Math.min(14, 2 + a.altitude / 400) : 1.5;
      ctx.save(); ctx.translate(x + off, y + off * 1.2); ctx.rotate(a.heading * DEG); ctx.globalAlpha = alpha * (air ? 0.3 : 0.45);
      if (air) { ctx.filter = 'blur(2px)'; }
      drawShape(ctx, shape, eff, p.bg0, p.bg0); ctx.restore();
      // selection: puck-like disc + dashed ring
      if (isSel) {
        const R = Math.max(28, radPx + 10);
        ctx.fillStyle = p.w06; ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = conflict ? p.red : p.w45; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.lineDashOffset = crawl;
        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      if (conflict) {
        ctx.save(); ctx.globalAlpha = alpha * pulse; ctx.strokeStyle = p.red; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, Math.max(12, radPx + 4), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      if (emerg) {
        ctx.strokeStyle = p.red; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, Math.max(16, radPx + 8), 0, Math.PI * 2); ctx.stroke();
      }
      // body
      let body = p.text1, eng = p.bg4;
      if (conflict || emerg) { body = p.red; eng = p.red85; }
      else if (parked) { body = p.w55; eng = p.bg3; }
      if (isHover) eff *= 1; // scale already applied
      ctx.translate(x, y); ctx.rotate(a.heading * DEG);
      drawShape(ctx, shape, eff, body, eng);
      ctx.restore();
      // trail (tower, airborne)
      if (f.layers.trails && air && f.position === 'tower' && a.trail.length > 1) {
        const n = a.trail.length;
        for (let i = 0; i < n; i += 2) {
          mercFromXY(engine.proj, a.trail[i].x, a.trail[i].y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch2);
          ctx.globalAlpha = 0.05 + 0.3 * (i / n); ctx.fillStyle = p.text1;
          ctx.beginPath(); ctx.arc(scratch2.x, scratch2.y, 1, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      // pending-command / request tick (orange dot at the tail)
      if (a.requests.some(r => r.answeredAt == null) && cam.zoom < 13.5) {
        ctx.fillStyle = p.orange; ctx.beginPath(); ctx.arc(x + radPx + 4, y - radPx - 4, 3, 0, Math.PI * 2); ctx.fill();
      }
      hit.r = Math.max(HIT_MIN_PX, radPx);
    }
  }

  // ── STCA / conflict pair lines ────────────────────────────────────────────
  private drawConflictLines(ctx: CanvasRenderingContext2D, engine: SimEngine, f: FrameInput) {
    const cam = f.cam, p = this.p;
    const alerts = engine.activeAlerts();
    if (!alerts.length) return;
    this.pairLines.length = 0;
    for (const al of alerts) {
      if (al.subjectIds.length < 2) continue;
      const a = engine.byId(al.subjectIds[0]), b = engine.byId(al.subjectIds[1]);
      if (!a || !b) continue;
      mercFromXY(engine.proj, a.pos.x, a.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
      mercFromXY(engine.proj, b.pos.x, b.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch2);
      ctx.save(); ctx.strokeStyle = p.red; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.lineDashOffset = f.reducedMotion ? 0 : -((f.now / 1000) * 8) % 8;
      ctx.globalAlpha = f.reducedMotion ? 1 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin((f.now / 1200) * Math.PI * 2));
      ctx.beginPath(); ctx.moveTo(scratch.x, scratch.y); ctx.lineTo(scratch2.x, scratch2.y); ctx.stroke(); ctx.restore();
      if (al.detail) {
        const mx = (scratch.x + scratch2.x) / 2, my = (scratch.y + scratch2.y) / 2;
        const font = fontOf(p, 500, 11); const w = this.measure(ctx, font, al.detail) + 20;
        this.roundRect(ctx, mx - w / 2, my - 12, w, 24, 12); ctx.fillStyle = p.dataBlock; ctx.fill();
        ctx.fillStyle = p.red; ctx.font = font; ctx.textAlign = 'center'; ctx.fillText(al.detail, mx, my + 0.5);
      }
    }
  }

  // ── data blocks (A10) ─────────────────────────────────────────────────────
  private blockParts(engine: SimEngine, a: AircraftState, f: FrameInput): Array<{ t: string; c: string; w?: 500 }> {
    const p = this.p;
    const air = isAirborne(a);
    const parts: Array<{ t: string; c: string; w?: 500 }> = [{ t: a.callsign, c: p.text1, w: 500 }];
    if (f.position === 'tower' || air) {
      parts.push({ t: String(Math.round(a.altitude / 100)).padStart(3, '0'), c: p.text2 });
      parts.push({ t: String(Math.round(a.speed / 10)).padStart(2, '0'), c: p.text2 });
      if (air) {
        const rw = a.assignedRunway ?? a.plan.runway;
        const nm = rw ? engine.distToThresholdNM(a, rw) : null;
        if (nm != null && nm < 15 && a.plan.kind === 'arrival') parts.push({ t: `${nm.toFixed(1)} NM`, c: p.text2 });
      } else {
        if (a.takeoffCleared) parts.push({ t: 'CLR T/O', c: p.green });
        else if (a.phase === 'lineup') parts.push({ t: 'LUAW', c: p.text2 });
        else if (a.plan.runway) parts.push({ t: a.plan.runway, c: p.text2 });
      }
    } else {
      parts.push({ t: a.perf.icaoCode, c: p.text2 });
      const dest = a.plan.kind === 'departure' ? (a.plan.runway ?? '') : (a.reservedStand ?? a.plan.gateRef ?? '');
      if (dest) parts.push({ t: dest, c: p.text2 });
      if (a.holdShortRunway && a.phase === 'hold_short') parts.push({ t: `HS ${a.holdShortRunway}`, c: p.orange });
    }
    return parts;
  }

  private drawDataBlocks(ctx: CanvasRenderingContext2D, engine: SimEngine, f: FrameInput) {
    const cam = f.cam, p = this.p;
    this.placed.length = 0;
    const order = this.acHits.slice().sort((h1, h2) => (h1.id === f.selectedId ? -1 : h2.id === f.selectedId ? 1 : 0));
    const fontB = fontOf(p, 500, 11), fontR = fontOf(p, 400, 11);
    const dotW = this.measure(ctx, fontR, ' · ');
    for (const h of order) {
      if (!h.visible) continue;
      const a = engine.byId(h.id); if (!a) continue;
      const isSel = a.id === f.selectedId, isHover = a.id === f.hoveredId;
      const stage = engine.stageOf(a);
      const parked = stage === 'parked' || stage === 'arrived';
      const hasReq = a.requests.some(r => r.answeredAt == null);
      const emerg = !!a.emergency && a.emergency.status !== 'resolved';
      if (parked && !isSel && !isHover && !hasReq && !emerg) continue;
      if (cam.zoom < 12.6 && !isSel && !isHover && !hasReq && !emerg) continue;
      const mine = ownsPosition(a, f.position);
      const parts = this.blockParts(engine, a, f);
      const pending = a.pendingCmds.length > 0;
      // width
      let w = BLOCK_PAD * 2;
      for (let i = 0; i < parts.length; i++) { w += this.measure(ctx, parts[i].w === 500 ? fontB : fontR, parts[i].t); if (i < parts.length - 1) w += dotW; }
      if (hasReq) w += this.measure(ctx, fontB, 'REQ') + 12;
      if (pending) w += 10;
      if (!mine) w += this.measure(ctx, fontR, a.onFrequency === 'tower' ? 'TWR' : a.onFrequency === 'ground' ? 'GND' : 'APP') + dotW;
      // placement: 8 candidate angles, selected wins
      const edgePad = 60;
      let bx = 0, by = 0, ok = false;
      const angles = h.x > cam.w - edgePad ? [-135, -45, 135, 45, 90, -90, 180, 0] : ANGLES;
      for (const ang of angles) {
        const rad = ang * DEG; const ax = h.x + Math.cos(rad) * (h.r + LEADER), ay = h.y + Math.sin(rad) * (h.r + LEADER);
        bx = Math.cos(rad) >= 0 ? ax : ax - w; by = ay - BLOCK_H / 2;
        if (bx < 4) bx = 4; if (bx + w > cam.w - 4) bx = cam.w - 4 - w;
        let clash = false;
        for (const q of this.placed) { if (bx < q.x + q.w + 4 && bx + w + 4 > q.x && by < q.y + q.h + 4 && by + BLOCK_H + 4 > q.y) { clash = true; break; } }
        if (!clash) { ok = true; break; }
      }
      if (!ok) { const rad = -45 * DEG; bx = h.x + Math.cos(rad) * (h.r + LEADER); by = h.y + Math.sin(rad) * (h.r + LEADER) - BLOCK_H / 2; }
      this.placed.push({ x: bx, y: by, w, h: BLOCK_H });
      h.lx = bx; h.ly = by; h.lw = w; h.lh = BLOCK_H;
      // leader from symbol edge to nearest block corner
      const cxB = Math.max(bx, Math.min(bx + w, h.x)), cyB = Math.max(by, Math.min(by + BLOCK_H, h.y));
      const dx = cxB - h.x, dy = cyB - h.y, L = Math.hypot(dx, dy) || 1;
      ctx.strokeStyle = p.w35; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(h.x + (dx / L) * h.r, h.y + (dy / L) * h.r); ctx.lineTo(cxB, cyB); ctx.stroke();
      // background
      ctx.save();
      let bg = p.dataBlock, border: string | null = null;
      if (emerg) bg = p.red85;
      else if (isSel) { bg = p.bg4; border = p.w18; }
      else if (isHover) bg = p.bg3;
      else if (a.conflict) bg = p.bg3;
      else if (!mine) { bg = p.bg2; ctx.globalAlpha = 0.75; }
      this.roundRect(ctx, bx, by, w, BLOCK_H, BLOCK_H / 2); ctx.fillStyle = bg; ctx.fill();
      if (a.conflict && !emerg) { ctx.fillStyle = p.redTint; ctx.fill(); }
      if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.globalAlpha = 1;
      // text
      ctx.textAlign = 'left';
      let x = bx + BLOCK_PAD; const y = by + BLOCK_H / 2 + 0.5;
      if (!mine) { const tag = a.onFrequency === 'tower' ? 'TWR' : a.onFrequency === 'ground' ? 'GND' : 'APP'; ctx.font = fontR; ctx.fillStyle = p.text3; ctx.fillText(tag, x, y); x += this.measure(ctx, fontR, tag); ctx.fillStyle = p.text4; ctx.fillText(' · ', x, y); x += dotW; }
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]; const font = part.w === 500 ? fontB : fontR;
        ctx.font = font;
        ctx.fillStyle = emerg ? p.text1 : (a.conflict && i === 0) ? p.red : (!mine ? p.text3 : part.c);
        ctx.fillText(part.t, x, y); x += this.measure(ctx, font, part.t);
        if (i < parts.length - 1) { ctx.font = fontR; ctx.fillStyle = emerg ? p.text1 : p.text4; ctx.fillText(' · ', x, y); x += dotW; }
      }
      if (hasReq) { x += 6; ctx.fillStyle = p.orange; ctx.beginPath(); ctx.arc(x + 3, y, 3, 0, Math.PI * 2); ctx.fill(); ctx.font = fontB; ctx.fillText('REQ', x + 9, y); }
      if (pending) { ctx.fillStyle = p.orange; ctx.beginPath(); ctx.arc(bx + w - 7, by + 6, 2.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
  }

  // ── drag-to-heading geometry ──────────────────────────────────────────────
  private drawDrag(ctx: CanvasRenderingContext2D, engine: SimEngine, f: FrameInput) {
    const d = f.drag!; const cam = f.cam, p = this.p;
    const a = engine.byId(d.id); if (!a || !d.active) return;
    mercFromXY(engine.proj, a.pos.x, a.pos.y, scratchM); toScreen(cam, scratchM.x, scratchM.y, scratch);
    const x0 = scratch.x, y0 = scratch.y;
    // rubber band
    ctx.save(); ctx.strokeStyle = p.w35; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(d.x, d.y); ctx.stroke(); ctx.restore();
    // bank-limited turn predictor: r = v² / (g·tan 25°)
    const v = Math.max(60, a.speed) * KT; const r = (v * v) / (9.81 * Math.tan(25 * DEG)); const rPx = r * cam.pxPerM;
    const h0 = a.heading, h1 = d.hdgTrue;
    let delta = ((h1 - h0 + 540) % 360) - 180;
    if (d.dir === 'L' && delta > 0) delta -= 360; if (d.dir === 'R' && delta < 0) delta += 360;
    const right = delta >= 0;
    const cxT = x0 + Math.sin((h0 + (right ? 90 : -90)) * DEG) * rPx, cyT = y0 - Math.cos((h0 + (right ? 90 : -90)) * DEG) * rPx;
    const start = Math.atan2(y0 - cyT, x0 - cxT); const end = start + delta * DEG;
    ctx.strokeStyle = p.orange; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cxT, cyT, rPx, start, end, !right); ctx.stroke();
    const ex = cxT + Math.cos(end) * rPx, ey = cyT + Math.sin(end) * rPx;
    const len = Math.max(40, v * 60 * cam.pxPerM);
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex + Math.sin(h1 * DEG) * len, ey - Math.cos(h1 * DEG) * len); ctx.stroke();
    // readout pill near the cursor
    const mag = ((h1 - engine.magVar) % 360 + 360) % 360;
    const text = `HDG ${hdg3(mag)}${d.dir ? ` · ${d.dir}` : right ? ' · R' : ' · L'}`;
    const font = fontOf(p, 500, 11); const w = this.measure(ctx, font, text) + 20;
    this.roundRect(ctx, d.x + 14, d.y - 12, w, 24, 12); ctx.fillStyle = p.bg4; ctx.fill(); ctx.strokeStyle = p.w18; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = font; ctx.fillStyle = p.text1; ctx.textAlign = 'left'; ctx.fillText(text, d.x + 24, d.y + 0.5);
  }
}

function RUNWAY_HALF_PX(cam: FrameCam): number { return 23 * cam.pxPerM; }

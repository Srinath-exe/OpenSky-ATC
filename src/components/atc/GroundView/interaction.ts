// ============================================================
//  Hit-testing + pointer helpers for the ground map (pure, no DOM).
//  Aircraft / vehicle hits come from the renderer's per-frame hit lists;
//  runway strips, stands and taxiways are resolved against the static
//  geometry (unit mercator → screen through the frame camera).
// ============================================================
import type { SimEngine } from '@/lib/sim/engine';
import type { OsmAirport } from '@/lib/osmAirport';
import type { XY } from '@/lib/sim/projection';
import type { AcHit, VehHit } from './render';
import type { GroundGeometry, GRunway, GRunwayEnd, GStand } from './geometry';
import type { FrameCam } from './mercator';
import { toScreen, toMerc, mercToLngLat } from './mercator';

/** 05 §3.2: ground hit radius 22 CSS px (silhouettes larger than that use their own radius). */
export const HIT_RADIUS_PX = 22;
const STAND_HIT_PX = 12;
const TAXIWAY_SNAP_M = 30;

const scratch: XY = { x: 0, y: 0 };
const scratchM = { x: 0, y: 0 };

/** Closest aircraft under the cursor (symbol disc or data-block rectangle). */
export function hitAircraft(hits: readonly AcHit[], x: number, y: number): AcHit | null {
  let best: AcHit | null = null, bd = Infinity;
  for (const h of hits) {
    if (!h.visible) continue;
    const r = Math.max(HIT_RADIUS_PX, h.r);
    const d = Math.hypot(h.x - x, h.y - y);
    const inLabel = h.lw > 0 && x >= h.lx && x <= h.lx + h.lw && y >= h.ly && y <= h.ly + h.lh;
    if (inLabel) { const dl = d * 0.5; if (dl < bd) { bd = dl; best = h; } continue; }
    if (d <= r && d < bd) { bd = d; best = h; }
  }
  return best;
}

export function hitVehicle(hits: readonly VehHit[], x: number, y: number): VehHit | null {
  let best: VehHit | null = null, bd = Infinity;
  for (const h of hits) {
    if (!h.visible) continue;
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= Math.max(h.r + 4, 16) && d < bd) { bd = d; best = h; }
  }
  return best;
}

export function hitStand(geom: GroundGeometry, cam: FrameCam, x: number, y: number): GStand | null {
  if (cam.zoom < 13.6) return null;
  let best: GStand | null = null, bd = STAND_HIT_PX;
  for (const s of geom.stands) {
    toScreen(cam, s.m.x, s.m.y, scratch);
    const d = Math.hypot(scratch.x - x, scratch.y - y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function pointInQuad(px: number, py: number, sx: number[], sy: number[]): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const yi = sy[i], yj = sy[j], xi = sx[i], xj = sx[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** Runway strip under the cursor (padded by 6 px so thin strips at low zoom stay clickable) + the nearest end. */
export function hitRunway(geom: GroundGeometry, cam: FrameCam, x: number, y: number): { runway: GRunway; end: GRunwayEnd } | null {
  const sx: number[] = [0, 0, 0, 0], sy: number[] = [0, 0, 0, 0];
  for (const rw of geom.runways) {
    for (let i = 0; i < 4; i++) { toScreen(cam, rw.poly[i].x, rw.poly[i].y, scratch); sx[i] = scratch.x; sy[i] = scratch.y; }
    // expand the quad around its centre by 6 px
    const cx = (sx[0] + sx[1] + sx[2] + sx[3]) / 4, cy = (sy[0] + sy[1] + sy[2] + sy[3]) / 4;
    for (let i = 0; i < 4; i++) { const dx = sx[i] - cx, dy = sy[i] - cy, L = Math.hypot(dx, dy) || 1; sx[i] += (dx / L) * 6; sy[i] += (dy / L) * 6; }
    if (!pointInQuad(x, y, sx, sy)) continue;
    let end = rw.ends[0], bd = Infinity;
    for (const e of rw.ends) { toScreen(cam, e.thr.x, e.thr.y, scratch); const d = Math.hypot(scratch.x - x, scratch.y - y); if (d < bd) { bd = d; end = e; } }
    return { runway: rw, end };
  }
  return null;
}

/** Screen px → engine XY (metres). */
export function screenToXY(engine: SimEngine, cam: FrameCam, x: number, y: number): XY {
  toMerc(cam, x, y, scratchM);
  const ll = mercToLngLat(scratchM.x, scratchM.y);
  return engine.proj.toXY(ll.lat, ll.lng);
}

/** Named taxiway nearest to an engine point (route-build taps). */
export function taxiwayAt(engine: SimEngine, xy: XY, maxM = TAXIWAY_SNAP_M): { taxiway: string; nodeId: string } | null {
  const id = engine.nearestNodeId(xy, maxM);
  if (!id) return null;
  const air = engine.air as unknown as OsmAirport;
  const node = air.nodes.get(id);
  if (!node) return null;
  for (const e of node.edges) if (e.type === 'taxiway' && e.taxiway && !e.leadIn) return { taxiway: e.taxiway, nodeId: id };
  return null;
}

/** Angle helpers for drag-to-heading. */
export function turnDelta(from: number, to: number): number { return ((to - from + 540) % 360) - 180; }

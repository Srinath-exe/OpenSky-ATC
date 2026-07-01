// ============================================================
//  Local Projection — lat/lng  ⇄  local Cartesian (x, y) in metres
//
//  Per phase1_simulation_spec.md §1: we project all geographic coords to a
//  flat local grid centred on the airport reference point so physics, distance
//  and separation maths run on cheap Euclidean (x, y) instead of spherical
//  trig. Azimuthal-equidistant style:
//
//      x = R · cos(refLat) · (lng − refLng) · π/180   (east  +)
//      y = R · (lat − refLat) · π/180                  (north +)
//
//  Accurate to well under a metre across a 40 km TMA — far more than enough.
// ============================================================

export const EARTH_RADIUS_M = 6_371_000;
export const DEG = Math.PI / 180;

export interface LngLat { lng: number; lat: number; }
export interface XY { x: number; y: number; }

export class LocalProjection {
  readonly refLat: number;
  readonly refLng: number;
  private readonly kx: number; // metres per degree lng at refLat
  private readonly ky: number; // metres per degree lat

  constructor(refLat: number, refLng: number) {
    this.refLat = refLat;
    this.refLng = refLng;
    this.kx = EARTH_RADIUS_M * Math.cos(refLat * DEG) * DEG;
    this.ky = EARTH_RADIUS_M * DEG;
  }

  toXY(lat: number, lng: number): XY {
    return { x: (lng - this.refLng) * this.kx, y: (lat - this.refLat) * this.ky };
  }

  toLngLat(x: number, y: number): LngLat {
    return { lng: this.refLng + x / this.kx, lat: this.refLat + y / this.ky };
  }
}

// ── Pure (x, y) helpers — all in metres / compass degrees ──────────────────────

export function dist(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function dist2(a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  return dx * dx + dy * dy;
}

// Compass bearing from a→b: 0=N, 90=E, 180=S, 270=W.
// On our grid +y is north and +x is east, so bearing = atan2(east, north).
export function headingTo(a: XY, b: XY): number {
  return (Math.atan2(b.x - a.x, b.y - a.y) / DEG + 360) % 360;
}

// Shortest signed turn from `from`→`to` in degrees, range (−180, 180].
export function angleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

// Move `metres` along a compass `heading` from point p.
export function advance(p: XY, heading: number, metres: number): XY {
  return { x: p.x + Math.sin(heading * DEG) * metres, y: p.y + Math.cos(heading * DEG) * metres };
}

// Distance from point p to segment a–b (metres).
export function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

// ── Polyline helpers for path-following ────────────────────────────────────────

// Remove points that are near-duplicate or backtrack (interior angle < ~25°),
// so A* spurs can't create hairpins the aircraft would have to U-turn through.
export function dedupeBacktracks(pts: XY[], minSeg = 3): XY[] {
  const out: XY[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && dist(last, p) < minSeg) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const back = Math.abs(angleDelta(headingTo(a, b), headingTo(b, p)));
      if (back > 150) { out.pop(); }            // drop the spike vertex
    }
    out.push(p);
  }
  return out.length >= 2 ? out : pts.slice();
}

// Resample a polyline to roughly uniform `spacing` metres so corner-rounding
// (Chaikin) is even and minimum turn radius is consistent everywhere.
export function resample(pts: XY[], spacing: number): XY[] {
  if (pts.length < 2) return pts.slice();
  const out: XY[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    let segLen = dist(a, b);
    if (segLen < 1e-6) continue;
    let d = spacing - carry;
    while (d < segLen) {
      const t = d / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += spacing;
    }
    carry = segLen - (d - spacing);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > 0.5) out.push(last);
  return out;
}

// Chaikin corner-cutting: rounds every corner into a short arc. `iters` passes.
export function chaikin(pts: XY[], iters = 2): XY[] {
  let cur = pts;
  for (let k = 0; k < iters; k++) {
    if (cur.length < 3) break;
    const out: XY[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

// Cumulative arc-length for a polyline. Returns { cum, total }.
export function arcLengths(pts: XY[]): { cum: number[]; total: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { cum, total: cum[cum.length - 1] };
}

// Point + tangent heading at arc-length `d` along a polyline with cumulative `cum`.
export function sampleAlong(pts: XY[], cum: number[], d: number): { pos: XY; heading: number } {
  const total = cum[cum.length - 1];
  if (d <= 0) return { pos: pts[0], heading: headingTo(pts[0], pts[1] ?? pts[0]) };
  if (d >= total) { const n = pts.length; return { pos: pts[n - 1], heading: headingTo(pts[n - 2] ?? pts[n - 1], pts[n - 1]) }; }
  let i = 1;
  while (i < cum.length && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1];
  const t = seg > 1e-6 ? (d - cum[i - 1]) / seg : 0;
  const a = pts[i - 1], b = pts[i];
  return { pos: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, heading: headingTo(a, b) };
}

// Unit conversions used throughout the sim.
export const KTS_TO_MPS = 0.514444;       // knots → metres/second
export const MPS_TO_KTS = 1 / KTS_TO_MPS;
export const NM_TO_M = 1852;              // nautical mile → metres
export const M_TO_NM = 1 / NM_TO_M;
export const FT_TO_M = 0.3048;

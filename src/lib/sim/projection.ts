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

/**
 * Replace every sharp corner of a path with a circular arc tangent to both legs. `radius` is the radius wanted at a
 * corner; where a leg is too short for it the largest radius that fits is used. A leg is the stretch of the polyline
 * that runs on from the corner without another corner and within 18 degrees of its direction (a gently curving lane counts), however many points it is cut into; two corners sharing
 * a leg get half of it each. Bends of under `minTurn` degrees (the vertices of an already curved line) and reversals
 * are left as they are.
 */
export function filletCorners(pts: XY[], radius: number | ((corner: XY) => number), minTurn = 20): XY[] {
  const n = pts.length; if (n < 3) return pts.slice();
  const { cum } = arcLengths(pts);
  const hdg: number[] = []; for (let i = 0; i < n - 1; i++) hdg.push(headingTo(pts[i], pts[i + 1]));
  const turnAt = (i: number) => (i <= 0 || i >= n - 1 ? 0 : angleDelta(hdg[i - 1], hdg[i]));
  const sharp = (i: number) => { const t = Math.abs(turnAt(i)); return t >= minTurn && t <= 150; };
  const at = (s: number): XY => {
    let i = 1; while (i < n - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1] || 1, t = Math.max(0, Math.min(1, (s - cum[i - 1]) / seg));
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  };
  const out: { p: XY; s: number }[] = [{ p: pts[0], s: 0 }];
  let used = 0;   // arc length already taken by the previous corner's arc
  for (let i = 1; i < n; i++) {
    if (i === n - 1 || !sharp(i)) { if (cum[i] > used + 0.01) out.push({ p: pts[i], s: cum[i] }); continue; }
    const turn = turnAt(i); const hin = hdg[i - 1], hout = hdg[i];
    // the straight legs either side of the corner
    let j = i - 1; while (j > 0 && Math.abs(angleDelta(hdg[j - 1], hin)) < 18 && !sharp(j)) j--;
    let k = i + 1; while (k < n - 1 && Math.abs(angleDelta(hdg[k], hout)) < 18 && !sharp(k)) k++;
    const legIn = cum[i] - Math.max(used, cum[j]) - (j > 0 && sharp(j) && cum[j] > used ? 0 : 0);
    const legOut = (cum[k] - cum[i]) * (k < n - 1 && sharp(k) ? 0.5 : 1);
    const half = Math.tan((Math.abs(turn) * DEG) / 2);
    let R = typeof radius === 'number' ? radius : radius(pts[i]);
    let t = R * half; const tMax = Math.min(legIn, legOut) - 0.3;
    if (tMax < 1.5) { out.push({ p: pts[i], s: cum[i] }); continue; }
    if (t > tMax) { t = tMax; R = t / half; }
    const s0 = cum[i] - t, s1 = cum[i] + t;
    while (out.length > 1 && out[out.length - 1].s > s0 - 0.01) out.pop();
    const T1 = at(s0), T2 = at(s1); const sg = turn > 0 ? 1 : -1;
    const right = (h: number) => ({ x: Math.cos(h * DEG), y: -Math.sin(h * DEG) });
    const r0 = right(hin); const C = { x: T1.x + r0.x * R * sg, y: T1.y + r0.y * R * sg };
    out.push({ p: T1, s: s0 });
    const steps = Math.max(2, Math.ceil((Math.abs(turn) * DEG * R) / 2));
    for (let q = 1; q < steps; q++) { const r = right(hin + turn * (q / steps)); out.push({ p: { x: C.x - r.x * R * sg, y: C.y - r.y * R * sg }, s: s0 + (s1 - s0) * (q / steps) }); }
    out.push({ p: T2, s: s1 });
    used = s1;
  }
  return out.map(o => o.p);
}

/**
 * Round a driven path the way a nose wheel is steered: every point becomes the Gaussian-weighted mean of the path
 * within a window of arc length around it (sigma metres; the window shrinks toward either end, so the first and last
 * points stay exactly where they are and the path leaves / arrives along its end segments). Straights are unchanged,
 * gentle curves barely move, and a corner of any angle - however the polyline happens to be cut into segments -
 * becomes one continuous arc: a 90 degree corner at sigma 9 turns on a radius of about 22 m and passes 5 m inside the
 * corner point. Output points are `step` metres apart.
 */
export function smoothPath(pts: XY[], sigma: number, step = 2): XY[] {
  if (pts.length < 3 || sigma <= 0) return pts.slice();
  const u = resample(pts, step); const n = u.length; if (n < 3) return u;
  const { cum, total } = arcLengths(u);
  const out: XY[] = new Array(n);
  const reach = 3 * sigma, k = 1 / (2 * sigma * sigma);
  for (let i = 0; i < n; i++) {
    const w = Math.min(reach, cum[i], total - cum[i]);
    if (w < step * 0.75) { out[i] = u[i]; continue; }
    let sx = 0, sy = 0, sw = 0;
    for (let j = i; j >= 0 && cum[i] - cum[j] <= w; j--) { const d = cum[i] - cum[j]; const g = Math.exp(-d * d * k); sx += u[j].x * g; sy += u[j].y * g; sw += g; }
    for (let j = i + 1; j < n && cum[j] - cum[i] <= w; j++) { const d = cum[j] - cum[i]; const g = Math.exp(-d * d * k); sx += u[j].x * g; sy += u[j].y * g; sw += g; }
    out[i] = { x: sx / sw, y: sy / sw };
  }
  return out;
}

// Cumulative arc-length for a polyline. Returns { cum, total }.
export function arcLengths(pts: XY[]): { cum: number[]; total: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { cum, total: cum[cum.length - 1] };
}

// Point + tangent heading at arc-length `d` along a polyline with cumulative `cum`.
// Binary search over `cum` (B17: paths carry thousands of points).
export function sampleAlong(pts: XY[], cum: number[], d: number): { pos: XY; heading: number } {
  const total = cum[cum.length - 1];
  if (d <= 0) return { pos: pts[0], heading: headingTo(pts[0], pts[1] ?? pts[0]) };
  if (d >= total) { const n = pts.length; return { pos: pts[n - 1], heading: headingTo(pts[n - 2] ?? pts[n - 1], pts[n - 1]) }; }
  const i = upperIndex(cum, d);
  const seg = cum[i] - cum[i - 1];
  const t = seg > 1e-6 ? (d - cum[i - 1]) / seg : 0;
  const a = pts[i - 1], b = pts[i];
  return { pos: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, heading: headingTo(a, b) };
}

// Smallest index i >= 1 with cum[i] >= d (cum is non-decreasing).
export function upperIndex(cum: number[], d: number): number {
  let lo = 1, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < d) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Arc-length of the point on the polyline nearest to `p`, searched from
// arc-length `from` onward (monotonic search for hold nodes along a route).
// Returns { at, dist } with dist = distance from p to the polyline.
export function projectOntoPath(pts: XY[], cum: number[], p: XY, from = 0, maxAhead = Infinity): { at: number; dist: number } {
  let best = { at: from, dist: Infinity };
  const start = Math.max(1, upperIndex(cum, from));
  for (let i = start; i < pts.length; i++) {
    if (cum[i - 1] - from > maxAhead) break;
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 < 1e-9 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) best = { at: cum[i - 1] + (cum[i] - cum[i - 1]) * t, dist: d };
  }
  if (best.at < from) best.at = from;
  return best;
}

// Signed cross-track distance of p from the infinite line through a in direction `hdg` (positive = right of track).
export function crossTrack(p: XY, a: XY, hdg: number): number {
  const rx = Math.sin((hdg + 90) * DEG), ry = Math.cos((hdg + 90) * DEG);
  return (p.x - a.x) * rx + (p.y - a.y) * ry;
}

// Signed along-track distance of p from a in direction `hdg` (positive = ahead).
export function alongTrack(p: XY, a: XY, hdg: number): number {
  return (p.x - a.x) * Math.sin(hdg * DEG) + (p.y - a.y) * Math.cos(hdg * DEG);
}

// Intersection point of two segments (a1-a2, b1-b2) or null when they do not cross.
export function segmentIntersection(a1: XY, a2: XY, b1: XY, b2: XY): XY | null {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  const u = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + (a2.x - a1.x) * t, y: a1.y + (a2.y - a1.y) * t };
}

// Unit conversions used throughout the sim.
export const KTS_TO_MPS = 0.514444;       // knots → metres/second
export const MPS_TO_KTS = 1 / KTS_TO_MPS;
export const NM_TO_M = 1852;              // nautical mile → metres
export const M_TO_NM = 1 / NM_TO_M;
export const FT_TO_M = 0.3048;

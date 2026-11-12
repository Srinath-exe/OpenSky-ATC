// The landing film's world, as a pure function of the frame: the story clock, every aircraft, the camera and the
// shader knobs. Shared by the raea composition (landing.tsx) and the page's tracking export (export-tracks.mjs), so the
// HTML data blocks sit exactly on the aircraft the GPU drew. Scene units are 10 m: x east, z south, y up.

import { AIRPORTS } from './airports.js';
export const W = 1920, H = 1080, FPS = 30, N = 480, SUB = 3;   // story frames 0..N, rendered SUB times as dense
const NM = 185.2;           // units per nautical mile
const U = 10;               // metres per unit
const KT = 1.943844;
export const LEN = { A320: 3.76, B738: 3.95, B77W: 7.39, A359: 6.68, A388: 7.27, B744: 7.07 };   // units
// nose wheel to main gear centre (units): the body swings about the main gear
export const WB = { A320: 1.27, B738: 1.56, B77W: 3.12, A359: 2.87, A388: 3.36, B744: 2.56 };
export const SPAN = { A320: 3.4, B738: 3.58, B77W: 6.48, A359: 6.48, A388: 7.98, B744: 6.44 };        // knots per m/s
const FT = 3.28084 * U;     // feet per unit

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const smoother = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
const v3 = (x, y, z) => [x, y, z];
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, k) => a.map((v) => v * k);
const len = (a) => Math.hypot(...a);
const nrm = (a) => mul(a, 1 / (len(a) || 1));
const mix3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---------- story chapters (story frames; the film is one loop: frame N is frame 0) ----------
export const CH = {
  scope: [0, 44], field: [44, 96], approach: [96, 146], final: [146, 212], taxiin: [212, 262], push: [262, 304], route: [304, 352], takeoff: [352, 404], ai: [404, 448], outro: [448, 480],
};

// ---------- the story clock: seconds of sim time per frame, slow through the flare, time-lapse on the ground ----------
const PACE = [[0, 1.25], [146, 1.25], [168, 0.4], [204, 0.4], [220, 7.8], [262, 7.8], [276, 1.6], [300, 1.6], [316, 9.0], [346, 9.0], [358, 1.0], [404, 1.0], [420, 2.2], [480, 2.2]];
const TAXI_PACE = [8, 9];   // PACE rows of the taxi-out time-lapse (tuned per airport so the take-off meets a gap)
const speedAt = (f) => {
  for (let i = 0; i < PACE.length - 1; i++) { const [a, va] = PACE[i], [b, vb] = PACE[i + 1]; if (f <= b) return lerp(va, vb, smoother(a, b, f)); }
  return PACE[PACE.length - 1][1];
};
let T_TABLE = new Float64Array(N * 10 + 1);
export let PERIOD = 0;
function buildClock(taxiRate) {
  for (const i of TAXI_PACE) PACE[i][1] = taxiRate;
  let acc = 0; T_TABLE[0] = 0;
  for (let i = 1; i < T_TABLE.length; i++) { acc += speedAt((i - 0.5) / 10) / 10; T_TABLE[i] = acc; }
  PERIOD = T_TABLE[N * 10];
}
buildClock(9.0);
export const storyT = (f) => { const x = clamp(f, 0, N) * 10; const i = Math.min(Math.floor(x), N * 10 - 1); const k = x - i; return T_TABLE[i] + (T_TABLE[i + 1] - T_TABLE[i]) * k; };

// ---------- paths ----------
// points: [x, z, r] with r the turn radius at that corner (units)
function fillet(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i === 0 || i === points.length - 1 || !(p[2] > 0)) { out.push([p[0], p[1]]); continue; }
    const a = points[i - 1], c = points[i + 1];
    const d1 = nrm([p[0] - a[0], p[1] - a[1]]), d2 = nrm([c[0] - p[0], c[1] - p[1]]);
    const cos = clamp(d1[0] * d2[0] + d1[1] * d2[1], -1, 1); const th = Math.acos(cos);
    if (th < 1e-3) { out.push([p[0], p[1]]); continue; }
    const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]), l2 = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const t = Math.min(p[2] * Math.tan(th / 2), l1 * 0.48, l2 * 0.48);
    const r = t / Math.tan(th / 2);
    const s0 = [p[0] - d1[0] * t, p[1] - d1[1] * t];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const nl = cross > 0 ? [-d1[1], d1[0]] : [d1[1], -d1[0]];
    const ctr = [s0[0] + nl[0] * r, s0[1] + nl[1] * r];
    const a0 = Math.atan2(s0[1] - ctr[1], s0[0] - ctr[0]);
    const steps = Math.max(3, Math.ceil((th * r) / 3));
    for (let k = 0; k <= steps; k++) { const ang = a0 + (cross > 0 ? 1 : -1) * th * (k / steps); out.push([ctr[0] + Math.cos(ang) * r, ctr[1] + Math.sin(ang) * r]); }
  }
  return out;
}
function resample(pts, step = 2) {
  const out = [{ x: pts[0][0], z: pts[0][1], s: 0 }]; let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue;
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) { const t = k / n; out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, s: s + L * t }); }
    s += L;
  }
  return out;
}
const at = (P, s) => {
  if (s <= 0) return P[0]; if (s >= P[P.length - 1].s) return P[P.length - 1];
  let lo = 0, hi = P.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].s < s) lo = m; else hi = m; }
  const a = P[lo], b = P[hi], t = (s - a.s) / (b.s - a.s || 1);
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, s };
};
const headingAt = (P, s, w = 4) => { const a = at(P, s - w), b = at(P, s + w); return Math.atan2(b.x - a.x, -(b.z - a.z)); };
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

// a leg: a path with a speed (m/s) per distance, an altitude (units) per distance, and an optional pause after it
// a ground path: filleted corners, then a light gaussian along the arc so the nodes of a mapped line never show as kinks
function pathOf(points, step = 2, sigma = 0) {
  let P = resample(fillet(points), step);
  if (!(sigma > 0) || P.length < 5) return P;
  const n = P.length, sg = sigma / step, out = [P[0]];
  for (let i = 1; i < n - 1; i++) {
    const h = Math.min(Math.ceil(3 * sg), i, n - 1 - i); let x = 0, z = 0, w = 0;
    for (let j = -h; j <= h; j++) { const g = Math.exp(-(j * j) / (2 * sg * sg)); x += P[i + j].x * g; z += P[i + j].z * g; w += g; }
    out.push({ x: x / w, z: z / w, s: 0 });
  }
  out.push({ ...P[n - 1] });
  for (let i = 1; i < n; i++) out[i].s = out[i - 1].s + Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
  return out;
}
const TURN_A = 1.0, ACC = 0.5, DEC = 0.7;   // m/s2: sideways in a turn on the ground (about 10 kt on a 30 m radius), speeding up, braking
// a leg: a path with a speed (m/s) per distance, an altitude (units) per distance, and an optional pause after it. With
// opts.turn the speed past opts.capFrom is held to what the curvature allows, with gentle braking before and speeding up after
function leg(points, speed, alt, opts = {}) {
  const P = opts.P || pathOf(points, opts.step || 2, opts.smooth || 0);
  const L = P[P.length - 1].s, n = P.length;
  const V = new Float64Array(n);
  for (let i = 0; i < n; i++) V[i] = speed(P[i].s, L);
  if (opts.turn) {
    let i0 = P.findIndex((q) => q.s >= (opts.capFrom || 0)); if (i0 < 0) i0 = n;
    const w = Math.max(1, Math.round(2 / (opts.step || 2)));
    for (let i = Math.max(i0, w); i < n - w; i++) {
      const a = P[i - w], b = P[i], c = P[i + w];
      const th = Math.abs(angDiff(Math.atan2(b.x - a.x, b.z - a.z), Math.atan2(c.x - b.x, c.z - b.z)));
      const k = th / (((c.s - a.s) / 2) * U || 1);
      V[i] = Math.min(V[i], Math.sqrt(opts.turn / Math.max(k, 1e-6)));
    }
    for (let i = n - 2; i >= i0; i--) V[i] = Math.min(V[i], Math.sqrt(V[i + 1] ** 2 + 2 * (opts.dec || DEC) * (P[i + 1].s - P[i].s) * U));
    for (let i = Math.max(1, i0 + 1); i < n; i++) V[i] = Math.min(V[i], Math.sqrt(V[i - 1] ** 2 + 2 * ACC * (P[i].s - P[i - 1].s) * U));
  }
  // time to each sample
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) { const ds = (P[i].s - P[i - 1].s) * U; const v = Math.max(0.6, (V[i] + V[i - 1]) / 2); t[i] = t[i - 1] + ds / v; }
  return { P, L, t, V, dur: t[n - 1], speed, alt, reverse: !!opts.reverse, hold: opts.hold || 0, pitch: opts.pitch, gear: opts.gear };
}
// where s falls between samples: [lo, hi, k]
const idxAt = (P, s) => {
  if (s <= 0) return [0, 0, 0]; const n = P.length; if (s >= P[n - 1].s) return [n - 1, n - 1, 0];
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].s < s) lo = m; else hi = m; }
  return [lo, hi, (s - P[lo].s) / (P[hi].s - P[lo].s || 1)];
};
// the aircraft as a rigid body on its wheels, through all its legs in order: the leading wheel follows the leg's path and
// the other trails it at the wheelbase, moving only along the fuselage (a tractrix). Taxiing forward the path is the nose
// wheel's and the main gear cuts inside the turn; pushing back the path is the main gear's, the body lies along it and the nose
// swings wide on the tug, as on a real push. Heading is the line from the main gear to the nose wheel, so it never jumps.
function rig(ac) {
  const wb = WB[ac.type] || 2;
  let N = null, M = null;
  for (const lg of ac.legs) {
    const P = lg.P, n = P.length;
    const NX = new Float64Array(n), NZ = new Float64Array(n), MX = new Float64Array(n), MZ = new Float64Array(n);
    if (!N) {
      const a = P[0], b = P[Math.min(n - 1, 2)]; const d = nrm([b.x - a.x, b.z - a.z]);
      if (lg.reverse) { M = [a.x, a.z]; N = [a.x - d[0] * wb, a.z - d[1] * wb]; } else { N = [a.x, a.z]; M = [a.x - d[0] * wb, a.z - d[1] * wb]; }
    }
    let prev = [P[0].x, P[0].z];
    for (let i = 0; i < n; i++) {
      const q = [P[i].x, P[i].z]; const sub = Math.max(1, Math.ceil(Math.hypot(q[0] - prev[0], q[1] - prev[1]) / (wb * 0.08)));
      for (let k = 1; k <= sub; k++) {
        const x = prev[0] + (q[0] - prev[0]) * (k / sub), z = prev[1] + (q[1] - prev[1]) * (k / sub);
        if (lg.reverse) {   // the main gear rolls only along the fuselage: the body lies along its track, the nose swings out on the tug
          const a = P[Math.max(0, i - 2)], c = P[Math.min(n - 1, i + 2)]; const d = nrm([c.x - a.x, c.z - a.z]);
          M = [x, z]; N = [x - d[0] * wb, z - d[1] * wb];
        } else { N = [x, z]; const d = nrm([x - M[0], z - M[1]]); M = [x - d[0] * wb, z - d[1] * wb]; }
      }
      prev = q; NX[i] = N[0]; NZ[i] = N[1]; MX[i] = M[0]; MZ[i] = M[1];
    }
    lg.K = { NX, NZ, MX, MZ };
  }
  return ac;
}
function sAtTime(lg, tt) {
  const t = lg.t; if (tt <= 0) return 0; if (tt >= lg.dur) return lg.L;
  let lo = 0, hi = t.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] < tt) lo = m; else hi = m; }
  const k = (tt - t[lo]) / (t[hi] - t[lo] || 1); return lg.P[lo].s + (lg.P[hi].s - lg.P[lo].s) * k;
}

// ---------- the world ----------
export function makeScene(J) {
  const rw = Object.fromEntries(J.runways.map((r) => [r.ref, r]));
  const C = AIRPORTS[J.icao || 'KJFK'];
  const R31R = rw[J.arr.ref], R31L = rw[J.dep.ref];
  const AE = J.arr.end, AO = AE === 'b' ? 'a' : 'b', DE = J.dep.end, DO = DE === 'b' ? 'a' : 'b';
  const THR = { x: R31R[AE][0], z: R31R[AE][1] };                 // arrival threshold
  const dl = nrm([R31R[AO][0] - R31R[AE][0], R31R[AO][1] - R31R[AE][1]]);  // landing roll direction
  const o = [-dl[0], -dl[1]];                                      // final course, outward
  const pl = [o[1], -o[0]];                                        // the north-east side of the final
  const F = (d, side = 0, r = 0) => [THR.x + o[0] * d * NM + pl[0] * side * NM, THR.z + o[1] * d * NM + pl[1] * side * NM, r];
  const onRw = (d, r = 0) => [THR.x + dl[0] * d, THR.z + dl[1] * d, r];
  const THR_L = { x: R31L[DE][0], z: R31L[DE][1] };
  const dd = nrm([R31L[DO][0] - R31L[DE][0], R31L[DO][1] - R31L[DE][1]]);   // take-off direction
  const onRwL = (d, r = 0) => [THR_L.x + dd[0] * d, THR_L.z + dd[1] * d, r];
  const ddl = mul([dd[1], -dd[0]], C.turn < 0 ? 1 : -1);          // the side the departures turn to
  const GS = Math.tan((3 * Math.PI) / 180);
  const tower = { x: J.tower[0], z: J.tower[1] };

  // ---- arrivals: lateral path to the threshold, then the runway, the exit and the taxi route ----
  const tdD = 30;                                   // touchdown 300 m past the threshold
  function arrival(entry, r) {
    const ground = [onRw(J.exit.s - 22, 0), [exitRw[0], exitRw[1], 4], [exitNode[0], exitNode[1], 3], ...r.route.slice(1).map((p) => [p[0], p[1], 3]), ...r.lead.slice(1).map((p) => [p[0], p[1], 2])];
    const pts = [...entry, F(0), ...ground];
    const P = resample(fillet(pts), 2);
    // the threshold's distance along the path
    let sThr = 0, best = 1e9; for (const q of P) { const d = Math.hypot(q.x - THR.x, q.z - THR.z); if (d < best) { best = d; sThr = q.s; } }
    const sStopRoll = sThr + J.exit.s - 22;
    const speed = (s) => {
      const D = sThr - s;                         // to the threshold (units)
      if (D > 15 * NM) return 118; if (D > 8 * NM) return lerp(78, 118, (D - 8 * NM) / (7 * NM)); if (D > 0) return lerp(71, 78, D / (8 * NM));
      const x = -D - tdD; if (x < 0) return 70;
      if (s < sStopRoll) return Math.max(13, Math.sqrt(Math.max(0, 70 * 70 - 2 * 1.75 * x * U)));
      return 9.5;
    };
    const alt = (s) => {
      const D = sThr - s;
      if (D < -tdD) return 0;
      const gs = D * GS + 1.5;
      if (D < 12) { const k = smooth(-tdD, 12, D); return Math.max(0, gs * k); }
      if (D <= 10.5 * NM) return gs;
      return Math.min(366, 10.5 * NM * GS + 1.5 + (D - 10.5 * NM) * 0.05);
    };
    const pitch = (s) => { const D = sThr - s; if (D > 8) return 0.045; if (D > -tdD) return lerp(0.085, 0.045, smooth(-tdD, 8, D)); return 0.085 * (1 - smooth(-tdD, -tdD - 25, D)); };
    return { ...leg(pts, speed, alt), pitchFn: pitch, sThr };
  }
  const STREAM_S = (far) => [F(13 + far, -11 - far * 0.2, 0), F(12, -5, 400), F(9.5, 0, 450)];
  const STREAM_N = (far) => [F(-2 - far * 0.6, 9 + far * 0.15, 0), F(3, 5.5, 500), F(15.5, 5.5, 480), F(12.5, 0, 450)];
  const STRAIGHT = (far) => [F(26 + far, 0, 0), F(12, 0, 0)];
  const ST = J.story;
  let P_ = PERIOD;

  // ---- arrivals: one every P/m seconds, the same m callsigns every loop (the hero is number 0) ----
  let TD_HERO = storyT(200);
  const CYCLE = C.cycle;
  let M = Math.max(3, Math.round(P_ / 105)), DT = P_ / M;
  const AC = [];
  function arrivalAc(k) {
    const j = ((k % M) + M) % M; const [cs, type, airline] = CYCLE[j % CYCLE.length];
    const hero = j === 0;
    const r = hero ? ST.hero : ST.others[j % ST.others.length];
    const entry = [STREAM_S(0), STREAM_N(0), STRAIGHT(0)][j % 3];
    let taxiV = 9.5;
    const tTd = TD_HERO + k * DT;
    let lg;
    for (let it = 0; it < (hero ? 4 : 1); it++) {
      lg = arrival(entry, r, taxiV);
      if (!hero) break;
      // the hero parks by frame 264: its taxi speed is what makes that true
      const iTd = lg.P.findIndex((q) => q.s >= lg.sThr + tdD), iEx = lg.P.findIndex((q) => q.s >= lg.sExit);
      const want = storyT(264) - (TD_HERO + (lg.t[iEx] - lg.t[iTd]));   // the same for every loop's hero
      const have = lg.t[lg.t.length - 1] - lg.t[iEx];
      taxiV = clamp(taxiV * have / Math.max(20, want), 5, 16);
    }
    const iTd = lg.P.findIndex((q) => q.s >= lg.sThr + tdD);
    return rig({ id: hero ? (k === 0 ? 'hero' : `hero${k}`) : `a${k}`, cs, type, kind: 'arr', legs: [lg], t0: tTd - lg.t[iTd], airline, gold: hero && C.heroGold, park: hero ? P_ + storyT(120) - TD_HERO - (lg.dur - lg.t[iTd]) : 150 });   // the last loop's hero leaves its stand while we are out on the approach
  }
  const X = J.exit2;   // the high-speed exit: its runway junction (s units past the threshold) and its path off the runway
  function arrival(entry, r, taxiV) {
    const exitPts = X.path.map((p, i) => [p[0], p[1], i ? 6 : 20]);
    const ground = [onRw(Math.max(tdD + 20, X.s - 40), 0), ...exitPts.slice(0, 1), ...exitPts.slice(1), ...r.route.slice(1).map((p) => [p[0], p[1], 3]), ...r.lead.slice(1).map((p) => [p[0], p[1], 1.5])];
    const pts = [...entry, F(0), ...ground];
    const P = pathOf(pts, 1, 1.2);
    let sThr = 0, best = 1e9; for (const q of P) { const d = Math.hypot(q.x - THR.x, q.z - THR.z); if (d < best) { best = d; sThr = q.s; } }
    const sJ = sThr + X.s, Lp = P[P.length - 1].s;
    const vEx = 16;   // ~30 kt at the exit
    const speed = (s) => {
      const D = sThr - s;
      if (D > 15 * NM) return 118; if (D > 8 * NM) return lerp(78, 118, (D - 8 * NM) / (7 * NM)); if (D > 0) return lerp(71, 78, D / (8 * NM));
      const x = -D - tdD; if (x < 0) return 70;
      const toStand = (Lp - s) * U;
      const stop = Math.max(0.8, Math.sqrt(2 * 0.35 * Math.max(0, toStand)));     // easing onto the stop mark
      if (s < sJ) return Math.max(vEx, Math.sqrt(Math.max(0, 70 * 70 - 2 * ((70 * 70 - vEx * vEx) / (2 * (X.s - tdD) * U)) * x * U)));
      return Math.min(lerp(vEx, taxiV, smooth(sJ, sJ + 60, s)), stop);
    };
    const alt = (s) => {
      const D = sThr - s;
      if (D < -tdD) return 0;
      const gs = D * GS + 1.5;
      if (D < 12) { const k = smooth(-tdD, 12, D); return Math.max(0, gs * k); }
      if (D <= 10.5 * NM) return gs;
      return Math.min(366, 10.5 * NM * GS + 1.5 + (D - 10.5 * NM) * 0.05);
    };
    const pitch = (s) => { const D = sThr - s; if (D > 8) return 0.045; if (D > -tdD) return lerp(0.085, 0.045, smooth(-tdD, 8, D)); return 0.085 * (1 - smooth(-tdD, -tdD - 25, D)); };
    return { ...leg(pts, speed, alt, { step: 1, P, turn: TURN_A, capFrom: sJ - 45, dec: 1.4 }), pitchFn: pitch, sThr, sExit: sJ };
  }
  for (let k = -3; k <= M + 3; k++) AC.push(arrivalAc(k));

  // ---- departures: stand -> pushback (tug) -> taxi -> line up -> take-off -> climb-out ----
  // the line-up point: far enough down the centreline that the main gear has trailed onto it (about four wheelbases of
  // straight roll after the turn) - the aircraft holds square on the centreline, not at an angle
  const LU = 17;
  const climbPts = (k = 0) => [onRwL(LU), onRwL(330), [THR_L.x + dd[0] * 900 + ddl[0] * 40, THR_L.z + dd[1] * 900 + ddl[1] * 40, 600], [THR_L.x + dd[0] * 900 + ddl[0] * 3000, THR_L.z + dd[1] * 900 + ddl[1] * 3000, 900 + k]];
  const sLo = 175;
  const airLeg = (k) => {
    const air = leg(climbPts(k), (s) => (s < sLo ? Math.max(4, Math.sqrt(2 * 2.1 * s * U)) : Math.min(125, Math.sqrt(2 * 2.1 * sLo * U) + (s - sLo) * 0.06)),
      (s) => (s < sLo ? 0 : Math.min(400, (s - sLo) * 0.13 * smooth(sLo, sLo + 40, s))), {});
    air.pitchFn = (s) => lerp(0, 0.13, smooth(sLo - 30, sLo + 6, s)) + 0.02 * smooth(sLo + 6, sLo + 50, s);   // about 2 deg/s about the main gear: 7.5 deg at lift-off, 8.6 climbing
    return air;
  };
  // when the take-off roll reaches the arrival runway, measured from brake release
  const AIR0 = airLeg(0);
  const sCross = (() => { let best = 1e9, sb = 0; for (const q of AIR0.P) { const rx = q.x - THR.x, rz = q.z - THR.z; const off = Math.abs(rx * dl[1] - rz * dl[0]); if (off < best && q.s < sLo + 60) { best = off; sb = q.s; } } return sb; })();
  const tCross = AIR0.t[AIR0.P.findIndex((q) => q.s >= sCross)] || 38;
  const arrCross = (() => { const a = arrivalAc(1); const lg = a.legs[0]; let best = 1e9, i0 = 0; lg.P.forEach((q, i) => { const d = Math.hypot(q.x - (THR_L.x + dd[0] * sCross), q.z - (THR_L.z + dd[1] * sCross)); if (d < best && q.s > lg.sThr) { best = d; i0 = i; } }); return lg.t[i0] - lg.t[lg.P.findIndex((q) => q.s >= lg.sThr + tdD)]; })();
  {
    let best = [1e9, 9, 10];
    for (let r = 8; r <= 16.001; r += 0.02) {
      buildClock(r); const P = PERIOD;
      for (let m = 6; m <= 16; m++) {
        const dt = P / m; if (dt < 92 || dt > 125) continue;
        const base = storyT(200) + arrCross + 0.5 * dt - tCross; const want = storyT(356);
        let e = (want - base) % dt; if (e < 0) e += dt; e = Math.min(e, dt - e);
        if (e < best[0]) best = [e, r, m];
      }
    }
    if (typeof process !== "undefined" && process.env && process.env.DBG) console.log("taxi pace", best);
    buildClock(best[1]); P_ = PERIOD; M = best[2]; DT = P_ / M; TD_HERO = storyT(200);
    AC.length = 0; for (let k = -M - 1; k <= M + 3; k++) AC.push(arrivalAc(k));
  }
  // the brake-release time nearest `want` whose crossing falls mid-gap between two arrivals
  const rollSlot = (want) => {
    const k = Math.round((want + tCross - TD_HERO - arrCross - 0.5 * DT) / DT);
    return TD_HERO + k * DT + arrCross + 0.5 * DT - tCross;
  };
  function departure(id, [cs, type, airline], r, tPush, tRoll, opts = {}) {
    const legs = [];
    if (opts.lineOnly) {   // already lined up when it appears (the camera is up at the scope then), then the take-off
      const lu0 = leg([onRwL(LU - 0.4), onRwL(LU - 0.2)], () => 1, () => 0, {});
      const lu = leg([onRwL(LU - 0.2), onRwL(LU)], () => 1, () => 0, {});
      lu.hold = Math.max(1, tRoll - tPush - lu0.dur - lu.dur);
      AC.push(rig({ id, cs, type, kind: 'dep', legs: [lu0, lu, airLeg(opts.k || 0)], t0: tPush, airline, startOnStand: false, tug: false }));
      return;
    }
    let route = r.route; if (opts.cut) route = route.slice(0, Math.floor(route.length * opts.cut));
    const l0 = r.lead[0];
    let k = 1; while (k < route.length - 1 && Math.hypot(route[k][0] - l0[0], route[k][1] - l0[1]) < 4) k++;
    const D = nrm([route[k][0] - l0[0], route[k][1] - l0[1]]);
    // the push, as the main gear's path: straight back along the stand's axis until it meets the taxilane, one arc onto the
    // lane with the tail swinging away from the way out, then straight along the lane until the nose has followed it round
    const wb = WB[type] || 2, Rp = wb > 2.2 ? 3.0 : 2.2;
    const stop = r.lead[r.lead.length - 1], pre = r.lead[r.lead.length - 2];
    const u = nrm([stop[0] - pre[0], stop[1] - pre[1]]);                       // the stand's axis, nose in
    const M0 = [stop[0] - u[0] * wb, stop[1] - u[1] * wb];
    let C = l0;
    { const den = -u[0] * D[1] + u[1] * D[0];                                  // M0 - u t = l0 + D w
      if (Math.abs(den) > 0.5) { const rx = l0[0] - M0[0], rz = l0[1] - M0[1]; const tt = (rx * D[1] - rz * D[0]) / den; if (tt > 2 * Rp) C = [M0[0] - u[0] * tt, M0[1] - u[1] * tt]; } }
    const th = Math.acos(clamp(-(-u[0] * D[0] - u[1] * D[1]), -1, 1));        // the turn from going back along -u to going along -D
    const tIn = Rp * Math.tan(th / 2), E = Math.max(tIn / 0.48, tIn + 1.6 * wb);
    const swing = [C[0] - D[0] * E, C[1] - D[1] * E];
    const pushPts = [[M0[0], M0[1], 0], [C[0], C[1], Rp], [swing[0], swing[1], 0]];
    const push = leg(pushPts, (s, L) => 0.25 + 1.35 * Math.min(1, s / 2.5, (L - s) / 3), () => 0, { reverse: true, step: 0.5, smooth: 0.8 });
    rig({ type, legs: [push] });
    const nEnd = [push.K.NX[push.P.length - 1], push.K.NZ[push.P.length - 1]];
    const tTaxi = Math.max(opts.tTaxi ?? -1e9, tPush + push.dur + 12);
    push.hold = Math.max(8, tTaxi - tPush - push.dur);
    legs.push(push);
    const lineUp = opts.cut ? [] : [onRwL(4.2, 1.6), onRwL(LU, 0)];   // onto the centreline with a proper turn, then straight to the line-up point
    const taxiPts = [[nEnd[0], nEnd[1], 0], [C[0], C[1], 0], ...route.slice(1).filter((p) => Math.hypot(p[0] - C[0], p[1] - C[1]) > 1).map((p, i, a) => [p[0], p[1], i < a.length - 1 ? 3 : opts.cut ? 0 : 3.5]), ...lineUp];
    const L = resample(fillet(taxiPts), 1); const len = L[L.length - 1].s * U;
    const want = Math.max(30, (opts.tLine ?? tRoll - 25) - tTaxi);
    let v = opts.cut ? 8.5 : clamp(len / want, 4, 16), taxi;
    for (let it = 0; it < (opts.cut ? 1 : 5); it++) {   // the speed that gets it there on time, starts and stops included
      const vv = v;
      taxi = leg(taxiPts, (s, Lx) => Math.min(vv, 1.2 + s * U * 0.06, Math.max(1, Math.sqrt(2 * 0.4 * Math.max(0, (Lx - s) * U)))), () => 0, { step: 1, smooth: 1.2, turn: TURN_A });
      if (opts.cut) break;
      v = clamp(v * taxi.dur / want, 4, 16);
    }
    taxi.hold = opts.cut ? 1e6 : Math.max(5, tRoll - tTaxi - taxi.dur);
    legs.push(taxi);
    if (!opts.cut) legs.push(airLeg(opts.k || 0));
    AC.push(rig({ id, cs, type, kind: 'dep', legs, t0: tPush, airline, startOnStand: true, tug: true }));
  }
  // the departure we follow: across the apron from the hero's stand
  const T_ROLL = rollSlot(storyT(356));
  const D747 = C.cycleDep;
  departure('dep', D747, ST.dep, storyT(268), T_ROLL, { tTaxi: storyT(318), tLine: storyT(350) });
  departure('dep_prev', D747, ST.dep, storyT(268) - P_, T_ROLL - P_, { tTaxi: storyT(318) - P_, tLine: storyT(350) - P_ });
  departure('dep_next', D747, ST.dep, storyT(268) + P_, T_ROLL + P_, { tTaxi: storyT(318) + P_, tLine: storyT(350) + P_ });
  // an earlier departure (seen during the approach) and its loop twin
  const dr = J.dep_routes;
  const T_ROLL2 = rollSlot(storyT(118));
  departure('d1', C.traffic.d1, dr[1], storyT(22), T_ROLL2, { lineOnly: true });
  departure('d1_prev', C.traffic.d1, dr[1], storyT(22) - P_, T_ROLL2 - P_, { lineOnly: true });

  // story time -> aircraft state
  function stateAt(ac, T) {
    let tt = T - ac.t0;
    if (tt < 0) {
      if (ac.kind === 'dep' && ac.startOnStand && tt > -900) return pose(ac, ac.legs[0], 0, 0, true);
      return null;
    }
    for (let i = 0; i < ac.legs.length; i++) {
      const lg = ac.legs[i];
      if (tt <= lg.dur) return pose(ac, lg, sAtTime(lg, tt), i);
      tt -= lg.dur;
      if (tt <= lg.hold) return pose(ac, lg, lg.L, i, true);
      tt -= lg.hold;
    }
    const lg = ac.legs[ac.legs.length - 1];
    if (ac.kind === 'arr' && tt < (ac.park ?? 150)) return pose(ac, lg, lg.L, 0, true);
    return null;
  }
  // x, z: the nose wheel; mx, mz: the main gear (the pivot for heading and pitch); tugA: the tug's angle off the nose
  function pose(ac, lg, s, legIdx, holding = false) {
    const [i, j, kk] = idxAt(lg.P, s); const K = lg.K, n = lg.P.length;
    const nx = lerp(K.NX[i], K.NX[j], kk), nz = lerp(K.NZ[i], K.NZ[j], kk), mx = lerp(K.MX[i], K.MX[j], kk), mz = lerp(K.MZ[i], K.MZ[j], kk);
    const hdg = Math.atan2(nx - mx, -(nz - mz));
    const v = holding ? 0 : lerp(lg.V[i], lg.V[j], kk);
    const p = { x: nx, z: nz };
    const y = lg.alt(s);
    const h0 = headingAt(lg.P, s - 12, 6), h1 = headingAt(lg.P, s + 12, 6);
    const dpsi = angDiff(h0, h1) / (24 * U);
    // banked into the turn in the air; on the ground the body leans a touch outward on its struts
    const bank = y > 3 ? clamp(Math.atan((v * v * dpsi) / 9.81), -0.45, 0.45) : y < 0.05 ? clamp(-Math.atan((v * v * dpsi) / 9.81) * 0.1, -0.012, 0.012) : 0;
    // the nose wheel's travel: the tug sits ahead of it, along it
    const a = Math.max(0, i - 3), b = Math.min(n - 1, j + 3);
    const mvx = K.NX[b] - K.NX[a], mvz = K.NZ[b] - K.NZ[a];
    const tugA = Math.hypot(mvx, mvz) > 1e-3 && lg.reverse ? clamp(angDiff(hdg, Math.atan2(-mvx, mvz)), -1.2, 1.2) : 0;
    const pitch = lg.pitchFn ? lg.pitchFn(s) : 0;
    const vs = y > 0.5 ? (lg.alt(s + 1) - lg.alt(s - 1)) / 2 : 0;
    return { id: ac.id, cs: ac.cs, type: ac.type, kind: ac.kind, x: p.x, y, z: p.z, mx, mz, tugA, s, hdg, pitch, bank, v, kt: Math.round(v * KT), ft: Math.round(y * FT), vs, leg: legIdx, holding, airborne: y > 0.3, airline: ac.airline, gold: !!ac.gold, tug: ac.tug && legIdx === 0 && (v > 0.05 || (holding && s > 1)) };
  }
  const aircraftAt = (f) => { const T = storyT(f); return AC.map((ac) => stateAt(ac, T)).filter(Boolean); };
  const trailAt = (ac, f, n = 14, dt = 5) => { const T = storyT(f); const out = []; for (let k = 1; k <= n; k++) { const s = stateAt(ac, T - k * dt); if (s && s.airborne) out.push(s); } return out; };

  // ---------- the camera: shots, cross-faded (weights always sum to 1) ----------
  const hero = AC.find((a) => a.id === 'hero');
  const dep = AC.find((a) => a.id === 'dep');
  const heroAt = (f) => stateAt(hero, storyT(f));
  const depAt = (f) => stateAt(dep, storyT(f));
  const P = (d, side, y) => { const q = F(d, side); return [q[0], y, q[1]]; };
  const top = (e, fov) => [e, [e[0] + 2, 0, e[2] - 12], fov];
  function spline(keys, f, idx) {
    if (f <= keys[0][0]) return keys[0][idx];
    if (f >= keys[keys.length - 1][0]) return keys[keys.length - 1][idx];
    let i = 0; while (keys[i + 1][0] < f) i++;
    const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
    const h = k2[0] - k1[0], t = (f - k1[0]) / h;
    const tan = (a, b, c) => {
      const ha = b[0] - a[0] || 1, hc = c[0] - b[0] || 1;
      const one = (va, vb, vc) => { const v = (vc - va) / (c[0] - a[0] || 1); const cap = Math.min(Math.abs(vb - va) / ha, Math.abs(vc - vb) / hc) * 1.5; return Math.sign(v) * Math.min(Math.abs(v), cap) * h; };
      return Array.isArray(a[idx]) ? a[idx].map((_, j) => one(a[idx][j], b[idx][j], c[idx][j])) : one(a[idx], b[idx], c[idx]);
    };
    const m1 = i === 0 ? (Array.isArray(k1[idx]) ? k1[idx].map(() => 0) : 0) : tan(k0, k1, k2);
    const m2 = i + 2 > keys.length - 1 ? (Array.isArray(k2[idx]) ? k2[idx].map(() => 0) : 0) : tan(k1, k2, k3);
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
    if (Array.isArray(k1[idx])) return k1[idx].map((v, j) => h00 * v + h10 * m1[j] + h01 * k2[idx][j] + h11 * m2[j]);
    return h00 * k1[idx] + h10 * m1 + h01 * k2[idx] + h11 * m2;
  }
  const dirOf = (ac, f, dt = 7) => { const T = storyT(f); const a = stateAt(ac, T - dt), b = stateAt(ac, T + dt); if (!a || !b || Math.hypot(b.x - a.x, b.z - a.z) < 0.5) return null; return nrm([b.x - a.x, 0, b.z - a.z]); };
  const fwdOf = (s) => [Math.sin(s.hdg), 0, -Math.cos(s.hdg)];
  // the landing, riding with the hero: low behind it down the glidepath, then round to its side for the flare, the
  // touchdown and the rollout, on the far side from the exit so it turns off away from us
  const XE = X.path[X.path.length - 1];
  const camSide = -(Math.sign((XE[0] - THR.x) * -dl[1] + (XE[1] - THR.z) * dl[0]) || 1);
  function chase(f) {
    const a = heroAt(f) || heroAt(200);
    const fwd = [dl[0], 0, dl[1]], right = [-fwd[2], 0, fwd[0]];
    const k = smoother(176, 198, f);
    const az = lerp(0.2, 1.05, k) * camSide, dist = lerp(15, 15.5, k);
    const pos = [a.x, a.y, a.z];
    const eye = add(add(pos, add(mul(fwd, -Math.cos(az) * dist), mul(right, Math.sin(az) * dist))), [0, lerp(2.3, 2.6, k), 0]);
    eye[1] = Math.max(eye[1], 1.2);
    const tgt = add(pos, add(mul(fwd, lerp(26, 2.6, k)), [0, lerp(-1.1, -0.2, k), 0]));
    return { eye, tgt, fov: lerp(40, 36, k) };
  }
  // taxi-in: above and behind the hero, the route ahead in view
  function taxiFollow(f) {
    const a = heroAt(f) || heroAt(262);
    const fwd = dirOf(hero, f, 9) || fwdOf(a), right = [-fwd[2], 0, fwd[0]];
    const pos = [a.x, 0, a.z];
    // backs off and climbs once it is clear of the runway: more of the route in view, the motion calmer on screen
    const k = smoother(214, 236, f);
    return { eye: add(add(add(pos, mul(fwd, lerp(-22, -36, k))), mul(right, lerp(9, 13, k))), [0, lerp(13, 27, k), 0]), tgt: add(pos, add(mul(fwd, lerp(3, 7, k)), [0, 1.2, 0])), fov: lerp(42, 46, k) };
  }
  // across the apron: from the parked hero to the pushback
  const SH = ST.hero.p, SD = ST.dep.p;
  const mid = [(SH[0] + SD[0]) / 2, 0, (SH[1] + SD[1]) / 2];
  const across = nrm([SD[0] - SH[0], 0, SD[1] - SH[1]]); const perp = [-across[2], 0, across[0]];
  const towerSide = Math.sign((tower.x - mid[0]) * perp[0] + (tower.z - mid[2]) * perp[2]) || 1;
  function switchShot(f) {
    const h = heroAt(f) || heroAt(264), d = depAt(f) || depAt(278);
    const look = smoother(262, 290, f);
    return { eye: add(add(mid, mul(perp, -towerSide * 34)), [0, 26, 0]), tgt: mix3([h.x, 1, h.z], [d.x, 1, d.z], look), fov: 46 };
  }
  // the controller's view: the route from above, then down onto the departure as it taxis
  const R = ST.dep.route; const rc = [R.reduce((a, p) => a + p[0], 0) / R.length, 0, R.reduce((a, p) => a + p[1], 0) / R.length];
  const rExt = Math.max(...R.map((p) => Math.hypot(p[0] - rc[0], p[1] - rc[2])));
  function routeTop(f) {
    const d = depAt(f) || depAt(318);
    const k = smoother(326, 352, f);
    const hi = { eye: [rc[0], rExt * 2.2 + 60, rc[2] + rExt * 0.35], tgt: rc };
    const lo = { eye: [d.x - Math.sin(d.hdg) * 60, 45, d.z + Math.cos(d.hdg) * 60], tgt: [d.x, 0, d.z] };
    return { eye: mix3(hi.eye, lo.eye, k), tgt: mix3(hi.tgt, lo.tgt, k), fov: lerp(44, 46, k) };
  }
  // the take-off, from the far side of the runway near the rotation point: a long lens on the 747 as it lines up and
  // rolls toward us with the airport behind it, panning as it rotates and climbs away
  const twrSideL = Math.sign((tower.x - THR_L.x) * -dd[1] + (tower.z - THR_L.z) * dd[0]) || 1;
  const RB = [THR_L.x + dd[0] * 196 + dd[1] * twrSideL * 38, 1.4, THR_L.z + dd[1] * 196 - dd[0] * twrSideL * 38];
  function rollBy(f) {
    const a = depAt(f) || depAt(404);
    const fw = fwdOf(a); const pos = [a.x - fw[0] * LEN.B744 * 0.38, a.y + 0.7, a.z - fw[2] * LEN.B744 * 0.38];
    const d = len(sub(pos, RB));
    return { eye: RB, tgt: pos, fov: clamp((2 * Math.atan((LEN.B744 * 1.1) / d) * 180) / Math.PI, 4.5, 34) };
  }
  const c404 = rollBy(404);
  const T4 = [tower.x, 0, tower.z];
  const FREE = [
    [0, ...top(P(3.0, 0.25, 2650), 46)],
    [36, ...top(P(2.6, 0.2, 2400), 44)],
    [70, P(6.0, -2.6, 1250), [0, 0, 0], 42],
    [96, P(3.2, -1.6, 520), [0, 0, 0], 40],
    [118, P(7.0, -4.6, 400), P(4.6, 0.3, 28), 40],
    [140, P(4.0, -2.0, 170), P(2.0, 0.1, 15), 38],
    [158, P(1.9, -0.35, 30), P(0.7, 0.0, 6), 36],
    [404, c404.eye, c404.tgt, c404.fov],
    [428, add(T4, [-700, 900, 1200]), add(T4, [120, 0, 100]), 46],
    [452, ...top(P(2.7, 0.2, 2500), 46)],
    [480, ...top(P(3.0, 0.25, 2650), 46)],
  ];
  const SHOTS = [
    [(f) => ({ eye: spline(FREE, f, 1), tgt: spline(FREE, f, 2), fov: spline(FREE, f, 3) }), -1, -1, 146, 170, 404, 428, 1e9, 1e9],
    [chase, 146, 170, 212, 228],
    [taxiFollow, 212, 228, 258, 274],
    [switchShot, 258, 274, 304, 318],
    [routeTop, 304, 318, 344, 360],
    [rollBy, 344, 360, 404, 428],
  ];
  function camera(f) {
    let eye = [0, 0, 0], tgt = [0, 0, 0], fov = 0, wsum = 0;
    for (const [fn, a0, a1, b0, b1, c0, c1, d0, d1] of SHOTS) {
      let w = (a1 < 0 ? 1 : smoother(a0, a1, f)) * (1 - smoother(b0, b1, f));
      if (c0 !== undefined) w += smoother(c0, c1, f) * (1 - smoother(d0, d1, f));
      if (w <= 1e-4) continue;
      const c = fn(f); eye = add(eye, mul(c.eye, w)); tgt = add(tgt, mul(c.tgt, w)); fov += c.fov * w; wsum += w;
    }
    return { eye: mul(eye, 1 / wsum), tgt: mul(tgt, 1 / wsum), fov: fov / wsum };
  }

  // ---------- the controller's taxi instructions ----------
  // Each word has its frame (the page pops them in one by one); each taxiway's centreline lights come on as it is named,
  // ahead of the aircraft, and go out behind it ("follow the greens"). The departure's lights stop at the runway's stop
  // bar until it is switched off for the line-up.
  const cumOf = (pts) => { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return c; };
  const sOn = (pts, cum, q) => { let b = 1e9, s = 0; for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], c = pts[i + 1]; const x = c[0] - a[0], z = c[1] - a[1], l2 = x * x + z * z || 1; const t = clamp(((q[0] - a[0]) * x + (q[1] - a[1]) * z) / l2); const d = Math.hypot(a[0] + x * t - q[0], a[1] + z * t - q[1]); if (d < b) { b = d; s = cum[i] + Math.sqrt(l2) * t; } } return s; };
  function instruction(who, pts, names, head, f0, dw, dn, ac) {
    const cum = cumOf(pts), L = cum[cum.length - 1];
    const words = head.map((w, i) => ({ w, f: f0 + i * dw }));
    const fN = f0 + head.length * dw + 0.4;
    const segs = names.map(([name, p0], i) => ({ name, s0: i ? sOn(pts, cum, p0) : 0, f: fN + i * dn, p0 }));
    segs.forEach((g, i) => { g.s1 = i < segs.length - 1 ? segs[i + 1].s0 : L; });
    for (const g of segs) words.push({ w: g.name, f: g.f, twy: true });
    return { who, pts, cum, L, words, segs, ac, sOf: (q) => sOn(pts, cum, q) };
  }
  const HP = [...X.path, ...ST.hero.route.slice(1)];
  const DP = ST.dep.route;
  const INSTR = [
    instruction('hero', HP, ST.hero.names, [hero.cs, 'TAXI', 'TO', 'STAND', ST.hero.stand, 'VIA'], 202.5, 0.75, 1.15, hero),
    instruction('dep', DP, ST.dep.names, [dep.cs, 'RUNWAY', C.depName, 'TAXI', 'VIA'], 305.5, 0.9, 1.6, dep),
  ];
  const HOLD = ST.dep.hold ? (() => { const I = INSTR[1]; const m = [(ST.dep.hold[0][0] + ST.dep.hold[1][0]) / 2, (ST.dep.hold[0][1] + ST.dep.hold[1][1]) / 2]; const s = I.sOf(m); let i = 1; while (i < I.cum.length - 1 && I.cum[i] < s) i++; const a = DP[i - 1], b = DP[i]; const t = nrm([b[0] - a[0], b[1] - a[1]]); const c = [a[0] + t[0] * (s - I.cum[i - 1]), a[1] + t[1] * (s - I.cum[i - 1])]; return { s, c, n: [-t[1], t[0]] }; })() : null;
  // where the lights are on along an instruction's route at frame f: [from, to] in route units, or null
  function greens(I, f) {
    let reach = -1;
    for (const g of I.segs) if (f >= g.f) reach = Math.max(reach, g.s0 + (g.s1 - g.s0) * smooth(g.f, g.f + 1.1, f));
    if (reach < 0) return null;
    const a = stateAt(I.ac, storyT(f));
    const sa = a ? I.sOf([a.x, a.z]) : 0;
    let bar = false;
    if (I.who === 'dep' && HOLD) { bar = sa < HOLD.s - 4.5; if (bar) reach = Math.min(reach, HOLD.s - 0.4); }
    if (a && sa > I.L - 1.0) return { from: 0, to: 0, bar: false };
    if (I.who === 'dep' && a && a.leg > 1) return { from: 0, to: 0, bar: false };
    return { from: Math.max(0, sa - 1.2), to: reach, bar };
  }

  // ---------- shader knobs (equal at frame 0 and frame N, so the loop is seamless) ----------
  function knobs(f) {
    const back = smooth(448, 478, f);
    return {
      scope: 1 - smooth(40, 90, f) + smooth(440, 472, f),
      sweepk: 1 - smooth(40, 80, f) + smooth(444, 474, f),
      reveal: smooth(50, 100, f) * (1 - back),
      sweep: (f * (2 * Math.PI * 8) / N) % (2 * Math.PI),
      course: clamp(1 - smooth(150, 180, f) + smooth(440, 470, f)),
      wave: f >= 304 && f < 330 ? (f - 304) / 26 : -1,
      sectors: smooth(408, 420, f) * (1 - smooth(440, 454, f)),
      city: 0.35 + 0.65 * smooth(50, 100, f) * (1 - back),
      heroRoute: smooth(208, 222, f) * (1 - smooth(262, 272, f)),
      depRoute: smooth(306, 324, f) * (1 - smooth(372, 384, f)),
      rabbit: f,
    };
  }

  // ---------- footprints: fuselage, swept wing and tailplane as segments (the pose point is the nose wheel) ----------
  function foot(s) {
    const ln = LEN[s.type], sp = SPAN[s.type] / 2; const f = [Math.sin(s.hdg), -Math.cos(s.hdg)], r = [-f[1], f[0]];
    const P = (a, b) => [s.x + f[0] * a * ln + r[0] * b, s.z + f[1] * a * ln + r[1] * b];
    return [[P(0.12, 0), P(-0.88, 0)], [P(-0.28, 0), P(-0.48, -sp)], [P(-0.28, 0), P(-0.48, sp)], [P(-0.80, -sp * 0.32), P(-0.80, sp * 0.32)]];
  }
  const segDist = ([a, b], [c, d]) => {
    const pd = (p, a, b) => { const x = b[0] - a[0], z = b[1] - a[1]; const t = clamp(((p[0] - a[0]) * x + (p[1] - a[1]) * z) / (x * x + z * z || 1)); return Math.hypot(p[0] - a[0] - x * t, p[1] - a[1] - z * t); };
    const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    if ((cr(a, b, c) > 0) !== (cr(a, b, d) > 0) && (cr(c, d, a) > 0) !== (cr(c, d, b) > 0)) return 0;
    return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b));
  };
  const gap = (a, b) => { let m = 1e9; for (const p of foot(a)) for (const q of foot(b)) m = Math.min(m, segDist(p, q)); return m; };
  // ---------- the parked fleet: free stands, nose wheel on the stop mark, never in the way of anything that moves ----------
  const PARK = (() => {
    const moving = [];
    for (let f = 0; f <= N; f += 0.5) for (const s of aircraftAt(f)) if (s.y < 0.3) moving.push(s);
    const busy = new Set([...J.dep_routes.map((r) => r.stand), ...J.arr_routes.map((r) => r.stand), ST.hero.stand, ST.dep.stand, ...ST.others.map((o) => o.stand)]);
    const out = []; let i = 0;
    for (const st of J.stands) {
      i++; if (busy.has(st.ref)) continue;
      const near = out.reduce((m, q) => Math.min(m, Math.hypot(q.x - st.p[0], q.z - st.p[1])), 1e9);
      const hh = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
      if (near < 4.6 || hh < 0.22) continue;
      const heavy = ['B77W', 'A388', 'B744', 'A359', 'B77W', 'A388', 'B744'];
      const type = near > 7.2 && hh > (C.heavies ? 0.5 : 0.72) ? (C.heavies ? heavy[Math.floor(((hh - 0.5) / 0.5) * heavy.length) % heavy.length] : hh > 0.86 ? 'B77W' : 'A359') : hh > 0.5 ? 'B738' : 'A320';
      const p = { stand: st.ref, type, x: st.p[0], z: st.p[1], hdg: st.hdg };
      if (out.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 16 && gap(p, q) < 0.4)) continue;
      if (moving.some((m) => Math.hypot(m.x - p.x, m.z - p.z) < 16 && gap(p, m) < 0.6)) continue;
      out.push(p);
    }
    return out;
  })();

  // ---------- projection (Bevy: right-handed, y up, looking down -z, vertical fov) ----------
  function project(cam, p, w = W, h = H) {
    const fwd = nrm(sub(cam.tgt, cam.eye)); const right = nrm([fwd[1] * 0 - fwd[2] * 1, fwd[2] * 0 - fwd[0] * 0, fwd[0] * 1 - fwd[1] * 0]);
    // right = fwd x up(0,1,0)
    const r = nrm([-fwd[2], 0, fwd[0]]); const up = [r[1] * fwd[2] - r[2] * fwd[1], r[2] * fwd[0] - r[0] * fwd[2], r[0] * fwd[1] - r[1] * fwd[0]];
    const d = sub(p, cam.eye); const zc = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
    if (zc < 0.5) return null;
    const xc = d[0] * r[0] + d[1] * r[1] + d[2] * r[2], yc = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    const th = Math.tan(((cam.fov * Math.PI) / 180) / 2), asp = w / h;
    const nx = xc / (zc * th * asp), ny = yc / (zc * th);
    return { x: (nx + 1) / 2 * w, y: (1 - ny) / 2 * h, z: zc, on: Math.abs(nx) < 1.05 && Math.abs(ny) < 1.05 };
  }

  return { AC, aircraftAt, trailAt, stateAt, camera, knobs, project, storyT, THR, THR_L, dl, dd, o, F, onRw, onRwL, tower, GS, NM, R31R, R31L, hero, heroAt, dep, depAt, story: ST, M, DT, T_ROLL, PARK, foot, segDist, gap, INSTR, HOLD, greens };
}

// The landing film's world, as a pure function of the frame: the story clock, every aircraft, the camera and the
// shader knobs. Shared by the raea composition (landing.tsx) and the page's tracking export (export-tracks.mjs), so the
// HTML data blocks sit exactly on the aircraft the GPU drew. Scene units are 10 m: x east, z south, y up.

export const W = 1600, H = 900, FPS = 30, N = 480;
const NM = 185.2;           // units per nautical mile
const U = 10;               // metres per unit
const KT = 1.943844;        // knots per m/s
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

// ---------- story chapters (frames) ----------
export const CH = {
  scope: [0, 56], field: [56, 130], approach: [130, 205], final: [205, 292], ground: [292, 362], voice: [362, 412], ai: [412, 452], outro: [452, 480],
};

// ---------- the story clock: seconds of sim time at a frame (slow motion through the flare) ----------
const speedAt = (f) => {
  // seconds of story per frame
  const base = 1.15;
  const slow = smoother(198, 228, f) * (1 - smoother(268, 300, f));
  return lerp(base, 0.36, slow);
};
const T_TABLE = (() => { const t = new Float64Array(N * 10 + 11); let acc = 0; for (let i = 1; i < t.length; i++) { acc += speedAt((i - 0.5) / 10) / 10; t[i] = acc; } return t; })();
export const storyT = (f) => { const x = clamp(f, 0, N) * 10; const i = Math.floor(x); const k = x - i; return T_TABLE[i] + (T_TABLE[Math.min(i + 1, T_TABLE.length - 1)] - T_TABLE[i]) * k; };

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
function leg(points, speed, alt, opts = {}) {
  const P = resample(fillet(points), opts.step || 2);
  const L = P[P.length - 1].s;
  // time to each sample
  const t = new Float64Array(P.length);
  for (let i = 1; i < P.length; i++) { const ds = (P[i].s - P[i - 1].s) * U; const v = Math.max(0.6, speed((P[i].s + P[i - 1].s) / 2, L)); t[i] = t[i - 1] + ds / v; }
  return { P, L, t, dur: t[P.length - 1], speed, alt, reverse: !!opts.reverse, hold: opts.hold || 0, pitch: opts.pitch, gear: opts.gear };
}
function sAtTime(lg, tt) {
  const t = lg.t; if (tt <= 0) return 0; if (tt >= lg.dur) return lg.L;
  let lo = 0, hi = t.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] < tt) lo = m; else hi = m; }
  const k = (tt - t[lo]) / (t[hi] - t[lo] || 1); return lg.P[lo].s + (lg.P[hi].s - lg.P[lo].s) * k;
}

// ---------- the world ----------
export function makeScene(J) {
  const rw = Object.fromEntries(J.runways.map((r) => [r.ref, r]));
  const R31R = rw['13L/31R'], R31L = rw['13R/31L'];
  const THR = { x: R31R.b[0], z: R31R.b[1] };                     // 31R threshold (SE end)
  const dl = nrm([R31R.a[0] - R31R.b[0], R31R.a[1] - R31R.b[1]]);  // landing roll direction on 31R
  const o = [-dl[0], -dl[1]];                                      // final course, outward
  const pl = [o[1], -o[0]];                                        // the north-east side of the final
  const F = (d, side = 0, r = 0) => [THR.x + o[0] * d * NM + pl[0] * side * NM, THR.z + o[1] * d * NM + pl[1] * side * NM, r];
  const onRw = (d, r = 0) => [THR.x + dl[0] * d, THR.z + dl[1] * d, r];
  const THR_L = { x: R31L.b[0], z: R31L.b[1] };
  const dd = nrm([R31L.a[0] - R31L.b[0], R31L.a[1] - R31L.b[1]]);   // 31L take-off direction
  const onRwL = (d, r = 0) => [THR_L.x + dd[0] * d, THR_L.z + dd[1] * d, r];
  const ddl = [dd[1], -dd[0]];                                     // left of the 31L departure (south-west)
  const GS = Math.tan((3 * Math.PI) / 180);
  const tower = { x: J.tower[0], z: J.tower[1] };

  // ---- arrivals: lateral path to the threshold, then the runway, the exit and the taxi route ----
  const exitRw = J.exit.runway_pt, exitNode = J.exit.node;
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

  const TD_HERO = storyT(262);      // the hero's touchdown, in story seconds
  const AC = [];
  const defArr = (id, cs, type, entry, route, tTd, airline) => {
    const lg = arrival(entry, route);
    const sTd = lg.sThr + tdD;
    let tTdLeg = 0; { const t = lg.t; let i = 0; while (i < lg.P.length - 1 && lg.P[i].s < sTd) i++; tTdLeg = t[i]; }
    AC.push({ id, cs, type, kind: 'arr', legs: [lg], t0: tTd - tTdLeg, airline });
  };
  const ar = J.arr_routes;
  defArr('hero', 'DAL220', 'A359', STREAM_S(0), ar[0], TD_HERO, 'Delta');
  defArr('a2', 'JBU623', 'A320', STREAM_N(0), ar[1], TD_HERO + 96, 'JetBlue');
  defArr('a3', 'AAL2', 'B77W', STREAM_S(5), ar[2], TD_HERO + 190, 'American');
  defArr('a4', 'UAE203', 'B77W', STRAIGHT(6), ar[1], TD_HERO + 290, 'Emirates');
  defArr('a5', 'BAW117', 'B77W', STREAM_N(9), ar[2], TD_HERO + 385, 'Speedbird');
  defArr('a0', 'JBU1104', 'A320', STREAM_N(0), ar[2], TD_HERO - 104, 'JetBlue');

  // ---- departures: stand -> pushback -> taxi -> 31L -> take-off -> climb-out (left turn to the south) ----
  const climbPts = (k = 0) => [onRwL(0), onRwL(330), [THR_L.x + dd[0] * 900 + ddl[0] * 40, THR_L.z + dd[1] * 900 + ddl[1] * 40, 600], [THR_L.x + dd[0] * 900 + ddl[0] * 3000, THR_L.z + dd[1] * 900 + ddl[1] * 3000, 900 + k]];
  function departure(id, cs, type, r, tPush, opts = {}) {
    const lead = r.lead; // runway-ward -> stand (stand last)
    const legs = [];
    if (!opts.noPush) {
      const back = [...lead].reverse();                        // stand -> lead start
      legs.push(leg(back.map((p, i) => [p[0], p[1], i ? 2 : 0]), () => 1.6, () => 0, { reverse: true, hold: opts.startHold ?? 35 }));
    }
    const taxi = r.route.map((p, i) => [p[0], p[1], i && i < r.route.length - 1 ? 3 : 0]);
    legs.push(leg(taxi, () => 9.5, () => 0, { hold: opts.lineup ?? 18 }));
    const sLo = 175;
    const air = leg(climbPts(opts.k || 0), (s) => (s < sLo ? Math.max(4, Math.sqrt(2 * 2.1 * s * U)) : Math.min(125, Math.sqrt(2 * 2.1 * sLo * U) + (s - sLo) * 0.06)),
      (s) => (s < sLo ? 0 : Math.min(400, (s - sLo) * 0.13 * smooth(sLo, sLo + 40, s) + Math.max(0, s - sLo - 40) * 0.0)), {});
    air.pitchFn = (s) => (s < sLo - 18 ? 0 : s < sLo + 8 ? lerp(0, 0.16, smooth(sLo - 18, sLo + 8, s)) : 0.14);
    legs.push(air);
    AC.push({ id, cs, type, kind: 'dep', legs, t0: tPush, airline: opts.airline, startOnStand: !opts.noPush });
  }
  const dr = J.dep_routes;
  departure('d1', 'AFR7', 'B77W', dr[1], -318, { airline: 'Air France', lineup: 10 });
  departure('d2', 'DAL400', 'A320', dr[0], storyT(300) - 0, { airline: 'Delta' });
  departure('d3', 'JBU1001', 'A320', dr[3], 30, { airline: 'JetBlue' });
  departure('d4', 'KLM642', 'A359', dr[2], -520, { airline: 'KLM', k: 300 });
  departure('d5', 'UAL1532', 'B738', dr[1], -900, { airline: 'United', k: -300 });

  // story time -> aircraft state
  function stateAt(ac, T) {
    let tt = T - ac.t0;
    if (tt < 0) {
      if (ac.kind === 'dep' && ac.startOnStand) { const lg = ac.legs[0]; const p = lg.P[0]; return pose(ac, lg, 0, p, 0, 0); }
      return null;
    }
    for (let i = 0; i < ac.legs.length; i++) {
      const lg = ac.legs[i];
      if (tt <= lg.dur) { const s = sAtTime(lg, tt); return pose(ac, lg, s, at(lg.P, s), lg.speed(s, lg.L), i); }
      tt -= lg.dur;
      if (tt <= lg.hold) { const s = lg.L; const p = lg.P[lg.P.length - 1]; return pose(ac, lg, s, p, 0, i, true); }
      tt -= lg.hold;
    }
    const lg = ac.legs[ac.legs.length - 1];
    if (ac.kind === 'arr') { const p = lg.P[lg.P.length - 1]; return pose(ac, lg, lg.L, p, 0, 0, true); }
    return null; // departed out of the scene
  }
  function pose(ac, lg, s, p, v, legIdx, holding = false) {
    let hdg = headingAt(lg.P, Math.min(Math.max(s, 3), lg.L - 3), 3);
    if (lg.reverse) hdg += Math.PI;
    const y = lg.alt(s);
    // bank from the turn rate
    const h0 = headingAt(lg.P, s - 12, 6), h1 = headingAt(lg.P, s + 12, 6);
    const dpsi = angDiff(h0, h1) / (24 * U);                // rad per metre
    const bank = y > 3 ? clamp(Math.atan((v * v * dpsi) / 9.81), -0.45, 0.45) : 0;
    const pitch = lg.pitchFn ? lg.pitchFn(s) : 0;
    const vs = y > 0.5 ? (lg.alt(s + 1) - lg.alt(s - 1)) / 2 : 0;
    return { id: ac.id, cs: ac.cs, type: ac.type, kind: ac.kind, x: p.x, y, z: p.z, hdg, pitch, bank, v, kt: Math.round(v * KT), ft: Math.round(y * FT), vs, leg: legIdx, holding, airborne: y > 0.3, airline: ac.airline };
  }
  const aircraftAt = (f) => { const T = storyT(f); return AC.map((ac) => stateAt(ac, T)).filter(Boolean); };
  const trailAt = (ac, f, n = 14, dt = 5) => { const T = storyT(f); const out = []; for (let k = 1; k <= n; k++) { const s = stateAt(ac, T - k * dt); if (s && s.airborne) out.push(s); } return out; };

  // ---------- the camera ----------
  const hero = AC.find((a) => a.id === 'hero');
  const heroAt = (f) => stateAt(hero, storyT(f));
  const KEYS = [
    // frame, eye, target, fov (deg)
    [0, [60, 2650, 330], [62, 0, 318], 46],
    [40, [90, 2350, 300], [86, 0, 270], 44],
    [78, [760, 1250, 1180], [70, 0, -40], 42],
    [112, [820, 520, 760], [20, 0, -120], 40],
    [140, [1350, 330, 330], [600, 80, -20], 38],
  ];
  // Hermite spline through keys (C1, tangents from the neighbours, scaled for uneven spacing)
  function spline(keys, f, idx) {
    if (f <= keys[0][0]) return keys[0][idx];
    if (f >= keys[keys.length - 1][0]) return keys[keys.length - 1][idx];
    let i = 0; while (keys[i + 1][0] < f) i++;
    const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
    const h = k2[0] - k1[0], t = (f - k1[0]) / h;
    // tangent at b from its neighbours, capped by the slower of its two segments (no overshoot between keys far apart)
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
  // the chase: behind, right and above the hero, easing in closer through the flare
  function chase(f) {
    const a = heroAt(f) || heroAt(262);
    const fwd = [Math.sin(a.hdg), 0, -Math.cos(a.hdg)], right = [Math.cos(a.hdg), 0, Math.sin(a.hdg)];
    const k = smooth(205, 255, f);
    const back = lerp(26, 9.5, k), side = lerp(10, 3.2, k), up = lerp(7, 2.0, k);
    const pos = [a.x, a.y, a.z];
    const eye = add(add(add(pos, mul(fwd, -back)), mul(right, side)), [0, up, 0]);
    const tgt = add(pos, add(mul(fwd, lerp(30, 22, k)), [0, lerp(-6, 0.3, k), 0]));
    return { eye, tgt, fov: lerp(46, 52, k) };
  }
  // alongside the approach stream
  function abeam(f) {
    const a = heroAt(f) || heroAt(205);
    const fwd = [Math.sin(a.hdg), 0, -Math.cos(a.hdg)], right = [Math.cos(a.hdg), 0, Math.sin(a.hdg)];
    const k = smooth(140, 205, f);
    const eye = add(add(add([a.x, a.y, a.z], mul(fwd, lerp(-160, -60, k))), mul(right, lerp(210, 70, k))), [0, lerp(70, 22, k), 0]);
    const tgt = add([a.x, a.y, a.z], add(mul(fwd, lerp(260, 120, k)), [0, lerp(-60, -14, k), 0]));
    return { eye, tgt, fov: 40 };
  }
  // the ground and the tower
  const T4 = [tower.x, 0, tower.z];
  const GROUND_KEYS = [
    [292, null, null, 50],
    [312, add(T4, [150, 70, -120]), add(T4, [40, 0, -40]), 46],
    [340, add(T4, [130, 55, 40]), add(T4, [40, 0, 70]), 44],
    [362, add(T4, [46, 18, 34]), add(T4, [-30, 5, -26]), 44],
    [388, add(T4, [-6, 17, 44]), add(T4, [-24, 4, -50]), 44],
    [412, add(T4, [-48, 22, 14]), add(T4, [30, 2, -36]), 44],
    [424, add(T4, [-160, 160, 220]), add(T4, [40, 0, -20]), 46],
    [436, add(T4, [-700, 900, 1200]), add(T4, [120, 0, 100]), 46],
    [458, [40, 2500, 420], [42, 0, 400], 46],
    [480, [40, 2650, 380], [42, 0, 360], 46],
  ];
  const P = (d, side, y) => { const q = F(d, side); return [q[0], y, q[1]]; };
  function camera(f) {
    let eye, tgt, fov;
    if (f <= 112) { eye = spline(KEYS, f, 1); tgt = spline(KEYS, f, 2); fov = spline(KEYS, f, 3); }
    else if (f <= 240) {
      // the approach as a 3D radar: the stream from the south-west side, then a dive in behind the hero
      const keys = [KEYS[3], [140, P(8.0, -5.4, 430), P(5.2, 0.4, 30), 40], [174, P(4.4, -2.2, 175), P(2.2, 0.1, 16), 38], [198, P(1.78, -0.29, 27), P(0.6, 0.0, 6), 36]];
      const base = { eye: spline(keys, Math.min(f, 198), 1), tgt: spline(keys, Math.min(f, 198), 2), fov: spline(keys, Math.min(f, 198), 3) };
      const c = chase(Math.max(f, 205)); const k = smoother(196, 234, f);
      eye = mix3(base.eye, c.eye, k); tgt = mix3(base.tgt, c.tgt, k); fov = lerp(base.fov, c.fov, k);
    }
    else if (f <= 292) { const c = chase(f); eye = c.eye; tgt = c.tgt; fov = c.fov; }
    else {
      const c = chase(292); const keys = GROUND_KEYS.map((k, i) => (i === 0 ? [k[0], c.eye, c.tgt, c.fov] : k));
      eye = spline(keys, f, 1); tgt = spline(keys, f, 2); fov = spline(keys, f, 3);
    }
    return { eye, tgt, fov };
  }

  // ---------- shader knobs ----------
  function knobs(f) {
    return {
      scope: lerp(1, 0.0, smooth(48, 112, f)) + smooth(436, 470, f),
      sweepk: 1 - smooth(48, 92, f) + smooth(440, 470, f),
      reveal: smooth(66, 128, f),
      sweep: (f * 0.105) % (2 * Math.PI),
      course: smooth(20, 60, f) * (1 - smooth(220, 260, f)) + smooth(440, 470, f),
      wave: f >= 362 && f < 412 ? (f - 362) / 50 : -1,
      sectors: smooth(412, 428, f) * (1 - smooth(446, 462, f)),
      city: 0.35 + 0.65 * smooth(60, 120, f),
      rabbit: f,
    };
  }

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

  return { AC, aircraftAt, trailAt, stateAt, camera, knobs, project, storyT, THR, THR_L, dl, dd, o, F, onRw, onRwL, tower, GS, NM, R31R, R31L, hero, heroAt };
}

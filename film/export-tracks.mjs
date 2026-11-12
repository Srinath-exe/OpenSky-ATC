// Per-frame screen positions of the traffic and a few landmarks, projected with the film's own camera, so the
// landing page's data blocks sit on what the GPU drew. Writes tracks.json (positions in film pixels, W x H).
import fs from 'fs';
import { makeScene, N, SUB, W, H, CH } from './scene.js';
import { AIRPORTS } from './airports.js';
const J = JSON.parse(fs.readFileSync(new URL('./jfk.json', import.meta.url)));
const S = makeScene(J);
const APT = AIRPORTS[J.icao || 'KJFK'];
const out = process.argv[2] || 'tracks.json';
const NMU = 185.2;
const ids = S.AC.map((a) => a.id);
const A_ = APT.arrName, D_ = APT.depName;
const PH = [`ILS ${A_}`, 'VECTORS', 'DOWNWIND', 'ROLLOUT', `TAXI STAND ${J.story.hero.stand}`, 'AT GATE', 'PUSHBACK', `TAXI ${D_}`, `LINE UP ${D_}`, `TAKEOFF ${D_}`, 'CLIMB', 'LANDED', `FINAL ${A_}`, 'BASE', 'STARTUP', 'TAXI', 'HOLD POSITION'];
const P = Object.fromEntries(PH.map((p, i) => [p, i]));
const thr = S.THR, o = S.o;
function phase(s) {
  if (s.kind === 'arr') {
    if (s.y > 0.3) {
      const rx = s.x - thr.x, rz = s.z - thr.z; const along = rx * o[0] + rz * o[1]; const across = Math.abs(-rx * o[1] + rz * o[0]);
      if (across < 25 && along < 12 * NMU) return along < 5 * NMU ? P[`FINAL ${A_}`] : P[`ILS ${A_}`];
      return across < 3 * NMU ? P['BASE'] : P['VECTORS'];
    }
    if (s.kt > 25) return P['ROLLOUT'];
    if (s.holding) return P['AT GATE'];
    return s.id === 'hero' ? P[`TAXI STAND ${J.story.hero.stand}`] : P['TAXI'];
  }
  if (s.leg === 0) return s.holding ? (s.s > 1 ? P['STARTUP'] : P['AT GATE']) : P['PUSHBACK'];
  if (s.leg === 1) return s.holding ? (s.id === 'dep' ? P[`LINE UP ${D_}`] : P['HOLD POSITION']) : s.id === 'dep' ? P[`TAXI ${D_}`] : P['TAXI'];
  return s.y > 0.5 ? P['CLIMB'] : P[`TAKEOFF ${D_}`];
}
const KX = 111320 * Math.cos((J.lat0 * Math.PI) / 180), KY = 110574;
const toU = (lat, lon) => [((lon - J.lon0) * KX) / 10, (-(lat - J.lat0) * KY) / 10];
const ANCH = [
  ['ARR', [thr.x, 0, thr.z]],
  ['DEP', [S.THR_L.x, 0, S.THR_L.z]],
  ['TWR', [S.tower.x, 11.5, S.tower.z]],
  ['CITY', (() => { const q = toU(APT.cityAt[0], APT.cityAt[1]); return [q[0], 30, q[1]]; })()],
  ['JFK', [0, 0, 0]],
  ['5NM', [926 * Math.sin(-2.2), 0, -926 * Math.cos(-2.2)]],
  ['13NM', [2408 * Math.sin(-2.5), 0, -2408 * Math.cos(-2.5)]],
  ['10NM', [S.F(10)[0], 0, S.F(10)[1]]],
  // the glidepath gates' distances
  ...[4, 3, 2, 1].map((d) => [`G${d}`, [S.THR.x + S.o[0] * d * NMU, d * NMU * S.GS + 1.5 + 2.8, S.THR.z + S.o[1] * d * NMU]]),
  // the taxiway names along the two routes, a little way into each stretch
  ...J.story.hero.names.map(([n, p]) => [`H:${n}`, [p[0], 0, p[1]]]),
  ...J.story.dep.names.map(([n, p]) => [`D:${n}`, [p[0], 0, p[1]]]),
];
const r1 = (v) => Math.round(v * 10) / 10;
const frames = [], anchors = [], cam = [], tsec = [], spacing = [], ip = [];
for (let i = 0; i < N * SUB; i++) {
  const f = i / SUB;
  const c = S.camera(f);
  const row = [];
  for (const s of S.aircraftAt(f)) {
    const p = S.project(c, [s.x, s.y + 0.6, s.z]);
    if (!p || !p.on) continue;
    const d = Math.hypot(c.eye[0] - s.x, c.eye[1] - s.y, c.eye[2] - s.z);
    const px = (({ A320: 3.76, B738: 3.95, B77W: 7.39, A359: 6.68, A388: 7.27, B744: 7.07 })[s.type] / d) / ((c.fov * Math.PI) / 180) * H;
    row.push([ids.indexOf(s.id), r1(p.x), r1(p.y), s.ft, s.kt, phase(s), Math.round(px)]);
  }
  frames.push(row);
  anchors.push(ANCH.map(([, q]) => { const p = S.project(c, q); return p && p.on ? [r1(p.x), r1(p.y)] : 0; }));
  cam.push(Math.round(c.eye[1] * 32.8084));
  tsec.push(Math.round(S.storyT(f) * 10) / 10);
  const a = S.aircraftAt(f); const h = a.find((x) => x.id === 'hero'), b = a.find((x) => x.id === 'a2');
  spacing.push(h && b && h.y > 0.3 ? Math.round((Math.hypot(h.x - b.x, h.z - b.z) / NMU) * 10) / 10 : 0);
  // how far along its cleared route each instructed aircraft is (route units), -1 when it isn't on the ground
  ip.push(S.INSTR.map((I) => { const q = S.stateAt(I.ac, S.storyT(f)); return q && q.y < 0.3 ? r1(I.sOf([q.x, q.z])) : -1; }));
}
const doc = { w: W, h: H, n: N * SUB, sub: SUB, icao: J.icao, arrName: A_, depName: D_, cityLabel: APT.cityLabel, ch: CH, phases: PH, anchors: ANCH.map((a) => a[0]),
  ac: S.AC.map((a) => ({ id: a.id, cs: a.cs, type: a.type, kind: a.kind, airline: a.airline })), f: frames, an: anchors, cam, t: tsec, sp: spacing,
  instr: S.INSTR.map((I) => ({ who: I.who, cs: I.ac.cs, words: I.words.map((w) => ({ w: w.w, f: Math.round(w.f * 100) / 100, twy: !!w.twy })), segs: I.segs.map((g) => ({ name: g.name, s0: r1(g.s0), s1: r1(g.s1), f: Math.round(g.f * 100) / 100 })), L: r1(I.L) })), ip };
fs.writeFileSync(out, JSON.stringify(doc));
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0), 'KB');

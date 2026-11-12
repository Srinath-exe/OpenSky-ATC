// Per-frame screen positions of the traffic and a few landmarks, projected with the film's own camera, so the
// landing page's data blocks sit on what the GPU drew. Writes tracks.json (positions in 1600x900 film pixels).
import fs from 'fs';
import { makeScene, N, W, H, CH } from './scene.js';
const J = JSON.parse(fs.readFileSync(new URL('./jfk.json', import.meta.url)));
const S = makeScene(J);
const out = process.argv[2] || 'tracks.json';
const NMU = 185.2;
const ids = S.AC.map((a) => a.id);
const PH = ['ILS 31R', 'VECTORS', 'DOWNWIND', 'ROLLOUT', 'TAXI TO GATE', 'AT GATE', 'PUSHBACK', 'TAXI 31L', 'HOLD SHORT 31L', 'TAKEOFF 31L', 'CLIMB', 'LANDED', 'FINAL 31R', 'BASE'];
const P = Object.fromEntries(PH.map((p, i) => [p, i]));
const thr = S.THR, o = S.o;
function phase(s) {
  if (s.kind === 'arr') {
    if (s.y > 0.3) {
      const rx = s.x - thr.x, rz = s.z - thr.z; const along = rx * o[0] + rz * o[1]; const across = Math.abs(-rx * o[1] + rz * o[0]);
      if (across < 25 && along < 12 * NMU) return along < 5 * NMU ? P['FINAL 31R'] : P['ILS 31R'];
      return across < 3 * NMU ? P['BASE'] : P['VECTORS'];
    }
    if (s.kt > 25) return P['ROLLOUT'];
    return s.holding ? P['AT GATE'] : P['TAXI TO GATE'];
  }
  if (s.leg === 0) return s.holding || s.kt === 0 ? (s.kt === 0 && !s.holding ? P['AT GATE'] : P['PUSHBACK']) : P['PUSHBACK'];
  if (s.leg === 1) return s.holding ? P['HOLD SHORT 31L'] : P['TAXI 31L'];
  return s.y > 0.5 ? P['CLIMB'] : P['TAKEOFF 31L'];
}
const KX = 111320 * Math.cos((J.lat0 * Math.PI) / 180), KY = 110574;
const toU = (lat, lon) => [((lon - J.lon0) * KX) / 10, (-(lat - J.lat0) * KY) / 10];
const ANCH = [
  ['31R', [thr.x, 0, thr.z]],
  ['31L', [S.THR_L.x, 0, S.THR_L.z]],
  ['TWR', [S.tower.x, 11.5, S.tower.z]],
  ['MANHATTAN', (() => { const q = toU(40.7549, -73.984); return [q[0], 30, q[1]]; })()],
  ['JFK', [0, 0, 0]],
  ['5NM', [926 * Math.sin(-2.2), 0, -926 * Math.cos(-2.2)]],
  ['13NM', [2408 * Math.sin(-2.5), 0, -2408 * Math.cos(-2.5)]],
  ['10NM', [S.F(10)[0], 0, S.F(10)[1]]],
];
const r1 = (v) => Math.round(v * 10) / 10;
const frames = [], anchors = [], cam = [], tsec = [], spacing = [];
for (let f = 0; f < N; f++) {
  const c = S.camera(f);
  const row = [];
  for (const s of S.aircraftAt(f)) {
    const p = S.project(c, [s.x, s.y + 0.6, s.z]);
    if (!p || !p.on) continue;
    const d = Math.hypot(c.eye[0] - s.x, c.eye[1] - s.y, c.eye[2] - s.z);
    const px = (({ A320: 3.76, B738: 3.95, B77W: 7.39, A359: 6.68 })[s.type] / d) / ((c.fov * Math.PI) / 180) * H;
    row.push([ids.indexOf(s.id), r1(p.x), r1(p.y), s.ft, s.kt, phase(s), Math.round(px)]);
  }
  frames.push(row);
  anchors.push(ANCH.map(([, q]) => { const p = S.project(c, q); return p && p.on ? [r1(p.x), r1(p.y)] : 0; }));
  cam.push(Math.round(c.eye[1] * 32.8084));
  tsec.push(Math.round(S.storyT(f) * 10) / 10);
  const a = S.aircraftAt(f); const h = a.find((x) => x.id === 'hero'), b = a.find((x) => x.id === 'a2');
  spacing.push(h && b && h.y > 0.3 ? Math.round((Math.hypot(h.x - b.x, h.z - b.z) / NMU) * 10) / 10 : 0);
}
const doc = { w: W, h: H, n: N, ch: CH, phases: PH, anchors: ANCH.map((a) => a[0]),
  ac: S.AC.map((a) => ({ id: a.id, cs: a.cs, type: a.type, kind: a.kind, airline: a.airline })), f: frames, an: anchors, cam, t: tsec, sp: spacing };
fs.writeFileSync(out, JSON.stringify(doc));
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0), 'KB');

// Ground conflicts over one loop: moving aircraft against each other and against the parked fleet.
// usage: node check.mjs [jfk.json]   (run from film/ with the work dir's jfk.json)
import fs from 'fs';
import { makeScene, N } from './scene.js';
const J = JSON.parse(fs.readFileSync(process.argv[2] || 'out/sfo/jfk.json'));
const S = makeScene(J);
const { foot, segDist } = S;
const ground = (s) => s && s.y < 0.3;
const hits = new Map();
const note = (k, f, d) => { const h = hits.get(k) || { f0: f, f1: f, d: 1e9 }; h.f1 = f; h.d = Math.min(h.d, d); hits.set(k, h); };
for (let f = 0; f <= N; f += 0.25) {
  const ac = S.aircraftAt(f).filter(ground);
  for (let i = 0; i < ac.length; i++) for (let j = i + 1; j < ac.length; j++) {
    const a = ac[i], b = ac[j];
    if (Math.hypot(a.x - b.x, a.z - b.z) > 16) continue;
    const d = Math.min(...foot(a).flatMap((p) => foot(b).map((q) => segDist(p, q))));
    if (d < 0.3) note(`${a.id}/${b.id}`, f, d);
  }
  for (const a of ac) for (const p of S.PARK) {
    if (Math.hypot(a.x - p.x, a.z - p.z) > 16) continue;
    const d = Math.min(...foot(a).flatMap((s) => foot(p).map((q) => segDist(s, q))));
    if (d < 0.3) note(`${a.id}/park:${p.stand}`, f, d);
  }
}
for (const [k, h] of hits) console.log(k.padEnd(28), 'frames', h.f0, '-', h.f1, 'min gap', h.d.toFixed(2), 'u');
console.log(hits.size ? `${hits.size} conflicts` : 'no conflicts', '| parked', S.PARK.length);

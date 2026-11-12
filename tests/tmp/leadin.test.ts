import test from 'node:test';
import fs from 'fs';
import { makeEngine } from '../engine/helpers';
import { meters } from '../../src/lib/osmAirport';
// Every stand: pushback paths facing each way, a taxi-in from the runway, and their tightest turn radius.
function minRadius(pts: { x: number; y: number }[], span = 6): { r: number; turn: number } {
  let r = Infinity; let turn = 0;
  for (let i = span; i < pts.length - span; i++) {
    const a = pts[i - span], b = pts[i], c = pts[i + span];
    const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y), ca = Math.hypot(a.x - c.x, a.y - c.y);
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2; if (area < 1e-6) continue;
    const R = (ab * bc * ca) / (4 * area); if (R < r) r = R;
  }
  for (let i = 1; i < pts.length - 1; i++) { const h0 = Math.atan2(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y), h1 = Math.atan2(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); let d = Math.abs(h1 - h0) * 180 / Math.PI; if (d > 180) d = 360 - d; turn += d; }
  return { r, turn };
}
test('stand paths', () => {
  const icao = process.env.ICAO ?? 'KSFO';
  const e = makeEngine(icao, { ends: ['28L', '28R'] } as never); const E = e as any; const air = e.air; const pr = E.proj;
  const xy = (p: { lat: number; lng: number }) => { const q = pr.toXY(p.lat, p.lng); return [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]; };
  const edges: unknown[] = [];
  for (const n of air.nodes.values()) for (const ed of n.edges) { if (n.id >= ed.to) continue; const m = air.nodes.get(ed.to)!; edges.push({ a: xy(n), b: xy(m), type: ed.type, leadIn: !!ed.leadIn, twy: ed.taxiway ?? null }); }
  const out: any[] = []; const bad: string[] = []; let canon = 0, nPush = 0, nIn = 0; const radii: number[] = [];
  for (const st of air.stands) {
    const row: any = { ref: st.ref, p: xy(st), hdg: st.headingIn, pts: st.leadInPts.map(xy), type: st.type, size: st.size };
    if (st.leadInPts.length === 2) canon++;
    const leadM = meters(st.leadInPts[0].lng, st.leadInPts[0].lat, st.lng, st.lat);
    e.clear();
    const a = e.spawnAt({ callsign: 'TST1', type: 'B738', kind: 'departure', phase: 'parked', runway: '28L', onFrequency: 'ground', gate: st.ref } as never);
    const notes: string[] = [];
    for (const [key, dir] of [['path_l', 'any'], ['path_r', 'N'], ['path_s', 'S'], ['path_e', 'E'], ['path_w', 'W']] as const) {
      const p = E.pushbackPath(a, dir); if (!p) { if (dir === 'any') notes.push('NO PUSH PATH'); continue; }
      if (key === 'path_l' || key === 'path_r') row[key] = p.pts.filter((_: unknown, i: number) => i % 2 === 0).map((q: any) => [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]);
      const m = minRadius(p.pts); if (dir === 'any') { nPush++; radii.push(m.r); }
      if (m.r < 14) notes.push(`push ${dir} R ${m.r.toFixed(0)}`); if (m.turn > 200) notes.push(`push ${dir} turns ${m.turn.toFixed(0)}`);
    }
    // taxi-in: an arrival on the ground at the far end of 28L, routed to this stand
    e.clear();
    const b = e.spawnAt({ callsign: 'TST2', type: 'B738', kind: 'arrival', phase: 'taxi', taxiwayNode: air.runways[0].ends[0].nodeId, onFrequency: 'ground' } as never);
    const plan = E.planTaxi(b, { kind: 'stand', ref: st.ref }, []);
    if ('code' in plan) notes.push(`NO TAXI-IN (${plan.reason})`);
    else { nIn++; const tail = plan.path.pts.slice(-Math.round((leadM + 80) / 2)); row.path_in = tail.map((q: any) => [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]); const m = minRadius(tail); if (m.r < 14) notes.push(`in R ${m.r.toFixed(0)}`); if (m.turn > 200) notes.push(`in turns ${m.turn.toFixed(0)}`); const end = tail[tail.length - 1]; const sp = pr.toXY(st.lat, st.lng); if (Math.hypot(end.x - sp.x, end.y - sp.y) > 1) notes.push('in ends off the stop'); }
    if (leadM > 200) notes.push(`lead ${leadM.toFixed(0)} m`);
    if (notes.length) bad.push(`${st.ref.padEnd(6)} ${st.type.padEnd(6)} ${notes.join('; ')}`);
    out.push(row);
  }
  const terminals = air.buildings.filter((b: any) => b.kind === 'terminal').map((b: any) => b.polygon.map(xy));
  fs.writeFileSync(process.env.OUT ?? '/tmp/claude-0/-root-atc/1c29601f-c5ea-405d-9c01-805c701fe12b/scratchpad/air.json', JSON.stringify({ edges, stands: out, terminals }));
  radii.sort((x, y) => x - y);
  console.log(`${icao}: stands ${air.stands.length}, straight lead-ins ${canon}, push paths ${nPush}, taxi-in paths ${nIn}, push min radius p5 ${radii[Math.floor(radii.length * 0.05)]?.toFixed(0)} median ${radii[radii.length >> 1]?.toFixed(0)}`);
  console.log(bad.join('\n'));
});

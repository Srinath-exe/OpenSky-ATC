// A taxi route that starts behind the nose (a push into a dead end, no forward way out): the path opens with a turn
// round on an arc instead of a reversal on the spot (the aircraft used to pivot on its nose wheel).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from './helpers';

type XY = { x: number; y: number };
const hdg = (a: XY, b: XY) => (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
const delta = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);
/** Sharpest heading change of the polyline within any 15 m of it (deg). */
function sharpest(pts: XY[]): number {
  let worst = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    let run = 0;
    for (let j = i + 1; j < pts.length && run < 15; j++) { run += Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y); worst = Math.max(worst, delta(hdg(pts[i - 1], pts[i]), hdg(pts[j - 1], pts[j]))); }
  }
  return worst;
}

test('taxi path starting behind the nose: a U-turn arc, no reversal on the spot', () => {
  const e = makeEngine('KJFK', { seed: 1, pilotDelay: null, emergencies: 'off' } as never);
  const E = e as unknown as { nodeXY(id: string): XY; air: { nodes: Map<string, { edges: { to: string; taxiway?: string }[] }> }; pathFromNodes(ids: string[], holdAtEnd?: boolean, from?: XY, turn?: { heading: number; radiusM: number }): { pts: XY[] } | null };
  // a straight run of taxiway nodes, the aircraft standing on the first one with its nose pointing away from the second
  const [start, n] = [...E.air.nodes.entries()].find(([id, v]) => v.edges.length === 2 && v.edges.every(x => x.taxiway) && Math.hypot(E.nodeXY(v.edges[0].to).x - E.nodeXY(id).x, E.nodeXY(v.edges[0].to).y - E.nodeXY(id).y) > 60)!;
  const ids = [start, n.edges[0].to];
  const s = E.nodeXY(start), t = E.nodeXY(ids[1]);
  const away = (hdg(s, t) + 180) % 360;                                       // nose pointing away from the route
  const first = (p: { pts: XY[] }) => { const q = p.pts.find(x => Math.hypot(x.x - s.x, x.y - s.y) > 3)!; return hdg(s, q); };
  const plain = E.pathFromNodes(ids, false, s)!;
  const turned = E.pathFromNodes(ids, false, s, { heading: away, radiusM: 30 })!;
  assert.ok(delta(away, first(plain)) > 150, `without the turn the route starts behind the nose (${delta(away, first(plain)).toFixed(0)} deg off)`);
  assert.ok(delta(away, first(turned)) < 35, `with it the path starts along the nose (${delta(away, first(turned)).toFixed(0)} deg off)`);
  assert.ok(sharpest(turned.pts) <= 60, `and turns gradually: the sharpest change within 15 m is ${sharpest(turned.pts).toFixed(0)} deg`);
});

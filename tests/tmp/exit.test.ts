import test from 'node:test';
import { makeEngine } from '../engine/helpers';
import { profileOf } from '../../src/lib/sim/airlines';
import { preferredEnds } from '../../src/lib/sim/weather';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { rf, chance } from '../../src/lib/sim/rng';
import { alongTrack } from '../../src/lib/sim/projection';
test('exit', () => {
  const ends = preferredEnds(RUNWAY_MANIFEST.YSSY.flatMap(r => r.ends), 160, 10);
  const e = makeEngine('YSSY', { seed: 2, pilotDelay: null, emergencies: 'off', ends } as any);
  e.settings.autoApproach = true; e.settings.autoTower = true; e.settings.autoGround = true; (e.settings as any).arrivalFlow = true; e.playerPosition = 'tower';
  const busy = profileOf('YSSY').busy;
  for (let i = 0; i < 4; i++) e.spawnDeparture(); for (let i = 0; i < 3; i++) e.spawnArrival();
  let next = e.time + rf(50, 100) / busy; const t0 = e.time; let done = false;
  while (e.time - t0 < 940 && !done) {
    if (e.time >= next) { if (e.aircraft.length < 14) { const dep = chance(0.55); const ok = dep ? e.spawnDeparture() : e.spawnArrival(); if (!ok) { if (dep) e.spawnArrival(); else e.spawnDeparture(); } } next = e.time + rf(50, 100) / busy; }
    e.step(15);
    const a = e.find('QFA19');
    if (a && a.phase === 'rollout' && !done) {
      done = true; const E = e as any; const rs = e.runwayState('16L')!; const thr = E.thresholdXY('16L');
      console.log('QFA19', a.perf.icaoCode, 'spd', Math.round(a.speed), 'along', Math.round(alongTrack(a.pos, thr, rs.headingTrue)), 'rwy len?', 'exitPlan', JSON.stringify(E.sc(a).exit ?? null));
      for (const ex of E.runwayExits(rs.ref)) {
        const along = alongTrack(ex.xy, thr, rs.headingTrue); const twy = E.nodeXY(ex.twyNodeId);
        const ang = Math.abs(((Math.atan2(twy.x - ex.xy.x, twy.y - ex.xy.y) * 180 / Math.PI - rs.headingTrue + 540) % 360) - 180);
        console.log('  exit', ex.taxiway, 'along', Math.round(along), 'angle', Math.round(ang), 'blocked strict', E.exitBlocked(a, ex.twyNodeId, ex.xy, rs, ex.runwayNodeId, true), 'loose', E.exitBlocked(a, ex.twyNodeId, ex.xy, rs, ex.runwayNodeId, false));
      }
    }
  }
});

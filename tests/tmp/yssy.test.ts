import test from 'node:test';
import { makeEngine } from '../engine/helpers';
import { profileOf } from '../../src/lib/sim/airlines';
import { preferredEnds } from '../../src/lib/sim/weather';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { rf, chance } from '../../src/lib/sim/rng';
import { locDevDeg, distAlongFwd, crossTrackM } from '../../src/lib/sim/ils';
test('yssy', () => {
  const ends = preferredEnds(RUNWAY_MANIFEST.YSSY.flatMap(r => r.ends), 160, 10);
  const e = makeEngine('YSSY', { seed: 7, pilotDelay: null, emergencies: 'off', ends } as any);
  e.settings.autoApproach = true; e.settings.autoTower = true; e.settings.autoGround = true; e.playerPosition = 'tower';
  const busy = profileOf('YSSY').busy;
  for (let i = 0; i < 4; i++) e.spawnDeparture(); for (let i = 0; i < 3; i++) e.spawnArrival();
  let next = e.time + rf(50, 100) / busy; const t0 = e.time; let last = -1;
  console.log('ends', ends.join(' '));
  while (e.time - t0 < 1500) {
    if (e.time >= next) { if (e.aircraft.length < 14) { const dep = chance(0.55); const ok = dep ? e.spawnDeparture() : e.spawnArrival(); if (!ok) { if (dep) e.spawnArrival(); else e.spawnDeparture(); } } next = e.time + rf(50, 100) / busy; }
    e.step(15);
    if (Math.floor((e.time - t0) / 20) !== last) { last = Math.floor((e.time - t0) / 20);
      if (e.time - t0 > 1080 && e.time - t0 < 1150) { const rs = e.runwayState('16R')!; const x07 = e.runwayState('07')!; console.log(Math.round(e.time - t0), '16R occ', JSON.stringify(rs.occupiedBy), '07 occ', JSON.stringify(x07?.occupiedBy), 'ETD368', (() => { const z = e.find('ETD368'); return z ? `${z.phase} alt${Math.round(z.altitude)} rwy${z.plan.runway} hs${z.holdShortRunway} pos${Math.round(z.pos.x)},${Math.round(z.pos.y)}` : 'gone'; })(), (e.aircraft.filter(x => x.phase === 'rollout' || x.phase === 'lineup' || x.phase === 'takeoff').map(x => `${x.callsign}:${x.phase}:${x.plan.runway}:spd${Math.round(x.speed)}:${Math.round(x.distAlong)}/${Math.round(x.path?.total ?? 0)}`)).join(' ')); }
      if (false) for (const a of e.aircraft) if (a.ilsArmed && !a.ilsCaptured) { const r = (e as any).ilsFor(a.plan.runway!); console.log(Math.round(e.time - t0), a.callsign, a.plan.runway, 'hdg', Math.round(a.heading), 'loc', r.locCourse.toFixed(1), 'rwd', r.rwdHdg.toFixed(1), 'dev', locDevDeg(a.pos, r).toFixed(2), 'along', (distAlongFwd(a.pos, r) / 1852).toFixed(1), 'xt', (crossTrackM(a.pos, r) / 1852).toFixed(2), 'est', r.estimated, 'alt', Math.round(a.altitude)); }
    }
  }
});

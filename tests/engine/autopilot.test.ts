// Autopilot (every position on the AI) under the store's traffic cadence: arrivals are sequenced and landed through
// a trombone pattern, departures climb out, the conflict net keeps the radar minima, nobody diverts, and the AI
// ground breaks taxiway deadlocks with a re-route. Seeded, so the numbers are exact for a given engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, evs } from './helpers';
import { profileOf } from '../../src/lib/sim/airlines';
import { preferredEnds } from '../../src/lib/sim/weather';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { rf, chance } from '../../src/lib/sim/rng';
import type { SimEngine } from '../../src/lib/sim/engine';

// prevailing winds of the home page's airport cards (src/app/_lib/airports.ts - not importable here: it uses the @/ alias)
const WINDS: Record<string, [number, number]> = { EGLL: [240, 10], WSSS: [30, 7], YSSY: [160, 10] };

function soak(icao: string, seed: number, minutes: number, cap = 14): { e: SimEngine; losses: string[]; diversions: string[]; goArounds: string[]; ground: string[] } {
  // the runway ends the home page puts in use for the field's prevailing wind
  const ends = preferredEnds(RUNWAY_MANIFEST[icao].flatMap(r => r.ends), WINDS[icao][0], WINDS[icao][1]);
  const e = makeEngine(icao, { seed, pilotDelay: null, emergencies: 'off', ends });
  e.settings.autoApproach = true; e.settings.autoTower = true; e.settings.autoGround = true; e.playerPosition = 'tower';
  const busy = profileOf(icao).busy;
  for (let i = 0; i < 4; i++) e.spawnDeparture(); for (let i = 0; i < 3; i++) e.spawnArrival();
  let next = e.time + rf(50, 100) / busy;
  const t0 = e.time;
  while (e.time - t0 < minutes * 60) {
    if (e.time >= next) { if (e.aircraft.length < cap) { const dep = chance(0.55); const ok = dep ? e.spawnDeparture() : e.spawnArrival(); if (!ok) { if (dep) e.spawnArrival(); else e.spawnDeparture(); } } next = e.time + rf(50, 100) / busy; }
    e.step(15);
  }
  const msgs = (type: string) => evs(e, type as never).map(x => `${Math.round(x.at)} ${x.message}`);
  return { e, losses: msgs('separation_loss'), diversions: msgs('diversion'), goArounds: msgs('go_around'), ground: msgs('ground_conflict') };
}

for (const [icao, seed, minArr] of [['EGLL', 3, 3], ['WSSS', 7, 3], ['YSSY', 3, 3], ['YSSY', 7, 3]] as const) {
  test(`autopilot soak ${icao} seed ${seed}: 40 minutes of full-auto traffic land arrivals and keep the minima`, () => {
    const r = soak(icao, seed, 40);
    assert.ok(r.e.stats.arrivals >= minArr, `${r.e.stats.arrivals} arrivals landed (want >= ${minArr})`);
    assert.ok(r.e.stats.departures >= 4, `${r.e.stats.departures} departures out`);
    assert.deepEqual(r.diversions, [], 'no diversions');
    assert.ok(r.losses.length <= 1, `separation losses: ${r.losses.join('; ')}`);
    assert.ok(r.goArounds.length <= 1, `go-arounds: ${r.goArounds.join('; ')}`);
    assert.ok(r.ground.length <= 1, `ground conflicts: ${r.ground.join('; ')}`);
    const tx = evs(r.e, 'transmission').map(x => x.message);
    assert.ok(tx.some(m => /^AI APP: .* cleared ILS/.test(m)) && tx.some(m => /^AI TWR: .* cleared to land/.test(m)) && tx.some(m => /^AI GND: .* taxi to runway/.test(m)), 'every AI position worked');
    const stuck = r.e.aircraft.filter(a => !['parked', 'arrived'].includes(a.phase) && a.requests.some(q => q.answeredAt == null && r.e.time - q.at > 180));
    assert.deepEqual(stuck.map(a => `${a.callsign}:${a.requests.map(q => q.kind).join('/')}`), [], 'no request left unanswered for 3 minutes');
  });
}

// Static parked population (airlines.ts profiles, engine.parked): stands filled per the airport profile with the
// carriers and types that belong there, departures wake parked airframes, arrivals retire onto their stand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, byCs } from './helpers';
import { profileOf, sizeFits } from '../../src/lib/sim/airlines';

test('every airport gets a populated apron: sizes fit the stands, carriers follow the profile, no stand is double-booked', () => {
  for (const icao of ['KSFO', 'EGLL', 'OMDB', 'VHHH', 'RJTT', 'YSSY']) {
    const e = makeEngine(icao, {});
    e.populateParked();
    const n = e.parked.length;
    assert.ok(n >= 40 && n <= 180, `${icao}: ${n} parked`);
    const refs = new Set(e.parked.map(p => p.standRef)); assert.equal(refs.size, n, 'one airframe per stand');
    for (const p of e.parked) { const st = e.air.stands.find(s => s.ref === p.standRef)!; assert.ok(sizeFits(p.type, st.size), `${icao} ${p.type} on a size ${st.size} stand ${p.standRef}`); }
    const home = Object.keys(profileOf(icao).carriers);
    const homeShare = e.parked.filter(p => home.includes(p.callsign.slice(0, 3))).length / n;
    assert.ok(homeShare >= 0.5, `${icao}: ${Math.round(homeShare * 100)} % home carriers`);
    // deterministic per seed, and idempotent
    const before = e.parked.map(p => p.callsign).join(','); e.populateParked(); assert.equal(e.parked.map(p => p.callsign).join(','), before);
  }
});

test('departures wake parked airframes (same stand, type and callsign) and free traffic never spawns onto a parked stand', () => {
  const e = makeEngine('OMDB', {});
  e.populateParked();
  const parkedBefore = e.parked.length;
  let woken = 0;
  for (let i = 0; i < 12; i++) {
    const a = e.spawnDeparture(); if (!a) continue;
    const p = e.parked.find(x => x.standRef === a.plan.gateRef); assert.equal(p, undefined, `stand ${a.plan.gateRef} still lists a parked airframe`);
    if (parkedBefore - e.parked.length > woken) { woken = parkedBefore - e.parked.length; }
  }
  assert.ok(woken >= 6, `${woken} of 12 departures came from the parked population`);
  // the fleet is right for the field: Emirates / flydubai dominate Dubai
  const dxb = e.aircraft.filter(a => /^(UAE|FDB)/.test(a.callsign)).length;
  assert.ok(dxb >= 3, `${dxb} of ${e.aircraft.length} departures are home carriers`);
});

test('an arrival that reaches its stand retires into the parked population when it despawns', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  e.populateParked(0.3);
  e.settings.despawnParked = true;
  e.spawnAt({ callsign: 'UAL77', type: 'B738', kind: 'arrival', phase: 'parked', gate: 'F18' } as never);
  const n0 = e.parked.length;
  (e as unknown as { sc(a: unknown): { despawnAt: number | null } }).sc(byCs(e, 'UAL77')).despawnAt = e.time + 5;   // what arriving at the stand schedules (despawnParked)
  runUntil(e, () => !e.aircraft.some(x => x.callsign === 'UAL77'), 60);
  assert.equal(e.aircraft.some(x => x.callsign === 'UAL77'), false, 'the arrival despawned');
  assert.ok(e.parked.some(p => p.standRef === 'F18' && p.type === 'B738' && p.callsign.startsWith('UAL')), 'a United 737 now sits on F18');
  assert.equal(e.parked.length, n0 + 1);
  run(e, 1);
});

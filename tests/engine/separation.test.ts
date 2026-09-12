// Separation and runway protection: air-air minima, reduced minima on parallel
// ILS, air-ground exclusion, wake in trail, runway incursions (aircraft,
// crossings under an arrival, vehicles), ground conflicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, cmd, evs, ledger, ledgerHas, spawnOnFinal, dist, advance, NM_TO_M } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { SCORE_TABLE } from '../../src/lib/sim/types';

test('air-air: 2.5 NM / same altitude is a separation loss scored once; restored by 1000 ft; a new loss re-emits', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const c = e.centerXY;
  const p1 = advance(c, 0, 12 * NM_TO_M), p2 = advance(p1, 90, 2.5 * NM_TO_M);
  const l1 = e.proj.toLngLat(p1.x, p1.y), l2 = e.proj.toLngLat(p2.x, p2.y);
  const a = e.spawnAt({ callsign: 'SEP1', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: l1.lat, lng: l1.lng, altFt: 8000 }, heading: 180, speedKts: 230 });
  const b = e.spawnAt({ callsign: 'SEP2', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: l2.lat, lng: l2.lng, altFt: 8000 }, heading: 180, speedKts: 230 });
  const skill0 = e.stats.skill;
  const evs1 = e.step(1);
  assert.ok(evs1.some(ev => ev.type === 'separation_loss'), 'separation_loss event');
  assert.ok(/SEPARATION LOSS/.test(evs(e, 'separation_loss')[0].message));
  assert.equal(a.conflict, true); assert.equal(b.conflict, true);
  assert.ok(ledgerHas(e, 'SEPARATION_LOSS', 'SEP1'));
  assert.equal(e.stats.skill, Math.max(0, skill0 + SCORE_TABLE.SEPARATION_LOSS.skill));
  run(e, 30);
  assert.equal(ledger(e).filter(c => c === 'SEPARATION_LOSS').length, 1, 'scored once while the loss persists');
  assert.equal(evs(e, 'separation_loss').length, 1);
  // restore vertically
  assert.equal(cmd(e, makeAst('altitude', 'SEP1', { ft: 10000 })).code, 'ok_queued');
  const ok = runUntil(e, () => !a.conflict && !b.conflict, 120);
  assert.ok(ok.ok, 'conflict cleared with 1000 ft');
  assert.ok(Math.abs(a.altitude - b.altitude) >= 1000);
  // new loss later re-emits (pair key cleared) - only after the 60 s dedupe window
  run(e, 60);
  cmd(e, makeAst('altitude', 'SEP1', { ft: 8000 }));
  const again = runUntil(e, () => !!a.conflict, 200);
  assert.ok(again.ok);
  assert.equal(evs(e, 'separation_loss').length, 2);
  assert.equal(ledger(e).filter(c => c === 'SEPARATION_LOSS').length, 2);
});

test('reduced minima: two aircraft established on the parallel ILS 27L / 27R (1.4 km apart) are separated; the same geometry without both established is a loss', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = spawnOnFinal(e, 'PAR1', '27L', 8, { onFrequency: 'approach' });
  const b = spawnOnFinal(e, 'PAR2', '27R', 8, { onFrequency: 'approach' });
  run(e, 3);
  assert.ok(a.ilsCaptured && b.ilsCaptured, 'both established');
  assert.ok(dist(a.pos, b.pos) < 1.0 * NM_TO_M, 'well inside 3 NM');
  assert.equal(e.reducedMinima(a, b), true);
  run(e, 60);
  assert.equal(evs(e, 'separation_loss').length, 0, 'no separation loss on independent parallels');
  assert.ok(!ledgerHas(e, 'SEPARATION_LOSS'));
  assert.equal(a.conflict, false);
  assert.ok(e.parallelRunways('27L').includes('27R'));
  // control: same geometry, neither on an ILS -> loss
  const e2 = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const c = e2.spawnAt({ callsign: 'CTL1', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -8, altFt: 2500 }, speedKts: 170 });
  const d = e2.spawnAt({ callsign: 'CTL2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27R', alongNM: -8, altFt: 2500 }, speedKts: 170 });
  run(e2, 1);
  assert.ok(c.conflict && d.conflict, 'loss without the parallel-ILS exemption');
  assert.ok(ledgerHas(e2, 'SEPARATION_LOSS'));
});

test('air-ground exclusion: an arrival on short final over a lined-up aircraft is never a separation loss (runway protection handles it)', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const d = e.spawnAt({ callsign: 'LUAW1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27L', onFrequency: 'tower' });
  const a = spawnOnFinal(e, 'ARR1', '27L', 1.4, { landingCleared: true });
  run(e, 1);
  assert.ok(dist(a.pos, d.pos) < 3 * NM_TO_M && Math.abs(a.altitude - d.altitude) < 1000, 'within radar minima but one is on the ground');
  run(e, 5);
  assert.equal(evs(e, 'separation_loss').length, 0);
  assert.ok(!ledgerHas(e, 'SEPARATION_LOSS'));
  assert.equal(d.conflict, false);
  const ga = runUntil(e, () => a.phase === 'go_around', 60, 0.2);
  assert.ok(ga.ok, 'runway protection: forced go-around instead');
  assert.ok(ledgerHas(e, 'RWY_INCURSION', 'ARR1'));
  assert.equal(evs(e, 'separation_loss').length, 0);
  // a taxiing aircraft under an overflying departure is not a loss either
  const e2 = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const t = e2.spawnAt({ callsign: 'TAX1', type: 'A320', kind: 'departure', phase: 'taxi', taxiTo: '27R' });
  const p = e2.proj.toLngLat(t.pos.x, t.pos.y);
  e2.spawnAt({ callsign: 'OVR1', type: 'A320', kind: 'departure', phase: 'climb', posLL: { lat: p.lat, lng: p.lng, altFt: 800 }, heading: 270, speedKts: 180, targets: { alt: 5000 } });
  run(e2, 2);
  assert.equal(evs(e2, 'separation_loss').length, 0);
});

test('wake in trail: MEDIUM 3.5 NM behind a HEAVY on the same track is a wake separation loss (5 NM required); 5.5 NM is fine; inside 4 NM on final the follower goes around', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const c = e.centerXY;
  const lead = advance(c, 0, 15 * NM_TO_M), trail = advance(lead, 180, 5.5 * NM_TO_M);
  const l1 = e.proj.toLngLat(lead.x, lead.y), l2 = e.proj.toLngLat(trail.x, trail.y);
  const h = e.spawnAt({ callsign: 'HVY1', type: 'B77W', kind: 'arrival', phase: 'approach', posLL: { lat: l1.lat, lng: l1.lng, altFt: 7000 }, heading: 360, speedKts: 230 });
  const m = e.spawnAt({ callsign: 'MED1', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: l2.lat, lng: l2.lng, altFt: 7000 }, heading: 360, speedKts: 230 });
  assert.equal(e.requiredSepNM(h, m), 5, 'HEAVY -> MEDIUM needs 5 NM');
  assert.equal(e.requiredSepNM(m, h), 5);
  run(e, 1);
  assert.equal(evs(e, 'separation_loss').length, 0, '5.5 NM in trail is fine');
  // move the follower to 3.5 NM behind
  const closer = advance(lead, 180, 3.5 * NM_TO_M); m.pos = { ...closer };
  run(e, 1);
  const w = evs(e, 'separation_loss');
  assert.equal(w.length, 1);
  assert.ok(/WAKE SEPARATION/.test(w[0].message), w[0].message);
  assert.ok(ledgerHas(e, 'WAKE_FINAL', 'MED1'));
  assert.ok(!ledgerHas(e, 'SEPARATION_LOSS'));
  // in-trail geometry requires the same track: abeam / opposite tracks fall back to 3 NM radar minimum
  const x = e.spawnAt({ callsign: 'OPP1', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: l2.lat, lng: l2.lng, altFt: 12000 }, heading: 180, speedKts: 230 });
  assert.equal(e.requiredSepNM(h, x), 3);
  // on final inside the wake minimum by > 1 NM: the follower is sent around
  const e2 = makeEngine('EGLL', { ends: ['27R', '27L'] });
  spawnOnFinal(e2, 'HVY2', '27L', 6.0, { type: 'B77W', landingCleared: true });
  const f = spawnOnFinal(e2, 'MED2', '27L', 9.05, { landingCleared: true });
  run(e2, 3);
  const ga = runUntil(e2, () => f.phase === 'go_around', 30);
  assert.ok(ga.ok, 'wake infringement > 1 NM forces the follower around');
  assert.ok(/wake turbulence/.test(evs(e2, 'go_around', 'MED2')[0].message));
});

test('runway incursion: an aircraft on the strip without a clearance is scored once, raises the alert and a ground_conflict event', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const node = e.runwayByEnd('27L')!.end.nodeId;
  const a = e.spawnAt({ callsign: 'INC1', type: 'A320', kind: 'departure', phase: 'taxi', taxiwayNode: node });
  assert.ok(e.isOnRunway(a), 'placed on the runway strip');
  assert.equal(a.phase, 'taxi');
  const first = e.step(1);
  assert.equal(e.onRunwayWithoutClearance(a.id), e.runwayState('27L')!.ref);
  assert.ok(first.some(ev => ev.type === 'ground_conflict' && /RUNWAY INCURSION/.test(ev.message)));
  assert.ok(ledgerHas(e, 'RWY_INCURSION', 'INC1'));
  assert.ok(e.activeAlerts().some(al => al.kind === 'runway_incursion' && al.subjects.includes('INC1')));
  run(e, 30);
  assert.equal(ledger(e).filter(c => c === 'RWY_INCURSION').length, 1, 'one incident per 60 s (B2 dedupe)');
  // a lined-up aircraft with a clearance is not an incursion
  const b = e.spawnAt({ callsign: 'OK1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27R', onFrequency: 'tower' });
  run(e, 2);
  assert.equal(e.onRunwayWithoutClearance(b.id), null);
  assert.ok(!ledgerHas(e, 'RWY_INCURSION', 'OK1'));
});

test('crossing under an arrival inside 2 NM: the cross executes but is scored RWY_INCURSION; the arrival goes around at 0.7 NM if still crossing', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = e.spawnAt({ callsign: 'UAL8', type: 'A320', kind: 'departure', phase: 'taxi', gate: 'A1', taxiTo: '28L' });
  const h = runUntil(e, () => a.phase === 'hold_short' && a.speed < 0.5, 600);
  assert.ok(h.ok && a.holdShortRunway === '01L');
  // arrival on 1.8 NM final for 01L (the runway being crossed), cleared
  const arr = spawnOnFinal(e, 'SKW9', '01L', 1.8, { type: 'E175', landingCleared: true });
  run(e, 1);
  assert.equal(e.crossingSafe('01L'), false);
  const c = cmd(e, makeAst('cross', 'UAL8', { runway: '01L' }));
  assert.equal(c.code, 'ok_queued', 'executed (trap mechanic)');
  assert.ok(ledgerHas(e, 'RWY_INCURSION', 'UAL8'));
  assert.equal(e.stats.ledger.find(l => l.code === 'RWY_INCURSION')!.secondary, 'SKW9');
  const ga = runUntil(e, () => arr.phase === 'go_around' || arr.phase === 'rollout', 90, 0.2);
  assert.ok(ga.ok);
  if (arr.phase === 'go_around') assert.ok(/crossing/.test(evs(e, 'go_around', 'SKW9')[0].message));
});

test('ground conflict: two taxiing aircraft nose to nose 20 m apart raise ground_conflict once and both carry conflict=true', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'GC1', type: 'A320', kind: 'departure', phase: 'taxi', taxiTo: '27R' });
  const p = advance(a.pos, a.heading, 20);
  const ll = e.proj.toLngLat(p.x, p.y);
  const near = e.nearestNodeId(p, 200)!;
  const b = e.spawnAt({ callsign: 'GC2', type: 'A320', kind: 'departure', phase: 'taxi', taxiwayNode: near });
  b.pos = { ...p }; b.heading = (a.heading + 180) % 360; b.speed = 8; a.speed = 8;
  void ll;
  const first = e.step(1);
  assert.ok(first.some(ev => ev.type === 'ground_conflict'), 'ground_conflict event');
  assert.ok(a.conflict && b.conflict);
  assert.ok(ledgerHas(e, 'GROUND_CONFLICT') || ledgerHas(e, 'COLLISION_GND'));
  run(e, 10);
  assert.equal(evs(e, 'ground_conflict').length, 1, 'emitted once per pair');
});

test('vehicles on the runway count as occupants: takeoff refused, landing clearance alerts, arrival at 1 NM goes around', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const ref = e.runwayState('28L')!.ref;
  const d = e.dispatchVehicle('ops', [], 1, { kind: 'runway', runway: '28L' });
  assert.equal(d.code, 'ok');
  assert.ok(evs(e, 'vehicle').some(ev => /ops/i.test(ev.message)), evs(e, 'vehicle').map(ev => ev.message).join(' | '));
  const v = e.fleet.byId('OPS1')!;
  // the inspection car drives to the runway; every runway crossing on the way is a request the controller grants
  let crossed = 0;
  const hold = runUntil(e, () => {
    if (v.state === 'enroute' && v.holdShortRunway && !v.holdReleased && v.speed < 0.5) { if (e.vehicleOp('OPS1', 'cross', v.holdShortRunway).code === 'ok') crossed++; }
    return v.state === 'onscene';
  }, 600, 2);
  assert.ok(hold.ok, 'ops at the runway holding point');
  run(e, 10);
  assert.equal(e.fleet.onRunway(ref).length, 0, 'does not enter an open runway on its own');
  assert.equal(e.vehicleOp('OPS1', 'cross', '28L').code, 'ok');
  const on = runUntil(e, () => e.fleet.onRunway(ref).length > 0, 120, 2);
  assert.ok(on.ok, 'ops vehicle on the runway');
  assert.equal(e.runwayOccupied('28L'), true);
  assert.ok(e.runwayState('28L')!.occupiedBy.some(o => o.id === v.id && o.kind === 'vehicle'), 'vehicle occupant bookkept');
  const dep = e.spawnAt({ callsign: 'UAL3', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '28L', onFrequency: 'tower' });
  const t = cmd(e, makeAst('takeoff', 'UAL3', { runway: '28L' }));
  assert.equal(t.code, 'runway_occupied');
  assert.ok(/ops/i.test(t.reason ?? ''), t.reason);
  const arr = spawnOnFinal(e, 'DAL4', '28L', 3, { landingCleared: true });
  run(e, 1);
  const ga = runUntil(e, () => arr.phase === 'go_around', 120, 0.2);
  assert.ok(ga.ok, 'vehicle on the runway forces a go-around at 1 NM');
  assert.ok(e.distToThresholdNM(arr, '28L')! <= 1.05);
  assert.ok(ledgerHas(e, 'RWY_INCURSION', 'DAL4'));
  void dep; void crossed;
});

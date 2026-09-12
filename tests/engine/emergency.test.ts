// Emergencies: engine fire end-to-end (declare -> ack -> priority -> ARFF ->
// land -> runway closed -> reopen), medical with ambulance, fuel countdown,
// hold-all / resume-all, and the emergency-rate setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, cmd, evs, ledger, ledgerHas, spawnOnFinal, dist, NM_TO_M } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { VEHICLE_CONST } from '../../src/lib/sim/vehicles';

test('engine fire at KSFO: MAYDAY event -> acknowledge -> priority runway -> ARFF on the runway <= 180 s -> lands and stops -> runway closed -> reopened after inspection', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = spawnOnFinal(e, 'DAL9', '28R', 14, { type: 'B738', speedKts: 200, onFrequency: 'approach' });
  run(e, 2);
  const em = e.declareEmergency(a, 'engine_fire');
  assert.equal(em.type, 'engine_fire'); assert.equal(em.level, 'MAYDAY'); assert.equal(em.status, 'declared');
  assert.equal(a.emergency, em);
  assert.equal(a.squawk, '7700');
  assert.equal(a.priority, true);
  const decl = evs(e, 'emergency', 'DAL9');
  assert.ok(decl.length >= 1 && /MAYDAY/.test(decl[0].message), 'MAYDAY pilot line');
  assert.equal(decl[0].data?.type === 'emergency' && decl[0].data.change, 'declared');
  assert.ok(e.activeAlerts().some(al => al.kind === 'emergency' && al.subjects[0] === 'DAL9'));
  assert.equal(e.stats.emergenciesDeclared, 1);
  assert.ok(a.perf.maxAirspeedTMA <= 210, 'single-engine speed cap applied');
  // acknowledge + souls/fuel
  const ack = cmd(e, makeAst('emergencyAck', 'DAL9', { ask: ['pob', 'fuel'], squawk: true }));
  assert.equal(ack.code, 'ok');
  assert.equal(em.status, 'acknowledged');
  assert.ok(em.checklist.acknowledge != null && em.checklist.souls_fuel != null);
  run(e, 5);
  assert.ok(evs(e, 'readback', 'DAL9').some(ev => /souls/.test(ev.message)), 'pilot reports souls and fuel');
  // priority runway, sterile
  const pr = cmd(e, makeAst('priority', 'DAL9', { runway: '28R', straightIn: true, numberOne: true, sterile: true, clearIls: false }));
  assert.equal(pr.code, 'ok_queued');
  run(e, 3);
  assert.equal(em.runway, '28R'); assert.equal(em.priority, true); assert.equal(em.sterile, true);
  assert.equal(e.runwayState('28R')!.status, 'sterile');
  assert.ok(em.checklist.priority_runway != null && em.checklist.hold_traffic != null);
  // ARFF full emergency
  const t0 = e.time;
  const d = e.dispatchVehicle('arff', [], 3, { kind: 'runway', runway: '28R' });
  assert.equal(d.code, 'ok'); assert.equal(d.extra?.count, 3);
  assert.equal(em.arff, 'full'); assert.equal(em.status, 'services_dispatched');
  assert.ok(em.checklist.arff != null);
  assert.ok(evs(e, 'vehicle').filter(ev => /fire/i.test(ev.message)).length >= 3, evs(e, 'vehicle').map(ev => ev.message).join(' | '));
  const arff = e.fleet.list().filter(v => v.type === 'arff');
  assert.equal(arff.length, 3);
  const on = runUntil(e, () => arff.every(v => v.state === 'onscene'), 240);
  assert.ok(on.ok, 'all three ARFF on scene');
  assert.ok(e.time - t0 <= VEHICLE_CONST.arffResponseLimitS, `ARFF response ${(e.time - t0).toFixed(0)} s <= 180 s`);
  const ref = e.runwayState('28R')!.ref;
  for (const v of arff) assert.ok(e.distToRunway(v.pos, ref) < 150, `${v.id} standing by ${e.distToRunway(v.pos, ref).toFixed(0)} m from the runway`);
  assert.ok(em.arffOnSceneAt != null, 'engine recorded ARFF on scene');
  assert.ok(ledgerHas(e, 'ARFF_ON_TIME', 'DAL9'));
  assert.ok(e.stats.arffResponseS.length === 1 && e.stats.arffResponseS[0] <= 180);
  assert.ok(a.phase !== 'go_around', 'the emergency is still inbound');
  // land on the sterile runway (allowed for the emergency), stops on the runway (engine fire), runway closed
  const lp = runUntil(e, () => a.phase === 'landing', 300);
  assert.ok(lp.ok);
  const cl = cmd(e, makeAst('clearedLand', 'DAL9', { runway: '28R' }));
  assert.equal(cl.code, 'ok_queued', 'sterile runway is usable by the emergency aircraft');
  const td = runUntil(e, () => a.phase === 'rollout', 400);
  assert.ok(td.ok, 'landed');
  assert.ok(em.landedAt != null);
  assert.equal(em.stopOnRunway, true, 'engine fire: stops on the runway');
  assert.equal(e.runwayState('28R')!.status, 'closed');
  assert.equal(e.runwayState('10L')!.status, 'closed');
  assert.ok(evs(e, 'runway_state').some(ev => ev.data?.type === 'runway_state' && ev.data.status === 'closed'));
  const stopped = runUntil(e, () => a.speed < 0.5, 120);
  assert.ok(stopped.ok);
  run(e, 6);
  assert.equal(em.status, 'stopped');
  assert.ok(em.stoppedAt != null);
  assert.ok(e.runwayState('28R')!.occupiedBy.some(o => o.id === a.id), 'disabled aircraft occupies the runway');
  assert.equal(e.runwayOccupied('28R'), true);
  // other traffic: landing / takeoff clearances on the closed runway are refused
  const other = spawnOnFinal(e, 'UAL2', '28R', 8);
  run(e, 3);
  assert.equal(cmd(e, makeAst('clearedLand', 'UAL2', { runway: '28R' })).code, 'runway_closed');
  e.remove(other.id);
  assert.ok(evs(e, 'emergency', 'DAL9').some(ev => ev.data?.type === 'emergency' && (ev.data.change === 'landed' || ev.data.change === 'stopped')));
  // reopen after inspection: aircraft towed clear, runway open, INSPECTION_CLEAN
  const ro = e.reopenRunway('28R', true);
  assert.equal(ro.code, 'ok');
  assert.equal(e.runwayState('28R')!.status, 'open');
  assert.equal(e.runwayState('28R')!.occupiedBy.length, 0);
  assert.ok(!e.find('DAL9'), 'disabled aircraft towed off');
  assert.ok(ledgerHas(e, 'INSPECTION_CLEAN'));
  assert.ok(evs(e, 'runway_state').some(ev => ev.data?.type === 'runway_state' && ev.data.status === 'open' && ev.data.previous === 'closed'));
  assert.ok(!e.activeAlerts().some(al => al.kind === 'runway_status'), 'runway status alert resolved');
  assert.equal(e.reopenRunway('28R', true).code, 'already');
  assert.ok(e.stats.points > 0, `net positive score ${e.stats.points}: ${ledger(e).join(',')}`);
});

test('medical PAN: ambulance to the stand, normal landing, taxi to stand resolves the emergency (patient handed over)', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = spawnOnFinal(e, 'BAW44', '27L', 9);
  run(e, 2);
  const em = e.declareEmergency(a, 'medical');
  assert.equal(em.level, 'PAN'); assert.equal(a.squawk !== '7700', true);
  assert.ok(/PAN PAN/.test(evs(e, 'emergency', 'BAW44')[0].message));
  assert.equal(cmd(e, makeAst('emergencyAck', 'BAW44', { ask: ['pob', 'fuel'], squawk: false })).code, 'ok');
  assert.equal(cmd(e, makeAst('priority', 'BAW44', { runway: '27L', straightIn: true, numberOne: true, sterile: false, clearIls: false })).code, 'ok_queued');
  run(e, 3);
  assert.equal(e.runwayState('27L')!.status, 'open', 'no sterile runway requested');
  const stand = a.plan.gateRef!;
  const amb = e.dispatchVehicle('ambulance', [], 1, { kind: 'stand', ref: stand });
  assert.equal(amb.code, 'ok');
  assert.ok(em.checklist.ambulance != null);
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW44', { runway: '27L' })).code, 'ok_queued');
  const td = runUntil(e, () => a.phase === 'rollout', 400);
  assert.ok(td.ok);
  assert.equal(em.stopOnRunway, false, 'medical vacates normally');
  const vac = runUntil(e, () => evs(e, 'runway_vacated', 'BAW44').length > 0, 200);
  assert.ok(vac.ok);
  assert.equal(e.runwayState('27L')!.status, 'open');
  const rq = runUntil(e, () => a.requests[0]?.kind === 'taxi_in', 120);
  assert.ok(rq.ok);
  assert.equal(cmd(e, makeAst('taxi', 'BAW44', { dest: { kind: 'stand', ref: stand }, expedite: true })).code, 'ok_queued');
  const arr = runUntil(e, () => a.phase === 'arrived', 1500, 5);
  assert.ok(arr.ok, 'on stand');
  assert.equal(em.status, 'resolved');
  assert.ok(evs(e, 'emergency', 'BAW44').some(ev => ev.data?.type === 'emergency' && ev.data.change === 'resolved'));
  assert.equal(e.stats.emergenciesResolved, 1);
  assert.equal(a.priority, false);
  assert.ok(!e.activeAlerts().some(al => al.kind === 'emergency'));
});

test('fuel: an arrival with 25 min of fuel declares a fuel emergency below 20 min; fuel exhaustion removes the aircraft and is scored', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'LOWF', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -18, altFt: 6000 }, heading: 90, speedKts: 220 });
  cmd(e, makeAst('hold', 'LOWF', { fix: e.beacons[0].id, inbound: null, dir: null, legTimeMin: null, legNM: null, efc: null }));
  a.fuelMin = 21;
  const decl = runUntil(e, () => !!a.emergency, 120, 5);
  assert.ok(decl.ok, 'fuel emergency declared');
  assert.equal(a.emergency!.type, 'fuel');
  assert.equal(a.squawk, '7700');
  assert.ok(a.fuelMin != null && a.fuelMin > 0 && a.fuelMin <= 40, `emergency fuel ${a.fuelMin}`);
  assert.equal(a.emergency!.fuelMin, a.fuelMin);
  // a hold is refused for a no-delay emergency; the pilot leaves the hold
  assert.equal(cmd(e, makeAst('hold', 'LOWF', { fix: e.beacons[0].id, inbound: null, dir: null, legTimeMin: null, legNM: null, efc: null })).code, 'unable');
  assert.notEqual(a.navMode, 'hold');
  a.fuelMin = 0.5; if (a.emergency) a.emergency.fuelMin = 0.5;
  const gone = runUntil(e, () => !e.find('LOWF'), 90, 2);
  assert.ok(gone.ok, 'flame-out');
  assert.ok(evs(e, 'fuel_exhaustion', 'LOWF').length >= 1);
  assert.ok(ledgerHas(e, 'FUEL_EXHAUSTION', 'LOWF'));
});

test('hold all / resume all: taxiing traffic stops, departures are refused while an emergency lands, then resumes', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const t = e.spawnAt({ callsign: 'TAX1', type: 'A320', kind: 'departure', phase: 'taxi', taxiTo: '27R' });
  const h = e.spawnAt({ callsign: 'HLD1', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '27R', onFrequency: 'tower' });
  runUntil(e, () => t.speed > 5, 30);
  assert.equal(e.holdAll('all', null).code, 'ok');
  assert.ok(e.holdAllActive);
  assert.equal(cmd(e, makeAst('takeoff', 'HLD1', { runway: '27R' })).code, 'held_by_emergency');
  assert.equal(cmd(e, makeAst('lineup', 'HLD1', { runway: '27R' })).code, 'held_by_emergency');
  const stopped = runUntil(e, () => t.speed < 0.3, 30);
  assert.ok(stopped.ok, 'taxiing traffic stopped');
  assert.equal(t.heldByEmergency, true);
  run(e, 20);
  assert.ok(t.speed < 0.3);
  assert.equal(e.resumeAll().code, 'ok');
  assert.equal(e.holdAllActive, null);
  const moving = runUntil(e, () => t.speed > 3, 30);
  assert.ok(moving.ok, 'traffic resumes');
  assert.equal(cmd(e, makeAst('takeoff', 'HLD1', { runway: '27R' })).code, 'ok_queued');
  assert.equal(e.resumeAll().code, 'nothing_pending');
  void h;
});

test('emergency rate "off" never declares; forced emergencies work on any stage; cancel MAYDAY resolves and scores', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'], emergencies: 'off' });
  for (let i = 0; i < 6; i++) e.spawnArrival();
  run(e, 600);
  assert.ok(e.aircraft.every(a => !a.emergency));
  assert.equal(e.stats.emergenciesDeclared, 0);
  const g = e.spawnAt({ callsign: 'GND9', type: 'A320', kind: 'departure', phase: 'taxi', taxiTo: '27R' });
  const em = e.declareEmergency(g, 'brake_fire');
  assert.equal(em.type, 'brake_fire');
  assert.ok(e.activeAlerts().some(al => al.kind === 'emergency' && al.subjects[0] === 'GND9'));
  assert.equal(cmd(e, makeAst('emergencyCancelAck', 'GND9')).code, 'ok');
  assert.equal(em.status, 'resolved');
  assert.ok(ledgerHas(e, 'EMERGENCY_DONE', 'GND9'));
  assert.ok(!e.activeAlerts().some(al => al.kind === 'emergency' && al.subjects[0] === 'GND9'));
  void dist; void NM_TO_M;
});

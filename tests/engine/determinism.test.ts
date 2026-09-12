// Determinism: two engines built with the same seed and driven by the same
// script produce identical event logs, aircraft states and scores; a different
// seed produces a different traffic sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, cmd } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import type { SimEngine } from '../../src/lib/sim/engine';
import type { SimEvent } from '../../src/lib/sim/types';

/** A 12-minute scripted session: spawns, ground + tower + approach commands, a forced emergency, a wind change. */
function session(seed: number, icao = 'EGLL'): { e: SimEngine; log: SimEvent[] } {
  const e = makeEngine(icao, { seed, ends: icao === 'EGLL' ? ['27R', '27L'] : ['28L', '28R'], pilotDelay: null, emergencies: 'normal', pilotErrorRate: 0.05 });
  const log: SimEvent[] = [];
  const step = (s: number) => log.push(...run(e, s));
  const dep = e.spawnDeparture({ callsign: 'DEP1', type: 'A320' })!;
  const arr1 = e.spawnArrival()!;
  e.spawnArrival(); e.spawnArrival();
  step(30);
  cmd(e, makeAst('pushback', 'DEP1', { dir: 'any', expectRunway: dep.plan.runway ?? null, startup: true }));
  step(200);
  cmd(e, makeAst('taxi', 'DEP1', { dest: { kind: 'runway', runway: dep.plan.runway!, intersection: null } }));
  cmd(e, makeAst('altitude', arr1.callsign, { ft: 4000 }));
  cmd(e, makeAst('heading', arr1.callsign, { hdg: 90 }));
  step(120);
  e.spawnDeparture({ atHold: true, callsign: 'DEP2', type: 'B77W' });
  step(5);
  cmd(e, makeAst('takeoff', 'DEP2', { runway: e.find('DEP2')!.plan.runway!, afterDepHdg: 300, initialAlt: 5000 }));
  step(120);
  const fire = e.spawnAt({ callsign: 'EMG1', type: 'B738', kind: 'arrival', phase: 'approach', posRel: { fromRunway: icao === 'EGLL' ? '27L' : '28R', alongNM: -12, altFt: 3500 }, speedKts: 200, ils: icao === 'EGLL' ? '27L' : '28R' });
  e.declareEmergency(fire, 'engine_fire');
  e.dispatchVehicle('arff', [], 3, { kind: 'runway', runway: fire.plan.runway! });
  step(60);
  e.setWind(120, 14);
  step(180);
  for (let i = 0; i < 3; i++) { e.spawnArrival(); step(5); }
  step(120);
  return { e, log };
}
const key = (ev: SimEvent) => `${ev.at.toFixed(3)}|${ev.type}|${ev.callsign}|${ev.message}`;
const snapshot = (e: SimEngine) => e.aircraft.map(a => `${a.callsign}|${a.perf.icaoCode}|${a.phase}|${a.pos.x.toFixed(3)}|${a.pos.y.toFixed(3)}|${a.heading.toFixed(3)}|${a.speed.toFixed(3)}|${a.altitude.toFixed(3)}|${a.plan.gateRef}|${a.squawk}|${a.requests.map(r => r.kind).join('+')}`).join('\n');

test('two seeded runs of the same 12-minute script produce identical event logs, states, weather, vehicles and scores', () => {
  const A = session(7), B = session(7);
  assert.ok(A.log.length > 150, `events logged: ${A.log.length}`);
  assert.equal(A.log.length, B.log.length);
  for (let i = 0; i < A.log.length; i++) assert.equal(key(A.log[i]), key(B.log[i]), `event ${i}`);
  assert.equal(snapshot(A.e), snapshot(B.e));
  assert.equal(JSON.stringify(A.e.stats.ledger), JSON.stringify(B.e.stats.ledger));
  assert.equal(A.e.stats.points, B.e.stats.points);
  assert.equal(A.e.stats.skill, B.e.stats.skill);
  assert.equal(JSON.stringify(A.e.wx()), JSON.stringify(B.e.wx()));
  assert.equal(A.e.atisLetter(), B.e.atisLetter());
  assert.equal(JSON.stringify(A.e.fleet.list().map(v => [v.id, v.state, v.pos.x.toFixed(2), v.pos.y.toFixed(2)])), JSON.stringify(B.e.fleet.list().map(v => [v.id, v.state, v.pos.x.toFixed(2), v.pos.y.toFixed(2)])));
  assert.equal(JSON.stringify(A.e.runwayStates().map(r => [r.name, r.status, r.occupiedBy.map(o => o.callsign), r.wakeTimer?.leader ?? null])), JSON.stringify(B.e.runwayStates().map(r => [r.name, r.status, r.occupiedBy.map(o => o.callsign), r.wakeTimer?.leader ?? null])));
  assert.equal(A.e.time, B.e.time);
  assert.equal(A.e.events.length, B.e.events.length);
  assert.ok(A.log.some(ev => ev.type === 'emergency') && A.log.some(ev => ev.type === 'vehicle') && A.log.some(ev => ev.type === 'atis'));
});

test('a different seed produces a different traffic sample (callsigns / types / stands), and KSFO is deterministic too', () => {
  const A = session(7), C = session(8);
  const ids = (e: SimEngine) => e.events.filter(ev => ev.type === 'spawn').map(ev => ev.message).join('\n');
  assert.notEqual(ids(A.e), ids(C.e));
  const K1 = session(11, 'KSFO'), K2 = session(11, 'KSFO');
  assert.equal(K1.log.map(key).join('\n'), K2.log.map(key).join('\n'));
  assert.equal(snapshot(K1.e), snapshot(K2.e));
});

test('engine.update() with a real-time dt clamps the backlog (B18) and is equivalent to step() for whole substeps', () => {
  // (the RNG is a process-global stream: build and drive one engine at a time)
  const A = makeEngine('EGLL', { seed: 3, ends: ['27R', '27L'] });
  A.spawnArrival();
  for (let i = 0; i < 300; i++) A.update(1 / 30);
  const B = makeEngine('EGLL', { seed: 3, ends: ['27R', '27L'] });
  B.spawnArrival();
  B.step(300);
  assert.ok(Math.abs(A.time - B.time) < 1e-6);
  assert.equal(snapshot(A), snapshot(B));
  // a 5 s stall is clamped: at most MAX_SUBSTEPS substeps run in one update
  const t0 = A.time;
  A.update(5);
  assert.ok(A.time - t0 <= 6 / 30 + 1e-9, 'backlog clamped');
  A.paused = true;
  const t1 = A.time; A.update(1);
  assert.equal(A.time, t1, 'paused engine does not advance');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMERGENCY_CATALOGUE, buildEmergency, maybeDeclare, onDeclared, stepEmergency, handleLanded, completeChecklistItem, scoreOnResolved,
  scoreChecklistMiss, ackEmergency, assignPriority, servicesDispatched, arffOnScene, resolveEmergency, checklistView, eligibleTypes,
  SOULS_FUEL_DEADLINE_S, type EmergencyEngineView,
} from '../../src/lib/sim/emergencies';
import { setSeed, subStream } from '../../src/lib/sim/rng';
import { ALL_STAGES, type AircraftState, type EmergencyType, type ScoreEvent, type SimEvent, type Stage } from '../../src/lib/sim/types';
import { mkAircraft } from './helpers';

const TYPES: EmergencyType[] = ['engine_fire', 'engine_failure', 'medical', 'fuel', 'depressurization', 'bird_strike', 'gear', 'smoke', 'hydraulic', 'hijack', 'radio_failure', 'general', 'brake_fire'];

function view(aircraft: AircraftState[], stageOf: (a: AircraftState) => Stage = () => 'arr_inbound'): EmergencyEngineView & { events: SimEvent[]; scores: ScoreEvent[]; runwayStatus: Array<{ runway: string; status: string }>; time: number } {
  const v = {
    time: 1000, aircraft, events: [] as SimEvent[], scores: [] as ScoreEvent[], runwayStatus: [] as Array<{ runway: string; status: string }>,
    stageOf,
    bestRunway: () => '27L',
    setRunwayStatus: (runway: string, status: string) => { v.runwayStatus.push({ runway, status }); },
    emit: (ev: SimEvent) => { v.events.push(ev); },
    score: (s: ScoreEvent) => { v.scores.push(s); },
    telephony: (cs: string) => `Speedbird ${cs.replace(/\D/g, '')}`,
  };
  return v;
}

test('catalogue completeness: 13 types, each with lines, checklist, stages, post-landing data', () => {
  assert.equal(Object.keys(EMERGENCY_CATALOGUE).length, 13);
  for (const t of TYPES) {
    const s = EMERGENCY_CATALOGUE[t];
    assert.equal(s.type, t);
    assert.ok(['MAYDAY', 'PAN'].includes(s.level));
    assert.ok(s.weight > 0);
    assert.ok(s.stages.length > 0 && s.stages.every(st => ALL_STAGES.includes(st)), `${t} stages`);
    if (t !== 'radio_failure') { assert.ok(s.pilotLine.includes('{cs}'), `${t} pilot line`); assert.ok(s.ackReply.includes('{cs}'), `${t} ack reply`); }
    assert.ok(s.required.length >= 3, `${t} checklist`);
    assert.ok(s.required[0] === 'acknowledge');
    assert.ok(['none', 'local', 'full'].includes(s.arff));
    assert.ok(s.stopOnRunwayP >= 0 && s.stopOnRunwayP <= 1);
    assert.ok(s.closureMin[0] <= s.closureMin[1]);
    assert.ok(s.perf.maxClimbRateFactor > 0 && s.perf.pilotDelayFactor >= 1);
    if (s.stopOnRunwayP > 0) assert.ok(s.closureMin[1] > 0 || s.type === 'bird_strike', `${t} closure when stopping`);
  }
  // MAYDAY kinds squawk 7700 except the special codes; PAN kinds keep the squawk
  assert.equal(EMERGENCY_CATALOGUE.hijack.squawk, '7500');
  assert.equal(EMERGENCY_CATALOGUE.radio_failure.squawk, '7600');
  assert.equal(EMERGENCY_CATALOGUE.engine_fire.squawk, '7700');
  assert.equal(EMERGENCY_CATALOGUE.medical.squawk, null);
  // every stage that can spawn something has at least one eligible row; ground stages only ground kinds
  for (const st of ['taxi_out', 'taxi_in'] as Stage[]) assert.ok(eligibleTypes(st).every(r => ['medical', 'brake_fire'].includes(r.type)));
  assert.ok(eligibleTypes('parked').length === 0);
});

test('buildEmergency fills souls / fuel / runway and the pilot line', () => {
  setSeed(5);
  const a = mkAircraft({ callsign: 'BAW117', type: 'B738', phase: 'descent' });
  const v = view([a]);
  const e = buildEmergency('engine_fire', a, 'arr_inbound', v, subStream('emerg'));
  assert.equal(e.type, 'engine_fire');
  assert.equal(e.level, 'MAYDAY');
  assert.equal(e.status, 'declared');
  assert.ok(e.soulsOnBoard >= 90 && e.soulsOnBoard <= 189);
  assert.equal(e.fuelMin, null);
  assert.match(e.pilotLine, /^MAYDAY MAYDAY MAYDAY, Speedbird 117, engine fire number two, request immediate return, vectors ILS 27L\.$/);
  assert.ok(e.requests.length >= 1);
  const f = buildEmergency('fuel', a, 'arr_inbound', v, subStream('emerg'));
  assert.ok(f.fuelMin != null && f.fuelMin >= 15 && f.fuelMin <= 40);
  assert.match(f.pilotLine, /MAYDAY FUEL, fuel \d+ minutes/);
});

test('maybeDeclare: never in the first 120 s, respects the concurrency cap, eventually declares an eligible kind', () => {
  setSeed(9);
  const a = mkAircraft({ callsign: 'BAW1', phase: 'descent' });
  const v = view([a]);
  v.time = 60;
  assert.equal(maybeDeclare(a, subStream('x'), v, 'training'), null, 'quiet start');
  v.time = 1000;
  assert.equal(maybeDeclare(a, subStream('x'), v, 'off'), null, 'off');
  // concurrency cap: another aircraft already has an emergency
  const b = mkAircraft({ callsign: 'BAW2', phase: 'descent' });
  b.emergency = buildEmergency('medical', b, 'arr_inbound', v, subStream('y'));
  const v2 = view([a, b]);
  const r = subStream('z');
  let declared = null;
  for (let i = 0; i < 20000 && !declared; i++) declared = maybeDeclare(a, r, v2, 'normal');
  assert.equal(declared, null, 'cap of one in normal mode');
  // with the cap cleared, a training-rate loop declares within a few sim hours
  b.emergency = null;
  const r2 = subStream('w');
  let e = null, n = 0;
  while (!e && n < 60000) { e = maybeDeclare(a, r2, v2, 'training'); n++; }
  assert.ok(e, 'declared eventually');
  assert.ok(EMERGENCY_CATALOGUE[e!.type].stages.includes('arr_inbound'), 'kind eligible for the stage');
  // never while a departure is below 400 ft
  const low = mkAircraft({ callsign: 'LOW', phase: 'climb', altitude: 200, plan: { kind: 'departure', runway: '27R' } });
  const v3 = view([low], () => 'dep_climb');
  let any = null;
  for (let i = 0; i < 30000 && !any; i++) any = maybeDeclare(low, r2, v3, 'training');
  assert.equal(any, null);
});

test('onDeclared applies squawk / priority / perf clone and emits the pilot line; noDelay leaves a hold', () => {
  setSeed(2);
  const a = mkAircraft({ callsign: 'BAW117', phase: 'cruise', navMode: 'hold', holdFixName: 'BIG', speedUntilNM: 4 });
  const v = view([a]);
  const shared = a.perf;
  a.emergency = buildEmergency('engine_fire', a, 'arr_inbound', v, subStream('e'));
  onDeclared(v, a);
  assert.equal(a.squawk, '7700');
  assert.equal(a.priority, true);
  assert.equal(a.navMode, 'heading');
  assert.equal(a.speedUntilNM, null);
  assert.notEqual(a.perf, shared, 'perf cloned');
  assert.equal(shared.maxClimbRate, 2500, 'shared DB entry untouched');
  assert.equal(a.perf.maxClimbRate, 1000);
  assert.equal(a.perf.maxAirspeedTMA, 210);
  assert.equal(v.events.length, 1);
  assert.equal(v.events[0].type, 'emergency');
  assert.equal(v.events[0].who, 'PILOT');
  assert.match(v.events[0].message, /^MAYDAY MAYDAY MAYDAY/);
  // radio failure: silent, NORDO note
  const r = mkAircraft({ callsign: 'DLH1', phase: 'descent' });
  r.emergency = buildEmergency('radio_failure', r, 'arr_inbound', v, subStream('e'));
  onDeclared(v, r);
  assert.equal(r.squawk, '7600');
  assert.match(r.note, /NORDO/);
  assert.equal(v.events[1].who, 'SYS');
});

test('checklist scoring: +25 within 60 s, late items 0, souls/fuel miss after 180 s scores -100 once', () => {
  setSeed(4);
  const a = mkAircraft({ callsign: 'BAW117', phase: 'descent' });
  const v = view([a]);
  a.emergency = buildEmergency('engine_fire', a, 'arr_inbound', v, subStream('e'));
  onDeclared(v, a);
  const s1 = completeChecklistItem(a, 'acknowledge', v.time + 20)!;
  assert.equal(s1.points, 25);
  assert.equal(a.emergency!.status, 'acknowledged');
  assert.equal(completeChecklistItem(a, 'acknowledge', v.time + 25), null, 'already done');
  const s2 = completeChecklistItem(a, 'souls_fuel', v.time + 100)!;
  assert.equal(s2.points, 0, 'late (80 s after the previous item)');
  const s3 = completeChecklistItem(a, 'priority_runway', v.time + 130)!;
  assert.equal(s3.points, 25);
  // miss scoring for a second aircraft that never got the souls/fuel query
  const b = mkAircraft({ callsign: 'BAW2', phase: 'descent' });
  const vb = view([b]);
  b.emergency = buildEmergency('smoke', b, 'arr_inbound', vb, subStream('e'));
  onDeclared(vb, b);
  completeChecklistItem(b, 'acknowledge', vb.time + 5);
  for (let t = 1; t <= SOULS_FUEL_DEADLINE_S + 30; t++) { vb.time = 1000 + t; stepEmergency(vb, b, 1); }
  const misses = vb.scores.filter(s => s.code === 'EMERGENCY_CHECKLIST_MISS');
  assert.equal(misses.length, 1);
  assert.equal(misses[0].points, -100);
  assert.equal(scoreChecklistMiss(b, 'arff', 0).points, -100);
});

test('progress: unacknowledged MAYDAY re-calls every 60 s (max 3); fuel emergency counts down to flame-out', () => {
  setSeed(6);
  const a = mkAircraft({ callsign: 'BAW117', phase: 'descent' });
  const v = view([a]);
  a.emergency = buildEmergency('fuel', a, 'arr_inbound', v, subStream('e'));
  a.emergency.fuelMin = 3;
  onDeclared(v, a);
  const start = v.events.length;
  for (let t = 1; t <= 200; t++) { v.time = 1000 + t; stepEmergency(v, a, 1); }
  const recalls = v.events.slice(start).filter(e => /did you copy/.test(e.message));
  assert.equal(recalls.length, 3);
  assert.ok(v.events.some(e => e.type === 'fuel_exhaustion'), 'flame-out at 0 fuel');
  assert.equal(v.scores.filter(s => s.code === 'FUEL_EXHAUSTION').length, 1);
  assert.equal(a.emergency!.fuelMin, 0);
});

test('handleLanded: engine fire stops on the runway and closes it; medical vacates; resolution scores EMERGENCY_DONE once', () => {
  setSeed(8);
  const a = mkAircraft({ callsign: 'BAW117', phase: 'landing', plan: { kind: 'arrival', runway: '27L' } });
  const v = view([a]);
  a.emergency = buildEmergency('engine_fire', a, 'arr_inbound', v, subStream('e'));
  onDeclared(v, a);
  ackEmergency(a, v.time + 10);
  assignPriority(a, '27L', true, v.time + 20);
  servicesDispatched(a, 'arff', 3, v.time + 30);
  assert.equal(a.emergency!.arff, 'full');
  assert.equal(a.emergency!.status, 'services_dispatched');
  const arff = arffOnScene(a, v.time + 150)!;
  assert.equal(arff.code, 'ARFF_ON_TIME');
  assert.equal(arff.points, 50);
  v.time = 1000 + 600;
  const closure = handleLanded(v, a);
  assert.ok(closure >= 20 && closure <= 40, `closure ${closure}`);
  assert.equal(a.emergency!.stopOnRunway, true);
  assert.equal(a.emergency!.status, 'landed');
  assert.ok(v.runwayStatus.some(r => r.runway === '27L' && r.status === 'closed'));
  // stopping: the aircraft is at rest 5 s later -> status stopped
  a.phase = 'rollout'; a.speed = 0;
  for (let t = 1; t <= 10; t++) { v.time = 1600 + t; stepEmergency(v, a, 1); }
  assert.equal(a.emergency!.status, 'stopped');
  // resolve and score
  resolveEmergency(v, a, 'fire out, request tow');
  assert.equal(a.emergency!.status, 'resolved');
  const done = v.scores.filter(s => s.code === 'EMERGENCY_DONE');
  assert.ok(done.length >= 1);
  const base = done.find(s => /concluded/.test(s.detail))!;
  assert.ok(base.points > 0 && base.points <= 300, `base ${base.points}`);
  assert.ok(done.some(s => /landed within 15 min/.test(s.detail)), 'landed-in-time bonus');
  assert.ok(v.scores.some(s => s.code === 'ARFF_ON_TIME' && s.points === 100), 'ARFF before touchdown bonus');
  assert.deepEqual(scoreOnResolved(a, v.time), [], 'idempotent');
  assert.equal(a.priority, false);
  assert.equal(a.squawk, null);
  // medical: no closure
  const m = mkAircraft({ callsign: 'DLH2', phase: 'landing', plan: { kind: 'arrival', runway: '27R' } });
  const vm = view([m]);
  m.emergency = buildEmergency('medical', m, 'arr_inbound', vm, subStream('e'));
  onDeclared(vm, m);
  assert.equal(handleLanded(vm, m), 0);
  assert.equal(m.emergency!.stopOnRunway, false);
  assert.equal(vm.runwayStatus.length, 0);
  const cv = checklistView(m, vm.time);
  assert.ok(cv.some(c => c.item === 'ambulance' && c.required));
});

test('every type runs declaration -> landing -> resolution without throwing', () => {
  setSeed(12);
  for (const t of TYPES) {
    const a = mkAircraft({ callsign: 'BAW117', type: 'A320', phase: t === 'brake_fire' ? 'taxi' : 'descent', plan: { kind: 'arrival', runway: '27L' } });
    const v = view([a], () => (t === 'brake_fire' ? 'taxi_in' : 'arr_inbound'));
    a.emergency = buildEmergency(t, a, v.stageOf(a), v, subStream(t));
    onDeclared(v, a);
    for (const item of EMERGENCY_CATALOGUE[t].required) completeChecklistItem(a, item, v.time + 10);
    for (let s = 1; s <= 120; s++) { v.time = 1000 + s; stepEmergency(v, a, 1); }
    if (t !== 'brake_fire') { v.time = 1500; handleLanded(v, a); a.phase = 'rollout'; a.speed = 0; for (let s = 1; s <= 10; s++) { v.time = 1500 + s; stepEmergency(v, a, 1); } }
    resolveEmergency(v, a, 'done');
    assert.equal(a.emergency!.status, 'resolved', t);
    assert.ok(v.scores.some(s => s.code === 'EMERGENCY_DONE' && /concluded/.test(s.detail)), `${t} scored`);
    const base = v.scores.find(s => s.code === 'EMERGENCY_DONE' && /concluded/.test(s.detail))!;
    assert.equal(base.points, 300, `${t} full checklist -> full base points`);
  }
});

test('automatic stand-down 10 min after a safe stop', () => {
  setSeed(13);
  const a = mkAircraft({ callsign: 'BAW117', phase: 'landing', plan: { kind: 'arrival', runway: '27L' } });
  const v = view([a]);
  a.emergency = buildEmergency('hydraulic', a, 'arr_inbound', v, subStream('e'));
  onDeclared(v, a);
  handleLanded(v, a);
  a.phase = 'rollout'; a.speed = 0;
  let resolvedAt: number | null = null;
  for (let s = 1; s <= 1400 && resolvedAt == null; s++) { v.time = 1000 + s; stepEmergency(v, a, 1); if (a.emergency!.status === 'resolved') resolvedAt = v.time; }
  assert.ok(resolvedAt != null && resolvedAt - a.emergency!.stoppedAt! >= 600 && resolvedAt - a.emergency!.stoppedAt! < 620, `resolved at ${resolvedAt}`);
  assert.ok(v.events.some(e => e.data?.type === 'emergency' && e.data.change === 'resolved'));
});

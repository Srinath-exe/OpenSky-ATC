import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine, ALERT_CONST, cpa, timeToInfringement, type AlertStepCtx } from '../../src/lib/sim/alerts';
import { NM_TO_M } from '../../src/lib/sim/projection';
import { WAKE_FINAL_NM } from '../../src/lib/sim/types';
import type { AircraftState, Vehicle } from '../../src/lib/sim/types';
import type { XY } from '../../src/lib/sim/projection';
import { mkAircraft, mkRunway } from './helpers';

const KT = 0.514444;

function ctxFor(time: number, over: Partial<AlertStepCtx> = {}): AlertStepCtx {
  return {
    time,
    requiredSepNM: () => 3,
    reducedMinima: () => false,
    msaAt: () => null,
    onRunwayWithoutClearance: () => null,
    arrivalOnFinal: () => null,
    rollingDeparture: () => null,
    wakeTimerRemainingS: () => 0,
    ...over,
  };
}

test('cpa: head-on pair at 10 NM closing at 400 kt meets in ~90 s, CPA 0 NM', () => {
  const a = { pos: { x: 0, y: 0 }, heading: 90, speedKt: 200, altFt: 5000, vsFpm: 0 };
  const b = { pos: { x: 10 * NM_TO_M, y: 0 }, heading: 270, speedKt: 200, altFt: 5000, vsFpm: 0 };
  const r = cpa(a, b, 300);
  const expected = 10 * NM_TO_M / (400 * KT);
  assert.ok(Math.abs(r.tS - expected) < 1, `t=${r.tS} expected ${expected}`);
  assert.ok(r.distNM < 0.01);
  assert.equal(Math.round(r.nowNM), 10);
  assert.equal(r.vertFt, 0);
});

test('cpa: diverging pair reports t=0 and current distance', () => {
  const a = { pos: { x: 0, y: 0 }, heading: 270, speedKt: 200, altFt: 5000, vsFpm: 0 };
  const b = { pos: { x: 5 * NM_TO_M, y: 0 }, heading: 90, speedKt: 200, altFt: 5000, vsFpm: 0 };
  const r = cpa(a, b);
  assert.equal(r.tS, 0);
  assert.ok(Math.abs(r.distNM - 5) < 0.01);
});

test('cpa: vertical rates are extrapolated (climber vs level)', () => {
  const a = { pos: { x: 0, y: 0 }, heading: 90, speedKt: 200, altFt: 3000, vsFpm: 2000 };
  const b = { pos: { x: 6 * NM_TO_M, y: 0 }, heading: 270, speedKt: 200, altFt: 5000, vsFpm: 0 };
  const r = cpa(a, b, 120);
  // 54 s to CPA -> climber gains 1800 ft -> 200 ft apart
  assert.ok(r.vertFt < 300 && r.vertFt > 100, `vert=${r.vertFt}`);
});

test('cpa: crossing tracks at 90 degrees, CPA is the perpendicular miss distance', () => {
  // a flies east through the origin; b flies north 2 NM east of the origin, arriving at the crossing at the same time
  const a = { pos: { x: -4 * NM_TO_M, y: 0 }, heading: 90, speedKt: 240, altFt: 5000, vsFpm: 0 };
  const b = { pos: { x: 0, y: -4 * NM_TO_M }, heading: 0, speedKt: 240, altFt: 5000, vsFpm: 0 };
  const r = cpa(a, b, 300);
  assert.ok(r.distNM < 0.05, `miss=${r.distNM}`);
  const t = timeToInfringement(a, b, 3, 1000, 300);
  assert.ok(t != null && t > 0 && t < r.tS, `tInf=${t}, tCpa=${r.tS}`);
});

test('timeToInfringement: vertically separated pair never infringes', () => {
  const a = { pos: { x: 0, y: 0 }, heading: 90, speedKt: 200, altFt: 5000, vsFpm: 0 };
  const b = { pos: { x: 8 * NM_TO_M, y: 0 }, heading: 270, speedKt: 200, altFt: 7000, vsFpm: 0 };
  assert.equal(timeToInfringement(a, b, 3, 1000, 120), null);
});

test('STCA: raised (predicted) for a converging pair, escalates to critical inside 30 s, resolves after the pair diverges with hysteresis', () => {
  const eng = new AlertEngine();
  const a = mkAircraft({ callsign: 'BAW117', pos: { x: -6 * NM_TO_M, y: 0 }, heading: 90, speed: 200, altitude: 5000, targetAltitude: 5000, phase: 'cruise' });
  const b = mkAircraft({ callsign: 'DLH2GK', pos: { x: 6 * NM_TO_M, y: 0 }, heading: 270, speed: 200, altitude: 5000, targetAltitude: 5000, phase: 'cruise' });
  // 12 NM apart closing at 400 kt: infringement (3 NM) at 9 NM closed -> ~81 s: beyond the 60 s look-ahead
  let r = eng.step([a, b], [], [], 1, ctxFor(0));
  assert.equal(eng.stca().active, false, 'no alert beyond look-ahead');
  // move to 8 NM apart -> infringement in 45 s: predicted warning
  a.pos = { x: -4 * NM_TO_M, y: 0 }; b.pos = { x: 4 * NM_TO_M, y: 0 };
  r = eng.step([a, b], [], [], 1, ctxFor(10));
  assert.equal(eng.stca().active, true);
  const al = eng.active().find(x => x.kind === 'stca')!;
  assert.equal(al.predicted, true);
  assert.equal(al.severity, 'warning');
  assert.deepEqual(eng.stca().pairs, [['BAW117', 'DLH2GK']]);
  assert.ok(r.changed.length === 1 && r.events.some(e => e.type === 'alert'));
  // 5.5 NM apart -> 22 s to infringement: critical
  a.pos = { x: -2.75 * NM_TO_M, y: 0 }; b.pos = { x: 2.75 * NM_TO_M, y: 0 };
  r = eng.step([a, b], [], [], 1, ctxFor(20));
  assert.equal(al.severity, 'critical');
  assert.equal(eng.active().filter(x => x.kind === 'stca').length, 1, 'no duplicate for the same pair');
  // actual loss: 2 NM apart
  a.pos = { x: -1 * NM_TO_M, y: 0 }; b.pos = { x: 1 * NM_TO_M, y: 0 };
  eng.step([a, b], [], [], 1, ctxFor(30));
  assert.equal(al.predicted, false);
  assert.equal(al.title, 'SEPARATION LOSS');
  // diverge: 10 NM apart flying away -> not resolved immediately (hysteresis), resolved after resolveHoldS
  a.pos = { x: -5 * NM_TO_M, y: 0 }; a.heading = 270; b.pos = { x: 5 * NM_TO_M, y: 0 }; b.heading = 90;
  r = eng.step([a, b], [], [], 1, ctxFor(31));
  assert.equal(al.resolvedAt, null, 'still active inside the hysteresis window');
  r = eng.step([a, b], [], [], 1, ctxFor(31 + ALERT_CONST.resolveHoldS + 1));
  assert.ok(al.resolvedAt != null, 'resolved after hold');
  assert.ok(r.resolved.includes(al));
  assert.equal(eng.stca().active, false);
});

test('STCA: pairs both on the ground and pairs under reduced minima are ignored; ack survives updates', () => {
  const eng = new AlertEngine();
  const g1 = mkAircraft({ phase: 'taxi', pos: { x: 0, y: 0 }, speed: 15, altitude: 0 });
  const g2 = mkAircraft({ phase: 'taxi', pos: { x: 100, y: 0 }, speed: 15, altitude: 0 });
  eng.step([g1, g2], [], [], 1, ctxFor(0));
  assert.equal(eng.stca().active, false);
  const a = mkAircraft({ pos: { x: -2 * NM_TO_M, y: 0 }, heading: 90, altitude: 4000, targetAltitude: 4000 });
  const b = mkAircraft({ pos: { x: 2 * NM_TO_M, y: 0 }, heading: 270, altitude: 4000, targetAltitude: 4000 });
  eng.step([a, b], [], [], 1, ctxFor(1, { reducedMinima: () => true }));
  assert.equal(eng.stca().active, false, 'reduced minima suppresses');
  eng.step([a, b], [], [], 1, ctxFor(2));
  const al = eng.active().find(x => x.kind === 'stca')!;
  assert.ok(al);
  assert.equal(eng.ack(al.id, 3), true);
  eng.step([a, b], [], [], 1, ctxFor(3));
  assert.equal(eng.active().find(x => x.id === al.id)?.ack, true);
});

test('MSAW: level flight below the default floor outside 5 NM raises critical; on approach it does not', () => {
  const eng = new AlertEngine();
  const low = mkAircraft({ callsign: 'LOW1', pos: { x: 8 * NM_TO_M, y: 0 }, altitude: 1200, targetAltitude: 1200, phase: 'descent' });
  const app = mkAircraft({ callsign: 'APP1', pos: { x: 8 * NM_TO_M, y: 1000 }, altitude: 1200, targetAltitude: 1200, phase: 'approach', ilsCaptured: true });
  eng.step([low, app], [], [], 1, ctxFor(0, { centerXY: { x: 0, y: 0 } }));
  const msaw = eng.active().filter(x => x.kind === 'msaw');
  assert.equal(msaw.length, 1);
  assert.equal(msaw[0].subjects[0], 'LOW1');
  assert.equal(msaw[0].severity, 'critical');
  // descending toward the floor: predicted (warning)
  const desc = mkAircraft({ callsign: 'DESC', pos: { x: 9 * NM_TO_M, y: 0 }, altitude: 2400, targetAltitude: 1000, phase: 'descent' });
  eng.step([desc], [], [], 1, ctxFor(1, { centerXY: { x: 0, y: 0 } }));
  const m2 = eng.active().find(x => x.kind === 'msaw' && x.subjects[0] === 'DESC')!;
  assert.ok(m2 && m2.predicted && m2.severity === 'warning');
});

test('runway incursion: aircraft on a runway without clearance and a vehicle crossing under an arrival', () => {
  const eng = new AlertEngine();
  const a = mkAircraft({ callsign: 'BAW1', phase: 'taxi', altitude: 0, speed: 10 });
  const rwy = mkRunway('27L', '09R', '09R/27L', 270, { occupiedBy: [{ id: 'FIRE1', callsign: 'Fire 1', kind: 'vehicle', since: 0 }] });
  const veh = { id: 'FIRE1', callsign: 'Fire 1', type: 'arff', state: 'enroute', pos: { x: 0, y: 0 }, heading: 0, speed: 20, station: { x: 0, y: 0 }, stationNodeId: '', target: null, path: null, distAlong: 0, holdShortNode: null, holdShortRunway: null, holdReleased: false, trafficHold: false, onRunway: '09R/27L', dispatchedAt: 0, etaAt: null, arrivedAt: null, onSceneUntil: null, maxSpeedKt: { taxiway: 40, runway: 50, apron: 15 }, safetyRadiusM: 8, trail: [] as XY[] } as const satisfies Vehicle;
  const r = eng.step([a], [veh], [rwy], 1, ctxFor(0, {
    onRunwayWithoutClearance: (id) => (id === a.id ? '27L' : null),
    arrivalOnFinal: (runway) => (runway === '27L' ? 'DLH2' : null),
  }));
  const inc = eng.active().filter(x => x.kind === 'runway_incursion');
  assert.ok(inc.some(x => x.subjects[0] === 'BAW1'), 'aircraft incursion');
  assert.ok(inc.some(x => x.subjects[0] === 'Fire 1' && x.subjects[1] === 'DLH2'), 'vehicle crossing under arrival');
  assert.ok(r.changed.length >= 2);
  // vehicle cleared (holdReleased) is not an incursion when the engine says so
  const eng2 = new AlertEngine();
  eng2.step([], [{ ...veh, holdReleased: true }], [], 1, ctxFor(0, { onRunwayWithoutClearance: (id) => (id === 'FIRE1' ? '27L' : null) }));
  assert.equal(eng2.active().filter(x => x.kind === 'runway_incursion').length, 0);
});

test('wake matrix: HEAVY leader / MEDIUM trailer 4 NM behind on the same final raises a wake alert; 5.5 NM does not', () => {
  const eng = new AlertEngine();
  const lead = mkAircraft({ callsign: 'HVY', type: 'B77W', phase: 'approach', ilsCaptured: true, assignedRunway: '27L', pos: { x: 4 * NM_TO_M, y: 0 }, heading: 270, altitude: 1300, targetAltitude: 0 });
  const trail = mkAircraft({ callsign: 'MED', type: 'A320', phase: 'approach', ilsCaptured: true, assignedRunway: '27L', pos: { x: 8 * NM_TO_M, y: 0 }, heading: 270, altitude: 2500, targetAltitude: 0 });
  assert.equal(WAKE_FINAL_NM.HEAVY.MEDIUM, 5);
  const ctx = ctxFor(0, { distToThresholdNM: (x: AircraftState) => x.pos.x / NM_TO_M });
  eng.step([lead, trail], [], [], 1, ctx);
  const w = eng.active().find(x => x.kind === 'wake');
  assert.ok(w, 'wake alert raised');
  assert.equal(w!.subjects[0], 'MED');
  assert.equal(w!.geometry.cpaNM, 5);
  trail.pos = { x: 9.5 * NM_TO_M, y: 0 };
  eng.step([lead, trail], [], [], 1, ctxFor(ALERT_CONST.resolveHoldS + 1, { distToThresholdNM: (x: AircraftState) => x.pos.x / NM_TO_M }));
  assert.ok(w!.resolvedAt != null, 'resolved once outside the minimum');
  // LIGHT behind SUPER needs 8 NM
  assert.equal(WAKE_FINAL_NM.SUPER.LIGHT, 8);
  assert.equal(WAKE_FINAL_NM.MEDIUM.MEDIUM, 3);
});

test('emergency mirror, holding fuel, unanswered request, stopped on runway, deadlock', () => {
  const eng = new AlertEngine();
  const em = mkAircraft({ callsign: 'EMG', phase: 'descent' });
  em.emergency = { type: 'engine_fire', level: 'MAYDAY', status: 'declared', declaredAt: 0, phase: 'climb', stage: 'dep_climb', soulsOnBoard: 150, fuelMin: null, squawk: '7700', requests: [], runway: null, priority: false, sterile: false, arff: 'none', arffOnSceneAt: null, stopOnRunway: false, evacuation: false, closureMin: 0, landedAt: null, stoppedAt: null, resolvedAt: null, checklist: { acknowledge: null, souls_fuel: null, priority_runway: null, arff: null, ambulance: null, hold_traffic: null, runway_closed: null, runway_reopened: null, inspection: null }, pilotLine: 'MAYDAY' };
  const hold = mkAircraft({ callsign: 'HLD', phase: 'cruise', navMode: 'hold', fuelMin: 25 });
  hold.delay.holdingS = 21 * 60;
  const req = mkAircraft({ callsign: 'REQ', phase: 'parked', altitude: 0, speed: 0 });
  req.requests = [{ id: 1, kind: 'pushback', callsign: 'REQ', text: 'request pushback', param: null, at: 0, recallAt: 45, recalls: 2, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null }];
  const stuck = mkAircraft({ callsign: 'STK', phase: 'rollout', altitude: 0, speed: 0 });
  const rwy = mkRunway('27L', '09R', '09R/27L', 270, { occupiedBy: [{ id: stuck.id, callsign: 'STK', kind: 'stopped', since: 0 }] });
  const h1 = mkAircraft({ callsign: 'HO1', phase: 'taxi', altitude: 0, speed: 0, pos: { x: 0, y: 0 }, heading: 90 });
  const h2 = mkAircraft({ callsign: 'HO2', phase: 'taxi', altitude: 0, speed: 0, pos: { x: 50, y: 0 }, heading: 270 });
  const all = [em, hold, req, stuck, h1, h2];
  eng.step(all, [], [rwy], 1, ctxFor(100));
  assert.ok(eng.active().some(x => x.kind === 'emergency' && x.subjects[0] === 'EMG' && x.severity === 'critical'));
  assert.ok(eng.active().some(x => x.kind === 'delay' && x.subjects[0] === 'HLD' && x.title.startsWith('HOLDING')));
  assert.ok(eng.active().some(x => x.kind === 'request' && x.subjects[0] === 'REQ'));
  assert.ok(eng.active().some(x => x.kind === 'ground_conflict' && x.subjects.includes('HO1')) === false, 'stopped pair is not a moving ground conflict');
  assert.ok(!eng.active().some(x => x.kind === 'deadlock'), 'deadlock needs 15 s');
  assert.ok(!eng.active().some(x => x.kind === 'runway_status'), 'stopped alert needs 60 s');
  eng.step(all, [], [rwy], 1, ctxFor(120));
  assert.ok(eng.active().some(x => x.kind === 'deadlock' && x.subjects.includes('HO1') && x.subjects.includes('HO2')));
  eng.step(all, [], [rwy], 1, ctxFor(165));
  assert.ok(eng.active().some(x => x.kind === 'runway_status' && x.subjects[0] === 'STK' && x.title === 'STOPPED ON RUNWAY'));
  // emergency resolves -> alert resolves
  em.emergency!.status = 'resolved';
  eng.step(all, [], [rwy], 1, ctxFor(180));
  assert.ok(eng.list().find(x => x.kind === 'emergency')!.resolvedAt != null);
  // raise() dedupes and raiseWeather works
  const w1 = eng.raiseWeather({ dep: ['09R'], arr: ['09L'], reason: 'wind 090/14' }, 200);
  const w2 = eng.raiseWeather({ dep: ['09R'], arr: ['09L'], reason: 'wind 090/16' }, 205);
  assert.equal(w1.id, w2.id);
  assert.equal(w2.detail, 'wind 090/16');
  assert.equal(eng.resolve(w1.id, 210), true);
  assert.equal(eng.resolve(w1.id, 211), false);
});

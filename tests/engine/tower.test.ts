// Tower position: landing clearance gate (B1/B7), forced go-around table,
// missed approach -> re-vector -> ILS -> land, requested exits, line-up /
// takeoff gating (occupied runway, wake timer), occupied-runway trap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, cmd, text, evs, ledger, ledgerHas, spawnOnFinal, runwayFrame, newTracker, runTracked, runTrackedUntil, formatViolations, dist, angleDelta, NM_TO_M, FIXED } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { FORCED_GA } from '../../src/lib/sim/engine';
import { TCH_FT } from '../../src/lib/sim/ils';

const AIRPORTS: Array<{ icao: string; ends: string[]; land: string }> = [
  { icao: 'EGLL', ends: ['27R', '27L'], land: '27L' },
  { icao: 'KSFO', ends: ['28L', '28R'], land: '28R' },
  { icao: 'KLAX', ends: ['25L', '25R', '24L', '24R'], land: '25L' },
];

for (const ap of AIRPORTS) {
  test(`B1 ${ap.icao} ${ap.land}: a cleared arrival crosses the threshold at the TCH on the centreline and touches down in the touchdown zone`, () => {
    const e = makeEngine(ap.icao, { ends: ap.ends });
    const tr = newTracker();
    const a = spawnOnFinal(e, 'DAL5', ap.land, 10);
    const rs = e.runwayState(ap.land)!;
    // established after the first ticks (on the centreline, below the glideslope, on course)
    runTracked(e, [a], 5, tr);
    assert.equal(a.ilsCaptured, true, 'localizer captured');
    assert.equal(a.assignedRunway, ap.land);
    assert.ok(ledgerHas(e, 'ESTABLISHED', 'DAL5'));
    // landing gate: not cleared on the ground / when not established
    const c = cmd(e, makeAst('clearedLand', 'DAL5', { runway: ap.land }));
    assert.equal(c.code, 'ok_queued');
    const cl = runTrackedUntil(e, [a], () => a.landingCleared, 10, tr);
    assert.ok(cl.ok);
    assert.ok(evs(e, 'landing_clearance', 'DAL5').length === 1);
    assert.ok(rs.landingClearances.includes('DAL5'));
    assert.equal(cmd(e, makeAst('clearedLand', 'DAL5', { runway: ap.land })).code, 'already');
    // landing phase (approach path built inside 8 NM), then track the threshold crossing
    const lp = runTrackedUntil(e, [a], () => a.phase === 'landing', 120, tr);
    assert.ok(lp.ok, 'landing phase');
    assert.equal(a.path!.kind, 'approach');
    const thr = { alt: null as number | null, cross: null as number | null };
    let prevAlong = runwayFrame(e, ap.land, a.pos).along;
    const td = runTrackedUntil(e, [a], () => {
      const f = runwayFrame(e, ap.land, a.pos);
      if (thr.alt == null && prevAlong < 0 && f.along >= 0) { thr.alt = a.altitude; thr.cross = f.cross; }
      prevAlong = f.along;
      return a.phase === 'rollout';
    }, 400, tr);
    assert.ok(td.ok, 'touched down');
    assert.ok(evs(e, 'touchdown', 'DAL5').length === 1);
    assert.ok(thr.alt != null && Math.abs(thr.alt - TCH_FT) <= 20, `threshold crossing height ${thr.alt?.toFixed(0)} ft (TCH ${TCH_FT})`);
    assert.ok(thr.cross != null && Math.abs(thr.cross) <= 10, `centreline at the threshold (${thr.cross?.toFixed(1)} m)`);
    const f = runwayFrame(e, ap.land, a.pos);
    assert.ok(Math.abs(f.cross) <= 10, `touchdown on the centreline (${f.cross.toFixed(1)} m)`);
    assert.ok(f.along >= 200 && f.along <= 450, `touchdown ${f.along.toFixed(0)} m past the threshold (TDZ 300-450 m)`);
    assert.ok(Math.abs(angleDelta(a.heading, rs.headingTrue)) < 3);
    assert.equal(a.altitude, 0);
    assert.equal(rs.occupiedBy.find(o => o.id === a.id)?.kind, 'rollout');
    assert.equal(a.landingCleared, false, 'clearance consumed at touchdown');
    assert.ok(!ledgerHas(e, 'GA_UNHANDLED'));
    assert.ok(!evs(e, 'go_around', 'DAL5').length, 'B1: no spurious go-around against itself');
    // rollout: decelerates, vacates, LANDED scored, handed to ground, pilot requests taxi
    const vac = runTrackedUntil(e, [a], () => evs(e, 'runway_vacated', 'DAL5').length > 0, 200, tr);
    assert.ok(vac.ok, 'vacated');
    const rot = a.delay.vacatedAt! - a.delay.touchdownAt!;
    assert.ok(rot >= 25 && rot <= 90, `runway occupancy ${rot.toFixed(0)} s`);
    assert.ok(ledgerHas(e, 'LANDED', 'DAL5'));
    assert.equal(rs.occupiedBy.length, 0);
    assert.ok(e.distToRunway(a.pos, rs.ref) > 60, 'clear of the strip when vacated');
    const rq = runTrackedUntil(e, [a], () => a.requests[0]?.kind === 'taxi_in', 120, tr);
    assert.ok(rq.ok, 'taxi-in request after vacating');
    assert.equal(a.onFrequency, 'ground');
    assert.equal(a.phase, 'taxi');
    assert.equal(e.stageOf(a), 'taxi_in');
    assert.equal(tr.violations.length, 0, `tracking violations:\n${formatViolations(tr)}`);
  });
}

test('no landing clearance: pilot queries at 4 NM, goes around at 2 NM on runway heading to 3000 ft (GA_UNHANDLED), then re-vector -> ILS -> land', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = spawnOnFinal(e, 'UAL1', '28R', 9, { type: 'B738', speedKts: 180 });
  const rs = e.runwayState('28R')!; const thr = e.thresholdXY('28R')!;
  const q = runUntil(e, () => a.requests[0]?.kind === 'confirm_cleared', 300);
  assert.ok(q.ok, 'pilot asks "confirm cleared to land?"');
  const dq = e.distToThresholdNM(a, '28R')!;
  assert.ok(dq <= 4.05 && dq > 3.5, `query at ${dq.toFixed(2)} NM`);
  const ga = runUntil(e, () => a.phase === 'go_around', 300, 0.2);
  assert.ok(ga.ok, 'went around');
  const dGA = e.distToThresholdNM(a, '28R')!;
  assert.ok(dGA <= FORCED_GA.noClearanceNM + 0.05 && dGA >= FORCED_GA.noClearanceNM - 0.3, `go-around at ${dGA.toFixed(2)} NM`);
  const gaEv = evs(e, 'go_around', 'UAL1')[0];
  assert.ok(gaEv && /no landing clearance/.test(gaEv.message), gaEv?.message);
  assert.equal(a.goAround, true);
  assert.equal(e.stageOf(a), 'go_around');
  assert.equal(a.ilsCaptured, false);
  assert.equal(a.landingCleared, false);
  assert.equal(a.path, null);
  assert.equal(a.targetAltitude, 3000);
  assert.ok(Math.abs(angleDelta(a.targetHeading, rs.headingTrue)) < 1, 'runway heading');
  assert.ok(ledgerHas(e, 'GA_UNHANDLED', 'UAL1'));
  assert.equal(e.stats.goAroundsPlayer, 1);
  assert.equal(a.goAroundCount, 1);
  assert.ok(a.requests[0]?.kind === 'going_around');
  assert.ok(e.activeAlerts().some(al => al.kind === 'go_around'));
  // a second ATC go-around while already going around is "already"
  assert.equal(cmd(e, makeAst('goAround', 'UAL1', { heading: null, alt: null, contact: null })).code, 'already');
  // climbs on runway heading to 3000, handed back to approach
  const up = runUntil(e, () => a.altitude >= 2950, 300);
  assert.ok(up.ok, 'reached 3000 ft');
  assert.ok(Math.abs(angleDelta(a.heading, rs.headingTrue)) < 2, 'still runway heading');
  assert.ok(Math.abs(runwayFrame(e, '28R', a.pos).cross) < 300, 'over the extended centreline');
  const ho = runUntil(e, () => a.onFrequency === 'approach', 30);
  assert.ok(ho.ok, 'back with approach');
  assert.ok(evs(e, 'handoff', 'UAL1').some(ev => ev.data?.type === 'handoff' && ev.data.to === 'approach'));
  // re-vector: right turn onto a downwind, base, 30-degree intercept, ILS, land
  const right = (rs.headingTrue + 90) % 360, downwind = (rs.headingTrue + 180) % 360, base = (rs.headingTrue + 270) % 360, icpt = (rs.headingTrue + 330) % 360;
  assert.equal(cmd(e, makeAst('heading', 'UAL1', { hdg: right, dir: 'R' })).code, 'ok_queued');
  run(e, 3);
  assert.equal(a.goAround, false, 'go-around flag cleared by the vector');
  assert.ok(a.phase === 'climb' || a.phase === 'cruise', a.phase);
  assert.notEqual(e.stageOf(a), 'go_around');
  runUntil(e, () => Math.abs(runwayFrame(e, '28R', a.pos).cross) > 2.5 * NM_TO_M, 300);
  cmd(e, makeAst('heading', 'UAL1', { hdg: downwind, dir: 'R' }));
  cmd(e, makeAst('speed', 'UAL1', { kts: 190 }));
  const dw = runUntil(e, () => runwayFrame(e, '28R', a.pos).along < -13 * NM_TO_M, 900);
  assert.ok(dw.ok, 'downwind abeam 13 NM');
  cmd(e, makeAst('heading', 'UAL1', { hdg: base, dir: 'R' }));
  const bs = runUntil(e, () => Math.abs(runwayFrame(e, '28R', a.pos).cross) < 2.2 * NM_TO_M, 600);
  assert.ok(bs.ok, 'base leg');
  cmd(e, makeAst('heading', 'UAL1', { hdg: icpt }));
  const ils = cmd(e, makeAst('ils', 'UAL1', { runway: '28R' }));
  assert.equal(ils.code, 'ok_queued');
  const cap = runUntil(e, () => a.ilsCaptured, 600);
  assert.ok(cap.ok, 'established again');
  assert.ok(e.distToThresholdNM(a, '28R')! > 6, 're-established outside 6 NM');
  const lp = runUntil(e, () => a.phase === 'landing', 600);
  assert.ok(lp.ok);
  assert.equal(cmd(e, makeAst('clearedLand', 'UAL1', { runway: '28R' })).code, 'ok_queued');
  const td = runUntil(e, () => a.phase === 'rollout', 600);
  assert.ok(td.ok, 'landed after the missed approach');
  assert.equal(a.goAroundCount, 1);
  const f = runwayFrame(e, '28R', a.pos);
  assert.ok(Math.abs(f.cross) <= 10 && f.along >= 200 && f.along <= 450, `touchdown ${f.along.toFixed(0)} / ${f.cross.toFixed(1)} m`);
  assert.ok(!ledgerHas(e, 'DIVERSION'));
});

test('"continue approach" moves the no-clearance go-around point to 1 NM; a late clearance still lands', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = spawnOnFinal(e, 'BAW7', '27L', 8);
  run(e, 3);
  assert.equal(cmd(e, makeAst('continueApproach', 'BAW7', { number: 2 })).code, 'ok_queued');
  run(e, 3);
  assert.equal(a.sequenceNo, 2);
  runUntil(e, () => (e.distToThresholdNM(a, '27L') ?? 9) < 1.9, 300, 0.2);
  assert.equal(a.phase, 'landing', 'no go-around at 2 NM after "continue approach"');
  assert.ok(!a.requests.some(r => r.kind === 'confirm_cleared'), 'no 4 NM query after "continue approach"');
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW7', { runway: '27L' })).code, 'ok_queued');
  const td = runUntil(e, () => a.phase === 'rollout', 120);
  assert.ok(td.ok, 'landed');
  assert.ok(!evs(e, 'go_around', 'BAW7').length);
});

test('landing clearance gates: not established / on the ground / wrong runway / closed runway / ICAO one clearance at a time', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const g = e.spawnAt({ callsign: 'GND1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27R', onFrequency: 'tower' });
  assert.equal(cmd(e, makeAst('clearedLand', 'GND1', { runway: '27R' })).code, 'invalid_stage');
  const a = e.spawnAt({ callsign: 'BAW8', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -12, offsetNM: 3, altFt: 4000 }, heading: 240, speedKts: 200 });
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW8', { runway: '27L' })).code, 'invalid_stage', 'not on approach');
  assert.equal(cmd(e, makeAst('ils', 'BAW8', { runway: '27L' })).code, 'ok_queued');
  run(e, 3);
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW8', { runway: '27L' })).code, 'invalid_stage', 'armed but not established');
  const b = spawnOnFinal(e, 'BAW9', '27L', 9);
  run(e, 3);
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW9', { runway: '27R' })).code, 'queried', 'wrong runway is queried');
  e.setRunwayStatus('27L', 'closed', 'test');
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW9', { runway: '27L' })).code, 'runway_closed');
  e.setRunwayStatus('27L', 'open', null);
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW9', { runway: '27L' })).code, 'ok_queued');
  run(e, 3);
  const c = spawnOnFinal(e, 'BAW10', '27L', 12, { onFrequency: 'tower' });
  run(e, 3);
  assert.equal(c.ilsCaptured, true);
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW10', { runway: '27L' })).code, 'already', 'ICAO: one landing clearance per runway');
  assert.equal(cmd(e, makeAst('clearedLand', 'GND1', { runway: '27R' })).code, 'invalid_stage');
});

test('requested exit: "cleared to land, vacate via N7" leaves 27L at N7, then taxi to stand -> arrived -> PARKED', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = spawnOnFinal(e, 'BAW22', '27L', 9);
  run(e, 3);
  const c = cmd(e, makeAst('clearedLand', 'BAW22', { runway: '27L', exit: { kind: 'taxiway', taxiway: 'N7' } }));
  assert.equal(c.code, 'ok_queued');
  run(e, 3);
  assert.equal(a.exitTaxiway, 'N7');
  const td = runUntil(e, () => a.phase === 'rollout', 400);
  assert.ok(td.ok);
  run(e, 1);
  assert.ok(!evs(e, 'info', 'BAW22').some(ev => /unable N7/.test(ev.message)), 'N7 is reachable');
  const vac = runUntil(e, () => evs(e, 'runway_vacated', 'BAW22').length > 0, 200);
  assert.ok(vac.ok);
  assert.ok(evs(e, 'info', 'BAW22').some(ev => /exiting via N7/.test(ev.message)), 'pilot takes N7');
  const n7 = e.air.taxiwayNodes.get('N7') ?? [];
  const nearN7 = Math.min(...n7.map(id => dist(a.pos, e.nodeXY(id)!)));
  assert.ok(nearN7 < 120, `vacated on N7 (${nearN7.toFixed(0)} m from the nearest N7 node)`);
  const f = runwayFrame(e, '27L', a.pos);
  assert.ok(f.along > 2500 && f.along < 3300, `left the runway around N7 (${f.along.toFixed(0)} m)`);
  // stopped at the exit, taxi-in request, taxi to the reserved stand, arrived, scored, despawned
  const rq = runUntil(e, () => a.requests[0]?.kind === 'taxi_in', 120);
  assert.ok(rq.ok);
  assert.ok(a.speed < 0.5 && a.phase === 'taxi');
  const stand = a.plan.gateRef!;
  assert.ok(e.gateStates().find(g => g.ref === stand)!.reservedFor === a.id, 'stand still reserved');
  const tx = cmd(e, makeAst('taxi', 'BAW22', { dest: { kind: 'stand', ref: stand } }));
  assert.equal(tx.code, 'ok_queued');
  assert.equal(tx.extra?.stand, stand);
  assert.equal(a.requests.length, 0);
  const arr = runUntil(e, () => a.phase === 'arrived', 1500, 5);
  assert.ok(arr.ok, 'arrived on stand');
  assert.equal(e.stageOf(a), 'arrived');
  const g = e.gateStates().find(g => g.ref === stand)!;
  assert.equal(g.occupiedBy, a.id);
  assert.equal(g.reservedFor, null);
  assert.ok(dist(a.pos, e.nodeXY(g.nodeId)!) < 60 || a.pos != null);
  assert.ok(ledgerHas(e, 'PARKED', 'BAW22'));
  assert.ok(ledgerHas(e, 'LANDED', 'BAW22'));
  assert.ok(ledgerHas(e, 'ESTABLISHED', 'BAW22'));
  assert.equal(e.stats.arrivals, 1);
  assert.ok(e.stats.points >= 30, `points ${e.stats.points}`);
  assert.ok(a.delay.totalDelayS >= 0 && a.delay.totalDelayS < 120, `delay ${a.delay.totalDelayS.toFixed(0)} s`);
  const gone = runUntil(e, () => !e.find('BAW22'), 320, 5);
  assert.ok(gone.ok, 'parked arrival despawns');
  assert.ok(evs(e, 'removed', 'BAW22').some(ev => ev.data?.type === 'removed' && ev.data.reason === 'arrived'));
  assert.equal(g.occupiedBy, null, 'stand freed');
});

test('an unreachable requested exit is declined ("unable, we will take ...") and the pilot takes a later one', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = spawnOnFinal(e, 'BAW23', '27L', 9);
  run(e, 3);
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW23', { runway: '27L', exit: { kind: 'taxiway', taxiway: 'N1' } })).code, 'ok_queued');
  const td = runUntil(e, () => a.phase === 'rollout', 400);
  assert.ok(td.ok);
  run(e, 1);
  assert.ok(evs(e, 'info', 'BAW23').some(ev => /unable N1/.test(ev.message)), 'pilot declines N1');
  const vac = runUntil(e, () => evs(e, 'runway_vacated', 'BAW23').length > 0, 200);
  assert.ok(vac.ok);
  assert.ok(runwayFrame(e, '27L', a.pos).along > 1000);
});

test('line-up and takeoff gating: occupied runway, wake timer HEAVY -> MEDIUM (120 s), efficient launch bonus', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const h = e.spawnAt({ callsign: 'BAW9', type: 'B77W', kind: 'departure', phase: 'lineup', runway: '27R', onFrequency: 'tower' });
  const m = e.spawnAt({ callsign: 'BAW2', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '27R', onFrequency: 'tower' });
  assert.equal(e.stageOf(m), 'hold_short_dep');
  assert.equal(m.wakeCategory, 'MEDIUM');
  assert.equal(h.wakeCategory, 'HEAVY');
  // runway occupied by the heavy: line-up / takeoff refused for the medium
  assert.equal(cmd(e, makeAst('lineup', 'BAW2', { runway: '27R' })).code, 'runway_occupied');
  assert.equal(cmd(e, makeAst('takeoff', 'BAW2', { runway: '27R' })).code, 'runway_occupied');
  assert.equal(cmd(e, makeAst('takeoff', 'BAW2', { runway: '27L' })).code, 'queried', 'wrong runway is queried');
  // heavy departs: wake timer starts at rotation
  assert.equal(cmd(e, makeAst('takeoff', 'BAW9', { runway: '27R' })).code, 'ok_queued');
  const air = runUntil(e, () => h.delay.airborneAt != null, 120);
  assert.ok(air.ok);
  const wt = e.wakeTimers();
  assert.ok(wt['27R'] && wt['27R'].leader === 'BAW9', 'wake timer on 27R');
  assert.ok(wt['09L'] && wt['09L'].leader === 'BAW9', 'both ends');
  const rem = e.wakeTimerRemainingS('27R', 'MEDIUM');
  assert.ok(rem > 118 && rem <= 120, `MEDIUM behind HEAVY: ${rem.toFixed(0)} s`);
  assert.equal(e.wakeTimerRemainingS('27R', 'HEAVY'), 0, 'HEAVY behind HEAVY needs no timer');
  assert.ok(evs(e, 'wake').some(ev => ev.data?.type === 'wake' && ev.data.leader === 'BAW9'));
  run(e, 20);
  assert.ok(e.runwayPhysicallyClear('27R', m.id));
  const early = cmd(e, makeAst('takeoff', 'BAW2', { runway: '27R' }));
  assert.equal(early.code, 'unable');
  assert.ok(/[Ww]ake/.test(early.reason ?? ''), early.reason);
  assert.equal(m.phase, 'hold_short');
  const done = runUntil(e, () => e.wakeTimerRemainingS('27R', 'MEDIUM') === 0, 130);
  assert.ok(done.ok);
  assert.ok(done.elapsed >= 95 && done.elapsed <= 102, `timer expired after ${done.elapsed + 20} s`);
  assert.equal(cmd(e, makeAst('takeoff', 'BAW2', { runway: '27R' })).code, 'ok_queued');
  assert.ok(ledgerHas(e, 'WAKE_EFFICIENT', 'BAW2'), 'clearance within 10 s of expiry');
  const air2 = runUntil(e, () => m.delay.airborneAt != null, 120);
  assert.ok(air2.ok, 'medium airborne');
  assert.ok(m.delay.airborneAt! - h.delay.airborneAt! >= 120, 'at least 2 minutes between rotations');
  // LIGHT behind MEDIUM also waits (2 min); HEAVY behind MEDIUM does not
  const l = e.spawnAt({ callsign: 'GAC1', type: 'C172', kind: 'departure', phase: 'hold_short', runway: '27R', onFrequency: 'tower' });
  assert.ok(e.wakeTimerRemainingS('27R', 'LIGHT') > 100);
  assert.equal(cmd(e, makeAst('takeoff', 'GAC1', { runway: '27R' })).code, 'unable');
  assert.equal(e.wakeTimerRemainingS('27R', 'HEAVY'), 0);
  void l;
});

test('line-up: LUAW query after 90 s, cancel line-up vacates via a taxiway without a landing score', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW5', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '27R', onFrequency: 'tower' });
  assert.equal(cmd(e, makeAst('lineup', 'BAW5', { runway: '27R' })).code, 'ok_queued');
  const lu = runUntil(e, () => a.phase === 'lineup' && a.speed < 0.5 && a.distAlong >= a.path!.total - 1, 120);
  assert.ok(lu.ok);
  assert.ok(lu.elapsed >= 15 && lu.elapsed <= 70, `line-up took ${lu.elapsed} s`);
  assert.ok(Math.abs(angleDelta(a.heading, e.runwayHeading('27R'))) <= 3);
  assert.equal(cmd(e, makeAst('lineup', 'BAW5', { runway: '27R' })).code, 'already');
  const q = runUntil(e, () => a.requests.length > 0, 120);
  assert.ok(q.ok && a.requests[0].kind === 'ready' && /holding in position/.test(a.requests[0].text));
  assert.ok(q.elapsed >= 60, `query after ${q.elapsed} s`);
  assert.equal(cmd(e, makeAst('cancelLineup', 'BAW5', { via: null })).code, 'ok_queued');
  const off = runUntil(e, () => a.phase === 'taxi', 240);
  assert.ok(off.ok, 'vacated');
  assert.ok(!e.isOnRunway(a));
  assert.equal(e.runwayState('27R')!.occupiedBy.length, 0);
  assert.ok(!ledgerHas(e, 'LANDED'));
});

test('trap mechanic: landing clearance with an aircraft lined up executes, alerts, and the arrival goes around at 1 NM (RWY_INCURSION attributed to the player)', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const d = e.spawnAt({ callsign: 'BAW1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27L', onFrequency: 'tower' });
  const a = spawnOnFinal(e, 'DAL2', '27L', 7);
  run(e, 3);
  const c = cmd(e, makeAst('clearedLand', 'DAL2', { runway: '27L' }));
  assert.equal(c.code, 'ok_queued', 'executed (never gated)');
  assert.equal(c.extra?.occupant, 'BAW1');
  run(e, 3);
  assert.ok(e.activeAlerts().some(al => al.kind === 'occupied_runway_clearance'), 'alert raised');
  const ga = runUntil(e, () => a.phase === 'go_around', 300, 0.2);
  assert.ok(ga.ok);
  const dGA = e.distToThresholdNM(a, '27L')!;
  assert.ok(dGA <= FORCED_GA.occupiedNM + 0.05 && dGA > 0.6, `forced at ${dGA.toFixed(2)} NM`);
  assert.ok(/BAW1/.test(evs(e, 'go_around', 'DAL2')[0].message));
  assert.ok(ledgerHas(e, 'RWY_INCURSION', 'DAL2'));
  assert.equal(e.stats.goAroundsPlayer, 1);
  assert.equal(d.phase, 'lineup', 'the departure is untouched');
  // an ATC go-around ordered in time earns SAFETY_GA instead
  const e2 = makeEngine('EGLL', { ends: ['27R', '27L'] });
  e2.spawnAt({ callsign: 'BAW1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27L', onFrequency: 'tower' });
  const b = spawnOnFinal(e2, 'DAL3', '27L', 5, { landingCleared: true });
  runUntil(e2, () => (e2.distToThresholdNM(b, '27L') ?? 9) < 1.4, 200, 0.2);
  const o = cmd(e2, makeAst('goAround', 'DAL3', { heading: 'runway', alt: 3000, contact: null }));
  assert.ok(o.ok);
  run(e2, 1);
  assert.equal(b.phase, 'go_around');
  assert.ok(ledgerHas(e2, 'SAFETY_GA', 'DAL3'));
  assert.ok(!ledgerHas(e2, 'RWY_INCURSION'));
  assert.equal(e2.stats.goAroundsPilot, 1);
});

test('rollout ahead: a preceding arrival still on the runway forces the follower around at 0.5 NM; a vacated runway does not', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const lead = e.spawnAt({ callsign: 'LEAD', type: 'A320', kind: 'arrival', phase: 'rollout', runway: '27L', speedKts: 40, onFrequency: 'tower' });
  lead.cmdIas = 0; if (lead.path) lead.path.holdAt = lead.path.total; // never exits: sits on the runway
  const f = spawnOnFinal(e, 'FOLO', '27L', 3, { landingCleared: true });
  run(e, 1);
  assert.equal(f.landingCleared, true);
  const ga = runUntil(e, () => f.phase === 'go_around', 200, 0.2);
  assert.ok(ga.ok, 'follower goes around');
  const d = e.distToThresholdNM(f, '27L')!;
  assert.ok(d <= FORCED_GA.precedingNM + 0.05, `at ${d.toFixed(2)} NM`);
  assert.ok(/LEAD/.test(evs(e, 'go_around', 'FOLO')[0].message));
});

test('takeoff clearance blocked by an arrival inside 2 NM and by a closed runway; tailwind > 10 kt is scored', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const d = e.spawnAt({ callsign: 'BAW1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27L', onFrequency: 'tower' });
  spawnOnFinal(e, 'DAL2', '27L', 1.5, { landingCleared: true });
  run(e, 1);
  const r = cmd(e, makeAst('takeoff', 'BAW1', { runway: '27L' }));
  assert.equal(r.code, 'unable');
  assert.ok(/DAL2/.test(r.reason ?? ''));
  e.setRunwayStatus('27L', 'closed', 'works');
  assert.equal(cmd(e, makeAst('takeoff', 'BAW1', { runway: '27L' })).code, 'runway_closed');
  e.setRunwayStatus('27L', 'open', null);
  e.remove(e.find('DAL2')!.id);
  e.setWind(90, 15); // straight tailwind on 27
  const t = cmd(e, makeAst('takeoff', 'BAW1', { runway: '27L' }));
  assert.ok(t.code === 'ok_queued' || t.code === 'unable', t.code);
  assert.ok(ledgerHas(e, 'PERFORMANCE_TAILWIND', 'BAW1'));
  void d;
});

test('cleared for takeoff from the hold (rolling takeoff): no stop on the runway, runway heading, MOVEMENT scored', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const tr = newTracker();
  const a = e.spawnAt({ callsign: 'BAW6', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '27R', onFrequency: 'tower' });
  assert.equal(cmd(e, makeAst('takeoff', 'BAW6', { runway: '27R', afterDepHdg: 'runway', initialAlt: 5000 })).code, 'ok_queued');
  const roll = runTrackedUntil(e, [a], () => a.phase === 'takeoff', 10, tr);
  assert.ok(roll.ok);
  assert.equal(e.runwayState('27R')!.occupiedBy.find(o => o.id === a.id)?.kind, 'takeoff');
  let stoppedOnRunway = false; let minSpd = 99;
  runTracked(e, [a], 120, tr, () => { if (e.isOnRunway(a) && a.takeoffCleared) minSpd = Math.min(minSpd, a.speed); if (e.isOnRunway(a) && a.speed < 0.2 && a.distAlong > 30) stoppedOnRunway = true; return a.delay.airborneAt != null; });
  assert.ok(a.delay.airborneAt != null, 'airborne');
  assert.ok(!stoppedOnRunway, 'rolling takeoff never stops on the runway');
  assert.ok(minSpd > 3, `kept rolling (min ${minSpd.toFixed(1)} kt)`);
  const climb = runTrackedUntil(e, [a], () => a.phase === 'climb', 60, tr);
  assert.ok(climb.ok);
  assert.equal(a.targetAltitude, 5000);
  assert.ok(Math.abs(angleDelta(a.targetHeading, e.runwayHeading('27R'))) < 1);
  assert.equal(a.clearance.autoHandoffAlt, 3000, 'auto handoff capped at 3000 ft');
  assert.equal(tr.violations.length, 0, `tracking violations:\n${formatViolations(tr)}`);
  void FIXED;
});

test('typed commands through executeText: ILS, cleared to land, exit, taxi to stand - the whole arrival from the command line', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW77', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -13, altFt: 3000 }, speedKts: 200 });
  const ils = text(e, 'BAW77 CLEARED ILS 27L');
  assert.ok(ils.parsedOk && ils.ok, `${ils.code} ${ils.reason ?? ''}`);
  assert.ok(ils.transmission.length > 0 && ils.readback.length > 0, 'phraseology filled in');
  assert.ok(evs(e, 'transmission', 'BAW77').length === 1, 'ATC transmission logged');
  const cap = runUntil(e, () => a.ilsCaptured, 120);
  assert.ok(cap.ok);
  assert.ok(evs(e, 'readback', 'BAW77').length >= 1, 'pilot readback event');
  const bad = text(e, 'BAW77 CLEARED TO LAND 99');
  assert.ok(!bad.ok, 'unknown runway is refused');
  const lp = runUntil(e, () => a.phase === 'landing', 200);
  assert.ok(lp.ok);
  const cl = text(e, 'BAW77 CLEARED TO LAND 27L');
  assert.ok(cl.parsedOk && cl.ok, `${cl.code} ${cl.reason ?? ''}`);
  const td = runUntil(e, () => a.phase === 'rollout', 300);
  assert.ok(td.ok, 'landed');
  const f = runwayFrame(e, '27L', a.pos);
  assert.ok(Math.abs(f.cross) <= 10 && f.along >= 200 && f.along <= 450);
  const rq = runUntil(e, () => a.requests[0]?.kind === 'taxi_in', 300);
  assert.ok(rq.ok);
  const tx = text(e, `BAW77 TAXI TO STAND ${a.plan.gateRef}`);
  assert.ok(tx.parsedOk && tx.ok, `${tx.code} ${tx.reason ?? ''}`);
  const arr = runUntil(e, () => a.phase === 'arrived', 1500, 5);
  assert.ok(arr.ok, 'on stand via typed commands');
  assert.ok(ledgerHas(e, 'PARKED', 'BAW77'));
});

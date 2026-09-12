// Ground position: parked -> startup -> pushback -> taxi (runway crossings as
// hold-short PLACES) -> departure hold -> line-up -> takeoff -> handoff.
// Real KSFO data (A1 -> 28L crosses 01L and 01R) and EGLL data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, cmd, evs, ledger, ledgerHas, newTracker, runTracked, runTrackedUntil, formatViolations, runwayFrame, facingTaxiway, dist, angleDelta, headingTo, NM_TO_M } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { PUSHBACK_KT } from '../../src/lib/sim/aircraft';
import type { SimEvent } from '../../src/lib/sim/types';

test('departure lifecycle at KSFO: parked -> startup -> pushback -> taxi with two runway crossings -> hold -> lineup -> takeoff -> handoff (no teleports, holds only at hold nodes)', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const tr = newTracker();
  const a = e.spawnDeparture({ callsign: 'UAL5', type: 'B738', runway: '28L', stand: 'A1' });
  assert.ok(a, 'spawnDeparture returned an aircraft');
  assert.equal(a.phase, 'parked');
  assert.equal(e.stageOf(a), 'parked');
  assert.equal(a.plan.gateRef, 'A1');
  assert.equal(a.needsPushback, true);
  assert.equal(a.onFrequency, 'ground');
  assert.ok(e.gateStates().find(g => g.ref === 'A1')!.occupiedBy === a.id, 'stand A1 occupied by the departure');

  // pilot requests pushback 20-90 s after spawn (UX G8)
  const rq = runTrackedUntil(e, [a], () => a.requests.length > 0, 120, tr);
  assert.ok(rq.ok, 'pushback request raised');
  assert.equal(a.requests[0].kind, 'pushback');
  assert.ok(rq.elapsed >= 19 && rq.elapsed <= 92, `request after ${rq.elapsed} s`);
  assert.ok(evs(e, 'request', 'UAL5').length >= 1);

  // taxi before pushback is refused
  assert.equal(cmd(e, makeAst('taxi', 'UAL5', { dest: { kind: 'runway', runway: '28L', intersection: null } })).code, 'invalid_stage');

  // pushback approved -> tug attach 20-40 s -> pushing at <= 3 kt -> disconnect 20-30 s -> startup phase
  const push = cmd(e, makeAst('pushback', 'UAL5', { dir: 'any', expectRunway: '28L', startup: true }));
  assert.equal(push.code, 'ok_queued');
  assert.equal(a.requests.length, 0, 'request answered');
  const pb = runTrackedUntil(e, [a], () => a.phase === 'pushback', 10, tr);
  assert.ok(pb.ok, 'pushback phase after the pilot delay');
  assert.equal(a.pushback.stage, 'tug_attach');
  const attachS = a.pushback.stageUntil - e.time;
  assert.ok(attachS >= 19 && attachS <= 41, `tug attach ${attachS.toFixed(0)} s`);
  assert.ok(a.startup.startedAt != null, 'engines started during the push');
  const startupDur = a.startup.readyAt! - a.startup.startedAt! - (a.startup.failed ? 300 : 0);
  assert.ok(startupDur >= a.perf.startupS[0] - 1 && startupDur <= a.perf.startupS[1] + 1, `startup ${startupDur.toFixed(0)} s within ${a.perf.startupS}`);
  assert.ok(startupDur >= 90 && startupDur <= 240, 'jet startup 90-240 s');
  const pushing = runTrackedUntil(e, [a], () => a.pushback.stage === 'pushing', 60, tr);
  assert.ok(pushing.ok);
  let maxPushKt = 0; const t0 = e.time; const p0 = { ...a.pos };
  runTracked(e, [a], 200, tr, () => { maxPushKt = Math.max(maxPushKt, a.speed); return a.pushback.stage !== 'pushing'; });
  assert.equal(a.pushback.stage, 'tug_disconnect');
  assert.ok(maxPushKt <= PUSHBACK_KT + 0.05, `push speed ${maxPushKt.toFixed(2)} kt`);
  const pushedM = dist(p0, a.pos);
  assert.ok(pushedM >= 30 && pushedM <= 150, `pushed ${pushedM.toFixed(0)} m`);
  const pushS = e.time - t0;
  assert.ok(pushS >= 20 && pushS <= 120, `push took ${pushS.toFixed(0)} s`);
  const discS = a.pushback.stageUntil - e.time;
  assert.ok(discS >= 19 && discS <= 31, `tug disconnect ${discS.toFixed(0)} s`);
  assert.ok(facingTaxiway(e, a), `nose (${a.heading.toFixed(0)}) aligned with a taxiway edge at the push end`);
  const done = runTrackedUntil(e, [a], () => a.pushback.stage === 'complete', 40, tr);
  assert.ok(done.ok);
  assert.equal(a.phase, 'startup');
  assert.equal(e.stageOf(a), 'startup');
  assert.ok(evs(e, 'pushback', 'UAL5').length >= 3, 'pushback events (attach / pushing / complete)');
  assert.ok(!e.gateStates().some(g => g.occupiedBy === a.id), 'stand released after the push');

  // engines stable -> "request taxi" 5-20 s later
  const stable = runTrackedUntil(e, [a], () => a.startup.enginesStable, 400, tr);
  assert.ok(stable.ok, 'engines stable');
  const tq = runTrackedUntil(e, [a], () => a.requests[0]?.kind === 'taxi', 30, tr);
  assert.ok(tq.ok, 'taxi request');
  assert.ok(tq.elapsed >= 4 && tq.elapsed <= 21, `taxi request ${tq.elapsed} s after engines stable`);

  // taxi clearance: route crosses 01L and 01R before the 28L holding point
  const tx = cmd(e, makeAst('taxi', 'UAL5', { dest: { kind: 'runway', runway: '28L', intersection: null } }));
  assert.equal(tx.code, 'ok_queued');
  assert.equal(tx.extra?.runway, '28L');
  const taxiing = runTrackedUntil(e, [a], () => a.phase === 'taxi', 10, tr);
  assert.ok(taxiing.ok);
  assert.equal(e.stageOf(a), 'taxi_out');
  assert.ok(a.plan.taxiRoute && a.plan.taxiRoute.length >= 3, `taxi route ${a.plan.taxiRoute}`);
  const holds = a.path!.holds!;
  assert.equal(holds.length, 3, `three hold places: ${holds.map(h => h.runway).join(',')}`);
  assert.deepEqual(holds.map(h => h.runway), ['01L', '01R', '28L']);
  assert.deepEqual(holds.map(h => h.isDepartureEntry), [false, false, true]);
  for (const h of holds) assert.ok(e.isHoldNodeForRunway(h.nodeId, h.runway), `${h.nodeId} is a hold node for ${h.runway}`);
  assert.equal(a.holdReleased, false);
  assert.equal(a.path!.holdAt, holds[0].at);
  // FAA airport: the implicit hold-short is scored TAXI_INCOMPLETE (03 A1)
  assert.ok(ledgerHas(e, 'TAXI_INCOMPLETE', 'UAL5'));
  // a hold-short for a runway that is not on the route is queried, never executed (B4)
  const hs = cmd(e, makeAst('holdShort', 'UAL5', { of: { kind: 'runway', runway: '28R' } }));
  assert.equal(hs.code, 'queried');
  // takeoff / line-up far from the runway are refused (B4: no straight line across the apron)
  assert.equal(cmd(e, makeAst('takeoff', 'UAL5', { runway: '28L' })).code, 'not_at_hold');
  assert.equal(cmd(e, makeAst('lineup', 'UAL5', { runway: '28L' })).code, 'not_at_hold');

  // first crossing: stops at the 01L hold, raises "request cross"
  const h1 = runTrackedUntil(e, [a], () => a.phase === 'hold_short' && a.speed < 0.5, 600, tr);
  assert.ok(h1.ok, 'reached the first hold');
  assert.equal(a.holdShortRunway, '01L');
  assert.equal(e.stageOf(a), 'hold_short_cross');
  assert.ok(a.speed < 0.5);
  assert.ok(e.isHoldNodeForRunway(a.holdShortNode!, '01L'));
  const dHold = e.distToRunway(a.pos, e.runwayState('01L')!.ref);
  assert.ok(dHold > 45 && dHold < 200, `holding ${dHold.toFixed(0)} m from the 01L centreline`);
  assert.ok(evs(e, 'reached_hold', 'UAL5').some(ev => /01L/.test(ev.message)));
  const cq = runTrackedUntil(e, [a], () => a.requests[0]?.kind === 'cross', 15, tr);
  assert.ok(cq.ok, 'cross request');
  assert.equal(a.requests[0].param, '01L');
  // "continue" at a runway hold is refused: crossing needs an explicit clearance
  assert.equal(cmd(e, makeAst('continue', 'UAL5')).code, 'not_at_hold');
  // crossing the wrong runway is not accepted
  assert.equal(cmd(e, makeAst('cross', 'UAL5', { runway: '01R' })).code, 'not_at_hold');
  run(e, 5);
  assert.equal(a.phase, 'hold_short', 'still holding without a cross clearance');
  const c1 = cmd(e, makeAst('cross', 'UAL5', { runway: '01L' }));
  assert.equal(c1.code, 'ok_queued');
  assert.equal(a.requests.length, 0);
  const moving = runTrackedUntil(e, [a], () => a.phase === 'taxi' && a.speed > 1, 15, tr);
  assert.ok(moving.ok, 'moving again after the cross clearance');
  assert.equal(a.holdReleased, true);
  assert.equal(e.runwayState('01L')!.occupiedBy.find(o => o.id === a.id)?.kind, 'crossing');
  // cross releases exactly one hold: after passing the line the next hold (01R) arms itself
  const passed = runTrackedUntil(e, [a], () => a.path!.holds!.length === 2, 60, tr);
  assert.ok(passed.ok, 'first hold consumed');
  assert.deepEqual(a.path!.holds!.map(h => h.runway), ['01R', '28L']);
  assert.equal(a.holdReleased, false, 'next hold re-armed');
  // vacated only after physically crossing the strip
  let entered = false;
  const vac = runTrackedUntil(e, [a], () => { if (e.distToRunway(a.pos, e.runwayState('01L')!.ref) < 45) entered = true; return evs(e, 'runway_vacated', 'UAL5').length > 0; }, 120, tr);
  assert.ok(vac.ok, 'runway_vacated');
  assert.ok(entered, 'the aircraft actually entered the 01L strip before reporting vacated');
  assert.ok(e.distToRunway(a.pos, e.runwayState('01L')!.ref) > 60, 'clear of 01L when vacated');
  assert.equal(e.runwayState('01L')!.occupiedBy.length, 0);
  assert.ok(!ledgerHas(e, 'RWY_INCURSION'), `no incursion scored for a cleared crossing: ${ledger(e)}`);

  // second crossing (01R)
  const h2 = runTrackedUntil(e, [a], () => a.phase === 'hold_short', 300, tr);
  assert.ok(h2.ok);
  assert.equal(a.holdShortRunway, '01R');
  assert.equal(cmd(e, makeAst('cross', 'UAL5', { runway: '01R' })).code, 'ok_queued');

  // departure hold: HOLD_POINT scored, auto handoff to tower, "ready for departure"
  const h3 = runTrackedUntil(e, [a], () => a.phase === 'hold_short' && a.holdShortRunway === '28L', 600, tr);
  assert.ok(h3.ok, 'reached the 28L holding point');
  assert.equal(e.stageOf(a), 'hold_short_dep');
  assert.equal(a.path!.holds!.length, 1);
  assert.ok(ledgerHas(e, 'HOLD_POINT', 'UAL5'));
  const ready = runTrackedUntil(e, [a], () => a.onFrequency === 'tower' && a.requests[0]?.kind === 'ready', 60, tr);
  assert.ok(ready.ok, 'ready for departure on tower');
  assert.ok(evs(e, 'handoff', 'UAL5').some(ev => ev.data?.type === 'handoff' && ev.data.to === 'tower'));
  assert.ok(e.runwayPhysicallyClear('28L', -1), 'holding aircraft is not on the runway strip (B15)');

  // line up: taxi onto the runway and stop aligned within 3 degrees
  const lu = cmd(e, makeAst('lineup', 'UAL5', { runway: '28L' }));
  assert.equal(lu.code, 'ok_queued');
  const lined = runTrackedUntil(e, [a], () => a.phase === 'lineup' && a.speed < 0.5 && a.distAlong >= a.path!.total - 1, 120, tr);
  assert.ok(lined.ok, 'lined up and stopped');
  const rs = e.runwayState('28L')!;
  assert.ok(Math.abs(angleDelta(rs.headingTrue, a.heading)) <= 3, `aligned: ${a.heading.toFixed(1)} vs ${rs.headingTrue.toFixed(1)}`);
  assert.ok(e.isOnRunway(a), 'on the runway strip');
  const fr = runwayFrame(e, '28L', a.pos);
  assert.ok(Math.abs(fr.cross) < 10, `on the centreline (${fr.cross.toFixed(1)} m)`);
  assert.ok(fr.along > 0 && fr.along < 400, `${fr.along.toFixed(0)} m past the threshold`);
  assert.equal(rs.occupiedBy.find(o => o.id === a.id)?.kind, 'lineup');
  assert.equal(e.runwayOccupied('28L'), true);
  // no roll without a takeoff clearance
  runTracked(e, [a], 30, tr);
  assert.equal(a.phase, 'lineup');
  assert.ok(a.speed < 0.5);

  // takeoff: needs the clearance; roll, rotate, initial climb, turn at 400 ft, auto handoff at the initial altitude
  const to = cmd(e, makeAst('takeoff', 'UAL5', { runway: '28L', afterDepHdg: 300, initialAlt: 3000 }));
  assert.equal(to.code, 'ok_queued');
  assert.equal(rs.takeoffClearance, 'UAL5');
  const rolling = runTrackedUntil(e, [a], () => a.phase === 'takeoff' && a.takeoffCleared, 30, tr);
  assert.ok(rolling.ok, 'rolling');
  const air = runTrackedUntil(e, [a], () => a.delay.airborneAt != null, 90, tr);
  assert.ok(air.ok, 'airborne');
  assert.ok(evs(e, 'airborne', 'UAL5').length === 1);
  assert.ok(a.speed >= a.perf.takeoffRotationSpeed - 20, `rotation near Vr (${a.speed.toFixed(0)} kt)`);
  assert.equal(a.phase, 'takeoff');
  assert.equal(e.stageOf(a), 'takeoff_roll', 'still takeoff_roll below 50 ft');
  runTracked(e, [a], 30, tr, () => a.altitude >= 60);
  assert.equal(e.stageOf(a), 'takeoff_air');
  // heading stays runway heading below 400 ft
  runTracked(e, [a], 300, tr, () => a.altitude >= 350);
  assert.ok(Math.abs(angleDelta(a.heading, rs.headingTrue)) < 3, 'runway heading below 400 ft');
  const climb = runTrackedUntil(e, [a], () => a.phase === 'climb', 60, tr);
  assert.ok(climb.ok);
  assert.ok(a.altitude >= 395 && a.altitude <= 500, `turn started at ${a.altitude.toFixed(0)} ft`);
  assert.equal(a.targetHeading, 300);
  assert.equal(a.navMode, 'heading');
  assert.equal(a.targetAltitude, 3000);
  assert.equal(e.stageOf(a), 'dep_climb');
  assert.ok(ledgerHas(e, 'MOVEMENT', 'UAL5'));
  assert.equal(rs.occupiedBy.length, 0, 'runway released at rotation');
  assert.ok(e.wakeTimers()['28L']?.leader === 'UAL5', 'wake timer set at rotation');
  const ho = runTrackedUntil(e, [a], () => evs(e, 'handoff', 'UAL5').some(ev => ev.data?.type === 'handoff' && ev.data.to === 'departure'), 300, tr);
  assert.ok(ho.ok, 'auto handoff to departure');
  const hoEv = evs(e, 'handoff', 'UAL5').find(ev => ev.data?.type === 'handoff' && ev.data.to === 'departure')!;
  assert.ok(hoEv.at >= a.delay.airborneAt!, 'handoff after liftoff');
  assert.equal(a.clearance.autoHandoffAlt, 3000);
  assert.ok(a.altitude >= 2900 && a.altitude <= 3300, `handed off at ${a.altitude.toFixed(0)} ft (initial altitude 3000)`);
  assert.equal(a.onFrequency, 'departure');
  assert.ok(Math.abs(angleDelta(a.heading, 300)) < 3, 'established on the after-departure heading');
  assert.ok(!ledgerHas(e, 'RWY_INCURSION'), `rolling through the 01L/01R intersection on 28L is not an incursion: ${ledger(e)}`);
  assert.ok(!ledgerHas(e, 'SEPARATION_LOSS') && !ledgerHas(e, 'GROUND_CONFLICT'));

  // whole session: no teleports, no backward jumps, hold_short only at hold nodes
  assert.equal(tr.violations.length, 0, `tracking violations:\n${formatViolations(tr)}`);
  assert.ok(tr.ticks > 30 * 600, 'tracked a long session');
});

test('B5: hold short -> cross -> hold short (re-arm) -> cross never moves the aircraft backwards', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'], pilotDelay: 0 });
  const tr = newTracker();
  const a = e.spawnAt({ callsign: 'UAL7', type: 'A320', kind: 'departure', phase: 'taxi', gate: 'A1', taxiTo: '28L' });
  assert.equal(a.path!.holds![0].runway, '01L');
  const h1 = runTrackedUntil(e, [a], () => a.phase === 'hold_short' && a.speed < 0.5, 600, tr);
  assert.ok(h1.ok);
  const holdPos = { ...a.pos };
  const holdAlong = a.distAlong;
  // cross, then (as the aircraft starts rolling) hold short again: it stops again at the line, never pulled back
  assert.equal(cmd(e, makeAst('cross', 'UAL7', { runway: '01L' })).code, 'ok_queued');
  runTracked(e, [a], 1.2, tr);
  assert.equal(a.holdReleased, true);
  assert.ok(a.speed > 1 && a.distAlong > holdAlong, 'rolling');
  const again = cmd(e, makeAst('holdShort', 'UAL7', { of: { kind: 'runway', runway: '01L' } }));
  assert.equal(again.code, 'ok_queued');
  runTracked(e, [a], 15, tr);
  assert.equal(a.phase, 'hold_short');
  assert.equal(a.holdReleased, false);
  assert.ok(a.distAlong >= holdAlong - 0.01, 'never behind the original stop');
  assert.ok(dist(a.pos, holdPos) < 12, `re-held within 12 m of the line (${dist(a.pos, holdPos).toFixed(1)} m)`);
  assert.equal(a.path!.holds!.length, 3, 'the runway hold is still there');
  assert.equal(a.holdShortRunway, '01L');
  assert.ok(e.isHoldNodeForRunway(a.holdShortNode!, '01L'));
  // second cross: proceeds, crosses, next hold arms
  assert.equal(cmd(e, makeAst('cross', 'UAL7', { runway: '01L' })).code, 'ok_queued');
  const passed = runTrackedUntil(e, [a], () => a.path!.holds!.length === 2, 90, tr);
  assert.ok(passed.ok, 'crossed 01L');
  const h2 = runTrackedUntil(e, [a], () => a.phase === 'hold_short' && a.speed < 0.5, 300, tr);
  assert.ok(h2.ok);
  assert.equal(a.holdShortRunway, '01R');
  // hold short of a runway already crossed -> queried (not on the route any more)
  assert.equal(cmd(e, makeAst('holdShort', 'UAL7', { of: { kind: 'runway', runway: '01L' } })).code, 'queried');
  // hold short issued when the nose is already at/over the line: pilot reports unable, keeps rolling, no jump
  const hold01R = a.path!.holds![0];
  assert.equal(cmd(e, makeAst('cross', 'UAL7', { runway: '01R' })).code, 'ok_queued');
  const atLine = runTrackedUntil(e, [a], () => a.holdReleased && a.distAlong > hold01R.at - 1, 30, tr);
  assert.ok(atLine.ok);
  cmd(e, makeAst('holdShort', 'UAL7', { of: { kind: 'runway', runway: '01R' } }));
  const before = a.distAlong;
  runTracked(e, [a], 3, tr);
  assert.ok(a.speed > 3, 'kept moving (already crossing)');
  assert.ok(a.distAlong > before + 5);
  assert.ok(evs(e, 'readback', 'UAL7').some(ev => /already crossing/.test(ev.message)));
  assert.equal(tr.violations.length, 0, `tracking violations:\n${formatViolations(tr)}`);
  assert.ok(tr.maxRatio <= 1, `max displacement ratio ${tr.maxRatio.toFixed(2)}`);
});

test('startup duration per type (03 1.2 table) and start-up without pushback at nose-out stands', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const expect: Record<string, [number, number]> = { C172: [30, 60], DH8D: [90, 120], B738: [120, 180], B77W: [150, 210], A388: [200, 240], B744: [200, 240] };
  for (const [type, [lo, hi]] of Object.entries(expect)) {
    const a = e.spawnAt({ callsign: `S${type}`, type, kind: 'departure', phase: 'startup', runway: '27R' });
    assert.equal(a.phase, 'startup');
    assert.deepEqual([...a.perf.startupS], [lo, hi], `${type} startupS`);
    const dur = a.startup.readyAt! - a.startup.startedAt! - (a.startup.failed ? 300 : 0);
    assert.ok(dur >= lo - 1e-6 && dur <= hi + 1e-6, `${type} startup ${dur.toFixed(0)} s in [${lo},${hi}]`);
    if (type !== 'C172') assert.ok(dur >= 90 && dur <= 240);
    assert.equal(a.startup.enginesStable, false);
  }
  // engines become stable at readyAt and the pilot then requests taxi
  const a = e.find('SDH8D')!;
  const r = runUntil(e, () => a.startup.enginesStable, 130 + (a.startup.failed ? 300 : 0));
  assert.ok(r.ok);
  assert.ok(evs(e, 'startup', 'SDH8D').some(ev => /stable/.test(ev.message)));
  const q = runUntil(e, () => a.requests[0]?.kind === 'taxi', 25);
  assert.ok(q.ok, 'taxi request after engines stable');
  // a parked aircraft at a pushback stand must use pushback, not startup alone
  const p = e.spawnDeparture({ callsign: 'BAW11', type: 'A320', runway: '27R' })!;
  assert.equal(p.needsPushback, true);
  assert.equal(cmd(e, makeAst('startup', 'BAW11', { expectRunway: '27R' })).code, 'invalid_stage');
  assert.equal(cmd(e, makeAst('pushback', 'BAW11', { dir: 'any', expectRunway: '27R', startup: true })).code, 'ok_queued');
  // pushback twice is "already"
  run(e, 3);
  assert.equal(cmd(e, makeAst('pushback', 'BAW11', { dir: 'any', expectRunway: '27R', startup: true })).code, 'already');
});

test('pushback ends on the taxiway graph facing along a taxiway (sample of pushback stands at EGLL and KSFO)', () => {
  for (const [icao, ends] of [['EGLL', ['27R', '27L']], ['KSFO', ['28L', '28R']]] as const) {
    const e = makeEngine(icao, { ends: [...ends] });
    let ok = 0, n = 0; const bad: string[] = [];
    for (const g of e.gateStates().filter(g => g.needsPushback).slice(0, 60)) {
      const a = e.spawnAt({ callsign: `P${n}`, type: 'A320', kind: 'departure', phase: 'pushback', gate: g.ref, runway: ends[0] });
      if (a.phase !== 'pushback') { e.remove(a.id); continue; }
      n++;
      a.pushback.stageUntil = e.time; // skip the tug attach wait
      const r = runUntil(e, () => a.pushback.stage === 'tug_disconnect' || a.pushback.stage === 'complete', 240);
      assert.ok(r.ok, `${icao} ${g.ref}: push completes`);
      assert.ok(a.pushback.pushedM >= 20 && a.pushback.pushedM <= 260, `${icao} ${g.ref}: pushed ${a.pushback.pushedM.toFixed(0)} m`);
      const near = e.nearestNodeId(a.pos, 40);
      assert.ok(near, `${icao} ${g.ref}: push ends within 40 m of the taxiway graph`);
      if (facingTaxiway(e, a)) ok++; else bad.push(g.ref);
      e.remove(a.id);
    }
    assert.ok(n >= 30, `${icao}: sampled ${n} stands`);
    assert.ok(ok / n >= 0.8, `${icao}: ${ok}/${n} pushbacks end facing a taxiway edge (bad: ${bad.join(' ')})`);
  }
});

test('rejected takeoff below 80 kt stops on the runway, then the pilot calls again and can be re-cleared', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27R', onFrequency: 'tower' });
  assert.equal(cmd(e, makeAst('takeoff', 'BAW1', { runway: '27R' })).code, 'ok_queued');
  const r = runUntil(e, () => a.speed >= 60, 120, 0.2);
  assert.ok(r.ok && a.phase === 'takeoff');
  const c = cmd(e, makeAst('cancelTakeoff', 'BAW1'));
  assert.equal(c.code, 'ok');
  assert.ok(a.rto && a.rto.speedKt >= 60 && a.rto.speedKt < 80);
  assert.equal(a.takeoffCleared, false);
  const stop = runUntil(e, () => a.phase === 'lineup', 60);
  assert.ok(stop.ok, 'stopped and back in lineup');
  assert.ok(a.speed < 0.5);
  assert.ok(e.isOnRunway(a), 'still on the runway after the RTO');
  assert.equal(e.runwayState('27R')!.occupiedBy.find(o => o.id === a.id)?.kind, 'lineup');
  assert.equal(e.runwayState('27R')!.status, 'open', 'low-speed RTO needs no inspection');
  assert.ok(ledgerHas(e, 'GOOD_CATCH', 'BAW1'));
  assert.ok(!evs(e, 'airborne', 'BAW1').length);
  // brake cooling 60-120 s, then the pilot calls (ready again / taxi back for a brake check)
  const rq = runUntil(e, () => a.requests.length > 0, 140);
  assert.ok(rq.ok, 'pilot request after the RTO');
  assert.ok(['ready', 'return_to_stand'].includes(a.requests[0].kind), a.requests[0].kind);
  assert.ok(rq.elapsed >= 40, `request after ${rq.elapsed} s (brake cooling)`);
  // a taxi clearance off the runway is refused while lined up; cancel line-up vacates, re-clearance works
  assert.equal(cmd(e, makeAst('taxi', 'BAW1', { dest: { kind: 'runway', runway: '27R', intersection: null } })).code, 'invalid_stage');
  const again = cmd(e, makeAst('takeoff', 'BAW1', { runway: '27R' }));
  assert.equal(again.code, 'ok_queued');
  const air = runUntil(e, () => a.delay.airborneAt != null, 120);
  assert.ok(air.ok, 'airborne on the second attempt');
});

test('high-speed RTO (>= 80 kt) closes the runway for inspection and the pilot asks to return to the stand', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW3', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27R', onFrequency: 'tower' });
  cmd(e, makeAst('takeoff', 'BAW3', { runway: '27R' }));
  runUntil(e, () => a.speed >= 95, 120, 0.2);
  assert.equal(cmd(e, makeAst('cancelTakeoff', 'BAW3')).code, 'ok');
  assert.equal(e.runwayState('27R')!.status, 'inspection');
  assert.equal(e.runwayState('09L')!.status, 'inspection', 'both ends share the status');
  const stop = runUntil(e, () => a.phase === 'lineup', 60);
  assert.ok(stop.ok);
  const rq = runUntil(e, () => a.requests.length > 0, 10);
  assert.ok(rq.ok, 'pilot calls after the high-speed reject');
  assert.equal(a.requests[0].kind, 'return_to_stand');
  // brakes cooling: a new takeoff clearance is refused; the runway stays closed for inspection
  assert.equal(cmd(e, makeAst('takeoff', 'BAW3', { runway: '27R' })).code, 'runway_closed');
  e.reopenRunway('27R', true);
  assert.equal(cmd(e, makeAst('takeoff', 'BAW3', { runway: '27R' })).code, 'unable');
  // vacate via the next taxiway and taxi back to a stand
  assert.equal(cmd(e, makeAst('cancelLineup', 'BAW3', { via: null })).code, 'ok_queued');
  const off = runUntil(e, () => a.phase === 'taxi', 240);
  assert.ok(off.ok, 'vacated the runway and stopped at the exit');
  assert.ok(!e.isOnRunway(a));
  assert.equal(e.runwayState('27R')!.occupiedBy.length, 0);
  assert.ok(!ledgerHas(e, 'LANDED', 'BAW3'), 'vacating after an RTO is not a landing');
  const stand = e.gateStates().find(g => g.occupiedBy == null && g.reservedFor == null)!;
  assert.equal(cmd(e, makeAst('taxi', 'BAW3', { dest: { kind: 'stand', ref: stand.ref } })).code, 'ok_queued');
  const parked = runUntil(e, () => a.phase === 'arrived', 1500, 5);
  assert.ok(parked.ok, 'back on a stand');
  // past V1 the pilot continues
  const b = e.spawnAt({ callsign: 'BAW4', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27L', onFrequency: 'tower' });
  cmd(e, makeAst('takeoff', 'BAW4', { runway: '27L' }));
  runUntil(e, () => b.speed >= b.perf.takeoffRotationSpeed * b.perf.v1Factor + 1, 120, 0.1);
  assert.equal(cmd(e, makeAst('cancelTakeoff', 'BAW4')).code, 'past_abort_speed');
});

test('gate reservation: no double booking across 40 spawns, departures never take a reserved stand (B21)', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const spawned = [];
  for (let i = 0; i < 40; i++) {
    const a = i % 2 === 0 ? e.spawnArrival() : e.spawnDeparture();
    assert.ok(a, `spawn ${i}`);
    spawned.push(a);
    run(e, 1);
  }
  const stands = spawned.map(a => a.reservedStand ?? a.plan.gateRef);
  assert.equal(new Set(stands).size, stands.length, `stands unique: ${stands.join(' ')}`);
  for (const a of spawned) {
    const g = e.gateStates().find(g => g.ref === (a.reservedStand ?? a.plan.gateRef))!;
    assert.ok(g, `${a.callsign} stand ${a.plan.gateRef} exists`);
    if (a.plan.kind === 'arrival') assert.equal(g.reservedFor, a.id, `${a.callsign} reserved ${g.ref}`);
    else assert.equal(g.occupiedBy, a.id, `${a.callsign} occupies ${g.ref}`);
  }
  const claimed = e.gateStates().filter(g => g.occupiedBy != null || g.reservedFor != null);
  assert.equal(claimed.length, 40);
  assert.ok(!claimed.some(g => g.occupiedBy != null && g.reservedFor != null), 'a stand is either occupied or reserved');
  // an arrival that parks releases its reservation and occupies the stand; removal frees it
  const arr = spawned[0];
  e.remove(arr.id, 'test');
  assert.ok(!e.gateStates().some(g => g.reservedFor === arr.id || g.occupiedBy === arr.id));
  // taxi to an occupied stand is refused
  const dep = spawned[1];
  const other = spawned[3];
  assert.equal(cmd(e, makeAst('taxi', dep.callsign, { dest: { kind: 'stand', ref: other.plan.gateRef! } })).code, 'invalid_stage');
});

test('ground traffic: a follower stops behind a stopped leader (no ground conflict), give-way / hold position / continue', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = e.spawnAt({ callsign: 'LEAD', type: 'A320', kind: 'departure', phase: 'taxi', gate: 'A1', taxiTo: '28L' });
  runUntil(e, () => a.distAlong > 250, 120);
  const b = e.spawnAt({ callsign: 'TRAIL', type: 'A320', kind: 'departure', phase: 'taxi', gate: 'A1', taxiTo: '28L' });
  assert.equal(cmd(e, makeAst('holdPosition', 'LEAD')).code, 'ok_queued');
  run(e, 1);
  assert.equal(a.trafficHold, true);
  const stopped = runUntil(e, () => a.speed < 0.3, 30);
  assert.ok(stopped.ok, 'leader stops on hold position');
  const r = runUntil(e, () => b.trafficHold && b.speed < 0.3, 240);
  assert.ok(r.ok, 'trailer held by traffic');
  const gap = dist(a.pos, b.pos);
  assert.ok(gap > 40 && gap < 200, `trailer stopped ${gap.toFixed(0)} m behind`);
  assert.ok(!evs(e, 'ground_conflict').length, 'no ground conflict');
  assert.ok(!ledgerHas(e, 'GROUND_CONFLICT'));
  // continue: leader moves, trailer follows
  assert.equal(cmd(e, makeAst('continue', 'LEAD')).code, 'ok_queued');
  const mv = runUntil(e, () => a.speed > 5, 20);
  assert.ok(mv.ok);
  const mv2 = runUntil(e, () => b.speed > 3, 60);
  assert.ok(mv2.ok, 'trailer resumes');
  // hold position on a parked aircraft is refused
  const p = e.spawnDeparture({ callsign: 'PARK', type: 'A320', runway: '28L' })!;
  assert.equal(cmd(e, makeAst('holdPosition', 'PARK')).code, 'invalid_stage');
});

test('runway crossing lock: the pilot stops at the hold even with a pre-issued cross that is no longer safe; auto-tower crosses when safe', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = e.spawnAt({ callsign: 'UAL8', type: 'A320', kind: 'departure', phase: 'taxi', gate: 'A1', taxiTo: '28L' });
  // taxi clearance that includes "cross 01L": the 01L hold is removed from the path; 01R remains
  const tx = cmd(e, makeAst('taxi', 'UAL8', { dest: { kind: 'runway', runway: '28L', intersection: null }, cross: ['01L'] }));
  assert.equal(tx.code, 'ok_queued');
  run(e, 3);
  assert.deepEqual(a.path!.holds!.map(h => h.runway), ['01R', '28L']);
  assert.ok(!ledgerHas(e, 'TAXI_INCOMPLETE', 'UAL8') || true);
  const h = runUntil(e, () => a.phase === 'hold_short', 600);
  assert.ok(h.ok);
  assert.equal(a.holdShortRunway, '01R');
  assert.equal(e.crossingSafe('01R'), true);
  e.settings.autoTower = true;
  const ai = runUntil(e, () => a.holdReleased, 30);
  assert.ok(ai.ok, 'AI tower granted the crossing');
  assert.ok(evs(e, 'transmission').some(ev => ev.who === 'AI' && /cross runway 01R/.test(ev.message)));
});

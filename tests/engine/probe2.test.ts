import { test } from 'node:test';
import { makeEngine, run, runUntil, cmd, byCs } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { NM_TO_M } from '../../src/lib/sim/projection';

test('probe arrival lifecycle at EGLL', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW22', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 2, altFt: 4000 }, heading: 240, speedKts: 210 });
  console.log('spawned', a.callsign, a.phase, 'stage', e.stageOf(a), 'stand', a.plan.gateRef, 'rwy', a.plan.runway, 'onfreq', a.onFrequency, 'dist', (e.distToThresholdNM(a, '27L') ?? 0).toFixed(1));
  let o = cmd(e, makeAst('altitude', 'BAW22', { ft: 3000 }));
  console.log('alt', o.code);
  o = cmd(e, makeAst('ils', 'BAW22', { runway: '27L' }));
  console.log('ils', o);
  const r1 = runUntil(e, () => a.ilsCaptured, 300);
  console.log('captured', r1.ok, r1.elapsed, 'd', (e.distToThresholdNM(a, '27L') ?? 0).toFixed(1), 'alt', a.altitude.toFixed(0), 'stage', e.stageOf(a));
  const r2 = runUntil(e, () => a.phase === 'landing', 300);
  console.log('landing phase', r2.ok, r2.elapsed, 'd', (e.distToThresholdNM(a, '27L') ?? 0).toFixed(1), 'alt', a.altitude.toFixed(0), 'gs', a.gsCaptured, 'onfreq', a.onFrequency, 'thrDist', Math.round(a.thresholdDist), 'total', Math.round(a.path?.total ?? 0));
  const r3 = runUntil(e, () => (e.distToThresholdNM(a, '27L') ?? 0) < 4.5, 300);
  console.log('4.5nm', r3.ok, r3.elapsed, 'req', a.requests[0]?.kind, 'stage', e.stageOf(a));
  o = cmd(e, makeAst('clearedLand', 'BAW22', { runway: '27L' }));
  console.log('cleared land', o);
  const r4 = runUntil(e, () => a.phase === 'rollout', 300);
  const thr = e.thresholdXY('27L')!; const rs = e.runwayState('27L')!;
  const { alongTrack, crossTrack } = require('../../src/lib/sim/projection');
  console.log('touchdown', r4.ok, r4.elapsed, 'along', Math.round(alongTrack(a.pos, thr, rs.headingTrue)), 'cross', Math.round(crossTrack(a.pos, thr, rs.headingTrue)), 'spd', a.speed.toFixed(0));
  const r5 = runUntil(e, () => e.events.some(ev => ev.type === 'runway_vacated' && ev.callsign === 'BAW22'), 200);
  console.log('vacated', r5.ok, r5.elapsed, 'phase', a.phase, 'spd', a.speed.toFixed(0), 'dist rwy', Math.round(e.distToRunway(a.pos, rs.ref)), 'info', e.events.filter(ev => ev.callsign === 'BAW22' && ev.type === 'info').map(ev => ev.message).slice(-3));
  const r6 = runUntil(e, () => a.requests[0]?.kind === 'taxi_in', 120);
  console.log('taxi_in req', r6.ok, r6.elapsed, 'phase', a.phase, 'onfreq', a.onFrequency, 'stage', e.stageOf(a));
  o = cmd(e, makeAst('taxi', 'BAW22', { dest: { kind: 'stand', ref: a.plan.gateRef! } }));
  console.log('taxi stand', o);
  const r7 = runUntil(e, () => a.phase === 'arrived', 1200);
  console.log('arrived', r7.ok, r7.elapsed, 'holds passed', e.events.filter(ev => ev.callsign === 'BAW22' && ev.type === 'reached_hold').map(ev => ev.message));
  console.log('score', e.stats.points, e.stats.ledger.map(l => l.code), 'occupants', e.runwayState('27L')!.occupiedBy);
});

test('probe no clearance -> go around', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = e.spawnAt({ callsign: 'UAL1', type: 'B738', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '28R', alongNM: -9, altFt: 2800 }, speedKts: 180, ils: '28R' });
  const r = runUntil(e, () => a.phase === 'go_around', 400);
  console.log('GA', r.ok, r.elapsed, 'd at GA', (e.distToThresholdNM(a, '28R') ?? 0).toFixed(2), 'alt', a.altitude.toFixed(0), e.events.filter(ev => ev.type === 'go_around').map(ev => ev.message), 'ledger', e.stats.ledger.map(l => l.code));
  const r2 = runUntil(e, () => a.altitude >= 2900, 300);
  console.log('climb', r2.ok, r2.elapsed, 'hdg', a.heading.toFixed(0), 'stage', e.stageOf(a), 'onfreq', a.onFrequency);
  cmd(e, makeAst('heading', 'UAL1', { hdg: 100, dir: 'L' }));
  run(e, 5);
  console.log('after heading: goAround', a.goAround, 'phase', a.phase, 'stage', e.stageOf(a));
});

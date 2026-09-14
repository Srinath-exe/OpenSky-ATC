// dispatch / executeText end-to-end against a real EGLL engine (OSM graph +
// airspace). Drives a full departure and a full arrival through typed
// commands, asserting CommandResult codes, TX / RB strings and the resulting
// aircraft state, plus the guard / validation / sequence / system paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, evs } from '../engine/helpers';
import type { SimEngine } from '../../src/lib/sim/engine';
import { dispatch, executeText, fromEngine, actionCtxFromEngine, attachCondition, guard, isSilent, SILENT_CODES } from '../../src/lib/sim/dispatch';
import type { DispatchResult } from '../../src/lib/sim/dispatch';
import { makeAst } from '../../src/lib/sim/commandAst';
import { parseCommand } from '../../src/lib/sim/commands';
import { REASONS, actionsFor } from '../../src/lib/sim/commandTree';
import { mkAircraft } from './helpers';

const say = (e: SimEngine, text: string): DispatchResult => executeText(e, text).result;
const ok = (r: DispatchResult, code?: string, label = '') => {
  assert.equal(r.ok, true, `${label} ${r.code}: ${r.reason ?? ''}`);
  if (code) assert.equal(r.code, code, label);
  assert.ok(r.transmission.length > 0, `${label} transmission`);
};

test('dispatch e2e: full departure BAW117 at EGLL by typed commands', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnDeparture({ callsign: 'BAW117', type: 'A320', runway: '27R', stand: '701' })!;   // pinned: the seeded stand pick shifts whenever the OSM stand set changes
  assert.equal(e.stageOf(a), 'parked');
  assert.ok(runUntil(e, () => a.requests.some(r => r.kind === 'pushback'), 120).ok, 'pilot requests pushback');

  // wrong stage -> silent SYS line with the canonical reason
  const early = say(e, 'BAW117 taxi 27R');
  assert.equal(early.ok, false);
  assert.equal(early.code, 'invalid_stage');
  assert.equal(early.reason, REASONS.X1);
  assert.equal(early.transmission, '');
  assert.ok(isSilent(early.code));

  const t0 = e.time;
  const push = say(e, 'BAW117 pushback approved, start up approved, expect runway 27R');
  ok(push, 'ok_queued', 'pushback');
  assert.equal(push.transmission, 'Speedbird one one seven, start-up and pushback approved, expect runway two seven right.');
  assert.equal(push.readback, 'Start-up and pushback approved, expect runway two seven right, Speedbird one one seven.');
  assert.equal(push.applyAt, t0 + 2, 'pilot delay override 2 s');
  assert.equal(push.readbackAt, t0 + 2);
  assert.deepEqual(push.warnings, []);
  assert.ok(a.pendingCmds.some(c => c.kind === 'pushback'), 'queued behind the pilot delay');
  assert.equal(a.requests.some(r => r.kind === 'pushback' && r.answeredAt == null), false, 'request answered');
  const tx = evs(e, 'transmission', 'BAW117');
  assert.equal(tx[tx.length - 1].message, push.transmission, 'transmission event carries the ATC line');
  run(e, 3);
  const rb = evs(e, 'readback', 'BAW117');
  assert.equal(rb[rb.length - 1].message, push.readback, 'readback event at readbackAt');

  assert.ok(runUntil(e, () => a.phase === 'startup' && a.pushback.stage === 'complete', 300).ok, 'pushback completes');
  assert.ok(runUntil(e, () => a.startup.enginesStable, 400).ok, 'engines stable');
  assert.ok(runUntil(e, () => a.requests.some(r => r.kind === 'taxi' && r.answeredAt == null), 90).ok, 'pilot requests taxi');
  assert.equal(e.stageOf(a), 'startup');

  const badVia = say(e, 'speedbird 117 taxi to holding point runway 27R via Q');
  assert.equal(badVia.code, 'unknown_taxiway');
  assert.equal(badVia.transmission, '');
  const taxi = say(e, 'speedbird 117 taxi to holding point runway 27R');
  ok(taxi, 'ok_queued', 'taxi');
  assert.equal(taxi.transmission, 'Speedbird one one seven, taxi to holding point runway two seven right.');
  assert.equal(taxi.readback, 'Holding point runway two seven right, Speedbird one one seven.');
  assert.ok(runUntil(e, () => a.phase === 'taxi', 30).ok, 'taxi starts');
  assert.equal(e.stageOf(a), 'taxi_out');
  assert.ok((a.plan.taxiRoute ?? []).length > 0, 'route planned');
  assert.ok(a.path?.holds?.some(h => h.isDepartureEntry && h.runway === '27R'), 'hold-short place at the 27R entry');

  const hold = say(e, 'BAW117 hold position');
  ok(hold, undefined, 'hold position');
  assert.equal(hold.readback, 'Holding position, Speedbird one one seven.');
  run(e, 8);
  assert.ok(a.speed < 1, 'stopped');
  const cont = say(e, 'BAW117 continue taxi');
  ok(cont, 'ok_queued', 'continue');
  assert.equal(cont.transmission, 'Speedbird one one seven, continue taxi.');
  assert.ok(runUntil(e, () => a.phase === 'hold_short', 900).ok, 'reaches the holding point');
  assert.equal(e.stageOf(a), 'hold_short_dep');
  assert.equal(a.holdShortRunway, '27R');
  assert.ok(runUntil(e, () => a.onFrequency === 'tower' && a.requests.some(r => r.kind === 'ready' && r.answeredAt == null), 90).ok, 'auto handoff to tower + ready call');

  const rows = actionsFor(a, actionCtxFromEngine(e, a)!);
  assert.equal(rows.find(r => r.primary)?.id, 'action-takeoff', 'panel primary answer to "ready"');
  assert.equal(rows.find(r => r.id === 'action-lineup')?.state, 'enabled');

  const luaw = say(e, 'BAW117 line up and wait 27R');
  ok(luaw, 'ok_queued', 'lineup');
  assert.equal(luaw.transmission, 'Speedbird one one seven, runway two seven right, line up and wait.');
  assert.equal(luaw.readback, 'Runway two seven right, line up and wait, Speedbird one one seven.');
  assert.ok(runUntil(e, () => a.phase === 'lineup', 120).ok, 'lined up');
  assert.equal(e.stageOf(a), 'lineup');
  const again = say(e, 'BAW117 line up and wait 27R');
  assert.equal(again.code, 'already');
  assert.equal(again.reason, REASONS.R2);

  const wind = say(e, 'BAW117 wind check');
  ok(wind, 'ok', 'wind check');
  assert.match(wind.transmission, /^Speedbird one one seven, wind .* knots\.$/);
  assert.equal(wind.readback, 'Roger, Speedbird one one seven.');
  assert.equal(wind.applyAt, undefined, 'immediate kind');

  const cto = say(e, 'BAW117 fly runway heading, climb 5000, cleared for takeoff 27R');
  ok(cto, 'ok_queued', 'takeoff');
  assert.match(cto.transmission, /^Speedbird one one seven, wind .*, runway two seven right, fly runway heading, climb to fife thousand, cleared for takeoff\.$/);
  assert.equal(cto.readback, 'Runway heading, climb fife thousand, cleared for takeoff runway two seven right, Speedbird one one seven.');
  assert.equal(e.runwayState('27R')?.takeoffClearance, 'BAW117');
  assert.ok(runUntil(e, () => a.delay.airborneAt != null, 150).ok, 'airborne');
  assert.equal(a.clearance.initialAlt, 5000);
  assert.ok(runUntil(e, () => a.altitude > 1500, 120).ok);
  assert.ok(['takeoff_air', 'dep_climb'].includes(e.stageOf(a)));

  const hand = say(e, 'BAW117 contact departure');
  ok(hand, 'ok_queued', 'handoff');
  assert.equal(hand.transmission, 'Speedbird one one seven, contact departure one two fife decimal two zero zero.');
  assert.equal(hand.readback, 'Departure one two fife decimal two zero zero, good day, Speedbird one one seven.');
  run(e, 6);
  assert.equal(a.onFrequency, 'departure');

  const vec = say(e, 'BAW117 turn left heading 180 climb FL80');
  ok(vec, 'ok_queued', 'vector sequence');
  assert.equal(vec.transmission, 'Speedbird one one seven, turn left heading one eight zero, climb to flight level eight zero.');
  assert.equal(vec.readback, 'Left heading one eight zero, climb flight level eight zero, Speedbird one one seven.');
  assert.deepEqual(vec.appliedParts, ['Turn left heading 180', 'Altitude 8000']);
  run(e, 5);
  assert.equal(Math.round(a.targetHeading), 180);
  assert.equal(a.targetAltitude, 8000);
  assert.equal(a.navMode, 'heading');

  // validation layer: ceiling / MSA / envelope / parser value checks
  assert.equal(say(e, 'BAW117 climb FL250').code, 'invalid_param');
  assert.equal(say(e, 'BAW117 descend 500').code, 'invalid_param');
  const slow = say(e, 'BAW117 speed 110');
  assert.equal(slow.code, 'unable_envelope');
  assert.equal(slow.ok, false);
  assert.ok(slow.transmission.startsWith('Speedbird one one seven, reduce speed'), 'pilot-side refusal is transmitted');
  assert.match(slow.readback, /^Unable .*Speedbird one one seven\.$/);
  assert.equal(say(e, 'BAW117 turn left heading 240 then direct BIG').code, 'invalid_param', 'incompatible parts refused by the parser');
  const dct = say(e, 'BAW117 direct BIG then heading 240');
  ok(dct, 'ok_queued', 'direct then heading');
  assert.equal(dct.transmission, 'Speedbird one one seven, proceed direct BIG, then fly heading two four zero.');
  run(e, 5);
  assert.equal(a.navMode, 'direct');
  assert.equal(a.directTargetName, 'BIG');
  assert.ok(e.stats.transmissions >= 10);
});

test('dispatch e2e: full arrival DLH2 at EGLL by typed commands', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const b = e.spawnAt({ callsign: 'DLH2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 2, altFt: 4000 }, heading: 240, speedKts: 210 });
  assert.equal(e.stageOf(b), 'arr_inbound');
  assert.equal(b.onFrequency, 'approach');
  const stand = b.plan.gateRef!;
  assert.ok(stand, 'arrival reserved a stand at spawn');

  const tooEarly = say(e, 'DLH2 cleared to land 27L');
  assert.equal(tooEarly.code, 'invalid_stage');
  assert.equal(tooEarly.reason, 'Not on approach');

  const seq = say(e, 'lufthansa 2 descend 3000 then cleared ILS 27L');
  ok(seq, 'ok_queued', 'descend + ILS');
  assert.equal(seq.transmission, 'Lufthansa two, descend to tree thousand, cleared ILS approach runway two seven left, report established.');
  assert.equal(seq.readback, 'Descend tree thousand, cleared ILS runway two seven left, will report established, Lufthansa two.');
  assert.deepEqual(seq.appliedParts, ['Altitude 3000', 'Cleared ILS 27L, report established']);
  assert.ok(runUntil(e, () => b.ilsCaptured, 300).ok, 'localizer captured');
  assert.equal(e.stageOf(b), 'arr_established');
  assert.equal(b.assignedRunway, '27L');

  const captured = say(e, 'DLH2 turn left heading 180');
  assert.equal(captured.code, 'invalid_stage', 'vectors while established are hard-blocked (X4)');
  assert.equal(captured.reason, REASONS.X4);
  assert.equal(b.ilsCaptured, true, 'ILS untouched');

  const spd = say(e, 'DLH2 speed 160 until 4 mile final');
  ok(spd, 'ok_queued', 'speed');
  assert.equal(spd.transmission, 'Lufthansa two, reduce speed to one six zero knots until four mile final.');
  assert.equal(spd.readback, 'Speed one six zero knots until four miles, Lufthansa two.');
  run(e, 3);
  assert.equal(b.cmdIas, 160);

  const twr = say(e, 'DLH2 contact tower');
  ok(twr, 'ok_queued', 'contact tower');
  assert.equal(twr.transmission, 'Lufthansa two, contact tower one one eight decimal fife zero zero.');
  run(e, 6); // pilot delay (2 s) + frequency change (2 s)
  assert.equal(b.onFrequency, 'tower');
  assert.equal(b.goAround, false);

  assert.ok(runUntil(e, () => b.phase === 'landing', 300).ok, 'on final');
  const land = say(e, 'DLH2 cleared to land 27L');
  ok(land, 'ok_queued', 'landing clearance');
  assert.match(land.transmission, /^Lufthansa two, wind .*, runway two seven left, cleared to land\.$/);
  assert.equal(land.readback, 'Cleared to land runway two seven left, Lufthansa two.');
  run(e, 3);
  assert.equal(b.landingCleared, true);
  assert.ok(e.runwayState('27L')?.landingClearances.includes('DLH2'));
  const dup = say(e, 'DLH2 cleared to land 27L');
  assert.equal(dup.code, 'already');
  assert.equal(dup.transmission, '');

  assert.ok(runUntil(e, () => b.phase === 'rollout', 400).ok, 'touchdown');
  assert.equal(e.stageOf(b), 'rollout');
  assert.ok(runUntil(e, () => b.requests.some(r => r.kind === 'taxi_in' && r.answeredAt == null), 300).ok, 'pilot requests taxi in after vacating');
  assert.ok(evs(e, 'runway_vacated', 'DLH2').length > 0);
  const rows = actionsFor(b, actionCtxFromEngine(e, b)!);
  assert.equal(rows.find(r => r.primary)?.id, 'action-taxi-stand');

  const taxiIn = say(e, `DLH2 taxi to stand ${stand}`);
  ok(taxiIn, 'ok_queued', 'taxi in');
  assert.ok(taxiIn.transmission.startsWith('Lufthansa two, taxi to stand'), taxiIn.transmission);
  assert.ok(runUntil(e, () => b.phase === 'arrived', 1500).ok, 'arrived at the stand');
  assert.equal(e.stageOf(b), 'arrived');
  assert.ok(e.stats.ledger.some(l => l.code === 'LANDED' || l.code === 'MOVEMENT' || l.code === 'PARKED'), `ledger ${e.stats.ledger.map(l => l.code).join(',')}`);
  assert.ok(!e.stats.ledger.some(l => l.code === 'DIVERSION' || l.code === 'RWY_INCURSION'), 'clean flight');
});

test('dispatch: guards — not_found, paused, strict frequency (R13), ignoreFrequency, malformed values', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const b = e.spawnAt({ callsign: 'DLH2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 2, altFt: 4000 }, heading: 240, speedKts: 210 });
  const nf = say(e, 'XYZ9 descend 3000');
  assert.equal(nf.code, 'not_found');
  assert.equal(nf.transmission, '');
  const nf2 = dispatch(e, makeAst('altitude', 'XYZ9', { ft: 3000 }));
  assert.equal(nf2.code, 'not_found');
  e.paused = true;
  assert.equal(say(e, 'DLH2 descend 3000').code, 'paused');
  assert.equal(dispatch(e, makeAst('holdAll', null)).code, 'paused');
  e.paused = false;
  e.settings.strictFrequencies = true;
  e.playerPosition = 'tower';
  const off = say(e, 'DLH2 descend 3000');
  assert.equal(off.code, 'not_on_frequency');
  assert.equal(off.reason, REASONS.R13);
  assert.equal(b.pendingCmds.length, 0, 'nothing queued');
  const ai = dispatch(e, makeAst('altitude', 'DLH2', { ft: 3000 }), { who: 'ai' });
  ok(ai, 'ok_queued', 'AI positions bypass strict frequency');
  const forced = dispatch(e, makeAst('altitude', 'DLH2', { ft: 3500 }), { ignoreFrequency: true });
  ok(forced, 'ok_queued');
  e.playerPosition = 'approach';
  ok(say(e, 'DLH2 descend 3000'), 'ok_queued', 'own position');
  e.settings.strictFrequencies = false;
  assert.equal(dispatch(e, makeAst('squawk', 'DLH2', { code: '8888' })).code, 'invalid_param');
  assert.equal(dispatch(e, makeAst('heading', 'DLH2', { hdg: 400 })).code, 'invalid_param');
  assert.equal(dispatch(e, makeAst('cancelApproach', 'DLH2', { hdg: 0, alt: 0 })).reason, REASONS.R7);
  assert.equal(dispatch(e, makeAst('altitude', 'DLH2', { ft: 3050 })).code, 'invalid_param');
  assert.equal(dispatch(e, { kind: 'sequence', callsign: 'DLH2', parts: [] }).code, 'invalid_param');
  assert.equal(dispatch(e, { kind: 'sequence', callsign: 'DLH2', parts: [makeAst('altitude', 'DLH2', { ft: 3000 }), makeAst('speed', 'DLH2', { kts: 180 }), makeAst('heading', 'DLH2', { hdg: 90 }), makeAst('direct', 'DLH2', { fix: 'OCK' }), makeAst('ils', 'DLH2', { runway: '27L' })] }).reason, 'Max 1 base + 3 parts');
  assert.equal(dispatch(e, { kind: 'sequence', callsign: 'DLH2', parts: [makeAst('altitude', 'XYZ9', { ft: 3000 })] }).code, 'invalid_param', 'mixed callsigns');
  assert.equal(guard(makeAst('broadcast', null, { text: '  ' }), null, e)?.code, 'invalid_param');
  assert.ok(SILENT_CODES.includes('runway_occupied'));
  // validation can be bypassed for tests / AI
  const noVal = dispatch(e, makeAst('altitude', 'DLH2', { ft: 25000 }), { validate: false });
  assert.notEqual(noVal.code, 'invalid_param');
});

test('dispatch: sequences — rollback on a hard refusal, per-part reasons, readback/applyAt bounds', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const b = e.spawnAt({ callsign: 'DLH2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 2, altFt: 4000 }, heading: 240, speedKts: 210 });
  const before = b.pendingCmds.length;
  const r = say(e, 'DLH2 descend 3000 then cleared ILS 09L'); // 09L is not an active arrival runway -> engine refuses the ILS part
  assert.equal(r.ok, false);
  assert.ok(isSilent(r.code), r.code);
  assert.equal(r.transmission, '');
  assert.ok(r.reason?.startsWith('Cleared ILS 09L, report established: '), r.reason);
  assert.deepEqual(r.appliedParts, [], 'queued altitude rolled back');
  assert.equal(b.pendingCmds.length, before, 'nothing left in the pending queue');
  assert.equal(b.ilsArmed, false);
  const good = say(e, 'DLH2 turn left heading 240, descend 3000, speed 180');
  ok(good, 'ok_queued');
  assert.equal(good.appliedParts?.length, 3);
  assert.ok(good.readbackAt! <= good.applyAt!, 'readback never after execution');
  assert.equal(b.pendingCmds.filter(c => ['heading', 'altitude', 'speed'].includes(c.kind)).length, 3);
  run(e, 3);
  assert.equal(Math.round(b.targetHeading), 240);
  assert.equal(b.targetAltitude, 3000);
  assert.equal(b.targetSpeed, 180);
});

test('dispatch: disregard drops the newest pending command inside the window; nothing_pending afterwards', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const b = e.spawnAt({ callsign: 'DLH2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 2, altFt: 4000 }, heading: 240, speedKts: 210 });
  const h0 = b.targetHeading;
  ok(say(e, 'DLH2 turn left heading 180'), 'ok_queued');
  const undo = say(e, 'DLH2 disregard');
  ok(undo, 'ok', 'disregard');
  assert.equal(undo.transmission, 'Lufthansa two, disregard.');
  assert.equal(undo.readback, 'Disregard, Lufthansa two.');
  run(e, 4);
  assert.equal(Math.round(b.targetHeading), Math.round(h0), 'heading target restored');
  const nothing = say(e, 'DLH2 disregard');
  assert.equal(nothing.code, 'nothing_pending');
  assert.equal(nothing.transmission, '');
});

test('dispatch: system commands — vehicles, runway status, hold all / resume all', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const fire = say(e, 'dispatch fire 1 to runway 27L');
  ok(fire, 'ok', 'dispatch');
  assert.equal(fire.transmission, 'Fire 1, proceed to runway two seven left, runway is yours.');
  assert.equal(fire.readback, 'Proceeding to runway two seven left, Fire 1.');
  assert.equal(e.fleet.byId('FIRE1')?.state, 'enroute');
  const busy = say(e, 'dispatch fire 1 to runway 27R');
  assert.equal(busy.ok, false);
  const hold = say(e, 'fire 1 hold');
  ok(hold, undefined, 'vehicle hold');
  assert.equal(say(e, 'recall fire 9').code, 'unknown_vehicle');
  const rtb = say(e, 'fire 1 return to base');
  ok(rtb, undefined, 'vehicle rtb');
  const close = say(e, 'close runway 09L debris');
  ok(close, 'ok', 'close');
  assert.equal(close.transmission, 'All stations, runway zero niner left is closed, debris.');
  assert.equal(close.readback, '');
  assert.equal(e.runwayState('09L')?.status, 'closed');
  assert.equal(e.runwayState('27R')?.status, 'closed', 'both ends of the physical runway');
  const reopen = say(e, 'reopen 09L');
  ok(reopen, 'ok', 'reopen');
  assert.equal(e.runwayState('09L')?.status, 'open');
  assert.equal(say(e, 'close runway 18L').code, 'unknown_runway');
  const ha = say(e, 'hold all');
  ok(ha, 'ok', 'hold all');
  assert.equal(e.holdAllActive?.scope, 'all');
  assert.match(ha.transmission, /^All stations, .*hold position\.$/);
  ok(say(e, 'resume all'), 'ok', 'resume all');
  assert.equal(e.holdAllActive, null);
  const again = say(e, 'resume all');
  assert.equal(again.code, 'nothing_pending');
  assert.equal(again.transmission, '');
  const bc = say(e, 'broadcast runway change in progress');
  ok(bc, 'ok', 'broadcast');
  assert.match(bc.transmission, /runway change in progress/);
});

test('dispatch: parse failures map to silent codes and never reach the engine', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  e.spawnAt({ callsign: 'DLH2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 2, altFt: 4000 }, heading: 240, speedKts: 210 });
  const n = e.stats.transmissions;
  for (const [text, code] of [['', 'invalid_param'], ['DLH2 frobnicate', 'invalid_param'], ['ZZZ9 descend 3000', 'not_found'], ['DLH2 direct ZZZZZ', 'unknown_fix'], ['DLH2 cleared ILS 18L', 'unknown_runway'], ['DLH2 taxi to stand 9999', 'unknown_stand'], ['DLH2 cleared for the option', 'not_implemented']] as const) {
    const r = executeText(e, text);
    assert.equal(r.parse.ok, false, text);
    assert.equal(r.result.ok, false, text);
    assert.equal(r.result.code, code, `${text}: ${r.result.code}`);
    assert.equal(r.result.transmission, '');
    assert.ok(r.result.reason, 'reason from the parser');
    assert.ok(Array.isArray(r.result.warnings));
  }
  assert.equal(e.stats.transmissions, n, 'nothing transmitted');
  const p = executeText(e, 'DLH2 descend 3000');
  assert.equal(p.parse.ok, true);
  assert.equal(p.parse.callsign, 'DLH2');
  assert.equal(p.result.code, 'ok_queued');
});

test('dispatch: fromEngine / actionCtxFromEngine expose the live airport for the parser and the tree', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnDeparture({ callsign: 'BAW117', type: 'A320', runway: '27R', stand: '701' })!;   // pinned: the seeded stand pick shifts whenever the OSM stand set changes
  const b = e.spawnAt({ callsign: 'DLH2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 2, altFt: 4000 }, heading: 240, speedKts: 210 });
  const ctx = fromEngine(e, { lastCallsign: 'DLH2' });
  assert.deepEqual(ctx.aircraft!.map(x => x.callsign).sort(), ['BAW117', 'DLH2']);
  const dep = ctx.aircraft!.find(x => x.callsign === 'BAW117')!;
  assert.equal(dep.stage, 'parked');
  assert.equal(dep.plan?.runway, '27R');
  assert.equal(dep.plan?.gateRef, a.plan.gateRef);
  assert.equal(dep.id, a.id);
  assert.equal(dep.type, 'A320');
  assert.ok(dep.minCleanKt! >= 100);
  assert.equal(ctx.aircraft!.find(x => x.callsign === 'DLH2')?.stage, 'arr_inbound');
  assert.deepEqual([...ctx.runways!].sort(), ['09L', '09R', '27L', '27R']);
  assert.ok(ctx.taxiways!.includes('A1') && ctx.taxiways!.includes('N1'));
  assert.ok(ctx.fixes!.includes('BIG') && ctx.fixes!.includes('OCK'));
  assert.ok(ctx.stands!.includes(a.plan.gateRef!));
  assert.ok(ctx.vehicles!.includes('FIRE1'));
  assert.equal(ctx.lastCallsign, 'DLH2');
  assert.equal(typeof ctx.magVar, 'number');
  assert.equal(Math.round(ctx.runwayHeadingTrue!('27L')!), Math.round(e.runwayState('27L')!.headingTrue));
  assert.equal(ctx.runwayHeadingTrue!('18L'), null);
  assert.equal(ctx.intersectionNode!('A1', 'ZZ'), null);
  // verb-first line uses lastCallsign
  const r = executeText(e, 'descend 3000', ctx);
  assert.equal(r.parse.callsign, 'DLH2');
  assert.equal(r.result.code, 'ok_queued');
  const withActions = fromEngine(e, { withActions: true });
  assert.ok(withActions.aircraft!.find(x => x.callsign === 'BAW117')!.enabledActions!.includes('action-pushback'));

  const ac = actionCtxFromEngine(e, b)!;
  assert.equal(ac.stage, 'arr_inbound');
  assert.equal(ac.position, e.playerPosition);
  assert.equal(ac.hasIls, true);
  assert.equal(ac.hasRadar, true);
  assert.equal(ac.runways!.length, 4);
  assert.ok(ac.runways!.every(r => r.hasIls));
  assert.equal(ac.runwayStatus('27L'), 'open');
  assert.equal(ac.runwayActive('27L', 'arr'), true);
  assert.equal(ac.runwayActive('09L', 'arr'), false);
  assert.equal(ac.weightAllowed('27L'), true);
  assert.ok(ac.fixes!.some(f => f.name === 'OCK' && f.distNM > 0));
  assert.ok(ac.stands!.length > 100);
  assert.ok(ac.vehicles!.some(v => v.id === 'FIRE1' && v.available));
  assert.equal(ac.positions!.find(p => p.position === 'tower')?.freq, e.frequencies.tower);
  assert.ok(ac.phraseCtx);
  assert.equal(ac.runwayHeading!('27L'), e.runwayState('27L')!.headingTrue);
  const sys = actionCtxFromEngine(e, null)!;
  assert.equal(sys.stage, 'departed');
  assert.equal(sys.weightAllowed('27L'), true);
  const rows = actionsFor(b, ac);
  assert.ok(rows.some(r => r.id === 'action-ils' && r.state === 'enabled'));
  assert.ok(rows.some(r => r.id === 'action-heading' && r.state === 'enabled'));
});

test('legacy shim: parseCommand(engine, text) dispatches through the installed hook', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  e.spawnAt({ callsign: 'DLH2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 2, altFt: 4000 }, heading: 240, speedKts: 210 });
  const r = parseCommand(e, 'DLH2 descend 3000');
  assert.equal(r.ok, true, r.reply);
  assert.equal(r.reply, 'Descend tree thousand, Lufthansa two.');
  assert.equal(r.callsign, 'DLH2');
  const bad = parseCommand(e, 'DLH2 frobnicate');
  assert.equal(bad.ok, false);
  assert.match(bad.reply, /Unknown instruction/);
});

test('attachCondition: parser-detached conditions land on the just-queued command of that kind', () => {
  const a = mkAircraft({ callsign: 'BAW117' });
  a.pendingCmds = [
    { kind: 'taxi', value: 0, applyAt: 105, issuedAt: 100, cancellable: true },
    { kind: 'heading', value: 90, applyAt: 105, issuedAt: 100, cancellable: true, condition: { type: 'after_fix', fix: 'OCK' } },
  ];
  assert.equal(attachCondition(a, 'taxi', { type: 'after_pushback' }, 100), true);
  assert.deepEqual(a.pendingCmds[0].condition, { type: 'after_pushback' });
  assert.equal(attachCondition(a, 'heading', { type: 'when_ready' }, 100), false, 'existing condition wins');
  assert.equal(attachCondition(a, 'speed', { type: 'when_ready' }, 100), false, 'no such command');
  assert.equal(attachCondition(a, 'taxi', { type: 'when_ready' }, 200), false, 'issued at another time');
});

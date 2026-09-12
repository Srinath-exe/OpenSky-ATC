// One grammar, three inputs (UX §1.1 rule 3): the click tree (toAst) and the
// text parser must meet on the same CommandAST. Every describe() summary is
// itself parseable back to the AST that produced it, and toAst output for every
// action id survives describe() -> parse().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/lib/sim/commands';
import { toAst, ALL_ACTION_IDS } from '../../src/lib/sim/commandTree';
import type { ActionId, ActionParams } from '../../src/lib/sim/commandTree';
import { describe, makeAst } from '../../src/lib/sim/commandAst';
import type { CommandAST } from '../../src/lib/sim/commandAst';
import { mkAircraft, mkParseCtx } from './helpers';

const ctx = mkParseCtx();
const cs = 'DLH2';
const text = (ast: CommandAST) => ('callsign' in ast ? `${ast.callsign} ` : '') + describe(ast);

function roundTrip(ast: CommandAST, label = ''): void {
  const t = text(ast);
  const r = parseCommand(t, ctx);
  assert.equal(r.ok, true, `${label} "${t}": ${r.errors[0]?.code}: ${r.errors[0]?.message}`);
  assert.deepEqual(r.ast, ast, `${label} "${t}"`);
}

const ASTS: CommandAST[] = [
  makeAst('startup', 'BAW117', { expectRunway: '27R' }), makeAst('startup', 'BAW117'),
  makeAst('pushback', 'BAW117', { dir: 'N', expectRunway: '27R', startup: true }), makeAst('pushback', 'BAW117', { tailTo: 'A' }), makeAst('pushback', 'BAW117'),
  makeAst('taxi', 'BAW117', { dest: { kind: 'runway', runway: '27R', intersection: 'A1' }, via: ['A', 'B'], auto: false, holdShortOf: { kind: 'runway', runway: '27L' } }),
  makeAst('taxi', 'BAW117', { dest: { kind: 'stand', ref: '512' }, via: ['N'], auto: false, cross: ['27L'], expedite: true }),
  makeAst('taxi', 'BAW117', { dest: { kind: 'node', nodeId: 'A/B', label: 'A/B' }, auto: true }),
  makeAst('taxi', 'BAW117', { dest: { kind: 'runway', runway: '27R', intersection: null }, auto: true }),
  makeAst('taxi', 'BAW117', { dest: { kind: 'runway', runway: '27R', intersection: null }, via: ['A'], auto: false, holdShortOf: { kind: 'taxiway', taxiway: 'B' } }),
  makeAst('holdShort', 'BAW117', { of: { kind: 'runway', runway: '27L' } }), makeAst('holdShort', 'BAW117', { of: { kind: 'taxiway', taxiway: 'B' } }),
  makeAst('holdPosition', 'BAW117', { reason: 'traffic' }), makeAst('holdPosition', 'BAW117'),
  makeAst('continue', 'BAW117', { holdShortOf: { kind: 'runway', runway: '27L' } }), makeAst('continue', 'BAW117'),
  makeAst('cross', 'BAW117', { runway: '27L', expedite: true }), makeAst('cross', 'BAW117', { runway: '27L', behind: 'UAE5' }), makeAst('cross', 'BAW117', { runway: '27L' }),
  makeAst('giveWay', 'BAW117', { to: 'DLH2' }), makeAst('giveWay', 'BAW117', { to: 'DLH2', mode: 'follow' }),
  makeAst('lineup', 'BAW117', { runway: '27R', intersection: 'A1' }), makeAst('lineup', 'BAW117', { runway: '27R', behind: 'UAE5' }), makeAst('lineup', 'BAW117', { runway: '27R' }),
  makeAst('takeoff', 'BAW117', { runway: '27R', immediate: true, afterDepHdg: 250, initialAlt: 5000, contactDeparture: true }),
  makeAst('takeoff', 'BAW117', { runway: '27R', afterDepHdg: 'runway' }), makeAst('takeoff', 'BAW117', { runway: '27R', turn: { dir: 'L', deg: 20 } }), makeAst('takeoff', 'BAW117', { runway: '27R' }),
  makeAst('cancelTakeoff', 'BAW117', { reason: 'vehicle on runway' }), makeAst('cancelTakeoff', 'BAW117'),
  makeAst('cancelLineup', 'BAW117', { via: 'A' }), makeAst('cancelLineup', 'BAW117'),
  makeAst('exitAt', 'UAE5', { exit: { kind: 'taxiway', taxiway: 'A' }, expedite: true, holdShortOf: { kind: 'runway', runway: '27R' }, contactGround: true }),
  makeAst('exitAt', 'UAE5', { exit: { kind: 'next', dir: 'R' } }), makeAst('exitAt', 'RYR4', { exit: { kind: 'taxiway', taxiway: 'A' } }),
  makeAst('expedite', cs, { scope: 'descent' }), makeAst('expedite', 'BAW117', { scope: 'taxi' }), makeAst('expedite', 'AFR1170', { scope: 'crossing' }),
  makeAst('clearedLand', 'UAE5', { runway: '27L', number: 2, lahso: '09L', exit: { kind: 'taxiway', taxiway: 'A' } }),
  makeAst('clearedLand', 'UAE5', { runway: '27L', exit: { kind: 'next', dir: 'L' } }), makeAst('clearedLand', 'UAE5', { runway: '27L' }),
  makeAst('continueApproach', 'UAE5', { number: 2 }), makeAst('continueApproach', 'UAE5'),
  makeAst('goAround', 'UAE5', { heading: 'runway', alt: 3000, contact: 'approach' }), makeAst('goAround', 'UAE5', { heading: 250 }), makeAst('goAround', 'UAE5'),
  makeAst('windCheck', 'UAE5'),
  makeAst('contact', 'UAE5', { position: 'tower' }), makeAst('contact', 'UAE5', { position: 'ground', when: 'when_vacated' }),
  makeAst('contact', 'BAW117', { position: 'tower', when: 'at_hold' }), makeAst('contact', cs, { position: 'departure', when: 'on_reaching' }), makeAst('contact', cs, { position: 'external' }),
  makeAst('heading', cs, { hdg: 240, dir: 'L' }), makeAst('heading', cs, { hdg: 240 }), makeAst('heading', cs, { hdg: 360, dir: 'R' }),
  makeAst('heading', cs, { hdg: 110, dir: 'R', relative: { dir: 'R', deg: 20 } }),
  makeAst('heading', cs, { hdg: 240, dir: 'L', when: { type: 'at_or_below_alt', ft: 4000 } }), makeAst('heading', cs, { hdg: 240, when: { type: 'after_fix', fix: 'OCK' } }),
  makeAst('heading', 'THY8', { hdg: 240, when: { type: 'at_or_above_alt', ft: 5000 } }),
  makeAst('altitude', cs, { ft: 3000, expedite: true }), makeAst('altitude', cs, { ft: 8000, when: { type: 'when_ready' } }), makeAst('altitude', cs, { ft: 3000, when: { type: 'at_or_below_alt', ft: 4000 } }),
  makeAst('altitude', cs, { ft: 13000 }), makeAst('altitude', cs, { ft: 3500 }),
  makeAst('speed', cs, { kts: 180, untilNM: 4 }), makeAst('speed', cs, { kts: 'resume' }), makeAst('speed', cs, { kts: 250 }),
  makeAst('direct', cs, { fix: 'OCK', thenHdg: 240 }), makeAst('direct', cs, { fix: 'OCK' }),
  makeAst('hold', cs, { fix: 'OCK', inbound: 90, dir: 'L', legTimeMin: 1 }), makeAst('hold', cs, { fix: 'OCK', legNM: 4, legTimeMin: null }), makeAst('hold', cs, { fix: 'OCK', legTimeMin: 1.5 }), makeAst('hold', cs, { fix: 'OCK', dir: 'R', legTimeMin: 1 }),
  makeAst('ils', cs, { runway: '27L' }), makeAst('loc', cs, { runway: '27L', maintainAlt: 3000 }), makeAst('loc', cs, { runway: '27L' }), makeAst('visual', cs, { runway: '27L', follow: 'UAE5' }), makeAst('visual', cs, { runway: '27L' }),
  makeAst('cancelApproach', 'UAE5', { hdg: 180, alt: 4000, dir: 'L' }), makeAst('cancelApproach', 'UAE5', { hdg: 180, alt: 4000 }),
  makeAst('expectRunway', cs, { runway: '27L', approach: 'VISUAL' }), makeAst('expectRunway', cs, { runway: '27L' }), makeAst('expectRunway', cs, { runway: '27L', approach: 'LOC' }),
  makeAst('resumeSid', cs), makeAst('squawk', cs, { code: '4521' }), makeAst('ident', cs),
  makeAst('radarContact', cs, { descendTo: 5000, expectRunway: '27L' }), makeAst('radarContact', cs), makeAst('radarContact', cs, { descendTo: 4000 }),
  makeAst('sayAgain', cs), makeAst('correction', cs, { field: 'heading', value: 250 }), makeAst('correction', cs, { field: 'altitude', value: 4000 }), makeAst('correction', cs, { field: 'runway', value: '27L' }),
  makeAst('correction', cs, { field: 'speed', value: 180 }), makeAst('correction', cs, { field: 'squawk', value: '4521' }),
  makeAst('disregard', cs), makeAst('standby', cs), makeAst('unable', cs, { reason: 'runway_closed' }), makeAst('unable', cs, { reason: 'wake' }), makeAst('unable', cs, { reason: 'delay' }),
  makeAst('report', cs, { items: ['heading', 'altitude'] }), makeAst('report', cs, { items: ['pob', 'fuel'] }), makeAst('report', cs, { items: ['position'] }), makeAst('report', cs, { items: ['established'] }), makeAst('report', 'BAW117', { items: ['ready', 'intentions'] }),
  makeAst('roger', cs),
  makeAst('emergencyAck', cs, { ask: ['pob', 'fuel', 'intentions'], squawk: true }), makeAst('emergencyAck', cs, { ask: ['nature'], squawk: false }), makeAst('emergencyAck', cs, { ask: ['pob', 'dg'], squawk: true }),
  makeAst('priority', cs, { runway: '27L', straightIn: true, numberOne: true, sterile: true, clearIls: true }), makeAst('priority', cs, { runway: '27L', numberOne: false, clearIls: false }), makeAst('priority', cs, { runway: '27L', numberOne: true, clearIls: true }),
  makeAst('stopOnRunway', 'UAE5', { mode: 'stop' }), makeAst('stopOnRunway', 'UAE5', { mode: 'vacate_if_able', via: 'A' }), makeAst('stopOnRunway', 'UAE5', { mode: 'vacate_if_able' }), makeAst('emergencyCancelAck', cs),
  makeAst('holdAll', null, { scope: 'departures', runway: '27L' }), makeAst('holdAll', null, { scope: 'all' }), makeAst('holdAll', null, { scope: 'crossings' }), makeAst('resumeAll', null),
  makeAst('reopenRunway', null, { runway: '27L', afterInspection: true }), makeAst('reopenRunway', null, { runway: '27L' }),
  makeAst('dispatchVehicle', null, { type: 'arff', ids: ['FIRE1', 'FIRE2'], count: 2, target: { kind: 'runway', runway: '27L' } }),
  makeAst('dispatchVehicle', null, { type: 'arff', ids: [], count: 2, target: { kind: 'aircraft', id: 2, callsign: 'DLH2' } }),
  makeAst('dispatchVehicle', null, { type: 'followme', ids: [], count: 1, target: { kind: 'stand', ref: '512' } }),
  makeAst('dispatchVehicle', null, { type: 'ambulance', ids: ['AMB1'], count: 1, target: { kind: 'runway', runway: '27L' } }),
  makeAst('recallVehicle', null, { id: 'FIRE1' }), makeAst('vehicleOp', null, { id: 'FIRE1', op: 'cross', runway: '27L' }), makeAst('vehicleOp', null, { id: 'FIRE1', op: 'hold' }), makeAst('vehicleOp', null, { id: 'OPS1', op: 'rtb' }), makeAst('vehicleOp', null, { id: 'OPS1', op: 'continue' }),
  makeAst('runwayStatus', null, { runway: '27L', status: 'closed', reason: 'debris' }), makeAst('runwayStatus', null, { runway: '27L', status: 'inspection' }), makeAst('runwayStatus', null, { runway: '27L', status: 'open' }), makeAst('runwayStatus', null, { runway: '27L', status: 'sterile' }),
  makeAst('broadcast', null, { text: 'runway change in progress' }),
  { kind: 'sequence', callsign: cs, parts: [makeAst('altitude', cs, { ft: 3000 }), makeAst('ils', cs, { runway: '27L' })] },
  { kind: 'sequence', callsign: cs, parts: [makeAst('heading', cs, { hdg: 240, dir: 'L' }), makeAst('altitude', cs, { ft: 3000 }), makeAst('speed', cs, { kts: 180 })] },
  { kind: 'sequence', callsign: cs, parts: [makeAst('altitude', cs, { ft: 3000 }), makeAst('speed', cs, { kts: 180 }), makeAst('ils', cs, { runway: '27L' }), makeAst('contact', cs, { position: 'tower' })] },
  { kind: 'sequence', callsign: 'UAE5', parts: [makeAst('clearedLand', 'UAE5', { runway: '27L' }), makeAst('contact', 'UAE5', { position: 'ground', when: 'when_vacated' })] },
  { kind: 'sequence', callsign: 'BAW117', parts: [makeAst('pushback', 'BAW117', { expectRunway: '27R' }), makeAst('taxi', 'BAW117', { dest: { kind: 'runway', runway: '27R', intersection: null }, via: ['A'], auto: false })] },
];

for (const ast of ASTS) test(`roundtrip describe: ${text(ast)}`, () => roundTrip(ast));

test('roundtrip: every AST kind is covered', () => {
  const kinds = new Set<string>();
  for (const a of ASTS) { kinds.add(a.kind); if (a.kind === 'sequence') for (const p of a.parts) kinds.add(p.kind); }
  assert.equal(kinds.size, 53, `kinds covered: ${kinds.size}`);
});

// ── toAst for every action id -> describe -> parse ───────────────────────────
const dep = mkAircraft({ callsign: 'BAW117', plan: { kind: 'departure', runway: '27R', gateRef: '512' }, holdShortRunway: '27L', altitude: 0, targetAltitude: 0, cmdAltitude: null, onFrequency: 'ground', emergency: { type: 'engine_fire', status: 'declared', runway: '27L' } as never });
const arr = mkAircraft({ callsign: 'UAE5', type: 'A388', plan: { kind: 'arrival', runway: '27L', gateRef: '301', fix: 'OCK' }, altitude: 3000, onFrequency: 'approach', exitTaxiway: 'A', emergency: { type: 'engine_fire', status: 'declared', runway: '27L' } as never });
const PARAMS: Array<[ActionId, ActionParams, 'dep' | 'arr']> = [
  ['action-pushback', { runway: '27R', direction: 'N' }, 'dep'],
  ['action-startup', { runway: '27R' }, 'dep'],
  ['action-taxi-runway', { runway: '27R', route: { via: ['A', 'B'], auto: false, holdShortOf: { kind: 'runway', runway: '27L' } } }, 'dep'],
  ['action-taxi-stand', { stand: '301', route: { via: ['N'], auto: false } }, 'arr'],
  ['action-taxi-point', { taxiway: 'A', taxiway2: 'B' }, 'dep'],
  ['action-amend-route', { route: { via: ['B', 'C'], auto: false } }, 'dep'],
  ['action-hold-short', { chips: ['runway'], runway: '27L' }, 'dep'],
  ['action-hold-short', { chips: ['taxiway'], taxiway: 'B' }, 'dep'],
  ['action-hold-short', { chips: ['here'] }, 'dep'],
  ['action-hold-position', {}, 'dep'],
  ['action-hold-fix', { hold: { fix: 'OCK', inbound: 90, dir: 'L', legTimeMin: 1 } }, 'arr'],
  ['action-continue', { route: { via: [], auto: true, holdShortOf: { kind: 'runway', runway: '27L' } } }, 'dep'],
  ['action-cross', { runway: '27L', chips: ['expedite'] }, 'dep'],
  ['action-lineup', { runway: '27R', aircraft: 'UAE5' }, 'dep'],
  ['action-takeoff', { runway: '27R', chips: ['immediate'], afterDepHdg: 250, initialAlt: 5000, contactDeparture: true }, 'dep'],
  ['action-takeoff', { runway: '27R', afterDepHdg: 'runway' }, 'dep'],
  ['action-cancel-takeoff', {}, 'dep'],
  ['action-cancel-lineup', { taxiway: 'A' }, 'dep'],
  ['action-land', { runway: '27L', lahso: '09L', exit: { kind: 'taxiway', taxiway: 'A' }, number: 2 }, 'arr'],
  ['action-goaround', { goAround: { heading: 'runway', alt: 3000, contact: 'approach' } }, 'arr'],
  ['action-cancel-approach', { heading: 180, altitude: 4000, dir: 'L' }, 'arr'],
  ['action-exit', { taxiway: 'A', chips: ['expedite'], route: { via: [], auto: true, holdShortOf: { kind: 'runway', runway: '27R' } }, position: 'ground' }, 'arr'],
  ['action-plan-exit', { direction: 'L' }, 'arr'],
  ['action-heading', { heading: 240, dir: 'L' }, 'arr'],
  ['action-altitude', { altitude: 3000, expedite: true }, 'arr'],
  ['action-altitude', { altitude: 8000, pilotsDiscretion: true }, 'arr'],
  ['action-speed', { speed: 180, untilNM: 4 }, 'arr'],
  ['action-speed', { speed: 'resume' }, 'arr'],
  ['action-direct', { fix: 'OCK' }, 'arr'],
  ['action-resume-sid', {}, 'dep'],
  ['action-ils', { runway: '27L' }, 'arr'],
  ['action-ils', { runway: '27L', approachType: 'LOC', altitude: 3000 }, 'arr'],
  ['action-ils', { runway: '27L', approachType: 'VISUAL', aircraft: 'DLH2' }, 'arr'],
  ['action-expect-runway', { runway: '27L', approachType: 'VISUAL' }, 'arr'],
  ['action-change-runway', { runway: '27R' }, 'arr'],
  ['action-expedite', {}, 'arr'],
  ['action-handoff', { position: 'tower' }, 'arr'],
  ['action-handoff', { position: 'ground', when: 'when_vacated' }, 'arr'],
  ['action-report', { chips: ['heading', 'altitude'] }, 'arr'],
  ['action-say-again', {}, 'arr'],
  ['action-correction', { chips: ['heading'], value: 250 }, 'arr'],
  ['action-standby', {}, 'dep'],
  ['action-unable', { chips: ['wake'] }, 'dep'],
  ['action-giveway', { aircraft: 'DLH2', chips: ['follow'] }, 'dep'],
  ['action-wind-check', {}, 'arr'],
  ['action-turnaround', { runway: '27R', chips: ['35'] }, 'arr'],
  ['emerg-ack', { chips: ['pob', 'fuel'] }, 'arr'],
  ['emerg-priority', { runway: '27L', chips: ['number_one', 'straight_in'] }, 'arr'],
  ['emerg-dispatch', { vehicles: ['FIRE1', 'FIRE2'], chips: ['runway'], runway: '27L' }, 'arr'],
  ['emerg-hold-all', { chips: ['departures'], runway: '27L' }, 'arr'],
  ['emerg-breakoff', { aircraft: 'DLH2', heading: 180, altitude: 4000 }, 'arr'],
  ['emerg-stop-runway', { chips: ['vacate_if_able'], taxiway: 'A' }, 'arr'],
  ['emerg-reopen', { runway: '27L', chips: ['after_inspection'] }, 'arr'],
  ['emerg-cancel-ack', {}, 'arr'],
  ['emerg-resume-all', {}, 'arr'],
];

for (const [id, params, who] of PARAMS) {
  test(`roundtrip toAst: ${id} ${JSON.stringify(params)}`, () => {
    const a = who === 'dep' ? dep : arr;
    const ast = toAst(id, params, a.callsign, a);
    // describe() does not render cancelApproach.reason (a chip-only note) — compare without it
    if (ast.kind === 'cancelApproach') (ast as { reason: string | null }).reason = null;
    roundTrip(ast, id);
  });
}

test('roundtrip toAst: every action id exercised', () => {
  const ids = new Set(PARAMS.map(p => p[0]));
  const missing = ALL_ACTION_IDS.filter(id => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('toAst: mandatory params throw so the UI can never transmit a half-built command', () => {
  assert.throws(() => toAst('action-takeoff', {}, 'BAW117', dep), /missing runway/);
  assert.throws(() => toAst('action-direct', {}, 'DLH2', arr), /missing fix/);
  assert.throws(() => toAst('action-cancel-approach', { heading: 180 }, 'UAE5', arr), /missing altitude/);
  assert.throws(() => toAst('action-giveway', {}, 'BAW117', dep), /missing aircraft/);
  assert.throws(() => toAst('action-taxi-stand', {}, 'UAE5', arr), /missing stand/);
  assert.throws(() => toAst('action-correction', { chips: ['heading'] }, 'DLH2', arr), /missing value/);
});

test('toAst: "+ ADD PART" chips build an ICAO-ordered sequence, and single parts collapse', () => {
  const seq = toAst('action-altitude', { altitude: 3000, then: [makeAst('ils', 'UAE5', { runway: '27L' }), makeAst('speed', 'UAE5', { kts: 180 })] }, 'UAE5', arr);
  assert.equal(seq.kind, 'sequence');
  assert.deepEqual((seq as { parts: Array<{ kind: string }> }).parts.map(p => p.kind), ['altitude', 'speed', 'ils']);
  assert.equal(describe(seq), 'Altitude 3000 / Speed 180 / Cleared ILS 27L, report established');
  assert.equal(toAst('action-altitude', { altitude: 3000, then: [] }, 'UAE5', arr).kind, 'altitude');
  assert.equal(toAst('action-hold-short', { chips: ['next'] }, 'BAW117', dep).kind, 'holdShort');
  assert.deepEqual((toAst('action-hold-short', { chips: ['next'] }, 'BAW117', dep) as { of: unknown }).of, { kind: 'runway', runway: '27L' }, 'next crossing from the aircraft hold-short runway');
});

test('toAst: system actions ignore the callsign, emergency actions carry it', () => {
  const d = toAst('emerg-dispatch', { chips: ['aircraft'] }, 'UAE5', arr);
  assert.equal(d.kind, 'dispatchVehicle');
  assert.ok(!('callsign' in d));
  assert.deepEqual((d as { target: unknown }).target, { kind: 'aircraft', id: arr.id, callsign: 'UAE5' });
  const h = toAst('emerg-hold-all', { chips: ['all'] }, 'UAE5', arr);
  assert.deepEqual(h, makeAst('holdAll', null, { scope: 'all', runway: '27L' }));
  const b = toAst('emerg-breakoff', { aircraft: 'dlh2', heading: 180, altitude: 4000 }, 'UAE5', arr);
  assert.equal((b as { callsign: string }).callsign, 'DLH2', 'break-off addresses the OTHER aircraft');
  assert.equal(toAst('emerg-resume-all', {}, 'UAE5', arr).kind, 'resumeAll');
});

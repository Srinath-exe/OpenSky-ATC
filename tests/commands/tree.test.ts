// Command tree: ACTION_MATRIX cells vs UX §G2 (>= 40 cells with reasons),
// actionsFor policy layers (paused / strict frequency / hold-all / empty pickers),
// stepsFor completeness, hotkeys (§1.3 + §G2 + §G6), validate() soft/hard cases (§G3)
// and the undo model (§1.6 / §G9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_DEFS, ACTION_MATRIX, ALL_ACTION_IDS, REASONS, REASON_RESULT_CODE, actionsFor, evaluateCell, stepsFor, toAst, validate, validateAst,
  hotkeyFor, resolveHotkey, reasonText, visibleActionsForStage, enabledActionsForStage, undoable, canUndo, undoAst, inverse, snapshotFor,
  emptyPickerReason, runwayChips, reciprocalRunway, transmissionPreview, UNDO_WINDOW_S, UNDO_MIN_REAL_S,
} from '../../src/lib/sim/commandTree';
import type { ActionId, ReasonCode } from '../../src/lib/sim/commandTree';
import { ALL_STAGES } from '../../src/lib/sim/types';
import type { Stage, PilotRequest } from '../../src/lib/sim/types';
import { makeAst, describe } from '../../src/lib/sim/commandAst';
import { mkAircraft, mkActionCtx, mkPhraseCtx } from './helpers';

const req = (kind: PilotRequest['kind']): PilotRequest => ({ id: 1, kind, callsign: 'TST1', text: 'request', param: null, at: 0, recallAt: 60, recalls: 0, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null });

// ──────────────────────────────────────────────────────────────────────────────
//  §G2 matrix cells: [action, stage, aircraft overrides, ctx overrides, expected state, expected reason]
// ──────────────────────────────────────────────────────────────────────────────
type CellCase = [ActionId, Stage, Parameters<typeof mkAircraft>[0], Parameters<typeof mkActionCtx>[1], 'enabled' | 'disabled' | 'hidden', ReasonCode | null];
const CELLS: CellCase[] = [
  ['action-pushback', 'parked', { needsPushback: true }, {}, 'enabled', null],
  ['action-pushback', 'parked', { needsPushback: false }, {}, 'disabled', 'R21'],
  ['action-pushback', 'pushback', {}, {}, 'disabled', 'R18'],
  ['action-pushback', 'taxi_out', {}, {}, 'hidden', null],
  ['action-startup', 'parked', { needsPushback: false }, {}, 'enabled', null],
  ['action-startup', 'parked', { needsPushback: true }, {}, 'disabled', 'X2'],
  ['action-taxi-runway', 'parked', {}, {}, 'disabled', 'X1'],
  ['action-taxi-runway', 'startup', {}, {}, 'enabled', null],
  ['action-taxi-runway', 'pushback', {}, {}, 'enabled', null],
  ['action-taxi-runway', 'hold_short_cross', {}, {}, 'enabled', null],
  ['action-taxi-runway', 'rollout', { plan: { kind: 'departure', runway: '27R' } }, {}, 'enabled', null],
  ['action-taxi-runway', 'rollout', { plan: { kind: 'arrival', runway: '27L' } }, {}, 'hidden', null],
  ['action-taxi-runway', 'arr_final', {}, {}, 'hidden', null],
  ['action-taxi-stand', 'taxi_in', {}, {}, 'enabled', null],
  ['action-taxi-stand', 'rollout', {}, {}, 'enabled', null],
  ['action-taxi-stand', 'parked', {}, {}, 'hidden', null],
  ['action-hold-short', 'taxi_out', {}, {}, 'enabled', null],
  ['action-hold-short', 'hold_short_dep', {}, {}, 'disabled', 'R18'],
  ['action-hold-short', 'hold_short_cross', {}, {}, 'disabled', 'R18'],
  ['action-hold-position', 'startup', {}, { groundSpeedKt: 0 }, 'disabled', 'R11'],
  ['action-hold-position', 'startup', {}, { groundSpeedKt: 5 }, 'enabled', null],
  ['action-hold-position', 'lineup', {}, {}, 'enabled', null],
  ['action-hold-fix', 'takeoff_air', {}, { aglFt: 600 }, 'disabled', 'X3'],
  ['action-hold-fix', 'takeoff_air', {}, { aglFt: 1500 }, 'enabled', null],
  ['action-hold-fix', 'arr_established', {}, {}, 'disabled', 'X4'],
  ['action-continue', 'pushback', { pushback: { stage: 'paused', startedAt: 0, totalM: 0, pushedM: 0, tugAttachedAt: 0, disconnectAt: null, direction: 'any', tailTo: null, targetNodeId: null, heading: 0 } as never }, {}, 'enabled', null],
  ['action-continue', 'pushback', {}, {}, 'disabled', 'R12'],
  ['action-continue', 'taxi_out', { trafficHold: true }, {}, 'enabled', null],
  ['action-continue', 'taxi_out', {}, {}, 'hidden', null],
  ['action-cross', 'taxi_out', {}, { nextHoldIsCrossing: true, nextCrossingRunway: '27L' }, 'enabled', null],
  ['action-cross', 'taxi_out', {}, { nextHoldIsCrossing: false }, 'hidden', null],
  ['action-cross', 'hold_short_cross', {}, {}, 'enabled', null],
  ['action-lineup', 'taxi_out', {}, { distToNextHoldM: 150 }, 'enabled', null],
  ['action-lineup', 'taxi_out', {}, { distToNextHoldM: 800 }, 'disabled', 'R1'],
  ['action-lineup', 'hold_short_dep', {}, {}, 'enabled', null],
  ['action-lineup', 'hold_short_cross', {}, {}, 'disabled', 'X5'],
  ['action-lineup', 'lineup', {}, {}, 'disabled', 'R18'],
  ['action-takeoff', 'lineup', {}, {}, 'enabled', null],
  ['action-takeoff', 'takeoff_roll', {}, {}, 'disabled', 'R18'],
  ['action-cancel-takeoff', 'takeoff_roll', {}, { groundSpeedKt: 60 }, 'enabled', null],
  ['action-cancel-takeoff', 'takeoff_roll', {}, { groundSpeedKt: 95 }, 'disabled', 'R5'],
  ['action-cancel-takeoff', 'takeoff_air', {}, {}, 'disabled', 'R16'],
  ['action-cancel-lineup', 'lineup', {}, {}, 'enabled', null],
  ['action-land', 'go_around', {}, {}, 'disabled', 'R10'],
  ['action-land', 'arr_inbound', {}, {}, 'disabled', 'X6'],
  ['action-land', 'arr_armed', {}, {}, 'disabled', 'R9'],
  ['action-land', 'arr_established', {}, {}, 'enabled', null],
  ['action-land', 'arr_short_final', {}, {}, 'enabled', null],
  ['action-land', 'rollout', {}, {}, 'disabled', 'R18'],
  ['action-goaround', 'takeoff_roll', {}, {}, 'disabled', 'R17'],
  ['action-goaround', 'go_around', {}, {}, 'disabled', 'R18'],
  ['action-goaround', 'arr_final', {}, {}, 'enabled', null],
  ['action-goaround', 'rollout', {}, {}, 'disabled', 'R17'],
  ['action-cancel-approach', 'arr_final', {}, { distToThresholdNM: 5 }, 'enabled', null],
  ['action-cancel-approach', 'arr_final', {}, { distToThresholdNM: 1.5 }, 'disabled', 'X7'],
  ['action-cancel-approach', 'arr_short_final', {}, {}, 'disabled', 'X7'],
  ['action-exit', 'arr_short_final', {}, { aglFt: 800 }, 'enabled', null],
  ['action-exit', 'arr_short_final', {}, { aglFt: 300 }, 'disabled', 'R6'],
  ['action-exit', 'rollout', {}, {}, 'enabled', null],
  ['action-heading', 'takeoff_air', {}, {}, 'enabled', null],
  ['action-heading', 'arr_established', {}, {}, 'disabled', 'X4'],
  ['action-heading', 'arr_short_final', {}, {}, 'disabled', 'X4'],
  ['action-heading', 'taxi_out', {}, {}, 'hidden', null],
  ['action-altitude', 'arr_final', {}, {}, 'disabled', 'X8'],
  ['action-altitude', 'dep_climb', {}, {}, 'enabled', null],
  ['action-speed', 'arr_final', {}, {}, 'enabled', null],
  ['action-speed', 'arr_short_final', {}, {}, 'disabled', 'X9'],
  ['action-direct', 'arr_established', {}, {}, 'disabled', 'X4'],
  ['action-resume-sid', 'dep_climb', { navMode: 'heading' }, { hasSid: true }, 'enabled', null],
  ['action-resume-sid', 'dep_climb', { navMode: 'heading' }, { hasSid: false }, 'hidden', null],
  ['action-ils', 'go_around', {}, { distToThresholdNM: 8, aboveGlideslope: false }, 'enabled', null],
  ['action-ils', 'go_around', {}, { distToThresholdNM: 2, aboveGlideslope: false }, 'disabled', 'R10'],
  ['action-ils', 'arr_inbound', {}, { hasIls: true }, 'enabled', null],
  ['action-ils', 'arr_inbound', {}, { hasIls: false }, 'disabled', 'R20'],
  ['action-ils', 'arr_inbound', {}, { hasRadar: false }, 'hidden', null],
  ['action-ils', 'arr_established', {}, {}, 'disabled', 'R18'],
  ['action-expect-runway', 'arr_inbound', {}, {}, 'enabled', null],
  ['action-change-runway', 'arr_established', { plan: { kind: 'arrival', runway: '27L' } }, { distToThresholdNM: 8 }, 'enabled', null],
  ['action-change-runway', 'arr_established', { plan: { kind: 'arrival', runway: '27L' } }, { distToThresholdNM: 3 }, 'disabled', 'X10'],
  ['action-change-runway', 'arr_final', {}, {}, 'disabled', 'X10'],
  ['action-handoff', 'taxi_out', {}, { nextCrossingRunway: '27L' }, 'disabled', 'X13'],
  ['action-handoff', 'taxi_out', {}, { nextCrossingRunway: null }, 'enabled', null],
  ['action-handoff', 'rollout', {}, { onRunway: true }, 'disabled', 'X11'],
  ['action-handoff', 'rollout', {}, { onRunway: false }, 'enabled', null],
  ['action-handoff', 'lineup', {}, {}, 'hidden', null],
  ['action-report', 'takeoff_roll', {}, {}, 'hidden', null],
  ['action-report', 'pushback', {}, {}, 'enabled', null],
  ['action-say-again', 'arr_inbound', {}, { sinceLastPilotLineS: 20 }, 'enabled', null],
  ['action-say-again', 'arr_inbound', {}, { sinceLastPilotLineS: 90 }, 'hidden', null],
  ['action-correction', 'taxi_out', {}, { sinceLastPilotLineS: null }, 'hidden', null],
  ['action-standby', 'parked', {}, {}, 'enabled', null],
  ['action-standby', 'dep_climb', {}, { pendingRequest: null }, 'hidden', null],
  ['action-standby', 'dep_climb', {}, { pendingRequest: req('higher') }, 'enabled', null],
  ['action-unable', 'dep_climb', {}, { pendingRequest: req('higher') }, 'enabled', null],
  ['action-unable', 'dep_climb', {}, {}, 'hidden', null],
  ['action-giveway', 'taxi_in', {}, {}, 'enabled', null],
  ['action-wind-check', 'lineup', {}, {}, 'enabled', null],
  ['action-wind-check', 'taxi_out', {}, {}, 'hidden', null],
  ['action-turnaround', 'arrived', {}, { sandbox: true }, 'enabled', null],
  ['action-turnaround', 'arrived', {}, { sandbox: false }, 'hidden', null],
  ['emerg-ack', 'arr_inbound', {}, {}, 'hidden', null],
  ['emerg-ack', 'arr_inbound', { emergency: { type: 'engine_fire', status: 'declared' } as never }, {}, 'enabled', null],
  ['emerg-priority', 'taxi_out', { emergency: { type: 'brake_fire', status: 'declared' } as never }, {}, 'hidden', null],
  ['emerg-priority', 'arr_inbound', { emergency: { type: 'engine_fire', status: 'declared' } as never }, {}, 'enabled', null],
  ['emerg-stop-runway', 'arr_final', { emergency: { type: 'engine_fire', status: 'declared' } as never }, {}, 'enabled', null],
  ['emerg-stop-runway', 'arr_inbound', { emergency: { type: 'engine_fire', status: 'declared' } as never }, {}, 'hidden', null],
  ['emerg-reopen', 'rollout', { emergency: { type: 'engine_fire', status: 'declared' } as never }, { emergencyClosedRunway: '27L', runwayStatus: r => (r === '27L' ? 'closed' : 'open'), runways: mkActionCtx('rollout').runways!.map(r => (r.name === '27L' ? { ...r, status: 'closed' as const } : r)) }, 'enabled', null],
  ['action-altitude', 'arr_short_final', {}, {}, 'disabled', 'X8'],
  ['action-direct', 'arr_short_final', {}, {}, 'disabled', 'X4'],
  ['action-heading', 'arr_final', {}, {}, 'disabled', 'X4'],
  ['action-lineup', 'taxi_out', {}, { distToNextHoldM: null }, 'disabled', 'R1'],
  ['action-cancel-approach', 'arr_final', {}, { distToThresholdNM: null }, 'disabled', 'X7'],
  ['action-change-runway', 'arr_short_final', {}, {}, 'disabled', 'X10'],
  ['emerg-reopen', 'rollout', { emergency: { type: 'engine_fire', status: 'declared' } as never }, { emergencyClosedRunway: null }, 'hidden', null],
  ['emerg-resume-all', 'rollout', { emergency: { type: 'engine_fire', status: 'declared' } as never }, { holdAllActive: true }, 'enabled', null],
  ['emerg-breakoff', 'arr_final', { emergency: { type: 'engine_fire', status: 'declared' } as never }, { otherArrivalsOnFinal: ['UAE5'] }, 'enabled', null],
  ['emerg-breakoff', 'arr_final', { emergency: { type: 'engine_fire', status: 'declared' } as never }, { otherArrivalsOnFinal: [] }, 'hidden', null],
];

for (const [id, stage, aOver, cOver, state, reason] of CELLS) {
  test(`matrix: ${id} @ ${stage} -> ${state}${reason ? ' ' + reason : ''}`, () => {
    const a = mkAircraft(aOver);
    const ctx = mkActionCtx(stage, cOver);
    const cell = evaluateCell(id, a, ctx);
    assert.equal(cell.state, state, `cell=${JSON.stringify(cell)} matrix=${ACTION_MATRIX[id][stage]}`);
    if (reason) assert.equal(cell.reason, reason);
    const rows = actionsFor(a, ctx);
    const row = rows.find(r => r.id === id);
    if (state === 'hidden') assert.equal(row, undefined, 'hidden rows are not returned');
    else {
      assert.ok(row, 'row present');
      assert.equal(row.state, state);
      if (reason) { assert.equal(row.reason, reason); assert.ok(row.reasonText.length > 0); assert.ok(!row.reasonText.includes('{'), `placeholders filled: ${row.reasonText}`); }
      else assert.equal(row.reasonText, '');
    }
  });
}

test('matrix: at least 40 cells covered with reasons', () => {
  assert.ok(CELLS.length >= 40);
  assert.ok(CELLS.filter(c => c[5]).length >= 40, 'at least 40 disabled-with-reason cells');
});

test('matrix: every action has a row for every stage; departed hides everything', () => {
  for (const id of ALL_ACTION_IDS) {
    for (const s of ALL_STAGES) assert.ok(ACTION_MATRIX[id][s] !== undefined, `${id}/${s}`);
    assert.equal(ACTION_MATRIX[id].departed, '-', `${id} must be hidden in departed`);
  }
  assert.equal(ALL_ACTION_IDS.length, 47);
  for (const id of ALL_ACTION_IDS) assert.ok(ACTION_DEFS[id], id);
});

test('matrix: canonical R1-R24 strings verbatim (§G2 legend)', () => {
  assert.equal(REASONS.R1, 'Not at the holding point yet');
  assert.equal(REASONS.R3, 'Runway {rwy} occupied by {occ}');
  assert.equal(REASONS.R6, 'Below 500 ft — too late for exit');
  assert.equal(REASONS.R13, 'Not on your frequency');
  assert.equal(REASONS.R16, 'Airborne — use Go around');
  assert.equal(REASONS.R22, 'Runway {rwy} not active for {role}');
  assert.equal(REASONS.R24, 'Emergency in progress');
  assert.equal(reasonText('R3', { rwy: '27L', occ: 'BAW117' }), 'Runway 27L occupied by BAW117');
  assert.equal(reasonText('R22', { rwy: '27L', role: 'arr' }), 'Runway 27L not active for arr');
  for (const k of Object.keys(REASONS) as ReasonCode[]) assert.ok(REASON_RESULT_CODE[k], `result code for ${k}`);
});

test('actionsFor: policy layers — paused X12, strict frequency R13, hold-all R24, empty pickers', () => {
  const a = mkAircraft({ onFrequency: 'ground', plan: { kind: 'departure', runway: '27R' } });
  const paused = actionsFor(a, mkActionCtx('hold_short_dep', { paused: true }));
  assert.ok(paused.length > 0 && paused.every(r => r.state === 'disabled' && r.reason === 'X12'));
  const off = actionsFor(a, mkActionCtx('hold_short_dep', { strictFrequencies: true, position: 'tower' }));
  assert.ok(off.every(r => r.state === 'disabled' && r.reason === 'R13'));
  const on = actionsFor(a, mkActionCtx('hold_short_dep', { strictFrequencies: true, position: 'ground' }));
  assert.ok(on.some(r => r.state === 'enabled'));
  const held = actionsFor(a, mkActionCtx('hold_short_dep', { holdAllActive: true }));
  assert.equal(held.find(r => r.id === 'action-lineup')?.reason, 'R24');
  assert.equal(held.find(r => r.id === 'action-takeoff')?.reason, 'R24');
  assert.equal(held.find(r => r.id === 'action-report')?.state, 'enabled', 'non-movement rows unaffected');
  // empty pickers
  const noFix = actionsFor(mkAircraft(), mkActionCtx('arr_inbound', { fixes: [] }));
  assert.equal(noFix.find(r => r.id === 'action-direct')?.reason, 'X15');
  const noIls = actionsFor(mkAircraft(), mkActionCtx('arr_inbound', { runways: mkActionCtx('arr_inbound').runways!.map(r => ({ ...r, hasIls: false })) }));
  assert.equal(noIls.find(r => r.id === 'action-ils')?.reason, 'R20');
  const noStand = actionsFor(mkAircraft(), mkActionCtx('taxi_in', { stands: [{ ref: '1', terminal: 'A', occupant: 'X' }, { ref: '2', terminal: 'A', occupant: 'Y' }] }));
  assert.equal(noStand.find(r => r.id === 'action-taxi-stand')?.reason, 'X14');
  const noVeh = actionsFor(mkAircraft({ emergency: { type: 'engine_fire', status: 'declared' } as never }), mkActionCtx('arr_final', { vehicles: [{ id: 'FIRE1', callsign: 'Fire 1', type: 'arff', state: 'enroute', available: false }] }));
  assert.equal(noVeh.find(r => r.id === 'emerg-dispatch')?.reason, 'X17');
});

test('actionsFor: ordering, primary answer for a pending request, emergency band first', () => {
  const a = mkAircraft({ plan: { kind: 'departure', runway: '27R' } });
  const rows = actionsFor(a, mkActionCtx('hold_short_dep', { pendingRequest: req('ready') }));
  assert.equal(rows.find(r => r.primary)?.id, 'action-takeoff');
  const busy = actionsFor(a, mkActionCtx('hold_short_dep', { pendingRequest: req('ready'), runwayOccupant: () => 'RYR1' }));
  assert.equal(busy.find(r => r.primary)?.id, 'action-lineup', '§G8: ready -> line up when the runway is occupied');
  const orders = rows.map(r => r.order);
  assert.deepEqual(orders, [...orders].sort((x, y) => x - y));
  const em = actionsFor(mkAircraft({ emergency: { type: 'engine_fire', status: 'declared' } as never }), mkActionCtx('arr_final'));
  assert.equal(em[0].group, 'emergency');
  assert.equal(em.find(r => r.primary)?.id, 'emerg-ack');
  for (const r of rows) { assert.ok(r.steps.length >= 1); assert.equal(r.steps[r.steps.length - 1].type, 'confirm'); }
});

test('stepsFor: every action ends with confirm and uses only known picker types', () => {
  const types = new Set(['runway', 'taxiway-route', 'heading', 'altitude', 'speed', 'fix', 'hold', 'direction', 'taxiway', 'gate', 'aircraft', 'vehicle', 'position', 'text', 'confirm']);
  const a = mkAircraft({ plan: { kind: 'arrival', runway: '27L', gateRef: '512', fix: 'OCK' }, emergency: { type: 'engine_fire', status: 'declared', runway: '27L' } as never });
  for (const id of ALL_ACTION_IDS) {
    for (const stage of ['parked', 'taxi_out', 'hold_short_dep', 'lineup', 'arr_inbound', 'arr_established', 'rollout', 'arrived'] as Stage[]) {
      const steps = stepsFor(id, a, mkActionCtx(stage));
      assert.ok(steps.length >= 1, `${id}/${stage}`);
      assert.equal(steps[steps.length - 1].type, 'confirm', `${id}/${stage} ends with confirm`);
      for (const s of steps) { assert.ok(types.has(s.type), `${id}: ${s.type}`); assert.ok(s.id && s.label, `${id}: step id/label`); }
      const ids = steps.map(s => s.id);
      assert.equal(new Set(ids).size, ids.length, `${id}/${stage}: unique step ids`);
    }
  }
});

test('stepsFor: defaults follow §G4 (runway from plan, altitude rounding, next position, last-used)', () => {
  const dep = mkAircraft({ plan: { kind: 'departure', runway: '27R' }, altitude: 2300, clearance: { initialAlt: 4000, autoHandoffAlt: 3000, afterDepHdg: null, immediate: false, squawk: '', sid: null, lahsoHoldShortOf: null, exitAt: null } as never, onFrequency: 'tower' });
  const takeoff = stepsFor('action-takeoff', dep, mkActionCtx('lineup'));
  assert.equal((takeoff[0] as { default: string }).default, '27R');
  assert.equal((takeoff[0] as { locked: boolean }).locked, true);
  const alt = stepsFor('action-altitude', dep, mkActionCtx('dep_climb'))[0] as { default: number; max: number };
  assert.equal(alt.default, 4000, 'departure climb default = max(initial, next thousand)');
  assert.equal(alt.max, 13000, 'TMA cap for departures');
  const arr = mkAircraft({ plan: { kind: 'arrival', runway: '27L' }, altitude: 5400, onFrequency: 'approach' });
  const dalt = stepsFor('action-altitude', arr, mkActionCtx('arr_inbound'))[0] as { default: number };
  assert.equal(dalt.default, 5000, 'descend default = rounded down thousand');
  const hand = stepsFor('action-handoff', arr, mkActionCtx('arr_established'))[0] as { default: string; candidates: Array<{ position: string; enabled: boolean }> };
  assert.equal(hand.default, 'tower', 'next-logical position');
  assert.equal(hand.candidates.find(c => c.position === 'approach')?.enabled, false, 'never contact yourself');
  const lu = stepsFor('action-heading', arr, mkActionCtx('arr_inbound', { lastUsed: { heading: 123 } }))[0] as { default: number };
  assert.equal(lu.default, 123, 'last-used default');
  const spd = stepsFor('action-speed', arr, mkActionCtx('arr_established'))[0] as { min: number; max: number; presets: string[] };
  assert.equal(spd.max, 210, 'established rail ceiling 210');
  assert.ok(spd.presets.includes('until4'));
  const rung = stepsFor('action-altitude', arr, mkActionCtx('arr_inbound', { msaFt: 2500 }))[0] as { rungs: Array<{ ft: number; band: string; label: string }> };
  assert.equal(rung.rungs.find(r => r.ft === 2000)?.band ?? 'msa', 'msa');
  assert.equal(rung.rungs.find(r => r.ft === 7000)?.label, 'FL070', 'flight levels above the transition altitude');
});

test('runwayChips: active-for-role first, headwind sort, R8/R14/R20 reasons, wind sub-label', () => {
  const a = mkAircraft({ type: 'A388' });
  const ctx = mkActionCtx('arr_inbound', {
    wind: { dir: 270, kts: 10, gust: 0 },
    runways: [
      { name: '27L', ref: '09R/27L', headingTrue: 270, status: 'open', activeDep: false, activeArr: true, hasIls: true, lengthM: 3600, weightAllowed: true },
      { name: '09R', ref: '09R/27L', headingTrue: 90, status: 'open', activeDep: true, activeArr: false, hasIls: false, lengthM: 3600, weightAllowed: true },
      { name: '27R', ref: '09L/27R', headingTrue: 270, status: 'closed', activeDep: true, activeArr: true, hasIls: true, lengthM: 3900, weightAllowed: false },
    ],
  });
  const land = runwayChips('landing', a, ctx);
  assert.equal(land[0].name, '27L');
  assert.equal(land[0].sub, 'HW 10 · XW 0');
  assert.equal(land.find(c => c.name === '27R')?.reason, reasonText('R14', { rwy: '27R' }));
  assert.equal(land.find(c => c.name === '09R')?.tailwind, true);
  const ils = runwayChips('ils', a, ctx);
  assert.equal(ils.find(c => c.name === '09R')?.reason, REASONS.R20);
  assert.ok(ils.find(c => c.name === '09R')?.badges.includes('NO ILS'));
  const visual = runwayChips('ils', a, ctx, 'VISUAL');
  assert.equal(visual.find(c => c.name === '09R')?.enabled, true, 'NO ILS runways enabled in visual mode');
  const cross = runwayChips('cross', a, ctx);
  assert.equal(cross.find(c => c.name === '27R')?.reason, '', 'crossing a closed / weight-restricted runway is allowed');
  assert.equal(reciprocalRunway('27L'), '09R');
  assert.equal(reciprocalRunway('09'), '27');
  assert.equal(reciprocalRunway('18C'), '36C');
  assert.equal(emptyPickerReason(stepsFor('action-ils', a, mkActionCtx('arr_inbound', { runways: ctx.runways!.map(r => ({ ...r, hasIls: false, weightAllowed: true })) }))), 'R20');
  assert.equal(emptyPickerReason(stepsFor('action-ils', a, mkActionCtx('arr_inbound', { runways: ctx.runways!.map(r => ({ ...r, hasIls: false })) }))), 'X18', 'mixed reasons -> generic no-runway');
});

test('hotkeys: §1.3 letters, §G2 collision rules, §G6 emergency chords', () => {
  assert.equal(hotkeyFor('action-taxi-runway', 'startup'), 'T');
  assert.equal(hotkeyFor('action-amend-route', 'taxi_out'), 'T');
  assert.equal(hotkeyFor('action-taxi-runway', 'taxi_out'), null);
  assert.equal(hotkeyFor('action-taxi-stand', 'rollout'), 'T');
  assert.equal(hotkeyFor('action-hold-short', 'taxi_out'), 'H');
  assert.equal(hotkeyFor('action-hold-position', 'lineup'), 'H');
  assert.equal(hotkeyFor('action-hold-fix', 'arr_inbound'), 'H');
  assert.equal(hotkeyFor('action-ils', 'arr_inbound'), 'I');
  assert.equal(hotkeyFor('action-change-runway', 'arr_armed'), 'I');
  assert.equal(hotkeyFor('action-cancel-lineup', 'lineup'), 'C');
  assert.equal(hotkeyFor('action-cancel-takeoff', 'takeoff_roll'), 'C');
  assert.equal(hotkeyFor('action-cancel-approach', 'arr_armed'), 'C');
  assert.equal(hotkeyFor('action-wind-check', 'lineup'), 'R');
  assert.equal(hotkeyFor('action-report', 'arr_inbound'), 'R');
  assert.equal(hotkeyFor('action-expedite', 'dep_climb'), 'A,E');
  assert.equal(hotkeyFor('action-lineup', 'hold_short_dep'), 'W');
  assert.equal(hotkeyFor('action-takeoff', 'lineup'), 'O');
  assert.equal(hotkeyFor('action-land', 'arr_final'), 'L');
  assert.equal(hotkeyFor('action-goaround', 'arr_final'), 'G');
  assert.equal(hotkeyFor('action-heading', 'arr_inbound'), 'V');
  assert.equal(hotkeyFor('action-handoff', 'arr_inbound'), 'F');
  assert.equal(hotkeyFor('action-giveway', 'taxi_out'), 'J');
  assert.equal(hotkeyFor('action-standby', 'parked'), 'Y');
  assert.equal(hotkeyFor('action-unable', 'parked'), 'N');
  assert.equal(hotkeyFor('emerg-ack', 'arr_final'), 'M,A');
  assert.equal(hotkeyFor('emerg-stop-runway', 'arr_final'), 'M,E');
  assert.equal(hotkeyFor('emerg-resume-all', 'arr_final'), 'M,X');
  assert.equal(hotkeyFor('action-turnaround', 'arrived'), null);
  // no two visible rows in a stage share a plain letter (chords excluded)
  for (const stage of ALL_STAGES) {
    const seen = new Map<string, ActionId>();
    for (const id of visibleActionsForStage(stage)) {
      const k = hotkeyFor(id, stage); if (!k || k.includes(',')) continue;
      if (k === 'X' || k === 'P') continue; // cross/continue share X and pushback/startup share P by design (exactly one is enabled at a time)
      assert.ok(!seen.has(k), `${stage}: ${k} shared by ${seen.get(k)} and ${id}`);
      seen.set(k, id);
    }
  }
  assert.ok(enabledActionsForStage('lineup').includes('action-takeoff'));
  assert.ok(!enabledActionsForStage('lineup').includes('action-lineup'));
});

test('resolveHotkey: enabled beats disabled, X prefers cross, second press cycles the family', () => {
  const a = mkAircraft({ plan: { kind: 'departure', runway: '27R' }, trafficHold: true });
  const rows = actionsFor(a, mkActionCtx('taxi_out', { nextHoldIsCrossing: true, nextCrossingRunway: '27L' }));
  assert.equal(resolveHotkey('x', rows)?.id, 'action-cross');
  assert.equal(resolveHotkey('X', rows, 'action-cross')?.id, 'action-continue');
  assert.equal(resolveHotkey('T', rows)?.id, 'action-amend-route');
  assert.equal(resolveHotkey('T', rows, 'action-amend-route')?.id, 'action-taxi-runway');
  assert.equal(resolveHotkey('Q', rows), null);
  const lineup = actionsFor(a, mkActionCtx('lineup'));
  assert.equal(resolveHotkey('C', lineup)?.id, 'action-cancel-lineup');
  assert.equal(resolveHotkey('M,A', actionsFor(mkAircraft({ emergency: { type: 'engine_fire', status: 'declared' } as never }), mkActionCtx('arr_final')))?.id, 'emerg-ack');
});

// ──────────────────────────────────────────────────────────────────────────────
//  validate(): §1.4 Hard / Soft + §G3 guards
// ──────────────────────────────────────────────────────────────────────────────
test('validate: takeoff hard blocks — closed runway, weight class, occupied, vehicle, arrival < 2 NM, crossing runway in use', () => {
  const a = mkAircraft({ callsign: 'BAW117', type: 'A388', plan: { kind: 'departure', runway: '27R' } });
  const base = mkActionCtx('lineup');
  const v = (over: Partial<typeof base>) => validate('action-takeoff', { runway: '27R' }, a, mkActionCtx('lineup', over));
  assert.equal(v({}).ok, true);
  assert.deepEqual(v({ runwayStatus: () => 'closed' }).errors.map(e => e.code), ['runway_closed']);
  assert.equal(v({ runwayStatus: () => 'closed' }).errors[0].reason, 'R14');
  assert.equal(v({ weightAllowed: () => false }).errors[0].code, 'weight_class');
  assert.equal(v({ weightAllowed: () => false }).errors[0].text, 'S category not permitted on 27R');
  assert.equal(v({ runwayOccupant: () => 'RYR1' }).errors[0].code, 'runway_occupied');
  assert.equal(v({ runwayOccupant: () => 'RYR1' }).errors[0].text, 'Runway 27R occupied by RYR1');
  assert.equal(v({ vehicleOnRunway: () => 'FIRE1' }).errors[0].text, 'Vehicle FIRE1 on runway');
  assert.equal(v({ arrivalOnFinal: () => ({ callsign: 'UAE5', nm: 1.5 }) }).errors[0].reason, 'R4');
  assert.equal(v({ takeoffClearanceHolder: () => 'EZY9' }).errors[0].text, 'EZY9 already cleared for takeoff on 27R');
  assert.equal(v({ intersectingRunways: () => ['09L'], runwayOccupant: (r) => (r === '09L' ? 'DLH9' : null) }).errors[0].text, 'Crossing runway 09L in use by DLH9');
  assert.equal(v({ arrivalOnFinal: (r) => (r === '09L' ? { callsign: 'OPP1', nm: 3 } : null) }).errors[0].reason, 'R4', 'opposite-end arrival < 4 NM is hard');
});

test('validate: takeoff / landing soft warnings — arrival 2-4 NM, wake timer, not active, tailwind / crosswind', () => {
  const a = mkAircraft({ callsign: 'BAW117', plan: { kind: 'departure', runway: '27R' } });
  const soft = validate('action-takeoff', { runway: '27R' }, a, mkActionCtx('lineup', {
    arrivalOnFinal: (r) => (r === '27R' ? { callsign: 'UAE5', nm: 3.2 } : null), wakeTimerRemainingS: () => 42, runwayActive: () => false, wind: { dir: 90, kts: 15, gust: 0 },
  }));
  assert.equal(soft.ok, true, JSON.stringify(soft.errors));
  const texts = soft.warnings.map(w => w.text);
  assert.ok(texts.includes('Arrival UAE5 3.2 NM final'));
  assert.ok(texts.includes('Wake turbulence — 42 s remaining'));
  assert.ok(texts.includes('Runway 27R not active for dep'));
  assert.ok(texts.includes('Tailwind 15 kt'));
  const xw = validate('action-takeoff', { runway: '27R' }, a, mkActionCtx('lineup', { wind: { dir: 180, kts: 30, gust: 0 } }));
  assert.ok(xw.warnings.some(w => w.text === 'Crosswind 30 kt'));
  const arr = mkAircraft({ callsign: 'UAE5', plan: { kind: 'arrival', runway: '27L' } });
  const land = validate('action-land', { runway: '27L' }, arr, mkActionCtx('arr_final', { runwayOccupant: () => 'BAW117', landingClearanceHolders: () => ['DLH2'], distToThresholdNM: 5 }));
  assert.equal(land.ok, true);
  assert.ok(land.warnings.some(w => w.text === 'Runway 27L occupied by BAW117'), 'landing with an occupied runway is soft (trap mechanic)');
  assert.ok(land.warnings.some(w => w.text === 'Number 2, DLH2 ahead'));
  const land2 = validate('action-land', { runway: '27L' }, arr, mkActionCtx('arr_short_final', { landingClearanceHolders: () => ['DLH2'], distToThresholdNM: 1.5 }));
  assert.equal(land2.errors[0]?.code, 'runway_occupied', 'second landing clearance inside 2 NM is hard');
});

test('validate: airborne guards — ilsCaptured hard, ilsArmed soft, MSA floor, ceiling, speed envelope, 250 below FL100', () => {
  const captured = mkAircraft({ ilsArmed: true, ilsCaptured: true });
  assert.equal(validateAst(makeAst('heading', captured.callsign, { hdg: 180 }), captured, mkActionCtx('arr_established')).errors[0]?.reason, 'X4');
  assert.equal(validateAst(makeAst('altitude', captured.callsign, { ft: 2500 }), captured, mkActionCtx('arr_established')).errors[0]?.reason, 'X8');
  const armed = mkAircraft({ ilsArmed: true });
  const r = validateAst(makeAst('heading', armed.callsign, { hdg: 180 }), armed, mkActionCtx('arr_armed'));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.text === 'Cancels ILS clearance'));
  const a = mkAircraft({ altitude: 8000 });
  assert.equal(validateAst(makeAst('altitude', a.callsign, { ft: 1000 }), a, mkActionCtx('arr_inbound', { msaFt: 2500 })).errors[0]?.code, 'too_low');
  assert.equal(validateAst(makeAst('altitude', a.callsign, { ft: 25000 }), a, mkActionCtx('arr_inbound')).errors[0]?.code, 'invalid_param');
  assert.equal(validateAst(makeAst('altitude', a.callsign, { ft: 3050 }), a, mkActionCtx('arr_inbound')).errors[0]?.code, 'invalid_param');
  const gs = validateAst(makeAst('altitude', armed.callsign, { ft: 2000 }), armed, mkActionCtx('arr_armed', { gsInterceptAltFt: 3000 }));
  assert.ok(gs.warnings.some(w => w.text.startsWith('Below glideslope intercept')));
  assert.equal(validateAst(makeAst('speed', a.callsign, { kts: 100 }), a, mkActionCtx('arr_inbound')).errors[0]?.code, 'unable_envelope');
  const fast = validateAst(makeAst('speed', a.callsign, { kts: 270 }), a, mkActionCtx('arr_inbound'));
  assert.ok(fast.warnings.some(w => w.text === 'Above 250 kt below FL100'));
  assert.equal(validateAst(makeAst('heading', a.callsign, { hdg: 180 }), a, mkActionCtx('taxi_out')).errors[0]?.reason, 'R17');
  assert.equal(validateAst(makeAst('speed', a.callsign, { kts: 180 }), a, mkActionCtx('taxi_out')).errors[0]?.reason, 'R17');
  assert.equal(validateAst(makeAst('direct', a.callsign, { fix: 'ZZZZ' }), a, mkActionCtx('arr_inbound')).errors[0]?.code, 'unknown_fix');
  assert.equal(validateAst(makeAst('hold', a.callsign, { fix: 'OCK' }), a, mkActionCtx('arr_inbound', { fixRestriction: () => 'Fix OCK inside D-123 below 4000' })).errors[0]?.text, 'Fix OCK inside D-123 below 4000');
  assert.equal(validateAst(makeAst('cancelApproach', a.callsign, { hdg: 0, alt: 0 }), a, mkActionCtx('arr_armed')).errors[0]?.reason, 'R7');
  assert.equal(validateAst(makeAst('goAround', a.callsign, {}), a, mkActionCtx('rollout')).errors[0]?.reason, 'R17');
  const ils = validateAst(makeAst('ils', a.callsign, { runway: '27L' }), a, mkActionCtx('arr_inbound', { interceptAngle: () => 75, aboveGlideslope: true, trafficAheadOnFinal: () => ({ callsign: 'UAE5', nm: 2.2 }) }));
  assert.equal(ils.ok, true);
  assert.ok(ils.warnings.some(w => w.text.includes('75° intercept')));
  assert.ok(ils.warnings.some(w => w.text === 'Above glideslope at intercept — descend first'));
  assert.ok(ils.warnings.some(w => w.text === 'UAE5 established 2.2 NM ahead'));
  assert.equal(validateAst(makeAst('ils', a.callsign, { runway: '18L' }), a, mkActionCtx('arr_inbound')).errors[0]?.code, 'unknown_runway');
});

test('validate: ground guards — unknown taxiway / stand, route reachability R15, hold-all R24, crossing with arrival, LAHSO soft, exit passed', () => {
  const a = mkAircraft({ callsign: 'BAW117', plan: { kind: 'departure', runway: '27R', gateRef: '512' } });
  const taxi = (params: Parameters<typeof toAst>[1], over: Parameters<typeof mkActionCtx>[1] = {}) => validate('action-taxi-runway', params, a, mkActionCtx('startup', over));
  assert.equal(taxi({ runway: '27R', route: { via: ['A', 'Q'], auto: false } }).errors[0]?.code, 'unknown_taxiway');
  assert.equal(taxi({ runway: '27R', route: { via: ['A'], auto: false } }, { routeExists: () => false }).errors[0]?.reason, 'R15');
  assert.equal(taxi({ runway: '27R', route: { via: ['A'], auto: false } }, { routeExists: () => true }).ok, true);
  assert.equal(taxi({ runway: '27R' }, { runwayStatus: () => 'inspection' }).errors[0]?.reason, 'R14');
  assert.equal(taxi({ runway: '27R' }, { holdAllActive: true }).errors[0]?.reason, 'R24');
  const crossing = taxi({ runway: '27R' }, { nextCrossingRunway: '27L' });
  assert.ok(crossing.warnings.some(w => w.text === 'Route crosses runway 27L — hold short inserted'));
  assert.equal(validate('action-taxi-stand', { stand: '999' }, a, mkActionCtx('taxi_in')).errors[0]?.code, 'unknown_stand');
  const occ = validate('action-taxi-stand', { stand: '301' }, a, mkActionCtx('taxi_in'));
  assert.equal(occ.ok, true);
  assert.ok(occ.warnings.some(w => w.text === 'Stand 301 occupied by RYR9'));
  const cross = validate('action-cross', { runway: '27L' }, a, mkActionCtx('hold_short_cross', { arrivalOnFinal: () => ({ callsign: 'UAE5', nm: 1.2 }) }));
  assert.equal(cross.errors[0]?.reason, 'R4');
  const crossSoft = validate('action-cross', { runway: '27L' }, a, mkActionCtx('hold_short_cross', { arrivalOnFinal: () => ({ callsign: 'UAE5', nm: 3 }) }));
  assert.equal(crossSoft.ok, true);
  assert.ok(crossSoft.warnings.some(w => w.text.includes('crossing takes')));
  const arr = mkAircraft({ callsign: 'UAE5', plan: { kind: 'arrival', runway: '27L' } });
  const lahso = validate('action-land', { runway: '27L', lahso: '09L', exit: { kind: 'taxiway', taxiway: 'A7' } }, arr, mkActionCtx('arr_final'));
  assert.ok(lahso.warnings.some(w => w.text.includes('LAHSO')));
  assert.equal(validate('action-exit', { taxiway: 'A9' }, arr, mkActionCtx('rollout', { exits: [{ taxiway: 'A9', distAheadM: -50, dir: 'L', passed: true }] })).errors[0]?.code, 'unable_exit');
  assert.equal(validate('action-exit', { taxiway: 'Z1' }, arr, mkActionCtx('rollout')).errors[0]?.code, 'unable_exit');
  assert.equal(validate('action-exit', { taxiway: 'A7' }, arr, mkActionCtx('arr_short_final', { aglFt: 200 })).errors[0]?.reason, 'R6');
});

test('validate: stage / policy gates and missing params', () => {
  const a = mkAircraft({ plan: { kind: 'departure', runway: '27R' } });
  const hidden = validate('action-land', { runway: '27R' }, a, mkActionCtx('taxi_out'));
  assert.equal(hidden.ok, false);
  assert.equal(hidden.errors[0].code, 'invalid_stage');
  const disabled = validate('action-lineup', { runway: '27R' }, a, mkActionCtx('hold_short_cross'));
  assert.equal(disabled.errors[0].reason, 'X5');
  assert.equal(disabled.errors[0].text, REASONS.X5);
  const paused = validate('action-takeoff', { runway: '27R' }, a, mkActionCtx('lineup', { paused: true }));
  assert.ok(paused.errors.some(e => e.code === 'paused'));
  const missing = validate('action-takeoff', {}, a, mkActionCtx('lineup'));
  assert.ok(missing.errors.some(e => e.code === 'invalid_param' && e.text.includes('missing runway')));
  assert.equal(missing.ast, null);
  const contact = validateAst(makeAst('contact', a.callsign, { position: 'ground' }), mkAircraft({ onFrequency: 'ground' }), mkActionCtx('taxi_out'));
  assert.equal(contact.errors[0]?.code, 'already');
  const conflict = validateAst(makeAst('contact', a.callsign, { position: 'tower' }), a, mkActionCtx('hold_short_dep', { conflictActive: true }));
  assert.ok(conflict.warnings.some(w => w.text === 'Conflict active'));
  const seq = validateAst({ kind: 'sequence', callsign: a.callsign, parts: [makeAst('ils', a.callsign, { runway: '27L' }), makeAst('hold', a.callsign, { fix: 'OCK' })] }, a, mkActionCtx('arr_inbound'));
  assert.ok(seq.errors.some(e => e.text.startsWith('Incompatible parts')));
  const sys = validateAst(makeAst('dispatchVehicle', null, { type: 'arff', count: 2, target: { kind: 'runway', runway: '27L' } }), null, mkActionCtx('departed', { arrivalOnFinal: () => ({ callsign: 'X', nm: 1 }) }));
  assert.equal(sys.ok, true);
  assert.ok(sys.warnings.some(w => w.text === 'Runway in use — vehicle will hold short'));
  const noVeh = validateAst(makeAst('dispatchVehicle', null, { type: 'sweeper', count: 1, target: { kind: 'runway', runway: '27L' } }), null, mkActionCtx('departed'));
  assert.equal(noVeh.errors[0]?.reason, 'X17');
  const reopen = validateAst(makeAst('reopenRunway', null, { runway: '27L' }), null, mkActionCtx('departed', { vehicleOnRunway: () => 'OPS1' }));
  assert.equal(reopen.errors[0]?.code, 'runway_occupied');
  const close = validateAst(makeAst('runwayStatus', null, { runway: '27L', status: 'closed' }), null, mkActionCtx('departed', { arrivalOnFinal: () => ({ callsign: 'UAE5', nm: 3 }) }));
  assert.ok(close.warnings.some(w => w.text.includes('will go around')));
});

test('transmissionPreview: phraseology when a PhraseCtx is present, describe() fallback otherwise', () => {
  const ast = makeAst('taxi', 'BAW117', { dest: { kind: 'runway', runway: '27L', intersection: null }, via: ['A', 'B'], auto: false, holdShortOf: { kind: 'runway', runway: '27R' } });
  assert.equal(transmissionPreview(ast, {}), 'BAW117, Taxi RWY 27L via A, B, hold short 27R.');
  const tx = transmissionPreview(ast, { phraseCtx: mkPhraseCtx() });
  assert.ok(tx.startsWith('Speedbird one one seven, taxi to holding point runway two seven left via'), tx);
  assert.ok(tx.includes('hold short of runway two seven right'));
});

// ──────────────────────────────────────────────────────────────────────────────
//  Undo model (§1.6, §G9)
// ──────────────────────────────────────────────────────────────────────────────
test('undo: undoable kinds, no-ring kinds, sequences all-or-nothing', () => {
  assert.equal(undoable(makeAst('heading', 'X', { hdg: 90 })), true);
  assert.equal(undoable(makeAst('taxi', 'X', { dest: { kind: 'runway', runway: '27L', intersection: null } })), true);
  for (const k of ['standby', 'report', 'sayAgain', 'windCheck', 'roger', 'disregard'] as const) assert.equal(undoable(makeAst(k, 'X')), false, k);
  for (const ast of [makeAst('dispatchVehicle', null), makeAst('runwayStatus', null, { runway: '27L' }), makeAst('holdAll', null), makeAst('reopenRunway', null, { runway: '27L' })]) assert.equal(undoable(ast), false, ast.kind);
  assert.equal(undoable(makeAst('cancelTakeoff', 'X')), false, 'immediate kinds have no window');
  assert.equal(undoable({ kind: 'sequence', callsign: 'X', parts: [makeAst('altitude', 'X', { ft: 3000 }), makeAst('ils', 'X', { runway: '27L' })] }), true);
  assert.equal(undoable({ kind: 'sequence', callsign: 'X', parts: [makeAst('altitude', 'X', { ft: 3000 }), makeAst('report', 'X')] }), false);
  assert.equal(undoAst(makeAst('heading', 'BAW117', { hdg: 90 }))?.kind, 'disregard');
  assert.equal((undoAst(makeAst('heading', 'BAW117', { hdg: 90 })) as { callsign: string }).callsign, 'BAW117');
  assert.equal(undoAst(makeAst('report', 'BAW117')), null);
  assert.equal(undoAst(makeAst('broadcast', null, { text: 'x' })), null);
});

test('undo: window is sim-time bounded, never after execution, clamped to real time', () => {
  assert.equal(UNDO_WINDOW_S, 10);
  assert.equal(UNDO_MIN_REAL_S, 1.5);
  assert.equal(canUndo(100, 102, 105), true);
  assert.equal(canUndo(100, 105, 105), false, 'at applyAt the pilot has executed');
  assert.equal(canUndo(100, 105, 105, 0.8), true, 'real-time clamp keeps the ring at 4x');
  assert.equal(canUndo(100, 105, 105, 2), false);
  assert.equal(canUndo(100, 111, null), false, 'window expired');
  assert.equal(canUndo(100, 99, null), false);
  assert.equal(canUndo(100, 103, null), true);
});

test('undo: inverse restores previous targets (§G9), part by part for sequences', () => {
  const a = mkAircraft({ callsign: 'BAW117', targetHeading: 240, cmdAltitude: 5000, cmdIas: 210, assignedRunway: '27L', onFrequency: 'approach', navMode: 'direct', directTargetName: 'OCK', ilsArmed: false, expedite: false, holdShortRunway: '27R', exitTaxiway: 'A7' });
  const prev = snapshotFor(a, 100);
  assert.equal(prev.heading, 240); assert.equal(prev.altitude, 5000); assert.equal(prev.speed, 210); assert.equal(prev.runway, '27L');
  const inv = (ast: Parameters<typeof inverse>[0]) => inverse(ast, prev);
  assert.deepEqual(inv(makeAst('heading', 'BAW117', { hdg: 90, dir: 'L' })), makeAst('heading', 'BAW117', { hdg: 240 }));
  assert.deepEqual(inv(makeAst('altitude', 'BAW117', { ft: 3000 })), makeAst('altitude', 'BAW117', { ft: 5000 }));
  assert.deepEqual(inv(makeAst('speed', 'BAW117', { kts: 160 })), makeAst('speed', 'BAW117', { kts: 210 }));
  assert.deepEqual(inv(makeAst('direct', 'BAW117', { fix: 'BIG' })), makeAst('direct', 'BAW117', { fix: 'OCK' }), 'previous direct restored');
  assert.deepEqual(inv(makeAst('ils', 'BAW117', { runway: '27L' })), makeAst('cancelApproach', 'BAW117', { hdg: 240, alt: 5000 }), 'ILS inverse = cancel approach with prior targets');
  assert.deepEqual(inv(makeAst('contact', 'BAW117', { position: 'tower' })), makeAst('contact', 'BAW117', { position: 'approach', when: 'now' }));
  assert.deepEqual(inv(makeAst('holdShort', 'BAW117', { of: { kind: 'taxiway', taxiway: 'B' } })), makeAst('continue', 'BAW117', { holdShortOf: { kind: 'runway', runway: '27R' } }));
  assert.deepEqual(inv(makeAst('holdPosition', 'BAW117')), makeAst('continue', 'BAW117'));
  assert.deepEqual(inv(makeAst('continue', 'BAW117')), makeAst('holdPosition', 'BAW117'));
  assert.deepEqual(inv(makeAst('cross', 'BAW117', { runway: '27R' })), makeAst('holdShort', 'BAW117', { of: { kind: 'runway', runway: '27R' } }));
  assert.deepEqual(inv(makeAst('taxi', 'BAW117', { dest: { kind: 'runway', runway: '27L', intersection: null } })), makeAst('holdPosition', 'BAW117'));
  assert.deepEqual(inv(makeAst('pushback', 'BAW117')), makeAst('holdPosition', 'BAW117', { reason: 'stop pushback' }));
  assert.deepEqual(inv(makeAst('lineup', 'BAW117', { runway: '27L' })), makeAst('cancelLineup', 'BAW117'));
  assert.deepEqual(inv(makeAst('takeoff', 'BAW117', { runway: '27L' })), makeAst('cancelTakeoff', 'BAW117'));
  assert.deepEqual(inv(makeAst('clearedLand', 'BAW117', { runway: '27L' })), makeAst('continueApproach', 'BAW117'));
  assert.deepEqual(inv(makeAst('exitAt', 'BAW117', { exit: { kind: 'next', dir: 'R' } })), makeAst('exitAt', 'BAW117', { exit: { kind: 'taxiway', taxiway: 'A7' } }));
  assert.deepEqual(inv(makeAst('expedite', 'BAW117', { scope: 'descent' })), makeAst('expedite', 'BAW117', { on: false, scope: 'descent' }));
  assert.deepEqual(inv(makeAst('giveWay', 'BAW117', { to: 'X' })), makeAst('continue', 'BAW117'));
  for (const k of ['standby', 'report', 'windCheck', 'goAround', 'sayAgain', 'roger', 'squawk'] as const) assert.equal(inv(makeAst(k, 'BAW117')), null, `${k} has no radio inverse`);
  assert.equal(inv(makeAst('holdAll', null)), null);
  const seq = inv({ kind: 'sequence', callsign: 'BAW117', parts: [makeAst('heading', 'BAW117', { hdg: 90 }), makeAst('altitude', 'BAW117', { ft: 3000 }), makeAst('speed', 'BAW117', { kts: 160 })] });
  assert.equal(seq?.kind, 'sequence');
  assert.deepEqual((seq as { parts: Array<{ kind: string }> }).parts.map(p => p.kind), ['heading', 'altitude', 'speed'], 'collapsed to one transmission in ICAO order');
  const armedPrev = snapshotFor(mkAircraft({ callsign: 'X', ilsArmed: true, assignedRunway: '27R' }), 0);
  assert.deepEqual(inverse(makeAst('cancelApproach', 'X', { hdg: 90, alt: 3000 }), armedPrev), makeAst('ils', 'X', { runway: '27R' }));
  assert.deepEqual(inverse(makeAst('ils', 'X', { runway: '27L' }), armedPrev), makeAst('ils', 'X', { runway: '27R' }), 're-clearing the previous ILS');
  assert.equal(describe(seq!).length > 0, true);
});

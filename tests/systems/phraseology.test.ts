import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAst, sequence, type CommandAST, type CommandKind } from '../../src/lib/sim/commandAst';
import {
  transmission, readback, pilotRequestLine, unableLine, spokenAltitude, spokenRunway, spokenDigits, groupNumber, telephony, spokenWind,
  spokenFrequency, magneticHeading, ALL_SINGLE_KINDS, emergencyAckLine, soulsFuelQueryLine, soulsFuelReplyLine, lowAltitudeAlertLine,
  trafficAlertLine, windshearAlertLine, atisCurrentLine, vehicleLine, arffIntercomLine, goAroundAckLine, spokenQnh,
} from '../../src/lib/sim/phraseology';
import type { PilotRequestKind } from '../../src/lib/sim/types';
import { mkAircraft, mkCtx } from './helpers';

const ac = () => mkAircraft({ callsign: 'BAW117', altitude: 5000, targetAltitude: 5000, heading: 270, speed: 220, phase: 'descent', reservedStand: '512', plan: { kind: 'arrival', runway: '27L', dest: 'EGLL' } });
const ctxFAA = () => mkCtx({ variant: 'FAA', aircraft: ac() });
const ctxICAO = () => mkCtx({ variant: 'ICAO', aircraft: ac(), telephony: (cs) => telephony(cs, 'ICAO') });

test('spoken numbers: runways, altitudes, flight levels, FAA group form, ICAO digits', () => {
  assert.equal(spokenRunway('27L', 'FAA'), 'two seven left');
  assert.equal(spokenRunway('09R', 'ICAO'), 'zero niner right');
  assert.equal(spokenRunway('4', 'FAA'), 'zero four');
  assert.equal(spokenAltitude(3000, 'FAA'), 'three thousand');
  assert.equal(spokenAltitude(11000, 'FAA'), 'one one thousand');
  assert.equal(spokenAltitude(4500, 'FAA'), 'four thousand five hundred');
  assert.equal(spokenAltitude(19000, 'FAA'), 'flight level one nine zero');
  assert.equal(spokenAltitude(12000, 'ICAO', 6000), 'flight level one two zero');
  assert.equal(spokenDigits('240', 'ICAO'), 'two four zero');
  assert.equal(spokenDigits('359', 'ICAO'), 'tree fife niner');
  assert.equal(groupNumber('117'), 'one seventeen');
  assert.equal(groupNumber('1223'), 'twelve twenty-three');
  assert.equal(telephony('BAW117', 'FAA'), 'Speedbird one seventeen');
  assert.equal(telephony('BAW117', 'ICAO'), 'Speedbird one one seven');
  assert.equal(telephony('DLH2GK', 'ICAO'), 'Lufthansa two Golf Kilo');
  assert.equal(telephony('N123AB', 'ICAO'), 'November one two three Alpha Bravo');
  assert.equal(spokenWind({ dir: 260, kts: 8, gust: 0 }, 'FAA'), 'wind two six zero at eight');
  assert.equal(spokenWind({ dir: 260, kts: 8, gust: 18 }, 'ICAO'), 'wind two six zero degrees eight knots gusting one eight');
  assert.equal(spokenFrequency('118.505', 'ICAO'), 'one one eight decimal fife zero fife');
  assert.equal(spokenFrequency('118.5', 'FAA'), 'one one eight point five');
  assert.equal(magneticHeading(270, -2), 272);
  assert.equal(spokenQnh(1013, 'ICAO'), 'QNH one zero one tree');
  assert.equal(spokenQnh(1013, 'FAA'), 'altimeter two nine nine one');
});

interface Snap { ast: CommandAST; tx: string; rb: string }
const SNAPSHOT_FAA: Snap[] = [
  { ast: makeAst('startup', 'BAW117', { expectRunway: '27L' }), tx: 'Speedbird one seventeen, start-up approved, expect runway two seven left, altimeter two nine nine one.', rb: 'Start-up approved, runway two seven left, altimeter two nine nine one, Speedbird one seventeen.' },
  { ast: makeAst('pushback', 'BAW117', { dir: 'N', expectRunway: '27L' }), tx: 'Speedbird one seventeen, pushback approved, face north, expect runway two seven left.', rb: 'Pushback approved, facing north, expect runway two seven left, Speedbird one seventeen.' },
  { ast: makeAst('taxi', 'BAW117', { dest: { kind: 'runway', runway: '27L', intersection: null }, via: ['A', 'B'], auto: false, holdShortOf: { kind: 'runway', runway: '27R' } }), tx: 'Speedbird one seventeen, runway two seven left, taxi via Alpha, Bravo, hold short of runway two seven right.', rb: 'Runway two seven left via Alpha, Bravo, hold short two seven right, Speedbird one seventeen.' },
  { ast: makeAst('taxi', 'BAW117', { dest: { kind: 'stand', ref: '512' }, via: ['A'], cross: ['27R'] }), tx: 'Speedbird one seventeen, taxi to stand five one two via Alpha, cross runway two seven right.', rb: 'Stand five one two via Alpha, cross two seven right, Speedbird one seventeen.' },
  { ast: makeAst('holdShort', 'BAW117', { of: { kind: 'runway', runway: '27R' } }), tx: 'Speedbird one seventeen, hold short of runway two seven right.', rb: 'Hold short two seven right, Speedbird one seventeen.' },
  { ast: makeAst('cross', 'BAW117', { runway: '27R' }), tx: 'Speedbird one seventeen, cross runway two seven right, report vacated.', rb: 'Cross runway two seven right, wilco, Speedbird one seventeen.' },
  { ast: makeAst('lineup', 'BAW117', { runway: '27L', trafficInfo: 'Boeing 737 four mile final' }), tx: 'Speedbird one seventeen, runway two seven left, line up and wait, traffic Boeing 737 four mile final.', rb: 'Runway two seven left, line up and wait, traffic in sight, Speedbird one seventeen.' },
  { ast: makeAst('takeoff', 'BAW117', { runway: '27L', afterDepHdg: 250, initialAlt: 4000, contactDeparture: true }), tx: 'Speedbird one seventeen, runway two seven left, after departure fly heading two five zero, climb and maintain four thousand, on reaching contact departure one two zero point four, cleared for takeoff, wind two six zero at eight.', rb: 'Heading two five zero, climb four thousand, contact departure on reaching, cleared for takeoff runway two seven left, Speedbird one seventeen.' },
  { ast: makeAst('takeoff', 'BAW117', { runway: '27L', immediate: true }), tx: 'Speedbird one seventeen, runway two seven left, cleared for immediate takeoff, wind two six zero at eight.', rb: 'Cleared for immediate takeoff runway two seven left, Speedbird one seventeen.' },
  { ast: makeAst('cancelTakeoff', 'BAW117', { reason: 'vehicle on the runway' }), tx: 'Speedbird one seventeen, hold position, cancel takeoff clearance, I say again, cancel takeoff clearance, vehicle on the runway.', rb: 'Holding position, Speedbird one seventeen.' },
  { ast: makeAst('clearedLand', 'BAW117', { runway: '27L', exit: { kind: 'taxiway', taxiway: 'A5' } }), tx: 'Speedbird one seventeen, runway two seven left, cleared to land, vacate via Alpha five, wind two six zero at eight.', rb: 'Cleared to land runway two seven left, vacating via Alpha five, Speedbird one seventeen.' },
  { ast: makeAst('goAround', 'BAW117', { heading: 'runway', alt: 3000, contact: 'approach', reason: 'traffic on the runway' }), tx: 'Speedbird one seventeen, go around, I say again, go around, traffic on the runway, fly runway heading, climb and maintain three thousand, contact approach one one nine point seven.', rb: 'Going around, runway heading, climbing three thousand, approach one one nine point seven, Speedbird one seventeen.' },
  { ast: makeAst('contact', 'BAW117', { position: 'tower', when: 'now' }), tx: 'Speedbird one seventeen, contact tower one one eight point five.', rb: 'Tower one one eight point five, Speedbird one seventeen.' },
  { ast: makeAst('heading', 'BAW117', { hdg: 240, dir: 'L' }), tx: 'Speedbird one seventeen, turn left heading two four zero.', rb: 'Left heading two four zero, Speedbird one seventeen.' },
  { ast: makeAst('altitude', 'BAW117', { ft: 3000 }), tx: 'Speedbird one seventeen, descend and maintain three thousand.', rb: 'Descend three thousand, Speedbird one seventeen.' },
  { ast: makeAst('altitude', 'BAW117', { ft: 11000 }), tx: 'Speedbird one seventeen, climb and maintain one one thousand.', rb: 'Climb one one thousand, Speedbird one seventeen.' },
  { ast: makeAst('speed', 'BAW117', { kts: 160, untilNM: 4 }), tx: 'Speedbird one seventeen, reduce speed to one six zero knots until four mile final.', rb: 'Speed one six zero knots until four miles, Speedbird one seventeen.' },
  { ast: makeAst('hold', 'BAW117', { fix: 'BIG', inbound: 270, dir: 'R', legTimeMin: 1, efc: 75 * 60 }), tx: 'Speedbird one seventeen, hold at BIG, inbound course two seven zero, right turns, one minute legs, expect further clearance at one five.', rb: 'Hold at BIG, inbound two seven zero, right turns, one minute legs, EFC one five, Speedbird one seventeen.' },
  { ast: makeAst('ils', 'BAW117', { runway: '27L' }), tx: 'Speedbird one seventeen, cleared ILS runway two seven left approach, report established.', rb: 'Cleared ILS runway two seven left, will report established, Speedbird one seventeen.' },
  { ast: makeAst('cancelApproach', 'BAW117', { hdg: 360, alt: 4000, dir: 'R' }), tx: 'Speedbird one seventeen, cancel approach clearance, turn right heading three six zero, climb and maintain four thousand.', rb: 'Cancel approach, right heading three six zero, climb four thousand, Speedbird one seventeen.' },
  { ast: makeAst('radarContact', 'BAW117', { descendTo: 4000, expectRunway: '27L' }), tx: 'Speedbird one seventeen, Heathrow Director, radar contact, descend and maintain four thousand, altimeter two nine nine one, expect ILS runway two seven left approach.', rb: 'Radar contact, descend four thousand, altimeter two nine nine one, ILS two seven left, Speedbird one seventeen.' },
  { ast: makeAst('correction', 'BAW117', { field: 'heading', value: 250 }), tx: 'Speedbird one seventeen, negative, heading two five zero, I say again, heading two five zero.', rb: 'Heading two five zero, Speedbird one seventeen.' },
  { ast: makeAst('priority', 'BAW117', { runway: '27L', straightIn: true, sterile: true }), tx: 'Speedbird one seventeen, roger, expect runway two seven left, you are number one, straight-in, cleared ILS runway two seven left approach, runway is yours, no delay, emergency services are alerted.', rb: 'Cleared ILS two seven left, number one, Speedbird one seventeen.' },
  { ast: makeAst('holdAll', null, { scope: 'departures', runway: '27L' }), tx: 'All stations, Heathrow Tower, emergency in progress, all departures runway two seven left hold position.', rb: '' },
  { ast: makeAst('dispatchVehicle', null, { type: 'arff', count: 3, target: { kind: 'runway', runway: '27L' } }), tx: 'Fire 1, 2, 3, proceed to runway two seven left, runway is yours.', rb: 'Fire station copies, rolling.' },
  { ast: makeAst('vehicleOp', null, { id: 'FIRE1', op: 'cross', runway: '27R' }), tx: 'Fire 1, cross runway two seven right, report vacated.', rb: 'Crossing two seven right, Fire 1.' },
  { ast: sequence('BAW117', [makeAst('ils', 'BAW117', { runway: '27L' }), makeAst('altitude', 'BAW117', { ft: 3000 })]), tx: 'Speedbird one seventeen, descend and maintain three thousand, cleared ILS runway two seven left approach, report established.', rb: 'Descend three thousand, cleared ILS runway two seven left, will report established, Speedbird one seventeen.' },
];

test('phraseology snapshot (FAA): 27 representative ASTs', () => {
  const ctx = ctxFAA();
  for (const s of SNAPSHOT_FAA) {
    assert.equal(transmission(s.ast, ctx), s.tx, `TX ${s.ast.kind}`);
    assert.equal(readback(s.ast, ctx), s.rb, `RB ${s.ast.kind}`);
  }
});

test('ICAO variant differences: holding point taxi, descend to, ILS approach runway, wind degrees/knots, decimal, cancel takeoff', () => {
  const ctx = ctxICAO();
  assert.equal(transmission(makeAst('taxi', 'BAW117', { dest: { kind: 'runway', runway: '27L', intersection: null }, via: ['A', 'B'], auto: false, holdShortOf: { kind: 'runway', runway: '27R' } }), ctx),
    'Speedbird one one seven, taxi to holding point runway two seven left via Alpha, Bravo, hold short of runway two seven right.');
  assert.equal(transmission(makeAst('altitude', 'BAW117', { ft: 3000 }), ctx), 'Speedbird one one seven, descend to tree thousand.');
  assert.equal(transmission(makeAst('altitude', 'BAW117', { ft: 12000 }), ctx), 'Speedbird one one seven, climb to flight level one two zero.');
  assert.equal(transmission(makeAst('ils', 'BAW117', { runway: '27L' }), ctx), 'Speedbird one one seven, cleared ILS approach runway two seven left, report established.');
  assert.equal(transmission(makeAst('takeoff', 'BAW117', { runway: '27L' }), ctx), 'Speedbird one one seven, wind two six zero degrees eight knots, runway two seven left, cleared for takeoff.');
  assert.equal(transmission(makeAst('contact', 'BAW117', { position: 'tower' }), ctx), 'Speedbird one one seven, contact tower one one eight decimal fife.');
  assert.equal(transmission(makeAst('cancelTakeoff', 'BAW117', {}), ctx), 'Speedbird one one seven, hold position, cancel takeoff, I say again, cancel takeoff.');
  assert.equal(transmission(makeAst('startup', 'BAW117', { expectRunway: '27L' }), ctx), 'Speedbird one one seven, start-up approved, expect runway two seven left, QNH one zero one tree.');
  // variant override on readback
  assert.equal(readback(makeAst('altitude', 'BAW117', { ft: 3000 }), ctxFAA(), 'ICAO'), 'Descend tree thousand, Speedbird one seventeen.');
});

test('every CommandAST kind produces a transmission and a readback (no throws, callsign placement)', () => {
  const ctx = ctxFAA();
  const a = ctx.aircraft!;
  a.emergency = { type: 'engine_fire', level: 'MAYDAY', status: 'declared', declaredAt: 0, phase: 'climb', stage: 'dep_climb', soulsOnBoard: 147, fuelMin: 80, squawk: '7700', requests: ['request immediate return'], runway: '27L', priority: false, sterile: false, arff: 'none', arffOnSceneAt: null, stopOnRunway: false, evacuation: false, closureMin: 0, landedAt: null, stoppedAt: null, resolvedAt: null, checklist: { acknowledge: null, souls_fuel: null, priority_runway: null, arff: null, ambulance: null, hold_traffic: null, runway_closed: null, runway_reopened: null, inspection: null }, pilotLine: '' };
  const seen = new Set<CommandKind>();
  for (const kind of ALL_SINGLE_KINDS) {
    const ast = makeAst(kind, 'BAW117', {} as never);
    // fill the mandatory identifiers so the strings are meaningful
    const any = ast as unknown as Record<string, unknown>;
    if ('runway' in any && !any.runway) any.runway = '27L';
    if ('fix' in any && !any.fix) any.fix = 'BIG';
    if ('to' in any && !any.to) any.to = 'DLH2GK';
    if ('code' in any && !any.code) any.code = '4217';
    if (kind === 'holdShort') any.of = { kind: 'runway', runway: '27R' };
    if (kind === 'heading') any.hdg = 240;
    if (kind === 'altitude') any.ft = 4000;
    if (kind === 'cancelApproach') { any.hdg = 360; any.alt = 4000; }
    const tx = transmission(ast, ctx);
    const rb = readback(ast, ctx);
    assert.ok(tx.startsWith('Speedbird one seventeen'), `${kind}: TX starts with the callsign: ${tx}`);
    assert.ok(tx.endsWith('.'), `${kind}: TX terminated`);
    if (kind !== 'roger') assert.ok(rb.endsWith('Speedbird one seventeen.'), `${kind}: RB ends with the callsign: ${rb}`);
    seen.add(kind);
  }
  for (const kind of ['holdAll', 'resumeAll', 'reopenRunway', 'dispatchVehicle', 'recallVehicle', 'vehicleOp', 'runwayStatus', 'broadcast'] as const) {
    const ast = makeAst(kind, null, {} as never);
    const any = ast as unknown as Record<string, unknown>;
    if ('runway' in any && !any.runway) any.runway = '27L';
    if ('id' in any && !any.id) any.id = 'OPS1';
    if ('text' in any && !any.text) any.text = 'stop transmitting, MAYDAY';
    const tx = transmission(ast, ctx);
    assert.ok(tx.length > 5 && tx.endsWith('.'), `${kind}: ${tx}`);
    readback(ast, ctx);
    seen.add(kind);
  }
  assert.equal(seen.size, 52, 'all 44 single kinds + 8 system kinds');
});

test('partial refusal renders "unable {part}" inside the readback; unableLine', () => {
  const ctx = ctxFAA();
  const spd = makeAst('speed', 'BAW117', { kts: 160 });
  const seq = sequence('BAW117', [makeAst('heading', 'BAW117', { hdg: 240, dir: 'L' }), spd]);
  assert.equal(readback(seq, ctx, undefined, [spd]), 'Left heading two four zero, unable one six zero knots, Speedbird one seventeen.');
  assert.equal(unableLine(spd, 'minimum clean two one zero', ctx), 'Unable one six zero knots, minimum clean two one zero, Speedbird one seventeen.');
  assert.equal(unableLine(makeAst('takeoff', 'BAW117', { runway: '27L', immediate: true }), '', ctx), 'Unable immediate, Speedbird one seventeen.');
});

test('pilot request lines for every PilotRequest kind', () => {
  const ctx = ctxFAA();
  const kinds: PilotRequestKind[] = ['clearance', 'pushback', 'startup', 'taxi', 'cross', 'ready', 'with_you', 'higher', 'lower', 'direct', 'hold', 'taxi_in', 'say_again', 'radio_check', 'cancel_mayday', 'return_to_stand', 'wind_check', 'confirm_cleared', 'further', 'intersection', 'runway_vacated', 'going_around'];
  for (const kind of kinds) {
    const line = pilotRequestLine({ id: 1, kind, callsign: 'BAW117', text: '', param: kind === 'cross' ? '27R' : kind === 'direct' ? 'BIG' : kind === 'higher' ? 12000 : kind === 'intersection' ? 'A3' : null, at: 0, recallAt: 0, recalls: 0, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null }, ctx);
    assert.ok(/Speedbird one seventeen/.test(line), `${kind}: ${line}`);
    assert.ok(line.endsWith('.'), `${kind} terminated`);
  }
  assert.equal(pilotRequestLine({ id: 1, kind: 'pushback', callsign: 'BAW117', text: '', param: null, at: 0, recallAt: 0, recalls: 0, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null }, ctx), 'Heathrow Ground, Speedbird one seventeen, stand five one two, request pushback, information Kilo.');
  assert.equal(pilotRequestLine({ id: 1, kind: 'cross', callsign: 'BAW117', text: '', param: '27R', at: 0, recallAt: 0, recalls: 0, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null }, ctx), 'Speedbird one seventeen, holding short runway two seven right, request cross.');
  // with_you for an established arrival on tower
  const arr = mkAircraft({ callsign: 'BAW117', phase: 'approach', ilsCaptured: true, assignedRunway: '27L', onFrequency: 'tower' });
  const line = pilotRequestLine({ id: 2, kind: 'with_you', callsign: 'BAW117', text: '', param: 8, at: 0, recallAt: 0, recalls: 0, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null }, mkCtx({ variant: 'FAA', aircraft: arr }));
  assert.equal(line, 'Heathrow Tower, Speedbird one seventeen, ILS runway two seven left, eight miles.');
});

test('emergency / safety / vehicle lines', () => {
  const ctx = ctxFAA();
  assert.equal(emergencyAckLine('BAW117', 'MAYDAY', ctx), 'Speedbird one seventeen, roger MAYDAY, Heathrow Ground, say intentions.');
  assert.equal(soulsFuelQueryLine('BAW117', ctx), 'Speedbird one seventeen, say souls on board and fuel remaining in minutes.');
  assert.equal(soulsFuelQueryLine('BAW117', ctxICAO()), 'Speedbird one one seven, report persons on board and endurance.');
  assert.equal(soulsFuelReplyLine('BAW117', 147, 80, ctx), 'One four seven souls, fuel one hour two zero, Speedbird one seventeen.');
  assert.equal(lowAltitudeAlertLine('BAW117', 3000, ctx), 'Speedbird one seventeen, low altitude alert, check your altitude immediately, the MVA in your area is three thousand, climb and maintain three thousand.');
  assert.equal(trafficAlertLine('BAW117', 'traffic twelve o\'clock, two miles', 'turn left heading two four zero', ctx), 'Speedbird one seventeen, traffic alert, traffic twelve o\'clock, two miles, turn left heading two four zero immediately.');
  assert.equal(windshearAlertLine('BAW117', { runway: '27L', type: 'MB', lossKt: 40 }, 'arrival', ctx), 'Speedbird one seventeen, microburst alert, runway two seven left arrival, four zero knot loss, two mile final.');
  assert.equal(atisCurrentLine('BAW117', 'L', 1013, ctxICAO()), 'Speedbird one one seven, information Lima now current, QNH one zero one tree.');
  assert.equal(vehicleLine('request_cross', 'FIRE1', '27R', ctx), 'Heathrow Ground, Fire 1, request cross runway two seven right.');
  assert.equal(vehicleLine('inspection_complete', 'OPS1', '27L', ctx), 'Heathrow Ground, Ops 1, runway two seven left inspection complete, no FOD found, vacating.');
  assert.equal(arffIntercomLine('full', '27L', 'B738', 'engine fire', 147, 80, 12, ctx), 'Full emergency, runway two seven left, Boeing 737, engine fire, 147 souls, 80 minutes fuel, ETA 12 minutes.');
  assert.equal(goAroundAckLine('BAW117', 3000, ctx), 'Speedbird one seventeen, roger, fly runway heading, climb and maintain three thousand, contact approach one one nine point seven.');
});

test('deterministic: identical inputs give identical strings across calls', () => {
  const ctx = ctxFAA();
  const ast = makeAst('clearedLand', 'BAW117', { runway: '27L', number: 2, trafficInfo: 'Boeing 737 two mile final' });
  const a = transmission(ast, ctx), b = transmission(ast, ctx);
  assert.equal(a, b);
  assert.equal(a, 'Speedbird one seventeen, number two, traffic Boeing 737 two mile final, runway two seven left, cleared to land, wind two six zero at eight.');
});

// ──────────────────────────────────────────────────────────────────────────────
//  Completeness: every CommandAST kind (44 single + 8 system + sequence) and every
//  PilotRequest kind. The maps below are typed Record<Kind, ...> so adding a kind to
//  commandAst.ts / types.ts without a representative here is a compile error.
// ──────────────────────────────────────────────────────────────────────────────
type Fields = Record<string, unknown>;
const REPRESENTATIVE: Record<Exclude<CommandKind, 'sequence'>, Fields> = {
  startup: { expectRunway: '27L' },
  pushback: { dir: 'N', tailTo: 'A', expectRunway: '27L' },
  taxi: { dest: { kind: 'runway', runway: '27L', intersection: null }, via: ['A', 'B'], holdShortOf: { kind: 'runway', runway: '27R' } },
  holdShort: { of: { kind: 'runway', runway: '27R' } },
  holdPosition: { reason: 'traffic crossing' },
  continue: { holdShortOf: { kind: 'taxiway', taxiway: 'C' } },
  cross: { runway: '27R' },
  giveWay: { to: 'DLH2GK', mode: 'give_way' },
  lineup: { runway: '27L', intersection: 'A3' },
  takeoff: { runway: '27L', wind: true, afterDepHdg: 'runway', initialAlt: 4000 },
  cancelTakeoff: { reason: 'vehicle on the runway' },
  cancelLineup: { via: 'A3' },
  exitAt: { exit: { kind: 'taxiway', taxiway: 'A7' }, contactGround: true },
  expedite: { on: true, scope: 'taxi' },
  clearedLand: { runway: '27L', wind: true, exit: { kind: 'next', dir: 'L' } },
  continueApproach: { number: 2 },
  goAround: { heading: 'runway', alt: 3000, reason: 'traffic on the runway' },
  windCheck: {},
  contact: { position: 'tower', when: 'now' },
  heading: { hdg: 240, dir: 'L' },
  altitude: { ft: 4000 },
  speed: { kts: 180, untilNM: 4 },
  direct: { fix: 'BIG' },
  hold: { fix: 'LAM', inbound: 270, dir: 'R', legTimeMin: 1, efc: 45 * 60 },
  ils: { runway: '27L', reportEstablished: true },
  loc: { runway: '27L', maintainAlt: 3000 },
  visual: { runway: '27L' },
  cancelApproach: { hdg: 360, alt: 4000, dir: 'L', reason: 'traffic' },
  expectRunway: { runway: '27R', approach: 'ILS' },
  resumeSid: {},
  squawk: { code: '4217' },
  ident: {},
  radarContact: { descendTo: 5000, expectRunway: '27L' },
  sayAgain: {},
  correction: { field: 'heading', value: 250 },
  disregard: {},
  standby: {},
  unable: { reason: 'traffic' },
  report: { items: ['position', 'altitude'] },
  roger: {},
  emergencyAck: { ask: ['pob', 'fuel', 'intentions'], squawk: true },
  priority: { runway: '27L', numberOne: true, straightIn: true, clearIls: true, sterile: true },
  stopOnRunway: { mode: 'stop', via: null },
  emergencyCancelAck: {},
  holdAll: { scope: 'all', runway: null },
  resumeAll: {},
  reopenRunway: { runway: '27L', afterInspection: true },
  dispatchVehicle: { type: 'arff', ids: [], count: 2, target: { kind: 'runway', runway: '27L' } },
  recallVehicle: { id: 'FIRE1' },
  vehicleOp: { id: 'OPS1', op: 'cross', runway: '27R' },
  runwayStatus: { runway: '27L', status: 'closed', reason: 'disabled aircraft' },
  broadcast: { text: 'stop transmitting, MAYDAY' },
};
/** Kinds whose pilot/driver side is silent by design: "all stations" broadcasts have no readback; a pilot does not answer "roger". */
const NO_READBACK = new Set<CommandKind>(['roger', 'holdAll', 'resumeAll', 'runwayStatus', 'broadcast']);

const REQUEST_PARAM: Record<PilotRequestKind, string | number | null> = {
  clearance: null, pushback: null, startup: null, taxi: null, cross: '27R', ready: '27L', with_you: 8, higher: 12000, lower: 3000,
  direct: 'BIG', hold: null, taxi_in: 'A7', say_again: null, radio_check: null, cancel_mayday: 'fire is out', return_to_stand: 'technical problem',
  wind_check: null, confirm_cleared: 4, further: null, intersection: 'A3', runway_vacated: '27L', going_around: 'unstable approach',
};

test('completeness: every CommandAST kind has a non-empty transmission and readback (both variants); sequence included', () => {
  for (const variant of ['ICAO', 'FAA'] as const) {
    const ctx = variant === 'FAA' ? ctxFAA() : ctxICAO();
    const a = ctx.aircraft!;
    a.emergency = { type: 'engine_fire', level: 'MAYDAY', status: 'declared', declaredAt: 0, phase: 'climb', stage: 'dep_climb', soulsOnBoard: 147, fuelMin: 80, squawk: '7700', requests: ['request immediate return'], runway: '27L', priority: false, sterile: false, arff: 'none', arffOnSceneAt: null, stopOnRunway: false, evacuation: false, closureMin: 0, landedAt: null, stoppedAt: null, resolvedAt: null, checklist: { acknowledge: null, souls_fuel: null, priority_runway: null, arff: null, ambulance: null, hold_traffic: null, runway_closed: null, runway_reopened: null, inspection: null }, pilotLine: '' };
    const cs = variant === 'FAA' ? 'Speedbird one seventeen' : 'Speedbird one one seven';
    const asts: CommandAST[] = (Object.keys(REPRESENTATIVE) as Array<keyof typeof REPRESENTATIVE>).map(kind => makeAst(kind, 'BAW117', REPRESENTATIVE[kind] as never));
    asts.push(sequence('BAW117', [makeAst('altitude', 'BAW117', { ft: 3000 }), makeAst('ils', 'BAW117', { runway: '27L', reportEstablished: true })]));
    assert.equal(asts.length, 53, '44 single + 8 system + sequence');
    for (const ast of asts) {
      const tx = transmission(ast, ctx);
      const rb = readback(ast, ctx);
      assert.ok(tx.trim().length > 0, `${variant} ${ast.kind}: empty transmission`);
      assert.ok(/[a-z]/i.test(tx) && tx.endsWith('.'), `${variant} ${ast.kind}: TX is a sentence: ${tx}`);
      assert.ok(!/undefined|null|NaN|\[object/.test(tx), `${variant} ${ast.kind}: TX leaks a value: ${tx}`);
      if ('callsign' in ast) assert.ok(tx.startsWith(cs), `${variant} ${ast.kind}: TX addresses the aircraft: ${tx}`);
      if (NO_READBACK.has(ast.kind)) continue;
      assert.ok(rb.trim().length > 0, `${variant} ${ast.kind}: empty readback for ${tx}`);
      assert.ok(rb.endsWith('.'), `${variant} ${ast.kind}: RB terminated: ${rb}`);
      assert.ok(!/undefined|null|NaN|\[object/.test(rb), `${variant} ${ast.kind}: RB leaks a value: ${rb}`);
      if ('callsign' in ast) assert.ok(rb.endsWith(`${cs}.`), `${variant} ${ast.kind}: RB ends with the callsign: ${rb}`);
    }
  }
});

test('completeness: every PilotRequest kind has a non-empty spoken line (both variants)', () => {
  for (const variant of ['ICAO', 'FAA'] as const) {
    const ctx = variant === 'FAA' ? ctxFAA() : ctxICAO();
    const cs = variant === 'FAA' ? 'Speedbird one seventeen' : 'Speedbird one one seven';
    const kinds = Object.keys(REQUEST_PARAM) as PilotRequestKind[];
    assert.equal(kinds.length, 22);
    for (const kind of kinds) {
      const line = pilotRequestLine({ id: 1, kind, callsign: 'BAW117', text: '', param: REQUEST_PARAM[kind], at: 0, recallAt: 0, recalls: 0, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null }, ctx);
      assert.ok(line.trim().length > 0 && line.endsWith('.'), `${variant} ${kind}: ${line}`);
      assert.ok(line.includes(cs), `${variant} ${kind}: names the aircraft: ${line}`);
      assert.ok(!/undefined|null|NaN|\[object/.test(line), `${variant} ${kind}: leaks a value: ${line}`);
    }
  }
});

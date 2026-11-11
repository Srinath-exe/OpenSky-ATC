// The pilot's eyes and ears (src/lib/sim/pilotmind.ts, docs/spec/13-PILOT-BRAIN.md): story tests for looking ahead and
// for the party line. Every story is a scripted scene with the call a real crew would make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, text, spawnOnFinal, advance, NM_TO_M } from './helpers';
import { mindOf } from '../../src/lib/sim/pilotmind';

const EGLL = () => makeEngine('EGLL', { ends: ['27R', '27L'] });
const lineUp = (e: ReturnType<typeof makeEngine>, cs: string, rw: string) => e.spawnAt({ callsign: cs, type: 'A320', kind: 'departure', phase: 'lineup', runway: rw, onFrequency: 'tower' });
const holdShort = (e: ReturnType<typeof makeEngine>, cs: string, rw: string) => e.spawnAt({ callsign: cs, type: 'A320', kind: 'departure', phase: 'hold_short', runway: rw, onFrequency: 'tower' });

test('story: cleared to land on short final with traffic lined up: the pilot asks; repeating the clearance confirms it', () => {
  const e = EGLL();
  lineUp(e, 'BAW1', '27L');
  const a = spawnOnFinal(e, 'DAL2', '27L', 3);
  run(e, 2);
  const q = text(e, 'DAL2 Cleared to land 27L');
  assert.equal(q.code, 'queried');
  assert.match(q.readback, /traffic lined up, confirm cleared to land runway 27L\?$/);
  assert.equal(a.landingCleared, false, 'nothing executed while the question is open');
  assert.equal(text(e, 'DAL2 Cleared to land 27L').ok, true, 'the same clearance again is the confirmation');
  run(e, 4);
  assert.equal(a.landingCleared, true);
});

test('story: the party line: the arrival heard the departure cleared to line up, and says so', () => {
  const e = EGLL();
  holdShort(e, 'BAW1', '27L');
  const a = spawnOnFinal(e, 'DAL2', '27L', 9);
  run(e, 2);
  assert.equal(text(e, 'BAW1 Line up 27L').ok, true, 'nine miles out: a normal line-up');
  const up = runUntil(e, () => e.runwayState('27L')!.occupiedBy.some((o) => o.callsign === 'BAW1' && o.kind === 'lineup') && (e.distToThresholdNM(a, '27L') ?? 9) < 3.2, 240);
  assert.ok(up.ok, 'the departure is on the runway and the arrival is inside 3 NM');
  const q = text(e, 'DAL2 Cleared to land 27L');
  assert.equal(q.code, 'queried');
  assert.match(q.readback, /we heard .+ cleared to line up, confirm cleared to land runway 27L\?$/);
});

test('story: a landing clearance far out is accepted; the pilot calls when the runway is still blocked on short final', () => {
  const e = EGLL();
  lineUp(e, 'BAW1', '27L');
  const a = spawnOnFinal(e, 'DAL2', '27L', 8);
  run(e, 2);
  assert.equal(text(e, 'DAL2 Cleared to land 27L').ok, true, 'eight miles out the departure has time to go');
  const called = runUntil(e, () => a.requests[0]?.kind === 'confirm_cleared', 200);
  assert.ok(called.ok, 'the pilot called');
  const d = e.distToThresholdNM(a, '27L')!;
  assert.ok(d <= 3.6 && d > 1.0, `called at ${d.toFixed(1)} NM, before the forced go-around`);
  assert.match(a.requests[0].text, /mile final, traffic lined up, confirm cleared to land\?$/);
  assert.equal(mindOf(e).stats.runwayCalls, 1);
  text(e, 'DAL2 Go around');
  assert.equal(a.requests.filter((r) => r.kind === 'confirm_cleared' && r.answeredAt == null).length, 0, 'any instruction answers the call');
});

test('a clear runway, or a departure already rolling far ahead, raises nothing', () => {
  const e = EGLL();
  const a = spawnOnFinal(e, 'DAL2', '27L', 3);
  run(e, 2);
  assert.equal(text(e, 'DAL2 Cleared to land 27L').ok, true);
  run(e, 30);
  assert.equal(mindOf(e).stats.runwayCalls + mindOf(e).stats.questions, 0);
  assert.equal(a.landingCleared, true);
});

test('story: line up with an arrival on short final: the pilot at the holding point asks', () => {
  const e = EGLL();
  holdShort(e, 'BAW1', '27L');
  spawnOnFinal(e, 'DAL2', '27L', 1.9, { landingCleared: true });
  run(e, 1);
  const q = text(e, 'BAW1 Line up 27L');
  assert.equal(q.code, 'queried');
  assert.match(q.readback, /traffic on 2 mile final, confirm line up runway 27L\?$/);
  const e2 = EGLL();
  holdShort(e2, 'BAW1', '27L');
  spawnOnFinal(e2, 'DAL2', '27L', 6);
  run(e2, 1);
  assert.equal(text(e2, 'BAW1 Line up 27L').ok, true, 'six miles out is a normal line-up');
});

test('story: two aircraft converging at the same level: the one that has the other ahead reports the traffic, once', () => {
  const e = EGLL();
  const a = spawnOnFinal(e, 'BAW327', '27L', 20, { altFt: 6000, onFrequency: 'approach' });
  a.ilsArmed = false; a.ilsCaptured = false; a.navMode = 'heading'; a.targetHeading = a.heading; a.targetAltitude = 6000; a.cmdAltitude = 6000;
  const b = spawnOnFinal(e, 'DLH978', '27L', 20, { altFt: 6000, onFrequency: 'approach' });
  b.ilsArmed = false; b.ilsCaptured = false; b.navMode = 'heading'; b.targetAltitude = 6000; b.cmdAltitude = 6000;
  // b: 7 NM ahead of a, flying straight back at it
  b.pos = advance(a.pos, a.heading, 7 * NM_TO_M); b.heading = (a.heading + 180) % 360; b.targetHeading = b.heading;
  const said = runUntil(e, () => a.requests[0]?.kind === 'concern' || b.requests[0]?.kind === 'concern', 60);
  assert.ok(said.ok, 'a traffic call was made');
  const req = (a.requests[0] ?? b.requests[0]);
  assert.match(req.text, /traffic 12 o'clock, \d+ miles, same level, converging\.$/);
  run(e, 40);
  assert.equal(mindOf(e).stats.trafficCalls, 1, 'said once, not repeated');
});

test('in-trail and parallel established approaches are never reported as converging traffic', () => {
  const e = EGLL();
  spawnOnFinal(e, 'BAW1', '27L', 6); spawnOnFinal(e, 'BAW2', '27L', 9); spawnOnFinal(e, 'BAW3', '27R', 6);
  run(e, 60);
  assert.equal(mindOf(e).stats.trafficCalls, 0);
});

test('story: the party line: a go-around for wind ahead, and the next one on the approach asks for a wind check', () => {
  const e = EGLL();
  const lead = spawnOnFinal(e, 'BAW1', '27L', 3, { landingCleared: true });
  const next = spawnOnFinal(e, 'DAL2', '27L', 6.5);
  const far = spawnOnFinal(e, 'AFR3', '27R', 5);
  run(e, 2);
  e.initiateGoAround(lead, 'gusts', false);
  run(e, 2);
  assert.equal(next.requests[0]?.kind, 'wind_check');
  assert.match(next.requests[0].text, /copied the go-around ahead, request wind check\.$/);
  assert.equal(far.requests.length, 0, 'the other runway is not concerned');
  assert.equal(text(e, 'DAL2 Wind check').ok, true);
  assert.equal(next.requests.length, 0);
});

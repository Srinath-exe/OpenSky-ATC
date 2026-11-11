// The pilot's memory (src/lib/sim/ledger.ts, docs/spec/13-PILOT-BRAIN.md): story tests for the clearance ledger and
// the questions a pilot asks when an instruction contradicts a recent one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, text, spawnOnFinal } from './helpers';
import { ledgerOf } from '../../src/lib/sim/ledger';

function airborne(e: ReturnType<typeof makeEngine>, cs = 'BAW327') {
  const a = spawnOnFinal(e, cs, '27L', 18, { altFt: 6000, onFrequency: 'approach' });
  a.ilsArmed = false; a.ilsCaptured = false;
  return a;
}

test('story: a climb reversed into a descent within 90 s is questioned; repeating it confirms', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = airborne(e);
  assert.equal(text(e, 'BAW327 Altitude 9000').ok, true);
  run(e, 20);
  const q = text(e, 'BAW327 Altitude 4000');
  assert.equal(q.code, 'queried');
  assert.match(q.readback, /previously cleared to climb FL090, confirm now 4000\?$/);
  assert.equal(Math.round(a.targetAltitude), 9000, 'nothing executed while the question is open');
  assert.equal(text(e, 'BAW327 Altitude 4000').ok, true, 'the same instruction again is the confirmation');
  run(e, 10);
  assert.equal(Math.round(a.targetAltitude), 4000);
  assert.equal(ledgerOf(e).text('BAW327'), 'level 4000');
});

test('story: "roger" confirms the questioned instruction; a different instruction replaces it', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = airborne(e);
  text(e, 'BAW327 Altitude 9000'); run(e, 15);
  assert.equal(text(e, 'BAW327 Altitude 4000').code, 'queried');
  assert.equal(text(e, 'BAW327 Roger').ok, true);
  run(e, 10);
  assert.equal(Math.round(a.targetAltitude), 4000);

  const b = airborne(e, 'DLH978');
  text(e, 'DLH978 Altitude 9000'); run(e, 15);
  assert.equal(text(e, 'DLH978 Altitude 4000').code, 'queried');
  assert.equal(text(e, 'DLH978 Altitude 5000').code, 'queried', 'still a reversal: asked again, about the new level');
  assert.equal(text(e, 'DLH978 Altitude 10000').ok, true, 'a level on the same side is a normal amendment');
  run(e, 10);
  assert.equal(Math.round(b.targetAltitude), 10000);
});

test('normal amendments are never questioned: step climb, a reversal after the level was flown, a late change', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = airborne(e);
  assert.equal(text(e, 'BAW327 Altitude 7000').ok, true);
  run(e, 20);
  assert.equal(text(e, 'BAW327 Altitude 9000').ok, true, 'step climb');
  run(e, 120);
  assert.equal(text(e, 'BAW327 Altitude 4000').ok, true, 'two minutes later it is a new plan, not a slip');
  assert.equal(a.callsign, 'BAW327');
});

test('story: a heading reversed by 120 degrees or more within 90 s is questioned', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  airborne(e);
  assert.equal(text(e, 'BAW327 Fly heading 090').ok, true);
  run(e, 20);
  assert.equal(text(e, 'BAW327 Fly heading 120').ok, true, 'a vector change is normal');
  run(e, 20);
  const q = text(e, 'BAW327 Fly heading 300');
  assert.equal(q.code, 'queried');
  assert.match(q.readback, /previously heading 120, confirm now heading 300\?$/);
  assert.equal(text(e, 'BAW327 Fly heading 300').ok, true);
});

test('the ledger remembers what is in force and what was replaced or withdrawn', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  airborne(e);
  text(e, 'BAW327 Altitude 5000'); text(e, 'BAW327 Fly heading 180'); text(e, 'BAW327 Speed 210');
  const L = ledgerOf(e);
  assert.equal(L.text('BAW327'), 'level 5000 · heading 180 · speed 210');
  run(e, 200);
  text(e, 'BAW327 Fly heading 200');
  assert.deepEqual(L.entries('BAW327').map((x) => x.status), ['active', 'superseded', 'active', 'active']);
  assert.equal(L.text('BAW327'), 'level 5000 · speed 210 · heading 200');
});

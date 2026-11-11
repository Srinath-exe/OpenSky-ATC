// Who is flying (src/lib/sim/persona.ts): a crew's character is fixed by its callsign and changes how it behaves,
// never what the phraseology says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, text, spawnOnFinal } from './helpers';
import { personaOf, personaLine, stressOf, delayFactor, errorFactor, overloadChance, type PersonaKind } from '../../src/lib/sim/persona';
import { setSeed } from '../../src/lib/sim/rng';

const find = (kind: PersonaKind, airline = true) => {
  for (let i = 1; i < 5000; i++) { const cs = airline ? `BAW${i}` : `GB${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}${i % 10}`; if (personaOf(cs).kind === kind) return cs; }
  throw new Error(`no ${kind}`);
};

test('a callsign always gets the same crew; airlines and general aviation have their own mix', () => {
  assert.deepEqual(personaOf('BAW327'), personaOf('baw327'));
  const n: Record<string, number> = {};
  for (let i = 1; i <= 2000; i++) { const k = personaOf(`DLH${i}`).kind; n[k] = (n[k] ?? 0) + 1; }
  assert.ok(!n.student, 'no students on airliners');
  assert.ok(n.captain > 400 && n.line > 800 && n.rookie > 200 && n.visitor > 200, JSON.stringify(n));
  let students = 0;
  for (let i = 0; i < 500; i++) if (personaOf(`N${100 + i}AB`).kind === 'student') students++;
  assert.ok(students > 150 && students < 300, `students ${students}`);
});

test('hesitation never changes a number, a callsign or a runway', () => {
  const rookie = personaOf(find('rookie'));
  const line = 'Cleared to land runway two seven left, Speedbird three two seven.';
  assert.equal(personaLine(line, rookie, 0, 0.1), 'Uh, cleared to land runway two seven left, Speedbird three two seven.');
  assert.equal(personaLine(line, rookie, 0, 0.9), line, 'most lines are said straight');
  assert.equal(personaLine('Speedbird three two seven, request descent.', rookie, 0, 0.1), 'Uh, Speedbird three two seven, request descent.');
  assert.equal(personaLine(line, personaOf(find('captain')), 1, 0), line, 'a captain never hesitates');
  assert.equal(personaLine(line, rookie, 1, 0.5), `Uh, ${line[0].toLowerCase()}${line.slice(1)}`, 'more of it under stress');
});

test('stress comes from the flight: go-arounds, an emergency, low fuel; it sharpens a captain and slows a student', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = spawnOnFinal(e, 'BAW327', '27L', 8);
  assert.equal(stressOf(a), 0);
  a.goAroundCount = 2; a.fuelMin = 20;
  assert.ok(Math.abs(stressOf(a) - 0.8) < 1e-9);
  const cap = personaOf(find('captain')), stu = personaOf(find('student', false));
  assert.ok(delayFactor(cap, 0.8) < delayFactor(cap, 0) && delayFactor(stu, 0.8) > delayFactor(stu, 0));
  assert.ok(errorFactor(stu, 0.8) > errorFactor(stu, 0) && errorFactor(cap, 0.8) === errorFactor(cap, 0));
  assert.equal(overloadChance(stu, 0, 2), 0, 'two instructions are never too much');
  assert.ok(overloadChance(stu, 0, 4) > overloadChance(stu, 0, 3) && overloadChance(cap, 1, 5) === 0);
});

test('story: three instructions in one breath to a student come back as "say again, slowly"; the repeat is taken in', () => {
  const cs = find('student', false);
  let asked = 0, taken = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const e = makeEngine('EGLL', { ends: ['27R', '27L'], seed });
    e.settings.personas = true;
    const a = spawnOnFinal(e, cs, '27L', 18, { altFt: 6000, onFrequency: 'approach' });
    a.ilsArmed = false; a.ilsCaptured = false;
    setSeed(seed * 7 + 1);
    const line = `${cs} Fly heading 180 Altitude 4000 Speed 210`;
    const r = text(e, line);
    assert.ok(r.parsedOk, 'the line parses as a sequence');
    if (r.code === 'queried') {
      asked++;
      assert.match(r.readback, /say again, slowly\?$/);
      assert.equal(Math.round(a.targetAltitude), 6000, 'nothing executed');
      run(e, 5);
      if (text(e, line).ok) taken++;
    }
  }
  assert.ok(asked >= 5 && asked <= 25, `asked ${asked} of 40`);
  assert.equal(taken, asked, 'the repeat always goes through');
  // with personas off (scripted scenarios, data export) it never happens
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = spawnOnFinal(e, cs, '27L', 18, { altFt: 6000, onFrequency: 'approach' });
  a.ilsArmed = false; a.ilsCaptured = false;
  for (let i = 0; i < 20; i++) { assert.doesNotMatch(text(e, `${cs} Fly heading ${180 + i} Altitude ${4000 + (i % 2) * 1000} Speed ${210 + (i % 2) * 10}`).readback, /say again/); run(e, 5); }
});

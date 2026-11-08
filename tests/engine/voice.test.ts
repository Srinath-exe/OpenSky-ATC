// Voice input layer L0 (docs/spec/11-VOICE-MODEL.md): what a controller SAYS must parse to the command that was meant.
// Every AI-controller command of a full-auto session is rendered to the spoken transmission (phraseology) and fed back
// through the typed-command parser; the AST must match (headings compared in the magnetic frame they were spoken in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from './helpers';
import { preferredEnds } from '../../src/lib/sim/weather';
import { RUNWAY_MANIFEST } from '../../src/lib/runwayManifest';
import { rf, chance } from '../../src/lib/sim/rng';
import { transmission, groupNumber } from '../../src/lib/sim/phraseology';
import { parseCommand } from '../../src/lib/sim/commands';
import { fromEngine } from '../../src/lib/sim/dispatch';
import type { CommandAST } from '../../src/lib/sim/commandAst';

const norm = (x: unknown) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? (k === 'hdg' ? 'H' : Math.round(v)) : v));
const hdgs = (x: unknown) => { const h: number[] = []; JSON.stringify(x, (k, v) => { if (k === 'hdg' && typeof v === 'number') h.push(v); return v; }); return h; };
const same = (a: unknown, b: unknown) => norm(a) === norm(b) && hdgs(a).every((v, i) => Math.abs(((v - hdgs(b)[i] + 540) % 360) - 180) <= 1.5);

function roundTrip(icao: string, minutes: number) {
  const ends = preferredEnds(RUNWAY_MANIFEST[icao].flatMap(r => r.ends), 280, 10);
  const e = makeEngine(icao, { seed: 1, pilotDelay: null, emergencies: 'off', ends } as any);
  e.settings.autoApproach = true; e.settings.autoTower = true; e.settings.autoGround = true; e.playerPosition = 'tower';
  for (let i = 0; i < 4; i++) e.spawnDeparture(); for (let i = 0; i < 3; i++) e.spawnArrival();
  let next = e.time + rf(50, 100); const t0 = e.time; let n = 0, ok = 0; const bad: string[] = [];
  while (e.time - t0 < minutes * 60) {
    if (e.time >= next) { if (e.aircraft.length < 14 && !(chance(0.55) ? e.spawnDeparture() : e.spawnArrival())) e.spawnDeparture(); next = e.time + rf(50, 100); }
    for (const ev of e.step(15)) {
      const ast = (ev.data as { ast?: CommandAST } | undefined)?.ast;
      if (ev.type !== 'transmission' || ev.who !== 'AI' || !ast || ast.kind === 'cancelApproach') continue;   // cancelApproach: the AI leaves the turn direction to the engine, the speech names it
      const a = e.find(ev.callsign); if (!a) continue;
      const spoken = transmission(ast, e.phraseCtx(a)); if (!spoken) continue;
      const r = parseCommand(spoken, fromEngine(e) as never);
      n++; if (r.ok && same(r.ast, ast)) ok++; else if (bad.length < 5) bad.push(`${spoken} -> ${r.ok ? norm(r.ast) : r.errors.map(x => x.message).join('; ')}`);
    }
  }
  return { n, ok, bad };
}

for (const icao of ['KJFK', 'EGLL']) {
  test(`voice L0: ${icao} AI transmissions, spoken, parse back to the same command`, () => {
    const { n, ok, bad } = roundTrip(icao, 12);
    assert.ok(n > 60, `enough commands (${n})`);
    assert.ok(ok / n >= 0.98, `${ok}/${n} round-tripped\n${bad.join('\n')}`);
  });
}

test('voice L0: spoken forms — grouped numbers, phonetic letters, facility name, wind / altimeter tails', () => {
  const e = makeEngine('KJFK', { seed: 1 } as never);
  e.spawnDeparture({ callsign: 'DAL421' } as never); e.spawnDeparture({ callsign: 'SKW972' } as never);
  const ctx = fromEngine(e) as never;
  const p = (s: string) => { const r = parseCommand(s, ctx); assert.ok(r.ok, `${s}: ${r.errors.map(x => x.message).join('; ')}`); return r.ast as any; };
  assert.equal(p('delta four twenty-one, climb flight level two forty').ft, 24000);
  assert.equal(p('Delta four two one, reduce speed to one sixty knots').kts, 160);
  assert.deepEqual(p('delta four twenty one taxi runway three one left via alpha bravo hold short of runway two two right').via, ['A', 'B']);
  assert.equal(p('Sierra Kilo Whiskey nine seventy-two, roger').callsign, 'SKW972');
  assert.equal(p('Delta 421, Kennedy Tower, runway 31 left, cleared for takeoff, wind 263 at 4').wind, true);
  assert.equal(p('Delta 421, wind 240 degrees 8 knots, runway 31 left, cleared for takeoff').kind, 'takeoff');
  assert.equal(p('Delta 421, start up approved, expect runway 31 left, altimeter 3033').kind, 'startup');
  assert.equal(p('Delta 421, unable, traffic, standby').kind, 'unable');
  // FAA group form says the zero: 108 is "one zero eight", never "one eight" (= 18)
  assert.equal(groupNumber('108'), 'one zero eight'); assert.equal(groupNumber('1200'), 'twelve hundred'); assert.equal(groupNumber('865'), 'eight sixty-five');
});

test('voice understand(): a recogniser transcript becomes a canonical command line that parses back to the same command', async () => {
  const { understand } = await import('../../src/lib/voice/understand');
  const e = makeEngine('KJFK', { seed: 1 } as never);
  e.spawnDeparture({ callsign: 'DAL421' } as never);
  const ctx = fromEngine(e) as never;
  const u = understand('Delta four twenty-one, uh, turn left heading two seven zero, descend and maintain four thousand.', ctx, e.magVar ?? 0);
  assert.ok(u.ok, u.error ?? '');
  assert.match(u.line, /^DAL421 /);
  const again = parseCommand(u.line, ctx);
  const first = parseCommand('Delta four twenty-one, turn left heading two seven zero, descend and maintain four thousand', ctx);
  assert.ok(again.ok && first.ok);
  assert.ok(same(again.ast, first.ast), `${u.line}: ${norm(again.ast)} vs ${norm(first.ast)}`);
  const bad = understand('um, delta nine nine nine, climb', ctx);
  assert.equal(bad.ok, false); assert.equal(bad.line, 'delta nine nine nine, climb');
});

test('runways named without a leading zero (KBOS "4L") parse whether typed "4L", "04L" or spoken "four left"', () => {
  const e = makeEngine('KBOS', { seed: 1 } as never);
  const a = e.spawnDeparture({ callsign: 'DAL421' } as never)!;
  const ctx = fromEngine(e) as never;
  const rw = (fromEngine(e) as { runways?: string[] }).runways ?? [];
  assert.ok(rw.includes('4L'), `KBOS runway list: ${rw.join(' ')}`);
  for (const s of ['DAL421 cross 4L', 'DAL421 cross 04L', 'delta four two one cross runway four left', 'DAL421 hold short 4L']) {
    const r = parseCommand(s, ctx);
    assert.ok(r.ok, `${s}: ${r.errors.map(x => x.message).join('; ')}`);
    assert.equal((r.ast as { runway?: string; of?: { runway: string } }).runway ?? (r.ast as { of: { runway: string } }).of.runway, '4L', s);
  }
  void a;
});

test('understandVoice(): rules first, then the model; confident -> send, unsure -> edit, SAY AGAIN and junk never sent', async () => {
  const { understandVoice } = await import('../../src/lib/voice/understand');
  const e = makeEngine('KJFK', { seed: 1 } as never);
  e.spawnDeparture({ callsign: 'DAL421' } as never);
  const ctx = fromEngine(e) as never;
  const state = { text: '@TWR 31L\nDAL421 delta 421 DEP GND parked h000 31L', callsigns: ['DAL421'] };
  let calls = 0;
  const fake = (line: string, confidence: number, sayAgain = false) => ({ complete: async () => { calls++; return { line, confidence, ms: 1, sayAgain }; } });
  // 1. the rules understand it: the model is not even asked
  const r1 = await understandVoice('Delta four two one, hold position', ctx, 0, fake('IGNORED', 1), state);
  assert.ok(r1.ok); assert.equal(r1.source, 'L0'); assert.equal(calls, 0);
  // 2. rules fail, model confident -> ok, canonical line
  const r2 = await understandVoice('delta for twenty won uh hold your position please', ctx, 0, fake('DAL421 Hold position', 0.93), state);
  assert.ok(r2.ok, r2.error ?? ''); assert.equal(r2.source, 'L1'); assert.match(r2.line, /^DAL421 Hold position/);
  // 3. model unsure -> not sent, line kept for editing, confidence in the message
  const r3 = await understandVoice('delta for twenty won uh hold your position please', ctx, 0, fake('DAL421 Hold position', 0.31), state);
  assert.equal(r3.ok, false); assert.match(r3.error ?? '', /31%/); assert.match(r3.line, /^DAL421/);
  // 4. model says SAY AGAIN -> not sent
  const r4 = await understandVoice('blah blah', ctx, 0, fake('SAY AGAIN', 0.9, true), state);
  assert.equal(r4.ok, false); assert.equal(r4.sayAgain, true);
  // 5. model writes something unparseable -> not sent
  const r5 = await understandVoice('blah blah', ctx, 0, fake('DAL421 Fly to the moon', 0.99), state);
  assert.equal(r5.ok, false); assert.match(r5.error ?? '', /did not parse/);
});

test('understandVoice(): when the rules can resolve the callsign the model got wrong, the rules win and the player checks it', async () => {
  const { understandVoice } = await import('../../src/lib/voice/understand');
  const e = makeEngine('KJFK', { seed: 1 } as never);
  e.spawnDeparture({ callsign: 'UPS973' } as never); e.spawnDeparture({ callsign: 'BAW963' } as never);
  const ctx = fromEngine(e) as never;
  const state = { text: '@APP 31L', callsigns: ['UPS973', 'BAW963'] };
  const fake = { complete: async () => ({ line: 'BAW963 Fly heading 102', confidence: 0.97, ms: 1, sayAgain: false }) };
  const r = await understandVoice('973 uh fly heading one zero two please', ctx, 0, fake, state);
  assert.equal(r.ok, false, 'not sent: the aircraft was corrected');
  assert.match(r.line, /^UPS973 /); assert.match(r.error ?? '', /UPS973/);
});

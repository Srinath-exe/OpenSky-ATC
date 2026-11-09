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

// decoder signals typical of a correct proposal (medians on ml/verify trainB, rules-failed transcripts; csLh / csLhMargin:
// the callsign search, medians over correct trainB proposals)
const SURE = { csMargin: 8.6, pSay: 5e-5, csMinFull: 0.998, insMinP: 0.9996, insLp: -0.0006, insMinMargin: 8.8, digMinP: 0.9999, digMargin: 10, rwyMinP: 1, eosP: 0.99998, nTok: 9, csLh: -0.002, csLhMargin: 2 };
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
  const sure = SURE;
  const fake = (line: string, confidence: number, sayAgain = false) => ({ complete: async () => { calls++; return { line, confidence, ms: 1, sayAgain, signals: sure }; } });
  // 1. the rules understand it: the model is not even asked
  const r1 = await understandVoice('Delta four two one, hold position', ctx, 0, fake('IGNORED', 1), state);
  assert.ok(r1.ok); assert.equal(r1.source, 'L0'); assert.equal(calls, 0);
  // 2. rules fail, model confident and the words agree -> ok, canonical line
  const r2 = await understandVoice('delta four two one uh turn heading two seven zero please', ctx, e.magVar ?? 0, fake('DAL421 Fly heading 270', 0.93), state);
  assert.ok(r2.ok, r2.error ?? ''); assert.equal(r2.source, 'L1'); assert.match(r2.line, /^DAL421 Fly heading 270/);
  // 3. the old gate (verifier: null): model unsure -> not sent, line kept for editing, confidence in the message
  const r3 = await understandVoice('delta for twenty won uh hold your position please', ctx, 0, fake('DAL421 Hold position', 0.31), state, 0.5, { verifier: null });
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

// ---------- the verifier (src/lib/voice/verify.ts, ml/verify/RESULTS.md) ----------
const vctx = { aircraft: [{ callsign: 'UPS973', altitude: 8000 }, { callsign: 'BAW963', altitude: 7000 }, { callsign: 'DAL421', altitude: 0 }] } as never;

test('verifier round trip: the proposal said back in words must agree with what was heard', async () => {
  const { roundTrip } = await import('../../src/lib/voice/verify');
  const rt = (heard: string, line: string) => { const p = parseCommand(line, vctx); assert.ok(p.ok, line); return roundTrip(heard, p.ast!, vctx, 0); };
  // the demo's confidently wrong callsign: 963 is not what was said, and another aircraft fits better
  const wrongCs = rt('973 fly heading 102', 'BAW963 Fly heading 102'), rightCs = rt('973 fly heading 102', 'UPS973 Fly heading 102');
  assert.ok(wrongCs.csOther > 0 && wrongCs.csNum < 0.5, JSON.stringify(wrongCs));
  assert.ok(rightCs.csOther < 0 && rightCs.csNum === 1 && rightCs.numRecall === 1, JSON.stringify(rightCs));
  // values: every number of the instruction must be heard (feet or flight level, grouped or digit by digit)
  assert.equal(rt('speedbird nine six three descend four thousand please', 'BAW963 Altitude 4000').numRecall, 1);
  assert.equal(rt('speedbird nine six three descend four thousand please', 'BAW963 Altitude 14000').numRecall, 0);
  assert.equal(rt('speedbird nine six three climb flight level one two zero', 'BAW963 Altitude 12000').numRecall, 1);
  assert.equal(rt('ups nine seven three turn left heading two seven zero', 'UPS973 Turn left heading 270').conflict, 0);
  assert.equal(rt('ups nine seven three turn left heading two seven zero', 'UPS973 Turn right heading 270').conflict, 1);
  assert.equal(rt('speedbird nine six three climb four thousand', 'BAW963 Altitude 4000').conflict, 1, 'climb to a level below the aircraft');
  // a frequency or wind the recogniser heard is not a number the command left out
  assert.ok(rt('ups nine seven three contact tower one one eight decimal five', 'UPS973 Contact tower').numExtra === 0);
  // a taxi route is compared in order and counted: "echo echo foxtrot" is not "echo foxtrot"
  const full = rt('delta four two one taxi runway 31 left via echo echo foxtrot', 'DAL421 Taxi RWY 31L via EE, F');
  const short = rt('delta four two one taxi runway 31 left via echo echo foxtrot', 'DAL421 Taxi RWY 31L via E, F');
  assert.ok(full.cover > short.cover, `${full.cover} vs ${short.cover}`);
});

test('understandVoice(): the verifier sends a confident proposal that matches the words and holds back one that does not', async () => {
  const { understandVoice } = await import('../../src/lib/voice/understand');
  const { VERIFIER_FULL, VERIFIERS } = await import('../../src/lib/voice/verify-model');
  const { S1_MODEL_URL } = await import('../../src/lib/voice/l1');
  assert.ok(VERIFIERS[S1_MODEL_URL], `a gate is fitted for the shipped S1 model ${S1_MODEL_URL} (ml/verify/refit.sh)`);
  const e = makeEngine('KJFK', { seed: 1 } as never);
  e.spawnArrival({ callsign: 'BAW963' } as never); e.spawnArrival({ callsign: 'UPS973' } as never);
  const ctx = fromEngine(e) as never;
  const state = { text: '@APP 31L', callsigns: ['BAW963', 'UPS973'] };
  const sure = SURE;
  const fake = (line: string) => ({ complete: async () => ({ line, confidence: 0.99, ms: 1, sayAgain: false, signals: sure }) });
  const said = 'speedbird nine six three uh turn heading one zero two please';
  const good = await understandVoice(said, ctx, 0, fake('BAW963 Fly heading 102'), state);
  assert.equal(good.source, 'L1'); assert.ok(good.ok, good.error ?? ''); assert.equal(good.verify?.gate, 'send'); assert.equal(good.verify?.model, VERIFIER_FULL.name);
  // the same confident decoder, but a heading nobody said: the old gate (confidence >= 0.5) would have sent it
  const bad = await understandVoice(said, ctx, 0, fake('BAW963 Fly heading 120'), state);
  assert.equal(bad.ok, false, `sent a heading that was not said (p=${bad.verify?.p})`); assert.match(bad.line, /^BAW963 /); assert.match(bad.error ?? '', /number/);
  const old = await understandVoice(said, ctx, 0, fake('BAW963 Fly heading 120'), state, 0.5, { verifier: null });
  assert.equal(old.ok, true, 'verifier: null keeps the old confidence gate');
  // the wrong aircraft, said oddly enough that the rules cannot be sure: held back either way (fusion or verifier)
  const cs = await understandVoice('nine seven tree uh fly heading one zero two please', ctx, e.magVar ?? 0, fake('BAW963 Fly heading 102'), state);
  assert.equal(cs.ok, false, `sent ${cs.line} for "nine seven tree" (p=${cs.verify?.p})`);
  // each S1 checkpoint has its own gate (thresholds differ): the result names its model, and that gate is used
  for (const url of Object.keys(VERIFIERS)) {
    const r = await understandVoice(said, ctx, e.magVar ?? 0, { complete: async () => ({ line: 'BAW963 Fly heading 102', confidence: 0.99, ms: 1, sayAgain: false, signals: sure, model: url }) }, state);
    assert.equal(r.verify?.model, VERIFIERS[url].full.name, url);
  }
  // a worker without signals (older build): the basic model (round trip + confidence) decides
  const basic = await understandVoice(said, ctx, 0, { complete: async () => ({ line: 'BAW963 Fly heading 102', confidence: 0.99, ms: 1, sayAgain: false }) }, state);
  assert.match(basic.verify?.model ?? '', /basic/); assert.ok(basic.ok, basic.error ?? '');
});

test('S1 model in node + verifier: the decoder reports its signals, and a confidently wrong proposal is never sent', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const { S1Model } = await import('../../src/lib/voice/s1');
  const { understandVoice } = await import('../../src/lib/voice/understand');
  const dir = path.join(process.cwd(), 'public/models/s1/2m-swap-v1');
  const bin = fs.readFileSync(path.join(dir, 'model.bin'));
  const m = new S1Model(JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
  const l1 = { complete: async (said: string, cs: string[], ctx?: string) => { m.prefill(ctx!); const c = m.complete(said, cs); return { ...c } } };
  // real recogniser transcripts from the GPU bake-off (ml/gpu/results/stt) where the shipped model proposed a wrong command
  // with >= 90% confidence: a wrong value (runway 09R for "19 right") and a wrong aircraft (EZY504 for "1-0-7")
  const cases = [
    { said: 'Japan air 88819 right taxi', gold: 'JAL888 Taxi RWY 19R', ctx: '@GND 01R 01L\nCPA898 cathay 898 DEP GND taxi h245 01L\nHKE527 hong kong express 527 DEP GND taxi h105 01R\nHKE528 hong kong express 528 DEP GND taxi h010 01L\nJAL888 japan air 888 DEP GND startup h194 01L\nUAL222 united 222 DEP GND taxi h194 01L\nUAL61 united 61 DEP GND hold_short h122 01R req:cross\nBAW978 speedbird 978 ARR APP descent 4700ft h266 01L\nBAW989 speedbird 989 ARR APP cruise 7000ft h136 01R\nSCO498 scooter 498 ARR APP approach 3000ft h015 01R\nSWA504 southwest 504 ARR APP descent 6600ft h183 01R\nUAL335 united 335 ARR APP approach 9000ft h160 01R\nVOZ693 velocity 693 ARR APP descent 9300ft h030 01R' },
    { said: '1-0-7 Heading 2-6-1', gold: 'RYR107 Fly heading 261', ctx: '@APP 27L 26R 27R 26L\nAFR459 air france 459 ARR APP approach 10000ft h040 27L\nASA901 alaska 901 ARR APP cruise 5000ft h242 27L\nDAL899 delta 899 ARR APP cruise 6000ft h290 27L\nEZY532 easy 532 ARR APP cruise 9000ft h103 27L\nFDX947 fedex 947 ARR APP cruise 8000ft h049 27L\nHKE528 hong kong express 528 DEP DEP climb 2000ft h161 27R\nQTR978 qatari 978 ARR APP cruise 4000ft h137 27L\nRYR107 ryanair 107 ARR APP cruise 7000ft h297 27L\nSCO498 scooter 498 ARR APP approach 3000ft h256 27L\nAFR222 air france 222 DEP GND taxi h133 26L\nAFR83 air france 83 DEP EXT departed 9300ft h045 26L\nEZY504 easy 504 ARR TWR rollout h173 27L\nHKE527 hong kong express 527 DEP GND taxi h083 26R\nJBU887 jetblue 887 DEP GND hold_short h103 26L' },
  ];
  for (const c of cases) {
    const lines = c.ctx.split('\n').slice(1);
    const pctx = { aircraft: lines.map(l => { const w = l.split(' '); const a = w.find(x => /^\d+ft$/.test(x)); return { callsign: w[0], altitude: a ? parseInt(a, 10) : 0 }; }) } as never;
    const state = { text: c.ctx, callsigns: lines.map(l => l.split(' ')[0]) };
    const r = await understandVoice(c.said, pctx, 0, l1, state);
    assert.equal(r.source, 'L1', `${c.said}: the rules should not parse it`);
    assert.ok(r.verify && /full/.test(r.verify.model), 'the real engine sends its signals, so the full verifier runs');
    const right = parseCommand(r.line, pctx), gold = parseCommand(c.gold, pctx);
    const isGold = right.ok && gold.ok && norm(right.ast) === norm(gold.ast);
    assert.ok(!r.ok || isGold, `${c.said}: sent ${r.line} (gold ${c.gold}, p=${r.verify?.p.toFixed(3)})`);
  }
});

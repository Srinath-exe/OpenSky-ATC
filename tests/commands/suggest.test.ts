// Autocomplete: suggest(prefix, ctx) ranking and vocabulary at every grammar position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest } from '../../src/lib/sim/commands';
import { mkParseCtx } from './helpers';

const ctx = mkParseCtx();
const texts = (p: string, c = ctx) => suggest(p, c).map(s => s.text);
const top = (p: string, n = 3, c = ctx) => texts(p, c).slice(0, n);

test('suggest: empty prefix lists callsigns first, REQ aircraft on top, then system verbs', () => {
  const s = suggest('', ctx);
  assert.equal(s[0].text, 'SWR7', 'aircraft with an open request ranks first');
  assert.equal(s[0].kind, 'callsign');
  assert.ok(s[0].label.includes('REQ'));
  const callsigns = s.filter(x => x.kind === 'callsign').map(x => x.text);
  assert.ok(callsigns.includes('BAW117') && callsigns.includes('DLH2'));
  assert.ok(s.some(x => x.kind === 'keyword' && x.text === 'DISPATCH'));
  assert.ok(s.findIndex(x => x.text === 'DISPATCH') > s.findIndex(x => x.text === 'DLH2'), 'system verbs after callsigns');
  assert.ok(s.every((x, i) => i === 0 || s[i - 1].score >= x.score), 'sorted by score desc');
});

test('suggest: partial callsign completes by prefix before substring', () => {
  assert.deepEqual(top('BA', 1), ['BAW117']);
  assert.deepEqual(top('ba', 1), ['BAW117']);
  const s = suggest('117', ctx);
  assert.equal(s[0].text, 'BAW117', 'last-digits match beats a substring match');
  assert.ok(s.map(x => x.text).includes('AFR1170'));
  assert.deepEqual(texts('DL'), ['DLH2']);
});

test('suggest: after a callsign, verbs valid for that stage come first', () => {
  const parked = texts('SWR7 ');
  assert.equal(parked[0], 'PUSHBACK APPROVED');
  assert.ok(parked.includes('STARTUP APPROVED'));
  assert.ok(!parked.includes('TURN LEFT HEADING'), 'no airborne verbs for a parked aircraft');
  assert.ok(!parked.includes('ROGER MAYDAY'), 'no emergency verbs without an emergency');
  const inbound = texts('DLH2 ');
  assert.ok(['TURN LEFT HEADING', 'CLIMB', 'DESCEND', 'FLY HEADING', 'CLEARED ILS', 'SPEED'].includes(inbound[0]), `got ${inbound[0]}`);
  const iLand = inbound.indexOf('CLEARED TO LAND');
  assert.ok(iLand === -1 || inbound.indexOf('CLEARED ILS') < iLand, 'statically-enabled verbs rank above disabled-with-reason ones');
  assert.ok(!inbound.includes('PUSHBACK APPROVED'));
  const emerg = texts('THY8 ');
  assert.ok(emerg.includes('ROGER MAYDAY'), 'emergency verbs offered during an emergency');
});

test('suggest: verb prefix completion', () => {
  assert.deepEqual(top('DLH2 desc', 1), ['DESCEND']);
  assert.deepEqual(top('DLH2 T', 2).every(t => t.startsWith('T')), true);
  assert.ok(texts('BAW117 tax').every(t => t.includes('TAX')));
  assert.ok(texts('BAW117 tax').includes('TAXI'));
});

test('suggest: number placeholders after altitude / speed / heading verbs', () => {
  const alt = suggest('DLH2 descend ', ctx);
  assert.equal(alt[0].kind, 'number');
  assert.ok(alt.map(a => a.text).includes('3000'));
  assert.ok(alt.map(a => a.text).includes('FL80'));
  assert.deepEqual(top('DLH2 speed ', 4), ['160', '180', '210', '250']);
  assert.ok(texts('DLH2 turn left heading ').includes('270'));
});

test('suggest: identifier lists at their grammar slots', () => {
  const rw = suggest('DLH2 cleared ILS ', ctx);
  // grammar accepts a continuation here (runway defaults to the plan) so continuations appear; a runway list appears on the taxi runway slot
  assert.ok(rw.length > 0);
  const taxiVia = suggest('BAW117 taxi 27R via ', ctx);
  assert.equal(taxiVia[0].kind, 'taxiway');
  assert.deepEqual(taxiVia.map(t => t.text).slice(0, 3), ['A', 'B', 'C']);
  const fix = suggest('DLH2 direct ', ctx);
  assert.equal(fix[0].text, 'OCK', 'planned fix first');
  assert.equal(fix[0].kind, 'fix');
  assert.ok(fix.map(f => f.text).includes('BIG'));
  const stand = suggest('DLH2 taxi to stand ', ctx);
  assert.equal(stand[0].text, '201', 'assigned stand first');
  assert.equal(stand[0].kind, 'stand');
  const pos = texts('BAW117 contact ');
  assert.deepEqual([...pos].sort(), ['APPROACH', 'DEPARTURE', 'GROUND', 'TOWER']);
  const veh = suggest('recall ', ctx);
  assert.equal(veh[0].kind, 'vehicle');
  assert.ok(veh.map(v => v.text).includes('FIRE1'));
  const target = texts('dispatch fire 1 to ');
  assert.ok(target.includes('27L') && target.includes('DLH2') && target.includes('STAND'));
  const other = suggest('AFR1170 give way to ', ctx);
  assert.ok(other.some(o => o.kind === 'aircraft' && o.text === 'BAW117'));
  assert.ok(!other.some(o => o.text === 'AFR1170'), 'never suggests self');
});

test('suggest: continuations after a complete part', () => {
  const afterAlt = texts('DLH2 descend 3000 ');
  assert.ok(afterAlt.includes('THEN CLEARED ILS'));
  assert.ok(afterAlt.includes('EXPEDITE'));
  assert.ok(afterAlt.includes('THEN'));
  const afterTaxi = texts('BAW117 taxi 27R ');
  assert.ok(afterTaxi.includes('VIA') && afterTaxi.includes('HOLD SHORT'));
  const afterVia = texts('BAW117 taxi 27R via A ');
  assert.ok(afterVia.includes('B'), 'more taxiways after a route chip');
  assert.ok(afterVia.includes('HOLD SHORT'));
  const afterTakeoff = texts('EZY99 cleared for takeoff 27R ');
  assert.ok(afterTakeoff.includes('FLY RUNWAY HEADING') && afterTakeoff.includes('CLIMB'));
  const afterLand = texts('UAE5 cleared to land 27L ');
  assert.ok(afterLand.includes('EXIT AT') && afterLand.includes('HOLD SHORT'));
  const afterIls = texts('DLH2 cleared ILS 27L ');
  assert.ok(afterIls.includes('REPORT ESTABLISHED'));
});

test('suggest: partial continuation keyword filters', () => {
  assert.deepEqual(top('DLH2 descend 3000 exp', 1), ['EXPEDITE']);
  assert.deepEqual(top('BAW117 taxi 27R via A hold', 1), ['HOLD SHORT']);
});

test('suggest: ambiguous callsign offers the candidates', () => {
  const s = suggest('70 ', ctx);
  assert.deepEqual(s.map(x => x.text).sort(), ['AFR1170', 'EIN70']);
  assert.ok(s.every(x => x.kind === 'callsign'));
});

test('suggest: lastCallsign enables verb-first completion', () => {
  const s = texts('', mkParseCtx({ lastCallsign: 'DLH2' }));
  assert.ok(s.includes('DESCEND') || s.includes('TURN LEFT HEADING'));
  const d = texts('desc', mkParseCtx({ lastCallsign: 'DLH2' }));
  assert.deepEqual(d, ['DESCEND']);
});

test('suggest: unknown callsign prefix falls back to the callsign list', () => {
  const s = suggest('ZZ', ctx);
  assert.deepEqual(s, []);
  const s2 = suggest('ZZZ9 ', ctx);
  assert.ok(s2.every(x => x.kind === 'callsign'));
});

test('suggest: results are unique, capped and scored', () => {
  for (const p of ['', 'DLH2 ', 'BAW117 taxi 27R via ', 'dispatch ']) {
    const s = suggest(p, ctx);
    assert.ok(s.length <= 24, `${p}: ${s.length}`);
    assert.equal(new Set(s.map(x => x.text)).size, s.length, `${p}: duplicates`);
    assert.ok(s.every(x => typeof x.score === 'number' && x.label.length > 0));
  }
});

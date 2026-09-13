// LLM I/O (docs/spec/07-LLM-IO.md): the observation the model reads, the reply contract, and a full round trip through
// the ordinary command path — a model line executes exactly like a typed one, a bad line is rejected with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, byCs } from './helpers';
import { buildObservation } from '../../src/lib/llm/observe';
import { parseReply, systemPrompt } from '../../src/lib/llm/prompt';
import { executeText, fromEngine } from '../../src/lib/sim/dispatch';

test('observation: header, open request with its answers, aircraft line with the valid actions, other traffic, vocabulary', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = e.spawnDeparture({ callsign: 'AFR851', type: 'B752', runway: '28L', stand: 'F18' })!;
  const arr = e.spawnArrival({ callsign: 'QTR427', type: 'A359' })!;
  runUntil(e, () => a.requests.length > 0, 120);
  const obs = buildObservation(e, { position: 'ground', vocabulary: true, radio: [{ who: 'SYS', text: 'boot', at: 0 }, { who: 'PILOT', callsign: 'AFR851', text: 'request pushback', at: e.time }] });
  const t = obs.text;
  assert.match(t, /^SKYCONTROL KSFO · you are GROUND · sim \d\d:\d\d:\d\d/m);
  assert.match(t, /^WX wind \d{3}\/\d+/m);
  assert.match(t, /^RUNWAYS dep .*28L/m);
  assert.match(t, /^TAXIWAYS .* A .* B /m, 'taxiway vocabulary on request');
  assert.match(t, /^REQUESTS ON GROUND \(1\)/m);
  assert.match(t, /^- AFR851: ".*request pushback.*" \(\d+s\) · answers: PUSHBACK APPROVED \| STANDBY \| UNABLE/m);
  assert.match(t, /^- AFR851 B752\/M DEP · Parked at stand.*stand F18 · rwy 28L · hdg \d{3} · 0 kt · REQUEST pushback \(\d+s\) · can: PUSHBACK APPROVED/m);
  assert.doesNotMatch(t, /REPORT HEADING|SAY AGAIN/, 'meta verbs are not listed');
  assert.match(t, /^OTHER TRAFFIC \(1, not on your frequency/m);
  assert.match(t, new RegExp(`^- ${arr.callsign} A359/H ARR .* \\d+ ft · \\d+ kt · hdg \\d{3} · [\\d.]+ NM out, bearing \\d{3} from the field.* · on APPROACH`, 'm'));
  assert.match(t, /^RECENT RADIO \(last 1\)\n- \[\d\d:\d\d:\d\d\] PILOT AFR851: request pushback/m, 'SYS lines are dropped from the radio');
  assert.equal(obs.requests.length, 1); assert.equal(obs.mine.length, 1); assert.equal(obs.others.length, 1);
  assert.equal(obs.mine[0].actions[0], 'PUSHBACK APPROVED');
  // approach observation: fixes instead of taxiways, the arrival is "mine"
  const ap = buildObservation(e, { position: 'approach', vocabulary: true });
  assert.match(ap.text, /^FIXES /m);
  assert.equal(ap.mine.length, 1); assert.equal(ap.mine[0].callsign, arr.callsign);
  assert.ok(ap.mine[0].actions.some(v => v.startsWith('HDG')), 'vectors offered for the arrival');
});

test('parseReply: markdown noise, NOOP, prose and duplicates are stripped; command lines survive upper-cased', () => {
  assert.deepEqual(parseReply('NOOP'), []);
  assert.deepEqual(parseReply('```\n1. AFR851 pushback approved\n- "dlh553 contact tower"\nNote: waiting for QTR427\nAFR851 PUSHBACK APPROVED\n```'), ['AFR851 PUSHBACK APPROVED', 'DLH553 CONTACT TOWER']);
  assert.deepEqual(parseReply('Sure, here are the commands:\nUAL9 HDG 180 THEN DESCEND 6000'), ['UAL9 HDG 180 THEN DESCEND 6000']);
  assert.ok(systemPrompt('tower').includes('POSITION: TOWER'));
  assert.ok(systemPrompt('ground').includes('CLEARED FOR TAKEOFF'), 'the grammar sheet is part of every prompt');
});

test('round trip: a model line executes through the ordinary command path on its position; a wrong line is rejected with a reason', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const a = e.spawnDeparture({ callsign: 'AFR851', type: 'B752', runway: '28L', stand: 'F18' })!;
  runUntil(e, () => a.requests.length > 0, 120);
  const ctx = fromEngine(e, { lastCallsign: null, position: 'ground' });
  const line = parseReply('AFR851 PUSHBACK APPROVED')[0];
  const r1 = executeText(e, line, ctx, { position: 'ground' });
  assert.ok(r1.parse.ok && r1.result.ok, `accepted: ${r1.result.reason ?? r1.result.code}`);
  assert.equal(byCs(e, 'AFR851').requests.length, 0, 'the request is answered');
  runUntil(e, () => byCs(e, 'AFR851').phase === 'pushback', 15);
  assert.equal(byCs(e, 'AFR851').phase, 'pushback');
  // a line the parser cannot accept never reaches the engine
  const r2 = executeText(e, parseReply('AFR851 CLEARED FOR TAKEOFF 99')[0], ctx, { position: 'ground' });
  assert.equal(r2.result.ok, false); assert.ok(r2.result.reason, 'a reason for the next observation');
  // the outcome feeds back into the next observation
  const obs = buildObservation(e, { position: 'ground', lastActions: [{ line, ok: true, note: r1.result.readback }, { line: 'AFR851 CLEARED FOR TAKEOFF 99', ok: false, note: r2.result.reason ?? '' }] });
  assert.match(obs.text, /^YOUR LAST ACTIONS\n- "AFR851 PUSHBACK APPROVED" → OK/m);
  assert.match(obs.text, /^- "AFR851 CLEARED FOR TAKEOFF 99" → REJECTED: /m);
  run(e, 1);
});

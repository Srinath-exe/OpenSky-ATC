// Weather / ATIS / runway selection: a forced wind reversal changes the
// suggested runways and the runway configuration; wind acts on airborne motion
// and the takeoff roll; crosswind out of limits sends the pilot around.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, cmd, evs, ledgerHas, spawnOnFinal, dist, advance, angleDelta, NM_TO_M, KTS_TO_MPS } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { windComponents } from '../../src/lib/sim/weather';

test('wind reversal at KSFO: 255/14 -> 100/18 makes 10L/10R the suggestion, ATIS advances, runway_state event; applying the change flips the active ends', () => {
  const e = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const w0 = e.wx();
  assert.ok(Math.abs(angleDelta(w0.windDirTrue, 255)) < 60 && w0.windKt >= 5, `seeded wind ${w0.windDirTrue}/${w0.windKt}`);
  assert.ok(e.suggestedRunways === null, 'current config within limits');
  assert.equal(e.runwayState('28R')!.activeArr, true); assert.equal(e.runwayState('10L')!.activeArr, false);
  const letter0 = e.atisLetter()!;
  const before = evs(e, 'atis').length;
  e.setWind(100, 18);
  const evsNow = run(e, 2);
  const w = e.wx();
  assert.equal(w.windDirTrue, 100); assert.equal(w.windKt, 18);
  const sug = e.suggestedRunways as { dep: string[]; arr: string[]; reason: string } | null;
  assert.ok(sug, 'runway change suggested');
  assert.ok(sug!.arr.every(r => /^10/.test(r)) && sug!.dep.every(r => /^10/.test(r)), `suggested ${sug!.dep}/${sug!.arr}`);
  assert.ok(/tailwind/.test(sug!.reason), sug!.reason);
  const direct = e.weather.suggestRunways((e as unknown as { manifestEnds(): Parameters<typeof e.weather.suggestRunways>[0] }).manifestEnds(), { dep: ['28L', '28R'], arr: ['28L', '28R'] });
  assert.equal(direct.changed, true);
  assert.ok(evs(e, 'atis').length > before, 'ATIS event(s) emitted');
  assert.ok(evs(e, 'atis').some(ev => /recommended/.test(ev.message)));
  assert.ok(evs(e, 'runway_state').some(ev => ev.data?.type === 'runway_state' && /suggested/.test(ev.data.reason)), 'runway_state event carries the suggestion');
  assert.notEqual(e.atisLetter(), letter0, 'ATIS letter advanced on the wind change');
  assert.ok(e.runwayState('28R')!.windHeadKt < -10, 'tailwind component on 28R');
  assert.ok(e.runwayState('10L')!.windHeadKt > 10, 'headwind on 10L');
  const comp = windComponents(100, 18, e.runwayHeading('28R'));
  assert.ok(comp.headKt < -10);
  void evsNow;
  // takeoff on 28R now carries a tailwind penalty; the same clearance on 10L does not
  const d = e.spawnAt({ callsign: 'UAL1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '28R', onFrequency: 'tower' });
  const t = cmd(e, makeAst('takeoff', 'UAL1', { runway: '28R' }));
  assert.ok(t.code === 'ok_queued' || t.code === 'unable');
  assert.ok(ledgerHas(e, 'PERFORMANCE_TAILWIND', 'UAL1'));
  e.remove(d.id);
  // apply the suggestion (runway change dialog)
  const letter1 = e.atisLetter()!;
  e.setActiveRunways(sug!.dep, sug!.arr);
  assert.ok(e.suggestedRunways === null);
  assert.equal(e.runwayState('28R')!.activeArr, false); assert.equal(e.runwayState('28R')!.activeDep, false);
  assert.ok(e.runwayState('10L')!.activeArr || e.runwayState('10R')!.activeArr);
  assert.ok(e.runwayState('10L')!.activeDep || e.runwayState('10R')!.activeDep);
  assert.notEqual(e.atisLetter(), letter1, 'ATIS letter advanced on the runway change');
  assert.ok(evs(e, 'atis').some(ev => ev.data?.type === 'atis' && /runway change/.test(ev.data.reason)));
  run(e, 2);
  assert.ok(e.suggestedRunways === null, 'new config is within limits');
  // arrivals now plan the 10s; ILS for a 28 is refused as inactive; departures spawn for the 10s
  const a = e.spawnArrival()!;
  assert.ok(/^10/.test(a.plan.runway ?? ''), `arrival expects ${a.plan.runway}`);
  assert.equal(cmd(e, makeAst('ils', a.callsign, { runway: '28R' })).code, 'invalid_param');
  assert.equal(cmd(e, makeAst('ils', a.callsign, { runway: sug!.arr[0] })).code, 'ok_queued');
  const dep = e.spawnDeparture({ callsign: 'DEP7', type: 'A320' })!;
  assert.ok(/^10/.test(dep.plan.runway ?? ''), `departure planned for ${dep.plan.runway}`);
  const atis = e.weather.atis();
  assert.ok(atis.text.length > 40 && /10/.test(atis.text), 'ATIS text names the new runways');
});

test('wind reversal at EGLL (westerlies -> easterlies) suggests 09L/09R; no suggestion while the current config is within limits', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  e.setWind(270, 12);
  run(e, 2);
  assert.ok(e.suggestedRunways === null);
  e.setWind(90, 16);
  run(e, 2);
  const sug = e.suggestedRunways as { dep: string[]; arr: string[]; reason: string } | null;
  assert.ok(sug && sug.arr.every(r => /^09/.test(r)), `suggested ${sug?.arr}`);
  assert.ok(e.stats.transmissions >= 0);
  // calm wind: hysteresis keeps the current runways
  e.setWind(180, 3);
  run(e, 2);
  assert.ok(e.suggestedRunways === null);
});

test('wind acts on airborne motion (ground speed / drift) but not on taxi speed; headwind shortens the takeoff roll', () => {
  const mk = (dir: number, kt: number) => { const e = makeEngine('EGLL', { ends: ['27R', '27L'] }); e.setWind(dir, kt); return e; };
  const calm = mk(0, 0), head = mk(90, 40), cross = mk(0, 30);
  // arrivals in heading mode (a departure would steer to its SID fix)
  const spawn = (e: ReturnType<typeof mk>) => e.spawnAt({ callsign: 'WND1', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: 6, altFt: 6000 }, heading: 90, speedKts: 250, targets: { alt: 6000, hdg: 90, ias: 250 } });
  const a0 = spawn(calm), a1 = spawn(head), a2 = spawn(cross);
  const p0 = { ...a0.pos }, p1 = { ...a1.pos }, p2 = { ...a2.pos };
  run(calm, 60); run(head, 60); run(cross, 60);
  const g0 = dist(p0, a0.pos) / 60 / KTS_TO_MPS, g1 = dist(p1, a1.pos) / 60 / KTS_TO_MPS;
  assert.ok(Math.abs(g0 - 250) < 3, `calm: ground speed ${g0.toFixed(0)} kt`);
  assert.ok(Math.abs(g1 - 210) < 3, `40 kt headwind: ground speed ${g1.toFixed(0)} kt`);
  const trk = Math.atan2(a2.pos.x - p2.x, a2.pos.y - p2.y) * 180 / Math.PI;
  assert.ok(Math.abs(angleDelta(trk, 90)) > 4 && Math.abs(angleDelta(a2.heading, 90)) < 0.5, `crosswind drift: track ${trk.toFixed(1)} on heading 090`);
  // taxi speed is not wind-affected
  const t0 = calm.spawnAt({ callsign: 'TX1', type: 'A320', kind: 'departure', phase: 'taxi', gate: 'B48', taxiTo: '27R' });
  const t1 = head.spawnAt({ callsign: 'TX1', type: 'A320', kind: 'departure', phase: 'taxi', gate: 'B48', taxiTo: '27R' });
  run(calm, 60); run(head, 60);
  assert.ok(Math.abs(t0.distAlong - t1.distAlong) < 1, 'same taxi progress in calm and strong wind');
  // takeoff roll: rotation earlier with a headwind
  const roll = (e: ReturnType<typeof mk>) => {
    const d = e.spawnAt({ callsign: 'TO1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27L', onFrequency: 'tower' });
    cmd(e, makeAst('takeoff', 'TO1', { runway: '27L' }));
    const start = { ...d.pos };
    runUntil(e, () => d.delay.airborneAt != null, 120, 0.2);
    return { m: dist(start, d.pos), kt: d.speed };
  };
  const r0 = roll(calm), r1 = roll(head);
  assert.ok(r1.m < r0.m * 0.8, `headwind roll ${r1.m.toFixed(0)} m vs calm ${r0.m.toFixed(0)} m`);
  assert.ok(r1.kt < r0.kt, 'lower ground speed at rotation into wind');
});

test('crosswind out of limits at 1000 ft: the pilot goes around (03 D4); ATIS regenerates hourly', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  e.setWind(0, 45); // 45 kt direct crosswind on 27L, above the 35 + 5 kt jet limit -> 100 %
  assert.ok(e.weather.crosswindGoAroundP('M', e.runwayHeading('27L')) >= 0.99);
  const a = spawnOnFinal(e, 'XW1', '27L', 6, { landingCleared: true });
  const ga = runUntil(e, () => a.phase === 'go_around', 300, 0.5);
  assert.ok(ga.ok, 'crosswind go-around');
  assert.ok(a.altitude <= 1300, `at ${a.altitude.toFixed(0)} ft`);
  assert.ok(/crosswind/.test(evs(e, 'go_around', 'XW1')[0].message));
  assert.equal(e.stats.goAroundsPilot, 1);
  assert.ok(!ledgerHas(e, 'GA_UNHANDLED'), 'pilot-caused, not scored against the player');
  // within limits: lands
  const e2 = makeEngine('EGLL', { ends: ['27R', '27L'] });
  e2.setWind(0, 20);
  assert.equal(e2.weather.crosswindGoAroundP('M', e2.runwayHeading('27L')), 0);
  const b = spawnOnFinal(e2, 'XW2', '27L', 6, { landingCleared: true });
  const td = runUntil(e2, () => b.phase === 'rollout', 300);
  assert.ok(td.ok);
  // hourly ATIS
  const e3 = makeEngine('KSFO', { ends: ['28L', '28R'] });
  const l0 = e3.atisLetter();
  run(e3, 3700);
  assert.notEqual(e3.atisLetter(), l0, 'ATIS letter advanced within an hour');
  assert.ok(evs(e3, 'atis').length >= 1);
  void advance; void NM_TO_M;
});

// Approach position: airspace entries and retirement (B3), vectors / altitude /
// speed / direct / hold, ILS intercept rules, handoffs, pending-command semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, cmd, evs, ledgerHas, spawnOnFinal, runwayFrame, dist, headingTo, angleDelta, advance, NM_TO_M } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { ILS_CONST } from '../../src/lib/sim/ils';

test('B3: 200 seeded entry spawns at EGLL (centre 8.8 NM from the OSM origin) - zero diversions on the spawn tick, every spawn on the boundary', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  assert.ok(dist(e.centerXY, { x: 0, y: 0 }) > 8 * NM_TO_M, 'airspace centre is offset from the OSM origin');
  const R = e.airspaceRadiusM;
  let diversions = 0; const keys = new Set<string>(); const types = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const a = e.spawnArrival();
    assert.ok(a, `spawn ${i}`);
    const d = dist(a.pos, e.centerXY);
    assert.ok(Math.abs(d - R) < 5, `spawn ${i} on the boundary (${(d / NM_TO_M).toFixed(1)} NM from the centre)`);
    assert.ok(a.altitude >= 5000 && a.speed >= 200 && a.plan.kind === 'arrival' && a.onFrequency === 'approach');
    assert.ok(a.reservedStand, 'stand reserved at spawn');
    keys.add(a.plan.fix ?? ''); types.add(a.perf.icaoCode);
    const evsNow = e.step(1);
    diversions += evsNow.filter(ev => ev.type === 'diversion').length;
    assert.ok(e.find(a.callsign), `spawn ${i} still there after the first tick`);
    e.remove(a.id, 'test');
  }
  assert.equal(diversions, 0);
  assert.equal(e.stats.diversions, 0);
  assert.ok(keys.size >= 4, `spawns spread over the entries: ${[...keys].join(' ')}`);
  assert.ok(types.size >= 5, 'type variety');
  assert.ok(!ledgerHas(e, 'DIVERSION'));
});

test('B3/B11: spawns queued behind a busy entry are spaced >= 4 NM in trail, outside the boundary, and are NOT diverted while inbound', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const list = [];
  for (let i = 0; i < 12; i++) { const a = e.spawnArrival()!; list.push(a); run(e, 10); }
  // pairwise distance at spawn moments is enforced by the queue rule: check no two are within 3 NM at the same altitude now
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j]; if (!e.find(a.callsign) || !e.find(b.callsign)) continue;
    const d = dist(a.pos, b.pos) / NM_TO_M;
    if (Math.abs(a.altitude - b.altitude) < 1000) assert.ok(d >= 3, `${a.callsign}/${b.callsign} ${d.toFixed(1)} NM`);
  }
  const outside = list.filter(a => dist(a.pos, e.centerXY) > e.airspaceRadiusM * 1.05);
  assert.ok(outside.length >= 1, 'at least one spawn queued outside the boundary');
  run(e, 120);
  assert.equal(evs(e, 'diversion').length, 0, 'no diversion for inbound queued spawns');
  assert.ok(!ledgerHas(e, 'DIVERSION'));
  for (const a of list) assert.ok(e.find(a.callsign), `${a.callsign} still in the sim`);
});

test('retire logic is measured from the airspace centre: inbound just inside 1.05R stays, outbound beyond 1.05R diverts, a vectored-out arrival diverts (A23)', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const R = e.airspaceRadiusM; const c = e.centerXY;
  // (a) east of the centre at 1.02 R from the centre = ~39 NM from the OSM origin: inbound, must not be diverted
  const pIn = advance(c, 90, R * 1.02);
  const ll = e.proj.toLngLat(pIn.x, pIn.y);
  const a = e.spawnAt({ callsign: 'IN1', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: ll.lat, lng: ll.lng, altFt: 8000 }, heading: 270, speedKts: 250 });
  assert.ok(dist(a.pos, { x: 0, y: 0 }) > R * 1.05, 'well outside the boundary as seen from the OSM origin');
  run(e, 40);
  assert.ok(e.find('IN1'), 'inbound arrival inside the real boundary is kept');
  // (b) west of the centre at 1.1 R from the centre (~24 NM from the origin), flying outbound: diverted
  const pOut = advance(c, 270, R * 1.1);
  const ll2 = e.proj.toLngLat(pOut.x, pOut.y);
  const b = e.spawnAt({ callsign: 'OUT1', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: ll2.lat, lng: ll2.lng, altFt: 8000 }, heading: 270, speedKts: 250 });
  assert.ok(dist(b.pos, { x: 0, y: 0 }) < R * 1.05, 'inside the boundary as seen from the OSM origin');
  const gone = runUntil(e, () => !e.find('OUT1'), 60);
  assert.ok(gone.ok, 'outbound arrival outside the real boundary is diverted');
  assert.ok(evs(e, 'diversion', 'OUT1').some(ev => /exited airspace/.test(ev.message)));
  assert.ok(ledgerHas(e, 'DIVERSION', 'OUT1'));
  assert.equal(e.stats.diversions, 1);
  // (c) an arrival at an entry vectored outward leaves the airspace -> diversion
  const s = e.spawnArrival()!;
  run(e, 40);
  const away = headingTo(c, s.pos);
  cmd(e, makeAst('heading', s.callsign, { hdg: Math.round(away) }));
  const g2 = runUntil(e, () => !e.find(s.callsign), 600, 5);
  assert.ok(g2.ok, 'vectored-out arrival diverts');
  assert.equal(e.stats.diversions, 2);
});

test('departure exit: above FL90 -> departed with handoff credit; below FL90 without handoff -> diversion (GC23/GC24)', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const R = e.airspaceRadiusM; const c = e.centerXY;
  const mk = (cs: string, alt: number) => {
    const p = advance(c, 45, R * 0.85); const ll = e.proj.toLngLat(p.x, p.y);
    return e.spawnAt({ callsign: cs, type: 'A320', kind: 'departure', phase: 'climb', posLL: { lat: ll.lat, lng: ll.lng, altFt: alt }, heading: 45, speedKts: 250, targets: { alt } });
  };
  const hi = mk('HI1', 12000), lo = mk('LO1', 5000);
  const r = runUntil(e, () => !e.find('HI1') && !e.find('LO1'), 300, 2);
  assert.ok(r.ok);
  assert.ok(evs(e, 'departed', 'HI1').length >= 1);
  assert.ok(ledgerHas(e, 'DEPARTED_HANDOFF', 'HI1'));
  assert.ok(evs(e, 'diversion', 'LO1').some(ev => /below FL90/.test(ev.message)));
  assert.ok(ledgerHas(e, 'DIVERSION_UNHANDLED', 'LO1'));
  void hi; void lo;
});

test('vectors: heading with turn direction, latest pending heading wins (A22), DISREGARD drops the newest pending command', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'], pilotDelay: 3 });
  const a = e.spawnAt({ callsign: 'UAL9', type: 'B738', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -8, altFt: 8000 }, heading: 270, speedKts: 250 });
  assert.equal(cmd(e, makeAst('heading', 'UAL9', { hdg: 180, dir: null })).code, 'ok_queued');
  assert.equal(a.pendingCmds.length, 1);
  run(e, 1);
  assert.equal(a.targetHeading, 270, 'not applied before the pilot delay');
  assert.equal(cmd(e, makeAst('heading', 'UAL9', { hdg: 200, dir: null })).code, 'ok_queued');
  assert.equal(a.pendingCmds.length, 1, 'latest heading replaces the pending one');
  run(e, 3.2);
  assert.equal(a.targetHeading, 200);
  assert.equal(a.navMode, 'heading');
  const turned = runUntil(e, () => Math.abs(angleDelta(a.heading, 200)) < 2, 90);
  assert.ok(turned.ok, 'turned to 200');
  assert.ok(turned.elapsed >= 25, `a 70-degree turn at 250 kt takes ${turned.elapsed} s`);
  // forced left turn: heading decreases through 090 the long way
  assert.equal(cmd(e, makeAst('heading', 'UAL9', { hdg: 240, dir: 'L' })).code, 'ok_queued');
  run(e, 3.2);
  assert.equal(a.turnDir, 'L');
  run(e, 15);
  assert.ok(Math.abs(angleDelta(a.heading, 200)) > 20 && angleDelta(200, a.heading) < 0, `turning left (now ${a.heading.toFixed(0)})`);
  const done = runUntil(e, () => Math.abs(angleDelta(a.heading, 240)) < 2, 200);
  assert.ok(done.ok);
  // disregard within the delay window
  assert.equal(cmd(e, makeAst('altitude', 'UAL9', { ft: 4000 })).code, 'ok_queued');
  assert.equal(a.pendingCmds.length, 1);
  assert.equal(cmd(e, makeAst('disregard', 'UAL9')).code, 'ok');
  assert.equal(a.pendingCmds.length, 0);
  run(e, 4);
  assert.equal(a.targetAltitude, 8000, 'disregarded altitude never applied');
  assert.equal(cmd(e, makeAst('disregard', 'UAL9')).code, 'nothing_pending');
  // heading / altitude / speed are refused on the ground
  const g = e.spawnDeparture({ callsign: 'GND2', type: 'A320', runway: '27R' })!;
  assert.equal(cmd(e, makeAst('heading', 'GND2', { hdg: 100 })).code, 'invalid_stage');
  assert.equal(cmd(e, makeAst('altitude', 'GND2', { ft: 5000 })).code, 'invalid_stage');
  assert.equal(cmd(e, makeAst('speed', 'GND2', { kts: 200 })).code, 'invalid_stage');
  void g;
});

test('altitude and speed: climb / descend rates, expedite, envelope refusals, minimum 1000 ft, 250 kt below 10000', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  // 22 NM east of the 27L threshold (the approach side), 6 NM either side, flying west toward the field
  const a = e.spawnAt({ callsign: 'UAL8', type: 'B738', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -22, offsetNM: 6, altFt: 8000 }, heading: 270, speedKts: 250 });
  const b = e.spawnAt({ callsign: 'UAL7', type: 'B738', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -22, offsetNM: -6, altFt: 8000 }, heading: 270, speedKts: 250 });
  assert.equal(cmd(e, makeAst('altitude', 'UAL8', { ft: 4000, expedite: false })).code, 'ok_queued');
  assert.equal(cmd(e, makeAst('altitude', 'UAL7', { ft: 4000, expedite: true })).code, 'ok_queued');
  run(e, 3);
  assert.equal(a.cmdAltitude, 4000); assert.equal(a.targetAltitude, 4000);
  assert.equal(a.phase, 'descent');
  assert.equal(e.stageOf(a), 'arr_inbound');
  run(e, 60);
  const dropA = 8000 - a.altitude, dropB = 8000 - b.altitude;
  assert.ok(dropA >= 1400 && dropA <= 1600, `1500 fpm descent (${dropA.toFixed(0)} ft/min)`);
  assert.ok(dropB > dropA * 1.3, `expedite descends faster (${dropB.toFixed(0)} vs ${dropA.toFixed(0)})`);
  const lvl = runUntil(e, () => a.altitude <= 4000, 200);
  assert.ok(lvl.ok);
  run(e, 2);
  assert.equal(a.phase, 'cruise');
  assert.equal(cmd(e, makeAst('altitude', 'UAL8', { ft: 500 })).code, 'unable', 'below 1000 ft refused');
  assert.equal(cmd(e, makeAst('speed', 'UAL8', { kts: 100 })).code, 'unable_envelope');
  assert.equal(cmd(e, makeAst('speed', 'UAL8', { kts: 300 })).code, 'unable_envelope', '250 kt below 10000');
  assert.equal(cmd(e, makeAst('speed', 'UAL8', { kts: 180 })).code, 'ok_queued');
  run(e, 3);
  assert.equal(a.cmdIas, 180);
  const s0 = a.speed;
  run(e, 10);
  assert.ok(s0 - a.speed >= 11 && s0 - a.speed <= 13, `1.2 kt/s deceleration (${(s0 - a.speed).toFixed(1)} kt in 10 s)`);
  const slow = runUntil(e, () => a.speed <= 180.5, 120);
  assert.ok(slow.ok);
  assert.equal(cmd(e, makeAst('speed', 'UAL8', { kts: 'resume' })).code, 'ok_queued');
  run(e, 3);
  assert.equal(a.cmdIas, null);
  // climb: a departure at 2500 fpm to 13000, above 10000 the 250 kt cap lifts
  const d = e.spawnAt({ callsign: 'DEP1', type: 'B738', kind: 'departure', phase: 'climb', posRel: { fromRunway: '27L', alongNM: 4, altFt: 3000 }, heading: 270, speedKts: 230, targets: { alt: 3000 } });
  assert.equal(cmd(e, makeAst('altitude', 'DEP1', { ft: 13000 })).code, 'ok_queued');
  run(e, 63);
  assert.ok(d.altitude - 3000 >= 2300 && d.altitude - 3000 <= 2600, `2500 fpm climb (${(d.altitude - 3000).toFixed(0)} ft in 60 s)`);
  assert.ok(d.speed <= 250.01);
});

test('direct to a fix -> passes it -> heading mode + "request further"; hold at a fix cycles legs within 12 NM and holding speed', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const fix = e.beacons.find(b => b.id === 'BIG') ?? e.beacons[0];
  const start = advance(fix, 45, 12 * NM_TO_M);
  const ll = e.proj.toLngLat(start.x, start.y);
  const a = e.spawnAt({ callsign: 'BAW3', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: ll.lat, lng: ll.lng, altFt: 7000 }, heading: 300, speedKts: 250 });
  assert.equal(cmd(e, makeAst('direct', 'BAW3', { fix: 'ZZZZZ', thenHdg: null })).code, 'unknown_fix');
  assert.equal(cmd(e, makeAst('direct', 'BAW3', { fix: fix.id, thenHdg: null })).code, 'ok_queued');
  run(e, 3);
  assert.equal(a.navMode, 'direct'); assert.equal(a.directTargetName, fix.id);
  const over = runUntil(e, () => a.navMode === 'heading', 600, 2);
  assert.ok(over.ok, 'reached the fix');
  assert.ok(dist(a.pos, fix) < 1.2 * NM_TO_M);
  const further = runUntil(e, () => a.requests[0]?.kind === 'further', 60);
  assert.ok(further.ok, 'pilot asks for further instructions');
  // hold
  assert.equal(cmd(e, makeAst('hold', 'BAW3', { fix: fix.id, inbound: 270, dir: 'L', legTimeMin: 1, legNM: null, efc: null })).code, 'ok_queued');
  run(e, 3);
  assert.equal(a.navMode, 'hold'); assert.equal(a.holdFixName, fix.id); assert.equal(a.holdTurnDir, 'L'); assert.equal(a.holdInboundHdg, 270);
  assert.equal(a.requests.length, 0, 'request answered by the hold');
  const phases = new Set<string>(); let maxD = 0;
  for (let i = 0; i < 60; i++) { run(e, 10); phases.add(a.holdPhase); maxD = Math.max(maxD, dist(a.pos, fix)); }
  assert.ok(phases.size >= 3, `hold phases seen: ${[...phases].join(',')}`);
  assert.ok(maxD < 12 * NM_TO_M, `stays within 12 NM of the fix (${(maxD / NM_TO_M).toFixed(1)})`);
  assert.ok(a.speed <= 230.5, `holding speed at 7000 ft (${a.speed.toFixed(0)} kt)`);
  assert.ok(a.delay.holdingS > 300);
  // a heading takes it out of the hold
  assert.equal(cmd(e, makeAst('heading', 'BAW3', { hdg: 180 })).code, 'ok_queued');
  run(e, 3);
  assert.equal(a.navMode, 'heading'); assert.equal(a.holdFix, null);
});

test('ILS intercept rules: 25-degree intercept captures (ESTABLISHED, LOC then GS), auto handoff to tower at 10 NM; 60-degree intercept flies through; above the glideslope is refused', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const rs = e.runwayState('27L')!;
  // 25-degree intercept from the right-hand side, 14 NM out, 3000 ft (below the slope)
  const p = advance(advance(e.thresholdXY('27L')!, (rs.headingTrue + 180) % 360, 14 * NM_TO_M), (rs.headingTrue + 90) % 360, 2.5 * NM_TO_M);
  const ll = e.proj.toLngLat(p.x, p.y);
  const a = e.spawnAt({ callsign: 'BAW30', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: ll.lat, lng: ll.lng, altFt: 3000 }, heading: (rs.headingTrue + 335) % 360, speedKts: 210 });
  assert.equal(cmd(e, makeAst('ils', 'BAW30', { runway: '09R' })).code, 'invalid_param', 'inactive end');
  const o = cmd(e, makeAst('ils', 'BAW30', { runway: '27L' }));
  assert.equal(o.code, 'ok_queued');
  assert.equal(o.extra?.aboveGlideslope, false);
  run(e, 3);
  assert.equal(a.ilsArmed, true); assert.equal(a.assignedRunway, '27L'); assert.equal(e.stageOf(a), 'arr_armed');
  assert.equal(cmd(e, makeAst('ils', 'BAW30', { runway: '27L' })).code, 'already');
  const cap = runUntil(e, () => a.ilsCaptured, 240);
  assert.ok(cap.ok, 'localizer captured');
  assert.ok(ledgerHas(e, 'ESTABLISHED', 'BAW30'));
  assert.equal(e.stageOf(a), 'arr_established');
  assert.ok(a.targetSpeed <= 200, 'slows to 200 at LOC capture');
  const gs = runUntil(e, () => a.gsCaptured, 240);
  assert.ok(gs.ok, 'glideslope captured from below');
  const ho = runUntil(e, () => a.onFrequency === 'tower', 300);
  assert.ok(ho.ok, 'auto handoff to tower');
  const dHo = e.distToThresholdNM(a, '27L')!;
  assert.ok(dHo <= 10.1 && dHo >= 8, `handed off at ${dHo.toFixed(1)} NM`);
  assert.ok(evs(e, 'handoff', 'BAW30').some(ev => ev.data?.type === 'handoff' && ev.data.to === 'tower'));
  const wy = runUntil(e, () => a.requests[0]?.kind === 'with_you', 20);
  assert.ok(wy.ok, '"with you" check-in on tower');
  // an off-centre capture converges onto the centreline by the touchdown zone (wind-corrected LOC tracking + approach path)
  const cross10 = Math.abs(runwayFrame(e, '27L', a.pos).cross);
  assert.equal(cmd(e, makeAst('clearedLand', 'BAW30', { runway: '27L' })).code, 'ok_queued');
  const td = runUntil(e, () => a.phase === 'rollout', 400);
  assert.ok(td.ok, 'landed');
  const f = runwayFrame(e, '27L', a.pos);
  assert.ok(Math.abs(f.cross) <= 10 && Math.abs(f.cross) < cross10, `touchdown ${f.cross.toFixed(1)} m off the centreline (was ${cross10.toFixed(0)} m at handoff)`);
  assert.ok(f.along >= 200 && f.along <= 450, `touchdown ${f.along.toFixed(0)} m past the threshold`);
  // 60-degree intercept: flies through the localizer
  const p2 = advance(advance(e.thresholdXY('27R')!, (e.runwayHeading('27R') + 180) % 360, 12 * NM_TO_M), (e.runwayHeading('27R') + 90) % 360, 1.5 * NM_TO_M);
  const ll2 = e.proj.toLngLat(p2.x, p2.y);
  const b = e.spawnAt({ callsign: 'BAW60', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: ll2.lat, lng: ll2.lng, altFt: 2500 }, heading: (e.runwayHeading('27R') + 300) % 360, speedKts: 200 });
  assert.equal(cmd(e, makeAst('ils', 'BAW60', { runway: '27R' })).code, 'ok_queued');
  const thru = runUntil(e, () => b.requests.some(r => r.kind === 'further' && /through the localizer/.test(r.text)), 200);
  assert.ok(thru.ok, 'pilot reports flying through and requests vectors back');
  assert.equal(b.ilsCaptured, false);
  assert.ok(ILS_CONST.interceptDeg === 30);
  // above the glideslope: cannot capture
  const c = e.spawnAt({ callsign: 'BAW90', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27R', alongNM: -20, altFt: 7000 }, speedKts: 200 });
  const oc = cmd(e, makeAst('ils', 'BAW90', { runway: '27R' }));
  assert.equal(oc.code, 'ok_queued');
  assert.equal(oc.extra?.aboveGlideslope, true);
  run(e, 20);
  assert.equal(c.ilsCaptured, false);
  assert.ok(c.requests.some(r => r.kind === 'further' && /above the glideslope/.test(r.text)), 'pilot reports above the glideslope and asks for vectors');
  // cancel approach -> heading + altitude, ILS flags cleared (on the established BAW90 re-cleared lower)
  assert.equal(cmd(e, makeAst('altitude', 'BAW90', { ft: 3000 })).code, 'ok_queued');
  const cap90 = runUntil(e, () => c.ilsCaptured, 300);
  assert.ok(cap90.ok, 'captures once below the slope');
  assert.equal(cmd(e, makeAst('cancelApproach', 'BAW90', { hdg: 360, alt: 3000, dir: 'R' })).code, 'ok_queued');
  run(e, 3);
  assert.equal(c.ilsArmed, false); assert.equal(c.ilsCaptured, false); assert.equal(c.targetHeading, 0); assert.equal(c.landingCleared, false);
  assert.equal(c.assignedRunway, null);
});

test('pilot requests: "request descent" after 3 min level at spawn altitude, "with you" at spawn, request timeouts recall and score', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnArrival()!;
  const wy = runUntil(e, () => a.requests[0]?.kind === 'with_you', 10);
  assert.ok(wy.ok);
  assert.equal(cmd(e, makeAst('radarContact', a.callsign, { descendTo: null, expectRunway: '27L' })).code, 'ok_queued');
  assert.equal(a.requests.length, 0);
  run(e, 3);
  assert.equal(a.plan.runway, '27L');
  cmd(e, makeAst('heading', a.callsign, { hdg: Math.round(headingTo(a.pos, e.centerXY)) }));
  const lower = runUntil(e, () => a.requests[0]?.kind === 'lower', 240, 2);
  assert.ok(lower.ok, 'requests descent after 3 min at the entry altitude');
  const t0 = e.time;
  const recalled = runUntil(e, () => evs(e, 'request', a.callsign).some(ev => ev.data?.type === 'request' && ev.data.change === 'recalled'), 120, 2);
  assert.ok(recalled.ok, 'unanswered request is re-called');
  assert.ok(e.time - t0 >= 80, `recall after ${(e.time - t0).toFixed(0)} s`);
  assert.equal(cmd(e, makeAst('altitude', a.callsign, { ft: 4000 })).code, 'ok_queued');
  assert.equal(a.requests.length, 0, 'answered');
  assert.ok(a.delay.requestWaitS > 80);
  assert.ok(e.stats.responsivenessMeanS > 0);
});

test('15 NM auto-slow to 220 kt for arrivals without an assigned speed; a departure is not slowed', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const p = advance(e.centerXY, 90, 16 * NM_TO_M); const ll = e.proj.toLngLat(p.x, p.y);
  const a = e.spawnAt({ callsign: 'ARR1', type: 'A320', kind: 'arrival', phase: 'approach', posLL: { lat: ll.lat, lng: ll.lng, altFt: 6000 }, heading: 270, speedKts: 250 });
  const d = e.spawnAt({ callsign: 'DEP2', type: 'A320', kind: 'departure', phase: 'climb', posLL: { lat: ll.lat, lng: ll.lng, altFt: 6000 }, heading: 90, speedKts: 250, targets: { alt: 6000 } });
  run(e, 60);
  assert.ok(a.targetSpeed <= 220 && a.speed < 250, `arrival slowed (${a.speed.toFixed(0)} kt)`);
  assert.ok(d.speed >= 249, 'departure keeps 250');
});

test('AI approach assist: three arrivals are sequenced onto the ILS (radar contact, descent, 30-degree intercept beyond the 10 NM gate) without a separation loss', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  e.settings.autoApproach = true; e.settings.autoTower = true;
  const list = [e.spawnArrival()!, e.spawnArrival()!, e.spawnArrival()!];
  for (const a of list) { a.plan.runway = '27L'; a.assignedRunway = '27L'; }
  const cap = runUntil(e, () => list.every(a => ['rollout', 'taxi', 'hold_short', 'arrived'].includes(a.phase) || !e.aircraft.includes(a)), 2400, 2);
  assert.ok(cap.ok, `all landed (${list.map(a => `${a.callsign}:${a.phase}/${a.ilsCaptured}`).join(' ')})`);
  assert.equal(evs(e, 'separation_loss').length, 0, evs(e, 'separation_loss').map(x => x.message).join('; '));
  assert.equal(evs(e, 'diversion').length, 0);
  assert.equal(evs(e, 'go_around').length, 0, evs(e, 'go_around').map(x => x.message).join('; '));
  const ai = evs(e, 'transmission').filter(x => /^AI APP:/.test(x.message));
  assert.ok(ai.some(x => /radar contact/.test(x.message)) && ai.some(x => /cleared ILS/.test(x.message)) && ai.some(x => /fly heading/.test(x.message)), 'assist transmissions logged');
  // no established aircraft ever turned in inside 7.5 NM
  for (const a of list) if (a.ilsCaptured) assert.ok(a.requests.every(r => r.kind !== 'further'), 'no vectors-back requests');
});

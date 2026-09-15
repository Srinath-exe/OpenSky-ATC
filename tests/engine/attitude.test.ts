// Ground kinematics and attitude: the nose wheel follows the line and the body trails it (no pivot on the nose wheel),
// pushback starts without a jump and ends aligned, rotation / liftoff / flare / de-rotation and coordinated bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, run, runUntil, cmd, spawnOnFinal, dist, angleDelta } from './helpers';
import { makeAst } from '../../src/lib/sim/commandAst';
import { wheelbaseM, trailBody } from '../../src/lib/sim/aircraft';
import { sampleAlong } from '../../src/lib/sim/projection';

test('taxi turn: the body heading lags the path tangent and never swings faster than the wheelbase allows', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW9', type: 'B77W', kind: 'departure', phase: 'taxi', runway: '27R', onFrequency: 'ground' });
  cmd(e, makeAst('taxi', 'BAW9', { dest: { kind: 'runway', runway: '27R', intersection: null } }));
  const L = wheelbaseM(a); assert.ok(L > 25 && L < 30, `777 wheelbase ${L.toFixed(1)} m`);
  let prevH = a.heading, prevPos = { ...a.pos }, maxDegPerM = 0, maxLag = 0, samples = 0;
  runUntil(e, () => {
    const dm = dist(prevPos, a.pos);
    if (dm > 0.05 && a.path) {
      maxDegPerM = Math.max(maxDegPerM, Math.abs(angleDelta(prevH, a.heading)) / dm);
      const tan = sampleAlong(a.path.pts, a.path.cum, a.distAlong).heading;
      maxLag = Math.max(maxLag, Math.abs(angleDelta(a.heading, tan))); samples++;
    }
    prevH = a.heading; prevPos = { ...a.pos };
    return a.phase === 'hold_short';
  }, 900);
  assert.ok(samples > 100, 'taxied');
  assert.ok(maxDegPerM <= (180 / Math.PI) / L + 0.05, `heading change ${maxDegPerM.toFixed(2)} deg/m within 1/wheelbase (${((180 / Math.PI) / L).toFixed(2)})`);
  assert.ok(maxLag > 8, `the body lagged the line through the bends (max ${maxLag.toFixed(0)} deg)`);
});

test('trailBody: a nose wheel moving abeam swings the body toward the travel direction, straight ahead keeps it', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW8', type: 'A320', kind: 'departure', phase: 'parked', runway: '27R', onFrequency: 'ground' });
  a.heading = 0; trailBody(a, 0, 5, 1); assert.equal(a.heading, 0);
  trailBody(a, 90, 5, 1); assert.ok(a.heading > 15 && a.heading < 25, `swung right ${a.heading.toFixed(1)} deg over 5 m`);
  a.heading = 0; trailBody(a, 270, 5, 1); assert.ok(a.heading > 335 && a.heading < 345, `swung left ${a.heading.toFixed(1)} deg`);
});

test('pushback: the nose stays put when the push starts, the tug slows in the bend, the body ends along the lane', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW7', type: 'B77W', kind: 'departure', phase: 'parked', runway: '27R', onFrequency: 'ground' });
  const p0 = { ...a.pos };
  cmd(e, makeAst('pushback', 'BAW7', { dir: 'any', expectRunway: '27R', startup: true, tailTo: null }));
  runUntil(e, () => a.pushback.stage === 'pushing', 60);
  assert.ok(dist(p0, a.pos) < 0.5, `nose wheel still at the stop mark as the push starts (${dist(p0, a.pos).toFixed(1)} m)`);
  run(e, 1);
  assert.ok(dist(p0, a.pos) < 3, `crept back a metre or so in the first second (${dist(p0, a.pos).toFixed(1)} m)`);
  let minKtInBend = 9; let sawBend = false;
  runUntil(e, () => {
    if (a.path && a.speed > 0.5) {
      const h0 = sampleAlong(a.path.pts, a.path.cum, a.distAlong).heading, h1 = sampleAlong(a.path.pts, a.path.cum, Math.min(a.path.total, a.distAlong + 12)).heading;
      if (Math.abs(angleDelta(h0, h1)) > 25) { sawBend = true; minKtInBend = Math.min(minKtInBend, a.speed); }
    }
    return a.pushback.stage === 'tug_disconnect';
  }, 300);
  assert.equal(a.pushback.stage, 'tug_disconnect');
  assert.ok(!sawBend || minKtInBend < 2.6, `slowed for the bend (${minKtInBend.toFixed(1)} kt)`);
  const tan = sampleAlong(a.path!.pts, a.path!.cum, a.path!.total).heading;
  assert.ok(Math.abs(angleDelta(a.heading, (tan + 180) % 360)) < 4, `body along the lane at the end (${a.heading.toFixed(0)} vs ${((tan + 180) % 360).toFixed(0)})`);
  assert.ok(dist(a.pos, sampleAlong(a.path!.pts, a.path!.cum, a.path!.total).pos) > wheelbaseM(a) - 2, 'nose wheel a wheelbase ahead of the main gear');
});

test('rotation, liftoff, climb attitude and a coordinated 25-degree bank', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const a = e.spawnAt({ callsign: 'BAW6', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27R', onFrequency: 'tower' });
  runUntil(e, () => a.phase === 'lineup' && a.speed < 0.3, 120);
  assert.equal(a.pitch, 0);
  cmd(e, makeAst('takeoff', 'BAW6', { runway: '27R', immediate: false, afterDepHdg: null, turn: null, initialAlt: null, contactDeparture: false }));
  let firstPitchKt: number | null = null;
  runUntil(e, () => { if (firstPitchKt == null && a.pitch > 0) firstPitchKt = a.speed; return a.delay.airborneAt != null; }, 200);
  assert.ok(a.delay.airborneAt != null, 'airborne');
  assert.ok(firstPitchKt != null && Math.abs(firstPitchKt - a.perf.takeoffRotationSpeed) < 12, `rotation began near Vr (${firstPitchKt} kt)`);
  assert.ok(a.pitch >= 7.9 && a.pitch <= 12, `wheels off at ~8 deg, pitching on (${a.pitch.toFixed(1)})`);
  assert.ok(a.speed > a.perf.takeoffRotationSpeed, 'liftoff above Vr');
  runUntil(e, () => a.altitude > 600, 200);
  assert.ok(a.pitch > 9 && a.pitch <= 15.5, `initial climb attitude ${a.pitch.toFixed(1)} deg`);
  runUntil(e, () => Math.abs(angleDelta(a.heading, a.targetHeading)) < 1 && Math.abs(a.bank) < 0.5, 200);   // the SID's own turn done
  const want = Math.round((a.heading + 120) % 360);
  const r = cmd(e, makeAst('heading', 'BAW6', { hdg: want, dir: 'R' }));
  assert.equal(r.code, 'ok_queued', `heading command: ${r.code} ${r.reason ?? ''}`);
  runUntil(e, () => Math.abs(angleDelta(a.targetHeading, want)) < 1, 60);
  let maxBank = 0, minBank = 0;
  runUntil(e, () => { maxBank = Math.max(maxBank, a.bank); minBank = Math.min(minBank, a.bank); return Math.abs(angleDelta(a.heading, a.targetHeading)) < 1 && Math.abs(a.bank) < 1; }, 200);
  assert.ok(maxBank > 20 && maxBank <= 25.5 && minBank > -3, `right turn banked right (${maxBank.toFixed(1)} / ${minBank.toFixed(1)})`);
});

test('landing: nose-up on the slope, flare to ~5 degrees at touchdown, de-rotation on the roll', () => {
  const e = makeEngine('EGLL', { ends: ['27R', '27L'] });
  const b = spawnOnFinal(e, 'DAL2', '27L', 4, { type: 'A320', landingCleared: true });
  runUntil(e, () => b.altitude < 300, 200);
  assert.ok(b.pitch > 0.5 && b.pitch < 4, `approach attitude ${b.pitch.toFixed(1)} deg`);
  runUntil(e, () => b.phase === 'rollout', 200);
  assert.equal(b.phase, 'rollout');
  assert.ok(b.pitch >= 4, `flared (${b.pitch.toFixed(1)} deg)`);
  const td = b.distAlong - b.thresholdDist;
  assert.ok(td >= 280 && td <= 470, `touchdown ${td.toFixed(0)} m past the threshold`);
  run(e, 6);
  assert.ok(b.pitch < 0.5, `nose wheel down after 6 s (${b.pitch.toFixed(1)})`);
});

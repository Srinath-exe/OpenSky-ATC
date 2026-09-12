// ============================================================
//  Aircraft physics & state machine (pure — no engine data, no DOM)
//
//  Ground movement: ARC-LENGTH PATH FOLLOWING on a Chaikin-smoothed polyline
//  with hold-short PLACES (DrivePath.holds — the next unreleased hold is the
//  only place the aircraft stops for a clearance; B4/B5).
//  Pushback: the aircraft follows a short pushback path TAIL FIRST at 3 kt
//  while the engine sequences tug attach / push / disconnect.
//  Takeoff: runway roll with class acceleration, rotation at Vr minus the
//  headwind component, initial climb on runway heading to 400 ft AGL.
//  Airborne flight: free integration toward autopilot targets; motion is
//  along the wind-corrected track at ground speed (weather.applyWind).
//  Landing: glideslope with 50 ft TCH, flare, touchdown 300-450 m past the
//  threshold, rollout deceleration profile to a planned exit speed.
//
//  Altitude throughout this module is in FEET AGL. Distances in metres.
//  Speed knots (ground speed on the ground, IAS-ish in the air).
// ============================================================
import { dist, headingTo, angleDelta, advance, sampleAlong, KTS_TO_MPS, FT_TO_M, NM_TO_M } from './projection';
import type { AircraftState, FlightPhase, PathHold, SimEventData, SimEventType } from './types';
import { EMERGENCY_CATALOGUE } from './emergencies';
import { TCH_FT } from './ils';

const FT_PER_M = 1 / FT_TO_M;  // 3.28084

const TRAIL_STEP_M = 8, TRAIL_MAX = 260;
/** Taxi accel 1.2 m/s^2, brake 2.5 m/s^2, emergency brake 3.0 (03 §8) in kt/s. */
export const TAXI_ACCEL = 1.2 / KTS_TO_MPS;     // 2.33 kt/s
export const TAXI_DECEL = 2.5 / KTS_TO_MPS;     // 4.86 kt/s
export const EMERG_DECEL = 3.0 / KTS_TO_MPS;    // 5.83 kt/s
const HEADING_DAMP = 100;                       // deg/s ceiling
const GROUND_DEG_PER_M = 5.5;                  // curvature limit → no pivots when stopped
/** Nose stops this far before the hold line node (03 §1.5: stop < 10 m before the line). */
export const HOLD_BUFFER_M = 7;
export const PUSHBACK_KT = 3;
/** Turns allowed / phase climb from this AGL (03 §2.2). */
export const DEP_TURN_FT = 400;
/** Initial climb rate to 1500 ft AGL (03 §2.2). */
const INITIAL_CLIMB_FPM = 2800;
const INITIAL_CLIMB_TO_FT = 1500;

export type Ev = { push: (m: string, t?: SimEventType) => void };

/** What the physics needs from the engine each step (kept tiny so tests can mock it). */
export interface StepCtx {
  time: number;
  /** Wind triangle: ground speed and track for a heading/TAS (weather.applyWindToGroundSpeed). */
  wind(hdgTrue: number, tasKt: number): { gsKt: number; trackTrue: number };
  /** Headwind component (kt, tailwind negative) on a runway heading. */
  headwindKt(rwyHdgTrue: number): number;
  /** Runway surface braking factor: dry 1, wet 0.65, contaminated 0.4. */
  surfaceFactor(): number;
  /** Engine-computed taxi speed cap for this tick (apron / crossing / expedite), kt. */
  taxiSpeedCapKt(a: AircraftState): number;
  emit(type: SimEventType, a: AircraftState, message: string, data?: SimEventData): void;
  setPhase(a: AircraftState, phase: FlightPhase): void;
}

export function setPhase(a: AircraftState, phase: FlightPhase, events: Ev) {
  if (a.phase === phase) return;
  a.phase = phase;
  events.push(`${a.callsign} -> ${phase}`, 'phase');
}

/** Per-tick physics for one aircraft. Pending-command draining is the engine's job (it needs engine data). */
export function stepAircraft(a: AircraftState, dt: number, ctx: StepCtx) {
  switch (a.phase) {
    case 'parked': case 'startup': case 'arrived': a.speed = 0; break;
    case 'pushback': stepPushback(a, dt); break;
    case 'taxi':
    case 'hold_short': stepTaxi(a, dt, ctx); break;
    case 'lineup': stepLineup(a, dt, ctx); break;
    case 'takeoff': stepTakeoff(a, dt, ctx); break;
    case 'climb':
    case 'cruise':
    case 'descent':
    case 'approach':
    case 'go_around':
    case 'departed': stepAirborneFree(a, dt, ctx); break;
    case 'landing': stepLanding(a, dt, ctx); break;
    case 'rollout': stepRollout(a, dt, ctx); break;
    default: break;
  }
  pushTrail(a);
}

// ── integrators ────────────────────────────────────────────────────────────────
export function approachVal(cur: number, target: number, maxStep: number): number {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}
export function brakingDistM(speedKts: number, decelKtsS: number): number {
  const v = speedKts * KTS_TO_MPS, a = Math.max(0.1, decelKtsS * KTS_TO_MPS);
  return (v * v) / (2 * a);
}

/** Arc-length the aircraft must stop at for the next unreleased hold, or null. */
export function nextStopAt(a: AircraftState): number | null {
  const p = a.path;
  if (!p) return null;
  const h = p.holds && p.holds.length ? p.holds[0] : null;
  if (h && !a.holdReleased) return h.at - HOLD_BUFFER_M;
  if (!h && p.holdAt != null && !a.holdReleased) return p.holdAt - HOLD_BUFFER_M;
  return null;
}

/**
 * Advance along the path at `targetSpeed` (kt) honouring traffic holds and
 * the next stop point. `reverse` = tail-first (pushback). Returns true at the
 * path end.
 */
function follow(a: AircraftState, dt: number, targetSpeed: number, accel: number, decel: number, reverse = false): boolean {
  const p = a.path!;
  let tgt = targetSpeed;
  if (a.trafficHold) tgt = 0;
  const stopAt = nextStopAt(a);
  if (stopAt != null) {
    const remain = stopAt - a.distAlong;
    if (remain <= brakingDistM(a.speed, decel) + 1.5) tgt = 0;
  }
  a.targetSpeed = tgt;
  a.speed = approachVal(a.speed, tgt, (tgt >= a.speed ? accel : decel) * dt);
  if (a.speed < 0) a.speed = 0;

  const movedM = a.speed * KTS_TO_MPS * dt;
  const prevAlong = a.distAlong;
  a.distAlong += movedM;
  // Overshoot clamp for the discrete step only: a hold re-armed behind the aircraft must never move it backwards (B5).
  if (stopAt != null && a.distAlong > stopAt) { a.distAlong = Math.max(stopAt, prevAlong); }
  // End of path: clamp (never snap forward - end checks tolerate the last 0.6 m).
  const atEnd = a.distAlong >= p.total - 0.5;
  if (a.distAlong > p.total) a.distAlong = p.total;

  const s = sampleAlong(p.pts, p.cum, a.distAlong);
  a.pos = s.pos;
  const want = reverse ? (s.heading + 180) % 360 : s.heading;
  const d = angleDelta(a.heading, want);
  const maxStep = Math.min(HEADING_DAMP * dt, GROUND_DEG_PER_M * movedM + 0.05);
  a.heading = (a.heading + Math.sign(d) * Math.min(Math.abs(d), maxStep) + 360) % 360;
  return atEnd;
}

/** Progressive taxi speed: straight -> maxTaxiSpeed, bends -> taxiTurnSpeed, into a stand -> creep. */
function taxiTargetSpeed(a: AircraftState, capKt: number): number {
  const p = a.path!;
  const h0 = sampleAlong(p.pts, p.cum, a.distAlong).heading;
  let bend = 0;
  for (const look of [14, 28, 45]) {
    const h = sampleAlong(p.pts, p.cum, Math.min(a.distAlong + look, p.total)).heading;
    bend = Math.max(bend, Math.abs(angleDelta(h0, h)));
  }
  const t = Math.min(1, bend / 32);
  const slow = a.perf.taxiTurnSpeed * 0.8;
  let v = a.perf.maxTaxiSpeed + (slow - a.perf.maxTaxiSpeed) * t;
  v = Math.min(v, capKt);
  const remain = p.total - a.distAlong;
  // final 30 m into a stand at <= 5 kt (03 §1.9), then a marshaller stop
  if (nextStopAt(a) == null && remain < 60) v = Math.min(v, Math.max(2, 5 * (remain / 30)));
  return Math.max(0, v);
}

// ── pushback ─────────────────────────────────────────────────────────────────
function stepPushback(a: AircraftState, dt: number) {
  if (a.pushback.stage !== 'pushing' || !a.path) {
    a.speed = approachVal(a.speed, 0, TAXI_DECEL * dt);
    return;
  }
  const end = follow(a, dt, PUSHBACK_KT, TAXI_ACCEL, TAXI_DECEL, true);
  a.pushback.pushedM = a.distAlong;
  if (end) { a.speed = 0; }
}

// ── taxi (path-follow with hold places) ────────────────────────────────────────
function stepTaxi(a: AircraftState, dt: number, ctx: StepCtx) {
  if (!a.path) { a.speed = approachVal(a.speed, 0, TAXI_DECEL * dt); return; }
  const p = a.path;
  const atEnd = follow(a, dt, taxiTargetSpeed(a, ctx.taxiSpeedCapKt(a)), TAXI_ACCEL, TAXI_DECEL);

  // Passed a released hold -> it is behind us now; the next one arms itself.
  const h: PathHold | undefined = p.holds?.[0];
  if (h && a.holdReleased && a.distAlong > h.at + 4) {
    p.holds!.shift();
    a.holdReleased = false;
    a.holdShortNode = null; a.holdShortRunway = null;
    p.holdAt = p.holds!.length ? p.holds![0].at : undefined;
  }

  const stopAt = nextStopAt(a);
  if (stopAt != null && !a.trafficHold) {
    const remain = stopAt - a.distAlong;
    if (remain <= 3 && a.speed < 3) {
      a.speed = Math.max(0, a.speed - TAXI_DECEL * 2 * dt);
      if (a.speed < 0.3) a.speed = 0;
      if (a.phase !== 'hold_short') {
        const hold = p.holds?.[0];
        a.holdShortNode = hold?.nodeId ?? a.holdShortNode;
        a.holdShortRunway = hold && hold.runway ? hold.runway : null;
        ctx.setPhase(a, 'hold_short');
        const what = hold?.runway ? `runway ${hold.runway}` : a.holdShortTaxiway ? `taxiway ${a.holdShortTaxiway}` : 'position';
        ctx.emit('reached_hold', a, `${a.callsign} holding short ${what}`);
      }
      return;
    }
  }
  if (a.phase === 'hold_short' && (stopAt == null || a.speed > 0.5)) ctx.setPhase(a, 'taxi');

  // Reaching the end of a taxi path (a stand, a holding point node, ...) is
  // handled by the engine (it knows the destination kind).
  if (atEnd) a.speed = approachVal(a.speed, 0, TAXI_DECEL * dt);
}

// ── lineup: taxi onto the runway and stop aligned ──────────────────────────────
function stepLineup(a: AircraftState, dt: number, ctx: StepCtx) {
  if (!a.path) { a.speed = approachVal(a.speed, 0, TAXI_DECEL * dt); return; }
  const cap = Math.min(a.perf.taxiTurnSpeed, ctx.taxiSpeedCapKt(a));
  const end = follow(a, dt, cap, TAXI_ACCEL, TAXI_DECEL);
  if (end) a.speed = approachVal(a.speed, 0, TAXI_DECEL * dt);
}

// ── takeoff ────────────────────────────────────────────────────────────────────
/** Class acceleration on the roll (03 §2.2: jets 1.8-2.3 m/s^2, light 1.5), kt/s. */
export function takeoffAccelKts(a: AircraftState): number {
  if (a.perf.specialRules.militaryManeuvering) return 4.5 / KTS_TO_MPS;
  switch (a.perf.weightClass) {
    case 'L': return 1.5 / KTS_TO_MPS;
    case 'M': return 2.1 / KTS_TO_MPS;
    case 'H': return 1.85 / KTS_TO_MPS;
    default: return 1.7 / KTS_TO_MPS;
  }
}

function stepTakeoff(a: AircraftState, dt: number, ctx: StepCtx) {
  // Airborne part of the takeoff (50-400 ft): runway heading, initial climb.
  if (!a.path) {
    stepInitialClimb(a, dt, ctx);
    return;
  }
  if (!a.takeoffCleared) {
    // Spooling up / holding on the runway: stationary (or still taxiing onto it for a rolling takeoff).
    const cap = Math.min(a.perf.taxiTurnSpeed, ctx.taxiSpeedCapKt(a));
    if (a.holdReleased) follow(a, dt, cap, TAXI_ACCEL, TAXI_DECEL); else a.speed = approachVal(a.speed, 0, TAXI_DECEL * dt);
    return;
  }
  const misaligned = Math.abs(angleDelta(a.heading, a.targetHeading)) > 12;
  if (misaligned) { follow(a, dt, a.perf.taxiTurnSpeed, TAXI_ACCEL, TAXI_DECEL); return; }
  const accel = takeoffAccelKts(a);
  const head = ctx.headwindKt(a.targetHeading);
  const vrGround = Math.max(40, a.perf.takeoffRotationSpeed - head);
  const end = follow(a, dt, vrGround + 40, accel, TAXI_DECEL);
  if (a.speed >= vrGround || end) {
    // Rotation / liftoff
    a.path = null; a.distAlong = 0;
    a.altitude = 5;
    a.targetHeading = a.heading;
    a.targetSpeed = Math.min(a.perf.maxAirspeedTMA, a.perf.takeoffRotationSpeed + 70);
    a.attention = true;
    a.delay.airborneAt = ctx.time;
    ctx.emit('airborne', a, `${a.callsign} airborne runway ${a.plan.runway ?? ''}`.trim());
  }
}

/** 5-400 ft AGL: runway heading, 2800 fpm, accelerating. The engine flips to `climb` at 400 ft. */
function stepInitialClimb(a: AircraftState, dt: number, ctx: StepCtx) {
  const spd = emergencyMaxSpeed(a, a.targetSpeed);
  a.speed = approachVal(a.speed, spd, a.perf.accelerationRateAir * dt);
  a.altitude += (Math.min(INITIAL_CLIMB_FPM, a.perf.maxClimbRate * 1.2) / 60) * dt * climbFactor(a);
  const w = ctx.wind(a.heading, a.speed);
  a.pos = advance(a.pos, w.trackTrue, w.gsKt * KTS_TO_MPS * dt);
}

function climbFactor(a: AircraftState): number {
  return a.emergency ? EMERGENCY_CATALOGUE[a.emergency.type].perf.maxClimbRateFactor : 1;
}
function emergencyMaxSpeed(a: AircraftState, spd: number): number {
  const m = a.emergency ? EMERGENCY_CATALOGUE[a.emergency.type].perf.maxSpeedKt : null;
  return m != null ? Math.min(spd, m) : spd;
}

// ── free airborne flight ───────────────────────────────────────────────────────
export function stepAirborneFree(a: AircraftState, dt: number, ctx: StepCtx) {
  // Hard speed ceiling: 250 kt below 10,000 ft (14 CFR 91.117)
  let maxSpd = a.altitude < 10000 ? Math.min(a.targetSpeed, 250) : a.targetSpeed;
  maxSpd = emergencyMaxSpeed(a, maxSpd);
  maxSpd = Math.max(maxSpd, a.perf.minAirspeedTMA * 0.9);

  const climbCap = a.altitude < INITIAL_CLIMB_TO_FT && a.plan.kind === 'departure' && a.phase === 'climb'
    ? Math.min(INITIAL_CLIMB_FPM, a.perf.maxClimbRate * 1.2) : a.perf.maxClimbRate;
  const rateUp = (a.expedite ? climbCap * 1.4 : climbCap) * climbFactor(a);
  const rateDn = a.expedite ? a.perf.maxDescentRate * 1.4 : a.perf.maxDescentRate;

  a.speed = approachVal(a.speed, maxSpd, (maxSpd >= a.speed ? a.perf.accelerationRateAir : a.perf.decelerationRateAir) * dt);

  // Turn rate from bank 25 deg: rate = g tan(bank) / V  (~3 deg/s at 180 kt, 2 deg/s at 250 kt)
  const v = Math.max(60, a.speed) * KTS_TO_MPS;
  const rate = Math.min(a.perf.turnRateAir * 1.6, (9.81 * Math.tan(25 * Math.PI / 180) / v) * 180 / Math.PI);
  const dh = angleDelta(a.heading, a.targetHeading);
  let turnDh = dh;
  if (a.turnDir === 'R') turnDh = (a.targetHeading - a.heading + 360) % 360;
  else if (a.turnDir === 'L') turnDh = -(((a.heading - a.targetHeading) + 360) % 360);
  a.heading = (a.heading + Math.sign(turnDh) * Math.min(Math.abs(turnDh), rate * dt) + 360) % 360;
  if (Math.abs(dh) < 1) a.turnDir = null; // reached target — clear forced direction

  const climb = rateUp / 60, desc = rateDn / 60;
  a.altitude = approachVal(a.altitude, a.targetAltitude, (a.targetAltitude >= a.altitude ? climb : desc) * dt);
  const w = ctx.wind(a.heading, a.speed);
  a.pos = advance(a.pos, w.trackTrue, w.gsKt * KTS_TO_MPS * dt);

  // Phase relabel: go_around is sticky until the controller re-vectors; ILS capture pins `approach`.
  if (a.phase === 'go_around' || a.phase === 'departed') return;
  if (a.ilsCaptured) a.phase = 'approach';
  else if (a.altitude < a.targetAltitude - 50) a.phase = 'climb';
  else if (a.altitude > a.targetAltitude + 50) a.phase = 'descent';
  else if (a.phase === 'climb' || a.phase === 'descent') a.phase = 'cruise';
}

// ── landing: track approach path on the glideslope to touchdown ───────────────
function stepLanding(a: AircraftState, dt: number, ctx: StepCtx) {
  if (!a.path) { stepAirborneFree(a, dt, ctx); return; }
  const p = a.path;
  const vapp = a.perf.approachSpeed + (a.emergency ? EMERGENCY_CATALOGUE[a.emergency.type].perf.vappPlusKt : 0);
  // Final speed schedule (03 §8): an assigned speed holds until its "until" distance (default 4 NM), otherwise
  // <= 200 kt outside 6 NM, 160 kt from 6 NM, Vapp inside 4 NM.
  const remainNM = Math.max(0, a.thresholdDist - a.distAlong) / NM_TO_M;
  const untilNM = a.speedUntilNM ?? 4;
  let tgt: number;
  if (a.cmdIas != null && remainNM > untilNM) tgt = Math.max(vapp, a.cmdIas);
  else if (remainNM > 6) tgt = Math.max(vapp, Math.min(a.targetSpeed || vapp, 200));
  else if (remainNM > 4) tgt = Math.max(vapp, Math.min(a.targetSpeed || 160, 160));
  else tgt = vapp;
  a.targetSpeed = tgt;
  a.speed = approachVal(a.speed, tgt, (tgt >= a.speed ? a.perf.accelerationRateAir : a.perf.decelerationRateAir) * dt);
  const tangent = sampleAlong(p.pts, p.cum, a.distAlong).heading;
  const gs = ctx.wind(tangent, a.speed).gsKt;
  const movedM = gs * KTS_TO_MPS * dt;
  a.distAlong = Math.min(p.total, a.distAlong + movedM);
  const s = sampleAlong(p.pts, p.cum, a.distAlong);
  a.pos = s.pos;
  const d = angleDelta(a.heading, s.heading);
  a.heading = (a.heading + Math.sign(d) * Math.min(Math.abs(d), 12 * dt) + 360) % 360;

  // Glideslope: 3 deg to a 50 ft TCH; touchdown zone 300-450 m past the threshold.
  const remain = a.thresholdDist - a.distAlong;            // + before threshold, - past it
  const tdzM = TCH_FT / (Math.tan(3 * Math.PI / 180) * FT_PER_M);
  const gsAlt = Math.max(0, (remain + tdzM) * Math.tan(3 * Math.PI / 180) * FT_PER_M);
  if (a.altitude > TCH_FT || remain > 0) {
    // Follow the slope; if still above it (captured within the tolerance) converge down at the descent rate, never below.
    a.altitude = a.altitude > gsAlt + 1 ? Math.max(gsAlt, a.altitude - (a.perf.maxDescentRate * 1.4 / 60) * dt) : gsAlt;
  } else {
    // Flare from the 50 ft TCH: ~550 fpm sink -> touchdown 300-450 m past the threshold at jet approach speeds (03 §2.5).
    a.altitude = Math.max(0, a.altitude - (550 / 60) * dt);
  }
  if (a.altitude <= 0.01 && remain <= 0) {
    a.altitude = 0;
    a.speed = Math.max(60, a.speed - 5);
    a.delay.touchdownAt = ctx.time;
    ctx.setPhase(a, 'rollout');
    ctx.emit('touchdown', a, `${a.callsign} touchdown runway ${a.plan.runway ?? ''}`.trim());
  }
}

// ── rollout: brake to the planned exit speed at path.holdAt (exit arc-length) ──
/** Rollout deceleration (m/s^2): dry 1.5-2.5 -> 2.0, scaled by surface and emergency factor. */
export function rolloutDecelMps2(a: AircraftState, surface: number): number {
  const f = a.emergency ? EMERGENCY_CATALOGUE[a.emergency.type].perf.rolloutFactor : 1;
  return 2.0 * surface / f;
}

function stepRollout(a: AircraftState, dt: number, ctx: StepCtx) {
  if (!a.path) { a.speed = approachVal(a.speed, 0, (rolloutDecelMps2(a, ctx.surfaceFactor()) / KTS_TO_MPS) * dt); return; }
  const p = a.path;
  const decel = rolloutDecelMps2(a, ctx.surfaceFactor()) / KTS_TO_MPS; // kt/s
  const exitAt = p.holdAt ?? p.total;
  const exitSpd = a.cmdIas != null && a.cmdIas < 60 ? a.cmdIas : 0; // engine stores the planned exit speed in cmdIas during rollout
  const remain = Math.max(0, exitAt - a.distAlong);
  // Highest speed we may still carry here and reach exitSpd at the exit with `decel`.
  const vAllowed = Math.sqrt(Math.max(0, (exitSpd * KTS_TO_MPS) ** 2 + 2 * decel * KTS_TO_MPS * remain)) / KTS_TO_MPS;
  let tgt = Math.min(a.speed, vAllowed);
  // On the exit path (kind 'taxi') the aircraft taxis at turn speed to the end - also when it left the runway from a
  // standstill (cancelled line-up / rejected takeoff), where a pure deceleration profile would never move it.
  if (p.kind === 'taxi') tgt = Math.min(vAllowed, Math.max(a.speed, a.perf.taxiTurnSpeed));
  a.targetSpeed = tgt;
  a.speed = approachVal(a.speed, tgt, (tgt > a.speed ? TAXI_ACCEL : decel) * dt);
  if (a.trafficHold) a.speed = approachVal(a.speed, 0, decel * dt);
  const movedM = a.speed * KTS_TO_MPS * dt;
  a.distAlong = Math.min(p.total, a.distAlong + movedM);
  const s = sampleAlong(p.pts, p.cum, a.distAlong);
  a.pos = s.pos;
  const d = angleDelta(a.heading, s.heading);
  const maxStep = Math.min(HEADING_DAMP * dt, GROUND_DEG_PER_M * movedM + 0.05);
  a.heading = (a.heading + Math.sign(d) * Math.min(Math.abs(d), maxStep) + 360) % 360;
}

// ── trail ──────────────────────────────────────────────────────────────────────
function pushTrail(a: AircraftState) {
  const last = a.trail[a.trail.length - 1];
  if (!last || dist(last, a.pos) > TRAIL_STEP_M) {
    a.trail.push({ x: a.pos.x, y: a.pos.y });
    if (a.trail.length > TRAIL_MAX) a.trail.shift();
  }
}

const AIR = new Set<FlightPhase>(['climb', 'cruise', 'descent', 'approach', 'landing', 'go_around', 'departed']);
export function isAirborne(a: AircraftState): boolean {
  return AIR.has(a.phase) || (a.phase === 'takeoff' && a.path == null);
}
export function isGround(a: AircraftState): boolean { return !isAirborne(a); }
export function routeProgress(a: AircraftState): number {
  if (!a.path || a.path.total < 1) return 0;
  return Math.min(1, a.distAlong / a.path.total);
}
/** Heading the aircraft would fly to a point (compass, true). */
export function bearingTo(a: AircraftState, p: { x: number; y: number }): number { return headingTo(a.pos, p); }

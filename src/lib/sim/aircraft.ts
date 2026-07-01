// ============================================================
//  Aircraft physics & state machine
//
//  Ground movement: ARC-LENGTH PATH FOLLOWING on a Chaikin-smoothed polyline.
//  Airborne flight: free integration toward autopilot targets (heading/alt/speed).
//  ILS approach: localizer + glideslope targets are SET by the engine's
//  handleTransitions() each tick; aircraft.ts just integrates toward them.
//
//  Altitude throughout this module is in FEET. Distances in metres. Speed knots.
// ============================================================
import {
  XY, dist, headingTo, angleDelta, advance, sampleAlong, KTS_TO_MPS, FT_TO_M,
} from './projection';
import { AircraftState, FlightPhase, PendingCmd } from './types';

const FT_PER_M = 1 / FT_TO_M;  // 3.28084

const TRAIL_STEP_M = 8, TRAIL_MAX = 260;
const TAXI_ACCEL = 4.5, TAXI_DECEL = 7;       // kts/s
const HEADING_DAMP = 100;                       // deg/s ceiling
const GROUND_DEG_PER_M = 5.5;                  // curvature limit → no pivots when stopped
const HOLD_BUFFER_M = 7;

export function setPhase(a: AircraftState, phase: FlightPhase, events: Ev) {
  if (a.phase === phase) return;
  a.phase = phase;
  events.push(`${a.callsign} → ${phase}`, 'phase');
}
type Ev = { push: (m: string, t?: any) => void };

export function stepAircraft(a: AircraftState, dt: number, events: Ev, simTime: number) {
  // Apply pending commands whose pilot-delay has elapsed.
  while (a.pendingCmds.length > 0 && a.pendingCmds[0].applyAt <= simTime) {
    const cmd: PendingCmd = a.pendingCmds.shift()!;
    if (cmd.kind === 'heading') { a.targetHeading = cmd.value; a.navMode = 'heading'; }
    else if (cmd.kind === 'altitude') a.targetAltitude = cmd.value;
    else if (cmd.kind === 'speed') a.targetSpeed = cmd.value;
  }

  switch (a.phase) {
    case 'parked': break;
    case 'pushback': stepPushback(a, dt, events); break;
    case 'taxi':
    case 'hold_short': stepTaxi(a, dt, events); break;
    case 'lineup': stepLineup(a, dt); break;
    case 'takeoff': stepTakeoff(a, dt, events); break;
    case 'climb':
    case 'cruise':
    case 'descent':
    case 'approach': stepAirborneFree(a, dt); break;
    case 'landing': stepLanding(a, dt, events); break;
    case 'rollout': stepRollout(a, dt); break;
    default: break;
  }
  pushTrail(a);
}

// ── integrators ────────────────────────────────────────────────────────────────
function approachVal(cur: number, target: number, maxStep: number): number {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return cur;
}
function brakingDistM(speedKts: number, decelKtsS: number): number {
  const v = speedKts * KTS_TO_MPS, a = Math.max(0.1, decelKtsS * KTS_TO_MPS);
  return (v * v) / (2 * a);
}

function follow(a: AircraftState, dt: number, targetSpeed: number, accel: number, decel: number): boolean {
  const p = a.path!;
  let tgt = targetSpeed;
  if (a.trafficHold) tgt = 0;
  if (p.holdAt != null && !a.holdReleased) {
    const stopAt = p.holdAt - HOLD_BUFFER_M;
    const remain = stopAt - a.distAlong;
    if (remain <= brakingDistM(a.speed, decel) + 1.5) tgt = 0;
  }
  a.targetSpeed = tgt;
  a.speed = approachVal(a.speed, tgt, (tgt >= a.speed ? accel : decel) * dt);
  if (a.speed < 0) a.speed = 0;

  const movedM = a.speed * KTS_TO_MPS * dt;
  a.distAlong += movedM;
  if (p.holdAt != null && !a.holdReleased) a.distAlong = Math.min(a.distAlong, p.holdAt - HOLD_BUFFER_M);
  const atEnd = a.distAlong >= p.total - 0.5;
  if (atEnd) a.distAlong = p.total;

  const s = sampleAlong(p.pts, p.cum, a.distAlong);
  a.pos = s.pos;
  const d = angleDelta(a.heading, s.heading);
  const maxStep = Math.min(HEADING_DAMP * dt, GROUND_DEG_PER_M * movedM + 0.05);
  a.heading = (a.heading + Math.sign(d) * Math.min(Math.abs(d), maxStep) + 360) % 360;
  return atEnd;
}

function taxiTargetSpeed(a: AircraftState): number {
  const p = a.path!;
  const h0 = sampleAlong(p.pts, p.cum, a.distAlong).heading;
  let bend = 0;
  for (const look of [14, 28]) {
    const h = sampleAlong(p.pts, p.cum, Math.min(a.distAlong + look, p.total)).heading;
    bend = Math.max(bend, Math.abs(angleDelta(h0, h)));
  }
  const t = Math.min(1, bend / 32);
  const slow = a.perf.taxiTurnSpeed * 0.7;
  let v = a.perf.maxTaxiSpeed + (slow - a.perf.maxTaxiSpeed) * t;
  const remain = p.total - a.distAlong;
  if (p.holdAt == null && remain < 25) v = Math.min(v, a.perf.taxiTurnSpeed * (remain / 25));
  return Math.max(0, v);
}

// ── pushback ─────────────────────────────────────────────────────────────────
function stepPushback(a: AircraftState, dt: number, events: Ev) {
  a.targetSpeed = 3;
  a.speed = approachVal(a.speed, 3, TAXI_ACCEL * dt);
  a.pos = advance(a.pos, (a.heading + 180) % 360, a.speed * KTS_TO_MPS * dt);
  a.distAlong += a.speed * KTS_TO_MPS * dt;
  if (a.distAlong >= 22) { a.speed = 0; a.distAlong = 0; setPhase(a, 'taxi', events); }
}

// ── taxi (path-follow) ─────────────────────────────────────────────────────────
function stepTaxi(a: AircraftState, dt: number, events: Ev) {
  if (!a.path) { a.speed = 0; return; }
  const atEnd = follow(a, dt, taxiTargetSpeed(a), TAXI_ACCEL, TAXI_DECEL);

  if (a.path.holdAt != null && !a.holdReleased && !a.trafficHold) {
    const remain = (a.path.holdAt - HOLD_BUFFER_M) - a.distAlong;
    if (remain <= 3) {
      if (a.phase !== 'hold_short') { setPhase(a, 'hold_short', events); events.push(`${a.callsign} holding short ${a.plan.runway ?? ''}`.trim(), 'reached_hold'); }
      a.speed = Math.max(0, a.speed - TAXI_DECEL * 2 * dt);
      if (a.speed < 0.3) a.speed = 0;
      return;
    }
  }
  if (a.phase !== 'taxi' && !(a.path.holdAt != null && !a.holdReleased)) a.phase = 'taxi';

  if (atEnd && a.speed < 0.4) {
    if (a.plan.kind === 'arrival') { setPhase(a, 'arrived', events); events.push(`${a.callsign} at stand ${a.plan.gateRef ?? ''}`.trim(), 'arrived'); }
  }
}

// ── lineup ─────────────────────────────────────────────────────────────────────
function stepLineup(a: AircraftState, dt: number) {
  if (a.path) follow(a, dt, 0, TAXI_ACCEL, TAXI_DECEL);
  else a.speed = approachVal(a.speed, 0, TAXI_DECEL * dt);
}

// ── takeoff ────────────────────────────────────────────────────────────────────
function takeoffAccelKts(a: AircraftState): number {
  switch (a.perf.weightClass) { case 'L': return 5.5; case 'M': return 3.9; case 'H': return 3.2; default: return 2.8; }
}
function stepTakeoff(a: AircraftState, dt: number, events: Ev) {
  if (!a.path) { a.phase = 'climb'; return; }
  const misaligned = Math.abs(angleDelta(a.heading, a.targetHeading)) > 12;
  if (misaligned) { follow(a, dt, a.perf.taxiTurnSpeed, TAXI_ACCEL, TAXI_DECEL); return; }
  const accel = a.perf.specialRules.militaryManeuvering ? 9 : takeoffAccelKts(a);
  follow(a, dt, a.perf.takeoffRotationSpeed + 30, accel, TAXI_DECEL);
  if (a.speed >= a.perf.takeoffRotationSpeed) {
    setPhase(a, 'climb', events);
    events.push(`${a.callsign} airborne, runway ${a.plan.runway ?? ''}`.trim(), 'airborne');
    a.path = null; a.distAlong = 0;
    a.targetAltitude = a.plan.cruiseAlt ?? 13000;
    a.targetHeading = a.heading;
    a.targetSpeed = Math.min(a.perf.maxAirspeedTMA, a.perf.takeoffRotationSpeed + 70);
    a.navMode = 'sid'; // departures start in SID mode → climb to departure fix
    a.attention = true;
  }
}

// ── free airborne flight ───────────────────────────────────────────────────────
function stepAirborneFree(a: AircraftState, dt: number) {
  // Hard speed ceiling: 250 kt below 10,000 ft (FL100)
  const maxSpd = a.altitude < 10000 ? Math.min(a.targetSpeed, 250) : a.targetSpeed;

  const rateUp = a.expedite ? a.perf.maxClimbRate * 1.5 : a.perf.maxClimbRate;
  const rateDn = a.expedite ? a.perf.maxDescentRate * 1.5 : a.perf.maxDescentRate;

  a.speed = approachVal(a.speed, maxSpd, (maxSpd >= a.speed ? a.perf.accelerationRateAir : a.perf.decelerationRateAir) * dt);

  // Respect forced turn direction (L/R from heading command); clear when on target.
  const dh = angleDelta(a.heading, a.targetHeading);
  let turnDh = dh;
  if (a.turnDir === 'R') turnDh  =  (a.targetHeading - a.heading + 360) % 360;
  else if (a.turnDir === 'L') turnDh = -(((a.heading - a.targetHeading) + 360) % 360);
  a.heading = (a.heading + Math.sign(turnDh) * Math.min(Math.abs(turnDh), a.perf.turnRateAir * dt) + 360) % 360;
  if (Math.abs(dh) < 1) a.turnDir = null; // reached target — clear forced direction

  const climb = rateUp / 60, desc = rateDn / 60;
  a.altitude = approachVal(a.altitude, a.targetAltitude, (a.targetAltitude >= a.altitude ? climb : desc) * dt);
  a.pos = advance(a.pos, a.heading, a.speed * KTS_TO_MPS * dt);

  // Phase update: ILS capture locks phase to 'approach' so handleTransitions can detect it.
  if (a.ilsCaptured) {
    a.phase = 'approach';
  } else if (a.altitude < a.targetAltitude - 50) {
    a.phase = 'climb';
  } else if (a.altitude > a.targetAltitude + 50) {
    a.phase = 'descent';
  } else if (a.phase === 'climb' || a.phase === 'descent') {
    a.phase = 'cruise';
  }
}

// ── landing: track approach path, glideslope to touchdown ─────────────────────
function stepLanding(a: AircraftState, dt: number, events: Ev) {
  if (!a.path) { stepAirborneFree(a, dt); return; }
  follow(a, dt, a.perf.approachSpeed, a.perf.accelerationRateAir, a.perf.decelerationRateAir);
  // Altitude on 3° glideslope in feet (correctly converted from metres remaining)
  const remain = Math.max(0, a.thresholdDist - a.distAlong);
  a.altitude = Math.max(0, remain * Math.tan(3 * Math.PI / 180) * FT_PER_M);
  if (a.distAlong >= a.thresholdDist - 1) {
    a.altitude = 0;
    setPhase(a, 'rollout', events);
    events.push(`${a.callsign} touchdown runway ${a.plan.runway ?? ''}`.trim(), 'touchdown');
  }
}

// ── rollout ────────────────────────────────────────────────────────────────────
function stepRollout(a: AircraftState, dt: number) {
  if (a.path) follow(a, dt, 0, TAXI_ACCEL, a.perf.decelerationRateAir * 6);
  else a.speed = approachVal(a.speed, 0, a.perf.decelerationRateAir * 6 * dt);
}

// ── trail ──────────────────────────────────────────────────────────────────────
function pushTrail(a: AircraftState) {
  const last = a.trail[a.trail.length - 1];
  if (!last || dist(last, a.pos) > TRAIL_STEP_M) {
    a.trail.push({ x: a.pos.x, y: a.pos.y });
    if (a.trail.length > TRAIL_MAX) a.trail.shift();
  }
}

export function isAirborne(a: AircraftState): boolean {
  return ['climb', 'cruise', 'descent', 'approach', 'landing'].includes(a.phase);
}
export function isGround(a: AircraftState): boolean {
  return ['parked', 'pushback', 'taxi', 'hold_short', 'lineup', 'takeoff', 'rollout', 'arrived'].includes(a.phase);
}
export function routeProgress(a: AircraftState): number {
  if (!a.path || a.path.total < 1) return 0;
  return Math.min(1, a.distAlong / a.path.total);
}

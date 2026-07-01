import { GeoPosition, haversine, bearing, angleDiff, clamp, moveAlongBearing } from './geoUtils';
import {
  SimAircraft,
  TaxiRoute,
  RouteProgress,
  GroundState,
  TaxiRouteSegment,
  transitionState,
  grantClearance,
  emptyRouteProgress,
} from './aircraft';
import { TaxiGraph, RunwayThreshold } from './airportData';

// ============================================================
//  Physics Constants
// ============================================================

const TAXI_ACCEL = 1.2;            // m/s^2
const TAXI_DECEL = 2.5;            // m/s^2
const PUSHBACK_ACCEL = 0.8;        // m/s^2
const PUSHBACK_SPEED = 4.0;        // m/s
const HOLD_APPROACH_DIST = 18;    // start decelerating this far before hold
const WAYPOINT_THRESHOLD = 5.0;   // meters — pop look-ahead past a node
const TURN_SPEED_THRESHOLD = 4.5; // m/s — sharp corner speed
const TURN_BOOST_SPEED = 2.5;     // m/s — to escape a stuck turn
const LOOKAHEAD_M = 22;           // pure-pursuit look-ahead distance along route
const LANE_KEEP_MAX_OFFSET = 4.0; // meters off-centerline before correcting
const TAKEOFF_ACCEL = 2.5;        // m/s^2 (airborne accel applied on ground)
const LANDING_DECEL = 3.0;        // m/s^2
const ROTATION_VR_BUFFER = 0;     // m/s — rotate exactly at Vr
const CLIMB_RATE_FPM = 1500;      // ft/min default after liftoff
const HANDOFF_ALT_FT = 1000;      // hand off to departure above this altitude
const ARRIVAL_EXIT_SPEED = 8;     // m/s vacating runway
const ARRIVAL_TAXI_SPEED = 6;     // m/s taxi-in to gate

export interface SimContext {
  otherAircraft: SimAircraft[];
  graph?: TaxiGraph | null;
}

// ============================================================
//  Main update function
// ============================================================

export function updateAircraft(ac: SimAircraft, dt: number, ctx: SimContext): SimAircraft {
  const safeDt = Math.min(dt, 0.1);

  // ── Airborne states: handled separately from ground physics ──
  if (ac.state === 'TAKEOFF_ROLL' || ac.state === 'ROTATE' || ac.state === 'AIRBORNE_CLIMB') {
    return updateAirborne(ac, safeDt, ctx);
  }
  if (ac.state === 'HANDED_OFF') return ac; // frozen, scheduler will despawn

  // ── Ground states ──
  let { targetSpeed, targetHeading } = computeGroundTargets(ac, ctx);

  // Separation override (ground only)
  const sep = checkSeparation(ac, ctx.otherAircraft);
  if (sep.violation) {
    targetSpeed = 0;
  }

  let newSpeed = applySpeedPhysics(ac.speed, targetSpeed, ac.state, ac.performance.maxTaxiSpeed, safeDt);
  let newHeading = applyHeadingPhysics(ac.heading, targetHeading, newSpeed, ac.performance.turnRateAir, safeDt);

  // Stuck-in-turn boost
  const headingDiff = Math.abs(angleDiff(newHeading, targetHeading));
  if (newSpeed < 1.0 && headingDiff > 10 && (ac.state === 'TAXIING' || ac.state === 'TAXIING_TO_GATE')) {
    newSpeed = Math.max(newSpeed, TURN_BOOST_SPEED);
    newHeading = applyHeadingPhysics(ac.heading, targetHeading, newSpeed, ac.performance.turnRateAir, safeDt);
  }

  const distanceMoved = newSpeed * safeDt;
  const movementHeading = ac.state === 'PUSHBACK_OUT' ? (newHeading + 180) % 360 : newHeading;
  const newPosition = distanceMoved > 0
    ? moveAlongBearing(ac.position, movementHeading, distanceMoved)
    : ac.position;

  let newProgress = ac.route
    ? advanceRoute(ac.routeProgress, newPosition, ac.route, ac.clearances, distanceMoved)
    : ac.routeProgress;

  // State transitions
  let newState: GroundState = ac.state;
  if (ac.route && newProgress.completed) {
    if (ac.state === 'PUSHBACK_OUT') {
      newState = 'PUSHBACK_COMPLETE';
    } else if (ac.state === 'TAXIING' && ac.runwayOperation === 'departure') {
      newState = 'RUNWAY_ENTRY';
    } else if ((ac.state === 'TAXIING' || ac.state === 'TAXIING_TO_GATE') && ac.runwayOperation !== 'departure') {
      newState = 'ARRIVED_GATE';
    } else if (ac.state === 'TAXIING_TO_GATE') {
      newState = 'ARRIVED_GATE';
    } else if (ac.state === 'TAXIING') {
      // generic arrival to a node — become ARRIVED_GATE if destination was a gate
      newState = 'ARRIVED_GATE';
    }
  }
  // Auto-hold at hold-short node
  if (newProgress.holdingAt && ac.state !== 'HOLDING') {
    newState = 'HOLDING';
    newSpeed = 0;
  }
  // Resume from hold once cleared (and we haven't auto-cleared it)
  if (ac.state === 'HOLDING' && !newProgress.holdingAt && ac.clearances.taxi) {
    newState = ac.runwayOperation === 'departure' ? 'TAXIING' : (ac.assignedGate ? 'TAXIING_TO_GATE' : 'TAXIING');
  }
  // Hold → line up if cleared
  if (ac.state === 'HOLDING' && ac.clearances.lineUp && ac.runwayOperation === 'departure') {
    newState = 'LINE_UP';
    newProgress = { ...newProgress, holdingAt: null };
  }
  // Line up → takeoff roll if cleared for takeoff
  if (ac.state === 'LINE_UP' && ac.clearances.takeoff) {
    newState = 'TAKEOFF_ROLL';
    newProgress = { ...newProgress, holdingAt: null };
  }

  let updated: SimAircraft = {
    ...ac,
    position: newPosition,
    heading: newHeading,
    speed: newSpeed,
    targetHeading,
    targetSpeed,
    routeProgress: newProgress,
  };
  if (newState !== ac.state) {
    updated = { ...updated, state: newState, stateChangedAt: Date.now() };
  }

  if (distanceMoved > 0.3) {
    updated.trail = [...ac.trail, ac.position].slice(-24);
  }
  return updated;
}

// ============================================================
//  Ground target computation with pure-pursuit steering
// ============================================================

function computeGroundTargets(ac: SimAircraft, ctx: SimContext): { targetSpeed: number; targetHeading: number } {
  switch (ac.state) {
    case 'PARKED':
    case 'ARRIVED_GATE':
    case 'HANDED_OFF':
      return { targetSpeed: 0, targetHeading: ac.heading };

    case 'PUSHBACK_OUT': {
      if (!ac.route) return { targetSpeed: 0, targetHeading: ac.heading };
      const seg = ac.route.path[ac.routeProgress.segmentIndex];
      if (!seg) return { targetSpeed: 0, targetHeading: ac.heading };
      const segBearing = bearing(seg.fromNode.position, seg.toNode.position);
      return { targetSpeed: PUSHBACK_SPEED, targetHeading: (segBearing + 180) % 360 };
    }

    case 'PUSHBACK_COMPLETE':
      return { targetSpeed: 0, targetHeading: ac.heading };

    case 'TAXIING':
    case 'TAXIING_TO_GATE':
      return computeTaxiTargets(ac);

    case 'HOLDING':
      return { targetSpeed: 0, targetHeading: ac.heading };

    case 'RUNWAY_ENTRY': {
      // slow creep toward runway threshold / line-up point
      if (!ac.route) return { targetSpeed: 0, targetHeading: ac.heading };
      const seg = ac.route.path[ac.routeProgress.segmentIndex];
      if (!seg) return { targetSpeed: 0, targetHeading: ac.heading };
      return { targetSpeed: 2.5, targetHeading: bearing(ac.position, seg.toNode.position) };
    }

    case 'LINE_UP':
      // align heading to runway heading; hold position
      return { targetSpeed: 0, targetHeading: runwayHeadingFor(ac) ?? ac.heading };

    case 'ARRIVING_RUNWAY': {
      // decelerating on the runway after touchdown, looking for an exit
      if (!ac.route) return { targetSpeed: 0, targetHeading: ac.heading };
      const seg = ac.route.path[ac.routeProgress.segmentIndex];
      if (!seg) return { targetSpeed: 0, targetHeading: ac.heading };
      const tgt = bearing(ac.position, seg.toNode.position);
      return { targetSpeed: ARRIVAL_EXIT_SPEED, targetHeading: tgt };
    }

    case 'LANDED': {
      // heavy braking on runway centerline
      return { targetSpeed: 0, targetHeading: ac.heading };
    }

    default:
      return { targetSpeed: 0, targetHeading: ac.heading };
  }
}

// Pure-pursuit + speed planning for taxi states
function computeTaxiTargets(ac: SimAircraft): { targetSpeed: number; targetHeading: number } {
  if (!ac.route) return { targetSpeed: 0, targetHeading: ac.heading };
  const route = ac.route;
  const prog = ac.routeProgress;
  const segIdx = prog.segmentIndex;
  const seg = route.path[segIdx];
  if (!seg) return { targetSpeed: 0, targetHeading: ac.heading };

  // Find the look-ahead point along the remaining route
  let speedLimit = Math.min(seg.maxSpeed, ac.performance.maxTaxiSpeed);

  // Hold-short approach decel
  const distToEnd = haversine(ac.position, seg.toNode.position);
  if (seg.holdShortId && distToEnd < HOLD_APPROACH_DIST) {
    const ratio = distToEnd / HOLD_APPROACH_DIST;
    speedLimit *= Math.max(0, ratio);
    if (distToEnd < 6) speedLimit = 0;
  }

  // Slow for upcoming sharp corner (look ahead one segment)
  const nextSeg = route.path[segIdx + 1];
  if (nextSeg && distToEnd < 25) {
    const turnAngle = Math.abs(angleDiff(
      bearing(seg.fromNode.position, seg.toNode.position),
      bearing(nextSeg.fromNode.position, nextSeg.toNode.position),
    ));
    if (turnAngle > 30) speedLimit = Math.min(speedLimit, TURN_SPEED_THRESHOLD);
  }

  // Pure-pursuit: find a target point LOOKAHEAD_M along the polyline from
  // the current segment's fromNode through all remaining segments.
  const lookAhead = findLookAheadPoint(ac, route, prog, LOOKAHEAD_M);
  if (!lookAhead) {
    return { targetSpeed: speedLimit, targetHeading: bearing(ac.position, seg.toNode.position) };
  }

  let targetBearing = bearing(ac.position, lookAhead);

  // Lane keeping: if we're off the current centerline, add a gentle correction
  const fromPos = seg.fromNode.position;
  const toPos = seg.toNode.position;
  const offset = perpendicularDistance(ac.position, fromPos, toPos);
  if (offset > LANE_KEEP_MAX_OFFSET) {
    // Steer slightly back toward the centerline projection point
    const proj = nearestPointOnSegment(ac.position, fromPos, toPos);
    const correctionBearing = bearing(ac.position, proj);
    const correctionWeight = clamp((offset - LANE_KEEP_MAX_OFFSET) / 8, 0, 1);
    // Blend 70% look-ahead / 30% correction (max)
    const blended = blendBearings(targetBearing, correctionBearing, 0.3 * correctionWeight);
    targetBearing = blended;
  }

  return { targetSpeed: speedLimit, targetHeading: targetBearing };
}

// Walk the route polyline accumulating `lookahead` meters from the aircraft's
// current projected position, returning a target point to steer toward.
function findLookAheadPoint(
  ac: SimAircraft,
  route: TaxiRoute,
  prog: RouteProgress,
  lookahead: number,
): GeoPosition | null {
  const startSeg = route.path[prog.segmentIndex];
  if (!startSeg) return null;
  // Project current position onto the current segment to find where we are
  const fromPos = startSeg.fromNode.position;
  const toPos = startSeg.toNode.position;
  const proj = nearestPointOnSegment(ac.position, fromPos, toPos);
  let remaining = lookahead;
  let curPoint = proj;
  for (let i = prog.segmentIndex; i < route.path.length; i++) {
    const s = route.path[i];
    const a = i === prog.segmentIndex ? curPoint : s.fromNode.position;
    const b = s.toNode.position;
    const segLen = haversine(a, b);
    if (segLen <= 0) continue;
    if (remaining <= segLen) {
      const t = clamp(remaining / segLen, 0, 1);
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
      };
    }
    remaining -= segLen;
    curPoint = b;
  }
  // Ran off the end — aim for the final node
  return route.path[route.path.length - 1]?.toNode.position ?? null;
}

// ============================================================
//  Airborne update — takeoff roll, rotate, climb, handoff
// ============================================================

function updateAirborne(ac: SimAircraft, dt: number, ctx: SimContext): SimAircraft {
  const rw = runwayFor(ac);
  if (!rw) {
    // No runway info — bail out, hand off
    return { ...ac, state: 'HANDED_OFF', stateChangedAt: Date.now(), handedOff: true };
  }

  // Pick the threshold we started from
  const startedFrom1 = haversine(ac.position, rw.threshold1) < haversine(ac.position, rw.threshold2);
  const centerline = rw.centerlineCoords;
  const rwHeading = rw.heading1to2;

  if (ac.state === 'TAKEOFF_ROLL') {
    // Accelerate along the runway centerline. We track progress by distance
    // from the starting threshold along the centerline.
    const accel = TAKEOFF_ACCEL;
    const vrMs = ac.performance.takeoffRotationSpeed / 1.94384; // kt → m/s
    const newSpeed = Math.min(ac.speed + accel * dt, ac.performance.maxAirspeedTMA / 1.94384);
    // Move along runway centerline
    const dist = newSpeed * dt;
    const newPos = moveAlongBearing(ac.position, rwHeading, dist);
    const newRollout = ac.rolloutDistance + dist;
    // Rotate when we hit Vr
    let newState: GroundState = ac.state;
    if (newSpeed >= vrMs - ROTATION_VR_BUFFER) {
      newState = 'ROTATE';
    }
    return {
      ...ac,
      position: newPos,
      heading: rwHeading,
      speed: newSpeed,
      targetHeading: rwHeading,
      targetSpeed: vrMs,
      rolloutDistance: newRollout,
      state: newState,
      stateChangedAt: newState !== ac.state ? Date.now() : ac.stateChangedAt,
      trail: appendTrail(ac, newPos),
    };
  }

  if (ac.state === 'ROTATE') {
    // Brief rotate phase: pitch up, lift off after ~3 seconds
    const newSpeed = Math.min(ac.speed + TAKEOFF_ACCEL * dt, ac.performance.maxAirspeedTMA / 1.94384);
    const dist = newSpeed * dt;
    const newPos = moveAlongBearing(ac.position, rwHeading, dist);
    // Transition to climb after we've rotated (small delay)
    const timeInRotate = (Date.now() - ac.stateChangedAt) / 1000;
    let newState: GroundState = ac.state;
    if (timeInRotate > 2.0) newState = 'AIRBORNE_CLIMB';
    return {
      ...ac,
      position: newPos,
      heading: rwHeading,
      speed: newSpeed,
      targetHeading: rwHeading,
      rolloutDistance: ac.rolloutDistance + dist,
      state: newState,
      stateChangedAt: newState !== ac.state ? Date.now() : ac.stateChangedAt,
      trail: appendTrail(ac, newPos),
    };
  }

  if (ac.state === 'AIRBORNE_CLIMB') {
    // Climb straight ahead on runway heading. Gain altitude. Hand off at HANDOFF_ALT_FT.
    const climbFpm = CLIMB_RATE_FPM;
    const climbFps = climbFpm / 60; // ft per second
    const newAlt = ac.altitude + climbFps * dt;
    // Continue accelerating to a climb speed (e.g. maxAirspeedTMA * 0.7)
    const targetClimbSpeed = (ac.performance.maxAirspeedTMA * 0.7) / 1.94384;
    const newSpeed = Math.min(ac.speed + TAKEOFF_ACCEL * dt, targetClimbSpeed);
    const dist = newSpeed * dt;
    const newPos = moveAlongBearing(ac.position, rwHeading, dist);
    let newState: GroundState = ac.state;
    let handedOff = ac.handedOff;
    if (newAlt >= HANDOFF_ALT_FT) {
      newState = 'HANDED_OFF';
      handedOff = true;
    }
    return {
      ...ac,
      position: newPos,
      heading: rwHeading,
      speed: newSpeed,
      targetHeading: rwHeading,
      altitude: newAlt,
      targetAltitude: HANDOFF_ALT_FT,
      verticalSpeed: climbFpm,
      state: newState,
      stateChangedAt: newState !== ac.state ? Date.now() : ac.stateChangedAt,
      handedOff,
      trail: appendTrail(ac, newPos),
    };
  }

  return ac;
}

function appendTrail(ac: SimAircraft, pos: GeoPosition): GeoPosition[] {
  return [...ac.trail, pos].slice(-24);
}

// ============================================================
//  Speed physics
// ============================================================

function applySpeedPhysics(
  current: number,
  target: number,
  state: GroundState,
  maxSpeed: number,
  dt: number,
): number {
  let accel = TAXI_ACCEL;
  let decel = TAXI_DECEL;
  if (state === 'PUSHBACK_OUT') {
    accel = PUSHBACK_ACCEL;
    decel = PUSHBACK_ACCEL * 1.5;
  } else if (state === 'ARRIVING_RUNWAY' || state === 'LANDED') {
    accel = TAXI_ACCEL;
    decel = LANDING_DECEL;
  }
  const diff = target - current;
  if (diff > 0) return Math.min(current + accel * dt, target, maxSpeed);
  if (diff < 0) return Math.max(current - decel * dt, target, 0);
  return current;
}

// ============================================================
//  Heading physics
// ============================================================

function applyHeadingPhysics(
  current: number,
  target: number,
  speed: number,
  turnRateAir: number,
  dt: number,
): number {
  const baseTurnRate = turnRateAir * 0.4;
  const speedFactor = clamp(1 - (speed / 15) * 0.4, 0.3, 1.0);
  const maxTurnRate = baseTurnRate * speedFactor;
  const diff = angleDiff(current, target);
  const turnAmount = clamp(diff, -maxTurnRate * dt, maxTurnRate * dt);
  return (current + turnAmount + 360) % 360;
}

// ============================================================
//  Route progression
// ============================================================

function advanceRoute(
  progress: RouteProgress,
  currentPos: GeoPosition,
  route: TaxiRoute,
  clearances: { holdShort: string | null; taxi: boolean; crossRunway: string | null; lineUp?: boolean; takeoff?: boolean },
  distanceMoved: number,
): RouteProgress {
  if (progress.completed) return progress;
  const segIdx = progress.segmentIndex;
  const seg = route.path[segIdx];
  if (!seg) return { ...progress, completed: true };

  const distToEnd = haversine(currentPos, seg.toNode.position);
  const newRouteDist = progress.routeDistanceTravelled + Math.max(distanceMoved, 0);

  if (distToEnd < WAYPOINT_THRESHOLD) {
    const nextIdx = segIdx + 1;
    if (nextIdx >= route.path.length) {
      return {
        ...progress,
        segmentIndex: nextIdx,
        completed: true,
        holdingAt: null,
        distanceInSegment: 0,
        routeDistanceTravelled: newRouteDist,
      };
    }
    const upcoming = route.path[nextIdx];
    // If the *upcoming* segment ends at a hold-short node and we don't have
    // hold clearance, hold at this node (the toNode of the current seg).
    let holdingAt: string | null = null;
    if (upcoming.holdShortId && !clearances.holdShort && !clearances.crossRunway && !clearances.lineUp && !clearances.takeoff) {
      holdingAt = upcoming.holdShortId;
    }
    return {
      ...progress,
      segmentIndex: nextIdx,
      holdingAt,
      distanceInSegment: 0,
      routeDistanceTravelled: newRouteDist,
    };
  }
  return {
    ...progress,
    distanceInSegment: seg.distance - distToEnd,
    routeDistanceTravelled: newRouteDist,
  };
}

// ============================================================
//  Separation
// ============================================================

export interface SeparationResult {
  violation: boolean;
  withId?: string;
  distance?: number;
  required?: number;
  type?: 'CRITICAL' | 'WARNING';
}

function checkSeparation(ac: SimAircraft, others: SimAircraft[]): SeparationResult {
  for (const other of others) {
    if (other.id === ac.id) continue;
    if (other.state === 'PARKED' || other.state === 'ARRIVED_GATE' || other.state === 'HANDED_OFF') continue;
    if (ac.state === 'PARKED' || ac.state === 'ARRIVED_GATE' || ac.state === 'HANDED_OFF') continue;
    if (ac.state === 'TAKEOFF_ROLL' || ac.state === 'ROTATE' || ac.state === 'AIRBORNE_CLIMB') continue;
    if (other.state === 'TAKEOFF_ROLL' || other.state === 'ROTATE' || other.state === 'AIRBORNE_CLIMB') continue;

    const dist = haversine(ac.position, other.position);
    const required = computeMinSeparation(ac, other);
    if (dist < required) {
      return {
        violation: true,
        withId: other.id,
        distance: dist,
        required,
        type: dist < 10 ? 'CRITICAL' : 'WARNING',
      };
    }
  }
  return { violation: false };
}

function computeMinSeparation(a: SimAircraft, b: SimAircraft): number {
  const base = Math.max(a.performance.safetyRadiusMeters, b.performance.safetyRadiusMeters);
  if (sameDirection(a, b)) return Math.max(base, 50);
  return Math.max(base, 70);
}

function sameDirection(a: SimAircraft, b: SimAircraft): boolean {
  if (!a.route || !b.route) return false;
  const aIdx = a.routeProgress.segmentIndex;
  const bIdx = b.routeProgress.segmentIndex;
  if (!a.route.path[aIdx] || !b.route.path[bIdx]) return false;
  const aEdge = a.route.path[aIdx].edge;
  const bEdge = b.route.path[bIdx].edge;
  if (!aEdge || !bEdge) return false;
  return aEdge.id === bEdge.id || aEdge.name === bEdge.name;
}

// ============================================================
//  Geometry helpers
// ============================================================

function perpendicularDistance(p: GeoPosition, a: GeoPosition, b: GeoPosition): number {
  const dAB = haversine(a, b);
  if (dAB < 0.01) return haversine(p, a);
  const dAP = haversine(a, p);
  const dBP = haversine(b, p);
  const cosA = (dAP * dAP + dAB * dAB - dBP * dBP) / (2 * dAP * dAB);
  const angleA = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (angleA > Math.PI / 2) return dAP;
  const cosB = (dBP * dBP + dAB * dAB - dAP * dAP) / (2 * dBP * dAB);
  const angleB = Math.acos(Math.max(-1, Math.min(1, cosB)));
  if (angleB > Math.PI / 2) return dBP;
  const area = 0.5 * dAP * dAB * Math.sin(angleA);
  return (2 * area) / dAB;
}

function nearestPointOnSegment(p: GeoPosition, a: GeoPosition, b: GeoPosition): GeoPosition {
  const dAB = haversine(a, b);
  if (dAB < 0.01) return a;
  const dAP = haversine(a, p);
  const dBP = haversine(b, p);
  const cosA = (dAP * dAP + dAB * dAB - dBP * dBP) / (2 * dAP * dAB);
  if (cosA < 0) return a;
  const cosB = (dBP * dBP + dAB * dAB - dAP * dAP) / (2 * dBP * dAB);
  if (cosB < 0) return b;
  // Project p onto segment ab parametrically using flat-earth approx
  const t = clamp((dAP * cosA) / dAB, 0, 1);
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

function blendBearings(a: number, b: number, weightB: number): number {
  // Convert both to unit vectors, blend, convert back.
  const ax = Math.cos(a * Math.PI / 180), ay = Math.sin(a * Math.PI / 180);
  const bx = Math.cos(b * Math.PI / 180), by = Math.sin(b * Math.PI / 180);
  const x = ax * (1 - weightB) + bx * weightB;
  const y = ay * (1 - weightB) + by * weightB;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ============================================================
//  Runway lookup
// ============================================================

function runwayFor(ac: SimAircraft, ctx?: SimContext): RunwayThreshold | null {
  // Use ctx.graph if available; otherwise we can't resolve.
  if (ctx?.graph && ac.assignedRunway) {
    return ctx.graph.runways.get(ac.assignedRunway) || null;
  }
  return null;
}

function runwayHeadingFor(ac: SimAircraft): number | null {
  // Best-effort: use the route's last segment toNode if it's a runway entry
  if (!ac.route) return null;
  const last = ac.route.path[ac.route.path.length - 1];
  if (!last) return null;
  return bearing(last.fromNode.position, last.toNode.position);
}

// Re-exports for back-compat with old code that imported from physics.ts
export { assignRoute, clearRoute } from './aircraft';
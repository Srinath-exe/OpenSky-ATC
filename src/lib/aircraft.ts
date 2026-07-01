import { GeoPosition, haversine, bearing, angleDiff, clamp, moveAlongBearing } from './geoUtils';
import { AircraftPerformance } from './types';
import type { TaxiNode, TaxiEdge } from './airportData';
export type { TaxiNode, TaxiEdge } from './airportData';

// ============================================================
//  SimAircraft Types & State Machine
// ============================================================

export type GroundState =
  | 'PARKED'
  | 'PUSHBACK_OUT'
  | 'PUSHBACK_COMPLETE'
  | 'TAXIING'
  | 'HOLDING'
  | 'RUNWAY_ENTRY'
  | 'LINE_UP'
  | 'TAKEOFF_ROLL'
  | 'ROTATE'
  | 'AIRBORNE_CLIMB'
  | 'HANDED_OFF'
  | 'ARRIVING_RUNWAY'
  | 'LANDED'
  | 'TAXIING_TO_GATE'
  | 'ARRIVED_GATE'
  // Legacy alias kept so old code keeps compiling:
  | 'DEPARTING';

export interface ClearanceSet {
  pushback: boolean;
  taxi: boolean;
  holdShort: string | null;
  lineUp: boolean;
  takeoff: boolean;
  crossRunway: string | null;
}

export interface TaxiRouteSegment {
  type: 'taxiway' | 'runway' | 'apron' | 'hold_short' | 'pushback' | 'gate_link';
  fromNode: TaxiNode;
  toNode: TaxiNode;
  edge: TaxiEdge | null;
  distance: number;
  maxSpeed: number;
  isOneWay: boolean;
  holdShortId: string | null;
  runwayCrossing: string | null;
  cumulativeDistance?: number;
}

export interface TaxiRoute {
  path: TaxiRouteSegment[];
  totalDistance: number;
  estimatedDuration: number;
}

export interface RouteProgress {
  segmentIndex: number;
  completed: boolean;
  holdingAt: string | null;
  distanceInSegment: number;
  // Distance along the whole route we've travelled (meters).
  routeDistanceTravelled: number;
}

// TaxiNode / TaxiEdge now live in airportData.ts; re-exported at top of file.

export interface FlightPlan {
  operation: 'departure' | 'arrival';
  originGate?: string | null;        // for departures
  destinationGate?: string | null;  // for arrivals
  runway: string;                   // e.g. "25L"
  sidOrStar?: string;               // optional, for future TRACON handoff
  callsign: string;
}

export interface SimAircraft {
  id: string;
  callsign: string;
  airlineCode: string;
  aircraftType: string;
  position: GeoPosition;
  heading: number;
  speed: number;             // ground speed m/s
  targetHeading: number;
  targetSpeed: number;
  // Airborne-only (0 on ground):
  altitude: number;          // feet MSL
  targetAltitude: number;
  verticalSpeed: number;     // ft/min
  state: GroundState;
  route: TaxiRoute | null;
  routeProgress: RouteProgress;
  assignedGate: string | null;
  assignedSpot: string | null;
  assignedRunway: string | null;
  runwayOperation: 'departure' | 'arrival' | null;
  flightPlan: FlightPlan | null;
  performance: AircraftPerformance;
  clearances: ClearanceSet;
  createdAt: number;
  stateChangedAt: number;
  color: string;
  labelVisible: boolean;
  trail: GeoPosition[];
  // For takeoff roll: distance travelled along runway centerline from threshold
  rolloutDistance: number;
  // For airborne climb: cleared-to-handoff flag
  handedOff: boolean;
}

// ============================================================
//  Aircraft Performance Database
// ============================================================

const PERFORMANCE_DB: Record<string, AircraftPerformance> = {
  C172: {
    icaoCode: 'C172',
    modelName: 'Cessna 172',
    weightClass: 'L',
    wingspanMeters: 11,
    lengthMeters: 8.3,
    safetyRadiusMeters: 15,
    maxTaxiSpeed: 8,
    takeoffRotationSpeed: 25,
    approachSpeed: 30,
    maxAirspeedTMA: 55,
    minAirspeedTMA: 25,
    maxClimbRate: 5,
    maxDescentRate: 3,
    accelerationRateAir: 1.5,
    decelerationRateAir: 2,
    turnRateAir: 3,
    specialRules: {
      wakeTurbulenceGenerator: false,
      wakeTurbulenceRequiredCategory: 'none',
      priorityAirspaceAccess: false,
      militaryManeuvering: false,
    },
  },
  A320: {
    icaoCode: 'A320',
    modelName: 'Airbus A320',
    weightClass: 'M',
    wingspanMeters: 35.8,
    lengthMeters: 37.6,
    safetyRadiusMeters: 30,
    maxTaxiSpeed: 12,
    takeoffRotationSpeed: 70,
    approachSpeed: 65,
    maxAirspeedTMA: 120,
    minAirspeedTMA: 55,
    maxClimbRate: 12,
    maxDescentRate: 8,
    accelerationRateAir: 2,
    decelerationRateAir: 3,
    turnRateAir: 2,
    specialRules: {
      wakeTurbulenceGenerator: false,
      wakeTurbulenceRequiredCategory: 'none',
      priorityAirspaceAccess: false,
      militaryManeuvering: false,
    },
  },
  B738: {
    icaoCode: 'B738',
    modelName: 'Boeing 737-800',
    weightClass: 'M',
    wingspanMeters: 35.8,
    lengthMeters: 39.5,
    safetyRadiusMeters: 30,
    maxTaxiSpeed: 12,
    takeoffRotationSpeed: 75,
    approachSpeed: 70,
    maxAirspeedTMA: 130,
    minAirspeedTMA: 60,
    maxClimbRate: 12,
    maxDescentRate: 8,
    accelerationRateAir: 2,
    decelerationRateAir: 3,
    turnRateAir: 2,
    specialRules: {
      wakeTurbulenceGenerator: false,
      wakeTurbulenceRequiredCategory: 'none',
      priorityAirspaceAccess: false,
      militaryManeuvering: false,
    },
  },
  B77W: {
    icaoCode: 'B77W',
    modelName: 'Boeing 777-300ER',
    weightClass: 'H',
    wingspanMeters: 64.8,
    lengthMeters: 73.9,
    safetyRadiusMeters: 50,
    maxTaxiSpeed: 15,
    takeoffRotationSpeed: 85,
    approachSpeed: 80,
    maxAirspeedTMA: 150,
    minAirspeedTMA: 70,
    maxClimbRate: 10,
    maxDescentRate: 7,
    accelerationRateAir: 1.8,
    decelerationRateAir: 2.5,
    turnRateAir: 1.5,
    specialRules: {
      wakeTurbulenceGenerator: true,
      wakeTurbulenceRequiredCategory: 'heavy',
      priorityAirspaceAccess: false,
      militaryManeuvering: false,
    },
  },
  A388: {
    icaoCode: 'A388',
    modelName: 'Airbus A380-800',
    weightClass: 'H',
    wingspanMeters: 79.8,
    lengthMeters: 72.7,
    safetyRadiusMeters: 60,
    maxTaxiSpeed: 15,
    takeoffRotationSpeed: 90,
    approachSpeed: 85,
    maxAirspeedTMA: 160,
    minAirspeedTMA: 75,
    maxClimbRate: 10,
    maxDescentRate: 7,
    accelerationRateAir: 1.5,
    decelerationRateAir: 2.2,
    turnRateAir: 1.2,
    specialRules: {
      wakeTurbulenceGenerator: true,
      wakeTurbulenceRequiredCategory: 'super',
      priorityAirspaceAccess: false,
      militaryManeuvering: false,
    },
  },
};

export function getPerformance(icaoType: string): AircraftPerformance {
  return PERFORMANCE_DB[icaoType] || PERFORMANCE_DB['B738'];
}

// ============================================================
//  Airline Colors
// ============================================================

const AIRLINE_COLORS: Record<string, string> = {
  AAL: '#ef4444',
  UAL: '#3b82f6',
  DAL: '#eab308',
  BAW: '#a855f7',
  UAE: '#22c55e',
  JBU: '#06b6d4',
  QTR: '#ec4899',
  AIC: '#6366f1',
  DLH: '#f97316',
  SWA: '#f43f5e',
  ETH: '#8b5cf6',
  JAI: '#f59e0b',
  N:   '#94a3b8',
};

export function getAirlineColor(code: string): string {
  return AIRLINE_COLORS[code] || AIRLINE_COLORS['N'];
}

// ============================================================
//  Spawn Helpers
// ============================================================

let _idCounter = 0;
function makeId(): string {
  return `ac-${Date.now()}-${++_idCounter}`;
}

export interface SpawnOptions {
  callsign: string;
  aircraftType: string;
  airlineCode: string;
  position: GeoPosition;
  heading: number;
  assignedGate?: string;
  assignedSpot?: string;
  assignedRunway?: string;
  runwayOperation?: 'departure' | 'arrival';
  flightPlan?: FlightPlan;
  color?: string;
}

export function spawnAircraft(opts: SpawnOptions): SimAircraft {
  const perf = getPerformance(opts.aircraftType);
  const now = Date.now();
  return {
    id: makeId(),
    callsign: opts.callsign,
    airlineCode: opts.airlineCode,
    aircraftType: opts.aircraftType,
    position: opts.position,
    heading: opts.heading,
    speed: 0,
    targetHeading: opts.heading,
    targetSpeed: 0,
    altitude: 0,
    targetAltitude: 0,
    verticalSpeed: 0,
    state: 'PARKED',
    route: null,
    routeProgress: { segmentIndex: 0, completed: false, holdingAt: null, distanceInSegment: 0, routeDistanceTravelled: 0 },
    assignedGate: opts.assignedGate || null,
    assignedSpot: opts.assignedSpot || null,
    assignedRunway: opts.assignedRunway || null,
    runwayOperation: opts.runwayOperation || null,
    flightPlan: opts.flightPlan || null,
    performance: perf,
    clearances: { pushback: false, taxi: false, holdShort: null, lineUp: false, takeoff: false, crossRunway: null },
    createdAt: now,
    stateChangedAt: now,
    color: opts.color || getAirlineColor(opts.airlineCode),
    labelVisible: true,
    trail: [],
    rolloutDistance: 0,
    handedOff: false,
  };
}

// ============================================================
//  State Machine Helpers
// ============================================================

export function canTransition(ac: SimAircraft, newState: GroundState): boolean {
  const valid: Record<GroundState, GroundState[]> = {
    PARKED:            ['PUSHBACK_OUT', 'ARRIVING_RUNWAY'],
    PUSHBACK_OUT:      ['PUSHBACK_COMPLETE', 'PARKED'],
    PUSHBACK_COMPLETE: ['TAXIING'],
    TAXIING:           ['HOLDING', 'RUNWAY_ENTRY', 'ARRIVED_GATE', 'PARKED', 'TAXIING_TO_GATE'],
    TAXIING_TO_GATE:   ['HOLDING', 'ARRIVED_GATE', 'TAXIING'],
    HOLDING:           ['TAXIING', 'TAXIING_TO_GATE', 'LINE_UP', 'RUNWAY_ENTRY'],
    RUNWAY_ENTRY:      ['LINE_UP', 'HOLDING'],
    LINE_UP:           ['TAKEOFF_ROLL', 'HOLDING'],
    TAKEOFF_ROLL:      ['ROTATE', 'HANDED_OFF'],
    ROTATE:            ['AIRBORNE_CLIMB'],
    AIRBORNE_CLIMB:    ['HANDED_OFF'],
    HANDED_OFF:        [],
    DEPARTING:         [],
    ARRIVING_RUNWAY:   ['LANDED', 'TAXIING_TO_GATE'],
    LANDED:            ['TAXIING_TO_GATE', 'ARRIVED_GATE'],
    ARRIVED_GATE:      ['PARKED'],
  };
  return valid[ac.state]?.includes(newState) ?? false;
}

export function transitionState(ac: SimAircraft, newState: GroundState): SimAircraft {
  if (!canTransition(ac, newState)) return ac;
  return { ...ac, state: newState, stateChangedAt: Date.now() };
}

// ============================================================
//  Clearance Helpers
// ============================================================

export function grantClearance(ac: SimAircraft, type: keyof ClearanceSet, value?: any): SimAircraft {
  const updated = { ...ac, clearances: { ...ac.clearances } };
  if (type === 'holdShort' || type === 'crossRunway') {
    (updated.clearances as any)[type] = value ?? null;
  } else {
    (updated.clearances as any)[type] = true;
  }
  return updated;
}

export function revokeClearance(ac: SimAircraft, type: keyof ClearanceSet): SimAircraft {
  const updated = { ...ac, clearances: { ...ac.clearances } };
  if (type === 'holdShort' || type === 'crossRunway') {
    (updated.clearances as any)[type] = null;
  } else {
    (updated.clearances as any)[type] = false;
  }
  return updated;
}

// ============================================================
//  Trail Management
// ============================================================

export function updateTrail(trail: GeoPosition[], pos: GeoPosition, maxLength = 20): GeoPosition[] {
  const updated = [...trail, pos];
  if (updated.length > maxLength) updated.shift();
  return updated;
}

// ============================================================
//  Command helpers — issue controller instructions to an aircraft
//  (used by both the manual control buttons and the future text console)
// ============================================================

export function emptyRouteProgress(): RouteProgress {
  return { segmentIndex: 0, completed: false, holdingAt: null, distanceInSegment: 0, routeDistanceTravelled: 0 };
}

export function assignRoute(ac: SimAircraft, route: TaxiRoute, state?: GroundState): SimAircraft {
  return {
    ...ac,
    route,
    routeProgress: emptyRouteProgress(),
    targetSpeed: 0,
    state: state ?? ac.state,
    stateChangedAt: state && state !== ac.state ? Date.now() : ac.stateChangedAt,
  };
}

export function clearRoute(ac: SimAircraft): SimAircraft {
  return { ...ac, route: null, routeProgress: emptyRouteProgress() };
}

// "AAL123, pushback approved"
export function commandPushback(ac: SimAircraft): SimAircraft {
  if (ac.state !== 'PARKED') return ac;
  const cleared = grantClearance(ac, 'pushback');
  return transitionState(cleared, 'PUSHBACK_OUT');
}

// "AAL123, taxi to runway 25L via A, B"
export function commandTaxiTo(ac: SimAircraft, route: TaxiRoute, runway?: string): SimAircraft {
  let next = assignRoute(ac, route, 'TAXIING');
  next = grantClearance(next, 'taxi');
  if (runway) {
    next = { ...next, assignedRunway: runway, runwayOperation: next.runwayOperation || 'departure' };
  }
  return next;
}

// "AAL123, hold short of runway 25L"
export function commandHoldShort(ac: SimAircraft, holdId: string): SimAircraft {
  // We don't actually change route; physics will detect arrival at hold node.
  // Just ensure we are in a taxiing-like state.
  return { ...ac, clearances: { ...ac.clearances, holdShort: holdId } };
}

// "AAL123, line up and wait"
export function commandLineUp(ac: SimAircraft): SimAircraft {
  if (ac.state !== 'HOLDING' && ac.state !== 'RUNWAY_ENTRY') return ac;
  const cleared = grantClearance(ac, 'lineUp');
  return transitionState(cleared, 'LINE_UP');
}

// "AAL123, cleared for takeoff runway 25L"
export function commandTakeoff(ac: SimAircraft, runway: string): SimAircraft {
  if (ac.state !== 'LINE_UP' && ac.state !== 'RUNWAY_ENTRY') return ac;
  const cleared = grantClearance(ac, 'takeoff');
  const withRw = { ...cleared, assignedRunway: runway, runwayOperation: 'departure' as const };
  return transitionState(withRw, 'TAKEOFF_ROLL');
}

// "AAL123, continue taxi / taxi to gate 42"
export function commandTaxiToGate(ac: SimAircraft, route: TaxiRoute, gateName: string): SimAircraft {
  const next = assignRoute(ac, route, 'TAXIING_TO_GATE');
  return grantClearance({ ...next, assignedGate: gateName, clearances: { ...next.clearances, holdShort: null } }, 'taxi');
}

// "AAL123, contact departure" — hand off (removes from GMS via scheduler)
export function commandHandoff(ac: SimAircraft): SimAircraft {
  return { ...ac, handedOff: true, state: 'HANDED_OFF', stateChangedAt: Date.now() };
}

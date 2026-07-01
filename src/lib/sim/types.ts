// ============================================================
//  Shared simulation types
// ============================================================
import { XY } from './projection';
import { AircraftPerformance } from './aircraftDB';

export type FlightPhase =
  | 'parked' | 'pushback' | 'taxi' | 'hold_short' | 'lineup'
  | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'approach'
  | 'landing' | 'rollout' | 'arrived' | 'departed';

export type FlightKind = 'departure' | 'arrival';
export type NavMode = 'heading' | 'direct' | 'ils' | 'loc' | 'hold' | 'sid';

export interface FlightPlan {
  kind: FlightKind;
  gateRef?: string;
  runway?: string;
  fix?: string;
  cruiseAlt?: number;
  taxiRoute?: string[];
}

export interface TaxiWaypoint extends XY {
  nodeId: string;
  holdShort?: boolean;
}

export interface DrivePath {
  pts: XY[];
  cum: number[];
  total: number;
  holdAt?: number;
  kind: 'taxi' | 'runway' | 'approach';
}

// A player command queued with a pilot-delay before it takes effect.
export interface PendingCmd {
  kind: 'heading' | 'altitude' | 'speed';
  value: number;
  applyAt: number; // sim time (seconds) when the aircraft executes this
}

export interface AircraftState {
  id: number;
  callsign: string;
  flightNo: string;
  airline: string;
  perf: AircraftPerformance;

  phase: FlightPhase;
  plan: FlightPlan;

  // kinematics — positions in local metres, altitude in ft, speed in knots
  pos: XY;
  heading: number;    // compass degrees, 0=N
  speed: number;      // kt
  altitude: number;   // ft AGL

  // autopilot targets that physics integrates toward
  targetHeading: number;
  targetSpeed: number;
  targetAltitude: number; // ft

  // ground navigation (arc-length path following)
  path: DrivePath | null;
  distAlong: number;
  holdReleased: boolean;
  trafficHold: boolean;
  thresholdDist: number; // arc-length (m) along path where threshold is (landing)
  takeoffCleared: boolean;

  // airborne nav mode
  navMode: NavMode;
  ilsArmed: boolean;     // player cleared for ILS/LOC approach
  ilsCaptured: boolean;  // localizer captured (lateral tracking active)
  gsCaptured: boolean;   // glideslope captured (vertical tracking active)
  assignedRunway: string | null; // ILS target runway name e.g. "27L"
  directTargetXY: XY | null;    // world position for DCT
  directTargetName: string | null;
  turnDir: 'L' | 'R' | null;    // forced turn direction for heading commands

  // hold pattern state
  holdFix: XY | null;
  holdFixName: string | null;
  holdInboundHdg: number;        // heading aircraft flies TOWARD the fix
  holdTurnDir: 'L' | 'R';       // standard = R
  holdPhase: 'to_fix' | 'outbound_turn' | 'outbound' | 'inbound_turn' | 'inbound';
  holdTimer: number;             // seconds elapsed in the outbound leg

  // player-commanded values (displayed in data tag even before pilot delay executes)
  cmdAltitude: number | null;
  cmdIas: number | null;
  expedite: boolean;

  // pilot delay queue — commands awaiting execution
  pendingCmds: PendingCmd[];

  // attention / control flags
  underControl: boolean; // player has ever selected this aircraft
  attention: boolean;    // flashing blue ring until player selects it

  // legacy node route (UI route preview)
  route: TaxiWaypoint[];
  routeIndex: number;
  holdingShort: boolean;

  trail: XY[];
  selected?: boolean;
  conflict?: boolean;
  spawnedAt: number;
}

export type SimEventType =
  | 'spawn' | 'phase' | 'reached_hold' | 'airborne' | 'touchdown'
  | 'arrived' | 'departed' | 'ground_conflict' | 'separation_loss'
  | 'go_around' | 'diversion' | 'info';

export interface SimEvent {
  type: SimEventType;
  id: number;
  callsign: string;
  message: string;
  at: number;
}

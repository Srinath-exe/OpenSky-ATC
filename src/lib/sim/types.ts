// ============================================================
//  Shared simulation types — WAVE 0 CONTRACT
//
//  Every module under src/lib/sim, the store bridge and the game UI code
//  against the types in this file. Rules:
//    - Everything here is JSON-serialisable (no Map/Set/class instances) so the
//      test API can hand it to Playwright unchanged.
//    - Prefer REQUIRED fields with defaults over optional sprawl. New
//      AircraftState fields are created by `newAircraftFields()` which
//      `SimEngine.base()` spreads in; adding a field means adding it there.
//    - The UI never gates on `phase`; it gates on `Stage` (see stage.ts).
//  Ownership: W0 (this file). Later waves extend via PR to the contract owner.
// ============================================================
import type { XY } from './projection';
import type { AircraftPerformance, WeightClass } from './aircraftDB';
import type { CommandAST, CommandResult } from './commandAst';
import type { ActionId } from './commandTree';

// ──────────────────────────────────────────────────────────────────────────────
//  Physics phases (engine-internal). `startup` and `go_around` are new.
// ──────────────────────────────────────────────────────────────────────────────
export type FlightPhase =
  | 'parked' | 'startup' | 'pushback' | 'taxi' | 'hold_short' | 'lineup'
  | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'approach' | 'go_around'
  | 'landing' | 'rollout' | 'arrived' | 'departed';

export type FlightKind = 'departure' | 'arrival';
export type NavMode = 'heading' | 'direct' | 'ils' | 'loc' | 'hold' | 'sid' | 'visual';

// ──────────────────────────────────────────────────────────────────────────────
//  UI-facing derived stage (UX 04 §G1). Derived by stage() in stage.ts; never
//  stored on the aircraft. Column names of the §G2 action matrix.
// ──────────────────────────────────────────────────────────────────────────────
export type Stage =
  // ground (== phase or a refinement of it)
  | 'parked' | 'startup' | 'pushback' | 'taxi_out' | 'taxi_in' | 'hold_short_dep' | 'hold_short_cross'
  | 'lineup' | 'takeoff_roll' | 'takeoff_air' | 'rollout' | 'arrived'
  // airborne
  | 'dep_climb' | 'dep_level' | 'go_around'
  | 'arr_inbound' | 'arr_armed' | 'arr_established' | 'arr_final' | 'arr_short_final'
  | 'departed';

export const ALL_STAGES: readonly Stage[] = [
  'parked', 'startup', 'pushback', 'taxi_out', 'taxi_in', 'hold_short_dep', 'hold_short_cross',
  'lineup', 'takeoff_roll', 'takeoff_air', 'rollout', 'arrived',
  'dep_climb', 'dep_level', 'go_around',
  'arr_inbound', 'arr_armed', 'arr_established', 'arr_final', 'arr_short_final',
  'departed',
];

// ──────────────────────────────────────────────────────────────────────────────
//  ATC positions / frequencies (UX 04 §G5.8). The player holds `PlayerPosition`s;
//  `departure` is worked from the APPROACH tab, `external` = centre/next unit.
// ──────────────────────────────────────────────────────────────────────────────
export type Position = 'ground' | 'tower' | 'departure' | 'approach' | 'external';
export type PlayerPosition = 'ground' | 'tower' | 'approach';
/** Which player tab owns a frequency position (null = nobody, i.e. handed off out of the game). */
export const POSITION_OWNER: Record<Position, PlayerPosition | null> = {
  ground: 'ground', tower: 'tower', departure: 'approach', approach: 'approach', external: null,
};
/** Next logical position for a handoff (UX §G4 picker-position). */
export const NEXT_POSITION: Record<FlightKind, Partial<Record<Position, Position>>> = {
  departure: { ground: 'tower', tower: 'departure', departure: 'external', approach: 'external' },
  arrival: { external: 'approach', approach: 'tower', tower: 'ground', departure: 'tower' },
};

// ──────────────────────────────────────────────────────────────────────────────
//  Wake turbulence (ICAO Doc 4444 categories). `WeightClass` 'S' displays as "J".
// ──────────────────────────────────────────────────────────────────────────────
export type WakeCategory = 'LIGHT' | 'MEDIUM' | 'HEAVY' | 'SUPER';
export const WAKE_CATEGORY_BY_CLASS: Record<WeightClass, WakeCategory> = {
  L: 'LIGHT', M: 'MEDIUM', H: 'HEAVY', S: 'SUPER',
};
/** Departure wake timer, seconds, full-length departures (03 §2.7, ICAO). 0 = no timer. */
export const WAKE_DEPARTURE_S: Record<WakeCategory, Record<WakeCategory, number>> = {
  SUPER:  { SUPER: 0, HEAVY: 120, MEDIUM: 180, LIGHT: 180 },
  HEAVY:  { SUPER: 0, HEAVY: 0,   MEDIUM: 120, LIGHT: 120 },
  MEDIUM: { SUPER: 0, HEAVY: 0,   MEDIUM: 0,   LIGHT: 120 },
  LIGHT:  { SUPER: 0, HEAVY: 0,   MEDIUM: 0,   LIGHT: 0 },
};
/** Distance-based wake minima on final, NM (03 §3.9, ICAO). 3 = radar minimum. */
export const WAKE_FINAL_NM: Record<WakeCategory, Record<WakeCategory, number>> = {
  SUPER:  { SUPER: 3, HEAVY: 5, MEDIUM: 7, LIGHT: 8 },
  HEAVY:  { SUPER: 3, HEAVY: 4, MEDIUM: 5, LIGHT: 6 },
  MEDIUM: { SUPER: 3, HEAVY: 3, MEDIUM: 3, LIGHT: 5 },
  LIGHT:  { SUPER: 3, HEAVY: 3, MEDIUM: 3, LIGHT: 3 },
};

// ──────────────────────────────────────────────────────────────────────────────
//  Flight plan, paths (unchanged shapes; `sid` / `star` added)
// ──────────────────────────────────────────────────────────────────────────────
export interface FlightPlan {
  kind: FlightKind;
  gateRef?: string;
  runway?: string;
  fix?: string;
  cruiseAlt?: number;
  taxiRoute?: string[];
  /** SID / STAR name once procedures exist (Phase 2). */
  sid?: string;
  star?: string;
  /** Destination / origin ICAO or city code for strips. */
  dest?: string;
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
  kind: 'taxi' | 'runway' | 'approach' | 'pushback';
  /** Node ids of hold-short places along this path (crossing runways), with arc-length. */
  holds?: PathHold[];
}
export interface PathHold {
  nodeId: string;
  /** Runway end name this hold protects (either end name of the physical runway). */
  runway: string;
  /** Arc-length (m) of the hold line on the path. */
  at: number;
  /** True when this is the departure runway entry (not a crossing). */
  isDepartureEntry: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Pending (pilot-delayed / conditional) commands
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Condition that must hold before a queued command executes (UX 04 §1.5, §G5.1).
 * `applyAt` is still honoured (pilot delay) — the command executes at
 * max(applyAt, first tick where the condition is true).
 */
export type PendingCondition =
  | { type: 'after_pushback' }                                   // "when ready taxi..."
  | { type: 'on_reaching_hold' }                                 // takeoff clearance issued while taxiing
  | { type: 'at_or_below_alt'; ft: number }                      // "descend 3000 THEN cleared ILS"
  | { type: 'at_or_above_alt'; ft: number }                      // "on reaching 400 ft turn / contact departure"
  | { type: 'after_fix'; fix: string }                           // "after BIG turn heading"
  | { type: 'behind_aircraft'; id: number; callsign: string }    // conditional line-up / crossing
  | { type: 'after_vacated' }                                    // "when vacated contact ground"
  | { type: 'when_ready' };                                      // pilot's discretion

/** Every AST verb can be queued; the legacy numeric kinds keep their `value` payload. */
export type PendingCmdKind = 'heading' | 'altitude' | 'speed' | CommandAST['kind'];

/**
 * A player command queued with a pilot delay before it takes effect.
 * `value` is the numeric payload for heading/altitude/speed (kept for the
 * existing physics drain in aircraft.ts); for every other kind `value` is 0 and
 * `ast` carries the full command. Latest-wins per kind for heading/altitude/
 * speed; FIFO for all other kinds (UX §G5.1). Extra fields are optional ONLY so
 * the existing `enqueuePilotCmd({kind,value})` keeps compiling — new code must
 * always fill `ast`, `issuedAt` and `cancellable`.
 */
export interface PendingCmd {
  kind: PendingCmdKind;
  value: number;
  applyAt: number; // sim time (seconds) when the aircraft executes this
  condition?: PendingCondition;
  ast?: CommandAST;
  issuedAt?: number;
  /** false for standby/report/say-again/wind-check (no undo ring, UX §G9). */
  cancellable?: boolean;
  /** Speed-until-distance (NM) expiry for "160 to 4 miles" (UX §G4 picker-speed). */
  untilNM?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Pilot requests (UX 04 §G8)
// ──────────────────────────────────────────────────────────────────────────────
export type PilotRequestKind =
  | 'clearance' | 'pushback' | 'startup' | 'taxi' | 'cross' | 'ready' | 'with_you'
  | 'higher' | 'lower' | 'direct' | 'hold' | 'taxi_in' | 'say_again' | 'radio_check'
  | 'cancel_mayday' | 'return_to_stand' | 'wind_check' | 'confirm_cleared' | 'further'
  | 'intersection' | 'runway_vacated' | 'going_around';

export interface PilotRequest {
  id: number;
  kind: PilotRequestKind;
  callsign: string;
  /** Spoken pilot line, e.g. "Ground, Speedbird 117, stand 512, request pushback." */
  text: string;
  /** Kind-specific parameter: runway for `cross`, fix for `direct`, ft for `higher`/`lower`. */
  param: string | number | null;
  at: number;
  /** Next re-call time (45/90/120 s per catalogue); recalls counted for responsiveness. */
  recallAt: number;
  recalls: number;
  /** Auto-clear time (e.g. with_you clears after 60 s) or null = until answered. */
  expiresAt: number | null;
  /** Highlighted answer in the command panel (null = informational only). */
  suggestedAction: ActionId | null;
  answeredAt: number | null;
  answeredBy: 'player' | 'ai' | 'timeout' | null;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Emergencies (03 §4 + §F; UX 04 §1.4 substates)
// ──────────────────────────────────────────────────────────────────────────────
export type EmergencyType =
  | 'engine_fire' | 'engine_failure' | 'medical' | 'fuel' | 'depressurization' | 'bird_strike'
  | 'gear' | 'smoke' | 'hydraulic' | 'hijack' | 'radio_failure' | 'general'
  | 'brake_fire';
export type EmergencyLevel = 'MAYDAY' | 'PAN';
export type EmergencyStatus = 'declared' | 'acknowledged' | 'services_dispatched' | 'landed' | 'stopped' | 'resolved';
export type ArffLevel = 'none' | 'local' | 'full';
export type EmergencyChecklistItem =
  | 'acknowledge' | 'souls_fuel' | 'priority_runway' | 'arff' | 'ambulance'
  | 'hold_traffic' | 'runway_closed' | 'runway_reopened' | 'inspection';

export interface Emergency {
  type: EmergencyType;
  level: EmergencyLevel;
  status: EmergencyStatus;
  declaredAt: number;
  /** Phase / stage at declaration (for scoring and pilot-line selection). */
  phase: FlightPhase;
  stage: Stage;
  soulsOnBoard: number;
  /** Fuel remaining in sim minutes; counts down; null = not fuel-related. */
  fuelMin: number | null;
  squawk: string | null;
  /** Pilot's stated requests/intentions in order ("request immediate return", "request hold 20 min"). */
  requests: string[];
  /** Priority runway assigned by the controller (null until `priority` command). */
  runway: string | null;
  priority: boolean;
  sterile: boolean;
  arff: ArffLevel;
  arffOnSceneAt: number | null;
  stopOnRunway: boolean;
  evacuation: boolean;
  /** Runway closure duration after the aircraft stops (minutes, 0 = vacates). */
  closureMin: number;
  landedAt: number | null;
  stoppedAt: number | null;
  resolvedAt: number | null;
  /** Sim time each checklist item was completed (null = not yet). */
  checklist: Record<EmergencyChecklistItem, number | null>;
  /** The opening MAYDAY/PAN transmission. */
  pilotLine: string;
}

export function emptyChecklist(): Record<EmergencyChecklistItem, number | null> {
  return {
    acknowledge: null, souls_fuel: null, priority_runway: null, arff: null, ambulance: null,
    hold_traffic: null, runway_closed: null, runway_reopened: null, inspection: null,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Departure clearance, startup, pushback, readback, delay sub-records
// ──────────────────────────────────────────────────────────────────────────────
export interface Clearance {
  /** IFR clearance issued (delivery). Default true — delivery is auto in v1. */
  ifr: boolean;
  /** Initial climb altitude (ft). Default 4000 (UX §G4), overridden by takeoff clearance. */
  initialAlt: number;
  squawk: string | null;
  sid: string | null;
  /** After-departure heading (true, degrees) or null = runway heading / SID. */
  depHdg: number | null;
  /** Altitude (ft AGL) at which the departure auto-hands off to departure/approach. */
  autoHandoffAlt: number;
  immediate: boolean;
}
export function defaultClearance(): Clearance {
  return { ifr: true, initialAlt: 4000, squawk: null, sid: null, depHdg: null, autoHandoffAlt: 1000, immediate: false };
}

export interface StartupState {
  /** Sim time engines started; null = not started. */
  startedAt: number | null;
  /** Sim time engines are stable (startup duration per type, 03 §1.2). */
  readyAt: number | null;
  enginesStable: boolean;
  /** Hot-start failure adds 300 s (4 %). */
  failed: boolean;
}
export function defaultStartup(): StartupState {
  return { startedAt: null, readyAt: null, enginesStable: false, failed: false };
}

export type PushbackDir = 'N' | 'E' | 'S' | 'W' | 'any';
export type PushbackStage = 'none' | 'tug_enroute' | 'tug_attach' | 'pushing' | 'paused' | 'tug_disconnect' | 'complete';
export interface PushbackState {
  stage: PushbackStage;
  /** Sim time the current stage ends (attach 20-40 s, push 40-90 s, disconnect 20-30 s). */
  stageUntil: number;
  facing: PushbackDir;
  tugId: string | null;
  /** Path length pushed so far / total (metres). */
  pushedM: number;
  totalM: number;
  /** Runway the pilot was told to expect at approval time. */
  expectRunway: string | null;
}
export function defaultPushback(): PushbackState {
  return { stage: 'none', stageUntil: 0, facing: 'any', tugId: null, pushedM: 0, totalM: 0, expectRunway: null };
}

export type ReadbackStatus = 'none' | 'pending' | 'ok' | 'partial' | 'unable' | 'mismatch' | 'say_again';
export interface ReadbackState {
  status: ReadbackStatus;
  /** Last readback text (pilot line). */
  text: string;
  /** Sim time the readback is due / was spoken. */
  dueAt: number;
  at: number;
  /** Set when the pilot read back a wrong value (UX §1.7 correction flow). */
  mismatch: { field: string; expected: string; read: string; deadline: number } | null;
  /** Parts refused with "unable ..." (describe() strings). */
  refused: string[];
  /** AST of the last transmission to this aircraft (drives REPEAT / correction prefill). */
  lastAst: CommandAST | null;
}
export function defaultReadback(): ReadbackState {
  return { status: 'none', text: '', dueAt: 0, at: 0, mismatch: null, refused: [], lastAst: null };
}

export interface DelayStats {
  firstRequestAt: number | null;
  pushbackAt: number | null;
  taxiStartAt: number | null;
  holdShortAt: number | null;
  airborneAt: number | null;
  touchdownAt: number | null;
  vacatedAt: number | null;
  parkedAt: number | null;
  handoffAt: number | null;
  /** Accumulated sim seconds waiting for an answer to a pilot request. */
  requestWaitS: number;
  /** Accumulated sim seconds stopped at a runway hold point. */
  holdShortWaitS: number;
  /** Accumulated sim seconds in a holding pattern. */
  holdingS: number;
  /** Accumulated sim seconds stopped on the ground for traffic (not hold points). */
  groundStoppedS: number;
  /** Sim seconds airborne inside the TMA. */
  airborneS: number;
  /** delay = actual − unimpeded (03 §G11); maintained by the engine. */
  totalDelayS: number;
  /** Sim seconds a request went unanswered past its recall time (responsiveness score). */
  unansweredS: number;
}
export function defaultDelayStats(): DelayStats {
  return {
    firstRequestAt: null, pushbackAt: null, taxiStartAt: null, holdShortAt: null, airborneAt: null,
    touchdownAt: null, vacatedAt: null, parkedAt: null, handoffAt: null,
    requestWaitS: 0, holdShortWaitS: 0, holdingS: 0, groundStoppedS: 0, airborneS: 0, totalDelayS: 0, unansweredS: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Aircraft state
// ──────────────────────────────────────────────────────────────────────────────
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
  heading: number;    // compass degrees TRUE, 0=N (display converts to magnetic)
  speed: number;      // kt (ground speed on the ground, IAS-ish in the air)
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

  // ── NEW (Wave 0). All initialised by newAircraftFields(). ──────────────────

  /** Attitude for the picture (deg): pitch nose-up positive, bank right positive (aircraft.ts settles both). */
  pitch: number;
  bank: number;
  /** ICAO wake category derived from perf.weightClass at spawn. */
  wakeCategory: WakeCategory;
  /** Pilot requests; at most ONE open request at a time (a new one replaces the old, UX §G8). */
  requests: PilotRequest[];
  /** Emergency substate overlaying any phase; null = normal. */
  emergency: Emergency | null;
  /** Departure clearance fields (UX §G5.11). */
  clearance: Clearance;
  /** Stand reserved for / occupied by this aircraft (arrivals reserve at spawn). */
  reservedStand: string | null;
  /** Whether the stand requires a tug (UX §G5.3). */
  needsPushback: boolean;
  startup: StartupState;
  pushback: PushbackState;
  /** Hold-short PLACE: graph node at the runway hold line the aircraft is stopping at / stopped at. */
  holdShortNode: string | null;
  /** Runway end name protected by `holdShortNode` (either end of the physical runway). */
  holdShortRunway: string | null;
  /** Taxiway/node hold requested by "hold short of taxiway D" (non-runway hold). */
  holdShortTaxiway: string | null;
  /** Landing clearance received for `plan.runway` (mandatory before 1 NM / 300 ft). */
  landingCleared: boolean;
  landingClearedAt: number | null;
  /** LAHSO: runway/taxiway to hold short of after landing. */
  lahsoHoldShortOf: string | null;
  /** Requested runway exit: taxiway name, or 'L'/'R' for next available. */
  exitTaxiway: string | null;
  exitDir: 'L' | 'R' | null;
  /** Set by initiateGoAround; cleared on handoff / new approach clearance. */
  goAround: boolean;
  goAroundCount: number;
  /** Frequency model: position the aircraft is currently talking to. */
  onFrequency: Position;
  /** Position a handoff was issued to (pending "with you" call), null = none. */
  handedTo: Position | null;
  handoffAt: number | null;
  /** Sim time of the last PILOT transmission for this callsign (strip timer). -1 = never. */
  lastTransmissionAt: number;
  /** Sim time of the last ATC transmission to this callsign. -1 = never. */
  lastAtcTransmissionAt: number;
  readback: ReadbackState;
  delay: DelayStats;
  /** Transponder code ('7700' etc.); ident flashes label until identUntil. */
  squawk: string | null;
  identUntil: number;
  /** Give-way / follow (03 §1.7): id of the aircraft or vehicle to yield to / follow. */
  giveWayTo: number | null;
  followId: number | null;
  followVehicleId: string | null;
  /** Expedite taxi/crossing/vacating until this sim time (0 = off). */
  expediteTaxiUntil: number;
  /** REQ chip suppressed until this sim time after STANDBY (60-120 s). */
  standbyUntil: number;
  /** Holding-pattern extras (UX §G4 picker-hold). */
  holdLegMin: number;
  holdLegNM: number | null;
  /** Expect-further-clearance time (sim seconds) or null. */
  holdEfc: number | null;
  /** Speed restriction expires at this distance to threshold (NM), null = none. */
  speedUntilNM: number | null;
  /** Landing sequence number set by APPROACH strip reordering (advisory). */
  sequenceNo: number | null;
  /** Priority flag (emergency / controller `priority` command). */
  priority: boolean;
  /** Held by an emergency "hold all traffic" order (HELD chip, R24 reasons). */
  heldByEmergency: boolean;
  /** Rejected takeoff record (03 §2.4 / §A8). */
  rto: { at: number; speedKt: number } | null;
  /** Fuel remaining in sim minutes (arrivals 45-120 at spawn; null = not tracked). */
  fuelMin: number | null;
  /** Free-text strip annotation (UX §3.1, max 24 chars). */
  note: string;
  /** True when spawned by the AI/auto-spawner vs a test/sandbox spawn. */
  synthetic: boolean;
}

/**
 * Defaults for every Wave-0 AircraftState field. `SimEngine.base()` spreads this
 * so a new field only ever has to be added HERE (and in AircraftState).
 */
export function newAircraftFields(weightClass: WeightClass, time: number): Pick<AircraftState,
  | 'pitch' | 'bank' | 'wakeCategory' | 'requests' | 'emergency' | 'clearance' | 'reservedStand' | 'needsPushback'
  | 'startup' | 'pushback' | 'holdShortNode' | 'holdShortRunway' | 'holdShortTaxiway'
  | 'landingCleared' | 'landingClearedAt' | 'lahsoHoldShortOf' | 'exitTaxiway' | 'exitDir'
  | 'goAround' | 'goAroundCount' | 'onFrequency' | 'handedTo' | 'handoffAt'
  | 'lastTransmissionAt' | 'lastAtcTransmissionAt' | 'readback' | 'delay' | 'squawk' | 'identUntil'
  | 'giveWayTo' | 'followId' | 'followVehicleId' | 'expediteTaxiUntil' | 'standbyUntil'
  | 'holdLegMin' | 'holdLegNM' | 'holdEfc' | 'speedUntilNM' | 'sequenceNo' | 'priority'
  | 'heldByEmergency' | 'rto' | 'fuelMin' | 'note' | 'synthetic'> {
  void time;
  return {
    pitch: 0, bank: 0,
    wakeCategory: WAKE_CATEGORY_BY_CLASS[weightClass],
    requests: [],
    emergency: null,
    clearance: defaultClearance(),
    reservedStand: null,
    needsPushback: true,
    startup: defaultStartup(),
    pushback: defaultPushback(),
    holdShortNode: null,
    holdShortRunway: null,
    holdShortTaxiway: null,
    landingCleared: false,
    landingClearedAt: null,
    lahsoHoldShortOf: null,
    exitTaxiway: null,
    exitDir: null,
    goAround: false,
    goAroundCount: 0,
    onFrequency: 'ground',
    handedTo: null,
    handoffAt: null,
    lastTransmissionAt: -1,
    lastAtcTransmissionAt: -1,
    readback: defaultReadback(),
    delay: defaultDelayStats(),
    squawk: null,
    identUntil: 0,
    giveWayTo: null,
    followId: null,
    followVehicleId: null,
    expediteTaxiUntil: 0,
    standbyUntil: 0,
    holdLegMin: 1,
    holdLegNM: null,
    holdEfc: null,
    speedUntilNM: null,
    sequenceNo: null,
    priority: false,
    heldByEmergency: false,
    rto: null,
    fuelMin: null,
    note: '',
    synthetic: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Ground vehicles (03 §1.13; UX 04 §6)
// ──────────────────────────────────────────────────────────────────────────────
export type VehicleType = 'arff' | 'ambulance' | 'followme' | 'tug' | 'fuel' | 'deice' | 'ops' | 'sweeper' | 'bird';
export type VehicleState = 'standby' | 'enroute' | 'onscene' | 'returning';
export type VehicleTarget =
  | { kind: 'runway'; runway: string }
  | { kind: 'aircraft'; id: number; callsign: string }
  | { kind: 'stand'; ref: string }
  | { kind: 'point'; xy: XY }
  | { kind: 'station' };

export interface Vehicle {
  /** Stable id used in testids: 'FIRE1', 'AMB1', 'FOLLOW1', 'TUG1', 'OPS1', ... */
  id: string;
  /** Radio callsign: 'Fire 1', 'Medic 1', 'Follow-me 1', 'Tug 1', 'Ops 1'. */
  callsign: string;
  type: VehicleType;
  state: VehicleState;
  pos: XY;
  heading: number;   // true degrees
  speed: number;     // kt
  station: XY;
  stationNodeId: string;
  target: VehicleTarget | null;
  path: DrivePath | null;
  distAlong: number;
  /** Runway-crossing hold (same semantics as aircraft). */
  holdShortNode: string | null;
  holdShortRunway: string | null;
  holdReleased: boolean;
  trafficHold: boolean;
  /** Physical runway ref the vehicle is currently on (closes it), null = none. */
  onRunway: string | null;
  dispatchedAt: number | null;
  /** Predicted arrival time at target (sim s); null when not en route. */
  etaAt: number | null;
  arrivedAt: number | null;
  /** On-scene dwell ends at this time and the vehicle returns (null = until recalled). */
  onSceneUntil: number | null;
  maxSpeedKt: { taxiway: number; runway: number; apron: number };
  safetyRadiusM: number;
  trail: XY[];
  selected?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Weather / ATIS (03 §2.12, §5; UX 04 §G5.4)
// ──────────────────────────────────────────────────────────────────────────────
export type Precip = 'none' | 'drizzle' | 'rain' | 'snow' | 'freezing';
export type RunwaySurface = 'dry' | 'wet' | 'contaminated';
export interface WeatherState {
  windDirTrue: number;   // degrees true, 0-359
  windKt: number;
  gustKt: number;        // 0 = no gusts
  variableFrom: number | null;
  variableTo: number | null;
  visM: number;          // metres, 10000 = 10 km+
  ceilingFt: number | null; // null = no ceiling
  cloud: string;         // 'CAVOK' | 'SCT015 BKN025' ...
  qnh: number;           // hPa
  tempC: number;
  dewC: number;
  precip: Precip;
  runwayCondition: RunwaySurface;
  lvp: boolean;
  windshearAlert: { runway: string; type: 'WS' | 'MB'; lossKt: number; until: number } | null;
  updatedAt: number;
}
export interface Atis {
  letter: string;        // 'A'..'Z'
  issuedAt: number;      // sim time
  /** Full ICAO-order broadcast text (03 §2.12). */
  text: string;
  wind: { dir: number; kts: number; gust: number };
  visM: number;
  cloud: string;
  qnh: number;
  tempC: number;
  dewC: number;
  activeDep: string[];
  activeArr: string[];
  transitionLevel: number;
  remarks: string[];
}
export type WeatherEventKind = 'wind_shift' | 'gust_front' | 'fog' | 'snow_shower' | 'thunderstorm' | 'clearing';
export interface WeatherEvent { kind: WeatherEventKind; atMin: number; params: Record<string, number | string>; }

// ──────────────────────────────────────────────────────────────────────────────
//  Alerts (UX 04 §5.1)
// ──────────────────────────────────────────────────────────────────────────────
export type AlertKind =
  | 'stca' | 'msaw' | 'runway_incursion' | 'occupied_runway_clearance' | 'ground_conflict' | 'wake'
  | 'go_around' | 'emergency' | 'diversion_risk' | 'delay' | 'request' | 'handoff' | 'runway_status'
  | 'deadlock';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export interface Alert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** Callsigns and/or vehicle ids involved, primary first. */
  subjects: string[];
  subjectIds: number[];
  title: string;
  /** One-line geometry / detail ("2.6 NM / 600 ft, closing 40 s"). */
  detail: string;
  geometry: { distNM: number | null; vertFt: number | null; cpaS: number | null; cpaNM: number | null; runway: string | null };
  createdAt: number;
  updatedAt: number;
  ack: boolean;
  ackAt: number | null;
  resolvedAt: number | null;
  /** Score delta applied when the alert resolved/scored (0 until then). */
  scoreDelta: number;
  /** True while the condition is predicted (STCA stage 1) rather than actual. */
  predicted: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Runway / gate state (master plan §2.2)
// ──────────────────────────────────────────────────────────────────────────────
export type RunwayStatus = 'open' | 'closed' | 'sterile' | 'inspection';
export type RunwayOccupantKind = 'lineup' | 'takeoff' | 'landing' | 'rollout' | 'crossing' | 'vehicle' | 'stopped' | 'inspection' | 'backtrack';
export interface RunwayOccupant {
  /** Aircraft numeric id or vehicle string id. */
  id: number | string;
  callsign: string;
  kind: RunwayOccupantKind;
  since: number;
}
export interface WakeTimer {
  leader: string;
  leaderCat: WakeCategory;
  startedAt: number;
  expiresAt: number;
  ref: 'airborne' | 'startRoll';
}
/** Per runway END. Both ends of a physical runway share status/occupants (engine keeps them in sync). */
export interface RunwayState {
  name: string;          // '27L'
  ref: string;           // '09R/27L'
  reciprocal: string;    // '09R'
  headingTrue: number;
  headingMag: number;
  lengthM: number;
  status: RunwayStatus;
  statusReason: string;
  statusUntil: number | null;
  surface: RunwaySurface;
  activeDep: boolean;
  activeArr: boolean;
  weightAllow: WeightClass[] | null;
  occupiedBy: RunwayOccupant[];
  wakeTimer: WakeTimer | null;
  /** Callsigns currently holding a landing clearance (ICAO max 1, FAA max 3). */
  landingClearances: string[];
  /** Callsign cleared for takeoff (rolling or "on reaching"), null = none. */
  takeoffClearance: string | null;
  lastDeparture: { callsign: string; at: number; cat: WakeCategory } | null;
  lastArrival: { callsign: string; at: number; cat: WakeCategory } | null;
  /** Graph node ids of hold-short places for this end (entry holds). */
  holdNodes: string[];
  hasIls: boolean;
  ilsEstimated: boolean;
  /** Physical runway refs whose centrelines intersect this one. */
  intersects: string[];
  /** Live wind components (kt); tailwind is negative headwind. */
  windHeadKt: number;
  windCrossKt: number;
}

/** A parked airframe that is not in the traffic (engine.parked): fills a stand until a departure wakes it up. */
export interface ParkedAircraft { id: number; callsign: string; airline: string; type: string; standRef: string; pos: XY; heading: number }

export interface GateState {
  ref: string;
  nodeId: string;
  /** Terminal group (ref prefix letter or 'STANDS'). */
  terminal: string;
  occupiedBy: number | null;
  reservedFor: number | null;
  needsPushback: boolean;
  closed: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Scoring / session stats (03 §G7 points, UX 04 §G11 skill)
// ──────────────────────────────────────────────────────────────────────────────
export type ScoreCode =
  // positives
  | 'MOVEMENT' | 'PARKED' | 'HOLD_POINT' | 'ESTABLISHED' | 'LANDED' | 'DEPARTED_HANDOFF'
  | 'WAKE_EFFICIENT' | 'GOOD_CATCH' | 'SAFETY_GA' | 'STCA_RESOLVED' | 'ARFF_ON_TIME' | 'EMERGENCY_DONE'
  | 'RWY_CHANGE_DONE' | 'LAHSO_SAVE' | 'INSPECTION_CLEAN' | 'BIRDS_ACTIONED' | 'STREAK'
  // negatives
  | 'COLLISION_AIR' | 'COLLISION_GND' | 'RWY_INCURSION' | 'SEPARATION_LOSS' | 'WAKE_DEP' | 'WAKE_FINAL'
  | 'GA_UNHANDLED' | 'MSAW_PERSIST' | 'RESTRICTED_AREA' | 'LUAW_UNSAFE' | 'TAXI_INCOMPLETE' | 'EXIT_INCOMPLETE'
  | 'TAXI_CONFLICT' | 'DEADLOCK' | 'GROUND_CONFLICT' | 'DIVERSION' | 'DIVERSION_UNHANDLED' | 'FUEL_EXHAUSTION'
  | 'UNANSWERED_REQUEST' | 'READBACK_ERROR_MISSED' | 'STERILE_RUNWAY_VIOLATION' | 'EMERGENCY_CHECKLIST_MISS'
  | 'HANDOFF_LATE' | 'DELAY_15' | 'DELAY_30' | 'PERFORMANCE_TAILWIND' | 'CLOSED_RUNWAY_CLEARANCE';

/** Points (03 §G7) and skill deltas (UX §G11 where listed, else 03 §G7). Skill deltas apply to the 0-12 skill scale. */
export const SCORE_TABLE: Record<ScoreCode, { points: number; skill: number; ref: string }> = {
  MOVEMENT: { points: 10, skill: 0.1, ref: 'Tower!SE +10/movement' },
  PARKED: { points: 10, skill: 0, ref: '03 §1.9' },
  HOLD_POINT: { points: 5, skill: 0, ref: '03 §1.4' },
  ESTABLISHED: { points: 10, skill: 0.1, ref: '03 §3.7' },
  LANDED: { points: 10, skill: 0.1, ref: '03 §2.5' },
  DEPARTED_HANDOFF: { points: 10, skill: 0.05, ref: '03 §3.14' },
  WAKE_EFFICIENT: { points: 5, skill: 0, ref: '03 §2.7' },
  GOOD_CATCH: { points: 50, skill: 0, ref: '03 §2.4' },
  SAFETY_GA: { points: 50, skill: 0, ref: '03 §2.6' },
  STCA_RESOLVED: { points: 5, skill: 0, ref: '03 §3.10' },
  ARFF_ON_TIME: { points: 50, skill: 0, ref: '03 §1.13' },
  EMERGENCY_DONE: { points: 300, skill: 0.5, ref: '03 §4' },
  RWY_CHANGE_DONE: { points: 100, skill: 0, ref: '03 §2.10' },
  LAHSO_SAVE: { points: 30, skill: 0, ref: '03 §2.11' },
  INSPECTION_CLEAN: { points: 30, skill: 0, ref: '03 §2.13' },
  BIRDS_ACTIONED: { points: 10, skill: 0, ref: '03 §2.14' },
  STREAK: { points: 500, skill: 0, ref: '03 §6' },
  COLLISION_AIR: { points: -1000, skill: -12, ref: '03 §G10 (session ends)' },
  COLLISION_GND: { points: -500, skill: -1.0, ref: '03 §G7' },
  RWY_INCURSION: { points: -500, skill: -1.0, ref: 'UX §G11 / 7110.65 3-1-3' },
  SEPARATION_LOSS: { points: -500, skill: -0.5, ref: 'Doc 4444 8.7.3' },
  WAKE_DEP: { points: -200, skill: -0.25, ref: 'Doc 4444 5.8.3' },
  WAKE_FINAL: { points: -200, skill: -0.25, ref: 'Doc 4444 8.7.3.4' },
  GA_UNHANDLED: { points: -500, skill: -0.25, ref: '03 §2.6' },
  MSAW_PERSIST: { points: -200, skill: -0.25, ref: '7110.65 5-15' },
  RESTRICTED_AREA: { points: -100, skill: -0.25, ref: '03 §3.11' },
  LUAW_UNSAFE: { points: -100, skill: 0, ref: '7110.65 3-9-4' },
  TAXI_INCOMPLETE: { points: -25, skill: 0, ref: '7110.65 3-7-2' },
  EXIT_INCOMPLETE: { points: -25, skill: 0, ref: '03 §C5' },
  TAXI_CONFLICT: { points: -20, skill: 0, ref: '03 §1.4' },
  DEADLOCK: { points: -50, skill: 0, ref: '03 §C6' },
  GROUND_CONFLICT: { points: -20, skill: -0.2, ref: 'UX §G11' },
  DIVERSION: { points: -500, skill: -0.5, ref: '03 §3.16' },
  DIVERSION_UNHANDLED: { points: -100, skill: 0, ref: '03 §3.16' },
  FUEL_EXHAUSTION: { points: -1000, skill: -2.0, ref: 'UX §G5.12' },
  UNANSWERED_REQUEST: { points: 0, skill: -0.1, ref: 'UX §G8 (per minute)' },
  READBACK_ERROR_MISSED: { points: -50, skill: -0.2, ref: 'UX §G11' },
  STERILE_RUNWAY_VIOLATION: { points: -500, skill: -0.5, ref: 'UX §G11' },
  EMERGENCY_CHECKLIST_MISS: { points: -100, skill: 0, ref: '7110.65 10-2-1' },
  HANDOFF_LATE: { points: -100, skill: 0, ref: '03 §2.15' },
  DELAY_15: { points: -10, skill: 0, ref: '03 §6' },
  DELAY_30: { points: 0, skill: -0.1, ref: '03 §6' },
  PERFORMANCE_TAILWIND: { points: -25, skill: 0, ref: '03 §2.2' },
  CLOSED_RUNWAY_CLEARANCE: { points: -50, skill: 0, ref: '03 §2.13' },
};

export interface ScoreEvent {
  code: ScoreCode;
  at: number;
  primary: string;          // callsign / vehicle id
  secondary: string | null; // other party
  runway: string | null;
  points: number;
  skillDelta: number;
  ref: string;
  detail: string;
}

export interface SessionStats {
  startedAt: number;
  simTime: number;
  score: number;
  skill: number;
  points: number;               // session points ledger sum (03 §6)
  movements: number;
  departures: number;
  arrivals: number;
  /** Rolling 20-minute window, scaled to per hour. */
  movementsPerHour: number;
  /** 5-minute buckets for the movements bar chart: [simTime, dep, arr]. */
  movementsHistory: Array<{ at: number; dep: number; arr: number }>;
  delayAvgS: number;
  delayP95S: number;
  delaySamples: number[];
  incidents: Partial<Record<ScoreCode, number>>;
  ledger: ScoreEvent[];
  goAroundsPlayer: number;
  goAroundsPilot: number;
  diversions: number;
  emergenciesDeclared: number;
  emergenciesResolved: number;
  arffResponseS: number[];
  transmissions: number;
  /** Mean answer time to pilot requests (sim s). */
  responsivenessMeanS: number;
  unansweredRequests: number;
  /** Sim seconds since the last negative incident (streak bonuses). */
  streakS: number;
}
export function emptySessionStats(now = 0): SessionStats {
  return {
    startedAt: now, simTime: now, score: 0, skill: 3, points: 0, movements: 0, departures: 0, arrivals: 0,
    movementsPerHour: 0, movementsHistory: [], delayAvgS: 0, delayP95S: 0, delaySamples: [], incidents: {},
    ledger: [], goAroundsPlayer: 0, goAroundsPilot: 0, diversions: 0, emergenciesDeclared: 0, emergenciesResolved: 0,
    arffResponseS: [], transmissions: 0, responsivenessMeanS: 0, unansweredRequests: 0, streakS: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Events
// ──────────────────────────────────────────────────────────────────────────────
export type SimEventType =
  // existing
  | 'spawn' | 'phase' | 'reached_hold' | 'airborne' | 'touchdown'
  | 'arrived' | 'departed' | 'ground_conflict' | 'separation_loss'
  | 'go_around' | 'diversion' | 'info'
  // new (Wave 0)
  | 'request' | 'readback' | 'emergency' | 'alert' | 'atis' | 'runway_state' | 'vehicle' | 'wake'
  | 'landing_clearance' | 'handoff' | 'score' | 'stage' | 'transmission' | 'startup' | 'pushback'
  | 'runway_vacated' | 'fuel_exhaustion' | 'removed';

export type SimEventData =
  | { type: 'request'; request: PilotRequest; change: 'raised' | 'recalled' | 'answered' | 'expired' }
  | { type: 'readback'; status: ReadbackStatus; text: string; ast: CommandAST | null; refused: string[] }
  | { type: 'emergency'; emergency: Emergency; change: 'declared' | 'acknowledged' | 'services' | 'landed' | 'stopped' | 'resolved' | 'update' }
  | { type: 'alert'; alert: Alert; change: 'raised' | 'updated' | 'acked' | 'resolved' }
  | { type: 'atis'; atis: Atis; reason: string }
  | { type: 'runway_state'; runway: string; status: RunwayStatus; previous: RunwayStatus; reason: string }
  | { type: 'vehicle'; vehicleId: string; state: VehicleState; target: VehicleTarget | null; etaS: number | null }
  | { type: 'wake'; runway: string; leader: string; expiresAt: number }
  | { type: 'landing_clearance'; runway: string; cleared: boolean }
  | { type: 'handoff'; from: Position; to: Position }
  | { type: 'score'; score: ScoreEvent }
  | { type: 'stage'; from: Stage | null; to: Stage }
  | { type: 'transmission'; ast: CommandAST; result: CommandResult; who: 'player' | 'ai' }
  | { type: 'removed'; reason: 'arrived' | 'departed' | 'diversion' | 'fuel_exhaustion' | 'collision' | 'test' };

export interface SimEvent {
  type: SimEventType;
  /** Aircraft id, -1 for system / vehicle events. */
  id: number;
  callsign: string;
  message: string;
  at: number;
  /** Which radio channel the line belongs to (store routes it to the comm log). Default derived by type. */
  who?: 'ATC' | 'PILOT' | 'SYS' | 'AI';
  /** Which position/frequency the line was heard on (comm-log filter). */
  position?: Position;
  data?: SimEventData;
}

/** Default comm-log routing for event types without an explicit `who`. */
export const EVENT_WHO: Record<SimEventType, 'ATC' | 'PILOT' | 'SYS' | 'AI'> = {
  spawn: 'SYS', phase: 'SYS', reached_hold: 'PILOT', airborne: 'PILOT', touchdown: 'PILOT',
  arrived: 'PILOT', departed: 'PILOT', ground_conflict: 'SYS', separation_loss: 'SYS',
  go_around: 'PILOT', diversion: 'SYS', info: 'SYS',
  request: 'PILOT', readback: 'PILOT', emergency: 'PILOT', alert: 'SYS', atis: 'SYS', runway_state: 'SYS',
  vehicle: 'SYS', wake: 'SYS', landing_clearance: 'SYS', handoff: 'PILOT', score: 'SYS', stage: 'SYS',
  transmission: 'ATC', startup: 'SYS', pushback: 'SYS', runway_vacated: 'PILOT', fuel_exhaustion: 'SYS',
  removed: 'SYS',
};

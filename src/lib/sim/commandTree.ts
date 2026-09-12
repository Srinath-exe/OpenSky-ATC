// ============================================================
//  Command tree — UX 04 §G2 action matrix as DATA + pickers + toAst + hotkeys
//  + validation (§G3 guards) + undo model (§G9).
//
//  Ownership: W0 wrote the contract (types, matrix, reasons, steps, toAst,
//  hotkeys). W1-COMMANDS owns this file from Wave 1. Ids and the R1-R24 /
//  X1-X13 reason strings are NEVER renamed (tests assert them verbatim via
//  data-testid / data-reason); new reasons are appended (X14+).
//
//  actionsFor(a, ctx) returns rows in panel order for the aircraft's stage:
//    - rows whose matrix cell is hidden ('-') are NOT returned
//    - 'on' rows come back state 'enabled'
//    - 'off:Rn' rows come back state 'disabled' with the canonical reason text
//    - 'dyn:rule' rows are decided by DYNAMIC_RULES[rule](a, ctx) at call time
//    - a picker with zero candidates disables the row (§G4 empty-state rule)
//  Everything the rules need is passed in ActionCtx (built by the store from
//  the engine) so this module has no engine import and is unit-testable. The
//  optional ActionCtx members (runways, fixes, ...) enrich pickers/validation
//  when the store provides them and degrade gracefully when absent.
// ============================================================
import type {
  AircraftState, NavMode, PilotRequest, PlayerPosition, Position, RunwayStatus, Stage, VehicleState, VehicleTarget, VehicleType,
} from './types';
import { ALL_STAGES, NEXT_POSITION } from './types';
import type {
  ApproachType, CommandAST, ContactWhen, CorrectionField, EmergencyInfoKind, ExitSpec, HoldAllScope, HoldShortTarget,
  PushDir, ReportKind, ResultCode, SingleAircraftCommand, TaxiDest, TurnDir, UnableReason,
} from './commandAst';
import { describe, incompatibleParts, isUndoable, IMMEDIATE_KINDS, makeAst, sequence, sortParts } from './commandAst';
import { isGroundStage, isAirStage } from './stage';
import { windComponents } from './weather';
import type { PhraseCtx } from './phraseology';
import { transmission as phraseTransmission, magneticHeading } from './phraseology';

// ──────────────────────────────────────────────────────────────────────────────
//  Action ids (== data-testid of the panel button; ctx-menu uses ctx-aircraft-<suffix>)
// ──────────────────────────────────────────────────────────────────────────────
export type ActionId =
  | 'action-pushback' | 'action-startup' | 'action-taxi-runway' | 'action-taxi-stand' | 'action-taxi-point'
  | 'action-amend-route' | 'action-hold-short' | 'action-hold-position' | 'action-hold-fix' | 'action-continue'
  | 'action-cross' | 'action-lineup' | 'action-takeoff' | 'action-cancel-takeoff' | 'action-cancel-lineup'
  | 'action-land' | 'action-goaround' | 'action-cancel-approach' | 'action-exit' | 'action-plan-exit'
  | 'action-heading' | 'action-altitude' | 'action-speed' | 'action-direct' | 'action-resume-sid' | 'action-ils'
  | 'action-expect-runway' | 'action-change-runway' | 'action-expedite' | 'action-handoff' | 'action-report'
  | 'action-say-again' | 'action-correction' | 'action-standby' | 'action-unable' | 'action-giveway'
  | 'action-wind-check' | 'action-turnaround'
  | 'emerg-ack' | 'emerg-priority' | 'emerg-dispatch' | 'emerg-hold-all' | 'emerg-breakoff' | 'emerg-stop-runway'
  | 'emerg-reopen' | 'emerg-cancel-ack' | 'emerg-resume-all';

export const ALL_ACTION_IDS: readonly ActionId[] = [
  'action-pushback', 'action-startup', 'action-taxi-runway', 'action-taxi-stand', 'action-taxi-point',
  'action-amend-route', 'action-hold-short', 'action-hold-position', 'action-hold-fix', 'action-continue',
  'action-cross', 'action-lineup', 'action-takeoff', 'action-cancel-takeoff', 'action-cancel-lineup',
  'action-land', 'action-goaround', 'action-cancel-approach', 'action-exit', 'action-plan-exit',
  'action-heading', 'action-altitude', 'action-speed', 'action-direct', 'action-resume-sid', 'action-ils',
  'action-expect-runway', 'action-change-runway', 'action-expedite', 'action-handoff', 'action-report',
  'action-say-again', 'action-correction', 'action-standby', 'action-unable', 'action-giveway',
  'action-wind-check', 'action-turnaround',
  'emerg-ack', 'emerg-priority', 'emerg-dispatch', 'emerg-hold-all', 'emerg-breakoff', 'emerg-stop-runway',
  'emerg-reopen', 'emerg-cancel-ack', 'emerg-resume-all',
];

// ──────────────────────────────────────────────────────────────────────────────
//  Canonical disabled-reasons (UX §G2 legend R1-R24 + the extra strings the
//  matrix uses, X1-X13; X14+ = §G4 empty-picker states). `{...}` placeholders
//  are filled by reasonText().
// ──────────────────────────────────────────────────────────────────────────────
export type ReasonCode =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12' | 'R13' | 'R14' | 'R15'
  | 'R16' | 'R17' | 'R18' | 'R19' | 'R20' | 'R21' | 'R22' | 'R23' | 'R24'
  | 'X1' | 'X2' | 'X3' | 'X4' | 'X5' | 'X6' | 'X7' | 'X8' | 'X9' | 'X10' | 'X11' | 'X12' | 'X13'
  | 'X14' | 'X15' | 'X16' | 'X17' | 'X18' | 'X19';

export const REASONS: Record<ReasonCode, string> = {
  R1: 'Not at the holding point yet',
  R2: 'Already on the runway',
  R3: 'Runway {rwy} occupied by {occ}',
  R4: 'Arrival {cs} {n} NM final',
  R5: 'Past abort speed',
  R6: 'Below 500 ft — too late for exit',
  R7: 'Needs heading and altitude',
  R8: '{cls} category not permitted on {rwy}',
  R9: 'Not established',
  R10: 'Not positioned — vector first',
  R11: 'Not moving',
  R12: 'No hold active',
  R13: 'Not on your frequency',
  R14: 'Runway {rwy} closed',
  R15: 'No route',
  R16: 'Airborne — use Go around',
  R17: 'On the ground',
  R18: 'Already cleared',
  R19: 'Stand {ref} occupied by {cs}',
  R20: 'No ILS on this airport',
  R21: 'Pushback not required at stand {ref}',
  R22: 'Runway {rwy} not active for {role}',
  R23: 'Traffic hold — wait',
  R24: 'Emergency in progress',
  X1: 'Push back first',
  X2: 'Use Pushback',
  X3: 'Below 1000 ft',
  X4: 'Use Cancel approach (C)',
  X5: 'Holding to cross, not to depart',
  X6: 'Not on approach',
  X7: 'Use Go around',
  X8: 'On glideslope — use Cancel approach',
  X9: 'Final approach speed',
  X10: 'Too close to switch',
  X11: 'Vacate first',
  X12: 'Paused',
  X13: 'Crossing {rwy} ahead — hand off after',
  X14: 'No free stands',
  X15: 'No fixes loaded',
  X16: 'No exits ahead',
  X17: 'No vehicles available',
  X18: 'No runway available',
  X19: 'No other traffic on final',
};

export function reasonText(code: ReasonCode, params: Record<string, string | number | null | undefined> = {}): string {
  return REASONS[code].replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

/** Result code dispatch/tests use when a reason blocks a command (03 §B4 silent codes). */
export const REASON_RESULT_CODE: Record<ReasonCode, ResultCode> = {
  R1: 'not_at_hold', R2: 'already', R3: 'runway_occupied', R4: 'runway_occupied', R5: 'past_abort_speed', R6: 'too_low',
  R7: 'invalid_param', R8: 'weight_class', R9: 'invalid_stage', R10: 'invalid_stage', R11: 'invalid_stage', R12: 'nothing_pending',
  R13: 'not_on_frequency', R14: 'runway_closed', R15: 'no_route', R16: 'invalid_stage', R17: 'invalid_stage', R18: 'already',
  R19: 'unknown_stand', R20: 'no_ils', R21: 'invalid_stage', R22: 'invalid_param', R23: 'held_by_emergency', R24: 'held_by_emergency',
  X1: 'invalid_stage', X2: 'invalid_stage', X3: 'too_low', X4: 'invalid_stage', X5: 'invalid_stage', X6: 'invalid_stage',
  X7: 'invalid_stage', X8: 'invalid_stage', X9: 'invalid_stage', X10: 'invalid_stage', X11: 'invalid_stage', X12: 'paused',
  X13: 'invalid_stage', X14: 'unknown_stand', X15: 'unknown_fix', X16: 'unable_exit', X17: 'vehicle_unavailable', X18: 'unknown_runway',
  X19: 'invalid_param',
};

// ──────────────────────────────────────────────────────────────────────────────
//  Context the rules read (built by the store from the engine for ONE aircraft)
// ──────────────────────────────────────────────────────────────────────────────
export interface RunwayInfo {
  name: string; ref: string; headingTrue: number; status: RunwayStatus; activeDep: boolean; activeArr: boolean;
  hasIls: boolean; lengthM: number; weightAllowed: boolean;
}
export interface FixInfo { name: string; bearingTrue: number; distNM: number; holdHeading?: number | null; pron?: string }
export interface StandInfo { ref: string; terminal: string; occupant: string | null; reservedFor?: string | null; closed?: boolean }
export interface VehicleInfo { id: string; callsign: string; type: VehicleType; state: VehicleState; available: boolean; etaS?: number | null }
export interface PositionInfo { position: Position; freq: string; label: string }
export interface ExitInfo { taxiway: string; distAheadM: number; dir: 'L' | 'R'; highSpeed?: boolean; engineDefault?: boolean; passed?: boolean }
export interface NearbyAircraft { callsign: string; type: string; bearingTrue: number; distM: number; onFinalNM: number | null; runway?: string | null; ground: boolean }
export interface IntersectionInfo { nodeId: string; label: string; taxiways: [string, string] }

export interface ActionCtx {
  stage: Stage;
  position: PlayerPosition;
  time: number;
  paused: boolean;
  /** Custom/sandbox mode enables `action-turnaround`. */
  sandbox: boolean;
  strictFrequencies: boolean;
  hasRadar: boolean;
  hasIls: boolean;
  hasSid: boolean;
  /** Emergency "hold all traffic" order in effect (R24 on movement actions). */
  holdAllActive: boolean;
  /** Metres to the next hold point on the aircraft's path (null = none / not on a path). */
  distToNextHoldM: number | null;
  /** Runway end name of the next runway crossing ahead on the route, null if none. */
  nextCrossingRunway: string | null;
  /** True when the next hold ahead is a runway crossing (vs the departure entry). */
  nextHoldIsCrossing: boolean;
  /** NM to threshold of plan/assigned runway (arrivals), null otherwise. */
  distToThresholdNM: number | null;
  aglFt: number;
  groundSpeedKt: number;
  /** null when not on an approach. */
  aboveGlideslope: boolean | null;
  /** Physically on a runway strip (lineup/rollout/backtrack). */
  onRunway: boolean;
  /** Seconds since the last pilot line for this callsign, null = never. */
  sinceLastPilotLineS: number | null;
  pendingRequest: PilotRequest | null;
  /** Runway the emergency closed for this aircraft (null = none). */
  emergencyClosedRunway: string | null;
  /** Other arrivals established on the same final (callsigns) — emerg-breakoff candidates. */
  otherArrivalsOnFinal: string[];
  runwayStatus(runway: string): RunwayStatus;
  /** Callsign / vehicle id occupying the runway (excluding this aircraft), null if free. */
  runwayOccupant(runway: string): string | null;
  arrivalOnFinal(runway: string): { callsign: string; nm: number } | null;
  parallelRunways(runway: string): string[];
  weightAllowed(runway: string): boolean;
  runwayActive(runway: string, role: 'dep' | 'arr'): boolean;
  /** Stand occupancy for picker-gate empty state / R19. */
  standOccupant(ref: string): string | null;
  wakeTimerRemainingS(runway: string): number;
  wind: { dir: number; kts: number; gust: number } | null;

  // ── Optional picker / validation data (W1-COMMANDS). Absent = not wired yet;
  //    pickers then degrade to name-only chips and the related guards are skipped. ──
  /** Every runway end of the airport (picker-runway candidates, wind components, ILS badges). */
  runways?: RunwayInfo[];
  /** Taxiway designators (`air.taxiwayNames`). */
  taxiways?: string[];
  /** Radar fixes with bearing/distance from this aircraft (picker-fix / picker-hold). */
  fixes?: FixInfo[];
  /** Stands with occupancy (picker-gate). */
  stands?: StandInfo[];
  /** Vehicle fleet with availability (picker-vehicle). */
  vehicles?: VehicleInfo[];
  /** Positions with frequencies (picker-position). */
  positions?: PositionInfo[];
  /** Runway exits ahead of the aircraft (rollout/landing pickers). */
  exits?: ExitInfo[];
  /** Nearby aircraft for give-way / behind-landing pickers. */
  nearbyAircraft?: NearbyAircraft[];
  /** Named taxiway intersections reachable from the aircraft (taxi-to-point). */
  intersections?: IntersectionInfo[];
  /** Pushback facings that leave the stand on a taxiway edge (§G4 picker-direction). */
  pushFacings?: Array<'N' | 'E' | 'S' | 'W'>;
  /** Taxiways adjacent to the stand ("face taxiway" chips -> PushbackAst.tailTo). */
  adjacentTaxiways?: string[];
  /** Minimum safe altitude of the sector containing the aircraft (ft); floor = max(1000, msa). */
  msaFt?: number;
  /** Service ceiling (ft); default FL200 (§G3). */
  ceilingFt?: number;
  transitionAltFt?: number;
  /** Glideslope-intercept altitude for the armed runway (ft), null/undefined = unknown. */
  gsInterceptAltFt?: number | null;
  magVar?: number;
  /** Active STCA/RIMCAS involving this aircraft (soft "Conflict active" on handoff). */
  conflictActive?: boolean;
  /** Previous picker values for this aircraft (§G4 "last used" default rule), keyed by step id. */
  lastUsed?: Record<string, string | number | undefined>;
  /** Physical runway refs whose centrelines intersect the given end's runway. */
  intersectingRunways?(runway: string): string[];
  /** Vehicle id on / crossing the runway, null = none. */
  vehicleOnRunway?(runway: string): string | null;
  /** Callsign holding a takeoff clearance (rolling or on-reaching) for the runway. */
  takeoffClearanceHolder?(runway: string): string | null;
  /** Callsigns currently holding a landing clearance on the runway, not yet vacated. */
  landingClearanceHolders?(runway: string): string[];
  /** Localizer intercept angle (deg) if the aircraft were cleared now, null = unknown. */
  interceptAngle?(runway: string): number | null;
  /** Nearest aircraft established ahead on the same final. */
  trafficAheadOnFinal?(runway: string): { callsign: string; nm: number } | null;
  /** `routeVia` reachability check for a manual taxi route. */
  routeExists?(dest: TaxiDest, via: string[]): boolean;
  /** Restricted-area check for a hold fix at an altitude: returns the reason text or null. */
  fixRestriction?(fix: string, altFt: number | null): string | null;
  /** Runway heading (true) for the "runway heading" preset. */
  runwayHeading?(runway: string): number | null;
  /** Phrase context for the confirm-step transmission preview. */
  phraseCtx?: PhraseCtx;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Matrix cells
// ──────────────────────────────────────────────────────────────────────────────
export type DynRule =
  | 'pushback' | 'startup' | 'hold_position_startup' | 'hold_fix_alt' | 'continue_pushback' | 'continue'
  | 'cross_next' | 'lineup_near' | 'cancel_takeoff_speed' | 'cancel_approach_dist' | 'exit_agl'
  | 'resume_sid' | 'ils_positioned' | 'ils_available' | 'change_runway' | 'handoff_ground' | 'handoff_taxi_out'
  | 'handoff_rollout' | 'recent_pilot_line' | 'req_pending' | 'standby' | 'sandbox' | 'rollout_dep'
  | 'emerg' | 'emerg_air' | 'emerg_stop' | 'emerg_reopen' | 'emerg_cancel' | 'emerg_resume' | 'emerg_breakoff';

export type Cell = '-' | 'on' | `off:${ReasonCode}` | `dyn:${DynRule}`;
export type MatrixRow = Record<Stage, Cell>;
export type CellResult = { state: 'enabled' | 'disabled' | 'hidden'; reason: ReasonCode | null; params?: Record<string, string | number | null> };

function row(def: Cell, overrides: Partial<Record<Stage, Cell>>): MatrixRow {
  const r = {} as MatrixRow;
  for (const s of ALL_STAGES) r[s] = overrides[s] ?? def;
  return r;
}
const AIRBORNE_CTRL: Stage[] = ['takeoff_air', 'dep_climb', 'dep_level', 'go_around', 'arr_inbound', 'arr_armed'];
const on = (stages: Stage[], cell: Cell = 'on'): Partial<Record<Stage, Cell>> => Object.fromEntries(stages.map(s => [s, cell]));

/**
 * The §G2 matrix (spec glyphs: on = enabled, off:Rn = disabled with reason,
 * dyn = iff clause, '-' = hidden). Columns = ALL_STAGES (21; dep_climb /
 * dep_level split; `departed` all hidden, including the emergency band).
 * Verified cell-by-cell against §G2 + §G13.1/.3/.5 (rollout departures,
 * taxi_out handoff, rollout handoff).
 */
export const ACTION_MATRIX: Record<ActionId, MatrixRow> = {
  'action-pushback': row('-', { parked: 'dyn:pushback', pushback: 'off:R18' }),
  'action-startup': row('-', { parked: 'dyn:startup' }),
  'action-taxi-runway': row('-', { parked: 'off:X1', startup: 'on', pushback: 'on', taxi_out: 'on', hold_short_dep: 'on', hold_short_cross: 'on', rollout: 'dyn:rollout_dep' }),
  'action-taxi-stand': row('-', { taxi_out: 'on', taxi_in: 'on', hold_short_cross: 'on', rollout: 'on' }),
  'action-taxi-point': row('-', { startup: 'on', taxi_out: 'on', taxi_in: 'on', hold_short_dep: 'on', hold_short_cross: 'on' }),
  'action-amend-route': row('-', { taxi_out: 'on', taxi_in: 'on', hold_short_dep: 'on', hold_short_cross: 'on' }),
  'action-hold-short': row('-', { taxi_out: 'on', taxi_in: 'on', hold_short_dep: 'off:R18', hold_short_cross: 'off:R18', rollout: 'on' }),
  'action-hold-position': row('-', { startup: 'dyn:hold_position_startup', pushback: 'on', taxi_out: 'on', taxi_in: 'on', hold_short_dep: 'on', hold_short_cross: 'on', lineup: 'on', rollout: 'on' }),
  'action-hold-fix': row('-', { takeoff_air: 'dyn:hold_fix_alt', dep_climb: 'on', dep_level: 'on', go_around: 'on', arr_inbound: 'on', arr_armed: 'on', arr_established: 'off:X4' }),
  'action-continue': row('-', { pushback: 'dyn:continue_pushback', taxi_out: 'dyn:continue', taxi_in: 'dyn:continue' }),
  'action-cross': row('-', { taxi_out: 'dyn:cross_next', taxi_in: 'dyn:cross_next', hold_short_cross: 'on' }),
  'action-lineup': row('-', { taxi_out: 'dyn:lineup_near', hold_short_dep: 'on', hold_short_cross: 'off:X5', lineup: 'off:R18' }),
  'action-takeoff': row('-', { taxi_out: 'on', hold_short_dep: 'on', lineup: 'on', takeoff_roll: 'off:R18' }),
  'action-cancel-takeoff': row('-', { takeoff_roll: 'dyn:cancel_takeoff_speed', takeoff_air: 'off:R16' }),
  'action-cancel-lineup': row('-', { lineup: 'on' }),
  'action-land': row('-', { go_around: 'off:R10', arr_inbound: 'off:X6', arr_armed: 'off:R9', arr_established: 'on', arr_final: 'on', arr_short_final: 'on', rollout: 'off:R18' }),
  'action-goaround': row('-', { takeoff_roll: 'off:R17', go_around: 'off:R18', arr_established: 'on', arr_final: 'on', arr_short_final: 'on', rollout: 'off:R17' }),
  'action-cancel-approach': row('-', { arr_armed: 'on', arr_established: 'on', arr_final: 'dyn:cancel_approach_dist', arr_short_final: 'off:X7' }),
  'action-exit': row('-', { arr_final: 'on', arr_short_final: 'dyn:exit_agl', rollout: 'on' }),
  'action-plan-exit': row('-', { arr_established: 'on', arr_final: 'on' }),
  'action-heading': row('-', { ...on(AIRBORNE_CTRL), arr_established: 'off:X4', arr_final: 'off:X4', arr_short_final: 'off:X4' }),
  'action-altitude': row('-', { ...on(AIRBORNE_CTRL), arr_established: 'off:X8', arr_final: 'off:X8', arr_short_final: 'off:X8' }),
  'action-speed': row('-', { ...on(AIRBORNE_CTRL), arr_established: 'on', arr_final: 'on', arr_short_final: 'off:X9' }),
  'action-direct': row('-', { ...on(AIRBORNE_CTRL), arr_established: 'off:X4', arr_final: 'off:X4', arr_short_final: 'off:X4' }),
  'action-resume-sid': row('-', { dep_climb: 'dyn:resume_sid', dep_level: 'dyn:resume_sid' }),
  'action-ils': row('-', { go_around: 'dyn:ils_positioned', arr_inbound: 'dyn:ils_available', arr_armed: 'on', arr_established: 'off:R18' }),
  'action-expect-runway': row('-', { arr_inbound: 'on' }),
  'action-change-runway': row('-', { arr_armed: 'on', arr_established: 'dyn:change_runway', arr_final: 'off:X10', arr_short_final: 'off:X10' }),
  'action-expedite': row('-', on(AIRBORNE_CTRL)),
  'action-handoff': row('-', {
    startup: 'on', taxi_out: 'dyn:handoff_taxi_out', taxi_in: 'on', hold_short_dep: 'on', hold_short_cross: 'on',
    takeoff_air: 'on', dep_climb: 'on', dep_level: 'on', go_around: 'on', arr_inbound: 'on', arr_armed: 'on',
    arr_established: 'on', arr_final: 'on', arr_short_final: 'on', rollout: 'dyn:handoff_rollout',
  }),
  'action-report': row('on', { takeoff_roll: '-', arrived: '-', departed: '-' }),
  'action-say-again': row('dyn:recent_pilot_line', { arrived: '-', departed: '-' }),
  'action-correction': row('dyn:recent_pilot_line', { arrived: '-', departed: '-' }),
  'action-standby': row('dyn:standby', { arrived: '-', departed: '-' }),
  'action-unable': row('dyn:req_pending', { arrived: '-', departed: '-' }),
  'action-giveway': row('-', { startup: 'on', taxi_out: 'on', taxi_in: 'on', hold_short_dep: 'on', hold_short_cross: 'on' }),
  'action-wind-check': row('-', { hold_short_dep: 'on', lineup: 'on', arr_established: 'on', arr_final: 'on', arr_short_final: 'on' }),
  'action-turnaround': row('-', { arrived: 'dyn:sandbox' }),
  'emerg-ack': row('dyn:emerg', { departed: '-' }),
  'emerg-priority': row('dyn:emerg_air', { departed: '-' }),
  'emerg-dispatch': row('dyn:emerg', { departed: '-' }),
  'emerg-hold-all': row('dyn:emerg', { departed: '-' }),
  'emerg-breakoff': row('dyn:emerg_breakoff', { departed: '-' }),
  'emerg-stop-runway': row('-', { arr_final: 'dyn:emerg_stop', arr_short_final: 'dyn:emerg_stop', rollout: 'dyn:emerg_stop' }),
  'emerg-reopen': row('dyn:emerg_reopen', { departed: '-' }),
  'emerg-cancel-ack': row('dyn:emerg_cancel', { departed: '-' }),
  'emerg-resume-all': row('dyn:emerg_resume', { departed: '-' }),
};

/** Movement actions hard-blocked by an emergency hold-all order (UX §G3 last row). */
const HELD_BY_EMERGENCY: readonly ActionId[] = ['action-continue', 'action-cross', 'action-lineup', 'action-takeoff', 'action-taxi-runway', 'action-taxi-stand', 'action-taxi-point', 'action-amend-route', 'action-pushback', 'action-startup'];

const enabled: CellResult = { state: 'enabled', reason: null };
const hidden: CellResult = { state: 'hidden', reason: null };
const disabled = (reason: ReasonCode, params?: Record<string, string | number | null>): CellResult => ({ state: 'disabled', reason, params });

/** Dynamic cells (the "iff" clauses of §G2 / §G13). Pure functions of (aircraft, ctx). */
export const DYNAMIC_RULES: Record<DynRule, (a: AircraftState, ctx: ActionCtx) => CellResult> = {
  pushback: a => (a.needsPushback ? enabled : disabled('R21', { ref: a.plan.gateRef ?? a.reservedStand ?? '?' })),
  startup: a => (a.needsPushback ? disabled('X2') : enabled),
  hold_position_startup: (_a, ctx) => (ctx.groundSpeedKt > 0.5 ? enabled : disabled('R11')),
  hold_fix_alt: (_a, ctx) => (ctx.aglFt >= 1000 ? enabled : disabled('X3')),
  // §G2: "● (resume push)" — meaningful only while the push is paused (Hold position); otherwise R12.
  continue_pushback: a => (a.pushback.stage === 'paused' ? enabled : disabled('R12')),
  continue: (a, ctx) => (a.trafficHold || a.holdShortTaxiway != null || (a.path?.holdAt != null && !a.holdReleased && !ctx.nextHoldIsCrossing && ctx.stage !== 'hold_short_dep') ? enabled : hidden),
  cross_next: (_a, ctx) => (ctx.nextHoldIsCrossing && ctx.nextCrossingRunway ? enabled : hidden),
  lineup_near: (_a, ctx) => (ctx.distToNextHoldM != null && ctx.distToNextHoldM < 200 && !ctx.nextHoldIsCrossing ? enabled : disabled('R1')),
  cancel_takeoff_speed: (_a, ctx) => (ctx.groundSpeedKt < 80 ? enabled : disabled('R5')),
  cancel_approach_dist: (_a, ctx) => (ctx.distToThresholdNM != null && ctx.distToThresholdNM > 2 ? enabled : disabled('X7')),
  exit_agl: (_a, ctx) => (ctx.aglFt >= 500 ? enabled : disabled('R6')),
  resume_sid: (a, ctx) => (ctx.hasSid && a.navMode !== 'sid' ? enabled : hidden),
  ils_positioned: (_a, ctx) => (ctx.distToThresholdNM != null && ctx.distToThresholdNM > 4 && ctx.aboveGlideslope === false ? enabled : disabled('R10')),
  ils_available: (_a, ctx) => (ctx.hasRadar ? (ctx.hasIls ? enabled : disabled('R20')) : hidden),
  change_runway: (a, ctx) => {
    const rwy = a.assignedRunway ?? a.plan.runway;
    const par = rwy ? ctx.parallelRunways(rwy) : [];
    return par.length && ctx.distToThresholdNM != null && ctx.distToThresholdNM > 4 ? enabled : disabled('X10');
  },
  handoff_ground: (_a, ctx) => (ctx.nextCrossingRunway == null && ctx.distToNextHoldM != null ? enabled : hidden),
  handoff_taxi_out: (_a, ctx) => (ctx.nextCrossingRunway ? disabled('X13', { rwy: ctx.nextCrossingRunway }) : enabled),
  handoff_rollout: (_a, ctx) => (ctx.onRunway ? disabled('X11') : enabled),
  recent_pilot_line: (_a, ctx) => (ctx.sinceLastPilotLineS != null && ctx.sinceLastPilotLineS <= 60 ? enabled : hidden),
  req_pending: (_a, ctx) => (ctx.pendingRequest ? enabled : hidden),
  standby: (_a, ctx) => (ctx.pendingRequest || ['parked', 'startup', 'hold_short_dep', 'hold_short_cross'].includes(ctx.stage) ? enabled : hidden),
  sandbox: (_a, ctx) => (ctx.sandbox ? enabled : hidden),
  rollout_dep: a => (a.plan.kind === 'departure' ? enabled : hidden),
  emerg: a => (a.emergency ? enabled : hidden),
  emerg_air: (a, ctx) => (a.emergency && isAirStage(ctx.stage) ? enabled : hidden),
  emerg_stop: a => (a.emergency ? enabled : hidden),
  emerg_reopen: (a, ctx) => (a.emergency && ctx.emergencyClosedRunway ? enabled : hidden),
  emerg_cancel: (a, ctx) => (a.emergency && ctx.pendingRequest?.kind === 'cancel_mayday' ? enabled : hidden),
  emerg_resume: (a, ctx) => (a.emergency && ctx.holdAllActive ? enabled : hidden),
  emerg_breakoff: (a, ctx) => (a.emergency && isAirStage(ctx.stage) && ctx.otherArrivalsOnFinal.length ? enabled : hidden),
};

export function evaluateCell(id: ActionId, a: AircraftState, ctx: ActionCtx): CellResult {
  const cell = ACTION_MATRIX[id][ctx.stage];
  if (cell === '-') return hidden;
  if (cell === 'on') return enabled;
  if (cell.startsWith('off:')) return disabled(cell.slice(4) as ReasonCode);
  return DYNAMIC_RULES[cell.slice(4) as DynRule](a, ctx);
}

/** Actions that CAN be rendered in a stage (static: `on`, `off` and `dyn` cells; `-` excluded). Used by autocomplete. */
export function visibleActionsForStage(stage: Stage): ActionId[] {
  return ALL_ACTION_IDS.filter(id => ACTION_MATRIX[id][stage] !== '-');
}
/** Actions that can be ENABLED in a stage without live data (`on` and `dyn` cells; `off:*` and `-` excluded). Used to rank autocomplete verbs. */
export function enabledActionsForStage(stage: Stage): ActionId[] {
  return ALL_ACTION_IDS.filter(id => { const c = ACTION_MATRIX[id][stage]; return c === 'on' || c.startsWith('dyn:'); });
}

// ──────────────────────────────────────────────────────────────────────────────
//  Picker steps (UX §1.2 / §G4). Each step id doubles as the ActionParams key.
//  Candidate lists are resolved from ActionCtx when the store provides them.
// ──────────────────────────────────────────────────────────────────────────────
interface StepBase { id: string; label: string; optional: boolean }

export interface RunwayChip {
  name: string; enabled: boolean; reason: string; /** "HW 7 · XW 4" / "TW 3 · XW 4" */ sub: string;
  headKt: number; crossKt: number; tailwind: boolean; activeDep: boolean; activeArr: boolean; hasIls: boolean; lengthM: number; badges: string[];
}
export interface FixChip { name: string; bearingMag: number; distNM: number; behind: boolean; holdHeading: number | null }
export interface AltitudeRung { ft: number; label: string; band: 'ok' | 'msa' | 'ceiling' | 'gs' }
export interface StandChip { ref: string; terminal: string; enabled: boolean; reason: string; assigned: boolean }
export interface VehicleChip { id: string; callsign: string; type: VehicleType; state: VehicleState; enabled: boolean; preselected: boolean; etaS: number | null }
export interface PositionChip { position: Position; freq: string; label: string; enabled: boolean }
export interface ExitChip { taxiway: string; distAheadM: number; dir: 'L' | 'R'; enabled: boolean; reason: string; engineDefault: boolean; highSpeed: boolean }
export interface AircraftChip { callsign: string; type: string; bearingMag: number; distM: number; onFinalNM: number | null; label: string }

export type PickerStep =
  | (StepBase & { type: 'runway'; mode: 'takeoff' | 'landing' | 'ils' | 'expect' | 'taxi' | 'cross' | 'priority' | 'lahso' | 'reopen' | 'change'; default: string | null; locked: boolean; approachModes: boolean; candidates: RunwayChip[] })
  | (StepBase & { type: 'taxiway-route'; destKind: TaxiDest['kind']; auto: boolean; allowHoldShort: boolean; allowCross: boolean; allowIntersection: boolean; contactTowerChip: boolean; taxiways: string[]; holdShortSuggestions: string[]; maxChips: number })
  | (StepBase & { type: 'heading'; default: number | null; allowDir: boolean; presets: Array<'runway' | 'current'>; currentHeadingTrue: number; runwayHeadingTrue: number | null; stepDeg: number; magVar: number; arcValidation: boolean })
  | (StepBase & { type: 'altitude'; default: number | null; min: number; max: number; expediteToggle: boolean; halfSteps: boolean; rungs: AltitudeRung[]; transitionAltFt: number; pilotsDiscretion: boolean; currentFt: number; commandedFt: number | null })
  | (StepBase & { type: 'speed'; default: number | null; min: number; max: number; presets: Array<'final' | 'resume' | 'until4'>; chips: number[]; quick: number[]; finalApproachKt: number; note250: string })
  | (StepBase & { type: 'fix'; default: string | null; candidates: FixChip[] })
  | (StepBase & { type: 'hold'; defaultInbound: number | null; defaultFix: string | null; defaultDir: TurnDir; legOptions: Array<{ legTimeMin: number | null; legNM: number | null; label: string }>; efcOptionsMin: number[]; time: number; candidates: FixChip[] })
  | (StepBase & { type: 'direction'; options: Array<'L' | 'R' | 'N' | 'E' | 'S' | 'W' | 'any'>; default: 'L' | 'R' | 'N' | 'E' | 'S' | 'W' | 'any' | null; enabledOptions: Array<'L' | 'R' | 'N' | 'E' | 'S' | 'W' | 'any'>; taxiwayOptions: string[] })
  | (StepBase & { type: 'taxiway'; mode: 'exit' | 'hold' | 'intersection' | 'vacate'; default: string | null; nextExitChips: boolean; candidates: string[]; exits: ExitChip[] })
  | (StepBase & { type: 'gate'; default: string | null; candidates: StandChip[] })
  | (StepBase & { type: 'aircraft'; mode: 'behind_landing' | 'give_way' | 'follow' | 'break_off'; candidates: AircraftChip[] })
  | (StepBase & { type: 'vehicle'; multi: boolean; preselect: VehicleType[]; candidates: VehicleChip[] })
  | (StepBase & { type: 'position'; default: Position | null; when: ContactWhen; candidates: PositionChip[] })
  | (StepBase & { type: 'text'; options: Array<{ value: string; label: string }>; multi: boolean; default: string[] })
  | (StepBase & { type: 'confirm'; parts: PartChip[]; holdToConfirmMs: number });

/** "+ ADD PART" chips offered on the confirm step (UX §1.5). */
export type PartChip = 'then_ils' | 'when_passing_alt' | 'after_fix' | 'descend_to' | 'speed' | 'report_established' | 'immediate' | 'after_dep_hdg' | 'turn_lr' | 'climb_to' | 'contact_on_reaching' | 'wind' | 'behind_landing' | 'traffic_final' | 'lahso' | 'exit_at' | 'next_exit' | 'via' | 'hold_short_of' | 'cross_runway' | 'intersection' | 'contact_tower_at_hold' | 'expect_runway' | 'face' | 'then_taxi' | 'fly_heading' | 'runway_heading' | 'contact' | 'expedite';

/** Reciprocal end name: 27L -> 09R, 09 -> 27, 18C -> 36C. */
export function reciprocalRunway(name: string): string {
  const m = name.toUpperCase().match(/^(\d{1,2})([LRC]?)$/);
  if (!m) return name;
  let n = parseInt(m[1], 10) + 18; if (n > 36) n -= 36;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return `${String(n).padStart(2, '0')}${side}`;
}

const HOLD_MS = 600;
const roleOf = (mode: Extract<PickerStep, { type: 'runway' }>['mode']): 'dep' | 'arr' | null =>
  mode === 'takeoff' || mode === 'taxi' ? 'dep' : mode === 'landing' || mode === 'ils' || mode === 'expect' || mode === 'priority' || mode === 'change' ? 'arr' : null;

/** Runway chips: active-for-role first, then headwind desc; disabled chips carry the reason (§G4 picker-runway). */
export function runwayChips(mode: Extract<PickerStep, { type: 'runway' }>['mode'], a: AircraftState, ctx: ActionCtx, approachType: ApproachType = 'ILS'): RunwayChip[] {
  const infos = ctx.runways ?? [];
  const role = roleOf(mode);
  const chips = infos.map<RunwayChip>(r => {
    const w = ctx.wind ? windComponents(ctx.wind.dir, ctx.wind.kts, r.headingTrue) : { headKt: 0, crossKt: 0, crossFrom: 'L' as const };
    const tail = w.headKt < 0;
    let reason = '';
    if (r.status !== 'open' && (mode === 'takeoff' || mode === 'landing' || mode === 'taxi' || mode === 'change' || mode === 'priority')) reason = reasonText('R14', { rwy: r.name });
    else if (!r.weightAllowed && mode !== 'reopen' && mode !== 'cross' && mode !== 'lahso') reason = reasonText('R8', { cls: a.perf.weightClass, rwy: r.name });
    else if ((mode === 'ils' || mode === 'change') && approachType !== 'VISUAL' && !r.hasIls) reason = reasonText('R20');
    else if (mode === 'reopen' && r.status === 'open') reason = 'Runway open';
    const badges: string[] = [];
    if (r.activeDep) badges.push('DEP'); if (r.activeArr) badges.push('ARR');
    if (!r.hasIls) badges.push('NO ILS');
    if (r.status !== 'open') badges.push(r.status.toUpperCase());
    const sub = `${tail ? 'TW' : 'HW'} ${Math.abs(Math.round(w.headKt))} · XW ${Math.round(w.crossKt)}`;
    return { name: r.name, enabled: !reason, reason, sub, headKt: w.headKt, crossKt: w.crossKt, tailwind: tail, activeDep: r.activeDep, activeArr: r.activeArr, hasIls: r.hasIls, lengthM: r.lengthM, badges };
  });
  const activeFor = (c: RunwayChip) => (role === 'dep' ? c.activeDep : role === 'arr' ? c.activeArr : c.activeDep || c.activeArr);
  return chips.sort((x, y) => Number(activeFor(y)) - Number(activeFor(x)) || y.headKt - x.headKt || x.name.localeCompare(y.name));
}

function fixChips(a: AircraftState, ctx: ActionCtx): FixChip[] {
  const magVar = ctx.magVar ?? 0;
  const chips = (ctx.fixes ?? []).map<FixChip>(f => {
    const rel = Math.abs((((f.bearingTrue - a.heading) % 360) + 540) % 360 - 180);
    return { name: f.name, bearingMag: magneticHeading(f.bearingTrue, magVar), distNM: Math.round(f.distNM * 10) / 10, behind: rel > 120, holdHeading: f.holdHeading ?? null };
  });
  return chips.sort((x, y) => Number(x.behind) - Number(y.behind) || x.distNM - y.distNM);
}

function altitudeRungs(min: number, max: number, ctx: ActionCtx, floorMsa: number, ceiling: number): AltitudeRung[] {
  const ta = ctx.transitionAltFt ?? 6000;
  const gs = ctx.gsInterceptAltFt ?? null;
  const rungs: AltitudeRung[] = [];
  for (let ft = Math.ceil(min / 1000) * 1000; ft <= max; ft += 1000) {
    const band: AltitudeRung['band'] = ft < floorMsa ? 'msa' : ft > ceiling ? 'ceiling' : gs != null && Math.abs(ft - gs) <= 500 ? 'gs' : 'ok';
    rungs.push({ ft, label: ft > ta ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : String(ft), band });
  }
  return rungs;
}

/** Stand occupant from the StandInfo list first, then the live callback. */
function standOccupantOf(ctx: ActionCtx, ref: string): string | null {
  return ctx.stands?.find(s => s.ref === ref)?.occupant ?? ctx.standOccupant(ref);
}

function standChips(a: AircraftState, ctx: ActionCtx): StandChip[] {
  const assigned = a.plan.gateRef ?? a.reservedStand ?? null;
  return (ctx.stands ?? []).map<StandChip>(s => {
    const occ = s.occupant ?? ctx.standOccupant(s.ref);
    const mine = occ === a.callsign;
    const reason = s.closed ? 'Stand closed' : occ && !mine ? reasonText('R19', { ref: s.ref, cs: occ }) : '';
    return { ref: s.ref, terminal: s.terminal, enabled: !reason, reason, assigned: s.ref === assigned };
  });
}

function vehicleChips(a: AircraftState, ctx: ActionCtx, preselect: VehicleType[]): VehicleChip[] {
  let arffLeft = 2;
  return (ctx.vehicles ?? []).map<VehicleChip>(v => {
    let pre = false;
    if (v.available && preselect.includes(v.type)) {
      if (v.type === 'arff') { if (arffLeft > 0) { pre = true; arffLeft--; } } else pre = true;
    }
    return { id: v.id, callsign: v.callsign, type: v.type, state: v.state, enabled: v.available, preselected: pre, etaS: v.etaS ?? null };
  });
}

function positionChips(a: AircraftState, ctx: ActionCtx): PositionChip[] {
  const infos = ctx.positions ?? DEFAULT_POSITIONS;
  return infos.map<PositionChip>(p => ({ position: p.position, freq: p.freq, label: p.label, enabled: p.position !== a.onFrequency }));
}
const DEFAULT_POSITIONS: PositionInfo[] = [
  { position: 'ground', freq: '', label: 'GROUND' }, { position: 'tower', freq: '', label: 'TOWER' },
  { position: 'departure', freq: '', label: 'DEPARTURE' }, { position: 'approach', freq: '', label: 'APPROACH' },
];

/** Next-logical handoff position (§G4: dep ground->tower->departure; arr approach->tower->ground). */
export function nextPosition(a: AircraftState, stage: Stage): Position | null {
  if (stage === 'rollout' || stage === 'taxi_in') return 'ground';
  if (stage === 'arr_established' || stage === 'arr_final' || stage === 'arr_short_final') return 'tower';
  if (stage === 'go_around') return 'approach';
  if (stage === 'takeoff_air' || stage === 'dep_climb' || stage === 'dep_level') return a.onFrequency === 'departure' || a.onFrequency === 'approach' ? 'external' : 'departure';
  const n = NEXT_POSITION[a.plan.kind][a.onFrequency];
  return n ?? null;
}

function exitChips(a: AircraftState, ctx: ActionCtx): ExitChip[] {
  void a;
  return (ctx.exits ?? []).map<ExitChip>(e => ({
    taxiway: e.taxiway, distAheadM: Math.round(e.distAheadM), dir: e.dir, enabled: !e.passed && e.distAheadM >= 0,
    reason: e.passed || e.distAheadM < 0 ? `Exit ${e.taxiway} already passed` : '', engineDefault: !!e.engineDefault, highSpeed: !!e.highSpeed,
  })).sort((x, y) => x.distAheadM - y.distAheadM);
}

function aircraftChips(a: AircraftState, ctx: ActionCtx, mode: Extract<PickerStep, { type: 'aircraft' }>['mode']): AircraftChip[] {
  const magVar = ctx.magVar ?? 0;
  const rwy = a.plan.runway ?? a.assignedRunway ?? null;
  let list = ctx.nearbyAircraft ?? [];
  if (mode === 'behind_landing') list = list.filter(n => n.onFinalNM != null && (!rwy || !n.runway || n.runway === rwy)).sort((x, y) => (x.onFinalNM ?? 0) - (y.onFinalNM ?? 0));
  else if (mode === 'break_off') list = list.filter(n => n.onFinalNM != null || ctx.otherArrivalsOnFinal.includes(n.callsign));
  else list = list.filter(n => n.ground && n.distM <= 300).sort((x, y) => x.distM - y.distM);
  if (mode === 'break_off' && !list.length) list = ctx.otherArrivalsOnFinal.map(cs => ({ callsign: cs, type: '', bearingTrue: 0, distM: 0, onFinalNM: null, ground: false }));
  return list.map<AircraftChip>(n => ({
    callsign: n.callsign, type: n.type, bearingMag: magneticHeading(n.bearingTrue, magVar), distM: Math.round(n.distM), onFinalNM: n.onFinalNM,
    label: n.onFinalNM != null ? `${n.callsign} ${n.type} ${n.onFinalNM.toFixed(1)} NM final` : `${n.callsign} ${n.type} ${Math.round(n.distM)} m`,
  }));
}

const S = {
  runway: (id: string, label: string, mode: Extract<PickerStep, { type: 'runway' }>['mode'], def: string | null, a: AircraftState, ctx: ActionCtx, locked = false, optional = false, approachModes = false): PickerStep => {
    const candidates = runwayChips(mode, a, ctx);
    const lu = ctx.lastUsed?.[id];
    const defaultName = def ?? (typeof lu === 'string' ? lu : null) ?? (candidates.find(c => c.enabled)?.name ?? null);
    return { id, label, type: 'runway', mode, default: defaultName, locked, optional, approachModes, candidates };
  },
  route: (id: string, label: string, destKind: TaxiDest['kind'], ctx: ActionCtx, opts: Partial<Extract<PickerStep, { type: 'taxiway-route' }>> = {}): PickerStep => ({
    id, label, type: 'taxiway-route', destKind, auto: true, allowHoldShort: true, allowCross: true, allowIntersection: true, contactTowerChip: destKind === 'runway', optional: false,
    taxiways: ctx.taxiways ?? [], holdShortSuggestions: [...(ctx.nextCrossingRunway ? [ctx.nextCrossingRunway] : []), ...(ctx.runways ?? []).map(r => r.name).filter(n => n !== ctx.nextCrossingRunway)], maxChips: 12, ...opts,
  }),
  heading: (id: string, label: string, def: number | null, a: AircraftState, ctx: ActionCtx, opts: Partial<Extract<PickerStep, { type: 'heading' }>> = {}): PickerStep => {
    const rwy = a.plan.runway ?? a.assignedRunway ?? null;
    return { id, label, type: 'heading', default: def, allowDir: true, presets: [], optional: false, currentHeadingTrue: Math.round(a.heading), runwayHeadingTrue: rwy && ctx.runwayHeading ? ctx.runwayHeading(rwy) : null, stepDeg: 5, magVar: ctx.magVar ?? 0, arcValidation: true, ...opts };
  },
  altitude: (id: string, label: string, def: number | null, a: AircraftState, ctx: ActionCtx, opts: Partial<Extract<PickerStep, { type: 'altitude' }>> = {}): PickerStep => {
    const floor = Math.max(1000, ctx.msaFt ?? 1000);
    const ceiling = ctx.ceilingFt ?? 20000;
    const min = opts.min ?? floor, max = opts.max ?? ceiling;
    return { id, label, type: 'altitude', default: def, min, max, expediteToggle: true, halfSteps: false, optional: false, rungs: altitudeRungs(min, max, ctx, floor, ceiling), transitionAltFt: ctx.transitionAltFt ?? 6000, pilotsDiscretion: true, currentFt: Math.round(a.altitude), commandedFt: a.cmdAltitude, ...opts };
  },
  speed: (id: string, label: string, def: number | null, a: AircraftState, opts: Partial<Extract<PickerStep, { type: 'speed' }>> = {}): PickerStep => {
    const min = Math.ceil((opts.min ?? a.perf.minAirspeedTMA) / 10) * 10, max = Math.floor((opts.max ?? a.perf.maxAirspeedTMA) / 10) * 10;
    const chips: number[] = []; for (let k = min; k <= max; k += 10) chips.push(k);
    return { id, label, type: 'speed', default: def, min, max, presets: ['final', 'resume'], optional: false, chips, quick: [160, 180, 210, 250].filter(q => q >= min && q <= max), finalApproachKt: a.perf.approachSpeed, note250: '<FL100', ...opts };
  },
  fix: (id: string, label: string, def: string | null, a: AircraftState, ctx: ActionCtx): PickerStep => {
    const candidates = fixChips(a, ctx);
    return { id, label, type: 'fix', default: def ?? candidates[0]?.name ?? null, optional: false, candidates };
  },
  hold: (id: string, label: string, defaultInbound: number | null, a: AircraftState, ctx: ActionCtx): PickerStep => {
    const candidates = fixChips(a, ctx);
    const defaultFix = a.holdFixName ?? a.plan.fix ?? candidates[0]?.name ?? null;
    const c = candidates.find(f => f.name === defaultFix);
    return { id, label, type: 'hold', defaultInbound: defaultInbound ?? c?.holdHeading ?? (c ? ((c.bearingMag + (ctx.magVar ?? 0)) % 360) : null), defaultFix, defaultDir: 'R', legOptions: [{ legTimeMin: 1, legNM: null, label: '1 min' }, { legTimeMin: 1.5, legNM: null, label: '1.5 min' }, { legTimeMin: null, legNM: 4, label: '4 NM' }], efcOptionsMin: [10, 20], time: ctx.time, optional: false, candidates };
  },
  direction: (id: string, label: string, options: Extract<PickerStep, { type: 'direction' }>['options'], def: Extract<PickerStep, { type: 'direction' }>['default'], ctx: ActionCtx, optional = false): PickerStep => {
    const facings = ctx.pushFacings;
    const enabledOptions = options.filter(o => o === 'any' || o === 'L' || o === 'R' || !facings || facings.includes(o));
    return { id, label, type: 'direction', options, default: def, optional, enabledOptions, taxiwayOptions: ctx.adjacentTaxiways ?? [] };
  },
  taxiway: (id: string, label: string, mode: Extract<PickerStep, { type: 'taxiway' }>['mode'], def: string | null, a: AircraftState, ctx: ActionCtx, optional = false, nextExitChips = false): PickerStep => {
    const exits = mode === 'exit' || mode === 'vacate' ? exitChips(a, ctx) : [];
    const candidates = exits.length ? exits.map(e => e.taxiway) : (ctx.taxiways ?? []);
    const d = def ?? exits.find(e => e.engineDefault && e.enabled)?.taxiway ?? null;
    return { id, label, type: 'taxiway', mode, default: d, optional, nextExitChips, candidates, exits };
  },
  gate: (id: string, label: string, def: string | null, a: AircraftState, ctx: ActionCtx): PickerStep => ({ id, label, type: 'gate', default: def, optional: false, candidates: standChips(a, ctx) }),
  aircraft: (id: string, label: string, mode: Extract<PickerStep, { type: 'aircraft' }>['mode'], a: AircraftState, ctx: ActionCtx, optional = false): PickerStep => ({ id, label, type: 'aircraft', mode, optional, candidates: aircraftChips(a, ctx, mode) }),
  vehicle: (id: string, label: string, preselect: VehicleType[], a: AircraftState, ctx: ActionCtx, multi = true): PickerStep => ({ id, label, type: 'vehicle', multi, preselect, optional: false, candidates: vehicleChips(a, ctx, preselect) }),
  position: (id: string, label: string, def: Position | null, a: AircraftState, ctx: ActionCtx, when: ContactWhen = 'now'): PickerStep => {
    const candidates = positionChips(a, ctx);
    const d = def ?? nextPosition(a, ctx.stage);
    return { id, label, type: 'position', default: d && candidates.some(c => c.position === d && c.enabled) ? d : (candidates.find(c => c.enabled)?.position ?? null), when, optional: false, candidates };
  },
  text: (id: string, label: string, options: Array<{ value: string; label: string }>, multi = false, def: string[] = [], optional = false): PickerStep => ({ id, label, type: 'text', options, multi, default: def, optional }),
  confirm: (parts: PartChip[] = []): PickerStep => ({ id: 'confirm', label: 'Confirm', type: 'confirm', parts, optional: false, holdToConfirmMs: HOLD_MS }),
};

const INFO_CHIPS_GROUND: Array<{ value: ReportKind; label: string }> = [
  { value: 'position', label: 'Position' }, { value: 'pob', label: 'POB' }, { value: 'fuel', label: 'Fuel' }, { value: 'dg', label: 'Dangerous goods' }, { value: 'intentions', label: 'Intentions' },
];
const INFO_CHIPS_AIR: Array<{ value: ReportKind; label: string }> = [
  { value: 'heading', label: 'Heading' }, { value: 'altitude', label: 'Altitude' }, { value: 'airspeed', label: 'Airspeed' }, { value: 'pob', label: 'POB' }, { value: 'fuel', label: 'Fuel' }, { value: 'nature', label: 'Nature' }, { value: 'intentions', label: 'Intentions' },
];
const UNABLE_CHIPS: Array<{ value: UnableReason; label: string }> = [
  { value: 'traffic', label: 'Traffic' }, { value: 'wake', label: 'Wake' }, { value: 'runway_closed', label: 'Runway closed' }, { value: 'slot', label: 'Slot' }, { value: 'delay', label: 'Expect delay' }, { value: 'standby', label: 'Standby' },
];

const roundUp1000 = (ft: number) => Math.ceil((ft + 1) / 1000) * 1000;
const roundDown1000 = (ft: number) => Math.floor((ft - 1) / 1000) * 1000;

/** Picker steps for an action, with defaults resolved from the aircraft (UX §1.4 tables, §G4 defaults). */
export function stepsFor(id: ActionId, a: AircraftState, ctx: ActionCtx): PickerStep[] {
  const rwy = a.plan.runway ?? a.assignedRunway ?? null;
  const air = isAirStage(ctx.stage);
  const floor = Math.max(1000, ctx.msaFt ?? 1000);
  switch (id) {
    case 'action-pushback': return [S.runway('runway', 'Expect runway', 'expect', rwy, a, ctx), S.direction('direction', 'Facing', ['any', 'N', 'E', 'S', 'W'], 'any', ctx, true), S.confirm(['expect_runway', 'face', 'then_taxi'])];
    case 'action-startup': return [S.runway('runway', 'Expect runway', 'expect', rwy, a, ctx), S.confirm(['expect_runway'])];
    case 'action-taxi-runway': return [S.runway('runway', ctx.stage === 'taxi_out' ? 'Runway (amend)' : 'Runway', 'taxi', rwy, a, ctx), S.route('route', 'Route', 'runway', ctx), S.confirm(['via', 'hold_short_of', 'cross_runway', 'intersection', 'contact_tower_at_hold'])];
    case 'action-taxi-stand': return [S.gate('stand', 'Stand', a.plan.gateRef ?? a.reservedStand, a, ctx), S.route('route', 'Route', 'stand', ctx, { contactTowerChip: false }), S.confirm(['via', 'hold_short_of', 'cross_runway'])];
    case 'action-taxi-point': return [S.taxiway('taxiway', 'Taxiway', 'intersection', null, a, ctx), S.taxiway('taxiway2', 'Intersecting taxiway', 'intersection', null, a, ctx), S.route('route', 'Route', 'node', ctx, { contactTowerChip: false }), S.confirm(['via', 'hold_short_of'])];
    case 'action-amend-route': return [S.route('route', 'Amend route', a.plan.kind === 'departure' ? 'runway' : 'stand', ctx), S.confirm(['via', 'hold_short_of', 'cross_runway'])];
    case 'action-hold-short': return [S.text('chips', 'Hold short of', [{ value: 'next', label: ctx.nextCrossingRunway ? `Runway ${ctx.nextCrossingRunway}` : 'Next runway on route' }, { value: 'runway', label: 'Runway...' }, { value: 'taxiway', label: 'Taxiway...' }, { value: 'here', label: 'Here' }], false, ['next']), S.confirm()];
    case 'action-hold-position': return ctx.stage === 'lineup'
      ? [S.text('chips', 'Reason', [{ value: 'traffic_final', label: 'Traffic on final' }, { value: 'wake', label: 'Wake' }, { value: 'crossing', label: 'Crossing traffic' }], false, [], true), S.confirm()]
      : [S.confirm()];
    case 'action-hold-fix': return [S.hold('hold', 'Holding pattern', a.holdInboundHdg || null, a, ctx), S.confirm()];
    case 'action-continue': return [S.confirm(['hold_short_of'])];
    case 'action-cross': return [S.runway('runway', 'Cross runway', 'cross', ctx.nextCrossingRunway ?? a.holdShortRunway, a, ctx, true), S.text('chips', 'Options', [{ value: 'expedite', label: 'Expedite' }], true, [], true), S.confirm(['expedite'])];
    case 'action-lineup': return [S.runway('runway', 'Runway', 'takeoff', rwy, a, ctx, true), S.aircraft('aircraft', 'Behind landing aircraft', 'behind_landing', a, ctx, true), S.confirm(['behind_landing', 'traffic_final'])];
    case 'action-takeoff': return [S.runway('runway', 'Runway', 'takeoff', rwy, a, ctx, true), S.confirm(['immediate', 'after_dep_hdg', 'turn_lr', 'climb_to', 'contact_on_reaching', 'wind'])];
    case 'action-cancel-takeoff': return [S.confirm()];
    case 'action-cancel-lineup': return [S.taxiway('taxiway', 'Vacate via', 'vacate', null, a, ctx, true, true), S.confirm()];
    case 'action-land': return [S.runway('runway', 'Runway', 'landing', rwy, a, ctx, true), S.confirm(['wind', 'lahso', 'exit_at', 'next_exit'])];
    case 'action-goaround': return [S.confirm(['fly_heading', 'runway_heading', 'climb_to', 'contact'])];
    case 'action-cancel-approach': return [S.heading('heading', 'Heading', null, a, ctx, { presets: ['runway', 'current'] }), S.altitude('altitude', 'Altitude', Math.max(3000, floor, roundUp1000(a.altitude)), a, ctx), S.confirm()];
    case 'action-exit': return [S.taxiway('taxiway', 'Exit at', 'exit', a.exitTaxiway, a, ctx, false, true), S.text('chips', 'Options', [{ value: 'expedite', label: 'Expedite, traffic on short final' }], true, [], true), S.confirm(['expedite', 'hold_short_of', 'contact'])];
    case 'action-plan-exit': return [S.taxiway('taxiway', 'Plan to vacate at', 'exit', a.exitTaxiway, a, ctx, false, true), S.confirm()];
    case 'action-heading': {
      const lu = ctx.lastUsed?.heading;
      const def = typeof lu === 'number' ? lu : Math.round(a.cmdAltitude != null ? a.targetHeading : a.heading);
      return [S.heading('heading', 'Heading', def, a, ctx, { presets: ['runway', 'current'] }), S.confirm(['climb_to', 'speed', 'then_ils', 'when_passing_alt', 'after_fix'])];
    }
    case 'action-altitude': {
      const dep = a.plan.kind === 'departure';
      const def = dep ? Math.min(13000, Math.max(a.clearance.initialAlt, roundUp1000(a.altitude))) : Math.max(floor, roundDown1000(a.altitude));
      return [S.altitude('altitude', 'Altitude', def, a, ctx, { max: dep ? 13000 : (ctx.ceilingFt ?? 20000) }), S.confirm(['fly_heading', 'speed', 'then_ils', 'when_passing_alt'])];
    }
    case 'action-speed': {
      const est = ctx.stage === 'arr_established' || ctx.stage === 'arr_final';
      return [S.speed('speed', 'Speed', a.cmdIas ?? Math.round(a.targetSpeed / 10) * 10, a, { min: est ? a.perf.approachSpeed : a.perf.minAirspeedTMA, max: est ? Math.min(210, a.perf.maxAirspeedTMA) : a.perf.maxAirspeedTMA, presets: est ? ['final', 'until4', 'resume'] : ['final', 'resume'] }), S.confirm(['fly_heading', 'climb_to'])];
    }
    case 'action-direct': return [S.fix('fix', 'Direct to', a.plan.fix ?? null, a, ctx), S.confirm(['climb_to', 'speed'])];
    case 'action-resume-sid': return [S.confirm()];
    case 'action-ils': return [S.runway('runway', 'Approach runway', 'ils', rwy, a, ctx, false, false, true), S.confirm(['descend_to', 'speed', 'report_established'])];
    case 'action-expect-runway': return [S.runway('runway', 'Expect runway', 'expect', rwy, a, ctx, false, false, true), S.confirm()];
    case 'action-change-runway': {
      const step = S.runway('runway', 'Change to runway', 'change', null, a, ctx) as Extract<PickerStep, { type: 'runway' }>;
      const par = rwy ? ctx.parallelRunways(rwy) : [];
      if (par.length) step.candidates = step.candidates.filter(c => par.includes(c.name));
      step.default = step.candidates.find(c => c.enabled)?.name ?? null;
      return [step, S.confirm()];
    }
    case 'action-expedite': return [S.confirm()];
    case 'action-handoff': return [S.position('position', 'Contact', null, a, ctx, ctx.stage === 'rollout' ? 'when_vacated' : 'now'), S.confirm()];
    case 'action-report': return [S.text('chips', 'Report', air ? INFO_CHIPS_AIR : INFO_CHIPS_GROUND, true, [air ? 'heading' : 'position']), S.confirm()];
    case 'action-say-again': return [S.confirm()];
    case 'action-correction': return [S.text('chips', 'Correct', [{ value: 'heading', label: 'Heading' }, { value: 'altitude', label: 'Altitude' }, { value: 'speed', label: 'Speed' }, { value: 'runway', label: 'Runway' }, { value: 'squawk', label: 'Squawk' }, { value: 'frequency', label: 'Frequency' }, { value: 'taxiway', label: 'Taxiway' }], false, [a.readback.mismatch?.field ?? 'heading']), S.confirm()];
    case 'action-standby': return [S.confirm()];
    case 'action-unable': return [S.text('chips', 'Reason', UNABLE_CHIPS, false, ['traffic']), S.confirm()];
    case 'action-giveway': return [S.aircraft('aircraft', 'Give way to / follow', 'give_way', a, ctx), S.text('chips', 'Mode', [{ value: 'give_way', label: 'Give way' }, { value: 'follow', label: 'Follow' }], false, ['give_way']), S.confirm()];
    case 'action-wind-check': return [S.confirm()];
    case 'action-turnaround': return [S.runway('runway', 'Departure runway', 'takeoff', rwy, a, ctx), S.text('chips', 'Delay', [{ value: '20', label: '20 min' }, { value: '35', label: '35 min' }, { value: '60', label: '60 min' }], false, ['35']), S.confirm()];
    case 'emerg-ack': return [S.text('chips', 'Ask for', [{ value: 'pob', label: 'POB' }, { value: 'fuel', label: 'Fuel' }, { value: 'nature', label: 'Nature' }, { value: 'dg', label: 'Dangerous goods' }, { value: 'intentions', label: 'Intentions' }], true, ['pob', 'fuel', 'intentions']), S.confirm()];
    case 'emerg-priority': return [S.runway('runway', 'Priority runway', 'priority', a.emergency?.runway ?? rwy, a, ctx), S.text('chips', 'Options', [{ value: 'straight_in', label: 'Straight-in' }, { value: 'number_one', label: 'Number one' }, { value: 'sterile', label: 'Runway sterile' }], true, ['number_one']), S.confirm()];
    case 'emerg-dispatch': return [S.vehicle('vehicles', 'Vehicles', a.emergency?.type === 'medical' ? ['arff', 'ambulance'] : ['arff'], a, ctx), S.text('chips', 'Location', [{ value: 'runway', label: `Runway ${a.emergency?.runway ?? rwy ?? ''}`.trim() }, { value: 'aircraft', label: 'Aircraft position' }, { value: 'stand', label: 'Gate' }, { value: 'map', label: 'Map point' }], false, ['runway']), S.confirm()];
    case 'emerg-hold-all': return [S.text('chips', 'Scope', [{ value: 'departures', label: `Departures ${rwy ?? ''}`.trim() }, { value: 'crossings', label: 'Crossings' }, { value: 'all', label: 'All ground movement' }], false, ['departures']), S.confirm()];
    case 'emerg-breakoff': return [S.aircraft('aircraft', 'Break off', 'break_off', a, ctx), S.heading('heading', 'Heading', null, a, ctx), S.altitude('altitude', 'Altitude', Math.max(4000, floor), a, ctx), S.confirm()];
    case 'emerg-stop-runway': return [S.text('chips', 'After landing', [{ value: 'stop', label: 'Stop on the runway' }, { value: 'vacate_if_able', label: 'Vacate if able' }], false, ['stop']), S.taxiway('taxiway', 'Vacate via', 'vacate', null, a, ctx, true, true), S.confirm()];
    case 'emerg-reopen': return [S.runway('runway', 'Reopen runway', 'reopen', ctx.emergencyClosedRunway, a, ctx), S.text('chips', 'Options', [{ value: 'after_inspection', label: 'After inspection' }], true, ['after_inspection'], true), S.confirm()];
    case 'emerg-cancel-ack': return [S.confirm()];
    case 'emerg-resume-all': return [S.confirm()];
  }
}

/** §G4 empty-state rule: a mandatory picker with zero candidates disables the row. Returns the reason or null. */
export function emptyPickerReason(steps: PickerStep[]): ReasonCode | null {
  for (const s of steps) {
    if (s.optional) continue;
    switch (s.type) {
      case 'runway': if (s.candidates.length && !s.candidates.some(c => c.enabled)) return s.candidates.every(c => c.reason === REASONS.R20) ? 'R20' : 'X18'; break;
      case 'gate': if (s.candidates.length && !s.candidates.some(c => c.enabled)) return 'X14'; break;
      case 'fix': if (!s.candidates.length && s.default == null) return 'X15'; break;
      case 'hold': if (!s.candidates.length && s.defaultFix == null) return 'X15'; break;
      case 'taxiway': if ((s.mode === 'exit' || s.mode === 'vacate') && s.exits.length && !s.exits.some(e => e.enabled)) return 'X16'; break;
      case 'vehicle': if (s.candidates.length && !s.candidates.some(c => c.enabled)) return 'X17'; break;
      case 'aircraft': if (s.mode === 'break_off' && !s.candidates.length) return 'X19'; break;
      default: break;
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Action definitions (labels, hotkeys, groups, panel order)
// ──────────────────────────────────────────────────────────────────────────────
export type ActionGroup = 'ground' | 'tower' | 'approach' | 'meta' | 'emergency';
export interface ActionDef { id: ActionId; label: string; key: string | null; group: ActionGroup; order: number }

const D = (id: ActionId, label: string, key: string | null, group: ActionGroup, order: number): ActionDef => ({ id, label, key, group, order });
export const ACTION_DEFS: Record<ActionId, ActionDef> = {
  'action-pushback': D('action-pushback', 'Pushback approved', 'P', 'ground', 10),
  'action-startup': D('action-startup', 'Start-up approved', 'P', 'ground', 11),
  'action-taxi-runway': D('action-taxi-runway', 'Taxi to runway', 'T', 'ground', 20),
  'action-taxi-stand': D('action-taxi-stand', 'Taxi to stand', 'T', 'ground', 21),
  'action-taxi-point': D('action-taxi-point', 'Taxi to point', 'T', 'ground', 22),
  'action-amend-route': D('action-amend-route', 'Amend route', 'T', 'ground', 23),
  'action-hold-short': D('action-hold-short', 'Hold short of', 'H', 'ground', 30),
  'action-hold-position': D('action-hold-position', 'Hold position', 'H', 'ground', 31),
  'action-continue': D('action-continue', 'Continue taxi', 'X', 'ground', 40),
  'action-cross': D('action-cross', 'Cross runway', 'X', 'ground', 41),
  'action-giveway': D('action-giveway', 'Give way / follow', 'J', 'ground', 45),
  'action-lineup': D('action-lineup', 'Line up and wait', 'W', 'tower', 50),
  'action-takeoff': D('action-takeoff', 'Cleared for takeoff', 'O', 'tower', 51),
  'action-cancel-takeoff': D('action-cancel-takeoff', 'Cancel takeoff', 'C', 'tower', 52),
  'action-cancel-lineup': D('action-cancel-lineup', 'Vacate runway', 'C', 'tower', 53),
  'action-land': D('action-land', 'Cleared to land', 'L', 'tower', 60),
  'action-goaround': D('action-goaround', 'Go around', 'G', 'tower', 61),
  'action-exit': D('action-exit', 'Exit / vacate', 'E', 'tower', 62),
  'action-plan-exit': D('action-plan-exit', 'Plan exit', 'E', 'tower', 63),
  'action-wind-check': D('action-wind-check', 'Wind check', 'R', 'tower', 64),
  'action-heading': D('action-heading', 'Vector', 'V', 'approach', 70),
  'action-altitude': D('action-altitude', 'Climb / descend', 'A', 'approach', 71),
  'action-speed': D('action-speed', 'Speed', 'S', 'approach', 72),
  'action-direct': D('action-direct', 'Direct', 'D', 'approach', 73),
  'action-resume-sid': D('action-resume-sid', 'Resume SID', 'D', 'approach', 74),
  'action-hold-fix': D('action-hold-fix', 'Hold at fix', 'H', 'approach', 75),
  'action-ils': D('action-ils', 'Cleared ILS', 'I', 'approach', 76),
  'action-expect-runway': D('action-expect-runway', 'Expect runway', 'I', 'approach', 77),
  'action-change-runway': D('action-change-runway', 'Change runway', 'I', 'approach', 78),
  'action-cancel-approach': D('action-cancel-approach', 'Cancel approach clearance', 'C', 'approach', 79),
  'action-expedite': D('action-expedite', 'Expedite', 'A', 'approach', 80),
  'action-handoff': D('action-handoff', 'Contact', 'F', 'meta', 90),
  'action-report': D('action-report', 'Report', 'R', 'meta', 91),
  'action-say-again': D('action-say-again', 'Say again', 'R', 'meta', 92),
  'action-correction': D('action-correction', 'Correction', 'R', 'meta', 93),
  'action-standby': D('action-standby', 'Standby', 'Y', 'meta', 94),
  'action-unable': D('action-unable', 'Unable', 'N', 'meta', 95),
  'action-turnaround': D('action-turnaround', 'Schedule as departure', null, 'meta', 99),
  'emerg-ack': D('emerg-ack', 'Acknowledge mayday', 'M,A', 'emergency', 1),
  'emerg-priority': D('emerg-priority', 'Priority runway', 'M,I', 'emergency', 2),
  'emerg-dispatch': D('emerg-dispatch', 'Dispatch services', 'M,D', 'emergency', 3),
  'emerg-hold-all': D('emerg-hold-all', 'Hold all traffic', 'M,H', 'emergency', 4),
  'emerg-breakoff': D('emerg-breakoff', 'Break off other arrival', 'M,B', 'emergency', 5),
  'emerg-stop-runway': D('emerg-stop-runway', 'Stop on runway / vacate', 'M,E', 'emergency', 6),
  'emerg-reopen': D('emerg-reopen', 'Reopen runway', 'M,R', 'emergency', 7),
  'emerg-cancel-ack': D('emerg-cancel-ack', 'Roger, mayday cancelled', 'M,C', 'emergency', 8),
  'emerg-resume-all': D('emerg-resume-all', 'Resume all traffic', 'M,X', 'emergency', 9),
};

/** Default first-row actions per position (UX §2.2) — used to rank the ctx menu. */
export const POSITION_DEFAULT_ROW: Record<PlayerPosition, ActionId[]> = {
  ground: ['action-pushback', 'action-taxi-runway', 'action-hold-short', 'action-continue', 'action-lineup'],
  tower: ['action-lineup', 'action-takeoff', 'action-land', 'action-goaround', 'action-exit'],
  approach: ['action-heading', 'action-altitude', 'action-speed', 'action-ils', 'action-direct'],
};

// ──────────────────────────────────────────────────────────────────────────────
//  actionsFor
// ──────────────────────────────────────────────────────────────────────────────
export interface ActionRow {
  id: ActionId;
  label: string;
  /** Resolved hotkey for this stage (null = none). Chords are "M,A" / "A,E". */
  hotkey: string | null;
  group: ActionGroup;
  state: 'enabled' | 'disabled';
  reason: ReasonCode | null;
  /** Canonical reason text with placeholders filled (empty when enabled) — data-reason. */
  reasonText: string;
  /** Soft warnings (amber TRANSMIT ANYWAY) known before the pickers run. */
  soft: string[];
  steps: PickerStep[];
  /** Highlighted default answer for a pending request / emergency flow. */
  primary: boolean;
  order: number;
}

/** Suggested answer per request kind (UX §G8). */
export const REQUEST_ANSWER: Partial<Record<PilotRequest['kind'], ActionId>> = {
  pushback: 'action-pushback', startup: 'action-startup', taxi: 'action-taxi-runway', cross: 'action-cross',
  ready: 'action-takeoff', higher: 'action-altitude', lower: 'action-altitude', direct: 'action-direct',
  taxi_in: 'action-taxi-stand', say_again: 'action-say-again', radio_check: 'action-report',
  cancel_mayday: 'emerg-cancel-ack', return_to_stand: 'action-taxi-stand', wind_check: 'action-wind-check',
  confirm_cleared: 'action-land', further: 'action-heading', intersection: 'action-taxi-runway',
  runway_vacated: 'action-handoff', going_around: 'action-goaround',
};

/**
 * The visible rows for `a` in `ctx.stage`, panel order: emergency band first
 * (when a.emergency), then ground/tower/approach/meta by `order`. Off-frequency
 * aircraft under strict frequencies get every row disabled with R13; paused
 * sims get X12; an emergency hold-all order disables movement rows with R24;
 * a mandatory picker without candidates disables the row (§G4).
 */
export function actionsFor(a: AircraftState, ctx: ActionCtx): ActionRow[] {
  const rows: ActionRow[] = [];
  const offFreq = ctx.strictFrequencies && a.onFrequency !== 'external' && ownerOf(a.onFrequency) !== ctx.position;
  let primaryId: ActionId | null = ctx.pendingRequest ? (ctx.pendingRequest.suggestedAction ?? REQUEST_ANSWER[ctx.pendingRequest.kind] ?? null) : (a.emergency && a.emergency.status === 'declared' ? 'emerg-ack' : null);
  // §G8: "ready for departure" -> line up when the runway is occupied.
  if (primaryId === 'action-takeoff' && ctx.pendingRequest?.kind === 'ready') {
    const r = a.plan.runway ?? a.assignedRunway;
    if (r && ctx.runwayOccupant(r)) primaryId = 'action-lineup';
  }
  for (const id of ALL_ACTION_IDS) {
    let cell = evaluateCell(id, a, ctx);
    if (cell.state === 'hidden') continue;
    const steps = stepsFor(id, a, ctx);
    // global policy layers override every visible row (§G3 "Any command while paused", strict-frequency R13)
    if (ctx.paused) cell = disabled('X12');
    else if (offFreq) cell = disabled('R13');
    else if (cell.state === 'enabled') {
      const empty = emptyPickerReason(steps);
      if (ctx.holdAllActive && HELD_BY_EMERGENCY.includes(id)) cell = disabled('R24');
      else if (empty) cell = disabled(empty);
    }
    const def = ACTION_DEFS[id];
    const params = { rwy: a.plan.runway ?? a.assignedRunway ?? '', ref: a.plan.gateRef ?? '', cls: a.perf.weightClass, ...(cell.params ?? {}) };
    rows.push({
      id, label: def.label, hotkey: hotkeyFor(id, ctx.stage), group: def.group,
      state: cell.state === 'enabled' ? 'enabled' : 'disabled',
      reason: cell.reason, reasonText: cell.reason ? reasonText(cell.reason, params) : '',
      soft: softWarnings(id, a, ctx),
      steps,
      primary: id === primaryId,
      order: def.group === 'emergency' ? def.order : 100 + def.order,
    });
  }
  return rows.sort((x, y) => x.order - y.order);
}

function ownerOf(p: Position): PlayerPosition | null {
  return p === 'ground' ? 'ground' : p === 'tower' ? 'tower' : p === 'approach' || p === 'departure' ? 'approach' : null;
}

/** Pre-picker soft warnings (UX §1.4 "Soft:" clauses that do not need picker values). */
export function softWarnings(id: ActionId, a: AircraftState, ctx: ActionCtx): string[] {
  const out: string[] = [];
  const rwy = a.plan.runway ?? a.assignedRunway;
  if ((id === 'action-heading' || id === 'action-direct') && ctx.stage === 'arr_armed') out.push('Cancels ILS clearance');
  if (id === 'action-heading' && ctx.stage === 'takeoff_air' && ctx.aglFt < 400) out.push('Below 400 ft');
  if (id === 'action-hold-fix' && ctx.stage === 'arr_armed') out.push('Cancels ILS clearance');
  if ((id === 'action-takeoff' || id === 'action-lineup') && rwy) {
    const arr = ctx.arrivalOnFinal(rwy);
    if (arr && arr.nm >= 2 && arr.nm <= 4) out.push(reasonText('R4', { cs: arr.callsign, n: arr.nm.toFixed(1) }));
    const wake = ctx.wakeTimerRemainingS(rwy);
    if (id === 'action-takeoff' && wake > 0) out.push(`Wake turbulence — ${Math.ceil(wake)} s remaining`);
    if (!ctx.runwayActive(rwy, 'dep')) out.push(reasonText('R22', { rwy, role: 'dep' }));
    for (const w of windWarnings(rwy, ctx)) out.push(w);
  }
  if (id === 'action-land' && rwy) {
    const occ = ctx.runwayOccupant(rwy);
    if (occ) out.push(reasonText('R3', { rwy, occ }));
    if (!ctx.runwayActive(rwy, 'arr')) out.push(reasonText('R22', { rwy, role: 'arr' }));
    for (const w of windWarnings(rwy, ctx)) out.push(w);
  }
  if (id === 'action-handoff' && ctx.stage === 'dep_climb' && a.altitude < 9000 && a.navMode !== 'sid') out.push('Below FL90 with SID off — counts as diversion');
  if (id === 'action-handoff' && ctx.conflictActive) out.push('Conflict active');
  if (id === 'action-hold-position' && ctx.stage === 'lineup' && rwy) {
    const arr = ctx.arrivalOnFinal(rwy);
    if (arr && arr.nm < 2) out.push('Arrival inside 2 NM — consider Vacate');
  }
  if (id === 'action-cross' && (ctx.nextCrossingRunway ?? a.holdShortRunway)) {
    const x = ctx.nextCrossingRunway ?? a.holdShortRunway!;
    const arr = ctx.arrivalOnFinal(x);
    if (arr && arr.nm >= 2 && arr.nm <= 4) out.push(`${reasonText('R4', { cs: arr.callsign, n: arr.nm.toFixed(1) })} — crossing takes ≈ 45 s`);
  }
  if (id === 'action-taxi-stand') {
    const ref = a.plan.gateRef ?? a.reservedStand;
    const occ = ref ? standOccupantOf(ctx, ref) : null;
    if (ref && occ && occ !== a.callsign) out.push(reasonText('R19', { ref, cs: occ }));
  }
  if (id === 'action-taxi-runway' && ctx.nextCrossingRunway && ctx.stage !== 'hold_short_cross') out.push(`Route crosses runway ${ctx.nextCrossingRunway} — hold short inserted`);
  return out;
}

function windWarnings(rwy: string, ctx: ActionCtx): string[] {
  const out: string[] = [];
  const info = ctx.runways?.find(r => r.name === rwy);
  if (!info || !ctx.wind) return out;
  const w = windComponents(ctx.wind.dir, Math.max(ctx.wind.kts, ctx.wind.gust), info.headingTrue);
  if (w.headKt < -10) out.push(`Tailwind ${Math.round(-w.headKt)} kt`);
  if (w.crossKt > 25) out.push(`Crosswind ${Math.round(w.crossKt)} kt`);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Hotkeys (UX §1.3 + §G2 collision rules + §G6)
// ──────────────────────────────────────────────────────────────────────────────
/** Actions sharing a root letter; the owner (hotkeyFor) is reached first, the others by pressing the letter again (§G2 "second press cycles"). */
export const HOTKEY_FAMILIES: Record<string, ActionId[]> = {
  T: ['action-amend-route', 'action-taxi-runway', 'action-taxi-stand', 'action-taxi-point'],
  H: ['action-hold-short', 'action-hold-position', 'action-hold-fix'],
  X: ['action-cross', 'action-continue'],
  I: ['action-ils', 'action-change-runway', 'action-expect-runway'],
  E: ['action-exit', 'action-plan-exit'],
  C: ['action-cancel-lineup', 'action-cancel-takeoff', 'action-cancel-approach'],
  R: ['action-report', 'action-wind-check', 'action-say-again', 'action-correction'],
  D: ['action-direct', 'action-resume-sid'],
  A: ['action-altitude', 'action-expedite'],
  P: ['action-pushback', 'action-startup'],
};

/** Resolved letter for an action in a stage; null when another action owns the letter there. */
export function hotkeyFor(id: ActionId, stage: Stage): string | null {
  const key = ACTION_DEFS[id].key;
  if (!key) return null;
  const ground = isGroundStage(stage);
  switch (key) {
    case 'T': {
      const owner: ActionId = stage === 'taxi_out' ? 'action-amend-route'
        : stage === 'taxi_in' || stage === 'rollout' ? 'action-taxi-stand'
          : 'action-taxi-runway'; // startup / pushback / parked / hold_short_* (change runway)
      return id === owner ? 'T' : null;
    }
    case 'H': {
      const owner: ActionId = stage === 'lineup' || stage === 'hold_short_dep' || stage === 'hold_short_cross' || stage === 'startup' || stage === 'pushback' ? 'action-hold-position'
        : ground ? 'action-hold-short' : 'action-hold-fix';
      return id === owner ? 'H' : null;
    }
    case 'X': return id === 'action-cross' ? 'X' : id === 'action-continue' ? 'X' : null; // resolveHotkey prefers cross when both visible
    case 'I': {
      const owner: ActionId = stage === 'arr_armed' || stage === 'arr_established' ? 'action-change-runway' : 'action-ils';
      return id === owner ? 'I' : null; // expect-runway is the I sub-chip in arr_inbound
    }
    case 'E': return id === 'action-exit' ? 'E' : stage === 'arr_established' && id === 'action-plan-exit' ? 'E' : null;
    case 'C': {
      const owner: ActionId = stage === 'lineup' ? 'action-cancel-lineup' : stage === 'takeoff_roll' || stage === 'takeoff_air' ? 'action-cancel-takeoff' : 'action-cancel-approach';
      return id === owner ? 'C' : null;
    }
    case 'R': {
      const owner: ActionId = ['hold_short_dep', 'lineup', 'arr_short_final'].includes(stage) ? 'action-wind-check' : 'action-report';
      return id === owner ? 'R' : null; // say-again / correction are R sub-chips
    }
    case 'D': return id === 'action-direct' ? 'D' : null; // resume-sid is D -> "resume" sub-chip
    case 'A': return id === 'action-altitude' ? 'A' : id === 'action-expedite' ? 'A,E' : null; // expedite = A then E (§1.4)
    case 'P': return id === 'action-pushback' || id === 'action-startup' ? 'P' : null;
    default: return key;
  }
}

/**
 * Which visible row a key press (letter or "M,x" chord) activates. Enabled rows
 * win over disabled ones; X prefers cross over continue; passing `after` (the
 * currently highlighted row id) cycles through the letter's family (§G2).
 */
export function resolveHotkey(key: string, rows: ActionRow[], after?: ActionId | null): ActionRow | null {
  const k = key.toUpperCase();
  const family = HOTKEY_FAMILIES[k];
  if (after && family) {
    const members = family.map(id => rows.find(r => r.id === id)).filter((r): r is ActionRow => !!r);
    const i = members.findIndex(r => r.id === after);
    if (i >= 0 && members.length > 1) return members[(i + 1) % members.length];
  }
  const hits = rows.filter(r => r.hotkey === k);
  if (!hits.length) return null;
  const ranked = [...hits].sort((x, y) => Number(y.state === 'enabled') - Number(x.state === 'enabled'));
  if (k === 'X') return ranked.find(r => r.id === 'action-cross' && r.state === 'enabled') ?? ranked[0];
  return ranked[0];
}

// ──────────────────────────────────────────────────────────────────────────────
//  toAst — picker output -> CommandAST
// ──────────────────────────────────────────────────────────────────────────────
/** Values collected by the stepper, keyed by step id (see stepsFor). */
export interface ActionParams {
  runway?: string;
  route?: { via: string[]; auto: boolean; holdShortOf?: HoldShortTarget | null; cross?: string[]; dest?: TaxiDest; intersection?: string | null };
  stand?: string;
  taxiway?: string;
  taxiway2?: string;
  node?: { nodeId: string; label: string };
  heading?: number;
  dir?: TurnDir | null;
  relative?: { dir: TurnDir; deg: number } | null;
  altitude?: number;
  expedite?: boolean;
  speed?: number | 'resume';
  untilNM?: number | null;
  fix?: string;
  hold?: { fix: string; inbound?: number | null; dir?: TurnDir | null; legTimeMin?: number | null; legNM?: number | null; efc?: number | null };
  direction?: PushDir | TurnDir;
  exit?: ExitSpec | null;
  position?: Position;
  when?: ContactWhen;
  aircraft?: string;
  /** Text-picker selections (values). */
  chips?: string[];
  immediate?: boolean;
  afterDepHdg?: number | 'runway' | null;
  turn?: { dir: TurnDir; deg: number } | null;
  initialAlt?: number | null;
  contactDeparture?: boolean;
  wind?: boolean;
  lahso?: string | null;
  approachType?: ApproachType;
  vehicles?: string[];
  vehicleType?: VehicleType;
  target?: VehicleTarget;
  reason?: string | null;
  number?: number | null;
  goAround?: { heading?: number | 'runway' | null; alt?: number | null; contact?: Position | null };
  field?: CorrectionField;
  value?: number | string;
  scope?: HoldAllScope;
  afterInspection?: boolean;
  /** Pilot's discretion / "when ready" toggle on the altitude ladder. */
  pilotsDiscretion?: boolean;
  /** Extra parts appended via "+ ADD PART" (already built by the UI with makeAst). */
  then?: SingleAircraftCommand[];
}

const up = (s: string | undefined | null) => (s ? s.toUpperCase() : '');
const chipsHave = (p: ActionParams, v: string) => (p.chips ?? []).includes(v);
function exitParam(p: ActionParams): ExitSpec | undefined {
  if (p.exit) return p.exit;
  if (p.taxiway) return { kind: 'taxiway', taxiway: up(p.taxiway) };
  if (p.direction === 'L' || p.direction === 'R') return { kind: 'next', dir: p.direction };
  return undefined;
}

/**
 * Build the AST for an action from its collected picker params. Aircraft
 * actions require `callsign`; system actions ignore it. Throws on a missing
 * mandatory param so the UI can never transmit a half-built command.
 */
export function toAst(id: ActionId, params: ActionParams, callsign: string, a?: AircraftState): CommandAST {
  const cs = callsign.toUpperCase();
  const req = <T,>(v: T | undefined | null, name: string): T => { if (v == null || v === '') throw new Error(`${id}: missing ${name}`); return v; };
  const withParts = (base: SingleAircraftCommand) => sequence(cs, sortParts([base, ...(params.then ?? [])]));
  const route = params.route;
  switch (id) {
    case 'action-pushback': return withParts(makeAst('pushback', cs, { dir: (params.direction as PushDir) ?? 'any', expectRunway: params.runway ? up(params.runway) : null, tailTo: params.taxiway ? up(params.taxiway) : null }));
    case 'action-startup': return makeAst('startup', cs, { expectRunway: params.runway ? up(params.runway) : null });
    case 'action-taxi-runway': return withParts(makeAst('taxi', cs, { dest: { kind: 'runway', runway: up(req(params.runway, 'runway')), intersection: route?.intersection ?? null }, via: route?.via ?? [], auto: route?.auto ?? !(route?.via?.length), holdShortOf: route?.holdShortOf ?? null, cross: route?.cross ?? [] }));
    case 'action-taxi-stand': return withParts(makeAst('taxi', cs, { dest: { kind: 'stand', ref: req(params.stand, 'stand') }, via: route?.via ?? [], auto: route?.auto ?? !(route?.via?.length), holdShortOf: route?.holdShortOf ?? null, cross: route?.cross ?? [] }));
    case 'action-taxi-point': {
      const n = params.node ?? (params.taxiway && params.taxiway2 ? { nodeId: `${up(params.taxiway)}/${up(params.taxiway2)}`, label: `${up(params.taxiway)}/${up(params.taxiway2)}` } : undefined);
      const node = req(n, 'node');
      return withParts(makeAst('taxi', cs, { dest: { kind: 'node', nodeId: node.nodeId, label: node.label }, via: route?.via ?? [], auto: route?.auto ?? true, holdShortOf: route?.holdShortOf ?? null, cross: route?.cross ?? [] }));
    }
    case 'action-amend-route': {
      const fallback: TaxiDest | undefined = a?.plan.kind === 'departure' && a.plan.runway ? { kind: 'runway', runway: a.plan.runway, intersection: null } : a?.plan.gateRef ? { kind: 'stand', ref: a.plan.gateRef } : undefined;
      const dest = req(route?.dest ?? fallback, 'route.dest');
      return withParts(makeAst('taxi', cs, { dest, via: route?.via ?? [], auto: route?.auto ?? false, holdShortOf: route?.holdShortOf ?? null, cross: route?.cross ?? [] }));
    }
    case 'action-hold-short': {
      if (chipsHave(params, 'here')) return makeAst('holdPosition', cs, {});
      if (chipsHave(params, 'taxiway')) return makeAst('holdShort', cs, { of: { kind: 'taxiway', taxiway: up(req(params.taxiway, 'taxiway')) } });
      return makeAst('holdShort', cs, { of: { kind: 'runway', runway: up(req(params.runway ?? a?.holdShortRunway ?? undefined, 'runway')) } });
    }
    case 'action-hold-position': return makeAst('holdPosition', cs, { reason: params.chips?.[0] ?? params.reason ?? null });
    case 'action-hold-fix': { const h = req(params.hold, 'hold'); return makeAst('hold', cs, { fix: up(h.fix), inbound: h.inbound ?? null, dir: h.dir ?? null, legTimeMin: h.legTimeMin ?? (h.legNM ? null : 1), legNM: h.legNM ?? null, efc: h.efc ?? null }); }
    case 'action-continue': return makeAst('continue', cs, { holdShortOf: route?.holdShortOf ?? null });
    case 'action-cross': return makeAst('cross', cs, { runway: up(req(params.runway, 'runway')), expedite: !!params.expedite || chipsHave(params, 'expedite'), behind: params.aircraft ? up(params.aircraft) : null });
    case 'action-lineup': return makeAst('lineup', cs, { runway: up(req(params.runway, 'runway')), behind: params.aircraft ? up(params.aircraft) : null, intersection: route?.intersection ?? null });
    case 'action-takeoff': return makeAst('takeoff', cs, { runway: up(req(params.runway, 'runway')), immediate: !!params.immediate || chipsHave(params, 'immediate'), afterDepHdg: params.afterDepHdg ?? (params.heading != null ? params.heading : null), turn: params.turn ?? null, initialAlt: params.initialAlt ?? params.altitude ?? null, contactDeparture: !!params.contactDeparture || chipsHave(params, 'contact_on_reaching'), wind: params.wind ?? true });
    case 'action-cancel-takeoff': return makeAst('cancelTakeoff', cs, { reason: params.reason ?? null });
    case 'action-cancel-lineup': return makeAst('cancelLineup', cs, { via: params.taxiway ? up(params.taxiway) : null });
    case 'action-land': return makeAst('clearedLand', cs, { runway: up(req(params.runway, 'runway')), lahso: params.lahso ? up(params.lahso) : null, exit: params.exit ?? null, wind: params.wind ?? true, number: params.number ?? null });
    case 'action-goaround': { const g = params.goAround ?? {}; return makeAst('goAround', cs, { heading: g.heading ?? params.afterDepHdg ?? (params.heading ?? null), alt: g.alt ?? params.altitude ?? null, contact: g.contact ?? params.position ?? null, reason: params.reason ?? null }); }
    case 'action-cancel-approach': return makeAst('cancelApproach', cs, { hdg: req(params.heading, 'heading'), alt: req(params.altitude, 'altitude'), dir: params.dir ?? null, reason: params.reason ?? null });
    case 'action-exit': return makeAst('exitAt', cs, { exit: req(exitParam(params), 'exit'), expedite: !!params.expedite || chipsHave(params, 'expedite'), holdShortOf: route?.holdShortOf ?? null, contactGround: params.position === 'ground' });
    case 'action-plan-exit': return makeAst('exitAt', cs, { exit: req(exitParam(params), 'exit') });
    case 'action-heading': return withParts(makeAst('heading', cs, { hdg: req(params.heading, 'heading'), dir: params.dir ?? null, relative: params.relative ?? null }));
    case 'action-altitude': return withParts(makeAst('altitude', cs, { ft: req(params.altitude, 'altitude'), expedite: !!params.expedite, when: params.pilotsDiscretion ? { type: 'when_ready' } : null }));
    case 'action-speed': return withParts(makeAst('speed', cs, { kts: req(params.speed, 'speed'), untilNM: params.untilNM ?? null }));
    case 'action-direct': return withParts(makeAst('direct', cs, { fix: up(req(params.fix, 'fix')) }));
    case 'action-resume-sid': return makeAst('resumeSid', cs, {});
    case 'action-ils': {
      const rwy = up(req(params.runway, 'runway'));
      const t = params.approachType ?? 'ILS';
      const base: SingleAircraftCommand = t === 'LOC' ? makeAst('loc', cs, { runway: rwy, maintainAlt: params.altitude ?? null }) : t === 'VISUAL' ? makeAst('visual', cs, { runway: rwy, follow: params.aircraft ? up(params.aircraft) : null }) : makeAst('ils', cs, { runway: rwy });
      return withParts(base);
    }
    case 'action-expect-runway': return makeAst('expectRunway', cs, { runway: up(req(params.runway, 'runway')), approach: params.approachType ?? 'ILS' });
    case 'action-change-runway': return makeAst('ils', cs, { runway: up(req(params.runway, 'runway')) });
    case 'action-expedite': return makeAst('expedite', cs, { on: params.expedite ?? true, scope: a && a.altitude < (a.cmdAltitude ?? a.targetAltitude) ? 'climb' : 'descent' });
    case 'action-handoff': return makeAst('contact', cs, { position: req(params.position, 'position'), when: params.when ?? 'now' });
    case 'action-report': return makeAst('report', cs, { items: (params.chips ?? ['position']) as ReportKind[] });
    case 'action-say-again': return makeAst('sayAgain', cs, {});
    case 'action-correction': return makeAst('correction', cs, { field: (params.field ?? (params.chips?.[0] as CorrectionField) ?? 'heading'), value: req(params.value, 'value') });
    case 'action-standby': return makeAst('standby', cs, {});
    case 'action-unable': return makeAst('unable', cs, { reason: (params.chips?.[0] as UnableReason) ?? 'traffic' });
    case 'action-giveway': return makeAst('giveWay', cs, { to: up(req(params.aircraft, 'aircraft')), mode: chipsHave(params, 'follow') ? 'follow' : 'give_way' });
    case 'action-wind-check': return makeAst('windCheck', cs, {});
    case 'action-turnaround': return makeAst('startup', cs, { expectRunway: params.runway ? up(params.runway) : null }); // sandbox scheduler consumes params.chips[0] minutes; AST is the eventual start-up
    case 'emerg-ack': return makeAst('emergencyAck', cs, { ask: (params.chips ?? ['pob', 'fuel', 'intentions']) as EmergencyInfoKind[], squawk: true });
    case 'emerg-priority': return makeAst('priority', cs, { runway: up(req(params.runway, 'runway')), straightIn: chipsHave(params, 'straight_in'), numberOne: chipsHave(params, 'number_one'), sterile: chipsHave(params, 'sterile'), clearIls: true });
    case 'emerg-dispatch': {
      const loc = params.chips?.[0] ?? 'runway';
      const target: VehicleTarget = params.target ?? (loc === 'aircraft' && a ? { kind: 'aircraft', id: a.id, callsign: a.callsign } : loc === 'stand' && (params.stand || a?.plan.gateRef) ? { kind: 'stand', ref: params.stand ?? a!.plan.gateRef! } : { kind: 'runway', runway: up(params.runway ?? a?.emergency?.runway ?? a?.plan.runway ?? '') });
      return makeAst('dispatchVehicle', null, { type: params.vehicleType ?? 'arff', ids: params.vehicles ?? [], count: params.vehicles?.length || 2, target });
    }
    case 'emerg-hold-all': return makeAst('holdAll', null, { scope: (params.scope ?? (params.chips?.[0] as HoldAllScope)) ?? 'departures', runway: params.runway ? up(params.runway) : (a?.emergency?.runway ?? a?.plan.runway ?? null) });
    case 'emerg-breakoff': return makeAst('cancelApproach', up(req(params.aircraft, 'aircraft')), { hdg: req(params.heading, 'heading'), alt: req(params.altitude, 'altitude'), reason: 'emergency traffic' });
    case 'emerg-stop-runway': return makeAst('stopOnRunway', cs, { mode: chipsHave(params, 'vacate_if_able') ? 'vacate_if_able' : 'stop', via: params.taxiway ? up(params.taxiway) : null });
    case 'emerg-reopen': return makeAst('reopenRunway', null, { runway: up(req(params.runway, 'runway')), afterInspection: params.afterInspection ?? chipsHave(params, 'after_inspection') });
    case 'emerg-cancel-ack': return makeAst('emergencyCancelAck', cs, {});
    case 'emerg-resume-all': return makeAst('resumeAll', null, {});
  }
}

/** Confirm-step preview: the exact transmission text (phraseology) or a describe() fallback while the templates are stubs. */
export function transmissionPreview(ast: CommandAST, ctx: Pick<ActionCtx, 'phraseCtx'>): string {
  if (ctx.phraseCtx) {
    try { return phraseTransmission(ast, ctx.phraseCtx); } catch { /* stub or template gap -> fallback */ }
  }
  const cs = 'callsign' in ast ? `${ast.callsign}, ` : '';
  return `${cs}${describe(ast)}.`;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Validation — UX §1.4 "Hard/Soft" clauses + §G3 guards, evaluated on the AST
//  with engine data from ActionCtx. `validate` = cell + toAst + validateAst.
// ──────────────────────────────────────────────────────────────────────────────
export interface ValidationIssue { code: ResultCode; reason: ReasonCode | null; text: string; hard: boolean; part?: string }
export interface ValidationResult { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[]; ast: CommandAST | null }

const hardIssue = (code: ResultCode, text: string, reason: ReasonCode | null = null, part?: string): ValidationIssue => ({ code, reason, text, hard: true, part });
const softIssue = (text: string, reason: ReasonCode | null = null, part?: string): ValidationIssue => ({ code: 'ok', reason, text, hard: false, part });
const isVehicleId = (s: string) => /^(FIRE|AMB|FOLLOW|TUG|OPS|SWEEP|BIRD|FUEL|DEICE)\d+$/i.test(s);

export function validate(id: ActionId, params: ActionParams, a: AircraftState, ctx: ActionCtx): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let cell = evaluateCell(id, a, ctx);
  const offFreq = ctx.strictFrequencies && a.onFrequency !== 'external' && ownerOf(a.onFrequency) !== ctx.position;
  if (cell.state === 'enabled') {
    if (ctx.paused) cell = disabled('X12');
    else if (offFreq) cell = disabled('R13');
    else if (ctx.holdAllActive && HELD_BY_EMERGENCY.includes(id)) cell = disabled('R24');
  }
  if (cell.state !== 'enabled') {
    const reason: ReasonCode = cell.reason ?? 'X6';
    const p = { rwy: a.plan.runway ?? a.assignedRunway ?? '', ref: a.plan.gateRef ?? '', cls: a.perf.weightClass, ...(cell.params ?? {}) };
    errors.push(hardIssue(cell.state === 'hidden' ? 'invalid_stage' : REASON_RESULT_CODE[reason], cell.state === 'hidden' ? `${ACTION_DEFS[id].label} not available in ${ctx.stage}` : reasonText(reason, p), cell.state === 'hidden' ? null : reason));
  }
  let ast: CommandAST | null = null;
  try { ast = toAst(id, params, a.callsign, a); } catch (e) { errors.push(hardIssue('invalid_param', (e as Error).message)); }
  if (ast) {
    const r = validateAst(ast, a, ctx);
    errors.push(...r.errors); warnings.push(...r.warnings);
  }
  for (const s of softWarnings(id, a, ctx)) if (!warnings.some(w => w.text === s)) warnings.push(softIssue(s));
  return { ok: !errors.length, errors, warnings, ast };
}

/** Validate an AST (from the click tree OR the text parser) against engine data. Sequences validate every part. */
export function validateAst(ast: CommandAST, a: AircraftState | null, ctx: ActionCtx): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (ctx.paused) errors.push(hardIssue('paused', REASONS.X12, 'X12'));
  if (ast.kind === 'sequence') {
    if (ast.parts.length > 4) errors.push(hardIssue('invalid_param', 'Max 1 base + 3 parts'));
    const inc = incompatibleParts(ast.parts);
    if (inc) errors.push(hardIssue('invalid_param', `Incompatible parts: ${inc[0]} and ${inc[1]}`));
    for (const p of ast.parts) {
      const r = validatePart(p, a, ctx);
      for (const e of r.errors) errors.push({ ...e, part: describe(p) });
      for (const w of r.warnings) warnings.push({ ...w, part: describe(p) });
    }
  } else {
    const r = validatePart(ast, a, ctx);
    errors.push(...r.errors); warnings.push(...r.warnings);
  }
  return { ok: !errors.length, errors, warnings, ast };
}

function validatePart(ast: CommandAST, a: AircraftState | null, ctx: ActionCtx): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const hard = (code: ResultCode, text: string, reason: ReasonCode | null = null) => errors.push(hardIssue(code, text, reason));
  const soft = (text: string, reason: ReasonCode | null = null) => warnings.push(softIssue(text, reason));
  const cls = a?.perf.weightClass ?? 'M';
  const runwayKnown = (rwy: string) => !ctx.runways || ctx.runways.some(r => r.name === rwy);
  const checkRunwayExists = (rwy: string) => { if (!rwy) hard('invalid_param', 'Runway required'); else if (!runwayKnown(rwy)) hard('unknown_runway', `Unknown runway ${rwy}`); };
  // A sterile runway is closed to everybody except the emergency it was sterilised for (03 §4: "runway sterile").
  const closed = (rwy: string) => { const st = ctx.runwayStatus(rwy); return st !== 'open' && !(st === 'sterile' && !!a?.emergency && a.emergency.status !== 'resolved'); };
  const stage = ctx.stage;
  const floor = Math.max(1000, ctx.msaFt ?? 1000);
  const ceiling = ctx.ceilingFt ?? 20000;

  switch (ast.kind) {
    case 'takeoff': case 'lineup': {
      const rwy = ast.runway;
      checkRunwayExists(rwy);
      if (!rwy || !runwayKnown(rwy)) break;
      if (closed(rwy)) hard('runway_closed', reasonText('R14', { rwy }), 'R14');
      if (!ctx.weightAllowed(rwy)) hard('weight_class', reasonText('R8', { cls, rwy }), 'R8');
      if (!ctx.runwayActive(rwy, 'dep')) soft(reasonText('R22', { rwy, role: 'dep' }), 'R22');
      const occ = ctx.runwayOccupant(rwy);
      const veh = ctx.vehicleOnRunway?.(rwy) ?? (occ && isVehicleId(occ) ? occ : null);
      if (veh) hard('runway_occupied', `Vehicle ${veh} on runway`, 'R3');
      else if (occ && occ !== a?.callsign && !(ast.kind === 'lineup' && ast.behind)) hard('runway_occupied', reasonText('R3', { rwy, occ }), 'R3');
      const holder = ctx.takeoffClearanceHolder?.(rwy);
      if (holder && holder !== a?.callsign) hard('runway_occupied', ast.kind === 'lineup' ? `${holder} cleared for takeoff on reaching` : `${holder} already cleared for takeoff on ${rwy}`, 'R3');
      const arr = ctx.arrivalOnFinal(rwy);
      if (arr && arr.callsign !== a?.callsign) {
        if (ast.kind === 'takeoff' && arr.nm < 2) hard('runway_occupied', reasonText('R4', { cs: arr.callsign, n: arr.nm.toFixed(1) }), 'R4');
        else if (arr.nm <= 4 && !(ast.kind === 'lineup' && ast.behind === arr.callsign)) soft(reasonText('R4', { cs: arr.callsign, n: arr.nm.toFixed(1) }), 'R4');
      }
      const recip = reciprocalRunway(rwy);
      const opp = recip !== rwy ? ctx.arrivalOnFinal(recip) : null;
      if (opp && opp.callsign !== a?.callsign) { if (opp.nm < 4) hard('runway_occupied', `Opposite-end arrival ${opp.callsign} ${opp.nm.toFixed(1)} NM final ${recip}`, 'R4'); else soft(`Opposite-end arrival ${opp.callsign} ${opp.nm.toFixed(1)} NM final ${recip}`, 'R4'); }
      const oppOcc = recip !== rwy ? ctx.runwayOccupant(recip) : null;
      if (oppOcc && oppOcc !== a?.callsign && oppOcc !== occ) soft(`Departure ${oppOcc} rolling from ${recip}`);
      for (const x of ctx.intersectingRunways?.(rwy) ?? []) {
        const xo = ctx.runwayOccupant(x) ?? ctx.takeoffClearanceHolder?.(x) ?? null;
        if (xo && xo !== a?.callsign) hard('runway_occupied', `Crossing runway ${x} in use by ${xo}`, 'R3');
      }
      if (ast.kind === 'takeoff') { const wake = ctx.wakeTimerRemainingS(rwy); if (wake > 0) soft(`Wake turbulence — ${Math.ceil(wake)} s remaining`); }
      for (const w of windWarnings(rwy, ctx)) soft(w);
      if (ast.kind === 'takeoff' && ast.initialAlt != null && ast.initialAlt > ceiling) hard('invalid_param', `Above service ceiling (${ceiling} ft)`);
      break;
    }
    case 'clearedLand': {
      const rwy = ast.runway;
      checkRunwayExists(rwy);
      if (!rwy || !runwayKnown(rwy)) break;
      if (closed(rwy)) hard('runway_closed', reasonText('R14', { rwy }), 'R14');
      if (!ctx.weightAllowed(rwy)) hard('weight_class', reasonText('R8', { cls, rwy }), 'R8');
      if (!ctx.runwayActive(rwy, 'arr')) soft(reasonText('R22', { rwy, role: 'arr' }), 'R22');
      const occ = ctx.runwayOccupant(rwy);
      if (occ && occ !== a?.callsign) soft(reasonText('R3', { rwy, occ }), 'R3');
      const holders = (ctx.landingClearanceHolders?.(rwy) ?? []).filter(h => h !== a?.callsign);
      if (holders.length) {
        const d = ctx.distToThresholdNM;
        if (d != null && d < 2) hard('runway_occupied', `${holders[0]} cleared to land ahead, not yet vacated`, 'R3');
        else soft(`Number ${holders.length + 1}, ${holders[0]} ahead`);
      }
      if (ast.lahso && ast.exit?.kind === 'taxiway') soft('LAHSO with a fixed exit — pilot may refuse');
      for (const w of windWarnings(rwy, ctx)) soft(w);
      break;
    }
    case 'cross': {
      const rwy = ast.runway;
      checkRunwayExists(rwy);
      if (!rwy || !runwayKnown(rwy)) break;
      const occ = ctx.runwayOccupant(rwy);
      const holder = ctx.takeoffClearanceHolder?.(rwy);
      if (occ && occ !== a?.callsign && !ast.behind) hard('runway_occupied', reasonText('R3', { rwy, occ }), 'R3');
      else if (holder && holder !== a?.callsign) hard('runway_occupied', `${holder} cleared for takeoff on ${rwy}`, 'R3');
      const arr = ctx.arrivalOnFinal(rwy);
      if (arr && arr.callsign !== ast.behind) {
        if (arr.nm < 2) hard('runway_occupied', reasonText('R4', { cs: arr.callsign, n: arr.nm.toFixed(1) }), 'R4');
        else if (arr.nm <= 4) soft(`${reasonText('R4', { cs: arr.callsign, n: arr.nm.toFixed(1) })} — crossing takes ≈ 45 s`, 'R4');
      }
      if (ctx.holdAllActive) hard('held_by_emergency', REASONS.R24, 'R24');
      break;
    }
    case 'taxi': {
      if (ast.dest.kind === 'runway') {
        const r = ast.dest.runway;
        checkRunwayExists(r);
        if (r && runwayKnown(r) && closed(r)) hard('runway_closed', reasonText('R14', { rwy: r }), 'R14');
        if (r && runwayKnown(r) && !ctx.runwayActive(r, 'dep')) soft(reasonText('R22', { rwy: r, role: 'dep' }), 'R22');
      } else if (ast.dest.kind === 'stand') {
        const ref = ast.dest.ref;
        const occ = standOccupantOf(ctx, ref);
        if (occ && occ !== a?.callsign) soft(reasonText('R19', { ref, cs: occ }), 'R19');
        if (ctx.stands?.length && !ctx.stands.some(s => s.ref === ref)) hard('unknown_stand', `Unknown stand ${ref}`);
      }
      if (ctx.taxiways?.length) for (const v of ast.via) if (!ctx.taxiways.includes(v)) hard('unknown_taxiway', `Unknown taxiway ${v}`);
      if (ctx.taxiways?.length && ast.holdShortOf?.kind === 'taxiway' && !ctx.taxiways.includes(ast.holdShortOf.taxiway)) hard('unknown_taxiway', `Unknown taxiway ${ast.holdShortOf.taxiway}`);
      if (ast.holdShortOf?.kind === 'runway') checkRunwayExists(ast.holdShortOf.runway);
      for (const x of ast.cross) checkRunwayExists(x);
      if (ast.cross.length > 1) soft('FAA: one runway crossing per clearance');
      if (!ast.auto && ast.via.length && ctx.routeExists && !ctx.routeExists(ast.dest, ast.via)) hard('no_route', REASONS.R15, 'R15');
      if (ast.via.length > 12) hard('invalid_param', 'Route limited to 12 taxiways');
      if (ctx.nextCrossingRunway && !ast.holdShortOf && !ast.cross.length) soft(`Route crosses runway ${ctx.nextCrossingRunway} — hold short inserted`);
      if (ctx.holdAllActive) hard('held_by_emergency', REASONS.R24, 'R24');
      break;
    }
    case 'holdShort': {
      if (ast.of.kind === 'runway') checkRunwayExists(ast.of.runway);
      else if (ast.of.kind === 'taxiway' && ctx.taxiways?.length && !ctx.taxiways.includes(ast.of.taxiway)) hard('unknown_taxiway', `Unknown taxiway ${ast.of.taxiway}`);
      break;
    }
    case 'pushback': case 'startup': {
      const exp = ast.expectRunway;
      if (exp) { checkRunwayExists(exp); if (runwayKnown(exp) && closed(exp)) hard('runway_closed', reasonText('R14', { rwy: exp }), 'R14'); if (runwayKnown(exp) && !ctx.runwayActive(exp, 'dep')) soft(reasonText('R22', { rwy: exp, role: 'dep' }), 'R22'); }
      if (ast.kind === 'pushback' && ast.dir !== 'any' && ctx.pushFacings && !ctx.pushFacings.includes(ast.dir)) hard('invalid_param', `Cannot face ${ast.dir} from this stand`);
      if (ctx.holdAllActive) hard('held_by_emergency', REASONS.R24, 'R24');
      break;
    }
    case 'heading': case 'direct': {
      if (ast.kind === 'heading' && (ast.hdg < 1 || ast.hdg > 360) && !ast.relative) hard('invalid_param', 'Heading 001-360');
      if (ast.kind === 'direct' && ctx.fixes?.length && !ctx.fixes.some(f => f.name === ast.fix)) hard('unknown_fix', `Unknown fix ${ast.fix}`);
      if (a && !isAirStage(stage)) hard('invalid_stage', REASONS.R17, 'R17');
      else if (a?.ilsCaptured) hard('invalid_stage', REASONS.X4, 'X4');
      else if (a?.ilsArmed) soft('Cancels ILS clearance');
      if (stage === 'takeoff_air' && ctx.aglFt < 400) soft('Below 400 ft');
      if (ast.kind === 'direct' && ctx.hasRadar === false) hard('invalid_stage', 'No radar airspace');
      break;
    }
    case 'altitude': {
      if (ast.ft % 100 !== 0 || ast.ft <= 0) hard('invalid_param', 'Altitude must be a multiple of 100 ft');
      if (a && !isAirStage(stage)) hard('invalid_stage', REASONS.R17, 'R17');
      else if (a?.ilsCaptured) hard('invalid_stage', REASONS.X8, 'X8');
      if (ast.ft < floor) hard('too_low', `Below MSA (${floor} ft)`);
      if (ast.ft > ceiling) hard('invalid_param', `Above service ceiling (${ceiling} ft)`);
      if (a?.plan.kind === 'departure' && ast.ft > 13000) soft('Above FL130 TMA cap');
      if (a?.ilsArmed && ctx.gsInterceptAltFt != null && ast.ft < ctx.gsInterceptAltFt) soft(`Below glideslope intercept (${ctx.gsInterceptAltFt})`);
      break;
    }
    case 'speed': {
      if (a && !isAirStage(stage)) hard('invalid_stage', REASONS.R17, 'R17');
      if (ast.kts !== 'resume' && a) {
        const est = stage === 'arr_established' || stage === 'arr_final' || stage === 'arr_short_final';
        const min = est ? a.perf.approachSpeed : a.perf.minAirspeedTMA;
        const max = est ? Math.min(210, a.perf.maxAirspeedTMA) : a.perf.maxAirspeedTMA;
        if (ast.kts < min || ast.kts > max) hard('unable_envelope', `Speed ${ast.kts} outside envelope ${min}-${max} kt`);
        if (ast.kts > 250 && a.altitude < 10000) soft('Above 250 kt below FL100');
        if (est && ast.kts < 160 && (ctx.distToThresholdNM ?? 0) > 4) soft('Below 160 kt outside 4 NM');
      }
      break;
    }
    case 'hold': {
      if (a && !isAirStage(stage)) hard('invalid_stage', REASONS.R17, 'R17');
      if (ctx.fixes?.length && !ctx.fixes.some(f => f.name === ast.fix)) hard('unknown_fix', `Unknown fix ${ast.fix}`);
      if (ast.inbound != null && (ast.inbound < 1 || ast.inbound > 360)) hard('invalid_param', 'Inbound course 001-360');
      const restr = ctx.fixRestriction?.(ast.fix, a?.cmdAltitude ?? a?.altitude ?? null);
      if (restr) hard('invalid_param', restr);
      if (a?.ilsCaptured) hard('invalid_stage', REASONS.X4, 'X4');
      else if (a?.ilsArmed) soft('Cancels ILS clearance');
      break;
    }
    case 'ils': case 'loc': case 'visual': {
      const rwy = ast.runway;
      checkRunwayExists(rwy);
      if (!rwy || !runwayKnown(rwy)) break;
      if (a && !isAirStage(stage)) hard('invalid_stage', REASONS.R17, 'R17');
      if (!ctx.weightAllowed(rwy)) hard('weight_class', reasonText('R8', { cls, rwy }), 'R8');
      const info = ctx.runways?.find(r => r.name === rwy);
      if (ast.kind !== 'visual' && info && !info.hasIls) hard('no_ils', REASONS.R20, 'R20');
      if (ast.kind !== 'visual' && !ctx.hasIls && !info) hard('no_ils', REASONS.R20, 'R20');
      if (closed(rwy)) soft(reasonText('R14', { rwy }), 'R14');
      if (!ctx.runwayActive(rwy, 'arr')) soft(reasonText('R22', { rwy, role: 'arr' }), 'R22');
      const ang = ctx.interceptAngle?.(rwy);
      if (ang != null && Math.abs(ang) > 60) soft(`Will not capture — ${Math.round(Math.abs(ang))}° intercept`);
      if (ctx.aboveGlideslope) soft('Above glideslope at intercept — descend first');
      const ahead = ctx.trafficAheadOnFinal?.(rwy);
      if (ahead && ahead.nm < 3) soft(`${ahead.callsign} established ${ahead.nm.toFixed(1)} NM ahead`);
      if (stage === 'arr_established' && a?.assignedRunway === rwy) hard('already', REASONS.R18, 'R18');
      if (ast.kind === 'loc' && ast.maintainAlt != null && ast.maintainAlt < floor) hard('too_low', `Below MSA (${floor} ft)`);
      break;
    }
    case 'cancelApproach': {
      if (!ast.hdg || !ast.alt) hard('invalid_param', REASONS.R7, 'R7');
      if (ast.alt && ast.alt < floor) hard('too_low', `Below MSA (${floor} ft)`);
      if (a && a.callsign === ast.callsign && !a.ilsArmed && !a.ilsCaptured && isAirStage(stage) && stage !== 'arr_armed' && stage !== 'arr_established' && stage !== 'arr_final') soft('No approach clearance to cancel');
      break;
    }
    case 'goAround': {
      if (a && !isAirStage(stage)) hard('invalid_stage', REASONS.R17, 'R17');
      if (a && !a.plan.runway && !a.assignedRunway) hard('invalid_stage', 'Never on approach');
      if (ast.alt != null && ast.alt < floor) hard('too_low', `Below MSA (${floor} ft)`);
      break;
    }
    case 'exitAt': {
      if (ast.exit.kind === 'taxiway') {
        const twy = ast.exit.taxiway;
        const ex = ctx.exits?.find(e => e.taxiway === twy);
        if (ctx.exits?.length && !ex) hard('unable_exit', `Exit ${twy} not on this runway`);
        else if (ex && (ex.passed || ex.distAheadM < 0)) hard('unable_exit', `Exit ${ex.taxiway} already passed`);
        if (ctx.taxiways?.length && !ctx.exits?.length && !ctx.taxiways.includes(twy)) hard('unknown_taxiway', `Unknown taxiway ${twy}`);
      }
      if (stage === 'arr_short_final' && ctx.aglFt < 500) hard('too_low', REASONS.R6, 'R6');
      if (ast.holdShortOf?.kind === 'runway') checkRunwayExists(ast.holdShortOf.runway);
      break;
    }
    case 'cancelLineup': if (ast.via && ctx.taxiways?.length && !ctx.taxiways.includes(ast.via)) hard('unknown_taxiway', `Unknown taxiway ${ast.via}`); break;
    case 'cancelTakeoff': if (stage === 'takeoff_roll' && ctx.groundSpeedKt >= 80) hard('past_abort_speed', REASONS.R5, 'R5'); else if (stage === 'takeoff_air') hard('invalid_stage', REASONS.R16, 'R16'); break;
    case 'contact': {
      if (a && ast.position === a.onFrequency) hard('already', `Already on ${ast.position}`, 'R18');
      if (ctx.conflictActive) soft('Conflict active');
      if (stage === 'rollout' && ctx.onRunway && ast.when === 'now') soft(REASONS.X11, 'X11');
      if (stage === 'taxi_out' && ctx.nextCrossingRunway && ast.position === 'tower') soft(reasonText('X13', { rwy: ctx.nextCrossingRunway }), 'X13');
      if (stage === 'dep_climb' && a && a.altitude < 9000 && a.navMode !== 'sid' && ast.position === 'external') soft('Below FL90 with SID off — counts as diversion');
      break;
    }
    case 'expectRunway': case 'priority': {
      checkRunwayExists(ast.runway);
      if (ast.runway && runwayKnown(ast.runway)) {
        if (!ctx.weightAllowed(ast.runway)) hard('weight_class', reasonText('R8', { cls, rwy: ast.runway }), 'R8');
        if (closed(ast.runway)) { if (ast.kind === 'priority') soft(reasonText('R14', { rwy: ast.runway }), 'R14'); else hard('runway_closed', reasonText('R14', { rwy: ast.runway }), 'R14'); }
        const info = ctx.runways?.find(r => r.name === ast.runway);
        if (ast.kind === 'expectRunway' && ast.approach !== 'VISUAL' && info && !info.hasIls) hard('no_ils', REASONS.R20, 'R20');
        if (ast.kind === 'priority' && ctx.otherArrivalsOnFinal.length) soft(`${ctx.otherArrivalsOnFinal.join(', ')} on final will need breaking off`);
      }
      break;
    }
    case 'squawk': if (!/^[0-7]{4}$/.test(ast.code)) hard('invalid_param', 'Squawk must be four octal digits'); break;
    case 'giveWay': if (a && ast.to === a.callsign) hard('invalid_param', 'Cannot give way to self'); break;
    case 'runwayStatus': case 'reopenRunway': {
      checkRunwayExists(ast.runway);
      if (ast.kind === 'runwayStatus' && ast.status !== 'open') { const arr = ctx.arrivalOnFinal(ast.runway); if (arr && arr.nm < 4) soft(`Arrival ${arr.callsign} ${arr.nm.toFixed(1)} NM — will go around`); }
      if (ast.kind === 'reopenRunway') { const v = ctx.vehicleOnRunway?.(ast.runway); if (v) hard('runway_occupied', `Vehicle ${v} on runway`, 'R3'); }
      break;
    }
    case 'dispatchVehicle': {
      if (ast.target.kind === 'runway') {
        checkRunwayExists(ast.target.runway);
        const arr = ctx.arrivalOnFinal(ast.target.runway);
        const occ = ctx.runwayOccupant(ast.target.runway);
        if ((arr && arr.nm < 2) || (occ && !isVehicleId(occ))) soft('Runway in use — vehicle will hold short');
      }
      if (ctx.vehicles?.length) {
        const avail = ctx.vehicles.filter(v => v.available && (ast.ids.length ? ast.ids.includes(v.id) : v.type === ast.type));
        if (!avail.length) hard('vehicle_unavailable', REASONS.X17, 'X17');
      }
      break;
    }
    case 'vehicleOp': if (ast.op === 'cross' && ast.runway) { checkRunwayExists(ast.runway); const arr = ctx.arrivalOnFinal(ast.runway); if (arr && arr.nm < 2) hard('runway_occupied', reasonText('R4', { cs: arr.callsign, n: arr.nm.toFixed(1) }), 'R4'); } break;
    case 'holdPosition': case 'continue': case 'expedite': case 'windCheck': case 'continueApproach': case 'resumeSid': case 'ident':
    case 'radarContact': case 'sayAgain': case 'correction': case 'disregard': case 'standby': case 'unable': case 'report': case 'roger':
    case 'emergencyAck': case 'stopOnRunway': case 'emergencyCancelAck': case 'holdAll': case 'resumeAll': case 'recallVehicle': case 'broadcast': case 'sequence':
      break;
  }
  return { errors, warnings };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Undo model (UX §1.6, §G9)
// ──────────────────────────────────────────────────────────────────────────────
/** Undo window: the pilot delay is sacred (§1.1 rule 5); commands can be pre-empted for up to this many sim seconds, never after `applyAt`. */
export const UNDO_WINDOW_S = 10;
/** Real-time clamp so 4x sim rate still leaves a usable ring (§G3). */
export const UNDO_MIN_REAL_S = 1.5;

/** Previous targets captured BEFORE a command executes (undo restores targets, not the previous pending command — §G9). */
export interface UndoSnapshot {
  at: number;
  heading: number;
  altitude: number;
  speed: number | null;
  runway: string | null;
  onFrequency: Position;
  navMode: NavMode;
  directFix: string | null;
  holdFix: string | null;
  holdShortRunway: string | null;
  holdShortTaxiway: string | null;
  ilsArmed: boolean;
  landingCleared: boolean;
  takeoffCleared: boolean;
  expedite: boolean;
  exitTaxiway: string | null;
}

export function snapshotFor(a: AircraftState, time: number): UndoSnapshot {
  return {
    at: time, heading: Math.round(a.targetHeading), altitude: a.cmdAltitude ?? a.targetAltitude, speed: a.cmdIas,
    runway: a.assignedRunway ?? a.plan.runway ?? null, onFrequency: a.onFrequency, navMode: a.navMode,
    directFix: a.directTargetName, holdFix: a.holdFixName, holdShortRunway: a.holdShortRunway, holdShortTaxiway: a.holdShortTaxiway,
    ilsArmed: a.ilsArmed, landingCleared: a.landingCleared, takeoffCleared: a.takeoffCleared, expedite: a.expedite, exitTaxiway: a.exitTaxiway,
  };
}

/** True when the transmission shows an UNDO ring (pilot execution can be pre-empted). Sequences are all-or-nothing. */
export function undoable(ast: CommandAST): boolean {
  if (!isUndoable(ast)) return false;
  if (ast.kind === 'sequence') return ast.parts.every(p => !IMMEDIATE_KINDS.includes(p.kind));
  return !IMMEDIATE_KINDS.includes(ast.kind);
}

/** Whether undo is still available at `now` for a command issued at `issuedAt` (sim s) that executes at `applyAt` (null = queued without a known time). */
export function canUndo(issuedAt: number, now: number, applyAt: number | null = null, realElapsedS: number | null = null): boolean {
  if (now < issuedAt) return false;
  if (now - issuedAt > UNDO_WINDOW_S) return false;
  if (applyAt != null && now >= applyAt && (realElapsedS == null || realElapsedS >= UNDO_MIN_REAL_S)) return false;
  return true;
}

/** The transmission that pre-empts a pending command inside the window: "{cs}, disregard." (null for system / no-undo kinds). */
export function undoAst(ast: CommandAST): CommandAST | null {
  if (!undoable(ast) || !('callsign' in ast)) return null;
  return makeAst('disregard', ast.callsign, {});
}

/**
 * Restoring command AFTER execution (the explicit cancel leaves of §1.6): the
 * AST that returns the aircraft to `prev`. null when there is no radio inverse
 * (standby, report, wind check, go-around, ...). Sequences invert part by part
 * in reverse order and collapse to one transmission.
 */
export function inverse(ast: CommandAST, prev: UndoSnapshot): CommandAST | null {
  if (!('callsign' in ast)) return null;
  const cs = ast.callsign;
  if (ast.kind === 'sequence') {
    const parts: SingleAircraftCommand[] = [];
    for (const p of [...ast.parts].reverse()) {
      const inv = inverse(p, prev);
      if (inv && inv.kind !== 'sequence' && 'callsign' in inv && !parts.some(x => x.kind === inv.kind)) parts.push(inv);
    }
    return parts.length ? sequence(cs, sortParts(parts)) : null;
  }
  switch (ast.kind) {
    case 'heading': return makeAst('heading', cs, { hdg: prev.heading || 360, dir: null });
    case 'altitude': return makeAst('altitude', cs, { ft: prev.altitude, expedite: prev.expedite });
    case 'speed': return makeAst('speed', cs, { kts: prev.speed ?? 'resume' });
    case 'expedite': return makeAst('expedite', cs, { on: prev.expedite, scope: ast.scope });
    case 'direct': return prev.navMode === 'direct' && prev.directFix ? makeAst('direct', cs, { fix: prev.directFix }) : makeAst('heading', cs, { hdg: prev.heading || 360 });
    case 'hold': return prev.navMode === 'direct' && prev.directFix ? makeAst('direct', cs, { fix: prev.directFix }) : makeAst('heading', cs, { hdg: prev.heading || 360 });
    case 'ils': case 'loc': case 'visual': return prev.ilsArmed && prev.runway ? makeAst('ils', cs, { runway: prev.runway }) : makeAst('cancelApproach', cs, { hdg: prev.heading || 360, alt: prev.altitude });
    case 'cancelApproach': return prev.ilsArmed && prev.runway ? makeAst('ils', cs, { runway: prev.runway }) : null;
    case 'expectRunway': return prev.runway ? makeAst('expectRunway', cs, { runway: prev.runway, approach: ast.approach }) : null;
    case 'resumeSid': return makeAst('heading', cs, { hdg: prev.heading || 360 });
    case 'contact': return makeAst('contact', cs, { position: prev.onFrequency, when: 'now' });
    case 'holdShort': return makeAst('continue', cs, { holdShortOf: prev.holdShortRunway ? { kind: 'runway', runway: prev.holdShortRunway } : prev.holdShortTaxiway ? { kind: 'taxiway', taxiway: prev.holdShortTaxiway } : null });
    case 'holdPosition': return makeAst('continue', cs, {});
    case 'continue': return makeAst('holdPosition', cs, {});
    case 'cross': return makeAst('holdShort', cs, { of: { kind: 'runway', runway: ast.runway } });
    case 'taxi': case 'pushback': case 'startup': return makeAst('holdPosition', cs, { reason: ast.kind === 'pushback' ? 'stop pushback' : null });
    case 'lineup': return makeAst('cancelLineup', cs, {});
    case 'takeoff': return makeAst('cancelTakeoff', cs, {});
    case 'clearedLand': return makeAst('continueApproach', cs, {});
    case 'exitAt': return prev.exitTaxiway ? makeAst('exitAt', cs, { exit: prev.exitTaxiway === 'L' || prev.exitTaxiway === 'R' ? { kind: 'next', dir: prev.exitTaxiway } : { kind: 'taxiway', taxiway: prev.exitTaxiway } }) : null;
    case 'giveWay': return makeAst('continue', cs, {});
    default: return null;
  }
}

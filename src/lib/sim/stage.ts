// ============================================================
//  Stage derivation — UX 04 §G1 (AUTHORITATIVE) implemented exactly.
//
//  `phase` is physics; `Stage` is what the UI, the action matrix, the strip
//  bays and the tests gate on. stage() is pure: it reads the aircraft plus a
//  minimal StageCtx the engine provides (threshold distance + hold-node
//  lookup). Unit-test target: one case per row of the §G1 table.
// ============================================================
import type { AircraftState, FlightKind, PlayerPosition, Stage } from './types';
import { NM_TO_M } from './projection';

/** Minimal engine view needed to derive a stage. SimEngine implements this (W1-ENGINE). */
export interface StageCtx {
  /**
   * Distance from the aircraft to the threshold of runway end `runway`, in NM,
   * measured along the approach track when on the ILS, else straight-line.
   * null when the runway is unknown.
   */
  distToThresholdNM(a: AircraftState, runway: string): number | null;
  /**
   * True when graph node `nodeId` is a hold-short place protecting runway end
   * `runway` (either end name of the same physical runway counts).
   */
  isHoldNodeForRunway(nodeId: string, runway: string): boolean;
}

/** Short-final threshold (UX §G1: arr_final vs arr_short_final). */
export const SHORT_FINAL_NM = 4;
/** Takeoff roll -> takeoff air split (ft AGL). */
export const TAKEOFF_AIR_FT = 50;

const AIR_PHASES = new Set(['climb', 'cruise', 'descent', 'approach', 'go_around', 'landing']);

export function isAirbornePhase(phase: AircraftState['phase']): boolean { return AIR_PHASES.has(phase); }

/**
 * Derive the UI stage. Rules (in order):
 *  1. parked/startup/pushback/lineup/rollout/arrived/departed -> same name.
 *  2. taxi -> taxi_out (departure) / taxi_in (arrival).
 *  3. hold_short -> hold_short_dep when the hold node protects plan.runway of a
 *     departure; else hold_short_cross. Fallbacks when the engine has not set
 *     holdShortNode: compare holdShortRunway to plan.runway; then by kind.
 *  4. takeoff -> takeoff_roll (< 50 ft AGL) / takeoff_air.
 *  5. go_around phase or a.goAround flag -> go_around.
 *  6. Airborne departure -> dep_climb (altitude < target - 50) / dep_level.
 *     A departure that has been cleared an approach (ilsArmed / landing phase,
 *     i.e. an emergency return) uses the arrival rules below.
 *  7. Airborne arrival: landing phase -> arr_final (> 4 NM to threshold) /
 *     arr_short_final; else ilsCaptured -> arr_established; ilsArmed ->
 *     arr_armed; otherwise arr_inbound.
 */
export function stage(a: AircraftState, ctx: StageCtx): Stage {
  const kind: FlightKind = a.plan.kind;
  switch (a.phase) {
    case 'parked': return 'parked';
    case 'startup': return 'startup';
    case 'pushback': return 'pushback';
    case 'lineup': return 'lineup';
    case 'rollout': return 'rollout';
    case 'arrived': return 'arrived';
    case 'departed': return 'departed';
    case 'taxi': return kind === 'departure' ? 'taxi_out' : 'taxi_in';
    case 'hold_short': return holdShortStage(a, ctx);
    case 'takeoff': return a.altitude < TAKEOFF_AIR_FT ? 'takeoff_roll' : 'takeoff_air';
    case 'go_around': return 'go_around';
    default: break;
  }
  // airborne
  if (a.goAround) return 'go_around';
  const returning = a.ilsArmed || a.phase === 'landing' || a.phase === 'approach';
  if (kind === 'departure' && !returning) {
    return a.altitude < a.targetAltitude - 50 ? 'dep_climb' : 'dep_level';
  }
  if (a.phase === 'landing') {
    const rwy = a.plan.runway ?? a.assignedRunway;
    const d = rwy ? ctx.distToThresholdNM(a, rwy) : null;
    return d != null && d > SHORT_FINAL_NM ? 'arr_final' : 'arr_short_final';
  }
  if (a.ilsCaptured) return 'arr_established';
  if (a.ilsArmed) return 'arr_armed';
  return 'arr_inbound';
}

function holdShortStage(a: AircraftState, ctx: StageCtx): Stage {
  const dep = a.plan.kind === 'departure';
  if (a.holdShortNode && a.plan.runway) {
    return dep && ctx.isHoldNodeForRunway(a.holdShortNode, a.plan.runway) ? 'hold_short_dep' : 'hold_short_cross';
  }
  if (a.holdShortRunway && a.plan.runway) {
    return dep && sameRunwayEnd(a.holdShortRunway, a.plan.runway) ? 'hold_short_dep' : 'hold_short_cross';
  }
  return dep ? 'hold_short_dep' : 'hold_short_cross';
}

function sameRunwayEnd(a: string, b: string): boolean { return a.toUpperCase() === b.toUpperCase(); }

// ──────────────────────────────────────────────────────────────────────────────
//  Classification helpers
// ──────────────────────────────────────────────────────────────────────────────
export const GROUND_STAGES: readonly Stage[] = ['parked', 'startup', 'pushback', 'taxi_out', 'taxi_in', 'hold_short_dep', 'hold_short_cross', 'lineup', 'takeoff_roll', 'rollout', 'arrived'];
export const AIR_STAGES: readonly Stage[] = ['takeoff_air', 'dep_climb', 'dep_level', 'go_around', 'arr_inbound', 'arr_armed', 'arr_established', 'arr_final', 'arr_short_final', 'departed'];
export function isGroundStage(s: Stage): boolean { return GROUND_STAGES.includes(s); }
export function isAirStage(s: Stage): boolean { return AIR_STAGES.includes(s); }
export function isArrivalStage(s: Stage): boolean { return s.startsWith('arr_') || s === 'rollout' || s === 'taxi_in' || s === 'arrived' || s === 'go_around'; }
export function isDepartureStage(s: Stage): boolean { return !isArrivalStage(s) && s !== 'hold_short_cross'; }

/** Distance to threshold in NM from the aircraft's own landing path (helper for engines/tests). */
export function distToThresholdFromPathNM(a: AircraftState): number | null {
  if (!a.path || a.phase !== 'landing') return null;
  return Math.max(0, a.thresholdDist - a.distAlong) / NM_TO_M;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Labels for UI badges (short = strip chip, long = tooltip / panel)
// ──────────────────────────────────────────────────────────────────────────────
export type StageTone = 'neutral' | 'ground' | 'air' | 'warn' | 'danger';
export interface StageLabel { short: string; long: string; tone: StageTone }

const LABELS: Record<Stage, StageLabel> = {
  parked: { short: 'PARKED', long: 'Parked at stand, engines off', tone: 'neutral' },
  startup: { short: 'START', long: 'Engines starting, stationary', tone: 'ground' },
  pushback: { short: 'PUSH', long: 'Pushing back on the tug', tone: 'ground' },
  taxi_out: { short: 'TAXI', long: 'Taxiing out to the runway', tone: 'ground' },
  taxi_in: { short: 'TAXI IN', long: 'Taxiing in to the stand', tone: 'ground' },
  hold_short_dep: { short: 'HOLD', long: 'Holding short of the departure runway', tone: 'ground' },
  hold_short_cross: { short: 'XING', long: 'Holding short to cross a runway', tone: 'warn' },
  lineup: { short: 'LUAW', long: 'Lined up and waiting on the runway', tone: 'warn' },
  takeoff_roll: { short: 'ROLL', long: 'Takeoff roll', tone: 'warn' },
  takeoff_air: { short: 'T/O', long: 'Airborne, initial climb', tone: 'air' },
  rollout: { short: 'RLT', long: 'Landed, rolling out', tone: 'warn' },
  arrived: { short: 'STAND', long: 'On stand, engines shut down', tone: 'neutral' },
  dep_climb: { short: 'CLB', long: 'Departure climbing', tone: 'air' },
  dep_level: { short: 'LVL', long: 'Departure level', tone: 'air' },
  go_around: { short: 'GA', long: 'Going around / missed approach', tone: 'danger' },
  arr_inbound: { short: 'INB', long: 'Arrival inbound, no approach clearance', tone: 'air' },
  arr_armed: { short: 'ILS', long: 'Approach clearance issued, intercepting', tone: 'air' },
  arr_established: { short: 'EST', long: 'Established on the approach', tone: 'air' },
  arr_final: { short: 'FINAL', long: 'On final, more than 4 NM', tone: 'air' },
  arr_short_final: { short: 'SHORT', long: 'Short final, 4 NM or less', tone: 'warn' },
  departed: { short: 'DEP', long: 'Handed off / left the airspace', tone: 'neutral' },
};

export function stageLabel(s: Stage): StageLabel { return LABELS[s]; }

// ──────────────────────────────────────────────────────────────────────────────
//  Strip bay mapping (UX 04 §G7). Returns null when the strip is not shown in
//  that position's bay. `handedOff` = the aircraft is on a frequency owned by a
//  later position than `position` (ghost strips are the UI's concern).
// ──────────────────────────────────────────────────────────────────────────────
export type BayId =
  | 'PENDING' | 'PUSH_START' | 'TAXI_OUT' | 'AT_HOLD' | 'TAXI_IN' | 'AT_STAND' | 'VEHICLES'
  | 'LINED_UP' | 'ROLLING_AIRBORNE' | 'FINAL' | 'LANDED_ROLLOUT' | 'TO_GROUND'
  | 'INBOUND' | 'SEQUENCE' | 'ESTABLISHED' | 'TO_TOWER' | 'CLIMB_OUT' | 'HANDED_OFF';

export function bayFor(a: AircraftState, s: Stage, position: PlayerPosition): BayId | null {
  const dep = a.plan.kind === 'departure';
  const onTower = a.onFrequency === 'tower';
  const onApp = a.onFrequency === 'approach' || a.onFrequency === 'departure';
  if (position === 'ground') {
    switch (s) {
      case 'parked': case 'startup': return a.pushback.stage === 'none' && a.startup.startedAt == null ? 'PENDING' : 'PUSH_START';
      case 'pushback': return 'PUSH_START';
      case 'taxi_out': return 'TAXI_OUT';
      case 'hold_short_cross': return dep ? 'TAXI_OUT' : 'TAXI_IN';
      case 'hold_short_dep': return onTower ? null : 'AT_HOLD';
      case 'taxi_in': return 'TAXI_IN';
      case 'arrived': return 'AT_STAND';
      default: return null;
    }
  }
  if (position === 'tower') {
    switch (s) {
      case 'hold_short_dep': return 'AT_HOLD';
      case 'lineup': return 'LINED_UP';
      case 'takeoff_roll': case 'takeoff_air': return 'ROLLING_AIRBORNE';
      case 'dep_climb': case 'dep_level': return onApp ? null : 'ROLLING_AIRBORNE';
      case 'arr_established': case 'arr_final': case 'arr_short_final': return onTower ? 'FINAL' : null;
      case 'go_around': return onTower ? 'FINAL' : null;
      case 'rollout': return 'LANDED_ROLLOUT';
      case 'taxi_in': case 'hold_short_cross': return dep ? null : 'TO_GROUND';
      default: return null;
    }
  }
  switch (s) {
    case 'dep_climb': case 'dep_level': case 'takeoff_air': return onApp ? 'CLIMB_OUT' : null;
    case 'departed': return 'HANDED_OFF';
    case 'arr_inbound': return 'INBOUND';
    case 'arr_armed': return 'SEQUENCE';
    case 'arr_established': return onTower ? 'TO_TOWER' : 'ESTABLISHED';
    case 'arr_final': case 'arr_short_final': return 'TO_TOWER';
    case 'go_around': return onTower ? null : 'SEQUENCE';
    default: return null;
  }
}

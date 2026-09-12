// ============================================================
//  Command tree — UX 04 §G2 action matrix as DATA + pickers + toAst + hotkeys.
//
//  Ownership: W0 wrote the contract (types, matrix, reasons, steps, toAst,
//  hotkeys). W1-COMMANDS owns this file from Wave 1: refine dynamic rules,
//  soft-warning texts and picker candidate lists; do NOT rename ids/reasons
//  (tests assert them verbatim via data-testid / data-reason).
//
//  actionsFor(a, ctx) returns rows in panel order for the aircraft's stage:
//    - rows whose matrix cell is hidden ('-') are NOT returned
//    - 'on' rows come back state 'enabled'
//    - 'off:Rn' rows come back state 'disabled' with the canonical reason text
//    - 'dyn:rule' rows are decided by DYNAMIC_RULES[rule](a, ctx) at call time
//  Everything the rules need is passed in ActionCtx (built by the store from
//  the engine) so this module has no engine import and is unit-testable.
// ============================================================
import type { AircraftState, PilotRequest, PlayerPosition, Position, RunwayStatus, Stage, VehicleTarget, VehicleType } from './types';
import { ALL_STAGES } from './types';
import type {
  ApproachType, CommandAST, ContactWhen, CorrectionField, EmergencyInfoKind, ExitSpec, HoldAllScope, HoldShortTarget,
  PushDir, ReportKind, SingleAircraftCommand, TaxiDest, TurnDir, UnableReason,
} from './commandAst';
import { makeAst, sequence, sortParts } from './commandAst';
import { isGroundStage, isAirStage } from './stage';

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
//  matrix uses, X1-X13). `{...}` placeholders are filled by reasonText().
// ──────────────────────────────────────────────────────────────────────────────
export type ReasonCode =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12' | 'R13' | 'R14' | 'R15'
  | 'R16' | 'R17' | 'R18' | 'R19' | 'R20' | 'R21' | 'R22' | 'R23' | 'R24'
  | 'X1' | 'X2' | 'X3' | 'X4' | 'X5' | 'X6' | 'X7' | 'X8' | 'X9' | 'X10' | 'X11' | 'X12' | 'X13';

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
};

export function reasonText(code: ReasonCode, params: Record<string, string | number | null | undefined> = {}): string {
  return REASONS[code].replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

// ──────────────────────────────────────────────────────────────────────────────
//  Context the rules read (built by the store from the engine for ONE aircraft)
// ──────────────────────────────────────────────────────────────────────────────
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

/** The §G2 matrix (spec glyphs: on = enabled, off:Rn = disabled with reason, dyn = iff clause, '-' = hidden). Columns = ALL_STAGES (21; dep_climb/dep_level split; `departed` all hidden). */
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
    startup: 'dyn:handoff_ground', taxi_out: 'dyn:handoff_taxi_out', taxi_in: 'on', hold_short_dep: 'on', hold_short_cross: 'on',
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
  'emerg-ack': row('dyn:emerg', {}),
  'emerg-priority': row('dyn:emerg_air', {}),
  'emerg-dispatch': row('dyn:emerg', {}),
  'emerg-hold-all': row('dyn:emerg', {}),
  'emerg-breakoff': row('dyn:emerg_breakoff', {}),
  'emerg-stop-runway': row('-', { arr_final: 'dyn:emerg_stop', arr_short_final: 'dyn:emerg_stop', rollout: 'dyn:emerg_stop' }),
  'emerg-reopen': row('dyn:emerg_reopen', {}),
  'emerg-cancel-ack': row('dyn:emerg_cancel', {}),
  'emerg-resume-all': row('dyn:emerg_resume', {}),
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
  continue_pushback: a => (a.pushback.stage === 'paused' ? enabled : hidden),
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

// ──────────────────────────────────────────────────────────────────────────────
//  Picker steps (UX §1.2 / §G4). Each step id doubles as the ActionParams key.
// ──────────────────────────────────────────────────────────────────────────────
interface StepBase { id: string; label: string; optional: boolean }
export type PickerStep =
  | (StepBase & { type: 'runway'; mode: 'takeoff' | 'landing' | 'ils' | 'expect' | 'taxi' | 'cross' | 'priority' | 'lahso' | 'reopen' | 'change'; default: string | null; locked: boolean; approachModes: boolean })
  | (StepBase & { type: 'taxiway-route'; destKind: TaxiDest['kind']; auto: boolean; allowHoldShort: boolean; allowCross: boolean; allowIntersection: boolean; contactTowerChip: boolean })
  | (StepBase & { type: 'heading'; default: number | null; allowDir: boolean; presets: Array<'runway' | 'current'> })
  | (StepBase & { type: 'altitude'; default: number | null; min: number; max: number; expediteToggle: boolean; halfSteps: boolean })
  | (StepBase & { type: 'speed'; default: number | null; min: number; max: number; presets: Array<'final' | 'resume' | 'until4'> })
  | (StepBase & { type: 'fix'; default: string | null })
  | (StepBase & { type: 'hold'; defaultInbound: number | null })
  | (StepBase & { type: 'direction'; options: Array<'L' | 'R' | 'N' | 'E' | 'S' | 'W' | 'any'>; default: 'L' | 'R' | 'N' | 'E' | 'S' | 'W' | 'any' | null })
  | (StepBase & { type: 'taxiway'; mode: 'exit' | 'hold' | 'intersection' | 'vacate'; default: string | null; nextExitChips: boolean })
  | (StepBase & { type: 'gate'; default: string | null })
  | (StepBase & { type: 'aircraft'; mode: 'behind_landing' | 'give_way' | 'follow' | 'break_off' })
  | (StepBase & { type: 'vehicle'; multi: boolean; preselect: VehicleType[] })
  | (StepBase & { type: 'position'; default: Position | null; when: ContactWhen })
  | (StepBase & { type: 'text'; options: Array<{ value: string; label: string }>; multi: boolean; default: string[] })
  | (StepBase & { type: 'confirm'; parts: PartChip[] });

/** "+ ADD PART" chips offered on the confirm step (UX §1.5). */
export type PartChip = 'then_ils' | 'when_passing_alt' | 'after_fix' | 'descend_to' | 'speed' | 'report_established' | 'immediate' | 'after_dep_hdg' | 'turn_lr' | 'climb_to' | 'contact_on_reaching' | 'wind' | 'behind_landing' | 'traffic_final' | 'lahso' | 'exit_at' | 'next_exit' | 'via' | 'hold_short_of' | 'cross_runway' | 'intersection' | 'contact_tower_at_hold' | 'expect_runway' | 'face' | 'then_taxi' | 'fly_heading' | 'runway_heading' | 'contact' | 'expedite';

const S = {
  runway: (id: string, label: string, mode: Extract<PickerStep, { type: 'runway' }>['mode'], def: string | null, locked = false, optional = false, approachModes = false): PickerStep => ({ id, label, type: 'runway', mode, default: def, locked, optional, approachModes }),
  route: (id: string, label: string, destKind: TaxiDest['kind'], opts: Partial<Extract<PickerStep, { type: 'taxiway-route' }>> = {}): PickerStep => ({ id, label, type: 'taxiway-route', destKind, auto: true, allowHoldShort: true, allowCross: true, allowIntersection: true, contactTowerChip: destKind === 'runway', optional: false, ...opts }),
  heading: (id: string, label: string, def: number | null, opts: Partial<Extract<PickerStep, { type: 'heading' }>> = {}): PickerStep => ({ id, label, type: 'heading', default: def, allowDir: true, presets: [], optional: false, ...opts }),
  altitude: (id: string, label: string, def: number | null, opts: Partial<Extract<PickerStep, { type: 'altitude' }>> = {}): PickerStep => ({ id, label, type: 'altitude', default: def, min: 1000, max: 20000, expediteToggle: true, halfSteps: false, optional: false, ...opts }),
  speed: (id: string, label: string, def: number | null, opts: Partial<Extract<PickerStep, { type: 'speed' }>> = {}): PickerStep => ({ id, label, type: 'speed', default: def, min: 140, max: 300, presets: ['final', 'resume'], optional: false, ...opts }),
  fix: (id: string, label: string, def: string | null): PickerStep => ({ id, label, type: 'fix', default: def, optional: false }),
  hold: (id: string, label: string, defaultInbound: number | null): PickerStep => ({ id, label, type: 'hold', defaultInbound, optional: false }),
  direction: (id: string, label: string, options: Extract<PickerStep, { type: 'direction' }>['options'], def: Extract<PickerStep, { type: 'direction' }>['default'], optional = false): PickerStep => ({ id, label, type: 'direction', options, default: def, optional }),
  taxiway: (id: string, label: string, mode: Extract<PickerStep, { type: 'taxiway' }>['mode'], def: string | null, optional = false, nextExitChips = false): PickerStep => ({ id, label, type: 'taxiway', mode, default: def, optional, nextExitChips }),
  gate: (id: string, label: string, def: string | null): PickerStep => ({ id, label, type: 'gate', default: def, optional: false }),
  aircraft: (id: string, label: string, mode: Extract<PickerStep, { type: 'aircraft' }>['mode'], optional = false): PickerStep => ({ id, label, type: 'aircraft', mode, optional }),
  vehicle: (id: string, label: string, preselect: VehicleType[], multi = true): PickerStep => ({ id, label, type: 'vehicle', multi, preselect, optional: false }),
  position: (id: string, label: string, def: Position | null, when: ContactWhen = 'now'): PickerStep => ({ id, label, type: 'position', default: def, when, optional: false }),
  text: (id: string, label: string, options: Array<{ value: string; label: string }>, multi = false, def: string[] = [], optional = false): PickerStep => ({ id, label, type: 'text', options, multi, default: def, optional }),
  confirm: (parts: PartChip[] = []): PickerStep => ({ id: 'confirm', label: 'Confirm', type: 'confirm', parts, optional: false }),
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

/** Picker steps for an action, with defaults resolved from the aircraft (UX §1.4 tables). */
export function stepsFor(id: ActionId, a: AircraftState, ctx: ActionCtx): PickerStep[] {
  const rwy = a.plan.runway ?? a.assignedRunway ?? null;
  const air = isAirStage(ctx.stage);
  switch (id) {
    case 'action-pushback': return [S.runway('runway', 'Expect runway', 'expect', rwy), S.direction('direction', 'Facing', ['any', 'N', 'E', 'S', 'W'], 'any', true), S.confirm(['expect_runway', 'face', 'then_taxi'])];
    case 'action-startup': return [S.runway('runway', 'Expect runway', 'expect', rwy), S.confirm(['expect_runway'])];
    case 'action-taxi-runway': return [S.runway('runway', ctx.stage === 'taxi_out' ? 'Runway (amend)' : 'Runway', 'taxi', rwy), S.route('route', 'Route', 'runway'), S.confirm(['via', 'hold_short_of', 'cross_runway', 'intersection', 'contact_tower_at_hold'])];
    case 'action-taxi-stand': return [S.gate('stand', 'Stand', a.plan.gateRef ?? a.reservedStand), S.route('route', 'Route', 'stand', { contactTowerChip: false }), S.confirm(['via', 'hold_short_of', 'cross_runway'])];
    case 'action-taxi-point': return [S.taxiway('taxiway', 'Taxiway', 'intersection', null), S.taxiway('taxiway2', 'Intersecting taxiway', 'intersection', null), S.route('route', 'Route', 'node', { contactTowerChip: false }), S.confirm(['via', 'hold_short_of'])];
    case 'action-amend-route': return [S.route('route', 'Amend route', a.plan.kind === 'departure' ? 'runway' : 'stand'), S.confirm(['via', 'hold_short_of', 'cross_runway'])];
    case 'action-hold-short': return [S.text('chips', 'Hold short of', [{ value: 'next', label: ctx.nextCrossingRunway ? `Runway ${ctx.nextCrossingRunway}` : 'Next runway on route' }, { value: 'runway', label: 'Runway...' }, { value: 'taxiway', label: 'Taxiway...' }, { value: 'here', label: 'Here' }], false, ['next']), S.confirm()];
    case 'action-hold-position': return ctx.stage === 'lineup'
      ? [S.text('chips', 'Reason', [{ value: 'traffic_final', label: 'Traffic on final' }, { value: 'wake', label: 'Wake' }, { value: 'crossing', label: 'Crossing traffic' }], false, [], true), S.confirm()]
      : [S.confirm()];
    case 'action-hold-fix': return [S.hold('hold', 'Holding pattern', a.holdInboundHdg || null), S.confirm()];
    case 'action-continue': return [S.confirm(['hold_short_of'])];
    case 'action-cross': return [S.runway('runway', 'Cross runway', 'cross', ctx.nextCrossingRunway ?? a.holdShortRunway, true), S.text('chips', 'Options', [{ value: 'expedite', label: 'Expedite' }], true, [], true), S.confirm(['expedite'])];
    case 'action-lineup': return [S.runway('runway', 'Runway', 'takeoff', rwy, true), S.aircraft('aircraft', 'Behind landing aircraft', 'behind_landing', true), S.confirm(['behind_landing', 'traffic_final'])];
    case 'action-takeoff': return [S.runway('runway', 'Runway', 'takeoff', rwy, true), S.confirm(['immediate', 'after_dep_hdg', 'turn_lr', 'climb_to', 'contact_on_reaching', 'wind'])];
    case 'action-cancel-takeoff': return [S.confirm()];
    case 'action-cancel-lineup': return [S.taxiway('taxiway', 'Vacate via', 'vacate', null, true, true), S.confirm()];
    case 'action-land': return [S.runway('runway', 'Runway', 'landing', rwy, true), S.confirm(['wind', 'lahso', 'exit_at', 'next_exit'])];
    case 'action-goaround': return [S.confirm(['fly_heading', 'runway_heading', 'climb_to', 'contact'])];
    case 'action-cancel-approach': return [S.heading('heading', 'Heading', null), S.altitude('altitude', 'Altitude', Math.max(3000, Math.ceil(a.altitude / 1000) * 1000)), S.confirm()];
    case 'action-exit': return [S.taxiway('taxiway', 'Exit at', 'exit', a.exitTaxiway, false, true), S.text('chips', 'Options', [{ value: 'expedite', label: 'Expedite, traffic on short final' }], true, [], true), S.confirm(['expedite', 'hold_short_of', 'contact'])];
    case 'action-plan-exit': return [S.taxiway('taxiway', 'Plan to vacate at', 'exit', a.exitTaxiway, false, true), S.confirm()];
    case 'action-heading': return [S.heading('heading', 'Heading', Math.round(a.cmdAltitude != null ? a.targetHeading : a.heading), { presets: ['runway', 'current'] }), S.confirm(['climb_to', 'speed', 'then_ils', 'when_passing_alt', 'after_fix'])];
    case 'action-altitude': return [S.altitude('altitude', 'Altitude', a.plan.kind === 'departure' ? Math.max(a.clearance.initialAlt, Math.ceil((a.altitude + 1) / 1000) * 1000) : Math.max(1000, Math.floor((a.altitude - 1) / 1000) * 1000), { max: a.plan.kind === 'departure' ? 13000 : 20000 }), S.confirm(['fly_heading', 'speed', 'then_ils', 'when_passing_alt'])];
    case 'action-speed': {
      const est = ctx.stage === 'arr_established' || ctx.stage === 'arr_final';
      return [S.speed('speed', 'Speed', a.cmdIas ?? Math.round(a.targetSpeed / 10) * 10, { min: est ? a.perf.approachSpeed : a.perf.minAirspeedTMA, max: est ? 210 : a.perf.maxAirspeedTMA, presets: est ? ['final', 'until4', 'resume'] : ['final', 'resume'] }), S.confirm(['fly_heading', 'climb_to'])];
    }
    case 'action-direct': return [S.fix('fix', 'Direct to', a.plan.fix ?? null), S.confirm(['climb_to', 'speed'])];
    case 'action-resume-sid': return [S.confirm()];
    case 'action-ils': return [S.runway('runway', 'Approach runway', 'ils', rwy, false, false, true), S.confirm(['descend_to', 'speed', 'report_established'])];
    case 'action-expect-runway': return [S.runway('runway', 'Expect runway', 'expect', rwy, false, false, true), S.confirm()];
    case 'action-change-runway': return [S.runway('runway', 'Change to runway', 'change', null), S.confirm()];
    case 'action-expedite': return [S.confirm()];
    case 'action-handoff': return [S.position('position', 'Contact', null, ctx.stage === 'rollout' ? 'when_vacated' : 'now'), S.confirm()];
    case 'action-report': return [S.text('chips', 'Report', air ? INFO_CHIPS_AIR : INFO_CHIPS_GROUND, true, [air ? 'heading' : 'position']), S.confirm()];
    case 'action-say-again': return [S.confirm()];
    case 'action-correction': return [S.text('chips', 'Correct', [{ value: 'heading', label: 'Heading' }, { value: 'altitude', label: 'Altitude' }, { value: 'speed', label: 'Speed' }, { value: 'runway', label: 'Runway' }, { value: 'squawk', label: 'Squawk' }, { value: 'frequency', label: 'Frequency' }, { value: 'taxiway', label: 'Taxiway' }], false, [a.readback.mismatch?.field ?? 'heading']), S.confirm()];
    case 'action-standby': return [S.confirm()];
    case 'action-unable': return [S.text('chips', 'Reason', UNABLE_CHIPS, false, ['traffic']), S.confirm()];
    case 'action-giveway': return [S.aircraft('aircraft', 'Give way to / follow', 'give_way'), S.text('chips', 'Mode', [{ value: 'give_way', label: 'Give way' }, { value: 'follow', label: 'Follow' }], false, ['give_way']), S.confirm()];
    case 'action-wind-check': return [S.confirm()];
    case 'action-turnaround': return [S.runway('runway', 'Departure runway', 'takeoff', rwy), S.text('chips', 'Delay', [{ value: '20', label: '20 min' }, { value: '35', label: '35 min' }, { value: '60', label: '60 min' }], false, ['35']), S.confirm()];
    case 'emerg-ack': return [S.text('chips', 'Ask for', [{ value: 'pob', label: 'POB' }, { value: 'fuel', label: 'Fuel' }, { value: 'nature', label: 'Nature' }, { value: 'dg', label: 'Dangerous goods' }, { value: 'intentions', label: 'Intentions' }], true, ['pob', 'fuel', 'intentions']), S.confirm()];
    case 'emerg-priority': return [S.runway('runway', 'Priority runway', 'priority', a.emergency?.runway ?? rwy), S.text('chips', 'Options', [{ value: 'straight_in', label: 'Straight-in' }, { value: 'number_one', label: 'Number one' }, { value: 'sterile', label: 'Runway sterile' }], true, ['number_one']), S.confirm()];
    case 'emerg-dispatch': return [S.vehicle('vehicles', 'Vehicles', a.emergency?.type === 'medical' ? ['arff', 'ambulance'] : ['arff']), S.text('chips', 'Location', [{ value: 'runway', label: `Runway ${a.emergency?.runway ?? rwy ?? ''}`.trim() }, { value: 'aircraft', label: 'Aircraft position' }, { value: 'stand', label: 'Gate' }, { value: 'map', label: 'Map point' }], false, ['runway']), S.confirm()];
    case 'emerg-hold-all': return [S.text('chips', 'Scope', [{ value: 'departures', label: `Departures ${rwy ?? ''}`.trim() }, { value: 'crossings', label: 'Crossings' }, { value: 'all', label: 'All ground movement' }], false, ['departures']), S.confirm()];
    case 'emerg-breakoff': return [S.aircraft('aircraft', 'Break off', 'break_off'), S.heading('heading', 'Heading', null), S.altitude('altitude', 'Altitude', 4000), S.confirm()];
    case 'emerg-stop-runway': return [S.text('chips', 'After landing', [{ value: 'stop', label: 'Stop on the runway' }, { value: 'vacate_if_able', label: 'Vacate if able' }], false, ['stop']), S.taxiway('taxiway', 'Vacate via', 'vacate', null, true, true), S.confirm()];
    case 'emerg-reopen': return [S.runway('runway', 'Reopen runway', 'reopen', ctx.emergencyClosedRunway), S.text('chips', 'Options', [{ value: 'after_inspection', label: 'After inspection' }], true, ['after_inspection'], true), S.confirm()];
    case 'emerg-cancel-ack': return [S.confirm()];
    case 'emerg-resume-all': return [S.confirm()];
  }
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
  /** Resolved hotkey for this stage (null = none). Chords are "M,A". */
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
 * sims get X12; an emergency hold-all order disables movement rows with R24.
 */
export function actionsFor(a: AircraftState, ctx: ActionCtx): ActionRow[] {
  const rows: ActionRow[] = [];
  const offFreq = ctx.strictFrequencies && a.onFrequency !== 'external' && ownerOf(a.onFrequency) !== ctx.position;
  const primaryId = ctx.pendingRequest ? (ctx.pendingRequest.suggestedAction ?? REQUEST_ANSWER[ctx.pendingRequest.kind] ?? null) : (a.emergency && a.emergency.status === 'declared' ? 'emerg-ack' : null);
  for (const id of ALL_ACTION_IDS) {
    let cell = evaluateCell(id, a, ctx);
    if (cell.state === 'hidden') continue;
    if (cell.state === 'enabled') {
      if (ctx.paused) cell = disabled('X12');
      else if (offFreq) cell = disabled('R13');
      else if (ctx.holdAllActive && HELD_BY_EMERGENCY.includes(id)) cell = disabled('R24');
    }
    const def = ACTION_DEFS[id];
    const params = { rwy: a.plan.runway ?? a.assignedRunway ?? '', ref: a.plan.gateRef ?? '', cls: a.perf.weightClass, ...(cell.params ?? {}) };
    rows.push({
      id, label: def.label, hotkey: hotkeyFor(id, ctx.stage), group: def.group,
      state: cell.state === 'enabled' ? 'enabled' : 'disabled',
      reason: cell.reason, reasonText: cell.reason ? reasonText(cell.reason, params) : '',
      soft: softWarnings(id, a, ctx),
      steps: stepsFor(id, a, ctx),
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
  }
  if (id === 'action-land' && rwy) {
    const occ = ctx.runwayOccupant(rwy);
    if (occ) out.push(reasonText('R3', { rwy, occ }));
    if (!ctx.runwayActive(rwy, 'arr')) out.push(reasonText('R22', { rwy, role: 'arr' }));
  }
  if (id === 'action-handoff' && ctx.stage === 'dep_climb' && a.altitude < 9000 && a.navMode !== 'sid') out.push('Below FL90 with SID off — counts as diversion');
  if (id === 'action-hold-position' && ctx.stage === 'lineup' && rwy) {
    const arr = ctx.arrivalOnFinal(rwy);
    if (arr && arr.nm < 2) out.push('Arrival inside 2 NM — consider Vacate');
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Hotkeys (UX §1.3 + §G2 collision rules + §G6)
// ──────────────────────────────────────────────────────────────────────────────
/** Resolved letter for an action in a stage; null when another action owns the letter there. */
export function hotkeyFor(id: ActionId, stage: Stage): string | null {
  const key = ACTION_DEFS[id].key;
  if (!key) return null;
  const ground = isGroundStage(stage);
  switch (key) {
    case 'T': {
      const owner: ActionId = stage === 'taxi_out' ? 'action-amend-route'
        : stage === 'startup' || stage === 'pushback' || stage === 'parked' ? 'action-taxi-runway'
          : stage === 'taxi_in' || stage === 'rollout' ? 'action-taxi-stand'
            : stage === 'hold_short_dep' || stage === 'hold_short_cross' ? 'action-taxi-runway' : 'action-taxi-runway';
      return id === owner ? 'T' : null;
    }
    case 'H': {
      const owner: ActionId = stage === 'lineup' ? 'action-hold-position' : ground ? 'action-hold-short' : 'action-hold-fix';
      if (id === owner) return 'H';
      // hold-position keeps H where hold-short is not rendered (startup/pushback/rollout)
      if (id === 'action-hold-position' && ['startup', 'pushback', 'rollout', 'hold_short_dep', 'hold_short_cross'].includes(stage)) return 'H';
      return null;
    }
    case 'X': return id === 'action-cross' ? 'X' : id === 'action-continue' ? 'X' : null; // resolveHotkey prefers cross when both visible
    case 'I': {
      const owner: ActionId = stage === 'arr_inbound' ? 'action-ils' : stage === 'arr_armed' || stage === 'arr_established' ? 'action-change-runway' : 'action-ils';
      return id === owner ? 'I' : null;
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
    case 'A': return id === 'action-altitude' ? 'A' : null; // expedite is A -> E
    case 'P': return id === 'action-pushback' || id === 'action-startup' ? 'P' : null;
    default: return key;
  }
}

/** Which visible row a key press (letter or "M,x" chord) activates; X prefers cross over continue. */
export function resolveHotkey(key: string, rows: ActionRow[]): ActionRow | null {
  const k = key.toUpperCase();
  const hits = rows.filter(r => r.hotkey === k);
  if (!hits.length) return null;
  if (k === 'X') return hits.find(r => r.id === 'action-cross') ?? hits[0];
  return hits[0];
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
    case 'action-pushback': return withParts(makeAst('pushback', cs, { dir: (params.direction as PushDir) ?? 'any', expectRunway: params.runway ? up(params.runway) : null }));
    case 'action-startup': return makeAst('startup', cs, { expectRunway: params.runway ? up(params.runway) : null });
    case 'action-taxi-runway': return withParts(makeAst('taxi', cs, { dest: { kind: 'runway', runway: up(req(params.runway, 'runway')), intersection: route?.intersection ?? null }, via: route?.via ?? [], auto: route?.auto ?? !(route?.via?.length), holdShortOf: route?.holdShortOf ?? null, cross: route?.cross ?? [] }));
    case 'action-taxi-stand': return withParts(makeAst('taxi', cs, { dest: { kind: 'stand', ref: req(params.stand, 'stand') }, via: route?.via ?? [], auto: route?.auto ?? !(route?.via?.length), holdShortOf: route?.holdShortOf ?? null, cross: route?.cross ?? [] }));
    case 'action-taxi-point': { const n = req(params.node, 'node'); return withParts(makeAst('taxi', cs, { dest: { kind: 'node', nodeId: n.nodeId, label: n.label }, via: route?.via ?? [], auto: route?.auto ?? true, holdShortOf: route?.holdShortOf ?? null, cross: route?.cross ?? [] })); }
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
    case 'action-takeoff': return makeAst('takeoff', cs, { runway: up(req(params.runway, 'runway')), immediate: !!params.immediate, afterDepHdg: params.afterDepHdg ?? (params.heading != null ? params.heading : null), turn: params.turn ?? null, initialAlt: params.initialAlt ?? params.altitude ?? null, contactDeparture: !!params.contactDeparture, wind: params.wind ?? true });
    case 'action-cancel-takeoff': return makeAst('cancelTakeoff', cs, { reason: params.reason ?? null });
    case 'action-cancel-lineup': return makeAst('cancelLineup', cs, { via: params.taxiway ? up(params.taxiway) : null });
    case 'action-land': return makeAst('clearedLand', cs, { runway: up(req(params.runway, 'runway')), lahso: params.lahso ? up(params.lahso) : null, exit: params.exit ?? null, wind: params.wind ?? true, number: params.number ?? null });
    case 'action-goaround': { const g = params.goAround ?? {}; return makeAst('goAround', cs, { heading: g.heading ?? params.afterDepHdg ?? null, alt: g.alt ?? params.altitude ?? null, contact: g.contact ?? params.position ?? null, reason: params.reason ?? null }); }
    case 'action-cancel-approach': return makeAst('cancelApproach', cs, { hdg: req(params.heading, 'heading'), alt: req(params.altitude, 'altitude'), dir: params.dir ?? null, reason: params.reason ?? null });
    case 'action-exit': return makeAst('exitAt', cs, { exit: req(exitParam(params), 'exit'), expedite: !!params.expedite || chipsHave(params, 'expedite'), holdShortOf: route?.holdShortOf ?? null, contactGround: params.position === 'ground' });
    case 'action-plan-exit': return makeAst('exitAt', cs, { exit: req(exitParam(params), 'exit') });
    case 'action-heading': return withParts(makeAst('heading', cs, { hdg: req(params.heading, 'heading'), dir: params.dir ?? null, relative: params.relative ?? null }));
    case 'action-altitude': return withParts(makeAst('altitude', cs, { ft: req(params.altitude, 'altitude'), expedite: !!params.expedite }));
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

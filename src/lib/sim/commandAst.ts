// ============================================================
//  CommandAST — the ONE structured representation of every ATC command.
//
//  Produced by: the text parser (commands.ts), the click tree (commandTree.ts
//  toAst) and, later, STT / LLM function calling.
//  Consumed by: dispatch.ts (AST -> engine), phraseology.ts (AST -> TX/RB text),
//  the comm log (describe()), the undo/pending queue (PendingCmd.ast).
//
//  Design rules
//    - Discriminated on `kind`. Aircraft-addressed commands carry `callsign`
//      (ICAO callsign, upper-case). System commands (vehicles, runway status,
//      hold-all, broadcast) carry no callsign.
//    - Fields are REQUIRED with explicit null/false/[] defaults; use makeAst()
//      to fill defaults from a partial.
//    - One representation per intent: "taxi to stand" is `taxi` with
//      dest.kind === 'stand'; "descend 3000 then cleared ILS" is a `sequence`.
//    - Headings/courses are TRUE degrees inside the AST (the engine's frame);
//      phraseology converts to magnetic for speech (UX §G4 picker-heading).
//    - All values JSON-serialisable.
// ============================================================
import type { PendingCondition, Position, VehicleType, VehicleTarget, RunwayStatus } from './types';

// ──────────────────────────────────────────────────────────────────────────────
//  Parameter sub-types
// ──────────────────────────────────────────────────────────────────────────────
export type TaxiDest =
  | { kind: 'runway'; runway: string; intersection: string | null }
  | { kind: 'stand'; ref: string }
  | { kind: 'node'; nodeId: string; label: string };

export type HoldShortTarget =
  | { kind: 'runway'; runway: string }
  | { kind: 'taxiway'; taxiway: string }
  | { kind: 'node'; nodeId: string; label: string };

export type ExitSpec =
  | { kind: 'taxiway'; taxiway: string }
  | { kind: 'next'; dir: 'L' | 'R' };

export type PushDir = 'N' | 'E' | 'S' | 'W' | 'any';
export type TurnDir = 'L' | 'R';
export type ApproachType = 'ILS' | 'LOC' | 'VISUAL' | 'RNAV';
export type UnableReason = 'traffic' | 'wake' | 'runway_closed' | 'slot' | 'standby' | 'delay' | 'weather';
export type ReportKind =
  | 'position' | 'heading' | 'altitude' | 'airspeed' | 'pob' | 'fuel' | 'nature' | 'dg' | 'intentions'
  | 'established' | 'vacated' | 'ready' | 'reason' | 'readyou5' | 'four_mile_final' | 'rolling';
export type EmergencyInfoKind = 'pob' | 'fuel' | 'nature' | 'dg' | 'intentions';
export type CorrectionField = 'heading' | 'altitude' | 'speed' | 'runway' | 'squawk' | 'frequency' | 'taxiway';
export type ExpediteScope = 'taxi' | 'crossing' | 'vacating' | 'climb' | 'descent';
export type HoldAllScope = 'departures' | 'crossings' | 'all';
export type ContactWhen = 'now' | 'when_vacated' | 'on_reaching' | 'at_hold';

// ──────────────────────────────────────────────────────────────────────────────
//  Aircraft-addressed commands
// ──────────────────────────────────────────────────────────────────────────────
interface Addressed { callsign: string }

// ── ground ────────────────────────────────────────────────────────────────────
/** "Start-up approved, expect runway 27L." Stands without pushback. */
export interface StartupAst extends Addressed { kind: 'startup'; expectRunway: string | null }
/** "Pushback approved [face north], expect runway 27L." `startup` = "start-up approved" included. */
export interface PushbackAst extends Addressed { kind: 'pushback'; dir: PushDir; expectRunway: string | null; startup: boolean; tailTo: string | null }
/**
 * Taxi to a runway holding point / stand / intersection node via named taxiways.
 * `via: []` + `auto: true` = shortest route (findPath). `holdShortOf` = explicit
 * hold; `cross` = runways the clearance includes crossing (FAA, max 1). Every
 * other runway on the route gets an implicit hold-short (engine safety net).
 */
export interface TaxiAst extends Addressed { kind: 'taxi'; dest: TaxiDest; via: string[]; auto: boolean; holdShortOf: HoldShortTarget | null; cross: string[]; expedite: boolean }
export interface HoldShortAst extends Addressed { kind: 'holdShort'; of: HoldShortTarget }
export interface HoldPositionAst extends Addressed { kind: 'holdPosition'; reason: string | null }
/** Resume taxi/pushback after a hold; optional new hold-short. Never releases a runway hold. */
export interface ContinueAst extends Addressed { kind: 'continue'; holdShortOf: HoldShortTarget | null }
/** Cross a runway at the current hold line. `behind` = conditional on a named landing/departing aircraft. */
export interface CrossAst extends Addressed { kind: 'cross'; runway: string; expedite: boolean; behind: string | null }
export interface GiveWayAst extends Addressed { kind: 'giveWay'; to: string; mode: 'give_way' | 'follow' }
/** Line up and wait. `behind` = conditional on a landing aircraft (callsign). `trafficInfo` = spoken traffic string. */
export interface LineupAst extends Addressed { kind: 'lineup'; runway: string; behind: string | null; intersection: string | null; trafficInfo: string | null }
/**
 * Takeoff clearance with departure parts. `afterDepHdg` true degrees, 'runway' =
 * runway heading, null = SID/own nav. `turn` = relative "turn left 20 degrees".
 * `wind` = include the wind check in the transmission (auto from ATIS).
 */
export interface TakeoffAst extends Addressed { kind: 'takeoff'; runway: string; immediate: boolean; afterDepHdg: number | 'runway' | null; turn: { dir: TurnDir; deg: number } | null; initialAlt: number | null; contactDeparture: boolean; wind: boolean }
export interface CancelTakeoffAst extends Addressed { kind: 'cancelTakeoff'; reason: string | null }
/** Vacate the runway from line-up via a taxiway (null = next available). */
export interface CancelLineupAst extends Addressed { kind: 'cancelLineup'; via: string | null }
/** Runway exit instruction (landing/rollout) with optional after-vacate hold and ground contact. */
export interface ExitAtAst extends Addressed { kind: 'exitAt'; exit: ExitSpec; expedite: boolean; holdShortOf: HoldShortTarget | null; contactGround: boolean }
export interface ExpediteAst extends Addressed { kind: 'expedite'; on: boolean; scope: ExpediteScope }

// ── tower ─────────────────────────────────────────────────────────────────────
/** Landing clearance. `lahso` = hold short of runway/taxiway; `number` = sequence for traffic info. */
export interface ClearedLandAst extends Addressed { kind: 'clearedLand'; runway: string; lahso: string | null; exit: ExitSpec | null; wind: boolean; trafficInfo: string | null; number: number | null }
/** "Continue approach, number two, expect late landing clearance." (03 §D1) */
export interface ContinueApproachAst extends Addressed { kind: 'continueApproach'; number: number | null }
/** Go around with missed-approach parts. `heading` true degrees | 'runway' | null (= runway heading). */
export interface GoAroundAst extends Addressed { kind: 'goAround'; heading: number | 'runway' | null; alt: number | null; contact: Position | null; reason: string | null }
export interface WindCheckAst extends Addressed { kind: 'windCheck' }
/** Handoff: "contact tower 118.5" [when vacated / on reaching / at the holding point]. Frequency comes from the airport data at phrase time. */
export interface ContactAst extends Addressed { kind: 'contact'; position: Position; when: ContactWhen }

// ── approach ──────────────────────────────────────────────────────────────────
/** Vector. `hdg` TRUE degrees (1-360). `relative` keeps the spoken "turn left 20 degrees" form. `when` = conditional. */
export interface HeadingAst extends Addressed { kind: 'heading'; hdg: number; dir: TurnDir | null; when: PendingCondition | null; relative: { dir: TurnDir; deg: number } | null }
/** Climb/descend/maintain; verb is derived from the aircraft altitude at phrase time. */
export interface AltitudeAst extends Addressed { kind: 'altitude'; ft: number; expedite: boolean; when: PendingCondition | null }
/** Speed assignment; 'resume' = resume normal speed; `untilNM` = "until 4-mile final". */
export interface SpeedAst extends Addressed { kind: 'speed'; kts: number | 'resume'; untilNM: number | null }
export interface DirectAst extends Addressed { kind: 'direct'; fix: string; thenHdg: number | null }
/** Hold at a fix. `inbound` TRUE degrees (null = bearing to fix / published). `efc` = sim time (s) or null. */
export interface HoldAst extends Addressed { kind: 'hold'; fix: string; inbound: number | null; dir: TurnDir | null; legTimeMin: number | null; legNM: number | null; efc: number | null }
/** ILS clearance. "descend 3000 then cleared ILS" is a `sequence` [altitude, ils]. */
export interface IlsAst extends Addressed { kind: 'ils'; runway: string; reportEstablished: boolean }
/** Localizer-only: track LOC, maintain `maintainAlt` (null = current cmdAltitude) until cleared ILS. */
export interface LocAst extends Addressed { kind: 'loc'; runway: string; maintainAlt: number | null }
export interface VisualAst extends Addressed { kind: 'visual'; runway: string; follow: string | null }
/** Cancel approach clearance — heading AND altitude mandatory (UX §1.4). */
export interface CancelApproachAst extends Addressed { kind: 'cancelApproach'; hdg: number; alt: number; dir: TurnDir | null; reason: string | null }
export interface ExpectRunwayAst extends Addressed { kind: 'expectRunway'; runway: string; approach: ApproachType }
export interface ResumeSidAst extends Addressed { kind: 'resumeSid' }
export interface SquawkAst extends Addressed { kind: 'squawk'; code: string }
export interface IdentAst extends Addressed { kind: 'ident' }
/** "Radar contact, descend 5000, QNH, expect ILS 27L." (03 §3.1) */
export interface RadarContactAst extends Addressed { kind: 'radarContact'; descendTo: number | null; expectRunway: string | null }

// ── meta ──────────────────────────────────────────────────────────────────────
export interface SayAgainAst extends Addressed { kind: 'sayAgain' }
/** "Negative, heading 240, I say again heading 240." Replaces the value of the last command; restarts pilot delay. */
export interface CorrectionAst extends Addressed { kind: 'correction'; field: CorrectionField; value: number | string }
/** Undo: drops the newest pending (not yet executed) command. */
export interface DisregardAst extends Addressed { kind: 'disregard' }
export interface StandbyAst extends Addressed { kind: 'standby' }
export interface UnableAst extends Addressed { kind: 'unable'; reason: UnableReason }
export interface ReportAst extends Addressed { kind: 'report'; items: ReportKind[] }
export interface RogerAst extends Addressed { kind: 'roger' }

// ── emergency (aircraft-addressed) ────────────────────────────────────────────
/** "Roger mayday, [squawk 7700,] say souls on board and fuel remaining, state intentions." */
export interface EmergencyAckAst extends Addressed { kind: 'emergencyAck'; ask: EmergencyInfoKind[]; squawk: boolean }
/** Priority runway: "expect 27L, number one, [straight-in,] cleared ILS 27L, emergency services alerted." */
export interface PriorityAst extends Addressed { kind: 'priority'; runway: string; straightIn: boolean; numberOne: boolean; sterile: boolean; clearIls: boolean }
/** After landing: stop on the runway (fire services meet you) or vacate if able via a taxiway. */
export interface StopOnRunwayAst extends Addressed { kind: 'stopOnRunway'; mode: 'stop' | 'vacate_if_able'; via: string | null }
export interface EmergencyCancelAckAst extends Addressed { kind: 'emergencyCancelAck' }

// ──────────────────────────────────────────────────────────────────────────────
//  System commands (no callsign)
// ──────────────────────────────────────────────────────────────────────────────
/** "All stations, hold position, emergency in progress." Sets runway sterile / HELD chips. */
export interface HoldAllAst { kind: 'holdAll'; scope: HoldAllScope; runway: string | null }
export interface ResumeAllAst { kind: 'resumeAll' }
export interface ReopenRunwayAst { kind: 'reopenRunway'; runway: string; afterInspection: boolean }
/** Dispatch vehicles of `type` (specific `ids` or the first available `count`) to a target. */
export interface DispatchVehicleAst { kind: 'dispatchVehicle'; type: VehicleType; ids: string[]; count: number; target: VehicleTarget }
export interface RecallVehicleAst { kind: 'recallVehicle'; id: string }
/** Vehicle radio ops: hold position / continue / cross runway / return to base. */
export interface VehicleOpAst { kind: 'vehicleOp'; id: string; op: 'hold' | 'continue' | 'cross' | 'rtb'; runway: string | null }
export interface RunwayStatusAst { kind: 'runwayStatus'; runway: string; status: RunwayStatus; reason: string | null }
export interface BroadcastAst { kind: 'broadcast'; text: string }

// ──────────────────────────────────────────────────────────────────────────────
//  Compound
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Ordered multi-part transmission to one aircraft ("descend 3000, cleared ILS
 * 27L, report established"). Parts are single (non-sequence) aircraft commands
 * with the same callsign, already in ICAO word order (UX §1.5). Max 1 base + 3 parts.
 */
export interface SequenceAst extends Addressed { kind: 'sequence'; parts: SingleAircraftCommand[] }

export type SingleAircraftCommand =
  | StartupAst | PushbackAst | TaxiAst | HoldShortAst | HoldPositionAst | ContinueAst | CrossAst | GiveWayAst
  | LineupAst | TakeoffAst | CancelTakeoffAst | CancelLineupAst | ExitAtAst | ExpediteAst
  | ClearedLandAst | ContinueApproachAst | GoAroundAst | WindCheckAst | ContactAst
  | HeadingAst | AltitudeAst | SpeedAst | DirectAst | HoldAst | IlsAst | LocAst | VisualAst | CancelApproachAst
  | ExpectRunwayAst | ResumeSidAst | SquawkAst | IdentAst | RadarContactAst
  | SayAgainAst | CorrectionAst | DisregardAst | StandbyAst | UnableAst | ReportAst | RogerAst
  | EmergencyAckAst | PriorityAst | StopOnRunwayAst | EmergencyCancelAckAst;

export type AircraftCommand = SingleAircraftCommand | SequenceAst;

export type SystemCommand =
  | HoldAllAst | ResumeAllAst | ReopenRunwayAst | DispatchVehicleAst | RecallVehicleAst | VehicleOpAst
  | RunwayStatusAst | BroadcastAst;

export type CommandAST = AircraftCommand | SystemCommand;
export type CommandKind = CommandAST['kind'];
export type AstOf<K extends CommandKind> = Extract<CommandAST, { kind: K }>;

// ──────────────────────────────────────────────────────────────────────────────
//  Results
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Outcome codes. Policy (03 §B4):
 *   ok / ok_queued / ok_conditional / partial  -> transmitted, pilot reads back, executes (maybe scored)
 *   queried                                    -> pilot asks back ("confirm runway 22?"), nothing executes
 *   unable_*                                   -> pilot refuses (readback "unable"), nothing executes
 *   refused_* / not_found / invalid_*          -> engine refuses before transmission (SYS line, no radio)
 */
export type ResultCode =
  | 'ok' | 'ok_queued' | 'ok_conditional' | 'partial' | 'queried'
  | 'unable' | 'unable_envelope' | 'unable_lahso' | 'unable_immediate' | 'unable_exit' | 'unable_route'
  | 'not_found' | 'not_on_frequency' | 'invalid_stage' | 'invalid_param' | 'unknown_runway' | 'unknown_fix'
  | 'unknown_taxiway' | 'unknown_stand' | 'unknown_vehicle' | 'no_route' | 'runway_occupied' | 'runway_closed'
  | 'weight_class' | 'not_at_hold' | 'already' | 'past_abort_speed' | 'too_low' | 'no_ils' | 'paused'
  | 'held_by_emergency' | 'vehicle_unavailable' | 'nothing_pending' | 'not_implemented';

export interface CommandResult {
  ok: boolean;
  code: ResultCode;
  /** Controller line as transmitted (empty when refused pre-transmission). */
  transmission: string;
  /** Pilot readback line (empty when refused pre-transmission; "Unable ..." for unable_*). */
  readback: string;
  /** Human reason for non-ok codes (canonical R-strings from commandTree when applicable). */
  reason?: string;
  /** True when the engine changed state immediately (vs queued behind pilot delay). */
  applied?: boolean;
  /** Parts refused by the pilot in a partial result (describe() strings). */
  refused?: string[];
  /** Sim time the readback will be spoken (issue time + pilot delay). */
  readbackAt?: number;
  /** Sim time the command executes (max(applyAt, condition)); undefined when immediate. */
  applyAt?: number;
}

/** What an engine `cmd*` method returns to dispatch (no text — dispatch adds TX/RB from phraseology). */
export interface EngineOutcome {
  ok: boolean;
  code: ResultCode;
  reason?: string;
  applied?: boolean;
  refused?: string[];
  applyAt?: number;
  /** Extra values phraseology needs (e.g. resolved runway, computed heading, traffic string). */
  extra?: Record<string, string | number | boolean | null>;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Kind groups + guards
// ──────────────────────────────────────────────────────────────────────────────
export const GROUND_KINDS: readonly CommandKind[] = [
  'startup', 'pushback', 'taxi', 'holdShort', 'holdPosition', 'continue', 'cross', 'giveWay', 'lineup', 'takeoff',
  'cancelTakeoff', 'cancelLineup', 'exitAt', 'expedite',
];
export const TOWER_KINDS: readonly CommandKind[] = ['clearedLand', 'continueApproach', 'goAround', 'windCheck', 'contact'];
export const APPROACH_KINDS: readonly CommandKind[] = [
  'heading', 'altitude', 'speed', 'direct', 'hold', 'ils', 'loc', 'visual', 'cancelApproach', 'expectRunway',
  'resumeSid', 'squawk', 'ident', 'radarContact',
];
export const META_KINDS: readonly CommandKind[] = ['sayAgain', 'correction', 'disregard', 'standby', 'unable', 'report', 'roger'];
export const EMERGENCY_KINDS: readonly CommandKind[] = ['emergencyAck', 'priority', 'stopOnRunway', 'emergencyCancelAck', 'holdAll', 'resumeAll', 'reopenRunway'];
export const SYSTEM_KINDS: readonly CommandKind[] = ['holdAll', 'resumeAll', 'reopenRunway', 'dispatchVehicle', 'recallVehicle', 'vehicleOp', 'runwayStatus', 'broadcast'];
/** Kinds with no pilot execution and therefore no undo ring (UX §G9). */
export const NO_UNDO_KINDS: readonly CommandKind[] = ['standby', 'report', 'sayAgain', 'windCheck', 'roger', 'dispatchVehicle', 'recallVehicle', 'vehicleOp', 'runwayStatus', 'broadcast', 'holdAll', 'resumeAll', 'reopenRunway', 'disregard'];
/** Kinds that execute immediately (no pilot delay) — everything else is queued PILOT_DELAY_S. */
export const IMMEDIATE_KINDS: readonly CommandKind[] = ['disregard', 'standby', 'sayAgain', 'roger', 'windCheck', 'report', 'holdAll', 'resumeAll', 'reopenRunway', 'dispatchVehicle', 'recallVehicle', 'vehicleOp', 'runwayStatus', 'broadcast', 'cancelTakeoff'];

export function isSystemCommand(ast: CommandAST): ast is SystemCommand {
  return (SYSTEM_KINDS as readonly string[]).includes(ast.kind);
}
export function isAircraftCommand(ast: CommandAST): ast is AircraftCommand {
  return !isSystemCommand(ast);
}
export function isSequence(ast: CommandAST): ast is SequenceAst { return ast.kind === 'sequence'; }
export function isGroundCommand(ast: CommandAST): boolean { return GROUND_KINDS.includes(ast.kind); }
export function isAirborneCommand(ast: CommandAST): boolean { return APPROACH_KINDS.includes(ast.kind) || ast.kind === 'goAround' || ast.kind === 'clearedLand'; }
export function isMetaCommand(ast: CommandAST): boolean { return META_KINDS.includes(ast.kind); }
export function isUndoable(ast: CommandAST): boolean {
  if (ast.kind === 'sequence') return ast.parts.every(p => !NO_UNDO_KINDS.includes(p.kind));
  return !NO_UNDO_KINDS.includes(ast.kind);
}
export function callsignOf(ast: CommandAST): string | null { return isAircraftCommand(ast) ? ast.callsign : null; }
/** Flatten a sequence into its parts (single commands return [self]). */
export function flatten(ast: CommandAST): CommandAST[] { return ast.kind === 'sequence' ? ast.parts : [ast]; }
/** Every kind present in the AST (sequence-aware). */
export function kindsOf(ast: CommandAST): CommandKind[] { return flatten(ast).map(p => p.kind); }

// ──────────────────────────────────────────────────────────────────────────────
//  Builders — fill required fields from a partial (defaults documented per kind)
// ──────────────────────────────────────────────────────────────────────────────
type Defaults = { [K in CommandKind]: Omit<AstOf<K>, 'kind' | 'callsign'> };
const AST_DEFAULTS: Defaults = {
  startup: { expectRunway: null },
  pushback: { dir: 'any', expectRunway: null, startup: false, tailTo: null },
  taxi: { dest: { kind: 'runway', runway: '', intersection: null }, via: [], auto: true, holdShortOf: null, cross: [], expedite: false },
  holdShort: { of: { kind: 'runway', runway: '' } },
  holdPosition: { reason: null },
  continue: { holdShortOf: null },
  cross: { runway: '', expedite: false, behind: null },
  giveWay: { to: '', mode: 'give_way' },
  lineup: { runway: '', behind: null, intersection: null, trafficInfo: null },
  takeoff: { runway: '', immediate: false, afterDepHdg: null, turn: null, initialAlt: null, contactDeparture: false, wind: true },
  cancelTakeoff: { reason: null },
  cancelLineup: { via: null },
  exitAt: { exit: { kind: 'next', dir: 'L' }, expedite: false, holdShortOf: null, contactGround: false },
  expedite: { on: true, scope: 'climb' },
  clearedLand: { runway: '', lahso: null, exit: null, wind: true, trafficInfo: null, number: null },
  continueApproach: { number: null },
  goAround: { heading: null, alt: null, contact: null, reason: null },
  windCheck: {},
  contact: { position: 'tower', when: 'now' },
  heading: { hdg: 0, dir: null, when: null, relative: null },
  altitude: { ft: 0, expedite: false, when: null },
  speed: { kts: 'resume', untilNM: null },
  direct: { fix: '', thenHdg: null },
  hold: { fix: '', inbound: null, dir: null, legTimeMin: null, legNM: null, efc: null },
  ils: { runway: '', reportEstablished: true },
  loc: { runway: '', maintainAlt: null },
  visual: { runway: '', follow: null },
  cancelApproach: { hdg: 0, alt: 0, dir: null, reason: null },
  expectRunway: { runway: '', approach: 'ILS' },
  resumeSid: {},
  squawk: { code: '' },
  ident: {},
  radarContact: { descendTo: null, expectRunway: null },
  sayAgain: {},
  correction: { field: 'heading', value: 0 },
  disregard: {},
  standby: {},
  unable: { reason: 'traffic' },
  report: { items: [] },
  roger: {},
  emergencyAck: { ask: ['pob', 'fuel', 'intentions'], squawk: true },
  priority: { runway: '', straightIn: false, numberOne: true, sterile: false, clearIls: true },
  stopOnRunway: { mode: 'stop', via: null },
  emergencyCancelAck: {},
  holdAll: { scope: 'all', runway: null },
  resumeAll: {},
  reopenRunway: { runway: '', afterInspection: false },
  dispatchVehicle: { type: 'arff', ids: [], count: 2, target: { kind: 'station' } },
  recallVehicle: { id: '' },
  vehicleOp: { id: '', op: 'hold', runway: null },
  runwayStatus: { runway: '', status: 'open', reason: null },
  broadcast: { text: '' },
  sequence: { parts: [] },
};

/**
 * Build an AST node of `kind` for `callsign` (null for system commands), merging
 * `fields` over the kind's defaults. Runway/fix/taxiway strings are upper-cased.
 */
export function makeAst<K extends CommandKind>(kind: K, callsign: string | null, fields: Partial<Omit<AstOf<K>, 'kind' | 'callsign'>> = {}): AstOf<K> {
  const base: Record<string, unknown> = { kind, ...(AST_DEFAULTS[kind] as object), ...(fields as object) };
  if (callsign != null && !(SYSTEM_KINDS as readonly string[]).includes(kind)) base.callsign = callsign.toUpperCase();
  normaliseIdentifiers(base);
  return base as unknown as AstOf<K>;
}

/** Keys whose string values are runway/fix/taxiway/stand/callsign identifiers (upper-cased, also inside nested objects). */
const IDENT_KEYS = new Set(['runway', 'fix', 'taxiway', 'to', 'behind', 'follow', 'via', 'cross', 'expectRunway', 'lahso', 'intersection', 'ref', 'tailTo', 'callsign', 'id']);
function normaliseIdentifiers(obj: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'text' || k === 'reason' || k === 'label' || k === 'nodeId') continue;
    if (typeof v === 'string') { if (IDENT_KEYS.has(k)) obj[k] = v.toUpperCase(); }
    else if (Array.isArray(v)) { if (IDENT_KEYS.has(k)) obj[k] = v.map(x => (typeof x === 'string' ? x.toUpperCase() : x)); else for (const x of v) if (x && typeof x === 'object') normaliseIdentifiers(x as Record<string, unknown>); }
    else if (v && typeof v === 'object') normaliseIdentifiers(v as Record<string, unknown>);
  }
}

/** Build a sequence; a single part collapses to that part. Throws on mixed callsigns. */
export function sequence(callsign: string, parts: SingleAircraftCommand[]): AircraftCommand {
  const cs = callsign.toUpperCase();
  for (const p of parts) if (p.callsign !== cs) throw new Error(`sequence: part ${p.kind} addressed to ${p.callsign}, expected ${cs}`);
  if (parts.length === 1) return parts[0];
  return { kind: 'sequence', callsign: cs, parts };
}

/** ICAO word order for sequence parts (UX §1.5 "Emitted order"). Lower sorts first. */
export const PART_ORDER: Partial<Record<CommandKind, number>> = {
  // pushback / startup family
  pushback: 10, startup: 10, taxi: 40,
  // takeoff family: wind -> runway -> after-departure -> climb -> contact -> cleared (all inside TakeoffAst)
  lineup: 20, takeoff: 90,
  // airborne: turn -> climb/descend -> speed -> then-clause
  heading: 20, altitude: 30, speed: 40, direct: 45, ils: 60, loc: 60, visual: 60, hold: 70, contact: 80, report: 85,
  clearedLand: 50, exitAt: 60, holdShort: 55, cross: 55, goAround: 5, cancelApproach: 5,
};
export function sortParts(parts: SingleAircraftCommand[]): SingleAircraftCommand[] {
  return [...parts].sort((a, b) => (PART_ORDER[a.kind] ?? 50) - (PART_ORDER[b.kind] ?? 50));
}

/** Part pairs that may not share one transmission (UX §G13.7). */
export const INCOMPATIBLE_PARTS: ReadonlyArray<readonly [CommandKind, CommandKind]> = [
  ['ils', 'hold'], ['loc', 'hold'], ['expedite', 'speed'], ['heading', 'direct'],
];
export function incompatibleParts(parts: SingleAircraftCommand[]): [CommandKind, CommandKind] | null {
  const kinds: CommandKind[] = parts.map(p => p.kind);
  for (const [a, b] of INCOMPATIBLE_PARTS) if (kinds.includes(a) && kinds.includes(b)) return [a, b];
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
//  describe() — short human summary for chips, strips and the comm log.
//  (NOT radio phraseology — that is phraseology.ts.)
// ──────────────────────────────────────────────────────────────────────────────
const hdg3 = (h: number) => String(((Math.round(h) % 360) + 360) % 360 || 360).padStart(3, '0');
const dirWord = (d: TurnDir | null) => (d === 'L' ? 'left ' : d === 'R' ? 'right ' : '');
function holdTargetText(t: HoldShortTarget | null): string {
  if (!t) return '';
  return t.kind === 'runway' ? `hold short ${t.runway}` : t.kind === 'taxiway' ? `hold short twy ${t.taxiway}` : `hold at ${t.label}`;
}
function exitText(e: ExitSpec): string { return e.kind === 'taxiway' ? `exit ${e.taxiway}` : `next exit ${e.dir === 'L' ? 'left' : 'right'}`; }
function condText(c: PendingCondition | null): string {
  if (!c) return '';
  switch (c.type) {
    case 'after_pushback': return ' after pushback';
    case 'on_reaching_hold': return ' on reaching';
    case 'at_or_below_alt': return ` at or below ${c.ft}`;
    case 'at_or_above_alt': return ` at ${c.ft}`;
    case 'after_fix': return ` after ${c.fix}`;
    case 'behind_aircraft': return ` behind ${c.callsign}`;
    case 'after_vacated': return ' when vacated';
    case 'when_ready': return ' when ready';
  }
}
function targetText(t: VehicleTarget): string {
  switch (t.kind) {
    case 'runway': return `RWY ${t.runway}`;
    case 'aircraft': return t.callsign;
    case 'stand': return `stand ${t.ref}`;
    case 'point': return 'map point';
    case 'station': return 'station';
  }
}

export function describe(ast: CommandAST): string {
  switch (ast.kind) {
    case 'startup': return `Start-up approved${ast.expectRunway ? `, expect ${ast.expectRunway}` : ''}`;
    case 'pushback': return `Pushback${ast.startup ? ' + start-up' : ''} approved${ast.dir !== 'any' ? `, face ${ast.dir}` : ''}${ast.tailTo ? `, tail to ${ast.tailTo}` : ''}${ast.expectRunway ? `, expect ${ast.expectRunway}` : ''}`;
    case 'taxi': {
      const d = ast.dest.kind === 'runway' ? `RWY ${ast.dest.runway}${ast.dest.intersection ? ` at ${ast.dest.intersection}` : ''}` : ast.dest.kind === 'stand' ? `stand ${ast.dest.ref}` : ast.dest.label;
      const via = ast.via.length ? ` via ${ast.via.join(', ')}` : ast.auto ? '' : '';
      const x = ast.cross.length ? `, cross ${ast.cross.join(', ')}` : '';
      const hs = ast.holdShortOf ? `, ${holdTargetText(ast.holdShortOf)}` : '';
      return `Taxi ${d}${via}${x}${hs}${ast.expedite ? ', expedite' : ''}`;
    }
    case 'holdShort': return holdTargetText(ast.of).replace(/^h/, 'H');
    case 'holdPosition': return `Hold position${ast.reason ? ` (${ast.reason})` : ''}`;
    case 'continue': return `Continue${ast.holdShortOf ? `, ${holdTargetText(ast.holdShortOf)}` : ''}`;
    case 'cross': return `Cross ${ast.runway}${ast.expedite ? ', expedite' : ''}${ast.behind ? `, behind ${ast.behind}` : ''}`;
    case 'giveWay': return ast.mode === 'follow' ? `Follow ${ast.to}` : `Give way to ${ast.to}`;
    case 'lineup': return `Line up and wait ${ast.runway}${ast.intersection ? ` at ${ast.intersection}` : ''}${ast.behind ? `, behind ${ast.behind}` : ''}`;
    case 'takeoff': {
      const parts: string[] = [];
      if (ast.afterDepHdg === 'runway') parts.push('runway heading'); else if (ast.afterDepHdg != null) parts.push(`hdg ${hdg3(ast.afterDepHdg)}`);
      if (ast.turn) parts.push(`turn ${ast.turn.dir === 'L' ? 'left' : 'right'} ${ast.turn.deg}`);
      if (ast.initialAlt != null) parts.push(`climb ${ast.initialAlt}`);
      if (ast.contactDeparture) parts.push('contact departure');
      return `Cleared for ${ast.immediate ? 'immediate ' : ''}takeoff ${ast.runway}${parts.length ? `, ${parts.join(', ')}` : ''}`;
    }
    case 'cancelTakeoff': return `Cancel takeoff${ast.reason ? ` (${ast.reason})` : ''}`;
    case 'cancelLineup': return `Vacate runway${ast.via ? ` via ${ast.via}` : ''}`;
    case 'exitAt': return `${exitText(ast.exit).replace(/^./, c => c.toUpperCase())}${ast.expedite ? ', expedite' : ''}${ast.holdShortOf ? `, ${holdTargetText(ast.holdShortOf)}` : ''}${ast.contactGround ? ', contact ground' : ''}`;
    case 'expedite': return `Expedite ${ast.scope}${ast.on ? '' : ' cancelled'}`;
    case 'clearedLand': return `Cleared to land ${ast.runway}${ast.number ? `, number ${ast.number}` : ''}${ast.lahso ? `, hold short ${ast.lahso}` : ''}${ast.exit ? `, ${exitText(ast.exit)}` : ''}`;
    case 'continueApproach': return `Continue approach${ast.number ? `, number ${ast.number}` : ''}`;
    case 'goAround': {
      const p: string[] = [];
      if (ast.heading === 'runway') p.push('runway heading'); else if (ast.heading != null) p.push(`hdg ${hdg3(ast.heading)}`);
      if (ast.alt != null) p.push(`climb ${ast.alt}`);
      if (ast.contact) p.push(`contact ${ast.contact}`);
      return `Go around${p.length ? `, ${p.join(', ')}` : ''}`;
    }
    case 'windCheck': return 'Wind check';
    case 'contact': return `Contact ${ast.position}${ast.when === 'when_vacated' ? ' when vacated' : ast.when === 'on_reaching' ? ' on reaching' : ast.when === 'at_hold' ? ' at the holding point' : ''}`;
    case 'heading': return ast.relative ? `Turn ${ast.relative.dir === 'L' ? 'left' : 'right'} ${ast.relative.deg} deg` : `${ast.dir ? `Turn ${dirWord(ast.dir)}` : 'Fly '}heading ${hdg3(ast.hdg)}${condText(ast.when)}`;
    case 'altitude': return `Altitude ${ast.ft}${ast.expedite ? ', expedite' : ''}${condText(ast.when)}`;
    case 'speed': return ast.kts === 'resume' ? 'Resume normal speed' : `Speed ${ast.kts}${ast.untilNM != null ? ` until ${ast.untilNM} NM` : ''}`;
    case 'direct': return `Direct ${ast.fix}${ast.thenHdg != null ? `, then hdg ${hdg3(ast.thenHdg)}` : ''}`;
    case 'hold': return `Hold at ${ast.fix}${ast.inbound != null ? `, inbound ${hdg3(ast.inbound)}` : ''}${ast.dir ? `, ${ast.dir === 'L' ? 'left' : 'right'} turns` : ''}${ast.legNM != null ? `, ${ast.legNM} NM legs` : ast.legTimeMin != null ? `, ${ast.legTimeMin} min legs` : ''}`;
    case 'ils': return `Cleared ILS ${ast.runway}${ast.reportEstablished ? ', report established' : ''}`;
    case 'loc': return `Cleared localizer ${ast.runway}${ast.maintainAlt != null ? `, maintain ${ast.maintainAlt}` : ''}`;
    case 'visual': return `Cleared visual ${ast.runway}${ast.follow ? `, follow ${ast.follow}` : ''}`;
    case 'cancelApproach': return `Cancel approach, ${dirWord(ast.dir)}heading ${hdg3(ast.hdg)}, altitude ${ast.alt}`;
    case 'expectRunway': return `Expect ${ast.approach} ${ast.runway}`;
    case 'resumeSid': return 'Resume own navigation';
    case 'squawk': return `Squawk ${ast.code}`;
    case 'ident': return 'Squawk ident';
    case 'radarContact': return `Radar contact${ast.descendTo != null ? `, descend ${ast.descendTo}` : ''}${ast.expectRunway ? `, expect ${ast.expectRunway}` : ''}`;
    case 'sayAgain': return 'Say again';
    case 'correction': return `Correction: ${ast.field} ${ast.value}`;
    case 'disregard': return 'Disregard';
    case 'standby': return 'Standby';
    case 'unable': return `Unable (${ast.reason.replace('_', ' ')})`;
    case 'report': return `Report ${ast.items.join(', ') || 'position'}`;
    case 'roger': return 'Roger';
    case 'emergencyAck': return `Roger mayday${ast.squawk ? ', squawk 7700' : ''}, say ${ast.ask.join('/')}`;
    case 'priority': return `Priority ${ast.runway}${ast.numberOne ? ', number one' : ''}${ast.straightIn ? ', straight-in' : ''}${ast.clearIls ? `, cleared ILS ${ast.runway}` : ''}${ast.sterile ? ', runway sterile' : ''}`;
    case 'stopOnRunway': return ast.mode === 'stop' ? 'Stop on the runway' : `Vacate if able${ast.via ? ` via ${ast.via}` : ''}`;
    case 'emergencyCancelAck': return 'Roger, mayday cancelled';
    case 'holdAll': return `Hold ${ast.scope}${ast.runway ? ` ${ast.runway}` : ''}`;
    case 'resumeAll': return 'Resume all traffic';
    case 'reopenRunway': return `Reopen ${ast.runway}${ast.afterInspection ? ' after inspection' : ''}`;
    case 'dispatchVehicle': return `Dispatch ${ast.ids.length ? ast.ids.join(', ') : `${ast.count} x ${ast.type}`} to ${targetText(ast.target)}`;
    case 'recallVehicle': return `Recall ${ast.id}`;
    case 'vehicleOp': return `${ast.id}: ${ast.op === 'rtb' ? 'return to base' : ast.op === 'cross' ? `cross ${ast.runway ?? ''}` : ast.op}`;
    case 'runwayStatus': return `Runway ${ast.runway} ${ast.status}${ast.reason ? ` (${ast.reason})` : ''}`;
    case 'broadcast': return `Broadcast: ${ast.text}`;
    case 'sequence': return ast.parts.map(describe).join(' / ');
  }
}

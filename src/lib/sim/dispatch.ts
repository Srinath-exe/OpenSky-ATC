// ============================================================
//  dispatch — CommandAST -> engine method -> CommandResult
//
//  Ownership: W0 wrote the contract (EngineCommandApi = the exact method set
//  W1-ENGINE implements on SimEngine; the AST->method routing; the result
//  composition). W1-COMMANDS owns this file from Wave 1 (guards, sequences,
//  partial refusals, strict-frequency policy, validation, text entry point).
//
//  Flow for one transmission (UX §1.1):
//    UI/parser -> dispatch(engine, ast)
//      1. resolve callsign (not_found -> SYS line, no radio)
//      2. pure pre-flight guard (paused, malformed values)
//      3. strict-frequency guard (not_on_frequency, R13)
//      4. UX §G3 validation via commandTree.validateAst with an ActionCtx built
//         from the engine (hard issue -> SYS line; soft issues -> `warnings`)
//      5. route each part to the engine method; the engine returns EngineOutcome
//         (state changes are queued behind the pilot delay unless the kind is in
//         IMMEDIATE_KINDS). Sequences: parts apply in order; the first SILENT
//         refusal aborts the transmission and rolls the queued parts back
//         (cmdDisregard); pilot-side `unable_*` parts are collected as refused
//         and the rest apply (code 'partial').
//      6. compose transmission()/readback() via phraseology with the engine's PhraseCtx
//      7. engine.onTransmission(ast, result) emits `transmission` (ATC line, now)
//         and schedules the `readback` event at readbackAt (pilot line)
//      8. return CommandResult to the caller (store pushes both lines; test API returns it)
//
//  executeText(engine, text) = parseCommand + dispatch for the command line /
//  STT; fromEngine(engine) builds the parser/autocomplete context.
// ============================================================
import type {
  AircraftState, GateState, PendingCondition, PlayerPosition, Position, RunwayState, RunwayStatus, Stage,
  Vehicle, VehicleTarget, VehicleType, WeatherState,
} from './types';
import type { WeightClass } from './aircraftDB';
import type {
  ApproachType, CommandAST, CommandKind, CommandResult, ContactWhen, CorrectionField, EmergencyInfoKind, EngineOutcome, ExitSpec,
  ExpediteScope, HoldAllScope, HoldShortTarget, PushDir, ReportKind, ResultCode, SingleAircraftCommand, TaxiDest, TurnDir, UnableReason,
} from './commandAst';
import { IMMEDIATE_KINDS, describe, isAircraftCommand, isSystemCommand } from './commandAst';
import type { PhraseCtx } from './phraseology';
import { readback as phraseReadback, transmission as phraseTransmission, unableLine } from './phraseology';
import type { ActionCtx, FixInfo, RunwayInfo, StandInfo, ValidationResult, VehicleInfo } from './commandTree';
import { REASONS, actionsFor, validateAst } from './commandTree';
import type { ParseAircraft, ParseCtx, ParseErrorCode, ParseResult } from './commands';
import { parseCommand } from './commands';
import { headingTo, NM_TO_M, dist as xyDist } from './projection';

// ──────────────────────────────────────────────────────────────────────────────
//  The engine surface dispatch codes against (W1-ENGINE implements on SimEngine)
// ──────────────────────────────────────────────────────────────────────────────
export interface EngineCommandApi {
  readonly time: number;
  paused: boolean;
  find(cs: string): AircraftState | undefined;
  /** Pilot delay (s) for this aircraft/kind: 3 s air, 4-8 s ground, x2 for incapacitation (03 §8, §F4.16). */
  pilotDelayS(a: AircraftState, kind: CommandAST['kind']): number;
  /** Phrase context (variant, telephony, wind, frequencies, magVar, ...) for an aircraft or the system. */
  phraseCtx(a: AircraftState | null): PhraseCtx;
  /** Strict-frequency policy: true when the player may command this aircraft from the current position. */
  onPlayerFrequency(a: AircraftState): boolean;
  /** Called by dispatch after composing the result: emits transmission + schedules readback event, updates ack state, stats. */
  onTransmission(ast: CommandAST, result: CommandResult, a: AircraftState | null): void;

  // ── ground ──
  cmdStartup(a: AircraftState, expectRunway: string | null): EngineOutcome;
  cmdPushback(a: AircraftState, dir: PushDir, expectRunway: string | null, withStartup: boolean, tailTo: string | null): EngineOutcome;
  cmdTaxi(a: AircraftState, dest: TaxiDest, via: string[], auto: boolean, holdShortOf: HoldShortTarget | null, cross: string[], expedite: boolean): EngineOutcome;
  cmdHoldShort(a: AircraftState, of: HoldShortTarget): EngineOutcome;
  cmdHoldPosition(a: AircraftState): EngineOutcome;
  cmdContinue(a: AircraftState, holdShortOf: HoldShortTarget | null): EngineOutcome;
  cmdCross(a: AircraftState, runway: string, expedite: boolean, behind: string | null): EngineOutcome;
  cmdGiveWay(a: AircraftState, to: string, mode: 'give_way' | 'follow'): EngineOutcome;
  cmdLineUp(a: AircraftState, runway: string, behind: string | null, intersection: string | null): EngineOutcome;
  cmdTakeoff(a: AircraftState, runway: string, opts: { immediate: boolean; afterDepHdg: number | 'runway' | null; turn: { dir: TurnDir; deg: number } | null; initialAlt: number | null; contactDeparture: boolean }): EngineOutcome;
  cmdCancelTakeoff(a: AircraftState): EngineOutcome;
  cmdCancelLineup(a: AircraftState, via: string | null): EngineOutcome;
  cmdExitAt(a: AircraftState, exit: ExitSpec, expedite: boolean, holdShortOf: HoldShortTarget | null, contactGround: boolean): EngineOutcome;
  cmdExpedite(a: AircraftState, on: boolean, scope: ExpediteScope): EngineOutcome;
  // ── tower ──
  cmdClearedLand(a: AircraftState, runway: string, lahso: string | null, exit: ExitSpec | null): EngineOutcome;
  cmdContinueApproach(a: AircraftState, number: number | null): EngineOutcome;
  cmdGoAround(a: AircraftState, heading: number | 'runway' | null, alt: number | null, contact: Position | null): EngineOutcome;
  cmdWindCheck(a: AircraftState): EngineOutcome;
  cmdHandoff(a: AircraftState, position: Position, when: ContactWhen): EngineOutcome;
  // ── approach ──
  cmdHeading(a: AircraftState, hdg: number, dir: TurnDir | null, when: PendingCondition | null): EngineOutcome;
  cmdAltitude(a: AircraftState, ft: number, expedite: boolean, when: PendingCondition | null): EngineOutcome;
  cmdSpeed(a: AircraftState, kts: number | 'resume', untilNM: number | null): EngineOutcome;
  cmdDirect(a: AircraftState, fix: string, thenHdg: number | null): EngineOutcome;
  cmdHold(a: AircraftState, fix: string, inbound: number | null, dir: TurnDir | null, legTimeMin: number | null, legNM: number | null, efc: number | null): EngineOutcome;
  cmdILS(a: AircraftState, runway: string): EngineOutcome;
  cmdLOC(a: AircraftState, runway: string, maintainAlt: number | null): EngineOutcome;
  cmdVisual(a: AircraftState, runway: string, follow: string | null): EngineOutcome;
  cmdCancelApproach(a: AircraftState, hdg: number, alt: number, dir: TurnDir | null): EngineOutcome;
  cmdExpectRunway(a: AircraftState, runway: string, approach: ApproachType): EngineOutcome;
  cmdResumeSid(a: AircraftState): EngineOutcome;
  cmdSquawk(a: AircraftState, code: string): EngineOutcome;
  cmdIdent(a: AircraftState): EngineOutcome;
  cmdRadarContact(a: AircraftState, descendTo: number | null, expectRunway: string | null): EngineOutcome;
  // ── meta ──
  cmdSayAgain(a: AircraftState): EngineOutcome;
  cmdCorrection(a: AircraftState, field: CorrectionField, value: number | string): EngineOutcome;
  /** Drops the newest cancellable pending command (nothing_pending when none). */
  cmdDisregard(a: AircraftState): EngineOutcome;
  cmdStandby(a: AircraftState): EngineOutcome;
  cmdUnable(a: AircraftState, reason: UnableReason): EngineOutcome;
  cmdReport(a: AircraftState, items: ReportKind[]): EngineOutcome;
  cmdRoger(a: AircraftState): EngineOutcome;
  // ── emergency ──
  cmdEmergencyAck(a: AircraftState, ask: EmergencyInfoKind[], squawk: boolean): EngineOutcome;
  cmdPriority(a: AircraftState, runway: string, opts: { straightIn: boolean; numberOne: boolean; sterile: boolean; clearIls: boolean }): EngineOutcome;
  cmdStopOnRunway(a: AircraftState, mode: 'stop' | 'vacate_if_able', via: string | null): EngineOutcome;
  cmdEmergencyCancelAck(a: AircraftState): EngineOutcome;
  // ── system ──
  holdAll(scope: HoldAllScope, runway: string | null): EngineOutcome;
  resumeAll(): EngineOutcome;
  reopenRunway(runway: string, afterInspection: boolean): EngineOutcome;
  dispatchVehicle(type: VehicleType, ids: string[], count: number, target: VehicleTarget): EngineOutcome;
  recallVehicle(id: string): EngineOutcome;
  vehicleOp(id: string, op: 'hold' | 'continue' | 'cross' | 'rtb', runway: string | null): EngineOutcome;
  setRunwayStatus(runway: string, status: RunwayStatus, reason: string | null): EngineOutcome;
  broadcast(text: string): EngineOutcome;
}

/** A parser-detached condition ("after pushback taxi ...") to attach to the queued command of that kind. */
export interface DetachedCondition { kind: CommandKind; condition: PendingCondition }

export interface DispatchOptions {
  /** 'player' (default) or 'ai' (AI-assist positions; logged grey, never scored against the player). */
  who?: 'player' | 'ai';
  /** Skip the strict-frequency guard (used by AI positions and tests). */
  ignoreFrequency?: boolean;
  /** ActionCtx to validate against (the store passes the one it built for the panel); built from the engine when absent. */
  ctx?: ActionCtx | null;
  /** false = skip the UX §G3 validation layer entirely (engine guards still apply). */
  validate?: boolean;
  /** Conditions the parser could not attach to the AST (ParseResult.detachedConditions). */
  conditions?: DetachedCondition[];
}

/** CommandResult plus the soft warnings and per-part outcome of a sequence. */
export interface DispatchResult extends CommandResult {
  /** Soft warnings (UX §G3 amber "TRANSMIT ANYWAY" texts) that did not block the transmission. */
  warnings: string[];
  /** Sequence only: describe() strings of the parts that were applied/queued (after any rollback). */
  appliedParts?: string[];
}

/** Codes that mean "nothing was transmitted" (SYS line only). */
export const SILENT_CODES: readonly ResultCode[] = [
  'not_found', 'not_on_frequency', 'invalid_stage', 'invalid_param', 'unknown_runway', 'unknown_fix', 'unknown_taxiway',
  'unknown_stand', 'unknown_vehicle', 'no_route', 'runway_closed', 'weight_class', 'not_at_hold', 'already', 'paused',
  'held_by_emergency', 'vehicle_unavailable', 'nothing_pending', 'not_implemented', 'no_ils', 'too_low', 'past_abort_speed',
  'runway_occupied',
];

export function isSilent(code: ResultCode): boolean { return SILENT_CODES.includes(code); }

/** Route ONE non-sequence AST to its engine method (implemented: this mapping IS the contract). */
export function applyToEngine(engine: EngineCommandApi, ast: CommandAST, a: AircraftState | null): EngineOutcome {
  if (isSystemCommand(ast)) {
    switch (ast.kind) {
      case 'holdAll': return engine.holdAll(ast.scope, ast.runway);
      case 'resumeAll': return engine.resumeAll();
      case 'reopenRunway': return engine.reopenRunway(ast.runway, ast.afterInspection);
      case 'dispatchVehicle': return engine.dispatchVehicle(ast.type, ast.ids, ast.count, ast.target);
      case 'recallVehicle': return engine.recallVehicle(ast.id);
      case 'vehicleOp': return engine.vehicleOp(ast.id, ast.op, ast.runway);
      case 'runwayStatus': return engine.setRunwayStatus(ast.runway, ast.status, ast.reason);
      case 'broadcast': return engine.broadcast(ast.text);
    }
  }
  if (!a) return { ok: false, code: 'not_found', reason: 'No aircraft' };
  switch (ast.kind) {
    case 'startup': return engine.cmdStartup(a, ast.expectRunway);
    case 'pushback': return engine.cmdPushback(a, ast.dir, ast.expectRunway, ast.startup, ast.tailTo);
    case 'taxi': return engine.cmdTaxi(a, ast.dest, ast.via, ast.auto, ast.holdShortOf, ast.cross, ast.expedite);
    case 'holdShort': return engine.cmdHoldShort(a, ast.of);
    case 'holdPosition': return engine.cmdHoldPosition(a);
    case 'continue': return engine.cmdContinue(a, ast.holdShortOf);
    case 'cross': return engine.cmdCross(a, ast.runway, ast.expedite, ast.behind);
    case 'giveWay': return engine.cmdGiveWay(a, ast.to, ast.mode);
    case 'lineup': return engine.cmdLineUp(a, ast.runway, ast.behind, ast.intersection);
    case 'takeoff': return engine.cmdTakeoff(a, ast.runway, { immediate: ast.immediate, afterDepHdg: ast.afterDepHdg, turn: ast.turn, initialAlt: ast.initialAlt, contactDeparture: ast.contactDeparture });
    case 'cancelTakeoff': return engine.cmdCancelTakeoff(a);
    case 'cancelLineup': return engine.cmdCancelLineup(a, ast.via);
    case 'exitAt': return engine.cmdExitAt(a, ast.exit, ast.expedite, ast.holdShortOf, ast.contactGround);
    case 'expedite': return engine.cmdExpedite(a, ast.on, ast.scope);
    case 'clearedLand': return engine.cmdClearedLand(a, ast.runway, ast.lahso, ast.exit);
    case 'continueApproach': return engine.cmdContinueApproach(a, ast.number);
    case 'goAround': return engine.cmdGoAround(a, ast.heading, ast.alt, ast.contact);
    case 'windCheck': return engine.cmdWindCheck(a);
    case 'contact': return engine.cmdHandoff(a, ast.position, ast.when);
    case 'heading': return engine.cmdHeading(a, ast.hdg, ast.dir, ast.when);
    case 'altitude': return engine.cmdAltitude(a, ast.ft, ast.expedite, ast.when);
    case 'speed': return engine.cmdSpeed(a, ast.kts, ast.untilNM);
    case 'direct': return engine.cmdDirect(a, ast.fix, ast.thenHdg);
    case 'hold': return engine.cmdHold(a, ast.fix, ast.inbound, ast.dir, ast.legTimeMin, ast.legNM, ast.efc);
    case 'ils': return engine.cmdILS(a, ast.runway);
    case 'loc': return engine.cmdLOC(a, ast.runway, ast.maintainAlt);
    case 'visual': return engine.cmdVisual(a, ast.runway, ast.follow);
    case 'cancelApproach': return engine.cmdCancelApproach(a, ast.hdg, ast.alt, ast.dir);
    case 'expectRunway': return engine.cmdExpectRunway(a, ast.runway, ast.approach);
    case 'resumeSid': return engine.cmdResumeSid(a);
    case 'squawk': return engine.cmdSquawk(a, ast.code);
    case 'ident': return engine.cmdIdent(a);
    case 'radarContact': return engine.cmdRadarContact(a, ast.descendTo, ast.expectRunway);
    case 'sayAgain': return engine.cmdSayAgain(a);
    case 'correction': return engine.cmdCorrection(a, ast.field, ast.value);
    case 'disregard': return engine.cmdDisregard(a);
    case 'standby': return engine.cmdStandby(a);
    case 'unable': return engine.cmdUnable(a, ast.reason);
    case 'report': return engine.cmdReport(a, ast.items);
    case 'roger': return engine.cmdRoger(a);
    case 'emergencyAck': return engine.cmdEmergencyAck(a, ast.ask, ast.squawk);
    case 'priority': return engine.cmdPriority(a, ast.runway, { straightIn: ast.straightIn, numberOne: ast.numberOne, sterile: ast.sterile, clearIls: ast.clearIls });
    case 'stopOnRunway': return engine.cmdStopOnRunway(a, ast.mode, ast.via);
    case 'emergencyCancelAck': return engine.cmdEmergencyCancelAck(a);
    case 'sequence': return { ok: false, code: 'invalid_param', reason: 'nested sequence' };
  }
}

/**
 * Per-kind pre-flight guards evaluated BEFORE the engine method (cheap, pure).
 * Returns null when the command may proceed. Engine-data guards (runway
 * occupancy, weight class, closed runway, arrival < 2 NM, ...) live in
 * commandTree.validateAst and run from dispatch() with an ActionCtx.
 */
export function guard(ast: CommandAST, a: AircraftState | null, engine: EngineCommandApi): EngineOutcome | null {
  if (engine.paused) return { ok: false, code: 'paused', reason: 'Paused' };
  if (isSystemCommand(ast)) {
    if (ast.kind === 'broadcast' && !ast.text.trim()) return { ok: false, code: 'invalid_param', reason: 'Broadcast text required' };
    if ((ast.kind === 'reopenRunway' || ast.kind === 'runwayStatus') && !ast.runway) return { ok: false, code: 'invalid_param', reason: 'Runway required' };
    if ((ast.kind === 'recallVehicle' || ast.kind === 'vehicleOp') && !ast.id) return { ok: false, code: 'invalid_param', reason: 'Vehicle id required' };
    if (ast.kind === 'vehicleOp' && ast.op === 'cross' && !ast.runway) return { ok: false, code: 'invalid_param', reason: 'Cross which runway?' };
    if (ast.kind === 'dispatchVehicle' && !ast.ids.length && ast.count < 1) return { ok: false, code: 'invalid_param', reason: 'Vehicle count required' };
    return null;
  }
  if (!a) return { ok: false, code: 'not_found', reason: `No aircraft ${ast.callsign} on frequency` };
  if (ast.kind === 'sequence') {
    if (!ast.parts.length) return { ok: false, code: 'invalid_param', reason: 'Empty transmission' };
    if (ast.parts.length > 4) return { ok: false, code: 'invalid_param', reason: 'Max 1 base + 3 parts' };
    for (const p of ast.parts) {
      if (p.callsign !== ast.callsign) return { ok: false, code: 'invalid_param', reason: `Part ${p.kind} addressed to ${p.callsign}` };
      const g = guardPart(p);
      if (g) return g;
    }
    return null;
  }
  return guardPart(ast);
}

function guardPart(ast: SingleAircraftCommand): EngineOutcome | null {
  const bad = (reason: string): EngineOutcome => ({ ok: false, code: 'invalid_param', reason });
  switch (ast.kind) {
    case 'cancelApproach': return !ast.hdg || !ast.alt ? bad(REASONS.R7) : null;
    case 'squawk': return /^[0-7]{4}$/.test(ast.code) ? null : bad('Squawk must be four octal digits');
    case 'heading': return (ast.hdg < 0 || ast.hdg > 360) ? bad('Heading 001-360') : null;
    case 'altitude': return ast.ft <= 0 || ast.ft % 100 !== 0 ? bad('Altitude must be a multiple of 100 ft') : null;
    case 'speed': return ast.kts !== 'resume' && (ast.kts < 50 || ast.kts > 400) ? bad('Speed 100-350 kt') : null;
    case 'taxi': return ast.dest.kind === 'runway' && !ast.dest.runway ? bad('Runway required') : ast.dest.kind === 'stand' && !ast.dest.ref ? bad('Stand required') : null;
    case 'lineup': case 'takeoff': case 'clearedLand': case 'ils': case 'loc': case 'visual': case 'expectRunway': case 'priority': case 'cross':
      return ast.runway ? null : bad('Runway required');
    case 'direct': case 'hold': return ast.fix ? null : bad('Fix required');
    case 'giveWay': return ast.to ? (ast.to === ast.callsign ? bad('Cannot give way to self') : null) : bad('Aircraft required');
    case 'holdShort': return ast.of.kind === 'runway' && !ast.of.runway ? bad('Runway required') : ast.of.kind === 'taxiway' && !ast.of.taxiway ? bad('Taxiway required') : null;
    default: return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  ActionCtx from the live engine (duck-typed on SimEngine's public helpers)
// ──────────────────────────────────────────────────────────────────────────────
/** Optional members of SimEngine the ctx builders read when present (everything degrades gracefully when absent). */
export interface EngineCtxSource {
  aircraft?: AircraftState[];
  runways?: RunwayState[];
  gates?: GateState[];
  beacons?: Array<{ id: string; x: number; y: number }>;
  ilsRunways?: Array<{ name: string }>;
  entries?: unknown[];
  magVar?: number;
  transitionAltFt?: number;
  playerPosition?: PlayerPosition;
  settings?: { strictFrequencies?: boolean; sandbox?: boolean; region?: string };
  holdAllActive?: { scope: HoldAllScope; runway: string | null } | null;
  frequencies?: Partial<Record<Position, string>>;
  air?: { taxiwayNames?: string[]; taxiwayNodes?: Map<string, string[]> };
  fleet?: { list(): Vehicle[]; onRunway?(ref: string): Vehicle[] };
  stageOf?(a: AircraftState): Stage;
  runwayState?(name: string): RunwayState | undefined;
  runwayStates?(): RunwayState[];
  runwayOccupant?(name: string, exceptId?: number): string | null;
  arrivalOnFinal?(name: string, nm: number): { callsign: string; nm: number } | null;
  weightAllowed?(name: string, wc: WeightClass): boolean;
  standOccupant?(ref: string): string | null;
  wakeTimerRemainingS?(name: string, follower?: AircraftState['wakeCategory']): number;
  distToNextHold?(a: AircraftState): { m: number; runway: string | null; isCrossing: boolean } | null;
  parallelRunways?(name: string): string[];
  isOnRunway?(a: AircraftState): boolean;
  distToThresholdNM?(a: AircraftState, runway: string): number | null;
  wx?(): WeatherState;
  activeAlerts?(): Array<{ subjects: string[]; resolvedAt?: number | null; ack?: boolean }>;
}

const refOf = (name: string) => name.replace(/[LRC]$/, '');

function src(engine: EngineCommandApi): EngineCtxSource { return engine as unknown as EngineCtxSource; }
function runwayList(e: EngineCtxSource): RunwayState[] { return e.runwayStates?.() ?? e.runways ?? []; }
function rs(e: EngineCtxSource, name: string): RunwayState | undefined {
  const u = (name ?? '').toUpperCase();
  return e.runwayState?.(u) ?? runwayList(e).find(r => r.name === u);
}
function sameRunway(e: EngineCtxSource, x: string | null | undefined, y: string | null | undefined): boolean {
  if (!x || !y) return false;
  const a = rs(e, x), b = rs(e, y);
  return a && b ? a.ref === b.ref : refOf(x.toUpperCase()) === refOf(y.toUpperCase());
}

/**
 * Build the UX §G2/§G3 ActionCtx for `a` from the engine's public helpers. Returns
 * null when the engine cannot even report a stage (then dispatch skips validation).
 * The store may reuse this for the command panel (same rules, same data).
 */
export function actionCtxFromEngine(engine: EngineCommandApi, a: AircraftState | null, opts: { position?: PlayerPosition; sandbox?: boolean } = {}): ActionCtx | null {
  const e = src(engine);
  const stage: Stage | null = a ? (e.stageOf ? e.stageOf(a) : null) : 'departed';
  if (!stage) return null;
  const runways = runwayList(e);
  const ilsNames = new Set((e.ilsRunways ?? []).map(r => r.name.toUpperCase()));
  const wxs = e.wx?.() ?? null;
  const rwy = a ? (a.assignedRunway ?? a.plan.runway ?? null) : null;
  const nextHold = a && e.distToNextHold ? e.distToNextHold(a) : null;
  const alerts = e.activeAlerts?.() ?? [];
  const arrivalsOnFinal = (a && rwy && e.aircraft ? e.aircraft.filter(o => o.id !== a.id && o.plan.kind === 'arrival' && (o.ilsCaptured || o.phase === 'landing') && sameRunway(e, o.assignedRunway ?? o.plan.runway, rwy)).map(o => o.callsign) : []);
  const emergencyRwy = a?.emergency?.runway ?? null;
  const emergencyClosed = emergencyRwy && rs(e, emergencyRwy)?.status && rs(e, emergencyRwy)!.status !== 'open' ? emergencyRwy : null;
  const wc = a?.perf.weightClass;
  const holdScope = e.holdAllActive?.scope ?? null;
  const ctx: ActionCtx = {
    stage,
    position: opts.position ?? e.playerPosition ?? 'tower',
    time: engine.time,
    paused: engine.paused,
    sandbox: opts.sandbox ?? !!e.settings?.sandbox,
    strictFrequencies: !!e.settings?.strictFrequencies,
    hasRadar: (e.beacons?.length ?? 0) > 0 || (e.entries?.length ?? 0) > 0,
    hasIls: ilsNames.size > 0,
    hasSid: false,
    holdAllActive: holdScope === 'all',
    distToNextHoldM: nextHold ? nextHold.m : null,
    nextCrossingRunway: nextHold && nextHold.isCrossing ? nextHold.runway : null,
    nextHoldIsCrossing: !!nextHold?.isCrossing,
    distToThresholdNM: a && rwy && e.distToThresholdNM ? e.distToThresholdNM(a, rwy) : null,
    aglFt: a ? Math.max(0, a.altitude) : 0,
    groundSpeedKt: a ? a.speed : 0,
    aboveGlideslope: null,
    onRunway: a && e.isOnRunway ? e.isOnRunway(a) : false,
    sinceLastPilotLineS: a && a.lastTransmissionAt >= 0 ? engine.time - a.lastTransmissionAt : null,
    pendingRequest: a ? (a.requests.find(r => r.answeredAt == null) ?? a.requests[0] ?? null) : null,
    emergencyClosedRunway: emergencyClosed,
    otherArrivalsOnFinal: arrivalsOnFinal,
    runwayStatus: (r) => rs(e, r)?.status ?? 'open',
    runwayOccupant: (r) => (e.runwayOccupant ? e.runwayOccupant(r, a?.id) : (rs(e, r)?.occupiedBy.find(o => o.id !== a?.id)?.callsign ?? null)),
    arrivalOnFinal: (r) => { const x = e.arrivalOnFinal?.(r, 10); return x ? { callsign: x.callsign, nm: x.nm } : null; },
    parallelRunways: (r) => e.parallelRunways?.(r) ?? [],
    weightAllowed: (r) => (wc && e.weightAllowed ? e.weightAllowed(r, wc) : true),
    runwayActive: (r, role) => { const s = rs(e, r); return s ? (role === 'dep' ? s.activeDep : s.activeArr) : true; },
    standOccupant: (ref) => e.standOccupant?.(ref) ?? null,
    wakeTimerRemainingS: (r) => e.wakeTimerRemainingS?.(r, a?.wakeCategory) ?? 0,
    wind: wxs ? { dir: wxs.windDirTrue, kts: wxs.windKt, gust: wxs.gustKt } : null,
    runways: runways.map<RunwayInfo>(r => ({ name: r.name, ref: r.ref, headingTrue: r.headingTrue, status: r.status, activeDep: r.activeDep, activeArr: r.activeArr, hasIls: ilsNames.has(r.name), lengthM: r.lengthM, weightAllowed: wc ? (r.weightAllow ? r.weightAllow.includes(wc) : true) : true })),
    taxiways: e.air?.taxiwayNames ?? [],
    fixes: a ? (e.beacons ?? []).map<FixInfo>(b => ({ name: b.id, bearingTrue: headingTo(a.pos, b), distNM: xyDist(a.pos, b) / NM_TO_M })) : (e.beacons ?? []).map<FixInfo>(b => ({ name: b.id, bearingTrue: 0, distNM: 0 })),
    stands: (e.gates ?? []).map<StandInfo>(g => ({ ref: g.ref, terminal: g.terminal, occupant: e.standOccupant?.(g.ref) ?? null, reservedFor: g.reservedFor != null ? String(g.reservedFor) : null, closed: g.closed })),
    vehicles: safeList(e.fleet).map<VehicleInfo>(v => ({ id: v.id, callsign: v.callsign, type: v.type, state: v.state, available: v.state === 'standby', etaS: v.etaAt != null ? v.etaAt - engine.time : null })),
    positions: (['ground', 'tower', 'departure', 'approach'] as Position[]).map(p => ({ position: p, freq: e.frequencies?.[p] ?? '', label: p.toUpperCase() })),
    nearbyAircraft: [],
    msaFt: 1000,
    ceilingFt: 20000,
    transitionAltFt: e.transitionAltFt ?? 6000,
    magVar: e.magVar ?? 0,
    conflictActive: !!a && alerts.some(al => !al.resolvedAt && al.subjects.includes(a.callsign)),
    vehicleOnRunway: (r) => { const s = rs(e, r); const list = s && e.fleet?.onRunway ? safe(() => e.fleet!.onRunway!(s.ref), []) : []; return list[0]?.id ?? null; },
    takeoffClearanceHolder: (r) => rs(e, r)?.takeoffClearance ?? null,
    landingClearanceHolders: (r) => rs(e, r)?.landingClearances ?? [],
    runwayHeading: (r) => rs(e, r)?.headingTrue ?? null,
    phraseCtx: safe(() => engine.phraseCtx(a), undefined),
  };
  return ctx;
}

function safeList(fleet: EngineCtxSource['fleet']): Vehicle[] { return fleet ? safe(() => fleet.list(), [] as Vehicle[]) : []; }
function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

// ──────────────────────────────────────────────────────────────────────────────
//  dispatch
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Dispatch an AST. Sequences: parts are applied in order; the first hard
 * refusal (SILENT code) aborts the whole transmission (queued parts are rolled
 * back with cmdDisregard); pilot-side "unable" parts are collected into
 * `refused` and the rest apply (code 'partial'). Composes TX/RB via
 * phraseology and notifies the engine (onTransmission) exactly once.
 */
export function dispatch(engine: EngineCommandApi, ast: CommandAST, opts: DispatchOptions = {}): DispatchResult {
  const a = isAircraftCommand(ast) ? (engine.find(ast.callsign) ?? null) : null;
  const warnings: string[] = [];
  const finish = (r: DispatchResult): DispatchResult => { safe(() => engine.onTransmission(ast, r, a), undefined); return r; };
  const fail = (code: ResultCode, reason: string, extra: Partial<DispatchResult> = {}): DispatchResult =>
    finish({ ok: false, code, transmission: '', readback: '', reason, warnings, ...extra });

  // 1-2. resolve + pure guard
  const g = guard(ast, a, engine);
  if (g) return fail(g.code, g.reason ?? g.code);
  // 3. strict frequency (R13)
  if (a && opts.who !== 'ai' && !opts.ignoreFrequency && !engine.onPlayerFrequency(a)) return fail('not_on_frequency', REASONS.R13);
  // 4. UX §G3 validation
  if (opts.validate !== false) {
    const ctx = opts.ctx === undefined ? safe(() => actionCtxFromEngine(engine, a), null) : opts.ctx;
    if (ctx) {
      const v = safe<ValidationResult | null>(() => validateAst(ast, a, ctx), null);
      if (v) {
        if (v.errors.length) {
          const err = v.errors[0];
          const reason = err.part ? `${err.part}: ${err.text}` : err.text;
          if (isSilent(err.code)) return fail(err.code, reason);
          // pilot-side refusal (unable_*): transmitted, the pilot answers "unable", nothing executes (03 §B4)
          const pc = engine.phraseCtx(a);
          return finish({ ok: false, code: err.code, transmission: safe(() => phraseTransmission(ast, pc), describe(ast)), readback: safe(() => unableLine(ast, err.text, pc), ''), reason, warnings, readbackAt: a ? engine.time + readbackDelay(engine, a, ast.kind, undefined) : undefined });
        }
        for (const w of v.warnings) if (!warnings.includes(w.text)) warnings.push(w.text);
      }
    }
  }
  const pctx = engine.phraseCtx(a);
  const tx = () => safe(() => phraseTransmission(ast, pctx), describe(ast));

  // 5. system commands
  if (isSystemCommand(ast)) {
    const out = applyToEngine(engine, ast, null);
    if (!out.ok) {
      if (isSilent(out.code)) return fail(out.code, out.reason ?? out.code);
      return finish({ ok: false, code: out.code, transmission: tx(), readback: safe(() => unableLine(ast, out.reason ?? '', pctx), ''), reason: out.reason, warnings });
    }
    return finish({ ok: true, code: out.code, transmission: tx(), readback: safe(() => phraseReadback(ast, pctx), ''), applied: out.applied ?? true, warnings });
  }
  if (!a) return fail('not_found', `No aircraft ${ast.callsign} on frequency`);

  // 6. aircraft commands (single or sequence)
  const parts: SingleAircraftCommand[] = ast.kind === 'sequence' ? ast.parts : [ast];
  const applied: SingleAircraftCommand[] = [];
  const queued: SingleAircraftCommand[] = [];
  const refused: SingleAircraftCommand[] = [];
  let applyAt: number | undefined;
  let anyImmediate = false;
  let conditional = false;
  let unableCode: ResultCode | null = null;
  let unableReason: string | undefined;

  const rollback = () => {
    for (let i = queued.length - 1; i >= 0; i--) {
      const r = safe(() => engine.cmdDisregard(a), { ok: false, code: 'nothing_pending' } as EngineOutcome);
      if (r.ok) { const idx = applied.indexOf(queued[i]); if (idx >= 0) applied.splice(idx, 1); }
    }
    queued.length = 0;
  };

  for (const part of parts) {
    const out = applyToEngine(engine, part, a);
    if (out.ok) {
      applied.push(part);
      if (out.applyAt != null) { queued.push(part); applyAt = applyAt == null ? out.applyAt : Math.max(applyAt, out.applyAt); }
      if (out.applied) anyImmediate = true;
      if (out.code === 'ok_conditional') conditional = true;
      const det = opts.conditions?.find(c => c.kind === part.kind);
      if (det && attachCondition(a, part.kind, det.condition, engine.time)) conditional = true;
      continue;
    }
    if (isSilent(out.code)) {
      rollback();
      return fail(out.code, parts.length > 1 ? `${describe(part)}: ${out.reason ?? out.code}` : (out.reason ?? out.code), { appliedParts: parts.length > 1 ? applied.map(describe) : undefined });
    }
    if (out.code === 'queried') {
      rollback();
      const q = (out.reason ?? 'say again').replace(/[.?]+$/, '');
      return finish({ ok: false, code: 'queried', transmission: tx(), readback: `${q}?`, reason: out.reason, warnings, readbackAt: engine.time + readbackDelay(engine, a, ast.kind, undefined), appliedParts: parts.length > 1 ? applied.map(describe) : undefined });
    }
    // pilot-side refusal (unable_*): keep going with the remaining parts
    refused.push(part);
    unableCode = unableCode ?? out.code;
    unableReason = unableReason ?? out.reason;
  }

  const readbackAt = engine.time + readbackDelay(engine, a, ast.kind, applyAt);
  if (refused.length === parts.length) {
    // every part refused -> "unable ..., {cs}"
    return finish({
      ok: false, code: unableCode ?? 'unable', transmission: tx(),
      readback: safe(() => (parts.length > 1 ? phraseReadback(ast, pctx, undefined, refused) : unableLine(ast, unableReason ?? '', pctx)), ''),
      reason: unableReason, refused: refused.map(describe), warnings, readbackAt,
    });
  }
  const code: ResultCode = refused.length ? 'partial' : conditional ? 'ok_conditional' : applyAt != null ? 'ok_queued' : 'ok';
  return finish({
    ok: true, code, transmission: tx(),
    readback: safe(() => phraseReadback(ast, pctx, undefined, refused), ''),
    reason: refused.length ? unableReason : undefined,
    applied: anyImmediate && applyAt == null,
    refused: refused.length ? refused.map(describe) : undefined,
    readbackAt, applyAt, warnings,
    appliedParts: parts.length > 1 ? applied.map(describe) : undefined,
  });
}

/** Readback lands after the pilot delay but never after the command executes. */
function readbackDelay(engine: EngineCommandApi, a: AircraftState, kind: CommandKind, applyAt: number | undefined): number {
  const d = safe(() => engine.pilotDelayS(a, kind), 3);
  return applyAt != null ? Math.max(0, Math.min(d, applyAt - engine.time)) : d;
}

/**
 * Attach a parser-detached condition to the command of `kind` the engine just
 * queued (issued now, no condition yet). Returns true when attached. The engine
 * honours `PendingCmd.condition` generically in its drain loop.
 */
export function attachCondition(a: AircraftState, kind: CommandKind, condition: PendingCondition, now: number): boolean {
  for (let i = a.pendingCmds.length - 1; i >= 0; i--) {
    const c = a.pendingCmds[i];
    if (c.kind !== kind) continue;
    if (c.issuedAt != null && c.issuedAt !== now) continue;
    if (c.condition) return false;
    c.condition = condition;
    return true;
  }
  return false;
}

/** Build a CommandResult from an outcome plus text (helper shared by dispatch and the AI positions). */
export function composeResult(outcome: EngineOutcome, transmission: string, readback: string, readbackAt?: number): CommandResult {
  return {
    ok: outcome.ok, code: outcome.code, transmission, readback,
    reason: outcome.reason, applied: outcome.applied, refused: outcome.refused, readbackAt, applyAt: outcome.applyAt,
  };
}

/** True when a kind executes immediately (no pilot delay / undo window). */
export function isImmediate(ast: CommandAST): boolean {
  return IMMEDIATE_KINDS.includes(ast.kind);
}

/** Type helper for W1-COMMANDS: the single-part kinds a sequence may contain. */
export type SequencePart = SingleAircraftCommand;

// ──────────────────────────────────────────────────────────────────────────────
//  Text entry point + parser/autocomplete context
// ──────────────────────────────────────────────────────────────────────────────
/** Context the text parser and `suggest()` consume (alias kept for the store / autocomplete). */
export type SuggestCtx = ParseCtx;

export interface FromEngineOptions {
  /** Verb-first lines address this callsign. */
  lastCallsign?: string | null;
  /** Compute `enabledActions` per aircraft via actionsFor (authoritative verb filter; costs ~47 stepsFor per aircraft). */
  withActions?: boolean;
  position?: PlayerPosition;
}

/** Build the parser / autocomplete context from the live engine. */
export function fromEngine(engine: EngineCommandApi, opts: FromEngineOptions = {}): SuggestCtx {
  const e = src(engine);
  const list = e.aircraft ?? [];
  const aircraft = list.map<ParseAircraft>(a => {
    const stage = e.stageOf ? safe(() => e.stageOf!(a), undefined) : undefined;
    const row: ParseAircraft = {
      id: a.id, callsign: a.callsign, flightNo: a.flightNo, airline: a.airline, type: a.perf.icaoCode, stage,
      altitude: a.altitude, heading: a.heading,
      plan: { kind: a.plan.kind, runway: a.plan.runway ?? null, gateRef: a.plan.gateRef ?? a.reservedStand ?? null, fix: a.plan.fix ?? a.holdFixName ?? a.directTargetName ?? null },
      holdShortRunway: a.holdShortRunway, assignedRunway: a.assignedRunway, onFrequency: a.onFrequency,
      takeoffCleared: a.takeoffCleared, ilsArmed: a.ilsArmed, hasRequest: a.requests.some(r => r.answeredAt == null),
      emergency: !!a.emergency, minCleanKt: Math.ceil(a.perf.minAirspeedTMA / 10) * 10,
    };
    if (opts.withActions) {
      const ctx = safe(() => actionCtxFromEngine(engine, a, { position: opts.position }), null);
      if (ctx) row.enabledActions = safe(() => actionsFor(a, ctx).filter(r => r.state === 'enabled').map(r => r.id), undefined);
    }
    return row;
  });
  const taxiwayNodes = e.air?.taxiwayNodes;
  return {
    aircraft,
    runways: runwayList(e).map(r => r.name),
    taxiways: e.air?.taxiwayNames ?? [],
    fixes: (e.beacons ?? []).map(b => b.id),
    stands: (e.gates ?? []).map(g => g.ref),
    vehicles: safeList(e.fleet).map(v => v.id),
    lastCallsign: opts.lastCallsign ?? null,
    magVar: e.magVar ?? 0,
    time: engine.time,
    runwayHeadingTrue: (rwy) => rs(e, rwy)?.headingTrue ?? null,
    intersectionNode: taxiwayNodes ? (x, y) => {
      const A = taxiwayNodes.get(x.toUpperCase()) ?? [], B = new Set(taxiwayNodes.get(y.toUpperCase()) ?? []);
      const id = A.find(n => B.has(n));
      return id ? { nodeId: id, label: `${x.toUpperCase()}/${y.toUpperCase()}` } : null;
    } : undefined,
  };
}

const PARSE_CODE_MAP: Partial<Record<ParseErrorCode, ResultCode>> = {
  unknown_callsign: 'not_found', ambiguous_callsign: 'not_found', unknown_aircraft: 'not_found',
  unknown_runway: 'unknown_runway', unknown_taxiway: 'unknown_taxiway', unknown_fix: 'unknown_fix', unknown_stand: 'unknown_stand', unknown_vehicle: 'unknown_vehicle',
  unsupported: 'not_implemented',
};

export interface ExecuteTextResult { parse: ParseResult; result: DispatchResult }

/**
 * Command-line / STT entry point: parse `text` (with `ctx` or a context built
 * from the engine) and dispatch the AST. A failed parse yields a silent result
 * (SYS line) whose `reason` is the parser message; nothing reaches the engine.
 */
export function executeText(engine: EngineCommandApi, text: string, ctx?: ParseCtx | null, opts: DispatchOptions & FromEngineOptions = {}): ExecuteTextResult {
  const pctx = ctx ?? fromEngine(engine, { lastCallsign: opts.lastCallsign, position: opts.position });
  const parse = parseCommand(text, pctx);
  if (!parse.ok || !parse.ast) {
    const err = parse.errors[0];
    const code: ResultCode = err ? (PARSE_CODE_MAP[err.code] ?? 'invalid_param') : 'invalid_param';
    return { parse, result: { ok: false, code, transmission: '', readback: '', reason: err?.message ?? 'Unable to parse', warnings: [] } };
  }
  const { lastCallsign: _lc, withActions: _wa, ...dopts } = opts;
  void _lc; void _wa;
  const result = dispatch(engine, parse.ast, { ...dopts, conditions: parse.detachedConditions ?? dopts.conditions });
  return { parse, result };
}

/** Describe-level helper for logs: the callsign an AST addresses (null for system commands). */
export function targetOf(ast: CommandAST): string | null { return isAircraftCommand(ast) ? ast.callsign : null; }

// Wave-2 shim: the legacy `parseCommand(engine, text)` overload in commands.ts
// (still used by the current simStore) dispatches through this hook so the UI
// command line works end-to-end before W2-STORE switches to executeText().
// commands.ts cannot import this module directly (it would be a cycle).
(globalThis as { __atcDispatch?: (engine: EngineCommandApi, ast: CommandAST) => CommandResult }).__atcDispatch = (engine, ast) => dispatch(engine, ast);

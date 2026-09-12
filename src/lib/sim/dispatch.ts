// ============================================================
//  dispatch — CommandAST -> engine method -> CommandResult (CONTRACT STUB)
//
//  Ownership: W0 wrote the contract (EngineCommandApi = the exact method set
//  W1-ENGINE must implement on SimEngine; the AST->method routing; the result
//  composition). W1-COMMANDS owns this file from Wave 1 (guards, sequences,
//  partial refusals, strict-frequency policy, event emission details).
//
//  Flow for one transmission (UX §1.1):
//    UI/parser -> dispatch(engine, ast)
//      1. resolve callsign (not_found -> SYS line, no radio)
//      2. strict-frequency guard (not_on_frequency, R13)
//      3. paused guard
//      4. route each part to the engine method; the engine returns EngineOutcome
//         (state changes are queued behind the pilot delay unless the kind is in
//         IMMEDIATE_KINDS; refused parts come back in `refused`)
//      5. compose transmission()/readback() via phraseology with the engine's PhraseCtx
//      6. engine.onTransmission(ast, result) emits `transmission` (ATC line, now)
//         and schedules the `readback` event at readbackAt (pilot line)
//      7. return CommandResult to the caller (store pushes both lines; test API returns it)
// ============================================================
import type { AircraftState, PendingCondition, Position, RunwayStatus, VehicleTarget, VehicleType } from './types';
import type {
  ApproachType, CommandAST, CommandResult, ContactWhen, CorrectionField, EmergencyInfoKind, EngineOutcome, ExitSpec,
  ExpediteScope, HoldAllScope, HoldShortTarget, PushDir, ReportKind, ResultCode, SingleAircraftCommand, TaxiDest, TurnDir, UnableReason,
} from './commandAst';
import { IMMEDIATE_KINDS, isSystemCommand } from './commandAst';
import type { PhraseCtx } from './phraseology';

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

export interface DispatchOptions {
  /** 'player' (default) or 'ai' (AI-assist positions; logged grey, never scored against the player). */
  who?: 'player' | 'ai';
  /** Skip the strict-frequency guard (used by AI positions and tests). */
  ignoreFrequency?: boolean;
}

/** Codes that mean "nothing was transmitted" (SYS line only). */
export const SILENT_CODES: readonly ResultCode[] = [
  'not_found', 'not_on_frequency', 'invalid_stage', 'invalid_param', 'unknown_runway', 'unknown_fix', 'unknown_taxiway',
  'unknown_stand', 'unknown_vehicle', 'no_route', 'runway_closed', 'weight_class', 'not_at_hold', 'already', 'paused',
  'held_by_emergency', 'vehicle_unavailable', 'nothing_pending', 'not_implemented', 'no_ils', 'too_low', 'past_abort_speed',
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
 * Returns null when the command may proceed. W1-COMMANDS extends this table
 * with the UX §9 / §G3 hard blocks that need engine data (runway occupancy,
 * weight class, closed runway, arrival < 2 NM, ...) via the ActionCtx.
 */
export function guard(ast: CommandAST, a: AircraftState | null, engine: EngineCommandApi): EngineOutcome | null {
  if (engine.paused) return { ok: false, code: 'paused', reason: 'Paused' };
  if (isSystemCommand(ast)) return null;
  if (!a) return { ok: false, code: 'not_found', reason: `No aircraft ${ast.callsign} on frequency` };
  if (ast.kind === 'sequence' && ast.parts.length > 4) return { ok: false, code: 'invalid_param', reason: 'Max 1 base + 3 parts' };
  if (ast.kind === 'cancelApproach' && (!ast.hdg || !ast.alt)) return { ok: false, code: 'invalid_param', reason: 'Needs heading and altitude' };
  if (ast.kind === 'squawk' && !/^[0-7]{4}$/.test(ast.code)) return { ok: false, code: 'invalid_param', reason: 'Squawk must be four octal digits' };
  if (ast.kind === 'heading' && (ast.hdg < 0 || ast.hdg > 360)) return { ok: false, code: 'invalid_param', reason: 'Heading 001-360' };
  return null;
}

/**
 * Dispatch an AST. Sequences: parts are applied in order; the first hard
 * refusal (SILENT code) aborts the whole transmission (nothing is queued);
 * pilot-side "unable" parts are collected into `refused` and the rest apply
 * (code 'partial'). Composes TX/RB via phraseology and notifies the engine.
 */
export function dispatch(engine: EngineCommandApi, ast: CommandAST, opts: DispatchOptions = {}): CommandResult {
  void engine; void ast; void opts;
  throw new Error('not implemented');
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

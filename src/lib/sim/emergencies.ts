// ============================================================
//  Emergencies — CONTRACT STUB (W1-SYSTEMS implements; W1-ENGINE calls)
//
//  12 primary types per 03 §4.1-4.12 plus `brake_fire` (03 §F 4.13 / UX
//  §G5.12 ground emergency). The catalogue below is DATA and complete: pilot
//  declaration lines, level, squawk, which stages can spawn it, what the
//  controller must do (checklist items), engine performance effects and
//  post-landing behaviour. Implementers fill the function bodies only.
//
//  Spawn model (UX §G5.12): probability per sim hour = EMERGENCY_RATE[setting];
//  kinds by stage; never more than one active emergency in Normal mode; fuelMin
//  counts down in sim minutes and 0 => `fuel_exhaustion` event (-2.0 skill).
// ============================================================
import type { AircraftState, ArffLevel, Emergency, EmergencyChecklistItem, EmergencyLevel, EmergencyType, ScoreEvent, SimEvent, Stage } from './types';
import { emptyChecklist } from './types';

// ──────────────────────────────────────────────────────────────────────────────
//  Catalogue
// ──────────────────────────────────────────────────────────────────────────────
export interface EmergencySpec {
  type: EmergencyType;
  level: EmergencyLevel;
  squawk: string | null;
  /** Relative spawn weight (03 §4 distribution). */
  weight: number;
  /** Stages in which this kind may be declared (UX §G5.12). */
  stages: Stage[];
  /** Pilot opening call; {cs} = telephony callsign, {rwy} = nearest suitable runway, {n} = souls, {fuel} = minutes. */
  pilotLine: string;
  /** Follow-up pilot line after `emergencyAck` (answers souls/fuel/intentions). */
  ackReply: string;
  /** Checklist items the controller must complete, in order, each within 60 s for +25 (03 §4). */
  required: EmergencyChecklistItem[];
  arff: ArffLevel;
  ambulance: boolean;
  /** Wants the longest / nearest runway. */
  runwayPreference: 'nearest' | 'longest' | 'any';
  /** Refuses holds / speed control (true = must not be delayed). */
  noDelay: boolean;
  /** Performance modifiers applied by the engine while active. */
  perf: { maxClimbRateFactor: number; maxSpeedKt: number | null; vappPlusKt: number; rolloutFactor: number; pilotDelayFactor: number };
  /** Minutes the pilot wants to be on the ground within (null = no target). */
  landWithinMin: number | null;
  /** Fuel remaining at declaration, minutes [min,max]; null = not fuel-related. */
  fuelMin: readonly [number, number] | null;
  /** After landing: stop on the runway probability (0-1) and runway closure minutes when stopped [min,max]. */
  stopOnRunwayP: number;
  closureMin: readonly [number, number];
  /** Evacuation probability once stopped. */
  evacuationP: number;
  /** Bonus points on safe conclusion (in addition to EMERGENCY_DONE +300). */
  bonus: { landedInTime: number; arffBeforeTouchdown: number };
}

export const EMERGENCY_CATALOGUE: Record<EmergencyType, EmergencySpec> = {
  engine_fire: {
    type: 'engine_fire', level: 'MAYDAY', squawk: '7700', weight: 6, stages: ['dep_climb', 'takeoff_air'],
    pilotLine: 'MAYDAY MAYDAY MAYDAY, {cs}, engine fire number two, request immediate return, vectors ILS {rwy}.',
    ackReply: '{n} souls on board, fuel {fuel} minutes, request ILS {rwy}, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'arff', 'hold_traffic', 'runway_closed', 'runway_reopened'],
    arff: 'full', ambulance: false, runwayPreference: 'nearest', noDelay: true,
    perf: { maxClimbRateFactor: 0.4, maxSpeedKt: 210, vappPlusKt: 0, rolloutFactor: 1, pilotDelayFactor: 1 },
    landWithinMin: 15, fuelMin: null, stopOnRunwayP: 1, closureMin: [20, 40], evacuationP: 0.3,
    bonus: { landedInTime: 200, arffBeforeTouchdown: 100 },
  },
  engine_failure: {
    type: 'engine_failure', level: 'MAYDAY', squawk: '7700', weight: 14, stages: ['takeoff_roll', 'takeoff_air', 'dep_climb'],
    pilotLine: 'MAYDAY MAYDAY MAYDAY, {cs}, engine failure, request return, runway {rwy}.',
    ackReply: '{n} souls, fuel {fuel} minutes, request vectors ILS {rwy}, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'arff', 'runway_closed', 'runway_reopened'],
    arff: 'local', ambulance: false, runwayPreference: 'longest', noDelay: false,
    perf: { maxClimbRateFactor: 0.35, maxSpeedKt: 220, vappPlusKt: 0, rolloutFactor: 1.2, pilotDelayFactor: 1 },
    landWithinMin: 20, fuelMin: null, stopOnRunwayP: 0.3, closureMin: [10, 30], evacuationP: 0.05,
    bonus: { landedInTime: 150, arffBeforeTouchdown: 100 },
  },
  medical: {
    type: 'medical', level: 'PAN', squawk: null, weight: 22, stages: ['dep_climb', 'dep_level', 'arr_inbound', 'arr_armed', 'arr_established', 'taxi_out', 'taxi_in'],
    pilotLine: 'PAN PAN PAN PAN PAN PAN, {cs}, medical emergency, passenger unconscious, request priority landing and medical assistance on arrival.',
    ackReply: '{n} on board, fuel {fuel} minutes, request direct routing, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'ambulance'],
    arff: 'none', ambulance: true, runwayPreference: 'any', noDelay: true,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 0, rolloutFactor: 1, pilotDelayFactor: 1 },
    landWithinMin: 12, fuelMin: null, stopOnRunwayP: 0, closureMin: [0, 0], evacuationP: 0,
    bonus: { landedInTime: 100, arffBeforeTouchdown: 0 },
  },
  fuel: {
    type: 'fuel', level: 'MAYDAY', squawk: '7700', weight: 18, stages: ['arr_inbound', 'arr_armed'],
    pilotLine: 'MAYDAY MAYDAY MAYDAY, {cs}, MAYDAY FUEL, fuel {fuel} minutes, request immediate landing runway {rwy}.',
    ackReply: '{n} souls, fuel {fuel} minutes, request straight-in {rwy}, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'arff'],
    arff: 'local', ambulance: false, runwayPreference: 'nearest', noDelay: true,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 0, rolloutFactor: 1, pilotDelayFactor: 1 },
    landWithinMin: null, fuelMin: [15, 40], stopOnRunwayP: 0, closureMin: [0, 0], evacuationP: 0,
    bonus: { landedInTime: 150, arffBeforeTouchdown: 0 },
  },
  depressurization: {
    type: 'depressurization', level: 'MAYDAY', squawk: '7700', weight: 4, stages: ['dep_level', 'arr_inbound'],
    pilotLine: 'MAYDAY MAYDAY MAYDAY, {cs}, emergency descent, depressurization, descending ten thousand, request nearest suitable airport.',
    ackReply: '{n} souls, fuel {fuel} minutes, levelling ten thousand, request vectors {rwy}, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'ambulance'],
    arff: 'local', ambulance: true, runwayPreference: 'any', noDelay: true,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 0, rolloutFactor: 1, pilotDelayFactor: 1 },
    landWithinMin: 20, fuelMin: null, stopOnRunwayP: 0, closureMin: [0, 0], evacuationP: 0,
    bonus: { landedInTime: 100, arffBeforeTouchdown: 0 },
  },
  bird_strike: {
    type: 'bird_strike', level: 'PAN', squawk: null, weight: 8, stages: ['takeoff_roll', 'takeoff_air', 'arr_final', 'arr_short_final'],
    pilotLine: 'PAN PAN PAN PAN PAN PAN, {cs}, bird strike on rotation, request return, runway {rwy}.',
    ackReply: '{n} souls, fuel {fuel} minutes, engine vibration, request return {rwy}, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'arff', 'inspection'],
    arff: 'local', ambulance: false, runwayPreference: 'any', noDelay: false,
    perf: { maxClimbRateFactor: 0.7, maxSpeedKt: 220, vappPlusKt: 0, rolloutFactor: 1, pilotDelayFactor: 1 },
    landWithinMin: 15, fuelMin: null, stopOnRunwayP: 0.1, closureMin: [3, 6], evacuationP: 0,
    bonus: { landedInTime: 100, arffBeforeTouchdown: 50 },
  },
  gear: {
    type: 'gear', level: 'PAN', squawk: null, weight: 10, stages: ['arr_inbound', 'arr_armed', 'arr_established'],
    pilotLine: 'PAN PAN PAN PAN PAN PAN, {cs}, unsafe gear indication, request low approach for gear check, then hold to troubleshoot.',
    ackReply: '{n} souls, fuel {fuel} minutes, nose gear not extended, request emergency landing {rwy}, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'arff', 'hold_traffic', 'runway_closed', 'runway_reopened'],
    arff: 'full', ambulance: true, runwayPreference: 'longest', noDelay: false,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: 200, vappPlusKt: 0, rolloutFactor: 0.6, pilotDelayFactor: 1 },
    landWithinMin: null, fuelMin: null, stopOnRunwayP: 1, closureMin: [45, 120], evacuationP: 0.2,
    bonus: { landedInTime: 100, arffBeforeTouchdown: 200 },
  },
  smoke: {
    type: 'smoke', level: 'MAYDAY', squawk: '7700', weight: 5, stages: ['dep_climb', 'dep_level', 'arr_inbound'],
    pilotLine: 'MAYDAY MAYDAY MAYDAY, {cs}, smoke in the cabin, request immediate landing, nearest runway, may evacuate on the runway.',
    ackReply: '{n} souls, fuel {fuel} minutes, request {rwy}, expect evacuation, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'arff', 'hold_traffic', 'runway_closed', 'runway_reopened'],
    arff: 'full', ambulance: true, runwayPreference: 'nearest', noDelay: true,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 20, rolloutFactor: 1, pilotDelayFactor: 1 },
    landWithinMin: 10, fuelMin: null, stopOnRunwayP: 1, closureMin: [30, 60], evacuationP: 0.6,
    bonus: { landedInTime: 250, arffBeforeTouchdown: 100 },
  },
  hydraulic: {
    type: 'hydraulic', level: 'PAN', squawk: null, weight: 8, stages: ['arr_inbound', 'arr_armed', 'dep_level'],
    pilotLine: 'PAN PAN PAN PAN PAN PAN, {cs}, hydraulic failure, request longest runway, will need to stop on the runway and tow, request no crossing traffic behind.',
    ackReply: '{n} souls, fuel {fuel} minutes, request {rwy}, expect to stop on the runway, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'arff', 'runway_closed', 'runway_reopened'],
    arff: 'local', ambulance: false, runwayPreference: 'longest', noDelay: false,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 20, rolloutFactor: 1.8, pilotDelayFactor: 1 },
    landWithinMin: null, fuelMin: null, stopOnRunwayP: 1, closureMin: [20, 40], evacuationP: 0,
    bonus: { landedInTime: 150, arffBeforeTouchdown: 50 },
  },
  hijack: {
    type: 'hijack', level: 'MAYDAY', squawk: '7500', weight: 1, stages: ['arr_inbound', 'dep_level'],
    pilotLine: '{cs}, squawking seven five zero zero.',
    ackReply: 'Affirm, {cs}.',
    required: ['acknowledge', 'priority_runway', 'arff', 'hold_traffic'],
    arff: 'full', ambulance: false, runwayPreference: 'any', noDelay: true,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 0, rolloutFactor: 1, pilotDelayFactor: 2 },
    landWithinMin: null, fuelMin: null, stopOnRunwayP: 0, closureMin: [0, 0], evacuationP: 0,
    bonus: { landedInTime: 0, arffBeforeTouchdown: 100 },
  },
  radio_failure: {
    type: 'radio_failure', level: 'PAN', squawk: '7600', weight: 4, stages: ['arr_inbound', 'arr_armed', 'dep_climb'],
    pilotLine: '',
    ackReply: '',
    required: ['acknowledge', 'priority_runway', 'hold_traffic'],
    arff: 'none', ambulance: false, runwayPreference: 'any', noDelay: false,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 0, rolloutFactor: 1, pilotDelayFactor: 1 },
    landWithinMin: null, fuelMin: null, stopOnRunwayP: 0, closureMin: [0, 0], evacuationP: 0,
    bonus: { landedInTime: 150, arffBeforeTouchdown: 0 },
  },
  general: {
    type: 'general', level: 'MAYDAY', squawk: '7700', weight: 6, stages: ['dep_climb', 'dep_level', 'arr_inbound', 'arr_armed'],
    pilotLine: 'MAYDAY MAYDAY MAYDAY, {cs}, flight control problem, request return, priority landing.',
    ackReply: '{n} souls, fuel {fuel} minutes, request {rwy}, {cs}.',
    required: ['acknowledge', 'souls_fuel', 'priority_runway', 'arff'],
    arff: 'full', ambulance: false, runwayPreference: 'longest', noDelay: true,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 30, rolloutFactor: 1.3, pilotDelayFactor: 1 },
    landWithinMin: 20, fuelMin: null, stopOnRunwayP: 0.3, closureMin: [10, 30], evacuationP: 0.1,
    bonus: { landedInTime: 100, arffBeforeTouchdown: 50 },
  },
  brake_fire: {
    type: 'brake_fire', level: 'PAN', squawk: null, weight: 4, stages: ['taxi_out', 'taxi_in', 'rollout', 'hold_short_dep', 'hold_short_cross'],
    pilotLine: 'PAN PAN PAN PAN PAN PAN, {cs}, hot brakes, possible brake fire, request to hold on the taxiway and fire service check.',
    ackReply: '{n} on board, holding position, request fire services, {cs}.',
    required: ['acknowledge', 'arff', 'hold_traffic'],
    arff: 'local', ambulance: false, runwayPreference: 'any', noDelay: true,
    perf: { maxClimbRateFactor: 1, maxSpeedKt: null, vappPlusKt: 0, rolloutFactor: 1, pilotDelayFactor: 1 },
    landWithinMin: null, fuelMin: null, stopOnRunwayP: 0, closureMin: [0, 0], evacuationP: 0.15,
    bonus: { landedInTime: 0, arffBeforeTouchdown: 50 },
  },
};

/** Emergencies per sim hour by setting (UX §G5.12). */
export const EMERGENCY_RATE: Record<'off' | 'rare' | 'normal' | 'training', number> = { off: 0, rare: 0.2, normal: 0.4, training: 1.2 };
/** Souls-on-board range by weight class (used for `soulsOnBoard`). */
export const SOULS_BY_CLASS = { L: [1, 4], M: [90, 189], H: [200, 380], S: [400, 520] } as const;
/** Checklist item deadline for the +25 bonus, s (03 §4). */
export const CHECKLIST_ITEM_DEADLINE_S = 60;
/** Souls/fuel query deadline before EMERGENCY_CHECKLIST_MISS (-100), s. */
export const SOULS_FUEL_DEADLINE_S = 180;

// ──────────────────────────────────────────────────────────────────────────────
//  Engine view the module needs
// ──────────────────────────────────────────────────────────────────────────────
export interface EmergencyEngineView {
  time: number;
  aircraft: readonly AircraftState[];
  stageOf(a: AircraftState): Stage;
  /** Nearest / longest suitable runway end for the aircraft (weight class, status open). */
  bestRunway(a: AircraftState, pref: EmergencySpec['runwayPreference']): string | null;
  setRunwayStatus(runway: string, status: 'open' | 'closed' | 'sterile' | 'inspection', reason: string): void;
  emit(ev: SimEvent): void;
  score(ev: ScoreEvent): void;
  /** Telephony for pilot lines. */
  telephony(cs: string): string;
}

export type EmergencySetting = keyof typeof EMERGENCY_RATE;

/** Build a fresh Emergency record (used by maybeDeclare and the test API's forceEmergency). */
export function createEmergency(type: EmergencyType, a: AircraftState, stage: Stage, time: number, souls: number, fuelMin: number | null, telephony: string, runway: string | null): Emergency {
  const spec = EMERGENCY_CATALOGUE[type];
  const fill = (s: string) => s.replace('{cs}', telephony).replace(/\{rwy\}/g, runway ?? '').replace('{n}', String(souls)).replace('{fuel}', String(fuelMin ?? ''));
  return {
    type, level: spec.level, status: 'declared', declaredAt: time, phase: a.phase, stage,
    soulsOnBoard: souls, fuelMin, squawk: spec.squawk, requests: [], runway: null,
    priority: false, sterile: false, arff: 'none', arffOnSceneAt: null, stopOnRunway: false, evacuation: false,
    closureMin: 0, landedAt: null, stoppedAt: null, resolvedAt: null, checklist: emptyChecklist(),
    pilotLine: fill(spec.pilotLine),
  };
}

/**
 * Random declaration hook, called by the engine once per sim second per
 * aircraft without an emergency. Returns the emergency to attach (the engine
 * sets a.emergency, a.squawk, a.priority and emits `emergency`/`alert`) or
 * null. Rules: rate per hour by `setting`; kind drawn from the catalogue rows
 * whose `stages` include the aircraft's stage, weighted; at most one active
 * emergency in the sim unless setting === 'training' (max 2); never within
 * the first 120 s of a session; never for an aircraft below 400 ft AGL on
 * departure (engine failure on the roll is handled by the RTO path).
 */
export function maybeDeclare(a: AircraftState, rng: () => number, view: EmergencyEngineView, setting: EmergencySetting): Emergency | null {
  void a; void rng; void view; void setting;
  throw new Error('not implemented');
}

/**
 * Side effects at declaration: squawk, priority flag, cancel holds/speed
 * restrictions for noDelay kinds, apply perf modifiers, raise the `emergency`
 * alert (critical), and for `radio_failure`/`hijack` set the silent behaviour
 * (no readbacks; follows last clearance / expected approach).
 */
export function onDeclared(view: EmergencyEngineView, a: AircraftState): void {
  void view; void a;
  throw new Error('not implemented');
}

/** Called each sim second while an emergency is active: fuel countdown, checklist deadlines, pilot re-calls, fire-out chance. */
export function stepEmergency(view: EmergencyEngineView, a: AircraftState, dt: number): void {
  void view; void a; void dt;
  throw new Error('not implemented');
}

/**
 * Called by the engine at touchdown of an emergency aircraft. Decides stop-on-
 * runway vs vacate (stopOnRunwayP, or forced by `stopOnRunway` command), sets
 * runway closure (closureMin), evacuation, status 'landed'/'stopped', and
 * schedules ARFF gather + tow. Returns the runway closure minutes (0 = none).
 */
export function handleLanded(view: EmergencyEngineView, a: AircraftState): number {
  void view; void a;
  throw new Error('not implemented');
}

/** Mark a checklist item done at `time`; returns the ScoreEvent (+25 within 60 s of the previous item / declaration) or null if already done. */
export function completeChecklistItem(a: AircraftState, item: EmergencyChecklistItem, time: number): ScoreEvent | null {
  void a; void item; void time;
  throw new Error('not implemented');
}

/** Scoring on resolution: EMERGENCY_DONE +300 x checklist completion ratio + catalogue bonuses; returns the ledger entries. */
export function scoreOnResolved(a: AircraftState, time: number): ScoreEvent[] {
  void a; void time;
  throw new Error('not implemented');
}

/** Scoring on a missed checklist deadline (EMERGENCY_CHECKLIST_MISS -100 each). */
export function scoreChecklistMiss(a: AircraftState, item: EmergencyChecklistItem, time: number): ScoreEvent {
  void a; void item; void time;
  throw new Error('not implemented');
}

/** Pilot's spoken ack reply for an emergency (fills souls/fuel/runway). */
export function ackReplyLine(a: AircraftState, telephony: string): string {
  const e = a.emergency;
  if (!e) return '';
  return EMERGENCY_CATALOGUE[e.type].ackReply
    .replace('{cs}', telephony).replace(/\{rwy\}/g, e.runway ?? a.plan.runway ?? '')
    .replace('{n}', String(e.soulsOnBoard)).replace('{fuel}', String(e.fuelMin ?? Math.round(a.fuelMin ?? 60)));
}

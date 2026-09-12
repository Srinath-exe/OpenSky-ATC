// ============================================================
//  Emergencies (W1-SYSTEMS implements; W1-ENGINE calls)
//
//  12 primary types per 03 §4.1-4.12 plus `brake_fire` (03 §F 4.13 / UX
//  §G5.12 ground emergency). The catalogue is DATA: pilot declaration lines,
//  level, squawk, which stages can spawn it, what the controller must do
//  (checklist items), engine performance effects and post-landing behaviour.
//
//  Spawn model (UX §G5.12, 03 §4): probability per sim hour = EMERGENCY_RATE
//  [setting] scaled by the per-kind weights; kinds by stage; never more than
//  one active emergency in Normal mode (two in Training); never in the first
//  120 s of a session; never below 400 ft AGL on departure. fuelMin counts
//  down in sim minutes and 0 => `fuel_exhaustion` event (-2.0 skill).
//
//  Progress model (stepEmergency): checklist deadlines (souls/fuel within
//  180 s, else EMERGENCY_CHECKLIST_MISS), pilot re-calls while unacknowledged,
//  engine-fire extinguish roll at 60 s (70 %), "land within N min" pressure
//  calls, medical deterioration, holds refused for noDelay kinds, automatic
//  stand-down 10 min after a safe stop with no fire (status -> resolved).
//
//  All randomness via rng.ts (rng / rf / chance) or the rng passed to
//  maybeDeclare (a subStream so emergencies never perturb traffic draws).
// ============================================================
import type { AircraftState, ArffLevel, Emergency, EmergencyChecklistItem, EmergencyLevel, EmergencyType, ScoreEvent, SimEvent, Stage } from './types';
import { SCORE_TABLE, emptyChecklist } from './types';
import { chance, rf, ri, rng } from './rng';

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
/** Points per checklist item completed within the deadline (03 §4). */
export const CHECKLIST_ITEM_POINTS = 25;
/** Automatic stand-down after a safe stop with no fire, s (03 §4 ARFF response model). */
export const STAND_DOWN_S = 600;
/** Maximum concurrent emergencies by setting (03 §4: 1, Training 2). */
export const MAX_CONCURRENT: Record<EmergencySetting, number> = { off: 0, rare: 1, normal: 1, training: 2 };
/** No declarations in the first N s of a session. */
export const QUIET_START_S = 120;
/** Pilot re-calls MAYDAY every N s while unacknowledged (max 3). */
export const RECALL_S = 60;
/** Engine fire: chance the fire is out after the extinguisher (60 s). */
export const FIRE_OUT_P = 0.7;
/** Order in which checklist items are expected, for the strip tick-list. */
export const CHECKLIST_ORDER: readonly EmergencyChecklistItem[] = ['acknowledge', 'souls_fuel', 'priority_runway', 'arff', 'ambulance', 'hold_traffic', 'runway_closed', 'runway_reopened', 'inspection'];
/** UI labels for the checklist (strip tick-list). */
export const CHECKLIST_LABEL: Record<EmergencyChecklistItem, string> = {
  acknowledge: 'Acknowledge MAYDAY / PAN', souls_fuel: 'Souls & fuel obtained', priority_runway: 'Priority runway assigned', arff: 'ARFF alerted',
  ambulance: 'Ambulance dispatched', hold_traffic: 'Traffic held / runway sterile', runway_closed: 'Runway closed after stop', runway_reopened: 'Runway reopened', inspection: 'Runway inspected',
};

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
    pilotLine: fill(spec.pilotLine).replace(/runway \./, 'runway.').replace(/\s+,/g, ','),
  };
}

/** Spoken nature for lines and ARFF intercom. */
export function natureOf(type: EmergencyType): string {
  switch (type) {
    case 'engine_fire': return 'engine fire';
    case 'engine_failure': return 'engine failure';
    case 'medical': return 'medical emergency';
    case 'fuel': return 'fuel emergency';
    case 'depressurization': return 'depressurization';
    case 'bird_strike': return 'bird strike';
    case 'gear': return 'unsafe gear';
    case 'smoke': return 'smoke in the cabin';
    case 'hydraulic': return 'hydraulic failure';
    case 'hijack': return 'unlawful interference';
    case 'radio_failure': return 'radio failure';
    case 'general': return 'flight control problem';
    case 'brake_fire': return 'hot brakes';
  }
}

/** Number of active (unresolved) emergencies in the sim. */
export function activeEmergencies(aircraft: readonly AircraftState[]): number {
  let n = 0;
  for (const a of aircraft) if (a.emergency && a.emergency.status !== 'resolved') n++;
  return n;
}

/** Catalogue rows eligible for a stage. */
export function eligibleTypes(stage: Stage): EmergencySpec[] {
  return (Object.values(EMERGENCY_CATALOGUE) as EmergencySpec[]).filter(s => s.stages.includes(stage));
}

/** Souls draw for a weight class (via the supplied rng). */
export function drawSouls(weightClass: keyof typeof SOULS_BY_CLASS, r: () => number): number {
  const [lo, hi] = SOULS_BY_CLASS[weightClass];
  return lo + Math.floor(r() * (hi - lo + 1));
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
  const rate = EMERGENCY_RATE[setting];
  if (rate <= 0 || a.emergency) return null;
  if (view.time < QUIET_START_S) return null;
  if (a.phase === 'arrived' || a.phase === 'departed' || a.phase === 'parked') return null;
  if (a.plan.kind === 'departure' && (a.phase === 'takeoff' || a.phase === 'climb') && a.altitude < 400 && a.phase !== 'takeoff') return null;
  if (a.phase === 'takeoff' && a.altitude < 400 && a.speed > 80) return null; // high-speed roll / initial rotation: RTO path
  if (activeEmergencies(view.aircraft) >= MAX_CONCURRENT[setting]) return null;
  const stage = view.stageOf(a);
  const rows = eligibleTypes(stage);
  if (!rows.length) return null;
  // per-second probability: rate/hour spread over the traffic present (so density does not multiply the rate)
  const exposed = Math.max(1, view.aircraft.filter(x => !x.emergency && x.phase !== 'parked' && x.phase !== 'arrived' && x.phase !== 'departed').length);
  const pPerSecond = rate / 3600 / exposed;
  if (rng() >= pPerSecond) return null;
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let pick = rng() * total;
  let spec = rows[rows.length - 1];
  for (const r of rows) { pick -= r.weight; if (pick <= 0) { spec = r; break; } }
  if (spec.type === 'depressurization' && a.altitude < 10000) return null; // only above FL100
  return buildEmergency(spec.type, a, stage, view, rng);
}

/** Build the record for a type (used by maybeDeclare and forceEmergency): souls, fuel, runway from the view. */
export function buildEmergency(type: EmergencyType, a: AircraftState, stage: Stage, view: EmergencyEngineView, r: () => number = rng): Emergency {
  const spec = EMERGENCY_CATALOGUE[type];
  const souls = drawSouls(a.perf.weightClass, r);
  const fuel = spec.fuelMin ? Math.round(spec.fuelMin[0] + r() * (spec.fuelMin[1] - spec.fuelMin[0])) : a.fuelMin != null ? Math.round(a.fuelMin) : Math.round(45 + r() * 75);
  const runway = view.bestRunway(a, spec.runwayPreference) ?? a.plan.runway ?? null;
  const e = createEmergency(type, a, stage, view.time, souls, spec.fuelMin ? fuel : null, view.telephony(a.callsign), runway);
  if (!spec.fuelMin) e.fuelMin = null;
  e.requests = initialRequests(spec, runway, r);
  return e;
}

function initialRequests(spec: EmergencySpec, runway: string | null, r: () => number): string[] {
  const rwy = runway ? `runway ${runway}` : 'the nearest runway';
  switch (spec.type) {
    case 'engine_fire': return ['request immediate return', `request vectors ILS ${rwy}`];
    case 'engine_failure': return r() < 0.5 && spec.level === 'MAYDAY' ? ['request return', 'request hold 20 minutes to dump fuel'] : ['request return', `request ${rwy}`];
    case 'medical': return ['request priority landing', 'request medical assistance on arrival', 'unable to hold'];
    case 'fuel': return ['request immediate landing', `request straight-in ${rwy}`];
    case 'depressurization': return ['emergency descent to ten thousand', 'request nearest suitable airport'];
    case 'bird_strike': return ['request return', `request ${rwy}`];
    case 'gear': return ['request low approach for gear check', 'request hold 20 minutes to troubleshoot'];
    case 'smoke': return ['request immediate landing', 'request nearest runway', 'may evacuate on the runway'];
    case 'hydraulic': return ['request longest runway', 'will stop on the runway and require tow', 'request no crossing traffic behind'];
    case 'hijack': return [];
    case 'radio_failure': return [];
    case 'general': return ['request return', 'request priority landing'];
    case 'brake_fire': return ['request to hold on the taxiway for cooling', 'request fire service check'];
  }
}

/** Per-aircraft progress memory that does not belong on the JSON Emergency record. */
interface Progress {
  recalls: number;
  nextRecallAt: number;
  fireRolled: boolean;
  fireOut: boolean | null;
  landWithinCalled: boolean;
  deteriorationCalled: boolean;
  flameoutEmitted: boolean;
  missedItems: Set<EmergencyChecklistItem>;
  evacuationCalled: boolean;
  fuelDumpUntil: number | null;
}
const progress = new WeakMap<Emergency, Progress>();
function prog(e: Emergency): Progress {
  let p = progress.get(e);
  if (!p) {
    p = { recalls: 0, nextRecallAt: e.declaredAt + RECALL_S, fireRolled: false, fireOut: null, landWithinCalled: false, deteriorationCalled: false, flameoutEmitted: false, missedItems: new Set(), evacuationCalled: false, fuelDumpUntil: null };
    progress.set(e, p);
  }
  return p;
}
const scoredResolved = new WeakSet<Emergency>();

function pilotEvent(view: EmergencyEngineView, a: AircraftState, line: string, change: 'declared' | 'acknowledged' | 'services' | 'landed' | 'stopped' | 'resolved' | 'update'): void {
  const e = a.emergency!;
  view.emit({ type: 'emergency', id: a.id, callsign: a.callsign, message: line, at: view.time, who: 'PILOT', position: a.onFrequency, data: { type: 'emergency', emergency: e, change } });
}
function sysEvent(view: EmergencyEngineView, a: AircraftState, line: string, change: 'declared' | 'acknowledged' | 'services' | 'landed' | 'stopped' | 'resolved' | 'update'): void {
  const e = a.emergency!;
  view.emit({ type: 'emergency', id: a.id, callsign: a.callsign, message: line, at: view.time, who: 'SYS', data: { type: 'emergency', emergency: e, change } });
}

/**
 * Side effects at declaration: squawk, priority flag, cancel holds/speed
 * restrictions for noDelay kinds, apply perf modifiers, emit the `emergency`
 * event (the store raises the critical alert / toast from it), and for
 * `radio_failure`/`hijack` set the silent behaviour (no readbacks; follows
 * last clearance / expected approach). Call once, right after `a.emergency` is set.
 */
export function onDeclared(view: EmergencyEngineView, a: AircraftState): void {
  const e = a.emergency;
  if (!e) return;
  const spec = EMERGENCY_CATALOGUE[e.type];
  if (spec.squawk) { a.squawk = spec.squawk; e.squawk = spec.squawk; }
  a.priority = true;
  if (e.fuelMin != null) a.fuelMin = e.fuelMin;
  // noDelay kinds: leave any hold, drop speed restrictions, cancel expedite
  if (spec.noDelay) {
    if (a.navMode === 'hold') { a.navMode = 'heading'; a.targetHeading = a.heading; a.holdFix = null; a.holdFixName = null; }
    a.speedUntilNM = null;
    a.cmdIas = null;
    a.sequenceNo = 1;
  }
  // performance modifiers: clone perf so the shared AIRCRAFT_DB entry is untouched
  const p = spec.perf;
  a.perf = {
    ...a.perf,
    maxClimbRate: Math.round(a.perf.maxClimbRate * p.maxClimbRateFactor),
    maxAirspeedTMA: p.maxSpeedKt != null ? Math.min(a.perf.maxAirspeedTMA, p.maxSpeedKt) : a.perf.maxAirspeedTMA,
    approachSpeed: a.perf.approachSpeed + p.vappPlusKt,
  };
  if (p.maxSpeedKt != null && a.targetSpeed > p.maxSpeedKt) a.targetSpeed = p.maxSpeedKt;
  if (e.type === 'depressurization') { a.targetAltitude = Math.min(a.targetAltitude, 10000); a.cmdAltitude = 10000; a.expedite = true; }
  if (e.type === 'radio_failure' || e.type === 'hijack') {
    a.note = e.type === 'radio_failure' ? 'NORDO 7600' : 'SQUAWK 7500';
    a.readback = { ...a.readback, status: 'none', text: '' };
  }
  if (e.type === 'engine_failure' && a.perf.weightClass !== 'L' && e.requests.some(r => r.includes('dump'))) prog(e).fuelDumpUntil = view.time + rf(15, 25) * 60;
  prog(e);
  const line = e.pilotLine || (e.type === 'radio_failure' ? `${a.callsign} squawking 7600 — radio failure (no transmissions)` : `${a.callsign} squawking ${e.squawk}`);
  if (e.pilotLine) pilotEvent(view, a, line, 'declared'); else sysEvent(view, a, line, 'declared');
}

/** Called each sim second while an emergency is active: fuel countdown, checklist deadlines, pilot re-calls, fire-out chance. */
export function stepEmergency(view: EmergencyEngineView, a: AircraftState, dt: number): void {
  const e = a.emergency;
  if (!e || e.status === 'resolved') return;
  const spec = EMERGENCY_CATALOGUE[e.type];
  const p = prog(e);
  const now = view.time;
  const tel = view.telephony(a.callsign);
  const airborne = a.phase !== 'parked' && a.phase !== 'startup' && a.phase !== 'pushback' && a.phase !== 'taxi' && a.phase !== 'hold_short' && a.phase !== 'lineup' && a.phase !== 'rollout' && a.phase !== 'arrived' && a.phase !== 'departed' && a.phase !== 'takeoff';

  // 1. fuel countdown (fuel emergencies burn 1 min per sim minute; flame-out at 0 while airborne)
  if (e.fuelMin != null && e.landedAt == null) {
    e.fuelMin = Math.max(0, e.fuelMin - dt / 60);
    a.fuelMin = e.fuelMin;
    if (e.fuelMin <= 0 && airborne && !p.flameoutEmitted) {
      p.flameoutEmitted = true;
      view.emit({ type: 'fuel_exhaustion', id: a.id, callsign: a.callsign, message: `${tel}, engine flame-out, fuel exhausted`, at: now, who: 'PILOT' });
      view.score(scoreEvent('FUEL_EXHAUSTION', now, a.callsign, null, e.runway, 'fuel exhaustion after fuel emergency'));
    }
  }

  // 2. unacknowledged: pilot re-calls (max 3) every 60 s
  if (e.checklist.acknowledge == null && e.pilotLine && now >= p.nextRecallAt && p.recalls < 3) {
    p.recalls++;
    p.nextRecallAt = now + RECALL_S;
    pilotEvent(view, a, `${e.level === 'PAN' ? 'PAN PAN' : 'MAYDAY'}, ${tel}, ${natureOf(e.type)}, did you copy?`, 'update');
  }

  // 3. souls / fuel deadline (-100 once)
  if (spec.required.includes('souls_fuel') && e.checklist.souls_fuel == null && now - e.declaredAt >= SOULS_FUEL_DEADLINE_S && !p.missedItems.has('souls_fuel')) {
    p.missedItems.add('souls_fuel');
    view.score(scoreChecklistMiss(a, 'souls_fuel', now));
  }
  // acknowledge missed after 3 recalls
  if (spec.required.includes('acknowledge') && e.checklist.acknowledge == null && p.recalls >= 3 && now >= p.nextRecallAt && !p.missedItems.has('acknowledge')) {
    p.missedItems.add('acknowledge');
    view.score(scoreChecklistMiss(a, 'acknowledge', now));
  }

  // 4. engine fire: extinguisher roll at 60 s
  if (e.type === 'engine_fire' && !p.fireRolled && now - e.declaredAt >= 60) {
    p.fireRolled = true;
    p.fireOut = chance(FIRE_OUT_P);
    if (p.fireOut) { e.requests = e.requests.filter(r => !r.includes('immediate')); pilotEvent(view, a, `${tel}, fire is out, engine number two shut down, still request return${e.runway ? ` ${e.runway}` : ''}.`, 'update'); }
    else { e.requests.unshift('fire not out, request shortest straight-in'); pilotEvent(view, a, `${tel}, fire is NOT out, request shortest possible straight-in, any runway.`, 'update'); }
  }

  // 5. land-within pressure call (once, halfway) and overdue
  if (spec.landWithinMin != null && e.landedAt == null && airborne) {
    const elapsedMin = (now - e.declaredAt) / 60;
    if (!p.landWithinCalled && elapsedMin >= spec.landWithinMin) {
      p.landWithinCalled = true;
      pilotEvent(view, a, `${tel}, we need to land now, request immediate ${e.runway ? `landing runway ${e.runway}` : 'landing, any runway'}.`, 'update');
    }
  }

  // 6. medical / depressurization deterioration
  if ((e.type === 'medical' || e.type === 'depressurization') && e.landedAt == null && !p.deteriorationCalled && now - e.declaredAt >= 600) {
    p.deteriorationCalled = true;
    pilotEvent(view, a, e.type === 'medical' ? `${tel}, passenger condition deteriorating, request no further delay.` : `${tel}, oxygen limited, request expedited approach.`, 'update');
  }

  // 7. noDelay kinds refuse holds: if the engine put it in a hold, the pilot leaves it
  if (spec.noDelay && a.navMode === 'hold' && e.landedAt == null) {
    a.navMode = 'heading'; a.targetHeading = a.heading; a.holdFix = null; a.holdFixName = null;
    pilotEvent(view, a, `${tel}, unable to hold, ${natureOf(e.type)}, continuing.`, 'update');
  }

  // 8. fuel dump complete (engine failure heavies)
  if (p.fuelDumpUntil != null && now >= p.fuelDumpUntil) {
    p.fuelDumpUntil = null;
    e.requests = e.requests.filter(r => !r.includes('dump'));
    pilotEvent(view, a, `${tel}, fuel dump complete, ready for the approach${e.runway ? `, request ILS ${e.runway}` : ''}.`, 'update');
  }

  // 9. evacuation announcement once stopped
  if (e.evacuation && e.stoppedAt != null && !p.evacuationCalled) {
    p.evacuationCalled = true;
    pilotEvent(view, a, `${tel}, evacuating, evacuating, slides deployed, keep everything away from the aircraft.`, 'update');
  }

  // 10. stopped / landed status from engine motion
  if (e.landedAt != null && e.stoppedAt == null && (a.phase === 'rollout' || a.phase === 'taxi' || a.phase === 'arrived' || a.phase === 'hold_short') && a.speed < 1 && now - e.landedAt > 5) {
    e.stoppedAt = now;
    e.status = 'stopped';
    if (e.stopOnRunway && e.runway) view.setRunwayStatus(e.runway, 'closed', `${a.callsign} stopped on the runway (${natureOf(e.type)})`);
    sysEvent(view, a, e.stopOnRunway ? `${a.callsign} stopped on runway ${e.runway ?? ''}${e.evacuation ? ' — EVACUATION' : ''}` : `${a.callsign} stopped, ARFF check in progress`, 'stopped');
  }

  // 11. automatic stand-down 10 min after a safe stop with no fire (ground emergencies: from declaration + ARFF check)
  const safeStopAt = e.stoppedAt ?? (e.landedAt != null && !e.stopOnRunway ? e.landedAt : null) ?? (e.type === 'brake_fire' ? e.declaredAt : null);
  const fireRisk = e.evacuation || (e.type === 'engine_fire' && p.fireOut === false) || e.type === 'smoke';
  if (safeStopAt != null && now - safeStopAt >= STAND_DOWN_S * (fireRisk ? 2 : 1)) {
    resolveEmergency(view, a, 'automatic stand-down');
  }
}

/** Resolve an emergency (pilot "cancel MAYDAY", controller cancel-ack, or automatic stand-down); scores via the view once. */
export function resolveEmergency(view: EmergencyEngineView, a: AircraftState, reason: string): void {
  const e = a.emergency;
  if (!e || e.status === 'resolved') return;
  e.status = 'resolved';
  e.resolvedAt = view.time;
  a.priority = false;
  if (a.squawk === '7700' || a.squawk === '7600' || a.squawk === '7500') a.squawk = null;
  pilotEvent(view, a, `${view.telephony(a.callsign)}, ${e.level === 'PAN' ? 'PAN PAN' : 'MAYDAY'} cancelled, ${reason}.`, 'resolved');
  for (const s of scoreOnResolved(a, view.time)) view.score(s);
}

/**
 * Called by the engine at touchdown of an emergency aircraft. Decides stop-on-
 * runway vs vacate (stopOnRunwayP, or forced by `stopOnRunway` command), sets
 * runway closure (closureMin), evacuation, status 'landed'/'stopped', and
 * schedules ARFF gather + tow. Returns the runway closure minutes (0 = none).
 */
export function handleLanded(view: EmergencyEngineView, a: AircraftState): number {
  const e = a.emergency;
  if (!e || e.status === 'resolved') return 0;
  const spec = EMERGENCY_CATALOGUE[e.type];
  e.landedAt = view.time;
  e.status = 'landed';
  if (!e.runway) e.runway = a.plan.runway ?? a.assignedRunway ?? null;
  const p = prog(e);
  const fireStillBurning = e.type === 'engine_fire' && p.fireOut === false;
  // decision: forced by the controller, else by catalogue probability (fire still burning always stops)
  const stop = e.stopOnRunway || fireStillBurning || (!e.requests.includes('vacate_if_able') && chance(spec.stopOnRunwayP));
  e.stopOnRunway = stop;
  let closure = 0;
  if (stop) {
    e.evacuation = chance(fireStillBurning ? Math.max(spec.evacuationP, 0.6) : spec.evacuationP);
    closure = Math.round(rf(spec.closureMin[0], spec.closureMin[1]));
    if (closure <= 0) closure = e.evacuation ? 30 : 15; // tow / ARFF check minimum when the catalogue has no closure
    if (e.evacuation) closure = Math.max(closure, 20);
    e.closureMin = closure;
    if (e.arff === 'none' && spec.arff !== 'none') e.arff = spec.arff;
    if (e.evacuation) e.arff = 'full';
    if (e.runway) view.setRunwayStatus(e.runway, 'closed', `${a.callsign} stopping on the runway (${natureOf(e.type)}), ${closure} min`);
    sysEvent(view, a, `${a.callsign} landed runway ${e.runway ?? ''} — stopping on the runway${e.evacuation ? ', evacuation expected' : ''}; runway closed ${closure} min`, 'landed');
  } else {
    e.evacuation = false;
    e.closureMin = 0;
    sysEvent(view, a, `${a.callsign} landed runway ${e.runway ?? ''} — vacating${spec.arff !== 'none' ? ', ARFF to follow' : ''}${spec.ambulance ? ', ambulance to the gate' : ''}`, 'landed');
  }
  // bird strike / hydraulic etc.: runway needs an inspection before the next movement
  if (spec.required.includes('inspection') && e.runway && !stop) view.setRunwayStatus(e.runway, 'inspection', `${a.callsign} ${natureOf(e.type)} — inspection required`);
  // landing-time bonus is booked at resolution; ARFF-before-touchdown recorded by the engine via arffOnSceneAt
  return closure;
}

/** Mark a checklist item done at `time`; returns the ScoreEvent (+25 within 60 s of the previous item / declaration) or null if already done. */
export function completeChecklistItem(a: AircraftState, item: EmergencyChecklistItem, time: number): ScoreEvent | null {
  const e = a.emergency;
  if (!e || e.checklist[item] != null) return null;
  const spec = EMERGENCY_CATALOGUE[e.type];
  // reference = the latest completed item (or the declaration)
  let ref = e.declaredAt;
  for (const k of CHECKLIST_ORDER) { const t = e.checklist[k]; if (t != null && t > ref) ref = t; }
  e.checklist[item] = time;
  // status progression
  if (item === 'acknowledge' && e.status === 'declared') e.status = 'acknowledged';
  if ((item === 'arff' || item === 'ambulance') && (e.status === 'declared' || e.status === 'acknowledged')) e.status = 'services_dispatched';
  if (item === 'priority_runway') e.priority = true;
  if (item === 'hold_traffic') e.sterile = true;
  const required = spec.required.includes(item);
  const onTime = time - ref <= CHECKLIST_ITEM_DEADLINE_S;
  const points = required && onTime ? CHECKLIST_ITEM_POINTS : 0;
  return { code: 'EMERGENCY_DONE', at: time, primary: a.callsign, secondary: null, runway: e.runway, points, skillDelta: 0, ref: '03 §4 checklist', detail: `checklist ${item}${required ? '' : ' (optional)'}${onTime ? '' : ' (late)'}` };
}

/** Scoring on resolution: EMERGENCY_DONE +300 x checklist completion ratio + catalogue bonuses; returns the ledger entries (idempotent per emergency). */
export function scoreOnResolved(a: AircraftState, time: number): ScoreEvent[] {
  const e = a.emergency;
  if (!e || scoredResolved.has(e)) return [];
  scoredResolved.add(e);
  const spec = EMERGENCY_CATALOGUE[e.type];
  const out: ScoreEvent[] = [];
  const req = spec.required;
  const done = req.filter(k => e.checklist[k] != null).length;
  const ratio = req.length ? done / req.length : 1;
  const base = SCORE_TABLE.EMERGENCY_DONE;
  out.push({ code: 'EMERGENCY_DONE', at: time, primary: a.callsign, secondary: null, runway: e.runway, points: Math.round(base.points * ratio), skillDelta: Math.round(base.skill * ratio * 100) / 100, ref: base.ref, detail: `${natureOf(e.type)} concluded, checklist ${done}/${req.length}` });
  if (spec.bonus.landedInTime > 0 && spec.landWithinMin != null && e.landedAt != null && (e.landedAt - e.declaredAt) / 60 <= spec.landWithinMin) {
    out.push({ code: 'EMERGENCY_DONE', at: time, primary: a.callsign, secondary: null, runway: e.runway, points: spec.bonus.landedInTime, skillDelta: 0, ref: '03 §4 landed in time', detail: `landed within ${spec.landWithinMin} min of declaration` });
  } else if (spec.bonus.landedInTime > 0 && spec.landWithinMin == null && e.landedAt != null && e.type === 'fuel' && (e.fuelMin ?? 0) >= 5) {
    out.push({ code: 'EMERGENCY_DONE', at: time, primary: a.callsign, secondary: null, runway: e.runway, points: spec.bonus.landedInTime, skillDelta: 0, ref: '03 §4.4', detail: `fuel emergency landed with ${Math.round(e.fuelMin ?? 0)} min remaining` });
  }
  if (spec.bonus.arffBeforeTouchdown > 0 && e.arffOnSceneAt != null && e.landedAt != null && e.arffOnSceneAt <= e.landedAt) {
    out.push({ code: 'ARFF_ON_TIME', at: time, primary: a.callsign, secondary: null, runway: e.runway, points: spec.bonus.arffBeforeTouchdown, skillDelta: 0, ref: SCORE_TABLE.ARFF_ON_TIME.ref, detail: 'ARFF at the runway before touchdown' });
  } else if (spec.bonus.arffBeforeTouchdown > 0 && e.arffOnSceneAt != null && e.landedAt == null && e.type === 'brake_fire' && e.arffOnSceneAt - e.declaredAt <= 180) {
    out.push({ code: 'ARFF_ON_TIME', at: time, primary: a.callsign, secondary: null, runway: e.runway, points: spec.bonus.arffBeforeTouchdown, skillDelta: 0, ref: SCORE_TABLE.ARFF_ON_TIME.ref, detail: 'ARFF at the aircraft within 3 min' });
  }
  return out;
}

/** Scoring on a missed checklist deadline (EMERGENCY_CHECKLIST_MISS -100 each). */
export function scoreChecklistMiss(a: AircraftState, item: EmergencyChecklistItem, time: number): ScoreEvent {
  const t = SCORE_TABLE.EMERGENCY_CHECKLIST_MISS;
  return { code: 'EMERGENCY_CHECKLIST_MISS', at: time, primary: a.callsign, secondary: null, runway: a.emergency?.runway ?? null, points: t.points, skillDelta: t.skill, ref: t.ref, detail: `${CHECKLIST_LABEL[item]} not done in time` };
}

/** Pilot's spoken ack reply for an emergency (fills souls/fuel/runway). */
export function ackReplyLine(a: AircraftState, telephony: string): string {
  const e = a.emergency;
  if (!e) return '';
  return EMERGENCY_CATALOGUE[e.type].ackReply
    .replace('{cs}', telephony).replace(/\{rwy\}/g, e.runway ?? a.plan.runway ?? '')
    .replace('{n}', String(e.soulsOnBoard)).replace('{fuel}', String(Math.round(e.fuelMin ?? a.fuelMin ?? 60)));
}

// ──────────────────────────────────────────────────────────────────────────────
//  Controller-action helpers (mutate checklist state; return the score event)
// ──────────────────────────────────────────────────────────────────────────────
/** `emergencyAck`: acknowledge + (if souls/fuel asked) souls_fuel. Returns the score events. */
export function ackEmergency(a: AircraftState, time: number, askedSoulsFuel = true): ScoreEvent[] {
  const out: ScoreEvent[] = [];
  const s1 = completeChecklistItem(a, 'acknowledge', time); if (s1) out.push(s1);
  if (askedSoulsFuel) { const s2 = completeChecklistItem(a, 'souls_fuel', time); if (s2) out.push(s2); }
  return out;
}

/** `priority`: assigns the runway, number one, optional sterile. */
export function assignPriority(a: AircraftState, runway: string, sterile: boolean, time: number): ScoreEvent[] {
  const e = a.emergency;
  if (!e) return [];
  e.runway = runway.toUpperCase();
  e.priority = true;
  a.priority = true;
  a.sequenceNo = 1;
  const out: ScoreEvent[] = [];
  const s = completeChecklistItem(a, 'priority_runway', time); if (s) out.push(s);
  if (sterile) { e.sterile = true; const h = completeChecklistItem(a, 'hold_traffic', time); if (h) out.push(h); }
  return out;
}

/** `dispatchVehicle` for an emergency: ARFF level (2 trucks = local, 3 = full) / ambulance. */
export function servicesDispatched(a: AircraftState, kind: 'arff' | 'ambulance', count: number, time: number): ScoreEvent[] {
  const e = a.emergency;
  if (!e) return [];
  const out: ScoreEvent[] = [];
  if (kind === 'arff') {
    e.arff = count >= 3 ? 'full' : e.arff === 'full' ? 'full' : 'local';
    const s = completeChecklistItem(a, 'arff', time); if (s) out.push(s);
  } else {
    const s = completeChecklistItem(a, 'ambulance', time); if (s) out.push(s);
  }
  if (e.status === 'declared' || e.status === 'acknowledged') e.status = 'services_dispatched';
  return out;
}

/** ARFF reached the scene (engine calls when the first ARFF vehicle flips to onscene for this aircraft / its runway). */
export function arffOnScene(a: AircraftState, time: number): ScoreEvent | null {
  const e = a.emergency;
  if (!e || e.arffOnSceneAt != null) return null;
  e.arffOnSceneAt = time;
  const t = SCORE_TABLE.ARFF_ON_TIME;
  const within = time - (e.checklist.arff ?? e.declaredAt) <= 180;
  return within
    ? { code: 'ARFF_ON_TIME', at: time, primary: a.callsign, secondary: null, runway: e.runway, points: t.points, skillDelta: t.skill, ref: t.ref, detail: `ARFF on scene ${Math.round(time - (e.checklist.arff ?? e.declaredAt))} s after alert` }
    : { code: 'ARFF_ON_TIME', at: time, primary: a.callsign, secondary: null, runway: e.runway, points: -100 * Math.max(1, Math.ceil((time - (e.checklist.arff ?? e.declaredAt) - 180) / 60)), skillDelta: 0, ref: '03 §1.13', detail: `ARFF late: ${Math.round(time - (e.checklist.arff ?? e.declaredAt))} s` };
}

/** `holdAll`: every emergency gets its hold_traffic item. */
export function holdAllTraffic(aircraft: readonly AircraftState[], time: number): ScoreEvent[] {
  const out: ScoreEvent[] = [];
  for (const a of aircraft) {
    if (!a.emergency || a.emergency.status === 'resolved') continue;
    a.emergency.sterile = true;
    const s = completeChecklistItem(a, 'hold_traffic', time); if (s) out.push(s);
  }
  return out;
}

/** Runway closed / reopened / inspected for the emergency on `runway` (null = every active emergency). */
export function runwayChecklist(aircraft: readonly AircraftState[], item: 'runway_closed' | 'runway_reopened' | 'inspection', runway: string | null, time: number): ScoreEvent[] {
  const out: ScoreEvent[] = [];
  for (const a of aircraft) {
    const e = a.emergency;
    if (!e || e.status === 'resolved') continue;
    if (runway && e.runway && e.runway.toUpperCase() !== runway.toUpperCase()) continue;
    if (item === 'runway_reopened' && e.checklist.runway_closed == null) continue;
    const s = completeChecklistItem(a, item, time); if (s) out.push(s);
  }
  return out;
}

/** `stopOnRunway` command: record the controller's post-landing instruction. */
export function setStopOnRunway(a: AircraftState, mode: 'stop' | 'vacate_if_able'): void {
  const e = a.emergency;
  if (!e) return;
  e.stopOnRunway = mode === 'stop';
  e.requests = e.requests.filter(r => r !== 'vacate_if_able');
  if (mode === 'vacate_if_able') e.requests.push('vacate_if_able');
}

/** Pilot "cancel MAYDAY" eligibility: medical/general/bird after landing, engine fire out and landed, etc. */
export function canCancel(a: AircraftState, time: number): boolean {
  const e = a.emergency;
  if (!e || e.status === 'resolved') return false;
  if (e.type === 'brake_fire') return time - e.declaredAt >= 600 && e.arffOnSceneAt != null;
  if (e.landedAt == null) return false;
  if (e.stopOnRunway) return e.stoppedAt != null && time - e.stoppedAt >= 300 && !e.evacuation;
  return time - e.landedAt >= 120;
}

/** Checklist view for the strip tick-list: ordered items with done/required/deadline state. */
export function checklistView(a: AircraftState, time: number): Array<{ item: EmergencyChecklistItem; label: string; required: boolean; doneAt: number | null; overdue: boolean }> {
  const e = a.emergency;
  if (!e) return [];
  const spec = EMERGENCY_CATALOGUE[e.type];
  return CHECKLIST_ORDER.filter(k => spec.required.includes(k) || e.checklist[k] != null).map(item => ({
    item, label: CHECKLIST_LABEL[item], required: spec.required.includes(item), doneAt: e.checklist[item],
    overdue: e.checklist[item] == null && spec.required.includes(item) && (item === 'souls_fuel' ? time - e.declaredAt > SOULS_FUEL_DEADLINE_S : item === 'acknowledge' ? time - e.declaredAt > RECALL_S : false),
  }));
}

/** ARFF alert level the catalogue wants for a type ("local standby" / "full emergency"). */
export function arffLevelFor(type: EmergencyType): ArffLevel { return EMERGENCY_CATALOGUE[type].arff; }

/** Pick a random emergency type eligible for a stage (debug menu / forceEmergency without a kind). */
export function randomTypeFor(stage: Stage): EmergencyType | null {
  const rows = eligibleTypes(stage);
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let pick = rf(0, total);
  for (const r of rows) { pick -= r.weight; if (pick <= 0) return r.type; }
  return rows[ri(rows.length)].type;
}

function scoreEvent(code: keyof typeof SCORE_TABLE, at: number, primary: string, secondary: string | null, runway: string | null, detail: string): ScoreEvent {
  const t = SCORE_TABLE[code];
  return { code, at, primary, secondary, runway, points: t.points, skillDelta: t.skill, ref: t.ref, detail };
}

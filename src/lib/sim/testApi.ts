// ============================================================
//  Deterministic test API — TYPES per 05-TEST-STRATEGY §2.2 (exact) + G12 extras.
//
//  Installed on window.__atcTest by the store in test mode only (W2-STORE owns
//  the implementation; this file is the contract every Playwright fixture and
//  spec codes against). Everything returned is plain JSON.
//
//  Determinism: no RAF in test mode; time advances only through advance();
//  all randomness via rng.ts; spawn is explicit (`?spawn=none`).
// ============================================================
import type { XY } from './projection';
import type { WeightClass } from './aircraftDB';
import type {
  AircraftState, Alert, Emergency, EmergencyType, FlightPhase, FlightPlan, NavMode, PendingCmd, PilotRequest,
  PilotRequestKind, Position, RunwayState, RunwayStatus, SimEvent, Stage, Vehicle, VehicleState, WakeCategory, WeatherState,
} from './types';
import type { CommandAST, CommandResult } from './commandAst';
import type { ActionRow } from './commandTree';

// ──────────────────────────────────────────────────────────────────────────────
//  Views
// ──────────────────────────────────────────────────────────────────────────────
export interface RadioLine {
  who: 'ATC' | 'PILOT' | 'SYS' | 'AI';
  text: string;
  key: number;
  /** Sim time of the line. */
  at?: number;
  callsign?: string;
  position?: Position;
  status?: 'pending' | 'executed' | 'undone' | 'unable' | 'mismatch';
}

/** Plain-JSON projection of AircraftState for tests (05 §2.2 list + Wave-0 fields). */
export interface AircraftView {
  id: number;
  callsign: string;
  type: string;
  phase: FlightPhase;
  stage: Stage;
  plan: FlightPlan;
  pos: XY;
  heading: number;
  speed: number;
  altitude: number;
  targetHeading: number;
  targetSpeed: number;
  targetAltitude: number;
  cmdAltitude: number | null;
  cmdIas: number | null;
  expedite: boolean;
  navMode: NavMode;
  ilsArmed: boolean;
  ilsCaptured: boolean;
  gsCaptured: boolean;
  assignedRunway: string | null;
  holdFixName: string | null;
  holdPhase: AircraftState['holdPhase'];
  directTargetName: string | null;
  conflict: boolean;
  trafficHold: boolean;
  holdReleased: boolean;
  takeoffCleared: boolean;
  pendingCmds: PendingCmd[];
  pathTotal: number;
  distAlong: number;
  taxiRoute: string[];
  attention: boolean;
  underControl: boolean;
  // Wave-0 additions
  wakeCategory: WakeCategory;
  requests: PilotRequest[];
  emergency: Emergency | null;
  landingCleared: boolean;
  holdShortNode: string | null;
  holdShortRunway: string | null;
  onFrequency: Position;
  handedTo: Position | null;
  goAround: boolean;
  squawk: string | null;
  pushbackStage: AircraftState['pushback']['stage'];
  startupReadyAt: number | null;
  reservedStand: string | null;
  fuelMin: number | null;
}

export interface Snapshot {
  time: number;
  score: number;
  skill: number;
  paused: boolean;
  rate: number;
  selectedId: number | null;
  icao: string;
  stats: { total: number; dep: number; arr: number; air: number; gnd: number; conf: number };
  aircraft: AircraftView[];
  radio: RadioLine[];
}

export interface RelPos { fromRunway: string; alongNM: number; offsetNM?: number; altFt: number }

/** Radar camera (local XY metres + zoom) or MapLibre camera. */
export type CameraView = { x: number; y: number; zoom: number } | { lng: number; lat: number; zoom: number };

export type FeatureFlag =
  | 'wind' | 'atis' | 'runwayChange' | 'emergencies' | 'arff' | 'stca' | 'wakeTimers' | 'strips' | 'keyboard' | 'dragHeading'
  | 'vehicles' | 'requests' | 'pushback' | 'landingClearance' | 'commandTree' | 'msaw' | 'runwayIncursion';

/** Feature availability defaults: every flag flips to true in testApi.ts when its module is wired (05 §2.4). */
export const FEATURE_DEFAULTS: Record<FeatureFlag, boolean> = {
  wind: false, atis: false, runwayChange: false, emergencies: false, arff: false, stca: false, wakeTimers: false,
  strips: false, keyboard: false, dragHeading: false, vehicles: false, requests: false, pushback: false,
  landingClearance: false, commandTree: false, msaw: false, runwayIncursion: false,
};

// ──────────────────────────────────────────────────────────────────────────────
//  Spawn spec (05 §2.2, exact)
// ──────────────────────────────────────────────────────────────────────────────
export interface SpawnSpec {
  callsign: string;
  /** e.g. 'A320', 'B77W', 'A388' (weight class drives wake). */
  type?: string;
  kind: 'departure' | 'arrival';
  phase: FlightPhase;
  // position — exactly one of:
  /** parked/pushback/taxi from a stand ref. */
  gate?: string;
  /** hold_short/lineup/takeoff at threshold of this end. */
  runway?: string;
  /** any OSM node id. */
  taxiwayNode?: string;
  /** airborne: on/near extended centreline (alongNM<0 = before threshold). */
  posRel?: RelPos;
  posLL?: { lat: number; lng: number; altFt: number };
  // airborne kinematics
  heading?: number;
  speedKts?: number;
  altFt?: number;
  targets?: { alt?: number; ias?: number; hdg?: number };
  // plan
  plan?: { runway?: string; fix?: string; gateRef?: string; cruiseAlt?: number };
  // pre-arm
  /** arm ILS for this runway immediately (no pilot delay). */
  ils?: string;
  hold?: { fix: string; inbound?: number; dir?: 'L' | 'R' };
  /** build path immediately (like cmdTaxiTo). */
  taxiTo?: string;
  /** Wave-0 extras: frequency, landing clearance, emergency at spawn. */
  onFrequency?: Position;
  landingCleared?: boolean;
  emergency?: EmergencyType;
}

// ──────────────────────────────────────────────────────────────────────────────
//  The API (05 §2.2 exact members first, G12 extras after)
// ──────────────────────────────────────────────────────────────────────────────
export interface AtcTestApi {
  // ── lifecycle ──
  /** engine && !loading */
  ready(): boolean;
  /** GroundView maplibre 'load' fired (false in radar mode). */
  mapReady(): boolean;
  features(): Record<FeatureFlag, boolean>;
  /** Re-load the airport deterministically. */
  reset(opts?: { icao?: string; seed?: number; spawn?: 'none' | 'default' }): Promise<void>;
  seed(n: number): void;

  // ── time ──
  /** Synchronous; loops sim.step(1/30); returns [] and does nothing while paused; ignores rate. */
  advance(simSeconds: number): SimEvent[];
  advanceUntil(pred: (s: Snapshot) => boolean, maxSimSeconds: number, stepS?: number): { ok: boolean; elapsed: number; events: SimEvent[] };
  /** Applies sim.rate (rate tests only). */
  advanceReal(realSeconds: number): SimEvent[];
  /** dt passed to the last sim.step() (rate spy). */
  lastStepDt(): number;
  /** engine.time */
  time(): number;

  // ── read state ──
  snapshot(): Snapshot;
  aircraft(cs: string): AircraftView | null;
  radio(): RadioLine[];
  /** All events since last clear (ring buffer 500). */
  events(): SimEvent[];
  clearEvents(): void;
  runways(): Array<{ name: string; hdg: number; active: boolean; occupied: boolean; weights: WeightClass[] | null }>;
  beacons(): string[];
  gates(): string[];
  taxiways(): string[];

  // ── write state ──
  /** Deterministic aircraft factory. */
  spawnAt(spec: SpawnSpec): AircraftView;
  /** Shallow merge; re-projects posLL/posRel. */
  setState(cs: string, patch: Partial<AircraftState & { posLL?: { lat: number; lng: number }; posRel?: RelPos }>): AircraftView;
  remove(cs: string): void;
  clear(): void;
  setAutoSpawn(on: boolean): void;
  setAutoTower(on: boolean): void;
  setScore(n: number): void;
  setSkill(n: number): void;
  /** Same as sim.command() but returns the structured result. */
  command(text: string): CommandResult;

  // ── geometry for canvas hit-testing ──
  /** CSS px relative to the ACTIVE canvas element (radar or ground map container). */
  screenPos(cs: string): { x: number; y: number } | null;
  screenPosOf(xy: { x: number; y: number }): { x: number; y: number };
  /** Point >= 40 css px from every aircraft and >= 20 px from the canvas edge. */
  emptySpot(): { x: number; y: number };
  camera(): CameraView;
  /** Centre the active view on an aircraft (radar: cam = a.pos; ground: map.jumpTo) - 05 §3.2. */
  centerOn(cs: string): void;
  /** Pin the active view camera before geometry-dependent interactions (05 §3.2). */
  setCamera(cam: CameraView): void;

  // ── feature-contract hooks (no-ops until the feature exists; features() reports availability) ──
  setWind(dirDeg: number, kts: number, gustKts?: number): void;
  setActiveRunways(ends: string[]): void;
  forceEmergency(cs: string, kind: EmergencyType): void;
  arff(): { vehicles: Array<{ id: string; pos: XY; state: VehicleState; target?: string }> };
  stca(): { pairs: [string, string][]; active: boolean };
  atis(): { letter: string; wind: { dir: number; kts: number }; activeRunways: string[]; issuedAt: number };
  wakeTimers(): Record<string, { runway: string; leader: string; remainingS: number }>;

  // ── G12 extras ──
  /** Pilot delay override in sim seconds (1-8). */
  setPilotDelay(s: number): void;
  setWeather(w: Partial<WeatherState>): void;
  /** Inject a pilot request as if the engine raised it. */
  request(cs: string, kind: PilotRequestKind, param?: string | number): void;
  /** Full aircraft state (not the view) for deep assertions. */
  state(cs: string): AircraftState | null;
  alerts(): Alert[];
  ackAlert(id: string): boolean;
  vehicles(): Vehicle[];
  runwayStates(): RunwayState[];
  setRunwayStatus(runway: string, status: RunwayStatus): void;
  stage(cs: string): Stage | null;
  /** actionsFor() rows for the aircraft in the current position (data-state/data-reason assertions). */
  actions(cs: string): ActionRow[];
  /** Dispatch a structured command (bypasses the text parser). */
  dispatchAst(ast: CommandAST): CommandResult;
  /** Switch the player position tab. */
  setPosition(p: 'ground' | 'tower' | 'approach'): void;
  /** Select an aircraft (or null) exactly as a click would. */
  select(cs: string | null): void;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Host contract (what createTestApi needs from the store; W2-STORE implements on SimStore)
// ──────────────────────────────────────────────────────────────────────────────
export interface TestApiHost {
  testMode: boolean;
  loading: boolean;
  paused: boolean;
  rate: number;
  icao: string;
  selectedId: number | null;
  autoSpawn: boolean;
  mapReady: boolean;
  radio: RadioLine[];
  lastStepDt: number;
  /** Ring buffer of every engine event since the last clear (500). */
  eventLog: SimEvent[];
  /** The live engine (typed loosely so the contract does not depend on engine internals). */
  engine: unknown;
  step(dtSim: number): SimEvent[];
  emit(): void;
  load(icao: string, ends?: string[], weights?: Record<string, WeightClass[]>): Promise<void>;
  enableTestMode(opts: { seed?: number; spawn?: 'none' | 'default' }): void;
  command(text: string): CommandResult;
  select(id: number | null): void;
  setRate(r: number): void;
  setPosition(p: 'ground' | 'tower' | 'approach'): void;
  /** Screen projection of the active view (radar `toScreen` or maplibre project), null when no view is mounted. */
  screenProject(xy: XY): { x: number; y: number } | null;
  camera(): CameraView | null;
  /** Move the active view camera (radar cam / maplibre jumpTo); no-op when no view is mounted. */
  setCamera(cam: CameraView): void;
}

/**
 * Build the window.__atcTest object. Implementation notes (05 §2.2):
 *  - advance() loops host.step(1/30) Math.round(N*30) times, host.emit() every
 *    30 steps and once at the end; returns [] while host.paused.
 *  - spawnAt for airborne uses engine.base() + the spawnArrivalAtEntry field
 *    setup; for ground it reuses spawnDeparture's path build then overrides
 *    phase/position; phase 'parked' puts the aircraft on the gate node with path null.
 *  - screenPos() = host.screenProject(a.pos) (CSS px, no dpr multiply).
 *  - features() reports true per flag once the corresponding module is wired.
 */
export function createTestApi(host: TestApiHost): AtcTestApi {
  void host;
  throw new Error('not implemented');
}

declare global {
  interface Window { __atcTest?: AtcTestApi }
}

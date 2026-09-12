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
import { actionsFor } from './commandTree';
import { actionCtxFromEngine } from './dispatch';

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
  /** Store status ('ok' | 'unable' | 'partial' | 'error' | 'undone' | 'mismatch'); typed loosely so the store's union can grow. */
  status?: string;
  undoUntil?: number;
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
//  Host contract (what createTestApi needs from the store; W2-STORE's SimStore
//  implements it directly). Typed loosely on purpose so this file never
//  depends on the store module (no DOM here, 06 §1).
// ──────────────────────────────────────────────────────────────────────────────
export interface TestHostStartConfig {
  icao: string;
  ends?: string[];
  weights?: Record<string, WeightClass[]>;
  seed?: number;
  spawn?: 'none' | 'default';
  test?: boolean;
}

export interface TestApiHost {
  testMode: boolean;
  loading: boolean;
  paused: boolean;
  rate: number;
  icao: string;
  seed: number;
  selectedId: number | null;
  autoSpawn: boolean;
  mapReady: boolean;
  radio: RadioLine[];
  lastStepDt: number;
  /** Ring buffer of every engine event since the last clear (500). */
  eventLog: SimEvent[];
  /** The live engine (typed loosely so the contract does not depend on engine internals). */
  engine: unknown;
  /** Feature-flag overrides (UI agents may flip a flag off until their part ships). */
  featureOverrides: Partial<Record<string, boolean>>;
  step(dtSim: number): SimEvent[];
  /** Route the events the engine produced outside a step (spawns, status changes) without advancing time. */
  flush(): void;
  emit(): void;
  load(cfg: TestHostStartConfig): Promise<void>;
  enableTestMode(opts: { seed?: number; spawn?: 'none' | 'default' }): void;
  command(text: string): CommandResult;
  dispatchAst(ast: CommandAST): CommandResult;
  select(id: number | null): void;
  setRate(r: 1 | 2 | 4): void;
  setPosition(p: 'ground' | 'tower' | 'approach'): void;
  updateSettings(patch: Record<string, unknown>): void;
  ackAlert(id: string): boolean;
  clearEvents(): void;
  /** Screen projection of the active view (radar `toScreen` or maplibre project), null when no view is mounted. */
  screenProject(xy: XY): { x: number; y: number } | null;
  camera(): CameraView | null;
  /** Move the active view camera (radar cam / maplibre jumpTo); no-op when no view is mounted. */
  setCamera(cam: CameraView): void;
  centerOnXY(xy: XY): void;
  /** CSS size of the active canvas, null when unknown. */
  viewSize(): { w: number; h: number } | null;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Minimal engine surface the API touches (structural; SimEngine satisfies it)
// ──────────────────────────────────────────────────────────────────────────────
interface EngineLike {
  time: number;
  aircraft: AircraftState[];
  runways: RunwayState[];
  gates: Array<{ ref: string }>;
  beacons: Array<{ id: string; x: number; y: number }>;
  air: { taxiwayNames?: string[] };
  stats: { points: number; skill: number };
  settings: { autoTower: boolean; pilotDelayOverride: number | null };
  proj: { toXY(lat: number, lng: number): XY };
  fleet: { list(): Vehicle[] };
  alerts: { list(): Alert[]; active(): Alert[]; ack(id: string, time: number): boolean; stca(): { pairs: [string, string][]; active: boolean } };
  weather: { atis(): { letter: string; issuedAt: number; wind: { dir: number; kts: number; gust: number }; activeDep: string[]; activeArr: string[] }; setState(patch: Partial<WeatherState>): void };
  find(cs: string): AircraftState | undefined;
  byId(id: number): AircraftState | undefined;
  counts(): { total: number; dep: number; arr: number; air: number; gnd: number; conf: number };
  viewOf(a: AircraftState): AircraftView;
  stageOf(a: AircraftState): Stage;
  spawnAt(spec: SpawnSpec): AircraftState;
  remove(id: number, reason: 'test'): void;
  clear(): void;
  runwayState(name: string): RunwayState | undefined;
  runwayOccupied(name: string): boolean;
  thresholdXY(name: string): XY | null;
  setWind(dirTrue: number, kts: number, gust?: number): void;
  setActiveRunwayEnds(ends: string[] | null): void;
  setRunwayStatus(runway: string, status: RunwayStatus, reason: string | null): unknown;
  declareEmergency(a: AircraftState, type: EmergencyType): Emergency;
  raiseRequest(a: AircraftState, kind: PilotRequestKind, param?: string | number | null, text?: string): PilotRequest;
  activeAlerts(): Alert[];
  wakeTimers(): Record<string, { runway: string; leader: string; remainingS: number }>;
  playerPosition: 'ground' | 'tower' | 'approach';
}

const FIXED_DT = 1 / 30;

/** Every feature the engine + store wire today; UI-owned flags can be overridden by the host. */
const FEATURES_WIRED: Record<FeatureFlag, boolean> = {
  wind: true, atis: true, runwayChange: true, emergencies: true, arff: true, stca: true, wakeTimers: true,
  strips: true, keyboard: true, dragHeading: true, vehicles: true, requests: true, pushback: true,
  landingClearance: true, commandTree: true, msaw: true, runwayIncursion: true,
};

const NM_M = 1852;
function advanceXY(p: XY, headingDeg: number, m: number): XY {
  const r = (headingDeg * Math.PI) / 180;
  return { x: p.x + Math.sin(r) * m, y: p.y + Math.cos(r) * m };
}

/**
 * Build the window.__atcTest object (05 §2.2 exact + §G12 extras).
 *  - advance() loops host.step(1/30) Math.round(N*30) times, host.emit() every
 *    30 steps and once at the end; returns [] while host.paused; ignores rate.
 *  - advanceReal() applies host.rate (rate tests); lastStepDt() is the spy.
 *  - spawnAt / setState go straight to the engine's deterministic factory.
 *  - screenPos() = host.screenProject(a.pos) (CSS px, no dpr multiply).
 *  - features() reports FEATURES_WIRED merged with host.featureOverrides.
 */
export function createTestApi(host: TestApiHost): AtcTestApi {
  const eng = (): EngineLike => {
    const e = host.engine as EngineLike | null;
    if (!e) throw new Error('__atcTest: no engine loaded (call reset() / wait for ready())');
    return e;
  };
  const ac = (cs: string): AircraftState => {
    const a = eng().find(cs);
    if (!a) throw new Error(`__atcTest: no aircraft ${cs}`);
    return a;
  };
  const view = (a: AircraftState): AircraftView => eng().viewOf(a);

  const stepN = (n: number): SimEvent[] => {
    const out: SimEvent[] = [];
    for (let i = 0; i < n; i++) {
      const evs = host.step(FIXED_DT);
      for (const ev of evs) out.push(ev);
      if ((i + 1) % 30 === 0) host.emit();
    }
    host.emit();
    return out;
  };

  const snapshot = (): Snapshot => {
    const e = eng();
    return {
      time: e.time, score: e.stats.points, skill: e.stats.skill, paused: host.paused, rate: host.rate,
      selectedId: host.selectedId, icao: host.icao, stats: e.counts(),
      aircraft: e.aircraft.map(a => e.viewOf(a)), radio: host.radio.map(l => ({ ...l })),
    };
  };

  const api: AtcTestApi = {
    // ── lifecycle ──
    ready: () => !!host.engine && !host.loading,
    mapReady: () => host.mapReady,
    features: () => ({ ...FEATURES_WIRED, ...(host.featureOverrides as Partial<Record<FeatureFlag, boolean>>) }),
    reset: async (opts = {}) => {
      host.enableTestMode({ seed: opts.seed, spawn: opts.spawn });
      await host.load({ icao: opts.icao ?? host.icao ?? 'EGLL', seed: opts.seed ?? host.seed, spawn: opts.spawn ?? 'none', test: true });
    },
    seed: (n: number) => { host.enableTestMode({ seed: n }); },

    // ── time ──
    advance: (simSeconds: number) => {
      if (host.paused || !host.engine) return [];
      return stepN(Math.max(0, Math.round(simSeconds * 30)));
    },
    advanceUntil: (pred, maxSimSeconds, stepS = 1) => {
      const events: SimEvent[] = [];
      let elapsed = 0;
      if (!host.engine) return { ok: false, elapsed: 0, events };
      const chunk = Math.max(1, Math.round(stepS * 30));
      while (elapsed < maxSimSeconds) {
        if (pred(snapshot())) return { ok: true, elapsed, events };
        if (host.paused) return { ok: false, elapsed, events };
        for (const ev of stepN(chunk)) events.push(ev);
        elapsed += chunk / 30;
      }
      return { ok: pred(snapshot()), elapsed, events };
    },
    advanceReal: (realSeconds: number) => {
      if (host.paused || !host.engine) return [];
      const out: SimEvent[] = [];
      const frames = Math.max(0, Math.round(realSeconds * 60));
      for (let i = 0; i < frames; i++) {
        for (const ev of host.step((1 / 60) * host.rate)) out.push(ev);
        if ((i + 1) % 6 === 0) host.emit();
      }
      host.emit();
      return out;
    },
    lastStepDt: () => host.lastStepDt,
    time: () => (host.engine ? eng().time : 0),

    // ── read state ──
    snapshot,
    aircraft: (cs: string) => { const a = eng().find(cs); return a ? view(a) : null; },
    radio: () => host.radio.map(l => ({ ...l })),
    events: () => host.eventLog.slice(),
    clearEvents: () => { host.clearEvents(); },
    runways: () => eng().runways.map(r => ({ name: r.name, hdg: Math.round(r.headingMag), active: r.activeDep || r.activeArr, occupied: r.occupiedBy.length > 0, weights: r.weightAllow })),
    beacons: () => eng().beacons.map(b => b.id),
    gates: () => eng().gates.map(g => g.ref),
    taxiways: () => [...(eng().air.taxiwayNames ?? [])],

    // ── write state ──
    spawnAt: (spec: SpawnSpec) => {
      const e = eng();
      const a = e.spawnAt(spec);
      host.flush();
      host.emit();
      return view(a);
    },
    setState: (cs, patch) => {
      const e = eng();
      const a = ac(cs);
      const { posLL, posRel, ...rest } = patch as Partial<AircraftState> & { posLL?: { lat: number; lng: number; altFt?: number }; posRel?: RelPos };
      Object.assign(a, rest);
      if (posLL) { a.pos = e.proj.toXY(posLL.lat, posLL.lng); if (posLL.altFt != null) a.altitude = posLL.altFt; }
      if (posRel) {
        const rs = e.runwayState(posRel.fromRunway); const thr = e.thresholdXY(posRel.fromRunway);
        if (rs && thr) {
          let p = advanceXY(thr, rs.headingTrue, posRel.alongNM * NM_M);
          if (posRel.offsetNM) p = advanceXY(p, (rs.headingTrue + 90) % 360, posRel.offsetNM * NM_M);
          a.pos = p; a.altitude = posRel.altFt;
        }
      }
      host.emit();
      return view(a);
    },
    remove: (cs) => { const e = eng(); const a = e.find(cs); if (a) { if (host.selectedId === a.id) host.select(null); e.remove(a.id, 'test'); host.flush(); host.emit(); } },
    clear: () => { const e = eng(); host.select(null); e.clear(); host.flush(); host.emit(); },
    setAutoSpawn: (on) => { host.autoSpawn = on; host.emit(); },
    setAutoTower: (on) => { host.updateSettings({ autoTower: on }); eng().settings.autoTower = on; host.emit(); },
    setScore: (n) => { eng().stats.points = n; host.emit(); },
    setSkill: (n) => { eng().stats.skill = Math.max(0, Math.min(12, n)); host.emit(); },
    command: (text) => host.command(text),

    // ── geometry ──
    screenPos: (cs) => { const a = eng().find(cs); return a ? host.screenProject(a.pos) : null; },
    screenPosOf: (xy) => host.screenProject(xy) ?? { x: 0, y: 0 },
    emptySpot: () => {
      const size = host.viewSize() ?? { w: 1280, h: 720 };
      const pts: Array<{ x: number; y: number }> = [];
      if (host.engine) for (const a of eng().aircraft) { const p = host.screenProject(a.pos); if (p) pts.push(p); }
      if (host.engine) for (const v of eng().fleet.list()) { const p = host.screenProject(v.pos); if (p) pts.push(p); }
      const margin = 20, minD = 40;
      let best = { x: size.w / 2, y: size.h / 2 }, bestD = -1;
      const cols = 16, rows = 10;
      for (let i = 0; i <= cols; i++) for (let j = 0; j <= rows; j++) {
        const x = margin + ((size.w - 2 * margin) * i) / cols, y = margin + ((size.h - 2 * margin) * j) / rows;
        let d = Infinity;
        for (const p of pts) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
        if (d > bestD) { bestD = d; best = { x, y }; }
        if (d >= minD * 3) return { x, y };
      }
      return best;
    },
    camera: () => host.camera() ?? { x: 0, y: 0, zoom: 1 },
    centerOn: (cs) => { const a = ac(cs); host.centerOnXY(a.pos); host.emit(); },
    setCamera: (cam) => { host.setCamera(cam); host.emit(); },

    // ── feature-contract hooks ──
    setWind: (dirDeg, kts, gustKts = 0) => { eng().setWind(dirDeg, kts, gustKts); host.flush(); host.emit(); },
    setActiveRunways: (ends) => { eng().setActiveRunwayEnds(ends.length ? ends : null); host.flush(); host.emit(); },
    forceEmergency: (cs, kind) => { const a = ac(cs); eng().declareEmergency(a, kind); host.flush(); host.emit(); },
    arff: () => ({
      vehicles: eng().fleet.list().filter(v => v.type === 'arff').map(v => ({
        id: v.id, pos: { x: v.pos.x, y: v.pos.y }, state: v.state,
        target: v.target ? (v.target.kind === 'runway' ? v.target.runway : v.target.kind === 'aircraft' ? v.target.callsign : v.target.kind === 'stand' ? v.target.ref : v.target.kind) : undefined,
      })),
    }),
    stca: () => eng().alerts.stca(),
    atis: () => { const a = eng().weather.atis(); return { letter: a.letter, wind: { dir: a.wind.dir, kts: a.wind.kts }, activeRunways: [...new Set([...a.activeDep, ...a.activeArr])], issuedAt: a.issuedAt }; },
    wakeTimers: () => eng().wakeTimers(),

    // ── G12 extras ──
    setPilotDelay: (s) => { const v = Math.max(1, Math.min(8, s)); eng().settings.pilotDelayOverride = v; host.updateSettings({ pilotDelayS: v }); host.emit(); },
    setWeather: (w) => { eng().weather.setState(w); host.flush(); host.emit(); },
    request: (cs, kind, param) => { const a = ac(cs); eng().raiseRequest(a, kind, param ?? null); host.flush(); host.emit(); },
    state: (cs) => eng().find(cs) ?? null,
    alerts: () => eng().alerts.list().map(a => ({ ...a })),
    ackAlert: (id) => host.ackAlert(id),
    vehicles: () => eng().fleet.list().map(v => ({ ...v })),
    runwayStates: () => eng().runways.map(r => ({ ...r })),
    setRunwayStatus: (runway, status) => { eng().setRunwayStatus(runway, status, 'test'); host.flush(); host.emit(); },
    stage: (cs) => { const a = eng().find(cs); return a ? eng().stageOf(a) : null; },
    actions: (cs) => {
      const a = ac(cs);
      const e = eng() as EngineLike & { playerPosition: 'ground' | 'tower' | 'approach' };
      const ctx = actionCtxFromEngine(e as unknown as Parameters<typeof actionCtxFromEngine>[0], a, { position: e.playerPosition });
      return ctx ? actionsFor(a, ctx) : [];
    },
    dispatchAst: (ast) => host.dispatchAst(ast),
    setPosition: (p) => { host.setPosition(p); },
    select: (cs) => { if (cs == null) { host.select(null); return; } host.select(ac(cs).id); },
  };
  return api;
}

declare global {
  interface Window { __atcTest?: AtcTestApi }
}

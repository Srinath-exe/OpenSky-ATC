// ============================================================
//  simStore — the single bridge between the pure engine (src/lib/sim) and the
//  React game UI / canvas renderers (00-MASTER-PLAN §2.1, 06-CONTRACTS §2, §7).
//
//  Owns: ONE SimEngine (+ the parsed airspace projected into engine XY), the
//  RAF loop (never in test mode), `step()` (engine.update + event routing +
//  autospawn + persistence), the comm log, toasts, selection / hover, the
//  position tab, settings (persisted), start-config consumption, the test API
//  installation (window.__atcTest) and the render-hook registry the canvas
//  views use for screen projection.
//
//  Emit policy (binding for the UI): every discrete mutation emits at once
//  (version++ and subscribers notified); the RAF loop emits every 6th frame
//  (~10 Hz) so live numbers update; canvas views read `sim` directly in their
//  own RAF and never re-render React per frame.
//
//  Relative imports on purpose: this file is also compiled by the headless
//  node:test runner (scripts/test-sim.sh) which ignores tsconfig path aliases.
// ============================================================
import { useRef, useSyncExternalStore } from 'react';
import { SimEngine, AirspaceConfig, FIXED } from '../../lib/sim/engine';
import { buildOsmAirport } from '../../lib/osmAirport';
import type { OsmAirport } from '../../lib/osmAirport';
import { loadEndlessAirport, coordToXY } from '../../lib/airspace/eairport';
import type { EAirport } from '../../lib/airspace/eairport';
import { setSeed, rf, chance } from '../../lib/sim/rng';
import { advance, headingTo, NM_TO_M } from '../../lib/sim/projection';
import type { XY } from '../../lib/sim/projection';
import type { ILSRunway } from '../../lib/sim/ils';
import type { WeightClass } from '../../lib/sim/aircraftDB';
import { executeText, dispatch, fromEngine, actionCtxFromEngine, isSilent } from '../../lib/sim/dispatch';
import type { DispatchResult } from '../../lib/sim/dispatch';
import { suggest as suggestText } from '../../lib/sim/commands';
import type { Suggestion } from '../../lib/sim/commands';
import { actionsFor as treeActionsFor, stepsFor as treeStepsFor, validate as treeValidate, toAst, undoable, canUndo } from '../../lib/sim/commandTree';
import type { ActionCtx, ActionRow, PickerStep, ActionParams, ValidationResult, ActionId } from '../../lib/sim/commandTree';
import { makeAst, isAircraftCommand } from '../../lib/sim/commandAst';
import type { CommandAST, CommandResult } from '../../lib/sim/commandAst';
import { bayFor } from '../../lib/sim/stage';
import type { BayId } from '../../lib/sim/stage';
import { EVENT_WHO } from '../../lib/sim/types';
import type {
  AircraftState, Alert, AlertSeverity, Atis, EmergencyType, PilotRequest, PlayerPosition, RunwayState, RunwayStatus,
  SessionStats, SimEvent, Stage, Vehicle, VehicleTarget, VehicleType, WeatherState, Position as FreqPosition,
} from '../../lib/sim/types';
import { createTestApi } from '../../lib/sim/testApi';
import type { AtcTestApi, CameraView, TestApiHost } from '../../lib/sim/testApi';
import { sound } from './sound';
import * as persist from './persist';

const NM = NM_TO_M, DEG = Math.PI / 180;

// ──────────────────────────────────────────────────────────────────────────────
//  Airport catalogue (home page picker, ground camera presets)
// ──────────────────────────────────────────────────────────────────────────────
export const ATC_AIRPORTS: Record<string, { center: [number, number]; groundZoom: number; name: string; city: string }> = {
  EGLL: { center: [-0.4543, 51.4700], groundZoom: 13.4, name: 'Heathrow', city: 'London' },
  KLAX: { center: [-118.4081, 33.9416], groundZoom: 13.5, name: 'Los Angeles Intl', city: 'Los Angeles' },
  KJFK: { center: [-73.7781, 40.6413], groundZoom: 13.3, name: 'John F. Kennedy', city: 'New York' },
  KSFO: { center: [-122.3790, 37.6213], groundZoom: 13.5, name: 'San Francisco Intl', city: 'San Francisco' },
  KBOS: { center: [-71.0096, 42.3656], groundZoom: 13.5, name: 'Logan Intl', city: 'Boston' },
  VIDP: { center: [77.1000, 28.5562], groundZoom: 13.1, name: 'Indira Gandhi', city: 'Delhi' },
};

// ──────────────────────────────────────────────────────────────────────────────
//  Public types (the STORE INTERFACE every Wave-2 agent codes to)
// ──────────────────────────────────────────────────────────────────────────────
export type Position = PlayerPosition;

export interface RadioLine {
  key: number;
  who: 'ATC' | 'PILOT' | 'SYS' | 'AI';
  text: string;
  /** Sim seconds. */
  at: number;
  callsign?: string;
  /** Frequency the line was heard on (comm-log filter). */
  position?: FreqPosition;
  result?: CommandResult;
  ast?: CommandAST;
  /** Sim time until which this ATC line can be undone (UNDO ring); undefined = no ring / closed. */
  undoUntil?: number;
  status?: 'ok' | 'unable' | 'partial' | 'error' | 'undone' | 'mismatch';
}

export type ToastKind = 'info' | 'success' | 'attention' | 'error';
export interface Toast {
  key: number;
  kind: ToastKind;
  text: string;
  detail?: string;
  /** Alert severity when the toast mirrors an alert. */
  severity?: AlertSeverity;
  /** Wall-clock ms the toast was pushed. */
  at: number;
  /** ms; 0 = sticky (critical alerts stay until acked / dismissed). */
  duration: number;
  alertId?: string;
  callsigns?: string[];
  scoreDelta?: number;
}

export interface Settings {
  autoTower: boolean;
  autoGround: boolean;
  autoHandoff: boolean;
  strictFrequencies: boolean;
  emergencyRate: 'off' | 'rare' | 'normal' | 'training';
  groundTheme: 'satellite' | 'chart';
  showRings: boolean;
  difficulty: 'low' | 'normal' | 'high';
  sound: boolean;
  tts: boolean;
  /** 0..1 master volume. */
  volume: number;
  /** Fixed pilot delay in sim seconds (1-8), null = realistic 2-4 s air / 4-8 s ground. */
  pilotDelayS: number | null;
  /** Pilots occasionally read back a wrong value (2 %). */
  readbackErrors: boolean;
  /** Phraseology variant; 'auto' = FAA for K-airports, ICAO elsewhere. */
  region: 'auto' | 'ICAO' | 'FAA';
  /** Drag-to-heading transmits without confirm. */
  instantVectors: boolean;
  /** Typed command line transmits without confirm. */
  typedInstant: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoTower: false, autoGround: false, autoHandoff: true, strictFrequencies: false, emergencyRate: 'normal',
  groundTheme: 'satellite', showRings: true, difficulty: 'normal', sound: true, tts: false, volume: 0.8,
  pilotDelayS: null, readbackErrors: true, region: 'auto', instantVectors: false, typedInstant: true,
};

export interface StartConfig {
  icao: string;
  /** Active runway ends (both roles); undefined / [] = every end. */
  ends?: string[];
  /** Allowed weight classes per END. */
  weights?: Record<string, WeightClass[]>;
  seed?: number;
  spawn?: 'none' | 'default';
  difficulty?: 'low' | 'normal' | 'high';
  /** Deterministic test mode: no RAF, window.__atcTest installed. */
  test?: boolean;
  /** Starting position tab. */
  position?: Position;
}

export interface RadarBeacon { id: string; x: number; y: number; pron?: string; holdHeading?: number }
export interface RadarRunway { id: string; name: string; thr: XY; course: number; locCourse: number; gsDeg: number; lengthM: number }
export interface RadarEntry { x: number; y: number; heading: number; beacon?: string; altFt: number; weight: number }
export interface RadarArea { shape: 'circle' | 'polygon'; altFt: number; name?: string; radiusM?: number; center?: XY; points: XY[] }
export interface RadarScene {
  centerXY: XY; radiusM: number;
  beacons: RadarBeacon[]; runways: RadarRunway[]; entries: RadarEntry[]; areas: RadarArea[];
}

export interface StripBay { bay: BayId; title: string; items: AircraftState[] }

export type ProjectorKind = 'radar' | 'ground';
export interface ProjectorExtras {
  /** Move the view camera (radar cam / maplibre jumpTo with zoom). */
  setCamera?: (cam: CameraView) => void;
  /** CSS size of the canvas element (emptySpot / hit-testing). */
  size?: () => { w: number; h: number } | null;
}
interface Projector { fn: (xy: XY) => { x: number; y: number } | null; centerOn: (xy: XY) => void; camera: () => CameraView | null; extras: ProjectorExtras }

/** Legacy key map kept for the old settings page; new code uses `persist.PERSIST_KEYS`. */
export const LS_KEYS = {
  score: persist.PERSIST_KEYS.highScore,
  tts: persist.PERSIST_KEYS.settings,
  groundTheme: persist.PERSIST_KEYS.settings,
  autoTower: persist.PERSIST_KEYS.settings,
  settings: persist.PERSIST_KEYS.settings,
  startConfig: persist.PERSIST_KEYS.startConfig,
};

const RADIO_MAX = 300;
const EVENT_RING = 500;
const TOAST_MAX = 8;
const EMIT_EVERY = 6;

const BAY_TITLES: Record<BayId, string> = {
  PENDING: 'PENDING', PUSH_START: 'PUSH · START', TAXI_OUT: 'TAXI OUT', AT_HOLD: 'AT HOLD', TAXI_IN: 'TAXI IN', AT_STAND: 'AT STAND', VEHICLES: 'VEHICLES',
  LINED_UP: 'LINED UP', ROLLING_AIRBORNE: 'ROLLING · AIRBORNE', FINAL: 'FINAL', LANDED_ROLLOUT: 'LANDED · ROLLOUT', TO_GROUND: 'TO GROUND',
  INBOUND: 'INBOUND', SEQUENCE: 'SEQUENCE', ESTABLISHED: 'ESTABLISHED', TO_TOWER: 'TO TOWER', CLIMB_OUT: 'CLIMB OUT', HANDED_OFF: 'HANDED OFF',
};
const BAY_ORDER: Record<Position, BayId[]> = {
  ground: ['PENDING', 'PUSH_START', 'TAXI_OUT', 'AT_HOLD', 'TAXI_IN', 'AT_STAND', 'VEHICLES'],
  tower: ['AT_HOLD', 'LINED_UP', 'ROLLING_AIRBORNE', 'FINAL', 'LANDED_ROLLOUT', 'TO_GROUND', 'VEHICLES'],
  approach: ['INBOUND', 'SEQUENCE', 'ESTABLISHED', 'TO_TOWER', 'CLIMB_OUT', 'HANDED_OFF'],
};
/** Bays sorted by distance to threshold (arrival flow). */
const DISTANCE_BAYS = new Set<BayId>(['FINAL', 'SEQUENCE', 'ESTABLISHED', 'TO_TOWER', 'INBOUND']);

/** Autospawn tuning per difficulty: traffic cap and spawn cadence (sim s). */
const SPAWN_TUNING: Record<Settings['difficulty'], { base: number; lo: number; hi: number; depShare: number }> = {
  low: { base: 5, lo: 90, hi: 150, depShare: 0.55 },
  normal: { base: 8, lo: 50, hi: 100, depShare: 0.55 },
  high: { base: 12, lo: 30, hi: 60, depShare: 0.5 },
};
const SPAWN_CAP_MAX = 20;

const isBrowser = () => typeof window !== 'undefined';

function readUrlParams(): { test: boolean; seed: number | null; spawn: 'none' | 'default' | null; icao: string | null } {
  if (!isBrowser()) return { test: false, seed: null, spawn: null, icao: null };
  try {
    const q = new URLSearchParams(window.location.search);
    const seedRaw = q.get('seed');
    const seed = seedRaw != null && seedRaw !== '' && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : null;
    const spawnRaw = q.get('spawn');
    const spawn = spawnRaw === 'none' || spawnRaw === 'default' ? spawnRaw : null;
    const icaoRaw = q.get('icao');
    const icao = icaoRaw && /^[A-Za-z]{4}$/.test(icaoRaw) ? icaoRaw.toUpperCase() : null;
    const test = q.get('test') === '1' || q.get('test') === 'true';
    return { test, seed, spawn, icao };
  } catch {
    return { test: false, seed: null, spawn: null, icao: null };
  }
}

function randomSeed(): number {
  return (Math.floor(Math.random() * 0x7fffffff) ^ (Date.now() & 0x7fffffff)) >>> 0;
}

// ──────────────────────────────────────────────────────────────────────────────
//  The store
// ──────────────────────────────────────────────────────────────────────────────
class SimStore implements TestApiHost {
  // ---- state ----
  engine: SimEngine | null = null;
  osm: OsmAirport | null = null;
  airspace: EAirport | null = null;
  radar: RadarScene | null = null;
  icao = '';
  loading = false;
  loadError: string | null = null;
  /** Monotonic; bumps on every emit. */
  version = 0;
  paused = false;
  rate: 1 | 2 | 4 = 1;
  position: Position = 'tower';
  selectedId: number | null = null;
  hoveredId: number | null = null;
  radio: RadioLine[] = [];
  toasts: Toast[] = [];
  settings: Settings;
  testMode = false;
  autoSpawn = true;
  mapReady = false;
  highScore = 0;
  lastCallsign: string | null = null;
  /** Seed of the current session (reproducible). */
  seed = 0;
  /** Config the current session was loaded with (restart re-applies it). */
  lastConfig: StartConfig | null = null;
  /** dt passed to the last step() (rate spy for the test API). */
  lastStepDt = 0;
  /** Ring of every engine event since the last clear (test API / late panels). */
  eventLog: SimEvent[] = [];
  /** Feature-flag overrides for the test API (`features()`); UI agents may flip flags off. */
  featureOverrides: Partial<Record<string, boolean>> = {};
  /** Sim time of the last spawn decision and the next planned spawn. */
  nextSpawnAt = 0;

  get tts(): boolean { return this.settings.tts; }

  private raf = 0;
  private last = 0;
  private emitTick = 0;
  private lineKey = 0;
  private toastKey = 0;
  private loadToken = 0;
  private sessionStartedAt = 0;
  private lastHighScoreWriteAt = -Infinity;
  private listeners = new Set<() => void>();
  private batchDepth = 0;
  private dirty = false;
  private projectors: Partial<Record<ProjectorKind, Projector>> = {};
  private memo = new Map<string, { v: number; value: unknown }>();
  private urlTest: ReturnType<typeof readUrlParams> | null = null;

  constructor() {
    this.settings = persist.loadSettings(DEFAULT_SETTINGS);
    this.highScore = persist.loadHighScore();
    sound.setEnabled(this.settings.sound);
    sound.setTTS(this.settings.tts);
    sound.setVolume(this.settings.volume);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Subscription / emit
  // ═══════════════════════════════════════════════════════════════════════════
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  emit(): void {
    if (this.batchDepth > 0) { this.dirty = true; return; }
    this.version++;
    for (const l of this.listeners) { try { l(); } catch (err) { console.error(err); } }
  }
  /** Coalesce the emits of several mutations into one notification. */
  private batch<T>(fn: () => T): T {
    this.batchDepth++;
    try { return fn(); }
    finally { if (--this.batchDepth === 0 && this.dirty) { this.dirty = false; this.emit(); } }
  }
  /** Memoise a query per store version (identity-stable results for useSim selectors). */
  private cached<T>(key: string, compute: () => T): T {
    const m = this.memo.get(key);
    if (m && m.v === this.version) return m.value as T;
    const value = compute();
    this.memo.set(key, { v: this.version, value });
    return value;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Convenience boot for the game page: consumes the one-shot start config
   * written by the home page, merges `?test=1&seed=&icao=&spawn=` and loads.
   */
  boot(fallbackIcao = 'EGLL'): Promise<void> {
    const url = readUrlParams();
    const cfg = persist.consumeStartConfig<StartConfig>() ?? this.lastConfig;
    const icao = url.icao ?? cfg?.icao ?? fallbackIcao;
    return this.load({ ...(cfg ?? {}), icao, test: url.test || !!cfg?.test, seed: url.seed ?? cfg?.seed, spawn: url.spawn ?? cfg?.spawn });
  }

  /** Test-API hook: arm test mode before the next load (05 §2.2). */
  enableTestMode(opts: { seed?: number; spawn?: 'none' | 'default' } = {}): void {
    this.testMode = true;
    this.urlTest = { test: true, seed: opts.seed ?? null, spawn: opts.spawn ?? null, icao: null };
    if (opts.seed != null) this.seed = opts.seed;
  }

  /**
   * ALWAYS applies (also when an engine exists): tears the session down, seeds
   * the rng, fetches osm + airspace, builds the engine per 06-CONTRACTS §7.1,
   * applies ends / weights, spawns initial traffic unless spawn:'none' and
   * starts the RAF loop (never in test mode).
   */
  async load(cfg: StartConfig): Promise<void> {
    const token = ++this.loadToken;
    const url = this.urlTest ?? readUrlParams();
    this.urlTest = null;
    const icao = (cfg.icao || 'EGLL').toUpperCase();
    const testMode = !!cfg.test || url.test;
    const spawn: 'none' | 'default' = cfg.spawn ?? url.spawn ?? 'default';
    const seed = cfg.seed ?? url.seed ?? (testMode ? 1 : randomSeed());

    this.teardown();
    this.testMode = testMode;
    this.seed = seed;
    this.icao = icao;
    this.loading = true;
    this.loadError = null;
    this.lastConfig = { ...cfg, icao, seed, spawn, test: testMode };
    if (cfg.difficulty && cfg.difficulty !== this.settings.difficulty) this.updateSettings({ difficulty: cfg.difficulty }, { silent: true });
    if (cfg.position) this.position = cfg.position;
    this.emit();

    let fc: unknown; let ap: EAirport | null = null;
    try {
      [fc, ap] = await Promise.all([
        fetch(`/maps/osm/${icao}.geojson`).then(r => { if (!r.ok) throw new Error(`No airport data for ${icao} (${r.status})`); return r.json(); }),
        loadEndlessAirport(icao).catch(() => null),
      ]);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.loading = false;
      this.loadError = err instanceof Error ? err.message : String(err);
      this.emit();
      return;
    }
    if (token !== this.loadToken) return;

    try {
      setSeed(seed);                                                     // BEFORE new SimEngine (§7.1)
      const air = buildOsmAirport(icao, fc, { magVarDeg: ap?.airspace.magVar, quiet: true });
      const e = new SimEngine(air);
      e.setActiveRunwayEnds(cfg.ends && cfg.ends.length ? cfg.ends : null);
      e.setRunwayWeightAllow(cfg.weights && Object.keys(cfg.weights).length ? cfg.weights : null);
      this.osm = air; this.airspace = ap; this.engine = e;
      this.radar = ap ? this.buildRadar(ap, e) : null;
      if (ap && this.radar) e.setAirspaceConfig(this.airspaceConfig(ap, e, this.radar));
      this.applySettingsToEngine(e);
      e.playerPosition = this.position;
      if (testMode) {
        // deterministic scenarios: fixed pilot delay, exact readbacks, no random emergencies (forceEmergency is the hook)
        e.settings.pilotDelayOverride = this.settings.pilotDelayS ?? 3;
        e.settings.pilotErrorRate = 0;
        e.settings.emergencyRate = 'off';
      }
      this.sessionStartedAt = Date.now();
      this.nextSpawnAt = 0;
      this.autoSpawn = !testMode && spawn !== 'none';
      if (spawn !== 'none') {
        for (let i = 0; i < 4; i++) e.spawnDeparture();
        for (let i = 0; i < 3; i++) e.spawnArrival();
        this.nextSpawnAt = e.time + rf(SPAWN_TUNING[this.settings.difficulty].lo, SPAWN_TUNING[this.settings.difficulty].hi);
      }
      this.pushLine({ who: 'SYS', at: e.time, text: `${ATC_AIRPORTS[icao]?.name ?? air.icao} — ${air.gates.length} stands, ${air.runways.length} runways${ap ? `, ${ap.airspace.radiusNM} NM TMA` : ', no radar airspace'} online${testMode ? ` · test mode · seed ${seed}` : ''}` });
      this.flushEvents();
    } catch (err) {
      this.engine = null; this.radar = null;
      this.loading = false;
      this.loadError = err instanceof Error ? err.message : String(err);
      this.emit();
      return;
    }
    this.loading = false;
    this.emit();
    if (testMode) this.installTestApi();
    else this.start();
  }

  /**
   * Resume the live session on the singleton without reloading (home "Resume shift", settings "Back to shift"):
   * restarts the RAF loop when an engine exists. Returns false when there is nothing to resume.
   */
  resume(): boolean {
    if (!this.engine || this.loading) return false;
    if (!this.testMode) this.start();
    this.emit();
    return true;
  }

  /** Reload the current config (new seed outside test mode); records the finished session first. */
  restart(): Promise<void> {
    const cfg = this.lastConfig ?? { icao: this.icao || 'EGLL' };
    return this.load({ ...cfg, seed: this.testMode ? cfg.seed : undefined });
  }

  private teardown(): void {
    this.stop();
    if (this.engine) this.recordSession();
    this.engine = null; this.osm = null; this.airspace = null; this.radar = null;
    this.selectedId = null; this.hoveredId = null; this.lastCallsign = null;
    this.radio = []; this.toasts = []; this.eventLog = [];
    this.mapReady = false;
    this.paused = false;
    this.memo.clear();
    sound.stopSpeech();
  }

  private recordSession(): void {
    const e = this.engine; if (!e || e.time < 30) return;
    const s = e.stats;
    const incidents = Object.values(s.incidents).reduce<number>((n, v) => n + (v ?? 0), 0);
    persist.pushSessionRecord({
      icao: this.icao, startedAt: this.sessionStartedAt, endedAt: Date.now(), simTimeS: Math.round(e.time),
      points: s.points, skill: s.score, movements: s.movements, departures: s.departures, arrivals: s.arrivals,
      incidents, emergenciesResolved: s.emergenciesResolved, seed: this.seed,
    });
    this.persistHighScore(true);
  }

  private airspaceConfig(ap: EAirport, e: SimEngine, radar: RadarScene): AirspaceConfig {
    const ilsRunways: ILSRunway[] = ap.runways.map(r => ({
      name: r.name, thrXY: coordToXY(r.thrCoord ?? r.coord, e.proj), rwdHdg: r.trueHeading, locCourse: r.localizerCourse,
      gsDeg: r.glideslopeDeg, thrElevFt: 0, estimated: r.derived,
    }));
    const tower = ap.runways.find(r => r.towerFreq != null)?.towerFreq;
    return {
      radiusM: radar.radiusM, centerXY: radar.centerXY, ilsRunways,
      beacons: radar.beacons.map(b => ({ id: b.id, x: b.x, y: b.y })),
      entries: radar.entries.map(ep => ({ x: ep.x, y: ep.y, heading: ep.heading, altFt: ep.altFt, beacon: ep.beacon, weight: ep.weight })),
      magVar: ap.airspace.magVar, transitionAltFt: ap.airspace.transitionAltFt, airportName: ap.name,
      frequencies: tower != null ? { tower: tower.toFixed(3) } : undefined, missedApproachAltFt: 3000,
    };
  }

  private buildRadar(ap: EAirport, e: SimEngine): RadarScene {
    const proj = e.proj;
    const centerXY = coordToXY({ kind: 'll', lat: ap.airspace.center.lat, lng: ap.airspace.center.lng }, proj);
    const radiusM = ap.airspace.radiusNM * NM;
    const beacons: RadarBeacon[] = ap.airspace.beacons.map(b => { const p = coordToXY(b.coord, proj); return { id: b.id, x: p.x, y: p.y, pron: b.pron, holdHeading: b.holdHeading }; });
    const runways: RadarRunway[] = ap.runways.map(r => {
      const thr = coordToXY(r.thrCoord ?? r.coord, proj);
      return { id: r.id, name: r.name, thr, course: r.trueHeading, locCourse: r.localizerCourse, gsDeg: r.glideslopeDeg, lengthM: r.lengthFt * 0.3048 };
    });
    const entries: RadarEntry[] = ap.entryPoints.map(ep => {
      const pos = advance(centerXY, (ep.heading + 180) % 360, radiusM);
      return { x: pos.x, y: pos.y, heading: ep.heading, beacon: ep.beacon, altFt: ep.altitudeFt, weight: ep.weight };
    });
    const areas: RadarArea[] = ap.areas.map(a => ({
      shape: a.shape, altFt: a.altitudeFt, name: a.name,
      radiusM: a.radiusNM ? a.radiusNM * NM : undefined,
      center: a.center ? coordToXY(a.center, proj) : undefined,
      points: a.points.map(p => coordToXY(p, proj)),
    }));
    return { centerXY, radiusM, beacons, runways, entries, areas };
  }

  private installTestApi(): void {
    if (!isBrowser()) return;
    try { (window as unknown as { __atcTest?: AtcTestApi }).__atcTest = createTestApi(this); } catch (err) { console.error('test API install failed', err); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Loop
  // ═══════════════════════════════════════════════════════════════════════════
  private start(): void {
    if (this.raf || this.testMode || !isBrowser()) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min((now - this.last) / 1000, 0.1); this.last = now;
      this.pruneToasts();
      if (this.paused || !this.engine) return;
      this.step(dt * this.rate);
      if (++this.emitTick % EMIT_EVERY === 0) this.emit();
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop(): void {
    if (this.raf && isBrowser()) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * Advance the sim by dtSim sim-seconds (already rate-scaled) and run every
   * store side-effect: event routing, autospawn, persistence, selection
   * clean-up. Pure with respect to the DOM. Returns the engine events.
   */
  step(dtSim: number): SimEvent[] {
    const e = this.engine; if (!e) return [];
    this.lastStepDt = dtSim;
    const events = e.update(dtSim);
    this.batch(() => {
      this.routeEvents(events);
      if (this.autoSpawn) this.autoSpawnTick(e);
      this.persistHighScore(false);
      if (this.selectedId != null && !e.byId(this.selectedId)) { this.selectedId = null; this.pushToast({ kind: 'info', text: 'Selected aircraft left the simulation', duration: 4000 }); }
      if (this.hoveredId != null && !e.byId(this.hoveredId)) { this.hoveredId = null; this.emit(); }
    });
    return events;
  }

  /** Drain events the engine produced outside a step (commands, dispatches) so lines appear at once. */
  flush(): void { this.flushEvents(); }
  private flushEvents(): void {
    const e = this.engine; if (!e) return;
    const evs = e.update(0);
    if (evs.length) this.batch(() => this.routeEvents(evs));
  }

  private autoSpawnTick(e: SimEngine): void {
    const tune = SPAWN_TUNING[this.settings.difficulty];
    if (e.time < this.nextSpawnAt) return;
    const cap = Math.min(SPAWN_CAP_MAX, tune.base + Math.floor(e.skill / 2));
    if (e.aircraft.length < cap) {
      const dep = chance(tune.depShare);
      const ok = dep ? e.spawnDeparture() : e.spawnArrival();
      if (!ok) { if (dep) e.spawnArrival(); else e.spawnDeparture(); }
    }
    this.nextSpawnAt = e.time + rf(tune.lo, tune.hi);
  }

  private persistHighScore(force: boolean): void {
    const e = this.engine; if (!e) return;
    if (e.stats.points > this.highScore) {
      this.highScore = e.stats.points;
      if (force || e.time - this.lastHighScoreWriteAt >= 1) { persist.saveHighScore(this.highScore); this.lastHighScoreWriteAt = e.time; }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Event routing (06-CONTRACTS §7.3)
  // ═══════════════════════════════════════════════════════════════════════════
  private routeEvents(events: SimEvent[]): void {
    if (!events.length) return;
    for (const ev of events) {
      this.eventLog.push(ev);
      this.route(ev);
    }
    if (this.eventLog.length > EVENT_RING) this.eventLog.splice(0, this.eventLog.length - EVENT_RING);
  }

  private route(ev: SimEvent): void {
    const who = ev.who ?? EVENT_WHO[ev.type];
    const d = ev.data;
    switch (ev.type) {
      case 'phase': case 'stage': case 'removed': case 'landing_clearance':
        return;                                                        // UI reads these from state
      case 'request': {
        if (d?.type === 'request') {
          if (d.change === 'raised' || d.change === 'recalled') { this.pushLine({ who: 'PILOT', at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position }); sound.play('request'); this.speak(ev.message, 'PILOT'); }
          return;
        }
        break;
      }
      case 'readback': {
        this.pushLine({ who: 'PILOT', at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position, status: d?.type === 'readback' ? readbackStatus(d.status) : undefined });
        this.closeUndo(ev.callsign, d?.type === 'readback' ? d.status : 'ok');
        if (d?.type === 'readback' && (d.status === 'unable' || d.status === 'mismatch')) sound.play('error'); else sound.play('readback');
        this.speak(ev.message, 'PILOT');
        return;
      }
      case 'transmission': {
        if (d?.type === 'transmission') {
          const res = d.result;
          const undoOpen = res.ok && res.applyAt != null && res.applyAt > ev.at && undoable(d.ast);
          this.pushLine({
            who: who === 'AI' ? 'AI' : 'ATC', at: ev.at, text: ev.message, callsign: ev.callsign !== 'SYSTEM' ? ev.callsign : undefined, position: ev.position,
            result: res, ast: d.ast, undoUntil: undoOpen ? res.applyAt : undefined,
            status: res.ok ? (res.code === 'partial' ? 'partial' : 'ok') : res.code.startsWith('unable') ? 'unable' : res.code === 'queried' ? 'ok' : 'error',
          });
          if (d.who === 'player') sound.play('transmit');
          return;
        }
        break;
      }
      case 'alert': {
        if (d?.type === 'alert') {
          const al = d.alert;
          if (d.change === 'raised' || d.change === 'updated') {
            this.upsertAlertToast(al, d.change);
            if (d.change === 'raised') sound.alert(al.severity);
          } else if (d.change === 'resolved') {
            this.toasts = this.toasts.filter(t => t.alertId !== al.id);
            this.pushToast({ kind: 'success', text: `Resolved · ${al.title}`, detail: al.subjects.join(' / '), duration: 3000, alertId: undefined, callsigns: al.subjects });
            sound.play('resolve');
          } else if (d.change === 'acked') {
            this.toasts = this.toasts.filter(t => t.alertId !== al.id);
            this.emit();
          }
          return;
        }
        break;
      }
      case 'score': {
        if (d?.type === 'score') {
          const s = d.score;
          if (s.points !== 0) {
            this.pushToast({
              kind: s.points < 0 ? 'error' : s.points >= 50 ? 'success' : 'info',
              text: `${s.points > 0 ? '+' : ''}${s.points} ${s.code.toLowerCase().replace(/_/g, ' ')}`, detail: s.detail || s.primary,
              duration: s.points < 0 ? 5000 : 2500, scoreDelta: s.points, callsigns: [s.primary, ...(s.secondary ? [s.secondary] : [])],
            });
            sound.play(s.points < 0 ? 'score-down' : 'score-up');
          }
          return;
        }
        break;
      }
      case 'emergency': {
        if (d?.type === 'emergency') {
          const line = who === 'PILOT' ? 'PILOT' : 'SYS';
          this.pushLine({ who: line, at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position });
          if (d.change === 'declared') {
            this.pushToast({ kind: 'error', severity: 'critical', text: `${d.emergency.level} · ${ev.callsign}`, detail: ev.message, duration: 0, callsigns: [ev.callsign] });
            sound.play('emergency');
          } else if (d.change === 'resolved') {
            this.toasts = this.toasts.filter(t => !(t.severity === 'critical' && t.callsigns?.includes(ev.callsign) && !t.alertId));
            this.pushToast({ kind: 'success', text: `Emergency resolved · ${ev.callsign}`, duration: 4000, callsigns: [ev.callsign] });
            sound.play('resolve');
          }
          if (line === 'PILOT') this.speak(ev.message, 'PILOT');
          return;
        }
        break;
      }
      case 'atis': {
        this.pushLine({ who: 'SYS', at: ev.at, text: ev.message });
        return;
      }
      case 'handoff': {
        this.pushLine({ who: 'SYS', at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position });
        sound.play('handoff');
        return;
      }
      case 'ground_conflict': case 'separation_loss': case 'diversion': case 'fuel_exhaustion': {
        this.pushLine({ who: 'SYS', at: ev.at, text: ev.message, callsign: ev.callsign, position: ev.position, status: 'error' });
        return;
      }
      default:
        break;
    }
    // generic routing by who
    this.pushLine({ who, at: ev.at, text: ev.message, callsign: ev.callsign !== 'SYSTEM' ? ev.callsign : undefined, position: ev.position });
    if (who === 'PILOT') this.speak(ev.message, 'PILOT');
  }

  private upsertAlertToast(al: Alert, change: 'raised' | 'updated'): void {
    const kind: ToastKind = al.severity === 'critical' ? 'error' : al.severity === 'warning' ? 'attention' : 'info';
    const duration = al.severity === 'critical' ? 0 : al.severity === 'warning' ? 12000 : 6000;
    const existing = this.toasts.find(t => t.alertId === al.id);
    if (existing) {
      this.toasts = this.toasts.map(t => t.alertId === al.id ? { ...t, text: al.title, detail: al.detail, severity: al.severity, kind, callsigns: [...al.subjects] } : t);
      this.emit();
      return;
    }
    if (change === 'updated') return;
    this.pushToast({ kind, severity: al.severity, text: al.title, detail: al.detail, duration, alertId: al.id, callsigns: [...al.subjects] });
  }

  private speak(text: string, who: 'PILOT' | 'ATC'): void {
    if (this.settings.tts && this.settings.sound && !this.testMode) sound.speak(text, { who });
  }

  /** Readback for `callsign` arrived: the UNDO ring of its latest open ATC line closes (06 §4). */
  private closeUndo(callsign: string, status: string): void {
    for (let i = this.radio.length - 1; i >= 0; i--) {
      const l = this.radio[i];
      if ((l.who !== 'ATC' && l.who !== 'AI') || l.callsign !== callsign) continue;
      const next: RadioLine = { ...l, undoUntil: undefined, status: status === 'mismatch' ? 'mismatch' : status === 'unable' ? 'unable' : status === 'partial' ? 'partial' : l.status };
      this.radio = [...this.radio.slice(0, i), next, ...this.radio.slice(i + 1)];
      return;
    }
  }

  private pushLine(l: Omit<RadioLine, 'key'>): RadioLine {
    if (!l.text) return { ...l, key: -1 } as RadioLine;
    const line: RadioLine = { ...l, key: ++this.lineKey };
    this.radio = this.radio.length >= RADIO_MAX ? [...this.radio.slice(-(RADIO_MAX - 1)), line] : [...this.radio, line];
    this.emit();
    return line;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Commands
  // ═══════════════════════════════════════════════════════════════════════════
  private parseCtx() {
    const e = this.engine!;
    const sel = this.selectedId != null ? e.byId(this.selectedId) : undefined;
    return fromEngine(e, { lastCallsign: sel?.callsign ?? this.lastCallsign, position: this.position });
  }

  /** Comm-log text entry: executeText with the engine context; pushes the ATC line (via the transmission event) or a SYS line. */
  command(text: string): DispatchResult {
    const e = this.engine;
    const trimmed = text.trim();
    if (!e) return { ok: false, code: 'not_implemented', transmission: '', readback: '', reason: 'No airport loaded', warnings: [] };
    if (!trimmed) return { ok: false, code: 'invalid_param', transmission: '', readback: '', reason: 'Empty command', warnings: [] };
    const { parse, result } = executeText(e, trimmed, this.parseCtx(), { position: this.position });
    if (parse.callsign) this.lastCallsign = parse.callsign;
    this.afterDispatch(result, parse.callsign ?? null, trimmed);
    return result;
  }

  /** Structured dispatch (click tree, drag gestures, panels). */
  dispatchAst(ast: CommandAST): DispatchResult {
    const e = this.engine;
    if (!e) return { ok: false, code: 'not_implemented', transmission: '', readback: '', reason: 'No airport loaded', warnings: [] };
    const a = isAircraftCommand(ast) ? e.find(ast.callsign) ?? null : null;
    const ctx = a ? this.actionCtx(a) : undefined;
    const result = dispatch(e, ast, ctx ? { ctx } : {});
    if (a) this.lastCallsign = a.callsign;
    this.afterDispatch(result, a?.callsign ?? null, null);
    return result;
  }

  private afterDispatch(result: DispatchResult, callsign: string | null, raw: string | null): void {
    const e = this.engine!;
    this.flushEvents();
    if (!result.ok && isSilent(result.code)) {
      this.pushLine({ who: 'SYS', at: e.time, text: `${raw ? `${raw.toUpperCase()} — ` : ''}${result.reason ?? result.code}`, callsign: callsign ?? undefined, status: 'error' });
      sound.play('error');
    }
    this.emit();
  }

  suggest(prefix: string): Suggestion[] {
    if (!this.engine) return [];
    return suggestText(prefix, this.parseCtx());
  }

  actionCtx(a: AircraftState): ActionCtx | null {
    const e = this.engine; if (!e) return null;
    return actionCtxFromEngine(e, a, { position: this.position });
  }
  actionsFor(a: AircraftState): ActionRow[] {
    const ctx = this.actionCtx(a); if (!ctx) return [];
    return treeActionsFor(a, ctx);
  }
  stepsFor(id: ActionId, a: AircraftState): PickerStep[] {
    const ctx = this.actionCtx(a); if (!ctx) return [];
    return treeStepsFor(id, a, ctx);
  }
  validate(id: ActionId, params: ActionParams, a: AircraftState): ValidationResult {
    const ctx = this.actionCtx(a);
    if (!ctx) return { ok: false, errors: [{ code: 'not_found', reason: null, text: 'No airport loaded', hard: true }], warnings: [], ast: null };
    return treeValidate(id, params, a, ctx);
  }
  /** toAst + dispatch (the TRANSMIT button). */
  transmit(id: ActionId, params: ActionParams, a: AircraftState): DispatchResult {
    let ast: CommandAST;
    try { ast = toAst(id, params, a.callsign, a); }
    catch (err) { return { ok: false, code: 'invalid_param', transmission: '', readback: '', reason: err instanceof Error ? err.message : String(err), warnings: [] }; }
    return this.dispatchAst(ast);
  }

  /** The line whose UNDO ring is still open (newest first), null if none. */
  undoableLine(): RadioLine | null {
    const e = this.engine; if (!e) return null;
    for (let i = this.radio.length - 1; i >= 0; i--) {
      const l = this.radio[i];
      if (l.who !== 'ATC' || l.undoUntil == null || !l.callsign || !l.ast) continue;
      if (e.time >= l.undoUntil) continue;
      if (!canUndo(l.at, e.time, l.undoUntil)) continue;
      return l;
    }
    return null;
  }

  /** Pre-empt the last undoable transmission within its window ("{cs}, disregard."). */
  undo(): boolean {
    const e = this.engine; if (!e) return false;
    const line = this.undoableLine(); if (!line || !line.callsign) return false;
    const r = this.dispatchAst(makeAst('disregard', line.callsign, {}));
    if (!r.ok) return false;
    this.radio = this.radio.map(l => l.key === line.key ? { ...l, undoUntil: undefined, status: 'undone' } : l);
    sound.play('undo');
    this.emit();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UI state
  // ═══════════════════════════════════════════════════════════════════════════
  select(id: number | null): void {
    const e = this.engine;
    if (id != null && e) {
      const a = e.byId(id);
      if (!a) id = null;
      else { a.attention = false; a.underControl = true; this.lastCallsign = a.callsign; }
    }
    if (this.selectedId === id) return;
    this.selectedId = id;
    if (id != null) sound.play('select');
    this.emit();
  }
  hover(id: number | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.emit();
  }
  setPosition(p: Position): void {
    if (this.position === p) return;
    this.position = p;
    if (this.engine) this.engine.playerPosition = p;
    this.memo.clear();
    this.emit();
  }
  setRate(r: 1 | 2 | 4): void {
    if (r !== 1 && r !== 2 && r !== 4) return;
    this.rate = r;
    this.emit();
  }
  togglePause(): void { this.setPaused(!this.paused); }
  setPaused(b: boolean): void {
    if (this.paused === b) return;
    this.paused = b;
    if (this.engine) this.engine.paused = b;
    if (isBrowser()) this.last = performance.now();
    sound.play(b ? 'pause' : 'resume');
    this.emit();
  }
  toggleTTS(): void { this.updateSettings({ tts: !this.settings.tts }); }
  setMapReady(b: boolean): void {
    if (this.mapReady === b) return;
    this.mapReady = b;
    this.emit();
  }

  /** Merge a settings patch, persist it and apply it to the engine + sound at once. */
  updateSettings(patch: Partial<Settings>, opts: { silent?: boolean } = {}): void {
    this.settings = { ...this.settings, ...patch };
    persist.saveSettings(this.settings);
    sound.setEnabled(this.settings.sound);
    sound.setTTS(this.settings.tts);
    sound.setVolume(this.settings.volume);
    if (this.engine) this.applySettingsToEngine(this.engine);
    if (!opts.silent) this.emit();
  }
  private applySettingsToEngine(e: SimEngine): void {
    const s = this.settings;
    e.settings.autoTower = s.autoTower;
    e.settings.autoGround = s.autoGround;
    e.settings.autoHandoff = s.autoHandoff;
    e.settings.strictFrequencies = s.strictFrequencies;
    if (!this.testMode) {
      e.settings.emergencyRate = s.emergencyRate;
      e.settings.pilotDelayOverride = s.pilotDelayS;
      e.settings.pilotErrorRate = s.readbackErrors ? 0.02 : 0;
    } else if (s.pilotDelayS != null) {
      e.settings.pilotDelayOverride = s.pilotDelayS;
    }
    if (s.region !== 'auto') e.settings.region = s.region;
  }

  ackAlert(id: string): boolean {
    const e = this.engine; if (!e) return false;
    const ok = e.alerts.ack(id, e.time);
    this.toasts = this.toasts.filter(t => t.alertId !== id);
    this.memo.clear();
    this.emit();
    return ok;
  }
  dismissToast(key: number): void {
    const before = this.toasts.length;
    this.toasts = this.toasts.filter(t => t.key !== key);
    if (this.toasts.length !== before) this.emit();
  }
  pushToast(t: Omit<Toast, 'key' | 'at'> & { at?: number; duration?: number }): Toast {
    const toast: Toast = { ...t, key: ++this.toastKey, at: t.at ?? Date.now(), duration: t.duration ?? 5000 };
    this.toasts = [...this.toasts, toast].slice(-TOAST_MAX);
    this.emit();
    return toast;
  }
  private pruneToasts(): void {
    if (!this.toasts.length) return;
    const now = Date.now();
    const keep = this.toasts.filter(t => t.duration === 0 || now - t.at < t.duration);
    if (keep.length !== this.toasts.length) { this.toasts = keep; this.emit(); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Ops
  // ═══════════════════════════════════════════════════════════════════════════
  /** Dispatch a vehicle by type ('arff' = all three trucks) or by id ('FIRE1'). */
  dispatchVehicle(typeOrId: string, target: VehicleTarget): DispatchResult {
    const e = this.engine;
    if (!e) return { ok: false, code: 'not_implemented', transmission: '', readback: '', reason: 'No airport loaded', warnings: [] };
    const v = e.fleet.byId(typeOrId.toUpperCase());
    const type = (v ? v.type : typeOrId.toLowerCase()) as VehicleType;
    const ids = v ? [v.id] : [];
    const count = v ? 1 : type === 'arff' ? 3 : 1;
    return this.dispatchAst(makeAst('dispatchVehicle', null, { type, ids, count, target }));
  }
  recallVehicle(id: string): DispatchResult {
    return this.dispatchAst(makeAst('recallVehicle', null, { id: id.toUpperCase() }));
  }
  setActiveRunways(dep: string[], arr: string[]): void {
    const e = this.engine; if (!e) return;
    e.setActiveRunways(dep, arr);
    this.flushEvents();
    this.memo.clear();
    this.emit();
  }
  setRunwayStatus(rwy: string, status: RunwayStatus, reason = 'controller'): void {
    const e = this.engine; if (!e) return;
    const out = e.setRunwayStatus(rwy, status, reason);
    this.flushEvents();
    if (!out.ok) this.pushLine({ who: 'SYS', at: e.time, text: out.reason ?? out.code, status: 'error' });
    this.memo.clear();
    this.emit();
  }
  spawnDeparture(): void {
    const e = this.engine; if (!e) return;
    e.spawnDeparture();
    this.flushEvents(); this.emit();
  }
  spawnArrival(): void {
    const e = this.engine; if (!e) return;
    e.spawnArrival();
    this.flushEvents(); this.emit();
  }
  clearTraffic(): void {
    const e = this.engine; if (!e) return;
    e.clear(); this.selectedId = null; this.hoveredId = null;
    this.flushEvents(); this.emit();
  }
  declareEmergency(cs: string, type: EmergencyType): void {
    const e = this.engine; if (!e) return;
    const a = e.find(cs); if (!a) return;
    e.declareEmergency(a, type);
    this.flushEvents(); this.emit();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Queries (memoised per version where cheap)
  // ═══════════════════════════════════════════════════════════════════════════
  aircraft(): AircraftState[] { return this.cached('aircraft', () => this.engine ? [...this.engine.aircraft] : []); }
  byId(id: number): AircraftState | undefined { return this.engine?.byId(id); }
  find(cs: string): AircraftState | undefined { return this.engine?.find(cs); }
  selected(): AircraftState | null { return this.selectedId != null ? this.engine?.byId(this.selectedId) ?? null : null; }
  stageOf(a: AircraftState): Stage { return this.engine ? this.engine.stageOf(a) : 'parked'; }
  bayOf(a: AircraftState, position: Position = this.position): BayId | null { return this.engine ? bayFor(a, this.engine.stageOf(a), position) : null; }

  /** Strip bays for a position tab (UX §2.2 + §G7): every bay in its fixed order; emergencies pinned first. */
  stripsFor(position: Position): StripBay[] {
    return this.cached(`strips:${position}`, () => {
      const e = this.engine;
      const bays = new Map<BayId, AircraftState[]>();
      for (const b of BAY_ORDER[position]) bays.set(b, []);
      if (e) {
        for (const a of e.aircraft) {
          const bay = bayFor(a, e.stageOf(a), position);
          if (bay && bays.has(bay)) bays.get(bay)!.push(a);
        }
        for (const [bay, items] of bays) {
          const key = (a: AircraftState) => (DISTANCE_BAYS.has(bay) ? (a.plan.runway ? e.distToThresholdNM(a, a.plan.runway) ?? 999 : 999) : a.spawnedAt);
          items.sort((x, y) => {
            const ex = x.emergency && x.emergency.status !== 'resolved' ? 0 : 1, ey = y.emergency && y.emergency.status !== 'resolved' ? 0 : 1;
            if (ex !== ey) return ex - ey;
            return key(x) - key(y) || x.id - y.id;
          });
        }
      }
      return [...bays].map(([bay, items]) => ({ bay, title: BAY_TITLES[bay], items }));
    });
  }
  // shallow copies: the fleet mutates vehicles in place, and useSim's shallow-equal would otherwise miss a state change (recall / hold) until the next tick
  vehicles(): Vehicle[] { return this.cached('vehicles', () => this.engine ? this.engine.fleet.list().map(v => ({ ...v })) : []); }
  alerts(): Alert[] { return this.cached('alerts', () => this.engine ? [...this.engine.activeAlerts()] : []); }
  allAlerts(): Alert[] { return this.cached('allAlerts', () => this.engine ? [...this.engine.alerts.list()] : []); }
  atis(): Atis | null { return this.cached('atis', () => { try { return this.engine ? this.engine.weather.atis() : null; } catch { return null; } }); }
  weather(): WeatherState | null { return this.cached('weather', () => this.engine ? this.engine.wx() : null); }
  runways(): RunwayState[] { return this.cached('runways', () => this.engine ? [...this.engine.runwayStates()] : []); }
  suggestedRunways(): { dep: string[]; arr: string[]; reason: string } | null { return this.engine?.suggestedRunways ?? null; }
  stats(): SessionStats { return this.cached('stats', () => this.engine ? { ...this.engine.stats } : emptyStats()); }
  score(): number { return this.engine?.stats.points ?? 0; }
  skill(): number { return this.engine?.stats.skill ?? 0; }
  time(): number { return this.engine?.time ?? 0; }
  counts(): { total: number; air: number; gnd: number; conflict: number; req: number; emerg: number } {
    return this.cached('counts', () => {
      const e = this.engine;
      if (!e) return { total: 0, air: 0, gnd: 0, conflict: 0, req: 0, emerg: 0 };
      const c = e.counts();
      let req = 0, emerg = 0;
      for (const a of e.aircraft) {
        if (a.requests.some(r => r.answeredAt == null) && e.time >= a.standbyUntil) req++;
        if (a.emergency && a.emergency.status !== 'resolved') emerg++;
      }
      return { total: c.total, air: c.air, gnd: c.gnd, conflict: c.conf, req, emerg };
    });
  }
  /** Open pilot requests (oldest first), STANDBY-suppressed ones excluded. */
  requests(): PilotRequest[] {
    return this.cached('requests', () => {
      const e = this.engine; if (!e) return [];
      const out: PilotRequest[] = [];
      for (const a of e.aircraft) { if (e.time < a.standbyUntil) continue; for (const r of a.requests) if (r.answeredAt == null) out.push(r); }
      return out.sort((x, y) => x.at - y.at);
    });
  }
  wakeTimers(): Record<string, { runway: string; leader: string; remainingS: number }> { return this.cached('wake', () => this.engine ? this.engine.wakeTimers() : {}); }
  events(): SimEvent[] { return this.eventLog; }
  clearEvents(): void { this.eventLog = []; }
  /** Active alerts involving a callsign. */
  alertsFor(cs: string): Alert[] { return this.alerts().filter(a => a.subjects.includes(cs)); }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Render hooks (canvas views register; test API + panels use)
  // ═══════════════════════════════════════════════════════════════════════════
  registerProjector(kind: ProjectorKind, fn: (xy: XY) => { x: number; y: number } | null, centerOn: (xy: XY) => void, camera: () => CameraView | null, extras: ProjectorExtras = {}): () => void {
    const p: Projector = { fn, centerOn, camera, extras };
    this.projectors[kind] = p;
    this.emit();
    return () => {
      if (this.projectors[kind] === p) {
        delete this.projectors[kind];
        if (kind === 'ground') this.mapReady = false;
        this.emit();
      }
    };
  }
  /** The projector for the active view (radar on APPROACH, ground otherwise; falls back to whichever is mounted). */
  private activeProjector(): Projector | null {
    const want: ProjectorKind = this.position === 'approach' ? 'radar' : 'ground';
    return this.projectors[want] ?? this.projectors[want === 'radar' ? 'ground' : 'radar'] ?? null;
  }
  activeView(): ProjectorKind | null {
    const want: ProjectorKind = this.position === 'approach' ? 'radar' : 'ground';
    if (this.projectors[want]) return want;
    return this.projectors.radar ? 'radar' : this.projectors.ground ? 'ground' : null;
  }
  screenProject(xy: XY): { x: number; y: number } | null {
    const p = this.activeProjector(); if (!p) return null;
    try { return p.fn(xy); } catch { return null; }
  }
  screenPos(id: number): { x: number; y: number } | null {
    const a = this.engine?.byId(id); if (!a) return null;
    return this.screenProject(a.pos);
  }
  centerOnXY(xy: XY): void {
    const p = this.activeProjector(); if (!p) return;
    try { p.centerOn(xy); } catch { /* view not ready */ }
  }
  centerOn(id: number): void {
    const a = this.engine?.byId(id); if (!a) return;
    this.centerOnXY(a.pos);
  }
  camera(): CameraView | null {
    const p = this.activeProjector(); if (!p) return null;
    try { return p.camera(); } catch { return null; }
  }
  setCamera(cam: CameraView): void {
    const p = this.activeProjector(); if (!p) return;
    try {
      if (p.extras.setCamera) { p.extras.setCamera(cam); return; }
      if ('lng' in cam) { if (this.engine) p.centerOn(this.engine.proj.toXY(cam.lat, cam.lng)); }
      else p.centerOn({ x: cam.x, y: cam.y });
    } catch { /* view not ready */ }
  }
  /** True when a CSS point relative to the active canvas actually hits the canvas (not a floating panel / toolbar) — emptySpot(). */
  spotFree(x: number, y: number): boolean {
    if (!isBrowser() || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return true;
    const kind = this.activeView();
    const el = document.querySelector<HTMLElement>(kind === 'radar' ? '[data-testid="radar-canvas"]' : '[data-testid="ground-map"]');
    if (!el) return true;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + x, r.top + y);
    return !!hit && hit.tagName === 'CANVAS';
  }
  /** CSS size of the active canvas (registered getter, else DOM lookup by testid). */
  viewSize(): { w: number; h: number } | null {
    const p = this.activeProjector();
    try {
      const s = p?.extras.size?.(); if (s && s.w > 0 && s.h > 0) return s;
    } catch { /* ignore */ }
    if (!isBrowser() || typeof document === 'undefined') return null;
    const kind = this.activeView();
    const el = document.querySelector<HTMLElement>(kind === 'radar' ? '[data-testid="radar-canvas"]' : '[data-testid="ground-map"]')
      ?? document.querySelector<HTMLElement>('[data-testid="radar-canvas"], [data-testid="ground-map"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null;
  }
}

function emptyStats(): SessionStats {
  return {
    startedAt: 0, simTime: 0, score: 0, skill: 0, points: 0, movements: 0, departures: 0, arrivals: 0, movementsPerHour: 0, movementsHistory: [],
    delayAvgS: 0, delayP95S: 0, delaySamples: [], incidents: {}, ledger: [], goAroundsPlayer: 0, goAroundsPilot: 0, diversions: 0,
    emergenciesDeclared: 0, emergenciesResolved: 0, arffResponseS: [], transmissions: 0, responsivenessMeanS: 0, unansweredRequests: 0, streakS: 0,
  };
}
function readbackStatus(s: string): RadioLine['status'] {
  switch (s) { case 'unable': return 'unable'; case 'partial': return 'partial'; case 'mismatch': return 'mismatch'; default: return 'ok'; }
}

export type { SimStore };

// ──────────────────────────────────────────────────────────────────────────────
//  Singleton (HMR-safe) on window.__atcSim
// ──────────────────────────────────────────────────────────────────────────────
declare global {
  interface Window { __atcSim?: SimStore }
}
export const sim: SimStore = (() => {
  if (typeof window !== 'undefined') {
    const w = window as Window;
    if (!w.__atcSim) w.__atcSim = new SimStore();
    return w.__atcSim;
  }
  return new SimStore();
})();

// ──────────────────────────────────────────────────────────────────────────────
//  React hooks
// ──────────────────────────────────────────────────────────────────────────────
function depsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/**
 * Subscribe to the store with a selector. Re-evaluates the selector only when
 * `sim.version` (or `deps`) changes; the result is kept identity-stable when it
 * is shallow-equal to the previous one, so plain object/array selectors are safe.
 */
export function useSim<T>(selector: (s: SimStore) => T, deps: readonly unknown[] = []): T {
  const ref = useRef<{ v: number; deps: readonly unknown[]; value: T } | null>(null);
  const read = () => {
    const v = sim.version;
    const c = ref.current;
    if (c && c.v === v && depsEqual(c.deps, deps)) return c.value;
    const next = selector(sim);
    const value = c && shallowEqual(c.value, next) ? c.value : next;
    ref.current = { v, deps, value };
    return value;
  };
  return useSyncExternalStore(sim.subscribe, read, read);
}

/** The bare version counter (re-render on every emit). */
export function useSimVersion(): number {
  return useSyncExternalStore(sim.subscribe, () => sim.version, () => 0);
}

// ──────────────────────────────────────────────────────────────────────────────
//  Geometry helpers kept for the canvas views
// ──────────────────────────────────────────────────────────────────────────────
/** Glideslope intercept distance (NM from threshold) for an altitude on a gs°. */
export function gsInterceptNM(altFt: number, gsDeg: number, thrElevFt = 0): number {
  return (altFt - thrElevFt) / (Math.tan(gsDeg * DEG) * 6076);
}
export { headingTo, advance, NM };

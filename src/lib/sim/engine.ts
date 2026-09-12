// ============================================================
//  SimEngine — owns aircraft, runways, stands, the fixed-timestep loop,
//  spawning, drivable paths with hold-short PLACES, ground traffic rules,
//  separation / incursion detection, ILS + landing-clearance logic, the
//  pilot-delay command queue (EngineCommandApi), pilot requests, readbacks,
//  scoring, and the hooks into the systems modules (weather, vehicles,
//  emergencies, alerts, phraseology).
//
//  Pure TypeScript: no DOM, no React. All randomness via rng.ts.
//  Master plan §2.2 / 06-CONTRACTS §7 are the binding contracts.
// ============================================================
import {
  LocalProjection, XY, dist, headingTo, advance, chaikin, angleDelta,
  dedupeBacktracks, arcLengths, resample, distToSegment, projectOntoPath, alongTrack, crossTrack, sampleAlong,
  segmentIntersection, NM_TO_M, FT_TO_M, KTS_TO_MPS,
} from './projection';
import { OsmAirport, OsmRunway, OsmRunwayEnd, OsmStand, findPath, routeVia as osmRouteVia, taxiwaysForPath, holdsOnPath, isHoldNodeForRunway as osmIsHoldNode, holdForRunwayEntry } from '../osmAirport';
import { getPerformance, randomCommercialTypeOf, spokenTypeOf, v1Kt, WeightClass } from './aircraftDB';
import {
  AircraftState, DrivePath, PathHold, SimEvent, SimEventType, SimEventData, FlightKind, FlightPhase, PendingCmd, PendingCondition,
  PilotRequest, PilotRequestKind, Position, PlayerPosition, POSITION_OWNER, NEXT_POSITION, RunwayState, RunwayStatus, RunwayOccupant,
  RunwayOccupantKind, GateState, SessionStats, ScoreCode, ScoreEvent, SCORE_TABLE, emptySessionStats, Stage, WakeCategory,
  WAKE_DEPARTURE_S, WAKE_FINAL_NM, WAKE_CATEGORY_BY_CLASS, newAircraftFields, Emergency, EmergencyType, ReadbackStatus,
  VehicleTarget, VehicleType, WeatherState, Vehicle, Alert, defaultPushback, defaultStartup, EVENT_WHO,
} from './types';
import { stepAircraft, isAirborne, StepCtx, HOLD_BUFFER_M, DEP_TURN_FT, TAXI_DECEL, EMERG_DECEL, takeoffAccelKts, approachVal } from './aircraft';
import { ILSRunway, canCaptureLoc, overshootsLoc, locTargetHdg, gsAltFt, gsDistM, distAlongFwd, aboveGlideslope, ilsFromGeometry, ILS_CONST } from './ils';
import { rng, rnd, ri, rf, chance, subStream } from './rng';
import { stage as deriveStage, StageCtx, distToThresholdFromPathNM } from './stage';
import type {
  CommandAST, EngineOutcome, CommandResult, TaxiDest, HoldShortTarget, PushDir, TurnDir, ExitSpec, ExpediteScope, ContactWhen,
  ApproachType, CorrectionField, UnableReason, ReportKind, EmergencyInfoKind, HoldAllScope, ResultCode,
} from './commandAst';
import { describe, IMMEDIATE_KINDS, makeAst } from './commandAst';
import type { EngineCommandApi } from './dispatch';
import { SILENT_CODES } from './dispatch';
import { WeatherModel, defaultWeather, windComponents, applyWind } from './weather';
import { VehicleFleet, defaultStations, VehicleStepCtx, VehicleStations } from './vehicles';
import { AlertEngine, AlertStepCtx } from './alerts';
import {
  EMERGENCY_CATALOGUE, EmergencyEngineView, EmergencySetting, createEmergency, maybeDeclare, onDeclared, stepEmergency,
  handleLanded, completeChecklistItem, scoreOnResolved, ackReplyLine, SOULS_BY_CLASS,
} from './emergencies';
import { PhraseCtx, telephony as telephonyOf, readback as phraseReadback, pilotRequestLine } from './phraseology';
import type { RunwayEnd } from '../runwayManifest';
import type { AircraftView, SpawnSpec } from './testApi';

// ──────────────────────────────────────────────────────────────────────────────
//  Constants (03 §8 / §H, 06 §7)
// ──────────────────────────────────────────────────────────────────────────────
export const FIXED = 1 / 30;
export const MAX_SUBSTEPS = 6;
const VERT_SEP_FT = 1000, HORIZ_SEP_NM = 3, REDUCED_FINAL_NM = 2.5;
const FT_PER_M = 1 / FT_TO_M;
/** Landing phase begins (approach path built) inside this distance once established. */
const LANDING_PHASE_NM = 8;
/** Arrival auto-handoff APP -> TWR when established (03 §3.14). */
const TOWER_HANDOFF_NM = 10;
/** Forced go-around table (03 §B1) + the engine brief (no clearance at 2 NM). */
export const FORCED_GA = { noClearanceNM: 2.0, noClearanceFt: 300, occupiedNM: 1.0, crossingNM: 0.7, precedingNM: 0.5, closedNM: 3.0 } as const;
/** 4 NM: pilot "confirm cleared to land?" query. */
const CONFIRM_CLEARED_NM = 4;
/** Runway geometry: physical strip half-width (on the runway) and hold-line distance from the centreline. */
const STRIP_HALF_M = 45, HOLD_LINE_M = 90;
/** Line-up: stop this far past the entry point along the runway. */
const LINEUP_ADVANCE_M = 50;
const MISSED_APPROACH_ALT_FT = 3000;
const LUAW_QUERY_S = 90;
const READBACK_MISMATCH_WINDOW_S = 15;
const INCIDENT_DEDUPE_S = 60;
const EVENT_RING = 500;

const AIRLINES = [
  { icao: 'BAW', iata: 'BA', name: 'British Airways' }, { icao: 'UAL', iata: 'UA', name: 'United' },
  { icao: 'AAL', iata: 'AA', name: 'American' }, { icao: 'DAL', iata: 'DL', name: 'Delta' },
  { icao: 'DLH', iata: 'LH', name: 'Lufthansa' }, { icao: 'AFR', iata: 'AF', name: 'Air France' },
  { icao: 'KLM', iata: 'KL', name: 'KLM' }, { icao: 'UAE', iata: 'EK', name: 'Emirates' },
  { icao: 'QTR', iata: 'QR', name: 'Qatar' }, { icao: 'SIA', iata: 'SQ', name: 'Singapore' },
  { icao: 'CPA', iata: 'CX', name: 'Cathay Pacific' }, { icao: 'QFA', iata: 'QF', name: 'Qantas' },
  { icao: 'SWR', iata: 'LX', name: 'Swiss' }, { icao: 'EIN', iata: 'EI', name: 'Aer Lingus' },
];
const CITIES = ['MUC', 'FRA', 'CDG', 'AMS', 'MAD', 'DXB', 'SIN', 'HKG', 'JFK', 'LAX', 'ORD', 'DEL', 'SYD', 'NRT', 'GVA', 'VIE', 'LIS', 'DUB', 'ZRH', 'IST'];
const DEFAULT_FREQ: Record<Position, string> = { ground: '121.900', tower: '118.500', departure: '125.200', approach: '119.700', external: '127.100' };

export type AirportData = OsmAirport;

export interface AirspaceEntry { x?: number; y?: number; heading: number; altFt: number; beacon?: string; weight: number }

export interface AirspaceConfig {
  radiusM: number;
  ilsRunways: ILSRunway[];
  beacons: Array<{ id: string; x: number; y: number }>;
  /** Airspace centre in engine XY (B3). Default {0,0} = OSM airport centre. */
  centerXY?: XY;
  /** Boundary entry points (weighted); positions computed from centre+radius when x/y absent. */
  entries?: AirspaceEntry[];
  magVar?: number;
  transitionAltFt?: number;
  airportName?: string;
  frequencies?: Partial<Record<Position, string>>;
  missedApproachAltFt?: number;
}

export interface EngineSettings {
  /** AI tower assist: routine clearances 8 s after they become valid (UX §G5.10). */
  autoTower: boolean;
  /** Auto taxi-in after vacating (set-auto-taxi-in). */
  autoGround: boolean;
  /** Auto-handoff at 1000 ft AGL / 10 NM established. */
  autoHandoff: boolean;
  emergencyRate: EmergencySetting;
  /** Wrong-readback probability (0 / 0.02 / 0.05). */
  pilotErrorRate: number;
  strictFrequencies: boolean;
  arcadeIntercept: boolean;
  reducedFinalSep: boolean;
  region: 'ICAO' | 'FAA';
  /** Test hook: fixed pilot delay in s (null = realistic 2-4 s air / 4-8 s ground). */
  pilotDelayOverride: number | null;
  /** Despawn parked arrivals after 120-300 s. */
  despawnParked: boolean;
}

interface ExitPlan { runwayNodeId: string; twyNodeId: string; at: number; speedKt: number; taxiway: string | null; angleDeg: number }
interface RunwayExit { runwayNodeId: string; twyNodeId: string; xy: XY; taxiway: string | null }

/** Private per-aircraft timers/scratch (not part of AircraftState). */
interface Scratch {
  nextRequestAt: number | null;
  nextRequestKind: PilotRequestKind | null;
  rollAt: number | null;
  handoffAt: number | null;
  handoffTo: Position | null;
  exitPlan: ExitPlan | null;
  taxiDest: TaxiDest | null;
  crossingRef: string | null;
  onRunwayRef: string | null;
  luawAt: number | null;
  gaAt: number | null;
  stoppedSince: number | null;
  continueApproach: boolean;
  queried4NM: boolean;
  vacated: boolean;
  passedFixes: Set<string>;
  lastStage: Stage | null;
  emergNoticeAt: number;
  crosswindChecked: boolean;
  despawnAt: number | null;
  rtoRecoverAt: number | null;
  lastLevelAt: number;
  overshootSaid: boolean;
  arffDispatchedAt: number | null;
  handoffLateScored: boolean;
  wakeWarned: Set<number>;
  entryKey: string | null;
  touchdownDone: boolean;
  /** Crossing bookkeeping: has the aircraft physically entered the strip since the cross clearance; closest approach so far (m). */
  crossingEntered: boolean;
  crossingMinD: number;
  /** Arrival has been inside the airspace boundary at least once (retire logic ignores queued spawns still inbound). */
  enteredAirspace: boolean;
}
function newScratch(): Scratch {
  return {
    nextRequestAt: null, nextRequestKind: null, rollAt: null, handoffAt: null, handoffTo: null, exitPlan: null, taxiDest: null,
    crossingRef: null, onRunwayRef: null, luawAt: null, gaAt: null, stoppedSince: null, continueApproach: false, queried4NM: false,
    vacated: false, passedFixes: new Set(), lastStage: null, emergNoticeAt: 0, crosswindChecked: false, despawnAt: null, rtoRecoverAt: null,
    lastLevelAt: 0, overshootSaid: false, arffDispatchedAt: null, handoffLateScored: false, wakeWarned: new Set(), entryKey: null, touchdownDone: false,
    crossingEntered: false, crossingMinD: Infinity, enteredAirspace: false,
  };
}

interface ScheduledReadback { at: number; aircraftId: number; status: ReadbackStatus; text: string; ast: CommandAST | null; refused: string[]; mismatch: { field: string; expected: string; read: string } | null }

const OK: EngineOutcome = { ok: true, code: 'ok', applied: true };
const isNotImpl = (e: unknown) => e instanceof Error && /not implemented|not initialised|not initialized/i.test(e.message);
const upper = (s: string) => s.toUpperCase();
const hdg3 = (h: number) => String(((Math.round(h) % 360) + 360) % 360 || 360).padStart(3, '0');
const NUMERIC_KINDS = new Set<string>(['heading', 'altitude', 'speed']);
const SURFACE_FACTOR: Record<WeatherState['runwayCondition'], number> = { dry: 1, wet: 0.65, contaminated: 0.4 };

// ──────────────────────────────────────────────────────────────────────────────
//  The engine
// ──────────────────────────────────────────────────────────────────────────────
export class SimEngine implements EngineCommandApi, StageCtx {
  readonly air: AirportData;
  readonly proj: LocalProjection;
  aircraft: AircraftState[] = [];
  time = 0;
  paused = false;
  /** Position tab the player is working (strict-frequency policy). */
  playerPosition: PlayerPosition = 'tower';
  settings: EngineSettings = {
    autoTower: false, autoGround: false, autoHandoff: true, emergencyRate: 'normal', pilotErrorRate: 0.02,
    strictFrequencies: false, arcadeIntercept: false, reducedFinalSep: true, region: 'ICAO', pilotDelayOverride: null, despawnParked: true,
  };
  stats: SessionStats = emptySessionStats(0);
  /** Systems owned by the engine (06 §2). */
  readonly weather = new WeatherModel();
  readonly fleet = new VehicleFleet();
  readonly alerts = new AlertEngine();
  /** Per-END runway state (both ends of a physical runway share status / occupants). */
  runways: RunwayState[] = [];
  gates: GateState[] = [];
  /** Airspace centre in engine XY (B3). */
  centerXY: XY = { x: 0, y: 0 };
  airspaceRadiusM = 30 * NM_TO_M;
  ilsRunways: ILSRunway[] = [];
  beacons: Array<{ id: string; x: number; y: number }> = [];
  entries: Array<Required<Pick<AirspaceEntry, 'x' | 'y' | 'heading' | 'altFt' | 'weight'>> & { beacon?: string; key: string }> = [];
  magVar = 0;
  transitionAltFt = 6000;
  airportName: string;
  frequencies: Record<Position, string> = { ...DEFAULT_FREQ };
  missedApproachAltFt = MISSED_APPROACH_ALT_FT;
  /** Ring buffer of the last 500 events (test API). */
  events: SimEvent[] = [];
  /** Current runway-config suggestion from the weather model (UI "Change runway" prompt), null = current config is best. */
  suggestedRunways: { dep: string[]; arr: string[]; reason: string } | null = null;
  /** Emergency "hold all traffic" order (R24). */
  holdAllActive: { scope: HoldAllScope; runway: string | null } | null = null;

  private acc = 0;
  private idc = 0;
  private pendingEvents: SimEvent[] = [];
  private conflictPairs = new Set<string>();
  private xyCache = new Map<string, XY>();
  private grid = new Map<string, string[]>();
  private readonly GRID = 150;
  private scratch = new Map<number, Scratch>();
  private readbacks: ScheduledReadback[] = [];
  private lastSecond = -1;
  private frameEvents: SimEvent[] = [];
  private incidentLog = new Map<string, number>();
  private entryLast = new Map<string, { at: number; id: number }>();
  private sys = { weather: true, fleet: true, alerts: true, emergencies: true, phrase: true };
  private wxRng = subStream('weather');
  private emergRng = subStream('emergencies');
  private lastSuggestionKey = '';
  /** Physical runway -> centreline node ids / hold nodes / exits. */
  private runwayNodes = new Map<string, Set<string>>();
  private holdNodes = new Map<string, Set<string>>();
  private holdNodeInfo = new Map<string, { ref: string; runwayNodeId: string }>();
  private exitsCache = new Map<string, RunwayExit[]>();
  private squawkPool = new Set<string>();
  private lastRunwayCheck = 0;

  constructor(air: OsmAirport) {
    this.air = air as AirportData;
    this.proj = new LocalProjection(air.center.lat, air.center.lng);
    this.airportName = air.icao;
    this.settings.region = /^K/.test(air.icao) ? 'FAA' : 'ICAO';
    this.buildGrid();
    this.buildRunways();
    this.buildGates();
    this.initSystems();
  }

  // ── legacy accessors (simStore / tests) ─────────────────────────────────────
  get score(): number { return this.stats.points; }
  set score(v: number) { this.stats.points = v; }
  get skill(): number { return this.stats.skill; }
  set skill(v: number) { this.stats.skill = Math.max(0, Math.min(12, v)); }
  get autoTower(): boolean { return this.settings.autoTower; }
  set autoTower(v: boolean) { this.settings.autoTower = v; }
  get autoGround(): boolean { return this.settings.autoGround; }
  set autoGround(v: boolean) { this.settings.autoGround = v; }

  // ── configuration ───────────────────────────────────────────────────────────
  setAirspaceConfig(cfg: AirspaceConfig) {
    this.airspaceRadiusM = cfg.radiusM;
    this.ilsRunways = cfg.ilsRunways.map(r => ({ ...r }));
    this.beacons = cfg.beacons;
    this.centerXY = cfg.centerXY ? { ...cfg.centerXY } : { x: 0, y: 0 };
    this.magVar = cfg.magVar ?? 0;
    this.transitionAltFt = cfg.transitionAltFt ?? 6000;
    if (cfg.airportName) this.airportName = cfg.airportName;
    if (cfg.frequencies) this.frequencies = { ...this.frequencies, ...cfg.frequencies };
    this.missedApproachAltFt = cfg.missedApproachAltFt ?? MISSED_APPROACH_ALT_FT;
    this.entries = (cfg.entries ?? []).map(e => {
      const p = e.x != null && e.y != null ? { x: e.x, y: e.y } : advance(this.centerXY, (e.heading + 180) % 360, this.airspaceRadiusM);
      return { x: p.x, y: p.y, heading: e.heading, altFt: e.altFt, weight: e.weight, beacon: e.beacon, key: `${e.heading}|${e.beacon ?? ''}` };
    });
    for (const rs of this.runways) {
      const ils = this.ilsRunways.find(r => r.name === rs.name);
      rs.hasIls = true; rs.ilsEstimated = !ils || !!ils.estimated;
    }
  }

  /** Restrict active ends (home-page runway config). Pass null/empty to activate every end for both roles. */
  setActiveRunwayEnds(ends: string[] | null) {
    const set = ends && ends.length ? new Set(ends.map(upper)) : null;
    for (const rs of this.runways) { rs.activeDep = !set || set.has(rs.name); rs.activeArr = rs.activeDep; }
    this.regenAtis('runway change');
  }
  /** Explicit dep/arr split (runway-change dialog / weather suggestion applied). */
  setActiveRunways(dep: string[], arr: string[]) {
    const d = new Set(dep.map(upper)), a = new Set(arr.map(upper));
    for (const rs of this.runways) { rs.activeDep = d.has(rs.name); rs.activeArr = a.has(rs.name); }
    this.suggestedRunways = null; this.lastSuggestionKey = '';
    this.regenAtis('runway change');
    this.emit('info', null, `Runway change: departures ${dep.join('/') || '-'}, arrivals ${arr.join('/') || '-'}`);
  }
  activeEnds(role: 'dep' | 'arr'): RunwayState[] { return this.runways.filter(r => (role === 'dep' ? r.activeDep : r.activeArr)); }
  private endActive(name: string, role: 'dep' | 'arr' = 'dep'): boolean {
    const rs = this.runwayState(name); if (!rs) return false;
    return role === 'dep' ? rs.activeDep : rs.activeArr;
  }

  /** Per-runway-end allowed weight classes. Pass null to allow every class everywhere. */
  setRunwayWeightAllow(map: Record<string, WeightClass[]> | null) {
    for (const rs of this.runways) rs.weightAllow = null;
    if (!map) return;
    for (const [k, v] of Object.entries(map)) { const rs = this.runwayState(k); if (rs) rs.weightAllow = [...v]; }
  }
  private weightsFor(endName: string): Set<WeightClass> | null {
    const w = this.runwayState(endName)?.weightAllow;
    return w && w.length ? new Set(w) : null;
  }
  weightAllowed(endName: string, wc: WeightClass): boolean { const w = this.weightsFor(endName); return !w || w.has(wc); }

  // ── geometry ───────────────────────────────────────────────────────────────
  nodeXY(nodeId: string): XY | null {
    const c = this.xyCache.get(nodeId);
    if (c) return c;
    const n = this.air.nodes.get(nodeId);
    if (!n) return null;
    const xy = this.proj.toXY(n.lat, n.lng);
    this.xyCache.set(nodeId, xy);
    return xy;
  }
  endXY(e: { lat: number; lng: number }): XY { return this.proj.toXY(e.lat, e.lng); }
  private gridKey(x: number, y: number) { return `${Math.floor(x / this.GRID)},${Math.floor(y / this.GRID)}`; }
  private buildGrid() {
    for (const id of this.air.nodes.keys()) {
      const xy = this.nodeXY(id)!;
      const k = this.gridKey(xy.x, xy.y);
      const cell = this.grid.get(k); if (cell) cell.push(id); else this.grid.set(k, [id]);
    }
  }
  /** Nearest graph node to a point (spatial grid, B17). */
  nearestNodeId(p: XY, maxM = 1500): string | null {
    const cx = Math.floor(p.x / this.GRID), cy = Math.floor(p.y / this.GRID);
    let best: string | null = null, bestD = maxM * maxM;
    const maxR = Math.ceil(maxM / this.GRID);
    for (let r = 0; r <= maxR; r++) {
      let found = false;
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cell = this.grid.get(`${cx + dx},${cy + dy}`); if (!cell) continue;
        for (const id of cell) { const xy = this.nodeXY(id)!; const d = (xy.x - p.x) ** 2 + (xy.y - p.y) ** 2; if (d < bestD) { bestD = d; best = id; found = true; } }
      }
      if (best && r >= 1 && bestD <= ((r - 1) * this.GRID) ** 2) break;
      if (found && r >= 1) break;
    }
    return best;
  }

  runwayByEnd(endName: string): { rw: OsmRunway; end: OsmRunwayEnd; other: OsmRunwayEnd } | null {
    const u = upper(endName);
    for (const rw of this.air.runways) {
      const e = rw.ends.find(x => upper(x.name) === u);
      if (e) return { rw, end: e, other: rw.ends.find(x => x !== e)! };
    }
    return null;
  }
  runwayState(endName: string): RunwayState | undefined { const u = upper(endName); return this.runways.find(r => r.name === u); }
  runwayHeading(endName: string): number { return this.runwayState(endName)?.headingTrue ?? 0; }
  /** Landing threshold XY of a runway end (ILS record when present, else the OSM displaced threshold). */
  thresholdXY(endName: string): XY | null {
    const ils = this.ilsRunways.find(r => r.name === upper(endName));
    if (ils) return ils.thrXY;
    const r = this.runwayByEnd(endName); return r ? this.proj.toXY(r.end.thr.lat, r.end.thr.lng) : null;
  }
  private runwaySegment(ref: string): { a: XY; b: XY } | null {
    const rw = this.air.runways.find(r => r.ref === ref); if (!rw) return null;
    return { a: this.endXY(rw.ends[0]), b: this.endXY(rw.ends[1]) };
  }
  /** Distance from a point to a physical runway centreline. */
  distToRunway(p: XY, ref: string): number { const s = this.runwaySegment(ref); return s ? distToSegment(p, s.a, s.b) : Infinity; }
  /** Physical runway refs whose strip contains the point. */
  runwaysAt(p: XY, halfWidth = STRIP_HALF_M): string[] { return this.air.runways.filter(rw => this.distToRunway(p, rw.ref) < halfWidth).map(rw => rw.ref); }

  private buildRunways() {
    // Orientation safety net (B2): the DATA loader orients ends by geometry; re-check so a stale file cannot flip a runway.
    for (const rw of this.air.runways) {
      const [e0, e1] = rw.ends;
      const b = headingTo(this.endXY(e0), this.endXY(e1));
      const num = parseInt(e0.name, 10);
      if (isFinite(num) && Math.abs(angleDelta(num * 10 + this.air.magVar, b)) > 90) { rw.ends = [e1, e0]; }
    }
    for (const rw of this.air.runways) {
      const seg = this.runwaySegment(rw.ref)!;
      const set = new Set<string>(rw.nodeIds ?? []);
      if (!set.size) for (const [id, n] of this.air.nodes) { if (n.edges.some(e => e.type === 'runway') && distToSegment(this.nodeXY(id)!, seg.a, seg.b) < 30) set.add(id); }
      this.runwayNodes.set(rw.ref, set);
      const holds = new Set<string>();
      for (const h of this.air.holdingPositions ?? []) {
        if (!h.runwayRefs.includes(rw.ref)) continue;
        holds.add(h.nodeId);
        if (!this.holdNodeInfo.has(h.nodeId)) {
          // runway centreline node this hold leads to: nearest runway node of the ref
          const hx = this.nodeXY(h.nodeId)!;
          let best: string | null = null, bd = Infinity;
          for (const rid of set) { const d = dist(hx, this.nodeXY(rid)!); if (d < bd) { bd = d; best = rid; } }
          if (best) this.holdNodeInfo.set(h.nodeId, { ref: rw.ref, runwayNodeId: best });
        }
      }
      // Fallback when the loader found no hold for an entry: the taxiway neighbour nearest 90 m from the centreline.
      if (!holds.size) for (const rid of set) {
        const n = this.air.nodes.get(rid)!;
        for (const e of n.edges) {
          if (e.type === 'runway' || set.has(e.to)) continue;
          let best: string | null = null, bestScore = Infinity, prev = rid, cur = e.to;
          for (let k = 0; k < 4 && cur; k++) {
            const xy = this.nodeXY(cur)!; const d = distToSegment(xy, seg.a, seg.b);
            if (d > 260) break;
            const score = Math.abs(d - HOLD_LINE_M) + (d < 40 ? 200 : 0);
            if (score < bestScore) { bestScore = score; best = cur; }
            const cn = this.air.nodes.get(cur)!;
            const next = cn.edges.filter(x => x.to !== prev && x.type !== 'runway' && !set.has(x.to));
            if (next.length !== 1) break;
            prev = cur; cur = next[0].to;
          }
          const chosen = best ?? e.to;
          holds.add(chosen);
          if (!this.holdNodeInfo.has(chosen)) this.holdNodeInfo.set(chosen, { ref: rw.ref, runwayNodeId: rid });
        }
      }
      this.holdNodes.set(rw.ref, holds);
    }
    // Intersections between physical runways (loader data, else segment intersection).
    const inter = new Map<string, string[]>();
    for (const a of this.air.runways) {
      if (a.intersects && a.intersects.length) { inter.set(a.ref, [...a.intersects]); continue; }
      for (const b of this.air.runways) {
        if (a === b) continue;
        const sa = this.runwaySegment(a.ref)!, sb = this.runwaySegment(b.ref)!;
        if (segmentIntersection(sa.a, sa.b, sb.a, sb.b)) { const l = inter.get(a.ref) ?? []; l.push(b.ref); inter.set(a.ref, l); }
      }
    }
    this.runways = [];
    for (const rw of this.air.runways) {
      const [e0, e1] = rw.ends;
      const len = rw.lengthM || dist(this.endXY(e0), this.endXY(e1));
      const occupants: RunwayOccupant[] = [];
      const allHolds = [...(this.holdNodes.get(rw.ref) ?? [])];
      const mk = (end: OsmRunwayEnd, other: OsmRunwayEnd): RunwayState => ({
        name: upper(end.name), ref: rw.ref, reciprocal: upper(other.name),
        headingTrue: headingTo(this.endXY(end), this.endXY(other)), headingMag: 0, lengthM: len,
        status: 'open', statusReason: '', statusUntil: null, surface: 'dry', activeDep: true, activeArr: true, weightAllow: null,
        occupiedBy: occupants, wakeTimer: null, landingClearances: [], takeoffClearance: null, lastDeparture: null, lastArrival: null,
        holdNodes: end.holdNodeIds && end.holdNodeIds.length ? [...end.holdNodeIds, ...allHolds.filter(h => !end.holdNodeIds.includes(h))] : allHolds,
        hasIls: false, ilsEstimated: true, intersects: inter.get(rw.ref) ?? [], windHeadKt: 0, windCrossKt: 0,
      });
      this.runways.push(mk(e0, e1), mk(e1, e0));
    }
    this.magVar = this.air.magVar ?? 0;
    for (const rs of this.runways) rs.headingMag = ((rs.headingTrue - this.magVar) % 360 + 360) % 360;
  }

  private buildGates() {
    const byRef = new Map<string, GateState>();
    const add = (ref: string, nodeId: string, needsPushback: boolean, terminal: string | undefined, closed = false) => {
      if (byRef.has(ref)) return;
      byRef.set(ref, { ref, nodeId, terminal: terminal ?? (/^[A-Z]/i.test(ref) ? ref[0].toUpperCase() : 'STANDS'), occupiedBy: null, reservedFor: null, needsPushback, closed });
    };
    for (const st of this.air.stands ?? []) add(st.ref, st.nodeId, st.type !== 'remote' || /^[0-9]/.test(st.ref), st.terminal);
    for (const g of this.air.gates) { const n = this.air.nodes.get(g.nodeId); add(g.ref, g.nodeId, /^[0-9]/.test(g.ref) || (n ? n.edges.length <= 1 : true), undefined); }
    this.gates = [...byRef.values()];
  }
  gateStates(): GateState[] { return this.gates; }
  runwayStates(): RunwayState[] { return this.runways; }
  gateByRef(ref: string): GateState | undefined { const u = upper(ref); return this.gates.find(g => g.ref.toUpperCase() === u); }
  private standOf(g: GateState): OsmStand | undefined { return this.air.stands?.find(x => x.ref === g.ref); }
  private gateXY(g: GateState): XY {
    const s = this.standOf(g);
    if (s) return this.proj.toXY(s.lat, s.lng);
    const og = this.air.gates.find(x => x.ref === g.ref);
    if (og) return this.proj.toXY(og.lat, og.lng);
    return this.nodeXY(g.nodeId) ?? { x: 0, y: 0 };
  }
  /** Nose heading of a parked aircraft (bearing of the lead-in, i.e. nose-in). */
  private standHeading(g: GateState): number {
    const s = this.standOf(g);
    if (s) return s.headingIn;
    const gx = this.gateXY(g), nx = this.nodeXY(g.nodeId);
    if (nx && dist(gx, nx) > 3) return headingTo(nx, gx);
    const n = this.air.nodes.get(g.nodeId);
    const e = n?.edges[0]; const ex = e ? this.nodeXY(e.to) : null;
    return ex && nx ? (headingTo(nx, ex) + 90) % 360 : 0;
  }

  private initSystems() {
    const ends = this.manifestEnds();
    this.safe('weather', () => this.weather.init({
      icao: this.air.icao, time: this.time, initial: null, script: [], ends,
      activeDep: this.activeEnds('dep').map(r => r.name), activeArr: this.activeEnds('arr').map(r => r.name), airportName: this.airportName,
    }, this.wxRng), undefined);
    const st = this.stationsXY();
    this.safe('fleet', () => this.fleet.init(this.air, st), undefined);
  }
  private manifestEnds(): RunwayEnd[] {
    return this.runways.map(r => { const e = this.runwayByEnd(r.name)!; return { name: r.name, hdg: r.headingTrue, thr: { lat: e.end.thr.lat, lng: e.end.thr.lng }, lengthFt: Math.round(r.lengthM / FT_TO_M) }; });
  }
  private stationsXY(): VehicleStations {
    const d = defaultStations({ x: 0, y: 0 });
    const s = this.air.stations;
    if (!s) return d;
    const conv = (p: { lng: number; lat: number } | undefined, fb: XY): XY => (p ? this.proj.toXY(p.lat, p.lng) : fb);
    return { fire: conv(s.arff, d.fire), ops: conv(s.ops, d.ops), tugPool: conv(s.tugDepot, d.tugPool), fuelFarm: conv(s.fuelFarm, d.fuelFarm), deicePad: conv(s.deice?.[0], d.deicePad), apron: conv(s.followMeBase, d.apron) };
  }
  /** Run a systems-module call; a "not implemented" stub disables that hook for the session instead of crashing the sim. */
  private safe<T>(name: keyof SimEngine['sys'], fn: () => T, fallback: T): T {
    if (!this.sys[name]) return fallback;
    try { return fn(); } catch (e) { if (isNotImpl(e)) { this.sys[name] = false; return fallback; } throw e; }
  }
  /** Which systems are live (test API `features()`). */
  systemsAvailable(): Record<'weather' | 'fleet' | 'alerts' | 'emergencies' | 'phrase', boolean> { return { ...this.sys }; }

  // ── weather accessors (stub-tolerant) ──────────────────────────────────────
  wx(): WeatherState { return this.safe('weather', () => this.weather.state(), defaultWeather(this.time)); }
  atisLetter(): string | null { return this.safe('weather', () => this.weather.atis().letter, null); }
  private regenAtis(reason: string) {
    this.safe('weather', () => {
      // weather.regenerateAtis queues the `atis` SimEvent itself ("ATIS X — reason"); emitting a second one here doubled the comm-log line.
      this.weather.regenerateAtis(reason, this.activeEnds('dep').map(r => r.name), this.activeEnds('arr').map(r => r.name), this.atisRemarks());
    }, undefined);
  }
  private atisRemarks(): string[] {
    const r: string[] = [];
    for (const rs of this.runways) if (rs.status !== 'open' && rs.name < rs.reciprocal) r.push(`Runway ${rs.ref} ${rs.status}`);
    return r;
  }
  windFor(rwyHdgTrue: number): { headKt: number; crossKt: number; crossFrom: 'L' | 'R' } {
    const w = this.wx();
    return windComponents(w.windDirTrue, w.windKt, rwyHdgTrue);
  }
  windSpoken(): { dir: number; kts: number; gust: number } { const w = this.wx(); return { dir: w.windDirTrue, kts: w.windKt, gust: w.gustKt }; }

  // ── events / lookup ────────────────────────────────────────────────────────
  emit(type: SimEventType, ac: AircraftState | null, message: string, data?: SimEventData, who?: SimEvent['who']): SimEvent {
    const ev: SimEvent = { type, id: ac?.id ?? -1, callsign: ac?.callsign ?? 'SYSTEM', message, at: this.time, data };
    if (who) ev.who = who;
    if (ac) ev.position = ac.onFrequency;
    // Position reports the pilot makes on his own (holding short, airborne, touchdown, vacated, going around) count as
    // pilot calls for the strip timer, exactly like requests and readbacks do.
    if (ac && (who ?? EVENT_WHO[type]) === 'PILOT' && type !== 'request' && type !== 'readback') ac.lastTransmissionAt = this.time;
    this.pushEvent(ev);
    return ev;
  }
  private pushEvent(ev: SimEvent) {
    this.pendingEvents.push(ev);
    this.events.push(ev);
    if (this.events.length > EVENT_RING) this.events.splice(0, this.events.length - EVENT_RING);
  }
  find(cs: string): AircraftState | undefined { const u = upper(cs); return this.aircraft.find(a => a.callsign === u || a.flightNo === u); }
  byId(id: number): AircraftState | undefined { return this.aircraft.find(a => a.id === id); }
  private sc(a: AircraftState): Scratch { let s = this.scratch.get(a.id); if (!s) { s = newScratch(); this.scratch.set(a.id, s); } return s; }
  stageOf(a: AircraftState): Stage { return deriveStage(a, this); }
  telephony(cs: string): string { return telephonyOf(cs, this.settings.region); }

  // ── StageCtx ───────────────────────────────────────────────────────────────
  distToThresholdNM(a: AircraftState, runway: string): number | null {
    if (a.phase === 'landing' && a.path) return distToThresholdFromPathNM(a);
    const thr = this.thresholdXY(runway); if (!thr) return null;
    const ils = this.ilsFor(runway);
    if (ils && a.ilsCaptured) return Math.max(0, distAlongFwd(a.pos, ils)) / NM_TO_M;
    return dist(a.pos, thr) / NM_TO_M;
  }
  isHoldNodeForRunway(nodeId: string, runway: string): boolean {
    const rs = this.runwayState(runway); if (!rs) return false;
    if (this.holdNodes.get(rs.ref)?.has(nodeId)) return true;
    return this.air.holdByNode ? osmIsHoldNode(this.air, nodeId, rs.name) : false;
  }

  counts() {
    let dep = 0, arr = 0, air = 0, gnd = 0, conf = 0;
    for (const a of this.aircraft) {
      if (a.plan.kind === 'departure') dep++; else arr++;
      if (isAirborne(a)) air++; else gnd++;
      if (a.conflict) conf++;
    }
    return { total: this.aircraft.length, dep, arr, air, gnd, conf };
  }

  // ── identity / base ────────────────────────────────────────────────────────
  private newIdentity(type?: string, allowedWeights?: Set<WeightClass> | null, callsign?: string) {
    const al = rnd(AIRLINES); const fno = 1 + ri(998);
    let cs = callsign ? upper(callsign) : `${al.icao}${fno}`;
    let guard = 0;
    while (!callsign && this.aircraft.some(a => a.callsign === cs) && guard++ < 20) cs = `${rnd(AIRLINES).icao}${1 + ri(998)}`;
    const m = cs.match(/^([A-Z]{3})(\d+)/);
    const alr = m ? AIRLINES.find(x => x.icao === m[1]) : null;
    const perf = getPerformance(type ?? randomCommercialTypeOf(allowedWeights));
    return { callsign: cs, flightNo: alr ? `${alr.iata}${m![2]}` : cs, airline: alr?.name ?? (m ? m[1] : 'GA'), perf };
  }
  private base(ident: ReturnType<SimEngine['newIdentity']>, kind: FlightKind, pos: XY, heading: number): AircraftState {
    const a: AircraftState = {
      id: ++this.idc, callsign: ident.callsign, flightNo: ident.flightNo, airline: ident.airline, perf: ident.perf,
      phase: 'parked', plan: { kind }, pos: { ...pos }, heading, speed: 0, altitude: 0,
      targetHeading: heading, targetSpeed: 0, targetAltitude: 0,
      path: null, distAlong: 0, holdReleased: false, trafficHold: false, thresholdDist: 0, takeoffCleared: false,
      navMode: 'heading',
      ilsArmed: false, ilsCaptured: false, gsCaptured: false, assignedRunway: null,
      directTargetXY: null, directTargetName: null, turnDir: null,
      holdFix: null, holdFixName: null, holdInboundHdg: 0, holdTurnDir: 'R',
      holdPhase: 'to_fix', holdTimer: 0,
      cmdAltitude: null, cmdIas: null, expedite: false,
      pendingCmds: [], underControl: false, attention: false,
      route: [], routeIndex: 0, holdingShort: false,
      trail: [{ ...pos }], spawnedAt: this.time,
      ...newAircraftFields(ident.perf.weightClass, this.time),
    };
    a.squawk = this.newSquawk();
    a.clearance.squawk = a.squawk;
    return a;
  }
  private newSquawk(): string {
    for (let i = 0; i < 20; i++) {
      const code = [ri(8), ri(8), ri(8), ri(8)].join('');
      if (/^(7500|7600|7700|1200|2000|0000|1000|1202|7000|7001|7400|7777)$/.test(code) || code.endsWith('00') || this.squawkPool.has(code)) continue;
      this.squawkPool.add(code); return code;
    }
    return '4' + String(ri(700) + 100);
  }

  // ── stands ─────────────────────────────────────────────────────────────────
  /** A stand that is free (not occupied, not reserved, not closed) and has no aircraft parked within 45 m. */
  private freeStand(opts: { prefer?: string | null; needsPushback?: boolean } = {}): GateState | null {
    if (opts.prefer) { const g = this.gateByRef(opts.prefer); if (g && !g.closed && g.occupiedBy == null && g.reservedFor == null) return g; }
    const cands = this.gates.filter(g => !g.closed && g.occupiedBy == null && g.reservedFor == null && (opts.needsPushback == null || g.needsPushback === opts.needsPushback));
    if (!cands.length) return null;
    for (let tries = 0; tries < 12; tries++) {
      const g = rnd(cands);
      const xy = this.gateXY(g);
      if (!this.aircraft.some(a => !isAirborne(a) && dist(a.pos, xy) < 45)) return g;
    }
    return null;
  }
  private reserveStand(g: GateState, a: AircraftState) { g.reservedFor = a.id; a.reservedStand = g.ref; a.plan.gateRef = g.ref; }
  private occupyStand(g: GateState, a: AircraftState) { g.occupiedBy = a.id; g.reservedFor = null; a.reservedStand = g.ref; a.plan.gateRef = g.ref; }
  private releaseStands(a: AircraftState) { for (const g of this.gates) { if (g.occupiedBy === a.id) g.occupiedBy = null; if (g.reservedFor === a.id) g.reservedFor = null; } }
  standOccupant(ref: string): string | null {
    const g = this.gateByRef(ref); if (!g) return null;
    const id = g.occupiedBy ?? g.reservedFor; if (id == null) return null;
    return this.byId(id)?.callsign ?? null;
  }

  // ── spawning ───────────────────────────────────────────────────────────────
  /** Departure spawned PARKED at a reserved stand (master plan §2.2). `atHold` = sandbox "+DEP at hold". */
  spawnDeparture(opts: { atHold?: boolean; type?: string; callsign?: string; stand?: string; runway?: string } = {}): AircraftState | null {
    if (!this.gates.length || !this.air.runways.length) return null;
    const active = this.activeEnds('dep').filter(r => r.status === 'open');
    const endName = opts.runway ? upper(opts.runway) : active.length ? rnd(active).name : rnd(this.runways).name;
    const ident = this.newIdentity(opts.type, this.weightsFor(endName), opts.callsign);
    const gate = this.freeStand({ prefer: opts.stand ?? null }); if (!gate) return null;
    const pos = this.gateXY(gate);
    const a = this.base(ident, 'departure', pos, this.standHeading(gate));
    this.occupyStand(gate, a);
    a.needsPushback = gate.needsPushback;
    a.plan.runway = endName;
    a.plan.fix = this.beacons.length > 0 ? rnd(this.beacons).id : rnd(CITIES);
    a.plan.dest = rnd(CITIES);
    a.plan.cruiseAlt = 13000;
    a.plan.taxiRoute = [];
    a.onFrequency = 'ground';
    a.phase = 'parked';
    this.aircraft.push(a);
    const s = this.sc(a);
    s.nextRequestAt = this.time + rf(20, 90);
    s.nextRequestKind = a.needsPushback ? 'pushback' : 'startup';
    this.emit('spawn', a, `${a.callsign} (${a.perf.icaoCode}) stand ${gate.ref}, departure to ${a.plan.dest} via ${a.plan.fix}, runway ${endName}`);
    if (opts.atHold) this.placeAtHold(a, endName);
    return a;
  }

  /** Arrival at a weighted boundary entry with spacing/weight filtering (B11) and a reserved stand (B21). Falls back to a short final without airspace. */
  spawnArrival(opts: { type?: string; callsign?: string; entryKey?: string } = {}): AircraftState | null {
    if (!this.entries.length) return this.spawnArrivalShortFinal(opts);
    const arrEnds = this.activeEnds('arr').filter(r => r.status === 'open');
    // weight filter: the type must be allowed on at least one active arrival runway
    let allowed: Set<WeightClass> | null = null;
    if (arrEnds.length && arrEnds.some(r => r.weightAllow && r.weightAllow.length)) {
      allowed = new Set<WeightClass>();
      for (const r of arrEnds) for (const w of (r.weightAllow ?? ['L', 'M', 'H', 'S'] as WeightClass[])) allowed.add(w);
    }
    const ident = this.newIdentity(opts.type, allowed, opts.callsign);
    // weighted entry pick, avoiding an entry that had a spawn < 120 s / < 4 NM ago
    const order = this.weightedEntries();
    let entry = opts.entryKey ? this.entries.find(e => e.key === opts.entryKey) ?? order[0] : order[0];
    let pos = { x: entry.x, y: entry.y };
    for (const cand of (opts.entryKey ? [entry] : order)) {
      const last = this.entryLast.get(cand.key);
      const lastAc = last ? this.byId(last.id) : undefined;
      const tooClose = last && lastAc && isAirborne(lastAc) && (this.time - last.at < 120 || dist(lastAc.pos, { x: cand.x, y: cand.y }) < 4 * NM_TO_M);
      if (!tooClose) { entry = cand; pos = { x: cand.x, y: cand.y }; break; }
      // queue behind the previous spawn on the inbound track: radar minimum + 1 NM, or the wake minimum + 1 NM behind a heavier leader (B11: never co-located)
      const lead: WakeCategory = lastAc!.perf.b757 ? 'HEAVY' : lastAc!.wakeCategory;
      const needNM = Math.max(4, WAKE_FINAL_NM[lead][WAKE_CATEGORY_BY_CLASS[ident.perf.weightClass]] + 1);
      const along = alongTrack(lastAc!.pos, { x: cand.x, y: cand.y }, cand.heading); // + = already inside the boundary
      const gap = Math.max(0, needNM * NM_TO_M - along);
      entry = cand; pos = advance({ x: cand.x, y: cand.y }, (cand.heading + 180) % 360, gap);
    }
    const a = this.spawnArrivalAtEntry(pos, entry.heading, entry.altFt, entry.beacon, { ident, entryKey: entry.key });
    return a;
  }
  private weightedEntries() {
    const list = [...this.entries];
    const out: typeof list = [];
    while (list.length) {
      const total = list.reduce((s, e) => s + e.weight, 0);
      let pick = rng() * total; let idx = 0;
      for (let i = 0; i < list.length; i++) { pick -= list[i].weight; if (pick <= 0) { idx = i; break; } }
      out.push(list.splice(idx, 1)[0]);
    }
    return out;
  }

  /** Spawn an arrival at a boundary entry point (approach-radar style). */
  spawnArrivalAtEntry(pos: XY, heading: number, altFt: number, beacon?: string, opts: { ident?: ReturnType<SimEngine['newIdentity']>; entryKey?: string; type?: string; callsign?: string } = {}): AircraftState | null {
    if (!this.gates.length) return null;
    const ident = opts.ident ?? this.newIdentity(opts.type, null, opts.callsign);
    const a = this.base(ident, 'arrival', pos, heading);
    a.altitude = altFt; a.targetAltitude = altFt;
    a.speed = Math.min(250, a.perf.maxAirspeedTMA);
    a.targetSpeed = a.speed;
    a.phase = 'approach';
    a.plan.fix = beacon ?? rnd(CITIES);
    a.plan.dest = this.air.icao;
    a.navMode = 'heading';
    a.attention = true;
    a.cmdAltitude = altFt;
    a.onFrequency = 'approach';
    a.fuelMin = Math.round(rf(45, 120));
    const gate = this.freeStand();
    if (gate) this.reserveStand(gate, a); else a.plan.gateRef = rnd(this.gates).ref;
    // expected runway: best active arrival end for the class (nearest to the entry heading)
    const cands = this.activeEnds('arr').filter(r => r.status === 'open' && this.weightAllowed(r.name, a.perf.weightClass));
    if (cands.length) a.plan.runway = cands.reduce((best, r) => (Math.abs(angleDelta(heading, r.headingTrue)) < Math.abs(angleDelta(heading, best.headingTrue)) ? r : best)).name;
    this.aircraft.push(a);
    const s = this.sc(a);
    if (opts.entryKey) { s.entryKey = opts.entryKey; this.entryLast.set(opts.entryKey, { at: this.time, id: a.id }); }
    s.nextRequestAt = this.time + 2; s.nextRequestKind = 'with_you';
    this.emit('spawn', a, `${a.callsign} (${a.perf.icaoCode}) inbound via ${a.plan.fix}, ${Math.round(altFt)} ft, hdg ${hdg3(heading)}, stand ${a.plan.gateRef}`);
    return a;
  }

  /** Fallback (no airspace data): arrival on an 11 km final of an active end. */
  private spawnArrivalShortFinal(opts: { type?: string; callsign?: string } = {}): AircraftState | null {
    if (!this.gates.length || !this.air.runways.length) return null;
    const ends = this.activeEnds('arr').filter(r => r.status === 'open' && !this.runwayOccupied(r.name));
    const end = ends.length ? rnd(ends) : rnd(this.runways);
    const ident = this.newIdentity(opts.type, this.weightsFor(end.name), opts.callsign);
    const thr = this.thresholdXY(end.name)!;
    const start = advance(thr, (end.headingTrue + 180) % 360, 11000);
    const a = this.base(ident, 'arrival', start, end.headingTrue);
    a.plan.runway = end.name; a.plan.fix = rnd(CITIES); a.plan.dest = this.air.icao;
    const gate = this.freeStand(); if (gate) this.reserveStand(gate, a); else a.plan.gateRef = rnd(this.gates).ref;
    a.altitude = 2000; a.targetAltitude = 2000; a.speed = 180; a.targetSpeed = 180; a.phase = 'approach';
    a.onFrequency = 'tower'; a.fuelMin = Math.round(rf(45, 120));
    this.aircraft.push(a);
    this.execILS(a, end.name);
    a.ilsCaptured = true; a.gsCaptured = true;
    this.emit('spawn', a, `${a.callsign} (${a.perf.icaoCode}) 6 NM final runway ${end.name}`);
    return a;
  }

  /** Place a departure at the full-length hold node of `endName` in hold_short (sandbox / spawnAt). */
  private placeAtHold(a: AircraftState, endName: string) {
    const rs = this.runwayState(endName); const r = this.runwayByEnd(endName);
    if (!rs || !r) return;
    const thr = this.endXY(r.end);
    const holds = [...(this.holdNodes.get(rs.ref) ?? [])];
    if (!holds.length) return;
    const entry = this.air.holdByNode ? holdForRunwayEntry(this.air, rs.name, r.end.nodeId) : null;
    const holdId = entry && this.holdNodeInfo.has(entry.nodeId) ? entry.nodeId : holds.reduce((best, id) => (dist(this.nodeXY(id)!, thr) < dist(this.nodeXY(best)!, thr) ? id : best));
    const info = this.holdNodeInfo.get(holdId)!;
    const hx = this.nodeXY(holdId)!, rx = this.nodeXY(info.runwayNodeId)!;
    const back = advance(hx, headingTo(rx, hx), 60);
    const path = this.buildPath([back, hx, rx], 'taxi');
    const at = projectOntoPath(path.pts, path.cum, hx).at;
    path.holds = [{ nodeId: holdId, runway: rs.name, at, isDepartureEntry: true }];
    path.holdAt = at;
    a.path = path; a.distAlong = Math.max(0, at - HOLD_BUFFER_M); a.holdReleased = false;
    const sm = sampleAlong(path.pts, path.cum, a.distAlong);
    a.pos = { ...sm.pos }; a.heading = sm.heading;
    a.speed = 0; a.phase = 'hold_short'; a.holdShortNode = holdId; a.holdShortRunway = rs.name;
    a.plan.runway = rs.name; a.onFrequency = 'tower';
    a.startup.enginesStable = true; a.startup.startedAt = this.time - 300; a.startup.readyAt = this.time - 120;
    a.pushback.stage = 'complete';
    this.releaseStands(a); a.reservedStand = null;
    this.sc(a).stoppedSince = this.time - 60;
    this.sc(a).nextRequestAt = this.time + 3; this.sc(a).nextRequestKind = 'ready';
  }

  /** Deterministic test factory (05 §2.2 SpawnSpec). */
  spawnAt(spec: SpawnSpec): AircraftState {
    const kind = spec.kind;
    const runway = spec.runway ? upper(spec.runway) : spec.plan?.runway ? upper(spec.plan.runway) : undefined;
    const ident = this.newIdentity(spec.type, null, spec.callsign);
    let a: AircraftState;
    const ground = ['parked', 'startup', 'pushback', 'taxi', 'hold_short', 'lineup', 'takeoff', 'rollout', 'arrived'].includes(spec.phase);
    if (ground && !spec.posRel && !spec.posLL) {
      const gate = spec.gate ? this.gateByRef(spec.gate) ?? null : (!spec.taxiwayNode && ['parked', 'startup', 'pushback', 'taxi'].includes(spec.phase) ? this.freeStand() : null);
      const pos = gate ? this.gateXY(gate) : spec.taxiwayNode ? this.nodeXY(spec.taxiwayNode) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
      a = this.base(ident, kind, pos, gate ? this.standHeading(gate) : 0);
      a.synthetic = false;
      a.plan.runway = runway ?? (this.activeEnds(kind === 'departure' ? 'dep' : 'arr')[0]?.name);
      a.plan.fix = spec.plan?.fix ?? (this.beacons[0]?.id ?? rnd(CITIES));
      a.plan.cruiseAlt = spec.plan?.cruiseAlt ?? 13000;
      a.plan.dest = kind === 'arrival' ? this.air.icao : rnd(CITIES);
      this.aircraft.push(a);
      if (gate) { if (kind === 'departure' || spec.phase === 'arrived') this.occupyStand(gate, a); else this.reserveStand(gate, a); a.needsPushback = gate.needsPushback; }
      if (spec.plan?.gateRef) a.plan.gateRef = spec.plan.gateRef;
      a.onFrequency = spec.onFrequency ?? (kind === 'departure' ? 'ground' : 'ground');
      switch (spec.phase) {
        case 'parked': a.phase = 'parked'; break;
        case 'arrived': a.phase = 'arrived'; break;
        case 'startup': this.execStartup(a, a.plan.runway ?? null); break;
        case 'pushback': a.startup.enginesStable = true; a.startup.startedAt = this.time; a.startup.readyAt = this.time; this.execPushback(a, 'any', a.plan.runway ?? null, false, null); break;
        case 'taxi': {
          a.startup.enginesStable = true; a.startup.startedAt = this.time - 200; a.startup.readyAt = this.time - 60; a.pushback.stage = 'complete';
          if (gate) { const st = this.standOf(gate); const nx = this.nodeXY(st?.entryNodeId ?? gate.nodeId); if (nx) { a.pos = { ...nx }; a.heading = st ? (st.pushbackHeading + 180) % 360 : a.heading; } }
          this.releaseStands(a); a.reservedStand = null;
          a.phase = 'taxi';
          const dest = spec.taxiTo ?? runway;
          if (dest) { const g = this.gateByRef(dest); this.execTaxi(a, g ? { kind: 'stand', ref: g.ref } : { kind: 'runway', runway: upper(dest), intersection: null }, [], true, null, [], false); }
          break;
        }
        case 'hold_short': if (runway) this.placeAtHold(a, runway); break;
        case 'lineup': case 'takeoff': case 'rollout': {
          if (!runway) break;
          const rs = this.runwayState(runway)!; const thr = this.thresholdXY(runway)!;
          const p = advance(thr, rs.headingTrue, spec.phase === 'rollout' ? 600 : LINEUP_ADVANCE_M);
          a.pos = p; a.heading = rs.headingTrue; a.targetHeading = rs.headingTrue;
          a.startup.enginesStable = true; a.pushback.stage = 'complete'; a.onFrequency = spec.onFrequency ?? 'tower';
          this.releaseStands(a); a.reservedStand = null;
          if (spec.phase === 'lineup') { a.phase = 'lineup'; this.addOccupant(runway, a, 'lineup'); this.sc(a).luawAt = this.time; }
          else if (spec.phase === 'takeoff') { this.beginRoll(a, runway); a.takeoffCleared = true; }
          else { this.startRollout(a, runway, 600); a.speed = spec.speedKts ?? a.perf.approachSpeed - 5; }
          break;
        }
      }
    } else {
      let pos: XY = { x: 0, y: 0 }; let heading = spec.heading ?? 0; let alt = spec.altFt ?? 5000;
      if (spec.posRel) {
        const rs = this.runwayState(spec.posRel.fromRunway); const thr = this.thresholdXY(spec.posRel.fromRunway);
        if (rs && thr) {
          pos = advance(thr, rs.headingTrue, spec.posRel.alongNM * NM_TO_M);
          if (spec.posRel.offsetNM) pos = advance(pos, (rs.headingTrue + 90) % 360, spec.posRel.offsetNM * NM_TO_M);
          heading = spec.heading ?? rs.headingTrue; alt = spec.posRel.altFt;
        }
      } else if (spec.posLL) { pos = this.proj.toXY(spec.posLL.lat, spec.posLL.lng); alt = spec.posLL.altFt; }
      a = this.base(ident, kind, pos, heading);
      a.synthetic = false;
      a.altitude = alt; a.targetAltitude = spec.targets?.alt ?? alt; a.cmdAltitude = a.targetAltitude;
      a.speed = spec.speedKts ?? Math.min(250, a.perf.maxAirspeedTMA); a.targetSpeed = spec.targets?.ias ?? a.speed;
      if (spec.targets?.ias != null) a.cmdIas = spec.targets.ias;
      a.targetHeading = spec.targets?.hdg ?? heading;
      a.phase = spec.phase === 'go_around' ? 'go_around' : 'approach';
      if (spec.phase === 'go_around') a.goAround = true;
      a.plan.runway = runway; a.plan.fix = spec.plan?.fix ?? (this.beacons[0]?.id ?? rnd(CITIES)); a.plan.cruiseAlt = spec.plan?.cruiseAlt ?? 13000;
      a.plan.dest = kind === 'arrival' ? this.air.icao : rnd(CITIES);
      a.onFrequency = spec.onFrequency ?? (kind === 'departure' ? 'departure' : 'approach');
      a.fuelMin = kind === 'arrival' ? 90 : null;
      this.aircraft.push(a);
      if (kind === 'arrival') { const g = spec.plan?.gateRef ? this.gateByRef(spec.plan.gateRef) : this.freeStand(); if (g) this.reserveStand(g, a); }
      if (spec.plan?.gateRef) a.plan.gateRef = spec.plan.gateRef;
      if (kind === 'departure') { a.navMode = 'sid'; a.targetAltitude = spec.targets?.alt ?? Math.max(alt, a.clearance.initialAlt); }
      if (spec.ils) this.execILS(a, upper(spec.ils));
      if (spec.hold) this.execHold(a, upper(spec.hold.fix), spec.hold.inbound ?? null, spec.hold.dir ?? null, null, null, null);
      if (spec.landingCleared && a.plan.runway) { a.landingCleared = true; a.landingClearedAt = this.time; const rs = this.runwayState(a.plan.runway); if (rs) this.setLandingClearance(rs, a.callsign, true); }
      a.underControl = true; a.attention = false;
    }
    if (spec.emergency) this.declareEmergency(a, spec.emergency);
    this.emit('spawn', a, `${a.callsign} (${a.perf.icaoCode}) test spawn ${spec.phase}`);
    return a;
  }

  remove(id: number, reason: 'arrived' | 'departed' | 'diversion' | 'fuel_exhaustion' | 'collision' | 'test' = 'test') {
    const a = this.byId(id); if (!a) return;
    this.releaseStands(a);
    for (const rs of this.runways) { this.removeOccupant(rs.ref, a.id); rs.landingClearances = rs.landingClearances.filter(c => c !== a.callsign); if (rs.takeoffClearance === a.callsign) rs.takeoffClearance = null; }
    this.scratch.delete(a.id);
    this.readbacks = this.readbacks.filter(r => r.aircraftId !== a.id);
    this.aircraft = this.aircraft.filter(x => x.id !== id);
    this.emit('removed', a, `${a.callsign} removed (${reason})`, { type: 'removed', reason });
  }
  clear() {
    for (const a of [...this.aircraft]) this.remove(a.id, 'test');
    this.aircraft = []; this.conflictPairs.clear(); this.scratch.clear(); this.readbacks = [];
    for (const g of this.gates) { g.occupiedBy = null; g.reservedFor = null; }
    for (const rs of this.runways) { rs.occupiedBy.length = 0; rs.landingClearances = []; rs.takeoffClearance = null; }
    this.entryLast.clear();
  }

  // ── paths ──────────────────────────────────────────────────────────────────
  private buildPath(raw: XY[], kind: DrivePath['kind'], holdAtEnd = false): DrivePath {
    const clean = dedupeBacktracks(raw, 3);
    const uniform = resample(clean, kind === 'taxi' || kind === 'pushback' ? 8 : 30);
    const pts = kind === 'taxi' || kind === 'pushback' ? chaikin(uniform, 4) : chaikin(uniform, 3);
    const { cum, total } = arcLengths(pts);
    return { pts, cum, total, kind, holdAt: holdAtEnd ? total : undefined };
  }
  /** Build a taxi DrivePath through node ids (also used by the vehicle fleet). Holds are derived from the route. */
  pathFromNodes(ids: string[], holdAtEnd = false, from?: XY): DrivePath | null {
    const raw: XY[] = [];
    if (from) raw.push({ ...from });
    for (const id of ids) { const xy = this.nodeXY(id); if (xy) raw.push(xy); }
    if (raw.length < 2) return null;
    const path = this.buildPath(raw, 'taxi', holdAtEnd);
    path.holds = this.computeHolds(ids, path);
    path.holdAt = path.holds.length ? path.holds[0].at : (holdAtEnd ? path.total : undefined);
    return path;
  }
  /** Hold-short PLACES along a node route: one per runway entered (crossing or departure entry) — B4. Arc-lengths re-projected onto the resampled path. */
  private computeHolds(ids: string[], path: DrivePath): PathHold[] {
    const raw = holdsOnPath(this.air, ids);
    const holds: PathHold[] = [];
    let lastAt = 0;
    const scale = path.total / Math.max(1, rawLength(this.air, ids));
    for (const h of raw) {
      const xy = this.nodeXY(h.nodeId); if (!xy) continue;
      // holdsOnPath's `at` is along the raw node polyline; the resampled/smoothed path is slightly shorter, so search a window around the scaled hint
      const hint = h.at * scale;
      const pr = projectOntoPath(path.pts, path.cum, xy, Math.max(lastAt, hint - 250), 500);
      holds.push({ nodeId: h.nodeId, runway: upper(h.runway), at: pr.at, isDepartureEntry: h.isDepartureEntry });
      lastAt = pr.at;
      if (!this.holdNodeInfo.has(h.nodeId)) {
        const rs = this.runwayState(h.runway);
        if (rs) { const set = this.runwayNodes.get(rs.ref); let best: string | null = null, bd = Infinity; for (const rid of set ?? []) { const d = dist(xy, this.nodeXY(rid)!); if (d < bd) { bd = d; best = rid; } } if (best) this.holdNodeInfo.set(h.nodeId, { ref: rs.ref, runwayNodeId: best }); }
      }
    }
    holds.sort((x, y) => x.at - y.at);
    return holds;
  }
  private nearestEndName(rw: OsmRunway, p: XY): string {
    const [e0, e1] = rw.ends;
    return dist(p, this.endXY(e0)) <= dist(p, this.endXY(e1)) ? upper(e0.name) : upper(e1.name);
  }
  /** Start node for a route from the aircraft's current position: nearest node, preferring one ahead of the nose. */
  private startNodeFor(a: AircraftState): string | null {
    const near = this.nearestNodeId(a.pos, 1500); if (!near) return null;
    let best = near; let bestScore = this.scoreStart(a, near);
    const nx = this.nodeXY(near)!;
    const n = this.air.nodes.get(near)!;
    for (const e of n.edges) { const s = this.scoreStart(a, e.to); if (s < bestScore) { bestScore = s; best = e.to; } }
    void nx;
    return best;
  }
  private scoreStart(a: AircraftState, id: string): number {
    const xy = this.nodeXY(id)!; const d = dist(a.pos, xy);
    const rel = Math.abs(angleDelta(a.heading, headingTo(a.pos, xy)));
    return d + (d > 3 && rel > 100 ? 120 : 0);
  }
  private routeVia(startId: string, viaNames: string[], goalId: string): string[] | null {
    return osmRouteVia(this.air, startId, viaNames.map(upper), goalId, { avoidRunways: this.closedRunwayRefs() });
  }
  private closedRunwayRefs(): string[] { return this.runways.filter(r => r.status === 'sterile' && r.name < r.reciprocal).map(r => r.ref); }
  /** Resolve a taxi destination to a goal node. */
  private resolveTaxiGoal(dest: TaxiDest): { goalId: string; runway: string | null; stand: string | null } | { code: ResultCode; reason: string } {
    if (dest.kind === 'runway') {
      const rs = this.runwayState(dest.runway); const r = this.runwayByEnd(dest.runway);
      if (!rs || !r) return { code: 'unknown_runway', reason: `Unknown runway ${dest.runway}` };
      if (dest.intersection) {
        const tw = upper(dest.intersection);
        const nodes = this.air.taxiwayNodes.get(tw);
        const hold = [...(this.holdNodes.get(rs.ref) ?? [])].find(h => nodes?.includes(h));
        if (hold) return { goalId: this.holdNodeInfo.get(hold)!.runwayNodeId, runway: rs.name, stand: null };
      }
      return { goalId: r.end.nodeId, runway: rs.name, stand: null };
    }
    if (dest.kind === 'stand') {
      const g = this.gateByRef(dest.ref); if (!g) return { code: 'unknown_stand', reason: `Unknown stand ${dest.ref}` };
      return { goalId: g.nodeId, runway: null, stand: g.ref };
    }
    if (!this.air.nodes.has(dest.nodeId)) return { code: 'invalid_param', reason: `Unknown node ${dest.label}` };
    return { goalId: dest.nodeId, runway: null, stand: null };
  }
  /** Route + DrivePath for a taxi clearance from the aircraft's current position. */
  private planTaxi(a: AircraftState, dest: TaxiDest, via: string[]): { ids: string[]; path: DrivePath; runway: string | null; stand: string | null } | { code: ResultCode; reason: string } {
    const goal = this.resolveTaxiGoal(dest);
    if ('code' in goal) return goal;
    const startId = this.startNodeFor(a); if (!startId) return { code: 'no_route', reason: 'No route' };
    let ids: string[] | null;
    if (via.length) {
      const bad = via.find(v => !this.air.taxiwayNodes.has(upper(v)));
      if (bad) return { code: 'unknown_taxiway', reason: `No taxiway ${upper(bad)} here` };
      ids = this.routeVia(startId, via, goal.goalId);
      if (!ids) return { code: 'unable_route', reason: `Unable, ${via.map(upper).join(' ')} does not connect` };
    } else {
      ids = findPath(this.air, startId, goal.goalId, { avoidRunways: this.closedRunwayRefs() });
    }
    if (!ids || ids.length < 2) {
      if (ids && ids.length === 1 && dist(a.pos, this.nodeXY(ids[0])!) > 5) ids = [ids[0]]; else return { code: 'no_route', reason: 'No route' };
    }
    const path = this.pathFromNodes(ids, !!goal.runway, a.pos);
    if (!path) return { code: 'no_route', reason: 'No route' };
    if (goal.runway) {
      const rs = this.runwayState(goal.runway)!;
      const depHold = path.holds!.find(h => this.runwayState(h.runway)?.ref === rs.ref);
      if (depHold) { depHold.isDepartureEntry = true; depHold.runway = rs.name; for (const h of path.holds!) if (h !== depHold) h.isDepartureEntry = false; }
      else { path.holds!.push({ nodeId: ids[ids.length - 1], runway: rs.name, at: path.total, isDepartureEntry: true }); }
      path.holdAt = path.holds![0].at;
    }
    return { ids, path, runway: goal.runway, stand: goal.stand };
  }

  /** Pushback path: stand -> lead-in (reversed) -> ~35 m along the taxiway in the direction that leaves the nose facing `dir`. */
  private pushbackPath(a: AircraftState, dir: PushDir): DrivePath | null {
    const g = a.reservedStand ? this.gateByRef(a.reservedStand) : a.plan.gateRef ? this.gateByRef(a.plan.gateRef) : undefined;
    const stand = g ? this.standOf(g) : undefined;
    const raw: XY[] = [{ ...a.pos }];
    let entryId: string | null = null;
    if (stand && stand.leadInPts.length >= 2) {
      const pts = [...stand.leadInPts].reverse().map(p => this.proj.toXY(p.lat, p.lng)); // stand -> entry
      for (const p of pts) if (dist(raw[raw.length - 1], p) > 2) raw.push(p);
      entryId = stand.entryNodeId;
    } else {
      const nodeId = g?.nodeId ?? this.nearestNodeId(a.pos, 400); if (!nodeId) return null;
      const nx = this.nodeXY(nodeId)!;
      if (dist(a.pos, nx) > 3) raw.push(nx); else raw.push(advance(a.pos, (a.heading + 180) % 360, 12));
      let cur = nodeId, prev: string | null = null, hops = 0;
      while (hops++ < 3) {
        const n = this.air.nodes.get(cur)!;
        if (n.edges.length >= 3 || n.edges.some(e => e.taxiway)) break;
        const next = n.edges.find(e => e.to !== prev); if (!next) break;
        prev = cur; cur = next.to; raw.push(this.nodeXY(cur)!);
      }
      entryId = cur;
    }
    const jn = this.air.nodes.get(entryId); const jx = this.nodeXY(entryId);
    if (!jn || !jx) return null;
    if (dist(raw[raw.length - 1], jx) > 2) raw.push(jx);
    const wantFace = dir === 'N' ? 0 : dir === 'E' ? 90 : dir === 'S' ? 180 : dir === 'W' ? 270 : null;
    let pushHdg: number | null = null;
    if (wantFace != null) pushHdg = (wantFace + 180) % 360;
    else if (a.plan.runway) {
      // 'any': push away from the direction of the departure runway route so the nose faces it afterwards
      const r = this.runwayByEnd(a.plan.runway);
      const ids = r ? findPath(this.air, entryId, r.end.nodeId) : null;
      if (ids && ids.length > 1) pushHdg = (headingTo(jx, this.nodeXY(ids[1])!) + 180) % 360;
    }
    const inHdg = headingTo(raw[raw.length - 2] ?? a.pos, jx);
    let bestTo: string | null = null, bestDiff = 400;
    // Prefer a real taxiway edge at the junction; when the junction only continues as a shared lead-in lane
    // (long apron lead-ins), push along that lane rather than off the graph into the grass.
    for (const pass of [0, 1]) {
      for (const e of jn.edges) {
        if (e.type === 'runway' || (pass === 0 && e.leadIn)) continue;
        const h = headingTo(jx, this.nodeXY(e.to)!);
        if (Math.abs(angleDelta(inHdg, h)) > 150) continue; // never push back up the lead-in
        const diff = pushHdg == null ? Math.abs(angleDelta(inHdg, h)) : Math.abs(angleDelta(pushHdg, h));
        if (diff < bestDiff) { bestDiff = diff; bestTo = e.to; }
      }
      if (bestTo) break;
    }
    if (bestTo) {
      // Push ~35 m along the lane, walking through short apron segments so the aircraft ends aligned with the lane.
      let prev = entryId, cur = bestTo, acc = 0, guard = 0;
      while (guard++ < 6) {
        const px = this.nodeXY(prev)!, cx = this.nodeXY(cur)!;
        const segLen = dist(px, cx);
        if (acc + segLen >= 35) { raw.push(advance(px, headingTo(px, cx), 35 - acc)); break; }
        raw.push(cx); acc += segLen;
        const h0 = headingTo(px, cx);
        const nexts = this.air.nodes.get(cur)!.edges.filter(x => x.to !== prev && x.type !== 'runway');
        if (!nexts.length) break;
        const next = nexts.reduce((b, x) => (Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(x.to)!))) < Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(b.to)!))) ? x : b));
        if (Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(next.to)!))) > 60) break;
        prev = cur; cur = next.to;
      }
    } else raw.push(advance(jx, inHdg, 25));
    const path = this.buildPath(raw, 'pushback');
    return path.total > 5 ? path : null;
  }

  /** Runway exits of a physical runway: taxiway nodes adjacent to centreline nodes. */
  private runwayExits(ref: string): RunwayExit[] {
    const c = this.exitsCache.get(ref); if (c) return c;
    const out: RunwayExit[] = [];
    const set = this.runwayNodes.get(ref) ?? new Set<string>();
    for (const rid of set) {
      const n = this.air.nodes.get(rid)!;
      for (const e of n.edges) {
        if (e.type === 'runway' || e.leadIn || set.has(e.to)) continue;
        out.push({ runwayNodeId: rid, twyNodeId: e.to, xy: this.nodeXY(rid)!, taxiway: e.taxiway ?? this.taxiwayNameOf(e.to) });
      }
    }
    this.exitsCache.set(ref, out);
    return out;
  }
  private taxiwayNameOf(nodeId: string): string | null {
    for (const [name, ids] of this.air.taxiwayNodes) if (ids.includes(nodeId)) return name;
    return null;
  }

  // ── runway state / occupancy ───────────────────────────────────────────────
  private bothEnds(ref: string): RunwayState[] { return this.runways.filter(r => r.ref === ref); }
  private refOf(endName: string): string | null { return this.runwayState(endName)?.ref ?? null; }
  addOccupant(endName: string, a: AircraftState | { id: string | number; callsign: string }, kind: RunwayOccupantKind) {
    const rs = this.runwayState(endName); if (!rs) return;
    const ex = rs.occupiedBy.find(o => o.id === a.id);
    if (ex) { ex.kind = kind; return; }
    rs.occupiedBy.push({ id: a.id, callsign: a.callsign, kind, since: this.time });
    if (typeof a.id === 'number') this.sc(a as AircraftState).onRunwayRef = rs.ref;
  }
  removeOccupant(ref: string, id: number | string) {
    const rs = this.bothEnds(ref)[0]; if (!rs) return;
    const i = rs.occupiedBy.findIndex(o => o.id === id);
    if (i >= 0) rs.occupiedBy.splice(i, 1);
    if (typeof id === 'number') { const a = this.byId(id); if (a) { const s = this.sc(a); if (s.onRunwayRef === ref) s.onRunwayRef = null; } }
  }
  /** Occupied for landing/takeoff purposes: any occupant other than `exceptId`, or a runway that is not open (06 §7.9). */
  runwayOccupied(endName: string, exceptId?: number): boolean {
    const rs = this.runwayState(endName); if (!rs) return false;
    if (rs.status !== 'open') return true;
    return rs.occupiedBy.some(o => o.id !== exceptId) || this.safe('fleet', () => this.fleet.onRunway(rs.ref).length > 0, false);
  }
  /** Callsign / vehicle id occupying the runway (excluding `exceptId`), null if free. */
  runwayOccupant(endName: string, exceptId?: number): string | null {
    const rs = this.runwayState(endName); if (!rs) return null;
    const o = rs.occupiedBy.find(x => x.id !== exceptId); if (o) return o.callsign;
    const v = this.safe('fleet', () => this.fleet.onRunway(rs.ref)[0] ?? null, null); if (v) return v.callsign;
    return null;
  }
  /** No aircraft physically on the runway strip other than `exceptId` (B15: strip half-width, not the hold line). */
  runwayPhysicallyClear(endName: string, exceptId: number): boolean {
    const rs = this.runwayState(endName); if (!rs) return false;
    return !this.aircraft.some(ac => ac.id !== exceptId && !isAirborne(ac) && ac.phase !== 'parked' && ac.phase !== 'arrived' && this.distToRunway(ac.pos, rs.ref) < STRIP_HALF_M);
  }
  /** Nearest arrival on final to this runway (either end name) within `nm`. */
  arrivalOnFinal(endName: string, nm: number): { callsign: string; nm: number; a: AircraftState } | null {
    const rs = this.runwayState(endName); if (!rs) return null;
    let best: { callsign: string; nm: number; a: AircraftState } | null = null;
    for (const a of this.aircraft) {
      if (!isAirborne(a) || a.plan.kind !== 'arrival' && !a.ilsArmed) continue;
      const rw = a.plan.runway ?? a.assignedRunway; if (!rw || this.refOf(rw) !== rs.ref) continue;
      if (!(a.ilsCaptured || a.phase === 'landing' || a.navMode === 'visual')) continue;
      const d = this.distToThresholdNM(a, rw); if (d == null || d > nm) continue;
      if (!best || d < best.nm) best = { callsign: a.callsign, nm: d, a };
    }
    return best;
  }
  rollingDeparture(endName: string): string | null {
    const rs = this.runwayState(endName); if (!rs) return null;
    const a = this.aircraft.find(x => x.phase === 'takeoff' && x.plan.runway && this.refOf(x.plan.runway) === rs.ref);
    return a?.callsign ?? null;
  }
  wakeTimerRemainingS(endName: string, follower?: WakeCategory): number {
    const rs = this.runwayState(endName); const t = rs?.wakeTimer; if (!rs || !t) return 0;
    if (follower) { const need = WAKE_DEPARTURE_S[t.leaderCat][follower]; if (!need) return 0; return Math.max(0, t.startedAt + need - this.time); }
    return Math.max(0, t.expiresAt - this.time);
  }
  private setWakeTimer(endName: string, leader: AircraftState) {
    const rs = this.runwayState(endName); if (!rs) return;
    const cat: WakeCategory = leader.perf.b757 ? 'HEAVY' : leader.wakeCategory;
    const longest = Math.max(...Object.values(WAKE_DEPARTURE_S[cat]));
    const timer = longest > 0 ? { leader: leader.callsign, leaderCat: cat, startedAt: this.time, expiresAt: this.time + longest, ref: 'airborne' as const } : null;
    for (const r of this.bothEnds(rs.ref)) { r.wakeTimer = timer; r.lastDeparture = { callsign: leader.callsign, at: this.time, cat }; }
    if (timer) this.emit('wake', null, `Wake timer runway ${rs.name}: ${leader.callsign} (${cat}) departed, ${Math.round(longest)} s`, { type: 'wake', runway: rs.name, leader: leader.callsign, expiresAt: timer.expiresAt });
  }
  private setLandingClearance(rs: RunwayState, cs: string, on: boolean) {
    for (const r of this.bothEnds(rs.ref)) {
      r.landingClearances = r.landingClearances.filter(c => c !== cs);
      if (on) r.landingClearances.push(cs);
    }
  }
  /** Runway crossing lock (03 §D12): time to threshold of the nearest arrival > pilot delay + crossing time + 20 s, no rolling departure. */
  crossingSafe(endName: string, crossingS = 35): boolean {
    const rs = this.runwayState(endName); if (!rs) return false;
    if (rs.status === 'sterile') return false;
    if (this.rollingDeparture(endName)) return false;
    if (rs.occupiedBy.some(o => o.kind === 'lineup' || o.kind === 'takeoff' || o.kind === 'landing')) return false;
    const arr = this.arrivalOnFinal(endName, 10);
    if (!arr) return true;
    const gs = Math.max(90, arr.a.speed);
    const ttt = (arr.nm * NM_TO_M) / (gs * KTS_TO_MPS);
    return ttt > 6 + crossingS + 20;
  }
  /** Change a runway's status (both ends). Reason is free text. */
  setRunwayStatus(runway: string, status: RunwayStatus, reason: string | null): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    const prev = rs.status;
    for (const r of this.bothEnds(rs.ref)) { r.status = status; r.statusReason = reason ?? ''; r.statusUntil = null; }
    if (status === 'open') for (const r of this.bothEnds(rs.ref)) { r.occupiedBy.length = 0; }
    if (prev !== status) {
      this.emit('runway_state', null, `Runway ${rs.ref} ${status}${reason ? ` (${reason})` : ''}`, { type: 'runway_state', runway: rs.name, status, previous: prev, reason: reason ?? '' });
      this.safe('alerts', () => { if (status !== 'open') this.alerts.raise('runway_status', [rs.ref], `Runway ${rs.ref} ${status}`, reason ?? '', this.time, { runway: rs.name }); else for (const al of this.alerts.active()) if (al.kind === 'runway_status' && al.subjects[0] === rs.ref) this.alerts.resolve(al.id, this.time); }, undefined);
      this.regenAtis(`runway ${rs.ref} ${status}`);
    }
    return { ...OK, extra: { runway: rs.name, status } };
  }
  reopenRunway(runway: string, afterInspection: boolean): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (rs.status === 'open') return { ok: false, code: 'already', reason: `Runway ${rs.ref} already open` };
    // Emergency aircraft still stopped on it are towed clear
    for (const a of this.aircraft) if (a.emergency && this.sc(a).onRunwayRef === rs.ref && a.phase === 'rollout') this.remove(a.id, 'arrived');
    const out = this.setRunwayStatus(runway, 'open', afterInspection ? 'inspection complete' : 'reopened');
    for (const a of this.aircraft) if (a.emergency && a.emergency.runway && this.refOf(a.emergency.runway) === rs.ref) this.checklist(a, 'runway_reopened');
    if (afterInspection) this.addScore('INSPECTION_CLEAN', 'SYSTEM', null, rs.name, `Runway ${rs.ref} inspected and reopened`);
    return out;
  }

  // ── scoring ────────────────────────────────────────────────────────────────
  /** Ledger entry through SCORE_TABLE; one incident per (code, primary, secondary) per 60 s (03 §B2). */
  addScore(code: ScoreCode, primary: string, secondary: string | null = null, runway: string | null = null, detail = ''): ScoreEvent | null {
    const key = `${code}|${primary}|${secondary ?? ''}`;
    const last = this.incidentLog.get(key);
    if (last != null && this.time - last < INCIDENT_DEDUPE_S) return null;
    this.incidentLog.set(key, this.time);
    const t = SCORE_TABLE[code];
    const ev: ScoreEvent = { code, at: this.time, primary, secondary, runway, points: t.points, skillDelta: t.skill, ref: t.ref, detail };
    return this.applyScore(ev);
  }
  private applyScore(ev: ScoreEvent): ScoreEvent {
    const st = this.stats;
    st.ledger.push(ev);
    st.points += ev.points;
    st.skill = Math.max(0, Math.min(12, st.skill + ev.skillDelta));
    st.score = Math.max(st.score, st.skill);
    st.incidents[ev.code] = (st.incidents[ev.code] ?? 0) + 1;
    if (ev.points < 0) st.streakS = 0;
    const a = this.find(ev.primary) ?? null;
    this.emit('score', a, `${ev.points >= 0 ? '+' : ''}${ev.points} ${ev.code.toLowerCase().replace(/_/g, ' ')}${ev.detail ? ` — ${ev.detail}` : ''}`, { type: 'score', score: ev });
    return ev;
  }
  private recordMovement(a: AircraftState) {
    const st = this.stats;
    st.movements++;
    if (a.plan.kind === 'departure') st.departures++; else st.arrivals++;
    const bucket = Math.floor(this.time / 300) * 300;
    let h = st.movementsHistory[st.movementsHistory.length - 1];
    if (!h || h.at !== bucket) { h = { at: bucket, dep: 0, arr: 0 }; st.movementsHistory.push(h); if (st.movementsHistory.length > 48) st.movementsHistory.shift(); }
    if (a.plan.kind === 'departure') h.dep++; else h.arr++;
    const win = st.movementsHistory.filter(x => x.at >= this.time - 1200);
    const n = win.reduce((s, x) => s + x.dep + x.arr, 0);
    st.movementsPerHour = Math.round(n * 3);
  }
  private recordDelay(a: AircraftState) {
    const d = a.delay;
    const total = d.requestWaitS + d.holdShortWaitS + d.holdingS + d.groundStoppedS;
    d.totalDelayS = total;
    const st = this.stats;
    st.delaySamples.push(total);
    if (st.delaySamples.length > 200) st.delaySamples.shift();
    const sorted = [...st.delaySamples].sort((x, y) => x - y);
    st.delayAvgS = sorted.reduce((s, x) => s + x, 0) / sorted.length;
    st.delayP95S = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    if (total > 900) this.addScore('DELAY_15', a.callsign, null, null, `${Math.round(total / 60)} min delay`);
    if (d.airborneS > 1800 && a.plan.kind === 'arrival') this.addScore('DELAY_30', a.callsign);
  }

  // ── pilot requests (UX §G8) ────────────────────────────────────────────────
  private reqSeq = 0;
  private static RECALL_S: Partial<Record<PilotRequestKind, number>> = { pushback: 45, startup: 45, taxi: 45, cross: 45, ready: 45, taxi_in: 45, higher: 90, lower: 90, direct: 120, say_again: 20, confirm_cleared: 30, runway_vacated: 60, further: 60, wind_check: 60, with_you: 60 };
  raiseRequest(a: AircraftState, kind: PilotRequestKind, param: string | number | null = null, text?: string): PilotRequest {
    if (this.time < a.standbyUntil && kind !== 'going_around' && kind !== 'cancel_mayday') { const s = this.sc(a); s.nextRequestAt = a.standbyUntil + 1; s.nextRequestKind = kind; return a.requests[0]; }
    const open = a.requests[0];
    if (open && open.kind === kind && open.answeredAt == null) return open;
    const req: PilotRequest = {
      id: ++this.reqSeq, kind, callsign: a.callsign, text: '', param, at: this.time,
      recallAt: this.time + (SimEngine.RECALL_S[kind] ?? 60), recalls: 0,
      expiresAt: kind === 'with_you' ? this.time + 60 : kind === 'going_around' || kind === 'runway_vacated' ? this.time + 90 : null,
      suggestedAction: null, answeredAt: null, answeredBy: null,
    };
    req.text = text ?? this.requestText(a, req);
    a.requests = [req];
    if (a.delay.firstRequestAt == null) a.delay.firstRequestAt = this.time;
    a.lastTransmissionAt = this.time;
    this.emit('request', a, req.text, { type: 'request', request: req, change: 'raised' });
    return req;
  }
  private requestText(a: AircraftState, req: PilotRequest): string {
    const fromPhrase = this.safe('phrase', () => pilotRequestLine(req, this.phraseCtx(a)), '');
    if (fromPhrase) return fromPhrase;
    const cs = this.telephony(a.callsign);
    const unit = this.unitName(a.onFrequency);
    const atis = this.atisLetter();
    const info = atis ? `, information ${atis}` : '';
    switch (req.kind) {
      case 'pushback': return `${unit}, ${cs}, stand ${a.plan.gateRef ?? ''}, request pushback${info}.`;
      case 'startup': return `${unit}, ${cs}, stand ${a.plan.gateRef ?? ''}, request start-up${info}.`;
      case 'taxi': return `${unit}, ${cs}, request taxi.`;
      case 'cross': return `${cs}, holding short of runway ${req.param ?? ''}, request cross.`;
      case 'ready': return `${unit}, ${cs}, holding point runway ${a.plan.runway ?? ''}, ready for departure.`;
      case 'with_you': return `${unit}, ${cs}, with you${isAirborne(a) ? `, ${Math.round(a.altitude / 100) * 100} feet` : ''}.`;
      case 'higher': return `${cs}, request higher.`;
      case 'lower': return `${cs}, request descent.`;
      case 'direct': return `${cs}, request direct ${req.param ?? ''}.`;
      case 'taxi_in': return `${unit}, ${cs}, runway vacated, request taxi to stand ${a.plan.gateRef ?? ''}.`;
      case 'confirm_cleared': return `${cs}, ${Math.round(req.param as number)} mile final, confirm cleared to land?`;
      case 'runway_vacated': return `${cs}, runway vacated.`;
      case 'going_around': return `${cs}, going around${req.param ? `, ${req.param}` : ''}.`;
      case 'wind_check': return `${cs}, request wind check.`;
      case 'cancel_mayday': return `${cs}, cancel MAYDAY, cancel MAYDAY.`;
      case 'return_to_stand': return `${cs}, request return to stand, technical problem.`;
      case 'say_again': return `${cs}, say again.`;
      case 'radio_check': return `${unit}, ${cs}, radio check.`;
      case 'further': return `${cs}, over ${req.param ?? ''}, request further.`;
      case 'intersection': return `${cs}, request intersection departure ${req.param ?? ''}.`;
      case 'hold': return `${cs}, request hold.`;
      case 'clearance': return `${cs}, request clearance.`;
    }
  }
  /** Mark the open request as answered when a command of an answering kind arrives. */
  private answerRequest(a: AircraftState, kinds: PilotRequestKind[] | 'any', by: 'player' | 'ai' = 'player') {
    const s = this.sc(a);
    if (s.nextRequestKind && (kinds === 'any' || kinds.includes(s.nextRequestKind))) { s.nextRequestKind = null; s.nextRequestAt = null; }
    const req = a.requests[0]; if (!req || req.answeredAt != null) return;
    if (kinds !== 'any' && !kinds.includes(req.kind)) return;
    req.answeredAt = this.time; req.answeredBy = by;
    a.delay.requestWaitS += this.time - req.at;
    const st = this.stats; const n = st.movements + st.unansweredRequests + 1;
    st.responsivenessMeanS = st.responsivenessMeanS + ((this.time - req.at) - st.responsivenessMeanS) / n;
    this.emit('request', a, `${a.callsign} request ${req.kind} answered`, { type: 'request', request: req, change: 'answered' });
    a.requests = [];
  }
  private expireRequest(a: AircraftState) {
    const req = a.requests[0]; if (!req) return;
    req.answeredAt = this.time; req.answeredBy = 'timeout';
    this.emit('request', a, `${a.callsign} request ${req.kind} expired`, { type: 'request', request: req, change: 'expired' });
    a.requests = [];
  }
  private static ANSWERS: Partial<Record<CommandAST['kind'], PilotRequestKind[]>> = {
    pushback: ['pushback', 'startup'], startup: ['startup', 'pushback'], taxi: ['taxi', 'taxi_in', 'return_to_stand', 'intersection'], cross: ['cross'],
    lineup: ['ready'], takeoff: ['ready'], altitude: ['higher', 'lower'], direct: ['direct'], clearedLand: ['confirm_cleared'], continueApproach: ['confirm_cleared'],
    heading: ['further', 'hold'], hold: ['hold', 'further'], ils: ['further'], windCheck: ['wind_check'], roger: ['runway_vacated', 'going_around', 'radio_check'],
    contact: ['runway_vacated'], report: ['radio_check'], emergencyCancelAck: ['cancel_mayday'], radarContact: ['with_you'], goAround: ['going_around'],
    standby: [], unable: [],
  };

  // ── pilot delay / readbacks / transmissions ────────────────────────────────
  /** Pilot delay (s): 2-4 s air, 4-8 s ground, x pilotDelayFactor for incapacitation/hijack (03 §8 / §F4.16). */
  pilotDelayS(a: AircraftState, kind: CommandAST['kind']): number {
    const f = a.emergency ? EMERGENCY_CATALOGUE[a.emergency.type].perf.pilotDelayFactor : 1;
    if (this.settings.pilotDelayOverride != null) return this.settings.pilotDelayOverride * f;
    const groundKind = !isAirborne(a) && !['heading', 'altitude', 'speed', 'direct', 'hold', 'ils', 'loc', 'visual', 'goAround', 'clearedLand'].includes(kind);
    void kind;
    return (groundKind ? rf(4, 8) : rf(2, 4)) * f;
  }
  unitName(position: Position): string {
    const name = this.airportName;
    switch (position) { case 'ground': return `${name} Ground`; case 'tower': return `${name} Tower`; case 'departure': return `${name} Departure`; case 'approach': return `${name} Approach`; default: return 'Control'; }
  }
  phraseCtx(a: AircraftState | null): PhraseCtx {
    const w = this.wx();
    return {
      variant: this.settings.region,
      telephony: (cs: string) => this.telephony(cs),
      unit: (p: Position) => this.unitName(p),
      freq: (p: Position) => this.frequencies[p] ?? '',
      wind: { dir: w.windDirTrue, kts: w.windKt, gust: w.gustKt },
      qnh: w.qnh,
      atisLetter: this.atisLetter(),
      magVar: this.magVar,
      transitionAltFt: this.transitionAltFt,
      time: this.time,
      aircraft: a,
      spokenType: (icao: string) => spokenTypeOf(icao),
    };
  }
  /** Strict-frequency policy (03 §B6): only enforced when the setting is on; the player's own positions are one frequency. */
  onPlayerFrequency(a: AircraftState): boolean {
    if (!this.settings.strictFrequencies) return true;
    const owner = POSITION_OWNER[a.onFrequency];
    return owner === this.playerPosition;
  }
  /** Called by dispatch after composing the result: transmission event now, readback event at readbackAt. */
  onTransmission(ast: CommandAST, result: CommandResult, a: AircraftState | null): void {
    this.stats.transmissions++;
    if (a) { a.lastAtcTransmissionAt = this.time; a.readback.lastAst = ast; }
    if (SILENT_CODES.includes(result.code)) return;
    this.emit('transmission', a, result.transmission || describe(ast), { type: 'transmission', ast, result, who: 'player' }, 'ATC');
    if (!a) return;
    const status: ReadbackStatus = result.code === 'partial' ? 'partial' : result.code === 'queried' ? 'say_again' : result.code.startsWith('unable') ? 'unable' : 'ok';
    const at = result.readbackAt ?? this.time + (this.settings.pilotDelayOverride ?? rf(2, 4));
    let text = result.readback || this.fallbackReadback(ast, a, status, result.reason);
    let mismatch: ScheduledReadback['mismatch'] = null;
    if (status === 'ok' && this.settings.pilotErrorRate > 0 && chance(this.settings.pilotErrorRate)) {
      const m = this.wrongReadback(ast, text); if (m) { mismatch = m.mismatch; text = m.text; }
    }
    a.readback = { ...a.readback, status: 'pending', dueAt: at, text: '', mismatch: null, refused: result.refused ?? [] };
    this.readbacks.push({ at, aircraftId: a.id, status: mismatch ? 'mismatch' : status, text, ast, refused: result.refused ?? [], mismatch });
  }
  private fallbackReadback(ast: CommandAST, a: AircraftState, status: ReadbackStatus, reason?: string): string {
    const rb = this.safe('phrase', () => phraseReadback(ast, this.phraseCtx(a)), '');
    if (rb) return rb;
    const cs = this.telephony(a.callsign);
    if (status === 'unable') return `Unable${reason ? `, ${reason.toLowerCase()}` : ''}, ${cs}.`;
    if (status === 'say_again') return `${cs}, ${reason ?? 'say again'}?`;
    return `${describe(ast)}, ${cs}.`;
  }
  /** 2 % wrong readback (03 §G4): perturb a heading/altitude/speed/runway token in the readback text. */
  private wrongReadback(ast: CommandAST, text: string): { text: string; mismatch: NonNullable<ScheduledReadback['mismatch']> } | null {
    if (ast.kind === 'heading') { const wrong = hdg3(ast.hdg + (chance(0.5) ? 10 : -10)); return { text: text.replace(/\b\d{3}\b/, wrong), mismatch: { field: 'heading', expected: hdg3(ast.hdg), read: wrong } }; }
    if (ast.kind === 'altitude') { const wrong = ast.ft + (chance(0.5) ? 1000 : -1000); return { text: text.replace(String(ast.ft), String(wrong)), mismatch: { field: 'altitude', expected: String(ast.ft), read: String(wrong) } }; }
    if (ast.kind === 'speed' && typeof ast.kts === 'number') { const wrong = ast.kts + 10; return { text: text.replace(String(ast.kts), String(wrong)), mismatch: { field: 'speed', expected: String(ast.kts), read: String(wrong) } }; }
    if (ast.kind === 'taxi' && ast.dest.kind === 'runway' || ast.kind === 'lineup' || ast.kind === 'takeoff' || ast.kind === 'clearedLand' || ast.kind === 'ils') {
      const rwy = ast.kind === 'taxi' ? (ast.dest as { runway: string }).runway : (ast as { runway: string }).runway;
      const rs = this.runwayState(rwy); if (!rs) return null;
      const other = this.runways.find(r => r.name !== rs.name && r.ref !== rs.ref && r.name.slice(0, 2) === rs.name.slice(0, 2)) ?? this.runways.find(r => r.ref !== rs.ref);
      if (!other) return null;
      return { text: text.replace(rs.name, other.name), mismatch: { field: 'runway', expected: rs.name, read: other.name } };
    }
    return null;
  }
  private processReadbacks() {
    if (!this.readbacks.length) return;
    const due = this.readbacks.filter(r => r.at <= this.time);
    if (!due.length) return;
    this.readbacks = this.readbacks.filter(r => r.at > this.time);
    for (const r of due) {
      const a = this.byId(r.aircraftId); if (!a) continue;
      if (a.emergency?.type === 'radio_failure') continue;
      a.readback.status = r.status; a.readback.text = r.text; a.readback.at = this.time; a.readback.refused = r.refused;
      a.readback.mismatch = r.mismatch ? { ...r.mismatch, deadline: this.time + READBACK_MISMATCH_WINDOW_S } : null;
      a.lastTransmissionAt = this.time;
      this.emit('readback', a, r.text, { type: 'readback', status: r.status, text: r.text, ast: r.ast, refused: r.refused });
    }
  }
  /** Uncorrected wrong readback after 15 s: the wrong value executes (G4) and READBACK_ERROR_MISSED is scored. */
  private enforceMismatch(a: AircraftState) {
    const m = a.readback.mismatch; if (!m || this.time < m.deadline) return;
    a.readback.mismatch = null;
    this.addScore('READBACK_ERROR_MISSED', a.callsign, null, null, `${m.field} read back ${m.read}, expected ${m.expected}`);
    if (m.field === 'heading') { const v = parseInt(m.read, 10) % 360; const p = a.pendingCmds.find(c => c.kind === 'heading'); if (p) p.value = v; else if (a.navMode === 'heading') a.targetHeading = v; }
    else if (m.field === 'altitude') { const v = parseInt(m.read, 10); const p = a.pendingCmds.find(c => c.kind === 'altitude'); if (p) p.value = v; else { a.targetAltitude = v; a.cmdAltitude = v; } }
    else if (m.field === 'speed') { const v = parseInt(m.read, 10); const p = a.pendingCmds.find(c => c.kind === 'speed'); if (p) p.value = v; else { a.targetSpeed = v; a.cmdIas = v; } }
    this.emit('info', a, `${a.callsign} executing uncorrected readback: ${m.field} ${m.read}`);
  }

  // ── pending queue (UX §G5.1) ───────────────────────────────────────────────
  private enqueue(a: AircraftState, ast: CommandAST, opts: { condition?: PendingCondition | null; value?: number; untilNM?: number | null; cancellable?: boolean; immediate?: boolean } = {}): EngineOutcome {
    const kind = ast.kind as PendingCmd['kind'];
    const immediate = opts.immediate ?? IMMEDIATE_KINDS.includes(ast.kind);
    const delay = immediate ? 0 : this.pilotDelayS(a, ast.kind);
    if (NUMERIC_KINDS.has(kind)) a.pendingCmds = a.pendingCmds.filter(c => c.kind !== kind);
    // The parts of one transmission (same issue time) share one pilot delay and execute in the order they were
    // spoken: "turn right heading 245, cleared ILS" must never arm the ILS before the turn (or cancel it after).
    const sibling = immediate ? undefined : a.pendingCmds.find(c => c.issuedAt === this.time && c.applyAt > this.time);
    const applyAt = sibling ? sibling.applyAt : this.time + delay;
    a.pendingCmds.push({ kind, value: opts.value ?? 0, applyAt, condition: opts.condition ?? undefined, ast, issuedAt: this.time, cancellable: opts.cancellable ?? true, untilNM: opts.untilNM ?? undefined });
    a.underControl = true; a.attention = false;
    return { ok: true, code: opts.condition ? 'ok_conditional' : 'ok_queued', applyAt, applied: false };
  }
  private conditionMet(a: AircraftState, c: PendingCondition | undefined): boolean {
    if (!c) return true;
    const s = this.sc(a);
    switch (c.type) {
      case 'after_pushback': return a.phase !== 'pushback' && (a.pushback.stage === 'complete' || a.pushback.stage === 'none') && a.startup.enginesStable;
      case 'when_ready': return a.startup.enginesStable && a.phase !== 'pushback';
      case 'on_reaching_hold': return a.phase === 'hold_short' && !!a.holdShortNode && !!a.plan.runway && this.isHoldNodeForRunway(a.holdShortNode, a.plan.runway);
      case 'at_or_below_alt': return a.altitude <= c.ft + 50;
      case 'at_or_above_alt': return a.altitude >= c.ft - 50;
      case 'after_fix': return s.passedFixes.has(upper(c.fix));
      case 'after_vacated': return s.vacated;
      case 'behind_aircraft': {
        const b = this.byId(c.id) ?? this.find(c.callsign);
        if (!b) return true;
        // the runway the condition protects: the next hold on the path (a crossing), else the departure runway
        const hold = a.path?.holds?.[0];
        const rw = (hold && hold.runway) || a.holdShortRunway || a.plan.runway;
        const ref = rw ? this.refOf(rw) : null;
        if (isAirborne(b)) { const d = rw ? this.distToThresholdNM(b, rw) : null; return b.plan.kind === 'departure' || (d != null && d > 3 && !b.ilsCaptured); }
        if (b.phase === 'takeoff' || b.phase === 'lineup') return false;
        if (b.phase === 'rollout') {
          // "behind the landing traffic" (03 D12): a crossing may start once the lander has rolled past the crossing
          // point; a line-up behind it waits for the runway to be vacated.
          if (!hold || hold.isDepartureEntry) return false;
          const info = this.holdNodeInfo.get(a.holdShortNode ?? hold.nodeId);
          const rx = info ? this.nodeXY(info.runwayNodeId) : null;
          if (!rx || (ref && this.refOf(hold.runway) !== ref)) return false;
          return alongTrack(b.pos, rx, b.heading) > b.perf.lengthMeters + 150;
        }
        return ref ? this.distToRunway(b.pos, ref) > HOLD_LINE_M : true;
      }
    }
  }
  private drainPending(a: AircraftState) {
    if (!a.pendingCmds.length) return;
    const ready = a.pendingCmds.filter(c => c.applyAt <= this.time && this.conditionMet(a, c.condition));
    if (!ready.length) return;
    a.pendingCmds = a.pendingCmds.filter(c => !ready.includes(c));
    for (const c of ready) {
      if (c.ast) this.applyAst(a, c.ast, c);
      else if (c.kind === 'heading') { a.targetHeading = c.value; a.navMode = 'heading'; }
      else if (c.kind === 'altitude') a.targetAltitude = c.value;
      else if (c.kind === 'speed') a.targetSpeed = c.value;
    }
  }

  // ── AST execution (at applyAt) ─────────────────────────────────────────────
  private applyAst(a: AircraftState, ast: CommandAST, cmd?: PendingCmd) {
    switch (ast.kind) {
      case 'startup': this.execStartup(a, ast.expectRunway); break;
      case 'pushback': this.execPushback(a, ast.dir, ast.expectRunway, ast.startup, ast.tailTo); break;
      case 'taxi': this.execTaxi(a, ast.dest, ast.via, ast.auto, ast.holdShortOf, ast.cross, ast.expedite); break;
      case 'holdShort': this.execHoldShort(a, ast.of); break;
      case 'holdPosition': this.execHoldPosition(a); break;
      case 'continue': this.execContinue(a, ast.holdShortOf); break;
      case 'cross': this.execCross(a, ast.runway); break;
      case 'giveWay': this.execGiveWay(a, ast.to, ast.mode); break;
      case 'lineup': this.execLineUp(a, ast.runway, ast.intersection); break;
      case 'takeoff': this.execTakeoff(a, ast.runway, { immediate: ast.immediate, afterDepHdg: ast.afterDepHdg, turn: ast.turn, initialAlt: ast.initialAlt, contactDeparture: ast.contactDeparture }); break;
      case 'cancelLineup': this.execCancelLineup(a, ast.via); break;
      case 'exitAt': this.execExitAt(a, ast.exit, ast.expedite, ast.holdShortOf, ast.contactGround); break;
      case 'expedite': this.execExpedite(a, ast.on, ast.scope); break;
      case 'clearedLand': this.execClearedLand(a, ast.runway, ast.lahso, ast.exit); break;
      case 'continueApproach': { const s = this.sc(a); s.continueApproach = true; break; }
      case 'goAround': this.execGoAround(a, ast.heading, ast.alt, ast.contact); break;
      case 'contact': this.execHandoff(a, ast.position); break;
      case 'heading': this.execHeading(a, cmd?.value ?? ast.hdg, ast.dir); break;
      case 'altitude': this.execAltitude(a, cmd?.value ?? ast.ft, ast.expedite); break;
      case 'speed': this.execSpeed(a, ast.kts === 'resume' ? null : (cmd?.value ?? ast.kts), ast.untilNM); break;
      case 'direct': this.execDirect(a, ast.fix, ast.thenHdg); break;
      case 'hold': this.execHold(a, ast.fix, ast.inbound, ast.dir, ast.legTimeMin, ast.legNM, ast.efc); break;
      case 'ils': this.execILS(a, ast.runway, false, null, cmd?.issuedAt); break;
      case 'loc': this.execILS(a, ast.runway, true, ast.maintainAlt, cmd?.issuedAt); break;
      case 'visual': this.execVisual(a, ast.runway); break;
      case 'cancelApproach': this.execCancelApproach(a, ast.hdg, ast.alt, ast.dir); break;
      case 'expectRunway': a.plan.runway = ast.runway; a.assignedRunway = null; break;
      case 'resumeSid': a.navMode = 'sid'; a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; break;
      case 'squawk': a.squawk = ast.code; break;
      case 'ident': a.identUntil = this.time + 10; break;
      case 'radarContact': a.underControl = true; a.attention = false; if (ast.descendTo != null) this.execAltitude(a, ast.descendTo, false); if (ast.expectRunway) a.plan.runway = ast.expectRunway; break;
      case 'priority': this.execPriority(a, ast.runway, ast); break;
      case 'stopOnRunway': if (a.emergency) { a.emergency.stopOnRunway = ast.mode === 'stop'; if (ast.mode === 'vacate_if_able') a.emergency.requests.push('vacate_if_able'); if (ast.via) a.exitTaxiway = upper(ast.via); } break;
      default: break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — ground
  // ═══════════════════════════════════════════════════════════════════════════
  cmdStartup(a: AircraftState, expectRunway: string | null): EngineOutcome {
    if (a.phase !== 'parked') return { ok: false, code: a.startup.startedAt != null ? 'already' : 'invalid_stage', reason: a.startup.startedAt != null ? 'Already started' : 'Not parked' };
    if (a.needsPushback) return { ok: false, code: 'invalid_stage', reason: 'Use Pushback' };
    if (expectRunway && !this.runwayState(expectRunway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${expectRunway}` };
    this.answerRequest(a, SimEngine.ANSWERS.startup!);
    return this.enqueue(a, makeAst('startup', a.callsign, { expectRunway }));
  }
  private execStartup(a: AircraftState, expectRunway: string | null) {
    if (a.startup.startedAt != null) return;
    const [lo, hi] = a.perf.startupS;
    let dur = rf(lo, hi);
    a.startup.startedAt = this.time;
    if (chance(0.04)) { a.startup.failed = true; dur += 300; this.emit('startup', a, `${a.callsign} start aborted, hot start, request five minutes`, undefined, 'PILOT'); }
    a.startup.readyAt = this.time + dur; a.startup.enginesStable = false;
    if (expectRunway) a.plan.runway = upper(expectRunway);
    if (a.phase === 'parked') { a.phase = 'startup'; }
    this.emit('startup', a, `${a.callsign} starting engines (${Math.round(dur)} s)`);
  }
  cmdPushback(a: AircraftState, dir: PushDir, expectRunway: string | null, withStartup: boolean, tailTo: string | null): EngineOutcome {
    if (a.phase !== 'parked') return { ok: false, code: a.phase === 'pushback' ? 'already' : 'invalid_stage', reason: a.phase === 'pushback' ? 'Already cleared' : 'Not parked' };
    if (!a.needsPushback) return { ok: false, code: 'invalid_stage', reason: `Pushback not required at stand ${a.plan.gateRef ?? ''}` };
    if (expectRunway && !this.runwayState(expectRunway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${expectRunway}` };
    if (!this.pushbackPath(a, dir)) return { ok: false, code: 'no_route', reason: 'No pushback lane' };
    this.answerRequest(a, SimEngine.ANSWERS.pushback!);
    return { ...this.enqueue(a, makeAst('pushback', a.callsign, { dir, expectRunway, startup: withStartup, tailTo })), extra: { runway: expectRunway ?? a.plan.runway ?? null } };
  }
  private execPushback(a: AircraftState, dir: PushDir, expectRunway: string | null, withStartup: boolean, tailTo: string | null) {
    void tailTo;
    if (a.phase !== 'parked') return;
    const path = this.pushbackPath(a, dir); if (!path) return;
    if (expectRunway) a.plan.runway = upper(expectRunway);
    a.pushback = { ...defaultPushback(), stage: 'tug_attach', stageUntil: this.time + rf(20, 40), facing: dir, tugId: 'TUG', totalM: path.total, expectRunway: expectRunway ?? a.plan.runway ?? null };
    a.path = path; a.distAlong = 0; a.holdReleased = true; a.speed = 0;
    a.phase = 'pushback';
    a.delay.pushbackAt = this.time;
    if (withStartup || a.startup.startedAt == null) this.execStartup(a, expectRunway);
    this.releaseStands(a);
    this.emit('pushback', a, `${a.callsign} pushback: tug connecting`);
  }
  cmdTaxi(a: AircraftState, dest: TaxiDest, via: string[], auto: boolean, holdShortOf: HoldShortTarget | null, cross: string[], expedite: boolean): EngineOutcome {
    if (a.phase === 'parked') return { ok: false, code: 'invalid_stage', reason: a.needsPushback ? 'Push back first' : 'Start up first' };
    if (isAirborne(a) || a.phase === 'takeoff' || a.phase === 'lineup' || a.phase === 'landing') return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    if (a.phase === 'arrived' || a.phase === 'departed') return { ok: false, code: 'invalid_stage', reason: 'On stand' };
    if (dest.kind === 'runway' && a.plan.kind === 'departure') {
      const rs = this.runwayState(dest.runway);
      if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${dest.runway}` };
      if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    }
    if (dest.kind === 'stand') { const occ = this.standOccupant(dest.ref); if (occ && occ !== a.callsign) return { ok: false, code: 'unknown_stand', reason: `Stand ${dest.ref} occupied by ${occ}` }; }
    const plan = this.planTaxi(a, dest, via);
    if ('code' in plan) return { ok: false, code: plan.code, reason: plan.reason };
    if (holdShortOf?.kind === 'taxiway' && !this.air.taxiwayNodes.has(upper(holdShortOf.taxiway))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(holdShortOf.taxiway)} here` };
    for (const x of cross) if (!this.runwayState(x)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${x}` };
    // FAA (03 §A1): a route crossing a runway with neither cross nor hold-short scores TAXI_INCOMPLETE (-25); ICAO implicit hold is correct.
    if (this.settings.region === 'FAA') {
      const crossings = plan.path.holds!.filter(h => !h.isDepartureEntry);
      const covered = (h: PathHold) => cross.some(c => this.refOf(c) === this.refOf(h.runway)) || (holdShortOf?.kind === 'runway' && this.refOf(holdShortOf.runway) === this.refOf(h.runway));
      if (crossings.some(h => !covered(h))) this.addScore('TAXI_INCOMPLETE', a.callsign, null, crossings[0].runway, 'runway crossing without cross/hold-short instruction');
    }
    this.answerRequest(a, SimEngine.ANSWERS.taxi!);
    const condition: PendingCondition | null = a.phase === 'pushback' ? { type: 'after_pushback' } : a.phase === 'startup' && !a.startup.enginesStable ? { type: 'when_ready' } : a.phase === 'rollout' ? { type: 'after_vacated' } : null;
    const ast = makeAst('taxi', a.callsign, { dest, via, auto, holdShortOf, cross, expedite });
    return { ...this.enqueue(a, ast, { condition }), extra: { route: plan.ids.length ? taxiwaysForPath(this.air, plan.ids).join(' ') : '', runway: plan.runway, stand: plan.stand } };
  }
  private execTaxi(a: AircraftState, dest: TaxiDest, via: string[], auto: boolean, holdShortOf: HoldShortTarget | null, cross: string[], expedite: boolean) {
    void auto;
    if (isAirborne(a) || a.phase === 'takeoff' || a.phase === 'lineup') return;
    const plan = this.planTaxi(a, dest, via);
    if ('code' in plan) { this.emit('readback', a, `Unable, ${plan.reason.toLowerCase()}, ${this.telephony(a.callsign)}`, { type: 'readback', status: 'unable', text: plan.reason, ast: null, refused: [] }); return; }
    const s = this.sc(a);
    const path = plan.path;
    // Explicit hold-short target / crossing clearances in the same transmission
    if (holdShortOf?.kind === 'taxiway') this.insertTaxiwayHold(a, path, upper(holdShortOf.taxiway));
    for (const c of cross) { const ref = this.refOf(c); const h = path.holds!.find(x => this.refOf(x.runway) === ref && !x.isDepartureEntry); if (h) { path.holds!.splice(path.holds!.indexOf(h), 1); } }
    path.holdAt = path.holds!.length ? path.holds![0].at : undefined;
    // Leaving a runway / a hold node: release runway occupancy bookkeeping
    if (s.onRunwayRef && (a.phase === 'rollout' || a.phase === 'hold_short')) { /* vacate handled by transitions */ }
    a.path = path; a.distAlong = 0; a.holdReleased = false; a.takeoffCleared = false;
    a.holdShortNode = null; a.holdShortRunway = null; a.holdShortTaxiway = holdShortOf?.kind === 'taxiway' ? upper(holdShortOf.taxiway) : null;
    a.plan.taxiRoute = taxiwaysForPath(this.air, plan.ids);
    s.taxiDest = dest;
    if (plan.runway) { a.plan.runway = plan.runway; if (a.plan.kind === 'departure') { a.assignedRunway = null; } }
    if (plan.stand) { a.plan.gateRef = plan.stand; const g = this.gateByRef(plan.stand); if (g) { this.releaseStands(a); this.reserveStand(g, a); } }
    if (expedite) a.expediteTaxiUntil = this.time + 90;
    if (a.delay.taxiStartAt == null) a.delay.taxiStartAt = this.time;
    if (a.phase === 'rollout') { for (const rs of this.runways) this.removeOccupant(rs.ref, a.id); }
    if (a.phase === 'startup') { a.reservedStand = null; this.releaseStands(a); }
    a.phase = 'taxi';
    s.stoppedSince = null;
    this.emit('phase', a, `${a.callsign} -> taxi`);
  }
  private insertTaxiwayHold(a: AircraftState, path: DrivePath, taxiway: string): boolean {
    const nodes = this.air.taxiwayNodes.get(taxiway); if (!nodes) return false;
    let best: { at: number; nodeId: string } | null = null;
    for (const id of nodes) {
      const xy = this.nodeXY(id)!;
      const pr = projectOntoPath(path.pts, path.cum, xy, a.distAlong);
      if (pr.dist < 12 && pr.at > a.distAlong + 5 && (!best || pr.at < best.at)) best = { at: pr.at, nodeId: id };
    }
    if (!best) return false;
    const at = Math.max(a.distAlong + 1, best.at - 15);
    path.holds = path.holds ?? [];
    if (!path.holds.some(h => Math.abs(h.at - at) < 5)) path.holds.push({ nodeId: best.nodeId, runway: '', at, isDepartureEntry: false });
    path.holds.sort((x, y) => x.at - y.at);
    path.holdAt = path.holds[0].at;
    a.holdShortTaxiway = taxiway;
    return true;
  }
  cmdHoldShort(a: AircraftState, of: HoldShortTarget): EngineOutcome {
    if (isAirborne(a) || a.phase === 'takeoff') return { ok: false, code: 'invalid_stage', reason: 'Airborne — use Go around' };
    if (!a.path || (a.phase !== 'taxi' && a.phase !== 'hold_short' && a.phase !== 'rollout')) return { ok: false, code: 'invalid_stage', reason: 'Not moving' };
    if (of.kind === 'runway') {
      const ref = this.refOf(of.runway); if (!ref) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${of.runway}` };
      const h = a.path.holds?.find(x => this.refOf(x.runway) === ref);
      if (!h) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, unable, ${of.runway} is not on our route` };
      if (a.phase === 'hold_short' && a.path.holds![0] === h) return { ok: false, code: 'already', reason: 'Already holding short' };
    } else if (of.kind === 'taxiway') {
      if (!this.air.taxiwayNodes.has(upper(of.taxiway))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(of.taxiway)} here` };
    }
    return this.enqueue(a, makeAst('holdShort', a.callsign, { of }));
  }
  private execHoldShort(a: AircraftState, of: HoldShortTarget) {
    if (!a.path) return;
    if (of.kind === 'runway') {
      const ref = this.refOf(of.runway);
      const h = a.path.holds?.find(x => this.refOf(x.runway) === ref);
      // re-arm a released crossing only while the aircraft can still stop before the line (never pull it back, B5)
      if (h && a.path.holds![0] === h) {
        if (a.distAlong <= h.at - HOLD_BUFFER_M) a.holdReleased = false;
        else if (a.distAlong < h.at - 1) { h.at = Math.max(h.at, a.distAlong + HOLD_BUFFER_M + this.brakingM(a.speed, 2.5)); a.path.holdAt = h.at; a.holdReleased = false; }
        else this.emit('readback', a, `Unable, already crossing ${of.runway}, ${this.telephony(a.callsign)}`, { type: 'readback', status: 'unable', text: `already crossing ${of.runway}`, ast: null, refused: [] });
      }
    } else if (of.kind === 'taxiway') {
      if (!this.insertTaxiwayHold(a, a.path, upper(of.taxiway))) this.emit('readback', a, `Unable, already past ${of.taxiway}, ${this.telephony(a.callsign)}`, { type: 'readback', status: 'unable', text: `already past ${of.taxiway}`, ast: null, refused: [] });
    } else {
      const xy = this.nodeXY(of.nodeId); if (!xy) return;
      const pr = projectOntoPath(a.path.pts, a.path.cum, xy, a.distAlong);
      if (pr.dist < 15) { a.path.holds = a.path.holds ?? []; a.path.holds.push({ nodeId: of.nodeId, runway: '', at: pr.at, isDepartureEntry: false }); a.path.holds.sort((x, y) => x.at - y.at); a.path.holdAt = a.path.holds[0].at; }
    }
    a.takeoffCleared = false;
  }
  cmdHoldPosition(a: AircraftState): EngineOutcome {
    if (isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'Airborne — use Go around' };
    if (a.phase === 'takeoff') return this.cmdCancelTakeoff(a);
    if (a.phase === 'parked' || a.phase === 'arrived') return { ok: false, code: 'invalid_stage', reason: 'Not moving' };
    return this.enqueue(a, makeAst('holdPosition', a.callsign), { immediate: true });
  }
  private execHoldPosition(a: AircraftState) {
    a.trafficHold = true; this.sc(a).stoppedSince = this.time;
    a.heldByEmergency = a.heldByEmergency || false;
    a.takeoffCleared = false;
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'takeoff' && c.kind !== 'lineup' && c.kind !== 'cross');
    // an explicit hold survives the per-tick traffic recompute via holdReleased=false + a manual flag in scratch
    this.sc(a).luawAt = a.phase === 'lineup' ? this.sc(a).luawAt : null;
    this.manualHold.add(a.id);
    if (a.phase === 'pushback' && a.pushback.stage === 'pushing') a.pushback.stage = 'paused';
  }
  private manualHold = new Set<number>();
  cmdContinue(a: AircraftState, holdShortOf: HoldShortTarget | null): EngineOutcome {
    if (isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    const nextHold = a.path?.holds?.[0];
    const manual = this.manualHold.has(a.id) || (a.phase === 'pushback' && a.pushback.stage === 'paused');
    const atRunwayHold = a.phase === 'hold_short' && nextHold && nextHold.runway && !a.holdReleased;
    if (atRunwayHold && !manual) return { ok: false, code: 'not_at_hold', reason: nextHold!.isDepartureEntry ? 'At the runway holding point — use Line up / Takeoff' : `Use Cross ${nextHold!.runway}` };
    if (!manual && !(a.phase === 'hold_short' && nextHold && !nextHold.runway)) return { ok: false, code: 'nothing_pending', reason: 'No hold active' };
    return this.enqueue(a, makeAst('continue', a.callsign, { holdShortOf }));
  }
  private execContinue(a: AircraftState, holdShortOf: HoldShortTarget | null) {
    this.manualHold.delete(a.id);
    a.trafficHold = false;
    if (a.phase === 'pushback' && a.pushback.stage === 'paused') a.pushback.stage = 'pushing';
    const h = a.path?.holds?.[0];
    if (a.phase === 'hold_short' && h && !h.runway) { a.holdReleased = true; a.holdShortTaxiway = null; a.phase = 'taxi'; }
    if (holdShortOf?.kind === 'taxiway' && a.path) this.insertTaxiwayHold(a, a.path, upper(holdShortOf.taxiway));
  }
  cmdCross(a: AircraftState, runway: string, expedite: boolean, behind: string | null): EngineOutcome {
    if (isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    const h = a.path?.holds?.[0];
    if (!h || !h.runway || this.refOf(h.runway) !== rs.ref) {
      const later = a.path?.holds?.find(x => x.runway && this.refOf(x.runway) === rs.ref);
      if (later) return { ok: false, code: 'not_at_hold', reason: `Not at the ${rs.name} holding point yet` };
      return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're not holding short of ${rs.name}, confirm?` };
    }
    if (a.holdReleased) return { ok: false, code: 'already', reason: 'Already cleared to cross' };
    if (h.isDepartureEntry && a.plan.kind === 'departure') return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, ${rs.name} is our departure runway, confirm cross?` };
    if (rs.status === 'sterile') return { ok: false, code: 'held_by_emergency', reason: `Runway ${rs.name} sterile` };
    let condition: PendingCondition | null = null;
    if (behind) { const b = this.find(behind); if (!b) return { ok: false, code: 'not_found', reason: `No aircraft ${behind}` }; condition = { type: 'behind_aircraft', id: b.id, callsign: b.callsign }; }
    if (expedite) a.expediteTaxiUntil = this.time + 90;
    this.answerRequest(a, ['cross']);
    // Crossing under an arrival inside the lock: executed and scored (03 §B5)
    const arr = this.arrivalOnFinal(rs.name, 2);
    if (arr && !condition) this.addScore('RWY_INCURSION', a.callsign, arr.callsign, rs.name, `crossing ${rs.name} with ${arr.callsign} ${arr.nm.toFixed(1)} NM final`);
    return { ...this.enqueue(a, makeAst('cross', a.callsign, { runway: rs.name, expedite, behind }), { condition }), extra: { runway: rs.name } };
  }
  private execCross(a: AircraftState, runway: string) {
    const rs = this.runwayState(runway); const h = a.path?.holds?.[0];
    if (!rs || !h || this.refOf(h.runway) !== rs.ref) return;
    a.holdReleased = true; this.manualHold.delete(a.id); a.trafficHold = false;
    if (a.phase === 'hold_short') a.phase = 'taxi';
    const s = this.sc(a); s.crossingRef = rs.ref; s.crossingEntered = false; s.crossingMinD = this.distToRunway(a.pos, rs.ref);
    this.addOccupant(rs.name, a, 'crossing');
  }
  cmdGiveWay(a: AircraftState, to: string, mode: 'give_way' | 'follow'): EngineOutcome {
    if (isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    const b = this.find(to); if (!b) return { ok: false, code: 'not_found', reason: `No aircraft ${to}` };
    if (b.id === a.id) return { ok: false, code: 'invalid_param', reason: 'Cannot give way to self' };
    return this.enqueue(a, makeAst('giveWay', a.callsign, { to: b.callsign, mode }));
  }
  private execGiveWay(a: AircraftState, to: string, mode: 'give_way' | 'follow') {
    const b = this.find(to); if (!b) return;
    if (mode === 'follow') { a.followId = b.id; a.giveWayTo = null; } else { a.giveWayTo = b.id; a.followId = null; }
  }
  cmdLineUp(a: AircraftState, runway: string, behind: string | null, intersection: string | null): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (a.phase === 'lineup') return { ok: false, code: 'already', reason: 'Already on the runway' };
    if (a.phase !== 'hold_short' && a.phase !== 'taxi') return { ok: false, code: 'invalid_stage', reason: isAirborne(a) ? 'Airborne' : 'Not at the holding point yet' };
    const atHold = this.atDepartureHold(a, rs);
    if (!atHold) {
      const nearM = this.distToNextHoldM(a, rs);
      if (nearM == null || nearM > 200) return { ok: false, code: 'not_at_hold', reason: 'Not at the holding point yet' };
    }
    if (a.plan.runway && this.refOf(a.plan.runway) !== rs.ref && !this.holdsForRunway(a, rs)) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're holding short of runway ${a.holdShortRunway ?? a.plan.runway}, confirm?` };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (rs.status !== 'open') return { ok: false, code: 'runway_closed', reason: `Runway ${rs.name} ${rs.status}` };
    if (this.holdAllBlocks(a, rs)) return { ok: false, code: 'held_by_emergency', reason: 'Traffic hold in effect' };
    const other = rs.occupiedBy.find(o => o.id !== a.id && (o.kind === 'lineup' || o.kind === 'takeoff' || o.kind === 'backtrack'));
    if (other) return { ok: false, code: 'runway_occupied', reason: `Runway ${rs.name} occupied by ${other.callsign}` };
    let condition: PendingCondition | null = atHold ? null : { type: 'on_reaching_hold' };
    if (behind) { const b = this.find(behind); if (!b) return { ok: false, code: 'not_found', reason: `No aircraft ${behind}` }; condition = { type: 'behind_aircraft', id: b.id, callsign: b.callsign }; }
    const arr = this.arrivalOnFinal(rs.name, 2);
    if (arr && !condition) this.addScore('LUAW_UNSAFE', a.callsign, arr.callsign, rs.name, `${arr.callsign} on ${arr.nm.toFixed(1)} NM final`);
    this.answerRequest(a, ['ready']);
    const traffic = this.arrivalOnFinal(rs.name, 6);
    a.plan.runway = rs.name;
    return { ...this.enqueue(a, makeAst('lineup', a.callsign, { runway: rs.name, behind, intersection }), { condition }), extra: { runway: rs.name, trafficInfo: traffic ? `${spokenTypeOf(traffic.a.perf.icaoCode)} ${Math.round(traffic.nm)} mile final` : null } };
  }
  private holdsForRunway(a: AircraftState, rs: RunwayState): boolean { return !!a.holdShortNode && this.isHoldNodeForRunway(a.holdShortNode, rs.name); }
  private atDepartureHold(a: AircraftState, rs: RunwayState): boolean {
    return a.phase === 'hold_short' && this.holdsForRunway(a, rs) && a.speed < 3;
  }
  private distToNextHoldM(a: AircraftState, rs: RunwayState): number | null {
    const h = a.path?.holds?.find(x => this.refOf(x.runway) === rs.ref); if (!h) return null;
    return h.at - a.distAlong;
  }
  private execLineUp(a: AircraftState, runway: string, intersection: string | null) {
    const rs = this.runwayState(runway); if (!rs) return;
    if (a.phase !== 'hold_short' && a.phase !== 'taxi') return;
    const path = this.lineupPath(a, rs, intersection); if (!path) return;
    a.path = path; a.distAlong = 0; a.holdReleased = true; a.takeoffCleared = false;
    a.holdShortNode = null; a.holdShortRunway = null;
    a.targetHeading = rs.headingTrue; a.plan.runway = rs.name;
    a.phase = 'lineup'; this.manualHold.delete(a.id); a.trafficHold = false;
    this.addOccupant(rs.name, a, 'lineup');
    this.sc(a).luawAt = this.time;
    this.emit('phase', a, `${a.callsign} -> lineup ${rs.name}`);
  }
  /** Path from the hold onto the runway: hold node -> runway node -> 50 m along the runway (threshold + 50 m for a full-length entry). */
  private lineupPath(a: AircraftState, rs: RunwayState, intersection: string | null): DrivePath | null {
    void intersection;
    const info = a.holdShortNode ? this.holdNodeInfo.get(a.holdShortNode) : undefined;
    const thr = this.thresholdXY(rs.name)!;
    let entry: XY;
    if (info && info.ref === rs.ref) entry = this.nodeXY(info.runwayNodeId)!;
    else {
      const r = this.runwayByEnd(rs.name)!; entry = this.endXY(r.end);
      const cands = [...(this.holdNodes.get(rs.ref) ?? [])];
      const near = cands.reduce<{ id: string; d: number } | null>((b, id) => { const d = dist(a.pos, this.nodeXY(id)!); return !b || d < b.d ? { id, d } : b; }, null);
      if (near && near.d < 250) entry = this.nodeXY(this.holdNodeInfo.get(near.id)!.runwayNodeId)!;
    }
    const along = Math.max(0, alongTrack(entry, thr, rs.headingTrue));
    const onLine = advance(thr, rs.headingTrue, along);
    const stop = advance(thr, rs.headingTrue, along + LINEUP_ADVANCE_M);
    const raw = [{ ...a.pos }, onLine, stop];
    if (dist(entry, onLine) > 8) raw.splice(1, 0, entry);
    const p = this.buildPath(raw, 'runway', true);
    return p.total > 2 ? p : null;
  }
  cmdTakeoff(a: AircraftState, runway: string, opts: { immediate: boolean; afterDepHdg: number | 'runway' | null; turn: { dir: TurnDir; deg: number } | null; initialAlt: number | null; contactDeparture: boolean }): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (a.phase === 'takeoff') return { ok: false, code: 'already', reason: 'Already cleared' };
    if (!['hold_short', 'lineup', 'taxi'].includes(a.phase)) return { ok: false, code: 'invalid_stage', reason: isAirborne(a) ? 'Airborne' : 'Not at the holding point yet' };
    const lined = a.phase === 'lineup' && a.plan.runway && this.refOf(a.plan.runway) === rs.ref;
    const atHold = this.atDepartureHold(a, rs);
    if (!lined && !atHold) {
      const nearM = this.distToNextHoldM(a, rs);
      if (a.phase === 'lineup') return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're lined up on runway ${a.plan.runway}, confirm ${rs.name}?` };
      if (nearM == null) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're holding short of ${a.holdShortRunway ?? 'the runway'}, confirm ${rs.name}?` };
      if (nearM > 250) return { ok: false, code: 'not_at_hold', reason: 'Not at the holding point yet' };
    }
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (rs.status !== 'open') return { ok: false, code: 'runway_closed', reason: `Runway ${rs.name} ${rs.status}` };
    if (this.holdAllBlocks(a, rs)) return { ok: false, code: 'held_by_emergency', reason: 'Traffic hold in effect' };
    const occ = this.runwayOccupant(rs.name, a.id);
    if (occ) return { ok: false, code: 'runway_occupied', reason: `Runway ${rs.name} occupied by ${occ}` };
    if (!this.runwayPhysicallyClear(rs.name, a.id)) return { ok: false, code: 'runway_occupied', reason: `Runway ${rs.name} occupied by ${this.aircraft.find(x => x.id !== a.id && this.distToRunway(x.pos, rs.ref) < STRIP_HALF_M)?.callsign ?? 'traffic'}` };
    const cool = this.sc(a).rtoRecoverAt;
    if (a.rto && cool != null && this.time < cool) return { ok: false, code: 'unable', reason: `Unable, brakes cooling after the rejected takeoff, ${Math.ceil((cool - this.time) / 60)} min` };
    const wake = this.wakeTimerRemainingS(rs.name, a.wakeCategory);
    if (wake > 0) return { ok: false, code: 'unable', reason: `Wake turbulence, ${rs.wakeTimer?.leader} departed, ${Math.ceil(wake)} s remaining` };
    const arr = this.arrivalOnFinal(rs.name, 2);
    if (arr) return { ok: false, code: 'unable', reason: `Arrival ${arr.callsign} ${arr.nm.toFixed(1)} NM final` };
    if (opts.immediate && chance(a.wakeCategory === 'HEAVY' || a.wakeCategory === 'SUPER' ? 0.10 : 0.04)) return { ok: false, code: 'unable_immediate', reason: 'Unable immediate' };
    const wc = this.windFor(rs.headingTrue);
    if (-wc.headKt > 10) { this.addScore('PERFORMANCE_TAILWIND', a.callsign, null, rs.name, `${Math.round(-wc.headKt)} kt tailwind`); if (chance(0.3)) return { ok: false, code: 'unable', reason: `Unable, ${Math.round(-wc.headKt)} kt tailwind, request the other runway` }; }
    this.answerRequest(a, ['ready']);
    a.plan.runway = rs.name;
    const condition: PendingCondition | null = lined || atHold ? null : { type: 'on_reaching_hold' };
    for (const r of this.bothEnds(rs.ref)) r.takeoffClearance = a.callsign;
    a.takeoffCleared = false;
    const eff = this.wakeTimerRemainingS(rs.name);
    if (rs.wakeTimer && eff === 0 && this.time - rs.wakeTimer.expiresAt < 10) this.addScore('WAKE_EFFICIENT', a.callsign, null, rs.name);
    const ast = makeAst('takeoff', a.callsign, { runway: rs.name, immediate: opts.immediate, afterDepHdg: opts.afterDepHdg, turn: opts.turn, initialAlt: opts.initialAlt, contactDeparture: opts.contactDeparture });
    return { ...this.enqueue(a, ast, { condition }), extra: { runway: rs.name, windDir: wc.headKt, wind: `${hdg3(this.wx().windDirTrue)}/${Math.round(this.wx().windKt)}` } };
  }
  private execTakeoff(a: AircraftState, runway: string, opts: { immediate: boolean; afterDepHdg: number | 'runway' | null; turn: { dir: TurnDir; deg: number } | null; initialAlt: number | null; contactDeparture: boolean }) {
    const rs = this.runwayState(runway); if (!rs) return;
    if (!['hold_short', 'lineup', 'taxi'].includes(a.phase)) return;
    a.clearance.depHdg = opts.afterDepHdg === 'runway' ? rs.headingTrue : opts.afterDepHdg;
    if (opts.turn) a.clearance.depHdg = ((rs.headingTrue + (opts.turn.dir === 'L' ? -opts.turn.deg : opts.turn.deg)) % 360 + 360) % 360;
    if (opts.initialAlt != null) a.clearance.initialAlt = opts.initialAlt;
    a.clearance.autoHandoffAlt = Math.min(3000, a.clearance.initialAlt);
    a.clearance.immediate = opts.immediate;
    const fromLineup = a.phase === 'lineup';
    a.rto = null;
    this.beginRoll(a, rs.name);
    const s = this.sc(a);
    // Spool-up 8-15 s from a standing start; rolling takeoff (from the hold) taxis on and goes without stopping.
    s.rollAt = this.time + (fromLineup ? rf(8, 15) : 0);
    a.holdReleased = true;
    if (!fromLineup) a.takeoffCleared = false;
  }
  /** Build the runway roll path and switch to `takeoff` (roll starts when takeoffCleared flips at rollAt). */
  private beginRoll(a: AircraftState, endName: string) {
    const rs = this.runwayState(endName)!; const r = this.runwayByEnd(endName)!;
    const thr = this.thresholdXY(endName)!;
    const far = advance(this.endXY(r.other), rs.headingTrue, 600);
    const raw: XY[] = [{ ...a.pos }];
    const alongNow = alongTrack(a.pos, thr, rs.headingTrue);
    const onLine = advance(thr, rs.headingTrue, Math.max(alongNow, 0) + 30);
    if (a.phase !== 'lineup') {
      const info = a.holdShortNode ? this.holdNodeInfo.get(a.holdShortNode) : undefined;
      if (info && info.ref === rs.ref) raw.push(this.nodeXY(info.runwayNodeId)!);
    }
    if (dist(raw[raw.length - 1], onLine) > 5) raw.push(onLine);
    raw.push(far);
    a.path = this.buildPath(raw, 'runway');
    a.distAlong = 0; a.holdReleased = true; a.takeoffCleared = false;
    a.holdShortNode = null; a.holdShortRunway = null;
    a.targetHeading = rs.headingTrue; a.plan.runway = rs.name;
    a.phase = 'takeoff'; this.manualHold.delete(a.id); a.trafficHold = false;
    this.addOccupant(rs.name, a, 'takeoff');
    this.sc(a).luawAt = null;
    this.emit('phase', a, `${a.callsign} -> takeoff ${rs.name}`);
  }
  cmdCancelTakeoff(a: AircraftState): EngineOutcome {
    const pending = a.pendingCmds.find(c => c.kind === 'takeoff');
    if (pending) { a.pendingCmds = a.pendingCmds.filter(c => c !== pending); this.clearTakeoffClearance(a); return { ...OK, extra: { phase: 'pending' } }; }
    if (a.phase !== 'takeoff') return { ok: false, code: 'invalid_stage', reason: a.phase === 'lineup' ? 'No takeoff clearance to cancel' : 'Not taking off' };
    if (!a.path) return { ok: false, code: 'past_abort_speed', reason: 'Airborne — use Go around' };
    const v1 = v1Kt(a.perf);
    if (a.speed >= v1) return { ok: false, code: 'past_abort_speed', reason: 'Past abort speed' };
    // < 80 kt: rejected takeoff; 80 kt-V1: high-speed reject (03 §A8)
    const hi = a.speed >= 80;
    a.rto = { at: this.time, speedKt: a.speed };
    a.takeoffCleared = false; a.holdReleased = false;
    this.clearTakeoffClearance(a);
    if (a.path) { a.path.holds = [{ nodeId: '', runway: a.plan.runway ?? '', at: Math.min(a.path.total, a.distAlong + this.brakingM(a.speed, hi ? 3.5 : 3.0) + HOLD_BUFFER_M), isDepartureEntry: false }]; a.path.holdAt = a.path.holds[0].at; }
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'takeoff');
    const s = this.sc(a); s.rollAt = null; s.rtoRecoverAt = this.time + (hi ? 1800 : rf(60, 120));
    this.emit('info', a, `${a.callsign} rejected takeoff at ${Math.round(a.speed)} kt${hi ? ' (high speed: brake cooling 30 min, runway inspection required)' : ''}`);
    if (a.speed > 5) this.addScore('GOOD_CATCH', a.callsign, null, a.plan.runway ?? null, 'takeoff cancelled on the roll');
    const rs = a.plan.runway ? this.runwayState(a.plan.runway) : undefined;
    if (hi && rs) this.setRunwayStatus(rs.name, 'inspection', 'high-speed RTO');
    return { ...OK, extra: { speed: Math.round(a.speed) } };
  }
  private brakingM(kt: number, mps2: number): number { const v = kt * KTS_TO_MPS; return (v * v) / (2 * mps2); }
  private clearTakeoffClearance(a: AircraftState) { for (const rs of this.runways) if (rs.takeoffClearance === a.callsign) rs.takeoffClearance = null; }
  cmdCancelLineup(a: AircraftState, via: string | null): EngineOutcome {
    if (a.phase !== 'lineup') return { ok: false, code: 'invalid_stage', reason: 'Not lined up' };
    if (via && !this.air.taxiwayNodes.has(upper(via))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(via)} here` };
    return this.enqueue(a, makeAst('cancelLineup', a.callsign, { via }));
  }
  private execCancelLineup(a: AircraftState, via: string | null) {
    if (a.phase !== 'lineup' || !a.plan.runway) return;
    const rs = this.runwayState(a.plan.runway)!;
    const exit = this.chooseExit(a, rs.ref, rs.headingTrue, 0, via ? upper(via) : null, true);
    if (!exit) { this.emit('readback', a, `Unable, no exit ahead, ${this.telephony(a.callsign)}`, { type: 'readback', status: 'unable', text: 'no exit', ast: null, refused: [] }); return; }
    this.exitViaTaxiway(a, rs, exit, true);
  }
  cmdExitAt(a: AircraftState, exit: ExitSpec, expedite: boolean, holdShortOf: HoldShortTarget | null, contactGround: boolean): EngineOutcome {
    if (a.phase !== 'landing' && a.phase !== 'rollout' && !(a.phase === 'approach' && a.ilsCaptured)) return { ok: false, code: 'invalid_stage', reason: 'Not landing' };
    if (a.phase === 'landing' && a.altitude < 500 && a.altitude > 0) return { ok: false, code: 'too_low', reason: 'Below 500 ft — too late for exit' };
    if (exit.kind === 'taxiway' && !this.air.taxiwayNodes.has(upper(exit.taxiway))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(exit.taxiway)} here` };
    if (a.phase === 'rollout' && exit.kind === 'taxiway' && a.plan.runway) {
      const rs = this.runwayState(a.plan.runway)!;
      const ex = this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, upper(exit.taxiway), false);
      if (!ex) return { ok: false, code: 'unable_exit', reason: `Unable ${upper(exit.taxiway)}, we'll take ${this.sc(a).exitPlan?.taxiway ?? 'the next one'}` };
    }
    return this.enqueue(a, makeAst('exitAt', a.callsign, { exit, expedite, holdShortOf, contactGround }));
  }
  private execExitAt(a: AircraftState, exit: ExitSpec, expedite: boolean, holdShortOf: HoldShortTarget | null, contactGround: boolean) {
    if (exit.kind === 'taxiway') { a.exitTaxiway = upper(exit.taxiway); a.exitDir = null; } else { a.exitDir = exit.dir; a.exitTaxiway = null; }
    if (expedite) a.expediteTaxiUntil = this.time + 90;
    if (holdShortOf?.kind === 'runway') a.lahsoHoldShortOf = upper(holdShortOf.runway);
    const s = this.sc(a);
    if (a.phase === 'rollout' && a.plan.runway) { const rs = this.runwayState(a.plan.runway)!; const ex = this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, a.exitTaxiway, false); if (ex) s.exitPlan = ex; }
    if (contactGround) { s.handoffTo = 'ground'; s.handoffAt = null; a.handedTo = 'ground'; }
  }
  cmdExpedite(a: AircraftState, on: boolean, scope: ExpediteScope): EngineOutcome {
    if (scope === 'climb' || scope === 'descent') { if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' }; }
    else if (isAirborne(a) && a.phase !== 'landing') return { ok: false, code: 'invalid_stage', reason: 'Airborne' };
    if (on && scope === 'taxi' && this.wx().runwayCondition !== 'dry') return { ok: false, code: 'unable', reason: 'Unable to expedite, runway wet' };
    return this.enqueue(a, makeAst('expedite', a.callsign, { on, scope }), { immediate: true });
  }
  private execExpedite(a: AircraftState, on: boolean, scope: ExpediteScope) {
    if (scope === 'climb' || scope === 'descent') a.expedite = on; else a.expediteTaxiUntil = on ? this.time + 90 : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — tower
  // ═══════════════════════════════════════════════════════════════════════════
  cmdClearedLand(a: AircraftState, runway: string, lahso: string | null, exit: ExitSpec | null): EngineOutcome {
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'rollout') return { ok: false, code: 'already', reason: 'Already landed' };
    if (a.landingCleared && a.plan.runway && this.refOf(a.plan.runway) === rs.ref) return { ok: false, code: 'already', reason: 'Already cleared' };
    if (!(a.ilsCaptured || a.phase === 'landing' || a.navMode === 'visual')) return { ok: false, code: 'invalid_stage', reason: a.ilsArmed ? 'Not established' : 'Not on approach' };
    const cur = a.plan.runway ?? a.assignedRunway;
    if (cur && this.refOf(cur) !== rs.ref) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're established on ${cur}, confirm runway ${rs.name}?` };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (rs.status !== 'open' && !a.emergency) return { ok: false, code: 'runway_closed', reason: `Runway ${rs.name} ${rs.status}` };
    if (this.holdAllBlocks(a, rs)) return { ok: false, code: 'held_by_emergency', reason: 'Traffic hold in effect' };
    if (this.settings.region === 'ICAO' && rs.landingClearances.length && !rs.landingClearances.includes(a.callsign)) return { ok: false, code: 'already', reason: `${rs.landingClearances[0]} already cleared to land — use Continue approach` };
    if (lahso && !this.runwayState(lahso)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${lahso}` };
    // Preconditions are reported and scored, never gated (03 §B4 trap mechanic)
    const occ = this.runwayOccupant(rs.name, a.id);
    if (occ) { this.safe('alerts', () => this.alerts.raise('occupied_runway_clearance', [a.callsign, occ], `Landing clearance with ${rs.name} occupied`, `${occ} on the runway`, this.time, { runway: rs.name }, [a.id]), undefined); }
    const wc = this.windFor(rs.headingTrue);
    if (-wc.headKt > 10) this.addScore('PERFORMANCE_TAILWIND', a.callsign, null, rs.name, `${Math.round(-wc.headKt)} kt tailwind`);
    this.answerRequest(a, ['confirm_cleared']);
    return { ...this.enqueue(a, makeAst('clearedLand', a.callsign, { runway: rs.name, lahso, exit })), extra: { runway: rs.name, occupant: occ, wind: `${hdg3(this.wx().windDirTrue)}/${Math.round(this.wx().windKt)}` } };
  }
  private execClearedLand(a: AircraftState, runway: string, lahso: string | null, exit: ExitSpec | null) {
    const rs = this.runwayState(runway); if (!rs) return;
    a.landingCleared = true; a.landingClearedAt = this.time;
    a.plan.runway = rs.name; if (!a.assignedRunway) a.assignedRunway = rs.name;
    a.lahsoHoldShortOf = lahso ? upper(lahso) : null;
    if (exit) { if (exit.kind === 'taxiway') a.exitTaxiway = upper(exit.taxiway); else a.exitDir = exit.dir; }
    this.setLandingClearance(rs, a.callsign, true);
    this.sc(a).continueApproach = false;
    this.emit('landing_clearance', a, `${a.callsign} cleared to land runway ${rs.name}`, { type: 'landing_clearance', runway: rs.name, cleared: true });
  }
  cmdContinueApproach(a: AircraftState, number: number | null): EngineOutcome {
    if (!isAirborne(a) || !(a.ilsArmed || a.phase === 'landing')) return { ok: false, code: 'invalid_stage', reason: 'Not on approach' };
    if (number != null) a.sequenceNo = number;
    this.answerRequest(a, ['confirm_cleared']);
    return this.enqueue(a, makeAst('continueApproach', a.callsign, { number }));
  }
  cmdGoAround(a: AircraftState, heading: number | 'runway' | null, alt: number | null, contact: Position | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'go_around' && heading == null && alt == null && contact == null) return { ok: false, code: 'already', reason: 'Already going around' };
    if (a.phase === 'rollout') return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    this.answerRequest(a, ['going_around']);
    const arr = a.plan.runway ? this.runwayOccupant(a.plan.runway, a.id) : null;
    const d = a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) : null;
    if (arr && d != null && d < 1.5 && a.phase !== 'go_around') this.addScore('SAFETY_GA', a.callsign, arr, a.plan.runway, 'go-around ordered with the runway occupied');
    return { ...this.enqueue(a, makeAst('goAround', a.callsign, { heading, alt, contact }), { immediate: a.phase !== 'go_around' }), extra: { alt: alt ?? this.missedApproachAltFt } };
  }
  private execGoAround(a: AircraftState, heading: number | 'runway' | null, alt: number | null, contact: Position | null) {
    if (a.phase !== 'go_around') this.initiateGoAround(a, 'ATC instruction', false);
    const rs = a.plan.runway ? this.runwayState(a.plan.runway) : undefined;
    if (heading === 'runway' && rs) a.targetHeading = rs.headingTrue;
    else if (typeof heading === 'number') { a.targetHeading = ((heading % 360) + 360) % 360; a.navMode = 'heading'; a.goAround = false; a.phase = 'climb'; }
    if (alt != null) { a.targetAltitude = alt; a.cmdAltitude = alt; }
    if (contact) this.execHandoff(a, contact);
  }
  /** Go-around: TOGA, runway heading, climb to the missed-approach altitude; `goAround` flag until re-vectored. */
  initiateGoAround(a: AircraftState, reason: string, playerCaused: boolean, scoreCode: ScoreCode | null = null, secondary: string | null = null) {
    const rw = a.plan.runway ?? a.assignedRunway;
    const rs = rw ? this.runwayState(rw) : undefined;
    if (rs) this.setLandingClearance(rs, a.callsign, false);
    a.landingCleared = false; a.landingClearedAt = null;
    a.ilsArmed = false; a.ilsCaptured = false; a.gsCaptured = false;
    a.navMode = 'heading'; a.path = null; a.distAlong = 0;
    a.targetHeading = rs ? rs.headingTrue : a.heading;
    a.targetAltitude = this.missedApproachAltFt; a.cmdAltitude = this.missedApproachAltFt;
    a.targetSpeed = Math.min(a.perf.maxAirspeedTMA, 200); a.cmdIas = null;
    a.speed = Math.max(a.speed, a.perf.approachSpeed + 10);
    if (a.altitude < 30) a.altitude = 30;
    a.phase = 'go_around'; a.goAround = true; a.goAroundCount++;
    a.turnDir = null;
    for (const r of this.runways) this.removeOccupant(r.ref, a.id);
    const s = this.sc(a); s.gaAt = this.time; s.continueApproach = false; s.queried4NM = false; s.exitPlan = null;
    this.emit('go_around', a, `${a.callsign} going around — ${reason}`);
    this.raiseRequest(a, 'going_around', reason);
    if (playerCaused) { this.stats.goAroundsPlayer++; if (scoreCode) this.addScore(scoreCode, a.callsign, secondary, rw ?? null, reason); }
    else this.stats.goAroundsPilot++;
    this.safe('alerts', () => this.alerts.raise('go_around', [a.callsign], `${a.callsign} going around`, reason, this.time, { runway: rw ?? null }, [a.id]), undefined);
    if (a.goAroundCount >= 2 && a.plan.kind === 'arrival') this.emit('info', a, `${a.callsign}: second go-around, requesting diversion consideration`, undefined, 'PILOT');
  }
  cmdWindCheck(a: AircraftState): EngineOutcome {
    this.answerRequest(a, ['wind_check']);
    const w = this.wx();
    return { ...OK, extra: { dir: w.windDirTrue, kts: w.windKt, gust: w.gustKt } };
  }
  cmdHandoff(a: AircraftState, position: Position, when: ContactWhen): EngineOutcome {
    if (a.onFrequency === position && a.handedTo == null) return { ok: false, code: 'already', reason: `Already on ${position}` };
    if (a.emergency?.type === 'radio_failure') return { ok: false, code: 'unable', reason: 'NORDO' };
    let condition: PendingCondition | null = null;
    if (when === 'when_vacated') condition = { type: 'after_vacated' };
    else if (when === 'on_reaching') condition = { type: 'at_or_above_alt', ft: a.clearance.autoHandoffAlt };
    else if (when === 'at_hold') condition = { type: 'on_reaching_hold' };
    this.answerRequest(a, ['runway_vacated']);
    if (position === 'external' && a.plan.kind === 'departure' && isAirborne(a)) this.addScore('DEPARTED_HANDOFF', a.callsign, null, a.plan.runway ?? null);
    if (a.plan.kind === 'arrival' && position === 'tower' && a.ilsCaptured) { const d = a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) : null; if (d != null && d < 4) this.addScore('HANDOFF_LATE', a.callsign, null, a.plan.runway ?? null, `handoff at ${d.toFixed(1)} NM`); }
    return { ...this.enqueue(a, makeAst('contact', a.callsign, { position, when }), { condition }), extra: { freq: this.frequencies[position] ?? '' } };
  }
  private execHandoff(a: AircraftState, position: Position) {
    a.handedTo = position;
    const s = this.sc(a);
    s.handoffTo = position; s.handoffAt = this.time + (this.settings.pilotDelayOverride != null ? 2 : rf(5, 15));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — approach
  // ═══════════════════════════════════════════════════════════════════════════
  private airborneOnly(a: AircraftState): EngineOutcome | null {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'landing' || (a.ilsCaptured && a.gsCaptured)) return { ok: false, code: 'invalid_stage', reason: 'On the glideslope — use Cancel approach' };
    return null;
  }
  cmdHeading(a: AircraftState, hdg: number, dir: TurnDir | null, when: PendingCondition | null): EngineOutcome {
    const g = this.airborneOnly(a); if (g) return g;
    if (a.phase === 'takeoff' && a.altitude < DEP_TURN_FT) when = when ?? { type: 'at_or_above_alt', ft: DEP_TURN_FT };
    const h = ((Math.round(hdg) % 360) + 360) % 360;
    if (a.emergency?.type === 'radio_failure') return { ok: false, code: 'unable', reason: 'NORDO' };
    a.turnDir = dir;
    this.answerRequest(a, ['further', 'hold']);
    const queried = a.ilsCaptured && chance(0.5);
    if (queried) return { ok: false, code: 'queried', reason: `${this.telephony(a.callsign)}, we're established on the localizer, confirm heading ${hdg3(h)}?` };
    return { ...this.enqueue(a, makeAst('heading', a.callsign, { hdg: h, dir, when }), { condition: when, value: h }), extra: { hdg: h } };
  }
  private execHeading(a: AircraftState, hdg: number, dir: TurnDir | null) {
    if (!isAirborne(a)) return;
    a.turnDir = dir;
    if (a.ilsCaptured || a.ilsArmed) { this.cancelIls(a); }
    a.navMode = 'heading'; a.targetHeading = ((hdg % 360) + 360) % 360;
    a.directTargetXY = null; a.directTargetName = null; a.holdFix = null; a.holdFixName = null;
    if (a.goAround) { a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; }
  }
  private cancelIls(a: AircraftState) {
    const rw = a.assignedRunway ?? a.plan.runway; const rs = rw ? this.runwayState(rw) : undefined;
    if (rs) this.setLandingClearance(rs, a.callsign, false);
    a.ilsArmed = false; a.ilsCaptured = false; a.gsCaptured = false; a.landingCleared = false; a.landingClearedAt = null;
    if (a.phase === 'approach') a.phase = 'cruise';
  }
  cmdAltitude(a: AircraftState, ft: number, expedite: boolean, when: PendingCondition | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'landing' || (a.gsCaptured && a.ilsCaptured)) return { ok: false, code: 'invalid_stage', reason: 'On glideslope — use Cancel approach' };
    const tgt = Math.max(0, Math.round(ft));
    if (tgt > 0 && tgt < 1000 && !a.emergency) return { ok: false, code: 'unable', reason: `Unable ${tgt}, minimum altitude 1000` };
    if (expedite && (Math.abs(tgt - a.altitude) < 300 || (tgt < a.altitude && a.altitude < 3000)) && chance(0.1)) return { ok: false, code: 'unable', reason: 'Unable to expedite' };
    a.cmdAltitude = tgt;
    this.answerRequest(a, ['higher', 'lower']);
    return { ...this.enqueue(a, makeAst('altitude', a.callsign, { ft: tgt, expedite, when }), { condition: when, value: tgt }), extra: { ft: tgt, verb: tgt >= a.altitude ? 'climb' : 'descend' } };
  }
  private execAltitude(a: AircraftState, ft: number, expedite: boolean) {
    a.targetAltitude = Math.max(0, ft); a.cmdAltitude = a.targetAltitude; a.expedite = expedite;
    if (a.goAround && a.phase === 'go_around' && ft !== this.missedApproachAltFt) { /* keeps go_around until a lateral instruction */ }
  }
  cmdSpeed(a: AircraftState, kts: number | 'resume', untilNM: number | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (kts !== 'resume') {
      const d = a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) : null;
      if (a.ilsCaptured && d != null && d < 5 && untilNM == null) return { ok: false, code: 'unable', reason: 'Unable, five-mile final' };
      if (kts < a.perf.minAirspeedTMA) return { ok: false, code: 'unable_envelope', reason: `Unable ${kts}, minimum clean ${a.perf.minAirspeedTMA}` };
      if (kts > a.perf.maxAirspeedTMA || (kts > 250 && a.altitude < 10000)) return { ok: false, code: 'unable_envelope', reason: `Unable ${kts}, maximum ${Math.min(a.perf.maxAirspeedTMA, a.altitude < 10000 ? 250 : 999)}` };
      if (a.emergency && EMERGENCY_CATALOGUE[a.emergency.type].noDelay && kts < a.speed) return { ok: false, code: 'unable', reason: 'Unable, emergency' };
      a.cmdIas = Math.round(kts);
    } else a.cmdIas = null;
    return { ...this.enqueue(a, makeAst('speed', a.callsign, { kts, untilNM }), { value: kts === 'resume' ? 0 : Math.round(kts), untilNM }), extra: { kts: kts === 'resume' ? null : Math.round(kts) } };
  }
  private execSpeed(a: AircraftState, kts: number | null, untilNM: number | null) {
    if (kts == null) { a.cmdIas = null; a.speedUntilNM = null; a.targetSpeed = a.ilsCaptured ? Math.min(a.targetSpeed, 200) : Math.min(a.perf.maxAirspeedTMA, 250); return; }
    a.targetSpeed = kts; a.cmdIas = kts; a.speedUntilNM = untilNM;
  }
  cmdDirect(a: AircraftState, fix: string, thenHdg: number | null): EngineOutcome {
    const g = this.airborneOnly(a); if (g) return g;
    const b = this.beacons.find(x => x.id === upper(fix));
    if (!b) return { ok: false, code: 'unknown_fix', reason: `Unable, ${upper(fix)} not in our database` };
    this.answerRequest(a, ['direct']);
    return this.enqueue(a, makeAst('direct', a.callsign, { fix: upper(fix), thenHdg }));
  }
  private execDirect(a: AircraftState, fix: string, thenHdg: number | null) {
    const b = this.beacons.find(x => x.id === upper(fix)); if (!b) return;
    a.directTargetXY = { x: b.x, y: b.y }; a.directTargetName = upper(fix);
    a.navMode = 'direct'; a.turnDir = null;
    if (a.ilsArmed) this.cancelIls(a);
    a.holdFix = null; a.holdFixName = null;
    if (a.goAround) { a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; }
    if (thenHdg != null) a.pendingCmds.push({ kind: 'heading', value: ((thenHdg % 360) + 360) % 360, applyAt: this.time, condition: { type: 'after_fix', fix: upper(fix) }, ast: makeAst('heading', a.callsign, { hdg: thenHdg }), issuedAt: this.time, cancellable: true });
  }
  cmdHold(a: AircraftState, fix: string, inbound: number | null, dir: TurnDir | null, legTimeMin: number | null, legNM: number | null, efc: number | null): EngineOutcome {
    const g = this.airborneOnly(a); if (g) return g;
    if (a.altitude < 1000) return { ok: false, code: 'too_low', reason: 'Below 1000 ft' };
    const b = this.beacons.find(x => x.id === upper(fix));
    if (!b) return { ok: false, code: 'unknown_fix', reason: `Unable, ${upper(fix)} not in our database` };
    if (a.emergency && EMERGENCY_CATALOGUE[a.emergency.type].noDelay) return { ok: false, code: 'unable', reason: 'Unable to hold, emergency' };
    this.answerRequest(a, ['hold', 'further']);
    return this.enqueue(a, makeAst('hold', a.callsign, { fix: upper(fix), inbound, dir, legTimeMin, legNM, efc }));
  }
  private execHold(a: AircraftState, fix: string, inbound: number | null, dir: TurnDir | null, legTimeMin: number | null, legNM: number | null, efc: number | null) {
    const b = this.beacons.find(x => x.id === upper(fix)); if (!b) return;
    a.holdFix = { x: b.x, y: b.y }; a.holdFixName = upper(fix);
    a.holdInboundHdg = inbound ?? headingTo(a.pos, { x: b.x, y: b.y });
    a.holdTurnDir = dir ?? 'R'; a.holdPhase = 'to_fix'; a.holdTimer = 0;
    a.holdLegMin = legTimeMin ?? (a.altitude > 14000 ? 1.5 : 1); a.holdLegNM = legNM; a.holdEfc = efc;
    a.navMode = 'hold'; a.turnDir = null;
    if (a.ilsArmed) this.cancelIls(a);
    if (a.goAround) { a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; }
    // holding speeds (AIM 5-3-8)
    const hs = a.altitude <= 6000 ? 200 : a.altitude <= 14000 ? 230 : 265;
    if (a.cmdIas == null || a.cmdIas > hs) a.targetSpeed = Math.min(a.targetSpeed, hs);
  }
  private ilsFor(runway: string): ILSRunway | null {
    const u = upper(runway);
    let ils = this.ilsRunways.find(r => r.name === u) ?? null;
    if (!ils) {
      const rs = this.runwayState(u); const r = this.runwayByEnd(u);
      if (!rs || !r) return null;
      ils = ilsFromGeometry(rs.name, this.endXY(r.end), rs.headingTrue, 0);
      this.ilsRunways.push(ils);
    }
    return ils;
  }
  cmdILS(a: AircraftState, runway: string): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (a.phase === 'landing') return { ok: false, code: 'already', reason: 'Already on final' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (!rs.activeArr && !a.emergency) return { ok: false, code: 'invalid_param', reason: `Runway ${rs.name} not active for arr` };
    if (rs.status !== 'open' && !a.emergency) return { ok: false, code: 'runway_closed', reason: `Runway ${rs.name} ${rs.status}` };
    const ils = this.ilsFor(rs.name); if (!ils) return { ok: false, code: 'no_ils', reason: 'No ILS on this airport' };
    if (a.ilsArmed && a.assignedRunway === rs.name) return { ok: false, code: 'already', reason: 'Already cleared' };
    if (a.plan.kind === 'arrival') this.answerRequest(a, ['further']);
    const along = distAlongFwd(a.pos, ils) / NM_TO_M;
    const high = along > 0.5 && aboveGlideslope(a.pos, a.altitude, ils);
    return { ...this.enqueue(a, makeAst('ils', a.callsign, { runway: rs.name })), extra: { runway: rs.name, estimated: !!ils.estimated, aboveGlideslope: high, alongNM: Math.round(along * 10) / 10 } };
  }
  private execILS(a: AircraftState, runway: string, locOnly = false, maintainAlt: number | null = null, issuedAt: number | null = null) {
    const rs = this.runwayState(runway); if (!rs) return;
    const ils = this.ilsFor(rs.name); if (!ils) return;
    a.assignedRunway = rs.name; a.plan.runway = rs.name;
    a.ilsArmed = true; a.ilsCaptured = false; a.gsCaptured = false;
    a.navMode = locOnly ? 'loc' : 'ils';
    a.holdFix = null; a.holdFixName = null; a.directTargetXY = null; a.directTargetName = null;
    // An approach clearance supersedes earlier vectors, never the intercept heading given in the same transmission
    // ("turn right heading 245, cleared ILS"): the parts of a sequence draw their own pilot delays, so the ILS part can
    // execute a second before its heading part.
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'heading' || (issuedAt != null && c.issuedAt != null && c.issuedAt >= issuedAt));
    if (maintainAlt != null) { a.targetAltitude = maintainAlt; a.cmdAltitude = maintainAlt; }
    a.landingCleared = false; a.landingClearedAt = null;
    if (a.goAround) { a.goAround = false; if (a.phase === 'go_around') a.phase = 'climb'; }
    a.underControl = true; a.attention = false;
    this.sc(a).overshootSaid = false; this.sc(a).queried4NM = false;
  }
  cmdLOC(a: AircraftState, runway: string, maintainAlt: number | null): EngineOutcome {
    const r = this.cmdILS(a, runway); if (!r.ok) return r;
    a.pendingCmds = a.pendingCmds.filter(c => c.kind !== 'ils');
    return { ...this.enqueue(a, makeAst('loc', a.callsign, { runway: upper(runway), maintainAlt })), extra: r.extra };
  }
  cmdVisual(a: AircraftState, runway: string, follow: string | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    const w = this.wx();
    if (w.visM < 4800 || (w.ceilingFt != null && w.ceilingFt < 1500)) return { ok: false, code: 'unable', reason: 'Negative contact, IMC' };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    if (follow && !this.find(follow)) return { ok: false, code: 'not_found', reason: `No aircraft ${follow}` };
    return this.enqueue(a, makeAst('visual', a.callsign, { runway: rs.name, follow }));
  }
  private execVisual(a: AircraftState, runway: string) {
    // Visual approach: self-navigate to a 4 NM final then join the (estimated) ILS geometry.
    this.execILS(a, runway);
    a.navMode = 'visual';
    const ils = this.ilsFor(runway)!;
    const join = advance(ils.thrXY, (ils.rwdHdg + 180) % 360, 4 * NM_TO_M);
    a.directTargetXY = join; a.directTargetName = `FINAL ${upper(runway)}`;
    a.targetSpeed = Math.min(a.targetSpeed, 180);
    a.targetAltitude = Math.min(a.targetAltitude, 1500);
  }
  cmdCancelApproach(a: AircraftState, hdg: number, alt: number, dir: TurnDir | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (!a.ilsArmed && a.phase !== 'landing') return { ok: false, code: 'invalid_stage', reason: 'Not on approach' };
    const d = a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) : null;
    if (a.phase === 'landing' && d != null && d < 2) return { ok: false, code: 'invalid_stage', reason: 'Use Go around' };
    return this.enqueue(a, makeAst('cancelApproach', a.callsign, { hdg, alt, dir }));
  }
  private execCancelApproach(a: AircraftState, hdg: number, alt: number, dir: TurnDir | null) {
    if (a.phase === 'landing') { a.path = null; a.distAlong = 0; a.phase = 'climb'; }
    this.cancelIls(a);
    a.assignedRunway = null;
    this.execHeading(a, hdg, dir); this.execAltitude(a, alt, false);
  }
  cmdExpectRunway(a: AircraftState, runway: string, approach: ApproachType): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (!this.weightAllowed(rs.name, a.perf.weightClass)) return { ok: false, code: 'weight_class', reason: `${a.perf.weightClass} category not permitted on ${rs.name}` };
    return this.enqueue(a, makeAst('expectRunway', a.callsign, { runway: rs.name, approach }));
  }
  cmdResumeSid(a: AircraftState): EngineOutcome {
    if (!isAirborne(a) || a.plan.kind !== 'departure') return { ok: false, code: 'invalid_stage', reason: 'Not a departure' };
    if (a.navMode === 'sid') return { ok: false, code: 'already', reason: 'Already on the SID' };
    return this.enqueue(a, makeAst('resumeSid', a.callsign));
  }
  cmdSquawk(a: AircraftState, code: string): EngineOutcome {
    if (!/^[0-7]{4}$/.test(code)) return { ok: false, code: 'invalid_param', reason: 'Squawk must be four octal digits' };
    return this.enqueue(a, makeAst('squawk', a.callsign, { code }));
  }
  cmdIdent(a: AircraftState): EngineOutcome { return this.enqueue(a, makeAst('ident', a.callsign)); }
  cmdRadarContact(a: AircraftState, descendTo: number | null, expectRunway: string | null): EngineOutcome {
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    if (expectRunway && !this.runwayState(expectRunway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${expectRunway}` };
    this.answerRequest(a, ['with_you']);
    a.underControl = true; a.attention = false;
    return this.enqueue(a, makeAst('radarContact', a.callsign, { descendTo, expectRunway }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — meta
  // ═══════════════════════════════════════════════════════════════════════════
  cmdSayAgain(a: AircraftState): EngineOutcome {
    if (a.lastTransmissionAt < 0) return { ok: false, code: 'nothing_pending', reason: 'Nothing to repeat' };
    const text = a.readback.text || a.requests[0]?.text || '';
    if (text) this.readbacks.push({ at: this.time + rf(1.5, 3), aircraftId: a.id, status: a.readback.status === 'none' ? 'ok' : a.readback.status, text: `I say again, ${text}`, ast: a.readback.lastAst, refused: [], mismatch: null });
    return OK;
  }
  cmdCorrection(a: AircraftState, field: CorrectionField, value: number | string): EngineOutcome {
    const m = a.readback.mismatch;
    if (m) { a.readback.mismatch = null; a.readback.status = 'ok'; }
    const kindOf: Partial<Record<CorrectionField, PendingCmd['kind']>> = { heading: 'heading', altitude: 'altitude', speed: 'speed' };
    const kind = kindOf[field];
    if (kind) {
      const num = typeof value === 'number' ? value : parseInt(String(value), 10);
      if (!isFinite(num)) return { ok: false, code: 'invalid_param', reason: 'Numeric value required' };
      const p = a.pendingCmds.find(c => c.kind === kind);
      const ast = makeAst(kind as 'heading', a.callsign, kind === 'heading' ? { hdg: num } : kind === 'altitude' ? ({ ft: num } as never) : ({ kts: num } as never));
      if (p) { p.value = num; p.ast = ast; p.applyAt = this.time + this.pilotDelayS(a, kind); p.issuedAt = this.time; }
      else return this.enqueue(a, ast, { value: num });
      return { ok: true, code: 'ok_queued', applyAt: p.applyAt };
    }
    if (!m && !a.readback.lastAst) return { ok: false, code: 'nothing_pending', reason: 'Nothing to correct' };
    return OK;
  }
  cmdDisregard(a: AircraftState): EngineOutcome {
    for (let i = a.pendingCmds.length - 1; i >= 0; i--) {
      const c = a.pendingCmds[i];
      if (c.cancellable === false) continue;
      a.pendingCmds.splice(i, 1);
      if (c.kind === 'takeoff') this.clearTakeoffClearance(a);
      if (c.kind === 'altitude') a.cmdAltitude = a.targetAltitude;
      if (c.kind === 'speed') a.cmdIas = null;
      return { ...OK, extra: { kind: c.kind } };
    }
    return { ok: false, code: 'nothing_pending', reason: 'Nothing pending' };
  }
  cmdStandby(a: AircraftState): EngineOutcome {
    a.standbyUntil = this.time + 120;
    const req = a.requests[0];
    if (req) { req.recallAt = this.time + 120; }
    return OK;
  }
  cmdUnable(a: AircraftState, reason: UnableReason): EngineOutcome {
    const req = a.requests[0];
    if (!req) return { ok: false, code: 'nothing_pending', reason: 'No request pending' };
    this.answerRequest(a, 'any');
    const s = this.sc(a);
    const delay = reason === 'delay' || reason === 'slot' ? rf(120, 240) : rf(60, 120);
    s.nextRequestAt = this.time + delay; s.nextRequestKind = req.kind === 'with_you' ? null : req.kind;
    return { ...OK, extra: { reason } };
  }
  cmdReport(a: AircraftState, items: ReportKind[]): EngineOutcome {
    const cs = this.telephony(a.callsign);
    const lines: string[] = [];
    for (const it of items.length ? items : ['position' as ReportKind]) {
      switch (it) {
        case 'position': lines.push(isAirborne(a) ? `${Math.round(dist(a.pos, this.centerXY) / NM_TO_M)} miles from the field, ${Math.round(a.altitude / 100) * 100} feet` : `${a.phase === 'parked' ? `stand ${a.plan.gateRef}` : a.holdShortRunway ? `holding short ${a.holdShortRunway}` : 'on the taxiway'}`); break;
        case 'heading': lines.push(`heading ${hdg3(a.heading - this.magVar)}`); break;
        case 'altitude': lines.push(`${a.altitude > a.targetAltitude + 50 ? 'descending through' : a.altitude < a.targetAltitude - 50 ? 'climbing through' : 'maintaining'} ${Math.round(a.altitude / 100) * 100}`); break;
        case 'airspeed': lines.push(`${Math.round(a.speed)} knots`); break;
        case 'pob': lines.push(`${a.emergency?.soulsOnBoard ?? this.soulsFor(a)} on board`); break;
        case 'fuel': lines.push(`fuel ${Math.round(a.fuelMin ?? 90)} minutes`); break;
        case 'nature': lines.push(a.emergency ? a.emergency.type.replace('_', ' ') : 'no emergency'); break;
        case 'dg': lines.push('no dangerous goods'); break;
        case 'intentions': lines.push(a.emergency ? (a.emergency.requests[0] ?? 'request priority landing') : 'as filed'); break;
        case 'established': lines.push(a.ilsCaptured ? `established localizer ${a.assignedRunway}` : 'not yet established'); break;
        case 'vacated': lines.push(this.sc(a).vacated ? 'runway vacated' : 'still on the runway'); break;
        case 'ready': lines.push(a.phase === 'hold_short' ? 'ready for departure' : 'not yet ready'); break;
        case 'reason': lines.push(a.requests[0]?.text ?? 'no reason'); break;
        case 'readyou5': lines.push('read you five'); this.answerRequest(a, ['radio_check']); break;
        case 'four_mile_final': lines.push(`${(a.plan.runway ? this.distToThresholdNM(a, a.plan.runway) ?? 0 : 0).toFixed(0)} mile final`); break;
        case 'rolling': lines.push(a.phase === 'takeoff' ? 'rolling' : 'holding'); break;
      }
    }
    if (a.emergency && items.some(i => i === 'pob' || i === 'fuel')) this.checklist(a, 'souls_fuel');
    this.readbacks.push({ at: this.time + rf(2, 4), aircraftId: a.id, status: 'ok', text: `${lines.join(', ')}, ${cs}.`, ast: null, refused: [], mismatch: null });
    return { ...OK, extra: { items: items.join(',') } };
  }
  private soulsFor(a: AircraftState): number { const [lo, hi] = SOULS_BY_CLASS[a.perf.weightClass]; return lo + ri(hi - lo + 1); }
  cmdRoger(a: AircraftState): EngineOutcome { this.answerRequest(a, 'any'); return OK; }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EngineCommandApi — emergency + system
  // ═══════════════════════════════════════════════════════════════════════════
  private checklist(a: AircraftState, item: Parameters<typeof completeChecklistItem>[1]) {
    if (!a.emergency) return;
    const ev = this.safe('emergencies', () => completeChecklistItem(a, item, this.time), null);
    if (ev) this.applyScore(ev);
    else if (a.emergency.checklist[item] == null) a.emergency.checklist[item] = this.time;
  }
  cmdEmergencyAck(a: AircraftState, ask: EmergencyInfoKind[], squawk: boolean): EngineOutcome {
    const e = a.emergency; if (!e) return { ok: false, code: 'invalid_stage', reason: 'No emergency' };
    if (e.status === 'declared') e.status = 'acknowledged';
    this.checklist(a, 'acknowledge');
    if (ask.includes('pob') || ask.includes('fuel')) this.checklist(a, 'souls_fuel');
    if (squawk && e.squawk) a.squawk = e.squawk;
    const reply = this.safe('emergencies', () => ackReplyLine(a, this.telephony(a.callsign)), '') || `${e.soulsOnBoard} souls on board, fuel ${Math.round(e.fuelMin ?? a.fuelMin ?? 60)} minutes, ${this.telephony(a.callsign)}.`;
    this.readbacks.push({ at: this.time + rf(2, 4), aircraftId: a.id, status: 'ok', text: reply, ast: null, refused: [], mismatch: null });
    this.emit('emergency', a, `${a.callsign} emergency acknowledged`, { type: 'emergency', emergency: e, change: 'acknowledged' }, 'SYS');
    return OK;
  }
  cmdPriority(a: AircraftState, runway: string, opts: { straightIn: boolean; numberOne: boolean; sterile: boolean; clearIls: boolean }): EngineOutcome {
    const e = a.emergency; if (!e) return { ok: false, code: 'invalid_stage', reason: 'No emergency' };
    const rs = this.runwayState(runway); if (!rs) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    if (!isAirborne(a)) return { ok: false, code: 'invalid_stage', reason: 'On the ground' };
    return { ...this.enqueue(a, makeAst('priority', a.callsign, { runway: rs.name, ...opts })), extra: { runway: rs.name } };
  }
  private execPriority(a: AircraftState, runway: string, opts: { straightIn: boolean; numberOne: boolean; sterile: boolean; clearIls: boolean }) {
    const e = a.emergency; const rs = this.runwayState(runway); if (!e || !rs) return;
    e.runway = rs.name; e.priority = true; a.priority = true; a.sequenceNo = opts.numberOne ? 1 : a.sequenceNo;
    a.plan.runway = rs.name;
    this.checklist(a, 'priority_runway');
    if (opts.sterile) { e.sterile = true; this.setRunwayStatus(rs.name, 'sterile', `emergency ${a.callsign}`); this.checklist(a, 'hold_traffic'); }
    if (opts.clearIls) this.execILS(a, rs.name);
    if (e.status === 'declared') e.status = 'acknowledged';
    this.emit('emergency', a, `${a.callsign} priority runway ${rs.name}`, { type: 'emergency', emergency: e, change: 'update' }, 'SYS');
  }
  cmdStopOnRunway(a: AircraftState, mode: 'stop' | 'vacate_if_able', via: string | null): EngineOutcome {
    if (!a.emergency) return { ok: false, code: 'invalid_stage', reason: 'No emergency' };
    if (via && !this.air.taxiwayNodes.has(upper(via))) return { ok: false, code: 'unknown_taxiway', reason: `No taxiway ${upper(via)} here` };
    return this.enqueue(a, makeAst('stopOnRunway', a.callsign, { mode, via }));
  }
  cmdEmergencyCancelAck(a: AircraftState): EngineOutcome {
    const e = a.emergency; if (!e) return { ok: false, code: 'invalid_stage', reason: 'No emergency' };
    this.answerRequest(a, ['cancel_mayday']);
    this.resolveEmergency(a, 'cancelled by pilot');
    return OK;
  }
  private resolveEmergency(a: AircraftState, reason: string) {
    const e = a.emergency; if (!e || e.status === 'resolved') return;
    e.status = 'resolved'; e.resolvedAt = this.time;
    a.priority = false;
    const evs = this.safe('emergencies', () => scoreOnResolved(a, this.time), null);
    if (evs) for (const ev of evs) this.applyScore(ev); else this.addScore('EMERGENCY_DONE', a.callsign, null, e.runway, reason);
    this.stats.emergenciesResolved++;
    this.emit('emergency', a, `${a.callsign} emergency resolved (${reason})`, { type: 'emergency', emergency: e, change: 'resolved' }, 'SYS');
    this.safe('alerts', () => { for (const al of this.alerts.active()) if (al.kind === 'emergency' && al.subjects[0] === a.callsign) this.alerts.resolve(al.id, this.time); }, undefined);
    if (e.sterile && e.runway) { const rs = this.runwayState(e.runway); if (rs && rs.status === 'sterile') this.setRunwayStatus(rs.name, 'open', 'emergency resolved'); }
  }
  /** Declare an emergency on an aircraft (random hook or test API forceEmergency). */
  declareEmergency(a: AircraftState, type: EmergencyType): Emergency {
    const stage = this.stageOf(a);
    const spec = EMERGENCY_CATALOGUE[type];
    const souls = this.soulsFor(a);
    const fuel = spec.fuelMin ? Math.round(rf(spec.fuelMin[0], spec.fuelMin[1])) : null;
    const rwy = this.bestRunwayFor(a, spec.runwayPreference);
    const e = createEmergency(type, a, stage, this.time, souls, fuel, this.telephony(a.callsign), rwy);
    return this.attachEmergency(a, e);
  }
  private attachEmergency(a: AircraftState, e: Emergency): Emergency {
    a.emergency = e; a.priority = true;
    if (e.squawk) a.squawk = e.squawk;
    if (e.fuelMin != null) a.fuelMin = e.fuelMin;
    this.stats.emergenciesDeclared++;
    const before = this.pendingEvents.length;
    this.safe('emergencies', () => onDeclared(this.emergencyView(), a), undefined);
    const emitted = this.pendingEvents.slice(before).some(ev => ev.type === 'emergency');
    if (!emitted) this.emit('emergency', a, e.pilotLine || `${a.callsign} squawking ${e.squawk ?? '7700'}`, { type: 'emergency', emergency: e, change: 'declared' });
    this.safe('alerts', () => this.alerts.raise('emergency', [a.callsign], `${e.level} ${a.callsign}`, e.type.replace('_', ' '), this.time, { runway: e.runway }, [a.id]), undefined);
    if (a.navMode === 'hold' && EMERGENCY_CATALOGUE[e.type].noDelay) { a.navMode = 'heading'; a.targetHeading = a.heading; }
    return e;
  }
  bestRunwayFor(a: AircraftState, pref: 'nearest' | 'longest' | 'any'): string | null {
    const cands = this.runways.filter(r => r.status === 'open' && this.weightAllowed(r.name, a.perf.weightClass) && (r.activeArr || pref !== 'any'));
    if (!cands.length) return this.runways[0]?.name ?? null;
    if (pref === 'longest') return cands.reduce((b, r) => (r.lengthM > b.lengthM ? r : b)).name;
    const thr = (r: RunwayState) => this.thresholdXY(r.name)!;
    const scored = cands.map(r => ({ r, d: dist(a.pos, thr(r)) + (r.activeArr ? 0 : 3000) + Math.abs(-this.windFor(r.headingTrue).headKt) * 200 }));
    return scored.reduce((b, x) => (x.d < b.d ? x : b)).r.name;
  }
  private emergencyView(): EmergencyEngineView {
    return {
      time: this.time, aircraft: this.aircraft, stageOf: (a) => this.stageOf(a),
      bestRunway: (a, pref) => this.bestRunwayFor(a, pref),
      setRunwayStatus: (rw, st, reason) => { this.setRunwayStatus(rw, st, reason); },
      emit: (ev) => this.pushEvent(ev),
      score: (ev) => { this.applyScore(ev); },
      telephony: (cs) => this.telephony(cs),
    };
  }
  private holdAllBlocks(a: AircraftState, rs: RunwayState): boolean {
    const h = this.holdAllActive; if (!h || a.emergency) return false;
    if (h.runway && this.refOf(h.runway) !== rs.ref) return false;
    return h.scope === 'all' || h.scope === 'departures';
  }
  holdAll(scope: HoldAllScope, runway: string | null): EngineOutcome {
    if (runway && !this.runwayState(runway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    this.holdAllActive = { scope, runway: runway ? upper(runway) : null };
    for (const a of this.aircraft) if (!a.emergency && !isAirborne(a) && a.phase !== 'parked' && a.phase !== 'arrived') { a.heldByEmergency = true; if (scope === 'all' && (a.phase === 'taxi' || a.phase === 'hold_short')) { a.trafficHold = true; this.manualHold.add(a.id); } }
    for (const a of this.aircraft) if (a.emergency) this.checklist(a, 'hold_traffic');
    this.emit('info', null, `All stations, hold position${runway ? `, runway ${runway}` : ''}, emergency in progress.`, undefined, 'ATC');
    return OK;
  }
  resumeAll(): EngineOutcome {
    if (!this.holdAllActive) return { ok: false, code: 'nothing_pending', reason: 'No traffic hold active' };
    this.holdAllActive = null;
    for (const a of this.aircraft) { if (a.heldByEmergency) { a.heldByEmergency = false; this.manualHold.delete(a.id); a.trafficHold = false; } }
    this.emit('info', null, 'All stations, resume normal operations.', undefined, 'ATC');
    return OK;
  }
  dispatchVehicle(type: VehicleType, ids: string[], count: number, target: VehicleTarget): EngineOutcome {
    if (target.kind === 'runway' && !this.runwayState(target.runway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${target.runway}` };
    if (target.kind === 'aircraft' && !this.byId(target.id) && !this.find(target.callsign)) return { ok: false, code: 'not_found', reason: `No aircraft ${target.callsign}` };
    if (target.kind === 'stand' && !this.gateByRef(target.ref)) return { ok: false, code: 'unknown_stand', reason: `Unknown stand ${target.ref}` };
    if (!this.sys.fleet) return { ok: false, code: 'not_implemented', reason: 'Vehicles not available' };
    const res = this.safe('fleet', () => this.fleet.dispatch(type, target, ids, count), null);
    if (!res) return { ok: false, code: 'not_implemented', reason: 'Vehicles not available' };
    if (!res.ok) return { ok: false, code: 'vehicle_unavailable', reason: res.reason ?? 'No vehicle available' };
    for (const v of res.vehicles) this.emit('vehicle', null, `${v.callsign} -> ${describeTarget(target)}${res.etaAt != null ? `, ETA ${Math.round(res.etaAt - this.time)} s` : ''}`, { type: 'vehicle', vehicleId: v.id, state: v.state, target, etaS: res.etaAt != null ? res.etaAt - this.time : null });
    // Emergency checklist hooks
    const subject = target.kind === 'aircraft' ? (this.byId(target.id) ?? this.find(target.callsign)) : this.aircraft.find(a => a.emergency && a.emergency.status !== 'resolved' && (target.kind !== 'runway' || !a.emergency.runway || this.refOf(a.emergency.runway) === this.refOf(target.runway)));
    if (subject?.emergency) {
      const e = subject.emergency; const s = this.sc(subject);
      if (type === 'arff') { e.arff = res.vehicles.length >= 3 ? 'full' : 'local'; if (e.status === 'acknowledged' || e.status === 'declared') e.status = 'services_dispatched'; this.checklist(subject, 'arff'); s.arffDispatchedAt = s.arffDispatchedAt ?? this.time; }
      if (type === 'ambulance') this.checklist(subject, 'ambulance');
      this.emit('emergency', subject, `${subject.callsign}: ${type} dispatched`, { type: 'emergency', emergency: e, change: 'services' }, 'SYS');
    }
    return { ...OK, extra: { count: res.vehicles.length, etaS: res.etaAt != null ? Math.round(res.etaAt - this.time) : null } };
  }
  recallVehicle(id: string): EngineOutcome {
    const v = this.fleet.byId(id); if (!v) return { ok: false, code: 'unknown_vehicle', reason: `Unknown vehicle ${id}` };
    const ok = this.safe('fleet', () => this.fleet.recall(id), false);
    if (!ok) return { ok: false, code: 'already', reason: `${v.callsign} already at station` };
    this.emit('vehicle', null, `${v.callsign} returning to station`, { type: 'vehicle', vehicleId: v.id, state: v.state, target: { kind: 'station' }, etaS: null });
    return OK;
  }
  vehicleOp(id: string, op: 'hold' | 'continue' | 'cross' | 'rtb', runway: string | null): EngineOutcome {
    const v = this.fleet.byId(id); if (!v) return { ok: false, code: 'unknown_vehicle', reason: `Unknown vehicle ${id}` };
    if (op === 'cross' && runway && !this.runwayState(runway)) return { ok: false, code: 'unknown_runway', reason: `Unknown runway ${runway}` };
    const ok = this.safe('fleet', () => this.fleet.op(id, op, runway), false);
    if (!ok) return { ok: false, code: 'invalid_stage', reason: `${v.callsign}: cannot ${op} now` };
    this.emit('vehicle', null, `${v.callsign} ${op === 'rtb' ? 'return to base' : op === 'cross' ? `cross runway ${runway ?? ''}` : op}`, { type: 'vehicle', vehicleId: v.id, state: v.state, target: v.target, etaS: null });
    return OK;
  }
  broadcast(text: string): EngineOutcome {
    if (!text.trim()) return { ok: false, code: 'invalid_param', reason: 'Empty broadcast' };
    this.emit('info', null, `All stations, ${this.airportName}, ${text}`, undefined, 'ATC');
    for (const a of this.aircraft) if (a.emergency?.type === 'hijack' && /hijack|seven five|7500/i.test(text)) this.addScore('EMERGENCY_CHECKLIST_MISS', a.callsign, null, null, 'hijack discussed on frequency');
    return OK;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Main loop
  // ═══════════════════════════════════════════════════════════════════════════
  /** Real-time driver: accumulates dt (clamped, B18) and runs fixed substeps; one post pass per call. */
  update(realDt: number): SimEvent[] {
    if (this.paused) { const out = this.pendingEvents; this.pendingEvents = []; return out; }
    this.acc = Math.min(this.acc + Math.min(realDt, 0.25), FIXED * MAX_SUBSTEPS);
    let steps = 0;
    while (this.acc >= FIXED && steps < MAX_SUBSTEPS) { this.substep(); this.acc -= FIXED; steps++; }
    if (steps > 0) this.postPass(steps * FIXED);
    const out = this.pendingEvents; this.pendingEvents = [];
    return out;
  }
  /** Deterministic driver: exactly `n` fixed substeps, then one post pass. Returns the events. */
  step(n = 1): SimEvent[] {
    for (let i = 0; i < n; i++) this.substep();
    if (n > 0) this.postPass(n * FIXED);
    const out = this.pendingEvents; this.pendingEvents = [];
    return out;
  }
  private substep() {
    const ctx = this.stepCtx();
    for (const a of this.aircraft) this.drainPending(a);
    this.applyNavTargets();
    this.applyTraffic();
    for (const a of this.aircraft) stepAircraft(a, FIXED, ctx);
    this.stepSystems();
    this.handleTransitions();
    this.processReadbacks();
    const sec = Math.floor(this.time);
    if (sec !== this.lastSecond) { this.lastSecond = sec; this.perSecond(); }
    this.time += FIXED;
    this.stats.simTime = this.time;
  }
  private postPass(dt: number) {
    this.checkSeparation();
    this.checkIncursions();
    this.stepAlerts(dt);
    this.stats.streakS += dt;
  }
  private stepCtx(): StepCtx {
    const wx = this.wx();
    return {
      time: this.time,
      wind: (hdg, tas) => applyWind(wx, hdg, tas),
      headwindKt: (rwyHdg) => windComponents(wx.windDirTrue, wx.windKt, rwyHdg).headKt,
      surfaceFactor: () => SURFACE_FACTOR[wx.runwayCondition],
      taxiSpeedCapKt: (a) => this.taxiSpeedCap(a),
      emit: (type, a, message, data) => { this.emit(type, a, message, data); },
      setPhase: (a, phase) => { if (a.phase !== phase) { a.phase = phase; this.emit('phase', a, `${a.callsign} -> ${phase}`); } },
    };
  }
  /** Progressive taxi cap: apron 10 kt, crossing a runway 12 kt, expedite +30 % (heavies +15 %), single-engine taxi 30 kt cap. */
  private taxiSpeedCap(a: AircraftState): number {
    let cap = a.perf.maxTaxiSpeed;
    if (a.path) {
      const near = this.gates.some(g => dist(this.gateXY(g), a.pos) < 90);
      if (near || (a.plan.kind === 'departure' && a.distAlong < 120) || (a.plan.kind === 'arrival' && a.path.total - a.distAlong < 200)) cap = Math.min(cap, 10);
    }
    if (this.sc(a).crossingRef) cap = Math.min(cap, 12);
    if (this.time < a.expediteTaxiUntil) cap = Math.min(cap * (a.wakeCategory === 'HEAVY' || a.wakeCategory === 'SUPER' ? 1.15 : 1.3), 25);
    if (a.emergency?.type === 'engine_failure') cap = Math.min(cap, 30);
    return cap;
  }
  private stepSystems() {
    // vehicles
    if (this.sys.fleet) {
      const ctx: VehicleStepCtx = {
        time: this.time, air: this.air, nodeXY: (id) => this.nodeXY(id), nearestNodeId: (p) => this.nearestNodeId(p),
        pathFromNodes: (ids) => this.pathFromNodes(ids), runways: this.runways, aircraft: this.aircraft,
        crossingSafe: (rw) => this.crossingSafe(rw, 25), autoCross: false,
      };
      const res = this.safe('fleet', () => this.fleet.step(FIXED, ctx), null);
      if (res) {
        // events the fleet queued between steps (dispatch / recall) carry its last step time: stamp them with the current time so the stream stays monotonic
        for (const ev of res.events) this.pushEvent(ev.at < this.time ? { ...ev, at: this.time } : ev);
        for (const e of res.enteredRunway) { const rs = this.bothEnds(e.runway)[0] ?? this.runwayState(e.runway); const v = this.fleet.byId(e.vehicleId); if (rs && v) this.addOccupant(rs.name, { id: v.id, callsign: v.callsign }, 'vehicle'); }
        for (const e of res.vacatedRunway) { const rs = this.bothEnds(e.runway)[0] ?? this.runwayState(e.runway); if (rs) this.removeOccupant(rs.ref, e.vehicleId); }
        for (const r of res.crossingRequests) {
          const v = this.fleet.byId(r.vehicleId);
          if (v && !this.pendingEvents.some(ev => ev.type === 'request' && ev.callsign === v.id)) {
            const req: PilotRequest = { id: ++this.reqSeq, kind: 'cross', callsign: v.id, text: `Ground, ${v.callsign}, request cross runway ${r.runway}.`, param: r.runway, at: this.time, recallAt: this.time + 45, recalls: 0, expiresAt: null, suggestedAction: null, answeredAt: null, answeredBy: null };
            this.pushEvent({ type: 'request', id: -1, callsign: v.id, message: req.text, at: this.time, data: { type: 'request', request: req, change: 'raised' } });
          }
        }
      }
    }
    // weather
    if (this.sys.weather) {
      const res = this.safe('weather', () => this.weather.step(FIXED), null);
      if (res) {
        for (const ev of res.events) this.pushEvent(ev.at < this.time ? { ...ev, at: this.time } : ev);
        if (res.atisChanged || res.suggestion) this.onWeatherChange(res.suggestion);
      }
    }
  }
  private onWeatherChange(suggestion: { dep: string[]; arr: string[]; reason: string } | null) {
    const w = this.wx();
    for (const rs of this.runways) { const c = windComponents(w.windDirTrue, w.windKt, rs.headingTrue); rs.windHeadKt = c.headKt; rs.windCrossKt = c.crossKt; }
    const curDep = this.activeEnds('dep').map(r => r.name).sort(), curArr = this.activeEnds('arr').map(r => r.name).sort();
    let sug = suggestion;
    if (!sug) sug = this.safe('weather', () => this.weather.suggestRunways(this.manifestEnds(), { dep: curDep, arr: curArr }), null);
    if (sug && (sug.dep.slice().sort().join() !== curDep.join() || sug.arr.slice().sort().join() !== curArr.join())) {
      const key = `${sug.dep.join('/')}|${sug.arr.join('/')}`;
      this.suggestedRunways = sug;
      if (key !== this.lastSuggestionKey) {
        this.lastSuggestionKey = key;
        const atis = this.safe('weather', () => this.weather.atis(), null);
        const msg = `Wind ${hdg3(w.windDirTrue)}/${Math.round(w.windKt)}${w.gustKt ? `G${Math.round(w.gustKt)}` : ''} — runway ${sug.arr.join('/')} recommended (current ${curArr.join('/')}). ${sug.reason}`;
        if (atis) this.emit('atis', null, msg, { type: 'atis', atis, reason: `runway change suggested: ${sug.reason}` });
        const rs = this.runwayState(sug.dep[0] ?? sug.arr[0]);
        if (rs) this.emit('runway_state', null, msg, { type: 'runway_state', runway: rs.name, status: rs.status, previous: rs.status, reason: `suggested: ${sug.reason}` });
      }
    } else { this.suggestedRunways = null; this.lastSuggestionKey = ''; }
  }
  /** Force a wind change (test hook / scenario); re-evaluates the runway suggestion immediately. */
  setWind(dirTrue: number, kts: number, gust = 0) {
    this.safe('weather', () => this.weather.setWind(dirTrue, kts, gust), undefined);
    if (!this.sys.weather) { const w = this.weather.state(); w.windDirTrue = dirTrue; w.windKt = kts; w.gustKt = gust; w.updatedAt = this.time; }
    this.onWeatherChange(null);
  }

  // ── nav targets (every substep, before physics) ─────────────────────────────
  private applyNavTargets() {
    for (const a of this.aircraft) {
      if (!isAirborne(a) || a.phase === 'landing') continue;
      const s = this.sc(a);
      // --- HOLD pattern ---
      if (a.navMode === 'hold' && a.holdFix) {
        const fixDist = dist(a.pos, a.holdFix);
        const hdgToFix = headingTo(a.pos, a.holdFix);
        const outHdg = (a.holdInboundHdg + 180) % 360;
        const legS = a.holdLegNM != null ? (a.holdLegNM * NM_TO_M) / Math.max(60, a.speed * KTS_TO_MPS) : a.holdLegMin * 60;
        switch (a.holdPhase) {
          case 'to_fix': a.targetHeading = hdgToFix; if (fixDist < 700) { a.holdPhase = 'outbound_turn'; a.holdTimer = 0; a.turnDir = a.holdTurnDir; } break;
          case 'outbound_turn': { a.targetHeading = outHdg; if (Math.abs(angleDelta(a.heading, outHdg)) < 5) { a.holdPhase = 'outbound'; a.holdTimer = 0; a.turnDir = null; } break; }
          case 'outbound': a.targetHeading = outHdg; a.holdTimer += FIXED; if (a.holdTimer >= legS) { a.holdPhase = 'inbound_turn'; a.holdTimer = 0; a.turnDir = a.holdTurnDir; } break;
          case 'inbound_turn': { a.targetHeading = a.holdInboundHdg; if (Math.abs(angleDelta(a.heading, a.holdInboundHdg)) < 5) { a.holdPhase = 'inbound'; a.turnDir = null; } break; }
          case 'inbound': a.targetHeading = hdgToFix; if (fixDist < 700) { a.holdPhase = 'outbound_turn'; a.holdTimer = 0; a.turnDir = a.holdTurnDir; } break;
        }
        a.delay.holdingS += FIXED;
      }
      // --- DCT ---
      if ((a.navMode === 'direct' || a.navMode === 'visual') && a.directTargetXY) {
        a.targetHeading = headingTo(a.pos, a.directTargetXY);
        if (dist(a.pos, a.directTargetXY) < (a.navMode === 'visual' ? 600 : 1500)) {
          if (a.directTargetName) s.passedFixes.add(a.directTargetName);
          if (a.navMode === 'direct') { a.navMode = 'heading'; a.directTargetXY = null; s.nextRequestAt = this.time + 30; s.nextRequestKind = 'further'; }
          else { a.directTargetXY = null; }
        }
      }
      // --- SID ---
      if (a.navMode === 'sid' && a.plan.fix) {
        const b = this.beacons.find(x => x.id === a.plan.fix);
        if (b) { a.targetHeading = headingTo(a.pos, { x: b.x, y: b.y }); if (dist(a.pos, { x: b.x, y: b.y }) < 2000) { a.navMode = 'heading'; s.passedFixes.add(b.id); } }
      }
      // --- ILS / LOC / visual final ---
      if ((a.navMode === 'ils' || a.navMode === 'loc' || a.navMode === 'visual') && a.ilsArmed && a.assignedRunway) {
        const r = this.ilsFor(a.assignedRunway); if (!r) continue;
        if (!a.ilsCaptured) {
          const arcade = this.settings.arcadeIntercept || a.navMode === 'visual';
          if (canCaptureLoc(a.pos, a.heading, r, arcade)) {
            if (!aboveGlideslope(a.pos, a.altitude, r)) {
              a.ilsCaptured = true; a.turnDir = null; a.holdFix = null;
              if ((a.cmdIas ?? a.targetSpeed) > 200) { a.targetSpeed = 200; a.cmdIas = null; }
              this.addScore('ESTABLISHED', a.callsign, null, a.assignedRunway);
              this.emit('info', a, `${a.callsign} established localizer ${a.assignedRunway}`, undefined, 'PILOT');
            } else if (!s.overshootSaid) { s.overshootSaid = true; this.emit('info', a, `${a.callsign}: unable to capture, above the glideslope`, undefined, 'PILOT'); }
          } else if (!s.overshootSaid && overshootsLoc(a.pos, a.heading, r, arcade)) { s.overshootSaid = true; this.emit('info', a, `${a.callsign}: we've flown through the localizer`, undefined, 'PILOT'); }
        }
        if (a.ilsCaptured) {
          // Track the localizer: the LOC law gives a desired TRACK; convert to a heading with the wind-correction angle
          // so a crosswind does not hold the aircraft off the centreline (the engine moves along the wind-corrected track).
          const trk = locTargetHdg(a.pos, r);
          const w = this.wx();
          const rel = ((w.windDirTrue - trk) + 540) % 360 - 180; // + = wind from the right
          const xw = Math.sin(rel * Math.PI / 180) * w.windKt;
          const wca = Math.asin(Math.max(-0.5, Math.min(0.5, xw / Math.max(80, a.speed)))) * 180 / Math.PI;
          a.targetHeading = (trk + wca + 360) % 360;
          const along = distAlongFwd(a.pos, r);
          const gs = gsAltFt(along, r);
          // GS capture from (slightly) below or within the above-slope tolerance the LOC capture allowed; the
          // aircraft then descends onto the slope (stepLanding converges without an altitude jump).
          if (!a.gsCaptured && a.navMode !== 'loc' && a.altitude <= gs + ILS_CONST.aboveGsFt && along > 500) a.gsCaptured = true;
          const distNM = along / NM_TO_M;
          if (a.gsCaptured) {
            if (distNM < 4) a.targetSpeed = a.perf.approachSpeed;
            else if (distNM < 6 && a.targetSpeed > 160) a.targetSpeed = 160;
            if (a.speedUntilNM != null && distNM <= a.speedUntilNM) { a.speedUntilNM = null; a.cmdIas = null; }
            a.targetAltitude = Math.max(0, gs);
          }
        }
      }
      // --- 15 NM auto-slow (220 kt) unless a speed was assigned ---
      const fieldDist = dist(a.pos, this.centerXY);
      if (fieldDist < 15 * NM_TO_M && a.cmdIas == null && a.targetSpeed > 220 && !a.ilsCaptured && a.plan.kind === 'arrival') a.targetSpeed = 220;
      // --- departure: turn to the after-departure heading above 400 ft, SID otherwise ---
      if (a.plan.kind === 'departure' && a.phase === 'takeoff' && a.altitude >= DEP_TURN_FT) {
        a.phase = 'climb';
        if (a.clearance.depHdg != null) { a.navMode = 'heading'; a.targetHeading = a.clearance.depHdg; }
        else a.navMode = 'sid';
        a.targetAltitude = a.clearance.initialAlt; a.cmdAltitude = a.clearance.initialAlt;
        this.emit('phase', a, `${a.callsign} -> climb`);
      }
    }
  }

  // ── ground traffic rules (B14: tie-break after all rules; give-way; parked excluded) ──
  private applyTraffic() {
    const moving = this.aircraft.filter(a => ['taxi', 'pushback', 'lineup', 'rollout', 'hold_short'].includes(a.phase) || (a.phase === 'takeoff' && a.path && !a.takeoffCleared));
    // Static aircraft at their stand (parked / starting up nose-in) do not block the apron lane next to them; an aircraft
    // that has pushed back and is waiting for its engines on the lane does.
    const blockers = this.aircraft.filter(a => !isAirborne(a) && a.phase !== 'parked' && a.phase !== 'arrived' && !(a.phase === 'startup' && a.pushback.stage !== 'complete'));
    // Direction of travel: a pushback moves tail-first, so it looks behind itself for traffic.
    const travelHdg = (a: AircraftState) => (a.phase === 'pushback' ? (a.heading + 180) % 360 : a.heading);
    const blockedBy = new Map<number, number>();
    for (const a of moving) { if (!this.manualHold.has(a.id)) a.trafficHold = false; else a.trafficHold = true; }
    for (const a of moving) {
      if (a.phase === 'hold_short' || a.phase === 'rollout' || this.manualHold.has(a.id)) continue;
      for (const b of blockers) {
        if (b === a) continue;
        const d = dist(a.pos, b.pos); if (d < 1) continue;
        const hs = b.wakeCategory === 'HEAVY' || b.wakeCategory === 'SUPER' ? 20 : 0;
        const gap = a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters + 14 + a.speed * 0.9 + hs;
        if (d < gap) {
          const rel = Math.abs(angleDelta(travelHdg(a), headingTo(a.pos, b.pos)));
          if (rel < 48) { a.trafficHold = true; blockedBy.set(a.id, b.id); }
        }
      }
      // give way / follow
      if (a.giveWayTo != null) {
        const b = this.byId(a.giveWayTo);
        if (!b || isAirborne(b)) a.giveWayTo = null;
        else {
          const d = dist(a.pos, b.pos);
          const bRel = Math.abs(angleDelta(b.heading, headingTo(b.pos, a.pos)));
          if (d < 160 && bRel < 100) a.trafficHold = true; else if (d > 200 || bRel > 120) a.giveWayTo = null;
        }
      }
      if (a.followId != null) {
        const b = this.byId(a.followId);
        if (!b || isAirborne(b) || b.phase === 'parked' || b.phase === 'arrived') a.followId = null;
        else if (dist(a.pos, b.pos) < a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters + 20 || b.speed < 0.5 && dist(a.pos, b.pos) < 120) a.trafficHold = true;
      }
    }
    // close pairs facing each other both stop; then break mutual blocks by lower id (B14). A pushback is a fixed
    // manoeuvre (it cannot be "released" into the aircraft behind it), so a pair involving one is never broken.
    for (let i = 0; i < moving.length; i++) for (let j = i + 1; j < moving.length; j++) {
      const a = moving[i], b = moving[j];
      if (dist(a.pos, b.pos) >= a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters + 7) continue;
      const aSeesB = Math.abs(angleDelta(travelHdg(a), headingTo(a.pos, b.pos)));
      const bSeesA = Math.abs(angleDelta(travelHdg(b), headingTo(b.pos, a.pos)));
      if (aSeesB < 90 && a.phase !== 'hold_short') { a.trafficHold = true; if (!blockedBy.has(a.id)) blockedBy.set(a.id, b.id); }
      if (bSeesA < 90 && b.phase !== 'hold_short') { b.trafficHold = true; if (!blockedBy.has(b.id)) blockedBy.set(b.id, a.id); }
    }
    for (const a of moving) {
      const bId = blockedBy.get(a.id); if (bId == null || this.manualHold.has(a.id)) continue;
      const b = this.byId(bId);
      if (blockedBy.get(bId) === a.id && a.id < bId && a.phase !== 'pushback' && b?.phase !== 'pushback') a.trafficHold = false;
    }
    // active-runway protection: ground traffic (not cleared onto it) stays clear of a runway with a landing/rolling movement
    const active = new Map<string, { a: XY; b: XY }>();
    for (const a of this.aircraft) {
      if (!a.plan.runway) continue;
      const rolling = a.phase === 'takeoff' && a.path, landing = a.phase === 'landing' && a.plan.runway && (this.distToThresholdNM(a, a.plan.runway) ?? 99) < 2;
      if (!rolling && !landing) continue;
      const rs = this.runwayState(a.plan.runway); if (!rs) continue;
      active.set(rs.ref, this.runwaySegment(rs.ref)!);
    }
    if (active.size) for (const ac of moving) {
      if (ac.phase === 'takeoff' || ac.phase === 'rollout' || ac.phase === 'lineup') continue;
      const s = this.sc(ac);
      const ahead = advance(ac.pos, ac.heading, 28);
      for (const [ref, seg] of active) {
        if (s.crossingRef === ref || s.onRunwayRef === ref) continue;
        if (distToSegment(ac.pos, seg.a, seg.b) < HOLD_LINE_M || distToSegment(ahead, seg.a, seg.b) < HOLD_LINE_M) { if (!(ac.holdReleased && ac.path?.holds?.[0] && this.refOf(ac.path.holds[0].runway) === ref)) { ac.trafficHold = true; } break; }
      }
    }
    for (const a of moving) if (a.trafficHold && a.speed < 0.5 && a.phase !== 'hold_short') a.delay.groundStoppedS += FIXED;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Transitions (state machine that needs engine data)
  // ═══════════════════════════════════════════════════════════════════════════
  private handleTransitions() {
    for (const a of this.aircraft) {
      const s = this.sc(a);
      switch (a.phase) {
        case 'parked': break;
        case 'startup': this.trStartup(a, s); break;
        case 'pushback': this.trPushback(a, s); break;
        case 'taxi': case 'hold_short': this.trTaxi(a, s); break;
        case 'lineup': this.trLineup(a, s); break;
        case 'takeoff': this.trTakeoff(a, s); break;
        case 'landing': this.trLanding(a, s); break;
        case 'rollout': this.trRollout(a, s); break;
        case 'go_around': this.trGoAround(a, s); break;
        case 'arrived': break;
        default: this.trAirborne(a, s); break;
      }
      // engines become stable (any ground phase)
      if (!a.startup.enginesStable && a.startup.readyAt != null && this.time >= a.startup.readyAt) {
        a.startup.enginesStable = true;
        this.emit('startup', a, `${a.callsign} engines stable`);
        if (a.phase === 'startup' && (a.pushback.stage === 'complete' || a.pushback.stage === 'none') && !a.requests.length) { s.nextRequestAt = this.time + rf(5, 20); s.nextRequestKind = 'taxi'; }
      }
      // frequency change completes
      if (s.handoffAt != null && this.time >= s.handoffAt && s.handoffTo) this.completeHandoff(a, s);
      // established on the ILS: approach -> tower handoff at 10 NM
      if (a.ilsCaptured && this.settings.autoHandoff && (a.onFrequency === 'approach' || a.onFrequency === 'departure') && a.handedTo == null && a.assignedRunway) {
        const d = this.distToThresholdNM(a, a.assignedRunway);
        if (d != null && d <= TOWER_HANDOFF_NM) this.execHandoff(a, 'tower');
      }
    }
    this.retire();
  }
  private completeHandoff(a: AircraftState, s: Scratch) {
    const from = a.onFrequency, to = s.handoffTo!;
    a.onFrequency = to; a.handedTo = null; a.delay.handoffAt = this.time;
    s.handoffAt = null; s.handoffTo = null;
    this.emit('handoff', a, `${a.callsign} contact ${this.unitName(to)} ${this.frequencies[to] ?? ''}`.trim(), { type: 'handoff', from, to });
    if (to === 'external') {
      if (isAirborne(a)) { a.phase = 'departed'; this.emit('departed', a, `${a.callsign} handed off, leaving the TMA`); s.despawnAt = this.time + 90; }
      return;
    }
    // First call on the new frequency: a departure at the holding point checks in "ready for departure"; everyone else "with you".
    // A request already scheduled for the new frequency (e.g. taxi-in after vacating) IS the first call - never clobber it with "with you".
    const atDepHold = a.phase === 'hold_short' && !!a.holdShortNode && !!a.plan.runway && this.isHoldNodeForRunway(a.holdShortNode, a.plan.runway);
    if (s.nextRequestKind && s.nextRequestKind !== 'with_you') {
      s.nextRequestAt = s.nextRequestKind === 'ready' && to === 'tower' ? this.time + 4 : Math.max(s.nextRequestAt ?? 0, this.time + 4);
      return;
    }
    const open = a.requests[0];
    if (open && open.answeredAt == null && open.kind !== 'with_you') return;
    s.nextRequestAt = this.time + 4; s.nextRequestKind = atDepHold && to === 'tower' ? 'ready' : 'with_you';
  }
  private trStartup(a: AircraftState, s: Scratch) { void a; void s; }
  private trPushback(a: AircraftState, s: Scratch) {
    const p = a.pushback;
    switch (p.stage) {
      case 'tug_attach':
        if (this.time >= p.stageUntil) { p.stage = 'pushing'; this.emit('pushback', a, `${a.callsign} pushing back`); }
        break;
      case 'pushing':
        if (a.path && a.distAlong >= a.path.total - 0.6 && a.speed < 0.5) { p.stage = 'tug_disconnect'; p.stageUntil = this.time + rf(20, 30); this.emit('pushback', a, `${a.callsign} pushback complete, tug disconnecting`); }
        break;
      case 'tug_disconnect':
        if (this.time >= p.stageUntil) {
          p.stage = 'complete'; p.tugId = null;
          a.path = null; a.distAlong = 0; a.speed = 0; a.phase = 'startup';
          this.emit('pushback', a, `${a.callsign} tug disconnected`);
          this.emit('phase', a, `${a.callsign} -> startup`);
          if (a.startup.enginesStable) { s.nextRequestAt = this.time + rf(5, 20); s.nextRequestKind = 'taxi'; }
        }
        break;
      default: break;
    }
  }
  private trTaxi(a: AircraftState, s: Scratch) {
    const p = a.path;
    // Crossing / runway strip bookkeeping
    if (s.crossingRef) {
      // Vacated only after the strip was actually entered and left again (addOccupant sets onRunwayRef at clearance time,
      // so it cannot be used as the "entered" signal), or when the route turned away without ever entering.
      const d = this.distToRunway(a.pos, s.crossingRef);
      if (d < STRIP_HALF_M) { s.onRunwayRef = s.crossingRef; s.crossingEntered = true; }
      s.crossingMinD = Math.min(s.crossingMinD, d);
      const clearM = HOLD_LINE_M - 15 + a.perf.lengthMeters * 0.5;
      if ((s.crossingEntered && d > clearM) || (!s.crossingEntered && d > s.crossingMinD + 60 && d > HOLD_LINE_M + 30)) {
        const ref = s.crossingRef; s.crossingRef = null; s.crossingEntered = false; s.crossingMinD = Infinity; this.removeOccupant(ref, a.id); s.onRunwayRef = null;
        this.emit('runway_vacated', a, `${a.callsign} runway ${ref} vacated`);
      }
    }
    if (a.phase === 'hold_short') {
      a.delay.holdShortWaitS += FIXED;
      if (s.stoppedSince == null) {
        s.stoppedSince = this.time;
        const h = p?.holds?.[0];
        if (h && h.runway) {
          if (h.isDepartureEntry && a.plan.kind === 'departure') {
            this.addScore('HOLD_POINT', a.callsign, null, h.runway);
            if (a.delay.holdShortAt == null) a.delay.holdShortAt = this.time;
            if (a.onFrequency === 'ground' && this.settings.autoHandoff && a.handedTo == null) { s.handoffTo = 'tower'; s.handoffAt = this.time + rf(5, 15); a.handedTo = 'tower'; }
            s.nextRequestAt = this.time + (a.onFrequency === 'tower' ? rf(3, 8) : 25); s.nextRequestKind = 'ready';
          } else { s.nextRequestAt = this.time + rf(2, 5); s.nextRequestKind = 'cross'; }
        }
      }
      // ready-for-departure once on tower (C1: engines stable >= 60 s, >= 45 s since stop)
      return;
    }
    if (s.stoppedSince != null && a.speed > 1) s.stoppedSince = null;
    // End of the taxi path
    if (p && a.distAlong >= p.total - 0.6 && a.speed < 0.4 && !(p.holds && p.holds.length)) {
      const dest = s.taxiDest;
      if (dest?.kind === 'stand') {
        const g = this.gateByRef(dest.ref);
        a.path = null; a.distAlong = 0; a.speed = 0; a.phase = 'arrived';
        if (g) this.occupyStand(g, a);
        a.delay.parkedAt = this.time;
        this.emit('arrived', a, `${a.callsign} on stand ${dest.ref}`);
        this.emit('phase', a, `${a.callsign} -> arrived`);
        if (a.plan.kind === 'arrival') { this.addScore('PARKED', a.callsign, null, null, `stand ${dest.ref}`); this.recordDelay(a); if (this.settings.despawnParked) s.despawnAt = this.time + rf(120, 300); }
        else { s.despawnAt = this.settings.despawnParked ? this.time + rf(600, 1200) : null; }
        if (a.emergency && a.emergency.status !== 'resolved') { a.emergency.stoppedAt = a.emergency.stoppedAt ?? this.time; if (a.emergency.type === 'medical') this.resolveEmergency(a, 'patient handed over'); }
        s.taxiDest = null;
      } else if (dest && dest.kind !== 'runway') {
        a.path = null; a.speed = 0; s.taxiDest = null;
        this.emit('info', a, `${a.callsign} holding at ${dest.label}`, undefined, 'PILOT');
      } else if (!dest) {
        a.path = null; a.speed = 0;
        if (a.plan.kind === 'arrival' && !a.requests.length && s.vacated) { s.nextRequestAt = this.time + rf(3, 8); s.nextRequestKind = 'taxi_in'; }
      }
    }
  }
  private trLineup(a: AircraftState, s: Scratch) {
    if (s.luawAt != null && a.speed < 0.5 && this.time - s.luawAt > LUAW_QUERY_S && !a.requests.length && !a.rto && !a.pendingCmds.some(c => c.kind === 'takeoff')) {
      this.raiseRequest(a, 'ready', null, `${this.telephony(a.callsign)}, holding in position runway ${a.plan.runway}, are we cleared for takeoff?`);
      s.luawAt = this.time;
    }
    if (a.rto && s.rtoRecoverAt != null && this.time >= s.rtoRecoverAt && !a.requests.length) {
      const hi = a.rto.speedKt >= 80;
      this.raiseRequest(a, hi ? 'return_to_stand' : 'ready', null, hi ? `${this.telephony(a.callsign)}, request taxi back to the stand for a brake check.` : `${this.telephony(a.callsign)}, brakes cooled, ready for departure.`);
      s.rtoRecoverAt = null;
    }
  }
  private trTakeoff(a: AircraftState, s: Scratch) {
    if (a.path) {
      if (!a.takeoffCleared && s.rollAt != null && this.time >= s.rollAt && !a.rto) { a.takeoffCleared = true; s.rollAt = null; this.emit('info', a, `${a.callsign} rolling runway ${a.plan.runway}`, undefined, 'PILOT'); }
      if (a.rto && a.speed < 0.3) {
        // Rejected takeoff complete: stopped on the runway, back to lineup (brake cooling / taxi back)
        a.phase = 'lineup'; a.path = null; a.distAlong = 0; a.takeoffCleared = false;
        const rs = a.plan.runway ? this.runwayState(a.plan.runway) : undefined;
        if (rs) this.addOccupant(rs.name, a, 'lineup');
        s.luawAt = this.time;
        this.emit('info', a, `${a.callsign} stopped on runway ${a.plan.runway} after the rejected takeoff`);
        // high-speed reject: 30 min brake cooling + inspection - the pilot asks to go back to the stand right away
        if (a.rto.speedKt >= 80) this.raiseRequest(a, 'return_to_stand', null, `${this.telephony(a.callsign)}, request taxi back to the stand for a brake check.`);
      }
      return;
    }
    // Airborne (path cleared by the physics at rotation): one-off bookkeeping
    if (s.onRunwayRef) {
      const ref = s.onRunwayRef;
      const rs = a.plan.runway ? this.runwayState(a.plan.runway) : this.bothEnds(ref)[0];
      this.removeOccupant(ref, a.id);
      if (rs) { this.setWakeTimer(rs.name, a); for (const r of this.bothEnds(rs.ref)) if (r.takeoffClearance === a.callsign) r.takeoffClearance = null; }
      this.addScore('MOVEMENT', a.callsign, null, a.plan.runway ?? null, 'takeoff');
      this.recordMovement(a);
      this.recordDelay(a);
      a.onFrequency = a.onFrequency === 'ground' ? 'tower' : a.onFrequency;
    }
    if (this.settings.autoHandoff && a.onFrequency === 'tower' && a.handedTo == null && a.altitude >= a.clearance.autoHandoffAlt) this.execHandoff(a, 'departure');
  }
  private trAirborne(a: AircraftState, s: Scratch) {
    // A departure stays a departure until it is set up for an approach (emergency return, "request return"): from
    // then on it is handled like an arrival (landing path, tower handoff, landing clearance).
    if (a.plan.kind === 'departure' && !a.ilsArmed && a.navMode !== 'visual') {
      if (this.settings.autoHandoff && a.onFrequency === 'tower' && a.handedTo == null && a.altitude >= a.clearance.autoHandoffAlt) this.execHandoff(a, 'departure');
      // level below cruise for > 60 s -> request higher
      if (Math.abs(a.altitude - a.targetAltitude) < 60 && a.targetAltitude < (a.plan.cruiseAlt ?? 13000)) {
        if (s.lastLevelAt === 0) s.lastLevelAt = this.time;
        else if (this.time - s.lastLevelAt > 60 && !a.requests.length && a.onFrequency !== 'external' && (s.nextRequestAt == null || s.nextRequestAt < this.time)) { this.raiseRequest(a, 'higher', Math.min(a.targetAltitude + 2000, a.plan.cruiseAlt ?? 13000)); s.lastLevelAt = this.time + 30; }
      } else s.lastLevelAt = 0;
      return;
    }
    // Arrival: build the landing path once established inside 8 NM (B1 fixed: the runway check happens at the forced-GA points, not here)
    if (a.gsCaptured && a.ilsCaptured && a.assignedRunway) {
      const r = this.ilsFor(a.assignedRunway); if (!r) return;
      const along = distAlongFwd(a.pos, r);
      if (along < LANDING_PHASE_NM * NM_TO_M && along > 100 && Math.abs(angleDelta(a.heading, r.rwdHdg)) < 25) {
        const rs = this.runwayState(a.assignedRunway)!; const osm = this.runwayByEnd(a.assignedRunway)!;
        const thrXY = r.thrXY;
        const farXY = advance(this.endXY(osm.other), rs.headingTrue, 300);
        // path: current position -> point 1.5 NM out on the centreline -> threshold -> far end (keeps the last miles straight)
        const onLine = advance(thrXY, (rs.headingTrue + 180) % 360, Math.min(along - 200, 1.5 * NM_TO_M));
        const raw = along > 1.8 * NM_TO_M ? [{ ...a.pos }, onLine, thrXY, farXY] : [{ ...a.pos }, thrXY, farXY];
        a.path = this.buildPath(raw, 'approach');
        a.thresholdDist = projectOntoPath(a.path.pts, a.path.cum, thrXY).at;
        a.distAlong = 0; a.holdReleased = true;
        a.plan.runway = a.assignedRunway;
        a.phase = 'landing';
        this.emit('phase', a, `${a.callsign} -> landing ${a.assignedRunway}`);
        s.queried4NM = false; s.crosswindChecked = false;
      }
    }
    // Arrival at spawn altitude with no descent for 3 min -> request lower
    if (a.plan.kind === 'arrival' && !a.ilsArmed && a.cmdAltitude != null && a.cmdAltitude >= 7000 && this.time - a.spawnedAt > 180 && !a.requests.length && (s.nextRequestAt == null || s.nextRequestAt < this.time) && s.lastLevelAt === 0) { this.raiseRequest(a, 'lower', 4000); s.lastLevelAt = this.time; }
    if (a.plan.kind === 'arrival' && a.navMode === 'heading' && !a.ilsArmed && this.time - a.spawnedAt > 360 && !a.requests.length && s.lastLevelAt > 0 && this.time - s.lastLevelAt > 150 && this.beacons.length) {
      const near = this.beacons.reduce((b, x) => (dist(a.pos, x) < dist(a.pos, b) ? x : b));
      this.raiseRequest(a, 'direct', near.id); s.lastLevelAt = this.time + 120;
    }
  }
  private trLanding(a: AircraftState, s: Scratch) {
    const rw = a.plan.runway ?? a.assignedRunway; if (!rw) return;
    const rs = this.runwayState(rw); if (!rs) return;
    const d = distToThresholdFromPathNM(a) ?? 99;
    // 1000 ft: crosswind / gust go-around roll (03 §D4)
    if (!s.crosswindChecked && a.altitude <= 1000) {
      s.crosswindChecked = true;
      const pX = this.safe('weather', () => this.weather.crosswindGoAroundP(a.perf.weightClass, rs.headingTrue), 0);
      const pG = this.safe('weather', () => this.weather.gustGoAroundP(), 0);
      const p = Math.max(pX, pG);
      if (p > 0 && this.wxRng() < p) { this.initiateGoAround(a, pX >= pG ? 'crosswind out of limits' : 'gusts', false); return; }
    }
    // 4 NM without clearance: pilot query (suppressed by "continue approach")
    if (!a.landingCleared && !s.continueApproach && !s.queried4NM && d <= CONFIRM_CLEARED_NM) { s.queried4NM = true; this.raiseRequest(a, 'confirm_cleared', Math.round(d)); }
    // Forced go-around table (03 §B1 + brief)
    const noClrNM = s.continueApproach ? 1.0 : FORCED_GA.noClearanceNM;
    if (!a.landingCleared && (d <= noClrNM || a.altitude <= FORCED_GA.noClearanceFt)) { this.initiateGoAround(a, 'no landing clearance', true, 'GA_UNHANDLED'); return; }
    if (rs.status === 'closed' && d <= FORCED_GA.closedNM && !a.emergency) { this.initiateGoAround(a, `runway ${rs.name} closed`, true, 'CLOSED_RUNWAY_CLEARANCE'); return; }
    const occ = rs.occupiedBy.filter(o => o.id !== a.id);
    const blocking = occ.find(o => o.kind === 'lineup' || o.kind === 'takeoff' || o.kind === 'stopped' || o.kind === 'inspection' || o.kind === 'backtrack' || o.kind === 'vehicle');
    if (blocking && d <= FORCED_GA.occupiedNM) { this.initiateGoAround(a, `runway occupied by ${blocking.callsign}`, true, 'RWY_INCURSION', blocking.callsign); return; }
    const crossing = occ.find(o => o.kind === 'crossing');
    if (crossing && d <= FORCED_GA.crossingNM) { this.initiateGoAround(a, `${crossing.callsign} crossing the runway`, true, 'RWY_INCURSION', crossing.callsign); return; }
    const preceding = occ.find(o => o.kind === 'rollout' || o.kind === 'landing');
    if (preceding && d <= FORCED_GA.precedingNM) { this.initiateGoAround(a, `${preceding.callsign} still on the runway`, true, 'RWY_INCURSION', preceding.callsign); return; }
    const veh = this.safe('fleet', () => this.fleet.onRunway(rs.ref)[0] ?? null, null);
    if (veh && d <= FORCED_GA.occupiedNM) { this.initiateGoAround(a, `${veh.callsign} on the runway`, true, 'RWY_INCURSION', veh.id); return; }
    // Landing occupant from 2 NM (1 NM medium; 2 NM H/S per 03 §2.5)
    if (d <= (a.wakeCategory === 'HEAVY' || a.wakeCategory === 'SUPER' ? 2 : 1) && !occ.length && !rs.occupiedBy.some(o => o.id === a.id)) this.addOccupant(rs.name, a, 'landing');
    // Tower handoff safety net (landing without being on tower)
    if (this.settings.autoHandoff && a.onFrequency === 'approach' && a.handedTo == null) this.execHandoff(a, 'tower');
  }
  private trRollout(a: AircraftState, s: Scratch) {
    const rw = a.plan.runway ?? a.assignedRunway; const rs = rw ? this.runwayState(rw) : undefined;
    if (!rs) return;
    if (!s.touchdownDone) { s.touchdownDone = true; this.onTouchdown(a, s, rs); }
    if (a.path && a.path.kind !== 'taxi') {
      // On the runway path: exit when reaching the planned exit (or stop for an emergency / no exit)
      const plan = s.exitPlan;
      if (plan && a.distAlong >= plan.at - 1 && a.speed <= plan.speedKt + 3) {
        this.exitViaTaxiway(a, rs, plan, false);
        return;
      }
      if (!plan && a.speed < 0.3) {
        // Stopped on the runway (emergency / no exit found / LAHSO)
        if (a.emergency && a.emergency.stopOnRunway && a.emergency.stoppedAt == null) {
          a.emergency.stoppedAt = this.time; a.emergency.status = 'stopped';
          this.addOccupant(rs.name, a, 'stopped');
          this.emit('emergency', a, `${a.callsign} stopped on runway ${rs.name}`, { type: 'emergency', emergency: a.emergency, change: 'stopped' }, 'SYS');
          if (a.emergency.closureMin > 0 && rs.status !== 'closed') this.setRunwayStatus(rs.name, 'closed', `${a.callsign} disabled on the runway`);
          for (const r of this.bothEnds(rs.ref)) r.statusUntil = this.time + a.emergency.closureMin * 60;
          this.checklist(a, 'runway_closed');
        } else if (!a.emergency && !s.vacated && !a.requests.length && !this.pendingEvents.some(e => e.id === a.id && e.type === 'info')) {
          this.emit('info', a, `${a.callsign} stopped on the runway, request taxi`, undefined, 'PILOT');
          this.raiseRequest(a, 'taxi_in');
        }
      }
      return;
    }
    // On the exit path
    if (!s.vacated) {
      const clearM = HOLD_LINE_M - 15 + a.perf.lengthMeters * 0.5;
      if (this.distToRunway(a.pos, rs.ref) > clearM) this.onVacated(a, s, rs);
    }
    if (a.path && a.distAlong >= a.path.total - 0.6 && a.speed < 0.4) {
      a.path = null; a.distAlong = 0; a.speed = 0; a.phase = 'taxi';
      this.emit('phase', a, `${a.callsign} -> taxi`);
      if (!s.vacated) this.onVacated(a, s, rs);
      if (this.settings.autoGround && a.plan.gateRef) { this.execTaxi(a, { kind: 'stand', ref: a.plan.gateRef }, [], true, null, [], false); this.emit('info', a, `${a.callsign} auto taxi to stand ${a.plan.gateRef}`, undefined, 'AI'); }
      else { s.nextRequestAt = Math.max(this.time + rf(2, 6), s.handoffAt != null ? s.handoffAt + 4 : 0); s.nextRequestKind = 'taxi_in'; }
    }
  }
  private onTouchdown(a: AircraftState, s: Scratch, rs: RunwayState) {
    for (const r of this.bothEnds(rs.ref)) { r.lastArrival = { callsign: a.callsign, at: this.time, cat: a.wakeCategory }; }
    this.setLandingClearance(rs, a.callsign, false);
    this.addOccupant(rs.name, a, 'rollout');
    a.landingCleared = false;
    let closure = 0;
    if (a.emergency && a.emergency.status !== 'resolved') {
      closure = this.safe('emergencies', () => handleLanded(this.emergencyView(), a), 0);
      if (!this.sys.emergencies) { const spec = EMERGENCY_CATALOGUE[a.emergency.type]; a.emergency.landedAt = this.time; a.emergency.status = 'landed'; a.emergency.stopOnRunway = a.emergency.stopOnRunway || chance(spec.stopOnRunwayP); closure = a.emergency.stopOnRunway ? Math.round(rf(spec.closureMin[0], spec.closureMin[1])) : 0; }
      a.emergency.closureMin = closure;
      this.emit('emergency', a, `${a.callsign} landed runway ${rs.name}${a.emergency.stopOnRunway ? ', stopping on the runway' : ''}`, { type: 'emergency', emergency: a.emergency, change: 'landed' }, 'SYS');
    }
    const stopOnRunway = !!a.emergency && a.emergency.stopOnRunway && a.emergency.status !== 'resolved';
    if (stopOnRunway) {
      s.exitPlan = null;
      if (a.path) { a.path.holdAt = Math.min(a.path.total, a.distAlong + this.brakingM(a.speed, 2.5) + 40); }
      a.cmdIas = null;
      return;
    }
    const plan = this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, a.exitTaxiway, false) ?? (a.exitTaxiway ? this.chooseExit(a, rs.ref, rs.headingTrue, a.speed, null, false) : null);
    s.exitPlan = plan;
    if (a.path) a.path.holdAt = plan ? plan.at : undefined;
    a.cmdIas = plan ? plan.speedKt : null;
    if (a.exitTaxiway && (!plan || plan.taxiway !== a.exitTaxiway)) this.emit('info', a, `${a.callsign}: unable ${a.exitTaxiway}, we'll take ${plan?.taxiway ?? 'the end'}`, undefined, 'PILOT');
  }
  private onVacated(a: AircraftState, s: Scratch, rs: RunwayState) {
    s.vacated = true;
    this.removeOccupant(rs.ref, a.id); s.onRunwayRef = null;
    a.delay.vacatedAt = this.time;
    this.emit('runway_vacated', a, `${a.callsign} runway ${rs.name} vacated`);
    if (a.delay.touchdownAt != null) {
      // a landing (not a departure that vacated after a cancelled line-up / rejected takeoff)
      this.addScore('LANDED', a.callsign, null, rs.name, `runway occupancy ${Math.round(this.time - a.delay.touchdownAt)} s`);
      this.recordMovement(a);
    }
    if (this.settings.autoHandoff && a.onFrequency === 'tower' && a.handedTo == null) { s.handoffTo = 'ground'; s.handoffAt = this.time + rf(5, 15); a.handedTo = 'ground'; }
    if (a.lahsoHoldShortOf) { a.lahsoHoldShortOf = null; }
  }
  private trGoAround(a: AircraftState, s: Scratch) {
    if (a.altitude >= this.missedApproachAltFt - 100 && this.settings.autoHandoff && a.onFrequency === 'tower' && a.handedTo == null) this.execHandoff(a, 'approach');
    if (s.gaAt != null && this.time - s.gaAt > 30 && !s.overshootSaid) { s.overshootSaid = true; this.emit('info', a, `${a.callsign}: flying runway heading, climbing ${this.missedApproachAltFt}, request further instructions`, undefined, 'PILOT'); }
  }

  /** Pick the runway exit: first high-speed exit reachable at <= 30 kt (M) / 25 kt (H,S), else the next 90-degree exit at <= 15 kt. */
  private chooseExit(a: AircraftState, ref: string, hdg: number, speedKt: number, wantTaxiway: string | null, fromStandstill: boolean): ExitPlan | null {
    const rs = this.bothEnds(ref).find(r => Math.abs(angleDelta(r.headingTrue, hdg)) < 5) ?? this.bothEnds(ref)[0];
    const thr = this.thresholdXY(rs.name)!;
    const alongNow = alongTrack(a.pos, thr, hdg);
    const decel = 2.0 * SURFACE_FACTOR[this.wx().runwayCondition] / (a.emergency ? EMERGENCY_CATALOGUE[a.emergency.type].perf.rolloutFactor : 1);
    const hsSpeed = a.perf.weightClass === 'L' ? 35 : a.perf.weightClass === 'M' ? 30 : 25;
    const cands: Array<ExitPlan & { along: number; hs: boolean }> = [];
    for (const ex of this.runwayExits(ref)) {
      const along = alongTrack(ex.xy, thr, hdg);
      const margin = fromStandstill ? 10 : 40;
      if (along < alongNow + margin) continue;
      const twy = this.nodeXY(ex.twyNodeId)!;
      const angle = Math.abs(angleDelta(hdg, headingTo(ex.xy, twy)));
      if (angle > 125) continue; // would need a backtrack
      const hs = angle >= 8 && angle <= 55;
      const exitSpeed = hs ? hsSpeed : 15;
      const need = fromStandstill ? 0 : this.brakingM(speedKt, decel) - this.brakingM(exitSpeed, decel);
      if (along - alongNow - margin < need) continue;
      const at = a.path ? projectOntoPath(a.path.pts, a.path.cum, ex.xy, a.distAlong).at : along - alongNow;
      cands.push({ runwayNodeId: ex.runwayNodeId, twyNodeId: ex.twyNodeId, at, speedKt: exitSpeed, taxiway: ex.taxiway, angleDeg: angle, along, hs });
    }
    cands.sort((x, y) => x.along - y.along);
    if (!cands.length) return null;
    if (wantTaxiway) {
      const w = cands.find(c => c.taxiway === wantTaxiway || this.air.taxiwayNodes.get(wantTaxiway)?.includes(c.twyNodeId));
      if (w) return strip(w);
      if (!fromStandstill) return null;
    }
    if (a.exitDir && !wantTaxiway) {
      const side = cands.find(c => (crossTrack(this.nodeXY(c.twyNodeId)!, thr, hdg) > 0 ? 'R' : 'L') === a.exitDir);
      if (side) return strip(side);
    }
    const first = cands.find(c => c.hs) ?? cands[0];
    return strip(first);
    function strip(c: ExitPlan & { along: number; hs: boolean }): ExitPlan { return { runwayNodeId: c.runwayNodeId, twyNodeId: c.twyNodeId, at: c.at, speedKt: c.speedKt, taxiway: c.taxiway, angleDeg: c.angleDeg }; }
  }
  /** Leave the runway via an exit: runway node -> taxiway node -> until clear of the hold line, then stop. */
  private exitViaTaxiway(a: AircraftState, rs: RunwayState, exit: ExitPlan, fromLineup: boolean) {
    const ids = [exit.runwayNodeId, exit.twyNodeId];
    let prev = exit.runwayNodeId, cur = exit.twyNodeId; let hops = 0;
    const clearM = HOLD_LINE_M + a.perf.lengthMeters * 0.5 + 15;
    // Walk the exit until clear of the strip: prefer the edge that gets furthest from the runway (a high-speed exit's
    // tail often runs parallel to the runway before joining the taxiway), never turning back more than 110 degrees.
    let walked = 0;
    while (hops++ < 80 && walked < 600 && this.distToRunway(this.nodeXY(cur)!, rs.ref) < clearM) {
      const n = this.air.nodes.get(cur)!;
      const cx = this.nodeXY(cur)!;
      const h0 = headingTo(this.nodeXY(prev)!, cx);
      const opts = n.edges.filter(e => e.to !== prev && e.type !== 'runway' && !this.runwayNodes.get(rs.ref)?.has(e.to) && Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(e.to)!))) <= 110);
      if (!opts.length) break;
      const score = (e: typeof opts[number]) => this.distToRunway(this.nodeXY(e.to)!, rs.ref) - Math.abs(angleDelta(h0, headingTo(cx, this.nodeXY(e.to)!))) * 0.2;
      const next = opts.reduce((b, e) => (score(e) > score(b) ? e : b));
      walked += next.meters;
      prev = cur; cur = next.to; ids.push(cur);
    }
    const raw: XY[] = [{ ...a.pos }];
    for (const id of ids) raw.push(this.nodeXY(id)!);
    const last = raw[raw.length - 1];
    if (this.distToRunway(last, rs.ref) < clearM) raw.push(advance(last, headingTo(raw[raw.length - 2], last), clearM - this.distToRunway(last, rs.ref) + 5));
    const path = this.buildPath(raw, 'taxi', true);
    path.holds = [];
    a.path = path; a.distAlong = 0; a.holdReleased = false; a.cmdIas = null;
    a.exitTaxiway = null; a.exitDir = null;
    const s = this.sc(a); s.exitPlan = null;
    if (fromLineup) {
      a.phase = 'rollout'; s.vacated = false; s.touchdownDone = true; a.takeoffCleared = false;
      this.emit('info', a, `${a.callsign} vacating runway ${rs.name} via ${exit.taxiway ?? 'the next taxiway'}`, undefined, 'PILOT');
    } else this.emit('info', a, `${a.callsign} exiting via ${exit.taxiway ?? 'taxiway'}`, undefined, 'PILOT');
  }
  private startRollout(a: AircraftState, endName: string, alongM: number) {
    const rs = this.runwayState(endName)!; const r = this.runwayByEnd(endName)!;
    const thr = this.thresholdXY(endName)!;
    const far = advance(this.endXY(r.other), rs.headingTrue, 300);
    a.pos = advance(thr, rs.headingTrue, alongM); a.heading = rs.headingTrue;
    a.path = this.buildPath([{ ...a.pos }, far], 'approach');
    a.distAlong = 0; a.thresholdDist = -alongM; a.altitude = 0;
    a.phase = 'rollout'; a.plan.runway = rs.name; a.assignedRunway = rs.name;
    a.delay.touchdownAt = this.time;
  }

  // ── per-second tasks ───────────────────────────────────────────────────────
  private perSecond() {
    for (const a of this.aircraft) {
      const s = this.sc(a);
      // scheduled pilot requests
      if (s.nextRequestAt != null && this.time >= s.nextRequestAt && s.nextRequestKind) {
        const kind = s.nextRequestKind; s.nextRequestAt = null; s.nextRequestKind = null;
        if (!(kind === 'with_you' && (a.underControl && this.time - a.spawnedAt > 5 && a.onFrequency === 'approach' && a.plan.kind === 'arrival' && false))) {
          if (kind === 'taxi' && a.phase !== 'startup') { /* superseded */ }
          else if (kind === 'ready' && a.phase !== 'hold_short' && a.phase !== 'lineup') { /* superseded */ }
          else if (kind === 'cross' && a.phase !== 'hold_short') { /* superseded */ }
          else this.raiseRequest(a, kind, kind === 'cross' ? (a.holdShortRunway ?? null) : kind === 'direct' ? (this.beacons[0]?.id ?? null) : null);
        }
      }
      // recall / expire open request
      const req = a.requests[0];
      if (req && req.answeredAt == null) {
        if (req.expiresAt != null && this.time >= req.expiresAt) this.expireRequest(a);
        else if (this.time >= req.recallAt) {
          req.recalls++; req.recallAt = this.time + (SimEngine.RECALL_S[req.kind] ?? 60);
          a.delay.unansweredS += SimEngine.RECALL_S[req.kind] ?? 60;
          if (req.recalls === 3) { this.stats.unansweredRequests++; }
          if (req.recalls >= 3 && req.recalls % 2 === 1) this.addScore('UNANSWERED_REQUEST', a.callsign, null, null, `${req.kind} unanswered ${Math.round(this.time - req.at)} s`);
          this.emit('request', a, req.recalls >= 3 ? `${this.telephony(a.callsign)}, standing by.` : req.text, { type: 'request', request: req, change: 'recalled' });
        }
      }
      // readback mismatch enforcement
      this.enforceMismatch(a);
      // airborne time / fuel
      if (isAirborne(a)) {
        a.delay.airborneS += 1;
        if (a.fuelMin != null) {
          a.fuelMin -= 1 / 60;
          if (a.fuelMin <= 0) {
            this.emit('fuel_exhaustion', a, `${a.callsign} FUEL EXHAUSTION`);
            this.addScore('FUEL_EXHAUSTION', a.callsign);
            this.remove(a.id, 'fuel_exhaustion');
            continue;
          }
          if (!a.emergency && a.fuelMin < 20 && a.plan.kind === 'arrival' && !isAirborne(a) === false && a.phase !== 'landing') {
            this.declareEmergency(a, 'fuel');
          }
        }
      }
      // emergencies
      if (this.sys.emergencies) {
        if (!a.emergency && this.settings.emergencyRate !== 'off') {
          const e = this.safe('emergencies', () => maybeDeclare(a, this.emergRng, this.emergencyView(), this.settings.emergencyRate), null);
          if (e) this.attachEmergency(a, e);
        } else if (a.emergency && a.emergency.status !== 'resolved') {
          this.safe('emergencies', () => stepEmergency(this.emergencyView(), a, 1), undefined);
          const em: Emergency = a.emergency;
          if (em.status === 'resolved' && em.resolvedAt == null) { em.resolvedAt = this.time; this.stats.emergenciesResolved++; }
        }
      }
      if (a.emergency && a.emergency.status !== 'resolved') this.emergencyTick(a, s);
      // stage change events
      const st = this.stageOf(a);
      if (st !== s.lastStage) { this.emit('stage', a, st, { type: 'stage', from: s.lastStage, to: st }); s.lastStage = st; }
      // despawn
      if (s.despawnAt != null && this.time >= s.despawnAt) { this.remove(a.id, a.plan.kind === 'arrival' ? 'arrived' : 'departed'); continue; }
      // rotten LUAW: > 180 s on the runway with nobody inbound -> vacates for fuel (03 §A14)
      if (a.phase === 'lineup' && s.luawAt != null && this.time - s.luawAt > 400 && !a.pendingCmds.length && a.plan.runway && !this.arrivalOnFinal(a.plan.runway, 6)) {
        const rs = this.runwayState(a.plan.runway)!; const ex = this.chooseExit(a, rs.ref, rs.headingTrue, 0, null, true);
        if (ex) { this.emit('info', a, `${a.callsign}: vacating the runway, brakes and fuel`, undefined, 'PILOT'); this.exitViaTaxiway(a, rs, ex, true); }
        s.luawAt = this.time;
      }
    }
    // runway status timers (closure after emergency: aircraft towed when it elapses; runway stays closed until reopened)
    for (const rs of this.runways) {
      if (rs.statusUntil != null && this.time >= rs.statusUntil) {
        rs.statusUntil = null;
        for (const a of this.aircraft) if (a.emergency && this.sc(a).onRunwayRef === rs.ref && a.phase === 'rollout') { this.emit('info', a, `${a.callsign} towed clear of runway ${rs.ref}`); this.remove(a.id, 'arrived'); }
        this.emit('info', null, `Runway ${rs.ref}: disabled aircraft cleared, inspection required before reopening`);
      }
    }
    // weather-driven runway wind components (cheap; every second)
    const w = this.wx();
    for (const rs of this.runways) { const c = windComponents(w.windDirTrue, w.windKt, rs.headingTrue); rs.windHeadKt = c.headKt; rs.windCrossKt = c.crossKt; }
    if (this.time - this.lastRunwayCheck >= 60) { this.lastRunwayCheck = this.time; this.onWeatherChange(null); }
    if (this.settings.autoTower) this.autoTowerStep();
    // streak bonuses (03 §6): 1 h / 2 h without an incident
    if (this.stats.streakS >= 3600 && !this.incidentLog.has('STREAK|1h|')) { this.incidentLog.set('STREAK|1h|', this.time); this.addScore('STREAK', 'SESSION', '1h', null, 'one hour without incident'); }
  }
  private emergencyTick(a: AircraftState, s: Scratch) {
    const e = a.emergency!;
    // ARFF on scene
    if (e.arff !== 'none' && e.arffOnSceneAt == null && this.sys.fleet) {
      const on = this.fleet.list().some(v => v.type === 'arff' && v.state === 'onscene');
      if (on) {
        e.arffOnSceneAt = this.time;
        const resp = s.arffDispatchedAt != null ? this.time - s.arffDispatchedAt : null;
        if (resp != null) { this.stats.arffResponseS.push(resp); if (resp <= 180) this.addScore('ARFF_ON_TIME', a.callsign, null, e.runway, `${Math.round(resp)} s`); }
        this.emit('emergency', a, `Fire services on scene for ${a.callsign}`, { type: 'emergency', emergency: e, change: 'services' }, 'SYS');
      }
    }
    // Souls/fuel not asked within 3 min
    if (e.checklist.souls_fuel == null && EMERGENCY_CATALOGUE[e.type].required.includes('souls_fuel') && this.time - e.declaredAt > 180 && !this.sys.emergencies) this.addScore('EMERGENCY_CHECKLIST_MISS', a.callsign, null, null, 'souls and fuel not obtained within 3 min');
    // Stand-down: stopped/vacated for 10 min with no fire -> resolved
    if ((e.status === 'stopped' || e.status === 'landed') && e.stoppedAt != null && this.time - e.stoppedAt > 600 && !this.sys.emergencies) this.resolveEmergency(a, 'stand down');
  }
  /** AI tower assist (UX §G5.10): routine clearances 8 s after they become valid; never violates the rules. */
  private autoTowerStep() {
    for (const rs of this.runways) {
      if (!rs.activeDep) continue;
      const waiting = this.aircraft.find(a => a.phase === 'hold_short' && a.holdShortNode && this.isHoldNodeForRunway(a.holdShortNode, rs.name) && a.plan.kind === 'departure' && this.refOf(a.plan.runway ?? '') === rs.ref && this.sc(a).stoppedSince != null && this.time - this.sc(a).stoppedSince! > 8 && !a.pendingCmds.length);
      if (waiting) {
        const r = this.cmdTakeoff(waiting, rs.name, { immediate: false, afterDepHdg: null, turn: null, initialAlt: null, contactDeparture: true });
        if (r.ok) this.emit('transmission', waiting, `AI TWR: ${waiting.callsign} runway ${rs.name} cleared for takeoff`, { type: 'transmission', ast: makeAst('takeoff', waiting.callsign, { runway: rs.name }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
      }
    }
    for (const a of this.aircraft) {
      if (a.phase === 'landing' && !a.landingCleared && a.plan.runway) {
        const d = distToThresholdFromPathNM(a) ?? 99;
        if (d <= 5 && !this.runwayOccupant(a.plan.runway, a.id) && !a.pendingCmds.some(c => c.kind === 'clearedLand')) {
          const r = this.cmdClearedLand(a, a.plan.runway, null, null);
          if (r.ok) this.emit('transmission', a, `AI TWR: ${a.callsign} runway ${a.plan.runway} cleared to land`, { type: 'transmission', ast: makeAst('clearedLand', a.callsign, { runway: a.plan.runway }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
        }
      }
      if (a.phase === 'hold_short' && a.holdShortRunway && !a.holdReleased && a.path?.holds?.[0] && !a.path.holds[0].isDepartureEntry && this.sc(a).stoppedSince != null && this.time - this.sc(a).stoppedSince! > 8 && this.crossingSafe(a.holdShortRunway) && !a.pendingCmds.length) {
        const r = this.cmdCross(a, a.holdShortRunway, false, null);
        if (r.ok) this.emit('transmission', a, `AI TWR: ${a.callsign} cross runway ${a.holdShortRunway}`, { type: 'transmission', ast: makeAst('cross', a.callsign, { runway: a.holdShortRunway }), result: { ok: true, code: r.code, transmission: '', readback: '' }, who: 'ai' }, 'AI');
      }
    }
  }

  // ── retire finished flights ────────────────────────────────────────────────
  private retire() {
    for (const a of [...this.aircraft]) {
      if (!isAirborne(a)) continue;
      const d = dist(a.pos, this.centerXY);
      if (a.plan.kind === 'departure') {
        if (d > this.airspaceRadiusM * 0.92) {
          if (a.phase === 'departed' || a.onFrequency === 'external') { this.emit('departed', a, `${a.callsign} left the TMA`); this.remove(a.id, 'departed'); }
          else if (a.altitude >= 9000) { this.emit('departed', a, `${a.callsign} left the TMA above FL90`); this.addScore('DEPARTED_HANDOFF', a.callsign, null, null, 'exit above FL90'); this.remove(a.id, 'departed'); }
          else { this.emit('diversion', a, `${a.callsign} DIVERSION — left airspace below FL90 without handoff`); this.addScore('DIVERSION_UNHANDLED', a.callsign, null, null, 'unhandled exit'); this.stats.diversions++; this.remove(a.id, 'diversion'); }
        }
      } else {
        const s = this.sc(a);
        if (d < this.airspaceRadiusM) s.enteredAirspace = true;
        if (this.time - a.spawnedAt <= 30 || d <= this.airspaceRadiusM * 1.05) continue;
        // Outside the boundary: a diversion once it has been inside, or when it is flying away from the field
        // (a spawn queued behind a busy entry starts outside and is still inbound - B3/B11).
        const outbound = Math.abs(angleDelta(a.heading, headingTo(a.pos, this.centerXY))) > 90;
        if (!s.enteredAirspace && !outbound && this.time - a.spawnedAt < 240) continue;
        this.emit('diversion', a, `${a.callsign} DIVERSION — exited airspace`);
        this.addScore('DIVERSION', a.callsign, null, null, 'exited airspace');
        this.stats.diversions++;
        this.remove(a.id, 'diversion');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Separation / incursions / alerts (once per frame)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Required lateral separation for a pair (NM): 3 NM radar (2.5 on the same final inside 10 NM, dry), or the wake matrix when in trail. */
  requiredSepNM(a: AircraftState, b: AircraftState): number {
    let base = HORIZ_SEP_NM;
    const sameFinal = a.ilsCaptured && b.ilsCaptured && a.assignedRunway && a.assignedRunway === b.assignedRunway;
    if (sameFinal && this.settings.reducedFinalSep && this.wx().runwayCondition === 'dry') {
      const da = this.distToThresholdNM(a, a.assignedRunway!) ?? 99, db = this.distToThresholdNM(b, a.assignedRunway!) ?? 99;
      if (da < 10 && db < 10) base = REDUCED_FINAL_NM;
    }
    const lt = this.leaderTrailer(a, b);
    if (!lt) return base;
    const leadCat: WakeCategory = lt.leader.perf.b757 ? 'HEAVY' : lt.leader.wakeCategory;
    return Math.max(base, WAKE_FINAL_NM[leadCat][lt.trailer.wakeCategory]);
  }
  /** In-trail geometry: same track (+-30 deg), trailer within 0.5 NM laterally of the leader's track and at/below the leader + 1000 ft. */
  private leaderTrailer(a: AircraftState, b: AircraftState): { leader: AircraftState; trailer: AircraftState } | null {
    if (Math.abs(angleDelta(a.heading, b.heading)) > 30) return null;
    const aAhead = alongTrack(a.pos, b.pos, b.heading) > 0;
    const leader = aAhead ? a : b, trailer = aAhead ? b : a;
    if (Math.abs(crossTrack(trailer.pos, leader.pos, leader.heading)) > 0.5 * NM_TO_M) return null;
    if (trailer.altitude > leader.altitude + 1000) return null;
    return { leader, trailer };
  }
  /** Reduced-minima exceptions (03 §8): independent parallel ILS, both on final < 1600 ft, diverging departures >= 15 deg, 60 s go-around grace. */
  reducedMinima(a: AircraftState, b: AircraftState): boolean {
    const refA = a.assignedRunway ? this.refOf(a.assignedRunway) : null, refB = b.assignedRunway ? this.refOf(b.assignedRunway) : null;
    if (a.ilsCaptured && b.ilsCaptured && refA && refB && refA !== refB && Math.abs(angleDelta(this.runwayHeading(a.assignedRunway!), this.runwayHeading(b.assignedRunway!))) < 15) return true;
    const onFinal = (x: AircraftState) => x.phase === 'landing' || (x.ilsCaptured && x.gsCaptured);
    if (onFinal(a) && onFinal(b) && refA !== refB && a.altitude < 1600 && b.altitude < 1600) return true;
    const dep = (x: AircraftState) => x.plan.kind === 'departure' && x.delay.airborneAt != null && this.time - x.delay.airborneAt < 180;
    if (dep(a) && dep(b) && Math.abs(angleDelta(a.heading, b.heading)) >= 15) return true;
    const ga = (x: AircraftState) => x.goAround && this.sc(x).gaAt != null && this.time - this.sc(x).gaAt! < 60;
    if (ga(a) || ga(b)) return true;
    // Segregated parallel operations (Doc 4444 6.7.3): a departure in its initial climb vs an aircraft on final to /
    // landing on a parallel runway is protected by the runway separation, not by the radar minimum.
    const initialClimb = (x: AircraftState) => x.plan.kind === 'departure' && !x.ilsArmed && x.delay.airborneAt != null && this.time - x.delay.airborneAt < 180 && !!x.plan.runway;
    const onFinalTo = (x: AircraftState) => (x.phase === 'landing' || x.ilsCaptured) && (x.assignedRunway ?? x.plan.runway ?? null);
    const parallelPair = (dep: AircraftState, arr: AircraftState) => {
      const rwA = arr.assignedRunway ?? arr.plan.runway!, rwD = dep.plan.runway!;
      const refA = this.refOf(rwA), refD = this.refOf(rwD);
      return !!refA && !!refD && refA !== refD && Math.abs(angleDelta(this.runwayHeading(rwA), this.runwayHeading(rwD))) < 15;
    };
    if (initialClimb(a) && onFinalTo(b) && parallelPair(a, b)) return true;
    if (initialClimb(b) && onFinalTo(a) && parallelPair(b, a)) return true;
    if (a.emergency?.type === 'depressurization' && this.time - a.emergency.declaredAt < 60 || b.emergency?.type === 'depressurization' && this.time - b.emergency.declaredAt < 60) return true;
    return false;
  }
  private checkSeparation() {
    for (const a of this.aircraft) a.conflict = false;
    const now = new Set<string>(); const list = this.aircraft;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]; const d = dist(a.pos, b.pos);
      const airA = isAirborne(a), airB = isAirborne(b);
      if (!airA && !airB) {
        // apron / taxiway spacing (parked pairs excluded: stands are close together)
        const stat = (x: AircraftState) => x.phase === 'parked' || x.phase === 'arrived' || x.phase === 'startup';
        if (stat(a) && stat(b)) continue;
        if (d < (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.6 && !(stat(a) || stat(b))) {
          a.conflict = b.conflict = true; const k = pairKey(a.id, b.id); now.add(k);
          if (!this.conflictPairs.has(k)) {
            const rel = Math.abs(a.speed - b.speed) + (a.speed > 0.5 && b.speed > 0.5 ? Math.min(a.speed, b.speed) : 0);
            if (d < (a.perf.safetyRadiusMeters + b.perf.safetyRadiusMeters) * 0.35 && rel > 5) { this.emit('ground_conflict', a, `GROUND COLLISION: ${a.callsign} / ${b.callsign}`); this.addScore('COLLISION_GND', a.callsign, b.callsign); }
            else { this.emit('ground_conflict', a, `GROUND CONFLICT: ${a.callsign} / ${b.callsign}`); this.addScore('GROUND_CONFLICT', a.callsign, b.callsign); }
          }
        }
      } else if (airA && airB) {
        // air-ground pairs are excluded (runway protection is the incursion domain)
        if (a.phase === 'departed' && b.phase === 'departed') continue;
        const reqNM = this.requiredSepNM(a, b);
        if (this.reducedMinima(a, b)) continue;
        const vert = Math.abs(a.altitude - b.altitude);
        if (d < 0.1 * NM_TO_M && vert < 200) {
          const k = pairKey(a.id, b.id);
          if (!this.conflictPairs.has(k)) { this.emit('separation_loss', a, `MID-AIR COLLISION: ${a.callsign} / ${b.callsign}`); this.addScore('COLLISION_AIR', a.callsign, b.callsign); }
          now.add(k); a.conflict = b.conflict = true; continue;
        }
        if (d < reqNM * NM_TO_M && vert < VERT_SEP_FT) {
          a.conflict = b.conflict = true; const k = pairKey(a.id, b.id); now.add(k);
          if (!this.conflictPairs.has(k)) {
            const lt = this.leaderTrailer(a, b);
            const wake = lt && WAKE_FINAL_NM[lt.leader.perf.b757 ? 'HEAVY' : lt.leader.wakeCategory][lt.trailer.wakeCategory] > HORIZ_SEP_NM && d >= HORIZ_SEP_NM * NM_TO_M;
            if (wake && lt) {
              this.emit('separation_loss', lt.trailer, `WAKE SEPARATION: ${lt.trailer.callsign} ${(d / NM_TO_M).toFixed(1)} NM behind ${lt.leader.callsign} (${lt.leader.wakeCategory}), ${reqNM} NM required`);
              this.addScore('WAKE_FINAL', lt.trailer.callsign, lt.leader.callsign, lt.trailer.assignedRunway ?? null, `${(d / NM_TO_M).toFixed(1)} NM`);
              if (d < (reqNM - 1) * NM_TO_M && (lt.trailer.phase === 'landing' || lt.trailer.gsCaptured)) this.initiateGoAround(lt.trailer, `wake turbulence, ${lt.leader.callsign} ahead`, true, null);
            } else {
              this.emit('separation_loss', a, `SEPARATION LOSS: ${a.callsign} / ${b.callsign} ${(d / NM_TO_M).toFixed(1)} NM / ${Math.round(vert)} ft`);
              this.addScore('SEPARATION_LOSS', a.callsign, b.callsign, null, `${(d / NM_TO_M).toFixed(1)} NM / ${Math.round(vert)} ft`);
            }
          }
        }
      }
    }
    this.conflictPairs = now;
  }
  /** Runway strip entered by an aircraft without a clearance for that runway (or while an arrival is inside 2 NM). Returns the runway ref. */
  onRunwayWithoutClearance(id: number | string): string | null {
    if (typeof id === 'string') {
      const v = this.fleet.byId(id); if (!v || !v.onRunway) return null;
      const rs = this.bothEnds(v.onRunway)[0]; if (!rs) return null;
      const arr = this.arrivalOnFinal(rs.name, 2);
      if (arr || this.rollingDeparture(rs.name)) return v.onRunway;
      return rs.occupiedBy.some(o => o.id === v.id) ? null : v.onRunway;
    }
    const a = this.byId(id); if (!a || isAirborne(a) || a.phase === 'parked' || a.phase === 'arrived' || a.phase === 'startup') return null;
    const s = this.sc(a);
    const refs = this.runwaysAt(a.pos);
    const authorisedOn = (ref: string) => {
      const rs = this.bothEnds(ref)[0];
      return rs.occupiedBy.some(o => o.id === a.id) || s.crossingRef === ref || s.onRunwayRef === ref || (!!a.plan.runway && this.refOf(a.plan.runway) === ref && (a.phase === 'takeoff' || a.phase === 'lineup' || a.phase === 'rollout'));
    };
    const cleared = refs.filter(authorisedOn);
    for (const ref of refs) {
      const rs = this.bothEnds(ref)[0];
      if (!cleared.includes(ref)) {
        // the intersection box of a runway the aircraft IS cleared on (landing roll / takeoff through a crossing runway) is not an incursion
        if (cleared.some(c => rs.intersects.includes(c) || this.bothEnds(c)[0].intersects.includes(ref))) continue;
        return ref;
      }
      const arr = this.arrivalOnFinal(rs.name, 2);
      if (arr && arr.a.id !== a.id && (s.crossingRef === ref || a.phase === 'taxi')) return ref;
    }
    return null;
  }
  private checkIncursions() {
    for (const a of this.aircraft) {
      const ref = this.onRunwayWithoutClearance(a.id);
      if (!ref) continue;
      const rs = this.bothEnds(ref)[0];
      const arr = this.arrivalOnFinal(rs.name, 2);
      const ev = this.addScore('RWY_INCURSION', a.callsign, arr?.callsign ?? null, rs.name, arr ? `on ${ref} with ${arr.callsign} ${arr.nm.toFixed(1)} NM final` : `on ${ref} without clearance`);
      if (ev) this.emit('ground_conflict', a, `RUNWAY INCURSION: ${a.callsign} on ${ref}${arr ? ` with ${arr.callsign} on final` : ''}`);
      this.safe('alerts', () => this.alerts.raise('runway_incursion', arr ? [a.callsign, arr.callsign] : [a.callsign], `Runway incursion ${ref}`, ev?.detail ?? '', this.time, { runway: rs.name }, [a.id]), undefined);
    }
  }
  private stepAlerts(dt: number) {
    if (!this.sys.alerts) return;
    const ctx: AlertStepCtx = {
      time: this.time,
      requiredSepNM: (a, b) => this.requiredSepNM(a, b),
      reducedMinima: (a, b) => this.reducedMinima(a, b),
      msaAt: () => null,
      onRunwayWithoutClearance: (id) => this.onRunwayWithoutClearance(id),
      arrivalOnFinal: (rw, nm) => this.arrivalOnFinal(rw, nm)?.callsign ?? null,
      rollingDeparture: (rw) => this.rollingDeparture(rw),
      wakeTimerRemainingS: (rw) => this.wakeTimerRemainingS(rw),
    };
    const vehicles = this.safe('fleet', () => this.fleet.list(), [] as Vehicle[]);
    const res = this.safe('alerts', () => this.alerts.step(this.aircraft, vehicles, this.runways, dt, ctx), null);
    if (!res) return;
    for (const ev of res.events) this.pushEvent(ev);
    for (const al of res.resolved) if (al.kind === 'stca' && al.predicted) this.addScore('STCA_RESOLVED', al.subjects[0], al.subjects[1] ?? null);
  }
  activeAlerts(): Alert[] { return this.safe('alerts', () => this.alerts.active(), [] as Alert[]); }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Test / store views
  // ═══════════════════════════════════════════════════════════════════════════
  viewOf(a: AircraftState): AircraftView {
    return {
      id: a.id, callsign: a.callsign, type: a.perf.icaoCode, phase: a.phase, stage: this.stageOf(a), plan: { ...a.plan },
      pos: { x: a.pos.x, y: a.pos.y }, heading: a.heading, speed: a.speed, altitude: a.altitude,
      targetHeading: a.targetHeading, targetSpeed: a.targetSpeed, targetAltitude: a.targetAltitude,
      cmdAltitude: a.cmdAltitude, cmdIas: a.cmdIas, expedite: a.expedite, navMode: a.navMode,
      ilsArmed: a.ilsArmed, ilsCaptured: a.ilsCaptured, gsCaptured: a.gsCaptured, assignedRunway: a.assignedRunway,
      holdFixName: a.holdFixName, holdPhase: a.holdPhase, directTargetName: a.directTargetName,
      conflict: !!a.conflict, trafficHold: a.trafficHold, holdReleased: a.holdReleased, takeoffCleared: a.takeoffCleared,
      pendingCmds: a.pendingCmds.map(c => ({ ...c })), pathTotal: a.path?.total ?? 0, distAlong: a.distAlong, taxiRoute: [...(a.plan.taxiRoute ?? [])],
      attention: a.attention, underControl: a.underControl,
      wakeCategory: a.wakeCategory, requests: a.requests.map(r => ({ ...r })), emergency: a.emergency ? { ...a.emergency, checklist: { ...a.emergency.checklist }, requests: [...a.emergency.requests] } : null,
      landingCleared: a.landingCleared, holdShortNode: a.holdShortNode, holdShortRunway: a.holdShortRunway, onFrequency: a.onFrequency, handedTo: a.handedTo,
      goAround: a.goAround, squawk: a.squawk, pushbackStage: a.pushback.stage, startupReadyAt: a.startup.readyAt, reservedStand: a.reservedStand, fuelMin: a.fuelMin,
    };
  }
  snapshotForTest(): AircraftView[] { return this.aircraft.map(a => this.viewOf(a)); }
  /** Wake timers per runway end (test API shape). */
  wakeTimers(): Record<string, { runway: string; leader: string; remainingS: number }> {
    const out: Record<string, { runway: string; leader: string; remainingS: number }> = {};
    for (const rs of this.runways) if (rs.wakeTimer && rs.wakeTimer.expiresAt > this.time) out[rs.name] = { runway: rs.name, leader: rs.wakeTimer.leader, remainingS: Math.round(rs.wakeTimer.expiresAt - this.time) };
    return out;
  }
  /** Distance (m) to the next hold on the aircraft's path, null when none (ActionCtx.distToNextHoldM). */
  distToNextHold(a: AircraftState): { m: number; runway: string | null; isCrossing: boolean } | null {
    const h = a.path?.holds?.[0]; if (!h || a.holdReleased) return null;
    return { m: Math.max(0, h.at - a.distAlong), runway: h.runway || null, isCrossing: !h.isDepartureEntry && !!h.runway };
  }
  /** Runways whose centrelines are parallel to `runway` (within 10 deg), other physical runways only. */
  parallelRunways(runway: string): string[] {
    const rs = this.runwayState(runway); if (!rs) return [];
    return this.runways.filter(r => r.ref !== rs.ref && Math.abs(angleDelta(r.headingTrue, rs.headingTrue)) < 10).map(r => r.name);
  }
  /** Physically on a runway strip (ActionCtx.onRunway). */
  isOnRunway(a: AircraftState): boolean { return !isAirborne(a) && this.runwaysAt(a.pos).length > 0; }
}

function pairKey(a: number, b: number) { return a < b ? `${a}-${b}` : `${b}-${a}`; }
function rawLength(air: OsmAirport, ids: string[]): number {
  let m = 0;
  for (let i = 0; i < ids.length - 1; i++) { const n = air.nodes.get(ids[i]); const e = n?.edges.find(x => x.to === ids[i + 1]); if (e) m += e.meters; }
  return m;
}
function describeTarget(t: VehicleTarget): string {
  switch (t.kind) { case 'runway': return `runway ${t.runway}`; case 'aircraft': return t.callsign; case 'stand': return `stand ${t.ref}`; case 'point': return 'map point'; case 'station': return 'station'; }
}

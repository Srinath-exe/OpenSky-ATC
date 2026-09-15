// ============================================================
//  Ground vehicles (W1-SYSTEMS implements; W1-ENGINE calls)
//
//  Vehicles are path-following entities on the taxiway graph (own A* with
//  per-type runway costs + the same arc-length follower maths as aircraft),
//  with runway-crossing holds identical to aircraft (PathHold on the
//  DrivePath), states standby|enroute|onscene|returning, station positions per
//  airport and a per-type speed table (03 §1.13, UX 04 §6).
//
//  Data flow: engine.update() -> fleet.step(dt, ctx) each fixed step. The
//  engine passes a VehicleStepCtx view (graph, projection, runway states,
//  aircraft positions) and consumes the returned VehicleStepResult (events,
//  runway occupancy changes, crossing requests). dispatch.ts calls
//  dispatch()/recall()/op() for the `dispatchVehicle` / `recallVehicle` /
//  `vehicleOp` AST kinds.
//
//  Behaviour summary
//    ARFF (Fire 1-3)  roll-out delay 60-120 s, then 80/100/30 km/h; park 60 m
//                     beside the runway abeam the touchdown zone (runway target)
//                     or 50 m abeam an aircraft; stay until recalled / dwell.
//                     Responding vehicles cross a runway without stopping when
//                     the engine says it is safe (holdReleased = true, so the
//                     alert engine does not flag an incursion) and otherwise
//                     hold short and request like everybody else.
//    Ambulance        to an aircraft / stand, 180 s dwell.
//    Follow-me        rendezvous 60 m ahead of the aircraft, then leads along
//                     the aircraft's own route (position = aircraft path + 60 m,
//                     capped before the aircraft's next hold line) at <= 15 kt;
//                     peels off when the aircraft parks.
//    Tug              driven by a.pushback.tugId: drives to the aircraft when
//                     the engine sets `tug_enroute`, sits on the nose while
//                     attached (position = nose + offset), returns on disconnect.
//    Ops (inspection) drives to the threshold; enters only when the runway is
//                     closed/inspection (else holds short and requests); drives
//                     the full length and back at 60-80 km/h; 10 % "FOD found,
//                     five more minutes"; reports complete and returns.
//    Sweeper / Bird   threshold stand-by point, dwell, report, return.
//    Fuel / De-ice    stand targets only; never routed over a runway.
//  All randomness via rng.ts.
// ============================================================
import type { XY } from './projection';
import { LocalProjection, KTS_TO_MPS, advance, angleDelta, arcLengths, chaikin, dedupeBacktracks, dist, distToSegment, headingTo, resample, sampleAlong } from './projection';
import type { OsmAirport, OsmNode } from '../osmAirport';
import { chance, rf } from './rng';
import type { AircraftState, DrivePath, PathHold, RunwayState, SimEvent, Vehicle, VehicleState, VehicleTarget, VehicleType } from './types';

// ──────────────────────────────────────────────────────────────────────────────
//  Fleet data (03 §1.13 table, UX §G4 picker-vehicle default fleet)
// ──────────────────────────────────────────────────────────────────────────────
export interface VehicleSpec {
  id: string;
  callsign: string;
  type: VehicleType;
  /** km/h per surface (03 §1.13); converted to kt inside init(). */
  speedKmh: { taxiway: number; runway: number; apron: number };
  safetyRadiusM: number;
  /** Where the vehicle parks: key into VehicleStations. */
  station: keyof VehicleStations;
}

export interface VehicleStations {
  fire: XY;
  ops: XY;
  tugPool: XY;
  fuelFarm: XY;
  deicePad: XY;
  apron: XY;
}

export const DEFAULT_FLEET: readonly VehicleSpec[] = [
  { id: 'FIRE1', callsign: 'Fire 1', type: 'arff', speedKmh: { taxiway: 80, runway: 100, apron: 30 }, safetyRadiusM: 8, station: 'fire' },
  { id: 'FIRE2', callsign: 'Fire 2', type: 'arff', speedKmh: { taxiway: 80, runway: 100, apron: 30 }, safetyRadiusM: 8, station: 'fire' },
  { id: 'FIRE3', callsign: 'Fire 3', type: 'arff', speedKmh: { taxiway: 80, runway: 100, apron: 30 }, safetyRadiusM: 8, station: 'fire' },
  { id: 'AMB1', callsign: 'Medic 1', type: 'ambulance', speedKmh: { taxiway: 60, runway: 80, apron: 25 }, safetyRadiusM: 6, station: 'fire' },
  { id: 'FOLLOW1', callsign: 'Follow-me 1', type: 'followme', speedKmh: { taxiway: 50, runway: 60, apron: 25 }, safetyRadiusM: 5, station: 'ops' },
  { id: 'TUG1', callsign: 'Tug 1', type: 'tug', speedKmh: { taxiway: 28, runway: 28, apron: 28 }, safetyRadiusM: 6, station: 'tugPool' },
  { id: 'TUG2', callsign: 'Tug 2', type: 'tug', speedKmh: { taxiway: 28, runway: 28, apron: 28 }, safetyRadiusM: 6, station: 'tugPool' },
  { id: 'OPS1', callsign: 'Ops 1', type: 'ops', speedKmh: { taxiway: 60, runway: 70, apron: 30 }, safetyRadiusM: 5, station: 'ops' },
  { id: 'SWEEP1', callsign: 'Sweeper 1', type: 'sweeper', speedKmh: { taxiway: 40, runway: 30, apron: 20 }, safetyRadiusM: 6, station: 'ops' },
  { id: 'BIRD1', callsign: 'Bird 1', type: 'bird', speedKmh: { taxiway: 40, runway: 40, apron: 25 }, safetyRadiusM: 5, station: 'ops' },
];

/** Extended fleet (03 §1.13 full table): +Follow-me 2, Tug 3, Fuel 1/2, Iceman 1/2. Pass to init() for large airports. */
export const FULL_FLEET: readonly VehicleSpec[] = [
  ...DEFAULT_FLEET,
  { id: 'FOLLOW2', callsign: 'Follow-me 2', type: 'followme', speedKmh: { taxiway: 50, runway: 60, apron: 25 }, safetyRadiusM: 5, station: 'ops' },
  { id: 'TUG3', callsign: 'Tug 3', type: 'tug', speedKmh: { taxiway: 28, runway: 28, apron: 28 }, safetyRadiusM: 6, station: 'tugPool' },
  { id: 'FUEL1', callsign: 'Fuel 1', type: 'fuel', speedKmh: { taxiway: 30, runway: 0, apron: 20 }, safetyRadiusM: 8, station: 'fuelFarm' },
  { id: 'FUEL2', callsign: 'Fuel 2', type: 'fuel', speedKmh: { taxiway: 30, runway: 0, apron: 20 }, safetyRadiusM: 8, station: 'fuelFarm' },
  { id: 'ICE1', callsign: 'Iceman 1', type: 'deice', speedKmh: { taxiway: 25, runway: 0, apron: 15 }, safetyRadiusM: 8, station: 'deicePad' },
  { id: 'ICE2', callsign: 'Iceman 2', type: 'deice', speedKmh: { taxiway: 25, runway: 0, apron: 15 }, safetyRadiusM: 8, station: 'deicePad' },
];

/** Timing constants (03 §8 / §H). */
export const VEHICLE_CONST = {
  /** ARFF roll-out delay (alarm -> wheels rolling), s. 03 §8 lists 60-120 as a game value; 30-60 keeps the ICAO 3-minute response achievable from a single station. */
  arffRolloutDelayS: [30, 60] as const,
  /** ARFF must reach any runway point within 180 s of "rolling" (ICAO Annex 14 §9.2). */
  arffResponseLimitS: 180,
  /** On-scene dwell defaults, s: ARFF 8-20 min after stop; ambulance 180; ops inspection 180-360; bird 240-480; sweeper 120-180. */
  onSceneS: { arff: [480, 1200], ambulance: [180, 180], followme: [0, 0], tug: [0, 0], fuel: [480, 900], deice: [240, 600], ops: [180, 360], sweeper: [120, 180], bird: [240, 480] } as Record<VehicleType, readonly [number, number]>,
  /** Auto-return after "stand down", s. */
  standDownReturnS: 120,
  /** Rendezvous distance ahead of an escorted aircraft, m. */
  followMeLeadM: 60,
  /** Follow-me leading speed cap, kt. */
  followMeLeadKt: 15,
  /** Runway crossing lock buffer for vehicles (03 §D12), s. */
  crossingBufferS: 20,
  /** ARFF stand-by point: distance in from the threshold (touchdown zone) and lateral offset from the centreline, m. */
  arffStandbyInM: 300,
  arffStandbyOffsetM: 60,
  /** Park abeam an aircraft, m (03 §4 "stop 50 m abeam"). */
  parkAbeamM: 50,
  /** Hold line distance from the runway centreline for vehicles, m; runway strip half-width for "on runway", m. */
  holdLineM: 60,
  runwayHalfWidthM: 35,
  /** Non-responding ARFF / tug solo speed, kt; tug pushing, kt. */
  normalSpeedKt: 15,
  tugPushKt: 3,
  /** Vehicle accel / decel, m/s^2. */
  accelMps2: 1.6,
  decelMps2: 2.5,
  /** Minimum speed through a sharp bend, kt (responding ARFF corner at ~35 km/h). */
  bendMinKt: 9,
  bendMinRespondingKt: 18,
  /** Aircraft-target re-plan interval, s, and movement threshold, m. */
  retargetS: 5,
  retargetM: 40,
  /** FOD probability during an inspection; extra dwell, s. */
  fodP: 0.1,
  fodExtraS: 300,
} as const;

export const KMH_TO_KT = 0.539957;

// ──────────────────────────────────────────────────────────────────────────────
//  Engine <-> fleet interface
// ──────────────────────────────────────────────────────────────────────────────
/** What the fleet needs from the engine each step (read-only view). */
export interface VehicleStepCtx {
  time: number;
  air: OsmAirport;
  nodeXY(nodeId: string): XY | null;
  nearestNodeId(p: XY): string | null;
  /** Build a taxi DrivePath through node ids (engine.pathFromNodes). */
  pathFromNodes(ids: string[]): DrivePath | null;
  runways: RunwayState[];
  aircraft: readonly AircraftState[];
  /** Whether crossing `runway` is currently safe per 03 §D12 (arrival time-to-threshold, no rolling departure). */
  crossingSafe(runway: string): boolean;
  /** Vehicle auto-cross setting (UX §6 veh-auto-cross). */
  autoCross: boolean;
}

export interface VehicleStepResult {
  events: SimEvent[];
  /** Runway refs that vehicles entered / vacated this step (engine updates RunwayState.occupiedBy). `runway` is an END name; `cleared` = crossing/entry was cleared (no incursion). */
  enteredRunway: Array<{ vehicleId: string; runway: string; cleared?: boolean }>;
  vacatedRunway: Array<{ vehicleId: string; runway: string }>;
  /** Vehicles now holding short of a runway and waiting for a crossing clearance (REQ strip). */
  crossingRequests: Array<{ vehicleId: string; runway: string }>;
}

export interface DispatchResult {
  ok: boolean;
  vehicles: Vehicle[];
  /** Predicted arrival, sim s, for the slowest vehicle dispatched. */
  etaAt: number | null;
  reason?: string;
}

/** Per-vehicle memory that is not part of the JSON Vehicle record. */
interface Internal {
  spec: VehicleSpec;
  /** Emergency response (ARFF / ambulance dispatched to a runway or an emergency aircraft). */
  responding: boolean;
  rolloutUntil: number;
  /** Index of the next hold in path.holds. */
  holdIdx: number;
  /** Crossing request already voiced for the current hold. */
  requested: boolean;
  waitingSince: number | null;
  /** Physical ref of the runway the current hold protects. */
  holdRef: string | null;
  retargetAt: number;
  targetXY: XY | null;
  parkXY: XY | null;
  /** Ops: inspection sub-state. */
  inspecting: 'none' | 'requested' | 'driving' | 'fod' | 'done';
  inspectRef: string | null;
  fodUntil: number | null;
  /** Follow-me: leading the aircraft. */
  leading: boolean;
  /** Tug: aircraft id while attached. */
  attachedTo: number | null;
  /** Last aircraft position known for a moving target. */
  lastTargetPos: XY | null;
  reported: boolean;
}

const norm360 = (d: number) => ((d % 360) + 360) % 360;
const fmtEta = (s: number) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.round(Math.max(0, s) % 60)).padStart(2, '0')}`;

/**
 * The fleet. One instance per loaded airport, owned by the engine.
 *
 * Lifecycle:
 *   init(air, stations)  -> creates DEFAULT_FLEET vehicles parked at their station
 *                           (nearest graph node to the station XY; airport
 *                           centre when a station is missing), state 'standby'.
 *   dispatch(type, target, ids?, count?) -> picks `ids` or the first `count`
 *                           standby vehicles of `type`, builds a path from the
 *                           station node to the target node (runway: taxiway
 *                           node nearest the touchdown zone; aircraft: node
 *                           nearest the aircraft, re-targeted every 5 s while
 *                           it moves; stand: its node; point: nearest node),
 *                           inserts runway-crossing holds exactly like aircraft
 *                           (PathHold on the DrivePath), sets state 'enroute',
 *                           dispatchedAt=now, etaAt from path length / speeds.
 *                           ARFF adds the roll-out delay before moving.
 *   recall(id)           -> path back to station, state 'returning'; a runway
 *                           it was closing is NOT reopened (explicit reopen only).
 *   step(dt, ctx)        -> advances every non-standby vehicle along its path
 *                           (speed by surface: runway/taxiway/apron), stops
 *                           at hold-short places until cleared (op 'cross'),
 *                           autoCross && crossingSafe, or (responding &&
 *                           crossingSafe); reports runway enter/vacate; flips
 *                           enroute->onscene at the target (parks 50-60 m
 *                           abeam), onscene->returning when onSceneUntil
 *                           passes, returning->standby at station.
 *   list()               -> all vehicles (JSON-serialisable, for the store/UI/test API).
 *   stationFor(type)     -> station XY for a type.
 */
export class VehicleFleet {
  private vehicles: Vehicle[] = [];
  private stations: VehicleStations | null = null;
  private air: OsmAirport | null = null;
  private proj: LocalProjection | null = null;
  private xyCache = new Map<string, XY>();
  private internal = new Map<string, Internal>();
  private now = 0;
  private dt = FIXED_DT;
  private lastCtx: VehicleStepCtx | null = null;
  private pendingEvents: SimEvent[] = [];
  /** Nodes that lie on a runway centreline (have runway edges or are within 30 m of one). */
  private runwayNodes = new Map<string, string>(); // nodeId -> physical ref
  private runwayGeom: Array<{ ref: string; ends: Array<{ name: string; xy: XY; nodeId: string }> }> = [];

  /** Create the fleet for an airport. `stations` XY are in engine local metres. */
  init(air: OsmAirport, stations: VehicleStations, fleet: readonly VehicleSpec[] = DEFAULT_FLEET): void {
    this.air = air;
    this.stations = stations;
    this.proj = new LocalProjection(air.center.lat, air.center.lng);
    this.xyCache.clear();
    this.internal.clear();
    this.vehicles = [];
    this.pendingEvents = [];
    this.now = 0;
    this.lastCtx = null;
    this.buildRunwayGeometry();
    for (const spec of fleet) {
      const station = stations[spec.station] ?? this.centerXY();
      const stationNodeId = this.nearestNodeId(station, spec.type === 'fuel' || spec.type === 'deice') ?? '';
      const v: Vehicle = {
        id: spec.id, callsign: spec.callsign, type: spec.type, state: 'standby',
        pos: { ...station }, heading: 0, speed: 0, station: { ...station }, stationNodeId,
        target: null, path: null, distAlong: 0, holdShortNode: null, holdShortRunway: null, holdReleased: false, trafficHold: false,
        onRunway: null, dispatchedAt: null, etaAt: null, arrivedAt: null, onSceneUntil: null,
        maxSpeedKt: { taxiway: spec.speedKmh.taxiway * KMH_TO_KT, runway: spec.speedKmh.runway * KMH_TO_KT, apron: spec.speedKmh.apron * KMH_TO_KT },
        safetyRadiusM: spec.safetyRadiusM, trail: [],
      };
      this.vehicles.push(v);
      this.internal.set(v.id, this.freshInternal(spec));
    }
  }

  private freshInternal(spec: VehicleSpec): Internal {
    return { spec, responding: false, rolloutUntil: 0, holdIdx: 0, requested: false, waitingSince: null, holdRef: null, retargetAt: 0, targetXY: null, parkXY: null, inspecting: 'none', inspectRef: null, fodUntil: null, leading: false, attachedTo: null, lastTargetPos: null, reported: false };
  }

  // ── geometry ──────────────────────────────────────────────────────────────
  private centerXY(): XY { return { x: 0, y: 0 }; }

  nodeXY(nodeId: string): XY | null {
    const c = this.xyCache.get(nodeId);
    if (c) return c;
    const n = this.air?.nodes.get(nodeId);
    if (!n || !this.proj) return null;
    const xy = this.proj.toXY(n.lat, n.lng);
    this.xyCache.set(nodeId, xy);
    return xy;
  }

  private buildRunwayGeometry(): void {
    this.runwayNodes.clear();
    this.runwayGeom = [];
    if (!this.air || !this.proj) return;
    for (const rw of this.air.runways) {
      const ends = rw.ends.map(e => ({ name: e.name, xy: this.proj!.toXY(e.lat, e.lng), nodeId: e.nodeId }));
      if (ends.length < 2) continue;
      this.runwayGeom.push({ ref: rw.ref, ends });
    }
    for (const n of this.air.nodes.values()) {
      const hasRunwayEdge = n.edges.some(e => e.type === 'runway');
      const xy = this.nodeXY(n.id)!;
      const ref = this.runwayRefAt(xy, hasRunwayEdge ? 60 : 30);
      if (ref) this.runwayNodes.set(n.id, ref);
    }
  }

  /** Physical runway ref whose centreline is within `halfWidth` m of a point, else null. */
  private runwayRefAt(p: XY, halfWidth: number = VEHICLE_CONST.runwayHalfWidthM): string | null {
    let best: string | null = null, bestD: number = halfWidth;
    for (const rw of this.runwayGeom) {
      const d = distToSegment(p, rw.ends[0].xy, rw.ends[1].xy);
      if (d < bestD) { bestD = d; best = rw.ref; }
    }
    return best;
  }
  private runwayByEnd(end: string) {
    const u = end.toUpperCase();
    for (const rw of this.runwayGeom) {
      const e = rw.ends.find(x => x.name.toUpperCase() === u);
      if (e) return { rw, end: e, other: rw.ends.find(x => x !== e)! };
    }
    return null;
  }
  private runwayByRef(ref: string) { return this.runwayGeom.find(r => r.ref === ref) ?? null; }
  /** Physical runway currently closed / under inspection per the last engine view (false when unknown). */
  private runwayClosed(ref: string): boolean {
    const rs = this.lastCtx?.runways.find(r => r.ref === ref);
    return !!rs && (rs.status === 'closed' || rs.status === 'inspection');
  }
  /** Straight-line inspection drive: hold point -> threshold -> far end -> threshold -> hold point (no smoothing, so the hairpin survives). */
  private inspectionPath(from: XY, a: XY, b: XY, park: XY): DrivePath {
    const pts: XY[] = [];
    for (const leg of [[from, a, b], [b, a, park]]) {
      for (const p of resample(leg, 15)) if (!pts.length || dist(pts[pts.length - 1], p) > 0.5) pts.push(p);
    }
    const { cum, total } = arcLengths(pts);
    return { pts, cum, total, kind: 'runway' };
  }
  private endNameForRef(ref: string): string { return this.runwayByRef(ref)?.ends[0].name ?? ref; }

  /** Nearest graph node to a point (optionally excluding runway nodes). */
  private nearestNodeId(p: XY, excludeRunway = true, maxM = Infinity): string | null {
    if (!this.air) return null;
    let best: string | null = null, bestD = maxM * maxM;
    for (const id of this.air.nodes.keys()) {
      if (excludeRunway && this.runwayNodes.has(id)) continue;
      const xy = this.nodeXY(id)!;
      const d = (xy.x - p.x) ** 2 + (xy.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  /** Nearest non-runway node to `p` that is at least `minD` m from the centreline of physical runway `ref`. */
  private nearestNodeClearOf(p: XY, ref: string, minD: number, maxM = Infinity): string | null {
    const rw = this.runwayByRef(ref);
    if (!this.air || !rw) return null;
    let best: string | null = null, bestD = maxM * maxM;
    for (const id of this.air.nodes.keys()) {
      if (this.runwayNodes.has(id)) continue;
      const xy = this.nodeXY(id)!;
      const d = (xy.x - p.x) ** 2 + (xy.y - p.y) ** 2;
      if (d >= bestD) continue;
      if (distToSegment(xy, rw.ends[0].xy, rw.ends[1].xy) < minD) continue;
      bestD = d; best = id;
    }
    return best;
  }

  /** A* over the OSM graph with per-vehicle runway costs (fuel/de-ice never; responding ARFF x6; others x40 like aircraft). */
  private findPath(startId: string, goalId: string, type: VehicleType, responding: boolean, allowRunwayRef: string | null = null): string[] | null {
    const air = this.air; if (!air) return null;
    const nodes = air.nodes;
    const start = nodes.get(startId), goal = nodes.get(goalId);
    if (!start || !goal) return null;
    const goalXY = this.nodeXY(goalId)!;
    const h = (id: string) => dist(this.nodeXY(id)!, goalXY);
    // a target runway is a cheap corridor only when it is already closed (inspection vehicles never use it: their entry is explicit)
    const corridor = allowRunwayRef && type !== 'ops' && type !== 'sweeper' && this.runwayClosed(allowRunwayRef) ? allowRunwayRef : null;
    const runwayFactor = (edge: OsmNode['edges'][number], from: string): number => {
      const onRw = edge.type === 'runway' || this.runwayNodes.has(edge.to) || this.runwayNodes.has(from);
      if (!onRw) return 1;
      const ref = this.runwayNodes.get(edge.to) ?? this.runwayNodes.get(from) ?? null;
      if (corridor && ref === corridor && edge.type === 'runway') return 1.2;
      if (type === 'fuel' || type === 'deice') return edge.type === 'runway' ? Infinity : 4;
      if (edge.type === 'runway') return responding ? 6 : 40;
      return responding ? 1.5 : 3; // taxiway edge touching a runway node (a crossing)
    };
    const open = new Map<string, number>([[startId, h(startId)]]);
    const came = new Map<string, string>();
    const g = new Map<string, number>([[startId, 0]]);
    const closed = new Set<string>();
    let guard = 0;
    while (open.size && guard++ < 200000) {
      let cur = '', best = Infinity;
      for (const [id, f] of open) if (f < best) { best = f; cur = id; }
      if (cur === goalId) {
        const path = [cur];
        while (came.has(cur)) { cur = came.get(cur)!; path.unshift(cur); }
        return path;
      }
      open.delete(cur); closed.add(cur);
      const node = nodes.get(cur)!;
      const gc = g.get(cur) ?? Infinity;
      for (const e of node.edges) {
        if (closed.has(e.to)) continue;
        const f = runwayFactor(e, cur);
        if (!isFinite(f)) continue;
        const tentative = gc + e.meters * f;
        if (tentative < (g.get(e.to) ?? Infinity)) {
          came.set(e.to, cur); g.set(e.to, tentative); open.set(e.to, tentative + h(e.to));
        }
      }
    }
    return null;
  }

  /** Smooth a raw polyline into a DrivePath (same recipe as the engine, lighter smoothing) and derive runway-crossing holds from the node list. */
  private buildPath(raw: XY[], ids: string[], kind: DrivePath['kind'] = 'taxi', targetRef: string | null = null): DrivePath | null {
    const clean = dedupeBacktracks(raw, 2);
    if (clean.length < 2) return null;
    const uniform = resample(clean, kind === 'taxi' ? 6 : 20);
    const pts = chaikin(uniform, kind === 'taxi' ? 2 : 1);
    const { cum, total } = arcLengths(pts);
    const path: DrivePath = { pts, cum, total, kind };
    if (ids.length) path.holds = this.deriveHolds(path, ids, targetRef);
    return path;
  }

  /** Arc-length of the path point nearest to `p`, searching from `fromIdx`; returns { at, idx }. */
  private arcOf(path: DrivePath, p: XY, fromIdx = 0): { at: number; idx: number; d: number } {
    let bestI = fromIdx, bestD = Infinity;
    for (let i = fromIdx; i < path.pts.length; i++) {
      const d = (path.pts[i].x - p.x) ** 2 + (path.pts[i].y - p.y) ** 2;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return { at: path.cum[bestI], idx: bestI, d: Math.sqrt(bestD) };
  }

  /**
   * Hold-short places: for every entry onto a runway centreline node along the
   * node list, the last point of the path that is still >= holdLineM from that
   * runway's centreline (03 master plan: hold-short is a place). The runway the
   * vehicle is heading to for an inspection / stand-by is still a hold (it needs
   * an entry clearance); crossings of the same physical runway twice get two holds.
   */
  private deriveHolds(path: DrivePath, ids: string[], targetRef: string | null): PathHold[] {
    void targetRef;
    const holds: PathHold[] = [];
    let idx = 0;
    let prevRef: string | null = this.runwayNodes.get(ids[0]) ?? null;
    for (let i = 1; i < ids.length; i++) {
      const ref = this.runwayNodes.get(ids[i]) ?? null;
      if (ref && ref !== prevRef) {
        const rw = this.runwayByRef(ref);
        const entry = this.arcOf(path, this.nodeXY(ids[i])!, idx);
        // walk back from the entry point to the last point >= holdLineM from the centreline
        let j = entry.idx;
        if (rw) {
          while (j > 0 && distToSegment(path.pts[j], rw.ends[0].xy, rw.ends[1].xy) < VEHICLE_CONST.holdLineM) j--;
        } else { j = Math.max(0, entry.idx - 8); }
        const at = Math.max(0, path.cum[j] - 2);
        if (!holds.length || at - holds[holds.length - 1].at > 30) {
          holds.push({ nodeId: ids[i - 1], runway: rw ? rw.ends[0].name : ref, at, isDepartureEntry: false });
        }
        idx = entry.idx;
      }
      prevRef = ref;
    }
    return holds;
  }

  // ── targets ───────────────────────────────────────────────────────────────
  /** Resolve a target to { goal node, park point, runway ref } for a vehicle type. */
  private resolveTarget(type: VehicleType, target: VehicleTarget, from: XY): { goalId: string; park: XY; ref: string | null; targetXY: XY } | null {
    if (!this.air) return null;
    switch (target.kind) {
      case 'runway': {
        const r = this.runwayByEnd(target.runway);
        if (!r) return null;
        const hdg = headingTo(r.end.xy, r.other.xy);
        if (type === 'ops' || type === 'sweeper') {
          // inspection: drive to the taxiway node nearest the threshold and park at the
          // hold-short place (holdLineM off the centreline) - the runway entry itself is
          // handled by the inspection logic once the runway is closed / cleared.
          const goalId = this.nearestNodeClearOf(r.end.xy, r.rw.ref, VEHICLE_CONST.runwayHalfWidthM + 5, 400) ?? this.nearestNodeId(r.end.xy, true, 400) ?? r.end.nodeId;
          const gxy = this.nodeXY(goalId) ?? r.end.xy;
          const holdD = VEHICLE_CONST.holdLineM + 5;
          const dg = distToSegment(gxy, r.end.xy, r.other.xy);
          let park: XY;
          if (dg > holdD) {
            const f = 1 - holdD / dg;
            park = { x: gxy.x + (r.end.xy.x - gxy.x) * f, y: gxy.y + (r.end.xy.y - gxy.y) * f };
          } else if (dg > 1) {
            park = advance(gxy, headingTo(r.end.xy, gxy), holdD - dg);
          } else {
            park = advance(r.end.xy, hdg + 180, holdD);
          }
          return { goalId, park, ref: r.rw.ref, targetXY: r.end.xy };
        }
        const tdz = advance(r.end.xy, hdg, VEHICLE_CONST.arffStandbyInM);
        const goalId = this.nearestNodeId(tdz, true, 350) ?? this.nearestNodeId(r.end.xy, true, 500) ?? this.nearestNodeId(r.end.xy, false);
        if (!goalId) return null;
        const gxy = this.nodeXY(goalId)!;
        // park on the side of the goal node, 60 m off the centreline
        const side = Math.sign(((gxy.x - r.end.xy.x) * Math.cos(hdg * Math.PI / 180)) - ((gxy.y - r.end.xy.y) * Math.sin(hdg * Math.PI / 180))) || 1;
        const off = type === 'bird' ? 80 : VEHICLE_CONST.arffStandbyOffsetM;
        const park = advance(tdz, hdg + 90 * side, off);
        return { goalId, park, ref: r.rw.ref, targetXY: tdz };
      }
      case 'aircraft': {
        const a = this.lastCtx?.aircraft.find(x => x.id === target.id || x.callsign === target.callsign.toUpperCase());
        if (!a) return null;
        const onRw = this.runwayRefAt(a.pos, 45);
        const goalId = this.nearestNodeId(a.pos, !onRw, onRw ? 300 : Infinity) ?? this.nearestNodeId(a.pos, false);
        if (!goalId) return null;
        const gxy = this.nodeXY(goalId)!;
        const side = Math.sign(((gxy.x - a.pos.x) * Math.cos(a.heading * Math.PI / 180)) - ((gxy.y - a.pos.y) * Math.sin(a.heading * Math.PI / 180))) || 1;
        const park = type === 'followme' ? advance(a.pos, a.heading, VEHICLE_CONST.followMeLeadM) : type === 'tug' ? advance(a.pos, a.heading, a.perf.lengthMeters / 2 + 6) : advance(a.pos, a.heading + 90 * side, VEHICLE_CONST.parkAbeamM);
        return { goalId, park, ref: onRw, targetXY: { ...a.pos } };
      }
      case 'stand': {
        const g = this.air.gates.find(x => x.ref.toUpperCase() === target.ref.toUpperCase());
        if (!g) return null;
        const gxy = this.proj!.toXY(g.lat, g.lng);
        const park = advance(gxy, headingTo(from, gxy) + 90, 25);
        return { goalId: g.nodeId, park, ref: null, targetXY: gxy };
      }
      case 'point': {
        const goalId = this.nearestNodeId(target.xy, true);
        if (!goalId) return null;
        return { goalId, park: { ...target.xy }, ref: this.runwayRefAt(target.xy, 45), targetXY: { ...target.xy } };
      }
      case 'station': {
        const st = this.stationFor(type);
        const goalId = this.nearestNodeId(st, true);
        if (!goalId) return null;
        return { goalId, park: { ...st }, ref: null, targetXY: { ...st } };
      }
    }
  }

  /** Plan and install a route for a vehicle from its current position to `target`. Returns false when no route exists. */
  private plan(v: Vehicle, target: VehicleTarget): boolean {
    const it = this.internal.get(v.id)!;
    const res = this.resolveTarget(v.type, target, v.pos);
    if (!res) return false;
    const startId = this.nearestNodeId(v.pos, !this.runwayRefAt(v.pos, 45));
    if (!startId) return false;
    const ids = startId === res.goalId ? [startId] : this.findPath(startId, res.goalId, v.type, it.responding, res.ref);
    if (!ids) return false;
    const raw: XY[] = [{ ...v.pos }];
    for (const id of ids) { const xy = this.nodeXY(id); if (xy) raw.push(xy); }
    raw.push(res.park);
    const path = this.buildPath(raw, ids, 'taxi', res.ref);
    if (!path) return false;
    v.path = path;
    v.distAlong = 0;
    v.holdReleased = false;
    v.holdShortNode = null;
    v.holdShortRunway = null;
    it.holdIdx = 0;
    it.requested = false;
    it.waitingSince = null;
    it.holdRef = null;
    it.targetXY = res.targetXY;
    it.parkXY = res.park;
    it.inspectRef = res.ref;
    // if the vehicle is already inside a runway strip that the first hold protects, skip that hold
    const onRef = this.runwayRefAt(v.pos);
    if (onRef && path.holds?.length && this.runwayByEnd(path.holds[0].runway)?.rw.ref === onRef && path.holds[0].at < 20) it.holdIdx = 1;
    return true;
  }

  /** Predicted travel time (s) for a vehicle along its current path from distAlong, incl. roll-out delay and a nominal hold pause. */
  private travelTimeS(v: Vehicle): number {
    const p = v.path; if (!p) return 0;
    const it = this.internal.get(v.id)!;
    const spd = this.speedTable(v, it);
    let t = 0;
    const step = 25;
    for (let d = v.distAlong; d < p.total; d += step) {
      const s = sampleAlong(p.pts, p.cum, Math.min(d, p.total));
      const onRw = this.runwayRefAt(s.pos) != null;
      const kt = onRw ? spd.runway : spd.taxiway;
      t += Math.min(step, p.total - d) / Math.max(2, kt * KTS_TO_MPS);
    }
    t += 8; // accel / decel
    const autoCross = !!this.lastCtx?.autoCross || it.responding;
    for (const h of p.holds ?? []) if (h.at > v.distAlong && this.holdRequired(v, it, h)) t += autoCross ? 3 : 15;
    if (it.rolloutUntil > this.now) t += it.rolloutUntil - this.now;
    return t;
  }

  private speedTable(v: Vehicle, it: Internal): { taxiway: number; runway: number; apron: number } {
    if (v.type === 'arff' || v.type === 'ambulance') {
      return it.responding ? v.maxSpeedKt : { taxiway: VEHICLE_CONST.normalSpeedKt, runway: VEHICLE_CONST.normalSpeedKt, apron: VEHICLE_CONST.normalSpeedKt };
    }
    if (v.type === 'tug') return { taxiway: VEHICLE_CONST.normalSpeedKt, runway: VEHICLE_CONST.normalSpeedKt, apron: VEHICLE_CONST.normalSpeedKt };
    return v.maxSpeedKt;
  }

  // ── public API ────────────────────────────────────────────────────────────
  /** Dispatch vehicles of `type` (specific `ids` or the first `count` available) to `target`. */
  dispatch(type: VehicleType, target: VehicleTarget, ids: string[] = [], count = 1): DispatchResult {
    if (!this.air) return { ok: false, vehicles: [], etaAt: null, reason: 'fleet not initialised' };
    let picked: Vehicle[];
    if (ids.length) {
      picked = ids.map(id => this.byId(id.toUpperCase())).filter((v): v is Vehicle => !!v);
      if (!picked.length) return { ok: false, vehicles: [], etaAt: null, reason: `unknown vehicle ${ids.join(', ')}` };
      const busy = picked.filter(v => this.internal.get(v.id)!.attachedTo != null);
      if (busy.length) return { ok: false, vehicles: [], etaAt: null, reason: `${busy.map(b => b.callsign).join(', ')} attached to an aircraft` };
    } else {
      const avail = this.available(type);
      if (!avail.length) return { ok: false, vehicles: [], etaAt: null, reason: `no ${type} vehicle available` };
      picked = avail.slice(0, Math.max(1, count));
    }
    if ((type === 'fuel' || type === 'deice') && target.kind === 'runway') return { ok: false, vehicles: [], etaAt: null, reason: `${type} vehicles never enter runways` };
    const out: Vehicle[] = [];
    let etaAt: number | null = null;
    for (const v of picked) {
      const it = this.internal.get(v.id)!;
      const wasStandby = v.state === 'standby';
      it.responding = (v.type === 'arff' || v.type === 'ambulance') && (target.kind === 'runway' || target.kind === 'aircraft' || target.kind === 'point');
      if (target.kind === 'aircraft' && v.type === 'ambulance') it.responding = true;
      it.leading = false;
      it.inspecting = 'none';
      it.fodUntil = null;
      it.reported = false;
      v.target = target;
      v.trafficHold = false;
      if (!this.plan(v, target)) {
        if (target.kind === 'aircraft' && !this.lastCtx) {
          // no engine view yet: plan lazily on the first step
          v.path = null;
        } else {
          v.target = null;
          continue;
        }
      }
      v.state = 'enroute';
      v.dispatchedAt = this.now;
      v.arrivedAt = null;
      v.onSceneUntil = null;
      it.rolloutUntil = v.type === 'arff' && wasStandby ? this.now + rf(VEHICLE_CONST.arffRolloutDelayS[0], VEHICLE_CONST.arffRolloutDelayS[1]) : 0;
      it.retargetAt = this.now + VEHICLE_CONST.retargetS;
      const eta = v.path ? this.travelTimeS(v) : null;
      v.etaAt = eta != null ? this.now + eta : null;
      if (v.etaAt != null) etaAt = Math.max(etaAt ?? 0, v.etaAt);
      out.push(v);
      this.pendingEvents.push(this.vehicleEvent(v, `${v.id} -> ${targetLabel(target)}${eta != null ? `, ETA ${fmtEta(eta)}` : ''}`, 'SYS'));
      if (v.type === 'arff' && it.responding) this.pendingEvents.push(this.vehicleEvent(v, `${v.callsign}, ${wasStandby ? 'fire station copies, rolling' : 're-tasked, proceeding'} to ${targetLabel(target)}.`, 'PILOT'));
    }
    if (!out.length) return { ok: false, vehicles: [], etaAt: null, reason: 'no route to target' };
    return { ok: true, vehicles: out, etaAt };
  }

  /** Emergency convenience (03 §4 ARFF response model): local standby = 2 ARFF; full emergency = 3 ARFF + ambulance. */
  dispatchEmergency(level: 'local' | 'full', target: VehicleTarget): DispatchResult {
    const arff = this.dispatch('arff', target, [], level === 'full' ? 3 : 2);
    if (level === 'full') {
      const amb = this.dispatch('ambulance', target, [], 1);
      return { ok: arff.ok || amb.ok, vehicles: [...arff.vehicles, ...amb.vehicles], etaAt: Math.max(arff.etaAt ?? 0, amb.etaAt ?? 0) || null, reason: arff.reason ?? amb.reason };
    }
    return arff;
  }

  /** Return a vehicle to its station. Returns false when the id is unknown or already standby. */
  recall(id: string): boolean {
    const v = this.byId(id.toUpperCase());
    if (!v || v.state === 'standby') return false;
    const it = this.internal.get(v.id)!;
    if (it.attachedTo != null) return false;
    it.responding = false;
    it.leading = false;
    it.inspecting = 'none';
    it.fodUntil = null;
    v.onSceneUntil = null;
    v.trafficHold = false;
    if (!this.plan(v, { kind: 'station' })) {
      // no route: teleport home gracefully at the next step
      v.path = null;
    }
    v.target = { kind: 'station' };
    v.state = 'returning';
    v.etaAt = v.path ? this.now + this.travelTimeS(v) : null;
    this.pendingEvents.push(this.vehicleEvent(v, `${v.id} returning to station`, 'SYS'));
    return true;
  }

  /** Radio ops on a vehicle: hold position / continue / cross the runway it is holding short of / return to base. */
  op(id: string, op: 'hold' | 'continue' | 'cross' | 'rtb', runway: string | null): boolean {
    const v = this.byId(id.toUpperCase());
    if (!v) return false;
    const it = this.internal.get(v.id)!;
    switch (op) {
      case 'hold': v.trafficHold = true; return true;
      case 'continue': v.trafficHold = false; return true;
      case 'rtb': return this.recall(v.id);
      case 'cross': {
        const hold = v.path?.holds?.[it.holdIdx] ?? null;
        if (!hold && !v.holdShortRunway) return false;
        const want = runway ? runway.toUpperCase() : null;
        const holdRef = it.holdRef ?? (hold ? this.runwayByEnd(hold.runway)?.rw.ref ?? null : null);
        if (want) {
          const wantRef = this.runwayByEnd(want)?.rw.ref ?? want;
          if (holdRef && wantRef !== holdRef && want !== holdRef) return false;
        }
        v.holdReleased = true;
        v.trafficHold = false;
        it.waitingSince = null;
        // an inspection car waiting for entry stays 'requested': stepInspection builds the drive path on the next step
        const entering = it.inspecting === 'requested';
        const endName = want ?? v.holdShortRunway ?? hold?.runway ?? '';
        this.pendingEvents.push(this.vehicleEvent(v, `${entering ? 'Entering' : 'Crossing'} ${endName}, ${v.callsign}.`, 'PILOT'));
        return true;
      }
    }
  }

  /** Advance every vehicle by dt sim seconds. Called once per fixed engine step. */
  step(dt: number, ctx: VehicleStepCtx): VehicleStepResult {
    this.now = ctx.time;
    this.dt = dt > 0 ? dt : FIXED_DT;
    this.lastCtx = ctx;
    const result: VehicleStepResult = { events: [], enteredRunway: [], vacatedRunway: [], crossingRequests: [] };
    if (!this.air) return result;
    for (const v of this.vehicles) {
      const it = this.internal.get(v.id)!;
      if (v.type === 'tug') this.stepTug(v, it, ctx, result);
      switch (v.state) {
        case 'standby': break;
        case 'enroute': this.stepEnroute(v, it, ctx, result); break;
        case 'onscene': this.stepOnScene(v, it, ctx, result); break;
        case 'returning': this.stepReturning(v, it, ctx, result); break;
      }
      this.updateRunwayOccupancy(v, it, result);
      pushTrail(v);
    }
    // vehicles waiting at a hold this step
    for (const v of this.vehicles) {
      const it = this.internal.get(v.id)!;
      if (it.waitingSince != null && v.holdShortRunway && !v.holdReleased && v.state !== 'standby') result.crossingRequests.push({ vehicleId: v.id, runway: v.holdShortRunway });
    }
    result.events.push(...this.pendingEvents);
    this.pendingEvents = [];
    return result;
  }

  // ── stepping helpers ──────────────────────────────────────────────────────
  private stepTug(v: Vehicle, it: Internal, ctx: VehicleStepCtx, result: VehicleStepResult): void {
    const a = ctx.aircraft.find(x => x.pushback.tugId === v.id);
    if (!a) {
      if (it.attachedTo != null) { it.attachedTo = null; v.speed = 0; this.recall(v.id); }
      return;
    }
    const st = a.pushback.stage;
    if (st === 'tug_enroute') {
      if (v.state === 'standby' || (v.state !== 'enroute' && it.attachedTo == null)) {
        this.dispatch('tug', { kind: 'aircraft', id: a.id, callsign: a.callsign }, [v.id], 1);
      }
      return;
    }
    if (st === 'tug_attach' || st === 'pushing' || st === 'paused' || st === 'tug_disconnect') {
      const nose = advance(a.pos, a.heading, 5.5);   // the aircraft position is its nose wheel; the tug sits under the nose
      v.pos = nose;
      v.heading = a.heading;
      v.speed = st === 'pushing' ? Math.min(a.speed, VEHICLE_CONST.tugPushKt) : 0;
      v.path = null;
      v.state = 'onscene';
      v.target = { kind: 'aircraft', id: a.id, callsign: a.callsign };
      if (it.attachedTo !== a.id) { it.attachedTo = a.id; v.arrivedAt = this.now; result.events.push(this.vehicleEvent(v, `${v.id} attached to ${a.callsign}`, 'SYS')); }
      return;
    }
    if ((st === 'complete' || st === 'none') && it.attachedTo === a.id) {
      it.attachedTo = null;
      v.speed = 0;
      this.recall(v.id);
    }
  }

  private stepEnroute(v: Vehicle, it: Internal, ctx: VehicleStepCtx, result: VehicleStepResult): void {
    if (it.rolloutUntil > this.now) { v.speed = 0; return; }
    // lazy planning (dispatched before the first step) and moving aircraft targets
    if (!v.path && v.target) { if (!this.plan(v, v.target)) { v.speed = 0; return; } v.etaAt = this.now + this.travelTimeS(v); }
    if (v.target?.kind === 'aircraft' && this.now >= it.retargetAt) {
      it.retargetAt = this.now + VEHICLE_CONST.retargetS;
      const a = ctx.aircraft.find(x => x.id === (v.target as { id: number }).id);
      if (!a) { this.recall(v.id); return; }
      if (it.targetXY && dist(a.pos, it.targetXY) > VEHICLE_CONST.retargetM) {
        const airborne = a.altitude > 50;
        if (!airborne) { this.plan(v, v.target); v.etaAt = this.now + this.travelTimeS(v); }
        else if (a.plan.runway) {
          // aircraft still airborne: stand by at its landing runway instead
          this.plan(v, { kind: 'runway', runway: a.plan.runway });
          v.etaAt = this.now + this.travelTimeS(v);
        }
      }
    }
    if (!v.path) return;
    const arrived = this.followPath(v, it, ctx, result);
    if (arrived) { this.arrive(v, it, ctx, result); return; }
    // inspection vehicle stopped at the entry hold of its own runway: that IS the stand-by point
    if ((v.type === 'ops' || v.type === 'sweeper') && v.target?.kind === 'runway' && v.speed === 0 && v.holdShortRunway && it.holdRef === it.inspectRef) {
      const hold = v.path.holds?.[it.holdIdx];
      if (hold && Math.abs(v.distAlong - hold.at) < 2) { it.parkXY = { ...v.pos }; this.arrive(v, it, ctx, result); }
    }
  }

  private stepReturning(v: Vehicle, it: Internal, ctx: VehicleStepCtx, result: VehicleStepResult): void {
    if (!v.path) {
      if (!this.plan(v, { kind: 'station' })) { v.pos = { ...v.station }; v.speed = 0; this.toStandby(v, it, result); return; }
    }
    const arrived = this.followPath(v, it, ctx, result);
    if (arrived) { v.pos = { ...v.station }; this.toStandby(v, it, result); }
  }

  private toStandby(v: Vehicle, it: Internal, result: VehicleStepResult): void {
    v.state = 'standby';
    v.speed = 0;
    v.path = null;
    v.target = null;
    v.distAlong = 0;
    v.etaAt = null;
    v.arrivedAt = null;
    v.onSceneUntil = null;
    v.holdShortNode = null; v.holdShortRunway = null; v.holdReleased = false; v.trafficHold = false;
    it.responding = false; it.leading = false; it.inspecting = 'none'; it.holdRef = null; it.waitingSince = null; it.requested = false;
    result.events.push(this.vehicleEvent(v, `${v.id} at station`, 'SYS'));
  }

  private stepOnScene(v: Vehicle, it: Internal, ctx: VehicleStepCtx, result: VehicleStepResult): void {
    switch (v.type) {
      case 'followme': this.stepFollowMe(v, it, ctx, result); return;
      case 'tug': return; // handled by stepTug
      case 'ops': case 'sweeper': if (it.inspecting !== 'none') { this.stepInspection(v, it, ctx, result); return; } break;
      default: break;
    }
    // ARFF / ambulance re-position when the target aircraft moves on the ground (follow it down the runway / to the stand)
    if (v.target?.kind === 'aircraft' && (v.type === 'arff' || v.type === 'ambulance')) {
      const a = ctx.aircraft.find(x => x.id === (v.target as { id: number }).id);
      if (!a) { this.recall(v.id); return; }
      if (it.parkXY && a.altitude < 50 && dist(a.pos, it.targetXY ?? it.parkXY) > 80 && this.now >= it.retargetAt) {
        it.retargetAt = this.now + VEHICLE_CONST.retargetS;
        if (this.plan(v, v.target)) { v.state = 'enroute'; v.etaAt = this.now + this.travelTimeS(v); return; }
      }
    }
    v.speed = 0;
    if (v.onSceneUntil != null && this.now >= v.onSceneUntil) {
      if (v.type === 'bird' && !it.reported) { it.reported = true; result.events.push(this.vehicleEvent(v, `Ground, ${v.callsign}, birds dispersed, returning to base.`, 'PILOT')); }
      this.recall(v.id);
    }
  }

  private stepFollowMe(v: Vehicle, it: Internal, ctx: VehicleStepCtx, result: VehicleStepResult): void {
    const a = v.target?.kind === 'aircraft' ? ctx.aircraft.find(x => x.id === (v.target as { id: number }).id) : undefined;
    if (!a || a.phase === 'arrived' || a.phase === 'parked' || a.altitude > 50) { it.leading = false; this.recall(v.id); return; }
    if (a.followVehicleId !== v.id && !it.leading) {
      // waiting at the rendezvous point for the escort to begin
      v.speed = 0;
      if (a.path && (a.phase === 'taxi' || a.phase === 'hold_short') && dist(a.pos, v.pos) < 120) it.leading = true;
      else return;
    }
    it.leading = true;
    if (!a.path) { v.speed = a.speed; return; }
    let lead: number = VEHICLE_CONST.followMeLeadM;
    const nextHold = a.path.holds?.find(h => h.at > a.distAlong);
    if (nextHold && !a.holdReleased && a.distAlong + lead > nextHold.at - 10) lead = Math.max(0, nextHold.at - 10 - a.distAlong);
    const d = Math.min(a.path.total, a.distAlong + lead);
    const s = sampleAlong(a.path.pts, a.path.cum, d);
    v.pos = s.pos;
    v.heading = s.heading;
    v.speed = Math.min(a.speed, VEHICLE_CONST.followMeLeadKt);
    v.path = null;
    if (a.distAlong >= a.path.total - 1) { it.leading = false; result.events.push(this.vehicleEvent(v, `${v.callsign}, ${a.callsign} at the stand, returning to base.`, 'PILOT')); this.recall(v.id); }
  }

  private stepInspection(v: Vehicle, it: Internal, ctx: VehicleStepCtx, result: VehicleStepResult): void {
    const rw = it.inspectRef ? this.runwayByRef(it.inspectRef) : null;
    if (!rw) { this.recall(v.id); return; }
    const targetEnd = v.target?.kind === 'runway' ? v.target.runway.toUpperCase() : null;
    const endName = targetEnd && rw.ends.some(e => e.name.toUpperCase() === targetEnd) ? targetEnd : rw.ends[0].name;
    const rs = this.runwayStateFor(ctx, rw.ref);
    if (it.inspecting === 'requested') {
      v.speed = 0;
      // enter once the runway is closed / inspection (or explicitly cleared via op('cross'))
      const closed = rs ? rs.status === 'closed' || rs.status === 'inspection' : false;
      if (closed || v.holdReleased) {
        it.inspecting = 'driving';
        it.reported = false;
        v.holdReleased = true;
        if (!closed) { /* cleared onto an open runway by the controller: proceed (engine scores if unsafe) */ }
        const near = dist(v.pos, rw.ends[0].xy) <= dist(v.pos, rw.ends[1].xy) ? 0 : 1;
        const a = rw.ends[near].xy, b = rw.ends[1 - near].xy;
        v.path = this.inspectionPath({ ...v.pos }, a, b, it.parkXY ?? { ...v.pos });
        v.distAlong = 0;
        v.holdShortNode = null; v.holdShortRunway = null;
        it.waitingSince = null;
        result.events.push(this.vehicleEvent(v, `Entering runway ${rw.ends[near].name}, ${v.callsign}, inspection in progress.`, 'PILOT'));
      } else {
        it.waitingSince ??= this.now;
        v.holdShortRunway = endName;
        return;
      }
    }
    if (it.inspecting === 'fod') {
      v.speed = 0;
      if (it.fodUntil != null && this.now >= it.fodUntil) { it.inspecting = 'driving'; result.events.push(this.vehicleEvent(v, `${v.callsign}, FOD removed, completing the inspection.`, 'PILOT')); }
      return;
    }
    if (it.inspecting === 'driving' && v.path) {
      const arrived = this.followPath(v, it, ctx, result, true);
      // FOD roll at the far end (halfway)
      if (!it.reported && v.distAlong >= v.path.total / 2) {
        it.reported = true;
        if (v.type === 'ops' && chance(VEHICLE_CONST.fodP)) {
          it.inspecting = 'fod'; it.fodUntil = this.now + VEHICLE_CONST.fodExtraS; v.speed = 0;
          result.events.push(this.vehicleEvent(v, `Ground, ${v.callsign}, FOD found on runway ${endName}, request five more minutes.`, 'PILOT'));
          return;
        }
      }
      if (arrived) {
        it.inspecting = 'done';
        const job = v.type === 'sweeper' ? 'sweep' : 'inspection';
        result.events.push(this.vehicleEvent(v, `Ground, ${v.callsign}, runway ${endName} ${job} complete, ${it.fodUntil != null ? 'FOD removed' : 'no FOD found'}, vacated.`, 'PILOT'));
        this.recall(v.id);
      }
    }
  }

  private arrive(v: Vehicle, it: Internal, ctx: VehicleStepCtx, result: VehicleStepResult): void {
    v.speed = 0;
    v.arrivedAt = this.now;
    v.state = 'onscene';
    v.etaAt = null;
    v.holdShortNode = null; v.holdShortRunway = null;
    it.waitingSince = null;
    const dwell = VEHICLE_CONST.onSceneS[v.type];
    const responding = it.responding;
    if ((v.type === 'ops' || v.type === 'sweeper') && v.target?.kind === 'runway') {
      it.inspecting = 'requested';
      v.onSceneUntil = null;
      const rs = it.inspectRef ? this.runwayStateFor(ctx, it.inspectRef) : null;
      const endName = it.inspectRef ? this.endNameForRef(it.inspectRef) : v.target.runway;
      if (rs && (rs.status === 'closed' || rs.status === 'inspection')) { /* enters on the next step */ }
      else {
        v.holdShortRunway = v.target.runway;
        it.waitingSince = this.now;
        result.events.push(this.vehicleEvent(v, `Ground, ${v.callsign}, holding short runway ${endName}, request enter runway for inspection.`, 'PILOT'));
      }
      result.events.push(this.vehicleEvent(v, `${v.id} at runway ${endName}`, 'SYS'));
      return;
    }
    if (v.type === 'followme') { v.onSceneUntil = null; it.leading = false; result.events.push(this.vehicleEvent(v, `${v.callsign} at the rendezvous point${v.target?.kind === 'aircraft' ? ` for ${v.target.callsign}` : ''}.`, 'PILOT')); return; }
    if (v.type === 'tug') { v.onSceneUntil = null; result.events.push(this.vehicleEvent(v, `${v.id} at ${v.target ? targetLabel(v.target) : 'target'}`, 'SYS')); return; }
    v.onSceneUntil = responding && v.type === 'arff' ? this.now + dwell[1] : this.now + rf(dwell[0], dwell[1]);
    const tgt = v.target ? targetLabel(v.target) : 'scene';
    const took = v.dispatchedAt != null ? this.now - v.dispatchedAt : 0;
    result.events.push(this.vehicleEvent(v, `${v.id} on scene ${tgt} (${fmtEta(took)})`, 'SYS'));
    if (v.type === 'arff' || v.type === 'ambulance') result.events.push(this.vehicleEvent(v, `${v.callsign} in position${v.target?.kind === 'runway' ? ` runway ${v.target.runway}` : v.target?.kind === 'aircraft' ? ` at ${v.target.callsign}` : ''}.`, 'PILOT'));
  }

  private runwayStateFor(ctx: VehicleStepCtx, refOrEnd: string): RunwayState | null {
    const u = refOrEnd.toUpperCase();
    return ctx.runways.find(r => r.ref.toUpperCase() === u || r.name.toUpperCase() === u || r.reciprocal.toUpperCase() === u) ?? null;
  }

  /** Whether a hold-short place requires a clearance right now (active + open, or sterile for non-responders). */
  private holdRequired(v: Vehicle, it: Internal, hold: PathHold): boolean {
    const ctx = this.lastCtx;
    const r = this.runwayByEnd(hold.runway);
    const ref = r?.rw.ref ?? hold.runway;
    // heading to inspect / stand by at this very runway: the entry is handled by the inspection logic
    if ((v.type === 'ops' || v.type === 'sweeper') && it.inspectRef === ref && v.target?.kind === 'runway') return true;
    if (!ctx) return true;
    const states = ctx.runways.filter(x => x.ref === ref);
    if (!states.length) return true;
    const active = states.some(x => x.activeDep || x.activeArr);
    const status = states[0].status;
    if (status === 'closed' || status === 'inspection') return false;
    if (status === 'sterile') return !it.responding;
    return active;
  }

  /**
   * Arc-length follower with hold-short logic. Returns true when the end of the path is reached.
   * `free` = no holds (inspection drive).
   */
  private followPath(v: Vehicle, it: Internal, ctx: VehicleStepCtx, result: VehicleStepResult, free = false): boolean {
    const p = v.path!;
    const dt = this.dt;
    const spd = this.speedTable(v, it);
    const onRw = this.runwayRefAt(v.pos) != null;
    let target = onRw ? spd.runway : spd.taxiway;
    if (target <= 0) target = spd.apron;
    // bends
    const h0 = sampleAlong(p.pts, p.cum, v.distAlong).heading;
    let bend = 0;
    for (const look of [12, 25]) bend = Math.max(bend, Math.abs(angleDelta(h0, sampleAlong(p.pts, p.cum, Math.min(v.distAlong + look, p.total)).heading)));
    const t = Math.min(1, bend / 40);
    const bendMin = it.responding ? VEHICLE_CONST.bendMinRespondingKt : VEHICLE_CONST.bendMinKt;
    target = target + (Math.min(target, bendMin) - target) * t;
    // end of path
    const remain = p.total - v.distAlong;
    if (remain < 30) target = Math.min(target, Math.max(3, 12 * (remain / 30)));
    // holds
    let stopAt: number | null = null;
    if (!free) {
      const hold = p.holds?.[it.holdIdx];
      if (hold && !v.holdReleased) {
        if (this.holdRequired(v, it, hold)) {
          stopAt = hold.at;
          v.holdShortNode = hold.nodeId;
          v.holdShortRunway = hold.runway;
          it.holdRef = this.runwayByEnd(hold.runway)?.rw.ref ?? hold.runway;
          // auto-cross / emergency response: when the engine says the crossing is safe, cross without stopping
          const inspectionEntry = (v.type === 'ops' || v.type === 'sweeper') && it.inspectRef === it.holdRef && v.target?.kind === 'runway';
          if (!inspectionEntry && stopAt - v.distAlong < 150 && (ctx.autoCross || it.responding) && ctx.crossingSafe(hold.runway)) {
            v.holdReleased = true;
            it.waitingSince = null;
            stopAt = null;
            result.events.push(this.vehicleEvent(v, `Crossing runway ${hold.runway}, ${v.callsign}.`, 'PILOT'));
          }
        } else if (v.distAlong >= hold.at - 1) {
          // inactive / closed runway: cross without clearance but announce it
          v.holdReleased = true;
          it.holdRef = this.runwayByEnd(hold.runway)?.rw.ref ?? hold.runway;
          result.events.push(this.vehicleEvent(v, `${v.callsign} crossing runway ${hold.runway} (inactive).`, 'PILOT'));
        }
      }
    }
    if (v.trafficHold) target = 0;
    if (stopAt != null) {
      const rem = stopAt - v.distAlong;
      const brake = (v.speed * KTS_TO_MPS) ** 2 / (2 * VEHICLE_CONST.decelMps2);
      if (rem <= brake + 1) target = 0;
      if (rem <= 12) target = Math.min(target, 3 * Math.max(0, rem / 12));
    }
    const accel = (it.responding ? 2.0 : VEHICLE_CONST.accelMps2) / KTS_TO_MPS * dt;
    const decel = VEHICLE_CONST.decelMps2 / KTS_TO_MPS * dt;
    v.speed = target >= v.speed ? Math.min(v.speed + accel, target) : Math.max(v.speed - decel, target);
    if (v.speed < 0.05) v.speed = 0;
    const moved = v.speed * KTS_TO_MPS * dt;
    v.distAlong += moved;
    if (stopAt != null && v.distAlong >= stopAt) { v.distAlong = stopAt; v.speed = 0; }
    const atEnd = v.distAlong >= p.total - 0.5;
    if (atEnd) v.distAlong = p.total;
    const s = sampleAlong(p.pts, p.cum, v.distAlong);
    v.pos = s.pos;
    const d = angleDelta(v.heading, s.heading);
    const maxStep = Math.min(120 * dt, 8 * moved + 0.1);
    v.heading = norm360(v.heading + Math.sign(d) * Math.min(Math.abs(d), maxStep));

    // waiting at a hold: raise the request once, auto-release when allowed
    if (stopAt != null && v.speed === 0 && stopAt - v.distAlong < 1.5) {
      const hold = p.holds![it.holdIdx];
      if (it.waitingSince == null) it.waitingSince = this.now;
      if (!it.requested) {
        it.requested = true;
        result.events.push(this.vehicleEvent(v, `Ground, ${v.callsign}, holding short runway ${hold.runway}, request cross.`, 'PILOT'));
      }
      const safe = ctx.crossingSafe(hold.runway);
      if ((ctx.autoCross && safe) || (it.responding && safe)) {
        v.holdReleased = true;
        it.waitingSince = null;
        result.events.push(this.vehicleEvent(v, `Crossing runway ${hold.runway}, ${v.callsign}.`, 'PILOT'));
      }
    }
    return atEnd;
  }

  /** Enter / vacate bookkeeping from the vehicle's position vs the runway strips. */
  private updateRunwayOccupancy(v: Vehicle, it: Internal, result: VehicleStepResult): void {
    if (v.state === 'standby') { if (v.onRunway) { result.vacatedRunway.push({ vehicleId: v.id, runway: this.endNameForRef(v.onRunway) }); v.onRunway = null; } return; }
    const ref = this.runwayRefAt(v.pos);
    if (ref && ref !== v.onRunway) {
      if (v.onRunway) result.vacatedRunway.push({ vehicleId: v.id, runway: this.endNameForRef(v.onRunway) });
      v.onRunway = ref;
      const hold = v.path?.holds?.[it.holdIdx];
      const endName = hold && (this.runwayByEnd(hold.runway)?.rw.ref === ref) ? hold.runway : this.endNameForRef(ref);
      const cleared = v.holdReleased || it.inspecting === 'driving' || it.leading || it.attachedTo != null;
      result.enteredRunway.push({ vehicleId: v.id, runway: endName, cleared });
      if (!cleared && !it.leading && it.attachedTo == null) result.events.push(this.vehicleEvent(v, `${v.id} entered runway ${endName} without clearance`, 'SYS'));
    } else if (!ref && v.onRunway) {
      const leftRef = v.onRunway;
      v.onRunway = null;
      const endName = v.holdShortRunway && this.runwayByEnd(v.holdShortRunway)?.rw.ref === leftRef ? v.holdShortRunway : this.endNameForRef(leftRef);
      result.vacatedRunway.push({ vehicleId: v.id, runway: endName });
      // the crossing is complete: next hold
      const hold = v.path?.holds?.[it.holdIdx];
      if (hold && (this.runwayByEnd(hold.runway)?.rw.ref === leftRef) && v.holdReleased) {
        it.holdIdx++;
        v.holdReleased = false;
        it.requested = false;
        it.waitingSince = null;
        v.holdShortNode = null; v.holdShortRunway = null; it.holdRef = null;
        if (v.state !== 'onscene' || it.inspecting === 'none') result.events.push(this.vehicleEvent(v, `Runway ${endName} vacated, ${v.callsign}.`, 'PILOT'));
      } else if (it.inspecting === 'done' || it.inspecting === 'none') {
        if (v.holdReleased && !v.path?.holds?.length) v.holdReleased = false;
      }
    }
  }

  private vehicleEvent(v: Vehicle, message: string, who: 'SYS' | 'PILOT'): SimEvent {
    const etaS = v.etaAt != null ? Math.max(0, v.etaAt - this.now) : null;
    return { type: 'vehicle', id: -1, callsign: v.id, message, at: this.now, who, position: 'ground', data: { type: 'vehicle', vehicleId: v.id, state: v.state, target: v.target, etaS } };
  }

  list(): Vehicle[] { return this.vehicles; }

  byId(id: string): Vehicle | undefined { return this.vehicles.find(v => v.id === id); }

  /** Vehicles of a type in a state (default: standby = available). */
  available(type: VehicleType, state: VehicleState = 'standby'): Vehicle[] {
    return this.vehicles.filter(v => v.type === type && v.state === state);
  }

  stationFor(type: VehicleType): XY {
    const s = this.stations;
    if (!s) return { x: 0, y: 0 };
    switch (type) {
      case 'arff': case 'ambulance': return s.fire;
      case 'followme': case 'ops': case 'sweeper': case 'bird': return s.ops;
      case 'tug': return s.tugPool;
      case 'fuel': return s.fuelFarm;
      case 'deice': return s.deicePad;
    }
  }

  /** True when any vehicle is physically on the given physical runway ref. */
  onRunway(ref: string): Vehicle[] { return this.vehicles.filter(v => v.onRunway === ref); }

  /** Vehicles currently responding to an emergency (ARFF / ambulance en route or on scene). */
  responding(): Vehicle[] { return this.vehicles.filter(v => this.internal.get(v.id)?.responding && v.state !== 'standby'); }
  isResponding(id: string): boolean { return !!this.internal.get(id.toUpperCase())?.responding; }

  /** Seconds until arrival for an en-route vehicle (null otherwise). */
  etaS(id: string): number | null {
    const v = this.byId(id.toUpperCase());
    return v && v.etaAt != null && v.state === 'enroute' ? Math.max(0, v.etaAt - this.now) : null;
  }

  /** ARFF vehicles on scene at a runway end / physical runway (for `arffOnSceneAt`). */
  arffOnScene(runwayOrRef: string | null): Vehicle[] {
    const u = runwayOrRef?.toUpperCase() ?? null;
    const ref = u ? this.runwayByEnd(u)?.rw.ref ?? u : null;
    return this.vehicles.filter(v => v.type === 'arff' && v.state === 'onscene' && (!ref || (v.target?.kind === 'runway' && (this.runwayByEnd(v.target.runway)?.rw.ref === ref)) || v.target?.kind === 'aircraft'));
  }

  /** Remove every vehicle (airport switch / test reset). */
  clear(): void { this.vehicles = []; this.stations = null; this.internal.clear(); this.air = null; this.proj = null; this.xyCache.clear(); this.runwayNodes.clear(); this.runwayGeom = []; this.pendingEvents = []; this.lastCtx = null; }
}

/** Default integration step when step() is called with dt <= 0 (engine.ts FIXED = 1/30 s). */
const FIXED_DT = 1 / 30;

function pushTrail(v: Vehicle): void {
  const last = v.trail[v.trail.length - 1];
  if (!last || dist(last, v.pos) >= 8) {
    v.trail.push({ ...v.pos });
    if (v.trail.length > 60) v.trail.shift();
  }
}

function targetLabel(t: VehicleTarget): string {
  switch (t.kind) {
    case 'runway': return `RWY ${t.runway}`;
    case 'aircraft': return t.callsign;
    case 'stand': return `stand ${t.ref}`;
    case 'point': return 'map point';
    case 'station': return 'station';
  }
}

/** Default station layout when an airport has no configured positions: everything at the airport centre offset by a few hundred metres. */
export function defaultStations(center: XY): VehicleStations {
  return {
    fire: { x: center.x + 400, y: center.y - 300 },
    ops: { x: center.x - 400, y: center.y - 300 },
    tugPool: { x: center.x + 200, y: center.y + 200 },
    fuelFarm: { x: center.x - 600, y: center.y + 400 },
    deicePad: { x: center.x + 700, y: center.y + 300 },
    apron: { x: center.x, y: center.y + 250 },
  };
}

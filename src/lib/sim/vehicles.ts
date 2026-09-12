// ============================================================
//  Ground vehicles — CONTRACT STUB (W1-SYSTEMS implements; W1-ENGINE calls)
//
//  Vehicles are path-following entities on the taxiway graph (reuse findPath
//  + the aircraft follow() maths), with runway-crossing holds identical to
//  aircraft, states standby|enroute|onscene|returning, station positions per
//  airport and a per-type speed table (03 §1.13, UX 04 §6).
//
//  Data flow: engine.update() -> fleet.step(dt, ctx) each fixed step. The
//  engine passes a VehicleStepCtx view (graph, projection, runway states,
//  aircraft positions) and consumes the returned VehicleStepResult (events,
//  runway occupancy changes). dispatch.ts calls dispatch()/recall() for the
//  `dispatchVehicle` / `recallVehicle` / `vehicleOp` AST kinds.
// ============================================================
import type { XY } from './projection';
import type { OsmAirport } from '../osmAirport';
import type { AircraftState, DrivePath, RunwayState, SimEvent, Vehicle, VehicleState, VehicleTarget, VehicleType } from './types';

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

/** Timing constants (03 §8 / §H). */
export const VEHICLE_CONST = {
  /** ARFF roll-out delay before moving, s (60-120). */
  arffRolloutDelayS: [60, 120] as const,
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
  /** Runway refs that vehicles entered / vacated this step (engine updates RunwayState.occupiedBy). */
  enteredRunway: Array<{ vehicleId: string; runway: string }>;
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

/**
 * The fleet. One instance per loaded airport, owned by the engine.
 *
 * Lifecycle:
 *   init(air, stations)  -> creates DEFAULT_FLEET vehicles parked at their station
 *                           node (nearest graph node to the station XY; airport
 *                           centre when a station is missing), state 'standby'.
 *   dispatch(type, target, ids?, count?) -> picks `ids` or the first `count`
 *                           standby vehicles of `type`, builds a path from the
 *                           station node to the target node (runway: nearest
 *                           hold node of that end; aircraft: node nearest the
 *                           aircraft, re-targeted every 5 s while it moves;
 *                           stand: its node; point: nearest node), inserts
 *                           runway-crossing holds exactly like aircraft
 *                           (PathHold on the DrivePath), sets state 'enroute',
 *                           dispatchedAt=now, etaAt from path length / speeds.
 *                           ARFF adds the roll-out delay before moving.
 *   recall(id)           -> path back to station, state 'returning'; a runway
 *                           it was closing is NOT reopened (explicit reopen only).
 *   step(dt, ctx)        -> advances every non-standby vehicle along its path
 *                           (speed by edge type: runway/taxiway/apron), stops
 *                           at hold-short nodes until crossingSafe && (autoCross
 *                           || holdReleased), reports runway enter/vacate,
 *                           flips enroute->onscene at the target (parks 50 m
 *                           abeam an aircraft), onscene->returning when
 *                           onSceneUntil passes, returning->standby at station.
 *   list()               -> all vehicles (JSON-serialisable, for the store/UI/test API).
 *   stationFor(type)     -> station XY for a type.
 */
export class VehicleFleet {
  private vehicles: Vehicle[] = [];
  private stations: VehicleStations | null = null;

  /** Create the fleet for an airport. `stations` XY are in engine local metres. */
  init(air: OsmAirport, stations: VehicleStations, fleet: readonly VehicleSpec[] = DEFAULT_FLEET): void {
    void air; void stations; void fleet;
    throw new Error('not implemented');
  }

  /** Dispatch vehicles of `type` (specific `ids` or the first `count` available) to `target`. */
  dispatch(type: VehicleType, target: VehicleTarget, ids: string[] = [], count = 1): DispatchResult {
    void type; void target; void ids; void count;
    throw new Error('not implemented');
  }

  /** Return a vehicle to its station. Returns false when the id is unknown or already standby. */
  recall(id: string): boolean {
    void id;
    throw new Error('not implemented');
  }

  /** Radio ops on a vehicle: hold position / continue / cross the runway it is holding short of / return to base. */
  op(id: string, op: 'hold' | 'continue' | 'cross' | 'rtb', runway: string | null): boolean {
    void id; void op; void runway;
    throw new Error('not implemented');
  }

  /** Advance every vehicle by dt sim seconds. Called once per fixed engine step. */
  step(dt: number, ctx: VehicleStepCtx): VehicleStepResult {
    void dt; void ctx;
    throw new Error('not implemented');
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

  /** Remove every vehicle (airport switch / test reset). */
  clear(): void { this.vehicles = []; this.stations = null; }
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

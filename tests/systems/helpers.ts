// Shared fixtures for the systems tests (node:test, headless).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AIRCRAFT_DB } from '../../src/lib/sim/aircraftDB';
import type { PhraseCtx } from '../../src/lib/sim/phraseology';
import { telephony } from '../../src/lib/sim/phraseology';
import type { AircraftState, FlightPhase, Position, RunwayState } from '../../src/lib/sim/types';
import { newAircraftFields } from '../../src/lib/sim/types';
import { buildOsmAirport, type OsmAirport } from '../../src/lib/osmAirport';
import { LocalProjection } from '../../src/lib/sim/projection';

let seq = 1;

export function mkAircraft(over: Partial<AircraftState> & { type?: string } = {}): AircraftState {
  const perf = AIRCRAFT_DB[over.type ?? 'B738'] ?? AIRCRAFT_DB.B738;
  const id = over.id ?? seq++;
  const base: AircraftState = {
    id, callsign: over.callsign ?? `TST${id}`, flightNo: String(id), airline: 'TST', perf,
    phase: (over.phase ?? 'cruise') as FlightPhase, plan: { kind: 'arrival', runway: '27L' },
    pos: { x: 0, y: 0 }, heading: 270, speed: 220, altitude: 5000,
    targetHeading: 270, targetSpeed: 220, targetAltitude: 5000,
    path: null, distAlong: 0, holdReleased: false, trafficHold: false, thresholdDist: 0, takeoffCleared: false,
    navMode: 'heading', ilsArmed: false, ilsCaptured: false, gsCaptured: false, assignedRunway: null, directTargetXY: null, directTargetName: null, turnDir: null,
    holdFix: null, holdFixName: null, holdInboundHdg: 0, holdTurnDir: 'R', holdPhase: 'to_fix', holdTimer: 0,
    cmdAltitude: null, cmdIas: null, expedite: false, pendingCmds: [], underControl: false, attention: false,
    route: [], routeIndex: 0, holdingShort: false, trail: [], spawnedAt: 0,
    ...newAircraftFields(perf.weightClass, 0),
  };
  const { type: _t, ...rest } = over;
  void _t;
  return { ...base, ...rest, plan: { ...base.plan, ...(over.plan ?? {}) } } as AircraftState;
}

export function mkCtx(over: Partial<PhraseCtx> = {}): PhraseCtx {
  return {
    variant: 'FAA',
    telephony: (cs: string) => telephony(cs, over.variant ?? 'FAA'),
    unit: (p: Position) => ({ ground: 'Heathrow Ground', tower: 'Heathrow Tower', departure: 'London Departure', approach: 'Heathrow Director', external: 'London Control' }[p]),
    freq: (p: Position) => ({ ground: '121.9', tower: '118.5', departure: '120.4', approach: '119.7', external: '127.4' }[p]),
    wind: { dir: 260, kts: 8, gust: 0 },
    qnh: 1013,
    atisLetter: 'K',
    magVar: 0,
    transitionAltFt: 6000,
    time: 45 * 60,
    aircraft: null,
    spokenType: (icao: string) => ({ B738: 'Boeing 737', A320: 'Airbus 320', B77W: 'Boeing 777', A388: 'Airbus 380', C172: 'Cessna 172' }[icao] ?? icao),
    ...over,
  };
}

export function mkRunway(name: string, reciprocal: string, ref: string, hdg: number, over: Partial<RunwayState> = {}): RunwayState {
  return {
    name, ref, reciprocal, headingTrue: hdg, headingMag: hdg, lengthM: 3500, status: 'open', statusReason: '', statusUntil: null, surface: 'dry',
    activeDep: true, activeArr: true, weightAllow: null, occupiedBy: [], wakeTimer: null, landingClearances: [], takeoffClearance: null,
    lastDeparture: null, lastArrival: null, holdNodes: [], hasIls: true, ilsEstimated: false, intersects: [], windHeadKt: 0, windCrossKt: 0,
    ...over,
  };
}

const airports = new Map<string, OsmAirport>();
export function loadAirport(icao: string): OsmAirport {
  let a = airports.get(icao);
  if (!a) {
    const file = path.join(process.cwd(), 'public', 'maps', 'osm', `${icao}.geojson`);
    const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
    a = buildOsmAirport(icao, fc);
    airports.set(icao, a);
  }
  return a;
}

export function projectionFor(air: OsmAirport): LocalProjection {
  return new LocalProjection(air.center.lat, air.center.lng);
}

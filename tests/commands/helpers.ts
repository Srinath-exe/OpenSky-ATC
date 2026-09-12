// Shared fixtures for the W1-COMMANDS tests (node:test, headless, no engine needed
// except for dispatch.test.ts which builds a real one via tests/engine/helpers).
import { AIRCRAFT_DB } from '../../src/lib/sim/aircraftDB';
import type { ParseCtx } from '../../src/lib/sim/commands';
import type { ActionCtx } from '../../src/lib/sim/commandTree';
import type { AircraftState, FlightPhase, Position, Stage } from '../../src/lib/sim/types';
import { newAircraftFields } from '../../src/lib/sim/types';
import type { PhraseCtx } from '../../src/lib/sim/phraseology';
import { telephony } from '../../src/lib/sim/phraseology';

let seq = 1;

/** Minimal but complete AircraftState for the pure modules (no engine). */
export function mkAircraft(over: Partial<AircraftState> & { type?: string } = {}): AircraftState {
  const perf = AIRCRAFT_DB[over.type ?? 'A320'] ?? AIRCRAFT_DB.A320;
  const id = over.id ?? seq++;
  const base: AircraftState = {
    id, callsign: over.callsign ?? `TST${id}`, flightNo: String(id), airline: 'TST', perf,
    phase: (over.phase ?? 'cruise') as FlightPhase, plan: { kind: 'arrival', runway: '27L', gateRef: '512' },
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

/** ActionCtx with sane defaults (everything enabled / free / open) — override per test. */
export function mkActionCtx(stage: Stage, over: Partial<ActionCtx> = {}): ActionCtx {
  const runwayNames = ['27L', '27R', '09L', '09R'];
  return {
    stage, position: 'tower', time: 1000, paused: false, sandbox: false, strictFrequencies: false,
    hasRadar: true, hasIls: true, hasSid: false, holdAllActive: false,
    distToNextHoldM: null, nextCrossingRunway: null, nextHoldIsCrossing: false, distToThresholdNM: null,
    aglFt: 5000, groundSpeedKt: 0, aboveGlideslope: null, onRunway: false, sinceLastPilotLineS: null, pendingRequest: null,
    emergencyClosedRunway: null, otherArrivalsOnFinal: [],
    runwayStatus: () => 'open', runwayOccupant: () => null, arrivalOnFinal: () => null, parallelRunways: (r) => (r === '27L' ? ['27R'] : r === '27R' ? ['27L'] : []),
    weightAllowed: () => true, runwayActive: () => true, standOccupant: () => null, wakeTimerRemainingS: () => 0,
    wind: { dir: 270, kts: 8, gust: 0 },
    runways: runwayNames.map(n => ({ name: n, ref: n.startsWith('27') ? '09R/27L' : '09L/27R', headingTrue: n.startsWith('27') ? 270 : 90, status: 'open' as const, activeDep: true, activeArr: true, hasIls: true, lengthM: 3600, weightAllowed: true })),
    taxiways: ['A', 'B', 'C', 'N', 'S', 'A1', 'A10', 'L', 'NB'],
    fixes: [{ name: 'OCK', bearingTrue: 180, distNM: 12 }, { name: 'BIG', bearingTrue: 90, distNM: 15 }, { name: 'LAM', bearingTrue: 30, distNM: 20 }],
    stands: [{ ref: '512', terminal: '5', occupant: null }, { ref: '201', terminal: '2', occupant: null }, { ref: '301', terminal: '3', occupant: 'RYR9' }],
    vehicles: [
      { id: 'FIRE1', callsign: 'Fire 1', type: 'arff', state: 'standby', available: true },
      { id: 'FIRE2', callsign: 'Fire 2', type: 'arff', state: 'standby', available: true },
      { id: 'AMB1', callsign: 'Medic 1', type: 'ambulance', state: 'standby', available: true },
    ],
    positions: [{ position: 'ground', freq: '121.9', label: 'GROUND' }, { position: 'tower', freq: '118.5', label: 'TOWER' }, { position: 'departure', freq: '120.4', label: 'DEPARTURE' }, { position: 'approach', freq: '119.7', label: 'APPROACH' }],
    exits: [{ taxiway: 'A7', distAheadM: 400, dir: 'L', highSpeed: true, engineDefault: true }, { taxiway: 'A9', distAheadM: 900, dir: 'L' }],
    nearbyAircraft: [{ callsign: 'UAE5', type: 'A388', bearingTrue: 90, distM: 8000, onFinalNM: 3.2, runway: '27L', ground: false }, { callsign: 'EZY9', type: 'A319', bearingTrue: 10, distM: 120, onFinalNM: null, ground: true }],
    msaFt: 2000, ceilingFt: 20000, transitionAltFt: 6000, magVar: 0,
    ...over,
  };
}

/** ParseCtx used by the parser / suggest tests. */
export function mkParseCtx(over: Partial<ParseCtx> = {}): ParseCtx {
  return {
    aircraft: [
      { id: 1, callsign: 'BAW117', flightNo: 'BA117', type: 'A320', stage: 'startup', altitude: 0, heading: 270, plan: { kind: 'departure', runway: '27R', gateRef: '512' }, minCleanKt: 210 },
      { id: 2, callsign: 'DLH2', flightNo: 'LH2', type: 'A320', stage: 'arr_inbound', altitude: 6000, heading: 90, plan: { kind: 'arrival', runway: '27L', gateRef: '201', fix: 'OCK' }, minCleanKt: 210 },
      { id: 3, callsign: 'AFR1170', type: 'B738', stage: 'taxi_out', altitude: 0, heading: 90, plan: { kind: 'departure', runway: '27R', gateRef: '210' }, holdShortRunway: '27L' },
      { id: 4, callsign: 'UAE5', type: 'A388', stage: 'arr_established', altitude: 2500, heading: 273, plan: { kind: 'arrival', runway: '27L', gateRef: '301' }, ilsArmed: true },
      { id: 5, callsign: 'EZY99', type: 'A319', stage: 'lineup', altitude: 0, heading: 273, plan: { kind: 'departure', runway: '27R', gateRef: '99' } },
      { id: 6, callsign: 'RYR4', type: 'B738', stage: 'rollout', altitude: 0, heading: 273, plan: { kind: 'arrival', runway: '27L', gateRef: '55' } },
      { id: 7, callsign: 'SWR7', type: 'A320', stage: 'parked', altitude: 0, heading: 0, plan: { kind: 'departure', runway: '27R', gateRef: '77' }, hasRequest: true },
      { id: 8, callsign: 'THY8', type: 'B738', stage: 'dep_climb', altitude: 3000, heading: 270, plan: { kind: 'departure', runway: '27R' }, emergency: true },
      { id: 9, callsign: 'EIN70', type: 'A21N', stage: 'dep_level', altitude: 6000, heading: 180, plan: { kind: 'departure', runway: '27R' } },
    ],
    runways: ['27L', '27R', '09L', '09R'],
    taxiways: ['A', 'B', 'C', 'N', 'S', 'A1', 'A10', 'L', 'NB'],
    fixes: ['OCK', 'BIG', 'LAM', 'BNN'],
    stands: ['512', '201', '210', '301', '99', '55', '77'],
    vehicles: ['FIRE1', 'FIRE2', 'FOLLOW1', 'OPS1', 'AMB1'],
    magVar: 0, time: 3600,
    ...over,
  };
}

export function mkPhraseCtx(over: Partial<PhraseCtx> = {}): PhraseCtx {
  return {
    variant: 'ICAO',
    telephony: (cs: string) => telephony(cs, over.variant ?? 'ICAO'),
    unit: (p: Position) => ({ ground: 'Heathrow Ground', tower: 'Heathrow Tower', departure: 'London Departure', approach: 'Heathrow Director', external: 'London Control' }[p]),
    freq: (p: Position) => ({ ground: '121.9', tower: '118.5', departure: '120.4', approach: '119.7', external: '127.4' }[p]),
    wind: { dir: 260, kts: 8, gust: 0 }, qnh: 1013, atisLetter: 'K', magVar: 0, transitionAltFt: 6000, time: 45 * 60, aircraft: null,
    spokenType: (icao: string) => icao,
    ...over,
  };
}

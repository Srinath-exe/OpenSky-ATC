/*
  Airlines, fleets and airport traffic profiles — who flies what, where.

  Every carrier has a weighted fleet (only types the aircraft database knows); every airport has a weighted list of
  the carriers that dominate it, an occupancy for its stands (how full the gates are when a shift starts) and a
  busyness factor for the spawn cadence. `pickCarrier` / `pickType` are used for spawned traffic and for the static
  parked population (engine.ts `parked`), so a stand at Dubai holds an Emirates A380 and a Boston gate a JetBlue A320.
*/
import type { WeightClass } from './aircraftDB';
import { AIRCRAFT_DB } from './aircraftDB';
import type { StandSize } from '../osmAirport';

export interface Airline { icao: string; iata: string; name: string; fleet: Record<string, number> }

export const AIRLINES: Airline[] = [
  { icao: 'BAW', iata: 'BA', name: 'British Airways', fleet: { A320: 4, A20N: 3, A321: 2, A319: 2, B789: 2, A359: 2, B77W: 3, A388: 1, B788: 1 } },
  { icao: 'VIR', iata: 'VS', name: 'Virgin Atlantic', fleet: { A333: 2, A359: 3, B789: 3 } },
  { icao: 'EIN', iata: 'EI', name: 'Aer Lingus', fleet: { A320: 4, A321: 1, A333: 2 } },
  { icao: 'EZY', iata: 'U2', name: 'easyJet', fleet: { A320: 5, A20N: 3, A319: 3, A321: 1 } },
  { icao: 'RYR', iata: 'FR', name: 'Ryanair', fleet: { B738: 6, B38M: 2 } },
  { icao: 'DLH', iata: 'LH', name: 'Lufthansa', fleet: { A320: 4, A20N: 3, A321: 2, A319: 1, A333: 1, A359: 2, B748: 1, A388: 1, A346: 1 } },
  { icao: 'AFR', iata: 'AF', name: 'Air France', fleet: { A320: 4, A20N: 2, A321: 1, A319: 1, A359: 2, B77W: 3, A333: 1, B789: 1 } },
  { icao: 'TRA', iata: 'HV', name: 'Transavia', fleet: { B738: 4, A20N: 1 } },
  { icao: 'KLM', iata: 'KL', name: 'KLM', fleet: { B738: 4, E190: 2, E175: 1, A333: 1, B789: 2, B77W: 2 } },
  { icao: 'SWR', iata: 'LX', name: 'Swiss', fleet: { A320: 3, A20N: 2, A321: 1, A333: 1, B77W: 1 } },
  { icao: 'UAE', iata: 'EK', name: 'Emirates', fleet: { A388: 4, B77W: 5, A359: 1 } },
  { icao: 'FDB', iata: 'FZ', name: 'flydubai', fleet: { B738: 4, B38M: 3 } },
  { icao: 'QTR', iata: 'QR', name: 'Qatar', fleet: { A359: 3, B77W: 3, A333: 1, A388: 1, B788: 1, A320: 1 } },
  { icao: 'ETD', iata: 'EY', name: 'Etihad', fleet: { B789: 3, A388: 1, B77W: 1, A320: 1, A321: 1 } },
  { icao: 'THY', iata: 'TK', name: 'Turkish', fleet: { B738: 3, A321: 3, A20N: 1, A333: 2, B789: 1, B77W: 1 } },
  { icao: 'AIC', iata: 'AI', name: 'Air India', fleet: { A320: 4, A20N: 2, A321: 1, B788: 2, B77W: 1, A359: 1 } },
  { icao: 'IGO', iata: '6E', name: 'IndiGo', fleet: { A320: 6, A20N: 5, A321: 3, AT76: 2 } },
  { icao: 'SIA', iata: 'SQ', name: 'Singapore', fleet: { A359: 4, B789: 2, B77W: 2, A388: 2, B788: 1 } },
  { icao: 'SCO', iata: 'TR', name: 'Scoot', fleet: { A20N: 3, A321: 1, B788: 2, B789: 1 } },
  { icao: 'CPA', iata: 'CX', name: 'Cathay Pacific', fleet: { A359: 4, A333: 3, B77W: 3, A321: 1, A20N: 1 } },
  { icao: 'HKE', iata: 'UO', name: 'HK Express', fleet: { A320: 3, A20N: 2, A321: 2 } },
  { icao: 'CES', iata: 'MU', name: 'China Eastern', fleet: { A320: 4, A20N: 2, A321: 1, A333: 1, B789: 1 } },
  { icao: 'CCA', iata: 'CA', name: 'Air China', fleet: { A320: 3, B738: 3, A333: 1, B789: 1, B77W: 1 } },
  { icao: 'ANA', iata: 'NH', name: 'All Nippon', fleet: { B788: 3, B789: 3, B77W: 2, B763: 2, A320: 2, A321: 2, B738: 2 } },
  { icao: 'JAL', iata: 'JL', name: 'Japan Airlines', fleet: { B788: 2, B789: 2, B77W: 2, B763: 3, A359: 2, B738: 3 } },
  { icao: 'QFA', iata: 'QF', name: 'Qantas', fleet: { B738: 5, A333: 2, B789: 2, A388: 1, DH8D: 1 } },
  { icao: 'VOZ', iata: 'VA', name: 'Virgin Australia', fleet: { B738: 5, B38M: 1 } },
  { icao: 'JST', iata: 'JQ', name: 'Jetstar', fleet: { A320: 4, A321: 2, B788: 1 } },
  { icao: 'ANZ', iata: 'NZ', name: 'Air New Zealand', fleet: { A320: 2, B789: 2, B77W: 1 } },
  { icao: 'UAL', iata: 'UA', name: 'United', fleet: { B738: 4, B739: 4, A320: 3, B38M: 2, B752: 1, B763: 1, B788: 1, B789: 2, B77W: 2, E175: 2 } },
  { icao: 'AAL', iata: 'AA', name: 'American', fleet: { B738: 5, A321: 4, A320: 2, A319: 2, B38M: 1, B788: 1, B789: 1, B77W: 1, E175: 2 } },
  { icao: 'DAL', iata: 'DL', name: 'Delta', fleet: { B738: 3, B739: 3, A321: 4, A320: 2, A319: 1, B752: 2, B763: 1, A333: 1, A359: 1, CRJ9: 1 } },
  { icao: 'SWA', iata: 'WN', name: 'Southwest', fleet: { B738: 6, B38M: 3 } },
  { icao: 'JBU', iata: 'B6', name: 'JetBlue', fleet: { A320: 5, A321: 3, E190: 2 } },
  { icao: 'ASA', iata: 'AS', name: 'Alaska', fleet: { B738: 3, B739: 3, B38M: 2, E175: 2 } },
  { icao: 'SKW', iata: 'OO', name: 'SkyWest', fleet: { E175: 4, CRJ9: 2, CRJ7: 1 } },
  { icao: 'FDX', iata: 'FX', name: 'FedEx', fleet: { B763: 3, B77W: 1, MD11: 1, AT76: 1 } },
  { icao: 'UPS', iata: '5X', name: 'UPS', fleet: { B763: 2, B748: 1, MD11: 1 } },
];
export const AIRLINE_BY_ICAO: Record<string, Airline> = Object.fromEntries(AIRLINES.map(a => [a.icao, a]));

/** Airport traffic profile: dominant carriers (weighted), stand occupancy at the start of a shift, spawn cadence factor. */
export interface TrafficProfile {
  carriers: Record<string, number>;
  /** Share of gate / open-stand / remote positions holding a parked aircraft when the shift starts. */
  occupancy: { gate: number; stand: number; remote: number };
  /** Spawn cadence multiplier (1 = the difficulty default; a hub gets more). */
  busy: number;
}
export const TRAFFIC_PROFILES: Record<string, TrafficProfile> = {
  EGLL: { carriers: { BAW: 10, VIR: 2, EIN: 1, DLH: 1, AFR: 1, KLM: 1, UAE: 1, AAL: 1, UAL: 1, QTR: 1, SIA: 1 }, occupancy: { gate: 0.6, stand: 0.4, remote: 0.25 }, busy: 1.1 },
  LFPG: { carriers: { AFR: 10, EZY: 3, TRA: 2, DLH: 1, KLM: 1, UAE: 1, DAL: 1, RYR: 1, QTR: 1 }, occupancy: { gate: 0.55, stand: 0.35, remote: 0.2 }, busy: 1.0 },
  KJFK: { carriers: { DAL: 6, JBU: 6, AAL: 5, UAL: 1, BAW: 2, VIR: 1, DLH: 1, AFR: 1, UAE: 1, QTR: 1, SKW: 1 }, occupancy: { gate: 0.55, stand: 0.35, remote: 0.2 }, busy: 1.0 },
  KLAX: { carriers: { UAL: 5, DAL: 5, AAL: 5, SWA: 4, ASA: 2, JBU: 1, SKW: 3, ANA: 1, JAL: 1, QFA: 1, CPA: 1, BAW: 1, UAE: 1 }, occupancy: { gate: 0.55, stand: 0.35, remote: 0.2 }, busy: 1.1 },
  KSFO: { carriers: { UAL: 10, ASA: 4, SWA: 2, DAL: 2, AAL: 2, SKW: 3, ANA: 1, JAL: 1, CPA: 1, SIA: 1, BAW: 1 }, occupancy: { gate: 0.55, stand: 0.35, remote: 0.2 }, busy: 0.85 },
  KBOS: { carriers: { JBU: 8, DAL: 5, AAL: 3, UAL: 2, SWA: 1, SKW: 1, BAW: 1, EIN: 1, AFR: 1 }, occupancy: { gate: 0.5, stand: 0.3, remote: 0.15 }, busy: 0.75 },
  VIDP: { carriers: { IGO: 8, AIC: 5, UAE: 1, QTR: 1, BAW: 1, SIA: 1, DLH: 1 }, occupancy: { gate: 0.5, stand: 0.35, remote: 0.25 }, busy: 0.9 },
  OMDB: { carriers: { UAE: 10, FDB: 5, BAW: 1, QTR: 1, AIC: 1, IGO: 1, THY: 1, DLH: 1 }, occupancy: { gate: 0.6, stand: 0.4, remote: 0.3 }, busy: 1.0 },
  WSSS: { carriers: { SIA: 8, SCO: 4, CPA: 1, QFA: 1, UAE: 1, BAW: 1, ANA: 1, JAL: 1, CES: 1, IGO: 1 }, occupancy: { gate: 0.55, stand: 0.35, remote: 0.2 }, busy: 0.9 },
  VHHH: { carriers: { CPA: 10, HKE: 4, CCA: 1, CES: 2, SIA: 1, UAE: 1, BAW: 1, UAL: 1, JAL: 1, ANA: 1 }, occupancy: { gate: 0.55, stand: 0.35, remote: 0.2 }, busy: 0.9 },
  RJTT: { carriers: { ANA: 8, JAL: 8, CPA: 1, SIA: 1, UAL: 1, DAL: 1, BAW: 1, CCA: 1 }, occupancy: { gate: 0.6, stand: 0.4, remote: 0.2 }, busy: 1.1 },
  YSSY: { carriers: { QFA: 8, VOZ: 5, JST: 4, ANZ: 1, SIA: 1, UAE: 1, CPA: 1, UAL: 1 }, occupancy: { gate: 0.5, stand: 0.3, remote: 0.15 }, busy: 0.75 },
};
const DEFAULT_PROFILE: TrafficProfile = { carriers: {}, occupancy: { gate: 0.45, stand: 0.3, remote: 0.15 }, busy: 0.8 };
export function profileOf(icao: string): TrafficProfile { return TRAFFIC_PROFILES[icao] ?? DEFAULT_PROFILE; }

/** ICAO stand size letter of a type from its wingspan (Annex 14 aerodrome reference code element 2). */
export function sizeOfType(type: string): StandSize {
  const span = AIRCRAFT_DB[type]?.wingspanMeters ?? 36;
  return span < 15 ? 'A' : span < 24 ? 'B' : span < 36 ? 'C' : span < 52 ? 'D' : span < 65 ? 'E' : 'F';
}
const SIZE_ORDER: StandSize[] = ['A', 'B', 'C', 'D', 'E', 'F'];
export function sizeFits(type: string, stand: StandSize): boolean { return SIZE_ORDER.indexOf(sizeOfType(type)) <= SIZE_ORDER.indexOf(stand); }

function weighted<T extends string>(table: Record<T, number>, r: number): T | null {
  const entries = (Object.entries(table) as [T, number][]).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0); if (!total) return null;
  let x = r * total; for (const [k, w] of entries) { x -= w; if (x <= 0) return k; }
  return entries[entries.length - 1][0];
}

/** A carrier for the airport: 65 % from its profile, the rest from the whole list (r1, r2: uniform randoms). */
export function pickCarrier(icao: string, r1: number, r2: number): Airline {
  const prof = profileOf(icao);
  const home = r1 < 0.65 ? weighted(prof.carriers, r2) : null;
  const al = home ? AIRLINE_BY_ICAO[home] : undefined;
  return al ?? AIRLINES[Math.min(AIRLINES.length - 1, Math.floor(r2 * AIRLINES.length))];
}

/** A type from the carrier's fleet that the runway allows and the stand can take (null when nothing fits). */
export function pickType(carrier: Airline, r: number, opts: { weights?: Set<WeightClass> | null; stand?: StandSize | null } = {}): string | null {
  const fleet: Record<string, number> = {};
  for (const [t, w] of Object.entries(carrier.fleet)) {
    if (!AIRCRAFT_DB[t] || w <= 0) continue;
    if (opts.weights && opts.weights.size && !opts.weights.has(AIRCRAFT_DB[t].weightClass)) continue;
    if (opts.stand && !sizeFits(t, opts.stand)) continue;
    fleet[t] = w;
  }
  return weighted(fleet, r);
}

// Home / settings page airport metadata. The playable set is the intersection of
// public/maps/osm, public/airspace and public/maps/satellite (06-CONTRACTS §7.1).
// Default winds are the prevailing direction at each field (true degrees) so the
// runway picker can preview head / cross components before a session exists.
import { RUNWAY_MANIFEST, type RunwayPair } from '@/lib/runwayManifest';

export interface AirportMeta {
  icao: string;
  iata: string;
  name: string;
  city: string;
  region: string;
  elevationFt: number;
  /** Prevailing wind, true degrees / knots. */
  wind: { dir: number; kts: number };
}

export const AIRPORTS: AirportMeta[] = [
  { icao: 'EGLL', iata: 'LHR', name: 'Heathrow', city: 'London', region: 'United Kingdom', elevationFt: 83, wind: { dir: 240, kts: 10 } },
  { icao: 'KJFK', iata: 'JFK', name: 'John F. Kennedy', city: 'New York', region: 'United States', elevationFt: 13, wind: { dir: 280, kts: 11 } },
  { icao: 'KLAX', iata: 'LAX', name: 'Los Angeles Intl', city: 'Los Angeles', region: 'United States', elevationFt: 128, wind: { dir: 250, kts: 9 } },
  { icao: 'KSFO', iata: 'SFO', name: 'San Francisco Intl', city: 'San Francisco', region: 'United States', elevationFt: 13, wind: { dir: 280, kts: 12 } },
  { icao: 'KBOS', iata: 'BOS', name: 'Logan Intl', city: 'Boston', region: 'United States', elevationFt: 20, wind: { dir: 270, kts: 10 } },
  { icao: 'VIDP', iata: 'DEL', name: 'Indira Gandhi', city: 'Delhi', region: 'India', elevationFt: 777, wind: { dir: 300, kts: 6 } },
];

export const AIRPORT_BY_ICAO: Record<string, AirportMeta> = Object.fromEntries(AIRPORTS.map((a) => [a.icao, a]));

export function runwaysOf(icao: string): RunwayPair[] {
  return RUNWAY_MANIFEST[icao] ?? [];
}

/** Longest runway in feet (0 when unknown). */
export function longestRunwayFt(icao: string): number {
  return runwaysOf(icao).reduce((m, r) => Math.max(m, r.lengthFt), 0);
}

/** Satellite thumbnails baked by scripts/fetch_satellite.py. */
export function satelliteUrl(icao: string, wide = false): string {
  return `/maps/satellite/${icao}${wide ? '_wide' : ''}.jpg`;
}

/** `09L/27R` -> `09L-27R` (05 §3.1: refs are sanitised in test ids). */
export function sanitiseRef(ref: string): string {
  return ref.replace(/[^0-9A-Za-z]+/g, '-');
}

export interface WindComponents { headKt: number; crossKt: number; crossFrom: 'L' | 'R' | null }

/** Head / cross wind for a runway heading (true) and a wind (true). Negative head = tailwind. */
export function windComponents(rwyHdgTrue: number, windDirTrue: number, windKts: number): WindComponents {
  const d = ((windDirTrue - rwyHdgTrue + 540) % 360) - 180; // -180..180, positive = wind from the right
  const rad = (d * Math.PI) / 180;
  const head = Math.round(windKts * Math.cos(rad));
  const cross = Math.round(Math.abs(windKts * Math.sin(rad)));
  return { headKt: head, crossKt: cross, crossFrom: cross === 0 ? null : d > 0 ? 'R' : 'L' };
}

/** ICAO runway-selection rule of thumb (00 §2.3): tailwind above 5 kt makes an end unfavourable. */
export const MAX_TAILWIND_KT = 5;

export function formatFeet(ft: number): string {
  return `${Math.round(ft).toLocaleString('en')} ft`;
}
export function feetToMetres(ft: number): number {
  return Math.round(ft * 0.3048);
}

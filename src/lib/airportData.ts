// ============================================================
//  Airport data — typed loader that joins the two data sources
//
//    public/maps/osm/<ICAO>.geojson  ──buildOsmAirport──▶  OsmAirport   (graph, runways, holds, stands, stations)
//    public/airspace/<ICAO>.txt      ──parseEndlessAirport─▶ EAirport   (TMA, beacons, ILS rows, SIDs/STARs)
//
//  `buildAirportData` is pure (no fetch) so tests and the store can feed it
//  file contents; `loadAirportData` is the browser convenience wrapper. The
//  airspace magnetic variation is passed into the OSM builder so runway ends
//  are oriented with the real variation rather than the fallback table.
// ============================================================
import { buildOsmAirport, runwayEndByName, type OsmAirport, type LngLat } from './osmAirport';
import { parseEndlessAirport, ecoordToLL, type EAirport, type ERunway } from './airspace/eairport';

export interface AirportData {
  icao: string;
  osm: OsmAirport;
  airspace: EAirport | null;
  /** Magnetic variation used, degrees east-positive. */
  magVar: number;
}

/** Everything the engine needs to seed one RunwayState (per END). Plain data, lat/lng — the engine projects. */
export interface RunwaySeed {
  name: string;
  ref: string;
  reciprocal: string;
  headingTrue: number;
  headingMag: number;
  lengthM: number;
  /** Physical end of the pavement (graph node). */
  end: LngLat;
  endNodeId: string;
  /** Landing threshold (displaced when known, else == end). */
  thr: LngLat;
  displacedM: number;
  thrElevFt: number;
  hasIls: boolean;
  /** True when the ILS row is missing or was derived from the opposite end's row. */
  ilsEstimated: boolean;
  ils: ERunway | null;
  holdNodes: string[];
  intersects: string[];
  /** True when the runway is long enough for airline traffic (≥ 3000 ft — matches RUNWAY_MANIFEST). */
  usable: boolean;
}

/** Build from already-loaded file contents (pure). */
export function buildAirportData(icao: string, geojson: unknown, airspaceText: string | null, opts: { quiet?: boolean } = {}): AirportData {
  let airspace: EAirport | null = null;
  if (airspaceText) {
    try { airspace = parseEndlessAirport(airspaceText); } catch { airspace = null; }
  }
  const magVar = airspace?.airspace.magVar;
  const osm = buildOsmAirport(icao, geojson, { magVarDeg: magVar, quiet: opts.quiet });
  return { icao, osm, airspace, magVar: osm.magVar };
}

/** Browser loader: fetches both files (the airspace file is optional). */
export async function loadAirportData(icao: string, fetchImpl: typeof fetch = fetch): Promise<AirportData> {
  const [geo, air] = await Promise.all([
    fetchImpl(`/maps/osm/${icao}.geojson`).then(r => { if (!r.ok) throw new Error(`Failed to load OSM data for ${icao}: ${r.status}`); return r.json(); }),
    fetchImpl(`/airspace/${icao}.txt`).then(r => (r.ok ? r.text() : null)).catch(() => null),
  ]);
  return buildAirportData(icao, geo, air);
}

const normName = (n: string) => n.trim().toUpperCase().replace(/^0(?=\d)/, '');

/** Airspace ILS row for an OSM runway end name (width-insensitive: '4R' matches '04R'). */
export function ilsRowFor(data: AirportData, endName: string): ERunway | null {
  if (!data.airspace) return null;
  const N = normName(endName);
  return data.airspace.runways.find(r => normName(r.name) === N) ?? null;
}

/** One seed per runway end, in OsmAirport.runways order (longest runway first). */
export function runwaySeeds(data: AirportData): RunwaySeed[] {
  const out: RunwaySeed[] = [];
  for (const rw of data.osm.runways) {
    for (const end of rw.ends) {
      const other = rw.ends.find(e => e !== end)!;
      const ils = ilsRowFor(data, end.name);
      out.push({
        name: end.name, ref: rw.ref, reciprocal: other.name,
        headingTrue: end.trueHdg, headingMag: end.magHdg, lengthM: rw.lengthM,
        end: { lng: end.lng, lat: end.lat }, endNodeId: end.nodeId,
        thr: end.thr, displacedM: end.displacedM,
        thrElevFt: ils?.thrElevFt ?? data.airspace?.airspace.elevationFt ?? 0,
        hasIls: !!ils, ilsEstimated: !ils || ils.derived, ils,
        holdNodes: end.holdNodeIds.slice(), intersects: rw.intersects.slice(),
        usable: rw.lengthM >= 3000 * 0.3048,
      });
    }
  }
  return out;
}

/** Threshold of an ILS row as lat/lng (xy rows converted around the airspace centre). */
export function ilsThresholdLL(data: AirportData, row: ERunway): LngLat {
  const c = data.airspace?.airspace.center ?? { lat: data.osm.center.lat, lng: data.osm.center.lng };
  const ll = ecoordToLL(row.coord, c);
  return { lng: ll.lng, lat: ll.lat };
}

/**
 * Consistency check between the two sources: distance (m) between each airspace
 * ILS threshold and the OSM end of the same name, plus heading difference. Used
 * by the data tests and worth a console.warn at load time when > 60 m / 3°.
 */
export function crossCheckRunways(data: AirportData): Array<{ name: string; distM: number; hdgDiff: number; ok: boolean }> {
  const out: Array<{ name: string; distM: number; hdgDiff: number; ok: boolean }> = [];
  if (!data.airspace) return out;
  for (const row of data.airspace.runways) {
    const r = runwayEndByName(data.osm, row.name) ?? runwayEndByName(data.osm, normName(row.name));
    if (!r) { out.push({ name: row.name, distM: Infinity, hdgDiff: Infinity, ok: false }); continue; }
    const t = ilsThresholdLL(data, row);
    const d2r = Math.PI / 180, R = 6371000;
    const distM = Math.hypot((t.lat - r.end.lat) * d2r * R, (t.lng - r.end.lng) * d2r * R * Math.cos(r.end.lat * d2r));
    const hdgDiff = Math.abs(((row.trueHeading - r.end.trueHdg) % 360 + 540) % 360 - 180);
    out.push({ name: row.name, distM, hdgDiff, ok: distM <= 60 && hdgDiff <= 3 });
  }
  return out;
}

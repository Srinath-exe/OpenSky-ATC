// ============================================================
//  Endless ATC airport-file parser.
//
//  Parses the community `.txt` airport format used by EndlessATC
//  (github.com/EndlessATC/Airports) — a factual aviation-data config: airspace
//  radius/center, beacons (fixes), runway + ILS geometry, entry points, SIDs,
//  STARs, restricted areas. We adopt the FORMAT and the factual nav data; no
//  game assets are used. Output is normalised so the sim's LocalProjection can
//  map every coordinate into the shared local-XY-metres space.
//
//  Format reference: the repo's example.txt + real files (e.g. EGLL).
//
//  W1-DATA changes (audit B12/B22):
//    • EVERY [airportN] section is parsed (`airports[]`); `runways` is the merged
//      list of all sections that describe the same aerodrome as [airport1]
//      (same code, or thresholds within 6 km) — deduped by name, airport1 wins.
//      A secondary aerodrome in the same file (EGLL's [airport2] = RAF Northolt)
//      is kept in `airports[]` but its runways do not leak into `runways`.
//    • The reciprocal end of every explicit runway row is derived when the file
//      does not list it (Endless ATC semantics: one row = one physical runway,
//      the named end's threshold; the opposite end = threshold + length along the
//      heading) — flagged `derived: true` so the ILS can be marked estimated.
//    • Displaced thresholds (columns 7/8), threshold elevation (`thrElevFt`),
//      tower frequency (last column) and `thrCoord` (landing threshold after the
//      displacement) are exposed per runway end.
//    • [departureN] / [approachN] routes become typed `sids[]` / `stars[]` with
//      resolved runway names and lat/lng waypoints (`departures`/`approaches`
//      are kept for backward compatibility and carry the same objects).
// ============================================================

export interface LL { lat: number; lng: number; }
// A coordinate is either lat/lng degrees (tokens with N/S/E/W) or x,y NM from center.
export type ECoord = { kind: 'll'; lat: number; lng: number } | { kind: 'xy'; xNM: number; yNM: number };

export interface EBeacon { id: string; coord: ECoord; holdHeading?: number; pron?: string; }
export interface ERunway {
  id: string; name: string; coord: ECoord;
  trueHeading: number; lengthFt: number;
  glideslopeDeg: number; localizerCourse: number; elevationFt: number;
  /** Threshold elevation, ft (column 9 of the runway row; same as elevationFt). */
  thrElevFt: number;
  /** Displaced threshold at this end / at the opposite end, ft (columns 7 / 8; 0 when absent). */
  displacedThrFt: number;
  displacedThrOppFt: number;
  /** Landing threshold = coord advanced by displacedThrFt along trueHeading. */
  thrCoord: ECoord;
  /** Opposite end name ('09R' for '27L'). */
  reciprocal: string;
  /** Tower frequency when the row carries one (last column, e.g. 118.505). */
  towerFreq?: number;
  /** Code of the [airportN] section the row came from. */
  airportCode: string;
  /** True when this end was synthesised as the reciprocal of an explicit row (ILS data estimated). */
  derived: boolean;
}
export interface EEntryPoint { heading: number; beacon?: string; altitudeFt: number; weight: number; }
export interface ERouteStep { coord: ECoord; maxAltFt?: number; maxSpeedKt?: number; }
export interface EWaypoint { lat: number; lng: number; altFt?: number; speedKt?: number; }
export interface ERoute {
  name: string; pron?: string;
  /** First runway id of the section (`runway = lls, lln` → 'lls'). */
  runwayId?: string;
  steps: ERouteStep[];
  /** 'sid' for [departureN], 'star' for [approachN]. */
  kind: 'sid' | 'star';
  /** Every runway id the section applies to. */
  runwayIds: string[];
  /** Resolved runway END names ('27L'), in the same order as runwayIds (unknown ids dropped). */
  runways: string[];
  /** Waypoints in lat/lng (xy coordinates converted around the airspace centre). */
  waypoints: EWaypoint[];
  /** Transition beacon for approaches (`beacon = BIG`). */
  beacon?: string;
  /** Number of identical route rows in the file (Endless ATC repeats a route to weight it). */
  weight: number;
}
export interface EArea { shape: 'circle' | 'polygon'; altitudeFt: number; name?: string; radiusNM?: number; center?: ECoord; points: ECoord[]; }

export interface EAirline { icao: string; weight: number; types: string[]; telephony: string; directions: string; }

export interface EAirportSection {
  /** 1-based index of the [airportN] section. */
  index: number;
  code: string;
  name: string;
  runways: ERunway[];
  entryPoints: EEntryPoint[];
  climbAltFt: number;
  traffic?: number;
  airlines: EAirline[];
  /** True when the section describes the same aerodrome as [airport1] (its runways are merged into `runways`). */
  coLocated: boolean;
}

export interface EAirspace {
  radiusNM: number;
  center: LL;
  /** Magnetic variation, degrees east-positive. */
  magVar: number;
  floorFt: number;
  ceilingFt: number;
  aboveFt: number;
  transitionAltFt: number;
  separationNM: number;
  name: string;
  decimalDegrees: boolean;
  beacons: EBeacon[];
  boundary: ECoord[];
  localizerSpeed?: { distNM: number; speedKt: number };
  elevationFt?: number;
  descendAltFt?: number;
}

export interface EAirport {
  airspace: EAirspace;
  code: string;
  name: string;
  /** Merged runway ends for the primary aerodrome (all co-located sections; explicit rows first, derived reciprocals last). */
  runways: ERunway[];
  entryPoints: EEntryPoint[];
  departures: ERoute[];   // SID routes (same objects as `sids`)
  approaches: ERoute[];   // STAR / transition routes (same objects as `stars`)
  sids: ERoute[];
  stars: ERoute[];
  areas: EArea[];
  climbAltFt: number;
  /** Every [airportN] section in file order. */
  airports: EAirportSection[];
}

// ── coordinate token parsing ───────────────────────────────────────────────────
// "N51.4752" → +51.4752 ; "W0.22" → -0.22 ; "E0.03" → +0.03 ; "51.47" → as-is.
function parseDegToken(tok: string): { val: number; hasLetter: boolean } {
  const t = tok.trim();
  const m = t.match(/^([NSEW])\s*([0-9.+-]+)$/i) || t.match(/^([0-9.+-]+)\s*([NSEW])$/i);
  if (m) {
    const letter = (m[1].match(/[NSEW]/i) ? m[1] : m[2]).toUpperCase();
    const num = parseFloat(m[1].match(/[NSEW]/i) ? m[2] : m[1]);
    const sign = letter === 'S' || letter === 'W' ? -1 : 1;
    return { val: sign * num, hasLetter: true };
  }
  // DMS like 51°28'18''N — collapse to decimal
  const dms = t.match(/(-?\d+)[°\s]+(\d+)['\s]+([\d.]+)["\s]*([NSEW])?/i);
  if (dms) {
    let v = parseInt(dms[1], 10) + parseInt(dms[2], 10) / 60 + parseFloat(dms[3]) / 3600;
    if (dms[4] && /[SW]/i.test(dms[4])) v = -v;
    return { val: v, hasLetter: !!dms[4] };
  }
  return { val: parseFloat(t), hasLetter: false };
}

// Two tokens → an ECoord. Letters ⇒ lat/lng degrees; plain numbers ⇒ x,y NM.
function parseCoordPair(a: string, b: string): ECoord {
  const pa = parseDegToken(a), pb = parseDegToken(b);
  if (pa.hasLetter || pb.hasLetter) return { kind: 'll', lat: pa.val, lng: pb.val };
  return { kind: 'xy', xNM: pa.val, yNM: pb.val };
}

const num = (s: string | undefined, d = 0) => { const v = parseFloat((s ?? '').trim()); return isFinite(v) ? v : d; };
const NM_M = 1852;
const R_EARTH = 6371000;
const D2R = Math.PI / 180;

/** Move a coordinate `m` metres along compass bearing `hdg` (works for both coordinate kinds). */
export function advanceCoord(c: ECoord, hdg: number, m: number): ECoord {
  const dN = Math.cos(hdg * D2R) * m, dE = Math.sin(hdg * D2R) * m;
  if (c.kind === 'xy') return { kind: 'xy', xNM: c.xNM + dE / NM_M, yNM: c.yNM + dN / NM_M };
  return { kind: 'll', lat: c.lat + dN / (R_EARTH * D2R), lng: c.lng + dE / (R_EARTH * D2R * Math.cos(c.lat * D2R)) };
}

/** Convert any ECoord to lat/lng, using the airspace centre for x,y NM offsets. */
export function ecoordToLL(c: ECoord, center: LL): LL {
  if (c.kind === 'll') return { lat: c.lat, lng: c.lng };
  return { lat: center.lat + c.yNM * NM_M / (R_EARTH * D2R), lng: center.lng + c.xNM * NM_M / (R_EARTH * D2R * Math.cos(center.lat * D2R)) };
}

function llDistM(a: LL, b: LL): number {
  const dLat = (b.lat - a.lat) * D2R, dLng = (b.lng - a.lng) * D2R, mid = (a.lat + b.lat) / 2 * D2R;
  return Math.hypot(dLat * R_EARTH, dLng * R_EARTH * Math.cos(mid));
}

/** '27L' → '09R', '09' → '27', '4R' → '22L'. Width of the number is preserved ('4R' stays single-digit). */
export function reciprocalName(name: string): string {
  const m = name.trim().toUpperCase().match(/^(\d{1,2})([LRC]?)$/);
  if (!m) return name;
  const n = parseInt(m[1], 10);
  const r = ((n + 18 - 1) % 36) + 1;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  const width = m[1].length;
  return `${width === 2 ? String(r).padStart(2, '0') : String(r)}${side}`;
}

// ── tokenizer: split into sections, scalars, and indented list blocks ───────────
interface RawSection { name: string; scalars: Map<string, string>; lists: Map<string, string[][]>; }

function tokenizeSections(text: string): RawSection[] {
  const lines = text.split(/\r?\n/);
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let listKey: string | null = null;

  const splitRow = (l: string) => l.trim().split(',').map(s => s.trim()).filter(s => s.length > 0);

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { listKey = null; continue; }                 // blank ends a list block
    if (line.trim().startsWith('#') || line.trim().startsWith('//')) continue;

    const sec = line.trim().match(/^\[([^\]]+)\]$/);
    if (sec) { cur = { name: sec[1].toLowerCase(), scalars: new Map(), lists: new Map() }; sections.push(cur); listKey = null; continue; }
    if (!cur) continue;

    const isIndented = /^[\t ]/.test(raw);
    if (isIndented && listKey) { cur.lists.get(listKey)!.push(splitRow(line)); continue; }

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (kv) {
      const key = kv[1].toLowerCase(); const val = kv[2].trim();
      if (val === '') { listKey = key; if (!cur.lists.has(key)) cur.lists.set(key, []); }
      else { cur.scalars.set(key, val); listKey = null; }
      continue;
    }
    // a bare indented row with no active list key is ignored
  }
  return sections;
}

// ── main parse ──────────────────────────────────────────────────────────────────
export function parseEndlessAirport(text: string): EAirport {
  const secs = tokenizeSections(text);
  const find = (n: string) => secs.find(s => s.name === n);
  const airspaceSec = find('airspace');
  if (!airspaceSec) throw new Error('No [airspace] section');

  const sc = airspaceSec.scalars;
  const centerRaw = (sc.get('center') ?? 'N0, E0').split(',').map(s => s.trim());
  const centerCoord = parseCoordPair(centerRaw[0], centerRaw[1]);
  const center: LL = centerCoord.kind === 'll' ? { lat: centerCoord.lat, lng: centerCoord.lng } : { lat: 0, lng: 0 };

  const beacons: EBeacon[] = (airspaceSec.lists.get('beacons') ?? []).map(r => ({
    id: r[0], coord: parseCoordPair(r[1], r[2]), holdHeading: r[3] ? num(r[3]) : undefined, pron: r[4],
  }));

  const boundary: ECoord[] = (airspaceSec.lists.get('boundary') ?? []).map(r => parseCoordPair(r[0], r[1]));

  const locSpeedRaw = sc.get('localizerspeed');
  const airspace: EAirspace = {
    radiusNM: num(sc.get('radius'), 30),
    center, magVar: num(sc.get('magneticvar')),
    floorFt: num(sc.get('floor'), 1500),
    ceilingFt: num(sc.get('ceiling'), 12000),
    aboveFt: num(sc.get('above'), 12000),
    transitionAltFt: num(sc.get('transitionaltitude'), 18000),
    separationNM: num(sc.get('separation'), 3),
    name: sc.get('name') ?? 'approach',
    decimalDegrees: (sc.get('decimaldegrees') ?? 'false') === 'true',
    beacons, boundary,
    localizerSpeed: locSpeedRaw ? (() => { const p = locSpeedRaw.split(',').map(s => num(s)); return { distNM: p[0], speedKt: p[1] }; })() : undefined,
    elevationFt: sc.has('elevation') ? num(sc.get('elevation')) : undefined,
    descendAltFt: sc.has('descendaltitude') ? num(sc.get('descendaltitude')) : undefined,
  };

  // ── every [airportN] section ──
  const parseRunwayRow = (r: string[], airportCode: string): ERunway | null => {
    if (r.length < 6) return null;
    const coord = parseCoordPair(r[2], r[3]);
    const trueHeading = num(r[4]);
    const displacedThrFt = num(r[6]);
    const last = r[r.length - 1];
    const towerFreq = r.length >= 12 && /^\d{3}\.\d{1,3}$/.test(last) ? parseFloat(last) : undefined;
    return {
      id: r[0], name: r[1], coord, trueHeading, lengthFt: num(r[5]),
      elevationFt: num(r[8]), thrElevFt: num(r[8]),
      glideslopeDeg: num(r[9], 3), localizerCourse: num(r[10], trueHeading),
      displacedThrFt, displacedThrOppFt: num(r[7]),
      thrCoord: displacedThrFt > 0 ? advanceCoord(coord, trueHeading, displacedThrFt * 0.3048) : coord,
      reciprocal: reciprocalName(r[1]), towerFreq, airportCode, derived: false,
    };
  };
  const parseEntryPoints = (rows: string[][]): EEntryPoint[] => {
    // dedupe by (heading,beacon) and count weight (repeated lines = more traffic)
    // Format: "heading, beacon, altitude" or "heading, altitude" (no beacon) or "heading, -, altitude" (explicit no-beacon)
    const epMap = new Map<string, EEntryPoint>();
    for (const r of rows) {
      let heading: number, beacon: string | undefined, altitudeFt: number;
      if (r.length < 3) {
        heading = num(r[0]); beacon = undefined; altitudeFt = num(r[1], 8000);
      } else {
        heading = num(r[0]);
        beacon = (r[1] && r[1] !== '-') ? r[1] : undefined;
        altitudeFt = num(r[2], 8000);
      }
      const key = `${heading}|${beacon ?? ''}`;
      const ex = epMap.get(key);
      if (ex) ex.weight++; else epMap.set(key, { heading, beacon, altitudeFt, weight: 1 });
    }
    return Array.from(epMap.values());
  };
  const airportSecs = secs.filter(s => /^airport\d+$/.test(s.name)).sort((a, b) => parseInt(a.name.slice(7), 10) - parseInt(b.name.slice(7), 10));
  const airports: EAirportSection[] = airportSecs.map(s => {
    const code = s.scalars.get('code') ?? 'XXXX';
    return {
      index: parseInt(s.name.slice(7), 10),
      code,
      name: s.scalars.get('name')?.split(',')[0].trim() ?? 'Airport',
      runways: (s.lists.get('runways') ?? []).map(r => parseRunwayRow(r, code)).filter((r): r is ERunway => !!r),
      entryPoints: parseEntryPoints(s.lists.get('entrypoints') ?? []),
      climbAltFt: num(s.scalars.get('climbaltitude'), 6000),
      traffic: s.scalars.has('traffic') ? num(s.scalars.get('traffic')) : undefined,
      airlines: (s.lists.get('airlines') ?? []).filter(r => r.length >= 2).map(r => ({ icao: r[0], weight: num(r[1], 1), types: (r[2] ?? '').split('/').filter(Boolean), telephony: r[3] ?? r[0], directions: r[4] ?? 'nswe' })),
      coLocated: false,
    };
  });
  const primary = airports[0];

  // co-located sections: same code as [airport1], or any runway threshold within 6 km of one of its thresholds
  const primaryThr = primary ? primary.runways.map(r => ecoordToLL(r.coord, center)) : [];
  for (const ap of airports) {
    if (!primary) break;
    if (ap === primary) { ap.coLocated = true; continue; }
    if (ap.code.toUpperCase() === primary.code.toUpperCase()) { ap.coLocated = true; continue; }
    ap.coLocated = ap.runways.some(r => { const p = ecoordToLL(r.coord, center); return primaryThr.some(q => llDistM(p, q) <= 6000); });
  }

  // merged runway list: explicit rows first (airport1 wins on duplicate names), then derived reciprocals.
  // Names are compared width-insensitively ('4R' == '04R', as KBOS is written single-digit in OSM).
  const normName = (n: string) => n.trim().toUpperCase().replace(/^0(?=\d)/, '');
  const runways: ERunway[] = [];
  const byName = new Map<string, ERunway>();
  for (const ap of airports) {
    if (!ap.coLocated) continue;
    for (const r of ap.runways) {
      const key = normName(r.name);
      if (byName.has(key)) continue;
      byName.set(key, r); runways.push(r);
    }
  }
  for (const r of runways.slice()) {
    const key = normName(r.reciprocal);
    if (byName.has(key) || key === normName(r.name)) continue;
    const far = advanceCoord(r.coord, r.trueHeading, r.lengthFt * 0.3048);
    const hdg = (r.trueHeading + 180) % 360;
    const d: ERunway = {
      id: r.reciprocal.toLowerCase(), name: r.reciprocal, coord: far, trueHeading: hdg, lengthFt: r.lengthFt,
      elevationFt: r.elevationFt, thrElevFt: r.thrElevFt, glideslopeDeg: r.glideslopeDeg, localizerCourse: hdg,
      displacedThrFt: r.displacedThrOppFt, displacedThrOppFt: r.displacedThrFt,
      thrCoord: r.displacedThrOppFt > 0 ? advanceCoord(far, hdg, r.displacedThrOppFt * 0.3048) : far,
      reciprocal: r.name, towerFreq: r.towerFreq, airportCode: r.airportCode, derived: true,
    };
    byName.set(key, d); runways.push(d);
  }
  // runway id -> end name, primary aerodrome only (a secondary aerodrome's SIDs never attach to the primary's runways)
  const runwayNameById = new Map<string, string>();
  for (const ap of airports) if (ap.coLocated) for (const r of ap.runways) if (!runwayNameById.has(r.id)) runwayNameById.set(r.id, r.name);
  for (const r of runways) if (!runwayNameById.has(r.id)) runwayNameById.set(r.id, r.name);

  // ── SIDs / STARs ──
  const parseRoutes = (prefix: string, kind: ERoute['kind']): ERoute[] => {
    const routes: ERoute[] = [];
    const seen = new Map<string, ERoute>();
    for (const s of secs.filter(x => new RegExp(`^${prefix}\\d*$`).test(x.name))) {
      const runwayIds = (s.scalars.get('runway') ?? '').split(',').map(x => x.trim()).filter(Boolean);
      const runwayId = runwayIds[0];
      const beacon = s.scalars.get('beacon')?.split(',')[0].trim() || undefined;
      const keys = Array.from(s.lists.keys()).filter(k => /^route\d*$/.test(k)).sort((a, b) => num(a.replace('route', '')) - num(b.replace('route', '')));
      for (const key of keys) {
        const rows = s.lists.get(key)!;
        if (rows.length < 1) continue;
        const head = rows[0];
        const steps: ERouteStep[] = rows.slice(1)
          .filter(rw => rw.length >= 2 && (parseDegToken(rw[0]).hasLetter || parseDegToken(rw[1]).hasLetter || (isFinite(parseFloat(rw[0])) && isFinite(parseFloat(rw[1])))))
          .map(rw => ({ coord: parseCoordPair(rw[0], rw[1]), maxAltFt: rw[2] ? num(rw[2]) : undefined, maxSpeedKt: rw[3] ? num(rw[3]) : undefined }));
        const dedupeKey = `${head[0]}|${runwayIds.join(',')}|${beacon ?? ''}`;
        const ex = seen.get(dedupeKey);
        if (ex) { ex.weight++; continue; }
        const runwayNames = runwayIds.map(id => runwayNameById.get(id)).filter((n): n is string => !!n);
        if (runwayIds.length && !runwayNames.length) continue;   // belongs to a secondary aerodrome in the same file
        const route: ERoute = {
          name: head[0], pron: head[1], runwayId, steps, kind, runwayIds,
          runways: runwayNames,
          waypoints: steps.map(st => { const ll = ecoordToLL(st.coord, center); return { lat: ll.lat, lng: ll.lng, altFt: st.maxAltFt, speedKt: st.maxSpeedKt }; }),
          beacon, weight: 1,
        };
        seen.set(dedupeKey, route);
        routes.push(route);
      }
    }
    return routes;
  };
  const sids = parseRoutes('departure', 'sid');
  const stars = parseRoutes('approach', 'star');

  const areas: EArea[] = secs.filter(s => /^area\d+$/.test(s.name)).map(s => {
    const shape = (s.scalars.get('shape') ?? 'polygon') as 'circle' | 'polygon';
    const posRaw = s.scalars.get('position')?.split(',').map(x => x.trim());
    return {
      shape, altitudeFt: num(s.scalars.get('altitude')), name: s.scalars.get('name'),
      radiusNM: s.scalars.has('radius') ? num(s.scalars.get('radius')) : undefined,
      center: posRaw && posRaw.length >= 2 ? parseCoordPair(posRaw[0], posRaw[1]) : undefined,
      points: (s.lists.get('points') ?? []).map(r => parseCoordPair(r[0], r[1])),
    };
  });

  return {
    airspace,
    code: primary?.code ?? 'XXXX',
    name: primary?.name ?? 'Airport',
    runways, entryPoints: primary?.entryPoints ?? [],
    departures: sids, approaches: stars, sids, stars,
    areas, climbAltFt: primary?.climbAltFt ?? 6000,
    airports,
  };
}

/** SIDs applicable to a runway end name ('27L'); empty when the file has none for it. */
export function sidsForRunway(ap: EAirport, runwayEnd: string): ERoute[] {
  const N = runwayEnd.toUpperCase();
  return ap.sids.filter(r => r.runways.some(n => n.toUpperCase() === N));
}

/** STARs applicable to a runway end name, optionally from a given beacon/fix. */
export function starsForRunway(ap: EAirport, runwayEnd: string, beacon?: string): ERoute[] {
  const N = runwayEnd.toUpperCase();
  return ap.stars.filter(r => r.runways.some(n => n.toUpperCase() === N) && (!beacon || (r.beacon ?? r.name.replace(/\d[A-Z]$/, '')).toUpperCase() === beacon.toUpperCase()));
}

// ── coordinate → local XY metres via the sim projection ─────────────────────────
export function coordToXY(c: ECoord, proj: { toXY: (lat: number, lng: number) => { x: number; y: number } }): { x: number; y: number } {
  return c.kind === 'll' ? proj.toXY(c.lat, c.lng) : { x: c.xNM * NM_M, y: c.yNM * NM_M };
}

export async function loadEndlessAirport(icao: string): Promise<EAirport> {
  const res = await fetch(`/airspace/${icao}.txt`);
  if (!res.ok) throw new Error(`No airspace file for ${icao}: ${res.status}`);
  return parseEndlessAirport(await res.text());
}

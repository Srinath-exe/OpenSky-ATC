// ============================================================
//  Endless ATC airport-file parser.
//
//  Parses the community `.txt` airport format used by EndlessATC
//  (github.com/EndlessATC/Airports) — a factual aviation-data config: airspace
//  radius/center, beacons (fixes), runway + ILS geometry, entry points, SIDs,
//  restricted areas. We adopt the FORMAT and the factual nav data; no game
//  assets are used. Output is normalised so the sim's LocalProjection can map
//  every coordinate into the shared local-XY-metres space.
//
//  Format reference: the repo's example.txt + real files (e.g. EGLL).
// ============================================================

export interface LL { lat: number; lng: number; }
// A coordinate is either lat/lng degrees (tokens with N/S/E/W) or x,y NM from center.
export type ECoord = { kind: 'll'; lat: number; lng: number } | { kind: 'xy'; xNM: number; yNM: number };

export interface EBeacon { id: string; coord: ECoord; holdHeading?: number; pron?: string; }
export interface ERunway {
  id: string; name: string; coord: ECoord;
  trueHeading: number; lengthFt: number;
  glideslopeDeg: number; localizerCourse: number; elevationFt: number;
}
export interface EEntryPoint { heading: number; beacon?: string; altitudeFt: number; weight: number; }
export interface ERouteStep { coord: ECoord; maxAltFt?: number; maxSpeedKt?: number; }
export interface ERoute { name: string; pron?: string; runwayId?: string; steps: ERouteStep[]; }
export interface EArea { shape: 'circle' | 'polygon'; altitudeFt: number; name?: string; radiusNM?: number; center?: ECoord; points: ECoord[]; }

export interface EAirspace {
  radiusNM: number;
  center: LL;
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
}

export interface EAirport {
  airspace: EAirspace;
  code: string;
  name: string;
  runways: ERunway[];
  entryPoints: EEntryPoint[];
  departures: ERoute[];   // SID routes
  approaches: ERoute[];
  areas: EArea[];
  climbAltFt: number;
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
  };

  const ap = find('airport1');
  const runways: ERunway[] = (ap?.lists.get('runways') ?? []).map(r => ({
    id: r[0], name: r[1], coord: parseCoordPair(r[2], r[3]),
    trueHeading: num(r[4]), lengthFt: num(r[5]),
    elevationFt: num(r[8]), glideslopeDeg: num(r[9], 3), localizerCourse: num(r[10], num(r[4])),
  }));

  // entry points: dedupe by (heading,beacon) and count weight (repeated lines = more traffic)
  // Format: "heading, beacon, altitude" or "heading, altitude" (no beacon) or "heading, -, altitude" (explicit no-beacon)
  const epMap = new Map<string, EEntryPoint>();
  for (const r of (ap?.lists.get('entrypoints') ?? [])) {
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

  const parseRoutes = (prefix: string): ERoute[] => {
    const routes: ERoute[] = [];
    for (const s of secs.filter(x => x.name.startsWith(prefix))) {
      const runwayId = s.scalars.get('runway')?.split(',')[0].trim();
      for (const [key, rows] of s.lists) {
        if (!key.startsWith('route') || rows.length < 1) continue;
        const head = rows[0];
        const steps: ERouteStep[] = rows.slice(1).map(rw => ({ coord: parseCoordPair(rw[0], rw[1]), maxAltFt: rw[2] ? num(rw[2]) : undefined, maxSpeedKt: rw[3] ? num(rw[3]) : undefined }));
        routes.push({ name: head[0], pron: head[1], runwayId, steps });
      }
    }
    return routes;
  };

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
    code: ap?.scalars.get('code') ?? 'XXXX',
    name: ap?.scalars.get('name')?.split(',')[0].trim() ?? 'Airport',
    runways, entryPoints: Array.from(epMap.values()),
    departures: parseRoutes('departure'), approaches: parseRoutes('approach'),
    areas, climbAltFt: num(ap?.scalars.get('climbaltitude'), 6000),
  };
}

// ── coordinate → local XY metres via the sim projection ─────────────────────────
const NM_M = 1852;
export function coordToXY(c: ECoord, proj: { toXY: (lat: number, lng: number) => { x: number; y: number } }): { x: number; y: number } {
  return c.kind === 'll' ? proj.toXY(c.lat, c.lng) : { x: c.xNM * NM_M, y: c.yNM * NM_M };
}

export async function loadEndlessAirport(icao: string): Promise<EAirport> {
  const res = await fetch(`/airspace/${icao}.txt`);
  if (!res.ok) throw new Error(`No airspace file for ${icao}: ${res.status}`);
  return parseEndlessAirport(await res.text());
}

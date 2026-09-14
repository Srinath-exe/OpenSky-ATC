// ============================================================
//  OSM Airport — the airport data layer (W1-DATA)
//
//  Builds, from one OpenStreetMap aeroway GeoJSON (public/maps/osm/<ICAO>.geojson,
//  see scripts/fetch_osm_airports.py):
//
//    • the taxiway/runway graph  (OSM ways share vertices at intersections, so
//      the LineStrings form ONE routable graph with no healing needed)
//    • runways: duplicate/split OSM ways merged per ref into one physical
//      runway with its two TRUE ends, oriented by geometry (designator ×10 vs
//      the bearing from that end toward the other, magnetic variation applied)
//    • holding positions (OSM Points + hold LineStrings) snapped onto graph
//      nodes and associated with the runway they protect; synthesized holds at
//      every runway/taxiway junction that OSM left unmarked
//    • stands / gates with lead-in lines, parked heading, size class, terminal
//    • terminal / hangar / apron polygons (lat/lng; the engine projects)
//    • service stations (ARFF, tug depot, follow-me/ops, fuel farm, de-ice)
//    • A* path finding with a binary heap, avoid sets and taxiway preferences
//
//  API (all pure, deterministic for a given input file — no DOM, no randomness):
//    buildOsmAirport(icao, fc, { magVarDeg? })   -> OsmAirport
//    findPath(air, from, to, opts?)               -> node ids | null   (opts: avoidRunways, avoidNodes, prefer, allowRunway)
//    routeVia(air, from, ['A','B'], to, opts?)    -> node ids | null
//    taxiwaysForPath(air, ids) / pathLengthM(air, ids)
//    holdsOnPath(air, ids)                        -> PathHold[] (hold-short PLACES on the path, path order)
//    holdForRunwayEntry(air, '27L', fromNodeId)   -> the entry hold to taxi to for a departure
//    holdsForRunway / isHoldNodeForRunway / runwayEndByName / runwayFor / runwayRefsAtNode
//    nearestOsmNode(air, lng, lat, maxM?)          -> grid-indexed nearest node
//    standByRef / vehicleStationsLL               -> stand lookup, VehicleFleet station map (lat/lng)
// ============================================================
import type { PathHold } from './sim/types';

export interface LngLat { lng: number; lat: number; }

export type OsmEdgeType = 'taxiway' | 'runway';
export interface OsmEdge {
  to: string;
  type: OsmEdgeType;
  meters: number;
  /** Taxiway designator (A, B, K1 …) for named taxiway edges. */
  taxiway?: string;
  /** Physical runway ref ('09R/27L') for runway edges that belong to a merged runway. */
  runway?: string;
  /** Stand lead-in edge (apron; type 'taxiway' so legacy routing treats it as a taxi lane). */
  leadIn?: boolean;
}

export interface OsmNode {
  id: string;
  lng: number;
  lat: number;
  edges: OsmEdge[];
}

/** Backward-compatible parking point (same data as `stands[]`). */
export interface OsmGate {
  ref: string;
  lng: number;
  lat: number;
  nodeId: string;          // graph node at the stand (leaf node at the end of the lead-in)
}

export interface OsmRunwayEnd {
  name: string;            // '27L'
  /** Physical end of the pavement (a graph node) — the "true" end the sim uses for roll/threshold. */
  lng: number;
  lat: number;
  nodeId: string;
  /** Direction of movement FROM this end toward the other, degrees true. */
  trueHdg: number;
  /** Same, magnetic (airport magnetic variation applied). */
  magHdg: number;
  /** Landing threshold: physical end advanced by `displacedM` along `trueHdg` (== end when 0). */
  thr: LngLat;
  /** Displaced threshold length when derivable from OSM way splits (0 otherwise). */
  displacedM: number;
  /** Holding positions that are entry holds for this end (closest first). */
  holdNodeIds: string[];
}

export interface OsmRunway {
  ref: string;             // e.g. "06L/24R"
  ends: OsmRunwayEnd[];    // always two
  lengthM: number;
  /** Bearing ends[0] → ends[1], degrees true. */
  trueHdg: number;
  /** Ordered centreline graph nodes from ends[0] to ends[1]. */
  nodeIds: string[];
  /** Other physical runway refs whose centrelines cross this one. */
  intersects: string[];
  orientation: 'geometry' | 'ambiguous';
  /** Number of OSM ways merged into this runway. */
  segments: number;
}

export interface OsmHoldingPosition {
  id: string;
  nodeId: string;
  lng: number;
  lat: number;
  ref: string | null;
  /** Physical runway refs this hold protects (usually one; empty for taxiway/apron holds). */
  runwayRefs: string[];
  /** Both end names of every protected runway (PathHold.runway accepts either). */
  runwayEnds: string[];
  /** Runway end name when the hold sits at a threshold entry, else null (mid-runway crossing / intersection). */
  entryEnd: string | null;
  /** Nearest end name of the protected runway (null when no runway). */
  nearestEnd: string | null;
  taxiwayRef: string | null;
  /** Perpendicular distance to the protected runway centreline, m (Infinity when none). */
  distToRunwayM: number;
  kind: 'runway' | 'taxiway' | 'synthetic';
  source: 'osm' | 'synthesized';
  /** Hold-line geometry when OSM drew one. */
  line: LngLat[] | null;
}

export type StandSize = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type StandType = 'gate' | 'stand' | 'remote';

export interface OsmStand {
  ref: string;
  /** Stop position (nose wheel). */
  lng: number;
  lat: number;
  /** Graph leaf node at the stop position. */
  nodeId: string;
  /** Taxiway / taxilane node where the lead-in joins the graph. */
  entryNodeId: string;
  /** Straight-line simplification of the lead-in: from = taxiway entry, to = stand. */
  leadIn: { from: LngLat; to: LngLat } | null;
  /** Full lead-in polyline, entry → stand (≥ 2 points; synthesized straight line when OSM has none). */
  leadInPts: LngLat[];
  /** Aircraft heading when parked (bearing of the lead-in), degrees true. */
  headingIn: number;
  /** Alias of headingIn (engine `StandRec` shape). */
  heading: number;
  /** Reverse of headingIn — the direction the tug pushes. */
  pushbackHeading: number;
  type: StandType;
  size: StandSize;
  terminal?: string;
  osmId: number | null;
  sizeSource: 'ref' | 'spacing' | 'leadin' | 'default';
  /** True when OSM drew the lead-in line (headingIn is measured, not inferred). */
  hasLeadIn: boolean;
  /** Nose-in stands need a tug (03 §1.3 / UX §G5.3); small remote/GA spots are taxi-out. */
  needsPushback: boolean;
  /** Stand closure (NOTAM) — always false from OSM; the engine may flip it. */
  closed: boolean;
}

export interface OsmBuilding {
  kind: 'terminal' | 'hangar' | 'apron';
  name: string | null;
  polygon: LngLat[];
  centroid: LngLat;
  areaM2: number;
  osmId: number | null;
}

export interface OsmStation {
  lat: number;
  lng: number;
  name: string | null;
  source: 'osm' | 'inferred';
  /** Nearest graph node (never null once the graph has nodes). */
  nodeId: string | null;
}

export interface OsmArffStandby {
  runway: string;            // physical ref
  end: string;               // end name whose touchdown zone this point is abeam
  touchdown: LngLat;         // abeam the touchdown zone (≈300 m in from the threshold)
  midpoint: LngLat;          // abeam the runway mid-point
  touchdownNodeId: string | null;
  midpointNodeId: string | null;
}

export interface OsmStations {
  arff: OsmStation;
  /** Every on-airport fire station found (primary first). */
  arffAll: OsmStation[];
  ambulance: OsmStation;
  tugDepot: OsmStation;
  followMeBase: OsmStation;
  ops: OsmStation;
  fuelFarm: OsmStation;
  deice: Array<OsmStation & { ref: string }>;
  arffStandby: OsmArffStandby[];
}

export interface OsmAirport {
  icao: string;
  center: LngLat;
  /** Magnetic variation used for orientation, degrees (east positive). */
  magVar: number;
  nodes: Map<string, OsmNode>;
  /** Backward compat: one entry per stand (ref, stop position, leaf node id). */
  gates: OsmGate[];
  stands: OsmStand[];
  runways: OsmRunway[];
  holdingPositions: OsmHoldingPosition[];
  holdByNode: Map<string, OsmHoldingPosition>;
  buildings: OsmBuilding[];
  stations: OsmStations;
  taxiwayNames: string[];                 // sorted unique taxiway designators (A, B, …)
  taxiwayNodes: Map<string, string[]>;    // taxiway name → node ids on it
  /** Data-quality notes produced while building (also console.warn'ed once). */
  warnings: string[];
}

// ── constants ───────────────────────────────────────────────
const R = 6371000;
const D2R = Math.PI / 180;
/** Hold snapping: an OSM hold within this distance of a node uses that node, else the edge is split. */
const HOLD_SNAP_M = 8;
/** Hold associates with a runway whose centreline is within this perpendicular distance … */
const HOLD_RWY_DIST_M = 150;
/** … but not closer than this (a marked hold on the runway strip itself is a data error, not a stop). */
const HOLD_RWY_MIN_M = 35;
/** … and which the taxiway reaches within this path length. */
const HOLD_RWY_PATH_M = 320;
/** Synthesized hold: perpendicular distance from the runway centreline (ICAO Annex 14 code 4 CAT I = 75 m). */
const SYNTH_HOLD_M = 75;
/** Minimum distance from a stand's stop position (nose wheel) to a terminal outline; closer stops are pulled back. */
const NOSE_CLEAR_M = 14;
/** A hold within this along-axis distance of a runway end counts as an entry hold for that end. */
const ENTRY_HOLD_M = 500;
/** Runway edge cost multiplier in findPath (taxiways are strongly preferred). */
const RUNWAY_COST = 40;
/** Fallback magnetic variation per airport, degrees east-positive (2025 WMM, rounded). */
const MAGVAR_FALLBACK: Record<string, number> = { EGLL: 0.5, KLAX: 11.5, KJFK: -12.7, KSFO: 13.2, KBOS: -14.2, VIDP: 0.9, VHHH: -3.4, YSSY: 12.7, LFPG: 2.0, WSSS: 0.2, RJTT: -7.7, OMDB: 2.0 };

// ── geo helpers ─────────────────────────────────────────────
export function meters(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLat = (bLat - aLat) * D2R;
  const dLng = (bLng - aLng) * D2R;
  const mid = (aLat + bLat) / 2 * D2R;
  return Math.hypot(dLat * R, dLng * R * Math.cos(mid));
}

// compass bearing (0=N, 90=E, 180=S, 270=W)
export function bearingDeg(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLng = (bLng - aLng) * D2R;
  const lat1 = aLat * D2R;
  const lat2 = bLat * D2R;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Move a point `m` metres along compass bearing `hdg`. */
export function advanceLL(p: LngLat, hdg: number, m: number): LngLat {
  const dN = Math.cos(hdg * D2R) * m, dE = Math.sin(hdg * D2R) * m;
  return { lng: p.lng + dE / (R * D2R * Math.cos(p.lat * D2R)), lat: p.lat + dN / (R * D2R) };
}

/** Smallest absolute difference between two compass angles. */
export function angDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

// node key — round to 6 decimals (~0.11m) so OSM-shared vertices merge exactly
function keyOf(lng: number, lat: number): string {
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

interface XY { x: number; y: number; }

/** Local planar frame (metres) used for all geometry inside the builder. */
class Frame {
  private readonly kx: number;
  private readonly ky: number;
  constructor(readonly c: LngLat) {
    this.kx = R * Math.cos(c.lat * D2R) * D2R;
    this.ky = R * D2R;
  }
  xy(lng: number, lat: number): XY { return { x: (lng - this.c.lng) * this.kx, y: (lat - this.c.lat) * this.ky }; }
  ll(p: XY): LngLat { return { lng: this.c.lng + p.x / this.kx, lat: this.c.lat + p.y / this.ky }; }
}

function projOnSeg(p: XY, a: XY, b: XY): { t: number; x: number; y: number; d: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx, y = a.y + t * dy;
  return { t, x, y, d: Math.hypot(p.x - x, p.y - y) };
}

function segIntersect(a: XY, b: XY, c: XY, d: XY): XY | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qp.x * s.y - qp.y * s.x) / den;
  const u = (qp.x * r.y - qp.y * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

function polyArea(pts: XY[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}
function polyCentroid(pts: XY[]): XY {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / Math.max(1, pts.length), y: sy / Math.max(1, pts.length) };
}
function pointInPoly(p: XY, poly: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function distToPolyEdge(p: XY, poly: XY[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, projOnSeg(p, poly[i], poly[(i + 1) % poly.length]).d);
  return best;
}

// ── loader ──────────────────────────────────────────────────
export async function loadOsmAirport(icao: string, opts?: BuildOpts): Promise<OsmAirport> {
  const res = await fetch(`/maps/osm/${icao}.geojson`);
  if (!res.ok) throw new Error(`Failed to load OSM data for ${icao}: ${res.status}`);
  const fc = await res.json();
  return buildOsmAirport(icao, fc, opts);
}

export interface BuildOpts {
  /** Magnetic variation, degrees east-positive (from the airspace file). Falls back to a per-airport table, else 0. */
  magVarDeg?: number;
  /** Suppress console.warn for data-quality notes (they are always available in `warnings`). */
  quiet?: boolean;
}

interface Feature { properties?: Record<string, unknown> | null; geometry?: { type: string; coordinates: unknown } | null; }

// A merged physical runway while building.
interface RwBuild {
  ref: string;
  names: [string, string];
  main: [number, number][];
  members: Feature[];
  axis: XY;          // unit vector along main
  origin: XY;        // main[0]
  minT: number; maxT: number;
  mainT0: number; mainT1: number;
  verts: Map<string, { t: number; lng: number; lat: number }>;
}

export function buildOsmAirport(icao: string, fc: unknown, opts: BuildOpts = {}): OsmAirport {
  const nodes = new Map<string, OsmNode>();
  const warnings: string[] = [];
  const warn = (s: string) => { warnings.push(s); };
  const featuresRaw = (fc as { features?: unknown })?.features;
  const features: Feature[] = Array.isArray(featuresRaw) ? (featuresRaw as Feature[]) : [];
  const centerRaw = (fc as { center?: unknown })?.center;
  const center: LngLat = Array.isArray(centerRaw) && centerRaw.length >= 2
    ? { lng: Number(centerRaw[0]), lat: Number(centerRaw[1]) }
    : { lng: 0, lat: 0 };
  const magVar = opts.magVarDeg ?? MAGVAR_FALLBACK[icao] ?? 0;
  const frame = new Frame(center);
  const xyOf = (n: { lng: number; lat: number }) => frame.xy(n.lng, n.lat);

  const prop = (f: Feature, k: string): unknown => f.properties ? f.properties[k] : undefined;
  const aerowayOf = (f: Feature) => String(prop(f, 'aeroway') ?? '');
  const refOf = (f: Feature): string | null => { const r = prop(f, 'ref'); return r == null || r === '' ? null : String(r); };
  const nameOf = (f: Feature): string | null => { const r = prop(f, 'name'); return r == null || r === '' ? null : String(r); };
  const idOf = (f: Feature): number | null => { const r = prop(f, 'id'); return typeof r === 'number' ? r : (r != null && isFinite(Number(r)) ? Number(r) : null); };
  const geomType = (f: Feature) => f.geometry?.type ?? '';
  const coordsOf = (f: Feature): [number, number][] => (f.geometry?.coordinates as [number, number][]) ?? [];

  const node = (lng: number, lat: number): OsmNode => {
    const k = keyOf(lng, lat);
    let n = nodes.get(k);
    if (!n) { n = { id: k, lng, lat, edges: [] }; nodes.set(k, n); }
    return n;
  };

  const taxiwayNodes = new Map<string, Set<string>>();
  const link = (a: OsmNode, b: OsmNode, type: OsmEdgeType, attrs: { taxiway?: string; runway?: string; leadIn?: boolean } = {}) => {
    if (a.id === b.id) return;
    const m = meters(a.lng, a.lat, b.lng, b.lat);
    const mk = (to: string): OsmEdge => {
      const e: OsmEdge = { to, type, meters: m };
      if (attrs.taxiway) e.taxiway = attrs.taxiway;
      if (attrs.runway) e.runway = attrs.runway;
      if (attrs.leadIn) e.leadIn = true;
      return e;
    };
    if (!a.edges.some(e => e.to === b.id)) a.edges.push(mk(b.id));
    if (!b.edges.some(e => e.to === a.id)) b.edges.push(mk(a.id));
    if (attrs.taxiway) {
      if (!taxiwayNodes.has(attrs.taxiway)) taxiwayNodes.set(attrs.taxiway, new Set());
      taxiwayNodes.get(attrs.taxiway)!.add(a.id); taxiwayNodes.get(attrs.taxiway)!.add(b.id);
    }
  };
  const unlink = (a: OsmNode, b: OsmNode) => {
    a.edges = a.edges.filter(e => e.to !== b.id);
    b.edges = b.edges.filter(e => e.to !== a.id);
  };
  /** Split edge a–b at point p (lng/lat); returns the new (or coincident) node. */
  const splitEdge = (a: OsmNode, b: OsmNode, p: LngLat): OsmNode => {
    const e = a.edges.find(x => x.to === b.id);
    if (!e) return node(p.lng, p.lat);
    const mid = node(p.lng, p.lat);
    if (mid.id === a.id || mid.id === b.id) return mid;
    unlink(a, b);
    const attrs = { taxiway: e.taxiway, runway: e.runway, leadIn: e.leadIn };
    link(a, mid, e.type, attrs);
    link(mid, b, e.type, attrs);
    return mid;
  };

  // ── 1. graph from taxiway + runway lines ──
  const taxiwayRefRe = /^[A-Z0-9]{1,3}$/i;
  for (const f of features) {
    const aw = aerowayOf(f);
    if ((aw !== 'taxiway' && aw !== 'runway') || geomType(f) !== 'LineString') continue;
    const cs = coordsOf(f);
    const rawRef = refOf(f);
    const ref = aw === 'taxiway' && rawRef && taxiwayRefRe.test(rawRef) ? rawRef.toUpperCase() : undefined;
    for (let i = 0; i < cs.length - 1; i++) {
      const a = node(cs[i][0], cs[i][1]);
      const b = node(cs[i + 1][0], cs[i + 1][1]);
      link(a, b, aw, { taxiway: ref });
    }
  }

  // ── 2. runways: merge split/duplicate ways per ref, orient by geometry ──
  const rwSegs = features.filter(f => aerowayOf(f) === 'runway' && geomType(f) === 'LineString' && coordsOf(f).length >= 2);
  const rwNameRe = /^\d{1,2}[LRC]?$/;
  const isRwRef = (r: string | null): r is string => {
    if (!r || !r.includes('/')) return false;
    const [a, b] = r.split('/').map(s => s.trim());
    if (!rwNameRe.test(a) || !rwNameRe.test(b)) return false;
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    return na >= 1 && na <= 36 && nb >= 1 && nb <= 36;
  };
  const segLen = (cs: [number, number][]) => { let s = 0; for (let i = 0; i < cs.length - 1; i++) s += meters(cs[i][0], cs[i][1], cs[i + 1][0], cs[i + 1][1]); return s; };
  const builds = new Map<string, RwBuild>();
  // '34R/16L' and '16L/34R' name the same runway: order the designators by number so duplicate ways merge
  const canonRef = (r: string | null): string | null => { if (!isRwRef(r)) return r; const parts = r!.split('/').map(x => x.trim().toUpperCase()); parts.sort((x, y) => parseInt(x, 10) - parseInt(y, 10)); return parts.join('/'); };
  for (const f of rwSegs) {
    const ref = canonRef(refOf(f));
    if (!isRwRef(ref)) continue;
    const cs = coordsOf(f);
    const prev = builds.get(ref);
    if (!prev || segLen(cs) > segLen(prev.main)) {
      const [n0, n1] = ref.split('/').map(s => s.trim()) as [string, string];
      const a = frame.xy(cs[0][0], cs[0][1]), b = frame.xy(cs[cs.length - 1][0], cs[cs.length - 1][1]);
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      builds.set(ref, { ref, names: [n0, n1], main: cs, members: [], axis: { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, origin: a, minT: 0, maxT: L, mainT0: 0, mainT1: L, verts: new Map() });
    }
  }
  const tOf = (rb: RwBuild, p: XY) => (p.x - rb.origin.x) * rb.axis.x + (p.y - rb.origin.y) * rb.axis.y;
  const perpOf = (rb: RwBuild, p: XY) => Math.abs((p.x - rb.origin.x) * -rb.axis.y + (p.y - rb.origin.y) * rb.axis.x);
  const claimed = new Set<Feature>();
  // members: same ref, or unnamed, collinear (all vertices ≤ 20 m off the main line) and abutting the current extent (≤ 40 m gap); iterate to chain.
  for (const rb of builds.values()) {
    for (const [lng, lat] of rb.main) { const p = frame.xy(lng, lat); rb.verts.set(keyOf(lng, lat), { t: tOf(rb, p), lng, lat }); }
    let grew = true;
    const pool = rwSegs.filter(f => !claimed.has(f) && (canonRef(refOf(f)) === rb.ref || !isRwRef(refOf(f))));
    while (grew) {
      grew = false;
      for (const f of pool) {
        if (claimed.has(f)) continue;
        const cs = coordsOf(f);
        if (cs === rb.main) { claimed.add(f); rb.members.push(f); continue; }
        const pts = cs.map(c => frame.xy(c[0], c[1]));
        if (!pts.every(p => perpOf(rb, p) <= 20)) continue;
        const ts = pts.map(p => tOf(rb, p));
        const lo = Math.min(...ts), hi = Math.max(...ts);
        if (hi < rb.minT - 40 || lo > rb.maxT + 40) continue;
        claimed.add(f); rb.members.push(f); grew = true;
        rb.minT = Math.min(rb.minT, lo); rb.maxT = Math.max(rb.maxT, hi);
        cs.forEach((c, i) => rb.verts.set(keyOf(c[0], c[1]), { t: ts[i], lng: c[0], lat: c[1] }));
      }
    }
    if (!rb.members.some(f => coordsOf(f) === rb.main)) { const mf = rwSegs.find(f => coordsOf(f) === rb.main); if (mf) { claimed.add(mf); rb.members.push(mf); } }
  }

  const runways: OsmRunway[] = [];
  const runwayNodeRefs = new Map<string, string[]>();
  const rwByRef = new Map<string, OsmRunway>();
  for (const rb of Array.from(builds.values()).sort((a, b) => (b.maxT - b.minT) - (a.maxT - a.minT))) {
    const chain = Array.from(rb.verts.values()).sort((a, b) => a.t - b.t);
    if (chain.length < 2) continue;
    // heal gaps between consecutive centreline nodes and tag runway edges with the ref
    const chainNodes = chain.map(v => node(v.lng, v.lat));
    for (let i = 0; i < chainNodes.length - 1; i++) {
      const a = chainNodes[i], b = chainNodes[i + 1];
      if (a.id === b.id) continue;
      let e = a.edges.find(x => x.to === b.id);
      if (!e) { link(a, b, 'runway'); e = a.edges.find(x => x.to === b.id)!; }
      e.runway = rb.ref; const back = b.edges.find(x => x.to === a.id); if (back) back.runway = rb.ref;
    }
    const nodeIds = chainNodes.map(n => n.id).filter((id, i, arr) => i === 0 || arr[i - 1] !== id);
    const P0 = chain[0], P1 = chain[chain.length - 1];
    const b01 = bearingDeg(P0.lng, P0.lat, P1.lng, P1.lat);
    const magB01 = (b01 - magVar + 360) % 360;
    const d0 = parseInt(rb.names[0], 10) * 10, d1 = parseInt(rb.names[1], 10) * 10;
    const diff0 = angDiff(d0, magB01), diff1 = angDiff(d1, magB01);
    // The end whose designator ×10 matches the bearing FROM it TO the other end gets that name.
    const first = diff0 <= diff1 ? rb.names[0] : rb.names[1];
    const second = diff0 <= diff1 ? rb.names[1] : rb.names[0];
    let orientation: OsmRunway['orientation'] = 'geometry';
    if (Math.min(diff0, diff1) > 25 || Math.abs(diff0 - diff1) < 30) {
      orientation = 'ambiguous';
      warn(`${icao} runway ${rb.ref}: ambiguous orientation (bearing ${b01.toFixed(1)}T / ${magB01.toFixed(1)}M vs ${d0}/${d1}); assigned ${first} at the ${b01 < 180 ? 'NW' : 'SE'} end`);
    }
    const lengthM = rb.maxT - rb.minT;
    // Displaced thresholds: OSM mappers usually split the runway way at the displaced threshold, so a short
    // extension beyond the main (longest) way is read as the displaced part. Only trust it when the main way
    // covers most of the runway and the extension is a plausible displacement (≤ 320 m); else 0.
    const mainFrac = (rb.mainT1 - rb.mainT0) / Math.max(1, rb.maxT - rb.minT);
    const dispOk = (d: number) => (mainFrac >= 0.7 && d > 0 && d <= 320 ? d : 0);
    const disp0 = dispOk(rb.mainT0 - rb.minT);
    const disp1 = dispOk(rb.maxT - rb.mainT1);
    const mkEnd = (name: string, P: { lng: number; lat: number }, hdg: number, disp: number): OsmRunwayEnd => ({
      name, lng: P.lng, lat: P.lat, nodeId: keyOf(P.lng, P.lat), trueHdg: hdg, magHdg: (hdg - magVar + 360) % 360,
      thr: disp > 0 ? advanceLL({ lng: P.lng, lat: P.lat }, hdg, disp) : { lng: P.lng, lat: P.lat }, displacedM: disp, holdNodeIds: [],
    });
    const rw: OsmRunway = {
      ref: rb.ref,
      ends: [mkEnd(first, P0, b01, disp0), mkEnd(second, P1, (b01 + 180) % 360, disp1)],
      lengthM, trueHdg: b01, nodeIds, intersects: [], orientation, segments: rb.members.length,
    };
    runways.push(rw); rwByRef.set(rb.ref, rw);
    for (const id of nodeIds) { const arr = runwayNodeRefs.get(id) ?? []; if (!arr.includes(rb.ref)) arr.push(rb.ref); runwayNodeRefs.set(id, arr); }
  }
  // intersections between physical runways
  for (let i = 0; i < runways.length; i++) for (let j = i + 1; j < runways.length; j++) {
    const a = runways[i], b = runways[j];
    const hit = segIntersect(xyOf(a.ends[0]), xyOf(a.ends[1]), xyOf(b.ends[0]), xyOf(b.ends[1]));
    if (hit) { a.intersects.push(b.ref); b.intersects.push(a.ref); }
  }

  // ── spatial helpers ──
  const isRunwayNode = (id: string) => runwayNodeRefs.has(id);
  interface EdgeRec { a: OsmNode; b: OsmNode; ax: XY; bx: XY; e: OsmEdge; }
  const collectTaxiEdges = (): EdgeRec[] => {
    const out: EdgeRec[] = [];
    for (const a of nodes.values()) for (const e of a.edges) {
      if (e.type !== 'taxiway' || e.leadIn || a.id >= e.to) continue;
      const b = nodes.get(e.to); if (!b) continue;
      out.push({ a, b, ax: xyOf(a), bx: xyOf(b), e });
    }
    return out;
  };
  class EdgeIndex {
    private cells = new Map<string, EdgeRec[]>();
    constructor(recs: EdgeRec[], private cell = 150) {
      for (const r of recs) {
        const x0 = Math.floor(Math.min(r.ax.x, r.bx.x) / cell), x1 = Math.floor(Math.max(r.ax.x, r.bx.x) / cell);
        const y0 = Math.floor(Math.min(r.ax.y, r.bx.y) / cell), y1 = Math.floor(Math.max(r.ax.y, r.bx.y) / cell);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = `${x},${y}`; (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(r); }
      }
    }
    add(rec: EdgeRec): void {
      const x0 = Math.floor(Math.min(rec.ax.x, rec.bx.x) / this.cell), x1 = Math.floor(Math.max(rec.ax.x, rec.bx.x) / this.cell);
      const y0 = Math.floor(Math.min(rec.ax.y, rec.bx.y) / this.cell), y1 = Math.floor(Math.max(rec.ax.y, rec.bx.y) / this.cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = `${x},${y}`; (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(rec); }
    }
    near(p: XY, maxM: number): EdgeRec[] {
      const out = new Set<EdgeRec>();
      const x0 = Math.floor((p.x - maxM) / this.cell), x1 = Math.floor((p.x + maxM) / this.cell);
      const y0 = Math.floor((p.y - maxM) / this.cell), y1 = Math.floor((p.y + maxM) / this.cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const r of this.cells.get(`${x},${y}`) ?? []) out.add(r);
      return Array.from(out);
    }
    nearest(p: XY, maxM: number): { rec: EdgeRec; proj: ReturnType<typeof projOnSeg> } | null {
      let best: { rec: EdgeRec; proj: ReturnType<typeof projOnSeg> } | null = null;
      for (const rec of this.near(p, maxM)) {
        if (rec.a.edges.every(e => e.to !== rec.b.id)) continue;   // removed by a split
        const pr = projOnSeg(p, rec.ax, rec.bx);
        if (pr.d <= maxM && (!best || pr.d < best.proj.d)) best = { rec, proj: pr };
      }
      return best;
    }
  }
  /** Split a–b at p and register the two new edges with the index. */
  const splitIndexed = (idx: EdgeIndex, a: OsmNode, b: OsmNode, p: LngLat): OsmNode => {
    const mid = splitEdge(a, b, p);
    if (mid.id !== a.id && mid.id !== b.id) {
      const e1 = a.edges.find(x => x.to === mid.id), e2 = mid.edges.find(x => x.to === b.id);
      if (e1) idx.add({ a, b: mid, ax: xyOf(a), bx: xyOf(mid), e: e1 });
      if (e2) idx.add({ a: mid, b, ax: xyOf(mid), bx: xyOf(b), e: e2 });
    }
    return mid;
  };
  const nearestNodeBrute = (p: XY, maxM: number, pred?: (n: OsmNode) => boolean): OsmNode | null => {
    let best: OsmNode | null = null, bd = maxM;
    for (const n of nodes.values()) {
      if (pred && !pred(n)) continue;
      const q = xyOf(n); const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
  /** Snap a planar point onto the taxiway network: exact node ≤ snapM, else split the nearest edge ≤ edgeM, else nearest node ≤ nodeM. */
  const snapToTaxiway = (idx: EdgeIndex, p: XY, snapM: number, edgeM: number, nodeM: number): OsmNode | null => {
    const hit = idx.nearest(p, edgeM);
    if (hit) {
      const { rec, proj } = hit;
      const da = Math.hypot(proj.x - rec.ax.x, proj.y - rec.ax.y), db = Math.hypot(proj.x - rec.bx.x, proj.y - rec.bx.y);
      if (da <= snapM) return rec.a;
      if (db <= snapM) return rec.b;
      return splitIndexed(idx, rec.a, rec.b, frame.ll({ x: proj.x, y: proj.y }));
    }
    return nearestNodeBrute(p, nodeM, n => !isRunwayNode(n.id));
  };

  // ── 3. holding positions ──
  const holdingPositions: OsmHoldingPosition[] = [];
  const holdByNode = new Map<string, OsmHoldingPosition>();
  const rwGeom = new Map<string, { a: XY; b: XY; L: number; rw: OsmRunway }>();
  for (const rw of runways) { const a = xyOf(rw.ends[0]), b = xyOf(rw.ends[1]); rwGeom.set(rw.ref, { a, b, L: Math.hypot(b.x - a.x, b.y - a.y), rw }); }
  const perpToRunway = (ref: string, p: XY) => { const g = rwGeom.get(ref)!; return projOnSeg(p, g.a, g.b).d; };
  const alongRunway = (ref: string, p: XY) => { const g = rwGeom.get(ref)!; const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y; return ((p.x - g.a.x) * dx + (p.y - g.a.y) * dy) / (g.L || 1); };
  /** Runway refs reachable from a node along taxiway edges within maxM path metres (Dijkstra, stops at runway nodes). */
  const runwaysReachable = (startId: string, maxM: number): Map<string, number> => {
    const found = new Map<string, number>();
    const dist = new Map<string, number>([[startId, 0]]);
    const heap = new MinHeap();
    heap.push(startId, 0);
    while (heap.size) {
      const { id, key } = heap.pop()!;
      if (key > (dist.get(id) ?? Infinity)) continue;
      if (id !== startId && isRunwayNode(id)) { for (const r of runwayNodeRefs.get(id)!) if (!found.has(r)) found.set(r, key); continue; }
      const n = nodes.get(id)!;
      for (const e of n.edges) {
        if (e.type !== 'taxiway' || e.leadIn) continue;
        const nd = key + e.meters; if (nd > maxM || nd >= (dist.get(e.to) ?? Infinity)) continue;
        dist.set(e.to, nd); heap.push(e.to, nd);
      }
    }
    return found;
  };
  const taxiwayRefAt = (n: OsmNode): string | null => {
    const count = new Map<string, number>();
    for (const e of n.edges) if (e.taxiway) count.set(e.taxiway, (count.get(e.taxiway) ?? 0) + 1);
    let best: string | null = null, bc = 0;
    for (const [k, c] of count) if (c > bc) { bc = c; best = k; }
    return best;
  };
  const classifyHold = (h: OsmHoldingPosition) => {
    const n = nodes.get(h.nodeId)!; const p = xyOf(n);
    const reach = runwaysReachable(h.nodeId, HOLD_RWY_PATH_M);
    const refs: string[] = [];
    for (const [ref] of reach) { const d = perpToRunway(ref, p); if (d <= HOLD_RWY_DIST_M && d >= HOLD_RWY_MIN_M) refs.push(ref); }
    refs.sort((a, b) => perpToRunway(a, p) - perpToRunway(b, p));
    h.runwayRefs = refs;
    h.runwayEnds = refs.flatMap(r => rwByRef.get(r)!.ends.map(e => e.name));
    h.taxiwayRef = taxiwayRefAt(n);
    if (refs.length) {
      const ref = refs[0]; const g = rwGeom.get(ref)!;
      h.distToRunwayM = projOnSeg(p, g.a, g.b).d;
      const t = alongRunway(ref, p);
      h.nearestEnd = t < g.L / 2 ? g.rw.ends[0].name : g.rw.ends[1].name;
      h.entryEnd = t <= ENTRY_HOLD_M ? g.rw.ends[0].name : t >= g.L - ENTRY_HOLD_M ? g.rw.ends[1].name : null;
      if (h.kind !== 'synthetic') h.kind = 'runway';
    } else {
      h.distToRunwayM = Infinity; h.nearestEnd = null; h.entryEnd = null;
      if (h.kind !== 'synthetic') h.kind = 'taxiway';
    }
  };
  const addHold = (h: OsmHoldingPosition) => {
    if (holdByNode.has(h.nodeId)) {
      const ex = holdByNode.get(h.nodeId)!;
      if (!ex.ref && h.ref) ex.ref = h.ref;
      if (!ex.line && h.line) ex.line = h.line;
      return ex;
    }
    classifyHold(h);
    holdingPositions.push(h); holdByNode.set(h.nodeId, h);
    return h;
  };

  {
    const idx = new EdgeIndex(collectTaxiEdges());
    for (const f of features) {
      if (aerowayOf(f) !== 'holding_position') continue;
      const gt = geomType(f);
      let target: OsmNode | null = null;
      let line: LngLat[] | null = null;
      if (gt === 'Point') {
        const [lng, lat] = f.geometry!.coordinates as [number, number];
        const exact = nodes.get(keyOf(lng, lat));
        target = exact && !isRunwayNode(exact.id) ? exact : snapToTaxiway(idx, frame.xy(lng, lat), HOLD_SNAP_M, 15, 40);
      } else if (gt === 'LineString') {
        const cs = coordsOf(f); if (cs.length < 2) continue;
        line = cs.map(c => ({ lng: c[0], lat: c[1] }));
        const pts = cs.map(c => frame.xy(c[0], c[1]));
        // the hold point is where the drawn hold line crosses the taxiway centreline
        let hit: { rec: EdgeRec; p: XY } | null = null;
        const mid = pts[Math.floor(pts.length / 2)];
        for (const rec of idx.near(mid, 120)) {
          if (rec.a.edges.every(e => e.to !== rec.b.id)) continue;
          for (let i = 0; i < pts.length - 1 && !hit; i++) { const x = segIntersect(pts[i], pts[i + 1], rec.ax, rec.bx); if (x) hit = { rec, p: x }; }
          if (hit) break;
        }
        if (hit) {
          const { rec, p } = hit;
          const da = Math.hypot(p.x - rec.ax.x, p.y - rec.ax.y), db = Math.hypot(p.x - rec.bx.x, p.y - rec.bx.y);
          target = da <= HOLD_SNAP_M ? rec.a : db <= HOLD_SNAP_M ? rec.b : splitIndexed(idx, rec.a, rec.b, frame.ll(p));
        } else {
          target = snapToTaxiway(idx, mid, HOLD_SNAP_M, 40, 40);
        }
      }
      if (!target || isRunwayNode(target.id)) continue;
      addHold({ id: `H${idOf(f) ?? holdingPositions.length}`, nodeId: target.id, lng: target.lng, lat: target.lat, ref: refOf(f), runwayRefs: [], runwayEnds: [], entryEnd: null, nearestEnd: null, taxiwayRef: null, distToRunwayM: Infinity, kind: 'taxiway', source: 'osm', line });
    }
  }

  // synthesized holds: every taxiway leaving a runway centreline node gets a hold ≈75 m out unless OSM marked
  // one on that chain (looking out to 220 m from the centreline, through degree-2 nodes only)
  {
    let synth = 0;
    const mkSynth = (target: OsmNode) => addHold({ id: `HS${++synth}`, nodeId: target.id, lng: target.lng, lat: target.lat, ref: null, runwayRefs: [], runwayEnds: [], entryEnd: null, nearestEnd: null, taxiwayRef: null, distToRunwayM: Infinity, kind: 'synthetic', source: 'synthesized', line: null });
    for (const rw of runways) {
      const g = rwGeom.get(rw.ref)!;
      const perp = (n: OsmNode) => projOnSeg(xyOf(n), g.a, g.b).d;
      for (const rid of rw.nodeIds) {
        const rn = nodes.get(rid); if (!rn) continue;
        for (const e0 of rn.edges.slice()) {
          if (e0.type !== 'taxiway' || e0.leadIn || isRunwayNode(e0.to)) continue;
          // pass 1: walk the degree-2 chain out to 220 m looking for an OSM hold that protects this runway
          const chain: OsmNode[] = [rn];
          let prev = rn, cur = nodes.get(e0.to)!, guard = 0, hasOsm = false, branchAt = -1;
          while (cur && guard++ < 80) {
            chain.push(cur);
            const h = holdByNode.get(cur.id);
            if (h && h.source === 'osm' && h.runwayRefs.includes(rw.ref)) { hasOsm = true; break; }
            if (perp(cur) >= 220) break;
            const next = cur.edges.filter(e => e.type === 'taxiway' && !e.leadIn && e.to !== prev.id);
            if (next.length !== 1 || isRunwayNode(cur.id)) { branchAt = chain.length - 1; break; }
            prev = cur; cur = nodes.get(next[0].to)!;
          }
          if (hasOsm) continue;
          // pass 2: place a hold where the chain first reaches SYNTH_HOLD_M from the centreline
          let placed = false;
          const limit = branchAt >= 0 ? branchAt : chain.length - 1;
          for (let i = 1; i <= limit; i++) {
            const a = chain[i - 1], b = chain[i];
            const dA = perp(a), dB = perp(b);
            if (dB < SYNTH_HOLD_M) continue;
            const span = dB - dA;
            const frac = span > 0 ? Math.max(0, Math.min(1, (SYNTH_HOLD_M - dA) / span)) : 1;
            const pa = xyOf(a), pb = xyOf(b);
            const p = { x: pa.x + (pb.x - pa.x) * frac, y: pa.y + (pb.y - pa.y) * frac };
            const dToB = Math.hypot(pb.x - p.x, pb.y - p.y), dToA = Math.hypot(pa.x - p.x, pa.y - p.y);
            let target: OsmNode | null;
            if (dToB <= 12 && !isRunwayNode(b.id)) target = b;
            else if (dToA <= 12 && !isRunwayNode(a.id)) target = a;
            else target = splitEdge(a, b, frame.ll(p));
            if (target && !isRunwayNode(target.id)) { mkSynth(target); placed = true; }
            break;
          }
          if (!placed) {
            // the chain branches / dead-ends before 75 m: hold at the last node ≥ 35 m out, else the branch node itself
            const cands = chain.slice(1, limit + 1).filter(n => !isRunwayNode(n.id));
            const far = cands.filter(n => perp(n) >= 35);
            const target = far.length ? far[far.length - 1] : cands[cands.length - 1];
            if (target) mkSynth(target);
          }
        }
      }
    }
  }
  // holds that were classified before a later split/synth may need the runway association re-checked
  for (const h of holdingPositions) if (h.source === 'synthesized' && !h.runwayRefs.length) classifyHold(h);
  for (const rw of runways) for (const end of rw.ends) {
    const ex = xyOf(end);
    end.holdNodeIds = holdingPositions
      .filter(h => h.entryEnd === end.name)
      .sort((a, b) => { const pa = xyOf(a), pb = xyOf(b); return Math.hypot(pa.x - ex.x, pa.y - ex.y) - Math.hypot(pb.x - ex.x, pb.y - ex.y); })
      .map(h => h.nodeId);
  }

  // ── 4. buildings ──
  const buildings: OsmBuilding[] = [];
  for (const f of features) {
    const aw = aerowayOf(f);
    if (aw !== 'terminal' && aw !== 'hangar' && aw !== 'apron') continue;
    const gt = geomType(f);
    const rings: [number, number][][] = gt === 'Polygon' ? [(f.geometry!.coordinates as [number, number][][])[0]]
      : gt === 'MultiPolygon' ? (f.geometry!.coordinates as [number, number][][][]).map(p => p[0]) : [];
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      const poly = ring.map(c => ({ lng: c[0], lat: c[1] }));
      const pts = poly.map(p => frame.xy(p.lng, p.lat));
      const c = polyCentroid(pts);
      buildings.push({ kind: aw, name: nameOf(f), polygon: poly, centroid: frame.ll(c), areaM2: polyArea(pts), osmId: idOf(f) });
    }
  }
  const terminalPolys = buildings.filter(b => b.kind === 'terminal').map(b => ({ b, pts: b.polygon.map(p => frame.xy(p.lng, p.lat)) }));
  const apronPolys = buildings.filter(b => b.kind === 'apron').map(b => ({ b, pts: b.polygon.map(p => frame.xy(p.lng, p.lat)) }));

  // ── 5. stands ──
  const stands: OsmStand[] = [];
  {
    const idx = new EdgeIndex(collectTaxiEdges());
    interface Cand { ref: string | null; osmId: number | null; stop: XY; stopLL: LngLat; entryLL: LngLat | null; pts: LngLat[]; isGate: boolean; }
    const cands: Cand[] = [];
    for (const f of features) {
      if (aerowayOf(f) !== 'parking_position') continue;
      const gt = geomType(f);
      if (gt === 'LineString') {
        const cs = coordsOf(f); if (cs.length < 2) continue;
        const pts = cs.map(c => frame.xy(c[0], c[1]));
        const dFirst = idx.nearest(pts[0], 200)?.proj.d ?? Infinity;
        const dLast = idx.nearest(pts[pts.length - 1], 200)?.proj.d ?? Infinity;
        const ordered = dFirst <= dLast ? cs : cs.slice().reverse();
        const stop = ordered[ordered.length - 1], entry = ordered[0];
        if (meters(stop[0], stop[1], entry[0], entry[1]) < 3) continue;
        cands.push({ ref: refOf(f), osmId: idOf(f), stop: frame.xy(stop[0], stop[1]), stopLL: { lng: stop[0], lat: stop[1] }, entryLL: { lng: entry[0], lat: entry[1] }, pts: ordered.map(c => ({ lng: c[0], lat: c[1] })), isGate: false });
      } else if (gt === 'Point') {
        const [lng, lat] = f.geometry!.coordinates as [number, number];
        cands.push({ ref: refOf(f), osmId: idOf(f), stop: frame.xy(lng, lat), stopLL: { lng, lat }, entryLL: null, pts: [], isGate: false });
      }
    }
    // gates: merge into a stand within 30 m, else become stands themselves
    for (const f of features) {
      if (aerowayOf(f) !== 'gate' || geomType(f) !== 'Point') continue;
      const [lng, lat] = f.geometry!.coordinates as [number, number];
      const p = frame.xy(lng, lat);
      let best: Cand | null = null, bd = 30;
      for (const c of cands) { const d = Math.hypot(c.stop.x - p.x, c.stop.y - p.y); if (d < bd) { bd = d; best = c; } }
      if (best) { best.isGate = true; if (!best.ref) best.ref = refOf(f); continue; }
      // a gate point at the terminal door (inside the outline or within 15 m of it) is not a stop position: attach it to
      // the parking position with the same ref when there is one nearby, otherwise it is not a stand at all
      if (terminalPolys.some(t => pointInPoly(p, t.pts) || distToPolyEdge(p, t.pts) < 15)) {
        const ref = refOf(f) ? String(refOf(f)).trim() : '';
        const same = ref ? cands.find(c => c.ref && String(c.ref).trim() === ref && Math.hypot(c.stop.x - p.x, c.stop.y - p.y) < 150) : undefined;
        if (same) same.isGate = true;
        continue;
      }
      cands.push({ ref: refOf(f), osmId: idOf(f), stop: p, stopLL: { lng, lat }, entryLL: null, pts: [], isGate: true });
    }
    // Unnamed parking_position ways that branch off a named stand's lead-in are that stand's lead-OUT / alternate
    // lead-in markings (SFO's mapper drew the curved exit arcs as parking_position too): they are not stands. Same for
    // an unnamed way with both ends on the taxiway network - a connector between taxilanes, not a stop.
    const distToPath = (p: XY, path: XY[]) => { let d = Infinity; for (let i = 1; i < path.length; i++) d = Math.min(d, projOnSeg(p, path[i - 1], path[i]).d); return d; };
    const namedPaths = cands.filter(c => c.ref && c.pts.length >= 2).map(c => c.pts.map(q => frame.xy(q.lng, q.lat)));
    const branch = (c: Cand) => {
      if (c.ref || c.pts.length < 2) return false;
      const ends = [frame.xy(c.pts[0].lng, c.pts[0].lat), c.stop];
      if (namedPaths.some(path => ends.some(e => distToPath(e, path) < 3))) return true;
      const dEntry = idx.nearest(ends[0], 200)?.proj.d ?? Infinity, dStop = idx.nearest(ends[1], 200)?.proj.d ?? Infinity;
      return dEntry < 12 && dStop < 12;
    };
    // dedupe candidates that share a stop position (< 12 m — no two stands are closer than that)
    const uniq: Cand[] = [];
    for (const c of cands) {
      if (branch(c)) continue;
      const dup = uniq.find(u => Math.hypot(u.stop.x - c.stop.x, u.stop.y - c.stop.y) < 12);
      if (dup) { if (!dup.ref && c.ref) dup.ref = c.ref; dup.isGate = dup.isGate || c.isGate; if (!dup.entryLL && c.entryLL) { dup.entryLL = c.entryLL; dup.pts = c.pts; } continue; }
      uniq.push(c);
    }
    // A stop position drawn right up against the terminal outline is a data error (the nose overhangs the nose wheel by
    // 5-9 m): pull it back along the lead-in so the nose wheel stops NOSE_CLEAR_M from the building.
    for (const c of uniq) {
      if (c.pts.length < 2) continue;
      let d = Infinity;   // signed: negative when the stop is inside the outline
      for (const t of terminalPolys) { const dd = pointInPoly(c.stop, t.pts) ? -distToPolyEdge(c.stop, t.pts) : distToPolyEdge(c.stop, t.pts); if (dd < d) d = dd; }
      if (d >= NOSE_CLEAR_M) continue;
      const prev = frame.xy(c.pts[c.pts.length - 2].lng, c.pts[c.pts.length - 2].lat);
      const seg = Math.hypot(c.stop.x - prev.x, c.stop.y - prev.y); if (seg < 4) continue;
      const back = Math.min(NOSE_CLEAR_M - d, seg - 3);
      const stop = { x: c.stop.x - (c.stop.x - prev.x) / seg * back, y: c.stop.y - (c.stop.y - prev.y) / seg * back };
      c.stop = stop; c.stopLL = frame.ll(stop); c.pts[c.pts.length - 1] = c.stopLL;
    }
    const usedRefs = new Map<string, number>();
    const realRefs = new Set(uniq.map(c => (c.ref ? String(c.ref).trim() : '')).filter(Boolean));
    for (const c of uniq) {
      // entry point on the taxiway network
      let entryNode: OsmNode | null = null;
      let leadPts: LngLat[] = [];
      if (c.entryLL) {
        const ep = frame.xy(c.entryLL.lng, c.entryLL.lat);
        const exact = nodes.get(keyOf(c.entryLL.lng, c.entryLL.lat));
        entryNode = exact && !isRunwayNode(exact.id) ? exact : snapToTaxiway(idx, ep, HOLD_SNAP_M, 45, 120);
        leadPts = c.pts.slice();
      } else {
        entryNode = snapToTaxiway(idx, c.stop, HOLD_SNAP_M, 120, 160);
        if (entryNode) leadPts = [{ lng: entryNode.lng, lat: entryNode.lat }, c.stopLL];
      }
      if (!entryNode) continue;
      if (leadPts.length && meters(leadPts[0].lng, leadPts[0].lat, entryNode.lng, entryNode.lat) > 1) leadPts.unshift({ lng: entryNode.lng, lat: entryNode.lat });
      // build the lead-in chain: entry → … → stand leaf
      let prev = entryNode;
      for (let i = 1; i < leadPts.length; i++) {
        const n = node(leadPts[i].lng, leadPts[i].lat);
        if (n.id === prev.id) continue;
        link(prev, n, 'taxiway', { leadIn: true });
        prev = n;
      }
      const standNode = prev.id === entryNode.id ? entryNode : prev;
      const entryXY = xyOf(entryNode), stopXY = xyOf(standNode);
      let headingIn: number;
      if (Math.hypot(stopXY.x - entryXY.x, stopXY.y - entryXY.y) >= 3) {
        // heading of the final lead-in segment (what the aircraft is pointing at when it stops)
        const n2 = leadPts.length >= 2 ? leadPts[leadPts.length - 2] : { lng: entryNode.lng, lat: entryNode.lat };
        headingIn = bearingDeg(n2.lng, n2.lat, standNode.lng, standNode.lat);
      } else {
        // stand drawn on the taxilane itself: face away from the taxiway, toward the nearest terminal when there is one
        const hit = idx.nearest(c.stop, 60);
        const edgeBrg = hit ? bearingDeg(hit.rec.a.lng, hit.rec.a.lat, hit.rec.b.lng, hit.rec.b.lat) : 0;
        let tBrg: number | null = null, td = 400;
        for (const t of terminalPolys) { const cc = polyCentroid(t.pts); const d = Math.hypot(cc.x - c.stop.x, cc.y - c.stop.y); if (d < td) { td = d; const ll = frame.ll(cc); tBrg = bearingDeg(c.stopLL.lng, c.stopLL.lat, ll.lng, ll.lat); } }
        const perpA = (edgeBrg + 90) % 360, perpB = (edgeBrg + 270) % 360;
        headingIn = tBrg == null ? perpA : (angDiff(perpA, tBrg) <= angDiff(perpB, tBrg) ? perpA : perpB);
      }
      // ref: OSM ref, else a short readable synthesized one (R01, R02, … — the OSM id would print as "S626510130"); keep unique
      let ref = c.ref ? String(c.ref).trim() : '';
      if (!ref) { let n = 1; while (usedRefs.has(`R${String(n).padStart(2, '0')}`) || realRefs.has(`R${String(n).padStart(2, '0')}`)) n++; ref = `R${String(n).padStart(2, '0')}`; }
      if (usedRefs.has(ref)) { const n = usedRefs.get(ref)! + 1; usedRefs.set(ref, n); ref = `${ref}#${n}`; } else usedRefs.set(ref, 1);
      // terminal + type
      let terminal: string | undefined, tdist = Infinity;
      for (const t of terminalPolys) {
        const d = pointInPoly(c.stop, t.pts) ? 0 : distToPolyEdge(c.stop, t.pts);
        if (d < tdist) { tdist = d; terminal = t.b.name ?? undefined; }
      }
      const type: StandType = c.isGate || tdist <= 70 ? 'gate' : tdist <= 250 ? 'stand' : 'remote';
      stands.push({
        ref, lng: standNode.lng, lat: standNode.lat, nodeId: standNode.id, entryNodeId: entryNode.id,
        leadIn: leadPts.length >= 2 ? { from: { lng: entryNode.lng, lat: entryNode.lat }, to: { lng: standNode.lng, lat: standNode.lat } } : null,
        leadInPts: leadPts.length >= 2 ? leadPts : [{ lng: standNode.lng, lat: standNode.lat }, { lng: standNode.lng, lat: standNode.lat }],
        headingIn, heading: headingIn, pushbackHeading: (headingIn + 180) % 360, type, size: 'C', terminal: tdist <= 300 ? terminal : undefined,
        osmId: c.osmId, sizeSource: 'default', hasLeadIn: !!c.entryLL, needsPushback: true, closed: false,
      });
    }
    // sizes: ref hints > stand spacing > lead-in length > default C
    const stXY = stands.map(s => frame.xy(s.lng, s.lat));
    const refSet = new Set(stands.map(s => s.ref));
    const sizeFromSpacing = (d: number): StandSize => d < 32 ? 'B' : d < 46 ? 'C' : d < 60 ? 'D' : d < 76 ? 'E' : 'F';
    for (let i = 0; i < stands.length; i++) {
      const s = stands[i];
      if (/A380|\bF$/i.test(s.ref)) { s.size = 'F'; s.sizeSource = 'ref'; continue; }
      const mLR = s.ref.match(/^(\d+)[LR]$/);
      if (mLR) { s.size = 'C'; s.sizeSource = 'ref'; continue; }
      if (/^\d+$/.test(s.ref) && refSet.has(`${s.ref}L`) && refSet.has(`${s.ref}R`)) { s.size = 'E'; s.sizeSource = 'ref'; }
      let nd = Infinity;
      for (let j = 0; j < stands.length; j++) { if (j === i) continue; const d = Math.hypot(stXY[j].x - stXY[i].x, stXY[j].y - stXY[i].y); if (d < nd) nd = d; }
      if (nd < 120) {
        const sz = sizeFromSpacing(nd);
        if (s.sizeSource === 'ref') { if (sz > s.size) s.size = sz; continue; }
        s.size = sz; s.sizeSource = 'spacing';
      } else if (s.sizeSource !== 'ref') {
        const L = s.leadIn ? meters(s.leadIn.from.lng, s.leadIn.from.lat, s.leadIn.to.lng, s.leadIn.to.lat) : 0;
        if (L >= 90) { s.size = 'E'; s.sizeSource = 'leadin'; }
      }
    }
    for (const s of stands) s.needsPushback = !(s.type === 'remote' && (s.size === 'A' || s.size === 'B'));
    stands.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  }
  const gates: OsmGate[] = stands.map(s => ({ ref: s.ref, lng: s.lng, lat: s.lat, nodeId: s.nodeId }));

  // ── 6. service stations ──
  const allNodeXY = Array.from(nodes.values()).map(n => ({ n, p: xyOf(n) }));
  const nearestNodeId = (ll: LngLat, maxM = 2000, pred?: (n: OsmNode) => boolean): string | null => {
    const p = frame.xy(ll.lng, ll.lat);
    let best: string | null = null, bd = maxM;
    for (const { n, p: q } of allNodeXY) { if (pred && !pred(n)) continue; const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = n.id; } }
    return best;
  };
  const onAirport = (ll: LngLat, maxM: number) => nearestNodeId(ll, maxM) != null;
  const mkStation = (ll: LngLat, name: string | null, source: OsmStation['source']): OsmStation => ({ lat: ll.lat, lng: ll.lng, name, source, nodeId: nearestNodeId(ll, 5000, n => !isRunwayNode(n.id)) });
  const rwCentroid = (() => {
    if (!runways.length) return frame.xy(center.lng, center.lat);
    let sx = 0, sy = 0; for (const rw of runways) for (const e of rw.ends) { const p = xyOf(e); sx += p.x; sy += p.y; }
    return { x: sx / (runways.length * 2), y: sy / (runways.length * 2) };
  })();
  const longest = runways[0] ?? null;
  const longestMid: XY = longest ? (() => { const a = xyOf(longest.ends[0]), b = xyOf(longest.ends[1]); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; })() : rwCentroid;

  // supplemental features (scripts/fetch_osm_airports.py --supplement): amenity=fire_station, storage tanks, aeroway=fuel
  const supp = features.filter(f => geomType(f) === 'Point' && prop(f, 'supplement') === true);
  const ptOf = (f: Feature): LngLat => { const [lng, lat] = f.geometry!.coordinates as [number, number]; return { lng, lat }; };
  const fireCands = supp
    .filter(f => prop(f, 'amenity') === 'fire_station' || prop(f, 'emergency') === 'fire_station')
    .filter(f => !/training|marine|boathouse|volunteer/i.test(nameOf(f) ?? ''))
    .filter(f => onAirport(ptOf(f), 450))
    .filter(f => { const p = frame.xy(ptOf(f).lng, ptOf(f).lat); return Math.hypot(p.x - rwCentroid.x, p.y - rwCentroid.y) <= 3500; })
    .map(f => {
      const ll = ptOf(f); const p = frame.xy(ll.lng, ll.lat);
      const nm = nameOf(f) ?? ''; const op = String(prop(f, 'operator') ?? '');
      const score = (/airport|aerodrome|arff|rescue|fire hq|massport|sfo fire|heathrow airport/i.test(nm + ' ' + op) ? 2 : 0)
        + (/\bhq\b|headquarters/i.test(nm) ? 1 : 0)
        - Math.hypot(p.x - rwCentroid.x, p.y - rwCentroid.y) / 3000;
      return { ll, nm, score };
    })
    .sort((a, b) => b.score - a.score);
  let arffAll: OsmStation[] = [];
  for (const c of fireCands) {   // node + building outline of the same station are both tagged in OSM: keep one
    if (arffAll.some(a => meters(a.lng, a.lat, c.ll.lng, c.ll.lat) < 80)) continue;
    arffAll.push(mkStation(c.ll, c.nm, 'osm'));
  }
  if (!arffAll.length) {
    // inferred: among the largest aprons, the one whose centroid is nearest the longest runway's mid-point
    const big = apronPolys.slice().sort((a, b) => b.b.areaM2 - a.b.areaM2).slice(0, 5);
    let pick: LngLat | null = null, bd = Infinity;
    for (const a of big) { const c = polyCentroid(a.pts); const d = Math.hypot(c.x - longestMid.x, c.y - longestMid.y); if (d < bd) { bd = d; pick = a.b.centroid; } }
    if (!pick) { const id = nearestNodeId(frame.ll(longestMid), 5000, n => !isRunwayNode(n.id)); const n = id ? nodes.get(id)! : null; pick = n ? { lng: n.lng, lat: n.lat } : center; }
    arffAll = [mkStation(pick, 'ARFF (inferred)', 'inferred')];
    warn(`${icao}: no on-airport fire station in OSM data; ARFF station inferred`);
  }
  const arff = arffAll[0];
  // tug depot: apron polygon holding the most stands (its centroid), else mean of stands
  const standXY = stands.map(s => frame.xy(s.lng, s.lat));
  let tugDepot: OsmStation;
  {
    let best: { b: OsmBuilding; pts: XY[] } | null = null, bc = 0;
    for (const a of apronPolys) { let c = 0; for (const p of standXY) if (pointInPoly(p, a.pts)) c++; if (c > bc) { bc = c; best = a; } }
    if (best) tugDepot = mkStation(best.b.centroid, best.b.name ? `Tug pool (${best.b.name})` : 'Tug pool', 'inferred');
    else if (standXY.length) { let sx = 0, sy = 0; for (const p of standXY) { sx += p.x; sy += p.y; } tugDepot = mkStation(frame.ll({ x: sx / standXY.length, y: sy / standXY.length }), 'Tug pool', 'inferred'); }
    else tugDepot = mkStation(center, 'Tug pool', 'inferred');
  }
  // ops / follow-me base: the apron nearest the runway-system centroid that is not the tug apron, else the fire station
  let ops: OsmStation;
  {
    let pick: OsmBuilding | null = null, bd = Infinity;
    for (const a of apronPolys) {
      if (a.b.areaM2 < 2000) continue;
      const c = polyCentroid(a.pts); const d = Math.hypot(c.x - rwCentroid.x, c.y - rwCentroid.y);
      if (tugDepot.name && a.b.name && tugDepot.name.includes(a.b.name)) continue;
      if (d < bd) { bd = d; pick = a.b; }
    }
    ops = pick ? mkStation(pick.centroid, pick.name ? `Ops (${pick.name})` : 'Ops', 'inferred') : { ...arff, name: 'Ops (fire station)', source: 'inferred' };
  }
  // fuel farm: storage-tank cluster (supplement) nearest the airport, else the largest hangar, else ops
  let fuelFarm: OsmStation;
  {
    // storage tanks within 600 m of the movement area, single-linkage clustered (150 m); the biggest cluster is the farm
    const tanks = supp.filter(f => prop(f, 'man_made') === 'storage_tank' || prop(f, 'aeroway') === 'fuel').map(ptOf).filter(ll => onAirport(ll, 600)).map(ll => frame.xy(ll.lng, ll.lat));
    if (tanks.length) {
      const label = new Array<number>(tanks.length).fill(-1); let nClusters = 0;
      for (let i = 0; i < tanks.length; i++) {
        if (label[i] >= 0) continue;
        const stack = [i]; label[i] = nClusters;
        while (stack.length) { const a = stack.pop()!; for (let b = 0; b < tanks.length; b++) if (label[b] < 0 && Math.hypot(tanks[a].x - tanks[b].x, tanks[a].y - tanks[b].y) <= 150) { label[b] = nClusters; stack.push(b); } }
        nClusters++;
      }
      const counts = new Array<number>(nClusters).fill(0); for (const l of label) counts[l]++;
      const best = counts.indexOf(Math.max(...counts));
      let sx = 0, sy = 0, n = 0; tanks.forEach((t, i) => { if (label[i] === best) { sx += t.x; sy += t.y; n++; } });
      fuelFarm = mkStation(frame.ll({ x: sx / n, y: sy / n }), `Fuel farm (${n} tanks)`, 'osm');
    } else {
      const hang = buildings.filter(b => b.kind === 'hangar').sort((a, b) => b.areaM2 - a.areaM2)[0];
      fuelFarm = hang ? mkStation(hang.centroid, `Fuel farm (near ${hang.name ?? 'hangar'})`, 'inferred') : { ...ops, name: 'Fuel farm (ops)', source: 'inferred' };
    }
  }
  // de-ice pads: one per end of the longest runway, on the taxiway ≈one node back from the entry hold
  const deice: Array<OsmStation & { ref: string }> = [];
  if (longest) {
    longest.ends.forEach((end, i) => {
      const hid = end.holdNodeIds[0];
      let ll: LngLat | null = null;
      if (hid) {
        const h = nodes.get(hid)!;
        const g = rwGeom.get(longest.ref)!;
        // step away from the runway along taxiway edges until ≥ 220 m from the centreline
        let prev: OsmNode | null = null, cur: OsmNode = h, guard = 0;
        while (guard++ < 30) {
          const nxt = cur.edges.filter(e => e.type === 'taxiway' && !e.leadIn && (!prev || e.to !== prev.id) && !isRunwayNode(e.to)).map(e => nodes.get(e.to)!)
            .sort((a, b) => projOnSeg(xyOf(b), g.a, g.b).d - projOnSeg(xyOf(a), g.a, g.b).d)[0];
          if (!nxt) break;
          prev = cur; cur = nxt;
          if (projOnSeg(xyOf(cur), g.a, g.b).d >= 220) break;
        }
        ll = { lng: cur.lng, lat: cur.lat };
      }
      if (!ll) ll = advanceLL({ lng: end.lng, lat: end.lat }, (end.trueHdg + 90) % 360, 300);
      deice.push({ ...mkStation(ll, `De-ice pad ${i + 1} (RWY ${end.name})`, 'inferred'), ref: `DP${i + 1}` });
    });
  }
  // ARFF standby points: abeam touchdown zone of each end + abeam the mid-point, on the fire-station side
  const arffStandby: OsmArffStandby[] = [];
  {
    const fp = frame.xy(arff.lng, arff.lat);
    for (const rw of runways) {
      const a = xyOf(rw.ends[0]), b = xyOf(rw.ends[1]);
      const ux = (b.x - a.x) / (rw.lengthM || 1), uy = (b.y - a.y) / (rw.lengthM || 1);
      const side = ((fp.x - a.x) * -uy + (fp.y - a.y) * ux) >= 0 ? 1 : -1;   // +1 = left of ends[0]→ends[1]
      const off = (p: XY) => ({ x: p.x + (-uy) * 90 * side, y: p.y + ux * 90 * side });
      const mid = off({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      rw.ends.forEach((end, i) => {
        const from = i === 0 ? a : b; const dir = i === 0 ? 1 : -1;
        const tdz = off({ x: from.x + ux * 300 * dir, y: from.y + uy * 300 * dir });
        const tdzLL = frame.ll(tdz), midLL = frame.ll(mid);
        arffStandby.push({ runway: rw.ref, end: end.name, touchdown: tdzLL, midpoint: midLL, touchdownNodeId: nearestNodeId(tdzLL, 400, n => !isRunwayNode(n.id)), midpointNodeId: nearestNodeId(midLL, 400, n => !isRunwayNode(n.id)) });
      });
    }
  }
  const stations: OsmStations = { arff, arffAll, ambulance: { ...arff }, tugDepot, followMeBase: { ...ops }, ops, fuelFarm, deice, arffStandby };

  // ── finish ──
  const twNodes = new Map<string, string[]>();
  for (const [name, set] of taxiwayNodes) twNodes.set(name, Array.from(set));
  const taxiwayNames = Array.from(twNodes.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!runways.length) warn(`${icao}: no named runways found in OSM data`);
  if (!opts.quiet && warnings.length && !warnedAirports.has(icao)) {
    warnedAirports.add(icao);
    for (const w of warnings) console.warn(`[osmAirport] ${w}`);
  }
  return { icao, center, magVar, nodes, gates, stands, runways, holdingPositions, holdByNode, buildings, stations, taxiwayNames, taxiwayNodes: twNodes, warnings };
}
const warnedAirports = new Set<string>();

// ── lookups ─────────────────────────────────────────────────
/** Stand by ref (exact, then case-insensitive). */
export function standByRef(air: OsmAirport, ref: string): OsmStand | null {
  return air.stands.find(s => s.ref === ref) ?? air.stands.find(s => s.ref.toUpperCase() === ref.toUpperCase()) ?? null;
}

/** Station positions keyed the way `VehicleFleet.init(air, stations)` expects (lat/lng; the engine projects to XY). */
export function vehicleStationsLL(air: OsmAirport): Record<'fire' | 'ops' | 'tugPool' | 'fuelFarm' | 'deicePad' | 'apron', LngLat> {
  const S = air.stations;
  const ll = (s: OsmStation): LngLat => ({ lng: s.lng, lat: s.lat });
  return { fire: ll(S.arff), ops: ll(S.ops), tugPool: ll(S.tugDepot), fuelFarm: ll(S.fuelFarm), deicePad: ll(S.deice[0] ?? S.ops), apron: ll(S.tugDepot) };
}

export function runwayEndByName(air: OsmAirport, name: string): { rw: OsmRunway; end: OsmRunwayEnd; other: OsmRunwayEnd } | null {
  const N = name.toUpperCase();
  for (const rw of air.runways) {
    const end = rw.ends.find(e => e.name.toUpperCase() === N);
    if (end) return { rw, end, other: rw.ends.find(e => e !== end)! };
  }
  return null;
}

/** Physical runway for a ref ('09R/27L') or an end name ('27L'). */
export function runwayFor(air: OsmAirport, refOrEnd: string): OsmRunway | null {
  const R2 = refOrEnd.toUpperCase();
  return air.runways.find(r => r.ref.toUpperCase() === R2) ?? runwayEndByName(air, refOrEnd)?.rw ?? null;
}

/** Physical runway refs a node lies on (centreline nodes only). */
export function runwayRefsAtNode(air: OsmAirport, nodeId: string): string[] {
  const n = air.nodes.get(nodeId); if (!n) return [];
  const refs = new Set<string>();
  for (const e of n.edges) if (e.type === 'runway' && e.runway) refs.add(e.runway);
  return Array.from(refs);
}

export function isHoldNodeForRunway(air: OsmAirport, nodeId: string, runway: string): boolean {
  const h = air.holdByNode.get(nodeId); if (!h) return false;
  const rw = runwayFor(air, runway); if (!rw) return false;
  return h.runwayRefs.includes(rw.ref);
}

// ── nearest node (grid index cached per airport) ────────────
interface Grid { cell: number; kx: number; ky: number; c: LngLat; cells: Map<string, OsmNode[]>; }
const gridCache = new WeakMap<OsmAirport, Grid>();
function gridFor(air: OsmAirport): Grid {
  let g = gridCache.get(air);
  if (g) return g;
  const c = air.center; const kx = R * Math.cos(c.lat * D2R) * D2R, ky = R * D2R;
  g = { cell: 120, kx, ky, c, cells: new Map() };
  for (const n of air.nodes.values()) {
    const k = `${Math.floor((n.lng - c.lng) * kx / g.cell)},${Math.floor((n.lat - c.lat) * ky / g.cell)}`;
    (g.cells.get(k) ?? g.cells.set(k, []).get(k)!).push(n);
  }
  gridCache.set(air, g);
  return g;
}

/** Nearest graph node to a lng/lat within maxM (default 120 m); optional predicate. */
export function nearestOsmNode(air: OsmAirport, lng: number, lat: number, maxM = 120, pred?: (n: OsmNode) => boolean): OsmNode | null {
  const g = gridFor(air);
  const px = (lng - g.c.lng) * g.kx, py = (lat - g.c.lat) * g.ky;
  const x0 = Math.floor((px - maxM) / g.cell), x1 = Math.floor((px + maxM) / g.cell);
  const y0 = Math.floor((py - maxM) / g.cell), y1 = Math.floor((py + maxM) / g.cell);
  let best: OsmNode | null = null, bd = maxM;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const n of g.cells.get(`${x},${y}`) ?? []) {
    if (pred && !pred(n)) continue;
    const d = Math.hypot((n.lng - g.c.lng) * g.kx - px, (n.lat - g.c.lat) * g.ky - py);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

// ── path helpers ────────────────────────────────────────────
/** Sequence of taxiway designators a node-id path traverses (consecutive dupes collapsed), e.g. ["A","B","K"]. */
export function taxiwaysForPath(air: OsmAirport, ids: string[]): string[] {
  const seq: string[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const n = air.nodes.get(ids[i]); if (!n) continue;
    const e = n.edges.find(x => x.to === ids[i + 1]);
    const name = e?.taxiway;
    if (name && seq[seq.length - 1] !== name) seq.push(name);
  }
  return seq;
}

/** Path length in metres along graph edges (straight-line between consecutive nodes when no edge exists). */
export function pathLengthM(air: OsmAirport, ids: string[]): number {
  let s = 0;
  for (let i = 0; i < ids.length - 1; i++) {
    const a = air.nodes.get(ids[i]), b = air.nodes.get(ids[i + 1]); if (!a || !b) continue;
    const e = a.edges.find(x => x.to === b.id);
    s += e ? e.meters : meters(a.lng, a.lat, b.lng, b.lat);
  }
  return s;
}

/**
 * Hold-short places along a node path, in path order. A hold is emitted when the
 * path continues onto the runway it protects (crossing or departure entry); only the
 * LAST hold before each runway entry is emitted (the one closest to the runway —
 * CAT II/III holds further back are not stops in CAT I conditions). When a path
 * enters a runway with no marked hold, the last taxiway node before the runway
 * edge is used. `at` is the arc-length along the raw node path (the engine
 * recomputes it on its resampled DrivePath).
 */
export function holdsOnPath(air: OsmAirport, ids: string[]): PathHold[] {
  const out: PathHold[] = [];
  if (ids.length < 1) return out;
  const cum: number[] = [0];
  for (let i = 0; i < ids.length - 1; i++) {
    const a = air.nodes.get(ids[i]), b = air.nodes.get(ids[i + 1]);
    const e = a?.edges.find(x => x.to === ids[i + 1]);
    cum.push(cum[i] + (e ? e.meters : (a && b ? meters(a.lng, a.lat, b.lng, b.lat) : 0)));
  }
  const onRw: string[][] = ids.map(id => runwayRefsAtNode(air, id));
  const lastIdx = ids.length - 1;
  let lastHoldIdx = -1;   // hold used for the most recent runway entry (reused for runway-to-runway transitions)
  for (let i = 1; i <= lastIdx; i++) {
    for (const ref of onRw[i]) {
      if (onRw[i - 1].includes(ref)) continue;                    // still on the same runway
      let j = i; while (j <= lastIdx && onRw[j].includes(ref)) j++;
      const isDepartureEntry = j > lastIdx;                       // the path ends on this runway
      const rw = runwayFor(air, ref);
      let holdIdx = -1;
      if (onRw[i - 1].length) {
        // runway-to-runway transition at an intersection: there is no hold line here. The previous
        // runway's hold already stops the aircraft; only a departure onto this runway needs its own
        // PathHold (same place) so the engine can ask for the line-up / take-off clearance.
        if (!isDepartureEntry || lastHoldIdx < 0) continue;
        holdIdx = lastHoldIdx;
      } else {
        // last marked hold for this runway on the path before node i (within 400 m back)
        for (let k = i - 1; k >= 0 && cum[i] - cum[k] <= 400; k--) {
          const h = air.holdByNode.get(ids[k]);
          if (h && h.runwayRefs.includes(ref)) { holdIdx = k; break; }
        }
        if (holdIdx < 0) holdIdx = i - 1;                        // fallback: last node before the runway
        lastHoldIdx = holdIdx;
      }
      const h = air.holdByNode.get(ids[holdIdx]);
      let runwayName = rw ? rw.ends[0].name : ref;
      if (rw) {
        if (h?.entryEnd && rw.ends.some(e => e.name === h.entryEnd)) runwayName = h.entryEnd;
        else if (h?.nearestEnd && rw.ends.some(e => e.name === h.nearestEnd)) runwayName = h.nearestEnd;
        else {
          const n = air.nodes.get(ids[holdIdx]);
          if (n) { const d0 = meters(n.lng, n.lat, rw.ends[0].lng, rw.ends[0].lat), d1 = meters(n.lng, n.lat, rw.ends[1].lng, rw.ends[1].lat); runwayName = d0 <= d1 ? rw.ends[0].name : rw.ends[1].name; }
        }
        if (isDepartureEntry) {
          // a departure backtracks to the end it starts from: name the end nearest the path's last node
          const last = air.nodes.get(ids[lastIdx]);
          if (last) { const d0 = meters(last.lng, last.lat, rw.ends[0].lng, rw.ends[0].lat), d1 = meters(last.lng, last.lat, rw.ends[1].lng, rw.ends[1].lat); runwayName = d0 <= d1 ? rw.ends[0].name : rw.ends[1].name; }
        }
      }
      out.push({ nodeId: ids[holdIdx], runway: runwayName, at: cum[holdIdx], isDepartureEntry });
    }
  }
  out.sort((a, b) => a.at - b.at || (a.isDepartureEntry ? 1 : 0) - (b.isDepartureEntry ? 1 : 0));
  return out;
}

/** The hold-short place to use when entering `runwayEnd` for departure from `fromNodeId` (nearest entry hold for that end). */
export function holdForRunwayEntry(air: OsmAirport, runwayEnd: string, fromNodeId: string): OsmHoldingPosition | null {
  const r = runwayEndByName(air, runwayEnd); if (!r) return null;
  const from = air.nodes.get(fromNodeId);
  const pool = air.holdingPositions.filter(h => h.entryEnd === r.end.name);
  const alt = pool.length ? pool : air.holdingPositions.filter(h => h.runwayRefs.includes(r.rw.ref) && h.nearestEnd === r.end.name);
  if (!alt.length) return null;
  if (!from) return alt[0];
  let best: OsmHoldingPosition | null = null, bd = Infinity;
  for (const h of alt) { const d = meters(from.lng, from.lat, h.lng, h.lat); if (d < bd) { bd = d; best = h; } }
  return best;
}

/** Holds that protect a runway (by ref or end name), entry holds for `end` first when given. */
export function holdsForRunway(air: OsmAirport, refOrEnd: string): OsmHoldingPosition[] {
  const rw = runwayFor(air, refOrEnd); if (!rw) return [];
  const endName = rw.ends.find(e => e.name.toUpperCase() === refOrEnd.toUpperCase())?.name;
  return air.holdingPositions.filter(h => h.runwayRefs.includes(rw.ref)).sort((a, b) => (a.entryEnd === endName ? 0 : 1) - (b.entryEnd === endName ? 0 : 1));
}

// ── A* with a binary heap ───────────────────────────────────
class MinHeap {
  private a: { id: string; key: number }[] = [];
  get size(): number { return this.a.length; }
  push(id: string, key: number): void {
    const a = this.a; a.push({ id, key });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].key <= a[i].key) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): { id: string; key: number } | undefined {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0]; const last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].key < a[m].key) m = l;
        if (r < a.length && a[r].key < a[m].key) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

export interface FindPathOpts {
  /** Runways (physical refs or end names) whose centreline edges are impassable (closed / sterile / active with traffic). */
  avoidRunways?: Iterable<string>;
  /** Node ids that must not be traversed (start/goal are exempt). */
  avoidNodes?: Iterable<string>;
  /** Taxiway designators to favour (their edges cost ×0.55) — e.g. a "via" list. */
  prefer?: Iterable<string>;
  /** Cost multiplier for runway edges (default 40). */
  runwayCost?: number;
  /** Runway (ref or end name) that may be used at taxiway cost — e.g. backtrack on the departure runway. */
  allowRunway?: string;
  /** Iteration guard (default 200 000). */
  maxIter?: number;
}

/**
 * A* over the graph from `startId` to `goalId`. Returns node ids or null when
 * unreachable. Runway edges are heavily penalised so aircraft taxi on taxiways
 * and only touch a runway at the entry; `opts` can forbid runways/nodes and
 * favour named taxiways. Signature-compatible with the legacy 3-arg form.
 */
export function findPath(air: OsmAirport, startId: string, goalId: string, opts: FindPathOpts = {}): string[] | null {
  const { nodes } = air;
  const start = nodes.get(startId), goal = nodes.get(goalId);
  if (!start || !goal) return null;
  if (startId === goalId) return [startId];

  const avoidRw = new Set<string>();
  for (const r of opts.avoidRunways ?? []) { const rw = runwayFor(air, r); if (rw) avoidRw.add(rw.ref); }
  const avoidNodes = new Set<string>(opts.avoidNodes ?? []);
  avoidNodes.delete(startId); avoidNodes.delete(goalId);
  const prefer = new Set<string>(Array.from(opts.prefer ?? []).map(s => s.toUpperCase()));
  const runwayCost = opts.runwayCost ?? RUNWAY_COST;
  const allowRef = opts.allowRunway ? runwayFor(air, opts.allowRunway)?.ref ?? null : null;
  const maxIter = opts.maxIter ?? 200000;

  const c = air.center; const kx = R * Math.cos(c.lat * D2R) * D2R, ky = R * D2R;
  const gx = (goal.lng - c.lng) * kx, gy = (goal.lat - c.lat) * ky;
  const h = (n: OsmNode) => Math.hypot((n.lng - c.lng) * kx - gx, (n.lat - c.lat) * ky - gy);

  const open = new MinHeap();
  const came = new Map<string, string>();
  const g = new Map<string, number>([[startId, 0]]);
  const closed = new Set<string>();
  open.push(startId, h(start));

  let guard = 0;
  while (open.size && guard++ < maxIter) {
    const { id: cur, key } = open.pop()!;
    if (closed.has(cur)) continue;
    const gCur = g.get(cur) ?? Infinity;
    if (key > gCur + h(nodes.get(cur)!) + 1e-6) continue;   // stale entry
    if (cur === goalId) {
      const path = [cur]; let p = cur;
      while (came.has(p)) { p = came.get(p)!; path.push(p); }
      return path.reverse();
    }
    closed.add(cur);
    const node = nodes.get(cur)!;
    for (const e of node.edges) {
      if (avoidNodes.has(e.to)) continue;
      let mult = 1;
      if (e.type === 'runway') {
        if (e.runway && avoidRw.has(e.runway)) continue;
        mult = e.runway && e.runway === allowRef ? 1 : runwayCost;
      } else if (e.taxiway && prefer.size) {
        mult = prefer.has(e.taxiway) ? 0.55 : 1;
      }
      const tentative = gCur + e.meters * mult;
      if (tentative < (g.get(e.to) ?? Infinity)) {
        came.set(e.to, cur);
        g.set(e.to, tentative);
        const nb = nodes.get(e.to);
        if (nb) open.push(e.to, tentative + h(nb));
      }
    }
  }
  return null;
}

/**
 * Route through named taxiways: for each designator in `via` (in order) the path
 * goes to the nearest node on that taxiway, then to the goal. Returns null when
 * any leg is unreachable or a designator is unknown.
 */
export function routeVia(air: OsmAirport, startId: string, via: string[], goalId: string, opts: FindPathOpts = {}): string[] | null {
  let cur = startId; const out: string[] = [startId];
  const from = air.nodes.get(startId); if (!from) return null;
  for (const raw of via) {
    const name = raw.toUpperCase();
    const onTw = air.taxiwayNodes.get(name); if (!onTw || !onTw.length) return null;
    const here = air.nodes.get(cur)!;
    // Waypoint = the taxiway's node nearest to the current position (the next named taxiway is normally the
    // one this leg joins). A node on a runway centreline (a high-speed exit's junction) is never a waypoint:
    // the raw-nearest node of "N3" from S3 at EGLL is N3's 27L junction, which sent the route across 27L and
    // back onto it again.
    const offRunway = onTw.filter(id => !runwayRefsAtNode(air, id).length);
    const pool = offRunway.length ? offRunway : onTw;
    let target = pool[0], bd = Infinity;
    for (const id of pool) {
      const n = air.nodes.get(id)!;
      const d = meters(here.lng, here.lat, n.lng, n.lat);
      if (d < bd) { bd = d; target = id; }
    }
    if (target === cur) continue;
    const seg = findPath(air, cur, target, { ...opts, prefer: [...(opts.prefer ?? []), name] }); if (!seg) return null;
    out.push(...seg.slice(1)); cur = target;
  }
  const last = findPath(air, cur, goalId, opts); if (!last) return null;
  out.push(...last.slice(1));
  return out;
}

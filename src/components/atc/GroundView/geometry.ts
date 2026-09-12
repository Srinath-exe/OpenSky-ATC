// ============================================================
//  Static airport geometry for the overlay, prepared once per airport from the
//  engine's OsmAirport: runway strips + thresholds + IDs, hold-short bars,
//  stands, taxiway designator anchors, service stations, apron centroids,
//  overview bounds. Everything is stored in unit mercator so the per-frame
//  work is one affine transform.
// ============================================================
import type { SimEngine } from '@/lib/sim/engine';
import type { OsmAirport, OsmHoldingPosition, OsmRunway, LngLat } from '@/lib/osmAirport';
import { advance, headingTo, dist, type XY } from '@/lib/sim/projection';
import { mercFromXY, mercFromLngLat, type Merc } from './mercator';

export const RUNWAY_HALF_WIDTH_M = 23;
const TAXIWAY_HALF_WIDTH_M = 12;
const LABEL_SPACING_M = 210;
const NM = 1852;

export interface GRunwayEnd {
  name: string;
  /** Physical end (pavement) mercator. */
  end: Merc;
  /** Landing threshold mercator. */
  thr: Merc;
  /** Engine XY of the threshold (corridor maths). */
  thrXY: XY;
  /** True heading of movement from this end toward the other. */
  hdg: number;
  /** ID label anchor (80 m in from the end) + rotation (deg, screen space). */
  label: Merc;
  labelRot: number;
  /** Threshold bar endpoints (across the runway). */
  bar: [Merc, Merc];
  /** Extended-centreline points every 1 NM out to 10 NM (index 0 = 1 NM). */
  corridor: Merc[];
  /** Perpendicular unit vector in XY (for corridor ticks). */
  perpXY: XY;
}
export interface GRunway {
  ref: string;
  ends: [GRunwayEnd, GRunwayEnd];
  /** Strip polygon (4 corners) mercator. */
  poly: [Merc, Merc, Merc, Merc];
  /** Centre + heading for hatch / labels. */
  centre: Merc;
  hdg: number;
  lengthM: number;
}
export interface GHold {
  nodeId: string;
  bar: [Merc, Merc];
  kind: OsmHoldingPosition['kind'];
  /** Protects a runway (as opposed to an intermediate taxiway hold). */
  runway: boolean;
  /** Runway-entry hold for this end (null = crossing / intermediate). */
  entryEnd: string | null;
  runwayEnds: string[];
  ref: string | null;
}
export interface GStand { ref: string; m: Merc; headingIn: number; terminal?: string }
export interface GLabel { name: string; m: Merc; rot: number }
export interface GStation { kind: 'arff' | 'tug' | 'ops' | 'fuel' | 'deice' | 'ambulance'; label: string; m: Merc; name: string | null }
export interface GApron { name: string; m: Merc; lng: number; lat: number; areaM2: number }

export interface GroundGeometry {
  icao: string;
  centre: { lng: number; lat: number };
  runways: GRunway[];
  endByName: Map<string, GRunwayEnd>;
  holds: GHold[];
  holdByNode: Map<string, GHold>;
  stands: GStand[];
  standByRef: Map<string, GStand>;
  labels: GLabel[];
  stations: GStation[];
  aprons: GApron[];
  /** Overview bounds [[minLng, minLat], [maxLng, maxLat]]. */
  bounds: [[number, number], [number, number]];
}

function ll(engine: SimEngine, xy: XY): LngLat { return engine.proj.toLngLat(xy.x, xy.y); }
function mXY(engine: SimEngine, xy: XY): Merc { return mercFromXY(engine.proj, xy.x, xy.y); }
function mLL(p: LngLat): Merc { return mercFromLngLat(p.lng, p.lat); }

function buildRunway(engine: SimEngine, rw: OsmRunway): GRunway {
  const [e0, e1] = rw.ends;
  const p0 = engine.proj.toXY(e0.lat, e0.lng), p1 = engine.proj.toXY(e1.lat, e1.lng);
  const hdg01 = headingTo(p0, p1);
  const len = rw.lengthM || dist(p0, p1);
  const perp = { x: Math.cos(hdg01 * (Math.PI / 180)), y: -Math.sin(hdg01 * (Math.PI / 180)) };
  const corner = (p: XY, s: number): Merc => mXY(engine, { x: p.x + perp.x * RUNWAY_HALF_WIDTH_M * s, y: p.y + perp.y * RUNWAY_HALF_WIDTH_M * s });
  const poly: [Merc, Merc, Merc, Merc] = [corner(p0, 1), corner(p1, 1), corner(p1, -1), corner(p0, -1)];
  const mkEnd = (end: typeof e0, endXY: XY, hdg: number): GRunwayEnd => {
    const thrXY = engine.thresholdXY(end.name) ?? engine.proj.toXY(end.thr.lat, end.thr.lng);
    const labelXY = advance(endXY, hdg, 90);
    const pp = { x: Math.cos(hdg * (Math.PI / 180)), y: -Math.sin(hdg * (Math.PI / 180)) };
    const bar: [Merc, Merc] = [
      mXY(engine, { x: thrXY.x + pp.x * RUNWAY_HALF_WIDTH_M, y: thrXY.y + pp.y * RUNWAY_HALF_WIDTH_M }),
      mXY(engine, { x: thrXY.x - pp.x * RUNWAY_HALF_WIDTH_M, y: thrXY.y - pp.y * RUNWAY_HALF_WIDTH_M }),
    ];
    const corridor: Merc[] = [];
    for (let nm = 1; nm <= 10; nm++) corridor.push(mXY(engine, advance(thrXY, (hdg + 180) % 360, nm * NM)));
    return { name: end.name.toUpperCase(), end: mXY(engine, endXY), thr: mXY(engine, thrXY), thrXY, hdg, label: mXY(engine, labelXY), labelRot: hdg, bar, corridor, perpXY: pp };
  };
  const g0 = mkEnd(e0, p0, hdg01), g1 = mkEnd(e1, p1, (hdg01 + 180) % 360);
  return { ref: rw.ref, ends: [g0, g1], poly, centre: mXY(engine, { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }), hdg: hdg01, lengthM: len };
}

/** Direction (true deg) from a hold node toward the nearest protected runway centreline; null when no runway. */
function holdApproachHeading(engine: SimEngine, air: OsmAirport, h: OsmHoldingPosition, nodeXY: XY): number | null {
  let best: { d: number; hdg: number } | null = null;
  for (const ref of h.runwayRefs) {
    const rw = air.runways.find(r => r.ref === ref); if (!rw) continue;
    const a = engine.proj.toXY(rw.ends[0].lat, rw.ends[0].lng), b = engine.proj.toXY(rw.ends[1].lat, rw.ends[1].lng);
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((nodeXY.x - a.x) * dx + (nodeXY.y - a.y) * dy) / len2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = dist(nodeXY, q);
    if (!best || d < best.d) best = { d, hdg: headingTo(nodeXY, q) };
  }
  return best ? best.hdg : null;
}

function buildHold(engine: SimEngine, air: OsmAirport, h: OsmHoldingPosition): GHold | null {
  const nodeXY = engine.nodeXY(h.nodeId) ?? engine.proj.toXY(h.lat, h.lng);
  let bar: [Merc, Merc] | null = null;
  if (h.line && h.line.length >= 2) {
    const a = h.line[0], b = h.line[h.line.length - 1];
    const aXY = engine.proj.toXY(a.lat, a.lng), bXY = engine.proj.toXY(b.lat, b.lng);
    if (dist(aXY, bXY) >= 6 && dist(aXY, bXY) <= 120) bar = [mLL(a), mLL(b)];
  }
  if (!bar) {
    // Perpendicular to the direction toward the runway (or to the first taxiway edge for taxiway holds).
    let dir = holdApproachHeading(engine, air, h, nodeXY);
    if (dir == null) {
      const node = air.nodes.get(h.nodeId);
      const e = node?.edges.find(x => x.type === 'taxiway');
      const to = e ? engine.nodeXY(e.to) : null;
      dir = to ? headingTo(nodeXY, to) : 0;
    }
    const half = h.runwayRefs.length ? TAXIWAY_HALF_WIDTH_M + 2 : TAXIWAY_HALF_WIDTH_M - 2;
    const p = advance(nodeXY, (dir + 90) % 360, half), q = advance(nodeXY, (dir + 270) % 360, half);
    bar = [mXY(engine, p), mXY(engine, q)];
  }
  return { nodeId: h.nodeId, bar, kind: h.kind, runway: h.runwayRefs.length > 0, entryEnd: h.entryEnd ? h.entryEnd.toUpperCase() : null, runwayEnds: h.runwayEnds.map(x => x.toUpperCase()), ref: h.ref };
}

/** Taxiway designator anchors: walk every named edge, keep midpoints spaced ≥ LABEL_SPACING_M per name. */
function buildLabels(engine: SimEngine, air: OsmAirport): GLabel[] {
  const out: GLabel[] = [];
  const seen = new Set<string>();
  const placedByName = new Map<string, XY[]>();
  for (const [name, ids] of air.taxiwayNodes) {
    if (!name || name.length > 4 || /\s/.test(name)) continue;
    const placed: XY[] = []; placedByName.set(name, placed);
    for (const id of ids) {
      const n = air.nodes.get(id); if (!n) continue;
      const a = engine.nodeXY(id); if (!a) continue;
      for (const e of n.edges) {
        if (e.taxiway !== name || e.type !== 'taxiway') continue;
        const key = id < e.to ? `${id}|${e.to}` : `${e.to}|${id}`;
        if (seen.has(key)) continue; seen.add(key);
        const b = engine.nodeXY(e.to); if (!b) continue;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let ok = true;
        for (const p of placed) { if (dist(p, mid) < LABEL_SPACING_M) { ok = false; break; } }
        if (!ok) continue;
        placed.push(mid);
        let rot = headingTo(a, b) - 90; // text baseline along the taxiway
        rot = ((rot % 360) + 360) % 360;
        if (rot > 90 && rot < 270) rot -= 180; // keep upright
        out.push({ name, m: mXY(engine, mid), rot });
      }
    }
  }
  return out;
}

function buildStations(air: OsmAirport): GStation[] {
  const S = air.stations; if (!S) return [];
  const out: GStation[] = [];
  const push = (kind: GStation['kind'], label: string, st: { lat: number; lng: number; name: string | null } | undefined) => {
    if (!st || !isFinite(st.lat) || !isFinite(st.lng)) return;
    const m = mercFromLngLat(st.lng, st.lat);
    if (out.some(o => Math.abs(o.m.x - m.x) < 1e-7 && Math.abs(o.m.y - m.y) < 1e-7)) return;
    out.push({ kind, label, m, name: st.name });
  };
  for (const a of S.arffAll ?? [S.arff]) push('arff', 'FIRE', a);
  push('tug', 'TUGS', S.tugDepot);
  push('ops', 'OPS', S.ops);
  push('fuel', 'FUEL', S.fuelFarm);
  for (const d of S.deice ?? []) push('deice', `DE-ICE ${d.ref}`.trim(), d);
  return out;
}

export function buildGroundGeometry(engine: SimEngine): GroundGeometry {
  const air = engine.air as unknown as OsmAirport;
  const runways = air.runways.map(rw => buildRunway(engine, rw));
  const endByName = new Map<string, GRunwayEnd>();
  for (const r of runways) for (const e of r.ends) endByName.set(e.name, e);
  const holds: GHold[] = [];
  const holdByNode = new Map<string, GHold>();
  for (const h of air.holdingPositions ?? []) {
    if (holdByNode.has(h.nodeId)) continue;
    const g = buildHold(engine, air, h); if (!g) continue;
    holds.push(g); holdByNode.set(g.nodeId, g);
  }
  const stands: GStand[] = [];
  const standByRef = new Map<string, GStand>();
  const standSrc = air.stands?.length ? air.stands.map(s => ({ ref: s.ref, lng: s.lng, lat: s.lat, headingIn: s.headingIn, terminal: s.terminal })) : air.gates.map(g => ({ ref: g.ref, lng: g.lng, lat: g.lat, headingIn: 0, terminal: undefined as string | undefined }));
  for (const s of standSrc) {
    if (standByRef.has(s.ref)) continue;
    const g: GStand = { ref: s.ref, m: mercFromLngLat(s.lng, s.lat), headingIn: s.headingIn, terminal: s.terminal };
    stands.push(g); standByRef.set(s.ref, g);
  }
  const labels = buildLabels(engine, air);
  const stations = buildStations(air);
  const aprons: GApron[] = (air.buildings ?? []).filter(b => b.kind === 'apron' && b.areaM2 > 15000).sort((a, b) => b.areaM2 - a.areaM2).slice(0, 6)
    .map((b, i) => ({ name: b.name ?? `Apron ${i + 1}`, m: mLL(b.centroid), lng: b.centroid.lng, lat: b.centroid.lat, areaM2: b.areaM2 }));
  // Overview bounds: runways + stands (+ a small margin)
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const take = (p: LngLat) => { if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng; if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat; };
  for (const rw of air.runways) for (const e of rw.ends) take(e);
  for (const s of standSrc) take(s);
  if (!isFinite(minLng)) { take(air.center); }
  const padLng = (maxLng - minLng) * 0.04 || 0.01, padLat = (maxLat - minLat) * 0.04 || 0.01;
  return {
    icao: air.icao, centre: air.center, runways, endByName, holds, holdByNode, stands, standByRef, labels, stations, aprons,
    bounds: [[minLng - padLng, minLat - padLat], [maxLng + padLng, maxLat + padLat]],
  };
}

export { ll as lngLatOf };

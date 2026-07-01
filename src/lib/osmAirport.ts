// ============================================================
//  OSM Airport — clean taxiway graph from OpenStreetMap aeroway data
//
//  OSM taxiway/runway LineStrings already share node coordinates at every
//  intersection, so they form ONE fully-connected graph with no healing,
//  bridging, or fragment-merging needed (unlike X-Plane scenery data).
//  This is the same data source AirNav Radar / FlightRadar24 use.
//
//  Source files: public/maps/osm/<ICAO>.geojson  (see scripts/fetch_osm_airports.py)
// ============================================================

export interface LngLat { lng: number; lat: number; }

export interface OsmNode {
  id: string;
  lng: number;
  lat: number;
  edges: { to: string; type: 'taxiway' | 'runway'; meters: number; taxiway?: string }[];
}

export interface OsmGate {
  ref: string;
  lng: number;
  lat: number;
  nodeId: string;          // nearest graph node
}

export interface OsmRunway {
  ref: string;             // e.g. "06L/24R"
  ends: { name: string; lng: number; lat: number; nodeId: string }[];
}

export interface OsmAirport {
  icao: string;
  center: LngLat;
  nodes: Map<string, OsmNode>;
  gates: OsmGate[];
  runways: OsmRunway[];
  taxiwayNames: string[];                 // sorted unique taxiway designators (A, B, …)
  taxiwayNodes: Map<string, string[]>;    // taxiway name → node ids on it
}

// ── geo helpers ─────────────────────────────────────────────
const R = 6371000;
export function meters(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const mid = (aLat + bLat) / 2 * Math.PI / 180;
  return Math.hypot(dLat * R, dLng * R * Math.cos(mid));
}

// compass bearing (0=N, 90=E, 180=S, 270=W)
export function bearingDeg(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLng = (bLng - aLng) * Math.PI / 180;
  const lat1 = aLat * Math.PI / 180;
  const lat2 = bLat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// node key — round to 6 decimals (~0.11m) so OSM-shared vertices merge exactly
function keyOf(lng: number, lat: number): string {
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

// ── loader ──────────────────────────────────────────────────
export async function loadOsmAirport(icao: string): Promise<OsmAirport> {
  const res = await fetch(`/maps/osm/${icao}.geojson`);
  if (!res.ok) throw new Error(`Failed to load OSM data for ${icao}: ${res.status}`);
  const fc = await res.json();
  return buildOsmAirport(icao, fc);
}

export function buildOsmAirport(icao: string, fc: any): OsmAirport {
  const nodes = new Map<string, OsmNode>();
  const center: LngLat = fc.center
    ? { lng: fc.center[0], lat: fc.center[1] }
    : { lng: 0, lat: 0 };

  const node = (lng: number, lat: number): OsmNode => {
    const k = keyOf(lng, lat);
    let n = nodes.get(k);
    if (!n) { n = { id: k, lng, lat, edges: [] }; nodes.set(k, n); }
    return n;
  };

  const taxiwayNodes = new Map<string, Set<string>>();
  const link = (a: OsmNode, b: OsmNode, type: 'taxiway' | 'runway', taxiway?: string) => {
    if (a.id === b.id) return;
    const m = meters(a.lng, a.lat, b.lng, b.lat);
    if (!a.edges.some(e => e.to === b.id)) a.edges.push({ to: b.id, type, meters: m, taxiway });
    if (!b.edges.some(e => e.to === a.id)) b.edges.push({ to: a.id, type, meters: m, taxiway });
    if (taxiway) {
      if (!taxiwayNodes.has(taxiway)) taxiwayNodes.set(taxiway, new Set());
      taxiwayNodes.get(taxiway)!.add(a.id); taxiwayNodes.get(taxiway)!.add(b.id);
    }
  };

  // ── build graph from taxiway + runway lines ──
  for (const f of fc.features as any[]) {
    const aw = f.properties?.aeroway;
    if ((aw !== 'taxiway' && aw !== 'runway') || f.geometry?.type !== 'LineString') continue;
    const cs: [number, number][] = f.geometry.coordinates;
    // taxiway designator from OSM `ref` (single letters/short codes only)
    const ref: string | undefined = aw === 'taxiway' && f.properties?.ref && /^[A-Z0-9]{1,3}$/i.test(f.properties.ref)
      ? String(f.properties.ref).toUpperCase() : undefined;
    for (let i = 0; i < cs.length - 1; i++) {
      const a = node(cs[i][0], cs[i][1]);
      const b = node(cs[i + 1][0], cs[i + 1][1]);
      link(a, b, aw, ref);
    }
  }

  // ── runways: store both ends, snap each to nearest graph node ──
  // Skip unnamed runways (OSM null ref) and dedupe split segments by ref,
  // keeping the longest segment (the full runway, not a fragment).
  const rwByRef = new Map<string, { ref: string; cs: [number, number][]; len: number }>();
  for (const f of fc.features as any[]) {
    if (f.properties?.aeroway !== 'runway' || f.geometry?.type !== 'LineString') continue;
    const ref: string | null = f.properties.ref;
    if (!ref || !ref.includes('/')) continue;          // drop null / malformed refs
    const cs: [number, number][] = f.geometry.coordinates;
    if (cs.length < 2) continue;
    const len = meters(cs[0][0], cs[0][1], cs[cs.length - 1][0], cs[cs.length - 1][1]);
    const prev = rwByRef.get(ref);
    if (!prev || len > prev.len) rwByRef.set(ref, { ref, cs, len });
  }
  const runways: OsmRunway[] = [];
  for (const { ref, cs } of rwByRef.values()) {
    const [n1, n2] = ref.split('/');
    const e0 = cs[0], e1 = cs[cs.length - 1];
    runways.push({
      ref,
      ends: [
        { name: n1 || ref, lng: e0[0], lat: e0[1], nodeId: keyOf(e0[0], e0[1]) },
        { name: n2 || ref, lng: e1[0], lat: e1[1], nodeId: keyOf(e1[0], e1[1]) },
      ],
    });
  }

  // ── gates: snap each to nearest graph node ──
  const nodeArr = Array.from(nodes.values());
  const nearestNode = (lng: number, lat: number, maxM = 120): string | null => {
    let best: string | null = null, bestD = maxM;
    for (const n of nodeArr) {
      const d = meters(lng, lat, n.lng, n.lat);
      if (d < bestD) { bestD = d; best = n.id; }
    }
    return best;
  };

  // Parking points = OSM gates + derived stands (from parking_position).
  // Gates are sparse; stands match X-Plane startup_locations density.
  const gates: OsmGate[] = [];
  const seen = new Set<string>();
  for (const f of fc.features as any[]) {
    const aw = f.properties?.aeroway;
    if ((aw !== 'gate' && aw !== 'stand') || f.geometry?.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates;
    const nodeId = nearestNode(lng, lat);
    if (!nodeId) continue;
    // de-duplicate a gate and a stand that resolve to the same graph node
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    gates.push({ ref: f.properties.ref || (aw === 'gate' ? `G${f.properties.id}` : `S${f.properties.id}`), lng, lat, nodeId });
  }

  const twNodes = new Map<string, string[]>();
  for (const [name, set] of taxiwayNodes) twNodes.set(name, Array.from(set));
  const taxiwayNames = Array.from(twNodes.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { icao, center, nodes, gates, runways, taxiwayNames, taxiwayNodes: twNodes };
}

// ── A* pathfinding ──────────────────────────────────────────
// Returns an array of node ids from start to goal, or null.
// Runway edges are heavily penalised so planes taxi on taxiways and only
// touch a runway at the entry threshold.
// Sequence of taxiway designators a node-id path traverses (consecutive dupes
// collapsed), e.g. ["A","B","K"]. Used for radio readbacks and route display.
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

export function findPath(air: OsmAirport, startId: string, goalId: string): string[] | null {
  const { nodes } = air;
  const start = nodes.get(startId), goal = nodes.get(goalId);
  if (!start || !goal) return null;

  const h = (id: string) => {
    const n = nodes.get(id)!;
    return meters(n.lng, n.lat, goal.lng, goal.lat);
  };

  const open = new Set<string>([startId]);
  const came = new Map<string, string>();
  const g = new Map<string, number>([[startId, 0]]);
  const f = new Map<string, number>([[startId, h(startId)]]);

  let guard = 0;
  while (open.size && guard++ < 200000) {
    let cur = '', best = Infinity;
    for (const id of open) {
      const s = f.get(id) ?? Infinity;
      if (s < best) { best = s; cur = id; }
    }
    if (cur === goalId) {
      const path = [cur];
      while (came.has(cur)) { cur = came.get(cur)!; path.unshift(cur); }
      return path;
    }
    open.delete(cur);
    const node = nodes.get(cur)!;
    for (const e of node.edges) {
      // discourage traveling along runways (×40) so taxiways are preferred
      const cost = e.meters * (e.type === 'runway' ? 40 : 1);
      const tentative = (g.get(cur) ?? Infinity) + cost;
      if (tentative < (g.get(e.to) ?? Infinity)) {
        came.set(e.to, cur);
        g.set(e.to, tentative);
        f.set(e.to, tentative + h(e.to));
        open.add(e.to);
      }
    }
  }
  return null;
}

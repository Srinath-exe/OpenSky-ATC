import { GeoPosition, haversine, bearing, moveAlongBearing, angleDiff } from './geoUtils';

// ============================================================
//  Airport Data Model — clean, named, drivable graph
//
//  Replaces the old taxiwayGraph.ts. Differences:
//   - Runway centerlines are NOT mixed into the taxi graph.
//   - Taxiways are NAMED (A, B, E, ...) from airport signs.
//   - Nodes are subsampled to ~25m so steering is smooth.
//   - Gates connect via a single explicit gate-entry node.
//   - Runway entry / exit / hold-short nodes are explicit.
//   - A* only uses the runway-traversal edge for takeoff/landing.
// ============================================================

// ── Public types (kept compatible with old TaxiGraph shape) ───────────────
export type NodeType =
  | 'intersection'
  | 'gate_entry'
  | 'runway_entry'
  | 'runway_exit'
  | 'hold_short'
  | 'apron';

export interface TaxiNode {
  id: string;
  position: GeoPosition;
  name?: string;        // e.g. "A", "A7", "INT-A-E"
  type: NodeType;
  neighbors: string[];
  // for runway entry/exit nodes:
  runwayId?: string;
  // for hold_short nodes:
  holdsForRunway?: string;
}

export interface TaxiEdge {
  id: string;
  name: string;          // taxiway letter or "RUNWAY 25L" or "GATE 42"
  fromNodeId: string;
  toNodeId: string;
  isOneWay: boolean;
  lengthMeters: number;
  type: 'taxiway' | 'runway' | 'apron' | 'pushback' | 'gate_link';
  crossesRunway?: string | null;
  taxiwayName?: string;
  isBridge?: boolean;   // synthetic edge — costly shortcut of last resort
  // For runway-traversal edges:
  runwayId?: string;
}

export interface HoldLine {
  id: string;
  position: GeoPosition;
  runway: string;
  associatedEdgeId: string;
}

export interface GateNode {
  id: string;            // gate name
  name: string;
  position: GeoPosition;
  heading: number;
  connectedNodeId: string;   // the gate_entry node
  type: 'gate' | 'tie_down';
  airline?: string;
}

export interface RunwayThreshold {
  runway: string;        // e.g. "06L/24R"
  name1: string;         // "06L"
  name2: string;         // "24R"
  threshold1: GeoPosition;
  threshold2: GeoPosition;
  heading1to2: number;    // true bearing from t1 to t2
  width: number;          // meters
  entryNodeId1: string;  // node near threshold1 (for departures on name1)
  entryNodeId2: string;  // node near threshold2 (for departures on name2)
  exitNodeId1: string;   // node near threshold1 (for arrivals vacating)
  exitNodeId2: string;   // node near threshold2 (for arrivals vacating)
  centerlineCoords: GeoPosition[];  // smoothed centerline for takeoff roll
  lengthMeters: number;
}

export interface TaxiGraph {
  nodes: Map<string, TaxiNode>;
  edges: Map<string, TaxiEdge[]>;
  holds: Map<string, HoldLine>;
  gates: Map<string, GateNode>;
  runways: Map<string, RunwayThreshold>;
  airportCenter: GeoPosition;
  icao: string;
}

export interface TaxiRouteSegment {
  type: 'taxiway' | 'runway' | 'apron' | 'hold_short' | 'pushback' | 'gate_link';
  fromNode: TaxiNode;
  toNode: TaxiNode;
  edge: TaxiEdge | null;
  distance: number;
  maxSpeed: number;
  isOneWay: boolean;
  holdShortId: string | null;
  runwayCrossing: string | null;
  // Cumulative distance along the route at the END of this segment (meters).
  cumulativeDistance: number;
}

export interface TaxiRoute {
  path: TaxiRouteSegment[];
  totalDistance: number;
  estimatedDuration: number;
}

export interface RouteEndpoint {
  type: 'gate' | 'node' | 'runway' | 'spot';
  id: string;
  operation?: 'departure' | 'arrival';
}

export interface RouteConstraints {
  avoidRunwayCrossings?: boolean;
  preferTaxiways?: boolean;
  maxLength?: number;
}

// ============================================================
//  Loader — fetch + parse X-Plane combined geojson for an airport
// ============================================================

export interface AirportGeojsonBundle {
  centerlines: any;
  holds: any;
  gates: any;
  runways: any;
  signs: any;
}

export async function loadAirportBundle(icao: string, base = `/maps/xplane/${icao}/combined`): Promise<AirportGeojsonBundle> {
  const [centerlines, holds, gates, runways, signs] = await Promise.all([
    fetchJson(`${base}/lines_centerlines.geojson`),
    fetchJson(`${base}/lines_holds.geojson`),
    fetchJson(`${base}/startup_locations.geojson`),
    fetchJson(`${base}/runways.geojson`),
    fetchJson(`${base}/signs.geojson`),
  ]);
  return { centerlines, holds, gates, runways, signs };
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

// ============================================================
//  Graph builder
// ============================================================

const RUNWAY_CENTERLINE_TYPES = new Set([
  'WIDE_ILS_CRITICAL_CENTERLINE_WITH_BLACK_BORDER',
  'ILS_CRITICAL_CENTERLINE_WITH_BLACK_BORDER',
]);

const SUBSAMPLE_SPACING_M = 50;       // emit a node every ~50m along a centerline
const BEND_KEEP_ANGLE_DEG = 25;       // keep original vertices where the line bends >25°
const NODE_MERGE_TOL_M = 4.0;          // merge graph nodes within 4m
const TAXIWAY_NAME_RE = /^[A-Z](\d?[A-Z]?)?$/;   // A, B, E, D7, R1, Z11
const RUNWAY_NAME_RE = /^[0-9]{1,2}[LRC]?$/;    // 06L, 25R, 09

export function buildTaxiGraph(
  bundle: AirportGeojsonBundle,
  airportCenter: GeoPosition,
  icao: string
): TaxiGraph {
  const nodes = new Map<string, TaxiNode>();
  const edges = new Map<string, TaxiEdge[]>();
  const holds = new Map<string, HoldLine>();
  const gates = new Map<string, GateNode>();
  const runways = new Map<string, RunwayThreshold>();

  // ── helpers ─────────────────────────────────────────────────
  function addNode(id: string, pos: GeoPosition, type: NodeType, name?: string): TaxiNode {
    let n = nodes.get(id);
    if (!n) {
      n = { id, position: pos, type, name, neighbors: [] };
      nodes.set(id, n);
    } else if (name && !n.name) {
      n.name = name;
    }
    return n;
  }

  function linkEdge(e: TaxiEdge) {
    if (!edges.has(e.fromNodeId)) edges.set(e.fromNodeId, []);
    if (!edges.has(e.toNodeId)) edges.set(e.toNodeId, []);
    // Avoid duplicate edges
    const list = edges.get(e.fromNodeId)!;
    if (!list.some(x => x.toNodeId === e.toNodeId && x.name === e.name)) {
      list.push(e);
      addNode(e.fromNodeId, nodes.get(e.fromNodeId)!.position, nodes.get(e.fromNodeId)!.type).neighbors.push(e.toNodeId);
    }
    if (!e.isOneWay) {
      const reverse: TaxiEdge = {
        ...e,
        id: reverseEdgeId(e.id),
        fromNodeId: e.toNodeId,
        toNodeId: e.fromNodeId,
      };
      const rlist = edges.get(e.toNodeId)!;
      if (!rlist.some(x => x.toNodeId === e.fromNodeId && x.name === e.name)) {
        rlist.push(reverse);
        addNode(e.toNodeId, nodes.get(e.toNodeId)!.position, nodes.get(e.toNodeId)!.type).neighbors.push(e.fromNodeId);
      }
    }
  }

  function reverseEdgeId(id: string): string {
    // e-aaa-bbb  ->  e-bbb-aaa
    const parts = id.split('-');
    if (parts.length === 3) return `${parts[0]}-${parts[2]}-${parts[1]}`;
    return `${id}:r`;
  }

  // ── 1. Partition centerlines into taxiway vs runway ──────────
  const twFeatures: any[] = [];
  const rwCenterlines: GeoPosition[][] = [];
  for (const f of bundle.centerlines?.features ?? []) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const t = f.properties?.painted_line_type;
    if (RUNWAY_CENTERLINE_TYPES.has(t)) {
      rwCenterlines.push(coords.map((c: [number, number]) => ({ lat: c[1], lng: c[0] })));
    } else {
      twFeatures.push(f);
    }
  }

  // ── 2. Build a taxiway-name map from signs ───────────────────
  // For each sign with a taxiway-letter label, snap it to the nearest
  // taxiway centerline feature (by midpoint distance). That feature's
  // whole polyline inherits the name.
  const taxiwayNameByFeatureIdx = new Map<number, string>();
  if (bundle.signs?.features) {
    for (const s of bundle.signs.features) {
      const label = s.properties?.label || '';
      if (!TAXIWAY_NAME_RE.test(label) || label.length > 4) continue;
      // ignore labels that are also valid runway names (e.g. "9", "27")
      if (RUNWAY_NAME_RE.test(label)) continue;
      const sc = s.geometry?.coordinates;
      if (!sc) continue;
      const spos: GeoPosition = { lat: sc[1], lng: sc[0] };
      // find nearest taxiway feature by min distance from spos to feature polyline
      let bestIdx = -1, bestD = 18; // within 18m
      for (let i = 0; i < twFeatures.length; i++) {
        const fc = twFeatures[i].geometry.coordinates;
        const d = polyLineNearestDist(spos, fc);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      if (bestIdx >= 0 && !taxiwayNameByFeatureIdx.has(bestIdx)) {
        taxiwayNameByFeatureIdx.set(bestIdx, label);
      }
    }
  }

  // ── 3. Subsample + build nodes/edges for each taxiway feature ─
  // Each taxiway feature becomes a chain of edges. Nodes are emitted
  // roughly every SUBSAMPLE_SPACING_M, plus at every sharp bend.
  // We also keep the subsampled polylines for intersection detection later.
  const twPolylines: { coords: [number, number][]; name: string }[] = [];
  let twCounter = 0;
  for (let fi = 0; fi < twFeatures.length; fi++) {
    const f = twFeatures[fi];
    const coords: [number, number][] = f.geometry.coordinates;
    const twName = taxiwayNameByFeatureIdx.get(fi) || '';
    const subsampled = subsamplePolyline(coords, SUBSAMPLE_SPACING_M, BEND_KEEP_ANGLE_DEG);
    if (subsampled.length < 2) continue;
    twCounter++;
    twPolylines.push({ coords: subsampled, name: twName });

    for (let i = 0; i < subsampled.length - 1; i++) {
      const a = subsampled[i];
      const b = subsampled[i + 1];
      const aPos: GeoPosition = { lat: a[1], lng: a[0] };
      const bPos: GeoPosition = { lat: b[1], lng: b[0] };
      const aId = nodeIdFor(aPos, twName ? `${twName}.${i}` : `tw${fi}.${i}`);
      const bId = nodeIdFor(bPos, twName ? `${twName}.${i + 1}` : `tw${fi}.${i + 1}`);
      addNode(aId, aPos, 'intersection', twName || undefined);
      addNode(bId, bPos, 'intersection', twName || undefined);
      const dist = haversine(aPos, bPos);
      if (dist < 0.5) continue;
      linkEdge({
        id: `e-${aId}-${bId}`,
        name: twName || `T${fi}`,
        fromNodeId: aId,
        toNodeId: bId,
        isOneWay: false,
        lengthMeters: dist,
        type: 'taxiway',
        crossesRunway: null,
        taxiwayName: twName || undefined,
      });
    }
  }

  // ── 4. Merge nearby nodes (tolerance) ────────────────────────
  mergeNearbyNodes(nodes, edges, NODE_MERGE_TOL_M);

  // ── 4b. Detect taxiway intersections and connect them ────────
  // Two taxiway polylines that cross should share a node at the crossing
  // point. Without this, the graph is disconnected at crossings.
  connectIntersections(nodes, edges, twPolylines, NODE_MERGE_TOL_M);

  // ── 4c. Connect nearby orphaned fragments ──────────────────
  // The X-Plane centerline data is heavily fragmented (50+ separate
  // polylines per taxiway). Snap endpoints to any nearby node within
  // ~25m and create connecting edges so the graph becomes connected.
  connectNearbyFragments(nodes, edges, 25);

  // ── 4d. Bridge any remaining disconnected components ─────────
  // Find connected components and connect each to its nearest neighbor
  // with a bridge edge. This guarantees the graph is fully connected.
  bridgeDisconnectedComponents(nodes, edges);

  // ── 5. Propagate taxiway names across merged fragments ───────
  // (already handled by name inheritance in addNode; do a second pass
  // to spread names to immediate neighbors that lack a name)
  propagateTaxiwayNames(nodes, edges);

  // ── 6. Build runway thresholds + runway entry/exit nodes ─────
  for (const f of bundle.runways?.features ?? []) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const n1 = f.properties?.name_1 || '??';
    const n2 = f.properties?.name_2 || '??';
    if (n1 === '??' && n2 === '??') continue;
    const runwayId = `${n1}/${n2}`;
    const t1: GeoPosition = { lat: coords[0][1], lng: coords[0][0] };
    const t2: GeoPosition = { lat: coords[coords.length - 1][1], lng: coords[coords.length - 1][0] };
    const rwHeading = bearing(t1, t2);
    const rwLength = haversine(t1, t2);
    const width = f.properties?.width || 46;

    // Smoothed centerline for takeoff roll (use runway geometry, not centerline features)
    const centerlineCoords: GeoPosition[] = coords.map((c: [number, number]) => ({ lat: c[1], lng: c[0] }));

    // Find existing taxiway nodes near each threshold (the runway-entry node)
    const entryId1 = findOrCreateRwNode(nodes, edges, t1, n1, 'runway_entry', runwayId, 35);
    const entryId2 = findOrCreateRwNode(nodes, edges, t2, n2, 'runway_entry', runwayId, 35);
    const exitId1 = entryId1; // for arrivals, vacate via the same near-threshold node set
    const exitId2 = entryId2;

    // For arrivals we want a node a bit PAST each threshold (on the runway side, near first exit)
    // — approximate by finding a taxiway node within 80m of the threshold but slightly inside
    const arrExit1 = findArrivalExitNode(nodes, t1, t2, 120);
    const arrExit2 = findArrivalExitNode(nodes, t2, t1, 120);

    runways.set(runwayId, {
      runway: runwayId,
      name1: n1,
      name2: n2,
      threshold1: t1,
      threshold2: t2,
      heading1to2: rwHeading,
      width,
      entryNodeId1: entryId1,
      entryNodeId2: entryId2,
      exitNodeId1: arrExit1 || entryId1,
      exitNodeId2: arrExit2 || entryId2,
      centerlineCoords,
      lengthMeters: rwLength,
    });

    // Also register each individual runway end so callers can ask for "06L" not just "06L/24R"
    runways.set(n1, runways.get(runwayId)!);
    runways.set(n2, runways.get(runwayId)!);
  }

  // ── 7. Hold-short nodes from lines_holds.geojson ─────────────
  // ILS-critical holds are runway holds; others are taxiway holds.
  // For each hold line, find the nearest taxiway *edge* and mark its
  // toNode as a hold_short node for that runway.
  for (const f of bundle.holds?.features ?? []) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 1) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    const pos: GeoPosition = { lat: mid[1], lng: mid[0] };
    const pt = f.properties?.painted_line_type || '';
    const isIlsHold = pt.includes('ILS_HOLD');

    // Find which runway this hold is for: nearest runway within 250m
    let rwy = '??';
    let bestD = 250;
    for (const rw of runways.values()) {
      if (!rw.centerlineCoords) continue;
      const d = pointToPolylineDist(pos, rw.centerlineCoords);
      if (d < bestD) { bestD = d; rwy = rw.runway.split('/')[0]; }
    }

    // Snap to nearest taxiway node within 25m — mark it hold_short
    const nearId = nearestNodeId(nodes, pos, 25);
    if (nearId) {
      const n = nodes.get(nearId)!;
      n.type = 'hold_short';
      n.holdsForRunway = rwy;
      const holdId = `HOLD-${rwy}-${nearId}`;
      // Find nearest edge for association
      const e = nearestEdge(nodes, edges, pos);
      holds.set(holdId, {
        id: holdId,
        position: pos,
        runway: rwy,
        associatedEdgeId: e?.id || '',
      });
    }
    // Track all holds (ILS or not) — only ILS holds block taxi without clearance,
    // but we keep the others for visual reference.
    void isIlsHold;
  }

  // ── 8. Gates → explicit gate_entry connector ─────────────────
  for (const f of bundle.gates?.features ?? []) {
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const pos: GeoPosition = { lat: c[1], lng: c[0] };
    const name = f.properties?.name || `Stand-${f.properties?.id || '?'}`;
    const heading = f.properties?.heading || 0;
    const type: 'gate' | 'tie_down' = f.properties?.location_type === 'gate' ? 'gate' : 'tie_down';
    const airline = f.properties?.airline_codes;

    // Project forward ~30m along gate heading to find where the aircraft
    // will end up after pushback (i.e. the taxiway it joins).
    const pushEnd = moveAlongBearing(pos, heading, 30);
    const entryId = nearestNodeId(nodes, pushEnd, 40);
    if (!entryId) continue;

    // Create a dedicated gate_entry node at pushEnd (or reuse the found node)
    let gateEntryId = entryId;
    const found = nodes.get(entryId)!;
    if (haversine(found.position, pushEnd) > 6) {
      // Make an explicit gate_entry node at the pushback end and connect it
      gateEntryId = nodeIdFor(pushEnd, `GE-${name}`);
      addNode(gateEntryId, pushEnd, 'gate_entry', `GE-${name}`);
      const d = haversine(pushEnd, found.position);
      linkEdge({
        id: `e-${gateEntryId}-${entryId}`,
        name: name,
        fromNodeId: gateEntryId,
        toNodeId: entryId,
        isOneWay: false,
        lengthMeters: d,
        type: 'gate_link',
        crossesRunway: null,
      });
    } else {
      // Tag the existing node as a gate_entry too
      found.type = 'gate_entry';
      if (!found.name) found.name = `GE-${name}`;
    }

    // Gate node itself — pushback starts from the gate, ends at gate_entry
    gates.set(name, {
      id: name,
      name,
      position: pos,
      heading,
      connectedNodeId: gateEntryId,
      type,
      airline,
    });
  }

  return { nodes, edges, holds, gates, runways, airportCenter, icao };
}

// ============================================================
//  Helpers — subsampling, naming, proximity
// ============================================================

function nodeIdFor(pos: GeoPosition, hint: string): string {
  const lat = Math.round(pos.lat * 200000).toString(36);
  const lng = Math.round(pos.lng * 200000).toString(36);
  return `n-${hint.slice(0, 24)}-${lat}-${lng}`;
}

// Walk a polyline and emit points at roughly `spacing` meters.
// Always keep the first/last points and any vertex where the bearing
// changes by more than `bendAngle` degrees.
function subsamplePolyline(coords: [number, number][], spacing: number, bendAngle: number): [number, number][] {
  if (coords.length <= 2) return coords.slice();
  const out: [number, number][] = [coords[0]];
  let accum = 0;
  let prevBearing: number | null = null;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const aPos = { lat: a[1], lng: a[0] };
    const bPos = { lat: b[1], lng: b[0] };
    const segLen = haversine(aPos, bPos);
    if (segLen < 0.01) continue;
    const bBearing = bearing(aPos, bPos);
    const bend = prevBearing === null ? 0 : Math.abs(angleDiff(prevBearing, bBearing));
    prevBearing = bBearing;

    // Keep the vertex if there's a sharp bend here
    if (bend > bendAngle && out[out.length - 1] !== a) {
      out.push(a);
      accum = 0;
    }

    // Walk along this segment, emitting points every `spacing` meters
    let walked = 0;
    while (walked + (spacing - accum) <= segLen) {
      walked += (spacing - accum);
      const t = walked / segLen;
      const nx = a[0] + (b[0] - a[0]) * t;
      const ny = a[1] + (b[1] - a[1]) * t;
      out.push([nx, ny]);
      accum = 0;
    }
    accum += segLen - walked;
  }
  // Always keep the final vertex
  const last = coords[coords.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function polyLineNearestDist(p: GeoPosition, coords: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const a: GeoPosition = { lat: coords[i][1], lng: coords[i][0] };
    const b: GeoPosition = { lat: coords[i + 1][1], lng: coords[i + 1][0] };
    best = Math.min(best, pointToSegmentDistance(p, a, b));
  }
  return best;
}

function pointToSegmentDistance(p: GeoPosition, a: GeoPosition, b: GeoPosition): number {
  const dAB = haversine(a, b);
  if (dAB < 0.01) return haversine(p, a);
  const dAP = haversine(a, p);
  const dBP = haversine(b, p);
  // law of cosines
  const cosA = (dAP * dAP + dAB * dAB - dBP * dBP) / (2 * dAP * dAB);
  const angleA = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (angleA > Math.PI / 2) return dAP;
  const cosB = (dBP * dBP + dAB * dAB - dAP * dAP) / (2 * dBP * dAB);
  const angleB = Math.acos(Math.max(-1, Math.min(1, cosB)));
  if (angleB > Math.PI / 2) return dBP;
  const area = 0.5 * dAP * dAB * Math.sin(angleA);
  return (2 * area) / dAB;
}

function pointToPolylineDist(p: GeoPosition, line: GeoPosition[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    best = Math.min(best, pointToSegmentDistance(p, line[i], line[i + 1]));
  }
  return best;
}

// Detect where two taxiway polylines cross and create an intersection
// node there, connecting both polylines' nearest nodes to it.
// Connect nodes that are geographically close but not yet connected by an edge.
// This heals fragmented centerline data by snapping endpoints together.
// Find connected components and bridge nearby ones together so the whole
// graph is reachable. For each component, find the nearest node in any other
// component and create an edge between them.
function bridgeDisconnectedComponents(
  nodes: Map<string, TaxiNode>,
  edges: Map<string, TaxiEdge[]>,
) {
  // Find components via BFS
  const componentOf = new Map<string, number>();
  const components: { id: number; nodeIds: string[]; centroid: GeoPosition }[] = [];
  let compId = 0;
  for (const [id] of nodes) {
    if (componentOf.has(id)) continue;
    const comp: string[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      if (componentOf.has(cur)) continue;
      componentOf.set(cur, compId);
      comp.push(cur);
      for (const e of (edges.get(cur) || [])) {
        if (!componentOf.has(e.toNodeId)) queue.push(e.toNodeId);
      }
    }
    // Compute centroid
    let sumLat = 0, sumLng = 0;
    for (const nid of comp) {
      const n = nodes.get(nid)!;
      sumLat += n.position.lat;
      sumLng += n.position.lng;
    }
    components.push({ id: compId, nodeIds: comp, centroid: { lat: sumLat / comp.length, lng: sumLng / comp.length } });
    compId++;
  }

  // Repeatedly find the two closest components (by min node-pair distance) and
  // bridge them, until only one component remains or no bridge is possible.
  let bridges = 0;
  while (components.length > 1 && bridges < 100) {
    // Find closest pair of components
    let bestPair: { a: number; b: number; dist: number; aNode: string; bNode: string } | null = null;
    for (let i = 0; i < components.length; i++) {
      for (let j = i + 1; j < components.length; j++) {
        // Quick centroid distance check first
        const cd = haversine(components[i].centroid, components[j].centroid);
        if (bestPair && cd > bestPair.dist * 3) continue;
        // Find closest node pair between the two components
        for (const nidA of components[i].nodeIds) {
          const nA = nodes.get(nidA)!;
          for (const nidB of components[j].nodeIds) {
            const nB = nodes.get(nidB)!;
            const d = haversine(nA.position, nB.position);
            if (!bestPair || d < bestPair.dist) {
              bestPair = { a: i, b: j, dist: d, aNode: nidA, bNode: nidB };
            }
          }
        }
      }
    }
    if (!bestPair || bestPair.dist > 1000) break; // don't bridge absurdly far components
    // Create bridge edge
    const nA = nodes.get(bestPair.aNode)!;
    const nB = nodes.get(bestPair.bNode)!;
    const name = nA.name && nB.name ? `${nA.name}~${nB.name}` : 'BRIDGE';
    if (!edges.has(bestPair.aNode)) edges.set(bestPair.aNode, []);
    if (!edges.has(bestPair.bNode)) edges.set(bestPair.bNode, []);
    edges.get(bestPair.aNode)!.push({ id: `bridge-${bestPair.aNode}-${bestPair.bNode}`, name, fromNodeId: bestPair.aNode, toNodeId: bestPair.bNode, isOneWay: false, lengthMeters: bestPair.dist, type: 'taxiway', crossesRunway: null, isBridge: true });
    edges.get(bestPair.bNode)!.push({ id: `bridge-${bestPair.bNode}-${bestPair.aNode}`, name, fromNodeId: bestPair.bNode, toNodeId: bestPair.aNode, isOneWay: false, lengthMeters: bestPair.dist, type: 'taxiway', crossesRunway: null, isBridge: true });
    if (!nA.neighbors.includes(bestPair.bNode)) nA.neighbors.push(bestPair.bNode);
    if (!nB.neighbors.includes(bestPair.aNode)) nB.neighbors.push(bestPair.aNode);
    bridges++;
    // Merge the two components
    const a = components[bestPair.a];
    const b = components[bestPair.b];
    a.nodeIds.push(...b.nodeIds);
    a.centroid = {
      lat: (a.centroid.lat * (a.nodeIds.length - b.nodeIds.length) + b.centroid.lat * b.nodeIds.length) / a.nodeIds.length,
      lng: (a.centroid.lng * (a.nodeIds.length - b.nodeIds.length) + b.centroid.lng * b.nodeIds.length) / a.nodeIds.length,
    };
    for (const nid of b.nodeIds) componentOf.set(nid, bestPair.a);
    components.splice(bestPair.b, 1);
  }
}

function connectNearbyFragments(
  nodes: Map<string, TaxiNode>,
  edges: Map<string, TaxiEdge[]>,
  tolerance: number,
) {
  // Spatial bucketing
  const BUCKET_DEG = tolerance / 111000; // rough meters-to-degrees
  const buckets = new Map<string, string[]>();
  for (const [id, n] of nodes) {
    const bx = Math.floor(n.position.lng / BUCKET_DEG);
    const by = Math.floor(n.position.lat / BUCKET_DEG);
    const key = `${bx},${by}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(id);
  }

  let connections = 0;
  for (const [idA, nA] of nodes) {
    const bx = Math.floor(nA.position.lng / BUCKET_DEG);
    const by = Math.floor(nA.position.lat / BUCKET_DEG);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cand = buckets.get(`${bx + dx},${by + dy}`) || [];
        for (const idB of cand) {
          if (idB === idA) continue;
          const nB = nodes.get(idB)!;
          const d = haversine(nA.position, nB.position);
          if (d > tolerance || d < 0.5) continue;
          // Check if already connected
          const aEdges = edges.get(idA) || [];
          if (aEdges.some(e => e.toNodeId === idB)) continue;
          // Connect them
          if (!edges.has(idA)) edges.set(idA, []);
          if (!edges.has(idB)) edges.set(idB, []);
          const fragName = nA.name && nB.name && nA.name !== nB.name ? `${nA.name}/${nB.name}` : (nA.name || nB.name || 'LINK');
          edges.get(idA)!.push({ id: `e-${idA}-${idB}`, name: fragName, fromNodeId: idA, toNodeId: idB, isOneWay: false, lengthMeters: d, type: 'taxiway', crossesRunway: null });
          edges.get(idB)!.push({ id: `e-${idB}-${idA}`, name: fragName, fromNodeId: idB, toNodeId: idA, isOneWay: false, lengthMeters: d, type: 'taxiway', crossesRunway: null });
          if (!nA.neighbors.includes(idB)) nA.neighbors.push(idB);
          if (!nB.neighbors.includes(idA)) nB.neighbors.push(idA);
          connections++;
        }
      }
    }
  }
}

function connectIntersections(
  nodes: Map<string, TaxiNode>,
  edges: Map<string, TaxiEdge[]>,
  polylines: { coords: [number, number][]; name: string }[],
  mergeTol: number,
) {
  // For each pair of polylines, find segment-segment crossings.
  // This is O(P^2 * S^2) but P and S are small enough.
  for (let i = 0; i < polylines.length; i++) {
    for (let j = i + 1; j < polylines.length; j++) {
      const p1 = polylines[i].coords;
      const p2 = polylines[j].coords;
      const n1 = polylines[i].name;
      const n2 = polylines[j].name;
      // Skip if both are the same taxiway (same name) — they'll merge anyway
      if (n1 && n2 && n1 === n2) continue;

      for (let a = 0; a < p1.length - 1; a++) {
        for (let b = 0; b < p2.length - 1; b++) {
          const crossing = segmentIntersection(
            p1[a], p1[a + 1], p2[b], p2[b + 1],
          );
          if (crossing) {
            const pos: GeoPosition = { lat: crossing[1], lng: crossing[0] };
            // Check if there's already a node nearby (within mergeTol)
            const existingId = nearestNodeId(nodes, pos, mergeTol);
            let nodeId: string;
            if (existingId) {
              nodeId = existingId;
            } else {
              nodeId = nodeIdFor(pos, `INT-${n1 || '?'}-${n2 || '?'}`);
              nodes.set(nodeId, { id: nodeId, position: pos, type: 'intersection', name: n1 && n2 ? `${n1}/${n2}` : (n1 || n2 || 'INT'), neighbors: [] });
              edges.set(nodeId, []);
            }
            // Connect this intersection node to the nearest node on each polyline
            // (within a reasonable distance — the crossing point is ON both segments
            // so the nearest nodes should be within SUBSAMPLE_SPACING_M).
            const p1Nearest = nearestNodeIdExcludingInternal(nodes, pos, 30, nodeId);
            const p2Nearest = nearestNodeIdExcludingInternal(nodes, pos, 30, nodeId);
            if (p1Nearest && p1Nearest !== nodeId) {
              linkBidirectional(edges, nodes, nodeId, p1Nearest, `INT-LINK-${n1 || ''}`);
            }
            if (p2Nearest && p2Nearest !== nodeId && p2Nearest !== p1Nearest) {
              linkBidirectional(edges, nodes, nodeId, p2Nearest, `INT-LINK-${n2 || ''}`);
            }
          }
        }
      }
    }
  }
}

function linkBidirectional(
  edges: Map<string, TaxiEdge[]>,
  nodes: Map<string, TaxiNode>,
  aId: string,
  bId: string,
  name: string,
) {
  if (aId === bId) return;
  const aPos = nodes.get(aId)?.position;
  const bPos = nodes.get(bId)?.position;
  if (!aPos || !bPos) return;
  const d = haversine(aPos, bPos);
  if (d < 0.5) return;
  if (!edges.has(aId)) edges.set(aId, []);
  if (!edges.has(bId)) edges.set(bId, []);
  // Avoid duplicates
  const aList = edges.get(aId)!;
  if (!aList.some(e => e.toNodeId === bId)) {
    aList.push({ id: `e-${aId}-${bId}`, name, fromNodeId: aId, toNodeId: bId, isOneWay: false, lengthMeters: d, type: 'taxiway', crossesRunway: null });
    nodes.get(aId)!.neighbors.push(bId);
  }
  const bList = edges.get(bId)!;
  if (!bList.some(e => e.toNodeId === aId)) {
    bList.push({ id: `e-${bId}-${aId}`, name, fromNodeId: bId, toNodeId: aId, isOneWay: false, lengthMeters: d, type: 'taxiway', crossesRunway: null });
    nodes.get(bId)!.neighbors.push(aId);
  }
}

function nearestNodeIdExcludingInternal(nodes: Map<string, TaxiNode>, pos: GeoPosition, radius: number, excludeId: string): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (const [id, n] of nodes) {
    if (id === excludeId) continue;
    const d = haversine(pos, n.position);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

// 2D segment intersection (flat-earth approximation using lng-scaled x).
// Returns [lng, lat] of the crossing point, or null if no crossing.
function segmentIntersection(
  a1: [number, number], a2: [number, number],
  b1: [number, number], b2: [number, number],
): [number, number] | null {
  // Scale lng by cos(lat) to approximate meters in both axes
  const refLat = (a1[1] + b1[1]) / 2 * Math.PI / 180;
  const cosLat = Math.cos(refLat);
  const toXY = (p: [number, number]): [number, number] => [p[0] * cosLat, p[1]];
  const A = toXY(a1), B = toXY(a2), C = toXY(b1), D = toXY(b2);
  const d1x = B[0] - A[0], d1y = B[1] - A[1];
  const d2x = D[0] - C[0], d2y = D[1] - C[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const dx = C[0] - A[0], dy = C[1] - A[1];
  const t1 = (dx * d2y - dy * d2x) / denom;
  const t2 = (dx * d1y - dy * d1x) / denom;
  if (t1 < -0.01 || t1 > 1.01 || t2 < -0.01 || t2 > 1.01) return null; // no crossing within segments
  // Crossing point in lng/lat
  const cx = a1[0] + (a2[0] - a1[0]) * t1;
  const cy = a1[1] + (a2[1] - a1[1]) * t1;
  return [cx, cy];
}

function mergeNearbyNodes(nodes: Map<string, TaxiNode>, edges: Map<string, TaxiEdge[]>, tol: number) {
  const ids = Array.from(nodes.keys());
  const merged = new Set<string>();
  // Spatial bucketing for speed
  const BUCKET = 5; // meters-ish in degrees — ~5m at equator-ish
  const buckets = new Map<string, string[]>();
  for (const id of ids) {
    const n = nodes.get(id)!;
    const bx = Math.floor(n.position.lng / BUCKET * 100000);
    const by = Math.floor(n.position.lat / BUCKET * 100000);
    const key = `${bx},${by}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(id);
  }

  for (const idA of ids) {
    if (merged.has(idA)) continue;
    const a = nodes.get(idA)!;
    // search 3x3 neighboring buckets
    const bx = Math.floor(a.position.lng / BUCKET * 100000);
    const by = Math.floor(a.position.lat / BUCKET * 100000);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cand = buckets.get(`${bx + dx},${by + dy}`) || [];
        for (const idB of cand) {
          if (idB === idA || merged.has(idB)) continue;
          const b = nodes.get(idB)!;
          if (haversine(a.position, b.position) < tol) {
            merged.add(idB);
            // Redirect every edge referencing idB to idA
            for (const [, list] of edges) {
              for (const e of list) {
                if (e.fromNodeId === idB) e.fromNodeId = idA;
                if (e.toNodeId === idB) e.toNodeId = idA;
              }
            }
            // Merge neighbors
            for (const nb of b.neighbors) {
              if (nb !== idA && !a.neighbors.includes(nb)) a.neighbors.push(nb);
            }
            // Preserve name: prefer a non-empty name
            if (!a.name && b.name) a.name = b.name;
            // Promote type: hold_short/runway_entry/gate_entry win over intersection
            const typeRank: Record<NodeType, number> = {
              intersection: 0, apron: 1, gate_entry: 2, runway_entry: 3, runway_exit: 3, hold_short: 4,
            };
            if (typeRank[b.type] > typeRank[a.type]) a.type = b.type;
            if (b.holdsForRunway && !a.holdsForRunway) a.holdsForRunway = b.holdsForRunway;
            if (b.runwayId && !a.runwayId) a.runwayId = b.runwayId;
            nodes.delete(idB);
          }
        }
      }
    }
  }

  // Clean self-loops + dedupe edges after redirection
  for (const [fromId, list] of edges) {
    const seen = new Set<string>();
    const cleaned: TaxiEdge[] = [];
    for (const e of list) {
      if (e.fromNodeId === e.toNodeId) continue;
      const key = `${e.toNodeId}|${e.name}|${e.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(e);
    }
    edges.set(fromId, cleaned);
  }
  // Remove orphaned empty edge lists
  for (const id of Array.from(edges.keys())) {
    if (!nodes.has(id)) edges.delete(id);
  }
  // Rebuild neighbor lists from edges
  for (const n of nodes.values()) n.neighbors = [];
  for (const [fromId, list] of edges) {
    const n = nodes.get(fromId);
    if (!n) continue;
    for (const e of list) {
      if (!n.neighbors.includes(e.toNodeId)) n.neighbors.push(e.toNodeId);
    }
  }
}

// Spread taxiway names to immediate unlabeled neighbors via BFS
function propagateTaxiwayNames(nodes: Map<string, TaxiNode>, edges: Map<string, TaxiEdge[]>) {
  const queue: string[] = [];
  for (const [id, n] of nodes) if (n.name) queue.push(id);
  let iter = 0;
  while (queue.length && iter < 5000) {
    iter++;
    const id = queue.shift()!;
    const n = nodes.get(id)!;
    if (!n.name) continue;
    for (const nbId of n.neighbors) {
      const nb = nodes.get(nbId);
      if (nb && !nb.name && nb.type === 'intersection') {
        nb.name = n.name;
        queue.push(nbId);
      }
    }
  }
}

function findOrCreateRwNode(
  nodes: Map<string, TaxiNode>,
  edges: Map<string, TaxiEdge[]>,
  pos: GeoPosition,
  endName: string,
  type: NodeType,
  runwayId: string,
  searchRadius: number,
): string {
  const existing = nearestNodeId(nodes, pos, searchRadius);
  if (existing) {
    const n = nodes.get(existing)!;
    n.type = type;
    n.runwayId = runwayId;
    if (!n.name) n.name = endName;
    return existing;
  }
  // No nearby node — create one and connect it to the nearest taxiway node
  // (search wider so the runway entry is actually reachable from the graph).
  const id = nodeIdFor(pos, `RW-${endName}`);
  nodes.set(id, { id, position: pos, type, name: endName, runwayId, neighbors: [] });
  edges.set(id, []);
  // Find the nearest taxiway node within 500m to connect to (wide because the
  // graph may be fragmented and the threshold is on the runway, away from taxiways)
  const connectId = nearestNodeIdExcluding(nodes, pos, 500, id);
  if (connectId) {
    const connectPos = nodes.get(connectId)!.position;
    const d = haversine(pos, connectPos);
    edges.get(id)!.push({
      id: `e-${id}-${connectId}`,
      name: `RW-LINK-${endName}`,
      fromNodeId: id,
      toNodeId: connectId,
      isOneWay: false,
      lengthMeters: d,
      type: 'taxiway',
      crossesRunway: null,
    });
    if (!edges.has(connectId)) edges.set(connectId, []);
    edges.get(connectId)!.push({
      id: `e-${connectId}-${id}`,
      name: `RW-LINK-${endName}`,
      fromNodeId: connectId,
      toNodeId: id,
      isOneWay: false,
      lengthMeters: d,
      type: 'taxiway',
      crossesRunway: null,
    });
    nodes.get(id)!.neighbors.push(connectId);
    nodes.get(connectId)!.neighbors.push(id);
  }
  return id;
}

function nearestNodeIdExcluding(nodes: Map<string, TaxiNode>, pos: GeoPosition, radius: number, excludeId: string): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (const [id, n] of nodes) {
    if (id === excludeId) continue;
    const d = haversine(pos, n.position);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

// Find a taxiway node within `radius` of `pos`, preferring ones that are
// *past* the threshold along the runway direction (for arrival exits).
function findArrivalExitNode(
  nodes: Map<string, TaxiNode>,
  threshold: GeoPosition,
  otherThreshold: GeoPosition,
  radius: number,
): string | null {
  const rwHeading = bearing(threshold, otherThreshold);
  // Look for nodes within radius, sorted by how far past the threshold they are
  const cands: { id: string; score: number }[] = [];
  for (const [id, n] of nodes) {
    const d = haversine(threshold, n.position);
    if (d > radius) continue;
    // score: how far along the runway direction (from threshold) this node is
    const bToNode = bearing(threshold, n.position);
    const along = d * Math.cos(angleDiff(rwHeading, bToNode) * Math.PI / 180);
    cands.push({ id, score: along });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  return cands[0].id;
}

function nearestNodeId(nodes: Map<string, TaxiNode>, pos: GeoPosition, radius: number): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (const [id, n] of nodes) {
    const d = haversine(pos, n.position);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function nearestEdge(nodes: Map<string, TaxiNode>, edges: Map<string, TaxiEdge[]>, pos: GeoPosition): TaxiEdge | null {
  let best: TaxiEdge | null = null;
  let bestD = Infinity;
  for (const list of edges.values()) {
    for (const e of list) {
      const a = nodes.get(e.fromNodeId)?.position;
      const b = nodes.get(e.toNodeId)?.position;
      if (!a || !b) continue;
      const d = pointToSegmentDistance(pos, a, b);
      if (d < bestD) { bestD = d; best = e; }
    }
  }
  return best;
}

// ============================================================
//  Pathfinding (A*) — compatible with old planRoute signature
// ============================================================

export function planRoute(
  graph: TaxiGraph,
  from: RouteEndpoint,
  to: RouteEndpoint,
  constraints: RouteConstraints = {},
): TaxiRoute | null {
  const startNode = resolveEndpoint(from, graph);
  const goalNode = resolveEndpoint(to, graph);
  if (!startNode || !goalNode) return null;

  const path = astar(graph, startNode, goalNode, constraints);
  if (!path || path.length < 2) return null;

  const segments: TaxiRouteSegment[] = [];
  let totalDistance = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const fromN = path[i];
    const toN = path[i + 1];
    const edge = findEdgeBetween(graph, fromN.id, toN.id);
    const dist = haversine(fromN.position, toN.position);
    totalDistance += dist;

    let maxSpeed = 12;             // default taxi speed (m/s) — bumped for visibility
    if (edge?.type === 'runway') maxSpeed = 20;
    if (edge?.type === 'apron') maxSpeed = 8;
    if (edge?.type === 'gate_link') maxSpeed = 6;
    if (dist < 30) maxSpeed = Math.min(maxSpeed, 5);

    // If the toNode is a hold_short node, this segment ends at a hold
    const holdShortId = toN.type === 'hold_short' && toN.holdsForRunway
      ? `HOLD-${toN.holdsForRunway}-${toN.id}`
      : null;

    segments.push({
      type: edge?.type || 'taxiway',
      fromNode: fromN,
      toNode: toN,
      edge,
      distance: dist,
      maxSpeed,
      isOneWay: edge?.isOneWay || false,
      holdShortId,
      runwayCrossing: edge?.crossesRunway || (toN.type === 'hold_short' ? toN.holdsForRunway || null : null),
      cumulativeDistance: totalDistance,
    });
  }
  const estimatedDuration = totalDistance / 6; // ~6 m/s avg
  return { path: segments, totalDistance, estimatedDuration };
}

function resolveEndpoint(ep: RouteEndpoint, graph: TaxiGraph): TaxiNode | null {
  switch (ep.type) {
    case 'gate': {
      const g = graph.gates.get(ep.id);
      return g ? graph.nodes.get(g.connectedNodeId) || null : null;
    }
    case 'spot': {
      const s = graph.gates.get(ep.id);
      return s ? graph.nodes.get(s.connectedNodeId) || null : null;
    }
    case 'node':
      return graph.nodes.get(ep.id) || null;
    case 'runway': {
      // ep.id can be a single end ("06L") or a pair ("06L/24R")
      const rw = graph.runways.get(ep.id);
      if (!rw) return null;
      if (ep.operation === 'arrival') {
        // arrivals vacate near the threshold they landed at; pick by id match
        if (ep.id === rw.name1) return graph.nodes.get(rw.exitNodeId1) || null;
        if (ep.id === rw.name2) return graph.nodes.get(rw.exitNodeId2) || null;
        return graph.nodes.get(rw.exitNodeId1) || graph.nodes.get(rw.exitNodeId2) || null;
      }
      // departure
      if (ep.id === rw.name1) return graph.nodes.get(rw.entryNodeId1) || null;
      if (ep.id === rw.name2) return graph.nodes.get(rw.entryNodeId2) || null;
      return graph.nodes.get(rw.entryNodeId1) || graph.nodes.get(rw.entryNodeId2) || null;
    }
  }
  return null;
}

function findEdgeBetween(graph: TaxiGraph, fromId: string, toId: string): TaxiEdge | null {
  const list = graph.edges.get(fromId);
  if (!list) return null;
  return list.find(e => e.toNodeId === toId) || null;
}

function astar(
  graph: TaxiGraph,
  start: TaxiNode,
  goal: TaxiNode,
  constraints: RouteConstraints,
): TaxiNode[] | null {
  const openSet = new Set<string>([start.id]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();
  for (const id of graph.nodes.keys()) {
    gScore.set(id, Infinity);
    fScore.set(id, Infinity);
  }
  gScore.set(start.id, 0);
  fScore.set(start.id, haversine(start.position, goal.position));

  let guard = 0;
  while (openSet.size && guard++ < 20000) {
    let current = '';
    let bestF = Infinity;
    for (const id of openSet) {
      const s = fScore.get(id) ?? Infinity;
      if (s < bestF) { bestF = s; current = id; }
    }
    if (current === goal.id) {
      const path: TaxiNode[] = [];
      let p = goal.id;
      while (cameFrom.has(p)) {
        path.unshift(graph.nodes.get(p)!);
        p = cameFrom.get(p)!;
      }
      path.unshift(graph.nodes.get(p)!);
      return path;
    }
    openSet.delete(current);
    const neighbors = graph.edges.get(current) || [];
    for (const edge of neighbors) {
      const cost = computeEdgeCost(edge, constraints);
      const tentativeG = gScore.get(current)! + cost;
      if (tentativeG < (gScore.get(edge.toNodeId) ?? Infinity)) {
        cameFrom.set(edge.toNodeId, current);
        gScore.set(edge.toNodeId, tentativeG);
        fScore.set(edge.toNodeId, tentativeG + haversine(graph.nodes.get(edge.toNodeId)!.position, goal.position));
        openSet.add(edge.toNodeId);
      }
    }
  }
  return null;
}

function computeEdgeCost(edge: TaxiEdge, constraints: RouteConstraints): number {
  let cost = edge.lengthMeters;
  // Strongly discourage using runway-traversal edges for plain taxi
  if (edge.type === 'runway') cost += 2000;
  // Runway crossings
  if (edge.crossesRunway && constraints.avoidRunwayCrossings) cost += 500;
  // Long apron penalty
  if (edge.type === 'apron' && edge.lengthMeters > 100) cost += edge.lengthMeters * 0.3;
  // Heavily penalise synthetic bridge/fragment edges so A* only uses them
  // when no real taxiway path exists. A real path up to 6 000 m is preferred
  // over a single bridge shortcut.
  if (edge.isBridge) cost += 6000;
  return cost;
}

// ============================================================
//  Public lookup helpers (kept compatible with old API)
// ============================================================

export function findNearestNode(pos: GeoPosition, graph: TaxiGraph, maxDist: number): string | null {
  return nearestNodeId(graph.nodes, pos, maxDist);
}

export function findNearestGate(pos: GeoPosition, graph: TaxiGraph, maxDist: number): GateNode | null {
  let best: GateNode | null = null;
  let bestD = maxDist;
  for (const g of graph.gates.values()) {
    const d = haversine(pos, g.position);
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}

// Resolve a free-text destination (runway, gate name, taxiway) to a RouteEndpoint
export function resolveDestination(
  text: string,
  graph: TaxiGraph,
): RouteEndpoint | null {
  const t = text.trim().toUpperCase();
  // Runway?
  if (graph.runways.has(t)) return { type: 'runway', id: t };
  // Also accept "RWY 25L" etc
  const rwyMatch = t.match(/^(?:RWY\s*)?(\d{1,2}[LRC]?)$/);
  if (rwyMatch && graph.runways.has(rwyMatch[1])) return { type: 'runway', id: rwyMatch[1] };
  // Gate?
  if (graph.gates.has(t)) return { type: 'gate', id: t };
  // Try fuzzy gate match
  for (const g of graph.gates.values()) {
    if (g.name.toUpperCase() === t) return { type: 'gate', id: g.name };
    if (g.name.toUpperCase().endsWith(' ' + t) || g.name.toUpperCase().includes(t)) return { type: 'gate', id: g.name };
  }
  return null;
}
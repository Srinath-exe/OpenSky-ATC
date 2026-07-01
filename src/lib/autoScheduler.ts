import { SimAircraft, TaxiRoute, RouteProgress, FlightPlan, transitionState, grantClearance, assignRoute, commandTaxiTo, commandTaxiToGate, emptyRouteProgress } from './aircraft';
import { GeoPosition, haversine, moveAlongBearing } from './geoUtils';
import {
  TaxiGraph,
  planRoute,
  findNearestNode,
  findNearestGate,
  RunwayThreshold,
  RouteEndpoint,
} from './airportData';

// ============================================================
//  Auto Scheduler — flight plan driven, not random walking
//
//  Two flow types:
//   - DEPARTURE: spawn at gate → pushback → taxi to assigned runway
//                → hold short → (auto-clear) line up → takeoff → handoff
//   - ARRIVAL:   spawn at runway threshold (already landed state LANDED)
//                → vacate → taxi to assigned gate → ARRIVED_GATE → despawn
// ============================================================

export type SchedulerPhase =
  | 'idle'
  | 'await_pushback'
  | 'pushback'
  | 'await_taxi'
  | 'taxi_out'
  | 'await_takeoff_clear'
  | 'line_up'
  | 'takeoff'
  | 'arrival_roll'
  | 'taxi_in'
  | 'arrived'
  | 'handed_off';

interface FlightTask {
  aircraftId: string;
  phase: SchedulerPhase;
  executeAt: number;       // ms epoch
  // Optional pre-resolved route to assign at execution
  pendingRoute?: TaxiRoute | null;
  pendingState?: SimAircraft['state'] | null;
  pendingRunway?: string | null;
}

let tasks: FlightTask[] = [];

export function resetScheduler() {
  tasks = [];
}

export function getScheduledTaskCount(): number {
  return tasks.length;
}

export function getNextTaskInfo(): string {
  if (tasks.length === 0) return 'No tasks';
  const now = Date.now();
  const next = tasks.reduce((b, t) => t.executeAt < b.executeAt ? t : b, tasks[0]);
  const remaining = Math.max(0, next.executeAt - now);
  return `${tasks.length} queued · next in ${(remaining/1000).toFixed(1)}s`;
}

// ============================================================
//  Task scheduling helpers
// ============================================================

function schedule(phase: SchedulerPhase, aircraftId: string, delayMs: number, opts: Partial<FlightTask> = {}) {
  tasks.push({ aircraftId, phase, executeAt: Date.now() + delayMs, ...opts });
}

// ============================================================
//  Departure flight plan
// ============================================================

export function startDeparture(
  ac: SimAircraft,
  graph: TaxiGraph,
  runway: string,
  delayMs = 0,
): void {
  // Phase 1: wait, then pushback
  schedule('await_pushback', ac.id, delayMs, { pendingRunway: runway });
  // Stash assigned runway on the aircraft immediately (caller should do this)
}

// ============================================================
//  Arrival flight plan
// ============================================================

export function startArrival(
  ac: SimAircraft,
  graph: TaxiGraph,
  runway: string,
  gate: string,
  delayMs = 0,
): void {
  schedule('arrival_roll', ac.id, delayMs, { pendingRunway: runway });
}

// ============================================================
//  Main process loop — called each sim tick
// ============================================================

export function processScheduler(
  aircrafts: Map<string, SimAircraft>,
  graph: TaxiGraph | null,
  dispatch: (action: any) => void,
): SimAircraft[] {
  if (!graph) return [];
  const now = Date.now();
  const updated: SimAircraft[] = [];
  const remaining: FlightTask[] = [];
  const newlyScheduled: FlightTask[] = [];

  // Temporarily swap the schedule target so new tasks land in `newlyScheduled`
  // instead of clobbering `remaining` via `tasks = remaining`.
  const originalTasks = tasks;
  tasks = newlyScheduled; // schedule() pushes here during this pass

  for (const task of originalTasks) {
    if (task.executeAt > now) { remaining.push(task); continue; }
    const ac = aircrafts.get(task.aircraftId);
    if (!ac) continue;

    const handler = PHASE_HANDLERS[task.phase];
    if (!handler) continue;
    const result = handler(ac, graph, task, dispatch);
    if (result) {
      if (result.aircraft && result.aircraft !== ac) {
        updated.push(result.aircraft);
      }
      if (result.nextPhase) {
        schedule(result.nextPhase, ac.id, result.nextDelayMs ?? 1000, result.nextOpts ?? {});
      }
    }
  }

  tasks = [...remaining, ...newlyScheduled];
  return updated;
}

// ============================================================
//  Phase handlers
// ============================================================

type PhaseResult = { aircraft: SimAircraft; nextPhase?: SchedulerPhase; nextDelayMs?: number; nextOpts?: Partial<FlightTask> } | null;
type PhaseHandler = (ac: SimAircraft, graph: TaxiGraph, task: FlightTask, dispatch: (a: any) => void) => PhaseResult;

const PHASE_HANDLERS: Record<SchedulerPhase, PhaseHandler> = {
  idle: () => null,

  // ── Departure: pushback ──
  await_pushback: (ac, graph, task) => {
    if (ac.state !== 'PARKED') return null;
    const rw = task.pendingRunway || ac.assignedRunway || pickRunway(graph);
    if (!rw) return null;

    const gateName = ac.assignedGate;
    if (!gateName) return null;
    const gate = graph.gates.get(gateName);
    if (!gate) return null;

    // Pushback end point: 30m forward along the gate heading. This is where
    // the aircraft ends up after pushback, facing the taxiway.
    const pushEnd = moveAlongBearing(gate.position, gate.heading, 30);
    // The segment bearing (gate → pushEnd) equals gate.heading.
    const segBearing = gate.heading;
    // During PUSHBACK_OUT the aircraft faces opposite to movement, so its
    // heading should be (segBearing + 180). Set it immediately — the tug
    // positions the plane, no gradual turn needed.
    const pushbackHeading = (segBearing + 180) % 360;

    // Use the gate's connectedNodeId as the toNode if it's close to pushEnd,
    // otherwise make a synthetic node at pushEnd (the taxi route will start
    // from the nearest real graph node after pushback completes).
    let toNode = graph.nodes.get(gate.connectedNodeId);
    let toPos = toNode ? toNode.position : pushEnd;
    let toId = toNode ? toNode.id : `pushend-${gateName}`;
    if (toNode && haversine(toNode.position, pushEnd) > 10) {
      // The connected graph node is far from pushEnd — use pushEnd as the
      // pushback target. The taxi route (planned after pushback) will start
      // from the nearest real node to pushEnd.
      toPos = pushEnd;
      toId = `pushend-${gateName}`;
      toNode = undefined;
    }

    const pushbackRoute: TaxiRoute = {
      path: [{
        type: 'pushback',
        fromNode: { id: `gate-${gateName}`, position: gate.position, type: 'intersection', name: gateName, neighbors: [] },
        toNode: toNode || { id: toId, position: toPos, type: 'intersection', name: `PushEnd-${gateName}`, neighbors: [] },
        edge: null,
        distance: haversine(gate.position, toPos),
        maxSpeed: 3,
        isOneWay: false,
        holdShortId: null,
        runwayCrossing: null,
        cumulativeDistance: haversine(gate.position, toPos),
      }],
      totalDistance: haversine(gate.position, toPos),
      estimatedDuration: 12,
    };

    let next = transitionState(ac, 'PUSHBACK_OUT');
    next = grantClearance(next, 'pushback');
    next = assignRoute(next, pushbackRoute, 'PUSHBACK_OUT');
    // Snap heading to pushback direction immediately (tug positioning)
    next = { ...next, heading: pushbackHeading, targetHeading: pushbackHeading, assignedRunway: rw, runwayOperation: 'departure' };

    return { aircraft: next, nextPhase: 'pushback', nextDelayMs: 8000 };
  },

  pushback: (ac, graph, task) => {
    // Wait until pushback completes (state = PUSHBACK_COMPLETE), then plan taxi to runway
    if (ac.state !== 'PUSHBACK_COMPLETE') {
      return { aircraft: ac, nextPhase: 'pushback', nextDelayMs: 2000 };
    }
    const fromId = findNearestNode(ac.position, graph, 80);
    if (!fromId) return { aircraft: ac, nextPhase: 'pushback', nextDelayMs: 3000 };
    const rw = ac.assignedRunway;
    if (!rw) return { aircraft: ac, nextPhase: 'pushback', nextDelayMs: 5000 };
    const route = planRoute(graph, { type: 'node', id: fromId }, { type: 'runway', id: rw, operation: 'departure' });
    if (!route) return { aircraft: ac, nextPhase: 'pushback', nextDelayMs: 5000 };
    const next = commandTaxiTo(ac, route, rw);
    return { aircraft: next, nextPhase: 'taxi_out', nextDelayMs: route.estimatedDuration * 1000 + 5000 };
  },

  await_taxi: () => null, // unused for now

  taxi_out: (ac, graph, task) => {
    // Aircraft should now be holding short of the runway. Auto-clear it through
    // line-up + takeoff (simulating the controller granting clearance).
    if (ac.state === 'HOLDING') {
      // Auto-clear hold short
      let next = grantClearance(ac, 'holdShort', ac.routeProgress.holdingAt || '');
      // Resume to TAXIING briefly so it reaches the runway entry node,
      // then we'll fire line_up + takeoff.
      next = { ...next, state: 'TAXIING' as const, routeProgress: { ...next.routeProgress, holdingAt: null } };
      return { aircraft: next, nextPhase: 'await_takeoff_clear', nextDelayMs: 4000 };
    }
    if (ac.state === 'RUNWAY_ENTRY') {
      return { aircraft: ac, nextPhase: 'await_takeoff_clear', nextDelayMs: 2000 };
    }
    if (ac.state === 'LINE_UP') {
      return { aircraft: ac, nextPhase: 'await_takeoff_clear', nextDelayMs: 1500 };
    }
    if (ac.state === 'TAKEOFF_ROLL' || ac.state === 'ROTATE' || ac.state === 'AIRBORNE_CLIMB' || ac.state === 'HANDED_OFF') {
      // Already moving — nothing to do here, the physics drives it.
      return null;
    }
    // Still taxiing — re-check later
    return { aircraft: ac, nextPhase: 'taxi_out', nextDelayMs: 3000 };
  },

  await_takeoff_clear: (ac, graph, task) => {
    // Auto-grant line-up + takeoff once at runway entry
    if (ac.state === 'HOLDING' || ac.state === 'RUNWAY_ENTRY') {
      let next = grantClearance(ac, 'lineUp');
      next = transitionState(next, 'LINE_UP');
      return { aircraft: next, nextPhase: 'await_takeoff_clear', nextDelayMs: 2000 };
    }
    if (ac.state === 'LINE_UP') {
      const rw = ac.assignedRunway || '';
      let next = grantClearance(ac, 'takeoff');
      next = { ...next, assignedRunway: rw, runwayOperation: 'departure' as const };
      next = transitionState(next, 'TAKEOFF_ROLL');
      return { aircraft: next, nextPhase: 'takeoff', nextDelayMs: 1000 };
    }
    if (ac.state === 'TAKEOFF_ROLL' || ac.state === 'ROTATE' || ac.state === 'AIRBORNE_CLIMB') {
      return { aircraft: ac, nextPhase: 'handed_off', nextDelayMs: 8000 };
    }
    if (ac.state === 'HANDED_OFF') return null;
    // Reschedule
    return { aircraft: ac, nextPhase: 'await_takeoff_clear', nextDelayMs: 2000 };
  },

  line_up: () => null,
  takeoff: () => null,

  handed_off: (ac, graph, task) => {
    // Aircraft has handed off — despawn from GMS (caller will dispatch DESPAWN)
    if (ac.state !== 'HANDED_OFF') return null;
    return null; // scheduler can't despawn directly; the loop will detect HANDED_OFF and despawn
  },

  // ── Arrival ──
  arrival_roll: (ac, graph, task) => {
    // Aircraft was spawned at the threshold in ARRIVING_RUNWAY / LANDED state.
    // Build a route from current position to a runway exit node, then to assigned gate.
    if (!ac.assignedRunway) return null;
    const rw = graph.runways.get(ac.assignedRunway);
    if (!rw) return null;

    // Pick the runway exit node based on which threshold we spawned at
    const exitId = haversine(ac.position, rw.threshold1) < haversine(ac.position, rw.threshold2)
      ? rw.exitNodeId1 : rw.exitNodeId2;
    // If no exit node, try the opposite threshold's exit (arrivals vacate past the threshold)
    const finalExitId = exitId || (haversine(ac.position, rw.threshold1) < haversine(ac.position, rw.threshold2) ? rw.exitNodeId2 : rw.exitNodeId1);
    const fromId = findNearestNode(ac.position, graph, 300) || rw.entryNodeId1 || rw.entryNodeId2;
    if (!fromId || !finalExitId) {
      return { aircraft: ac, nextPhase: 'arrival_roll', nextDelayMs: 5000 };
    }

    // First route: threshold → runway exit node
    let route1: TaxiRoute | null = null;
    if (fromId !== finalExitId) {
      route1 = planRoute(graph, { type: 'node', id: fromId }, { type: 'node', id: finalExitId });
    }
    // Then: runway exit node → assigned gate
    const gateName = ac.assignedGate;
    let route2: TaxiRoute | null = null;
    if (gateName && graph.gates.has(gateName)) {
      route2 = planRoute(graph, { type: 'node', id: finalExitId }, { type: 'gate', id: gateName });
    }
    let combined: TaxiRoute | null = null;
    if (route1 && route2) combined = combineRoutes(route1, route2);
    else if (route2) combined = route2;
    else if (route1) combined = route1;
    if (!combined) {
      return { aircraft: ac, nextPhase: 'arrival_roll', nextDelayMs: 5000 };
    }

    const next = assignRoute(ac, combined, 'TAXIING_TO_GATE');
    return { aircraft: next, nextPhase: 'taxi_in', nextDelayMs: combined.estimatedDuration * 1000 + 8000 };
  },

  taxi_in: (ac, graph, task) => {
    // Wait until arrived at gate, then despawn
    if (ac.state === 'ARRIVED_GATE') {
      return { aircraft: ac, nextPhase: 'arrived', nextDelayMs: 5000 };
    }
    // Reschedule if still taxiing
    return { aircraft: ac, nextPhase: 'taxi_in', nextDelayMs: 5000 };
  },

  arrived: (ac, graph, task) => {
    // Park at the gate; the loop will despawn after a short wait if needed.
    return null;
  },
};

// ============================================================
//  Helpers
// ============================================================

function pickRunway(graph: TaxiGraph): string | null {
  const rws = Array.from(graph.runways.values());
  // Deduplicate by runway id (we stored each end + the pair)
  const seen = new Set<string>();
  const unique: RunwayThreshold[] = [];
  for (const rw of rws) {
    if (rw.runway.includes('/') && !seen.has(rw.runway)) {
      seen.add(rw.runway);
      unique.push(rw);
    }
  }
  if (!unique.length) return null;
  const rw = unique[Math.floor(Math.random() * unique.length)];
  // Pick an end based on wind (random for now)
  return Math.random() < 0.5 ? rw.name1 : rw.name2;
}

function combineRoutes(r1: TaxiRoute, r2: TaxiRoute): TaxiRoute {
  const path = [...r1.path, ...r2.path];
  // Recompute cumulative distances
  let cum = 0;
  for (const s of path) {
    cum += s.distance;
    s.cumulativeDistance = cum;
  }
  return {
    path,
    totalDistance: r1.totalDistance + r2.totalDistance,
    estimatedDuration: r1.estimatedDuration + r2.estimatedDuration,
  };
}

// Pick a free gate for an arrival
export function pickFreeGate(graph: TaxiGraph, occupiedGateNames: Set<string>): string | null {
  const gates = Array.from(graph.gates.values()).filter(g => g.type === 'gate');
  if (!gates.length) return null;
  // Shuffle for variety
  for (let i = gates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [gates[i], gates[j]] = [gates[j], gates[i]];
  }
  for (const g of gates) {
    if (!occupiedGateNames.has(g.name)) return g.name;
  }
  return gates[0].name;
}

// Resolve a destination to an endpoint (used by manual commands)
export function resolveRouteEndpoint(text: string, graph: TaxiGraph): RouteEndpoint | null {
  const t = text.trim().toUpperCase();
  if (graph.runways.has(t)) return { type: 'runway', id: t };
  const rwyMatch = t.match(/^(?:RWY\s*)?(\d{1,2}[LRC]?)$/);
  if (rwyMatch && graph.runways.has(rwyMatch[1])) return { type: 'runway', id: rwyMatch[1] };
  if (graph.gates.has(t)) return { type: 'gate', id: t };
  // Fuzzy gate match
  for (const g of graph.gates.values()) {
    if (g.name.toUpperCase().includes(t)) return { type: 'gate', id: g.name };
  }
  return null;
}
# ATC Ground Movement System — Complete Technical Specification

## 1. System Overview

The Ground Movement System (GMS) simulates realistic aircraft taxi operations on airport surfaces. It integrates with the existing MapLibre-based airport viewer and provides:

- Realistic physics-based taxi movement
- A* pathfinding on actual taxiway geometry
- Collision detection & separation assurance
- ATC-like clearance system
- Pushback, taxi, hold-short, and runway crossing operations
- Visual aircraft representation with smooth animation
- Live traffic management UI

---

## 2. Core Entities & Data Model

### 2.1 SimAircraft (Ground Vehicle Entity)

```typescript
interface SimAircraft {
  // Identity
  id: string;                    // UUID
  callsign: string;              // "AAL123"
  airlineCode: string;           // "AAL"
  aircraftType: string;          // "B738" (ICAO type code)
  
  // Physical state
  position: GeoPosition;         // { lat, lng, alt? }
  heading: number;               // true heading in degrees [0-360)
  speed: number;                 // current ground speed (m/s)
  
  // Movement targets
  targetHeading: number;         // desired heading
  targetSpeed: number;           // desired speed (m/s)
  
  // Operational state machine
  state: GroundState;
  
  // Route & navigation
  route: TaxiRoute | null;       // computed path
  routeProgress: RouteProgress;  // where we are on the route
  
  // Parking
  assignedGate: string | null;  // "Gate 42"
  assignedSpot: string | null;   // parking spot ID
  
  // Runway assignment
  assignedRunway: string | null; // "25L"
  runwayOperation: 'departure' | 'arrival' | null;
  
  // Performance (from AircraftPerformance type)
  performance: AircraftPerformance;
  
  // Clearances
  clearances: ClearanceSet;
  
  // Timestamps
  createdAt: number;             // epoch ms
  stateChangedAt: number;        // epoch ms
  
  // Visual
  color: string;                 // airline brand color
  labelVisible: boolean;
  trail: GeoPosition[];          // last N positions for trail rendering
}
```

### 2.2 GroundState State Machine

```
PARKED ──[pushback clearance]──► PUSHBACK_OUT
    ▲                              │
    │                              ▼
    │                         PUSHBACK_COMPLETE
    │                              │
    │                    [taxi clearance]│
    │                              ▼
    │                           TAXIING ──[approach hold line]──► HOLDING
    │                              ▲    │                            │
    │                              │    │                    [hold clearance]
    │                              │    └────────────────────────────┘
    │                              │
    │                    [arrived at runway]│
    │                              ▼
    │                           RUNWAY_ENTRY ──[takeoff clearance]──► DEPARTING
    │                                                               (removed from GMS)
    │
    └──[arrival]── ARRIVING_RUNWAY ──[vacated]──► TAXIING (to gate)
                              │
                              ▼
                         ARRIVED_GATE
```

States:
- `PARKED` — at gate/spot, engines off or on, brakes set
- `PUSHBACK_OUT` — reversing from gate, tug attached
- `PUSHBACK_COMPLETE` — facing taxiway, waiting for taxi clearance
- `TAXIING` — moving under own power on taxiways
- `HOLDING` — stopped at hold-short line, awaiting clearance
- `RUNWAY_ENTRY` — crossing runway threshold, lining up
- `DEPARTING` — takeoff roll, handed off to departure system (removed from GMS)
- `ARRIVING_RUNWAY` — just landed, on runway
- `ARRIVED_GATE` — at destination gate (can be despawned)

### 2.3 TaxiRoute

```typescript
interface TaxiRoute {
  path: TaxiRouteSegment[];      // ordered segments
  totalDistance: number;         // meters
  estimatedDuration: number;     // seconds (at normal taxi speed)
}

interface TaxiRouteSegment {
  type: 'taxiway' | 'runway' | 'apron' | 'hold_short' | 'pushback';
  fromNode: TaxiNode;
  toNode: TaxiNode;
  edge: TaxiEdge | null;         // which taxiway edge
  distance: number;              // meters
  maxSpeed: number;              // speed limit for this segment (m/s)
  isOneWay: boolean;
  holdShortId: string | null;    // if this segment ends at a hold line
  runwayCrossing: string | null; // if crossing runway X
}
```

### 2.4 ClearanceSet

```typescript
interface ClearanceSet {
  pushback: boolean;             // cleared to pushback
  taxi: boolean;                 // cleared to taxi
  holdShort: string | null;      // hold short of this taxiway/runway
  lineUp: boolean;               // cleared to line up
  takeoff: boolean;              // cleared for takeoff
  crossRunway: string | null;    // cleared to cross runway X
}
```

---

## 3. Physics Engine

### 3.1 Update Loop (60 FPS target)

```typescript
function updateAircraft(ac: SimAircraft, dt: number, context: SimContext): SimAircraft {
  // dt = delta time in seconds (capped at 0.1s to prevent physics explosions)
  dt = Math.min(dt, 0.1);
  
  // Phase 1: Determine target speed & heading based on state
  const { targetSpeed, targetHeading } = computeTargets(ac, context);
  
  // Phase 2: Apply acceleration/deceleration limits
  const newSpeed = applySpeedPhysics(ac.speed, targetSpeed, ac.performance, dt);
  
  // Phase 3: Apply turn physics (bank angle limits → turn rate limits)
  const newHeading = applyHeadingPhysics(ac.heading, targetHeading, newSpeed, ac.performance, dt);
  
  // Phase 4: Compute new position
  const newPosition = moveAlongBearing(ac.position, newHeading, newSpeed * dt);
  
  // Phase 5: Advance route progress (did we reach the next waypoint?)
  const newProgress = advanceRoute(ac.routeProgress, newPosition, ac.route);
  
  // Phase 6: Check state transitions (hold short? arrived?)
  const newState = checkStateTransitions(ac, newProgress, context);
  
  // Phase 7: Check collisions
  const separationViolation = checkSeparation(ac, context.otherAircraft);
  if (separationViolation) {
    return emergencyStop(ac);
  }
  
  return {
    ...ac,
    position: newPosition,
    heading: newHeading,
    speed: newSpeed,
    targetSpeed,
    targetHeading,
    routeProgress: newProgress,
    state: newState,
    trail: updateTrail(ac.trail, newPosition),
  };
}
```

### 3.2 Speed Physics

**Acceleration curves:**
```
PUSHBACK:  maxSpeed = 3 m/s (6 knots),  acceleration = 0.8 m/s²
TAXIING:   maxSpeed = min(aircraftLimit, segmentLimit)
           default segment limit = 8.5 m/s (16.5 knots)
           tight turns (<30m radius) = 5 m/s (10 knots)
           high-speed taxiway = 13 m/s (25 knots)
           acceleration = 1.2 m/s²
           deceleration = 2.5 m/s² (braking)
HOLDING:   targetSpeed = 0
           approach decel zone = 15m before hold line
RUNWAY:    not in GMS (handled by departure/arrival)
```

**Aircraft type speed limits:**
| Type | Max Taxi | Turn Speed | Wingspan |
|------|----------|------------|----------|
| A320/B738 | 15 kt (7.7 m/s) | 10 kt | 36m |
| A321 | 15 kt | 10 kt | 40m |
| B77W | 20 kt (10.3 m/s) | 12 kt | 65m |
| A388 | 20 kt | 12 kt | 80m |
| GA/C172 | 10 kt (5.1 m/s) | 8 kt | 11m |

### 3.3 Heading/Turn Physics

```typescript
function applyHeadingPhysics(current: number, target: number, speed: number, perf: AircraftPerformance, dt: number): number {
  // Turn rate depends on speed (slower = tighter turn)
  // Formula: maxTurnRate = perf.turnRateGround * (1 - speed / perf.maxTaxiSpeed * 0.3)
  
  const diff = normalizeAngle(target - current); // [-180, 180]
  const maxTurnRate = perf.turnRateGround * (1 - (speed / perf.maxTaxiSpeed) * 0.3);
  const turnAmount = clamp(diff, -maxTurnRate * dt, maxTurnRate * dt);
  
  return normalizeAngle(current + turnAmount);
}
```

**Turn behavior:**
- Aircraft do NOT turn in place — they need forward speed to turn
- If speed < 1 m/s and heading diff > 10°, temporarily increase speed to 2 m/s to complete turn
- This simulates differential braking / nosewheel steering
- Widebody aircraft have wider turn radius (slower turn rate)

**As built (`aircraft.ts` `trailBody`)** — bicycle kinematics rather than a turn-rate cap. The point on the path
is the **nose wheel** (the model origin, 12 % of the length behind the nose: it follows the yellow line and stops at
the stop mark). The main gear, a wheelbase `L = 0.37 × length` behind it, cannot slip sideways, so the body heading
`θ` trails the nose wheel's direction of travel `φ`:

    dθ = (ds / L) · sin(φ − θ)          (ds = nose-wheel travel, capped at 8°/m and 100°/s)

The airframe rotates about its main gear, the tail follows the nose round the corner and the main gear cuts inside
the line; a 777 (L ≈ 27 m) straightens over a longer run than an A320 (L ≈ 14 m). A path that leads straight back
(|φ − θ| > 150°) turns the short way as if the nose wheel were at full lock. Line-ups run `50 m + 2.5 L` along the
runway so the body is on the centreline before the roll. Taxi speed drops toward 0.8 × `taxiTurnSpeed` as the bend
ahead (14 / 28 / 45 m) grows.

### 3.4 Position Movement

Use **great-circle distance** for realism:
```typescript
function moveAlongBearing(pos: GeoPosition, heading: number, distanceMeters: number): GeoPosition {
  // Haversine formula: move distanceMeters along heading degrees
  // Earth's radius R = 6,371,000m
  const R = 6371000;
  const lat1 = toRad(pos.lat);
  const lng1 = toRad(pos.lng);
  const h = toRad(heading);
  const d = distanceMeters / R;
  
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(h));
  const lng2 = lng1 + Math.atan2(Math.sin(h)*Math.sin(d)*Math.cos(lat1), Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
  
  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}
```

### 3.5 Route Progression

```typescript
function advanceRoute(progress: RouteProgress, currentPos: GeoPosition, route: TaxiRoute | null): RouteProgress {
  if (!route || !route.path.length) return progress;
  
  const nextSegment = route.path[progress.segmentIndex];
  const distToEnd = haversine(currentPos, nextSegment.toNode.position);
  
  if (distToEnd < 2.0) { // within 2 meters of waypoint
    // Advance to next segment
    const newIndex = progress.segmentIndex + 1;
    if (newIndex >= route.path.length) {
      // Route complete
      return { ...progress, segmentIndex: newIndex, completed: true };
    }
    
    // Check if next segment has a hold-short
    const upcoming = route.path[newIndex];
    if (upcoming.holdShortId && !upcoming.cleared) {
      return { ...progress, holdingAt: upcoming.holdShortId };
    }
    
    return { ...progress, segmentIndex: newIndex };
  }
  
  return progress;
}
```

---

## 4. Pathfinding System

### 4.1 Graph Construction

Build graph from combined geoJSON data:

```typescript
interface TaxiGraph {
  nodes: Map<string, TaxiNode>;       // nodeId -> TaxiNode
  edges: Map<string, TaxiEdge[]>;     // nodeId -> outgoing edges
  holds: Map<string, HoldLine>;        // holdShortId -> { position, runway }
  gates: Map<string, GateNode>;       // gateName -> { node, spot }
  runways: Map<string, RunwayThreshold>; // runway -> { entryNode, exitNode }
}

function buildTaxiGraph(airportGeojson: AirportGeojsonData): TaxiGraph {
  // 1. Extract all nodes from lines_centerlines.geojson
  //    Each vertex is a node. Merge vertices within 2m tolerance.
  
  // 2. Build edges from taxiway segments
  //    Each segment connects two nodes
  //    Properties: name (taxiway name), type, width, oneWay
  
  // 3. Extract hold-short lines from lines_holds.geojson
  //    Associate each hold with the nearest edge
  //    Mark the edge as having a "hold short of runway X" constraint
  
  // 4. Extract gates from startup_locations.geojson
  //    Connect each gate to nearest taxiway node (within 20m)
  //    Create a "gate connector" edge
  
  // 5. Extract runway thresholds from runways.geojson
  //    Connect runway ends to nearest taxiway nodes
}
```

### 4.2 Route Planning

```typescript
function planRoute(
  graph: TaxiGraph,
  from: RouteEndpoint,
  to: RouteEndpoint,
  constraints: RouteConstraints
): TaxiRoute | null {
  // from: { type: 'gate', id: 'Gate 42' } or { type: 'node', id: 'node-123' }
  // to: { type: 'runway', id: '25L', operation: 'departure' }
  // constraints: avoidRunways[], preferTaxiways[], maxLength?
  
  // 1. Resolve endpoints to graph nodes
  const startNode = resolveEndpoint(from, graph);
  const goalNode = resolveEndpoint(to, graph);
  
  // 2. A* with custom costs:
  //    - base cost = edge distance
  //    - penalty for runway crossings (+200m equivalent)
  //    - penalty for long waits at holds (+100m)
  //    - penalty for wrong-direction one-way edges (infinite / blocked)
  //    - prefer straight segments over complex turns
  
  // 3. Post-process: annotate each segment with speed limits, hold lines
  
  // 4. Return null if no path (e.g., one-way trap)
}
```

**Endpoint types:**
- `gate` — connect to nearest taxiway node, route starts at gate
- `spot` — same as gate but GA spot
- `runway` — for departure: nearest threshold node; for arrival: exit node
- `taxiway_node` — explicit node ID
- `intersection` — named taxiway intersection

### 4.3 Route Constraints & Costs

A* cost function:
```typescript
function edgeCost(edge: TaxiEdge, constraints: RouteConstraints): number {
  let cost = edge.lengthMeters;
  
  // Wrong-way penalty (soft block)
  if (edge.isOneWay && edge.direction === 'reverse') {
    cost += 1000; // very expensive but not impossible (emergency only)
  }
  
  // Runway crossing penalty
  if (edge.crossesRunway && constraints.avoidRunwayCrossings) {
    cost += 500;
  }
  
  // Prefer paved taxiways over aprons for long routes
  if (edge.type === 'apron' && edge.lengthMeters > 100) {
    cost += edge.lengthMeters * 0.3;
  }
  
  // Congestion penalty (dynamic)
  if (edge.currentAircraftCount > 0) {
    cost += edge.currentAircraftCount * 50;
  }
  
  return cost;
}
```

---

## 5. Collision & Separation System

### 5.1 Separation Rules (Real-world based)

| Scenario | Minimum Distance |
|----------|-----------------|
| Same taxiway, same direction | 60m (wingspan × 1.5) |
| Same taxiway, opposite direction | 100m (face-to-face) |
| Crossing paths | First arrives at intersection first |
| Behind heavy aircraft | 100m (wake turbulence) |
| Pushback area | 30m |
| Gate area | 20m |

### 5.2 Detection Algorithm

```typescript
function checkSeparation(ac: SimAircraft, others: SimAircraft[]): SeparationResult {
  for (const other of others) {
    if (other.id === ac.id) continue;
    if (other.state === 'PARKED' || other.state === 'ARRIVED_GATE') continue;
    
    const dist = haversine(ac.position, other.position);
    const minSep = computeMinSeparation(ac, other);
    
    if (dist < minSep) {
      return {
        violation: true,
        with: other.id,
        distance: dist,
        required: minSep,
        type: dist < 10 ? 'CRITICAL' : 'WARNING',
      };
    }
  }
  return { violation: false };
}

function computeMinSeparation(a: SimAircraft, b: SimAircraft): number {
  const base = Math.max(a.performance.wingspanMeters, b.performance.wingspanMeters) * 1.5;
  
  // Same direction on same edge
  if (onSameEdge(a, b) && sameDirection(a, b)) return Math.max(base, 60);
  
  // Opposite directions
  if (onSameEdge(a, b) && !sameDirection(a, b)) return Math.max(base, 100);
  
  // Heavy wake
  if (a.performance.weightClass === 'H' || b.performance.weightClass === 'H') return 100;
  
  return base;
}
```

### 5.3 Conflict Resolution

When separation violation detected:
1. **Immediate**: Both aircraft decelerate to stop (emergency braking)
2. **Resolution logic**:
   - If one is holding, the other must stop
   - If both taxiing, the one further from its next waypoint yields
   - If head-on, both stop; one gets "reverse" command to back up (rare)
3. **Resume**: After 3-second pause, re-check; if clear, resume at 3 m/s then accelerate

### 5.4 Intersection Management

For complex intersections (multiple taxiways crossing):
```typescript
interface IntersectionController {
  id: string;                    // intersection identifier
  position: GeoPosition;
  enteringEdges: string[];
  occupiedBy: string | null;      // aircraft ID currently in intersection
  queue: string[];                // aircraft IDs waiting
}

// Rules:
// 1. Only one aircraft in intersection at a time
// 2. Aircraft must declare intent 30m before intersection
// 3. Controller grants "enter" or "hold"
// 4. After aircraft clears (20m past center), next in queue enters
```

---

## 6. Pushback System

### 6.1 Pushback Physics

Pushback is fundamentally different from taxiing:
- Aircraft moves **backwards** (negative speed)
- **No steering** — tug follows a pre-defined pushback curve
- Slower speed: max 3 m/s (6 knots)
- Curved pushbacks: follow a circular arc then straight

**As built** — the tug steers the nose wheel, so the **main gear** is the point on the pushback path (the engine
starts the path a wheelbase behind the parked nose wheel, so nothing jumps when the push begins) and the body lies
along the path tangent, tail first; the nose wheel sits a wheelbase ahead of it and swings wide of the line in the
bend, exactly as a tug driver sees it. 3 kt on the straight, 2 kt while the tail is swung round (bend over the next
6–20 m). The path runs `20 m + L` along the taxiway past the junction so the nose wheel ends on the lane too. The tug
vehicle sits 5.5 m ahead of the nose wheel (under the nose).

```typescript
interface PushbackRoute {
  type: 'straight' | 'turn_then_straight';
  totalDistance: number;
  turnPoint: GeoPosition | null;   // where the turn happens
  finalHeading: number;           // heading after pushback complete
}

function computePushbackRoute(gate: GateNode, taxiwayGraph: TaxiGraph): PushbackRoute {
  // 1. Determine if straight or angled pushback based on gate orientation
  // 2. For angled: compute 90° or 135° turn to align with nearest taxiway
  // 3. End point must be on a taxiway centerline
  // 4. Return route with waypoints
}
```

### 6.2 Pushback States

```
PARKED → start pushback → PUSHBACK_OUT
  ↓                              ↓
  │                    [tug moving backward]
  │                              ↓
  │                    [reached end / turn complete]
  │                              ↓
  │                    PUSHBACK_COMPLETE
  │                              ↓
  │                    [pilot sets brakes, tug disconnects]
  │                              ↓
  │                    [ATC: "taxi to runway 25L via Alpha, Bravo"]
  │                              ↓
  └──────────────────────────► TAXIING
```

---

## 7. Hold-Short System

### 7.1 Hold Line Types

| Type | Visual | Meaning |
|------|--------|---------|
| Category I | Single dashed yellow | Hold unless cleared |
| Category II | Double solid yellow | Mandatory hold (ILS critical) |
| Category III | Red bars | Runway hold (most critical) |

### 7.2 Hold Detection

```typescript
function approachingHoldLine(ac: SimAircraft): HoldApproach | null {
  if (!ac.route) return null;
  
  const nextSeg = ac.route.path[ac.routeProgress.segmentIndex];
  if (!nextSeg || !nextSeg.holdShortId) return null;
  
  const distToHold = haversine(ac.position, nextSeg.toNode.position);
  
  if (distToHold < 25 && ac.speed > 0) {
    return {
      holdId: nextSeg.holdShortId,
      distance: distToHold,
      requiredStop: distToHold < 10,
    };
  }
  return null;
}
```

### 7.3 Auto-Stop Behavior

```
Distance to hold line:
> 25m:  normal taxi speed
15-25m: decelerate to 3 m/s
10-15m: decelerate to 1 m/s
< 10m:  stop completely (targetSpeed = 0)

After stopped at hold:
- State changes to HOLDING
- Await clearance (manual or automated)
- On clearance: state → TAXIING, targetSpeed = normal
```

---

## 8. Visual System (Map Rendering)

### 8.1 Aircraft Visual Representation

```typescript
interface AircraftVisual {
  // Marker element
  marker: maplibregl.Marker;
  
  // Icon SVG (dynamically colored by airline)
  icon: SVGElement;
  
  // Label (callsign floating above)
  label: maplibregl.Popup | null;
  
  // Trail (last 20 positions, fading)
  trail: maplibregl.Marker[];  // small dot markers
  
  // Selection ring
  selected: boolean;
}
```

**Icon design:**
- Top-down view of aircraft silhouette
- Color-coded by airline (extracted from airline code)
- Scale based on wingspan (C172: 12px, B738: 20px, A380: 32px)
- Rotated to match heading (CSS transform: rotate)
- Optional: show speed vector (short line in front, length ∝ speed)

### 8.2 Smooth Animation

Instead of `setLngLat()` every frame (can be jittery at 60fps):
```typescript
// Use CSS transitions for smooth movement
marker.getElement().style.transition = 'transform 0.05s linear';

// Or use MapLibre's built-in marker animation with requestAnimationFrame
// Compute interpolated position between frames
```

**Trail rendering:**
- Every 0.5 seconds, drop a small 3px dot at current position
- Dot fades over 3 seconds (opacity 1 → 0)
- Remove after 20 dots
- Color matches aircraft

### 8.3 Route Visualization

When aircraft is selected:
- Draw planned route as dashed line on map
- Color: yellow for taxi route, red for hold points
- Show distance remaining / ETA
- Animate a "progress dot" moving along the route

---

## 9. UI/UX Design

### 9.1 Ground Traffic Sidebar Panel

```
┌─────────────────────────────────┐
│  GROUND TRAFFIC         [+ Spawn]│
├─────────────────────────────────┤
│ FILTER: [All ▼] [Sort: ETA ▼]  │
├─────────────────────────────────┤
│ AAL123  ●──────→ 25L           │
│ B738 · Taxiing · 12kt · 45%    │
│ [Hold] [Reroute]                │
├─────────────────────────────────┤
│ UAL456  ●──────→ Gate 42       │
│ B739 · Holding · 0kt · HLD     │
│ [Clear] [Release]               │
├─────────────────────────────────┤
│ DLH789  ○ Pushback              │
│ A320 · Pushback · 3kt · 80%    │
│ [Abort]                         │
├─────────────────────────────────┤
│ ...                             │
├─────────────────────────────────┤
│ Total: 8 active | 3 holding     │
└─────────────────────────────────┘
```

**Row details:**
- **Callsign** + aircraft type icon
- **Status dot**: green (moving), yellow (holding), blue (pushback), grey (parked)
- **Destination** with arrow
- **Speed** + state
- **Progress**: percent along route or "HLD" for holding
- **Quick actions**: context-aware buttons

### 9.2 Aircraft Detail Popup (Click on Map)

```
┌──────────────────────────┐
│  [✈] AAL123    [×]      │
│  American Airlines B738  │
├──────────────────────────┤
│  Speed: 12 kt            │
│  Heading: 245°           │
│  Next waypoint: A3       │
│  ETA runway: 4:32 min   │
├──────────────────────────┤
│  ROUTE:                  │
│  Gate 42 → A → B → 25L   │
│  ████████░░░░░░░░ 45%   │
├──────────────────────────┤
│  [Hold] [Taxi] [Reroute] │
│  [Pushback] [Despawn]    │
└──────────────────────────┘
```

### 9.3 Spawn Dialog

```
┌──────────────────────────┐
│  Spawn Aircraft          │
├──────────────────────────┤
│  Callsign: [AAL___]      │
│  Type: [B738 ▼]          │
│  Airline: [American ▼]   │
│  Location: [Gate 42 ▼]   │
│  Destination: [25L ▼]  │
│  [Auto-route] ☑          │
├──────────────────────────┤
│  [Cancel] [Spawn]        │
└──────────────────────────┘
```

### 9.4 Clearance Panel (ATC-style)

```
┌──────────────────────────┐
│  CLEARANCES              │
├──────────────────────────┤
│  Pending (3):            │
│  • AAL123: hold short B  │
│    [Clear] [Deny]         │
│  • UAL456: cross 25L     │
│    [Clear] [Deny]         │
│  • DLH789: line up 25R   │
│    [Clear] [Deny]         │
├──────────────────────────┤
│  [Auto-clear all]        │
└──────────────────────────┘
```

---

## 10. Edge Cases & Failure Handling

### 10.1 Route Failure Scenarios

| Scenario | Detection | Resolution |
|----------|-----------|------------|
| No path found | A* returns null | Display error; aircraft holds; user can manually reroute |
| Path blocked | Target node unreachable | Try alternate runway/gate; if none, despawn |
| One-way trap | Aircraft enters dead-end | Auto-reverse (pushback maneuver); flag for user |
| Runway incursion | Aircraft crosses without clearance | Emergency stop; red alert; log incident |
| Stuck aircraft | No movement for 60s | Yellow alert; offer "teleport" or despawn |

### 10.2 Physics Edge Cases

```typescript
// CASE: Aircraft overshoots waypoint due to high speed
if (distToWaypoint < -2) { // we overshot by >2m
  // Don't snap — let it naturally turn back
  // Target heading = bearing to waypoint
  // Reduce speed
}

// CASE: Aircraft gets "stuck" in turn (speed too low to turn)
if (speed < 0.5 && headingDiff > 15) {
  // Briefly increase targetSpeed to 2.5 m/s
  // Apply differential turn logic
}

// CASE: Two aircraft approach head-on
if (sameEdge && oppositeDirection && dist < 80) {
  // Determine which has more room behind → that one stops
  // If equal, heavier/larger aircraft has right of way
}

// CASE: Gate occupied
if (targetGate.occupiedBy && targetGate.occupiedBy !== ac.id) {
  // Hold at nearest taxiway node
  // Alert user
}
```

### 10.3 Map Data Edge Cases

| Issue | Handling |
|-------|----------|
| Missing taxiway geoJSON | Graph incomplete; show warning; limit routes |
| No hold lines defined | Auto-generate hold lines 50m from runway edges |
| Overlapping nodes (duplicate) | Merge within 2m tolerance; log merge count |
| Disconnected graph components | Multiple sub-graphs; can't route between; warn user |
| One-way edges with no exit | Mark as trap; A* cost = ∞ |

---

## 11. State Management Architecture

### 11.1 React Context + Reducer Pattern

```typescript
// src/context/GroundTrafficContext.tsx
interface GMSState {
  aircrafts: Map<string, SimAircraft>;
  selectedId: string | null;
  taxiGraph: TaxiGraph | null;
  intersections: Map<string, IntersectionController>;
  isRunning: boolean;           // sim loop active?
  speedMultiplier: number;      // 1x, 2x, 4x
  statistics: GMSStatistics;
}

type GMSAction =
  | { type: 'SPAWN'; aircraft: SimAircraft }
  | { type: 'DESPAWN'; id: string }
  | { type: 'TICK'; updates: Map<string, SimAircraft> }  // batched per frame
  | { type: 'SELECT'; id: string | null }
  | { type: 'CLEARANCE'; id: string; clearance: ClearanceSet }
  | { type: 'REROUTE'; id: string; route: TaxiRoute }
  | { type: 'SET_SPEED'; multiplier: number }
  | { type: 'LOAD_GRAPH'; graph: TaxiGraph };
```

**Why reducer + context?**
- Single source of truth for all aircraft
- Batch updates per frame (single re-render)
- Time-travel debugging possible (log all actions)
- Easy to sync with future multiplayer backend

### 11.2 Sim Loop Integration

```typescript
// src/hooks/useSimLoop.ts
function useSimLoop() {
  const { state, dispatch } = useGroundTraffic();
  const lastTimeRef = useRef(performance.now());
  
  useEffect(() => {
    if (!state.isRunning) return;
    
    let raf: number;
    const loop = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000 * state.speedMultiplier;
      lastTimeRef.current = now;
      
      // Compute all updates in one pass
      const updates = new Map<string, SimAircraft>();
      for (const [id, ac] of state.aircrafts) {
        const updated = updateAircraft(ac, dt, {
          otherAircraft: Array.from(state.aircrafts.values()).filter(a => a.id !== id),
          taxiGraph: state.taxiGraph,
          intersections: state.intersections,
        });
        updates.set(id, updated);
      }
      
      // Single dispatch with batched updates
      dispatch({ type: 'TICK', updates });
      
      raf = requestAnimationFrame(loop);
    };
    
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state.isRunning, state.speedMultiplier, state.taxiGraph]);
}
```

---

## 12. Performance Considerations

### 12.1 Aircraft Count Limits

| Target | Max Aircraft | Approach |
|--------|-------------|----------|
| Smooth 60fps | 50 | Full physics every frame |
| Acceptable | 100 | LOD: far aircraft update every 2nd frame |
| Stress test | 200 | Simplified physics + no collision for far pairs |

### 12.2 Optimization Strategies

1. **Spatial hashing**: Only check collisions between aircraft in same grid cell
2. **Route caching**: Cache A* results for common routes (gate→runway pairs)
3. **Graph pre-computation**: Build graph once per airport, reuse
4. **Marker pooling**: Reuse DOM elements instead of creating/destroying
5. **Trail culling**: Don't render trails for aircraft off-screen
6. **Frame skipping**: At 4x speed, physics steps 4× per frame but render once

---

## 13. Integration with Existing Code

### 13.1 Map Component Changes

**LAXMap (`/lax`) and HiFiMap (`/hifi`)** will both support GMS via a shared overlay:

```typescript
// src/components/AircraftOverlay.tsx
interface AircraftOverlayProps {
  map: maplibregl.Map;
  airportCode: string;
}

// This component:
// 1. Loads the taxiway graph for the current airport
// 2. Subscribes to GMS context for aircraft in this airport
// 3. Renders AircraftMarkers for each aircraft
// 4. Renders route lines for selected aircraft
// 5. Renders intersection occupancy indicators
```

### 13.2 New Files to Create

```
src/
├── lib/
│   ├── aircraft.ts           # types, spawn helpers
│   ├── physics.ts            # movement math
│   ├── taxiwayGraph.ts       # graph builder from geoJSON
│   ├── pathfinding.ts        # A* (extends existing)
│   └── geoUtils.ts           # haversine, bearing, etc.
│
├── hooks/
│   ├── useSimLoop.ts         # RAF simulation loop
│   └── useTaxiwayGraph.ts    # load graph for airport
│
├── components/
│   ├── AircraftOverlay.tsx   # main map overlay
│   ├── AircraftMarker.tsx    # single aircraft visual
│   ├── AircraftTrail.tsx     # trail dots
│   ├── RouteLine.tsx         # planned route visualization
│   ├── GroundTrafficPanel.tsx # sidebar UI
│   ├── AircraftPopup.tsx     # click popup
│   ├── SpawnDialog.tsx       # spawn new aircraft
│   └── ClearancePanel.tsx    # ATC clearances
│
└── context/
    └── GroundTrafficContext.tsx # global GMS state
```

---

## 14. Development Phases

### Phase 1: Foundation (1-2 days)
- [ ] Implement `SimAircraft` types and state machine
- [ ] Build `taxiwayGraph.ts` (graph from geoJSON)
- [ ] Extend `pathfinding.ts` for route planning
- [ ] Basic physics: move, turn, stop
- [ ] `GroundTrafficContext` with reducer

### Phase 2: Single Aircraft (2-3 days)
- [ ] Spawn one aircraft at gate
- [ ] Compute route to runway
- [ ] Animate movement along route
- [ ] Auto-stop at hold lines
- [ ] Visual: marker + trail on map
- [ ] Click to select + popup

### Phase 3: Multi-Aircraft & Collision (2-3 days)
- [ ] Spawn multiple aircraft
- [ ] Separation detection
- [ ] Auto-yield / emergency stop
- [ ] Intersection controller
- [ ] Pushback physics

### Phase 4: UI & Control (2 days)
- [ ] Ground Traffic sidebar panel
- [ ] Spawn dialog
- [ ] Clearance panel
- [ ] Route visualization on map
- [ ] Speed controls (1x, 2x, 4x, pause)

### Phase 5: Polish & Edge Cases (2 days)
- [ ] Handle all edge cases (Section 10)
- [ ] Performance optimization
- [ ] Visual polish (aircraft icons, smooth animations)
- [ ] Integration with both `/lax` and `/hifi`

**Total estimated: 9-12 days of focused work.**

---

## 15. Testing Strategy

### 15.1 Unit Tests

```typescript
// physics.test.ts
describe('applySpeedPhysics', () => {
  it('accelerates within limits', () => {...});
  it('decelerates faster than accelerates', () => {...});
  it('stops at hold lines', () => {...});
});

// pathfinding.test.ts
describe('planRoute', () => {
  it('finds route from gate to runway', () => {...});
  it('avoids wrong-way edges', () => {...});
  it('prefers fewer runway crossings', () => {...});
});

// collision.test.ts
describe('checkSeparation', () => {
  it('detects head-on conflict', () => {...});
  it('ignores parked aircraft', () => {...});
});
```

### 15.2 Integration Tests

- Spawn 5 aircraft, all taxiing to same runway — verify queue forms
- Simulate rush hour: 20 aircraft spawning over 5 minutes
- Test with broken/missing geoJSON data

---

## 16. Future Extensions

| Feature | Description |
|---------|-------------|
| **ATC Voice** | Text-to-speech for clearances |
| **Weather** | Rain reduces braking, wind affects pushback |
| **Emergencies** | Aircraft breakdown, tug required |
| **Multiplayer** | Multiple users controlling different airports |
| **Replay** | Record and replay sessions |
| **Statistics** | Taxi times, fuel burn, delays |
| **API** | REST API to inject real ADS-B data |

---

**End of Specification**

This document covers every aspect of the Ground Movement System. Ready to start Phase 1?

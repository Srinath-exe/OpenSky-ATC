# SkyControl: Phase 1 Core Simulation Specification

To ensure a smooth, stable, and mathematically accurate implementation of **Phase 1: The Core Simulation Engine (Brain)**, we must address four critical engineering requirements: spatial projection, aircraft physics limits, taxiway path-following steering, and collision separation rules.

---

## 1. Spatial Coordinate Projection (Lat/Lng to local Cartesian X/Y)

Aircraft positions in OpenStreetMap are defined by geographic Latitude and Longitude. However, running trigonometry and distance calculations directly on spherical degrees is computationally expensive and mathematically complex.

### The Solution: Local Azimuthal Equidistant Projection
We will implement a lightweight projection system centered around the airport's reference point (`refLat`, `refLng`). This maps global coordinates to local flat-earth `(X, Y)` coordinates in **meters** for high-precision, high-speed rendering:

$$X = R \cdot \cos(\text{refLat}) \cdot (\text{lng} - \text{refLng}) \cdot \frac{\pi}{180}$$

$$Y = R \cdot (\text{lat} - \text{refLat}) \cdot \frac{\pi}{180}$$

*(Where $R$ is the Earth's radius, approximately $6,371,000$ meters).*

*   **During Data Loading:** Convert all runway endpoints, gate nodes, and taxi nodes from `(lat, lng)` to local `(x, y)` relative to the airport center.
*   **During Physics Ticks:** Calculate physics, speeds, and separations entirely on the fast `(x, y)` grid.

---

## 2. Aircraft Physics & Class Limits

Planes have momentum and physical constraints. We will classify planes into three distinct performance classes (Heavy, Medium, and Light) to ensure realistic acceleration, deceleration, turn, and climb behaviors.

| Metric | Light (e.g., Cessna 172) | Medium (e.g., Boeing 737) | Heavy (e.g., Boeing 777) |
| :--- | :--- | :--- | :--- |
| **Max Taxi Speed** | 15 kts | 20 kts | 20 kts |
| **Taxi Turn Speed** | 8 kts | 10 kts | 8 kts |
| **Takeoff Speed ($V_r$)** | 65 kts | 140 kts | 150 kts |
| **Climb Rate (ROC)** | 700 ft/min | 2,500 ft/min | 3,000 ft/min |
| **Descent Rate (ROD)**| 500 ft/min | 1,500 ft/min | 2,000 ft/min |
| **Flight Turn Rate** | $3^\circ$/sec (Std Rate) | $2^\circ$/sec | $1.5^\circ$/sec |

### Physics Interpolation Loop
For every physics tick (running at $10\text{Hz}$ or $20\text{Hz}$ independently of the 60fps render loops), the engine will interpolate current states toward target states:
*   `currentSpeed` increases/decreases towards `targetSpeed` by `accelerationRate * deltaTime`.
*   `currentHeading` rotates towards `targetHeading` by `turnRate * deltaTime`.
*   `currentAltitude` climbs/descends towards `targetAltitude` by `climbRate * deltaTime`.

---

## 3. Path-Following Steering (Ground Navigation)

Planes navigate taxiways by following a sequence of nodes: `Path = [NodeA, NodeB, NodeC]`.

```
                    Plane (Heading Vector)
                      O───►
                       \
                        \ (Steer Angle)
                         ▼
                       Node B (Target Node)
                        │
                        ▼
                       Node C
```

### The Steering Algorithm
1.  **Steer Target:** The aircraft's autopilot targets the coordinates of the first node in its queue (`NodeB`).
2.  **Distance Threshold:** When the plane's local `(x, y)` gets within a **5-meter radius** of the target node, the node is popped from the queue, and the plane targets `NodeC`.
3.  **Speed Control:** Before entering a node that requires a large heading change (a tight turn), the autopilot automatically throttles down to the **Taxi Turn Speed** (8–10 knots) to prevent "skidding" off the taxiway.

---

## 4. Separation & Collision Rules (Failure Conditions)

To drive challenging gameplay, the engine runs continuous proximity checks.

```
       ◄─────────────── 3 Nautical Miles (Horizontal) ───────────────►
       ┌─────────────────────────────────────────────────────────────┐
       │                                                             │ ▲
       │                        Plane A                              │ │ 1,000 feet
       │                                                             │ ▼ (Vertical)
       └─────────────────────────────────────────────────────────────┘
                                   Plane B
```

### 1. Ground Collisions
*   **Rule:** Aircraft on the ground must maintain a minimum wingtip clearance radius (e.g., 25 meters for Mediums, 40 meters for Heavies).
*   **Trigger:** If two ground planes' `(x, y)` distance is less than their combined safety radius, a **Ground Collision** is triggered, freezing the planes and ending the streak.

### 2. Airborne Separation (The 3NM/1000ft Rule)
*   **Rule:** Two airborne planes are considered separated if they satisfy **at least one** of these conditions:
    1.  **Horizontal Distance** is greater than **3 Nautical Miles** (approx $5,556$ meters).
    2.  **Vertical Separation** is greater than **1,000 feet**.
*   **Loss of Separation (Near-Miss):** If **both** conditions are breached (planes are closer than 3NM horizontally AND less than 1,000 ft vertically), the radar icons flash red, a loud alarm sounds, and the player loses safety score points.

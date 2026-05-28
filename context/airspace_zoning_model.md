# SkyControl: Airspace Zoning & Procedure Model

To deliver a highly realistic and authentic radar control experience, SkyControl models airspace surrounding airports not as a simple empty circle, but as a structured **3D Terminal Control Area (TMA / TRACON)**. This includes realistic altitude sectors, standard arrival/departure flight corridors, and restricted airspace zones.

---

## 1. The 3D Airspace Structure

Real-world terminal airspace is shaped like an **"upside-down wedding cake"** to allow low-altitude light aircraft to fly underneath commercial radar control without overloading the busy approach controllers.

```mermaid
graph TD
    subgraph TMA [Terminal Control Area: 40km Radius]
        OuterRing[Outer Sector: 30-40km \n Floor: 3,000 ft | Ceiling: 12,000 ft]
        InnerRing[Middle Sector: 15-30km \n Floor: 1,500 ft | Ceiling: 12,000 ft]
        CoreSector[Inner Sector: 0-15km \n Floor: Surface | Ceiling: 12,000 ft]
    end
```

### Data Model Schema (TypeScript)

```typescript
interface AirspaceSector {
  id: string; // e.g. "Approach East", "Tower Cylinder"
  polygonPoints: Coordinate[]; // 2D boundary on the map
  floorAltitude: number; // Floor in feet (e.g. 3000)
  ceilingAltitude: number; // Ceiling in feet (e.g. 12000)
  controllerType: 'TWR' | 'APP' | 'DEP'; // Tower, Approach, or Departure sector
}
```

---

## 2. Standard Instrument Procedures: STARs & SIDs

To keep traffic organized, aircraft do not fly random paths. They follow pre-defined instrument highways in the sky.

```
       [STAR Arrival Corridor]                    [SID Departure Corridor]
            (Alt: 10,000 ft)                           (Alt: 8,000 ft)
                   │                                          ▲
                   ▼                                          │
        Waypoint: WOODY (8,000 ft)                 Waypoint: BOSOX (6,000 ft)
                   │                                          ▲
                   ▼                                          │
        Waypoint: BLUEM (5,000 ft)                 Waypoint: LOGAN (3,000 ft)
                   │                                          ▲
                   ▼                                          │
       [Final Runway Approach] ◄────────────────────── [Runway Takeoff]
```

### 1. STARs (Standard Terminal Arrival Routes)
These are designated routing paths that channel arriving traffic from cruise flight down into the airport's terminal area.
*   **Arrival Fixes (Waypoints):** Entry gates situated at the outer boundary (40 km ring) of the radar screen (e.g., `WOODY` at 10,000 ft).
*   **Sequencing Paths:** A sequence of waypoints leading toward the final approach path.
*   **Altitude & Speed Restrictions:** Real-world charts specify restrictions (e.g., *"Cross BLUEM waypoint at or below 210 knots and exactly at 5,000 feet"*). Arriving planes in the simulation must meet these criteria.

### 2. SIDs (Standard Instrument Departures)
These are designated routing paths that channel departing traffic away from the runways and up into the high-altitude airways.
*   **Climb Corridors:** Flight paths immediately following runway departure to ensure planes climb away from arriving traffic.
*   **Departure Fixes (Exit Waypoints):** Designated waypoints on the outer 40 km boundary where the controller hands off the aircraft to regional Center controllers (e.g., `BOSOX` at 8,000 ft).

### TypeScript Procedure Schema

```typescript
interface FlightProcedureStep {
  waypointName: string;
  targetAltitude?: number; // Altitude constraint at this point
  targetSpeedKnots?: number; // Speed constraint at this point
}

interface FlightProcedure {
  id: string; // e.g., "WOODY1.ARR" or "BOSOX2.DEP"
  name: string; // e.g., "WOODY One Arrival"
  type: 'arrival' | 'departure';
  runwayDesignator: string; // Runway this procedure is tied to (e.g. "04L")
  steps: FlightProcedureStep[];
}
```

---

## 3. Restricted Airspace & Noise Abatement Zones

Real-world controllers must route planes to avoid noise-sensitive residential zones, heavy industrial areas, or military airspace.

*   **Noise Abatement Corridors:** Planes taking off must climb on specific headings before turning over land (e.g. in Boston Logan, planes departing Runway 09 must fly over Boston Harbor until passing 3,000 ft before turning over residential areas).
*   **Restricted Polygons:** The simulation will define "No-Fly Zones" or "Altitude Restricted Zones" on the map.
    *   **Gameplay Penalty:** If an aircraft penetrates a restricted airspace polygon below its designated ceiling altitude, the player receives an immediate visual warning and a penalty score.

### TypeScript Restricted Zone Schema

```typescript
interface RestrictedZone {
  id: string;
  name: string; // e.g. "Downtown Noise Restriction"
  boundary: Coordinate[]; // Polygon nodes
  floorAltitude: number; // e.g., 0 (surface)
  ceilingAltitude: number; // e.g., 3000 ft
  penaltyMessage: string;
}
```

---

## 4. Seeding Airspace Data (Boston Logan KBOS Example)

When loading KBOS, the game will load the airport graph AND its surrounding radar zoning:

```json
{
  "airspace": {
    "ceiling": 12000,
    "sectors": [
      {
        "id": "kbos_tma_core",
        "floorAltitude": 0,
        "ceilingAltitude": 12000,
        "controllerType": "APP",
        "boundary": [
          { "lat": 42.5000, "lng": -71.1500 },
          { "lat": 42.5000, "lng": -70.8500 },
          { "lat": 42.2000, "lng": -70.8500 },
          { "lat": 42.2000, "lng": -71.1500 }
        ]
      }
    ],
    "procedures": [
      {
        "id": "WOODY1_04L",
        "name": "WOODY One Approach Runway 04L",
        "type": "arrival",
        "runwayDesignator": "04L",
        "steps": [
          { "waypointName": "WOODY", "targetAltitude": 8000, "targetSpeedKnots": 240 },
          { "waypointName": "BLUEM", "targetAltitude": 5000, "targetSpeedKnots": 210 },
          { "waypointName": "LOGAN_I04L", "targetAltitude": 2000, "targetSpeedKnots": 180 }
        ]
      }
    ],
    "restrictedZones": [
      {
        "id": "downtown_noise",
        "name": "Boston Downtown Noise Abatement",
        "floorAltitude": 0,
        "ceilingAltitude": 3000,
        "boundary": [
          { "lat": 42.3615, "lng": -71.0580 },
          { "lat": 42.3520, "lng": -71.0500 },
          { "lat": 42.3580, "lng": -71.0700 }
        ],
        "penaltyMessage": "WARNING: Downtown noise abatement violation!"
      }
    ]
  }
}
```

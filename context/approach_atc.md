# PRODUCT.md — Web ATC Radar Simulator ("Endless ATC"-style)

> **Purpose of this file:** A complete, build-ready product + engineering spec for an agentic coding tool (Claude Code) to implement a browser-based air traffic control radar game modeled closely on *Endless ATC*. All numbers below come from the real game's published mechanics — treat them as the source of truth, not placeholders.

> **A note on "1:1":** Endless ATC is a polished commercial product. This spec reproduces its **core mechanics and feel faithfully** (radar UI, ILS approaches, separation, wake turbulence, dynamic difficulty, scoring). It does not copy its proprietary assets, exact airport data files, or audio. Build the engine first; airport realism and extra airports come later.

---

## 1. Product Summary

The player is a TRACON approach controller watching a 2D top-down radar. Aircraft spawn at the edge of a 30 NM airspace (arrivals) or at runways (departures). The player issues **heading, altitude, and speed** instructions plus **mode commands** (cleared for ILS approach, direct-to-fix, hold, SID) to:

1. Sequence **arrivals** onto a runway's ILS and land them.
2. Climb **departures** out of the airspace via their departure fix.
3. Keep every aircraft **separated** the entire time.

Every safe landing scores points. The better you do, the more traffic spawns and the more runways open — until you make a mistake. The loop is **endless**; the goal is a high score.

**Platform:** Web (desktop-first, mouse + keyboard; touch as a later enhancement). Runs fully client-side, no backend required for v1.

---

## 2. Tech Stack (recommended)

- **Rendering:** HTML5 `<canvas>` 2D context. The radar is vector line-art (circles, lines, text) — canvas is ideal and performant for 60 fps with dozens of moving targets. Do **not** use DOM elements per aircraft.
- **Language:** TypeScript (strict mode). Plain modules, no framework needed for the canvas. A thin layer of HTML/CSS for the sidebar/menus is fine.
- **Build:** Vite.
- **State:** A single authoritative game-state object updated by a fixed-timestep simulation loop, decoupled from the render loop.
- **Audio:** Web Speech API (`speechSynthesis`) for pilot readbacks; small WebAudio blips for alerts.
- **No external game engine.** Keep dependencies minimal so the agent can reason about the whole codebase.

---

## 3. Coordinate System & Units

- **World space** is measured in **nautical miles (NM)** on a flat plane. Origin `(0,0)` = airport reference point. `+x` = east, `+y` = north.
- The **airspace boundary** is a circle of radius **30 NM** (make this a per-airport constant; some real airports use ~37 NM).
- **Screen space:** a `pixelsPerNM` zoom factor maps world→screen. Support pan and zoom (mouse wheel = zoom, drag empty space = pan). Default zoom shows the full 30 NM circle plus margin.
- **Headings:** degrees, `0/360 = North`, `90 = East`, clockwise — i.e. compass bearings, **not** math angles. Write helper conversions and unit-test them.
- **Altitude:** feet. Displayed on labels as feet ÷ 100 (e.g. `3000 ft → "30"`, `FL130 → "130"`).
- **Speed:** knots. Distinguish **IAS** (indicated airspeed, what the player commands) from **ground speed** (what's displayed on the label). See §7.4.
- **Time:** simulation runs in real seconds. Support a global time multiplier (1×, 2×, 4×… up to ~10×, plus a press-and-hold 20× fast-forward).

---

## 4. Core Loop / Architecture

```
main()
 ├─ load airport config
 ├─ init game state (empty traffic, skill = starting value)
 ├─ requestAnimationFrame(renderLoop)   // draws current state at display refresh
 └─ fixed-timestep simulationLoop(dt)    // dt e.g. 1/30s, scaled by time multiplier
       ├─ spawnTraffic()        // based on current skill / flow
       ├─ for each aircraft: stepFlightModel(dt)
       │     ├─ apply pending commands after pilot delay
       │     ├─ update heading (turn-rate limited by bank/speed)
       │     ├─ update altitude (climb/descent rate, expedite)
       │     ├─ update speed   (accel limited; auto speed rules)
       │     ├─ ILS capture logic (localizer then glideslope)
       │     ├─ advance position by ground-speed vector (+ wind)
       │     └─ state transitions (landed / go-around / divert / handoff)
       ├─ checkSeparation()     // conflicts + incidents
       ├─ checkWakeTurbulence() // on localizer only
       ├─ updateScore()
       └─ cullAircraft()        // landed / departed / diverted
```

**Separate the flight model from rendering.** All physics live in pure functions over the state object so they can be unit-tested headlessly.

---

## 5. Data Models

### 5.1 Aircraft

```ts
type WeightCategory = 'L' | 'M' | 'H' | 'J'; // Light, Medium(no tag), Heavy, Super(J)
type FlightKind = 'arrival' | 'departure';
type NavMode = 'heading' | 'direct' | 'ils' | 'loc' | 'hold' | 'sid';

interface Aircraft {
  id: string;
  callsign: string;          // e.g. "KLM4302", "BAW23A"
  kind: FlightKind;
  weight: WeightCategory;
  type: string;              // ICAO type, e.g. "B738", "A320", "B77W"

  // kinematic state
  pos: { x: number; y: number };     // NM
  altitude: number;                  // ft (actual)
  heading: number;                   // deg (actual track of the nose)
  ias: number;                       // kt (indicated)
  groundSpeed: number;               // kt (derived: ias + altitude offset + wind)
  verticalSpeed: number;             // ft/min (derived this tick)

  // commanded targets (what the player set)
  cmdAltitude: number;
  cmdHeading: number;                // ignored when in ils/direct/hold/sid mode
  cmdIas: number;
  turnDirection?: 'L' | 'R' | null;  // forced turn direction (else shortest)
  expedite: boolean;

  navMode: NavMode;
  directTarget?: string;             // beacon id when navMode==='direct'
  assignedRunway?: string;           // runway id for ILS
  ilsArmed: boolean;                 // cleared for approach (ILS or LLZ)
  llzOnly: boolean;                  // localizer only, no glideslope capture
  sidEnabled: boolean;               // departures
  destination?: string;              // secondary-airport tag (e.g. "RD"); undefined = main

  // command pipeline (pilot delay)
  pendingCommands: PendingCommand[];

  // status
  status: 'inbound' | 'established' | 'landed' | 'goaround'
        | 'departing' | 'handedoff' | 'diverted' | 'delayed';
  spawnTime: number;
  underControl: boolean;             // false until player first selects / on handoff
  attention: boolean;                // flashing blue ring until selected
}
```

### 5.2 Airport / Airspace config

```ts
interface AirportConfig {
  icao: string;                 // "EDDF"
  name: string;                 // "Frankfurt"
  boundaryRadiusNM: number;     // 30 (default)
  elevationFt: number;
  transitionAltitudeFt: number; // above this, altitudes shown as flight levels
  magneticVariation: number;

  runways: Runway[];
  beacons: Beacon[];            // VORs, fixes, locators
  entryPoints: EntryPoint[];    // where arrivals spawn, with inbound beacon
  departureFixes: string[];     // beacon ids departures route to
  restrictedAreas: RestrictedArea[];

  wind: { dirDeg: number; speedKt: number }; // surface wind; scales with altitude
}

interface Runway {
  id: string;                   // "07L"
  thresholdPos: { x: number; y: number };
  headingDeg: number;           // runway course
  lengthNM: number;
  glideslopeDeg: number;        // default 3.0
  localizerRangeNM: number;     // default 25 (from touchdown)
  glideslopeRangeNM: number;    // default ~10–12
  active: boolean;
  mode: 'landing' | 'takeoff' | 'both';
  towerFreq?: string;
}

interface Beacon {
  id: string;                   // "PAM", "SUGOL"
  pos: { x: number; y: number };
  kind: 'vor' | 'fix' | 'locator';
  holdHeadingDeg?: number;
}

interface RestrictedArea {
  polygon: { x: number; y: number }[];
  minAltitudeFt: number;        // e.g. 3000 — no aircraft below unless exempt (RD tag)
  exemptDestinations?: string[];
}
```

---

## 6. Aircraft Labels (data block)

Default **3-line label** drawn next to each target (offer 2-line and 4-line styles later). Lines:

1. **Callsign** — e.g. `KLM4302`.
2. **Current altitude** + **selected altitude**, each in feet ÷ 100. Show selected only when different (e.g. climbing `070→130`). Prefix `F` for flight level vs `A` for altitude if you implement the transition-altitude distinction.
3. **Ground speed (kt)** + **weight tag** (`L` / none / `H` / `J`) + **mode** (`ils` / `direct` / `hold`).
4. *(optional 4th line)* **destination** tag, only if not the main airport (e.g. `RD`).

Aircraft **not under control** show a smaller 2-line label. Aircraft wanting attention show a **flashing blue ring** until selected. A small **leader line** (heading/velocity vector) extends from the target; its length is configurable (e.g. 30s/1min of travel).

Render targets as a small icon/dot with a configurable target symbol; heavies are visually identical but tagged `H`/`J`.

---

## 7. Flight Model (the heart of it — get these right)

### 7.1 Turning
- Planes bank to a **maximum of ~25–30°**. Turn rate is therefore **speed-dependent**, not constant. At low speed the effective rate is ~3°/s; at 200+ kt the radius is noticeably larger.
- Standard turn = shortest direction unless the player forces L/R. Support commanded turns **greater than 180°** (up to 360°) when a direction is forced.
- Compute turn rate from bank angle: `rate = (g * tan(bank)) / V` then convert to deg/s. Cap bank at the limit. Render an optional **curved predictor line** showing the turn radius.

### 7.2 Altitude
- Climb/descent at a per-type vertical speed (e.g. ~1500–2500 ft/min nominal). **Expedite** (double-click the alt control at its limit) increases vertical speed.
- Heavies climb/descend slightly slower.
- Respect the transition altitude for label display.

### 7.3 Speed envelope & automatic speed rules (critical for realistic flow)
Implement these as ordered rules; a manual speed command overrides the *automatic reductions to 220* but the localizer reductions still apply:

- Max **250 kt below FL100**; up to **300 kt at/above FL100**.
- Within **15 NM** of the field, planes slow to **220 kt** (unless the player already set a speed — then that speed holds until the localizer).
- On localizer intercept: reduce to **200 kt**.
- At **6 NM** from runway: reduce to **160 kt**.
- At **4 NM**: reduce to **final approach speed** (per-type; heavies higher). Allow the player to reduce earlier in 10-kt steps.
- Departures auto-accelerate (above FL100) unless a manual speed is set.

### 7.4 Ground speed vs IAS & wind
- Displayed **ground speed > commanded IAS**, with an offset that increases with altitude (air density). Model a simple multiplier, e.g. `groundSpeed = ias * (1 + k*altitude)` plus the wind vector component along the track.
- Wind speed/direction scale with altitude (stronger and slightly veered aloft). The label speed is ground speed; when the player changes speed, briefly show the new **target IAS in yellow**.

### 7.5 Pilot delay / command lead time
- Every command enters `pendingCommands` and is **applied after a configurable delay** (default a few seconds; expose a `DELAY` setting). Real aircraft don't react instantly — this delay is core to the game's feel and difficulty.
- Commands are committed on **OK / deselect**; a Cancel reverts un-OK'd changes.

---

## 8. ILS Approach Logic (the key skill)

An aircraft captures and lands via ILS only when **all** of these hold:

1. **ILS mode is armed** (player pressed ILS / cleared for approach).
2. It **intercepts the localizer at a shallow angle** — **≤ 60°** relative to runway heading in-game (real-life norm is 30°). Steeper intercepts or intercepting from the wrong side → no capture / overshoot.
3. It is **low enough to intercept the glideslope from below.** The required distance scales with altitude. Draw **blue range circles** marking where 2000 / 3000 / 4000 ft intercept the 3° glideslope. The plane must be **at or below** the glideslope, never above.

Sequence: capture **localizer first** (lateral), then **glideslope** (vertical descent path). Once correctly established, the plane **auto-follows the ILS to touchdown** — the player no longer steers it. Provide **yellow guide arrows** in-game showing valid intercept geometry (fly via the arrows at ~2000 ft with ILS armed).

**Failure / recovery states:**
- **Too high on the glideslope** (above the path) → eventually `MISSED APPROACH`: ILS disarms, player must re-vector lower to recapture from below.
- **Runway still occupied** when a plane is about to land → `GO-AROUND`: climbs to ~2000 ft, ILS disarms, needs new vectors with more spacing behind the leading aircraft. A short separation grace period applies right after a go-around.
- **LLZ-only mode** (`LOC`): captures the localizer but **not** the glideslope (used for parallel approaches / level intercepts). Player must later arm full ILS.
- **ILS\*** (cross one localizer to intercept the next) for parallel-runway distribution — implement after basics work.

**Localizer beacon (locator):** some runways have a fix on the ILS path; aircraft can fly **direct** to it and continue straight ahead (no hold there).

**Scoring trigger:** when a plane is **established on the ILS**, it's automatically handed to tower and you score skill points (see §11). You do **not** need to manually hand off.

---

## 9. Departures

- Spawn at a runway, take off, and **set their own heading and speed**; they only need an **altitude clearance to climb** (target **FL130**).
- **SID mode** on by default: the plane routes to a randomly assigned **departure fix** then continues ahead. Disabling SID lets the player give a manual heading but **caps the climb at FL90** — re-enable SID and continue the climb so the plane is **above FL90 before crossing the boundary**.
- Leaving the boundary **at or below FL90** counts as a **diversion** (penalty). So does any aircraft leaving the 30 NM boundary unintentionally.
- Departures may be handed off automatically once safely high; manual handoff optional.
- (Airport-specific: some fields launch departures on a heading first, requiring the player to enable SID to clear them to the fix — a later refinement.)

---

## 10. Separation & Conflict Detection

### 10.1 Standard minima
- **3 NM horizontal AND 1000 ft vertical.** A **conflict/incident** occurs when two aircraft's **3 NM rings overlap *and* their altitude difference is < 1000 ft.**
- Draw the **3 NM ring** (radius 3 NM → so each aircraft has a 1.5 NM "bubble"; the rule is centers within 3 NM). Implement as: `horizontalSeparation < 3 NM && |Δalt| < 1000 ft → incident`. Provide a visual + audio alarm; the alarm can be inhibited while the offending plane is selected.

### 10.2 Reduced minima (do NOT penalize in these cases)
1. Both planes **established on *different* ILS localizers** (`LOC` status) → independent parallel approaches allowed.
2. One or both planes **below 1600 ft**.
3. Two **departures on divergent headings ≥ 15°** apart.
4. **Briefly after a go-around** — a grace window to regain separation.

### 10.3 Parallel approaches
- Maintain **≥ 1000 ft vertical** until **both** aircraft are established on their respective localizers (e.g. intercept one runway at 2000 ft, the other at 3000 ft). After both are on the LOC, rule 10.2(1) means overlapping rings are fine as they descend.

---

## 11. Wake Turbulence

- Six weight categories (RECAT-style); in this build use at least **L / M / H / J**. Heavier-ahead-of-lighter needs **extra spacing**.
- Wake separation **only applies to aircraft on the localizer** (in trail on final).
- Draw an **arc behind a leading aircraft** showing the required safe distance for the trailing type. The distance depends on the **pair** of categories (e.g. medium behind heavy needs more than heavy behind heavy).
- If the trailing aircraft **infringes by more than ~1 NM**, risk a **go-around**.

Provide a small lookup table of required wake distances keyed by `(leader, follower)` category. Start with sensible values (e.g. M-behind-H ≈ 5 NM, H-behind-H ≈ 4 NM, anything-behind-J larger) and tune.

---

## 12. Scoring & Difficulty (the "endless" engine)

- **Skill score** is a single float. The number of aircraft you control simultaneously ≈ the skill value (skill 8.4 → ~8 planes). It also gates how many **runways** are active and the overall **traffic rate**.
- **Gaining points:** each plane successfully established on the ILS / handed to tower scores skill points — **at least 0.1 per plane**, scaled by current skill.
- **Game score** = the **maximum skill value reached this game** (it never decreases even if skill drops). **High score** = best game score ever (persist to `localStorage`).
- **Losing skill points** when planes:
  1. fly too close (overlapping 3 NM rings, <1000 ft apart),
  2. **divert** (leave the 30 NM boundary; departures leaving at/below FL90 count),
  3. **abort the approach** (go-around: runway occupied, too high, etc.),
  4. are **delayed** (not landed within ~30 minutes).
  - Use the real penalty model: a roughly **constant ~0.5 reduction per separation incident** plus a small duration component.
- **Dynamic difficulty:** as skill rises, spawn rate rises and more runways open automatically. Spawning is randomized; runway configuration is chosen at game start.

**Game modes (build Normal first):**
- **Normal:** traffic adapts to skill; high scores/goals enabled.
- **Custom:** fix or cap the skill (fewer planes, relaxed) OR set a constant **flow** (planes/hour, optionally varying between a min/max for inbound/outbound peaks). Disables high scores.
- **Scenario** (later): hand-authored non-random traffic to clear without mistakes, sometimes timed.

---

## 13. Controls & Input

### 13.1 Selection & sidebar
- **Click** a target to select it; selected plane shows full label + a control sidebar (Altitude ±, Speed ±, Heading ±/L/R, ILS, DCT, SID/HOLD, OK, Cancel).
- Changes apply on **OK** or **deselect**; **Cancel (C)** reverts; **C again** deselects.

### 13.2 Mouse gestures (match the original)
- **Drag from an aircraft** → set heading.
- **Drag from aircraft onto a beacon** → `DIRECT` to that fix (DCT illuminates).
- **Drag from a selected VOR** → set the heading to fly **after** reaching the beacon.
- **Left+right click together** → toggle ILS.
- **Scroll wheel** → change altitude; **right-button + scroll** → change speed; **scroll-wheel click** → OK/handover.
- **Right-click drag** → distance/bearing measuring tool between two points (anchorable to planes).
- **Long-press DCT** → HOLD at current position. Reaching a fix with no further instruction → enter a **holding pattern** (avoid; causes delays).

### 13.3 Keyboard command line (power-user input)
Type a **callsign** (space to autocomplete) to select, then space-separated commands:
- `A30` = altitude 3000 ft · `S170` = speed 170 kt · `H090`/`L`/`R` = heading/turn dir
- `DPAM` = direct to fix PAM · `T360` = after the fix, fly heading 360
- `I` = cleared approach (ILS) · `LOC`/`LLZ` = localizer only · `HO` = hold · `E` = expedite
- Plus hotkeys: simulation speed, heading-line length, `Tab` to cycle planes (priority to flashing), PageUp/Down altitude, arrows for speed/heading, ILS toggle, Enter = confirm.

---

## 14. Audio / Readbacks (immersion layer)

- On each accepted command, the pilot **reads it back** via TTS (Web Speech API): callsign + the instruction (e.g. "Climb flight level one three zero, KLM four three zero two"). Vary phrasing slightly; speed up speech when the time multiplier is high.
- Handoff calls when switching to tower/next controller (optional; can be automatic).
- Separation-conflict **alarm** tone; inhibit while the conflicting plane is selected.
- Optional radio-noise bed for atmosphere. Keep all audio behind a sound toggle with volume control.

---

## 15. Rendering / UI Spec

- **Background:** dark radar screen (default dark mode), high-contrast option. Draw the **30 NM boundary circle**, optional **range rings**, coastlines/airport background as light vector lines.
- **Runways:** thick blue line at the threshold; thin blue **ILS path** extending out; **blue altitude circles** (2000/3000/4000 ft glideslope intercept markers); inactive runways in grey.
- **Beacons:** small grey circles with labels; **restricted areas** as outlined polygons with their min-altitude label.
- **Yellow guide arrows** showing valid ILS intercept paths.
- **Aircraft:** target symbol + leader line + data-block label; flashing blue ring for attention; **wake arc** behind localizer traffic; **curved turn predictor** for the selected plane.
- **HUD:** top-left current **score** + **high score**; sidebar with skill, wind, flow rate (planes/hr over a ~20 min window), landing/takeoff counters, and menu buttons (Traffic, Runways, Display, Sound, Speed, Realism).
- **Pause screen** (Esc) shows plane-track history.

---

## 16. Build Order (phased — implement and verify each before moving on)

**Phase 0 — Skeleton.** Vite + TS project. Canvas that renders the 30 NM boundary, range rings, and one runway with its ILS line and altitude circles. Pan/zoom. Coordinate + heading helpers with unit tests.

**Phase 1 — One controllable aircraft.** Spawn one arrival. Implement the flight model: heading (turn-rate limited), altitude (climb/descent), speed (with IAS↔ground-speed). Click to select; sidebar with Alt/Speed/Heading + OK/Cancel. Pilot delay. Draw the 3-line label and leader line.

**Phase 2 — ILS & landing.** Localizer-then-glideslope capture with the ≤60° / from-below rules. Auto-follow to touchdown. Missed-approach + go-around states. This is the core skill loop — get the geometry right with tests.

**Phase 3 — Multiple aircraft + separation.** Random arrival spawning. Separation detection (3 NM / 1000 ft) with reduced-minima exceptions, visual + audio alarm. Conflict rings.

**Phase 4 — Departures.** Takeoff, SID mode to a departure fix, climb to FL130, boundary/diversion rules.

**Phase 5 — Scoring & dynamic difficulty.** Skill score, point gain/loss, game/high score persistence, spawn-rate scaling, multi-runway opening. Delay penalty.

**Phase 6 — Wake turbulence.** Categories, trailing arcs on final, infringement → go-around.

**Phase 7 — Polish.** TTS readbacks, keyboard command line, mouse gestures (drag-to-heading, drag-to-beacon, measuring tool, holding patterns), time multiplier + fast-forward, menus, custom/flow mode, dark/contrast themes, pause screen with tracks.

**Phase 8 — Airports.** Start with **one simple airport** (a Frankfurt-like single/parallel-runway field is the recommended beginner layout — avoid multi-airport TRACONs like NYC/London/Paris at first). Define an airport-config format (JSON) so new airports are pure data. Add secondary-airport (`RD`-style) and restricted-area support last.

---

## 17. Default Constants (starting values — tune later)

| Constant | Value |
|---|---|
| Airspace boundary radius | 30 NM |
| Localizer usable range | 25 NM from touchdown |
| Glideslope angle | 3.0° |
| ILS max intercept angle | 60° (game) / aim toward 30° |
| Glideslope intercept circles | 2000 / 3000 / 4000 ft |
| Standard separation | 3 NM horizontal, 1000 ft vertical |
| Reduced-separation alt floor | 1600 ft |
| Speed: below FL100 | ≤ 250 kt |
| Speed: at/above FL100 | ≤ 300 kt |
| Auto-slow inside 15 NM | 220 kt |
| Localizer intercept speed | 200 kt |
| Speed at 6 NM | 160 kt |
| Speed at 4 NM | final approach speed (per type) |
| Departure climb target | FL130 |
| SID-off climb cap | FL90 |
| Departure boundary min | above FL90 |
| Max bank angle | 25–30° |
| Nominal climb/descent | ~1500–2500 ft/min |
| Delay penalty threshold | ~30 min in airspace |
| Separation penalty | ~0.5 skill + small duration term |
| Min points per landing | 0.1 (scaled by skill) |
| Pilot command delay | configurable, few seconds |

---

## 18. Acceptance Criteria (definition of done for v1)

1. An arrival can be vectored, descended, given ILS clearance, and **lands** when intercepting the localizer ≤60° from below; landing scores points.
2. A plane that intercepts **too steep** or **from above** the glideslope does **not** capture (overshoot / missed approach), matching §8.
3. Two aircraft within **3 NM and <1000 ft** trigger a separation incident with alarm; the documented **reduced-minima exceptions** do **not** penalize.
4. Departures climb to **FL130 via SID** and exit the boundary above FL90 without a diversion penalty.
5. **Wake arcs** appear behind localizer traffic and an infringement can force a go-around.
6. **Skill score** rises with good performance, drives traffic volume and runway count, and **high score persists** across reloads.
7. Player can control aircraft via **sidebar, mouse gestures, and the keyboard command line**, with **pilot delay** between command and response.
8. Pilots **read back** commands via TTS.
9. Runs at ~60 fps with 15+ simultaneous aircraft on a typical laptop.

---

## 19. Out of Scope for v1 (note for later)

Weather (wind aloft beyond a simple model, clouds, pressure/QNH), all 9 real airports with accurate data, scenario campaigns with rewind, custom-airport text-file importing, multi-touch/mobile layout, frequencies/handoff realism, pilot-error simulation, achievements/goals. Architect cleanly so these can be added without rework (especially: airports-as-data, and a pluggable command pipeline).

---

## 20. References (real-game mechanics this spec is based on)

- Official Endless ATC instructions/manual (startgrid) — ILS interception rules, separation minima and reduced-minima cases, speed envelope, wake/RECAT, scoring, departure/SID behavior, controls.
- Steam/itch.io store descriptions — TRACON radar concept, dynamic traffic, 9-airport scope.

> When in doubt about a number or rule, prefer the values in this document; they are transcribed from the published game mechanics.


# Product Requirements Document (PRD): Endless ATC Web Recreation

## 1. Overview
This document outlines the architecture, mechanics, and UI/UX requirements for a 1:1 web-based recreation of the *Endless ATC* simulation game. Given your background as an AvGeek and Director of Premier Wings, this simulation prioritizes accurate aviation terminology and procedures (e.g., SIDs, ILS glide slopes, heavy wake turbulence). For the tech stack, we recommend a **Next.js** framework with **React** for the UI and **HTML5 Canvas** (or WebGL) for rendering the high-performance radar loop, aligning with your current stack transition.

## 2. Core Game Engine & Environment

### 2.1 Perspective & Viewport
* **Radar Screen:** A 2D top-down, classic ATC radar display (dark background, green/blue vector lines).
* **Scale & Scope:** The radar viewport represents a 30-nautical-mile (nm) radius around the primary airport.
* **Zoom/Pan:** Users must be able to zoom in/out (mouse wheel) and pan across the airspace to manage dense traffic scenarios.

### 2.2 Navigation Infrastructure
* **Primary Airport:** Located centrally, with defined runway orientations (e.g., Runway 27, 36L).
* **NAV Aids:** Physical waypoints (e.g., `SPY`, `LEKO`) used for vectoring aircraft.
* **Instrument Landing System (ILS):**
    * **Localizer:** A horizontal extension from the runway center indicating the approach path.
    * **Glide Slope:** Defined intercept points marked by descending minimum altitude requirements (e.g., 4,000ft -> 3,000ft -> 2,000ft). Aircraft must be below or at these altitudes to capture the slope.

### 2.3 Data Visualization (Aircraft UI)
* **Target Representation:** Each aircraft is represented by an icon, surrounded by a separation ring, and a trailing vector line indicating current heading.
* **Data Tag:** A clickable label accompanying each aircraft displaying:
    * **Callsign:** e.g., KLM4302 (marked 'H' for Heavy).
    * **Altitude:** Current and cleared altitude in hundreds of feet (e.g., `070` for 7,000ft).
    * **Speed:** Current and assigned speed in knots (e.g., `250`).
    * **Heading:** Current trajectory (e.g., `275` degrees).
    * **Aircraft Type:** e.g., B737, B777.

## 3. Key Mechanics & Logic

### 3.1 The Primary Objective: Separation Standards
* **The "Deal":** A separation incident (failure state) occurs if the separation rings of two aircraft overlap while they are within 1,000 feet of altitude of each other.
* **Vertical Separation:** Aircraft must maintain at least 1,000 feet of vertical separation if their lateral rings intersect.

### 3.2 Aircraft Control System
Players interact with aircraft by clicking their data tags and opening a command menu to alter:
* **Altitude Control:** Command descent/climb (e.g., descend to 3,000ft).
* **Speed Control:** Adjust knots to compress or expand the traffic flow (e.g., slow a leading aircraft to 160 knots, maintain a trailing aircraft at 220 knots).
* **Heading Control (Vectoring):** Issue specific compass headings (0-360 degrees) or command "Direct To" a specific NAV aid.

### 3.3 Flight States
* **Arrivals:** Spawn at the 30nm boundary. They must be vectored safely around other traffic, stepped down in altitude, and aligned with the localizer to capture the glide slope. Once established on the ILS, the AI takes over landing.
* **Departures:** Spawn on the runway (color-coded, e.g., pink). The player must clear them for takeoff and assign a Standard Instrument Departure (SID) route and maximum altitude to hand them off to the next center.

## 4. Advanced Features

### 4.1 Airspace Restrictions
* **Altitude Floors:** Certain zones (e.g., over secondary airports like Rotterdam or specific city areas) have hard altitude minimums (e.g., "Flight Level 30" or 3,000ft). Routing an aircraft below this minimum in restricted airspace triggers a penalty/incident.

### 4.2 Wake Turbulence Simulation
* **Heavy Aircraft ('H'):** Large aircraft (e.g., B777) generate significant wake turbulence.
* **Extended Separation:** A visual marker trails behind Heavy aircraft. Following aircraft must maintain a larger separation distance to avoid turbulence destabilization.

### 4.3 Dynamic Difficulty & Scoring
* **Ramping Traffic:** The game gradually spawns more simultaneous arrivals and departures as time progresses and planes are successfully landed.
* **Multi-Airport Management:** Advanced difficulty levels introduce secondary airports within the same airspace, requiring interleaved arrival streams.

### 4.4 Immersive Audio/Read-back
* **Radio Comms:** When a command is issued, simulated pilot audio reads back the instruction (e.g., "KLM4302 descending 3,000, heading 270"). This adds to cognitive load and immersion.

## 5. Technical Considerations for Implementation

* **State Latency (Lead Time):** Aircraft do not react instantly. The engine must simulate the physical delay between issuing a command (e.g., turning from 090 to 270) and the aircraft executing the maneuver based on standard turn rates and deceleration models.
* **Pathfinding/Guidance AI:** The system needs logic to detect when an aircraft is "established" on the localizer and automatically adjust its heading and speed for the final descent.
* **Collision Detection:** An efficient 2D spatial partitioning system (like a Quadtree) is highly recommended to continuously check for separation ring overlaps across dozens of moving entities.

---
*Generated for precise 1:1 Recreation.*
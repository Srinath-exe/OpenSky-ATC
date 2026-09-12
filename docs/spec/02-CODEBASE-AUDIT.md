# SkyControl (`/root/atc`) — Principal Engineering Audit

Scope: the live game = `/` (airport picker), `/atc` (game), `/settings`; engine in `src/lib/sim/*`; data loaders `src/lib/osmAirport.ts`, `src/lib/airspace/eairport.ts`. Stack: Next 16.2 / React 19.2 / TS 6.0 / MapLibre 5.24 (`package.json:13-27`). `tsc --noEmit` passes clean. Every engine claim below marked **[verified]** was reproduced by compiling `src/lib/sim/*` + `osmAirport.ts` + `eairport.ts` to CommonJS and driving `SimEngine.update()` headlessly against the real `public/maps/osm/*.geojson` and `public/airspace/*.txt`.

---

## 1. Architecture map

### 1.1 Data flow

```
public/maps/osm/<ICAO>.geojson ──fetch──▶ buildOsmAirport()            osmAirport.ts:75-173
   (aeroway taxiway/runway LineStrings,      nodes Map<key,OsmNode{edges}>, gates[], runways[{ref,ends[2]}],
    gate/stand Points, fc.center)            taxiwayNames[], taxiwayNodes Map<ref,nodeIds[]>
                                                    │
public/airspace/<ICAO>.txt ──fetch──▶ parseEndlessAirport()             eairport.ts:123-212
   (Endless-ATC format: [airspace] radius/     EAirport{airspace{radiusNM,center,beacons},runways[ILS],
    center/beacons, [airport1] runways/        entryPoints[weighted], departures, approaches, areas}
    entrypoints, [departureN], [areaN])                │
                                                       ▼
                             SimStore.load()  simStore.ts:111-159
                               new SimEngine(osm)           engine.ts:63-66  (LocalProjection at osm.center)
                               setActiveRunwayEnds / setRunwayWeightAllow  engine.ts:76-86
                               buildRadar(airspace) → RadarScene (XY)      simStore.ts:174-194
                               setAirspaceConfig({radiusM, ilsRunways, beacons})  engine.ts:68-72
                               spawn 4 departures + 3 arrivals            simStore.ts:149-155
                               start() RAF loop                           simStore.ts:210-240
                                                       │
                     ┌─────────────────────────────────┼──────────────────────────────┐
                     ▼                                 ▼                              ▼
          ApproachView (canvas)             GroundView (MapLibre + canvas)      /atc page.tsx sidebars
          ApproachView/index.tsx:20-397     GroundView/index.tsx:27-109         useSyncExternalStore snapshot
          reads sim.engine.aircraft each    reads sim.engine.aircraft each RAF  atc/page.tsx:18-28
          RAF frame (own RAF)               frame (own RAF), e.proj.toLngLat
```

The single source of truth is the `SimStore` singleton (`simStore.ts:55-243`) exported as `sim` and pinned on `window.__atcSim` (`simStore.ts:246-247`, HMR-safe). Views never own state; they only read `sim.engine`, `sim.radar`, `sim.selectedId` inside their own RAF loops.

### 1.2 Sim loop

* **Driver**: `SimStore.start()` → one `requestAnimationFrame` loop that never stops (`simStore.ts:210-240`; `stop()` at `:242` is never called). Per frame: `dt = min((now-last)/1000, 0.1)`; if `paused` → skip; `engine.update(dt * rate)` (`:216-218`); routes events to the radio log (`:219-222`); auto-spawns when `engine.time ≥ nextSpawn && aircraft.length < cap`, `cap = min(14, ceil(skill)+2)`, next spawn in 5–13 s sim time, 55 % departure (`:224-228`); persists high score (`:230-233`); clears dead selection (`:235`); `emit()` to React every 6th frame (`:237`).
* **Engine fixed step**: `SimEngine.update(realDt)` (`engine.ts:496-509`): `acc += min(realDt, 0.25)`; while `acc ≥ FIXED (1/30)` and `steps < MAX_SUBSTEPS (6)`: `applyNavTargets()` → `applyTraffic()` → `stepAircraft()` per aircraft → `handleTransitions()`; `time += 1/30`. `checkSeparation()` runs once per frame, not per substep (`:506`). Returns and clears `pendingEvents`.
* **Rate**: `sim.setRate(1|2|4)` multiplies dt (`simStore.ts:108`). At ≥4× on a slow frame the 6-substep cap silently slows the sim; `acc` is never clamped (see §4).
* **Tab hidden**: RAF stops → sim freezes (no wall-clock catch-up).

### 1.3 Projection

`LocalProjection` (`sim/projection.ts:21-41`): equirectangular scaled at the OSM `fc.center` lat: `x = (lng−refLng)·R·cos(refLat)·π/180`, `y = (lat−refLat)·R·π/180`; metres, x east, y north. Headings are compass degrees (`headingTo` `:56-58`, `advance` `:66-68`). `engine.nodeXY()` caches node projections (`engine.ts:92-100`). Everything downstream (ILS, separation, radar, ground canvas) is in this XY. Origin `(0,0)` = OSM airport centre — **not** the Endless-ATC airspace centre (see bug B3).

### 1.4 Ground path construction

1. `findPath(air, startId, goalId)` (`osmAirport.ts:192-234`): A* over `OsmNode.edges`; heuristic = haversine metres; runway edges cost ×40 (`:223`); open set is a `Set` scanned linearly per pop (`:210-213`, O(n) per pop); guard 200k iterations.
2. `routeVia(startId, viaNames, goalId)` (`engine.ts:249-265`): for each taxiway designator picks the *nearest node on that taxiway* to the current point, chains `findPath` segments.
3. `pathFromNodes(ids, holdAtEnd)` (`engine.ts:123-128`) → `buildPath(raw, kind, holdAtEnd)` (`:116-122`): `dedupeBacktracks(raw, 3)` (drops <3 m steps, pops spike vertices with turn >150°, `projection.ts:84-97`) → `resample(8 m taxi / 30 m runway+approach)` (`:101-120`) → `chaikin(4 iters taxi / 3 otherwise)` (`:123-137`) → `arcLengths` (`:140-144`). `DrivePath{pts,cum,total,kind,holdAt}` (`types.ts:29-35`); `holdAt = total` when `holdAtEnd`.
4. Following: `follow()` (`aircraft.ts:69-94`) advances `distAlong` by `speed·dt`, samples `sampleAlong(pts,cum,d)` (linear scan `projection.ts:147-157`) for pos+tangent, limits heading change to `min(100°/s·dt, 5.5°/m·moved + 0.05)` so a stopped aircraft cannot pivot; brakes for `holdAt` using `brakingDistM` (`:64-67`), clamps `distAlong ≤ holdAt−7 m` (`:84`). `taxiTargetSpeed()` (`:96-110`) looks 14/28 m ahead for bend and blends between `maxTaxiSpeed` and `0.7·taxiTurnSpeed`; slows into the path end only when `holdAt == null`.
   Point density: a 1.7 km taxi path becomes **3 408 pts (2 pts/m)** **[verified]**; a landing path ~5 000 pts.

### 1.5 ILS

`ILSRunway{name,thrXY,rwdHdg,locCourse,gsDeg,thrElevFt}` (`ils.ts:18-25`) built from the airspace file in `simStore.ts:133-140` (`thrElevFt` hard-coded 0). Per tick in `applyNavTargets()` (`engine.ts:573-622`):
* LOC capture: `canCaptureLoc` (`ils.ts:74-79`): `along > 200 m`, `|locDev| < 1.5°` (`locDevDeg` = atan2(cross, max(500,along)), `:46-51`), intercept ≤ 60°; rejected while `aboveGlideslope` (>200 ft above GS, `:83-87`). On capture speed clamps to ≤200 kt (`engine.ts:586-589`).
* Tracking: `targetHeading = locTargetHdg` = `rwdHdg − clamp(2.5·dev, ±30°)` (`ils.ts:90-94`).
* GS capture from below: `alt ≤ gsAlt+50 && along > 500 m` (`engine.ts:601-605`), then `targetAltitude = gsAltFt(along)` (`:619`, `ils.ts:54-57`, 3° ⇒ 318 ft/NM). Speed schedule on GS: <6 NM → ≤160 kt, <4 NM → `approachSpeed` (`engine.ts:609-615`). `navMode 'loc'` suppresses GS capture (`:601`) but nothing ever sets `'loc'` (dead nav mode).
* Landing hand-off in `handleTransitions()` (`engine.ts:685-710`): when `gsCaptured && ilsCaptured && along < 8 NM`: if `runwayOccupied` → go-around, else build approach path `[pos, OSM threshold, OSM far end+500 m]`, `thresholdDist = gsDistM(altitude)` (`ils.ts:60-63`), phase → `landing`. `stepLanding()` (`aircraft.ts:205-216`) then follows the path at `approachSpeed`, sets `altitude = remain·tan3°` and flips to `rollout` at `distAlong ≥ thresholdDist−1`. Rollout decel = `decelerationRateAir·6` (`:220`); at `speed < 22 kt` the engine routes it to its gate (`engine.ts:726-739`).
* Second go-around check at `< 2 NM` while `landing` (`engine.ts:713-723`) — **broken, see B1**.

### 1.6 Spawning

* `spawnDeparture()` (`engine.ts:171-194`): `freeGate()` (random gate, 12 tries, no aircraft within 55 m, `:162-169`) → random *active* runway end (fallback any) → `findPath(gate→end node)` → path with `holdAt=total` → identity from `newIdentity(type?, weightsFor(end))` (`:139-142`; random airline of 14, flight no 1–998, type via `randomCommercialTypeOf` `aircraftDB.ts:111-116`) → `plan{kind:'departure', gateRef, runway, fix (random beacon or city), cruiseAlt 13000, taxiRoute}` → **phase `'taxi'` immediately** (`:189`). No `parked`/`pushback`.
* `spawnArrivalAtEntry(pos, heading, altFt, beacon)` (`:197-214`): phase `'approach'`, `navMode 'heading'`, speed `min(250,maxTMA)`, `attention=true`, `cmdAltitude=altFt`. Called by `SimStore._spawnArrivalAtEntry()` (`simStore.ts:162-171`) with a weighted-random entry from `RadarScene.entries` (positions = `advance(centerXY, heading+180, radiusM)`, `:183-186`).
* `spawnArrival()` (`:217-239`): fallback only when no airspace entries — 11 km straight-in at 3°, phase `'landing'`. All six shipped airports have entry points, so this never runs in the live game except through code paths that no longer exist.

### 1.7 Command parsing and dispatch

`SimStore.command(text)` (`simStore.ts:196-201`) → `pushRadio('ATC')` → `parseCommand(engine, text)` (`commands.ts:28-143`) → `pushRadio(ok?'PILOT':'SYS', reply)`. `ok` is a **regex heuristic on the reply string** (`/unable|unknown|no route|no aircraft|where|\?$|not /i`, `commands.ts:145-148`), not a status code — e.g. `cmdPushback`'s rejection "already moving" is reported as a PILOT readback with `ok=true` **[verified]**. Grammar is in §3.5. Sidebar buttons all go through the same text path (`atc/page.tsx:112-131`).

---

## 2. Engine capability inventory

### 2.1 Flight phases (`types.ts:7-10`) and reachability

| Phase | Stepper (`aircraft.ts:40-54`) | Entered by | Reachable in live game? |
|---|---|---|---|
| `parked` | no-op | `base()` default (`engine.ts:146`) — immediately overwritten by every spawner | **No** |
| `pushback` | `stepPushback` `:113-119`: accel to 3 kt, reverse along heading, 22 m then → `taxi` | `cmdPushback` requires `parked` | **No** (cmdPushback always "already moving" **[verified]**) |
| `taxi` | `stepTaxi` `:122-140` | spawnDeparture, cmdTaxiTo, cmdCross, rollout→vacate | Yes |
| `hold_short` | `stepTaxi` (same) — set when `holdAt−7−distAlong ≤ 3` and emits `reached_hold` `:126-133` | path hold point, cmdHoldShort | Yes |
| `lineup` | `stepLineup` `:143-146` — `follow(…, targetSpeed 0)` ⇒ **does not move** | `cmdLineUp` | Yes, cosmetic **[verified: 1.6 m moved in 20 s, heading unchanged]** |
| `takeoff` | `stepTakeoff` `:152-168`: while `|hdg−target|>12°` taxi at turn speed; else accel `5.5/3.9/3.2/2.8 kt/s` by class (`:149-151`, 9 if military) to `Vr+30`; at `speed ≥ Vr` → `climb`, path null, `targetAlt=cruiseAlt`, `targetSpeed=min(maxTMA, Vr+70)`, `navMode='sid'`, `attention=true` | `beginRoll` | Yes |
| `climb` / `cruise` / `descent` / `approach` | `stepAirborneFree` `:171-202`: speed toward `min(target, 250 if <10 000 ft)` at `accelerationRateAir/decelerationRateAir`; forced turn dir; heading at `turnRateAir`; alt at `maxClimb/DescentRate` (×1.5 expedite); phase relabelled by alt vs target (±50 ft) or pinned to `approach` when `ilsCaptured` | takeoff, spawn, go-around, alt changes | Yes |
| `landing` | `stepLanding` `:205-216` | ILS hand-off; fallback spawn | Reached, but **never completes via ILS** (B1) |
| `rollout` | `stepRollout` `:219-222` | touchdown | Only via fallback spawn |
| `arrived` | none; removed next tick (`engine.ts:763`, `time−spawnedAt > 3` uses spawn time so effectively immediate) | taxi path end for arrivals (`aircraft.ts:137-139`) | via fallback only |
| `departed` | none | **never set** — departures are filtered out with a `departed` *event* (`engine.ts:771`) | **No** |

`isAirborne` = climb/cruise/descent/approach/landing (`aircraft.ts:233-235`). Trail: 8 m step, 260 pts (`:18, 225-231`).

### 2.2 Commands (`engine.ts`)

| Method | Signature → reply | Guards | Effect | Timing |
|---|---|---|---|---|
| `cmdPushback(cs)` `:242-247` | `"X, pushback approved"` | phase must be `parked` | `distAlong=0`, phase `pushback` | 22 m at 3 kt ≈ 14 s |
| `cmdTaxiTo(cs, dest, via?)` `:267-292` | `"X, taxi to D via A B"` | dest = runway end name (exact) or gate `ref` (case-insens); via names must exist in `taxiwayNodes` | new path from `nearestNodeId(pos)` (O(nodes) scan `:474-481`); `holdAt=total` only if runway; resets `holdReleased,takeoffCleared`; sets `plan.runway` or `plan.gateRef`; phase `taxi` | immediate |
| `cmdHoldShort(cs)` `:294-299` | `"X, hold short"` | none (works airborne too, no-op) | `holdReleased=false`; `path.holdAt = min(holdAt ?? total, distAlong + max(20, speed·2))` | stops within ~20–40 m |
| `cmdCross(cs)` `:300-304` | `"X, continue"` | none | `holdReleased=true`; `hold_short`→`taxi` | immediate |
| `cmdLineUp(cs)` `:305-313` | `"X, line up and wait runway R"` | phase `hold_short`/`taxi` and `plan.runway` | path `[pos, runway end]` kind runway; phase `lineup`; `targetHeading=runwayHeading` | no motion (see above) |
| `cmdTakeoff(cs)` `:324-331` | `"X, cleared for takeoff runway R"` / `"… — continue to the runway"` | `plan.runway` set | `hold_short`/`lineup` → `beginRoll()` `:315-323` (path `[pos, end, far+800 m]`, phase `takeoff`); `taxi` → `takeoffCleared=true` (rolls automatically when hold reached & runway clear `:742-745`) | **no occupancy check**, **no distance-to-runway check** (B4) |
| `cmdClearedLand(cs)` `:332-338` | `"X, cleared to land runway R"` | airborne, runway assigned | **nothing** — pure readback | cosmetic |
| `cmdHeading(cs, hdg, dir?)` `:348-362` | `"X, turn left fly heading 270"` | airborne | clears ILS/direct, `navMode='heading'`, `turnDir`, queues `{heading}` | +3 s pilot delay |
| `cmdAltitude(cs, ft, expedite?)` `:363-372` | `"X, climb/descend and maintain N ft[, expedite]"` | **none** (accepted on ground **[verified]**) | `cmdAltitude`, `expedite`, queues `{altitude}` | +3 s |
| `cmdSpeed(cs, kts)` `:373-380` | `"X, N knots"` | **none** | `cmdIas`, queues `{speed}` | +3 s |
| `cmdExpedite(cs)` `:381-385` | `"X, expedite on/off"` | none | toggles `expedite` | immediate |
| `cmdILS(cs, rwy)` `:388-414` | `"X, cleared ILS approach runway R"` | airborne; weight class allowed on that end; ILS known (else synthesised from OSM end geometry `:398-404` — inherits B2) | `assignedRunway`, `ilsArmed`, `navMode='ils'`, `plan.runway`; cancels pending heading | immediate |
| `cmdDirect(cs, fix)` `:417-430` | `"X, direct FIX"` | airborne, beacon exists | `navMode='direct'`; auto-reverts to `heading` within 1 500 m of fix (`:552-559`) | immediate |
| `cmdHold(cs, fix, inbound?, dir?)` `:433-451` | `"X, hold at FIX inbound 197, right turns, expect further clearance"` | airborne, beacon exists | inbound default = bearing aircraft→fix now; `holdTurnDir` default R; state machine `to_fix → outbound_turn → outbound (60 s) → inbound_turn → inbound → …` with 700 m fix capture and 5° turn completion (`:516-549`); no EFC/exit other than a new command | immediate |
| `cmdGoAround(cs)` `:454-459` | `"X, go around, climb to 3000 ft"` | airborne | `initiateGoAround` `:461-469`: clears ILS, path, `targetAlt=cmdAlt=3000`, `targetSpeed=min(maxTMA,220)`, phase `climb`, emits `go_around` | immediate |

Pilot-delay queue: `PendingCmd{kind:'heading'|'altitude'|'speed', value, applyAt}` (`types.ts:38-42`); `enqueuePilotCmd` replaces same-kind (`engine.ts:341-346`); `PILOT_DELAY_S = 3` (`:21`); drained head-first in `stepAircraft` (`aircraft.ts:33-38`). ILS/direct/hold/go-around apply instantly.

### 2.3 Events (`types.ts:114-117`)

`spawn, phase, reached_hold, airborne, touchdown, arrived, departed, ground_conflict, separation_loss, go_around, diversion, info`. Store routing (`simStore.ts:219-222`): SYS ← spawn/ground_conflict/separation_loss/diversion/info; PILOT ← airborne/touchdown/arrived/departed/go_around; **`phase` and `reached_hold` are dropped** — the player is never told an aircraft is holding short.

### 2.4 Scoring / skill (`engine.ts`)

* +1 score, +0.1 skill: arrival vacates runway (`:736`). +1, +0.05: departure leaves at ≥ 9 000 ft (`:772`).
* −0.5 skill: departure leaves < 9 000 ft (`:768-769`), arrival leaves beyond 1.05·radius (`:781-782`), each new separation-loss pair (`:811`). Ground conflict: event only, no penalty (`:799`).
* Skill ∈ [0,12] (start 3); drives spawn cap (§1.2). High score persisted at `LS_KEYS.score` (`simStore.ts:230-233`).

### 2.5 Separation (`checkSeparation` `engine.ts:790-817`)

* Ground pair: `d < 0.6·(rA+rB)` (e.g. 30 m for two B738) → `conflict`, `ground_conflict` once per pair episode.
* Air pair: `req = max(wake(a), wake(b), 3 NM)` with `wakeSeparationNM` = 3 / 5 (H) / 6 (S) applied *symmetrically* regardless of who leads (`aircraftDB.ts:96-99`); vertical 1 000 ft (`:20`). "Reduced minima" = **no check at all** for two ILS-captured aircraft on different runways or two landings on different runways (`:804-806`).
* Air↔ground pairs: never checked.

### 2.6 Ground traffic rules (`applyTraffic` `engine.ts:634-678`)

* Follower hold: taxiing aircraft stops if another non-airborne aircraft is within `rA+rB+14+0.7·speed` m and within ±48° ahead; mutual block resolved by lower id (`:638-653`).
* Close pairs (< `rA+rB+7` m) facing within ±90° both hold (`:654-661`) — can deadlock (§4).
* Active-runway protection: any ground aircraft (except takeoff/rollout/lineup, or one whose own `plan.runway` is that runway) within 75 m now or 28 m ahead of a runway that has lineup/takeoff/landing/rollout traffic holds (`:662-677`).

### 2.7 Runway occupancy / auto-tower / restrictions

* `runwayOccupied(end)` (`:483-488`): any aircraft with `plan.runway` on either end name in phase lineup/takeoff/landing/rollout — **includes the querying aircraft itself** (B1).
* `runwayPhysicallyClear(end, exceptId)` (`:489-493`): no other aircraft within 45 m of the runway segment.
* Auto-tower (`:749-759`, default on, `LS_KEYS.autoTower`): per free runway end, first aircraft in `hold_short` with that `plan.runway` gets `cmdTakeoff` — **no check that it is near the runway** (B4).
* Pre-cleared departures (`:742-745`): `hold_short && takeoffCleared && !occupied && physicallyClear` → roll.
* Active ends: `setActiveRunwayEnds` (`:76-79`) affects only spawn runway choice (departures, fallback arrivals). Weight classes: `setRunwayWeightAllow` (`:83-89`) affects departure type pool and `cmdILS` refusal; **arrivals are spawned without weight filtering** (`:200`), so a Heavy can arrive when no runway accepts Heavies.
* Airspace exit: departures retired at 0.92·radius from **origin (0,0)**, arrivals at 1.05·radius (`:762-787`).

---

## 3. UI inventory

### 3.1 `/` — airport picker (`src/app/page.tsx`)

| Element | Calls | Verdict |
|---|---|---|
| 6 airport cards (`:101-109`) | `selectAirport(code)` → default ends on, weights from `defaultWeights(lengthFt)` (`:13-18`) | works |
| Runway end toggles (`:135-138, 151-154`) | `toggleEnd` → `ends[]` → `engine.setActiveRunwayEnds` | works mechanically, but **13/22 end names are physically swapped** (B2) so "27L open" opens eastbound ops at EGLL |
| Weight class L/M/H/S (`:141-148`) | `toggleWeight` → `weights[end]` → `engine.setRunwayWeightAllow` | works for departures + ILS refusal; arrivals ignore it |
| START SIMULATION (`:163-165`) | writes `skycontrol_start_config` to localStorage, `router.push('/atc')` (`:64-76`) | **broken after first game**: `/atc` only consumes config when `!sim.engine && !sim.loading` (`atc/page.tsx:65-73`); client-side nav keeps `window.__atcSim`, so picking a new airport does nothing until hard reload |
| Settings link | `/settings` | works |

### 3.2 `/settings` (`src/app/settings/page.tsx`)

| Element | Calls | Verdict |
|---|---|---|
| Auto-tower toggle (`:32-37`) | localStorage + `sim.engine.autoTower` | works live |
| Pilot TTS toggle (`:26-31`) | localStorage + `sim.tts` (no `emit`) | works (browser `speechSynthesis`, `simStore.ts:46-53`; each utterance cancels the previous) |
| Default ground look (`:38-41`) | localStorage only; read once at `/atc` mount | works |
| Reset high score (`:42-48`) | localStorage + `sim.highScore=0` | works |

### 3.3 `/atc` (`src/app/atc/page.tsx`)

**Left sidebar**
| Element | Calls | Verdict |
|---|---|---|
| RADAR / GROUND segmented (`:157-160`) | `setMode` → mounts `ApproachView` or `GroundView` (dynamic, ssr:false `:13-14`) | works; both views clean their RAF/listeners on unmount (`GroundView:100`, `ApproachView:391-397`) |
| SATELLITE / CHART (`:163-168`) | `setStyle(buildOsmStyle(icao, theme))` (`GroundView:104-109`) | works; loses nothing (camera kept) |
| Stat chips TOTAL/AIRBORNE/GROUND/CONFLICT (`:171-176`) | `engine.stats()` (`engine.ts:819-827`) | works; CONFLICT counts aircraft, banner says "PAIRS" (`:193`) — cosmetic mislabel |
| Skill bar (`:179-189`) | `engine.skill/12` | works |
| Traffic list rows (`:200-202`, `AcftRow :434-451`) | `sim.select(id)` | works; sorted conflict→approach/landing→callsign |
| + DEP / + ARR (`:208-209`) | `sim.spawnDeparture()/spawnArrival()` | works (ARR uses entry points) |
| PAUSE/RESUME (`:212-214`) | `sim.togglePause()` | works |
| 1×/2×/4× (`:217-219`) | `sim.setRate` | works |

**Right panel (selected aircraft)**
| Element | Calls | Verdict |
|---|---|---|
| ALT/SPD/HDG big metrics with target arrows (`:238-243`) | reads `cmdAltitude/cmdIas` | works; updates ~2×/s via snapshot `Math.floor(time*2)` (`:25`) |
| Badges DEP/ARR, phase, ILS/LOC, HLD, DCT, EXPD (`:247-256`) | state flags | works |
| Route line RWY/TO or VIA/STAND (`:259-264`) | `plan` | works |
| **Ground buttons** (`:273-282`): PUSHBACK | `quick('PUSHBACK')` | **broken** — always "already moving" (no `parked` aircraft exist) |
| TAXI 27L | hard-coded `TAXI 27L` | **broken** at KLAX/KJFK/KSFO/KBOS/VIDP ("unknown destination"); at EGLL sends to the physically wrong end (B2) |
| LINE UP | `cmdLineUp` | cosmetic-only (no movement) |
| CLEARED T/O | `cmdTakeoff` | works; no safety checks |
| HOLD SHORT | `cmdHoldShort` | works for a stop; **dangerous**: during takeoff roll it aborts the takeoff and leaves the aircraft in `takeoff` phase at 0 kt forever, permanently occupying the runway **[verified]**; repeated use teleports (B5) |
| CROSS | `cmdCross` | works |
| **Approach controls** (RADAR mode only, `:288-329`): ALT ▲3k/▲1k/▼1k/▼3k | `altitude N` rounded to 1 000 | works |
| EXPD | toggles | works |
| SPD ±10/±20 (floor 100) | `speed N` | works |
| HDG ◀30/◀10/10▶/30▶ | `heading N` from *current* heading | works (no L/R forcing) |
| ILS buttons | first 5 of `radar.runways` | works; KSFO has 8 ILS runways → 3 unreachable by button |
| HOLD buttons | first 5 beacons in file order | works; EGLL has ~30 beacons → most unreachable by button |
| GO AROUND | `cmdGoAround` | works |
| Airborne quick cmds in GROUND mode (`:332-346`): CLIMB 8000 / DESCEND 4000 / SPEED 200 / CLEARED LAND | text | first three work; CLEARED LAND cosmetic |
| TYPE COMMAND › (`:348-350`) | focuses input | works |
| Empty state (`:353-358`) | — | works |

**Bottom strip**
| Element | Calls | Verdict |
|---|---|---|
| Airport name / ICAO / score / HI (`:366-373`) | — | works |
| Airport picker EGLL…VIDP (`:377-381`) | `sim.load(icao)` with **no** ends/weights | works but silently discards the home-page runway config; in GROUND+SATELLITE the imagery source is not swapped (only `osm` source `setData`, `GroundView:55-56`) so other airports render **black** until the theme is toggled |
| 🔊/🔇 (`:383-385`) | `sim.toggleTTS()` | works |
| UTC clock (`:76-82, :386`) | `setInterval` | works (wall clock, not sim clock) |
| Radio log (`:391-399`) | `sim.radio` (last 61 lines) | works; auto-scroll effect runs every render (`:85-87`) |
| Command input + SEND (`:402-416`) | `sim.command(cmd)` | works |
| Loading overlay (`:420-426`) | `sim.loading` | works |

**Views**
* `ApproachView` (`src/components/atc/ApproachView/index.tsx`): boundary + 10 NM rings (`:100-114`), restricted areas (`:117-123`), runways with ILS feather, ±30° cone, 2k/3k/4k GS intercept dots (`:126-169`), entries (`:172-177`), beacons (`:180-186`), hold ovals (`:188-236`), per-aircraft: attention pulse, 1.5 NM ring, H/S wake arc (`:261-280`), ILS intercept guide, DCT line, trail, 1-min vector, data tag `CS / ALT(↑↓target) / SPD+WC+mode` (`:353-376`), score HUD (`:379-388`). Wheel zoom (centre-anchored), drag pan, click select (`:55-78`). Verdict: works; hold oval is a speed-estimated sketch, not the flown track.
* `GroundView` (`src/components/atc/GroundView/index.tsx`): MapLibre map with `buildOsmStyle` (`osmMapStyle.ts:8-90`: static satellite `image` sources from `SATELLITE_BOUNDS` (`satelliteBounds.ts:11-18`) with Esri tile fallback `:23`, OSM apron/terminal/taxiway/runway/gate layers + labels); overlay canvas draws remaining route (green), trail (red), true-scale silhouettes via `getShape/drawShape` (`aircraftShapes.ts:144-167`), callsign; click/hover hit-test 22 px (`:37-44`). Verdict: works. Note the global `window.fetch` monkeypatch that turns every `AbortError` into a **never-resolving promise** (`:12-16`) — affects all fetches on the page, not just MapLibre.
* `Ground3DView` + `/demo3d` (`Ground3DView/index.tsx`, `osm3dStyle.ts`, `app/demo3d/page.tsx`): extruded terminals/hangars with name-guessed heights (`osm3dStyle.ts:16-27`), aircraft as `fill-extrusion` polygons with base = altitude (`Ground3DView:27-64`), camera presets + follow. Not linked from any live screen; hard-codes KSFO (`demo3d/page.tsx:29,48`). Verdict: working prototype, not part of the product.

### 3.4 Snapshot / re-render model
`useSim()` = `useSyncExternalStore(sim.subscribe, snapshot, () => 0)` where `snapshot` is an arithmetic hash of `radio.length, selectedId·1e6, loading·1e9, paused·5e8, rate·1e7, floor(time·2)·13` (`atc/page.tsx:18-27`). Works in practice but collisions are possible (e.g. `selectedId 11 @1×` and `selectedId 1 @2×` hash equal) and server snapshot `0` ≠ client → hydration re-render.

### 3.5 Command text grammar (`commands.ts:28-143`)

Input is upper-cased and whitespace-normalised; first token = callsign **or flight number** (`engine.find` `engine.ts:135`). Matching is **substring `includes`** on the remainder, evaluated in this order (first hit wins):

```
1  PUSHBACK | PUSH                              → cmdPushback
2  HOLD … SHORT                                 → cmdHoldShort
3  CROSS | CONTINUE                             → cmdCross          ("CONTINUE TAXI" ⇒ cross, not taxi)
4  LINE … UP | LUAW | WAIT                      → cmdLineUp
5  CLEARED TAKEOFF | TAKEOFF | CLEARED DEPARTURE→ cmdTakeoff
6  CLEARED LAND | LAND (without ILS)            → cmdClearedLand
7  TAXI [TO|RWY|RUNWAY|GATE|STAND] <dest> [VIA tw tw…]   dest = first token after filler; via tokens /^[A-Z0-9]{1,3}$/
8  HEADING | HDG | TURN | ^H\d{1,3}   n = first integer; LEFT|" L" → L, RIGHT|" R" → R
9  CLIMB | DESCEND | ALT | ALTITUDE | MAINTAIN | ^A\d   n = first integer; n<1000 ⇒ n·1000 ("CLIMB 8" ⇒ 8000; "DESCEND FL80" ⇒ 80 000 ft [verified]); EXPEDITE|EXPD flag
10 SPEED | SPD | ^S\d{2,3}             n = first integer
11 ILS | LOC | LLZ | APPROACH <rwy /^\d{1,2}[LRC]?$/>
12 DCT | DIRECT <fix /^[A-Z]{2,5}$/>
13 HOLD [AT] <fix> [LEFT|L|RIGHT|R] [<inbound \d{3}>]
14 EXPEDITE | EXPD                    → toggle
15 GO | AROUND | GOAROUND | MISSED    → cmdGoAround
16 else "unable — say again"
```
Consequences: "ALTITUDE 4000 THEN SPEED 180" ⇒ altitude only; "SPEED 180 THEN DESCEND 4000" ⇒ **climb 180 000 ft** (altitude rule precedes speed, takes first integer) **[verified]**; "HOLD POSITION" ⇒ "hold at which fix?" (no hold-position command exists); flight levels unsupported; no "CANCEL", "RESUME", "TAXI VIA … HOLD SHORT OF", "CROSS RWY X", "CONTACT", "SQUAWK".

---

## 4. Bugs & gaps

**Critical — game-breaking**

* **B1. Every ILS arrival goes around at 2.00 NM; no arrival ever lands in the live game.** `handleTransitions` (`engine.ts:713-723`) calls `runwayOccupied(a.plan.runway)` while `a` itself is in `landing` with that `plan.runway`; `runwayOccupied` (`:483-488`) has no `exceptId`. **[verified: single aircraft, EGLL 27R, go-around at t=210 s, along=2.00 NM; same on 27L, KSFO]**. Consequences: arrivals never touch down, never score, then fly out on runway heading at 3 000 ft and are eventually `diversion`-ed (−0.5 skill). The initial-load fallback path (`spawnArrival`) does land, but it is unreachable because all 6 airports ship entry points. Fix: pass `exceptId` (or check `b.id !== a.id`) — with that patch alone, all four tested approaches touched down within 3 m of the ILS threshold **[verified]**.
* **B2. Runway end names are assigned by LineString vertex order, not by heading** (`osmAirport.ts:133-139`: `n1 → cs[0]`, `n2 → cs[last]`). 13 of 22 ends are physically swapped: EGLL 09R/27L (both), KJFK 04L/22R, 13L/31R, KSFO 10L/28R, 10R/28L, 01L/19R, KBOS 4L/22R, 15L/33R, VIDP all four **[verified against geometry]**. Effects: `runwayHeading('27L') = 090` at EGLL; `cmdTaxiTo('27L')` and `beginRoll` roll **eastbound** on what is really 09R; home-page toggles mislabel; `cmdILS` OSM fallback builds a reversed localizer; landing hand-off uses `endXY(osmRwy.end)` so the rollout path is a hairpin that `dedupeBacktracks` collapses into a 500 m stub — aircraft "freeze" at path end while still decelerating (`aircraft.ts:85-86`). `scripts/gen_runway_manifest.py` inherits the same swap (`runwayManifest.ts:26-33`: "27L hdg 90"). Fix: orient ends by comparing the LineString bearing with the designator number ×10 (`bearingDeg` exists at `osmAirport.ts:52-59`), or snap to the Endless-ATC thresholds when available.
* **B3. Arrivals at EGLL are diverted on the tick they spawn (≈50 %).** Boundary entries are placed around the *airspace* centre (`simStore.ts:183-186`), which for EGLL is 8.8 NM east of the OSM origin, but retirement measures `dist(pos, {0,0}) > 1.05·radius` (`engine.ts:778-785`). OCK (6/18) and BNN (3/18) entries spawn at 34–37 NM > 29.4 NM **[verified]** → immediate `DIVERSION`, −0.5 skill each. Departures likewise exit at 0.92·radius from origin, i.e. up to 9 NM inside/outside the drawn circle. Fix: store `centerXY` in the engine and measure from it (or from the drawn boundary).
* **B4. `hold_short` is a phase, not a place.** `cmdHoldShort` anywhere on the apron sets `hold_short`; auto-tower (`engine.ts:753-755`) and `cmdTakeoff` (`:328`) then treat it as "at the runway" and `beginRoll` draws a **straight line from the current position to the threshold** — the aircraft drives cross-country through terminals under takeoff acceleration **[verified: cleared at 3.4 km from the runway, 20 s after HOLD SHORT]**. Fix: gate on `dist(pos, endXY) < ~60 m` (and on the hold point actually being the runway hold), or model hold-short lines as graph nodes.
* **B5. HOLD SHORT → CROSS → HOLD SHORT teleports the aircraft backwards and loses the runway hold.** Second call sets `holdAt = min(oldHoldAt, …)` (`engine.ts:297`) where `oldHoldAt` is behind the aircraft, then `follow` clamps `distAlong ≤ holdAt−7` (`aircraft.ts:84`) — **216 m backward jump [verified]**. After the first HOLD SHORT the runway-end `holdAt=total` is gone for good, so the departure taxis onto the threshold and sits in `taxi` at a frozen position with `speed=20` (no end-slowdown because `holdAt != null`, `aircraft.ts:108`), invisible to auto-tower and `runwayOccupied` **[verified]**.
* **B6. Start config ignored after the first game** (`atc/page.tsx:65-73` early-returns when `sim.engine` exists; `simStore.ts:246-247` singleton survives client navigation). Also the stale key is left in localStorage.

**High**

* B7. `cmdClearedLand` does nothing (`engine.ts:332-338`); landing is automatic once established — no landing-clearance gameplay.
* B8. `parked`, `pushback`, `departed` unreachable; `PUSHBACK` button always fails (§2.1).
* B9. `cmdHoldShort` during takeoff roll = permanent rejected takeoff on the runway (§3.3) — `stepTakeoff` honours `holdAt` via `follow` (`aircraft.ts:73-77`) and nothing clears the phase.
* B10. `cmdAltitude`/`cmdSpeed` accepted on the ground (`engine.ts:363-380`); sets `cmdIas` which then disables the 15 NM auto-slow rule (`:627`) and the LOC-capture clamp semantics for that flight.
* B11. Two arrivals spawned at the same entry (weighted duplicates, e.g. BIG ×3 at EGLL) start co-located at the same altitude → instant `SEPARATION LOSS` and −0.5 skill **[verified]**; no spawn spacing/queueing.
* B12. Airspace `[airport2]` sections are ignored (`eairport.ts:155` reads only `airport1`); EGLL's file therefore exposes ILS for 27L/27R only — 09L/09R fall to the OSM synthesised ILS (B2 makes those wrong).
* B13. No separation check between air and ground aircraft, no wake ordering (leader/trailer), "reduced minima" disables checking entirely (`engine.ts:804-807`).
* B14. Ground follower logic can deadlock: the close-pair rule (`engine.ts:654-661`) re-flags both aircraft after the tie-break in `:650-653`; aircraft blocked by a `hold_short` aircraft ahead wait forever if the hold is never released.
* B15. `runwayPhysicallyClear` uses 45 m from the runway centreline (`:492`) — a departure holding 7 m short of the *far* threshold node blocks takeoffs from the other end; conversely the hold point itself is the runway end node (OSM), so "holding short" aircraft are physically on the runway strip.

**Medium**

* B16. GroundView airport switch does not rebuild the style — satellite image sources keep the old airport's bounds (`GroundView:51-57`), so other airports show black in SATELLITE mode until the theme toggles.
* B17. `applyTraffic`/`checkSeparation`/`freeGate`/`nearestNodeId` are O(n²)/O(nodes) per tick; `sampleAlong` and the GroundView route draw are linear scans over 3–10 k-point paths (`projection.ts:152`, `GroundView:69`). Fine at 14 aircraft, will not scale; `findPath`'s open set is a linear-scan `Set` (`osmAirport.ts:210-213`).
* B18. `SimEngine.acc` never clamped (`engine.ts:497-505`) — after sustained slow frames the sim runs "fast-forward" until the backlog drains; with `MAX_SUBSTEPS` it can also silently run slower than `rate`.
* B19. `reply()` ok-heuristic misclassifies (§1.7); `phase`/`reached_hold` events dropped (§2.3).
* B20. `useState(() => localStorage…)` initialisers in `/atc` and `/settings` (`atc/page.tsx:54-57`, `settings/page.tsx:17-23`) differ between SSR and client → hydration warnings; `useSyncExternalStore` server snapshot `0` likewise.
* B21. Gate assignment has no reservation: arrival gates are picked at spawn (`engine.ts:199,205`) but departures may spawn there later; two arrivals can share a gate.
* B22. `thrElevFt` is always 0 (`simStore.ts:139`) though airspace files carry elevation (`eairport.ts:159` parses it); `altitude` is documented "ft AGL" (`types.ts:59`) — fine today, wrong once elevation is used.
* B23. `window.fetch` monkeypatch (`GroundView:12-16`) is global and leaks past unmount; swallowed aborts become hung promises.
* B24. Radio "PAIRS" count is aircraft count (`atc/page.tsx:193`); `arrived` retire uses `spawnedAt` (`engine.ts:763`); hold oval is drawn from estimated radius not the actual flown track (`ApproachView:198-216`).
* B25. Arrival airspace weight restrictions and active-end restrictions not enforced for ILS clearance (only weight is) — the player can land on a "closed" end.
* B26. `refrence/` submodule pointers and `tsconfig.tsbuildinfo` are dirty in git; `next.config.js:4` hard-codes a dev IP in `allowedDevOrigins`.

**Memory / lifecycle**: no RAF leaks found — `GroundView:100`, `ApproachView:391-397`, `Ground3DView:140` cancel on unmount; the store RAF is intentionally global. `ResizeObserver` disconnected. MapLibre maps removed. `setInterval` clock cleared (`atc/page.tsx:81`).

---

## 5. Dead code

Reachability was established from the import graph (`grep` of every `from '…'` under `src`). The live game imports exactly: `components/atc/{simStore,GroundView,ApproachView}`, `lib/sim/{engine,aircraft,types,commands,ils,aircraftDB,aircraftShapes,projection}`, `lib/{osmAirport,osmMapStyle,satelliteBounds,runwayManifest}`, `lib/airspace/eairport`. Everything else is reachable only via legacy routes.

**Safe to delete (nothing in the live game imports them)**

| Path | Why |
|---|---|
| `src/app/groundradar/page.tsx` + `src/components/GroundRadar/` | X-Plane era ground radar prototype; own map style, own data (`/maps/xplane`, `airportData.ts`) |
| `src/app/hifi/page.tsx` + `src/components/HiFiMap/` (1 002 lines) | multi-airport map prototype, no sim |
| `src/app/lax/page.tsx` + `src/components/LAXMap/{index,wrapper}.tsx`, `AircraftPopup.tsx`, `GroundTrafficPanel.tsx`, `RadarCanvasOverlay.tsx`, `AircraftOverlay.tsx`, `src/context/GroundTrafficContext.tsx`, `src/hooks/useSimLoop.ts` | the first ground-movement sim (reducer + `lib/physics.ts` + `lib/autoScheduler.ts`); entirely superseded by `SimEngine` |
| `src/app/osmradar/page.tsx` + `src/components/OsmRadar/` (766 lines) | OSM radar demo; only external use of `loadOsmAirport()` (`osmAirport.ts:68-73`, also then deletable) |
| `src/app/skycontrol/page.tsx` + `src/components/SkyControl/` (467 lines) | previous single-page game that instantiates its own `SimEngine`; superseded by `/atc` + `simStore` |
| `src/components/AirportMap/`, `src/components/StyleGallery/`, `src/lib/map-styles.ts`, `src/lib/asset2-types.ts` | asset2/SFO experiments; nobody imports `AirportMap` or `StyleGallery` at all |
| `src/lib/{aircraft,airportData,autoScheduler,geoUtils,physics,pathfinding,taxiwayGraph,types,projection}.ts` | legacy sim + X-Plane graph; `pathfinding.ts` and `lib/projection.ts` are imported by nothing; `taxiwayGraph.ts` is a shim for a module no live code uses |
| `src/lib/osmMapStyle.ts:94-125 paintAirframe` | exported but unused (GroundView uses `aircraftShapes`) |
| `public/maps/xplane/` (32 MB), `public/maps/geojson/`, `public/maps/lax_experiment/`, `public/maps/{KBOS,KSFO,VIDP,sfo-asset2}.json`, `public/*.html`, `public/sfo-asset2-*.png` | only referenced by the legacy components above; live game reads `public/maps/osm`, `public/maps/satellite`, `public/airspace` only |
| `scripts/*` except `fetch_osm_airports.py`, `fetch_satellite.py`, `gen_runway_manifest.py`, `gen_airspace.py`, `gen_aircraft_svgs.mjs` | X-Plane/asset2/LAX pipeline for the deleted data |
| In live files: `types.ts:24-27 TaxiWaypoint`, `AircraftState.route/routeIndex/holdingShort` (`types.ts:102-105`, written at `engine.ts:156` only), `NavMode 'loc'` (`types.ts:13`, never assigned), `aircraft.ts:236-241 isGround/routeProgress`, `projection.ts:49-52 dist2`, `:161-163 MPS_TO_KTS/M_TO_NM`, `ils.ts:66-68 distFromThrM` (imported, unused), `engine.ts:11 randomCommercialType` import, `commands.ts:150 isRunwayToken`, `commands.ts:38-41 num()` (shadowed by `firstNum`), `engine.ts:352` self-assignment | dead members |

**Keep, but decide**: `src/app/demo3d/page.tsx`, `src/components/atc/Ground3DView/`, `src/lib/osm3dStyle.ts` — coherent working prototype reading the shared store; delete unless 3D tower view is on the roadmap. `public/aircraft/*.svg` — generated by `scripts/gen_aircraft_svgs.mjs` from `aircraftShapes.ts`, not used by any live view (`drawShape` is canvas). `docs/GROUND_MOVEMENT_SPEC.md` describes the *legacy* reducer architecture (`SimAircraft`, `GroundState`, React Context, `docs:579-650`) and does not match the live engine; `context/phase1_simulation_spec.md` matches the projection/separation constants that were implemented (`phase1:11-19, 90-110`).

---

## 6. Extension points

* **Realistic startup / pushback timing**: make `spawnDeparture` (`engine.ts:171-194`) end in `phase='parked'` with the gate node as `pos` and the path stored but not yet followed; add `ClearanceSet`-style flags (`docs/GROUND_MOVEMENT_SPEC.md:118-127` already defines them) to `AircraftState` (`types.ts:44-112`); give `stepPushback` (`aircraft.ts:113-119`) a tug-speed profile and a pushback vector from the gate's OSM `parking_position` direction (available in the geojson properties, currently discarded at `osmAirport.ts:157-166`); add a `ready_for_taxi` phase and make `cmdTaxiTo` the only way into `taxi`. Timers belong in the pilot-delay queue: extend `PendingCmd.kind` (`types.ts:39`) or add `ac.timers: {startupUntil, pushbackUntil}` evaluated in `handleTransitions`.
* **Ground vehicles (fire, follow-me, tug)**: they are "aircraft without perf" — the cleanest seam is a `kind: 'aircraft'|'vehicle'` discriminator on `AircraftState` plus a tiny `perf` (`AircraftPerformance`, `aircraftDB.ts:20-53`) so `follow()`/`applyTraffic` work unchanged; exclude them in `checkSeparation` (`engine.ts:793`) and `runwayOccupied`; render via a new `META` family in `aircraftShapes.ts:24-42`. A tug is a vehicle whose path is the aircraft's pushback path and which sets the aircraft's pos while `phase==='pushback'`.
* **Emergencies**: add `emergency?: {type, declaredAt, priority}` to `AircraftState`; inject via a new `SimEvent` type (`types.ts:114-117`) and a `cmd`-less engine method `declareEmergency(id)` called from the store's spawn timer (`simStore.ts:224-228`); priority handling hooks: auto-tower loop (`engine.ts:749-759`) and the ILS hand-off occupancy check (`:691`). `specialRules.priorityAirspaceAccess` (`aircraftDB.ts:52`) is already there but unused.
* **Wind / ATIS**: a `WindState{dirDeg, kts, gust}` on `SimEngine` (`engine.ts:43-61`), applied in `stepAirborneFree` (`aircraft.ts:190`: `pos = advance(pos, heading, TAS·dt)` → add wind vector) and in `stepTakeoff` (`:157`, Vr ± headwind) ; active-runway suggestion from `RUNWAY_MANIFEST[icao][].ends[].hdg` (`runwayManifest.ts:4-6`, once B2 is fixed); ATIS text is a `pushRadio('SYS')` on load and change. Airspace files already carry `transitionaltitude`, `descendaltitude`, `localizerspeed` (`eairport.ts:141-153`) — unused today.
* **Flight strips**: the data already exists (`AircraftState.plan`, `cmdAltitude/cmdIas`, `assignedRunway`, `pendingCmds`); add `strip: {bay:'delivery'|'ground'|'tower'|'approach', notes}` and drive a strip board from the same `useSim()` snapshot (`atc/page.tsx:18-28`); the traffic list `AcftRow` (`:434-451`) is the seam. Keep it in the engine, not the store, so headless tests can assert it.
* **Command decision tree / structured commands**: replace `parseCommand`'s substring chain (`commands.ts:53-142`) with a tokenizer → `Command` union (`{kind:'taxi', dest, via, holdShortOf}` …) → `engine.dispatch(cmd)`; make each `cmd*` return `{ok, reply, code}` instead of a string so `reply()`'s regex (`:145-148`) goes away. Feed the same union from the sidebar buttons (`atc/page.tsx:112-131`) so buttons stop building strings. Availability of each verb per phase is exactly the guards table in §2.2.

---

## 7. Testability

**What exists**: `window.__atcSim` is the live `SimStore` (`simStore.ts:246-247`) → `sim.engine` (`SimEngine`), `sim.command(text)`, `sim.togglePause()`, `sim.setRate(r)`, `sim.load(icao, ends?, weights?)`, `sim.select(id)`, `sim.spawnDeparture()/spawnArrival()`, `sim.clearTraffic()`, `sim.radio`, `sim.paused`, `sim.rate`, `sim.selectedId`. On the engine: `aircraft[]`, `time`, `score`, `skill`, `autoTower`, `find(cs)`, `byId(id)`, `stats()`, `update(dt)`, `spawnArrivalAtEntry(pos,hdg,alt,beacon)`, every `cmd*`, `proj`, `air` (graph). The engine is pure TS with no DOM dependency **[verified: ran headless under Node after `tsc --module commonjs`]**.

**Playwright recipe today**
1. `page.goto('/atc')`; `await page.waitForFunction(() => window.__atcSim?.engine && !window.__atcSim.loading)`.
2. Freeze wall-clock coupling: `page.evaluate(() => { const s = window.__atcSim; s.paused = true; s.clearTraffic(); s.engine.autoTower = false; })`.
3. Place deterministic traffic: `s.engine.spawnArrivalAtEntry({x,y}, hdg, alt, 'BIG')` or `s.engine.spawnDeparture()` (still random gate/type — see gaps).
4. Advance deterministically without RAF: `for (let i=0;i<n;i++) s.engine.update(1/30)` inside `evaluate` (the store loop is paused so nothing else steps; events returned by `update` are the assertion surface).
5. Drive UI: `page.fill('.cmd-input', 'BAW123 ILS 27R'); page.press('.cmd-input','Enter')`; assert `s.radio.at(-1).text` or `s.engine.find('BAW123').ilsArmed`.
6. Views: `ApproachView`/`GroundView` read the store every frame, so screenshots are stable once paused.

**Missing hooks (add these)**
* **Seeded RNG**: `Math.random` is used in `engine.ts:34-35` (`rnd`, `ri`), `simStore.ts:167,226-227`, `aircraftDB.ts:104-116`. Inject `rng: () => number` on `SimEngine` and the store (mulberry32 + `?seed=` query / `sim.seed(n)`).
* **`engine.step(n)` / `store.stepFrames(n)`**: expose a substep-exact advance that also runs the store's event routing and auto-spawn, so tests exercise the same path as RAF.
* **Structured command results**: `sim.command` returns nothing; make it return `CommandResult` and add `code`.
* **Event tap**: `sim.onEvent(cb)` or an in-memory `sim.events[]` ring (currently events only survive as radio text with the `phase`/`reached_hold` types dropped).
* **Determinism controls**: `sim.autoSpawn=false` (today the store spawns whenever count < cap, `simStore.ts:224-228`), a way to spawn a *specific* type/gate/runway (`spawnDeparture(opts)`), and `engine.setTime()`.
* **DOM handles**: no `data-testid`s; selectors must rely on classnames like `.cmd-input`, `.acft-row`, `.ap-btn`. Add `data-testid` + `data-callsign` on `AcftRow`, and expose aircraft screen positions (`ApproachView` `toScreen` is closure-private) for click-to-select tests.
* **Headless build target**: add a tiny `vitest`/`node --test` harness compiling `src/lib/sim/**` (the CommonJS build used for this audit works with `tsc --module commonjs --moduleResolution node`), so B1–B5 become regression tests without a browser.
* **Reset**: `sim.load()` is the only reset and it re-spawns 7 aircraft; add `sim.reset({icao, spawn:false})`.

# SkyControl — Engine Contracts (Wave 0)

Binding interfaces every Wave 1/2/3 agent codes against. Where this document and a
Wave-0 source file disagree, **the source file wins** (it compiles; this is the map).
Where a contract and `00-MASTER-PLAN.md` disagree, the master plan wins and the
contract owner fixes the file.

Status after Wave 1b: every `src/lib/sim` module is implemented (no stubs remain except
`testApi.createTestApi`, owned by W2-STORE); `npx tsc --noEmit` is clean for `src/lib/**` and
`tests/**`; `bash scripts/test-sim.sh` runs 868 headless tests (parser, tree, dispatch, engine,
systems, data, integration). §7 is the Wave 2 handbook: the engine API as it really is.

---

## 1. Module map and ownership

| File (`src/lib/sim/`) | Status | Wave 0 wrote | Wave 1 owner | Wave 2 owner |
|---|---|---|---|---|
| `types.ts` | complete | all shared types, defaults, tables | — (PR to W0 owner for additions) | — |
| `rng.ts` | complete | mulberry32, `setSeed/rng/rnd/ri/rf/chance/isSeeded/subStream` | — | — |
| `stage.ts` | complete | `stage()`, `stageLabel()`, `bayFor()`, classification helpers | — | — |
| `commandAst.ts` | complete | AST union, `CommandResult`, `EngineOutcome`, `makeAst`, `sequence`, `describe`, guards, kind groups | — | — |
| `commandTree.ts` | implemented (W1) | `ActionId`, `REASONS`, `ACTION_MATRIX`, `DYNAMIC_RULES`, `stepsFor`, `actionsFor`, `toAst`, `hotkeyFor`, `resolveHotkey` | **W1-COMMANDS** (refine rules / soft warnings / candidates; never rename ids or reason strings) | — |
| `dispatch.ts` | implemented (W1) | `EngineCommandApi`, `applyToEngine` (AST -> method routing), `guard`, `dispatch` (stub), `composeResult` | **W1-COMMANDS** | — |
| `phraseology.ts` | implemented (W1) | `PhraseCtx`, telephony + spoken-number helpers (implemented), `transmission/readback/pilotRequestLine/unableLine` (stubs) | **W1-SYSTEMS** | — |
| `vehicles.ts` | implemented (W1) | `VehicleFleet` class API, `DEFAULT_FLEET`, `VEHICLE_CONST`, `VehicleStepCtx/Result` | **W1-SYSTEMS** | — |
| `emergencies.ts` | implemented (W1) | `EMERGENCY_CATALOGUE` (13 types, data complete), `createEmergency`, hooks (stubs) | **W1-SYSTEMS** | — |
| `weather.ts` | implemented (W1) | `WeatherModel` class API, `windComponents/runwayScore/transitionLevel/applyWind` (implemented) | **W1-SYSTEMS** | — |
| `alerts.ts` | implemented (W1) | `AlertEngine` (raise/ack/resolve/list/stca implemented; `step` stub), `cpa()` (implemented) | **W1-SYSTEMS** | — |
| `testApi.ts` | types complete | `AtcTestApi`, `SpawnSpec`, `Snapshot`, `AircraftView`, `TestApiHost`, `createTestApi` (stub) | — | **W2-STORE** |
| `engine.ts` | implemented (W1; see §7) | only `base()` now spreads `newAircraftFields()` (plus the import) | **W1-ENGINE** implements `EngineCommandApi` + `StageCtx` on `SimEngine` | — |
| `commands.ts` | implemented (W1) | untouched; its `CommandResult{ok,reply}` is legacy | **W1-COMMANDS** rewrites: tokenizer -> `CommandAST` -> `dispatch()` | — |

Rules: no DOM in `src/lib/sim`; everything the test API exposes is plain JSON; all
randomness through `rng.ts`.

---

## 2. Data flow

```
                      ┌──────────────── src/lib/sim (pure) ────────────────┐
 click tree ──toAst──▶│  CommandAST ──dispatch()──▶ SimEngine.cmd*() ──▶  │
 text parser ─parse─▶ │        │                      │ EngineOutcome       │
 STT (later) ─parse─▶ │        └── phraseology ◀──────┘                     │
                      │              TX / RB text                          │
                      │  engine.update(dt):  applyNavTargets ▸ applyTraffic │
                      │    ▸ stepAircraft ▸ fleet.step ▸ weather.step       │
                      │    ▸ emergencies.stepEmergency ▸ handleTransitions  │
                      │    ▸ checkSeparation ▸ alerts.step  ──▶ SimEvent[]  │
                      └────────────────────────┬──────────────────────────┘
                                               ▼
                simStore.step(dtSim)  routes SimEvent[] -> comm log (EVENT_WHO / ev.who)
                                       -> requests routing (REQ chips)
                                       -> alerts/toasts, score persist, autospawn
                                       -> emit() to React (useSyncExternalStore)
                                               ▼
                GameShell: StripBay (bayFor), CommandPanel (actionsFor -> steps -> toAst -> sim.dispatch),
                           GroundView/ApproachView (read sim.engine in their own RAF), AlertsPanel, AtisWeather, VehiclePanel
                                               ▼
                window.__atcTest (test mode only) = createTestApi(sim)  -> advance()/spawnAt()/aircraft()/actions()...
```

**Engine owns**: aircraft, `VehicleFleet`, `WeatherModel`, `AlertEngine`, `RunwayState[]`,
`GateState[]`, `SessionStats`, airspace centre, time. Systems modules never import the
engine class; they receive small read-only *views* (`VehicleStepCtx`, `AlertStepCtx`,
`EmergencyEngineView`, `StageCtx`, `ActionCtx`) so they stay headless-testable.

**Store owns**: RAF loop (never in test mode), `step()`, comm log lines, selection,
position tab, settings, start-config consumption, test API installation.

**UI owns nothing** — it reads `sim.engine` and calls `sim.dispatch(ast)` / `sim.command(text)`.

---

## 3. Types (types.ts) — what changed

- `FlightPhase` += `startup`, `go_around`. `NavMode` += `visual`.
- `Stage` union (UX §G1) + `ALL_STAGES`.
- `Position` = `ground|tower|departure|approach|external`; `PlayerPosition` = `ground|tower|approach`;
  `POSITION_OWNER` maps departure -> approach tab; `NEXT_POSITION` = next-logical handoff.
- `WakeCategory` + `WAKE_CATEGORY_BY_CLASS` + `WAKE_DEPARTURE_S` (ICAO time matrix) + `WAKE_FINAL_NM`.
- `DrivePath.kind` += `pushback`; `DrivePath.holds?: PathHold[]` = hold-short *places* on a path
  (`nodeId`, `runway`, `at`, `isDepartureEntry`). **Hold-short is a place, never a phase set by a command.**
- `PendingCondition` union; `PendingCmd` widened: `kind: PendingCmdKind` (all AST kinds), `value` kept
  for the legacy numeric drain, optional `condition/ast/issuedAt/cancellable/untilNM`. It stays ONE
  interface (not a union) so `enqueuePilotCmd({kind,value})` still compiles; new code must fill `ast`.
- `PilotRequest`, `Emergency` (+ `emptyChecklist`), `Clearance`, `StartupState`, `PushbackState`,
  `ReadbackState`, `DelayStats` with `default*()` factories.
- `AircraftState` gains 43 required fields (see the `NEW (Wave 0)` block). **Single source of
  defaults: `newAircraftFields(weightClass, time)`** — `engine.base()` spreads it. Adding a field =
  add to the interface + to that function; nothing else.
- `Vehicle`, `VehicleType`, `VehicleState`, `VehicleTarget`.
- `WeatherState`, `Atis`, `WeatherEvent`.
- `Alert`, `AlertKind`, `AlertSeverity`.
- `RunwayState` (per END; both ends of a physical runway are kept in sync by the engine),
  `RunwayStatus = open|closed|sterile|inspection` (master plan; "wet" lives in `surface`),
  `RunwayOccupant`, `WakeTimer`, `GateState`.
- `ScoreCode` + `SCORE_TABLE` (points from 03 §G7, skill deltas from UX §G11), `ScoreEvent`, `SessionStats` (+ `emptySessionStats`).
- `SimEventType` += `request readback emergency alert atis runway_state vehicle wake landing_clearance handoff score stage transmission startup pushback runway_vacated fuel_exhaustion removed`.
  `SimEvent` gains optional `who`, `position`, `data: SimEventData` (typed payload per type). `EVENT_WHO` = default comm-log routing.

---

## 4. Event catalogue

| type | id/callsign | message | data | who (default) | raised by |
|---|---|---|---|---|---|
| `spawn` | aircraft | "BAW117 (B738) ..." | — | SYS | engine spawn |
| `phase` | aircraft | "BAW117 -> taxi" | — | SYS | `setPhase` |
| `stage` | aircraft | stage label | `{from,to}` | SYS | engine (after transitions) |
| `reached_hold` | aircraft | "holding short 27L" | — | PILOT | stepTaxi at a PathHold |
| `request` | aircraft | pilot line | `{request, change}` | PILOT | engine request scheduler |
| `readback` | aircraft | pilot readback | `{status,text,ast,refused}` | PILOT | engine at `readbackAt` |
| `transmission` | aircraft/-1 | ATC line | `{ast,result,who}` | ATC / AI | `engine.onTransmission` |
| `startup` / `pushback` | aircraft | state text | — | SYS | engine timers |
| `airborne` / `touchdown` / `runway_vacated` / `arrived` / `departed` | aircraft | — | — | PILOT | engine |
| `go_around` | aircraft | reason | — | PILOT | `initiateGoAround` |
| `landing_clearance` | aircraft | — | `{runway,cleared}` | SYS | `cmdClearedLand` |
| `handoff` | aircraft | "contact tower 118.5" | `{from,to}` | PILOT | `cmdHandoff` / auto-handoff |
| `wake` | -1 | timer text | `{runway,leader,expiresAt}` | SYS | engine at rotation |
| `runway_state` | -1 | "RWY 27L closed" | `{runway,status,previous,reason}` | SYS | `setRunwayStatus` |
| `atis` | -1 | broadcast | `{atis,reason}` | SYS | `WeatherModel.step` |
| `vehicle` | -1 (callsign = vehicle id) | "FIRE 1 -> RWY 27L, ETA 02:10" | `{vehicleId,state,target,etaS}` | SYS | `VehicleFleet` |
| `emergency` | aircraft | MAYDAY line | `{emergency,change}` | PILOT | emergencies |
| `alert` | -1 | title | `{alert,change}` | SYS | `AlertEngine` |
| `ground_conflict` / `separation_loss` / `diversion` / `fuel_exhaustion` | aircraft | — | — | SYS | engine |
| `score` | aircraft/-1 | "+10 landed" | `{score}` | SYS | engine ledger |
| `removed` | aircraft | — | `{reason}` | SYS | engine retire |
| `info` | any | free text | — | SYS | anything |

Store routing: `ev.who ?? EVENT_WHO[ev.type]`; `phase`/`stage` are NOT logged (UI reads them),
`request` drives REQ chips, `alert` drives toasts, `readback` closes the undo ring.

---

## 5. The chain: stage -> actions -> AST -> dispatch -> result

```
AircraftState ──stage(a, StageCtx)──▶ Stage
Stage + ActionCtx ──actionsFor(a, ctx)──▶ ActionRow[] (enabled | disabled+reason, steps, hotkey, primary)
ActionRow.steps ──UI stepper──▶ ActionParams
toAst(actionId, params, callsign, a) ──▶ CommandAST
dispatch(engine, ast) ──guard──▶ applyToEngine ──▶ SimEngine.cmd*(...) : EngineOutcome
        └─ phraseology.transmission/readback(ast, engine.phraseCtx(a)) ──▶ CommandResult{ok, code, transmission, readback, ...}
engine.onTransmission(ast, result, a) ──▶ events: transmission (now), readback (at readbackAt)
```

### Worked example — click **Taxi** on BAW117 (stage `startup`), runway 27L via A, B

1. `stage(a, ctx)` -> `'startup'` (phase `startup`).
2. `actionsFor(a, ctx)` returns (among others) `{ id:'action-taxi-runway', state:'enabled', hotkey:'T', steps:[runway, taxiway-route, confirm] }`.
   The runway step defaults to `a.plan.runway` ('27L'); the route step is `auto:true`; the UI route
   builder inserts a hold-short pill at every runway crossing (here 27R).
3. Stepper collects `params = { runway:'27L', route:{ via:['A','B'], auto:false, holdShortOf:{kind:'runway',runway:'27R'} } }`.
4. `toAst('action-taxi-runway', params, 'BAW117')` ->
   ```json
   {"kind":"taxi","callsign":"BAW117","dest":{"kind":"runway","runway":"27L","intersection":null},
    "via":["A","B"],"auto":false,"holdShortOf":{"kind":"runway","runway":"27R"},"cross":[],"expedite":false}
   ```
   `describe(ast)` = `Taxi RWY 27L via A, B, hold short 27R` (chip / log summary).
5. `dispatch(engine, ast)`: `guard` passes -> `applyToEngine` -> `engine.cmdTaxi(a, dest, ['A','B'], false, holdShortOf, [], false)`.
   The engine builds the route with `routeVia`, derives `PathHold`s (27R crossing -> `holdShortNode`),
   queues the command behind the ground pilot delay (4-8 s) and returns
   `{ ok:true, code:'ok_queued', applyAt: t+5 }`.
6. Phraseology (ICAO): TX `BAW117, taxi to holding point runway 27L via A, B, hold short of runway 27R.`
   RB `Taxi holding point runway 27L via A, B, hold short 27R, Speedbird one one seven.`
   -> `CommandResult{ ok:true, code:'ok_queued', transmission, readback, readbackAt: t+3, applyAt: t+5 }`.
7. `engine.onTransmission` emits `transmission` now (ATC line with UNDO ring until `applyAt`) and a
   `readback` event at `readbackAt`; the strip's `T` box ticks on `readback.status === 'ok'`.
8. At `applyAt` the pending `taxi` executes: phase `taxi`, stage `taxi_out`; at the 27R hold line the
   aircraft stops (`hold_short`, stage `hold_short_cross`) and raises `request cross 27R`, whose
   `REQUEST_ANSWER` is `action-cross` (primary row).

### Result-code policy (03 §B4)

| code family | transmitted? | pilot reads back? | executes? | scored? |
|---|---|---|---|---|
| `ok`, `ok_queued`, `ok_conditional` | yes | yes | yes (after delay / condition) | safety violations still score ("trap" mechanic) |
| `partial` | yes | yes, with "unable {part}" | remaining parts | as above |
| `queried` | yes | pilot asks back | no | no |
| `unable*` | yes | "Unable ..., {cs}" | no | no |
| silent codes (`not_found`, `invalid_*`, `unknown_*`, `runway_closed`, `weight_class`, `not_at_hold`, `paused`, ...) | no (SYS line) | no | no | no |

`SILENT_CODES` in dispatch.ts is the authoritative list.

---

## 6. Module APIs (signatures)

### stage.ts
- `stage(a: AircraftState, ctx: StageCtx): Stage` — `StageCtx { distToThresholdNM(a, runway), isHoldNodeForRunway(nodeId, runway) }`.
  Task deviation from UX §G1's `stage(a, air)`: the ctx is narrower than `OsmAirport` and lets tests mock it.
- `stageLabel(stage): { short, long, tone }`, `bayFor(a, stage, position): BayId | null` (UX §G7),
  `isGroundStage/isAirStage/isArrivalStage/isDepartureStage`, `GROUND_STAGES`, `AIR_STAGES`, `isAirbornePhase(phase)`,
  `distToThresholdFromPathNM(a)` (landing-path helper for engines/tests), `SHORT_FINAL_NM = 4`, `TAKEOFF_AIR_FT = 50`.
  All 21 members of `Stage` are produced by `stage()`; `departed` is the only column with every matrix cell hidden.

### commandAst.ts
- `CommandAST = AircraftCommand | SystemCommand`; `AircraftCommand = SingleAircraftCommand | SequenceAst`.
  53 kinds = 44 single aircraft kinds (14 ground, 5 tower, 14 approach, 7 meta, 4 emergency) + 8 system kinds + `sequence`.
  Aircraft commands carry `callsign`; system commands (`holdAll resumeAll reopenRunway dispatchVehicle recallVehicle vehicleOp runwayStatus broadcast`) do not.
  Every kind is routed by `applyToEngine` (exhaustive switch) and summarised by `describe()` (exhaustive switch); `transmission()/readback()` cover every kind once W1-SYSTEMS fills the templates.
  Click coverage: 42 kinds are produced by `toAst` for the 47 action ids. The remaining kinds are reached from other surfaces, not from a command-panel row:
  `disregard` (UNDO ring), `recallVehicle` / `vehicleOp` (VehiclePanel), `runwayStatus` / `broadcast` (runway strip context menu / text input),
  `continueApproach` / `squawk` / `ident` / `radarContact` / `roger` (text parser and AI positions), `sequence` (built by the confirm-step `+ ADD PART` chips via `withParts`).
  Decisions: "taxi to stand" = `taxi` with `dest.kind:'stand'` (no separate `taxiToStand` kind); "descend 3000 then ILS" = `sequence`;
  headings are TRUE degrees inside the AST (phraseology converts to magnetic).
- `makeAst(kind, callsign|null, partial)` fills defaults and upper-cases identifiers (nested too); `sequence(cs, parts)`; `sortParts` (ICAO word order); `incompatibleParts`.
- `describe(ast): string` — short summary (not phraseology).
- Guards: `isSystemCommand`, `isAircraftCommand`, `isSequence`, `isGroundCommand`, `isAirborneCommand`, `isMetaCommand`, `isUndoable`, `callsignOf`, `flatten`, `kindsOf`.
- `CommandResult`, `ResultCode`, `EngineOutcome`, kind groups (`GROUND_KINDS`, `NO_UNDO_KINDS`, `IMMEDIATE_KINDS`, ...).

### commandTree.ts
- `ActionId` (47 ids = every `action-*` / `emerg-*` in UX §10 + §G12 incl. `emerg-resume-all`).
- `REASONS: Record<ReasonCode,string>` R1-R24 verbatim + X1-X13 (the other quoted strings of §G2/§G13); `reasonText(code, params)`.
- `ACTION_MATRIX: Record<ActionId, Record<Stage, Cell>>` with `Cell = '-' | 'on' | 'off:Rn' | 'dyn:rule'`; `DYNAMIC_RULES[rule](a, ctx)` for every "iff" clause; `evaluateCell`.
- `ActionCtx` — everything the rules need, built by the store per selected aircraft.
- `stepsFor(id, a, ctx): PickerStep[]` — pickers: `runway | taxiway-route | heading | altitude | speed | fix | hold | direction | taxiway | gate | aircraft | vehicle | position | text | confirm` (the task's 12 + `taxiway/gate/aircraft` needed by UX §1.2). `confirm.parts` = `+ ADD PART` chips.
- `actionsFor(a, ctx): ActionRow[]` — implemented; applies paused (X12), strict-frequency (R13), hold-all (R24); `primary` = answer to the pending REQ (`REQUEST_ANSWER`) or `emerg-ack`.
- `toAst(actionId, params, callsign, a?)` — implemented for all 47 ids; throws on a missing mandatory param.
- `hotkeyFor(id, stage)`, `resolveHotkey(key, rows)` — §1.3 letters with §G2 collision rules (T/H/X/I/E/C/R/D/A/P); emergency chords `M,A M,I M,D M,H M,B M,E M,R M,C M,X`.
- `POSITION_DEFAULT_ROW`, `ACTION_DEFS`, `softWarnings`.

### dispatch.ts
- `EngineCommandApi` — the exact method set `SimEngine` must expose (W1-ENGINE): `cmdStartup cmdPushback cmdTaxi cmdHoldShort cmdHoldPosition cmdContinue cmdCross cmdGiveWay cmdLineUp cmdTakeoff cmdCancelTakeoff cmdCancelLineup cmdExitAt cmdExpedite cmdClearedLand cmdContinueApproach cmdGoAround cmdWindCheck cmdHandoff cmdHeading cmdAltitude cmdSpeed cmdDirect cmdHold cmdILS cmdLOC cmdVisual cmdCancelApproach cmdExpectRunway cmdResumeSid cmdSquawk cmdIdent cmdRadarContact cmdSayAgain cmdCorrection cmdDisregard cmdStandby cmdUnable cmdReport cmdRoger cmdEmergencyAck cmdPriority cmdStopOnRunway cmdEmergencyCancelAck holdAll resumeAll reopenRunway dispatchVehicle recallVehicle vehicleOp setRunwayStatus broadcast` + `find pilotDelayS phraseCtx onPlayerFrequency onTransmission time paused`.
  Every `cmd*` takes the `AircraftState` (not a callsign) and returns `EngineOutcome` (no text).
- `applyToEngine(engine, ast, a)` — implemented routing table. `guard(ast, a, engine)` — pure pre-flight. `dispatch(engine, ast, opts)` — stub. `composeResult`, `isSilent`, `isImmediate`.

### phraseology.ts
- `PhraseCtx { variant, telephony(cs), unit(pos), freq(pos), wind, qnh, atisLetter, magVar, transitionAltFt, time, aircraft, spokenType(icao) }`.
- Implemented: `telephony`, `spellPhonetic`, `spokenDigits` (ICAO tree/fife/niner), `groupNumber` (FAA), `spokenRunway`, `spokenAltitude` (feet <= TA, FL above; FAA FL >= 18 000), `altitudeLabel`, `magneticHeading/trueHeading`, `spokenHeading`, `spokenFrequency` (decimal/point), `spokenWind` (ICAO/FAA), `spokenTaxiways`, `spokenEfc`, `AIRLINE_TELEPHONY`.
- Stubs: `transmission(ast, ctx)`, `readback(ast, ctx, variant?, refused?)`, `pilotRequestLine(req, ctx)`, `unableLine(ast, reason, ctx)`. Templates: 03 §7 (ICAO column) + UX §1.4 TX/RB; FAA diffs in the file header.

### vehicles.ts
- `VehicleFleet`: `init(air, stations, fleet?)`, `dispatch(type, target, ids?, count?) : DispatchResult`, `recall(id)`, `op(id, hold|continue|cross|rtb, runway)`, `step(dt, ctx: VehicleStepCtx): VehicleStepResult`, `list()`, `byId`, `available(type)`, `stationFor(type)`, `onRunway(ref)`, `clear()`.
- Data: `DEFAULT_FLEET` (FIRE1-3, AMB1, FOLLOW1, TUG1-2, OPS1, SWEEP1, BIRD1 with km/h per surface), `VEHICLE_CONST` (ARFF roll-out 60-120 s, 180 s response limit, on-scene dwell per type), `defaultStations(center)`.
- Engine hook: `engine.update` calls `fleet.step` each fixed step and applies `enteredRunway/vacatedRunway` to `RunwayState.occupiedBy`; `crossingRequests` become vehicle REQ strips.

### emergencies.ts
- `EMERGENCY_CATALOGUE: Record<EmergencyType, EmergencySpec>` — 12 primary (03 §4.1-4.12) + `brake_fire` (ground, 03 §F4.13 / UX §G5.12): level, squawk, weight, spawn stages, pilot line, ack reply, required checklist, ARFF level, runway preference, perf modifiers, land-within, fuel range, stop-on-runway / closure / evacuation probabilities, bonuses.
- `EMERGENCY_RATE` (off/rare/normal/training per sim hour), `SOULS_BY_CLASS`, deadlines.
- `createEmergency(...)` (implemented), `ackReplyLine` (implemented); stubs: `maybeDeclare(a, rng, view, setting)`, `onDeclared(view, a)`, `stepEmergency(view, a, dt)`, `handleLanded(view, a): closureMin`, `completeChecklistItem`, `scoreOnResolved`, `scoreChecklistMiss`.
- `EmergencyEngineView { time, aircraft, stageOf, bestRunway, setRunwayStatus, emit, score, telephony }`.

### weather.ts
- `WeatherModel`: `init(cfg: WeatherInit, rng)`, `step(dt): WeatherStepResult{events, atisChanged, suggestion}`, `state()`, `atis()`, `regenerateAtis(reason, dep, arr, remarks)`, `suggestRunways(ends, current)`, `applyWindToGroundSpeed(hdgTrue, tasKt)` (implemented via `applyWind`), `componentsFor(rwyHdg)`, `crosswindGoAroundP(weightClass, rwyHdgTrue)`, `gustGoAroundP()` (03 §D4 pilot go-around probabilities at 1000 ft; stubs), `setWind`, `scheduleEvent`.
- Implemented helpers: `windComponents`, `runwayScore` (03 §A12 formula), `transitionLevel`, `nextAtisLetter`, `atisWindTrigger`, `isLvp`, `defaultWeather`, `WX` constants.
- Wind affects airborne motion only (engine moves along `trackTrue` at `gsKt`); ground speed is not wind-affected (UX §G5.4).

### alerts.ts
- `AlertEngine`: `step(aircraft, vehicles, runways, dt, ctx: AlertStepCtx): AlertStepResult` (stub), `raise(kind, subjects, title, detail, time, geometry?, ids?)` (dedupes by kind+subjects), `ack(id, time)`, `resolve(id, time)`, `list/active/byId/clearResolved/clear`, `stca()` (test API shape).
- `cpa(a, b, maxS)` implemented (linear CPA with vertical rates); `verticalSpeedFpm(a)`; `ALERT_CONST`, `ALERT_SEVERITY`.

### testApi.ts
- `AtcTestApi` — every member of 05 §2.2 verbatim (`ready mapReady features reset seed advance advanceUntil advanceReal lastStepDt time snapshot aircraft radio events clearEvents runways beacons gates taxiways spawnAt setState remove clear setAutoSpawn setAutoTower setScore setSkill command screenPos screenPosOf emptySpot camera setWind setActiveRunways forceEmergency arff stca atis wakeTimers`) + §G12 extras (`setPilotDelay setWeather request state alerts ackAlert vehicles runwayStates setRunwayStatus stage actions dispatchAst setPosition select`).
  `forceEmergency(cs, kind: EmergencyType)` is a superset of the spec's 5-kind union.
  05 §3.2 helpers `centerOn(cs)` and `setCamera(cam: CameraView)` are members too (canvas hit-testing needs them).
- `SpawnSpec` verbatim + `onFrequency/landingCleared/emergency`. `AircraftView` = the §2.2 list + Wave-0 fields (`stage requests emergency landingCleared holdShortNode holdShortRunway onFrequency handedTo goAround squawk pushbackStage startupReadyAt reservedStand fuelMin`).
- `TestApiHost` — what `createTestApi(host)` needs from `SimStore` (W2-STORE implements): `testMode loading paused rate icao selectedId autoSpawn mapReady radio lastStepDt eventLog engine step emit load enableTestMode command select setRate setPosition screenProject camera setCamera`.
- `FEATURE_DEFAULTS` — all false until the module is wired.

---

## 7. Engine API for the store/UI (Wave 2 handbook — matches `src/lib/sim` as of Wave 1b)

Everything below is what `SimEngine` (`src/lib/sim/engine.ts`) and the command layer actually expose today.
`tests/engine/helpers.ts` (`makeEngine`) and `tests/integration/session.test.ts` are the executable reference:
the integration test drives a complete 30-minute EGLL session through nothing but this API.

### 7.1 Construction and load sequence

```ts
import { buildOsmAirport } from '@/lib/osmAirport';                       // fetch /maps/osm/{ICAO}.geojson yourself (loadOsmAirport(icao) does the fetch)
import { loadEndlessAirport, coordToXY } from '@/lib/airspace/eairport'; // /public/airspace/{ICAO}.txt (optional: no file = no radar, arrivals spawn on short final)
import { SimEngine, AirspaceConfig } from '@/lib/sim/engine';
import { setSeed } from '@/lib/sim/rng';

setSeed(seed);                                             // BEFORE new SimEngine: the ctor draws sub-streams for weather/emergencies
const air = buildOsmAirport(icao, geojson, { magVarDeg: ap?.airspace.magVar, quiet: true });
const e = new SimEngine(air);                              // builds the taxiway grid, RunwayState[] (both ends of every OSM runway), GateState[],
                                                           // then weather.init (ATIS A) and fleet.init (DEFAULT_FLEET at the OSM stations)
e.setActiveRunwayEnds(activeEnds ?? null);                 // home-page config: ['27R','27L']; null/[] = every end active for both roles (regenerates ATIS)
e.setRunwayWeightAllow(weightAllow ?? null);               // home-page config: { '27L': ['M','H'] } per END; null = all classes everywhere
if (ap) {                                                  // airspace (radar) — projected into engine XY with e.proj
  const centerXY = coordToXY({ kind: 'll', lat: ap.airspace.center.lat, lng: ap.airspace.center.lng }, e.proj);
  const radiusM = ap.airspace.radiusNM * NM_TO_M;
  const cfg: AirspaceConfig = {
    radiusM, centerXY,                                     // centerXY is REQUIRED for the retire/diversion logic (B3); default {0,0} = airport centre
    ilsRunways: ap.runways.map(r => ({ name: r.name, thrXY: coordToXY(r.thrCoord ?? r.coord, e.proj), rwdHdg: r.trueHeading, locCourse: r.localizerCourse, gsDeg: r.glideslopeDeg, thrElevFt: 0, estimated: r.derived })),
    beacons: ap.airspace.beacons.map(b => { const p = coordToXY(b.coord, e.proj); return { id: b.id, x: p.x, y: p.y }; }),
    entries: ap.entryPoints.map(ep => { const p = advance(centerXY, (ep.heading + 180) % 360, radiusM); return { x: p.x, y: p.y, heading: ep.heading, altFt: ep.altitudeFt, beacon: ep.beacon, weight: ep.weight }; }),
    magVar: ap.airspace.magVar, transitionAltFt: ap.airspace.transitionAltFt, airportName: ap.name,
    frequencies: { tower: '118.500' /* Partial<Record<Position,string>>, defaults in engine */ }, missedApproachAltFt: 3000,
  };
  e.setAirspaceConfig(cfg);                                // also marks RunwayState.hasIls / ilsEstimated
}
e.settings = { ...e.settings, autoTower: false, autoGround: false, autoHandoff: true, emergencyRate: 'normal', pilotErrorRate: 0.02,
               strictFrequencies: false, arcadeIntercept: false, reducedFinalSep: true, region: 'ICAO' /* 'FAA' for K-airports, set by ctor */, pilotDelayOverride: null, despawnParked: true };
e.playerPosition = 'tower';                                // 'ground' | 'tower' | 'approach' — strict-frequency policy + ActionCtx.position
```

- Runway state is built from the OSM runways (`air.runways`, ends oriented by geometry), NOT from `RUNWAY_MANIFEST`.
  `RUNWAY_MANIFEST` (`src/lib/runwayManifest.ts`) is the home page's picker source; the engine only derives a manifest-shaped
  `RunwayEnd[]` internally for the weather model (`suggestRunways`). The home config reaches the engine through
  `setActiveRunwayEnds` / `setRunwayWeightAllow`; `setActiveRunways(dep[], arr[])` is the dep/arr split (runway-change dialog,
  applying `e.suggestedRunways`) — it clears the suggestion, regenerates ATIS and emits an `info` line.
- `e.systemsAvailable()` reports which systems are live (`weather fleet alerts emergencies phrase`); a system whose stub throws
  "not implemented" is disabled for the session instead of crashing (`safe()` wrapper) — all five are implemented now.
- Data files the store must fetch: `/maps/osm/{ICAO}.geojson` (required), `/airspace/{ICAO}.txt` (optional). Airports with both:
  EGLL KBOS KJFK KLAX KSFO VIDP.

### 7.2 Time: `update` vs `step`, pause, events

- `e.update(realDt: number): SimEvent[]` — real-time driver. Accumulates `min(realDt, 0.25)` (B18 clamp), runs at most
  `MAX_SUBSTEPS = 6` fixed substeps of `FIXED = 1/30 s`, then one post pass (separation, incursions, alerts), returns the
  events produced since the last call. Pass `dt * rate` for the sim-rate control. When `e.paused` it returns the pending
  events without stepping (pending events are never lost).
- `e.step(n = 1): SimEvent[]` — deterministic driver: exactly `n` substeps + one post pass (tests, fast-forward).
- `e.time` (sim seconds), `e.paused`, `e.stats.simTime`. One substep = drain pending commands ▸ nav targets ▸ ground traffic
  rules ▸ physics (`stepAircraft`) ▸ `fleet.step` + `weather.step` ▸ transitions ▸ readbacks ▸ per-second tasks (requests,
  emergencies, stage events, despawn, ATIS/runway checks, AI tower).
- `e.events: SimEvent[]` — ring buffer of the last 500 events (test API / late subscribers). The store should consume the
  arrays returned by `update()`; every event has `type id callsign message at`, optional `who position data`.
  Store routing: `ev.who ?? EVENT_WHO[ev.type]` (`types.ts`). `phase` and `stage` are not logged; `request` drives REQ chips;
  `alert` drives toasts; `readback` closes the UNDO ring; `transmission` is the ATC line (its `data.result` is the CommandResult).
- Events emitted by the systems between steps (fleet dispatch/recall, weather scripts) are re-stamped with the current
  `e.time` when they enter the stream, so `at` is non-decreasing.

### 7.3 Every SimEventType (payload = `ev.data`, discriminated by `data.type === ev.type`)

| type | id/callsign | who (default) | data | when |
|---|---|---|---|---|
| `spawn` | aircraft | SYS | — | any spawn |
| `phase` | aircraft | SYS (not logged) | — | `a.phase` changed |
| `stage` | aircraft | SYS (not logged) | `{from: Stage|null, to: Stage}` | once per second when `stageOf(a)` changed |
| `reached_hold` | aircraft | PILOT | — | stopped at a PathHold ("holding short runway 27L") |
| `request` | aircraft (vehicle id for vehicle crossing requests, id -1) | PILOT | `{request: PilotRequest, change: 'raised'|'recalled'|'answered'|'expired'}` | request scheduler |
| `readback` | aircraft | PILOT | `{status: ReadbackStatus, text, ast: CommandAST|null, refused: string[]}` | at `result.readbackAt`; also pilot replies to report/say again/ack, and "Unable ..." lines |
| `transmission` | aircraft or -1 | ATC (`who:'AI'` for the AI tower) | `{ast, result: CommandResult, who: 'player'|'ai'}` | `onTransmission` (not for SILENT_CODES) |
| `startup` / `pushback` | aircraft | SYS | — | engine timers (tug connecting / pushing / complete / engines stable / hot start) |
| `airborne` / `touchdown` | aircraft | PILOT | — | physics (`aircraft.ts`) |
| `runway_vacated` | aircraft | PILOT | — | after physically clearing the strip (landing or crossing) |
| `arrived` / `departed` | aircraft | PILOT | — | on stand / handed off to external or left the TMA |
| `go_around` | aircraft | PILOT | — | `initiateGoAround` (reason in message) |
| `landing_clearance` | aircraft | SYS | `{runway, cleared}` | `clearedLand` executed |
| `handoff` | aircraft | PILOT | `{from: Position, to: Position}` | frequency change completed (5-15 s after `contact`) |
| `wake` | -1 | SYS | `{runway, leader, expiresAt}` | at rotation |
| `runway_state` | -1 | SYS | `{runway, status, previous, reason}` | `setRunwayStatus` (also emitted, with `status === previous`, when the weather model suggests a runway change) |
| `atis` | -1 | SYS | `{atis: Atis, reason}` | ATIS regenerated (wind/QNH change, runway change, hourly) or a runway suggestion |
| `vehicle` | -1 / callsign = vehicle id | SYS (`who:'PILOT'` for vehicle radio lines) | `{vehicleId, state, target, etaS}` | dispatch / en route / on scene / returning / at station |
| `emergency` | aircraft | PILOT (declaration, pilot updates) / SYS (checklist, services, stopped, resolved) | `{emergency: Emergency, change: 'declared'|'acknowledged'|'services'|'landed'|'stopped'|'resolved'|'update'}` | emergencies |
| `alert` | -1 | SYS | `{alert: Alert, change: 'raised'|'updated'|'acked'|'resolved'}` | `AlertEngine.step` |
| `ground_conflict` / `separation_loss` / `diversion` / `fuel_exhaustion` | aircraft | SYS | — | scored incidents |
| `score` | aircraft or -1 | SYS | `{score: ScoreEvent}` | every ledger entry ("+10 movement — takeoff") |
| `removed` | aircraft | SYS | `{reason: 'arrived'|'departed'|'diversion'|'fuel_exhaustion'|'collision'|'test'}` | aircraft left the sim |
| `info` | any | SYS (`who:'PILOT'`/`'ATC'` when set) | — | free text (pilot remarks, AI lines, all-stations broadcasts) |

### 7.4 Commands: text and click paths

```ts
import { executeText, dispatch, fromEngine, actionCtxFromEngine, DispatchResult } from '@/lib/sim/dispatch';
import { parseCommand, suggest, ParseCtx, ParseResult } from '@/lib/sim/commands';
import { actionsFor, stepsFor, validate, validateAst, toAst, hotkeyFor, resolveHotkey, softWarnings } from '@/lib/sim/commandTree';

// Text line (comm log input / STT):
const { parse, result } = executeText(e, text, ctx?, { lastCallsign, position, who?, ignoreFrequency?, validate? });
//   ctx: ParseCtx from fromEngine(e, { lastCallsign, position, withActions? }) (build once per render; cheap without withActions)
//   parse: ParseResult { ok, ast, callsign, errors: ParseError[], suggestions: string[], tokens, ambiguous?, detachedConditions? }
//   result: DispatchResult = CommandResult { ok, code: ResultCode, transmission, readback, reason?, applied?, refused?, readbackAt?, applyAt? } + { warnings: string[], appliedParts? }
//   A parse failure never reaches the engine: result.code is a SILENT code (not_found / unknown_* / invalid_param / not_implemented) and result.reason the parser message.
// Autocomplete: suggest(prefix, ctx): Suggestion[] { text, kind, label, score } — same ParseCtx.
// Click tree:
const actx = actionCtxFromEngine(e, a, { position: e.playerPosition });   // ActionCtx (null only if the engine cannot report a stage)
const rows = actionsFor(a, actx);                                          // ActionRow[] { id, label, hotkey, group, state, reason, reasonText, soft, steps, primary, order }
const steps = stepsFor(id, a, actx);                                       // PickerStep[] (runway | taxiway-route | heading | altitude | speed | fix | hold | direction | taxiway | gate | aircraft | vehicle | position | text | confirm)
const v = validate(id, params, a, actx);                                   // ValidationResult { ok, errors, warnings, ast } — hard errors block, warnings = amber TRANSMIT ANYWAY
const ast = toAst(id, params, a.callsign, a);                              // throws on a missing mandatory param
const r = dispatch(e, ast, { ctx: actx });                                 // same DispatchResult as executeText; pass `ctx` to reuse the panel's ActionCtx
hotkeyFor(id, stage); resolveHotkey(key, rows, after?);                     // §G6 letters / chords ("M,A")
```

- `dispatch` order: callsign resolve ▸ `guard` (paused, malformed) ▸ strict frequency (R13, skipped for `who:'ai'` /
  `ignoreFrequency`) ▸ UX §G3 `validateAst` (silent hard code → SYS line; `unable_*` hard code → transmitted with an
  "Unable ..." readback) ▸ `applyToEngine` per part ▸ phraseology TX/RB ▸ `e.onTransmission` exactly once.
- Sequences ("descend 3000 then cleared ILS 27L"): parts apply in spoken order and share ONE pilot delay; the first silent
  refusal rolls the already-queued parts back (`cmdDisregard`) and fails the whole transmission (`appliedParts` says what
  survived); pilot-side `unable_*` parts are collected in `refused` with code `partial`.
- Result codes: `ok` (immediate), `ok_queued` (executes at `applyAt`), `ok_conditional` (`PendingCmd.condition`: after
  pushback / on reaching the hold / behind aircraft / at altitude / after fix / after vacated), `partial`, `queried`
  (pilot asks back; nothing executes), `unable*` (transmitted, refused by the pilot), and the SILENT codes listed in
  `SILENT_CODES` (nothing transmitted; show `result.reason` as a SYS line).
- The engine never needs a CommandAST callsign it cannot `find()`: `e.find(cs)` matches callsign or flight number.
- Undo: `cmdDisregard` (AST kind `disregard`) drops the newest cancellable pending command; the UNDO ring is open until
  `result.applyAt`; `commandTree.canUndo/undoAst/inverse/snapshotFor` model it.
- Legacy: `parseCommand(engine, text)` still works through a `globalThis.__atcDispatch` shim installed by `dispatch.ts`
  — delete that call site and the overload when the store switches to `executeText`.

### 7.5 Stage, labels, bays

`e.stageOf(a): Stage` (21 stages, UX §G1) — the UI gates on this, never on `a.phase`.
`stageLabel(stage): { short, long, tone }`, `bayFor(a, stage, position): BayId | null`, `isGroundStage/isAirStage/isArrivalStage/isDepartureStage`
from `stage.ts`. `stage` events fire once per sim second when it changes.

### 7.6 Spawning and removal

- `e.spawnDeparture({ atHold?, type?, callsign?, stand?, runway? }): AircraftState | null` — parked on a free stand
  (`needsPushback` from the stand), pushback/startup request 20-90 s later, `plan.runway` = an active open departure end.
- `e.spawnArrival({ type?, callsign?, entryKey? })` — weighted boundary entry (needs `entries`), spaced behind the previous spawn on
  the same entry (radar/wake minimum + 1 NM), stand reserved (`GateState.reservedFor`), "with you" 2 s later; without airspace
  data it falls back to an 11 km final. `e.spawnArrivalAtEntry(pos, heading, altFt, beacon?, opts?)` is the explicit form.
- `e.spawnAt(spec: SpawnSpec): AircraftState` — deterministic factory (05 §2.2): `{ callsign, type?, kind, phase, gate? | runway? |
  taxiwayNode? | posRel? | posLL?, heading?, speedKts?, altFt?, targets?, plan?, ils?, hold?, taxiTo?, onFrequency?, landingCleared?, emergency? }`.
  Note: airborne `spawnAt` aircraft do not raise "with you" (they are `underControl` already).
- `e.remove(id, reason)`, `e.clear()`; `e.declareEmergency(a, type: EmergencyType): Emergency` (test API `forceEmergency`).
- Retire: departures are removed at 0.92 R (`departed` when handed to external or above FL90, else `DIVERSION_UNHANDLED`);
  arrivals outside 1.05 R after entering (or flying away) are diverted; parked arrivals despawn after 120-300 s when
  `settings.despawnParked`.

### 7.7 Query surface (read-only unless stated)

| Need | Call |
|---|---|
| aircraft | `e.aircraft: AircraftState[]`, `e.find(cs)`, `e.byId(id)`, `e.counts()` → `{ total, dep, arr, air, gnd, conf }`, `e.viewOf(a): AircraftView` (plain JSON), `e.snapshotForTest(): AircraftView[]` |
| per aircraft | `a.requests[0]` (open PilotRequest), `a.pendingCmds`, `a.readback`, `a.emergency`, `a.landingCleared`, `a.holdShortRunway/holdShortNode`, `a.onFrequency`, `a.handedTo`, `a.plan.{runway,gateRef,fix,taxiRoute}`, `a.delay` (DelayStats), `a.wakeCategory`, `a.squawk` |
| runways | `e.runways` / `e.runwayStates(): RunwayState[]` (per END; both ends of a physical runway share status/occupants/wake timer), `e.runwayState('27L')`, `e.activeEnds('dep'|'arr')`, `e.runwayByEnd(name)` (OSM geometry), `e.thresholdXY(name)`, `e.runwayHeading(name)`, `e.runwayOccupied(name, exceptId?)`, `e.runwayOccupant(name, exceptId?)`, `e.runwayPhysicallyClear(name, exceptId)`, `e.arrivalOnFinal(name, nm)` → `{ callsign, nm, a }`, `e.rollingDeparture(name)`, `e.crossingSafe(name, crossingS = 35)`, `e.parallelRunways(name)`, `e.isOnRunway(a)`, `e.distToNextHold(a)` |
| runway status (write) | `e.setRunwayStatus(name, 'open'|'closed'|'sterile'|'inspection', reason)`, `e.reopenRunway(name, afterInspection)` (tows a disabled emergency aircraft clear), `e.setActiveRunways(dep, arr)`, `e.setActiveRunwayEnds(ends)`, `e.setRunwayWeightAllow(map)`; all EngineOutcome / regenerate ATIS / emit `runway_state` |
| wake | `e.wakeTimers(): Record<end, { runway, leader, remainingS }>`, `e.wakeTimerRemainingS(name, followerCategory?)`, `rs.wakeTimer`, `rs.lastDeparture/lastArrival` |
| stands / gates | `e.gates` / `e.gateStates(): GateState[]` (`{ ref, nodeId, terminal, occupiedBy, reservedFor, needsPushback, closed }`), `e.gateByRef(ref)`, `e.standOccupant(ref)` (callsign occupying or reserving) |
| geometry | `e.proj` (LocalProjection: `toXY(lat,lng)` / `toLngLat(x,y)`), `e.nodeXY(nodeId)`, `e.nearestNodeId(xy, maxM?)`, `e.distToRunway(xy, ref)`, `e.runwaysAt(xy)`, `e.air` (OsmAirport: nodes, taxiwayNames, taxiwayNodes, stands, holdingPositions, stations), `e.pathFromNodes(ids, holdAtEnd?, from?)` (DrivePath with PathHolds) |
| airspace | `e.centerXY`, `e.airspaceRadiusM`, `e.beacons` (`{id,x,y}` — the only "fixes"; no SID/STAR database exists, `navMode:'sid'` flies to `plan.fix`), `e.entries` (`{x,y,heading,altFt,weight,beacon?,key}`), `e.ilsRunways: ILSRunway[]`, `e.magVar`, `e.transitionAltFt`, `e.frequencies: Record<Position,string>`, `e.unitName(position)`, `e.telephony(cs)` |
| weather / ATIS | `e.wx(): WeatherState`, `e.atisLetter()`, `e.weather.atis(): Atis` (full broadcast `text`), `e.weather.state()`, `e.windFor(rwyHdgTrue)` → `{ headKt, crossKt, crossFrom }`, `e.windSpoken()`, `rs.windHeadKt/windCrossKt` (live per end), `e.suggestedRunways` (`{ dep, arr, reason } | null` — the "Change runway" prompt; apply with `e.setActiveRunways`), `e.setWind(dirTrue, kts, gust?)` (scenario / test hook, re-evaluates the suggestion), `e.weather.setState(patch)`, `e.weather.scheduleEvent(ev)` |
| vehicles | `e.fleet.list(): Vehicle[]` (`{ id, callsign, type, state: standby|enroute|onscene|returning, pos, heading, speed, target, path, holdShortRunway, onRunway, etaAt, ... }`), `e.fleet.byId(id)`, `e.fleet.available(type)`, `e.fleet.onRunway(ref)`, `e.fleet.responding()`, `e.fleet.etaS(id)`, `e.fleet.arffOnScene(refOrEnd)`; commands through the ASTs `dispatchVehicle / recallVehicle / vehicleOp` (or `e.dispatchVehicle(type, ids, count, target)`, `e.recallVehicle(id)`, `e.vehicleOp(id, op, runway)`) |
| alerts | `e.activeAlerts(): Alert[]`, `e.alerts.list()/active()/byId(id)/forSubject(cs)/escalated(time)`, `e.alerts.ack(id, time)`, `e.alerts.resolve(id, time)`, `e.alerts.stca()` |
| emergencies | `a.emergency: Emergency` (`{ type, level, status, checklist, runway, sterile, arff, arffOnSceneAt, stopOnRunway, closureMin, requests, pilotLine, ... }`), `e.holdAllActive` (`{ scope, runway } | null`), `e.bestRunwayFor(a, pref)`; commands through the `emergencyAck / priority / stopOnRunway / emergencyCancelAck / holdAll / resumeAll / reopenRunway` ASTs |
| requests | `a.requests` (at most one open per aircraft; `answeredAt == null` = open), `request` events; answered automatically when a command of an answering kind is dispatched, `standby` pushes the recall by 120 s, `unable` refuses |
| score / stats | `e.stats: SessionStats` (`points`, `skill` 0-12, `score` = best skill, `movements`, `departures`, `arrivals`, `movementsPerHour`, `movementsHistory` (5-min buckets), `delayAvgS/delayP95S`, `incidents`, `ledger: ScoreEvent[]`, `goAroundsPlayer/Pilot`, `diversions`, `emergenciesDeclared/Resolved`, `arffResponseS`, `transmissions`, `responsivenessMeanS`, `unansweredRequests`, `streakS`), `e.score` / `e.skill` (get/set, legacy), `e.addScore(code, primary, secondary?, runway?, detail?)` (test hook) |
| settings | `e.settings` (EngineSettings, mutable), `e.autoTower` / `e.autoGround` (legacy get/set), `e.playerPosition`, `e.paused` |
| phraseology | `e.phraseCtx(a | null): PhraseCtx` (for `transmission()/readback()/pilotRequestLine()` previews), `e.pilotDelayS(a, kind)`, `e.onPlayerFrequency(a)` |

### 7.8 Worked example — the store loop (30 lines)

```ts
class SimStore {
  engine!: SimEngine; log: Line[] = []; selectedId: number | null = null; lastCallsign: string | null = null;
  rate = 1; paused = false; private last = 0; private nextSpawn = 0;
  async load(icao: string, cfg: { ends: string[]; weightAllow: Record<string, WeightClass[]>; seed: number }) {
    const [fc, ap] = await Promise.all([fetch(`/maps/osm/${icao}.geojson`).then(r => r.json()), loadEndlessAirport(icao).catch(() => null)]);
    setSeed(cfg.seed);
    this.engine = new SimEngine(buildOsmAirport(icao, fc, { magVarDeg: ap?.airspace.magVar, quiet: true }));
    this.engine.setActiveRunwayEnds(cfg.ends); this.engine.setRunwayWeightAllow(cfg.weightAllow);
    if (ap) this.engine.setAirspaceConfig(airspaceConfigFrom(ap, this.engine.proj));   // §7.1 (centerXY + entries + ILS + beacons)
    for (let i = 0; i < 4; i++) this.engine.spawnDeparture();
    for (let i = 0; i < 3; i++) this.engine.spawnArrival();
    requestAnimationFrame(this.tick);
  }
  tick = (now: number) => {
    requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.last) / 1000, 0.1); this.last = now;
    if (this.paused) return;                                                    // (or engine.paused = true: update() returns pending events)
    for (const ev of this.engine.update(dt * this.rate)) this.route(ev);         // §7.2 / §7.3
    const e = this.engine;
    if (e.time >= this.nextSpawn && e.aircraft.length < Math.ceil(e.skill) + 6) { chance(0.55) ? e.spawnDeparture() : e.spawnArrival(); this.nextSpawn = e.time + rf(40, 90); }
    this.emit();
  };
  route(ev: SimEvent) {
    if (ev.type === 'phase' || ev.type === 'stage') return;
    if (ev.type === 'alert' && ev.data?.type === 'alert') this.toast(ev.data.alert);
    this.log.push({ who: ev.who ?? EVENT_WHO[ev.type], text: ev.message, at: ev.at, callsign: ev.callsign, position: ev.position });
  }
  command(text: string) {                                                        // comm-log input (click panel: dispatch(engine, toAst(...), { ctx }))
    const { parse, result } = executeText(this.engine, text, fromEngine(this.engine, { lastCallsign: this.lastCallsign, position: this.engine.playerPosition }));
    if (parse.callsign) this.lastCallsign = parse.callsign;
    if (!result.ok && isSilent(result.code)) this.log.push({ who: 'SYS', text: result.reason ?? result.code, at: this.engine.time });
    return result;                                                              // transmission + readback lines arrive as events (§7.3)
  }
}
```

### 7.9 Behaviour the UI can rely on (implemented and covered by tests)

- Departures: parked → (pushback request) → `pushback` (tug 20-40 s, ≤ 3 kt, disconnect 20-30 s) → `startup` (engines 90-240 s
  by type, 4 % hot start +300 s) → taxi request → taxi with hold-short PLACES (`a.path.holds`, one per runway crossed +
  the departure entry; crossings need `cross`, the entry needs `lineup`/`takeoff`) → HOLD_POINT → auto handoff to tower →
  "ready" → line-up → takeoff (spool 8-15 s, runway heading to 400 ft, wake timer at rotation) → auto handoff to departure at
  `clearance.autoHandoffAlt` → `contact <external>` → `departed`.
- Arrivals: `radarContact` / vectors / `altitude` / `speed` / `direct` / `hold` / `ils` (25-30° intercept, capture from
  below or within 200 ft above the slope) → auto handoff to tower at 10 NM established → landing clearance mandatory
  (query at 4 NM, go-around at 2 NM / 300 ft; `continueApproach` moves it to 1 NM) → touchdown 300-450 m → exit (pilot's
  high-speed exit or `exitAt`) → `runway_vacated` → auto handoff to ground → taxi-in request → `taxi` to stand → `arrived`.
- Crossings: `cross <rwy>` from the hold; `cross <rwy> behind <cs>` starts once the landing aircraft has rolled past the
  crossing point (03 D12 "behind the landing traffic"); the R3 tree guard is bypassed by `behind`. Budget ~65-80 s at EGLL S3/N3.
- A departure that is cleared for an approach (`ils`) is handled as an arrival from then on (emergency returns).
- Separation: 3 NM / 1000 ft radar, 2.5 NM same final < 10 NM, wake matrix in trail; exemptions for independent parallel
  ILS, both on final < 1600 ft, diverging departures, 60 s go-around grace and a parallel-runway departure in its initial
  climb vs an arrival on the other runway (segregated mode).
- Emergencies: `declareEmergency` / random (`settings.emergencyRate`), `emergencyAck` → `priority <rwy> [sterile]` (sterile
  runway usable only by that aircraft, in engine and tree) → ARFF `dispatchVehicle` (3 = "full") → landing → stop on the
  runway (closure) → `emergencyCancelAck` → `reopenRunway <rwy> after inspection` (tows the aircraft, INSPECTION_CLEAN).
- Weather: `weather.step` random walk + scripted events; ATIS letter advances on significant change; a runway suggestion
  (`e.suggestedRunways`, `atis` + `runway_state` events) appears within 60 s of a wind reversal.

## 8. Deviations / decisions to confirm

- `engine.ts`: besides the `base()` body, the import line gained `newAircraftFields` (unavoidable to reference the defaults without duplicating 43 fields).
- `PendingCmd` remains a single interface with optional extras for compatibility with the existing `enqueuePilotCmd`; W1-ENGINE should make `ast/issuedAt/cancellable` effectively mandatory in new code.
- `RunwayStatus` has no `wet` (master plan enum); surface condition is `RunwayState.surface`.
- `EmergencyType` has 13 members (12 + `brake_fire`); UX §1.4's `depressurization/gear/bird_strike/smoke/hydraulic/brake_fire` names are used verbatim, 03's "unlawful interference" is `hijack`, "radio failure" is `radio_failure`.
- `Position` includes `departure` (UX picker-position); it is worked from the APPROACH tab (`POSITION_OWNER`).
- Reason strings keep the spec's em dashes (R6, R10, R16, X8, X13) because tests assert `data-reason` verbatim.
- `stage()` takes a `StageCtx`, not `OsmAirport`.
- R22's `{dep|arr}` placeholder is spelled `{role}` in `REASONS` (filled with `dep` / `arr`); the rendered string is identical to the spec.
- `PendingCmdKind` lists `heading | altitude | speed` explicitly ahead of `CommandAST['kind']` (they are also AST kinds) to document the legacy numeric drain.

## 9. Wave-0 review (coherence pass)

Checked after both Wave-0 agents finished: `npx tsc --noEmit` clean; every symbol in §6 exists with the documented signature;
all 47 action ids of UX §10 + §G12 are `ActionId`s with a matrix row, `stepsFor` and `toAst` case; R1-R24 are typed `ReasonCode`s with the
§G2 strings verbatim; every `CommandAST` kind has an `applyToEngine` route and a `describe()` case. Fixes applied in the pass:
`centerOn/setCamera` added to `AtcTestApi` (+ `setCamera` on `TestApiHost`); `crosswindGoAroundP/gustGoAroundP` declared on `WeatherModel`
(the class comment already promised them); the kind count corrected to 53.

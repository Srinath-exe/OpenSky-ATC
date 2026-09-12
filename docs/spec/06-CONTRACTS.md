# SkyControl — Engine Contracts (Wave 0)

Binding interfaces every Wave 1/2/3 agent codes against. Where this document and a
Wave-0 source file disagree, **the source file wins** (it compiles; this is the map).
Where a contract and `00-MASTER-PLAN.md` disagree, the master plan wins and the
contract owner fixes the file.

All Wave-0 files compile together with the existing engine (`npx tsc --noEmit` clean).
Stub bodies throw `Error('not implemented')`; pure helpers, data tables and the
matrix evaluator are implemented and smoke-tested.

---

## 1. Module map and ownership

| File (`src/lib/sim/`) | Status | Wave 0 wrote | Wave 1 owner | Wave 2 owner |
|---|---|---|---|---|
| `types.ts` | complete | all shared types, defaults, tables | — (PR to W0 owner for additions) | — |
| `rng.ts` | complete | mulberry32, `setSeed/rng/rnd/ri/rf/chance/isSeeded/subStream` | — | — |
| `stage.ts` | complete | `stage()`, `stageLabel()`, `bayFor()`, classification helpers | — | — |
| `commandAst.ts` | complete | AST union, `CommandResult`, `EngineOutcome`, `makeAst`, `sequence`, `describe`, guards, kind groups | — | — |
| `commandTree.ts` | contract + data | `ActionId`, `REASONS`, `ACTION_MATRIX`, `DYNAMIC_RULES`, `stepsFor`, `actionsFor`, `toAst`, `hotkeyFor`, `resolveHotkey` | **W1-COMMANDS** (refine rules / soft warnings / candidates; never rename ids or reason strings) | — |
| `dispatch.ts` | contract stub | `EngineCommandApi`, `applyToEngine` (AST -> method routing), `guard`, `dispatch` (stub), `composeResult` | **W1-COMMANDS** | — |
| `phraseology.ts` | contract stub | `PhraseCtx`, telephony + spoken-number helpers (implemented), `transmission/readback/pilotRequestLine/unableLine` (stubs) | **W1-SYSTEMS** | — |
| `vehicles.ts` | contract stub | `VehicleFleet` class API, `DEFAULT_FLEET`, `VEHICLE_CONST`, `VehicleStepCtx/Result` | **W1-SYSTEMS** | — |
| `emergencies.ts` | contract stub | `EMERGENCY_CATALOGUE` (13 types, data complete), `createEmergency`, hooks (stubs) | **W1-SYSTEMS** | — |
| `weather.ts` | contract stub | `WeatherModel` class API, `windComponents/runwayScore/transitionLevel/applyWind` (implemented) | **W1-SYSTEMS** | — |
| `alerts.ts` | contract stub | `AlertEngine` (raise/ack/resolve/list/stca implemented; `step` stub), `cpa()` (implemented) | **W1-SYSTEMS** | — |
| `testApi.ts` | types complete | `AtcTestApi`, `SpawnSpec`, `Snapshot`, `AircraftView`, `TestApiHost`, `createTestApi` (stub) | — | **W2-STORE** |
| `engine.ts` | existing | only `base()` now spreads `newAircraftFields()` (plus the import) | **W1-ENGINE** implements `EngineCommandApi` + `StageCtx` on `SimEngine` | — |
| `commands.ts` | existing (legacy) | untouched; its `CommandResult{ok,reply}` is legacy | **W1-COMMANDS** rewrites: tokenizer -> `CommandAST` -> `dispatch()` | — |

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

## 7. Engine obligations (for W1-ENGINE, derived from the contracts)

1. Implement `EngineCommandApi` and `StageCtx` on `SimEngine`; expose `stageOf(a)`, `runwayStates()`, `gateStates()`, `fleet`, `weather`, `alerts`, `stats: SessionStats`, `centerXY`.
2. Departures spawn `parked` with `reservedStand`, `needsPushback` (UX §G5.3 rule), `startup/pushback` defaults; arrivals reserve a stand at spawn (`GateState.reservedFor`).
3. Requests: schedule per UX §G8 (one open request per aircraft; `recallAt`; `REQUEST_ANSWER` is the UI default), emit `request` events, accumulate `delay.requestWaitS`.
4. Hold-short as a place: `DrivePath.holds` from the route; `holdShortNode/holdShortRunway` set when stopping; `hold_short_dep` vs `hold_short_cross` via `isHoldNodeForRunway`.
5. Landing clearance: `landingCleared` gates touchdown; no clearance at 1.0 NM / 300 ft AGL -> pilot go-around (`GA_UNHANDLED`); `goAround` flag + phase `go_around`; cleared by handoff or new approach clearance.
6. Every `cmd*` returns `EngineOutcome`; state changes go through `pendingCmds` with `applyAt = now + pilotDelayS` unless `IMMEDIATE_KINDS`; `condition` honoured; `cmdDisregard` drops the newest cancellable entry.
7. Wake: `RunwayState.wakeTimer` from `WAKE_DEPARTURE_S` at rotation; final spacing from `WAKE_FINAL_NM`.
8. Wind: call `weather.applyWindToGroundSpeed` in the airborne integrator; takeoff/landing distance factors per 03 §5.
9. Vehicles: `fleet.step` each fixed step; `runwayOccupied()` includes vehicles and `status !== 'open'`.
10. Emergencies: `maybeDeclare` once per sim second per aircraft; `handleLanded` at touchdown; `EMERGENCY_DONE` on resolve.
11. Scoring: every scored event goes through `SCORE_TABLE` -> `ScoreEvent` -> `SessionStats.ledger` -> `score` event; one incident per (code, primary, secondary) per 60 s.

---

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

# SkyControl e2e harness (Playwright)

Browser tests for the real product: home page, settings page and the `/play` game shell driven
through the deterministic test API (`window.__atcTest`, `src/lib/sim/testApi.ts`). Design:
`docs/spec/05-TEST-STRATEGY.md` (§1 harness, §2 determinism, §3 selectors, §4 scenario matrix).
Where §3.1's legacy table and the code disagree, **the code wins** — see `testids.txt`.

## Running

```bash
bash scripts/e2e.sh smoke            # @smoke subset (typecheck first)           == npm run test:e2e:smoke
bash scripts/e2e.sh                  # full suite                               == npm run test:e2e
bash scripts/e2e.sh grep "hold"      # by title regex
bash scripts/e2e.sh file tests/e2e/smoke.spec.ts
bash scripts/e2e.sh report           # serve playwright-report/                 == npm run test:e2e:report
E2E_TYPECHECK=0 bash scripts/e2e.sh smoke        # skip tsc
PW_ARGS="--trace on" bash scripts/e2e.sh smoke   # extra playwright flags       (npm run test:e2e:trace)
```

* Server: `playwright.config.ts` `webServer` runs `npx next dev -p 3005 -H 0.0.0.0` and **reuses** a server that is
  already listening on 3005 (keep `npm run dev -- -p 3005` running while iterating). Port 3005 is the only port the
  firewall allows. Override with `E2E_PORT` / `E2E_BASE_URL`.
* Browser: the cached chromium in `/root/.cache/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH` is exported by the
  script). No GPU: swiftshader GL flags are set in the config; MapLibre reaches `load` in ~1 s.
* Viewport 1600x950 at dpr 1, `reducedMotion: 'reduce'`, expect timeout 10 s, test timeout 90 s, retries 1
  (trace + video on the retry), 2 workers, files run serially inside themselves (`fullyParallel: false`).
* Output: `test-results/` (artifacts, ignored by git) and `playwright-report/` (HTML).
* No display: `--headed` / `--ui` do not work here; use `--trace on` + `npx playwright show-trace <zip>`.

## Determinism model (read this first)

* Open the game with `?test=1` (the page objects do it for you). In test mode the store never starts its RAF loop:
  **sim time only moves through `sim.advance(seconds)`**, all randomness is seeded from `?seed=`, `?spawn=none`
  boots with zero traffic (`spawn=default` = the seeded 4 departures + 3 arrivals), auto-spawn is off, pilot delay
  is fixed at 3 s, pilot errors and random emergencies are off. Toasts still expire on the wall clock.
* `advance()` is synchronous in the page and the wrapper flushes React afterwards, so DOM assertions right after
  `await sim.advance(n)` are safe. Never `waitForTimeout` for sim progress.
* Commands take effect after the pilot delay: `await sim.advance(3.1)` before asserting `targetHeading`, `cmdAltitude`...
* Engine state comes from `sim.*` (JSON views); visibility comes from the DOM. Assert both.
* Every test gets a fresh browser context (fresh localStorage, fresh `window.__atcSim`). Do not share pages.

## Fixtures (`tests/e2e/fixtures/test.ts`)

```ts
import { test, expect } from '../fixtures/test';   // or './fixtures/test' from tests/e2e/

test('vector an arrival @smoke', async ({ openGame, sim }) => {
  const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
  await sim.spawnAt({ callsign: 'UAL9', type: 'A320', kind: 'arrival', phase: 'descent',
                      posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250 });
  await game.openPanelFor('UAL9');
  await game.action('action-heading');          // opens stepper-action-heading
  await game.dial(210, 'L');                    // picker-heading-input (magnetic) + picker-heading-left
  await game.next();                            // step-next -> confirm step
  const tx = await game.transmit();             // btn-transmit -> panel-result {status, code, tx}
  expect(tx.code).toBe('ok_queued');
  await sim.advance(3.1);
  expect((await sim.aircraftOrFail('UAL9')).targetHeading).toBeCloseTo(210, 0);
});
```

| fixture | what |
|---|---|
| `seed` | option, default 7. `test.use({ seed: 42 })` per file/describe. |
| `sim` | `SimApi` — typed `window.__atcTest` wrapper (below). |
| `game` | `GamePage` — `/play` page object. |
| `home` | `HomePage` — `/` page object. |
| `settings` | `SettingsPage` — `/settings` page object. |
| `openGame(o)` | seeds localStorage (autoTower/autoGround/tts/sound off, onboarding seen) and `game.goto(o)`; returns `game`. `o.settings` merges over the store `Settings` blob, `o.autoTower` is a shortcut. |
| `browserConsole` | auto: records every console message + `pageerror`; **fails the test** on any `console.error` / uncaught error not matching the allowlist in `fixtures/console.ts` (favicon 404, MapLibre AbortError, swiftshader "GPU stall" notices, Next dev warnings). `browserConsole.allow(/re/)` widens it for one test. |
| `afterEach` | on failure attaches `sim-snapshot.json`, `sim-radio.txt`, `sim-events.json` and `browser-console` to the report. |

Also exported from `fixtures/test.ts`: `expectPhase(sim, cs, phase)`, `skipUnless(sim, flag)` / `skipUnlessAll`
(feature gating, `fixtures/features.ts`), `LS_KEYS`, `seedLocalStorage`, `seedSettings`, `readLocalStorage`,
`readLocalStorageJson`, `writeLocalStorage` (`fixtures/storage.ts`, apply seeds **before** `goto`).

### `SimApi` (`fixtures/simApi.ts`) — one method per `__atcTest` member

* lifecycle: `waitReady()`, `isReady()`, `ready()`, `waitMapReady()` / `mapReady()` (MapLibre `load`; GROUND/TOWER only),
  `features()`, `hasFeature(flag)`, `reset({icao, seed, spawn})`, `seed(n)`
* time: `advance(s)` → events, `advanceUntil(predSrc, maxS, stepS?)` → `{ok, elapsed, events}`,
  `advanceUntilOk(...)` (asserts), `advanceUntilPhase(cs, phase, maxS)`, `advanceReal(s)` (rate-scaled), `lastStepDt()`, `time()`.
  `advanceUntil` predicates are **source strings** evaluated in the page against the `Snapshot`:
  `"s => s.aircraft.find(a => a.callsign === 'BAW1')?.phase === 'climb'"`
* read: `snapshot()`, `aircraft(cs)`, `aircraftOrFail(cs)`, `callsigns()`, `radio()`, `lastRadio(who?)`, `events()`,
  `clearEvents()`, `runways()`, `beacons()`, `gates()`, `taxiways()`, `state(cs)` (full `AircraftState`), `stage(cs)`,
  `actions(cs)` (`ActionRow[]` for the current position), `alerts()`, `vehicles()`, `runwayStates()`, `atis()`,
  `wakeTimers()`, `stca()`, `arff()`
* write: `spawnAt(spec)` (05 §2.2 `SpawnSpec`; airborne spawns land in phase `approach`, `underControl`, on the
  approach frequency), `setState(cs, patch)`, `remove(cs)`, `clear()`, `setAutoSpawn`, `setAutoTower`, `setScore`,
  `setSkill`, `setPilotDelay`, `setWeather`, `setWind`, `setActiveRunways`, `setRunwayStatus`, `forceEmergency`,
  `request(cs, kind)`, `ackAlert(id)`, `command(text)` (store path, no DOM — prefer `game.send`), `dispatchAst(ast)`,
  `setPosition(p)`, `select(cs|null)`
* geometry: `screenPos(cs)` (CSS px inside the active canvas: `radar-canvas` on APPROACH, `ground-map` otherwise),
  `screenPosOf(xy)`, `emptySpot()`, `camera()`, `centerOn(cs)`, `setCamera(cam)`
* store-level (read `window.__atcSim`, so they also work on a LIVE boot without `?test=1`): `storeState()` (`{hasEngine,
  testMode, icao, seed, position, rate, paused, highScore, autoSpawn, time, settings, lastConfig, runways}`),
  `storeSettings()` (= `sim.settings`), `engineSettings()` (= `engine.settings`), `hasLiveEngine()`

### `GamePage` (`pages/GamePage.ts`)

* boot: `goto({icao, seed, spawn, position, test, waitMap})`, `waitReady()`, `GamePage.url(o)`
* shell: `position()`, `setPosition(p)` (clicks `mode-tab-{p}`, waits for `view-ground` / `view-radar`), `isPaused()`,
  `togglePause()` (`rate-pause[data-state]`), `setRate(1|2|4)` (`rate-{r}x`), `hotkey(key)` (blurs inputs first;
  `'?'` maps to `Shift+/`)
* strips + panel: `strip(cs)`, `strips()`, `stripCallsigns()`, `selectStrip(cs)`, `openPanelFor(cs)`, `closePanel()`,
  `panel()`, `panelCallsign()`, `panelStage()`, `panelKind()`, `reqBand()` / `reqAnswer()` / `reqUnable()` / `reqStandby()`,
  `metric(k)`, `metricTarget(k)`, `result()`, `resultTx()`, `resultRb()`, `undoChip()`
* actions: `action(actionId)` (grid button `{actionId}`; asserts `data-state=enabled`, falls back to `quick-{actionId}`),
  `quick(actionId)`, `actionState(actionId)` → `{state, reason}`
* stepper: `stepType()`, `next()`, `back()`, `cancel()`, `pickRunway(rwy, mode?)`, `pickTaxiwayRoute({auto, via, holdShort, cross})`,
  `dial(hdgMag, 'L'|'R'|'shortest')`, `ladderAlt(ft, {expedite})`, `ladderSpd(kts | 'final' | 'resume')`, `ladder(value)`
  (whichever ladder is open), `pickFix(fix)`, `pickDirection('L'|'R'|'N'|'E'|'S'|'W'|'any')`, `pickGate(ref)`,
  `pickTaxiway(t)`, `pickAircraft(cs)`, `pickPosition(p)`, `transmit({anyway})` = `confirm()` → `{status, code, tx}`
* comm log: `send(text)` → `{accepted, error}` (Enter; error = `cmd-parse-error` text), `sendOk(text)` → the ATC
  `RadioRow`, `sendViaButton(text)`, `radioRows(who?)`, `readLastRadio(who?)`, `waitRadio(/re/, {who, callsign})`,
  `showAllFrequencies()` (the log is filtered to the position's frequency by default; `radio()` on `sim` is unfiltered)
* toasts: `toastRows()`, `waitToast(/re/)`, `toast(kind)`
* canvas: `activeCanvas()`, `clickAircraft(cs)` (centres first if off-view), `clickEmpty()`
* raw locators for everything else: `modeTab`, `atisChip`, `wind`, `clock`, `score`, `scoreHi`, `alertsBell`,
  `settingsBtn`, `helpBtn`, `pausedPill`, `stripBay`, `bayTotal`, `bay(id)`, `stripRunway(cs)`, `stripReq(cs)`,
  `picker(type)`, `confirmStep`, `confirmSummary`, `blockedReason`, `cmdInput`, `cmdSend`, `logFilter(f)`,
  `alertStack`, `pauseMenu`, `helpOverlay`, `settingsModal`, `mapTooltip`, `groundMap`, `groundOverlay`, `radarCanvas`

### `HomePage` (`pages/HomePage.ts`)

`goto({ testMode: { seed, spawn } })`, `pickAirport(icao)`, `toggleEnd(end, on?)`, `toggleWeight(end, w, on?)`,
`isEndOn`, `isWeightOn`, `activeEnds()`, `weightsOn(end)`, `windComponents(end)` (`rwy-wind-{end}[data-head|data-cross]`),
`setWind(dir, kts)`, `applyWind()` ("Into wind"), `pickPosition(p)`, `pickDifficulty(d)`, `setSeed(n)`, `setSeedRaw(text)`,
`seedError()` (the Input's `role=alert`), `start()` (waits for `/play` + `page-atc[data-ready=true]`; follow with
`game.waitReady()`).

`testMode` patches the one-shot start config the home page writes (`skycontrol_start_config`) with
`{ test: true, seed, spawn }` through a `localStorage.setItem` hook installed before the page loads; `/play` honours
`stored.test`, so the shift started from the real START button boots deterministically with the ends / weights /
position chosen on the page. Without `testMode` the game runs live (RAF loop, no `__atcTest`).

### `SettingsPage` (`pages/SettingsPage.ts`)

`goto()`, `isOn(id)`, `setToggle(id, on)` (`data-state` via `StateMirror`), `pickTheme(t)`, `highScoreValue()`,
`segmentedValue(id)` / `pickSegmented(id, item)` (`set-difficulty`, `set-datablock`), `selectLabel(id)` / `pickSelect(id, /label/)`
(design `Select`: trigger `{id}` + menu `{id}-menu` with `role=option` rows — no `data-value` mirror, the label is the
product text), `setVolume(pct)` / `volumePct()` (`set-volume` range + `set-volume-value[data-value]`), `historyRow(i)` /
`historyRows()`, `credit(slug)` / `credits()`, plus locators for every `set-*` id. The in-game settings modal
(`settings-modal`, src/game/SettingsModal) reuses the `set-*` ids but its `Mirror` puts `data-state` on a wrapper span:
read the switch there with `aria-checked`.

### `RadarPage` (`pages/RadarPage.ts`) — APPROACH scope chrome + canvas gestures

`new RadarPage(page, game)`. `waitReady()` (the ApproachView is a `next/dynamic` chunk: waits for `radar-canvas` AND the
radar projector, i.e. `sim.camera().zoom !== 1`, before any `screenPos` / `centerOn` use), `camera()` (`{x, y, zoom}`,
zoom = px per NM), `settle()` (polls until the wall-clock zoom / pan easing stops), `box()` / `abs(p)` (canvas px ->
viewport px), `posOf(cs)` (centres first when off-view), `fixPos(id)`, `distToThresholdNM(cs, rwy)`, `distBetweenNM(a, b)`.
Gestures: `hoverAircraft`, `clickAircraft`, `clickEmpty`, `beginDrag(cs, dx, dy)` (press + move, keeps the button down ->
`map-hdg-readout[data-snap]`), `release()`, `dragToHeading(cs, dx, dy)` (-> `map-hdg-bubble`), `dragToFix(cs, fix)`
(-> `map-dct-bubble`), `RadarPage.headingForDrag(dx, dy, magVar)`, `wheel(deltaY, at?)`, `pan(dx, dy)` (rests 150 ms before
the release so the inertia is dropped), `setRange(p)` (`radar-tool-range-{30|15|10|final}`, aria-pressed), `pressedRange()`,
`rangeNM()` (`radar-chip-range[data-value]`), `setMeasureTool(on)`, `measure(a, b)` (click-click -> `map-measure-{i}` text).
Locators: `view()[data-cursor]`, `canvas()`, `toolbar()`, `zoomInBtn/zoomOutBtn/followBtn/ringsBtn/measureBtn/centreBtn`,
`chip*()`, `hdgReadout()`, `bubble(kind)` / `bubblePart(part, kind)` (`map-{hdg|dct|ils|alt}-bubble-{dial-svg|left|right|up|down|send|cancel}`),
`measurePill(i)` / `measurePills()` / `measureLive()`, `edgeArrow()`, `tooltip()`. Spec: `50-approach.spec.ts`.

## Selectors

`tests/e2e/testids.txt` is the generated list of every `data-testid` in `src/` (static ids, dynamic templates with
their source file, derived families, and the 47 `ActionId`s). Regenerate it after adding ids:

```bash
grep -rhoE 'data-testid="[^"]+"|testId="[^"]+"' src | sort -u
```

Conventions that hold in the code (05 §3.1 spirit): boolean state is mirrored in `aria-pressed` / `aria-selected` /
`data-state="on|off"` (pause: `paused|running`), numbers in `data-value`, list rows by domain key
(`strip-{CS}`, `picker-runway-{RWY}`, `airport-card-{ICAO}`), text assertions only on radio lines and reply strings.

Names that differ from 05 §3.1 (code wins): `mode-tab-{ground|tower|approach}` (not `mode-radar/ground`),
`rate-1x/2x/4x` + `rate-pause` (not `rate-1` / `btn-pause`), `brand-home` (game) / `nav-brand` (home),
`map-tool-zoom-in` (not `.maplibregl-ctrl-zoom-in`), `quick-{ActionId}` / `{ActionId}` (not `gnd-*` / `adj-*` /
`air-*`), `btn-transmit` inside `confirm-transmit`, `detail-close` inside `panel-close`, `strip-bay-{BAY}` per bay,
`radio-line[data-who]` + `radio-text` (unchanged), `load-overlay` (unchanged), `page-atc` for `/play`
(`/atc` is a 307 redirect to `/play`).

## Writing scenarios

* Tag: `@smoke` for the fast subset, `@gated:<feature>` + `await skipUnless(sim, '<feature>')` for feature-contract specs.
* Start from `openGame({ spawn: 'none', position })` and build traffic with `sim.spawnAt`; use `spawn: 'default'` only
  for "real boot" flows.
* Strip bays are per position (`bayFor` in `src/lib/sim/stage.ts`): a parked departure is only in the GROUND bay, an
  inbound arrival only in APPROACH, a lined-up departure only in TOWER. Open the position whose bay holds the strip.
* Use `test.describe.configure({ mode: 'serial' })` only for genuine multi-step chains.
* `sim.advanceUntilOk(pred, budget)` for phase transitions; budgets in 05 §4 are sim-seconds (600 sim-s ≈ 1-2 s wall).

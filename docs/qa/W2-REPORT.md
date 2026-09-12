# Wave 2 integration report (W2b-INTEGRATE)

Scope: make the Wave-2 build cohere end to end — store, game shell, command panel, strip bay, vehicle panel, comm log,
ground map and radar — by walking the REAL product in a browser and fixing what was broken, dead or off-spec.

Gates at hand-off:

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors repo-wide |
| `bash scripts/test-sim.sh` | 868 / 868 pass (engine, systems, commands, integration) |
| `npx next build` | clean (routes `/`, `/atc` → 307 redirect, `/design`, `/play`, `/settings`) |
| Playwright walk (5 legs, 101 screenshots) | 0 console errors, 0 console warnings, 0 pageerrors |

Walk setup: Playwright + Chromium 1223, swiftshader GL, viewport 1600×950, production build served by the standalone
server on `:3005` (a `next dev` started by an earlier agent on `:3417` blocks a second dev server in the same tree and
could not be stopped from this session; the production bundle was rebuilt after every fix batch instead). Screenshots
live in `docs/qa/w2/NN-name.png`. GL driver "GPU stall" performance messages from swiftshader were filtered; everything
else logged by the browser counts.

## 1. What works (screenshots)

### Home → start → game (leg 1)
- Airport grid, EGLL detail with the per-end runway config; ends and weight classes toggle with `aria-pressed`
  (`01-home-grid`, `02-home-egll-detail`, `03-home-egll-configured` — 09L/09R off, LIGHT removed from 27L).
- START writes the one-shot config; `/play` consumes it: engine reports active ends `27R/27L`, 27L `weightAllow M/H/S`,
  starting position tower, seed carried (`04-play-initial`).
- GROUND / TOWER / APPROACH tabs switch the map ↔ radar, bays and comm-log filter (`05-play-ground`, `06-play-tower`,
  `07-play-approach`).

### Departure by clicks only, test mode `/play?test=1&seed=7&spawn=none` (leg 2)
- Pushback request surfaces as a REQ chip on the strip and a REQ band in the panel (`08`, `09-dep-panel-parked`);
  one-tap answer opens the confirm step, TRANSMIT → `ok_queued` (`10`, `11`).
- Taxi to runway: runway picker → route picker (AUTO / hold short of / cross runway / taxiway chips) → confirm →
  `ok_conditional` ("after pushback") with the route preview drawn on the map (`12`–`15`).
- Hold short of "next runway on route" (`16`–`18`, `ok_queued`), aircraft reaches the hold (`19-dep-at-hold`, +5 toast).
- Line up and wait (`20`, `21-dep-lined-up`), cleared for takeoff with wind (`22`), airborne on the tower bay with the
  wake timer (`23`, `24-dep-airborne-tower`). Auto handoff ground → tower → departure happens on its own.

### Arrival by clicks only (leg 3)
- Vector via the heading dial (`27`–`29`), descend via the altitude ladder + numeric input (`30`–`32`), speed chips
  (`33`), ILS picker with ILS/LOC/VIS segmented control (`35`–`37`); the aircraft captures the localizer + glideslope and
  is auto-handed to tower at 10 NM (`38-arr-established-radar`, `39-arr-tower-final`).
- Cleared to land with wind (`40`), touchdown + rollout with the runway occupancy band (`41`), exit picker with next
  exit left/right (`42`–`45`; the pilot may answer *unable* for an exit already passed — transmitted as an "Unable"
  readback), handoff to ground, taxi to stand via gate + route pickers (`46`–`50`), on stand (`51-arr-at-stand`).

### Emergency, ARFF and every panel (leg 4)
- `forceEmergency(engine_fire)`: red strip band, MAYDAY alert card (glass), panel emergency band with POB / fuel /
  status, checklist and M-chord rows (`52`, `53-emerg-panel`); acknowledge (`54`), priority runway with straight-in /
  number one / sterile chips (`55`–`58`).
- Vehicles panel from the map toolbar (`59`); ARFF quick dispatch (`60`); the three trucks drive on the ground map with
  route + ETA labels while the panel shows EN ROUTE / Hold / Re-task / Recall (`61`, `62-arff-trucks-moving-90s`).
- Cleared to land (`63`), landed and stopped on the runway → runway closed (red hatch, closure alert, ATIS C)
  (`64-emerg-landed`).
- Alerts drawer (`65`), ATIS panel with rounded QNH / temp and wrapping runway-status chips (`66`), runway config
  dialog (`67`), score breakdown popover (`68`), help overlay: hotkeys / phraseology / stage×action matrix (`69`–`71`),
  pause menu (`72`) → settings modal (`73`) → back to the pause menu → resume actually resumes, typed command with the
  autocomplete menu above the input (`74`), typed command result (`75`), parse error plate + shake (`76`), strip bay
  collapsed to the 44 px rail with counts and dots (`77`), comm log collapsed to last line + command line (`78`),
  rate 1×/2×/4×, settings page (`79`, `80`).

### Crossing, map interaction, undo, onboarding, live loop (leg 5)
- A388 from a T4 stand to 27R: hold-short place at 27L (`81`, `82-cross-hold-short` with the REQ "request cross"
  band), cross runway with expedite (`83`–`86`), continues to 27R (`87`).
- Strip runway button opens the taxi/runway action (`88`); ground hover tooltip + pointer cursor (`89`); right-click
  quick menu with the top actions (`90`); empty-map click deselects; click selects; UNDO chip in the panel footer and on
  the comm-log line (probe screenshot during the walk).
- Radar: hover tooltip (`91`), drag-to-heading with the live readout (`92`), confirm bubble with dial + L/R → Send
  transmits "fly heading two one six" (`93`), shift-drag measuring (`94`), 15 NM preset + rings toggle (`95`).
- Non-test session `/play?icao=EGLL&seed=42`: onboarding coach mark bottom-centre (`96`), 4× rate runs 120 sim-s in
  ~30 real-s, five pushback requests + "request unanswered" advisory (`97`), request answered by clicks (`98`),
  Space pause, F1–F3, `?` help, brand → leave confirm (`99`) → home shows "Resume shift" (`100`) → `/play` resumes the
  live engine (sim time continues, `101-live-resumed`).

## 2. Fixes made in this pass (file:line)

Engine / command layer (all 868 headless tests still green):
- `src/lib/sim/commandTree.ts:297,357` — `action-takeoff` at `taxi_out` was unconditionally enabled; the engine refused
  it with `not_at_hold`. New `takeoff_near` rule mirrors `cmdTakeoff` (within 250 m of the departure hold).
- `src/lib/sim/commandTree.ts:355` — `action-continue` was offered to every taxiing departure whose route ends at a
  runway hold (engine: "No hold active"); now mirrors `cmdContinue` (manual/traffic hold or a taxiway hold-short place).
- `src/lib/sim/commandTree.ts:1089` — hold short "next runway on route" threw "missing runway" (confirm step blocked);
  resolves to the next hold on the path, then the held runway, then the planned runway.
- `src/lib/sim/engine.ts:527` — every ATIS regeneration produced two comm-log lines ("ATIS B: …" + "ATIS B — …");
  the engine's duplicate emit is gone (the weather model queues the event).
- `src/lib/sim/engine.ts:548` — pilot position reports (holding short, airborne, touchdown, vacated, go-around,
  "established localizer") now count as pilot calls for the strip timer (it went red on aircraft that had just called).
- `src/lib/sim/phraseology.ts:1004` — tower check-in for an aircraft still on the runway said "passing zero climbing
  zero"; now "lined up / rolling runway 27L".
- `src/lib/sim/testApi.ts:309,506` + `src/components/atc/simStore.ts:1103` — `__atcTest.emptySpot()` returned (20,20),
  under the floating strip bay; the host now rejects candidates not hitting the canvas (`spotFree`).

Store / routes:
- `src/components/atc/simStore.ts:426` `resume()` + `src/app/play/page.tsx:54` — plain `/play` (home "Resume shift",
  settings "Back to shift") resumes the live engine instead of rebuilding it with the same seed; a new home config or
  differing URL params still always reload (the app router restores the cached route's search string on `push('/play')`,
  so URL params only count when they differ from `sim.lastConfig`).

Game UI:
- `src/game/NavBar/NavBar.module.css:6,30-37`, `NavBar.tsx` — the ATIS chip overlapped the APPROACH tab and the clock at
  1440–1700 px; the nav grid is now `auto minmax(0,1fr) auto`, the chip clips instead of overlapping and discloses
  runways / QNH / cloud at 1440 / 1700 / 1800 px. `<Link prefetch={false}>` on the brand removes the "preloaded CSS not
  used" console warning Next raised for the home route. Position tabs use UX §10 ids `mode-tab-{ground|tower|approach}`.
- `src/game/CommandPanel/CommandPanel.tsx:682` + `.module.css:87` — the stepper scrolls into view on every step change
  (the TRANSMIT button used to sit below the fold); the REQ band hides while a draft is open; the step subtitle no longer
  repeats the action label; `.module.css:58` emergency action rows are single-column (labels were truncated to 6 chars).
- `src/game/GameShell/GameShell.module.css:30-31,49-50,53-55,115` + `GameShell.tsx` (`data-has-panel`) — map/radar
  chrome insets follow the floating panels: the radar corner chip no longer hides under the strip bay, the ground and
  radar toolbars and the vehicles panel move left of the command panel, the alert stack drops below the "Paused" pill,
  the vehicles panel leaves room for one critical alert. `src/components/atc/GroundView/GroundView.module.css:27,40`
  read the inset variables.
- `src/game/AlertStack/AlertStack.module.css:11` — floating alert cards had no backing (text straight over the
  satellite); each now carries glass-strong. `:27` drawer selector doubled.
- `src/game/CommLog/CommLog.module.css:2,56,77` — the autocomplete menu was clipped to the log height (3 of 8 items);
  it now rises over the map at menu width; the parse-error helper is a small plate instead of overprinting the last line.
- `src/game/GameShell/ToastHost.tsx:16` — toasts never expired in test mode (no RAF); wall-clock expiry added.
- `src/game/PauseMenu/PauseMenu.tsx:21-40` — settings / runway config / stats opened from the pause menu left the
  player on a silently paused shift; the menu now returns after the detour and Resume unpauses correctly.
- `src/game/AtisWeather/AtisWeather.tsx:136`, `.module.css:25` — QNH showed the raw float (`1023.99775…`) overprinting
  the temperature; runway-status chips overlapped instead of wrapping. `RunwayConfigDialog.tsx:11` uses the same `S`
  label / `rwycfg-end-{end}-weight-{L|M|H|S}` domain keys as the home page (was `J`).
- `src/game/VehiclePanel/VehiclePanel.module.css:35` — active vehicle cards squeezed the name column so the type tag
  overprinted the state pill; actions get their own row.
- `src/game/HelpOverlay/HelpOverlay.module.css:53`, `AtisWeather.module.css:3`, `StatsPanel.module.css:3`,
  `AlertStack.module.css:27` — floating GlassPanels lost `position: absolute` to the primitive's own
  `position: relative` depending on CSS chunk order (the onboarding card rendered half under the nav in production);
  doubled selectors + no transform-based centring.
- `src/design/primitives/Segmented/Segmented.tsx:55` — items mirror `aria-pressed` / `data-state` (05 §3.1).
- `src/components/atc/GroundView/render.ts:380` — tower 1/2/4 NM rings and the ground 250/500 m rings were 1.5 px
  crawling dashes at .45 white; per design A10/A21 they are now faint 1 px `--chart-grid` guides.
- `src/components/atc/ApproachView/render.ts:143` — restricted-area tint halved (overlapping CTR polygons stacked).
- `src/game/persist.ts` — the unused second onboarding key is gone (the store's `skycontrol_onboarding_seen` is the one).

## 3. Residual issues (not fixed here)

- `src/game/NavBar/NavBar.tsx:63-70` — with four active ends at 1600 px the ATIS chip clips mid-token
  ("… 09L/27R/27L/09R · 2"); an abbreviated runway list (`27R/27L +2`) would read better.
- `src/game/CommandPanel/pickers/TaxiwayPicker.tsx` — when the engine supplies no `exits` for a rollout the picker
  falls back to every taxiway name (`42-arr-exit-step0-taxiway`), so an exit already behind the aircraft can be picked
  (the pilot then answers unable, `45-arr-exit-confirm`). "next exit left/right" is the reliable choice.
- `src/game/GameShell/GameShell.module.css:115` — a tall alert stack (3 cards) still overlaps the top of the vehicles
  panel; only one critical card is reserved for.
- `src/components/atc/GroundView/render.ts` data-block placer does not know about the floating strip bay: labels near
  the left edge can be covered by it (`97-live-ground-2min`, DLH197).
- `src/game/StatsPanel/StatsPanel.module.css:3` — the score popover docks top-right under the nav rather than anchored
  to the score chip; `src/game/HelpOverlay/HelpOverlay.tsx` matrix legend sits under the tab's fade mask (cosmetic).
- Test ids that differ between the two spec tables: the code follows UX §10/§G12 (`mode-tab-*`, `rate-1x/2x/4x`,
  `map-tool-*`) while 05 §3.1 lists legacy names (`rate-1`, `btn-pause`, `.maplibregl-ctrl-zoom-in`); W3 specs should
  target the §10 names. The command-UI doubling (`btn-transmit` inside `confirm-transmit`, `detail-close` inside
  `panel-close`, `vehicle-recall-{id}` inside `veh-card-{id}-recall`, `vehicle-dispatch` inside `veh-confirm`) stays.
- Not implemented (known from the component reports): STT for PTT (visual only), tower runway-occupancy bars beneath
  the top bar, measure tool on the ground map, label drag, bay separators / cross-bay drag, ≥1920 two-column log,
  auto-collapse of the log at 1280–1439, spotlight-style onboarding anchored to targets, `veh-auto-cross`.
- Baked satellite imagery is blurry above ~z16 (asset resolution, `82-cross-hold-short`).
- The GL performance messages Chromium prints under swiftshader ("GPU stall due to ReadPixels") come from MapLibre's
  `readPixels` in the headless driver and do not occur on a real GPU; they were the only console output filtered.

## 4. Interactive elements exercised (by data-testid)

Home: `airport-card-EGLL`, `rwy-end-09L`, `rwy-end-09R`, `rwy-weight-27L-L`, `home-start`, `home-resume`, `brand-home`,
`home-leave-confirm-yes`.
Nav: `mode-tab-ground`, `mode-tab-tower`, `mode-tab-approach`, `atis-chip`, `score-chip`, `alerts-bell`, `help-btn`,
`rate-pause`, `rate-4x`, `rate-1x`, keyboard Space / F1 / F2 / F3 / `?` / Esc.
Strips: `strip-{cs}` (BAW975, DLH2GK, BAW117, QFA1, DAL55, DLH197), `strip-QFA1-runway`, `bay-collapse`, `tip-skip-all`,
`tip-next`.
Command panel: `panel-req-answer`, `quick-action-pushback`, `quick-action-taxi-runway`, `quick-action-hold-short`,
`quick-action-continue`, `quick-action-lineup`, `quick-action-takeoff`, `quick-action-heading`, `quick-action-altitude`,
`quick-action-speed`, `quick-action-ils`, `quick-action-land`, `quick-action-exit`, `quick-action-taxi-stand`,
`quick-action-cross`, `quick-emerg-ack`, `emerg-priority`, `action-hold-position`, `step-next`, `step-back`,
`btn-transmit`, `btn-cancel`, `btn-undo`, `picker-runway-27L`, `picker-runway-mode-*`, `picker-dir-N`,
`picker-route-auto`, `picker-holdshort-next`, `picker-alt-input`, `picker-heading-input`, `picker-heading-left`,
`picker-speed-chip-180`, `picker-taxiway-A1`, `picker-exit-*`, `picker-gate-*`, `picker-cross-expedite`,
`picker-emerg-*`, `picker-info-*`.
Comm log: `cmd-input`, `cmd-autocomplete-{n}`, Enter send, `cmd-parse-error`, `log-collapse`, `log-line-{key}-undo`.
Vehicles: `map-tool-vehicles`, `btn-arff-dispatch`, `veh-card-FIRE1-hold` / `-retask` / `-recall` (present, ARFF en
route), `veh-panel-close`.
Panels: `atis-runway-config`, `rwycfg-cancel`, `atis-close`, `score-breakdown-close`, `help-tab-phraseology`,
`help-tab-matrix`, `help-tab-alerts`, `help-tab-glossary`, `help-close`, `alerts-drawer-close`, `pause-settings`,
`set-sound`, `set-close`, `pause-resume`.
Map / radar: ground hover → `map-tooltip`, left click select / empty-click deselect, right click →
`ctx-aircraft-*`, radar hover, drag-to-heading → `map-hdg-bubble-send`, shift-drag measure → `map-measure-{n}`,
`radar-tool-range-15`, `radar-tool-rings`.
Settings page: `set-theme-chart`, `set-theme-satellite`, scroll through all sections.
Test API used to drive time and scenarios: `advance`, `spawnAt`, `forceEmergency`, `centerOn`, `screenPos`,
`emptySpot`, `arff`, `stage`, `actions`, `radio`, `command`.

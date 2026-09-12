# SKYCONTROL — Master Plan (rebuild to finished product)

This is the binding architecture for the rebuild. Every implementation agent reads THIS first, then the
spec it owns. Where a spec and this plan disagree, THIS PLAN WINS. Where this plan is silent, the spec wins.

Specs (all in `docs/spec/`):
- `01-DESIGN-SYSTEM.md` — pixel-exact design language (Ron Design Lab "Traffic Management"). Includes critic addendum.
- `02-CODEBASE-AUDIT.md` — what exists, 26 verified bugs (B1–B26), dead code list, extension points.
- `03-ATC-FEATURE-SPEC.md` — every feature, phraseology, timing constants. Includes critic corrections (§A is authoritative over the base where they conflict).
- `04-UX-COMMAND-TREE.md` — click-to-command tree, screen architecture, strips, alerts, vehicles UX, ~230-element inventory. Critic addendum §G1 (stage model) and §G2 (action matrix) are AUTHORITATIVE.
- `05-TEST-STRATEGY.md` — Playwright harness, deterministic test API, scenario matrix.

---

## 1. Product definition

One web app, three screens:

| Route | Screen |
|---|---|
| `/` | **Home** — airport picker → active-runway + weight-class config → Start |
| `/play` | **The game** — single screen; position tabs **GROUND · TOWER · APPROACH**; map/radar centre; floating glass panels |
| `/settings` | Settings |

`/atc` becomes a redirect to `/play`. `/demo3d` is deleted (3D is out of scope for this rebuild). All legacy prototype routes are deleted.

### The core loop the player experiences
1. Pick airport, configure runways, Start.
2. Aircraft spawn **parked at gates** (departures) and at **airspace entry points** (arrivals).
3. Pilots **request** things (pushback, taxi, ready for departure, "with you" on frequency). Requests surface as chips on strips + comm log.
4. Player **clicks an aircraft** (map, radar, or strip) → a contextual **command panel** shows only valid actions → picks parameters step-by-step → transmits. Pilot reads back after a realistic delay.
5. Departures: parked → startup → pushback → taxi (via named taxiways, holding short of runways to cross) → hold short → line up → takeoff → climb → handoff to approach → exit airspace.
6. Arrivals: enter airspace → vectors/altitude/speed → ILS clearance → established → **landing clearance** (mandatory) → touchdown → rollout → exit at taxiway → taxi to gate → arrived.
7. Emergencies happen; player dispatches ARFF (fire trucks visibly drive to the runway), gives priority, clears traffic.
8. Wind shifts → ATIS updates → runway change.
9. Score, skill, movements/hour, delay stats; session summary.

---

## 2. Architecture (binding)

### 2.1 Layers
```
src/lib/sim/           pure TypeScript, NO DOM, headless-testable   ← ENGINE
src/components/atc/    simStore (singleton bridge) + two canvas renderers ← BRIDGE/RENDER
src/design/            tokens + primitives (the ONLY styling source)   ← DESIGN SYSTEM
src/game/              game UI composed from primitives + simStore     ← GAME UI
src/app/               Next routes (thin)                              ← ROUTES
tests/e2e/             Playwright                                      ← TESTS
```
Rule: `src/game` and `src/app` import styling ONLY from `src/design`. No inline colour literals, no ad-hoc CSS strings, no per-page `<style>` blocks. Tokens are CSS custom properties in `src/design/tokens.css`; components use CSS Modules (`*.module.css`) referencing tokens.

### 2.2 Engine model changes (contracts — see `types.ts`)
- **`FlightPhase`** (physics) gains: `startup`, `go_around`. Departures spawn `parked`.
- **`Stage`** (UI-facing, derived) per UX §G1: `stage(a, engine)` in `src/lib/sim/stage.ts`. UI NEVER gates on `phase`; it gates on `stage`.
- **`CommandAST`** — single discriminated union for every command. Consumed by the text parser, the click-tree UI, and (later) LLM function calling. `engine.dispatch(ast): CommandResult` where `CommandResult = { ok, code, transmission, readback, reason? }`. No more string-regex "ok" heuristics.
- **`actionsFor(a, engine): ActionRow[]`** in `commandTree.ts` — the UX §G2 matrix as data: id, label, hotkey, enabled|disabled(reason)|hidden, picker steps.
- **Pilot requests** — engine emits `request` events (pushback/taxi/ready/with-you/higher/direct/…) with timeouts; `a.requests[]`.
- **Pending/conditional commands** — `PendingCmd.condition` (after pushback / on reaching / behind aircraft / at altitude).
- **Vehicles** — `Vehicle` entities (ARFF ×3, follow-me, tug, ambulance, fuel, de-ice, inspection car) with station positions, path-following on the taxiway graph (reuse `findPath` / `follow`), runway-crossing holds, states `standby|enroute|onscene|returning`. Rendered on GroundView.
- **Emergencies** — `a.emergency` substate; 12 types per spec §4 + addendum §F; ARFF response; runway closure/reopen; scoring.
- **Weather/ATIS** — `WeatherState` (wind dir/kts/gust, vis, ceiling, QNH, temp), ATIS letter + text, runway-in-use suggestion, wind applied to airborne motion & takeoff/landing; change events.
- **Alerts** — STCA (CPA prediction ≤60 s), MSAW, runway incursion (aircraft/vehicle), wake-timer violations; `Alert{id,kind,severity,subjects,ack,resolvedAt}`.
- **Runway state** — `RunwayState{ open|closed|sterile|inspection, activeDep, activeArr, occupiedBy, wakeTimer }` per end.
- **Gate reservation** — arrivals reserve a stand at spawn; departures never spawn on a reserved stand.
- **Determinism** — all randomness via `rng.ts`; `engine.step()`; `simStore.step(dt)`; test API per `05-TEST-STRATEGY.md §2` on `window.__atcTest` in test mode.
- **Critical bug fixes are mandatory** (audit B1–B15): runway occupancy excludes self; runway ends oriented by bearing (fix in `osmAirport.ts`; regenerate `runwayManifest.ts` + airspace files if needed); airspace centre stored on engine and used for retire logic; hold-short is a *place* (graph node at the runway hold line — derive as the last taxiway node before the runway edge on the path), not a phase set anywhere; hold-short/cross idempotent; start config always applied on `/play` mount; `cmdClearedLand` gates landing (aircraft without clearance at 2 NM goes around with "no landing clearance"); air/ground/wake separation proper; arrival gate reservation; `[airport2]` ILS sections parsed.

### 2.3 Realism constants (from spec §8 + addendum §H — the engine agent uses these)
Startup 90–240 s by type (APU 60 s + engines 30 s each), pushback: tug attach 30 s, push 45–90 s at 3 kt, disconnect 20 s; taxi 15–25 kt straights / 8–10 kt turns; hold-short brake distance; line-up 25 s; takeoff roll per class; rotation Vr; climb rates per DB; pilot readback delay 2–4 s; request timeouts; wake separation matrix (ICAO: SUPER/HEAVY/MEDIUM/LIGHT, time-based 2–3 min departures, distance 4–8 NM arrivals); ARFF 3 min to any runway end; go-around climb 3000 ft runway heading; missed approach; wind: 5-kt tailwind max for runway selection, crosswind limits per class.

### 2.4 Rendering
- **GroundView** (MapLibre + overlay canvas) — the *Ground* and *Tower* positions. Design per `01 §5 + A10`: baked satellite (kept) darkened to spec, taxiway centrelines, hold-line markers, runway status tint, gate occupancy dots, aircraft as true-scale silhouettes with callsign tags (glass-style), vehicles as small distinct icons with type glyph, selected aircraft ring + route preview, hover tooltip, drag-to-heading for airborne, smooth zoom (no tile reload — static images already), follow, camera presets.
- **ApproachView** (2D canvas radar) — the *Approach* position. Design per `01 A10`: near-black scope, thin rings, data blocks in DM Sans, orange selection, red conflict, STCA prediction vectors, hold ovals from actual track, ILS feathers, wake arcs, range/bearing measuring tool, drag-to-heading.
- Both read `sim` in their own RAF; both expose `screenPos` for the test API.

### 2.5 Game UI composition (`src/game/`)
```
GameShell            grid: NavBar (56px) / main (map) / floating panels
 ├ NavBar            logo · position tabs (GROUND TOWER APPROACH) · airport+ATIS chip · wind · UTC/sim clock · score · pause/rate · settings/help
 ├ StripBay          left, 320px, glass; bays per position; strip cards (callsign, type, wake, stand/rwy, stage badge, REQ chip, pending cmd, alt/spd/hdg for air)
 ├ CommandPanel      right, 360px, glass; appears when aircraft selected; header (callsign, type, stage, KPI row ALT/SPD/HDG big numbers), action list (from actionsFor), stepper for pickers, transmit/cancel, undo
 ├ CommLog           bottom-left, glass; ATC/PILOT/SYS lines with typing animation; text command input with autocomplete from CommandAST grammar
 ├ AlertsPanel       top-right stack; severity colours; ack/resolve
 ├ AtisWeather       small glass card; letter, wind, QNH, active rwys; regenerate on change with animation
 ├ StatsPanel        movements/hour (orange bar chart), delay sparkline, score, skill, incidents (design 01 §4)
 ├ VehiclePanel      ARFF/follow-me/tug/ambulance/etc dispatch: pick vehicle → target (aircraft/runway/point) → go; live states
 ├ Toasts            transient feedback
 └ HelpOverlay       phraseology reference, shortcuts, onboarding tips (first run)
```
Every interactive element carries `data-testid` per `05 §3` naming. Keyboard shortcuts per `04 §G6`.

### 2.6 Persistence
localStorage keys under `skycontrol_*`: settings, high score, start config (consumed once), onboarding-seen, session stats history.

---

## 3. Implementation waves & file ownership

Agents work in parallel ONLY on disjoint file sets. Shared files have ONE owner per wave.

### Wave 0 — Contracts (single agent, then reviewed)
Owns: `src/lib/sim/types.ts`, `src/lib/sim/rng.ts`, `src/lib/sim/stage.ts` (signature + impl), `src/lib/sim/commandAst.ts` (AST types + `describe()`), `src/design/tokens.css`, `src/design/README.md` (component API list w/ props).
Output: compiles; every downstream agent codes against these.

### Wave 1 — Parallel, disjoint
- **W1-ENGINE** owns `engine.ts`, `aircraft.ts`, `ils.ts`, `osmAirport.ts`, `airspace/eairport.ts`, `runwayManifest.ts`, `scripts/gen_runway_manifest.py`, `scripts/gen_airspace.py`, `public/airspace/*`. Implements: bug fixes B1–B15, parked/startup/pushback/taxi realism, hold-short-as-place, landing clearance, wake/runway separation, gate reservation, requests, conditional pending cmds, runway state, airspace centre, wind application hooks (calls `weather.ts` API), emergency hooks (calls `emergencies.ts` API), vehicle stepping hook (calls `vehicles.ts` API). MUST NOT edit files owned by others; where it needs their API, it codes to the contract stubs from Wave 0.
- **W1-SYSTEMS** owns `vehicles.ts`, `emergencies.ts`, `weather.ts`, `alerts.ts`, `phraseology.ts`. Pure modules exposing `step(engineView, dt)` + query/command APIs per contracts.
- **W1-COMMANDS** owns `commands.ts` (tokenizer + parser → AST; autocomplete), `commandTree.ts` (`actionsFor`, picker specs, validation, `toAst`), `dispatch.ts` (AST → engine method calls → `CommandResult`).
- **W1-DESIGN** owns `src/design/**` (except tokens.css from W0), `src/app/layout.tsx`, `src/app/globals.css`, fonts. Builds every primitive in `01 §4 + A11–A15` with CSS Modules, states per A2, motion per §7/A19, a `/design` dev route showing every primitive in every state (used for visual QA).

### Wave 2 — Integration + UI (after Wave 1 compiles)
- **W2-STORE** owns `simStore.ts`, `testApi.ts`, `src/app/play/page.tsx` boot: wires engine+systems+commands; `step()`; events ring; requests routing; test mode; start-config consumption; airport switch rebuild.
- **W2-GROUND** owns `GroundView/**`, `osmMapStyle.ts`: redesign per §2.4; vehicles; hold lines; runway tint; drag-heading; tooltip; screenPos export.
- **W2-RADAR** owns `ApproachView/**`: redesign per §2.4.
- **W2-GAMEUI** owns `src/game/**`: all panels per §2.5, using design primitives + `actionsFor` + `sim`.
- **W2-PAGES** owns `src/app/page.tsx`, `src/app/settings/page.tsx`, `src/app/atc/page.tsx` (redirect), delete legacy routes/components/libs/data per audit §5.

### Wave 3 — Tests
- **W3-HARNESS** owns `playwright.config.ts`, `tests/e2e/fixtures/**`, `tests/e2e/pages/**`, `package.json` scripts.
- **W3-SPECS-{home,settings,ground,tower,approach,emergency,alerts,strips,map,persistence,errors}** own their spec files; write + run; report failures with root cause.

### Wave 4 — Fix loop
Finders (run full suite + manual UI exploration via Playwright + screenshot review vs design refs) → fixers (worktree per bug, disjoint) → rerun. Until two consecutive rounds find nothing.

### Wave 5 — Polish
Visual QA agents compare every screen against `01-DESIGN-SYSTEM.md` and reference JPEGs; micro-interaction pass; perf pass (60 fps with 20 aircraft + 8 vehicles).

---

## 4. Definition of Done (the whole thing)
- `npx tsc --noEmit` clean; `npm run build` clean; `npm run test:e2e` green (0 failed, 0 skipped except explicitly out-of-scope).
- Every element in `04 §10 + §G12` inventory exists with its `data-testid` and is covered by a test.
- Every feature in `03 §9 + §I` Definition of Done is implemented.
- Every screen matches `01-DESIGN-SYSTEM.md` (tokens only, no stray colours; visual QA sign-off).
- No console errors/warnings in a full 10-minute seeded session at 4× with emergencies enabled.
- A player can, using only the mouse: start a game, push back and taxi a departure via named taxiways holding short of a crossing runway, line up, take off, hand off; vector an arrival, clear ILS, clear to land, watch it land, exit, taxi to a stand; handle an engine-fire emergency by dispatching ARFF and watching the trucks drive to the runway and back; see a wind change trigger an ATIS update and runway change; read the score/stats.

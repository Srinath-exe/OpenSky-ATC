# SkyControl (/root/atc) — End-to-End Test Harness Design

## 0. Ground truth from the code (what the harness must fit)

Read: `/root/atc/package.json`, `/root/atc/src/app/atc/page.tsx`, `/root/atc/src/components/atc/simStore.ts`, `/root/atc/src/components/atc/GroundView/index.tsx`, plus (for accuracy) `src/app/page.tsx`, `src/app/settings/page.tsx`, `src/lib/sim/commands.ts`, `src/lib/sim/engine.ts`, `src/components/atc/ApproachView/index.tsx`.

Facts that shape the design:

| Fact | Consequence for tests |
|---|---|
| `sim` singleton is `window.__atcSim` (HMR-safe). Sim loop is one RAF in `SimStore.start()`; `engine.update(dt)` runs fixed steps of `FIXED = 1/30 s`, max `MAX_SUBSTEPS = 6` per call (≤0.2 sim-s per call). | Deterministic advance must loop `update(FIXED)` N×30 times, and must go through a store-level `step()` so radio/score/autospawn side-effects run too. RAF must be disabled in test mode. |
| `Math.random` is used in 7 places (engine `rnd`/`ri`, callsign/type generation in `aircraftDB`, entry-point pick and auto-spawn in `simStore`). | One injectable RNG (`src/lib/sim/rng.ts`) with `setSeed()`; test mode seeds it from `?seed=`. |
| Pilot commands are applied after `PILOT_DELAY_S = 3` s (airborne only). | Assertions on `cmdAltitude/cmdIas/targetHeading` need `advance(3.1)` first. |
| `spawnDeparture()` creates aircraft directly in `taxi` (never `parked`), so `PUSHBACK` (requires `parked`) is unreachable from the real UI today. | Test API must be able to spawn in `parked`; home-to-game flow tests pushback only via test spawn. |
| Aircraft list rows, quick-command buttons, ILS/HOLD buttons, airport picker, rate buttons are rendered without `data-testid`. Ground "TAXI 27L" quick button is hard-coded to 27L. | Add testids (section 3). Quick "Taxi 27L" test is EGLL-only. |
| Both views are canvas (GroundView = MapLibre + 2D overlay; ApproachView = pure 2D canvas with wheel zoom, mousedown hit-test 16 px, drag-pan). | Hit-testing must use engine-projected screen coordinates exposed via the test API, not pixel colour. |
| Autotower (`engine.autoTower`, default on, `LS_KEYS.autoTower`) auto-clears hold_short departures. | Tests of manual takeoff set autoTower off via settings/localStorage. |
| **Not present in the codebase**: wind/ATIS/runway change, emergencies, ARFF vehicles, a dedicated STCA alert (only `separation_loss` / `ground_conflict` events + `conflict` flag), strip bay (the left "TRAFFIC" list is the de-facto strip bay), keyboard shortcuts, drag-to-set-heading, wake-turbulence timers (only `wakeSeparationNM` used in separation checks). | Scenarios for these are written against a **feature contract** (section 4.9–4.13) and gated with `test.skip(!features.X)`, where `features` is read from `window.__atcTest.features()`. They fail loudly (not silently) once the flag flips on but the test doesn't pass. |

Environment: no GPU (swiftshader), port 3005 is the only allowed dev port, chromium-1223 is at `/root/.cache/ms-playwright`, Playwright 1.61.1 is cached at `/root/.npm/_npx/e41f203b7505f1fb/node_modules` (only `playwright` + `playwright-core`; `@playwright/test` must be installed), Node 20.11, Next 16 (Turbopack), React 19.

---

## 1. Harness

### 1.1 Install

```bash
cd /root/atc
npm i -D @playwright/test@1.61.1        # same major/minor as cached chromium-1223
# no `npx playwright install` — the browser is already in /root/.cache/ms-playwright
```

`package.json` scripts to add:

```json
"test:e2e":        "playwright test",
"test:e2e:smoke":  "playwright test --grep @smoke",
"test:e2e:ui":     "playwright test --ui",
"test:e2e:update": "playwright test --update-snapshots --grep @visual",
"test:e2e:report": "playwright show-report test-results/report"
```

### 1.2 `playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test';

const PORT = 3005;
const BASE = `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,          // one dev server, one GPU-less chromium; keep serial per file
  workers: CI ? 2 : 1,
  retries: CI ? 2 : 0,
  timeout: 60_000,               // per test; sim is advanced synchronously so this is generous
  expect: {
    timeout: 8_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.3, animations: 'disabled', scale: 'css' },
  },
  forbidOnly: CI,
  reporter: CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'test-results/report' }], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : [['list'], ['html', { open: 'on-failure', outputFolder: 'test-results/report' }]],
  outputDir: 'test-results/artifacts',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',

  use: {
    baseURL: BASE,
    headless: true,
    viewport: { width: 1440, height: 900 },   // atc-root grid is 220 / 1fr / 268 + 200px footer; 1440×900 gives a ~950×700 canvas
    deviceScaleFactor: 1,                     // stable canvas px == css px (dpr math in GroundView)
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    launchOptions: {
      args: [
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
        '--disable-dev-shm-usage', '--no-sandbox',
        '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      ],
    },
    // Every page opens in test mode; the fixture appends ?test=1&seed=… itself.
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: undefined } },
    // Visual baselines are captured only by this project (keeps functional runs fast).
    { name: 'visual', testMatch: /visual\/.*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: `npx next dev -p ${PORT} --hostname 127.0.0.1`,
    url: `${BASE}/`,
    reuseExistingServer: !CI,     // dev: reuse a running server; CI: always fresh
    timeout: 180_000,             // Turbopack cold compile of /atc with maplibre can take a while
    stdout: 'pipe', stderr: 'pipe',
    env: { NEXT_PUBLIC_ATC_TEST: '1', NEXT_TELEMETRY_DISABLED: '1' },
  },
});
```

Notes:
- `--use-gl=swiftshader` alone is deprecated in recent Chromium; `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` is the working triple. Verify once with a probe test that `document.createElement('canvas').getContext('webgl2')` is non-null and that MapLibre fires `load`.
- Set `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright` in `.env.test`/CI so the cached chromium is used.
- `reuseExistingServer` lets the developer keep `next dev -p 3005` running while iterating.

### 1.3 Directory layout

```
tests/e2e/
  playwright.config.ts              (or at repo root — root is simpler for `npx playwright test`)
  fixtures/
    test.ts            extended `test` with page objects + sim API fixture + testMode nav
    simApi.ts          typed wrapper around page.evaluate(window.__atcTest.*)
    storage.ts         localStorage seeding helpers (keys from LS_KEYS)
    features.ts        feature-contract flags + `skipUnless(feature)`
  pages/
    HomePage.ts
    GamePage.ts        (+ sub-objects: LeftSidebar, DetailPanel, BottomBar, RadarCanvas, GroundMap)
    SettingsPage.ts
  specs/
    00-harness/        webgl.probe.spec.ts, testmode.spec.ts
    10-home/           home.spec.ts
    20-settings/       settings.spec.ts
    30-game-ui/        sidebar.spec.ts, detail-panel.spec.ts, bottom-bar.spec.ts, modes.spec.ts
    40-ground/         ground-commands.spec.ts, ground-quick-buttons.spec.ts, taxi-routing.spec.ts
    50-tower/          takeoff.spec.ts, landing.spec.ts, go-around.spec.ts, autotower.spec.ts
    60-approach/       vectors.spec.ts, altitude-speed.spec.ts, direct-hold.spec.ts, ils-to-gate.spec.ts
    70-safety/         conflicts.spec.ts, stca.spec.ts (gated), diversion.spec.ts
    80-airport/        atis-wind.spec.ts (gated), emergencies.spec.ts (gated), strips.spec.ts
    90-map/            radar-interactions.spec.ts, ground-map.spec.ts, shortcuts.spec.ts (gated)
    95-persistence/    persistence.spec.ts
    99-errors/         invalid-commands.spec.ts
  visual/
    screens.spec.ts
    __screenshots__/
  data/
    scenarios.json     canned aircraft states (positions in engine XY, phases, plans) per airport
```

### 1.4 Fixtures (`fixtures/test.ts`)

```ts
import { test as base, expect } from '@playwright/test';
import { HomePage } from '../pages/HomePage';
import { GamePage } from '../pages/GamePage';
import { SettingsPage } from '../pages/SettingsPage';
import { SimApi } from './simApi';

type Fx = {
  seed: number;
  home: HomePage; settings: SettingsPage; game: GamePage;
  sim: SimApi;
  /** Opens /atc?test=1&seed=N&icao=X, waits for engine ready, returns GamePage. */
  openGame: (opts?: { icao?: string; spawn?: 'none' | 'default'; autoTower?: boolean; ls?: Record<string,string> }) => Promise<GamePage>;
};

export const test = base.extend<Fx>({
  seed: [1234, { option: true }],
  home:     async ({ page }, use) => use(new HomePage(page)),
  settings: async ({ page }, use) => use(new SettingsPage(page)),
  game:     async ({ page }, use) => use(new GamePage(page)),
  sim:      async ({ page }, use) => use(new SimApi(page)),
  openGame: async ({ page, seed, sim, game }, use) => {
    await use(async (o = {}) => {
      await page.addInitScript(({ ls }) => { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); },
        { ls: { skycontrol_autotower: o.autoTower === false ? '0' : '1', skycontrol_tts: '0', ...o.ls } });
      const q = new URLSearchParams({ test: '1', seed: String(seed), icao: o.icao ?? 'EGLL', spawn: o.spawn ?? 'none' });
      await page.goto(`/atc?${q}`);
      await sim.waitReady();               // engine != null, loading == false, both canvases mounted
      return game;
    });
  },
});
export { expect };
```

Per-test isolation: every test gets a fresh browser context (Playwright default) → fresh `localStorage` and a fresh `window.__atcSim`. Never share a page between tests.

### 1.5 Page objects

Minimal shape (each method returns Locators built from `data-testid`, see section 3):

```ts
// pages/HomePage.ts
class HomePage {
  constructor(readonly page: Page) {}
  goto()                      { return this.page.goto('/'); }
  settingsLink                = () => this.page.getByTestId('home-settings-link');
  airportCard(icao: string)   { return this.page.getByTestId(`airport-card-${icao}`); }
  backLink                    = () => this.page.getByTestId('home-change-airport');
  runwayEnd(end: string)      { return this.page.getByTestId(`rwy-end-${end}`); }          // "27L"
  weight(end: string, w: 'L'|'M'|'H'|'S') { return this.page.getByTestId(`rwy-weight-${end}-${w}`); }
  startBtn                    = () => this.page.getByTestId('home-start');
  async pickAirport(icao: string) { await this.airportCard(icao).click(); await expect(this.page.getByTestId('home-detail')).toBeVisible(); }
}

// pages/SettingsPage.ts
class SettingsPage {
  goto()            { return this.page.goto('/settings'); }
  autoTower         = () => this.page.getByTestId('set-autotower');
  tts               = () => this.page.getByTestId('set-tts');
  theme(t: 'satellite'|'chart') { return this.page.getByTestId(`set-theme-${t}`); }
  highScore         = () => this.page.getByTestId('set-highscore');
  resetScore        = () => this.page.getByTestId('set-reset-score');
  homeLink          = () => this.page.getByTestId('set-home');
  backLink          = () => this.page.getByTestId('set-back');
}

// pages/GamePage.ts  (composed)
class GamePage {
  left   = new LeftSidebar(this.page);
  detail = new DetailPanel(this.page);
  bottom = new BottomBar(this.page);
  radar  = new RadarCanvas(this.page);   // approach mode canvas
  ground = new GroundMap(this.page);     // maplibre + overlay
  loading = () => this.page.getByTestId('load-overlay');
  async send(cmd: string) { await this.bottom.cmdInput().fill(cmd); await this.bottom.cmdInput().press('Enter'); }
  async sendViaButton(cmd: string) { await this.bottom.cmdInput().fill(cmd); await this.bottom.sendBtn().click(); }
  async selectFromList(cs: string) { await this.left.strip(cs).click(); await expect(this.detail.callsign()).toHaveText(cs); }
  lastRadio(who?: 'ATC'|'PILOT'|'SYS') { const l = this.bottom.radioLines(who); return l.last(); }
}
class LeftSidebar {
  modeBtn(m: 'RADAR'|'GROUND')            { return this.page.getByTestId(`mode-${m.toLowerCase()}`); }
  themeBtn(t: 'satellite'|'chart')        { return this.page.getByTestId(`ground-theme-${t}`); }
  stat(k: 'total'|'airborne'|'ground'|'conflict') { return this.page.getByTestId(`stat-${k}`); }
  skillValue = () => this.page.getByTestId('skill-value');
  conflictBanner = () => this.page.getByTestId('conflict-banner');
  strips = () => this.page.getByTestId(/^strip-/);
  strip(cs: string) { return this.page.getByTestId(`strip-${cs}`); }
  spawnDep = () => this.page.getByTestId('btn-spawn-dep');
  spawnArr = () => this.page.getByTestId('btn-spawn-arr');
  pause    = () => this.page.getByTestId('btn-pause');
  rate(r: 1|2|4) { return this.page.getByTestId(`rate-${r}`); }
  homeLink = () => this.page.getByTestId('nav-home'); settingsLink = () => this.page.getByTestId('nav-settings'); brand = () => this.page.getByTestId('nav-brand');
}
class DetailPanel {
  root = () => this.page.getByTestId('detail-panel'); empty = () => this.page.getByTestId('detail-empty');
  callsign = () => this.page.getByTestId('detail-callsign'); close = () => this.page.getByTestId('detail-close');
  metric(k: 'alt'|'spd'|'hdg') { return this.page.getByTestId(`metric-${k}`); }
  metricTarget(k: 'alt'|'spd') { return this.page.getByTestId(`metric-${k}-target`); }
  badge(k: 'kind'|'phase'|'ils'|'hold'|'direct'|'expd') { return this.page.getByTestId(`badge-${k}`); }
  gnd(k: 'pushback'|'taxi'|'lineup'|'takeoff'|'holdshort'|'cross') { return this.page.getByTestId(`gnd-${k}`); }
  adj(k: string) { return this.page.getByTestId(`adj-${k}`); }   // alt-up-3000, alt-up-1000, alt-dn-1000, alt-dn-3000, expd, spd-up-20, spd-up-10, spd-dn-10, spd-dn-20, hdg-l-30, hdg-l-10, hdg-r-10, hdg-r-30
  ils(rwy: string) { return this.page.getByTestId(`ils-${rwy}`); }
  hold(fix: string) { return this.page.getByTestId(`hold-${fix}`); }
  goAround = () => this.page.getByTestId('btn-go-around');
  air(k: 'climb8000'|'descend4000'|'speed200'|'clearedland') { return this.page.getByTestId(`air-${k}`); }
  typeHint = () => this.page.getByTestId('type-hint');
}
class BottomBar {
  airportName = () => this.page.getByTestId('apt-name'); icao = () => this.page.getByTestId('apt-icao');
  score = () => this.page.getByTestId('score'); highScore = () => this.page.getByTestId('score-hi');
  airport(icao: string) { return this.page.getByTestId(`ap-${icao}`); }
  tts = () => this.page.getByTestId('btn-tts'); clock = () => this.page.getByTestId('clock');
  radioLog = () => this.page.getByTestId('radio-log');
  radioLines(who?: string) { return who ? this.page.locator(`[data-testid="radio-line"][data-who="${who}"]`) : this.page.getByTestId('radio-line'); }
  cmdInput = () => this.page.getByTestId('cmd-input'); sendBtn = () => this.page.getByTestId('cmd-send');
}
class RadarCanvas {
  canvas = () => this.page.getByTestId('radar-canvas');
  async clickAircraft(cs: string) { const p = await sim(this.page).screenPos(cs); await this.canvas().click({ position: p }); }
  async clickEmpty() { const p = await sim(this.page).emptySpot(); await this.canvas().click({ position: p }); }
  async wheel(dy: number) { await this.canvas().hover(); await this.page.mouse.wheel(0, dy); }
  async drag(dx: number, dy: number) { const b = await this.canvas().boundingBox(); /* mouse.down/move/up from a verified-empty point */ }
}
class GroundMap {
  root = () => this.page.getByTestId('ground-map'); overlay = () => this.page.getByTestId('ground-overlay');
  zoomIn = () => this.page.locator('.maplibregl-ctrl-zoom-in'); zoomOut = () => this.page.locator('.maplibregl-ctrl-zoom-out');
  async clickAircraft(cs: string) { const p = await sim(this.page).screenPos(cs); await this.root().click({ position: p }); }
  async waitLoaded() { await this.page.waitForFunction(() => window.__atcTest?.mapReady() === true); }
}
```

---

## 2. Determinism and the test API

### 2.1 Principles

1. **No wall-clock in the loop under test.** In test mode the RAF loop is not started; time advances only through `__atcTest.advance()`.
2. **One RNG.** All randomness goes through `rng()` from `src/lib/sim/rng.ts`; test mode seeds it. Callsigns, types, gates, runways, fixes, entry points and auto-spawn intervals then repeat exactly for a given seed.
3. **Synchronous stepping.** `advance(N)` runs `Math.round(N*30)` fixed steps in a tight loop in the page and returns the collected events. No `waitForTimeout` anywhere in tests.
4. **Spawn is explicit.** `?spawn=none` skips the initial 4 dep + 3 arr and disables auto-spawn; tests build their own traffic with `spawnAt`. `?spawn=default` keeps the normal boot (seeded) for "real UI" flows.
5. **State assertions come from the engine; visibility assertions come from the DOM.** Every scenario asserts both.

### 2.2 Source changes (exact)

**`src/lib/sim/rng.ts` (new)**

```ts
let state = 0; let seeded = false;
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let impl: () => number = Math.random;
export function setSeed(seed: number) { state = seed; impl = mulberry32(seed); seeded = true; }
export function rng() { return impl(); }
export const rnd = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)];
export const ri  = (n: number) => Math.floor(rng() * n);
export const isSeeded = () => seeded;
```

Replace every `Math.random` in `engine.ts`, `aircraftDB.ts`, `simStore.ts` (entry-point pick, autospawn coin flip and interval) with `rng()`/`rnd()`/`ri()`.

**`simStore.ts` refactor** — split the RAF tick into a pure `step(dtSim)`:

```ts
/** Advance the sim by dtSim sim-seconds (already rate-scaled), run store side-effects. Returns engine events. */
step(dtSim: number): SimEvent[] {
  const e = this.engine; if (!e) return [];
  const events = e.update(dtSim);
  for (const ev of events) { /* existing radio routing */ }
  if (this.autoSpawn) { /* existing auto-spawn block */ }
  /* existing high-score persist + selection-clear */
  return events;
}
private start() {
  if (this.raf || this.testMode) return;                 // <— test mode never starts RAF
  const tick = (now) => { this.raf = requestAnimationFrame(tick); const dt = Math.min((now - this.last)/1000, 0.1); this.last = now;
    if (this.paused) return; this.step(dt * this.rate); if (++this.emitTick % 6 === 0) this.emit(); };
  this.raf = requestAnimationFrame(tick);
}
```

New store fields: `testMode = false`, `autoSpawn = true`, `mapReady = false` (set by GroundView on `map.on('load')`, reset on unmount).

**Boot in `atc/page.tsx`**: read `?test=1&seed=&icao=&spawn=` → `sim.enableTestMode({seed, spawn})` before `sim.load()`. Also honour `NEXT_PUBLIC_ATC_TEST` so the helper module is tree-shaken out of production when unset.

**`src/lib/sim/testApi.ts` (new, installed as `window.__atcTest` only in test mode)**

```ts
export interface AtcTestApi {
  // ── lifecycle ──
  ready(): boolean;                             // engine && !loading
  mapReady(): boolean;                          // GroundView maplibre 'load' fired (false in radar mode)
  features(): Record<FeatureFlag, boolean>;     // see 2.4
  reset(opts?: { icao?: string; seed?: number; spawn?: 'none'|'default' }): Promise<void>; // re-load airport deterministically
  seed(n: number): void;

  // ── time ──
  advance(simSeconds: number): SimEvent[];      // synchronous; loops engine.update(1/30) via sim.step(); ignores sim.paused? NO — respects paused (returns [] if paused) so pause tests are real
  advanceUntil(pred: (s: Snapshot) => boolean, maxSimSeconds: number, stepS?: number): { ok: boolean; elapsed: number; events: SimEvent[] };
  time(): number;                               // engine.time

  // ── read state ──
  snapshot(): Snapshot;                         // { time, score, skill, paused, rate, selectedId, icao, stats, aircraft: AircraftView[] , radio: RadioLine[] }
  aircraft(cs: string): AircraftView | null;    // plain JSON: id, callsign, phase, plan, pos, heading, speed, altitude, targetHeading, targetSpeed, targetAltitude, cmdAltitude, cmdIas, expedite, navMode, ilsArmed, ilsCaptured, gsCaptured, assignedRunway, holdFixName, holdPhase, directTargetName, conflict, trafficHold, holdReleased, takeoffCleared, pendingCmds, pathTotal, distAlong, taxiRoute, attention, underControl
  radio(): RadioLine[];
  events(): SimEvent[];                         // all events since last clear (ring buffer 500)
  clearEvents(): void;
  runways(): { name: string; hdg: number; active: boolean; occupied: boolean; weights: WeightClass[] | null }[];
  beacons(): string[]; gates(): string[]; taxiways(): string[];

  // ── write state ──
  spawnAt(spec: SpawnSpec): AircraftView;       // deterministic aircraft factory
  setState(cs: string, patch: Partial<AircraftState & { posLL?: {lat,lng}; posRel?: RelPos }>): AircraftView; // shallow merge, re-projects posLL/posRel
  remove(cs: string): void; clear(): void;
  setAutoSpawn(on: boolean): void; setAutoTower(on: boolean): void;
  setScore(n: number): void; setSkill(n: number): void;
  command(text: string): CommandResult;         // same as sim.command() but returns the parser result (tests still prefer the real input box)

  // ── geometry for canvas hit-testing ──
  screenPos(cs: string): { x: number; y: number } | null;   // CSS px relative to the ACTIVE canvas element (radar or ground map container)
  screenPosOf(xy: {x:number;y:number}): { x: number; y: number };
  emptySpot(): { x: number; y: number };        // point ≥ 40 css px from every aircraft & ≥ 20 px from canvas edge
  camera(): { x: number; y: number; zoom: number } | { lng: number; lat: number; zoom: number }; // radar cam or maplibre camera

  // ── feature-contract hooks (no-ops until the feature exists; `features()` reports availability) ──
  setWind(dirDeg: number, kts: number, gustKts?: number): void;
  setActiveRunways(ends: string[]): void;
  forceEmergency(cs: string, kind: 'engine_fire'|'medical'|'hydraulic'|'fuel'|'gear'): void;
  arff(): { vehicles: { id: string; pos: XY; state: 'standby'|'enroute'|'onscene'|'returning'; target?: string }[] };
  stca(): { pairs: [string,string][]; active: boolean };
  atis(): { letter: string; wind: {dir:number;kts:number}; activeRunways: string[]; issuedAt: number };
  wakeTimers(): Record<string, { runway: string; leader: string; remainingS: number }>;
}

export interface SpawnSpec {
  callsign: string; type?: string;              // e.g. 'A320', 'B77W', 'A388' (weight class drives wake)
  kind: 'departure' | 'arrival';
  phase: FlightPhase;
  // position — exactly one of:
  gate?: string;                                 // parked/pushback/taxi from a stand ref
  runway?: string;                               // hold_short/lineup/takeoff at threshold of this end
  taxiwayNode?: string;                          // any OSM node id
  posRel?: { fromRunway: string; alongNM: number; offsetNM?: number; altFt: number };  // airborne: on/near extended centreline (alongNM<0 = before threshold)
  posLL?: { lat: number; lng: number; altFt: number };
  // airborne kinematics
  heading?: number; speedKts?: number; altFt?: number;
  targets?: { alt?: number; ias?: number; hdg?: number };
  // plan
  plan?: { runway?: string; fix?: string; gateRef?: string; cruiseAlt?: number };
  // pre-arm
  ils?: string;                                  // arm ILS for this runway immediately (no pilot delay)
  hold?: { fix: string; inbound?: number; dir?: 'L'|'R' };
  taxiTo?: string;                               // build path immediately (like cmdTaxiTo)
}
```

Implementation notes:
- `advance()` calls `sim.step(1/30)` in a loop and calls `sim.emit()` once at the end (and every 30 steps for long advances) so `useSyncExternalStore` re-renders. `snapshot()` in the page uses `Math.floor(time*2)`, which changes as time advances, so React updates as usual. `advance` must return **after** React has flushed; because `emit()` is synchronous but React 19 batches, the test wrapper does `await page.evaluate(advance)` followed by `await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))))` — wrap that in `SimApi.advance()`.
- `advance()` returns `[]` and does nothing while `sim.paused`, so pause is tested for real. `advance()` ignores `sim.rate` (rate is tested by asserting `step` receives `dt*rate` via a spy: `__atcTest.lastStepDt()`), except `advanceReal(realSeconds)` which applies rate — used by the rate tests.
- `spawnAt` for airborne uses `engine.base()` + the same field setup as `spawnArrivalAtEntry`; for ground it reuses `spawnDeparture`'s path build then overrides phase/position. For `phase: 'parked'` it puts the aircraft on the gate node with `path: null`.
- `screenPos()` in radar mode reuses the ApproachView `toScreen`/`cam` (export a module-level `radarProject` setter from ApproachView); in ground mode: `m.project(e.proj.toLngLat(x,y))` returns CSS px relative to the map container (no dpr multiply — Playwright `click({position})` is in CSS px).

### 2.3 `fixtures/simApi.ts` (test side)

```ts
export class SimApi {
  constructor(private page: Page) {}
  private ev<T>(fn: (api: AtcTestApi, arg: any) => T, arg?: any) { return this.page.evaluate(([f, a]) => (window as any).__atcTest && new Function('api','a',`return (${f})(api,a)`)((window as any).__atcTest, a), [fn.toString(), arg]); }
  async waitReady() { await this.page.waitForFunction(() => (window as any).__atcTest?.ready() === true, null, { timeout: 30_000 }); }
  async advance(s: number) { const ev = await this.ev((api, a) => api.advance(a), s); await this.flush(); return ev as SimEvent[]; }
  async advanceUntil(predSrc: string, max: number) { const r = await this.ev((api, a) => api.advanceUntil(new Function('s', `return (${a.p})(s)`) as any, a.max), { p: predSrc, max }); await this.flush(); return r; }
  aircraft(cs: string) { return this.ev((api, a) => api.aircraft(a), cs) as Promise<AircraftView | null>; }
  spawnAt(spec: SpawnSpec) { return this.ev((api, a) => api.spawnAt(a), spec) as Promise<AircraftView>; }
  screenPos(cs: string) { return this.ev((api, a) => api.screenPos(a), cs) as Promise<{x:number;y:number}>; }
  // … one thin method per API entry
  private flush() { return this.page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)))); }
}
export const expectPhase = async (sim: SimApi, cs: string, phase: FlightPhase) => expect((await sim.aircraft(cs))?.phase).toBe(phase);
```

`advanceUntil` predicates are passed as source strings so they can reference `s.aircraft` in the page context (e.g. `"s => s.aircraft.find(a=>a.callsign==='BAW1')?.phase==='climb'"`).

### 2.4 Feature flags (`features()`)

`{ wind: false, atis: false, runwayChange: false, emergencies: false, arff: false, stca: false, wakeTimers: false, strips: false, keyboard: false, dragHeading: false }` today. Each flips to `true` in `testApi.ts` when the corresponding engine module exists. `fixtures/features.ts` exposes `skipUnless(feature)` which does `test.skip(!(await sim.features())[feature], 'feature not implemented')`. Gated tests remain in the matrix and count as "skipped" in reports, never "passed".

---

## 3. Selectors

### 3.1 Naming convention

`data-testid` everywhere; **never** rely on text, class or emoji (`⏸ PAUSE` / `▶ RESUME` toggles; `🔊/🔇`). Pattern: `<area>-<element>[-<param>]`, kebab-case, params verbatim from the domain (`27L`, `BAW117`, `KLAX`, `BIG`).

| Element type | testid | Notes |
|---|---|---|
| Page root | `page-home`, `page-atc`, `page-settings` | `data-ready="true"` when hydrated (set in effect) |
| Navigation links | `nav-home`, `nav-settings`, `nav-brand`, `home-settings-link`, `set-home`, `set-back` | |
| Segmented control button | `mode-radar`, `mode-ground`, `ground-theme-satellite`, `ground-theme-chart`, `set-theme-*` | plus `aria-pressed={active}` → assert `toHaveAttribute('aria-pressed','true')` |
| Toggle button (on/off) | `btn-pause`, `btn-tts`, `set-autotower`, `set-tts` | plus `data-state="on|off"` (pause: `data-state="paused|running"`) |
| Rate buttons | `rate-1`, `rate-2`, `rate-4` | `aria-pressed` |
| Stat chips | `stat-total`, `stat-airborne`, `stat-ground`, `stat-conflict` | value in `data-value`, text is the number |
| Skill | `skill-value`, `skill-fill` | |
| Conflict banner | `conflict-banner` | `data-count` |
| Aircraft list ("strip bay") | container `strip-bay`; row `strip-{callsign}`; inside: `strip-cs`, `strip-phase`, `strip-alt`, `strip-kind` | row attrs: `data-phase`, `data-kind="arrival|departure"`, `data-selected`, `data-conflict` |
| Spawn buttons | `btn-spawn-dep`, `btn-spawn-arr` | |
| Detail panel | `detail-panel` (`data-conflict`), `detail-empty`, `detail-callsign`, `detail-sub`, `detail-close`, `route-line` | |
| Big metrics | `metric-alt`, `metric-spd`, `metric-hdg`; targets `metric-alt-target`, `metric-spd-target` (`data-dir="up|dn"`) | number also in `data-value` (raw) for exact asserts |
| Badges | `badge-kind`, `badge-phase` (`data-phase`), `badge-ils` (`data-mode="LOC|ILS"`), `badge-hold` (`data-fix`), `badge-direct` (`data-fix`), `badge-expd` | |
| Ground quick buttons | `gnd-pushback`, `gnd-taxi`, `gnd-lineup`, `gnd-takeoff`, `gnd-holdshort`, `gnd-cross` | `gnd-taxi` carries `data-runway` |
| Adjust buttons | `adj-alt-up-3000`, `adj-alt-up-1000`, `adj-alt-dn-1000`, `adj-alt-dn-3000`, `adj-expd`, `adj-spd-up-20`, `adj-spd-up-10`, `adj-spd-dn-10`, `adj-spd-dn-20`, `adj-hdg-l-30`, `adj-hdg-l-10`, `adj-hdg-r-10`, `adj-hdg-r-30` | `adj-expd` has `aria-pressed` |
| ILS / HOLD rows | `ils-{rwy}`, `hold-{fix}` | `aria-pressed` for active |
| Go around | `btn-go-around` | |
| Airborne (ground mode) | `air-climb8000`, `air-descend4000`, `air-speed200`, `air-clearedland` | |
| Type hint | `type-hint` | |
| Status bar | `apt-name`, `apt-icao`, `score`, `score-hi`, `ap-{ICAO}`, `btn-tts`, `clock` | |
| Radio log | `radio-log`; line `radio-line` with `data-who="ATC|PILOT|SYS"`, `data-key`; child `radio-text` | |
| Command form | `cmd-form`, `cmd-input`, `cmd-send` | |
| Loading overlay | `load-overlay` | |
| Canvases | `radar-canvas` (ApproachView `<canvas>`), `ground-map` (map container div), `ground-overlay` (2D canvas) | |
| Home | `airport-card-{ICAO}`, `home-detail`, `home-change-airport`, `rwy-row-{ref}` (ref sanitised `09L-27R`), `rwy-end-{end}`, `rwy-weight-{end}-{W}`, `home-start` | `aria-pressed` on ends and weights |
| Settings | `set-autotower`, `set-tts`, `set-theme-satellite`, `set-theme-chart`, `set-highscore`, `set-reset-score` | |
| Feature-contract (future) | `atis-panel`, `atis-letter`, `wind`, `rwy-change-banner`, `stca-alert`, `stca-pair-{A}-{B}`, `emergency-banner-{cs}`, `btn-arff-dispatch`, `arff-vehicle-{id}`, `wake-timer-{rwy}`, `strip-bay-{dep|arr}`, `strip-drag-handle` | reserved names so specs can be written now |

Rules:
- Dynamic lists use the **domain key**, never the index: `strip-{callsign}`, `ils-{rwy}`, `hold-{fix}`, `ap-{ICAO}`. Callsigns are unique per engine (`newIdentity`).
- Boolean UI state is mirrored in `aria-pressed` / `data-state` so tests never parse emoji or CSS class names.
- Numbers are mirrored in `data-value` (unformatted) so tests avoid locale formatting (`FMT` uses `toLocaleString('en')`).
- Text assertions are allowed only on radio lines and reply strings (they are the product).

### 3.2 Canvas / map hit-testing

Never hit-test by colour. Use `__atcTest.screenPos(cs)`:
- Radar: point is CSS px inside `radar-canvas`; the click handler selects the closest aircraft within 16 px, so click exactly at `screenPos`. Before clicking, `expect(pos).toBeInsideBox(canvasBox)`; if it is off-screen the test first calls `__atcTest.centerOn(cs)` (sets `cam` to the aircraft) — add this helper.
- Ground: `screenPos` returns px relative to `ground-map` container (hit radius 22 px). Wait for `mapReady()`; if outside the viewport, `__atcTest.centerOn(cs)` calls `map.jumpTo`.
- Deselect: click at `emptySpot()` (radar clears selection on empty click and starts a drag; ground clears on empty click).
- Hover: `hover({position})` then assert `page.evaluate(() => getComputedStyle(document.querySelector('.maplibregl-canvas')).cursor) === 'pointer'`.
- To make positions stable across runs, tests call `__atcTest.centerOn(cs)` or pin the camera via `__atcTest.setCamera(...)` before geometry-dependent interactions.

---

## 4. Scenario matrix

Conventions: **Steps** are real UI actions unless prefixed `[api]` (test-API setup). **State** = assertions via `sim.aircraft()/snapshot()`; **UI** = DOM assertions. **Budget** = sim-seconds advanced (wall time is ≪ budget because stepping is synchronous; 600 sim-s ≈ 18 000 steps ≈ <2 s wall). Tags: `@smoke` (fast subset), `@gated:<feature>`.

Default fixture per scenario unless noted: `openGame({icao:'EGLL', spawn:'none', autoTower:false})`.

### 4.1 Home page (`10-home/home.spec.ts`)

| ID | Scenario | Steps | Assertions | Budget |
|---|---|---|---|---|
| H1 @smoke | Airport grid renders | goto `/` | UI: 6 `airport-card-*` (EGLL, KLAX, KJFK, KSFO, KBOS, VIDP) with name+city text; no `home-detail` | 0 |
| H2 | Settings link | click `home-settings-link` | URL `/settings`, `page-settings` visible | 0 |
| H3 @smoke | Select airport → detail | click `airport-card-EGLL` | UI: `home-detail` visible, title "Heathrow", one `rwy-row-*` per `RUNWAY_MANIFEST.EGLL`, every `rwy-end-*` `aria-pressed=true`, default weights per length (≥10000 ft → L,M,H,S pressed) | 0 |
| H4 | Change airport | H3 then click `home-change-airport` | grid visible again; select KLAX → LAX rows | 0 |
| H5 | Toggle runway end | H3; click `rwy-end-27L` | `aria-pressed=false`; click again → true | 0 |
| H6 | All ends off disables start | H3; click every `rwy-end-*` | `home-start` disabled (`toBeDisabled`) ; re-enable one → enabled | 0 |
| H7 | Toggle weight class | H3; click `rwy-weight-27L-S` | `aria-pressed=false`; others unchanged | 0 |
| H8 @smoke | Start with config → game boots with it | H3; turn off 09L,09R (keep 27L,27R); remove S from 27R; click `home-start` | URL `/atc`; `load-overlay` appears then disappears (≤30 s wall); [api] `runways()` shows only 27L/27R active, 27R weights `L,M,H`; `localStorage.skycontrol_start_config` removed; `apt-icao` = EGLL | boot |
| H9 | Config is one-shot | after H8 reload `/atc` | engine loads EGLL with all ends active (cfg consumed) | boot |
| H10 | Every airport starts | for each ICAO: pick, start | `apt-icao` matches; `stat-total` ≥ 0; no console errors (fixture fails test on `pageerror`) | boot ×6 |

### 4.2 Settings page (`20-settings/settings.spec.ts`)

| ID | Scenario | Steps | Assertions | Budget |
|---|---|---|---|---|
| S1 @smoke | Defaults | goto `/settings` with empty LS | `set-autotower` on, `set-tts` off, `set-theme-satellite` pressed, `set-highscore` "0" | 0 |
| S2 | Auto-tower toggle persists | click `set-autotower` | `data-state=off`; LS `skycontrol_autotower="0"`; reload → still off; openGame → [api] `snapshot().autoTower===false` | 0 |
| S3 | TTS toggle persists | click `set-tts` | LS `skycontrol_tts="1"`; openGame → `btn-tts` `data-state=on` | 0 |
| S4 | Theme persists to game | click `set-theme-chart` | LS `skycontrol_ground_theme="chart"`; openGame → click `mode-ground` → `ground-theme-chart` pressed | 0 |
| S5 | High score display + reset | [ls] `skycontrol_high_score=42`; goto | shows 42; click `set-reset-score` → "0", LS "0" | 0 |
| S6 | Navigation | click `set-home` → `/`; back; click `set-back` → `/` | | 0 |
| S7 | Settings from game reflects live values | openGame; click `btn-tts`; click `nav-settings` | `set-tts` on | 0 |

### 4.3 Game shell: every panel / button / toggle (`30-game-ui/*`)

| ID | Scenario | Steps | Assertions | Budget |
|---|---|---|---|---|
| G1 @smoke | Boot default | `openGame({spawn:'default'})` | `load-overlay` gone; `stat-total`=7 (4 dep + 3 arr, seeded); 7 `strip-*`; first radio line SYS "Heathrow — N stands, M runways, 30 NM TMA online"; `detail-empty` visible; `mode-radar` pressed; `radar-canvas` visible | 0 |
| G2 | Mode toggle | click `mode-ground` | `ground-map` visible, `radar-canvas` absent, brand-sub "GROUND · TOWER", `ground-theme-*` seg visible; click `mode-radar` → reverse | 0 |
| G3 | Ground theme toggle | G2; click `ground-theme-chart` | pressed; LS `skycontrol_ground_theme=chart`; [api] `mapReady()` true again after style swap; back to satellite | 0 |
| G4 | Nav links | `nav-home` → `/`; `nav-settings` → `/settings`; `nav-brand` → `/` | | 0 |
| G5 @smoke | Stats chips | [api] spawnAt dep taxi ×2, arr climb ×1 | `stat-total`=3, `stat-ground`=2, `stat-airborne`=1, `stat-conflict` absent | 0 |
| G6 | Skill bar | [api] setSkill(6) | `skill-value` "6.0", `skill-fill` width 50% | 0 |
| G7 @smoke | Strip select / deselect | click `strip-BAW1` | `data-selected=true`, `detail-callsign` BAW1, [api] `underControl=true, attention=false`; click `detail-close` → `detail-empty` | 0 |
| G8 | Strip ordering | [api] spawn A (taxi), B (approach), C (taxi) + force `conflict` on C via two aircraft ≤ 48 m apart; advance 0.1 | order: conflict row(s) first, then approach/landing, then alphabetical | 0.1 |
| G9 | Strip content | selected arrival airborne at 5000 ft | `strip-alt` "5,000 ft", `strip-kind` "A", `strip-phase` text from PHASE_LABEL; ground → "GND" | 0 |
| G10 @smoke | + DEP | click `btn-spawn-dep` | `stat-total` +1, new strip `data-kind=departure` `data-phase=taxi`, SYS radio "… taxi to …" | 0 |
| G11 @smoke | + ARR | click `btn-spawn-arr` | +1 arrival strip, airborne, phase `descent|cruise|approach`, at TMA boundary (dist ≈ radiusM ±1%) | 0 |
| G12 @smoke | Pause / resume | click `btn-pause` | `data-state=paused`, label "▶ RESUME"; [api] advance(10) → `time()` unchanged; click again → advance(10) → time +10 | 10 |
| G13 | Rate 1/2/4 | click `rate-2` | pressed; [api] `advanceReal(1)` → `time` +2; `rate-4` → +4; `rate-1` → +1 | 7 |
| G14 | Detail panel header + route (departure) | select dep | `detail-sub` "airline · type · WC/x"; `route-line` contains "RWY 27L" and "TO {fix}"; `badge-kind` "DEP" | 0 |
| G15 | Detail panel route (arrival) | select arr | "VIA {fix}" "STAND {gateRef}"; `badge-kind` "ARR" | 0 |
| G16 | Metrics live | select arr at 8000 ft, cmd descend 4000; advance 3.1 | `metric-alt-target` visible `data-dir=dn` "4,000"; advance 60 → `metric-alt` decreasing; spd target likewise | 63 |
| G17 | Badges | [api] set ilsCaptured (LOC), gsCaptured, hold, direct, expedite on separate aircraft | `badge-ils` "LOC" then "ILS"; `badge-hold` "HLD BIG"; `badge-direct` "DCT BIG"; `badge-expd` | 0 |
| G18 | Conflict panel styling | force conflict pair | `detail-panel[data-conflict]`, `conflict-banner` text "1 PAIR", `stat-conflict`=2 (count is aircraft, not pairs — assert current behaviour and document) | 0.1 |
| G19 | Ground panel vs approach panel | select ground ac → `gnd-*` visible, no `adj-*`; select airborne in RADAR → `adj-*`, `ils-*`, `hold-*`, `btn-go-around`; switch to GROUND mode → `air-*` panel | 0 |
| G20 | ILS/HOLD rows populated | | `ils-*` count = min(5, radar.runways), `hold-*` = min(5, beacons) | 0 |
| G21 | Type hint focuses input | click `type-hint` | `cmd-input` focused; placeholder contains callsign | 0 |
| G22 @smoke | Command input: Enter and SEND | fill, Enter → ATC line; fill, click `cmd-send` → ATC line; input cleared both times | 0 |
| G23 | Empty command ignored | press Enter with empty input | radio count unchanged | 0 |
| G24 | Radio log auto-scroll & cap | [api] push 80 lines via commands | `radio-line` count ≤ 61 (slice(-60)+1); `scrollTop + clientHeight ≈ scrollHeight` | 0 |
| G25 | Airport picker | click `ap-KLAX` | `load-overlay` shows "LOADING LOS ANGELES INTL"; then `apt-icao` KLAX; radio cleared; `detail-empty`; strips re-populated (seeded); in GROUND mode map `flyTo` → [api] `camera().lng ≈ -118.41` | boot |
| G26 | TTS toggle | click `btn-tts` | `data-state=on`, LS `skycontrol_tts=1`; page has `speechSynthesis.speak` stubbed via `addInitScript` and counts calls; send a valid command → 1 call; toggle off → no further calls | 0 |
| G27 | Clock | `clock` matches `/^\d\d:\d\d:\d\dZ$/`; changes within 1.5 s wall (only wall-clock assertion in the suite) | | 0 |
| G28 | Score chip | [api] setScore(5); trigger emit | `score` "5"; `score-hi` hidden while highScore 0 | 0 |
| G29 | Selection cleared when aircraft retires | select arrival in `arrived` phase; advance 4 | `detail-empty`; strip gone | 4 |

### 4.4 Ground control — full command tree (`40-ground/*`)

Setup: `spawnAt({callsign:'BAW1', type:'A320', kind:'departure', phase:'parked', gate:'<first gate>', plan:{runway:'27L'}})`, autoTower off. Both the typed command and the quick button are exercised (parametrised `for (const via of ['typed','button'])`).

| ID | Scenario | Steps | Assertions | Budget |
|---|---|---|---|---|
| GC1 @smoke | Pushback | select; `gnd-pushback` / "BAW1 PUSHBACK" | PILOT "BAW1, pushback approved"; phase `pushback`; advance 30 → phase `taxi`/`parked` per engine (assert leaves pushback within 60 s) | 60 |
| GC2 | Pushback when already moving | from taxi: PUSHBACK | SYS "BAW1: already moving"; phase unchanged | 0 |
| GC3 @smoke | Taxi to runway | "BAW1 TAXI RWY 27L" (`gnd-taxi` for EGLL) | PILOT "BAW1, taxi to 27L via …"; `plan.runway=27L`, `phase=taxi`, `pathTotal>0`, `holdReleased=false`, `taxiRoute` non-empty; advance until `hold_short` (≤600) → SYS/phase event `reached_hold`, `strip-phase` "HLD" | ≤600 |
| GC4 | Taxi to gate | arrival on ground: "TAXI TO {gate}" | `plan.gateRef` set; advance until `arrived` | ≤600 |
| GC5 | Taxi via | "BAW1 TAXI 27L VIA A B" (taxiway names from `taxiways()`) | reply includes "via"; `taxiRoute` starts with A then B | 0 |
| GC6 | Taxi via unknown | "TAXI 27L VIA ZZ" | SYS `no taxiway "ZZ" here`; path unchanged | 0 |
| GC7 | Taxi unknown dest | "TAXI 99Z" | SYS `unknown destination` | 0 |
| GC8 | Taxi where? | "BAW1 TAXI" | SYS "BAW1: taxi where?" | 0 |
| GC9 @smoke | Hold short mid-taxi | during taxi: `gnd-holdshort` | PILOT "hold short"; `holdReleased=false`; `path.holdAt ≤ distAlong + max(20, speed*2)`; advance 30 → speed → 0, `distAlong ≤ holdAt` | 30 |
| GC10 @smoke | Cross / continue | from GC9: `gnd-cross` | PILOT "continue"; `holdReleased=true`; if phase was hold_short → taxi; advance 10 → speed > 0 | 10 |
| GC11 | Hold short at runway then line up | advance to hold_short; `gnd-lineup` | PILOT "line up and wait runway 27L"; phase `lineup`; `targetHeading ≈ runwayHeading(27L)` ±1; advance 40 → aircraft position within 60 m of 27L threshold node | 40 |
| GC12 | Line up unable | from parked: LINE UP | SYS "unable line up" | 0 |
| GC13 @smoke | Cleared takeoff from lineup | GC11 then `gnd-takeoff` | PILOT "cleared for takeoff runway 27L"; phase `takeoff`; advance until `airborne` event (≤90) → phase `climb`, PILOT "…airborne…"; `stat-airborne` 1; strip alt shows ft | ≤90 |
| GC14 | Cleared takeoff from hold_short | takeoff directly at hold_short | phase `takeoff` immediately | 5 |
| GC15 | Pre-cleared takeoff while taxiing | taxi; "CLEARED TAKEOFF" | PILOT "… — continue to the runway"; `takeoffCleared=true`; advance until `takeoff` phase (via hold_short auto-roll) | ≤600 |
| GC16 | Takeoff without runway | parked no plan.runway: TAKEOFF | SYS "no runway assigned" | 0 |
| GC17 | Takeoff runway occupied waits | second ac lined up on 27L; first at hold_short with takeoffCleared | first stays `hold_short` while `runwayOccupied('27L')`; after second airborne + `runwayPhysicallyClear` → rolls; SYS "rolling, runway 27L" | ≤200 |
| GC18 | Auto-tower clears departures | `autoTower:true`; ac reaches hold_short | SYS "cleared for takeoff runway 27L" appears without user input; phase `takeoff` | ≤600 |
| GC19 | Ground traffic hold (following) | two taxiing on same path 40 m apart | trailing `trafficHold=true`, speed → 0 while leader ahead; no `ground_conflict` | 30 |
| GC20 | Ground conflict event | [api] place two ground ac 20 m apart on different paths | `ground_conflict` event; SYS "GROUND CONFLICT: A / B"; both `conflict=true`; `conflict-banner`; strips blink class `acft-row-conflict` | 0.1 |
| GC21 | Active runway ends respected | boot with ends `['27L','27R']` | 20× `btn-spawn-dep` → every `plan.runway ∈ {27L,27R}` | 0 |
| GC22 | Weight class restriction | 27R weights `['L','M']` | 20 spawns → no `perf.weightClass ∈ {H,S}` with runway 27R | 0 |
| GC23 | Departure exits airspace scored | airborne dep, climb 13000; advance until removed | `departed` event, PILOT "airborne, contact departure", `score`+1, `skill`+0.05, strip gone | ≤900 |
| GC24 | Departure diversion (low exit) | dep held at 5000 ft heading out | `diversion` event SYS "DIVERSION — left airspace below FL90"; skill −0.5 | ≤900 |
| GC25 | Ground quick buttons in radar mode | select ground ac while mode RADAR | `gnd-*` present (ground panel is mode-independent) | 0 |

### 4.5 Tower — landing, go-around, runway protection (`50-tower/*`)

Setup: arrival `DAL5` established: `spawnAt({kind:'arrival', phase:'approach', posRel:{fromRunway:'27L', alongNM:-10, altFt:3000}, heading:rwyHdg, speedKts:170, ils:'27L'})`.

| ID | Scenario | Steps | Assertions | Budget |
|---|---|---|---|---|
| T1 @smoke | Cleared to land phrase | "DAL5 CLEARED LAND" / `air-clearedland` (GROUND mode) | PILOT "cleared to land runway 27L" | 0 |
| T2 | Cleared land not airborne | ground ac: CLEARED LAND | SYS "not airborne" | 0 |
| T3 | Cleared land no runway | airborne no ILS/plan: LAND | SYS "no runway assigned" | 0 |
| T4 @smoke | ILS → landing → touchdown → rollout | advance until phase `landing` (≤120) | `plan.runway=27L`, `path.kind='approach'`; `touchdown` event PILOT text; phase `rollout`; speed decreasing | ≤300 |
| T5 @smoke | Vacate → taxi to stand → arrived | continue T4 until `taxi` | SYS "vacated, taxi to stand {gateRef}"; `score`+1; `skill`+0.1; then `arrived` → strip removed after 3 s; `stat-total` −1 | ≤900 |
| T6 | Landing runway occupied at 8 NM → go-around | ground ac lined up on 27L before DAL5 reaches 8 NM | `go_around` event "going around — runway occupied"; phase `climb`, `ilsCaptured=false`, `navMode='heading'`; `btn-go-around` etc. still available | ≤120 |
| T7 | Late go-around <2 NM | occupy runway after `landing` phase, before 2 NM | "going around — runway not clear" | ≤200 |
| T8 | Rollout exemption | ac in `rollout` >500 m from threshold does NOT trigger T7 for a lander at 1.5 NM | no go_around | ≤200 |
| T9 @smoke | Manual go-around | `btn-go-around` / "DAL5 GO AROUND" | PILOT reply; phase `climb`; `targetAltitude` = go-around alt; ILS badges cleared | 30 |
| T10 | Go-around clears runway assignment for takeoff | after T9, dep at hold_short 27L with takeoff → rolls (runway not occupied) | phase takeoff | 30 |
| T11 @gated:wakeTimers | Wake timer after heavy departs | A388 departs 27L; A320 at hold_short cleared takeoff | `wake-timer-27L` visible counting down `wakeTimers()['27L'].remainingS`; A320 holds until 0; SYS message | ≤180 |
| T12 | Wake separation in trail | H leader 4 NM ahead of M follower same alt | no `separation_loss` at 4 NM; move follower to 3.5 NM → `separation_loss` (required = max(wake) ≥ 4) | 0.1 |

### 4.6 Approach — vectors, alt, speed, direct, hold, ILS (`60-approach/*`)

Setup: `UAL9` arrival, phase `descent`, 8000 ft, 250 kt, heading 090, 20 NM SW of field; selected; mode RADAR. `PD` = pilot delay 3 s.

| ID | Scenario | Steps | Assertions | Budget |
|---|---|---|---|---|
| A1 @smoke | Heading typed | "UAL9 HDG 180" | ATC echo uppercase; PILOT reply; before PD: `pendingCmds` has kind heading; advance 3.1 → `targetHeading=180`, `navMode='heading'`; advance 60 → heading within 2° of 180 | 63 |
| A2 | Heading with turn dir | "TURN HEADING 240 LEFT" | `turnDir='L'`; advance 10 → heading decreasing through west | 13 |
| A3 | Heading shorthand | "H270" | works | 3.1 |
| A4 | Heading missing number | "UAL9 HEADING" | SYS "UAL9: heading?" | 0 |
| A5 @smoke | HDG buttons | `adj-hdg-l-30`, `adj-hdg-l-10`, `adj-hdg-r-10`, `adj-hdg-r-30` | each sends `heading (round10(hdg)±d)`; ATC line text matches; 360 wraparound (heading 5 → L30 → "heading 340"; 355 → R10 → "heading 360" not "0") | 3.1 ×4 |
| A6 @smoke | Altitude climb/descend | "DESCEND 4000" | advance 3.1 → `cmdAltitude=4000`; `metric-alt-target` dn; advance 120 → altitude ≤ 4100; then "CLIMB 8000" → up | 250 |
| A7 | Altitude shorthand | "ALT 5000", "A50"(→5000? no — `A\d` path: "A5" → 5000), "CLIMB 8" → 8000 | `cmdAltitude` | 3.1 ×3 |
| A8 | Altitude buttons | `adj-alt-up-3000/1000`, `adj-alt-dn-1000/3000` | commands relative to `round1000(cmdAltitude ?? altitude)`; floor 0 | 3.1 ×4 |
| A9 @smoke | Expedite | `adj-expd` / "EXPEDITE" / "DESCEND 3000 EXPEDITE" | `expedite=true`; `badge-expd`; `adj-expd` `aria-pressed`; vertical rate greater than non-expedite twin (compare two aircraft over 60 s) | 63 |
| A10 @smoke | Speed | "SPEED 180", `adj-spd-dn-20` etc., "S200" | `cmdIas`; `metric-spd-target`; floor 100 in buttons | 3.1 ×3 |
| A11 | Speed missing | "SPD" → SYS "speed?" | | 0 |
| A12 @smoke | Direct to fix | "DCT BIG" / "DIRECT BIG" | `navMode='direct'`, `directTargetName='BIG'`, `badge-direct` "DCT BIG"; advance until dist to beacon < 1 NM (≤600) then navMode reverts | ≤600 |
| A13 | Direct unknown / missing | "DCT ZZZZZ" → SYS unknown; "DCT" → "direct where?" | | 0 |
| A14 @smoke | Hold at fix | `hold-BIG` / "HOLD BIG" / "HOLD BIG LEFT 090" | `navMode='hold'`, `holdFixName='BIG'`, `holdTurnDir`, `holdInboundHdg=90`; `badge-hold`, `hold-BIG` pressed; advance 600 → `holdPhase` cycles through to_fix→outbound→inbound (collect distinct values ≥3); stays within 12 NM of fix | 600 |
| A15 | Hold missing fix | "HOLD" → "hold at which fix?" (must not be parsed as hold short) | | 0 |
| A16 | Exit hold via heading/direct | A14 then "HDG 270" | `navMode='heading'`, badge gone | 3.1 |
| A17 @smoke | ILS clearance & capture | position 12 NM out, 30° intercept, 3000 ft; `ils-27L` / "ILS 27L" / "CLEARED ILS 27L" | reply; `ilsArmed=true`, `assignedRunway=27L`, `ils-27L` pressed; advance until `ilsCaptured` (≤180) → `badge-ils` "LOC"; until `gsCaptured` → "ILS"; then T4/T5 chain | ≤300 |
| A18 | ILS which runway | "ILS" → SYS "ILS which runway?"; "ILS 99" → SYS unknown runway | | 0 |
| A19 | ILS re-vector cancels | after capture: "HDG 360" | `ilsCaptured=false` (or documented engine behaviour) | 3.1 |
| A20 @smoke | Full arrival end-to-end via UI only | spawn at entry via `btn-spawn-arr`; vector with buttons only (HDG/ALT/SPD/ILS) to 27L; land; taxi to gate | `score`+2 (vacate + …), `skill` up; strips reflect each phase (`data-phase` sequence recorded via MutationObserver in page ⊇ descent→approach→landing→rollout→taxi→arrived) | ≤1500 |
| A21 | Airborne quick panel (GROUND mode) | select airborne in GROUND mode; `air-climb8000`, `air-descend4000`, `air-speed200` | corresponding `cmdAltitude`/`cmdIas` | 3.1 ×3 |
| A22 | Latest pending cmd wins | "HDG 180" then immediately "HDG 200" | after PD: `targetHeading=200`; `pendingCmds` length 1 | 3.1 |
| A23 | Arrival diversion | vector arrival outward; advance until removed | SYS "DIVERSION — exited airspace", skill −0.5 | ≤900 |
| A24 | Separation loss (airborne) | two ac same alt 2.5 NM | `separation_loss` SYS, `conflict` both, banner, skill −0.5 once (not per tick) | 0.2 |
| A25 | Separation restored | A24 then "CLIMB 9000" one ac; advance 120 | `conflict=false`, banner gone; new loss later re-emits (pair key cleared) | 120 |

### 4.7 Safety / alerts (`70-safety/*`)

| ID | Scenario | Assertions | Budget |
|---|---|---|---|
| SF1 @smoke | Conflict pair counted once | `ground_conflict` emitted once per pair while persisting (advance 10, count SYS lines) | 10 |
| SF2 | Conflict colours | `strip-*[data-conflict=true]` ×2; `detail-panel[data-conflict]` when selected | 0.1 |
| SF3 @gated:stca | STCA predictive alert | two ac converging, 3 NM/1000 ft loss predicted in 60 s: `stca-alert` visible, `stca().pairs` includes pair, audio stub called once; resolve → alert clears | 60 |
| SF4 @gated:stca | STCA not raised for vertically separated | 1100 ft apart → no alert | 60 |

### 4.8 Persistence (`95-persistence/persistence.spec.ts`)

| ID | Scenario | Assertions | Budget |
|---|---|---|---|
| P1 @smoke | High score written | [api] setScore(7); advance 0.1 → LS `skycontrol_high_score=7`; `score-hi` "HI 7"; reload → `sim.highScore` 7; settings shows 7 | 0.1 |
| P2 | High score not lowered | LS 50 → setScore(7) → LS stays 50 | 0.1 |
| P3 | Ground theme, TTS, autoTower round-trip | set in game → reload → same | 0 |
| P4 | Start config consumed once | H8/H9 | boot |
| P5 | Fresh context has no state | new context → defaults | 0 |

### 4.9 Error states (`99-errors/invalid-commands.spec.ts`)

Each row: send text → assert last radio line is `SYS` with exact reason text, aircraft state unchanged (deep-equal `aircraft(cs)` before/after), `cmd-input` cleared.

| Input | Expected SYS reply |
|---|---|
| `ZZZ999 HDG 180` | `No aircraft "ZZZ999" on frequency` |
| `UAL9 FOO BAR` | `UAL9: unable — say again` |
| `UAL9 HEADING` | `UAL9: heading?` |
| `UAL9 CLIMB` | `UAL9: altitude?` |
| `UAL9 SPEED` | `UAL9: speed?` |
| `UAL9 ILS` | `UAL9: ILS which runway?` |
| `UAL9 DCT` | `UAL9: direct where?` |
| `UAL9 HOLD` | `UAL9: hold at which fix?` |
| `BAW1 TAXI` | `BAW1: taxi where?` |
| `BAW1 TAXI 99Z` | `BAW1: unknown destination "99Z"` |
| `BAW1 TAXI 27L VIA ZZ` | `BAW1: no taxiway "ZZ" here` |
| `BAW1 LINE UP` (parked) | `BAW1: unable line up` |
| `BAW1 TAKEOFF` (no runway) | `BAW1: no runway assigned` |
| `BAW1 CLEARED LAND` (ground) | `BAW1: not airborne` |
| `BAW1 PUSHBACK` (taxi) | `BAW1: already moving` |
| lowercase `ual9 hdg 180` | accepted (ATC line uppercased) |
| whitespace `  UAL9   HDG   180 ` | accepted |

Also: `reply()` classifier regression — a PILOT reply must never be classified SYS: assert `data-who=PILOT` for every ok reply in the matrix.

### 4.10 Map interactions (`90-map/*`)

| ID | Scenario | Steps | Assertions | Budget |
|---|---|---|---|---|
| M1 @smoke | Radar click selects | `radar.clickAircraft('UAL9')` | `detail-callsign` UAL9; strip selected | 0 |
| M2 | Radar click empty deselects | `radar.clickEmpty()` | `detail-empty` | 0 |
| M3 | Radar hit radius | click at `screenPos + (20,0)` | not selected; at +(10,0) → selected | 0 |
| M4 | Radar wheel zoom | record `camera().zoom`; `wheel(-300)` | zoom increased; `screenPos` distances between two ac increase proportionally | 0 |
| M5 | Radar drag pan | mouse down at emptySpot, move +100,+50, up | `camera().x/y` changed by 100/k, −50/k; aircraft `screenPos` shifted by ≈(100,50) | 0 |
| M6 | Radar selection ring / label rendering | after M1 take canvas pixel sample around `screenPos` | non-background pixels present (sanity, not exact) | 0 |
| M7 @smoke | Ground map loads (WebGL) | `mode-ground`; `ground.waitLoaded()` | `mapReady()`; `.maplibregl-canvas` present; no `pageerror` | 0 |
| M8 | Ground click selects / hover cursor | `ground.clickAircraft('BAW1')`; hover | selected; cursor `pointer`; hover empty → `''` | 0 |
| M9 | Ground zoom controls | click `.maplibregl-ctrl-zoom-in` | `camera().zoom` +1 | 0 |
| M10 | Ground follows airport switch | click `ap-KJFK` in ground mode | `camera()` centre ≈ KJFK within 0.05° after `flyTo` (poll `moveend` via `__atcTest.mapIdle()`) | boot |
| M11 | Overlay canvas sizing | resize viewport to 1200×800 | `ground-overlay` width/height == map canvas size; style size == container | 0 |
| M12 @gated:dragHeading | Drag-heading | mousedown on selected ac, drag 100 px at 45°, up | ATC "… HEADING 045" sent; `targetHeading` after PD | 3.1 |
| M13 @gated:keyboard | Shortcuts | `Space` pause, `1/2/4` rate, `Esc` deselect, `Tab` cycle strips, `G`/`R` mode, `/` focus input | corresponding state changes; shortcuts inert while `cmd-input` focused (except Esc) | 0 |

### 4.11 ATIS / wind / runway change (`80-airport/atis-wind.spec.ts`, all `@gated:wind|atis|runwayChange`)

| ID | Scenario | Assertions | Budget |
|---|---|---|---|
| W1 | Wind display | `setWind(270,12)` → `wind` text "270/12"; `atis-letter` "A" | 0 |
| W2 | ATIS letter increments on change | setWind again → "B"; SYS radio "Information Bravo…" | 0 |
| W3 | Runway change on wind reversal | active 27L/27R; `setWind(90,15)`; advance 60 → `rwy-change-banner` visible, `runways()` active = 09L/09R; new departures get 09x; ILS buttons re-ordered; existing hold_short 27L departures get SYS advisory | 60 |
| W4 | Crosswind no change | `setWind(180,10)` → active unchanged | 60 |
| W5 | Approach ground speed affected by wind | same IAS, head vs tail wind → ground speed differs ±wind | 30 |

### 4.12 Emergencies + ARFF (`80-airport/emergencies.spec.ts`, `@gated:emergencies|arff`)

| ID | Scenario | Assertions | Budget |
|---|---|---|---|
| E1 | Declare emergency | `forceEmergency('UAL9','engine_fire')` → PILOT "MAYDAY…"; `emergency-banner-UAL9`; strip `data-emergency`; sorted to top | 0 |
| E2 | Priority landing accepted | ILS + land → score bonus; other ac on final auto-go-around | ≤300 |
| E3 | ARFF dispatch button | `btn-arff-dispatch` → `arff().vehicles` all `enroute` to assigned runway; `arff-vehicle-*` DOM markers move: `screenPos` changes over advance(30); reach runway → `onscene` | 60 |
| E4 | ARFF auto-return | after emergency ac `arrived` → vehicles `returning` → `standby` at station | ≤300 |
| E5 | Runway blocked while ARFF on scene | departures on that runway held; `runwayOccupied` true | 60 |
| E6 | Ignored emergency penalty | no dispatch within 120 s → skill −1, SYS message | 120 |

### 4.13 Strip bay ops (`80-airport/strips.spec.ts`)

Non-gated (today's list): covered by G7–G9, G29. `@gated:strips` extras: drag reorder within `strip-bay-dep`, move dep→arr bay rejected, strip highlight on `attention`, pending-cmd indicator, double-click focuses input with callsign prefilled.

### 4.14 Harness self-tests (`00-harness/*`) @smoke

- WebGL probe: `getContext('webgl2')` non-null with swiftshader; MapLibre `load` within 20 s wall.
- Test mode: `?test=1` → `__atcTest` defined, RAF loop not running (`time()` constant across 500 ms wall), seed reproducibility (two contexts, same seed, `spawn:'default'` → identical callsign lists and positions).
- `advance(1)` → `time()` = 1 ± 1/60; `advance` while paused → no change.

---

## 5. Visual regression (`visual/screens.spec.ts`, project `visual`)

### 5.1 Baselines

| Baseline | Setup | Mask / mode |
|---|---|---|
| `home-grid` | `/` | full page |
| `home-detail-EGLL` | pick EGLL | full page |
| `settings-default` | `/settings` | full page |
| `atc-radar-empty` | openGame spawn none | mask `clock`; `radar-canvas` included (deterministic: pure 2D, seeded, no time-based animation after `advance(0)`) |
| `atc-radar-traffic` | seeded scenario `scenarios.json#egll-mixed-8`, camera pinned via `setCamera`, `advance(5)` | mask `clock` |
| `atc-radar-selected` | + select UAL9 (ILS captured) | mask `clock` |
| `atc-radar-conflict` | forced conflict | mask `clock`; blink animations disabled via `animations:'disabled'` **and** a test-mode CSS override `.acft-row-conflict,.conflict-banner,.badge-expd{animation:none!important}` |
| `atc-ground-chart` | mode ground, theme chart, `mapReady`, `mapIdle` | **mask the MapLibre canvas** (`.maplibregl-canvas`) — swiftshader tile raster differs subtly between runs; assert overlay + chrome only |
| `atc-ground-satellite` | theme satellite | same mask |
| `atc-detail-ground` / `atc-detail-approach` | element screenshots of `detail-panel` | element-level, tight tolerance |
| `atc-loading` | click `ap-KLAX`, capture while `load-overlay` visible (spinner masked) | mask `.load-spinner` |
| `atc-airport-{ICAO}` ×6 | radar mode, spawn none | mask `clock` |

### 5.2 Tolerance strategy

- DOM chrome: `maxDiffPixelRatio: 0.002`, `threshold: 0.2` (per-pixel colour distance) — fonts are `ui-monospace` fallbacks; pin fonts by adding a `@font-face` for a bundled monospace in test mode CSS so Linux CI and dev match, and set `deviceScaleFactor: 1`.
- Radar 2D canvas: compare, but with `maxDiffPixelRatio: 0.01` — anti-aliasing on swiftshader is deterministic for identical draw calls; the test pins camera and `advance()` to a fixed sim time.
- MapLibre WebGL canvas: **masked**. Correctness of the base map is covered by `mapReady` + a separate coarse check: read back one 64×64 block at a known runway location and assert mean luminance is in the expected band (runway grey vs background). Optionally a low-res (`scale:0.25`) unmasked screenshot with `maxDiffPixelRatio: 0.08` as an early-warning, non-blocking test (`test.info().annotations` + `expect.soft`).
- Everything with wall-clock (`clock`) or non-seeded animation is masked. `animations: 'disabled'` freezes CSS animations at start state.
- Baselines are stored per project (`__screenshots__/visual/...`) and updated only with `npm run test:e2e:update`; PRs that change them must include the diff images from `test-results/`.

---

## 6. Run scripts and smoke subset

### 6.1 `scripts/e2e.sh` (CI-style)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
export NEXT_PUBLIC_ATC_TEST=1 NEXT_TELEMETRY_DISABLED=1 CI="${CI:-1}"
MODE="${1:-full}"          # full | smoke | visual | update-visual
GREP=""; PROJ="--project=chromium"
case "$MODE" in
  smoke)         GREP="--grep @smoke" ;;
  visual)        PROJ="--project=visual" ;;
  update-visual) PROJ="--project=visual --update-snapshots" ;;
  full)          PROJ="--project=chromium --project=visual" ;;
esac
# Fail fast if 3005 is held by a foreign process (CI wants a fresh server)
if [ "$CI" = "1" ] && (ss -ltn | grep -q ':3005 '); then echo "port 3005 busy"; exit 2; fi
npm run typecheck
npx playwright test $PROJ $GREP --reporter=list,html,junit
echo "report: test-results/report/index.html  junit: test-results/junit.xml"
```

Dev loop: keep `npx next dev -p 3005` running; `npm run test:e2e:smoke` reuses it (`reuseExistingServer`). Use `npx playwright test specs/60-approach --headed` is not possible without a display; use `--trace on` + `npx playwright show-trace` instead, or `--ui` via `PW_TEST_HTML_REPORT_OPEN=never` + port-forward.

### 6.2 Smoke subset (`@smoke`, target < 90 s wall)

H1, H3, H8, S1, G1, G5, G7, G10, G11, G12, G22, GC1, GC3, GC9, GC10, GC13, T1, T4, T5, T9, A1, A5, A6, A9, A10, A12, A14, A17, A20, SF1, P1, M1, M7, harness probes. This exercises: boot from home config, every panel, one full departure (parked→airborne) and one full arrival (entry→gate), all quick-button rows, radar and ground canvases, persistence, and the WebGL path.

### 6.3 Failure triage aids

- Fixture `afterEach`: on failure attach `__atcTest.snapshot()` JSON, the radio log, and `events()` to the test (`testInfo.attach`) — the trace shows DOM, the attachment shows the engine.
- Fixture rejects the test on any `pageerror` or `console.error` (allowlist MapLibre "AbortError" and tile 404s for missing satellite tiles).
- `test.describe.configure({ mode: 'serial' })` only inside multi-step chains (A20, T4/T5); everything else independent so retries are meaningful.

### 6.4 Implementation order

1. `rng.ts` + `sim.step()` refactor + `?test=1` boot + `testApi.ts` (no UI changes yet). Harness self-tests pass.
2. Add `data-testid`/`aria-pressed`/`data-*` attributes to the three pages (pure markup, no behaviour change).
3. Page objects + fixtures; land `@smoke`.
4. Fill sections 4.1–4.10 and 4.14.
5. Visual project + baselines.
6. Gated suites stay skipped until their feature lands; flipping a flag in `features()` is the definition of done for that feature.

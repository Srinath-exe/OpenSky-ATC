/*
  Map interactions — 05-TEST-STRATEGY §4.10 (M-series) adapted to the shipped views:
    GroundView (src/components/atc/GroundView: MapLibre pavement + overlay canvas + DOM chrome — toolbar, layers /
    presets popovers, right-click quick menu, hover tooltip, edge arrow) for GROUND and TOWER, and the ApproachView
    radar (src/components/atc/ApproachView) for APPROACH. The radar's click / hover / drag-to-heading / wheel / pan /
    range presets / measure tool are covered in 50-approach.spec.ts; this file adds the ground map end to end plus the
    radar chrome that shares state with it (follow, rings, centre).

  Canvas hit-testing follows 05 §3.2: positions come from `sim.screenPos` / `screenPosOf` / `emptySpot` (CSS px inside
  `ground-map` / `radar-canvas`), the camera from `sim.camera()` (`{lng, lat, zoom}` on the ground map, `{x, y, zoom}` on
  the radar) and every selection / setting change is asserted through the DOM (strips, panel, toolbar data-state,
  popovers, toasts) AND the store (`sim.snapshot().selectedId`, `sim.storeSettings()`, localStorage).

  Boot: `/play?icao=EGLL&seed=7&spawn=none&test=1&position=ground|tower|approach`, `waitMap` for the ground map.
*/
import { test, expect, type SimApi, type SpawnSpec, readLocalStorageJson } from './fixtures/test';
import type { GamePage } from './pages/GamePage';
import { RadarPage } from './pages/RadarPage';

const GROUND = { icao: 'EGLL', spawn: 'none', position: 'ground', waitMap: true } as const;
const TOWER = { icao: 'EGLL', spawn: 'none', position: 'tower', waitMap: true } as const;
const PD = 3.2;
type Pt = { x: number; y: number };
type GroundCam = { lng: number; lat: number; zoom: number };

function inbound(cs: string, extra: Partial<SpawnSpec> = {}): SpawnSpec {
  return { callsign: cs, type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250, plan: { runway: '27L' }, ...extra };
}
/** Departure at the stand's entry node, engines running (stage taxi_out, no clearance yet). */
function readyToTaxi(cs: string, gate: string): SpawnSpec {
  return { callsign: cs, type: 'A320', kind: 'departure', phase: 'taxi', gate };
}
async function groundCam(sim: SimApi): Promise<GroundCam> {
  const c = await sim.camera();
  if (!('lng' in c)) throw new Error(`ground camera expected, got ${JSON.stringify(c)}`);
  return c;
}
async function box(game: GamePage): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await game.groundMap().boundingBox();
  expect(b, 'ground-map has no bounding box').not.toBeNull();
  return b!;
}
const inside = (p: Pt | null, b: { width: number; height: number }, margin = 0) => !!p && p.x >= margin && p.y >= margin && p.x <= b.width - margin && p.y <= b.height - margin;
/** Poll until the projected position of `cs` is stable and inside the map (the overlay + MapLibre settle on the wall clock). */
async function stablePos(sim: SimApi, game: GamePage, cs: string): Promise<Pt> {
  const b = await box(game);
  let last: Pt | null = null;
  await expect.poll(async () => {
    const p = await sim.screenPos(cs);
    const ok = inside(p, b, 10) && !!last && Math.abs(p!.x - last.x) < 0.5 && Math.abs(p!.y - last.y) < 0.5;
    last = p;
    return ok;
  }, { message: `${cs} never settled inside the ground map` }).toBe(true);
  return last!;
}
/** Hover the ground map at a canvas point and wait for the tooltip (150 ms wall-clock hover delay). */
async function hoverAt(game: GamePage, p: Pt): Promise<void> {
  await game.groundMap().hover({ position: p });
  await expect(game.mapTooltip()).toHaveAttribute('data-open', 'true');
}
async function cursor(game: GamePage): Promise<string> {
  return game.page.evaluate(() => getComputedStyle(document.querySelector('.maplibregl-canvas') as HTMLElement).cursor);
}
/**
 * A canvas point that is really free: `sim.emptySpot()` first, verified with elementFromPoint (the strip bay / panel /
 * comm log float over the map and can move as strips expand), else a scan of the central band away from every symbol.
 */
async function freeSpot(sim: SimApi, game: GamePage): Promise<Pt> {
  const b = await box(game);
  const symbols: Pt[] = [];
  for (const cs of await sim.callsigns()) { const p = await sim.screenPos(cs); if (p) symbols.push(p); }
  for (const v of await sim.vehicles()) symbols.push(await sim.screenPosOf(v.pos));
  const free = (p: Pt) => game.page.evaluate(({ x, y }) => {
    const el = document.querySelector('[data-testid="ground-map"]') as HTMLElement;
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + x, r.top + y)?.tagName === 'CANVAS';
  }, p);
  const clear = (p: Pt) => symbols.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= 60);
  const first = await sim.emptySpot();
  if (clear(first) && (await free(first))) return first;
  for (const fy of [0.5, 0.35, 0.65, 0.25, 0.75]) for (const fx of [0.5, 0.4, 0.6, 0.35, 0.65]) {
    const p = { x: Math.round(b.width * fx), y: Math.round(b.height * fy) };
    if (clear(p) && (await free(p))) return p;
  }
  throw new Error('no free spot on the ground map');
}
async function selectedVehicle(game: GamePage): Promise<string | null> {
  return game.page.evaluate(() => (window as unknown as { __atcSim?: { selectedVehicleId?: string | null } }).__atcSim?.selectedVehicleId ?? null);
}

test.describe('ground map', () => {
  test('M7 / M11 the map loads on GROUND and TOWER; the overlay canvas matches the MapLibre canvas and follows a resize @smoke', async ({ openGame, sim, page }) => {
    const game = await openGame(GROUND);
    expect(await sim.mapReady()).toBe(true);
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-position', 'ground');
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'satellite');
    await expect(page.locator('.maplibregl-canvas')).toHaveCount(1);
    await expect(game.groundOverlay()).toBeVisible();
    await expect(game.view('ground')).toBeVisible();
    await expect(game.radarCanvas()).toHaveCount(0);
    const sizes = () => page.evaluate(() => {
      const map = document.querySelector('.maplibregl-canvas') as HTMLCanvasElement;
      const ov = document.querySelector('[data-testid="ground-overlay"]') as HTMLCanvasElement;
      const host = document.querySelector('[data-testid="ground-map"]') as HTMLElement;
      return { map: [map.width, map.height], ov: [ov.width, ov.height], ovCss: [ov.style.width, ov.style.height], host: [host.clientWidth, host.clientHeight] };
    });
    let s = await sizes();
    expect(s.ov).toEqual(s.map);
    expect(s.ovCss).toEqual([`${s.host[0]}px`, `${s.host[1]}px`]);
    expect(s.host[0]).toBeGreaterThan(400);
    const cam = await groundCam(sim);
    expect(cam.lat).toBeCloseTo(51.47, 1);                                 // Heathrow
    expect(cam.lng).toBeCloseTo(-0.45, 1);
    expect(cam.zoom).toBeGreaterThan(11);

    // resize: both canvases follow the container
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => { s = await sizes(); return s.ov[0] === s.map[0] && s.ov[1] === s.map[1] && s.ovCss[0] === `${s.host[0]}px`; }).toBe(true);
    expect(s.host[0]).toBeLessThanOrEqual(1280);
    expect(s.host[0]).toBeGreaterThan(400);
    await page.setViewportSize({ width: 1600, height: 950 });
    await expect.poll(async () => { s = await sizes(); return s.ovCss[0] === `${s.host[0]}px` && s.ov[0] === s.map[0]; }).toBe(true);

    // TOWER shares the same view; APPROACH swaps in the radar (mapReady drops while the map is unmounted)
    await game.setPosition('tower');
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-position', 'tower');
    expect(await sim.mapReady()).toBe(true);
    await expect(page.getByTestId('map-tool-vehicles')).toBeVisible();
    await game.setPosition('approach');
    await expect(game.radarCanvas()).toBeVisible();
    await expect(game.groundMap()).toHaveCount(0);
    expect(await sim.mapReady()).toBe(false);
    const rc = await sim.camera();
    expect('x' in rc && 'y' in rc).toBe(true);
    await game.setPosition('ground');
    await sim.waitMapReady();
    await expect(game.groundMap()).toBeVisible();
    expect('lng' in (await sim.camera())).toBe(true);
  });

  test('M8 click selects (strip + panel), empty click deselects, hover shows the tooltip with the pointer cursor @smoke', async ({ openGame, sim }) => {
    const game = await openGame(TOWER);
    await sim.spawnAt({ callsign: 'BAW7', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '27R', plan: { runway: '27R' } });
    await expect(game.strip('BAW7')).toHaveAttribute('data-bay', 'AT_HOLD');
    await sim.centerOn('BAW7');
    const p = await stablePos(sim, game, 'BAW7');

    // hover: tooltip card (callsign · type/wake · stage · RWY) + pointer cursor; store hoveredId follows
    await hoverAt(game, p);
    await expect(game.mapTooltip()).toContainText('BAW7');
    await expect(game.mapTooltip()).toContainText('A320/M');
    await expect(game.mapTooltip()).toContainText('27R');
    await expect(game.mapTooltip()).toContainText(/DEP/);
    expect(await cursor(game)).toBe('pointer');
    expect((await sim.storeView()).hoveredId).toBe((await sim.aircraftOrFail('BAW7')).id);
    await expect(game.strip('BAW7')).toHaveAttribute('data-hovered', 'true');

    // click: selection in the store, the strip and the panel
    await game.groundMap().click({ position: p });
    await expect(game.strip('BAW7')).toHaveAttribute('data-selected', 'true');
    await expect(game.panelCallsign()).toHaveText('BAW7');
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'true');
    expect((await sim.snapshot()).selectedId).toBe((await sim.aircraftOrFail('BAW7')).id);
    expect((await sim.aircraftOrFail('BAW7')).underControl).toBe(true);

    // a miss outside the hit radius (22 px) keeps the selection; an empty click drops it and closes the tooltip
    await game.groundMap().click({ position: { x: p.x + 40, y: p.y } });
    expect((await sim.snapshot()).selectedId).toBeNull();
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await game.groundMap().click({ position: { x: p.x + 8, y: p.y } });
    await expect(game.strip('BAW7')).toHaveAttribute('data-selected', 'true');
    const empty = await freeSpot(sim, game);
    await game.groundMap().click({ position: empty });
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await expect(game.strip('BAW7')).toHaveAttribute('data-selected', 'false');
    expect((await sim.snapshot()).selectedId).toBeNull();
    await game.groundMap().hover({ position: empty });
    await expect(game.mapTooltip()).toHaveAttribute('data-open', 'false');
    expect(await cursor(game)).not.toBe('pointer');
    await expect.poll(async () => (await sim.storeView()).hoveredId).toBeNull();
  });

  test('vehicles: a dispatched follow-me renders on the map, its tooltip names it and clicking it selects the vehicle @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    await sim.spawnAt(readyToTaxi('BAW8', '401'));
    const r = await sim.dispatchAst({ kind: 'dispatchVehicle', type: 'followme', ids: ['FOLLOW1'], count: 1, target: { kind: 'aircraft', id: (await sim.aircraftOrFail('BAW8')).id, callsign: 'BAW8' } });
    expect(r.ok).toBe(true);
    await sim.advance(15);
    const v = await sim.vehicle('FOLLOW1');
    expect(v?.state).toBe('enroute');
    // bring the truck on screen: the ground camera accepts engine XY (jumpTo through the projection)
    await sim.setCamera({ x: v!.pos.x, y: v!.pos.y, zoom: 16 });
    const b = await box(game);
    let p: Pt | null = null;
    await expect.poll(async () => { p = await sim.vehicleScreenPos('FOLLOW1'); return inside(p, b, 10); }).toBe(true);
    expect(p!.x).toBeCloseTo(b.width / 2, -2);
    expect(p!.y).toBeCloseTo(b.height / 2, -2);
    await expect(game.bay('VEHICLES').getByTestId('strip-vehicle-FOLLOW1')).toHaveAttribute('data-state', 'enroute');

    await hoverAt(game, p!);
    await expect(game.mapTooltip()).toContainText(/FOLLOW/i);
    await expect(game.mapTooltip()).toContainText(/EN ROUTE/);
    await expect(game.mapTooltip()).toContainText('BAW8');
    expect(await cursor(game)).toBe('pointer');

    // click: the vehicle is selected (store flag + engine flag), any aircraft selection is dropped
    await game.selectStrip('BAW8');
    await game.groundMap().click({ position: p! });
    await expect.poll(() => selectedVehicle(game)).toBe('FOLLOW1');
    expect((await sim.vehicle('FOLLOW1'))?.selected).toBe(true);
    expect((await sim.snapshot()).selectedId).toBeNull();
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await game.groundMap().click({ position: await freeSpot(sim, game) });
    await expect.poll(() => selectedVehicle(game)).toBeNull();
    expect((await sim.vehicle('FOLLOW1'))?.selected).toBe(false);
    // it keeps driving: the projected position moves with sim time
    await sim.advance(20);
    const q = await sim.vehicleScreenPos('FOLLOW1');
    expect(Math.hypot(q!.x - p!.x, q!.y - p!.y)).toBeGreaterThan(3);
  });

  test('M9 zoom: the toolbar buttons, + / - keys and the wheel change the MapLibre zoom around the same centre @full', async ({ openGame, sim, page }) => {
    const game = await openGame(GROUND);
    const c0 = await groundCam(sim);
    await page.getByTestId('map-tool-zoom-in').click();
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(c0.zoom + 1, 2);
    let c = await groundCam(sim);
    expect(c.lng).toBeCloseTo(c0.lng, 5);
    expect(c.lat).toBeCloseTo(c0.lat, 5);
    await page.getByTestId('map-tool-zoom-out').click();
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(c0.zoom, 2);
    // keys (the map is not an input, the shell lets + / - through to the view)
    await game.hotkey('=');
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(c0.zoom + 1, 2);
    await game.hotkey('-');
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(c0.zoom, 2);
    // wheel over an empty spot zooms in around the cursor; an aircraft's projected separation from the centre grows
    await sim.spawnAt(readyToTaxi('BAW8', '401'));
    const b = await box(game);
    const p0 = await sim.screenPos('BAW8');
    const empty = await freeSpot(sim, game);
    await page.mouse.move(b.x + empty.x, b.y + empty.y);
    await page.mouse.wheel(0, -400);
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeGreaterThan(c0.zoom + 0.3);
    c = await groundCam(sim);
    const p1 = await sim.screenPos('BAW8');
    if (p0 && p1) expect(Math.hypot(p1.x - empty.x, p1.y - empty.y)).toBeGreaterThan(Math.hypot(p0.x - empty.x, p0.y - empty.y));
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeLessThan(c.zoom - 0.3);
    // the store camera hook pins the view exactly (05 §3.2)
    await sim.setCamera({ lng: c0.lng, lat: c0.lat, zoom: 15 });
    c = await groundCam(sim);
    expect(c.zoom).toBeCloseTo(15, 5);
    expect(c.lng).toBeCloseTo(c0.lng, 6);
  });

  test('presets: auto presets recentre the map and read as pressed; user slots save, recall and persist per position @full', async ({ openGame, sim, page }) => {
    const game = await openGame(GROUND);
    const c0 = await groundCam(sim);
    await page.getByTestId('map-tool-presets').click();
    await expect(page.getByTestId('map-presets-popover')).toBeVisible();
    await expect(page.getByTestId('map-tool-presets')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('preset-auto-overview')).toBeVisible();
    await expect(page.getByTestId('preset-auto-rwy-27L')).toContainText('RWY 27L');
    for (let i = 1; i <= 6; i++) await expect(page.getByTestId(`preset-user-${i}`)).toBeDisabled();       // no slot saved yet

    await page.getByTestId('preset-auto-rwy-27L').click();
    await expect(page.getByTestId('preset-auto-rwy-27L')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(15.4, 1);
    const rwy = await groundCam(sim);
    expect(rwy.lng).toBeGreaterThan(c0.lng);                                  // the 27L threshold is on the east side of the field
    // the 27L threshold is now at the centre of the map
    const thr = await sim.runways();
    expect(thr.find((r) => r.name === '27L')).toBeTruthy();
    // save the camera to slot 1: toast + storage; the slot button arms
    await page.getByTestId('preset-save-1').click();
    await game.waitToast(/Camera saved to slot 1/);
    await expect(page.getByTestId('preset-user-1')).toBeEnabled();
    await expect(page.getByTestId('preset-user-1')).toHaveAttribute('data-filled', 'true');
    const stored = await readLocalStorageJson<Record<string, Array<{ center: [number, number]; zoom: number } | null>>>(page, 'skycontrol_ground_presets');
    expect(stored?.['EGLL:ground']?.[0]?.zoom).toBeCloseTo(15.4, 1);
    expect(stored?.['EGLL:ground']?.[0]?.center[0]).toBeCloseTo(rwy.lng, 4);
    // overview fits the field again (pressed), then the slot recalls the runway camera
    await page.getByTestId('preset-auto-overview').click();
    await expect(page.getByTestId('preset-auto-overview')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(c0.zoom, 1);
    await page.getByTestId('preset-user-1').click();
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(15.4, 1);
    expect((await groundCam(sim)).lng).toBeCloseTo(rwy.lng, 4);
    await expect(page.getByTestId('preset-auto-overview')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('map-presets-close').click();
    await expect(page.getByTestId('map-presets-popover')).toHaveCount(0);

    // the slot survives a reload (per airport + position)
    await page.reload();
    await game.waitReady({ waitMap: true });
    await page.getByTestId('map-tool-presets').click();
    await expect(page.getByTestId('preset-user-1')).toBeEnabled();
    await expect(page.getByTestId('preset-user-2')).toBeDisabled();
    await page.getByTestId('preset-user-1').click();
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(15.4, 1);
    // TOWER has its own slots (empty) and its own auto presets (finals / departures)
    await page.getByTestId('map-presets-close').click();
    await game.setPosition('tower');
    await page.getByTestId('map-tool-presets').click();
    await expect(page.getByTestId('preset-user-1')).toBeDisabled();
    await expect(page.getByTestId('preset-auto-final-27L')).toBeVisible();
    await expect(page.getByTestId('preset-auto-dep-27R')).toBeVisible();
    await expect(page.getByTestId('preset-auto-rwy-27L')).toHaveCount(0);
  });

  test('Shift+1 recalls camera slot 1 from the keyboard as the presets popover advertises @full', async ({ openGame, sim, page }) => {
    test.fixme(true, 'BUG: src/game/GameShell/useShellHotkeys.ts:100 + src/game/hooks/useHotkeys.ts:26-29 — keyChord drops Shift for glyph keys, so Shift+1 reaches the shell as the chord "1" (sim rate 1x, handled + preventDefault) and GroundView/index.tsx:573 never sees it (e.defaultPrevented); on a US layout the browser key is "!" which its /^[1-6]$/ test on e.key rejects as well ; expected Shift+1..6 to recall the saved camera slot (toolbar tooltip "Shift 1-6", slot title "Shift+1") ; actual nothing happens (rate 1x) ; repro: save slot 1, move the camera, press Shift+1');
    const game = await openGame(GROUND);
    await page.getByTestId('map-tool-presets').click();
    await page.getByTestId('preset-auto-rwy-27L').click();
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(15.4, 1);
    await page.getByTestId('preset-save-1').click();
    await game.waitToast(/Camera saved to slot 1/);
    await page.getByTestId('map-presets-close').click();
    const c0 = await groundCam(sim);
    await sim.setCamera({ lng: c0.lng + 0.02, lat: c0.lat, zoom: 13 });
    await game.hotkey('Shift+1');
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(15.4, 1);
    expect((await groundCam(sim)).lng).toBeCloseTo(c0.lng, 4);
  });

  test('Escape closes an open layers / presets popover instead of pausing the game @full', async ({ openGame, page }) => {
    test.fixme(true, 'BUG: src/game/GameShell/useShellHotkeys.ts:76-82 — the shell\'s Escape handler runs before the ground map\'s (GroundView/index.tsx:569-572 only closes its floating chrome when the event is not defaultPrevented): with nothing selected it opens the pause menu, so Escape over an open layers / presets popover pauses the shift and leaves the popover open ; expected Escape to close the popover first (the map\'s own contract) ; actual pause-menu opens, popover stays ; repro: GROUND, click map-tool-layers, press Escape');
    const game = await openGame(GROUND);
    await page.getByTestId('map-tool-layers').click();
    await expect(page.getByTestId('map-layers-popover')).toBeVisible();
    await game.hotkey('Escape');
    await expect(page.getByTestId('map-layers-popover')).toHaveCount(0);
    await expect(game.pauseMenu()).toHaveCount(0);
    expect(await game.isPaused()).toBe(false);
  });

  test('layers popover: overlay toggles persist, the corridor row is TOWER-only, the base-map buttons switch the theme @full', async ({ openGame, page }) => {
    const game = await openGame(GROUND);
    await page.getByTestId('map-tool-layers').click();
    await expect(page.getByTestId('map-layers-popover')).toBeVisible();
    await expect(page.getByTestId('map-tool-layers')).toHaveAttribute('aria-expanded', 'true');
    for (const id of ['layer-labels-taxiway', 'layer-labels-stand', 'layer-holdbars', 'layer-vehicles', 'layer-trails']) await expect(page.getByTestId(id), id).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('layer-corridor')).toHaveCount(0);                                 // tower only
    await expect(page.getByTestId('layer-satellite')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('layer-chart')).toHaveAttribute('aria-pressed', 'false');

    await page.getByTestId('layer-labels-taxiway').click();
    await expect(page.getByTestId('layer-labels-taxiway')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('layer-trails').click();
    await expect(page.getByTestId('layer-trails')).toHaveAttribute('aria-checked', 'false');
    expect(await readLocalStorageJson<Record<string, boolean>>(page, 'skycontrol_ground_layers')).toMatchObject({ taxiwayLabels: false, trails: false, standLabels: true, holdBars: true, vehicles: true });
    await page.getByTestId('layer-chart').click();
    await expect(page.getByTestId('layer-chart')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'chart');
    await expect(page.getByTestId('map-tool-theme')).toHaveAttribute('data-state', 'chart');
    expect((await game.sim.storeSettings()).groundTheme).toBe('chart');
    // the presets button swaps the popover; a second click on it closes it
    await page.getByTestId('map-tool-presets').click();
    await expect(page.getByTestId('map-layers-popover')).toHaveCount(0);
    await expect(page.getByTestId('map-presets-popover')).toBeVisible();
    await page.getByTestId('map-tool-presets').click();
    await expect(page.getByTestId('map-presets-popover')).toHaveCount(0);
    await expect(page.getByTestId('map-tool-presets')).toHaveAttribute('aria-expanded', 'false');

    await game.setPosition('tower');
    await page.getByTestId('map-tool-layers').click();
    await expect(page.getByTestId('layer-corridor')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('layer-labels-taxiway')).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('map-layers-close').click();
    await expect(page.getByTestId('map-layers-popover')).toHaveCount(0);

    await page.reload();
    await game.waitReady({ waitMap: true });
    await page.getByTestId('map-tool-layers').click();
    await expect(page.getByTestId('layer-labels-taxiway')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('layer-trails')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('layer-holdbars')).toHaveAttribute('aria-checked', 'true');
  });

  test('theme toggle: satellite <-> chart swaps the style, the projector and hit-testing keep working, the settings modal mirrors it @full', async ({ openGame, sim, page }) => {
    const game = await openGame(GROUND);
    await sim.spawnAt(readyToTaxi('BAW8', '401'));
    await sim.centerOn('BAW8');
    const before = await stablePos(sim, game, 'BAW8');
    await page.getByTestId('map-tool-theme').click();
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'chart');
    await expect(page.getByTestId('map-tool-theme')).toHaveAttribute('data-state', 'chart');
    expect((await sim.storeSettings()).groundTheme).toBe('chart');
    await expect.poll(() => sim.mapReady()).toBe(true);
    // same camera, same projection: the aircraft is where it was and still clickable
    const after = await stablePos(sim, game, 'BAW8');
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
    await game.groundMap().click({ position: after });
    await expect(game.strip('BAW8')).toHaveAttribute('data-selected', 'true');
    await game.settingsBtn().click();
    await expect(game.settingsModal().getByTestId('set-theme-chart')).toHaveAttribute('aria-pressed', 'true');
    await game.settingsModal().getByTestId('set-theme-satellite').click();
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'satellite');
    await page.getByTestId('set-close').click();
    await expect(page.getByTestId('map-tool-theme')).toHaveAttribute('data-state', 'satellite');
    // the right-click map menu toggles it as well
    const empty = await freeSpot(sim, game);
    await game.groundMap().click({ position: empty, button: 'right' });
    await expect(page.getByTestId('map-context-map')).toBeVisible();
    await expect(page.getByTestId('ctx-map-theme')).toContainText(/Chart theme/);
    await page.getByTestId('ctx-map-theme').click();
    await expect(page.getByTestId('map-context-map')).toHaveCount(0);
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'chart');
    expect((await sim.storeSettings()).groundTheme).toBe('chart');
  });

  test('follow: disabled without a selection, keeps the taxiing aircraft centred, and a drag-pan turns it off with a toast @full', async ({ openGame, sim, page }) => {
    const game = await openGame(GROUND);
    await expect(page.getByTestId('map-tool-follow')).toBeDisabled();
    await expect(page.getByTestId('map-tool-follow')).toHaveAttribute('data-state', 'off');
    await sim.spawnAt(readyToTaxi('DLH2', 'CRP'));
    const r = await sim.command('DLH2 TAXI 27R');
    expect(r.ok).toBe(true);
    await sim.advance(PD);
    await game.selectStrip('DLH2');
    await expect(page.getByTestId('map-tool-follow')).toBeEnabled();
    await page.getByTestId('map-tool-follow').click();
    await expect(page.getByTestId('map-tool-follow')).toHaveAttribute('data-state', 'on');
    await game.waitToast(/Following selected aircraft/);
    const b = await box(game);
    // as the aircraft taxis the camera stays on it: its symbol sits at the map centre
    for (let i = 0; i < 3; i++) {
      await sim.advance(20);
      const a = await sim.aircraftOrFail('DLH2');
      expect(a.speed).toBeGreaterThan(1);
      await expect.poll(async () => { const p = await sim.screenPos('DLH2'); return p ? Math.hypot(p.x - b.width / 2, p.y - b.height / 2) : 1e9; }).toBeLessThan(3);
      const c = await groundCam(sim);
      const ll = await page.evaluate((xy) => {
        const s = (window as unknown as { __atcSim?: { engine?: { proj: { toLngLat(x: number, y: number): { lng: number; lat: number } } } } }).__atcSim;
        return s?.engine ? s.engine.proj.toLngLat(xy.x, xy.y) : null;
      }, a.pos);
      expect(ll!.lng).toBeCloseTo(c.lng, 4);
      expect(ll!.lat).toBeCloseTo(c.lat, 4);
    }
    // the F key toggles it off / on while the map has focus (an empty click deselects but leaves follow armed)
    await game.groundMap().click({ position: await freeSpot(sim, game) });
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await sim.select('DLH2');
    await page.getByTestId('ground-view').focus();
    await page.keyboard.press('f');
    await expect(page.getByTestId('map-tool-follow')).toHaveAttribute('data-state', 'off');
    await page.keyboard.press('f');
    await expect(page.getByTestId('map-tool-follow')).toHaveAttribute('data-state', 'on');
    // a manual drag-pan breaks follow
    const empty = await freeSpot(sim, game);
    await page.mouse.move(b.x + empty.x, b.y + empty.y);
    await page.mouse.down();
    await page.mouse.move(b.x + empty.x + 60, b.y + empty.y + 40, { steps: 6 });
    await page.mouse.move(b.x + empty.x + 120, b.y + empty.y + 80, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId('map-tool-follow')).toHaveAttribute('data-state', 'off');
    await game.waitToast(/Follow off/);
    await sim.advance(20);
    const p = await sim.screenPos('DLH2');
    expect(p ? Math.hypot(p.x - b.width / 2, p.y - b.height / 2) : 1e9).toBeGreaterThan(10);
  });

  test('edge arrow: a selected aircraft outside the view shows the arrow; clicking it centres the map on it @full', async ({ openGame, sim, page }) => {
    test.fixme(true, 'BUG: src/components/atc/GroundView/render.ts:604-605 — the off-screen edge arrow is clamped 28 px inside the FULL map canvas (cam.w / cam.h), but the strip bay (left) and the command panel (right) float over the map, so an arrow pointing east / west lands under the panel / bay and cannot be clicked (Playwright: "<aside data-testid=detail-panel> intercepts pointer events") ; expected the arrow to be clamped to the uncovered map area ; actual it is hidden behind the chrome ; repro: select a taxiing aircraft, fly to the RWY 09L preset, click map-edge-arrow');
    const game = await openGame(GROUND);
    await sim.spawnAt(readyToTaxi('BAW8', '401'));
    await game.selectStrip('BAW8');
    await sim.centerOn('BAW8');
    await stablePos(sim, game, 'BAW8');
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('data-open', 'false');
    // pan far away (the 27L threshold preset) -> the aircraft leaves the view
    await page.getByTestId('map-tool-presets').click();
    await page.getByTestId('preset-auto-rwy-09L').click();
    await page.getByTestId('map-presets-close').click();
    const b = await box(game);
    await expect.poll(async () => inside(await sim.screenPos('BAW8'), b)).toBe(false);
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('aria-label', 'Pan to BAW8');
    await page.getByTestId('map-edge-arrow').click();
    await expect.poll(async () => { const p = await sim.screenPos('BAW8'); return p ? Math.hypot(p.x - b.width / 2, p.y - b.height / 2) : 1e9; }).toBeLessThan(3);
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('data-open', 'false');
  });

  test('locate: the panel button and centerOn bring a selected aircraft back into view; the edge arrow reports it while off-view @full', async ({ openGame, sim, page }) => {
    const game = await openGame(GROUND);
    await sim.spawnAt(readyToTaxi('BAW8', '401'));
    await game.selectStrip('BAW8');
    await sim.centerOn('BAW8');
    await stablePos(sim, game, 'BAW8');
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('data-open', 'false');
    const b = await box(game);
    await sim.setCamera({ x: 0, y: 0, zoom: 16 });                                 // the field centre, far from T4
    await expect.poll(async () => inside(await sim.screenPos('BAW8'), b)).toBe(false);
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('aria-label', 'Pan to BAW8');
    await page.getByTestId('panel-locate').click();
    await expect.poll(async () => { const p = await sim.screenPos('BAW8'); return p ? Math.hypot(p.x - b.width / 2, p.y - b.height / 2) : 1e9; }).toBeLessThan(3);
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('data-open', 'false');
    await sim.setCamera({ x: 0, y: 0, zoom: 16 });
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('data-open', 'true');
    await sim.centerOn('BAW8');
    await expect.poll(async () => inside(await sim.screenPos('BAW8'), b)).toBe(true);
    await expect(page.getByTestId('map-edge-arrow')).toHaveAttribute('data-open', 'false');
  });

  test('right-click menus: the aircraft menu lists the enabled actions and opens the stepper; the map menu centres and toggles the rings @full', async ({ openGame, sim, page }) => {
    const game = await openGame(GROUND);
    await sim.spawnAt(readyToTaxi('BAW8', '401'));
    await sim.centerOn('BAW8');
    const p = await stablePos(sim, game, 'BAW8');
    await game.groundMap().click({ position: p, button: 'right' });
    await expect(page.getByTestId('map-context-aircraft')).toBeVisible();
    // the menu selects the aircraft and mirrors the tree: every row is an enabled action of the panel
    await expect(game.strip('BAW8')).toHaveAttribute('data-selected', 'true');
    const enabled = (await sim.actions('BAW8')).filter((r) => r.state === 'enabled').map((r) => r.id);
    const rows = await page.locator('[data-testid^="ctx-aircraft-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
    for (const id of rows.filter((r) => r !== 'ctx-aircraft-more' && r !== 'ctx-aircraft-follow')) expect(enabled, id).toContain(id.replace(/^ctx-aircraft-/, 'action-'));
    expect(rows).toContain('ctx-aircraft-taxi-runway');
    expect(rows).toContain('ctx-aircraft-follow');
    await page.getByTestId('ctx-aircraft-taxi-runway').click();
    await expect(page.getByTestId('map-context-aircraft')).toHaveCount(0);
    await expect(game.stepperFor('action-taxi-runway')).toBeVisible();
    await expect(game.panel()).toHaveAttribute('data-draft', 'action-taxi-runway');
    await game.cancel();
    // "Follow on map" from the menu arms follow
    await game.groundMap().click({ position: p, button: 'right' });
    await page.getByTestId('ctx-aircraft-follow').click();
    await expect(page.getByTestId('map-tool-follow')).toHaveAttribute('data-state', 'on');
    await page.getByTestId('map-tool-follow').click();
    await expect(page.getByTestId('map-tool-follow')).toHaveAttribute('data-state', 'off');

    // map menu: rings off (settings), a click elsewhere closes, "Centre here" moves the camera to the clicked point
    const empty = await freeSpot(sim, game);
    await game.groundMap().click({ position: empty, button: 'right' });
    await expect(page.getByTestId('map-context-map')).toBeVisible();
    await expect(page.getByTestId('ctx-map-rings')).toContainText(/Hide range rings/);
    await page.getByTestId('ctx-map-rings').click();
    await expect(page.getByTestId('map-tool-rings')).toHaveAttribute('data-state', 'off');
    expect((await sim.storeSettings()).showRings).toBe(false);
    await game.groundMap().click({ position: await freeSpot(sim, game), button: 'right' });
    await expect(page.getByTestId('ctx-map-rings')).toContainText(/Show range rings/);
    await page.getByTestId('map-toolbar').click({ position: { x: 2, y: 2 } });     // a pointer-down outside closes it
    await expect(page.getByTestId('map-context-map')).toHaveCount(0);
    const c0 = await groundCam(sim);
    const b = await box(game);
    const corner = { x: Math.round(b.width * 0.35), y: Math.round(b.height * 0.7) };
    await game.groundMap().click({ position: corner, button: 'right' });
    await expect(page.getByTestId('map-context-map')).toBeVisible();
    await page.getByTestId('ctx-map-centre').click();
    await expect.poll(async () => { const c = await groundCam(sim); return Math.abs(c.lng - c0.lng) > 1e-4 || Math.abs(c.lat - c0.lat) > 1e-4; }).toBe(true);
    // the map that was under the corner is now under the centre: an aircraft's projected position shifted by the same vector
    const q = await sim.screenPos('BAW8');
    expect(q).not.toBeNull();
    expect(q!.x - p.x).toBeCloseTo(b.width / 2 - corner.x, -1);
    expect(q!.y - p.y).toBeCloseTo(b.height / 2 - corner.y, -1);
  });

  test('positions: GROUND and TOWER keep their own camera on the shared map; APPROACH shows the radar and back @full', async ({ openGame, sim, page }) => {
    const game = await openGame(GROUND);
    const overview = await groundCam(sim);
    await page.getByTestId('map-tool-zoom-in').click();
    await page.getByTestId('map-tool-zoom-in').click();
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(overview.zoom + 2, 2);
    const groundZoomed = await groundCam(sim);

    await game.setPosition('tower');
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-position', 'tower');
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(overview.zoom, 1);       // first visit: overview fit
    await page.getByTestId('map-tool-zoom-out').click();
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(overview.zoom - 1, 2);
    const towerCam = await groundCam(sim);

    await game.setPosition('ground');
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(groundZoomed.zoom, 2);   // restored
    await game.setPosition('tower');
    await expect.poll(async () => (await groundCam(sim)).zoom).toBeCloseTo(towerCam.zoom, 2);

    await game.setPosition('approach');
    await expect(game.view('radar')).toBeVisible();
    await expect(game.view('ground')).toHaveCount(0);
    const radar = new RadarPage(page, game);
    await radar.waitReady();
    expect((await radar.camera()).zoom).toBeGreaterThan(1);
    await expect(page.getByTestId('radar-toolbar')).toBeVisible();
    await expect(page.getByTestId('map-toolbar')).toHaveCount(0);
    await game.setPosition('ground');
    await sim.waitMapReady();
    await expect(page.getByTestId('map-toolbar')).toBeVisible();
    await expect(page.getByTestId('radar-toolbar')).toHaveCount(0);
    expect('lng' in (await sim.camera())).toBe(true);
  });
});

test.describe('radar chrome shared with the map', () => {
  test('radar follow tracks the selected arrival, rings share the setting with the ground map, centre returns to the field @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    const radar = new RadarPage(page, game);
    await radar.waitReady();
    await sim.spawnAt(inbound('UAL9'));
    const field = await radar.settle();
    // no selection: the button explains instead of arming
    await radar.followBtn().click();
    await game.waitToast(/Select an aircraft to follow/);
    await expect(radar.followBtn()).toHaveAttribute('data-state', 'off');
    await expect(page.getByTestId('radar-tool-rings-centre-selected')).toBeDisabled();

    await radar.clickAircraft('UAL9');
    await expect(game.panelCallsign()).toHaveText('UAL9');
    await expect(page.getByTestId('radar-tool-rings-centre-selected')).toBeEnabled();
    await radar.followBtn().click();
    await expect(radar.followBtn()).toHaveAttribute('data-state', 'on');
    expect(await radar.pressedRange()).toBeNull();
    for (let i = 0; i < 2; i++) {
      await sim.advance(30);
      const a = await sim.aircraftOrFail('UAL9');
      await expect.poll(async () => { const c = await radar.camera(); return Math.hypot(c.x - a.pos.x, c.y - a.pos.y); }).toBeLessThan(200);
      const p = await sim.screenPos('UAL9');
      const b = await radar.box();
      expect(p!.x).toBeCloseTo(b.width / 2, -1);
      expect(p!.y).toBeCloseTo(b.height / 2, -1);
    }
    // rings centred on the selected aircraft; the rings toggle is the shared showRings setting
    await page.getByTestId('radar-tool-rings-centre-selected').click();
    await expect(page.getByTestId('radar-tool-rings-centre-selected')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('radar-tool-rings-centre-field')).toHaveAttribute('aria-pressed', 'false');
    await expect(radar.ringsBtn()).toHaveAttribute('data-state', 'on');
    await radar.ringsBtn().click();
    await expect(radar.ringsBtn()).toHaveAttribute('data-state', 'off');
    expect((await sim.storeSettings()).showRings).toBe(false);
    // deselecting drops follow; centre-on-field brings the scope back to the airport
    await radar.clickEmpty();
    await expect(radar.followBtn()).toHaveAttribute('data-state', 'off');
    await radar.centreBtn().click();
    const back = await radar.settle();
    expect(Math.hypot(back.x - field.x, back.y - field.y)).toBeLessThan(100);
    await game.setPosition('ground');
    await sim.waitMapReady();
    await expect(page.getByTestId('map-tool-rings')).toHaveAttribute('data-state', 'off');
  });

  test('radar zoom buttons scale the scope around its centre and release the range preset @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    const radar = new RadarPage(page, game);
    await radar.waitReady();
    await sim.spawnAt(inbound('UAL9'));
    await sim.spawnAt(inbound('DLH4', { posRel: { fromRunway: '27L', alongNM: -12, offsetNM: 3, altFt: 6000 } }));
    const c0 = await radar.settle();
    expect(await radar.pressedRange()).toBe('30');
    const p0 = await sim.screenPos('UAL9');
    const q0 = await sim.screenPos('DLH4');
    const sep0 = Math.hypot(p0!.x - q0!.x, p0!.y - q0!.y);
    await radar.zoomInBtn().click();
    await expect.poll(async () => (await radar.camera()).zoom).toBeCloseTo(c0.zoom * 1.25, 1);
    const c1 = await radar.settle();
    expect(c1.x).toBeCloseTo(c0.x, -1);
    expect(c1.y).toBeCloseTo(c0.y, -1);
    expect(await radar.pressedRange()).toBeNull();
    expect(await radar.rangeNM()).toBeLessThan(Math.round(Math.min((await radar.box()).width, (await radar.box()).height) / 2 / c0.zoom));
    const p1 = await sim.screenPos('UAL9');
    const q1 = await sim.screenPos('DLH4');
    expect(Math.hypot(p1!.x - q1!.x, p1!.y - q1!.y) / sep0).toBeCloseTo(1.25, 1);
    await radar.zoomOutBtn().click();
    await expect.poll(async () => (await radar.camera()).zoom).toBeCloseTo(c0.zoom, 1);
    // the 30 preset is a click away and restores the exact zoom
    const r30 = await radar.setRange('30');
    expect(r30.zoom).toBeCloseTo(c0.zoom, 3);
  });
});

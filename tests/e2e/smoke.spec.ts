/*
  @smoke — the fast confidence subset (05-TEST-STRATEGY §6.2, harness self-tests §4.14):
    1. home -> EGLL -> configure ends -> START -> /play boots in test mode with the home config
    2. the three positions render (ground map WebGL on GROUND / TOWER, radar canvas on APPROACH)
    3. selecting a strip opens the command panel with actions
    4. a typed command is accepted, echoed as an ATC line and read back after the pilot delay
    5. advance 60 sim-seconds with traffic: no console errors, deterministic clock, no RAF drift

  Run: `bash scripts/e2e.sh smoke`  (or `npm run test:e2e:smoke`)
*/
import { test, expect } from './fixtures/test';

test.describe('smoke', () => {
  test('home -> EGLL -> START boots /play in test mode with the home config @smoke', async ({ home, game, sim }) => {
    await home.goto({ testMode: { seed: 7, spawn: 'default' } });
    await expect(home.airportCards()).toHaveCount(6);
    await home.pickAirport('EGLL');
    await expect(home.detailTitle()).toContainText('Heathrow');

    // westerlies only: 09L / 09R off, keep 27L / 27R
    await home.toggleEnd('09L', false);
    await home.toggleEnd('09R', false);
    expect((await home.activeEnds()).sort()).toEqual(['27L', '27R']);
    await home.toggleWeight('27R', 'S', false);
    await expect(home.startHint()).toContainText('EGLL');

    await home.start();
    await game.waitReady();

    // test mode: __atcTest installed, engine ready, sim clock does not move on its own
    expect(await sim.ready()).toBe(true);
    const t0 = await sim.time();
    await game.page.waitForTimeout(400);
    expect(await sim.time()).toBe(t0);

    // the home config reached the engine
    const rws = await sim.runways();
    const active = rws.filter((r) => r.active).map((r) => r.name).sort();
    expect(active).toEqual(['27L', '27R']);
    expect(rws.find((r) => r.name === '27R')?.weights).toEqual(['L', 'M', 'H']);
    await expect(game.airportBadge()).toHaveText('EGLL');

    // one-shot config consumed; default spawn seeded 4 departures + 3 arrivals
    expect(await game.page.evaluate(() => localStorage.getItem('skycontrol_start_config'))).toBeNull();
    const snap = await sim.snapshot();
    expect(snap.icao).toBe('EGLL');
    expect(snap.stats.total).toBe(7);
    expect(snap.stats.dep).toBe(4);
    expect(snap.stats.arr).toBe(3);
    await expect(game.radioLines('SYS').first()).toContainText(/test mode · seed 7/);
  });

  test('three positions render: ground map, tower map, approach radar @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    expect(await game.position()).toBe('tower');
    await expect(game.view('ground')).toBeVisible();
    await expect(game.groundMap()).toBeVisible();
    await expect(game.groundOverlay()).toBeVisible();

    // WebGL probe: MapLibre must reach 'load' under swiftshader
    await sim.waitMapReady();
    expect(await game.page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))).toBe(true);
    await expect(game.page.locator('.maplibregl-canvas')).toHaveCount(1);

    await game.setPosition('ground');
    await expect(game.groundMap()).toBeVisible();
    await expect(game.modeTab('ground')).toHaveAttribute('aria-pressed', 'true');

    await game.setPosition('approach');
    await expect(game.radarCanvas()).toBeVisible();
    await expect(game.view('ground')).toHaveCount(0);
    const box = await game.radarCanvas().boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(400);
    expect(box?.height ?? 0).toBeGreaterThan(300);

    // keyboard: F2 -> tower, back on the ground map
    await game.hotkey('F2');
    await expect(game.shell()).toHaveAttribute('data-mode', 'tower');
    await expect(game.groundMap()).toBeVisible();
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
  });

  test('selecting a strip opens the command panel @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'default', position: 'ground' });
    const snap = await sim.snapshot();
    const dep = snap.aircraft.find((a) => a.plan.kind === 'departure' && a.phase === 'parked');
    expect(dep, 'a parked departure from the seeded boot').toBeTruthy();
    const cs = dep!.callsign;

    await expect(game.strip(cs)).toBeVisible();
    await expect(game.strip(cs)).toHaveAttribute('data-kind', 'departure');
    await expect(game.strip(cs)).toHaveAttribute('data-selected', 'false');
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');

    await game.openPanelFor(cs);
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'true');
    await expect(game.panelKind()).toHaveAttribute('data-kind', 'departure');
    await expect(game.panelStage()).toHaveAttribute('data-stage', await sim.stage(cs) ?? '');
    await expect(game.panelActions()).toBeVisible();
    const rows = await sim.actions(cs);
    for (const r of rows.slice(0, 3)) {
      await expect(game.actionBtn(r.id)).toHaveAttribute('data-state', r.state);
    }
    expect((await sim.snapshot()).selectedId).toBe(dep!.id);
    expect((await sim.aircraftOrFail(cs)).underControl).toBe(true);

    await game.closePanel();
    await expect(game.strip(cs)).toHaveAttribute('data-selected', 'false');
    expect((await sim.snapshot()).selectedId).toBeNull();
  });

  test('typed command is accepted, echoed and read back @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt({ callsign: 'UAL9', type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250 });
    await expect(game.strip('UAL9')).toBeVisible();

    const atc = await game.sendOk('UAL9 HEADING 180');
    expect(atc.who).toBe('ATC');
    expect(atc.callsign).toBe('UAL9');
    expect(atc.text.toLowerCase()).toMatch(/heading|one eight zero/);
    await expect(game.cmdInput()).toHaveValue('');

    // before the pilot delay the command is pending; after it the heading target is set
    const before = await sim.aircraftOrFail('UAL9');
    expect(before.pendingCmds.length).toBeGreaterThan(0);
    await sim.advance(3.5);
    const after = await sim.aircraftOrFail('UAL9');
    expect(after.pendingCmds.length).toBe(0);
    expect(after.navMode).toBe('heading');
    const tgt = ((after.targetHeading % 360) + 360) % 360;
    expect(Math.min(Math.abs(tgt - 180), 360 - Math.abs(tgt - 180))).toBeLessThanOrEqual(3);
    const rb = await game.waitRadio(/one eight zero|180/i, { who: 'PILOT', callsign: 'UAL9' });
    expect(rb.text).toMatch(/UAL9|United/i);

    // an unparseable line is rejected with a SYS reason and never reaches the engine
    const bad = await game.send('ZZZ999 HEADING 180');
    expect(bad.accepted).toBe(false);
    expect(bad.error).toMatch(/ZZZ999|no aircraft|not found|unknown/i);
  });

  test('advance 60 sim-seconds with traffic: no errors, deterministic clock @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'default', position: 'tower' });
    const t0 = await sim.time();
    const events = await sim.advance(60);
    const t1 = await sim.time();
    expect(t1 - t0).toBeCloseTo(60, 1);
    expect(Array.isArray(events)).toBe(true);
    expect((await sim.snapshot()).stats.total).toBeGreaterThan(0);

    // pause is real: no time passes while paused
    await game.togglePause();
    await expect(game.pausedPill()).toBeVisible();
    await sim.advance(10);
    expect(await sim.time()).toBeCloseTo(t1, 1);
    await game.togglePause();
    await sim.advance(1);
    expect(await sim.time()).toBeCloseTo(t1 + 1, 1);

    // the clock chip renders and the strips still reflect the engine
    await expect(game.clock()).toHaveText(/^\d\d:\d\d:\d\dZ$/);
    const snap = await sim.snapshot();
    await game.setPosition('ground');
    for (const a of snap.aircraft.filter((x) => x.phase === 'parked').slice(0, 2)) {
      await expect(game.strip(a.callsign)).toHaveAttribute('data-phase', 'parked');
    }
  });
});

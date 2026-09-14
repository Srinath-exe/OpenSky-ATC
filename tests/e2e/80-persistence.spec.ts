/*
  Persistence — 05-TEST-STRATEGY §4.8 P1-P5 adapted to the shipped storage layer:
    src/components/atc/persist.ts   (skycontrol_settings / high_score / start_config / session_history / onboarding_seen)
    src/app/_lib/persist.ts         (skycontrol_prefs + the legacy tts / autotower / ground_theme mirrors)
    src/game/persist.ts             (shell prefs: hotkey badges, log filter, command history ...)
    src/components/atc/simStore.ts  (load / restart / recordSession / persistHighScore / updateSettings)

  Every scenario asserts BOTH the storage + store + engine truth (`sim.storeSettings()`, `sim.engineSettings()`,
  `sim.storeState()`, `readLocalStorage*`) AND what the user sees after a full reload (the in-game settings modal,
  the nav HI chip, the map theme, the home / settings pages). The /settings page's own round-trips live in
  20-settings.spec.ts; the home page's real START flow in 10-home.spec.ts — this file covers the game-side paths
  (in-game modal, map toolbar, high score writes, one-shot config by storage, restart records, corrupt storage).
*/
import { test, expect, LS_KEYS, readLocalStorage, readLocalStorageJson, seedLocalStorage, writeLocalStorage, GamePage } from './fixtures/test';
import type { GameGotoOptions } from './pages/GamePage';
import type { SettingsSeed } from './fixtures/storage';
import type { Settings } from '@/components/atc/simStore';
import type { SessionRecord } from '@/components/atc/persist';

/** src/components/atc/simStore.ts DEFAULT_SETTINGS. */
const DEFAULTS: Settings = {
  autoTower: false, autoGround: false, autoApproach: false, autoMode: false, autoHandoff: true, strictFrequencies: false, emergencyRate: 'normal',
  groundTheme: 'satellite', showRings: true, difficulty: 'normal', sound: true, tts: false, volume: 0.8,
  pilotDelayS: null, readbackErrors: true, region: 'auto', instantVectors: false, typedInstant: true,
};
const TOWER = { icao: 'EGLL', spawn: 'none', position: 'tower' } as const;
const GROUND = { icao: 'EGLL', spawn: 'none', position: 'ground' } as const;
/** Shell-side keys (src/game/persist.ts, GroundView bridge / presets, StripBay). */
const SHELL_KEYS = ['skycontrol_panels', 'skycontrol_allow_narrow', 'skycontrol_hotkey_badges', 'skycontrol_log_filter', 'skycontrol_cmd_history', 'skycontrol_ground_layers', 'skycontrol_ground_presets', 'skycontrol_filters_ground', 'skycontrol_filters_tower', 'skycontrol_filters_approach'];

/**
 * Boot the game WITHOUT `page.addInitScript` seeding: init scripts re-run on every reload and would overwrite the
 * very values a reload test wants to read back. Opens `/` once so the origin's storage exists, writes the seeds
 * (defaults: sound / tts / autoTower / autoGround off, onboarding seen) and then opens /play deterministically.
 */
async function bootGame(game: GamePage, o: GameGotoOptions, settings: SettingsSeed = {}, extra: Record<string, string> = {}): Promise<void> {
  await game.page.goto('/');
  await expect(game.page.getByTestId('page-home')).toHaveAttribute('data-ready', 'true');
  await writeLocalStorage(game.page, LS_KEYS.settings, JSON.stringify({ autoTower: false, autoGround: false, tts: false, sound: false, ...settings }));
  await writeLocalStorage(game.page, LS_KEYS.onboardingSeen, '1');
  for (const [k, v] of Object.entries(extra)) await writeLocalStorage(game.page, k, v);
  await game.goto({ seed: 7, ...o });
}
/** Reload the current /play URL (same deterministic config, new store singleton) and wait for the engine. */
async function reloadGame(game: GamePage): Promise<void> {
  await game.page.reload();
  await game.waitReady();
}
/** Open the in-game settings modal (no-op when open). */
async function openModal(game: GamePage): Promise<void> {
  if (!(await game.settingsModal().count())) await game.settingsBtn().click();
  await expect(game.settingsModal()).toBeVisible();
}
async function closeModal(game: GamePage): Promise<void> {
  await game.page.getByTestId('set-close').click();
  await expect(game.settingsModal()).toHaveCount(0);
}
/** aria-checked of a modal switch (the modal's Mirror puts data-state on a wrapper span). */
async function modalChecked(game: GamePage, id: string): Promise<boolean> {
  return (await game.settingsModal().getByTestId(id).getAttribute('aria-checked')) === 'true';
}
async function setModalToggle(game: GamePage, id: string, on: boolean): Promise<void> {
  const el = game.settingsModal().getByTestId(id);
  if ((await el.getAttribute('aria-checked')) === String(on)) return;
  await el.click();
  await expect(el).toHaveAttribute('aria-checked', String(on));
}
/** Pick an option in a modal Select by label. */
async function pickModalSelect(game: GamePage, id: string, label: RegExp): Promise<void> {
  const trigger = game.settingsModal().getByTestId(id);
  await trigger.click();
  const menu = game.page.getByTestId(`${id}-menu`);
  await expect(menu).toBeVisible();
  await menu.getByRole('option', { name: label }).first().click();
  await expect(menu).toHaveCount(0);
}

test.describe('high score', () => {
  test('P1 a score is written after one sim-second, shown as HI, survives a reload and is never lowered @smoke', async ({ game, sim, page, browserConsole }) => {
    // the HI chip hydration mismatch on a hard load with a stored best is a known product defect (see the fixme below);
    // tolerated here so the persistence contract itself stays executable
    browserConsole.allow(/Hydration failed because the server rendered HTML didn't match the client/);
    await bootGame(game, TOWER);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBeNull();
    await expect(game.scoreHi()).toHaveCount(0);
    await sim.setScore(77);
    await sim.advance(1.1);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('77');
    expect((await sim.storeState()).highScore).toBe(77);
    await expect(game.score()).toHaveAttribute('data-value', '77');
    await expect(game.scoreHi()).toHaveText('HI 77');

    // a full reload rebuilds the engine (score 0) but the best stays
    await reloadGame(game);
    expect((await sim.snapshot()).score).toBe(0);
    expect((await sim.storeState()).highScore).toBe(77);
    await expect(game.score()).toHaveAttribute('data-value', '0');
    await expect(game.scoreHi()).toHaveText('HI 77');
    // P2: a lower session score never lowers it; a higher one raises it
    await sim.setScore(5);
    await sim.advance(1.1);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('77');
    await expect(game.scoreHi()).toHaveText('HI 77');
    await sim.setScore(120);
    await sim.advance(1.1);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('120');
    await expect(game.scoreHi()).toHaveText('HI 120');
    // the home page pill and the settings page read the same value
    await page.goto('/');
    await expect(page.getByTestId('page-home')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('home-highscore')).toContainText('120');
    await page.goto('/settings');
    await expect(page.getByTestId('page-settings')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('set-highscore')).toHaveAttribute('data-value', '120');
  });

  test('a stored best renders the HI chip on a hard load of /play without a hydration error @full', async ({ game, sim }) => {
    await bootGame(game, TOWER, {}, { [LS_KEYS.highScore]: '120' });
    await expect(game.scoreHi()).toHaveText('HI 120');
    expect((await sim.storeState()).highScore).toBe(120);
    // the console collector fails the test on the hydration pageerror
  });

  test('P2 a stored best above the session is kept; reset on /settings clears the HI chip of the running shift @full', async ({ game, sim, page, browserConsole }) => {
    browserConsole.allow(/Hydration failed because the server rendered HTML didn't match the client/);   // see the fixme above
    await bootGame(game, TOWER, {}, { [LS_KEYS.highScore]: '500' });
    expect((await sim.storeState()).highScore).toBe(500);
    await expect(game.scoreHi()).toHaveText('HI 500');
    await sim.setScore(50);
    await sim.advance(1.1);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('500');
    await expect(game.scoreHi()).toHaveText('HI 500');

    // reset from the full settings page (client-side navigation keeps the singleton)
    await openModal(game);
    await page.getByTestId('set-open-full').click();
    await expect(page.getByTestId('page-settings')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('set-highscore')).toHaveAttribute('data-value', '500');
    await page.getByTestId('set-reset-score').click();
    await expect(page.getByTestId('set-highscore')).toHaveAttribute('data-value', '0');
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('0');
    await page.getByTestId('set-resume').click();
    await page.waitForURL(/\/play(\?.*)?$/);
    await game.waitReady();
    expect((await sim.storeState()).highScore).toBe(0);
    await expect(game.scoreHi()).toHaveCount(0);
    // the running session's score becomes the new best on the next scored second
    await sim.advance(1.1);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('50');
    await expect(game.scoreHi()).toHaveText('HI 50');
  });
});

test.describe('settings round-trip through the game', () => {
  test('P3 in-game settings modal: every control persists and comes back after a reload of /play @full', async ({ game, sim, page, browserConsole }) => {
    // with pilot voice ON in storage the TX indicator (data-voice) hydrates differently from the SSR HTML — same store
    // snapshot defect as the HI chip fixme above; tolerated so the round-trip stays executable
    browserConsole.allow(/A tree hydrated but some attributes of the server rendered HTML didn't match/);
    await bootGame(game, TOWER);
    await openModal(game);
    // toggles (the modal exposes these; AI tower / ground assist live on /settings only)
    await setModalToggle(game, 'set-sound', true);
    await setModalToggle(game, 'set-tts', true);
    await setModalToggle(game, 'set-strict-frequencies', true);
    await setModalToggle(game, 'set-readback-errors', false);
    await setModalToggle(game, 'set-auto-handoff', false);
    await setModalToggle(game, 'set-instant-vectors', true);
    await setModalToggle(game, 'set-typed-instant', false);
    await setModalToggle(game, 'set-show-rings', false);
    await setModalToggle(game, 'set-hotkey-badges', false);
    await expect(page.locator('html')).toHaveAttribute('data-hotkey-badges', 'off');
    // selects, theme pills, master volume
    await pickModalSelect(game, 'set-pilot-delay', /^4 s/);
    await pickModalSelect(game, 'set-emergency-rate', /^Off/);
    await pickModalSelect(game, 'set-phraseology', /^FAA/);
    await game.settingsModal().getByTestId('set-theme-chart').click();
    await expect(game.settingsModal().getByTestId('set-theme-chart')).toHaveAttribute('aria-pressed', 'true');
    await game.settingsModal().getByTestId('set-volume-master').fill('35');
    await expect(game.settingsModal().getByTestId('set-volume-value')).toHaveAttribute('data-value', '35');

    const want: Partial<Settings> = { sound: true, tts: true, strictFrequencies: true, readbackErrors: false, autoHandoff: false, instantVectors: true, typedInstant: false, showRings: false, pilotDelayS: 4, emergencyRate: 'off', region: 'FAA', groundTheme: 'chart' };
    expect(await sim.storeSettings()).toMatchObject(want);
    expect((await sim.storeSettings()).volume).toBeCloseTo(0.35, 5);
    const blob = await readLocalStorageJson<Settings>(page, LS_KEYS.settings);
    expect(blob).toMatchObject(want);
    expect(await readLocalStorage(page, LS_KEYS.tts)).toBe('1');
    expect(await readLocalStorage(page, LS_KEYS.groundTheme)).toBe('chart');
    expect(await readLocalStorageJson<boolean>(page, 'skycontrol_hotkey_badges')).toBe(false);
    let eng = await sim.engineSettings();
    expect(eng.strictFrequencies).toBe(true);
    expect(eng.autoHandoff).toBe(false);
    expect(eng.region).toBe('FAA');
    expect(eng.pilotDelayOverride).toBe(4);
    await closeModal(game);
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'chart');

    // reload: a new store singleton reads the blob back; the modal, the map and the engine all agree
    await reloadGame(game);
    expect(await sim.storeSettings()).toMatchObject(want);
    eng = await sim.engineSettings();
    expect(eng.strictFrequencies).toBe(true);
    expect(eng.autoHandoff).toBe(false);
    expect(eng.region).toBe('FAA');
    expect(eng.pilotDelayOverride).toBe(4);
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'chart');
    await expect(page.getByTestId('map-tool-rings')).toHaveAttribute('data-state', 'off');
    await openModal(game);
    for (const [id, on] of [['set-sound', true], ['set-tts', true], ['set-strict-frequencies', true], ['set-readback-errors', false], ['set-auto-handoff', false], ['set-instant-vectors', true], ['set-typed-instant', false], ['set-show-rings', false], ['set-hotkey-badges', false]] as const) {
      expect(await modalChecked(game, id), id).toBe(on);
    }
    await expect(page.locator('html')).toHaveAttribute('data-hotkey-badges', 'off');
    expect(await game.settingsModal().getByTestId('set-pilot-delay').textContent()).toContain('4 s');
    expect(await game.settingsModal().getByTestId('set-emergency-rate').textContent()).toContain('Off');
    expect(await game.settingsModal().getByTestId('set-phraseology').textContent()).toContain('FAA');
    await expect(game.settingsModal().getByTestId('set-theme-chart')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.settingsModal().getByTestId('set-volume-value')).toHaveAttribute('data-value', '35');
    // typed commands now go through the review step (typedInstant off) — the setting is live, not just displayed
    await closeModal(game);
    await sim.spawnAt({ callsign: 'BAW7', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '27R', plan: { runway: '27R' } });
    await game.cmdInput().fill('BAW7 WIND CHECK');
    await game.cmdInput().press('Enter');
    await expect(game.cmdReview()).toBeVisible();
    await expect(game.cmdInput()).toHaveValue('BAW7 WIND CHECK');
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(0);
  });

  test('P4 settings seeded in storage are applied to the engine at boot and mirrored by the modal @full', async ({ openGame, sim }) => {
    const game = await openGame({ ...TOWER, settings: { autoTower: true, autoGround: true, autoHandoff: false, strictFrequencies: true, region: 'ICAO', pilotDelayS: 2, instantVectors: true, showRings: false, difficulty: 'high', volume: 0.1 } });
    const store = await sim.storeSettings();
    expect(store).toMatchObject({ autoTower: true, autoGround: true, autoHandoff: false, strictFrequencies: true, region: 'ICAO', pilotDelayS: 2, instantVectors: true, showRings: false, difficulty: 'high', volume: 0.1, tts: false, sound: false });
    const eng = await sim.engineSettings();
    expect(eng.autoTower).toBe(true);
    expect(eng.autoGround).toBe(true);
    expect(eng.autoHandoff).toBe(false);
    expect(eng.strictFrequencies).toBe(true);
    expect(eng.region).toBe('ICAO');
    expect(eng.pilotDelayOverride).toBe(2);
    expect((await sim.storeState()).settings.difficulty).toBe('high');
    await openModal(game);
    expect(await modalChecked(game, 'set-strict-frequencies')).toBe(true);
    expect(await modalChecked(game, 'set-auto-handoff')).toBe(false);
    expect(await modalChecked(game, 'set-instant-vectors')).toBe(true);
    expect(await modalChecked(game, 'set-show-rings')).toBe(false);
    expect(await modalChecked(game, 'set-sound')).toBe(false);
    await expect(game.settingsModal().getByTestId('set-volume-master')).toBeDisabled();       // muted: the slider is off
    await expect(game.settingsModal().getByTestId('set-volume-value')).toHaveAttribute('data-value', '10');
    expect(await game.settingsModal().getByTestId('set-pilot-delay').textContent()).toContain('2 s');
    expect(await game.settingsModal().getByTestId('set-phraseology').textContent()).toContain('ICAO');
    await closeModal(game);
    // the 2 s pilot delay is live: a command is executed before the default 3 s would have elapsed
    await sim.spawnAt({ callsign: 'UAL9', type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250, plan: { runway: '27L' }, onFrequency: 'tower' });
    const r = await sim.command('UAL9 HEADING 180');
    expect(r.ok).toBe(true);
    await sim.advance(2.2);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toHaveLength(0);
    expect((await sim.aircraftOrFail('UAL9')).targetHeading).toBeCloseTo(180, -1);
  });

  test('P3 map toolbar: chart theme and rings off persist to the settings blob and survive a reload on every view @full', async ({ game, sim, page }) => {
    await bootGame(game, { ...GROUND, waitMap: true });
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'satellite');
    await expect(page.getByTestId('map-tool-theme')).toHaveAttribute('data-state', 'satellite');
    await expect(page.getByTestId('map-tool-rings')).toHaveAttribute('data-state', 'on');
    await page.getByTestId('map-tool-theme').click();
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'chart');
    await page.getByTestId('map-tool-rings').click();
    await expect(page.getByTestId('map-tool-rings')).toHaveAttribute('data-state', 'off');
    expect(await sim.storeSettings()).toMatchObject({ groundTheme: 'chart', showRings: false });
    expect(await readLocalStorageJson<Settings>(page, LS_KEYS.settings)).toMatchObject({ groundTheme: 'chart', showRings: false });
    // (the map toolbar writes through the store, which owns the blob; the legacy `skycontrol_ground_theme` mirror is only
    //  kept by the /settings + home pages — nothing reads it, so it is not asserted here)
    // the radar shares the rings setting
    await game.setPosition('approach');
    await expect(page.getByTestId('radar-tool-rings')).toHaveAttribute('data-state', 'off');
    await page.getByTestId('radar-tool-rings').click();
    await expect(page.getByTestId('radar-tool-rings')).toHaveAttribute('data-state', 'on');
    expect((await sim.storeSettings()).showRings).toBe(true);
    await page.getByTestId('radar-tool-rings').click();
    expect((await sim.storeSettings()).showRings).toBe(false);

    await reloadGame(game);
    await sim.waitMapReady();
    expect(await sim.storeSettings()).toMatchObject({ groundTheme: 'chart', showRings: false });
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'chart');
    await expect(page.getByTestId('map-tool-theme')).toHaveAttribute('data-state', 'chart');
    await expect(page.getByTestId('map-tool-rings')).toHaveAttribute('data-state', 'off');
    await page.goto('/settings');
    await expect(page.getByTestId('page-settings')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('set-theme-chart')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('set-show-rings')).toHaveAttribute('data-state', 'off');
  });

  test('UI prefs from /settings (data-block density, reduced motion) reach the game document after navigation and reload @full', async ({ settings, openGame, page }) => {
    await settings.goto();
    await settings.pickSegmented('set-datablock', 'compact');
    await settings.setToggle('set-reduced-motion', true);
    expect(await readLocalStorageJson<{ dataBlockDensity: string; reducedMotion: boolean }>(page, LS_KEYS.prefs)).toEqual({ dataBlockDensity: 'compact', reducedMotion: true });
    const game = await openGame(TOWER);
    await expect(page.locator('html')).toHaveAttribute('data-datablock', 'compact');
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
    await reloadGame(game);
    await expect(page.locator('html')).toHaveAttribute('data-datablock', 'compact');
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
  });
});

test.describe('start config, sessions, fresh state', () => {
  test('P4 a one-shot start config in storage boots plain /play with its ends, weights, position, difficulty and seed, then is consumed @full', async ({ game, sim, page }) => {
    const cfg = { icao: 'EGLL', ends: ['27L', '27R'], weights: { '27L': ['L', 'M', 'H'], '27R': ['M', 'H'] }, difficulty: 'low', position: 'ground', spawn: 'none', seed: 11, test: true };
    await seedLocalStorage(page, { [LS_KEYS.startConfig]: JSON.stringify(cfg), [LS_KEYS.onboardingSeen]: '1', [LS_KEYS.settings]: JSON.stringify({ sound: false, tts: false }) });
    await page.goto('/play');
    await game.waitReady();
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();                    // consumed
    const st = await sim.storeState();
    expect(st).toMatchObject({ icao: 'EGLL', seed: 11, position: 'ground', testMode: true });
    expect(st.lastConfig).toMatchObject({ ends: ['27L', '27R'], difficulty: 'low', position: 'ground', seed: 11 });
    expect(st.settings.difficulty).toBe('low');
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.difficulty).toBe('low');
    const rws = await sim.runways();
    expect(rws.filter((r) => r.active).map((r) => r.name).sort()).toEqual(['27L', '27R']);
    expect(rws.find((r) => r.name === '27R')?.weights).toEqual(['M', 'H']);
    expect(rws.find((r) => r.name === '09L')?.active).toBe(false);
    await expect(game.shell()).toHaveAttribute('data-mode', 'ground');
    await expect(game.airportBadge()).toHaveText('EGLL');
    await expect(game.radioLines('SYS').first()).toContainText(/test mode · seed 11/);
    expect(await sim.callsigns()).toEqual([]);
    // the home page now offers to resume this very session
    await game.brand().click();
    await page.getByTestId('home-leave-confirm-yes').click();
    await page.waitForURL(/\/$/);
    await expect(page.getByTestId('home-resume')).toBeVisible();
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();
  });

  test('a malformed one-shot config is discarded: /play boots the URL config and the key is cleared @full', async ({ openGame, sim, page }) => {
    await seedLocalStorage(page, { [LS_KEYS.startConfig]: '{"icao": "KJFK", ends: [oops' });
    const game = await openGame({ ...TOWER, icao: 'EGLL' });
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();
    const st = await sim.storeState();
    expect(st.icao).toBe('EGLL');
    expect(st.testMode).toBe(true);
    expect(st.lastConfig?.ends ?? []).toEqual([]);
    await expect(game.airportBadge()).toHaveText('EGLL');
    // a config that is JSON but not an object is ignored the same way
    await seedLocalStorage(page, { [LS_KEYS.startConfig]: '42' });
    await reloadGame(game);
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();
    expect((await sim.storeState()).icao).toBe('EGLL');
  });

  test('P5 fresh context: /play boots with DEFAULT_SETTINGS in store and engine; storage is written on the first change only @full', async ({ game, sim, page }) => {
    await page.goto(GamePage.url({ icao: 'EGLL', seed: 7, spawn: 'none', position: 'tower' }));
    await game.waitReady();
    // (the shell's usePersistedState writes its own defaults on mount — panels, hotkey badges, log filter; every game-state
    //  key owned by persist.ts / _lib/persist.ts stays absent until the user changes something)
    for (const k of [...Object.values(LS_KEYS), 'skycontrol_cmd_history', 'skycontrol_ground_presets', 'skycontrol_allow_narrow']) expect(await readLocalStorage(page, k), k).toBeNull();
    expect(await sim.storeSettings()).toEqual(DEFAULTS);
    expect((await sim.storeState()).highScore).toBe(0);
    const eng = await sim.engineSettings();
    expect(eng.autoTower).toBe(false);
    expect(eng.autoGround).toBe(false);
    expect(eng.autoHandoff).toBe(true);
    expect(eng.strictFrequencies).toBe(false);
    expect(eng.region).toBe('ICAO');                                     // 'auto' resolves to ICAO at EGLL
    expect(eng.pilotDelayOverride).toBe(3);                              // test-mode default
    await expect(game.scoreHi()).toHaveCount(0);
    await expect(page.getByTestId('tip-1')).toHaveCount(0);              // tips never show in test mode
    await openModal(game);
    expect(await modalChecked(game, 'set-sound')).toBe(true);
    expect(await modalChecked(game, 'set-tts')).toBe(false);
    expect(await modalChecked(game, 'set-auto-handoff')).toBe(true);
    expect(await modalChecked(game, 'set-strict-frequencies')).toBe(false);
    expect(await modalChecked(game, 'set-typed-instant')).toBe(true);
    expect(await modalChecked(game, 'set-show-rings')).toBe(true);
    await expect(game.settingsModal().getByTestId('set-theme-satellite')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.settingsModal().getByTestId('set-volume-value')).toHaveAttribute('data-value', '80');
    expect(await readLocalStorage(page, LS_KEYS.settings)).toBeNull();     // reading never writes
    // the first change writes the whole blob (defaults + the change)
    await setModalToggle(game, 'set-tts', true);
    expect(await readLocalStorageJson<Settings>(page, LS_KEYS.settings)).toEqual({ ...DEFAULTS, tts: true });
    expect(await readLocalStorage(page, LS_KEYS.tts)).toBe('1');
  });

  test('onboarding: the first live boot shows the tips, dismissing them sets the flag, the next boot is quiet @full', async ({ game, page }) => {
    await seedLocalStorage(page, { [LS_KEYS.settings]: JSON.stringify({ sound: false, tts: false }) });
    // live boot (no ?test): the tips are a first-run feature of the real game loop; spawn=none keeps the sky empty
    await page.goto(GamePage.url({ icao: 'EGLL', seed: 7, spawn: 'none', position: 'ground', test: false }));
    await game.waitReady({ test: false });
    expect(await readLocalStorage(page, LS_KEYS.onboardingSeen)).toBeNull();
    await expect(page.getByTestId('tip-1')).toBeVisible();
    await expect(page.getByTestId('tip-1')).toHaveAttribute('data-step', '0');
    await page.getByTestId('tip-next').click();
    await expect(page.getByTestId('tip-2')).toBeVisible();
    await page.getByTestId('tip-skip-all').click();
    await expect(page.getByTestId('tip-2')).toHaveCount(0);
    await expect(page.locator('[data-testid^="tip-"][data-step]')).toHaveCount(0);
    expect(await readLocalStorage(page, LS_KEYS.onboardingSeen)).toBe('1');

    await page.reload();
    await game.waitReady({ test: false });
    await expect(game.stripBay()).toBeVisible();
    await expect(page.locator('[data-testid^="tip-"][data-step]')).toHaveCount(0);
    expect(await readLocalStorage(page, LS_KEYS.onboardingSeen)).toBe('1');
  });

  test('session history: Restart from the pause menu records the finished shift (>= 30 sim-s) and /settings lists it @full', async ({ openGame, sim, page }) => {
    const game = await openGame(TOWER);
    await sim.setScore(321);
    await sim.advance(45);
    expect(await readLocalStorage(page, LS_KEYS.sessionHistory)).toBeNull();
    await game.hotkey('Escape');
    await expect(game.pauseMenu()).toBeVisible();
    await game.pauseItem('restart').click();
    await expect(game.pauseConfirm('restart')).toBeVisible();
    await game.pauseConfirmYes().click();
    await expect(game.pauseMenu()).toHaveCount(0);
    await game.waitReady();
    expect(await sim.time()).toBeLessThan(1);                              // a new engine
    const hist = await readLocalStorageJson<SessionRecord[]>(page, LS_KEYS.sessionHistory);
    expect(hist).toHaveLength(1);
    expect(hist![0]).toMatchObject({ icao: 'EGLL', points: 321, seed: 7, simTimeS: 45 });
    expect(hist![0].endedAt).toBeGreaterThanOrEqual(hist![0].startedAt);
    // the best score was flushed by the record as well
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('321');
    await expect(game.scoreHi()).toHaveText('HI 321');
    // a short shift (< 30 sim-s) is not recorded
    await sim.advance(10);
    await game.hotkey('Escape');
    await game.pauseItem('restart').click();
    await game.pauseConfirmYes().click();
    await game.waitReady();
    expect(await readLocalStorageJson<SessionRecord[]>(page, LS_KEYS.sessionHistory)).toHaveLength(1);
    await openModal(game);
    await page.getByTestId('set-open-full').click();
    await expect(page.getByTestId('page-settings')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('[data-testid^="set-history-"][data-score]')).toHaveCount(1);
    await expect(page.getByTestId('set-history-0')).toHaveAttribute('data-score', '321');
    await expect(page.getByTestId('set-history-0')).toContainText('EGLL');
  });

  test('corrupt localStorage: garbage in every key still boots home, /settings and the game with defaults, no console errors @full', async ({ game, sim, page }) => {
    const garbage: Record<string, string> = {
      [LS_KEYS.settings]: '{not json',
      [LS_KEYS.highScore]: 'abc',
      [LS_KEYS.startConfig]: '[[[',
      [LS_KEYS.sessionHistory]: '{"a":1}',
      [LS_KEYS.onboardingSeen]: 'maybe',
      [LS_KEYS.prefs]: '<<<',
      [LS_KEYS.tts]: 'zzz',
      [LS_KEYS.autoTower]: '???',
      [LS_KEYS.groundTheme]: 'neon',
    };
    for (const k of SHELL_KEYS) garbage[k] = '{"';
    await seedLocalStorage(page, garbage);

    await page.goto('/');
    await expect(page.getByTestId('page-home')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('home-highscore')).toHaveCount(0);
    await expect(page.getByTestId('home-resume')).toHaveCount(0);
    await expect(page.locator('[data-testid^="airport-card-"]')).toHaveCount(12);

    await page.goto('/settings');
    await expect(page.getByTestId('page-settings')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('set-highscore')).toHaveAttribute('data-value', '0');
    await expect(page.getByTestId('set-history-empty')).toBeVisible();
    await expect(page.getByTestId('set-theme-satellite')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('set-auto-handoff')).toHaveAttribute('data-state', 'on');
    await expect(page.getByTestId('set-datablock-normal')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-datablock', 'normal');

    await page.goto(GamePage.url({ icao: 'EGLL', seed: 7, spawn: 'none', position: 'ground' }));
    await game.waitReady({ waitMap: true });
    expect(await sim.storeSettings()).toEqual(DEFAULTS);
    expect((await sim.storeState()).highScore).toBe(0);
    expect((await sim.storeState()).icao).toBe('EGLL');
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();
    await expect(game.scoreHi()).toHaveCount(0);
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'satellite');
    await expect(page.locator('html')).toHaveAttribute('data-hotkey-badges', 'on');
    await expect(game.logFilter('gnd')).toHaveAttribute('aria-selected', 'true');
    await expect(game.stripBay()).toHaveAttribute('data-collapsed', 'false');
    // the shell still works: a command line entry and the presets popover (which reads the garbage presets key)
    await sim.spawnAt({ callsign: 'BAW1', type: 'A320', kind: 'departure', phase: 'parked', gate: '512', plan: { runway: '27L' } });
    await game.sendOk('BAW1 PUSHBACK');
    await game.cmdInput().press('ArrowUp');                                  // history key was garbage: recall is a no-op, no crash
    await page.getByTestId('map-tool-presets').click();
    await expect(page.getByTestId('map-presets-popover')).toBeVisible();
    await expect(page.getByTestId('preset-user-1')).toBeDisabled();
    await page.getByTestId('map-tool-layers').click();
    await expect(page.getByTestId('map-layers-popover')).toBeVisible();
    await expect(page.getByTestId('layer-trails')).toHaveAttribute('aria-checked', 'true');
  });

  test('a settings blob with wrong value types does not break the boot @full', async ({ game, sim, page }) => {
    await seedLocalStorage(page, { [LS_KEYS.settings]: JSON.stringify({ volume: 'loud', difficulty: 'ultra', groundTheme: 7, pilotDelayS: 'soon', emergencyRate: 42, region: null, sound: 'no', tts: 0 }), [LS_KEYS.onboardingSeen]: '1' });
    await page.goto(GamePage.url({ icao: 'EGLL', seed: 7, spawn: 'default', position: 'tower' }));
    await game.waitReady();
    expect((await sim.storeState()).hasEngine).toBe(true);
    expect((await sim.snapshot()).stats.total).toBe(7);
    await expect(game.airportBadge()).toHaveText('EGLL');
    await expect(page.getByTestId('view-ground')).toBeVisible();
    await openModal(game);
    await expect(game.settingsModal().getByTestId('set-theme-satellite')).toBeVisible();
    await closeModal(game);
    await sim.advance(5);
    expect(await sim.time()).toBeGreaterThanOrEqual(4.99);
  });
});

/*
  Settings page (`/settings`, src/app/settings/page.tsx) — 05-TEST-STRATEGY §4.2 S1-S7 adapted to the real ids
  (tests/e2e/testids.txt) and extended to EVERY control on the page:
    defaults, every toggle (role=switch: aria-checked + data-state), every select, both segmented controls, the theme
    pills, the volume range — each round-trips to localStorage (`skycontrol_settings` / `skycontrol_prefs` + the legacy
    single-value mirrors), to the live store (`sim.settings`) and the live engine (`engine.settings`), and survives a reload;
    high score display + reset, session history (seeded and real), reset-all, navigation, credits, version, and the
    in-game "Replay onboarding" (set-reset-tips lives in the game's settings modal, src/game/SettingsModal).

  Code wins over 05 §4.2 where they differ: the store default for AI tower assist is OFF (DEFAULT_SETTINGS.autoTower = false).
*/
import { readFileSync } from 'node:fs';
import { test, expect, LS_KEYS, readLocalStorage, readLocalStorageJson, writeLocalStorage } from './fixtures/test';
import type { ToggleId, SelectId } from './pages/SettingsPage';
import type { Settings } from '@/components/atc/simStore';
import type { SessionRecord } from '@/components/atc/persist';

/** src/components/atc/simStore.ts DEFAULT_SETTINGS. */
const DEFAULTS: Settings = {
  autoTower: false, autoGround: false, autoApproach: false, autoMode: false, autoHandoff: true, strictFrequencies: false, emergencyRate: 'normal',
  groundTheme: 'satellite', showRings: true, difficulty: 'normal', sound: true, tts: false, volume: 0.8,
  pilotDelayS: null, readbackErrors: true, region: 'auto', instantVectors: false, typedInstant: true,
};
/** Toggle id -> Settings key (store-owned toggles). `set-reduced-motion` is a UI pref (skycontrol_prefs). */
const TOGGLE_KEY: Record<Exclude<ToggleId, 'set-reduced-motion'>, keyof Settings> = {
  'set-autotower': 'autoTower', 'set-autoground': 'autoGround', 'set-autoapproach': 'autoApproach', 'set-automode': 'autoMode', 'set-auto-handoff': 'autoHandoff',
  'set-strict-frequencies': 'strictFrequencies', 'set-readback-errors': 'readbackErrors', 'set-instant-vectors': 'instantVectors',
  'set-typed-instant': 'typedInstant', 'set-show-rings': 'showRings', 'set-sound': 'sound', 'set-tts': 'tts',
};
const STORE_TOGGLES = Object.keys(TOGGLE_KEY) as Array<keyof typeof TOGGLE_KEY>;
const SELECT_DEFAULT_LABEL: Record<SelectId, string> = { 'set-emergency-rate': 'Normal', 'set-pilot-delay': 'Realistic', 'set-phraseology': 'Automatic' };
const CREDIT_SLUGS = ['openstreetmap-contributors', 'esri-world-imagery', 'endless-atc-airport-format', 'maplibre-gl-js', 'dm-sans', 'lucide'];

/**
 * Seed storage for the NEXT full navigation without an init script: init scripts re-run on every reload and would
 * re-seed the value the test is about to reset. Opens `/` first so the origin's storage exists.
 */
async function seedForNextLoad(page: import('@playwright/test').Page, kv: Record<string, string>): Promise<void> {
  await page.goto('/');
  for (const [k, v] of Object.entries(kv)) await writeLocalStorage(page, k, v);
}

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    icao: 'EGLL', startedAt: 1_700_000_000_000, endedAt: 1_700_003_600_000, simTimeS: 1800, points: 1234, skill: 6.5,
    movements: 12, departures: 7, arrivals: 5, incidents: 0, emergenciesResolved: 0, seed: 7, ...over,
  };
}

test.describe('settings: defaults and navigation', () => {
  test('S1 defaults with empty storage: every control shows DEFAULT_SETTINGS @smoke', async ({ settings, page }) => {
    await settings.goto();
    expect(await readLocalStorage(page, LS_KEYS.settings)).toBeNull();
    for (const id of STORE_TOGGLES) {
      const want = DEFAULTS[TOGGLE_KEY[id]] as boolean;
      await expect(settings.toggle(id), id).toHaveAttribute('role', 'switch');
      await expect(settings.toggle(id), id).toHaveAttribute('aria-checked', String(want));
      await expect(settings.toggle(id), id).toHaveAttribute('data-state', want ? 'on' : 'off');
    }
    await expect(settings.toggle('set-reduced-motion')).toHaveAttribute('data-state', 'off');
    for (const id of Object.keys(SELECT_DEFAULT_LABEL) as SelectId[]) expect(await settings.selectLabel(id), id).toBe(SELECT_DEFAULT_LABEL[id]);
    expect(await settings.segmentedValue('set-difficulty')).toBe('normal');
    expect(await settings.segmentedValue('set-datablock')).toBe('normal');
    await expect(settings.theme('satellite')).toHaveAttribute('aria-pressed', 'true');
    await expect(settings.theme('chart')).toHaveAttribute('aria-pressed', 'false');
    expect(await settings.volumePct()).toBe(80);
    await expect(settings.volume()).toHaveValue('80');
    await expect(settings.volume()).toBeEnabled();
    expect(await settings.highScoreValue()).toBe(0);
    await expect(settings.resetScore()).toBeDisabled();
    await expect(settings.historyEmpty()).toBeVisible();
    await expect(settings.history()).toHaveCount(0);
    await expect(settings.clearHistory()).toBeDisabled();
    await expect(settings.resetAll()).toBeEnabled();
    for (const s of ['simulation', 'display', 'audio', 'data', 'about'] as const) await expect(settings.section(s)).toBeVisible();
    await expect(settings.resumeBtn()).toHaveCount(0);
    await expect(settings.backLink()).toBeVisible();
    await expect(settings.homeLink()).toBeVisible();
    // the <html> mirrors of the UI prefs
    await expect(page.locator('html')).toHaveAttribute('data-datablock', 'normal');
    await expect(page.locator('html')).not.toHaveAttribute('data-reduced-motion', 'true');
  });

  test('S6 navigation: brand and Home go to /; version and credits are present @full', async ({ settings, home, page }) => {
    await settings.goto();
    const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
    await expect(settings.version()).toHaveText(`v${version}`);
    await expect(settings.credits()).toHaveCount(CREDIT_SLUGS.length);
    for (const slug of CREDIT_SLUGS) await expect(settings.credit(slug)).toBeVisible();

    await settings.homeLink().click();
    await page.waitForURL(/\/$/);
    await expect(home.root()).toHaveAttribute('data-ready', 'true');
    await home.settingsLink().click();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await settings.backLink().click();
    await page.waitForURL(/\/$/);
    await expect(home.airportCards()).toHaveCount(6);
  });

  test('credits: linked rows open their licence page in a new tab, the format row is static @full', async ({ settings, page }) => {
    await settings.goto();
    // window.open is stubbed: the sandbox has no network and the target is the assertion, not the page load
    await page.evaluate(() => {
      const w = window as unknown as { __opened: string[]; open: (u?: string | URL) => Window | null };
      w.__opened = [];
      w.open = (u?: string | URL) => { w.__opened.push(String(u)); return null; };
    });
    const linked: Array<[string, RegExp]> = [
      ['openstreetmap-contributors', /openstreetmap\.org\/copyright/],
      ['esri-world-imagery', /esri\.com/],
      ['maplibre-gl-js', /maplibre\.org/],
      ['dm-sans', /fonts\.google\.com/],
      ['lucide', /lucide\.dev/],
    ];
    for (const [slug, re] of linked) {
      await expect(settings.credit(slug)).toHaveAttribute('role', 'button');
      await settings.credit(slug).click();
      const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
      expect(opened[opened.length - 1], slug).toMatch(re);
    }
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened).toHaveLength(linked.length);
    await expect(settings.credit('endless-atc-airport-format')).not.toHaveAttribute('role', 'button');
    await settings.credit('endless-atc-airport-format').click();
    expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toHaveLength(linked.length);
  });
});

test.describe('settings: every control round-trips to storage and survives reload', () => {
  test('S2 AI tower assist and pilot voice: data-state, settings blob and legacy mirrors @smoke', async ({ settings, page }) => {
    await settings.goto();
    await settings.setToggle('set-autotower', true);
    await expect(settings.autoTower()).toHaveAttribute('aria-checked', 'true');
    expect(await readLocalStorage(page, LS_KEYS.autoTower)).toBe('1');
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.autoTower).toBe(true);
    await settings.setToggle('set-tts', true);
    expect(await readLocalStorage(page, LS_KEYS.tts)).toBe('1');
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.tts).toBe(true);

    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.autoTower()).toHaveAttribute('data-state', 'on');
    await expect(settings.tts()).toHaveAttribute('data-state', 'on');

    await settings.setToggle('set-autotower', false);
    expect(await readLocalStorage(page, LS_KEYS.autoTower)).toBe('0');
    await settings.setToggle('set-tts', false);
    expect(await readLocalStorage(page, LS_KEYS.tts)).toBe('0');
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.autoTower).toBe(false);
  });

  test('every store toggle flips aria-checked / data-state and the settings blob; all survive a reload @full', async ({ settings, page }) => {
    await settings.goto();
    for (const id of STORE_TOGGLES) {
      const key = TOGGLE_KEY[id];
      const want = !(DEFAULTS[key] as boolean);
      await settings.setToggle(id, want);
      await expect(settings.toggle(id), id).toHaveAttribute('aria-checked', String(want));
      const blob = await readLocalStorageJson<Settings>(page, LS_KEYS.settings);
      expect(blob?.[key], `${id} -> settings.${key}`).toBe(want);
    }
    // volume control follows the sound toggle (sound is now off)
    await expect(settings.volume()).toBeDisabled();

    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    for (const id of STORE_TOGGLES) {
      const want = !(DEFAULTS[TOGGLE_KEY[id]] as boolean);
      await expect(settings.toggle(id), `${id} after reload`).toHaveAttribute('data-state', want ? 'on' : 'off');
      await expect(settings.toggle(id), `${id} after reload`).toHaveAttribute('aria-checked', String(want));
    }
    // and back to the defaults
    for (const id of STORE_TOGGLES) await settings.setToggle(id, DEFAULTS[TOGGLE_KEY[id]] as boolean);
    const blob = await readLocalStorageJson<Settings>(page, LS_KEYS.settings);
    for (const id of STORE_TOGGLES) expect(blob?.[TOGGLE_KEY[id]], id).toBe(DEFAULTS[TOGGLE_KEY[id]]);
    await expect(settings.volume()).toBeEnabled();
  });

  test('S3 selects: emergency rate, pilot delay and phraseology round-trip and survive a reload @full', async ({ settings, page }) => {
    await settings.goto();
    const blob = () => readLocalStorageJson<Settings>(page, LS_KEYS.settings);

    await settings.pickSelect('set-emergency-rate', /^Rare/);
    expect(await settings.selectLabel('set-emergency-rate')).toBe('Rare');
    expect((await blob())?.emergencyRate).toBe('rare');
    await settings.pickSelect('set-emergency-rate', /^Off/);
    expect((await blob())?.emergencyRate).toBe('off');
    await settings.pickSelect('set-emergency-rate', /^Training/);
    expect((await blob())?.emergencyRate).toBe('training');

    await settings.pickSelect('set-pilot-delay', /^1 s/);
    expect(await settings.selectLabel('set-pilot-delay')).toBe('1 s');
    expect((await blob())?.pilotDelayS).toBe(1);
    await settings.pickSelect('set-pilot-delay', /^8 s/);
    expect((await blob())?.pilotDelayS).toBe(8);
    await settings.pickSelect('set-pilot-delay', /^Realistic/);
    expect((await blob())?.pilotDelayS).toBeNull();
    await settings.pickSelect('set-pilot-delay', /^4 s/);
    expect((await blob())?.pilotDelayS).toBe(4);

    await settings.pickSelect('set-phraseology', /^ICAO/);
    expect(await settings.selectLabel('set-phraseology')).toBe('ICAO');
    expect((await blob())?.region).toBe('ICAO');
    await settings.pickSelect('set-phraseology', /^FAA/);
    expect((await blob())?.region).toBe('FAA');

    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    expect(await settings.selectLabel('set-emergency-rate')).toBe('Training');
    expect(await settings.selectLabel('set-pilot-delay')).toBe('4 s');
    expect(await settings.selectLabel('set-phraseology')).toBe('FAA');
    // the open menu marks the stored value as selected
    await page.getByTestId('set-phraseology').click();
    await expect(settings.selectMenu('set-phraseology').getByRole('option', { name: /^FAA/ })).toHaveAttribute('aria-selected', 'true');
    await expect(settings.selectMenu('set-phraseology').getByRole('option', { name: /^ICAO/ })).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Escape');
    await expect(settings.selectMenu('set-phraseology')).toHaveCount(0);
    // keyboard: arrows move, Enter commits
    await page.getByTestId('set-phraseology').focus();
    await page.keyboard.press('ArrowDown');       // opens at FAA
    await page.keyboard.press('ArrowUp');         // ICAO
    await page.keyboard.press('Enter');
    expect(await settings.selectLabel('set-phraseology')).toBe('ICAO');
    expect((await blob())?.region).toBe('ICAO');
    await settings.pickSelect('set-phraseology', /^Automatic/);
    expect((await blob())?.region).toBe('auto');
  });

  test('S4 segmented controls: difficulty (settings blob, home default) and data blocks (prefs, <html>) @full', async ({ settings, home, page }) => {
    await settings.goto();
    for (const d of ['low', 'high'] as const) {
      await settings.pickSegmented('set-difficulty', d);
      expect(await settings.segmentedValue('set-difficulty')).toBe(d);
      expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.difficulty).toBe(d);
    }
    for (const d of ['compact', 'full'] as const) {
      await settings.pickSegmented('set-datablock', d);
      expect((await readLocalStorageJson<{ dataBlockDensity: string }>(page, LS_KEYS.prefs))?.dataBlockDensity).toBe(d);
      await expect(page.locator('html')).toHaveAttribute('data-datablock', d);
    }
    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    expect(await settings.segmentedValue('set-difficulty')).toBe('high');
    expect(await settings.segmentedValue('set-datablock')).toBe('full');
    await expect(page.locator('html')).toHaveAttribute('data-datablock', 'full');
    // the home page picks the stored difficulty up as its default for a new shift
    await settings.backLink().click();
    await expect(home.root()).toHaveAttribute('data-ready', 'true');
    await home.pickAirport('EGLL');
    await expect(home.difficultyTab('high')).toHaveAttribute('aria-pressed', 'true');
  });

  test('reduced motion: prefs blob and the <html data-reduced-motion> hook, survives reload @full', async ({ settings, page }) => {
    await settings.goto();
    await settings.setToggle('set-reduced-motion', true);
    await expect(settings.toggle('set-reduced-motion')).toHaveAttribute('aria-checked', 'true');
    expect((await readLocalStorageJson<{ reducedMotion: boolean }>(page, LS_KEYS.prefs))?.reducedMotion).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.toggle('set-reduced-motion')).toHaveAttribute('data-state', 'on');
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
    await settings.setToggle('set-reduced-motion', false);
    await expect(page.locator('html')).not.toHaveAttribute('data-reduced-motion', 'true');
    expect((await readLocalStorageJson<{ reducedMotion: boolean }>(page, LS_KEYS.prefs))?.reducedMotion).toBe(false);
  });

  test('S5 ground theme: pills, settings blob + legacy mirror, and the game map picks it up @full', async ({ settings, openGame, sim, page }) => {
    await settings.goto();
    await settings.pickTheme('chart');
    await expect(settings.theme('satellite')).toHaveAttribute('aria-pressed', 'false');
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.groundTheme).toBe('chart');
    expect(await readLocalStorage(page, LS_KEYS.groundTheme)).toBe('chart');
    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.theme('chart')).toHaveAttribute('aria-pressed', 'true');

    // the game boots on the chart (store settings + ground view attribute + map toolbar state)
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground', settings: { groundTheme: 'chart' } });
    expect((await sim.storeSettings()).groundTheme).toBe('chart');
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'chart');
    await expect(page.getByTestId('map-tool-theme')).toHaveAttribute('data-state', 'chart');
    // the map toolbar toggles it back and the persisted value follows
    await page.getByTestId('map-tool-theme').click();
    await expect(page.getByTestId('ground-view')).toHaveAttribute('data-theme', 'satellite');
    expect((await sim.storeSettings()).groundTheme).toBe('satellite');
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.groundTheme).toBe('satellite');
    await expect(game.groundMap()).toBeVisible();
  });

  test('volume: range writes settings.volume, mirrors data-value, follows the sound toggle, survives reload @full', async ({ settings, page }) => {
    await settings.goto();
    await settings.setVolume(50);
    await expect(settings.volume()).toHaveValue('50');
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.volume).toBeCloseTo(0.5, 5);
    await settings.setVolume(0);
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.volume).toBe(0);
    await settings.setVolume(100);
    expect((await readLocalStorageJson<Settings>(page, LS_KEYS.settings))?.volume).toBe(1);
    await settings.setVolume(35);
    await settings.setToggle('set-sound', false);
    await expect(settings.volume()).toBeDisabled();
    expect(await settings.volumePct()).toBe(35);                    // the level is kept while muted
    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    expect(await settings.volumePct()).toBe(35);
    await expect(settings.volume()).toBeDisabled();
    await settings.setToggle('set-sound', true);
    await expect(settings.volume()).toBeEnabled();
    await expect(settings.volume()).toHaveValue('35');
  });
});

test.describe('settings: score, history, reset', () => {
  test('S5 high score: displayed from storage, reset to 0 (storage + home pill) @full', async ({ settings, home, page }) => {
    await seedForNextLoad(page, { [LS_KEYS.highScore]: '4200' });
    await settings.goto();
    expect(await settings.highScoreValue()).toBe(4200);
    await expect(settings.highScore()).toContainText('4,200');
    await expect(settings.resetScore()).toBeEnabled();
    await settings.homeLink().click();
    await expect(home.root()).toHaveAttribute('data-ready', 'true');
    await expect(home.highScore()).toBeVisible();
    await expect(home.highScore()).toContainText('4,200');
    await home.settingsLink().click();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');

    await settings.resetScore().click();
    await expect(settings.highScore()).toHaveAttribute('data-value', '0');
    await expect(settings.resetScore()).toBeDisabled();
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('0');
    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    expect(await settings.highScoreValue()).toBe(0);
    await settings.homeLink().click();
    await expect(home.root()).toHaveAttribute('data-ready', 'true');
    await expect(home.highScore()).toHaveCount(0);
  });

  test('P1 a session high score reaches storage, the nav chip and the settings page @full', async ({ openGame, sim, settings, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await expect(game.scoreHi()).toHaveCount(0);
    await sim.setScore(77);
    await sim.advance(1.1);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('77');
    expect((await sim.storeState()).highScore).toBe(77);
    await expect(game.score()).toHaveAttribute('data-value', '77');
    await expect(game.scoreHi()).toHaveText('HI 77');
    // lower scores never lower it
    await sim.setScore(5);
    await sim.advance(1.1);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('77');
    await expect(game.scoreHi()).toHaveText('HI 77');

    // client-side to /settings (the singleton survives): the page shows and resets the live value
    await game.settingsBtn().click();
    await expect(game.settingsModal()).toBeVisible();
    await page.getByTestId('set-open-full').click();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    expect(await settings.highScoreValue()).toBe(77);
    await settings.resetScore().click();
    await expect(settings.highScore()).toHaveAttribute('data-value', '0');
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('0');
    expect((await sim.storeState()).highScore).toBe(0);
  });

  test('session history: seeded records render newest first, capped at 10, and clear @full', async ({ settings, page }) => {
    const recs = Array.from({ length: 12 }, (_, i) => record({ icao: i % 2 ? 'KLAX' : 'EGLL', points: 1000 - i, endedAt: 1_700_000_000_000 - i * 60_000, incidents: i === 1 ? 2 : 0 }));
    await seedForNextLoad(page, { [LS_KEYS.sessionHistory]: JSON.stringify(recs) });
    await settings.goto();
    await expect(settings.history()).toBeVisible();
    await expect(settings.historyEmpty()).toHaveCount(0);
    await expect(settings.historyRows()).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await expect(settings.historyRow(i)).toHaveAttribute('data-score', String(1000 - i));
      await expect(settings.historyRow(i)).toContainText(i % 2 ? 'KLAX' : 'EGLL');
    }
    await expect(settings.historyRow(0)).toContainText('1,000');
    await expect(settings.historyRow(0)).toContainText('30 min');
    await expect(settings.historyRow(1)).toContainText('2');
    await expect(settings.historyRow(10)).toHaveCount(0);
    await expect(settings.clearHistory()).toBeEnabled();

    await settings.clearHistory().click();
    await expect(settings.historyEmpty()).toBeVisible();
    await expect(settings.history()).toHaveCount(0);
    await expect(settings.clearHistory()).toBeDisabled();
    expect(await readLocalStorage(page, LS_KEYS.sessionHistory)).toBeNull();
    await page.reload();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.historyEmpty()).toBeVisible();
  });

  test('session history: a finished shift (>= 30 sim-s) is recorded when the next one starts @full', async ({ openGame, sim, settings, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await sim.setScore(123);
    await sim.advance(60);
    expect(await readLocalStorage(page, LS_KEYS.sessionHistory)).toBeNull();
    // a new load tears the old session down and records it
    await sim.reset({ icao: 'EGLL', seed: 7, spawn: 'none' });
    const hist = await readLocalStorageJson<SessionRecord[]>(page, LS_KEYS.sessionHistory);
    expect(hist).toHaveLength(1);
    expect(hist![0]).toMatchObject({ icao: 'EGLL', points: 123, seed: 7, simTimeS: 60 });
    expect(hist![0].endedAt).toBeGreaterThanOrEqual(hist![0].startedAt);

    await game.settingsBtn().click();
    await page.getByTestId('set-open-full').click();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.historyRows()).toHaveCount(1);
    await expect(settings.historyRow(0)).toHaveAttribute('data-score', '123');
    await expect(settings.historyRow(0)).toContainText('EGLL');
    await expect(settings.historyRow(0)).toContainText('1 min');
  });

  test('reset all: settings and prefs back to defaults, mirrors cleared, high score kept @full', async ({ settings, page }) => {
    await seedForNextLoad(page, { [LS_KEYS.highScore]: '500' });
    await settings.goto();
    await settings.setToggle('set-autotower', true);
    await settings.setToggle('set-tts', true);
    await settings.setToggle('set-auto-handoff', false);
    await settings.pickTheme('chart');
    await settings.pickSegmented('set-difficulty', 'high');
    await settings.pickSegmented('set-datablock', 'compact');
    await settings.setToggle('set-reduced-motion', true);
    await settings.pickSelect('set-pilot-delay', /^2 s/);
    await settings.setVolume(20);
    expect(await readLocalStorage(page, LS_KEYS.autoTower)).toBe('1');

    await settings.resetAll().click();
    for (const id of STORE_TOGGLES) await expect(settings.toggle(id), id).toHaveAttribute('data-state', (DEFAULTS[TOGGLE_KEY[id]] as boolean) ? 'on' : 'off');
    await expect(settings.toggle('set-reduced-motion')).toHaveAttribute('data-state', 'off');
    await expect(settings.theme('satellite')).toHaveAttribute('aria-pressed', 'true');
    expect(await settings.segmentedValue('set-difficulty')).toBe('normal');
    expect(await settings.segmentedValue('set-datablock')).toBe('normal');
    expect(await settings.selectLabel('set-pilot-delay')).toBe('Realistic');
    expect(await settings.volumePct()).toBe(80);
    expect(await readLocalStorageJson<Settings>(page, LS_KEYS.settings)).toEqual(DEFAULTS);
    expect(await readLocalStorage(page, LS_KEYS.autoTower)).toBeNull();
    expect(await readLocalStorage(page, LS_KEYS.tts)).toBeNull();
    expect(await readLocalStorage(page, LS_KEYS.groundTheme)).toBeNull();
    expect(await readLocalStorage(page, LS_KEYS.prefs)).toBeNull();
    await expect(page.locator('html')).not.toHaveAttribute('data-reduced-motion', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-datablock', 'normal');
    expect(await settings.highScoreValue()).toBe(500);
    expect(await readLocalStorage(page, LS_KEYS.highScore)).toBe('500');
  });
});

test.describe('settings: live session', () => {
  test('S7 changes on /settings reach the live store and engine; "Back to shift" resumes the same session @full', async ({ openGame, sim, settings, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await sim.advance(10);
    const t = await sim.time();
    const before = await sim.engineSettings();
    expect(before.autoTower).toBe(false);
    expect(before.autoHandoff).toBe(true);
    expect(before.strictFrequencies).toBe(false);
    expect(before.pilotDelayOverride).toBe(3);                    // test-mode default

    // in-game modal -> "All settings" navigates client-side; the singleton (and __atcTest) survive
    await game.settingsBtn().click();
    await expect(game.settingsModal()).toBeVisible();
    // (the modal has no AI-tower row; its Mirror puts data-state on the wrapper span, so the switch itself is read via aria-checked)
    await expect(game.settingsModal().getByTestId('set-auto-handoff')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('set-open-full').click();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.resumeBtn()).toBeVisible();
    await expect(settings.resumeBtn()).toContainText('EGLL');

    await settings.setToggle('set-autotower', true);
    await settings.setToggle('set-autoground', true);
    await settings.setToggle('set-autoapproach', true);
    await settings.setToggle('set-auto-handoff', false);
    await settings.setToggle('set-strict-frequencies', true);
    await settings.pickSelect('set-phraseology', /^FAA/);
    await settings.pickSelect('set-pilot-delay', /^4 s/);
    await settings.pickSegmented('set-difficulty', 'high');
    await settings.setToggle('set-show-rings', false);
    await settings.setToggle('set-instant-vectors', true);

    const store = await sim.storeSettings();
    expect(store).toMatchObject({ autoTower: true, autoGround: true, autoApproach: true, autoHandoff: false, strictFrequencies: true, region: 'FAA', pilotDelayS: 4, difficulty: 'high', showRings: false, instantVectors: true });
    const eng = await sim.engineSettings();
    expect(eng.autoTower).toBe(true);
    expect(eng.autoGround).toBe(true);
    expect(eng.autoApproach).toBe(true);
    expect(eng.autoHandoff).toBe(false);
    expect(eng.strictFrequencies).toBe(true);
    expect(eng.region).toBe('FAA');
    expect(eng.pilotDelayOverride).toBe(4);
    expect(await readLocalStorage(page, LS_KEYS.autoTower)).toBe('1');

    await settings.resumeBtn().click();
    await page.waitForURL(/\/play(\?.*)?$/);
    await game.waitReady();
    expect(await sim.time()).toBeCloseTo(t, 1);                    // resumed, not rebuilt
    expect((await sim.engineSettings()).autoTower).toBe(true);
    expect((await sim.engineSettings()).pilotDelayOverride).toBe(4);
    expect((await sim.storeSettings()).difficulty).toBe('high');
    // the in-game modal shows the same live values
    await game.settingsBtn().click();
    await expect(game.settingsModal().getByTestId('set-strict-frequencies')).toHaveAttribute('aria-checked', 'true');
    await expect(game.settingsModal().getByTestId('set-auto-handoff')).toHaveAttribute('aria-checked', 'false');
    await expect(game.settingsModal().getByTestId('set-instant-vectors')).toHaveAttribute('aria-checked', 'true');
    expect(await game.settingsModal().getByTestId('set-pilot-delay').textContent()).toContain('4 s');
    // pilot delay is live: a command now takes 4 s, not 3
    await page.getByTestId('set-close').click();
    await expect(game.settingsModal()).toHaveCount(0);
    await sim.spawnAt({ callsign: 'UAL9', type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250 });
    await sim.setPosition('approach');
    const r = await sim.command('UAL9 HEADING 180');
    expect(r.ok).toBe(true);
    await sim.advance(3.5);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.length).toBeGreaterThan(0);
    await sim.advance(1);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toHaveLength(0);
  });

  test('in-game settings modal: a toggle flipped in the game shows on /settings and in storage @full', async ({ openGame, sim, settings, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await game.settingsBtn().click();
    const modal = game.settingsModal();
    await expect(modal).toBeVisible();
    await modal.getByTestId('set-tts').click();
    await expect(modal.getByTestId('set-tts')).toHaveAttribute('aria-checked', 'true');
    await modal.getByTestId('set-readback-errors').click();
    await expect(modal.getByTestId('set-readback-errors')).toHaveAttribute('aria-checked', 'false');
    expect((await sim.storeSettings()).tts).toBe(true);
    expect((await sim.storeSettings()).readbackErrors).toBe(false);
    expect(await readLocalStorage(page, LS_KEYS.tts)).toBe('1');
    await page.getByTestId('set-open-full').click();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.tts()).toHaveAttribute('data-state', 'on');
    await expect(settings.toggle('set-readback-errors')).toHaveAttribute('data-state', 'off');
    await expect(settings.resumeBtn()).toBeVisible();
  });

  test('replay onboarding (set-reset-tips): the coach marks come back and are dismissed again @full', async ({ openGame, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'default', position: 'ground' });
    expect(await readLocalStorage(page, LS_KEYS.onboardingSeen)).toBe('1');
    await expect(page.getByTestId('tip-1')).toHaveCount(0);
    await game.settingsBtn().click();
    await expect(game.settingsModal()).toBeVisible();
    await page.getByTestId('set-reset-tips').click();
    await expect(game.settingsModal()).toHaveCount(0);
    await expect(page.getByTestId('tip-1')).toBeVisible();
    await expect(page.getByTestId('tip-1')).toHaveAttribute('data-step', '0');
    await expect(page.getByTestId('tip-progress-1')).toHaveAttribute('data-on', 'true');
    expect(await readLocalStorage(page, LS_KEYS.onboardingSeen)).toBeNull();
    await page.getByTestId('tip-next').click();
    await expect(page.getByTestId('tip-2')).toBeVisible();
    await expect(page.getByTestId('tip-1')).toHaveCount(0);
    await page.getByTestId('tip-skip-all').click();
    await expect(page.getByTestId('tip-2')).toHaveCount(0);
    expect(await readLocalStorage(page, LS_KEYS.onboardingSeen)).toBe('1');
  });
});

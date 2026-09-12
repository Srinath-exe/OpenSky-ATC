/*
  Extended Playwright `test` for the SkyControl e2e suite (05-TEST-STRATEGY §1.4, adapted to the code).

    import { test, expect } from '../fixtures/test';

    test('vector an arrival @smoke', async ({ game, sim }) => {
      await game.goto({ icao: 'EGLL', seed: 7, spawn: 'none', position: 'approach' });
      await sim.spawnAt({ callsign: 'UAL9', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, altFt: 8000 }, heading: 90, speedKts: 250 });
      await game.openPanelFor('UAL9');
      await game.sendOk('UAL9 HDG 180');
      await sim.advance(3.1);
      expect((await sim.aircraftOrFail('UAL9')).targetHeading).toBeCloseTo(180, 0);
    });

  Fixtures:
    seed       per-test seed (option; default 7)
    sim        SimApi — typed window.__atcTest wrapper (advance / spawnAt / aircraft / snapshot / screenPos ...)
    game       GamePage — /play page object (goto, setPosition, selectStrip, openPanelFor, action, stepper helpers, send, radio, toasts, hotkey)
    home       HomePage — / page object (goto, pickAirport, toggleEnd, toggleWeight, start)
    settings   SettingsPage — /settings page object
    openGame   shortcut: seeds localStorage (autoTower off, tts off, sound off, onboarding seen) and opens /play in test mode
    browserConsole  ConsoleCollector — fails the test on any console.error / pageerror not in the allowlist (auto-used)

  Every test gets its own browser context (fresh localStorage, fresh sim singleton). Never share a page across tests.
*/
import { test as base, expect } from '@playwright/test';
import { SimApi } from './simApi';
import { ConsoleCollector } from './console';
import { seedSettings, seedOnboardingSeen, type SettingsSeed } from './storage';
import { HomePage } from '../pages/HomePage';
import { GamePage, type GameGotoOptions } from '../pages/GamePage';
import { SettingsPage } from '../pages/SettingsPage';

export interface OpenGameOptions extends GameGotoOptions {
  /** Store settings to seed before load (merged over: autoTower false, autoGround false, tts false, sound false). */
  settings?: SettingsSeed;
  /** Convenience: settings.autoTower */
  autoTower?: boolean;
}

export interface Fixtures {
  seed: number;
  sim: SimApi;
  game: GamePage;
  home: HomePage;
  settings: SettingsPage;
  browserConsole: ConsoleCollector;
  openGame: (o?: OpenGameOptions) => Promise<GamePage>;
}

export const test = base.extend<Fixtures>({
  seed: [7, { option: true }],

  browserConsole: [async ({ context }, use, testInfo) => {
    const collector = new ConsoleCollector(context);
    await use(collector);
    await collector.finish(testInfo);
  }, { auto: true }],

  sim: async ({ page }, use) => { await use(new SimApi(page)); },
  game: async ({ page }, use) => { await use(new GamePage(page)); },
  home: async ({ page }, use) => { await use(new HomePage(page)); },
  settings: async ({ page }, use) => { await use(new SettingsPage(page)); },

  openGame: async ({ page, seed, game }, use) => {
    await use(async (o: OpenGameOptions = {}) => {
      const settings: SettingsSeed = { autoTower: o.autoTower ?? false, autoGround: false, tts: false, sound: false, ...o.settings };
      await seedSettings(page, settings);
      await seedOnboardingSeen(page);
      await game.goto({ seed, ...o });
      return game;
    });
  },
});

/** On failure, attach the engine-side picture (snapshot / radio / events) next to the trace (05 §6.3). */
test.afterEach(async ({ page, sim }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  if (page.isClosed()) return;
  try {
    if (!(await sim.isReady())) return;
    const [snapshot, radio, events] = await Promise.all([sim.snapshot(), sim.radio(), sim.events()]);
    await testInfo.attach('sim-snapshot', { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' });
    await testInfo.attach('sim-radio', { body: radio.map((l) => `${l.at?.toFixed(1) ?? ''}\t${l.who}\t${l.callsign ?? ''}\t${l.text}`).join('\n'), contentType: 'text/plain' });
    await testInfo.attach('sim-events', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });
  } catch { /* page gone */ }
});

export { expect };
export { SimApi, expectPhase } from './simApi';
export type { AircraftView, Snapshot, SpawnSpec, RadioLine, SimEvent, FlightPhase, Stage, PlayerPosition } from './simApi';
export { skipUnless, skipUnlessAll } from './features';
export { LS_KEYS, seedLocalStorage, seedSettings, readLocalStorage, readLocalStorageJson, writeLocalStorage } from './storage';
export { HomePage } from '../pages/HomePage';
export { GamePage } from '../pages/GamePage';
export { SettingsPage } from '../pages/SettingsPage';

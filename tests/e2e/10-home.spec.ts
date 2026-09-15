/*
  Home page (`/`, src/app/page.tsx) — 05-TEST-STRATEGY §4.1 H1-H10 adapted to the real ids (tests/e2e/testids.txt):
    airport grid + detail view, change airport, every runway-end toggle and every weight-class toggle (aria-pressed),
    wind preview + "Into wind", position / difficulty segmented controls, seed validation, sound / voice toggles,
    START -> /play boots with the exact config (ends + weights in the engine's runways() and in the seeded spawns),
    the one-shot config, every airport boots, and "Resume shift" after leaving a session.

  Engine state comes from the `sim` fixture (window.__atcTest / window.__atcSim), visibility from the DOM.
  Time never advances on its own: boots use the home page's real START button with the test-mode patch
  (`home.goto({ testMode })`), so `__atcTest` is installed and the sim clock only moves through `sim.advance`.
*/
import { test, expect, LS_KEYS, readLocalStorage, readLocalStorageJson, seedSettings } from './fixtures/test';
import { RUNWAY_MANIFEST } from '@/lib/runwayManifest';
import { preferredEnds } from '@/lib/sim/weather';
import type { WeightClass } from '@/lib/sim/aircraftDB';
import type { Settings } from '@/components/atc/simStore';

/** Airport grid order + names (src/app/_lib/airports.ts AIRPORTS). */
const AIRPORTS = [
  { icao: 'EGLL', name: 'Heathrow', city: 'London', wind: { dir: 240, kts: 10 } },
  { icao: 'KJFK', name: 'John F. Kennedy', city: 'New York', wind: { dir: 280, kts: 11 } },
  { icao: 'KLAX', name: 'Los Angeles Intl', city: 'Los Angeles', wind: { dir: 250, kts: 9 } },
  { icao: 'KSFO', name: 'San Francisco Intl', city: 'San Francisco', wind: { dir: 280, kts: 12 } },
  { icao: 'KBOS', name: 'Logan Intl', city: 'Boston', wind: { dir: 270, kts: 10 } },
  { icao: 'VIDP', name: 'Indira Gandhi', city: 'Delhi', wind: { dir: 300, kts: 6 } },
  { icao: 'LFPG', name: 'Charles de Gaulle', city: 'Paris', wind: { dir: 240, kts: 10 } },
  { icao: 'OMDB', name: 'Dubai Intl', city: 'Dubai', wind: { dir: 310, kts: 9 } },
  { icao: 'WSSS', name: 'Changi', city: 'Singapore', wind: { dir: 30, kts: 7 } },
  { icao: 'VHHH', name: 'Hong Kong Intl', city: 'Hong Kong', wind: { dir: 70, kts: 10 } },
  { icao: 'RJTT', name: 'Haneda', city: 'Tokyo', wind: { dir: 340, kts: 10 } },
  { icao: 'YSSY', name: 'Kingsford Smith', city: 'Sydney', wind: { dir: 160, kts: 10 } },
] as const;
const WEIGHTS: WeightClass[] = ['L', 'M', 'H', 'S'];

/** The ends on by default: the family in use for the field's prevailing wind (src/app/page.tsx initialCfg). */
function defaultEnds(icao: string): string[] {
  const a = AIRPORTS.find((x) => x.icao === icao)!;
  return preferredEnds(RUNWAY_MANIFEST[icao].flatMap((r) => r.ends), a.wind.dir, a.wind.kts);
}

/** src/app/page.tsx defaultWeights (05 §4.1 H3). */
function defaultWeights(lengthFt: number): WeightClass[] {
  if (lengthFt >= 10000) return ['L', 'M', 'H', 'S'];
  if (lengthFt >= 7500) return ['L', 'M', 'H'];
  if (lengthFt >= 5500) return ['L', 'M'];
  return ['L'];
}
/** src/app/_lib/airports.ts windComponents — head (negative = tail) / cross for a true runway heading. */
function windComponents(rwyHdgTrue: number, windDirTrue: number, windKts: number): { head: number; cross: number } {
  const d = ((windDirTrue - rwyHdgTrue + 540) % 360) - 180;
  const rad = (d * Math.PI) / 180;
  // `|| 0` folds -0 (calm wind on a westerly end) to 0: the DOM carries "0", never "-0"
  return { head: Math.round(windKts * Math.cos(rad)) || 0, cross: Math.round(Math.abs(windKts * Math.sin(rad))) || 0 };
}
const sanitiseRef = (ref: string) => ref.replace(/[^0-9A-Za-z]+/g, '-');
/** All end names of an airport in page order (manifest pair order, then end order). */
const endsOf = (icao: string) => RUNWAY_MANIFEST[icao].flatMap((r) => r.ends.map((e) => e.name));
const endByName = (icao: string, name: string) => RUNWAY_MANIFEST[icao].flatMap((r) => r.ends).find((e) => e.name === name)!;

test.describe('home: airport grid and detail', () => {
  test('H1 airport grid renders every airport card, no detail, no resume, no high score @smoke', async ({ home, page }) => {
    await home.goto();
    await expect(home.airportCards()).toHaveCount(AIRPORTS.length);
    for (let i = 0; i < AIRPORTS.length; i++) {
      const a = AIRPORTS[i];
      const card = home.airportCards().nth(i);
      await expect(card).toHaveAttribute('data-testid', `airport-card-${a.icao}`);
      await expect(card).toHaveAttribute('data-icao', a.icao);
      await expect(card).toHaveAttribute('aria-label', `${a.name}, ${a.city} (${a.icao})`);
      await expect(card).toContainText(a.name);
      await expect(card).toContainText(a.city);
    }
    await expect(home.detail()).toHaveCount(0);
    await expect(home.brand()).toBeVisible();
    await expect(home.settingsLink()).toBeVisible();
    await expect(home.resumeBtn()).toHaveCount(0);         // no session on the singleton
    await expect(home.highScore()).toHaveCount(0);         // high score 0 -> pill hidden
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();
  });

  test('H2 settings link and brand navigate @full', async ({ home, settings, page }) => {
    await home.goto();
    await home.settingsLink().click();
    await page.waitForURL(/\/settings$/);
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.resumeBtn()).toHaveCount(0);     // nothing to resume
    await settings.backLink().click();
    await page.waitForURL(/\/$/);
    await expect(home.root()).toHaveAttribute('data-ready', 'true');
    await expect(home.airportCards()).toHaveCount(AIRPORTS.length);
    // the brand on the home page is a home link too (stays on /)
    await home.brand().click();
    await expect(home.root()).toHaveAttribute('data-ready', 'true');
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('H3 select EGLL: detail view, one row per runway pair, every end on, weights by length @smoke', async ({ home }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    await expect(home.detailTitle()).toHaveText('Heathrow');
    await expect(home.airportCards()).toHaveCount(0);

    const pairs = RUNWAY_MANIFEST.EGLL;
    await expect(home.runwayRows()).toHaveCount(pairs.length);
    for (const p of pairs) {
      const row = home.runwayRow(sanitiseRef(p.ref));
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('data-ref', p.ref);
      await expect(row).toHaveAttribute('data-active', 'true');
      for (const e of p.ends) {
        // the into-wind end of each runway is on (westerlies: 27L / 27R), the reciprocal off
        const on = defaultEnds('EGLL').includes(e.name);
        await expect(home.runwayEnd(e.name)).toHaveAttribute('aria-pressed', on ? 'true' : 'false');
        expect(await home.weightsOn(e.name)).toEqual(defaultWeights(p.lengthFt));
        for (const w of WEIGHTS) if (on) await expect(home.weight(e.name, w)).toBeEnabled(); else await expect(home.weight(e.name, w)).toBeDisabled();
      }
    }
    expect((await home.activeEnds()).sort()).toEqual(defaultEnds('EGLL').sort());
    await expect(home.activeCount()).toContainText(String(defaultEnds('EGLL').length));

    // shift panel defaults: tower, normal (settings default), empty seed, sound on, voice off
    await expect(home.positionTab('tower')).toHaveAttribute('aria-pressed', 'true');
    await expect(home.positionTab('ground')).toHaveAttribute('aria-pressed', 'false');
    await expect(home.positionTab('approach')).toHaveAttribute('aria-pressed', 'false');
    await expect(home.difficultyTab('normal')).toHaveAttribute('aria-pressed', 'true');
    await expect(home.seedInput()).toHaveValue('');
    await expect(home.seedError()).toHaveCount(0);
    await expect(home.soundToggle()).toHaveAttribute('data-state', 'on');
    await expect(home.soundToggle()).toHaveAttribute('aria-checked', 'true');
    await expect(home.ttsToggle()).toHaveAttribute('data-state', 'off');
    await expect(home.ttsToggle()).toHaveAttribute('aria-checked', 'false');
    await expect(home.startBtn()).toBeEnabled();
    await expect(home.startHint()).toContainText('EGLL');
    await expect(home.startHint()).toContainText(/normal traffic/);
    await expect(home.startHint()).toContainText(/tower/);
    await expect(home.tip()).toBeVisible();
  });

  test('default weight classes follow runway length at every airport @full', async ({ home }) => {
    await home.goto();
    for (const a of AIRPORTS) {
      await home.pickAirport(a.icao);
      await expect(home.detailTitle()).toHaveText(a.name);
      const pairs = RUNWAY_MANIFEST[a.icao];
      await expect(home.runwayRows()).toHaveCount(pairs.length);
      await expect(home.runwayEnds()).toHaveCount(pairs.length * 2);
      const on = defaultEnds(a.icao);
      for (const p of pairs) {
        await expect(home.runwayRow(sanitiseRef(p.ref))).toHaveAttribute('data-active', p.ends.some((e) => on.includes(e.name)) ? 'true' : 'false');
        for (const e of p.ends) {
          await expect(home.runwayEnd(e.name)).toHaveAttribute('aria-pressed', on.includes(e.name) ? 'true' : 'false');
          expect(await home.weightsOn(e.name), `${a.icao} ${e.name} (${p.lengthFt} ft)`).toEqual(defaultWeights(p.lengthFt));
        }
      }
      await expect(home.activeCount()).toContainText(String(on.length));
      await expect(home.windDir()).toHaveValue(String(a.wind.dir).padStart(3, '0'));
      await expect(home.windKts()).toHaveValue(String(a.wind.kts));
      await home.changeAirport().click();
      await expect(home.airportCards()).toHaveCount(AIRPORTS.length);
    }
  });

  test('H4 change airport returns to the grid and resets the runway config @full', async ({ home }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    await home.toggleEnd('27L', false);
    await home.toggleWeight('27R', 'S', false);
    await home.pickPosition('approach');
    await home.changeAirport().click();
    await expect(home.detail()).toHaveCount(0);
    await expect(home.airportCards()).toHaveCount(AIRPORTS.length);

    await home.pickAirport('KLAX');
    await expect(home.detailTitle()).toHaveText('Los Angeles Intl');
    await expect(home.runwayRows()).toHaveCount(RUNWAY_MANIFEST.KLAX.length);
    for (const p of RUNWAY_MANIFEST.KLAX) await expect(home.runwayRow(sanitiseRef(p.ref))).toHaveAttribute('data-ref', p.ref);
    await expect(home.runwayEnd('25L')).toHaveAttribute('aria-pressed', 'true');
    await expect(home.runwayEnd('09L')).toHaveCount(0);

    // the detail is keyed by airport: coming back to EGLL starts from the defaults again
    await home.changeAirport().click();
    await home.pickAirport('EGLL');
    await expect(home.runwayEnd('27L')).toHaveAttribute('aria-pressed', 'true');
    await expect(home.weight('27R', 'S')).toHaveAttribute('aria-pressed', 'true');
    await expect(home.positionTab('tower')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('home: runway configuration', () => {
  test('H5 every runway end toggles off and on with aria-pressed, count and hint follow @full', async ({ home }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    const all = endsOf('EGLL');
    for (const end of all) await home.toggleEnd(end, true);   // start from every end on
    for (const end of all) {
      await home.toggleEnd(end);
      await expect(home.runwayEnd(end)).toHaveAttribute('aria-pressed', 'false');
      await expect(home.runwayEnd(end)).toHaveAttribute('aria-label', `Runway ${end} inactive`);
      // the weight chips of an inactive end are disabled but keep their state
      for (const w of WEIGHTS) {
        await expect(home.weight(end, w)).toBeDisabled();
        await expect(home.weight(end, w)).toHaveAttribute('aria-pressed', 'true');
      }
      expect(await home.activeEnds()).toEqual(all.filter((e) => e !== end));
      await expect(home.activeCount()).toContainText(String(all.length - 1));
      await expect(home.startHint()).not.toContainText(end);
      for (const other of all.filter((e) => e !== end)) await expect(home.startHint()).toContainText(other);
      await expect(home.startBtn()).toBeEnabled();

      await home.toggleEnd(end);
      await expect(home.runwayEnd(end)).toHaveAttribute('aria-pressed', 'true');
      await expect(home.runwayEnd(end)).toHaveAttribute('aria-label', `Runway ${end} active`);
      for (const w of WEIGHTS) await expect(home.weight(end, w)).toBeEnabled();
      expect(await home.activeEnds()).toEqual(all);
    }
    // a pair with both ends off is marked inactive as a row
    await home.toggleEnd('09L', false);
    await expect(home.runwayRow('09L-27R')).toHaveAttribute('data-active', 'true');
    await home.toggleEnd('27R', false);
    await expect(home.runwayRow('09L-27R')).toHaveAttribute('data-active', 'false');
    await expect(home.runwayRow('09R-27L')).toHaveAttribute('data-active', 'true');
  });

  test('H6 all ends off disables START; one end back re-enables it @full', async ({ home }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    for (const end of endsOf('EGLL')) await home.toggleEnd(end, false);
    expect(await home.activeEnds()).toEqual([]);
    await expect(home.activeCount()).toContainText('0');
    await expect(home.startBtn()).toBeDisabled();
    await expect(home.startHint()).toContainText(/switch on at least one runway end/i);
    for (const p of RUNWAY_MANIFEST.EGLL) await expect(home.runwayRow(sanitiseRef(p.ref))).toHaveAttribute('data-active', 'false');

    await home.toggleEnd('27L', true);
    await expect(home.startBtn()).toBeEnabled();
    await expect(home.startHint()).toContainText('EGLL');
    await expect(home.startHint()).toContainText('27L');
    await expect(home.runwayRow('09R-27L')).toHaveAttribute('data-active', 'true');
    await expect(home.runwayRow('09L-27R')).toHaveAttribute('data-active', 'false');
  });

  test('H7 every weight class toggles per end; other chips unchanged; order is kept @full', async ({ home }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    for (const end of endsOf('EGLL')) await home.toggleEnd(end, true);   // chips are enabled on active ends only
    for (const end of endsOf('EGLL')) {
      for (const w of WEIGHTS) {
        await home.toggleWeight(end, w);
        await expect(home.weight(end, w)).toHaveAttribute('aria-pressed', 'false');
        expect(await home.weightsOn(end)).toEqual(WEIGHTS.filter((x) => x !== w));
        // the other ends are untouched
        for (const other of endsOf('EGLL').filter((e) => e !== end)) expect(await home.weightsOn(other)).toEqual(WEIGHTS);
        await home.toggleWeight(end, w);
        await expect(home.weight(end, w)).toHaveAttribute('aria-pressed', 'true');
        expect(await home.weightsOn(end)).toEqual(WEIGHTS);
      }
      // removing two and adding one back keeps L M H S order (not click order)
      await home.toggleWeight(end, 'L', false);
      await home.toggleWeight(end, 'H', false);
      expect(await home.weightsOn(end)).toEqual(['M', 'S']);
      await home.toggleWeight(end, 'L', true);
      expect(await home.weightsOn(end)).toEqual(['L', 'M', 'S']);
      await home.toggleWeight(end, 'H', true);
      expect(await home.weightsOn(end)).toEqual(WEIGHTS);
      // every chip has a tooltip-friendly label
      await expect(home.weight(end, 'S')).toHaveAttribute('aria-label', `Super on ${end}`);
    }
    // an end may end up with no classes at all — START stays enabled (the end is still active)
    for (const w of WEIGHTS) await home.toggleWeight('27R', w, false);
    expect(await home.weightsOn('27R')).toEqual([]);
    await expect(home.runwayEnd('27R')).toHaveAttribute('aria-pressed', 'true');
    await expect(home.startBtn()).toBeEnabled();
  });

  test('wind preview: head / cross per end follow the wind inputs; "Into wind" picks the favoured ends @full', async ({ home }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    await expect(home.windDir()).toHaveValue('240');
    await expect(home.windKts()).toHaveValue('10');
    const check = async (dir: number, kts: number) => {
      for (const end of endsOf('EGLL')) {
        const want = windComponents(endByName('EGLL', end).hdg, dir, kts);
        expect(await home.windComponents(end), `${end} at ${dir}/${kts}`).toEqual(want);
        if (kts === 0) await expect(home.windPreview(end)).toHaveText('Calm');
        else await expect(home.windPreview(end)).toContainText(want.head < 0 ? `TW ${-want.head}` : `HW ${want.head}`);
      }
    };
    await check(240, 10);
    // 240/10 on the 27s: 9 kt head, 5 kt cross from the left; on the 09s: 9 kt tail
    expect(await home.windComponents('27R')).toEqual({ head: 9, cross: 5 });
    expect(await home.windComponents('09L')).toEqual({ head: -9, cross: 5 });
    await expect(home.windPreview('27R')).toContainText('XW 5 L');
    await expect(home.windPreview('09L')).toContainText('XW 5 R');

    // easterly: the 09 ends become the into-wind ends
    await home.setWind(90, 10);
    await check(90, 10);
    await home.applyWind();
    expect((await home.activeEnds()).sort()).toEqual(['09L', '09R']);
    await expect(home.runwayEnd('27L')).toHaveAttribute('aria-pressed', 'false');
    await expect(home.runwayEnd('27R')).toHaveAttribute('aria-pressed', 'false');
    await expect(home.activeCount()).toContainText('2');
    // switching all four back on then applying the default westerly picks the 27s
    await home.toggleEnd('27L', true);
    await home.toggleEnd('27R', true);
    await home.setWind(240, 10);
    await home.applyWind();
    expect((await home.activeEnds()).sort()).toEqual(['27L', '27R']);
    // "Into wind" never leaves a pair with both ends off (an off pair gets its favoured end back)
    await home.toggleEnd('27L', false);
    await home.applyWind();
    expect((await home.activeEnds()).sort()).toEqual(['27L', '27R']);
    await expect(home.startBtn()).toBeEnabled();

    // calm: every preview reads "Calm"
    await home.setWind(240, 0);
    await check(240, 0);
    // input hygiene: direction wraps modulo 360 and is zero-padded, speed is clamped to two digits, junk is rejected
    await home.windDir().fill('400');
    await home.windDir().press('Enter');
    await expect(home.windDir()).toHaveValue('040');
    await home.windKts().fill('150');           // the field keeps two digits -> 15
    await home.windKts().press('Enter');
    await expect(home.windKts()).toHaveValue('15');
    expect(await home.windComponents('09L')).toEqual(windComponents(endByName('EGLL', '09L').hdg, 40, 15));
    await home.windDir().fill('abc');           // non-digits are stripped; an empty commit keeps the previous value
    await home.windDir().press('Enter');
    await expect(home.windDir()).toHaveValue('040');
  });
});

test.describe('home: shift setup', () => {
  test('position and difficulty segmented controls mirror aria-pressed and the start hint @full', async ({ home }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    for (const p of ['ground', 'approach', 'tower'] as const) {
      await home.pickPosition(p);
      await expect(home.positionTab(p)).toHaveAttribute('aria-pressed', 'true');
      await expect(home.positionTab(p)).toHaveAttribute('aria-selected', 'true');
      await expect(home.positionTab(p)).toHaveAttribute('data-state', 'on');
      for (const o of (['ground', 'tower', 'approach'] as const).filter((x) => x !== p)) {
        await expect(home.positionTab(o)).toHaveAttribute('aria-pressed', 'false');
        await expect(home.positionTab(o)).toHaveAttribute('data-state', 'off');
      }
      await expect(home.startHint()).toContainText(new RegExp(`${p}$`));
    }
    for (const d of ['low', 'high', 'normal'] as const) {
      await home.pickDifficulty(d);
      await expect(home.difficultyTab(d)).toHaveAttribute('aria-pressed', 'true');
      for (const o of (['low', 'normal', 'high'] as const).filter((x) => x !== d)) await expect(home.difficultyTab(o)).toHaveAttribute('aria-pressed', 'false');
      await expect(home.startHint()).toContainText(`${d} traffic`);
    }
    // keyboard: the tablist moves with the arrow keys
    await home.difficultyTab('normal').focus();
    await home.page.keyboard.press('ArrowRight');
    await expect(home.difficultyTab('high')).toHaveAttribute('aria-pressed', 'true');
    await home.page.keyboard.press('ArrowRight');
    await expect(home.difficultyTab('low')).toHaveAttribute('aria-pressed', 'true');
  });

  test('difficulty defaults to the stored setting @full', async ({ home, page }) => {
    await seedSettings(page, { difficulty: 'high' });
    await home.goto();
    await home.pickAirport('EGLL');
    await expect(home.difficultyTab('high')).toHaveAttribute('aria-pressed', 'true');
    await expect(home.startHint()).toContainText('high traffic');
  });

  test('seed validation: whole non-negative numbers only; invalid seeds block START @full', async ({ home }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    const bad = ['-1', '1.5', 'abc', '12x'];
    for (const v of bad) {
      await home.setSeedRaw(v);
      await expect(home.seedError(), `seed "${v}"`).toBeVisible();
      await expect(home.seedError()).toHaveText('Whole number');
      await expect(home.seedInput()).toHaveAttribute('aria-invalid', 'true');
      await expect(home.startBtn()).toBeDisabled();
    }
    for (const v of ['42', '0', '', '  7 ']) {
      await home.setSeedRaw(v);
      await expect(home.seedError(), `seed "${v}"`).toHaveCount(0);
      await expect(home.seedInput()).not.toHaveAttribute('aria-invalid', 'true');
      await expect(home.startBtn()).toBeEnabled();
    }
  });

  test('sound and pilot-voice toggles persist to the settings blob and its mirrors, survive reload @full', async ({ home, settings, page }) => {
    await home.goto();
    await home.pickAirport('EGLL');
    await home.soundToggle().click();
    await expect(home.soundToggle()).toHaveAttribute('data-state', 'off');
    await expect(home.soundToggle()).toHaveAttribute('aria-checked', 'false');
    await home.ttsToggle().click();
    await expect(home.ttsToggle()).toHaveAttribute('data-state', 'on');
    await expect(home.ttsToggle()).toHaveAttribute('aria-checked', 'true');
    const blob = await readLocalStorageJson<Partial<Settings>>(page, LS_KEYS.settings);
    expect(blob?.sound).toBe(false);
    expect(blob?.tts).toBe(true);
    expect(await readLocalStorage(page, LS_KEYS.tts)).toBe('1');

    await page.reload();
    await expect(home.root()).toHaveAttribute('data-ready', 'true');
    await home.pickAirport('EGLL');
    await expect(home.soundToggle()).toHaveAttribute('data-state', 'off');
    await expect(home.ttsToggle()).toHaveAttribute('data-state', 'on');
    // the settings page reads the same store
    await home.settingsLink().click();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.sound()).toHaveAttribute('data-state', 'off');
    await expect(settings.tts()).toHaveAttribute('data-state', 'on');
    // and the label click toggles too (Toggle label is clickable)
    await settings.backLink().click();
    await home.pickAirport('EGLL');
    await home.ttsToggle().click();
    await expect(home.ttsToggle()).toHaveAttribute('data-state', 'off');
    expect(await readLocalStorage(page, LS_KEYS.tts)).toBe('0');
  });
});

test.describe('home: start and boot', () => {
  test('H8 START boots /play with the exact config: ends, weights, position, difficulty, seed, spawns @smoke', async ({ home, game, sim, page }) => {
    await home.goto({ testMode: { spawn: 'default' } });
    await home.pickAirport('EGLL');
    // westerlies only; 27R medium + heavy only; 27L no supers
    await home.toggleEnd('09L', false);
    await home.toggleEnd('09R', false);
    await home.toggleWeight('27R', 'L', false);
    await home.toggleWeight('27R', 'S', false);
    await home.toggleWeight('27L', 'S', false);
    await home.pickPosition('approach');
    await home.pickDifficulty('high');
    await home.setSeed(123);
    await expect(home.startHint()).toContainText('EGLL');
    await expect(home.startHint()).toContainText(/high traffic/);
    await expect(home.startHint()).toContainText(/approach$/);

    await home.start();
    await game.waitReady();
    expect(new URL(page.url()).pathname).toBe('/play');
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();       // one-shot consumed

    // shell reflects the chosen position
    await expect(game.airportBadge()).toHaveText('EGLL');
    await expect(game.shell()).toHaveAttribute('data-mode', 'approach');
    await expect(game.modeTab('approach')).toHaveAttribute('aria-selected', 'true');
    await expect(game.radarCanvas()).toBeVisible();

    // store + engine got every field
    const st = await sim.storeState();
    expect(st.testMode).toBe(true);
    expect(st.seed).toBe(123);
    expect(st.position).toBe('approach');
    expect(st.icao).toBe('EGLL');
    expect(st.settings.difficulty).toBe('high');
    expect(st.lastConfig?.ends?.slice().sort()).toEqual(['27L', '27R']);
    expect(st.lastConfig?.weights).toEqual({ '27R': ['M', 'H'], '27L': ['L', 'M', 'H'] });
    expect(st.lastConfig?.difficulty).toBe('high');
    expect((await readLocalStorageJson<Partial<Settings>>(page, LS_KEYS.settings))?.difficulty).toBe('high');
    const rws = await sim.runways();
    expect(rws.filter((r) => r.active).map((r) => r.name).sort()).toEqual(['27L', '27R']);
    expect(rws.find((r) => r.name === '27R')?.weights).toEqual(['M', 'H']);
    expect(rws.find((r) => r.name === '27L')?.weights).toEqual(['L', 'M', 'H']);
    expect(rws.find((r) => r.name === '09L')?.weights).toBeNull();
    expect(rws.find((r) => r.name === '09R')?.active).toBe(false);
    await expect(game.radioLines('SYS').first()).toContainText(/test mode · seed 123/);

    // the seeded spawns respect the config: only the active ends, and the class allowed on that end
    const snap = await sim.snapshot();
    expect(snap.icao).toBe('EGLL');
    expect(snap.stats.total).toBe(7);
    const allow: Record<string, WeightClass[]> = { '27R': ['M', 'H'], '27L': ['L', 'M', 'H'] };
    for (const a of snap.aircraft) {
      expect(['27L', '27R'], `${a.callsign} planned runway ${a.plan.runway}`).toContain(a.plan.runway);
      const full = await sim.state(a.callsign);
      expect(full, a.callsign).not.toBeNull();
      expect(allow[a.plan.runway!], `${a.callsign} (${full!.perf.weightClass}) on ${a.plan.runway}`).toContain(full!.perf.weightClass);
    }
    // time only moves through the test API
    const t0 = await sim.time();
    await sim.advance(5);
    expect(await sim.time()).toBeCloseTo(t0 + 5, 1);
  });

  test('H9 the start config is one-shot: reloading /play boots the default config (every end active) @full', async ({ home, game, sim, page }) => {
    await home.goto({ testMode: { spawn: 'none', seed: 7 } });
    await home.pickAirport('EGLL');
    await home.toggleEnd('09L', false);
    await home.toggleEnd('09R', false);
    await home.toggleWeight('27R', 'S', false);
    await home.start();
    await game.waitReady();
    expect((await sim.runways()).filter((r) => r.active).map((r) => r.name).sort()).toEqual(['27L', '27R']);
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();

    // a hard reload has no one-shot config and no singleton: plain /play boots EGLL live with every end active
    await page.reload();
    await game.waitReady({ test: false });
    expect(new URL(page.url()).pathname).toBe('/play');
    const st = await sim.storeState();
    expect(st.hasEngine).toBe(true);
    expect(st.icao).toBe('EGLL');
    expect(st.testMode).toBe(false);
    expect(st.lastConfig?.ends ?? []).toEqual([]);
    expect(st.runways?.every((r) => r.active && r.weights === null)).toBe(true);
    expect(st.runways?.map((r) => r.name).sort()).toEqual(endsOf('EGLL').sort());
    await expect(game.airportBadge()).toHaveText('EGLL');
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();
  });

  for (const a of AIRPORTS) {
    test(`H10 ${a.icao} starts from the home page and boots with the into-wind ends active @full`, async ({ home, game, sim, page }) => {
      await home.goto({ testMode: { spawn: 'default', seed: 7 } });
      await home.pickAirport(a.icao);
      await expect(home.detailTitle()).toHaveText(a.name);
      await home.start();
      await game.waitReady();
      await expect(game.airportBadge()).toHaveText(a.icao);
      const snap = await sim.snapshot();
      expect(snap.icao).toBe(a.icao);
      expect(snap.stats.total).toBeGreaterThan(0);
      expect(snap.stats.dep + snap.stats.arr).toBe(snap.stats.total);
      // every end the home page offers exists in the engine; the ends on by default (the family in use for the
      // prevailing wind) are active, the rest inactive with no weight config - as is an OSM runway the manifest leaves
      // out (KBOS 15L/33R, 2,500 ft)
      const rws = await sim.runways();
      const names = rws.map((r) => r.name);
      const offered = endsOf(a.icao), on = defaultEnds(a.icao);
      expect(on.length).toBeGreaterThan(0);
      for (const end of offered) expect(names, `${a.icao}: home end ${end} unknown to the engine`).toContain(end);
      for (const r of rws) expect(r.active, `${a.icao} ${r.name} active`).toBe(on.includes(r.name));
      // the page's default weight classes (by runway length) are what the engine allows on each active end
      for (const p of RUNWAY_MANIFEST[a.icao]) for (const e of p.ends) {
        if (on.includes(e.name)) expect(rws.find((r) => r.name === e.name)?.weights, `${a.icao} ${e.name} weights`).toEqual(defaultWeights(p.lengthFt));
      }
      for (const r of rws.filter((r) => !on.includes(r.name))) expect(r.weights, `${a.icao} ${r.name} (not active)`).toBeNull();
      const st = await sim.storeState();
      expect(st.lastConfig?.ends?.slice().sort()).toEqual(on.slice().sort());
      expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();
      // the shift is live in the singleton: the home page now offers "Resume shift"
      await sim.advance(2);
      expect(await sim.time()).toBeGreaterThanOrEqual(2);
    });
  }

  test('resume shift: leaving keeps the engine; "Resume shift" / "Back to shift" return to the same session @full', async ({ home, game, sim, settings, page }) => {
    await home.goto({ testMode: { spawn: 'none', seed: 7 } });
    await home.pickAirport('EGLL');
    await home.toggleEnd('09R', true);
    await home.start();
    await game.waitReady();
    await sim.advance(30);
    const t = await sim.time();
    const lines = await game.radioLines().count();
    const cfg = (await sim.storeState()).lastConfig;

    // brand -> leave confirm; "Stay" keeps the page
    await game.brand().click();
    await expect(page.getByTestId('home-leave-confirm')).toBeVisible();
    await page.getByTestId('home-leave-confirm-no').click();
    await expect(page.getByTestId('home-leave-confirm')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/play');
    // "Leave" -> home with the session still on the singleton
    await game.brand().click();
    await page.getByTestId('home-leave-confirm-yes').click();
    await page.waitForURL(/\/$/);
    await expect(home.root()).toHaveAttribute('data-ready', 'true');
    await expect(home.resumeBtn()).toBeVisible();
    expect(await sim.hasLiveEngine()).toBe(true);
    expect(await readLocalStorage(page, LS_KEYS.startConfig)).toBeNull();

    await home.resumeBtn().click();
    await page.waitForURL(/\/play(\?.*)?$/);
    await game.waitReady();
    expect(await sim.time()).toBeCloseTo(t, 1);                   // same engine, not rebuilt
    expect((await sim.storeState()).lastConfig).toEqual(cfg);
    expect((await sim.runways()).filter((r) => r.active).map((r) => r.name).sort()).toEqual(['09R', '27L', '27R']);
    await expect(game.radioLines()).toHaveCount(lines);            // the log survived
    await sim.advance(1);
    expect(await sim.time()).toBeCloseTo(t + 1, 1);

    // settings "Back to shift · EGLL" resumes as well
    await game.brand().click();
    await page.getByTestId('home-leave-confirm-yes').click();
    await page.waitForURL(/\/$/);
    await home.settingsLink().click();
    await expect(settings.root()).toHaveAttribute('data-ready', 'true');
    await expect(settings.resumeBtn()).toBeVisible();
    await expect(settings.resumeBtn()).toContainText('EGLL');
    await settings.resumeBtn().click();
    await page.waitForURL(/\/play(\?.*)?$/);
    await game.waitReady();
    expect(await sim.time()).toBeCloseTo(t + 1, 1);
    await expect(game.airportBadge()).toHaveText('EGLL');
  });
});

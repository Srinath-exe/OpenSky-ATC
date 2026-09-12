/*
  Home page object (`/`, src/app/page.tsx). Test ids follow the code (see tests/e2e/testids.txt):
    page-home, nav-brand, home-settings-link, home-resume, home-highscore,
    airport-card-{ICAO}, home-detail, home-detail-title, home-change-airport, home-active-count,
    rwy-row-{ref}, rwy-end-{end} (aria-pressed), rwy-weight-{end}-{L|M|H|S} (aria-pressed), rwy-wind-{end},
    home-wind-dir, home-wind-kts, home-wind-apply,
    home-position (Segmented: home-position-{ground|tower|approach}), home-difficulty (home-difficulty-{low|normal|high}),
    home-seed, home-sound, home-tts, home-start, home-start-hint, home-tip.
*/
import { expect, type Locator, type Page } from '@playwright/test';
import { LS_KEYS } from '../fixtures/storage';

export type WeightClass = 'L' | 'M' | 'H' | 'S';
export type Position = 'ground' | 'tower' | 'approach';
export type Difficulty = 'low' | 'normal' | 'high';

export interface HomeGotoOptions {
  /**
   * Make the shift started from this page boot in deterministic test mode: the one-shot start config the
   * home page writes is patched (before the app reads it) with { test: true, seed, spawn }. The /play route
   * honours `stored.test`, so the game comes up with window.__atcTest installed and no RAF loop while
   * keeping every runway / weight / position choice made on the page.
   */
  testMode?: { seed?: number; spawn?: 'none' | 'default' };
}

export class HomePage {
  constructor(readonly page: Page) {}

  root = () => this.page.getByTestId('page-home');
  brand = () => this.page.getByTestId('nav-brand');
  settingsLink = () => this.page.getByTestId('home-settings-link');
  resumeBtn = () => this.page.getByTestId('home-resume');
  highScore = () => this.page.getByTestId('home-highscore');
  airportCards = () => this.page.locator('[data-testid^="airport-card-"]');
  airportCard = (icao: string) => this.page.getByTestId(`airport-card-${icao}`);
  detail = () => this.page.getByTestId('home-detail');
  detailTitle = () => this.page.getByTestId('home-detail-title');
  changeAirport = () => this.page.getByTestId('home-change-airport');
  activeCount = () => this.page.getByTestId('home-active-count');
  runwayRows = () => this.page.locator('[data-testid^="rwy-row-"]');
  runwayRow = (ref: string) => this.page.getByTestId(`rwy-row-${ref}`);
  runwayEnds = () => this.page.locator('[data-testid^="rwy-end-"]');
  runwayEnd = (end: string) => this.page.getByTestId(`rwy-end-${end}`);
  weight = (end: string, w: WeightClass) => this.page.getByTestId(`rwy-weight-${end}-${w}`);
  windDir = () => this.page.getByTestId('home-wind-dir');
  windKts = () => this.page.getByTestId('home-wind-kts');
  windApply = () => this.page.getByTestId('home-wind-apply');
  positionTab = (p: Position) => this.page.getByTestId(`home-position-${p}`);
  difficultyTab = (d: Difficulty) => this.page.getByTestId(`home-difficulty-${d}`);
  seedInput = () => this.page.getByTestId('home-seed');
  soundToggle = () => this.page.getByTestId('home-sound');
  ttsToggle = () => this.page.getByTestId('home-tts');
  startBtn = () => this.page.getByTestId('home-start');
  startHint = () => this.page.getByTestId('home-start-hint');
  tip = () => this.page.getByTestId('home-tip');
  shiftPanel = () => this.page.getByTestId('home-shift');
  runwaysPanel = () => this.page.getByTestId('home-runways');
  /** Head / cross wind preview chip of an end (`data-head`, `data-cross`; text "Calm" at 0 kt). */
  windPreview = (end: string) => this.page.getByTestId(`rwy-wind-${end}`);
  /** The seed input's inline error (`role=alert` inside the Input wrapper). */
  seedError = () => this.page.getByTestId('home-seed-wrap').locator('..').getByRole('alert');

  /** Open `/` and wait for hydration (`page-home[data-ready="true"]`). */
  async goto(opts: HomeGotoOptions = {}): Promise<void> {
    if (opts.testMode) await this.installStartConfigPatch(opts.testMode);
    await this.page.goto('/');
    await expect(this.root()).toHaveAttribute('data-ready', 'true');
  }

  private async installStartConfigPatch(tm: { seed?: number; spawn?: 'none' | 'default' }): Promise<void> {
    await this.page.addInitScript(([key, patch]) => {
      const proto = Object.getPrototypeOf(window.localStorage) as Storage;
      const orig = proto.setItem;
      proto.setItem = function (this: Storage, k: string, v: string) {
        if (k === key) {
          try {
            const cfg = JSON.parse(v) as Record<string, unknown>;
            v = JSON.stringify({ ...cfg, test: true, ...(patch.seed != null ? { seed: patch.seed } : {}), ...(patch.spawn ? { spawn: patch.spawn } : {}) });
          } catch { /* leave as-is */ }
        }
        return orig.call(this, k, v);
      };
    }, [LS_KEYS.startConfig, tm] as const);
  }

  /** Click an airport card and wait for the detail view. */
  async pickAirport(icao: string): Promise<void> {
    await this.airportCard(icao).click();
    await expect(this.detail()).toBeVisible();
    await expect(this.detail()).toHaveAttribute('data-icao', icao);
  }

  async isEndOn(end: string): Promise<boolean> {
    return (await this.runwayEnd(end).getAttribute('aria-pressed')) === 'true';
  }
  /** Toggle a runway end; with `on` given, only click when the state differs. */
  async toggleEnd(end: string, on?: boolean): Promise<void> {
    if (on != null && (await this.isEndOn(end)) === on) return;
    const want = on ?? !(await this.isEndOn(end));
    await this.runwayEnd(end).click();
    await expect(this.runwayEnd(end)).toHaveAttribute('aria-pressed', want ? 'true' : 'false');
  }
  async isWeightOn(end: string, w: WeightClass): Promise<boolean> {
    return (await this.weight(end, w).getAttribute('aria-pressed')) === 'true';
  }
  /** Toggle a weight class on an end; with `on` given, only click when the state differs. */
  async toggleWeight(end: string, w: WeightClass, on?: boolean): Promise<void> {
    if (on != null && (await this.isWeightOn(end, w)) === on) return;
    const want = on ?? !(await this.isWeightOn(end, w));
    await this.weight(end, w).click();
    await expect(this.weight(end, w)).toHaveAttribute('aria-pressed', want ? 'true' : 'false');
  }
  /** Names of the ends currently switched on, in page order. */
  async activeEnds(): Promise<string[]> {
    const ends = this.runwayEnds();
    const n = await ends.count();
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const el = ends.nth(i);
      if ((await el.getAttribute('aria-pressed')) === 'true') out.push((await el.getAttribute('data-testid'))!.replace('rwy-end-', ''));
    }
    return out;
  }
  pickPosition(p: Position) { return this.positionTab(p).click(); }
  pickDifficulty(d: Difficulty) { return this.difficultyTab(d).click(); }
  setSeed(seed: number | '') { return this.seedInput().fill(seed === '' ? '' : String(seed)); }
  /** Type raw text into the seed input (validation cases: '-1', '1.5', 'abc'). */
  setSeedRaw(text: string) { return this.seedInput().fill(text); }
  /** Weight classes switched on for an end, in L M H S order. */
  async weightsOn(end: string): Promise<WeightClass[]> {
    const out: WeightClass[] = [];
    for (const w of ['L', 'M', 'H', 'S'] as WeightClass[]) if (await this.isWeightOn(end, w)) out.push(w);
    return out;
  }
  /** Head / cross components the page previews for an end. */
  async windComponents(end: string): Promise<{ head: number; cross: number }> {
    const el = this.windPreview(end);
    return { head: Number(await el.getAttribute('data-head')), cross: Number(await el.getAttribute('data-cross')) };
  }
  /** Set the wind preview (direction true / knots); each field commits on Enter. */
  async setWind(dir: number, kts: number): Promise<void> {
    await this.windDir().fill(String(dir).padStart(3, '0'));
    await this.windDir().press('Enter');
    await this.windKts().fill(String(kts));
    await this.windKts().press('Enter');
    await expect(this.windDir()).toHaveValue(String(((dir % 360) + 360) % 360).padStart(3, '0'));
    await expect(this.windKts()).toHaveValue(String(Math.max(0, Math.min(99, kts))));
  }
  /** "Into wind": switch on the into-wind end of every pair, off the other. */
  applyWind() { return this.windApply().click(); }

  /** Click START and wait for the /play route to hydrate (`page-atc[data-ready="true"]`). */
  async start(): Promise<void> {
    await expect(this.startBtn()).toBeEnabled();
    await this.startBtn().click();
    await this.page.waitForURL(/\/play(\?.*)?$/);
    await expect(this.page.getByTestId('page-atc')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  }
}

/*
  Settings page object (`/settings`, src/app/settings/page.tsx). Test ids (see tests/e2e/testids.txt):
    page-settings, set-home (brand), set-back, set-resume,
    set-section-{simulation|display|audio|data|about},
    toggles (role=switch, aria-checked, data-state="on|off"): set-autotower, set-autoground, set-auto-handoff,
      set-strict-frequencies, set-readback-errors, set-instant-vectors, set-typed-instant, set-show-rings,
      set-reduced-motion, set-sound, set-tts,
    selects: set-emergency-rate, set-pilot-delay, set-phraseology,
    segmented: set-difficulty (set-difficulty-{low|normal|high}), set-datablock,
    set-theme-satellite / set-theme-chart (aria-pressed), set-volume (range) + set-volume-value[data-value],
    set-highscore[data-value], set-reset-score, set-history / set-history-{i} / set-history-empty, set-clear-history,
    set-reset-all, set-reset-tips, set-version.
*/
import { expect, type Locator, type Page } from '@playwright/test';

export type ToggleId =
  | 'set-autotower' | 'set-autoground' | 'set-autoapproach' | 'set-auto-handoff' | 'set-strict-frequencies' | 'set-readback-errors'
  | 'set-instant-vectors' | 'set-typed-instant' | 'set-show-rings' | 'set-reduced-motion' | 'set-sound' | 'set-tts';
export type SelectId = 'set-emergency-rate' | 'set-pilot-delay' | 'set-phraseology';

export class SettingsPage {
  constructor(readonly page: Page) {}

  root = () => this.page.getByTestId('page-settings');
  homeLink = () => this.page.getByTestId('set-home');
  backLink = () => this.page.getByTestId('set-back');
  resumeBtn = () => this.page.getByTestId('set-resume');
  section = (id: 'simulation' | 'display' | 'audio' | 'data' | 'about') => this.page.getByTestId(`set-section-${id}`);
  toggle = (id: ToggleId) => this.page.getByTestId(id);
  autoTower = () => this.toggle('set-autotower');
  tts = () => this.toggle('set-tts');
  sound = () => this.toggle('set-sound');
  theme = (t: 'satellite' | 'chart') => this.page.getByTestId(`set-theme-${t}`);
  difficulty = (d: 'low' | 'normal' | 'high') => this.page.getByTestId(`set-difficulty-${d}`);
  emergencyRate = () => this.page.getByTestId('set-emergency-rate');
  pilotDelay = () => this.page.getByTestId('set-pilot-delay');
  phraseology = () => this.page.getByTestId('set-phraseology');
  volume = () => this.page.getByTestId('set-volume');
  volumeValue = () => this.page.getByTestId('set-volume-value');
  highScore = () => this.page.getByTestId('set-highscore');
  resetScore = () => this.page.getByTestId('set-reset-score');
  history = () => this.page.getByTestId('set-history');
  historyEmpty = () => this.page.getByTestId('set-history-empty');
  clearHistory = () => this.page.getByTestId('set-clear-history');
  resetAll = () => this.page.getByTestId('set-reset-all');
  version = () => this.page.getByTestId('set-version');
  historyRow = (i: number) => this.page.getByTestId(`set-history-${i}`);
  historyRows = () => this.page.locator('[data-testid^="set-history-"][data-score]');
  datablock = (d: 'compact' | 'normal' | 'full') => this.page.getByTestId(`set-datablock-${d}`);
  /** Credit rows: `set-credit-{slug}` (slug = title lower-cased, non-alphanumerics -> '-'). */
  credit = (slug: string) => this.page.getByTestId(`set-credit-${slug}`);
  credits = () => this.page.locator('[data-testid^="set-credit-"]');
  /** Open menu of a Select (`{id}-menu`, role=listbox with role=option rows). */
  selectMenu = (id: SelectId) => this.page.getByTestId(`${id}-menu`);

  /** Open `/settings` and wait for hydration. */
  async goto(): Promise<void> {
    await this.page.goto('/settings');
    await expect(this.root()).toHaveAttribute('data-ready', 'true');
  }

  /** Boolean state of a toggle from `data-state` (StateMirror) with `aria-checked` as fallback. */
  async isOn(id: ToggleId): Promise<boolean> {
    const el = this.toggle(id);
    const ds = await el.getAttribute('data-state');
    if (ds === 'on' || ds === 'off') return ds === 'on';
    return (await el.getAttribute('aria-checked')) === 'true';
  }
  /** Set a toggle to `on` (no-op when already there). */
  async setToggle(id: ToggleId, on: boolean): Promise<void> {
    if ((await this.isOn(id)) === on) return;
    await this.toggle(id).click();
    await expect(this.toggle(id)).toHaveAttribute('data-state', on ? 'on' : 'off');
  }
  async pickTheme(t: 'satellite' | 'chart'): Promise<void> {
    await this.theme(t).click();
    await expect(this.theme(t)).toHaveAttribute('aria-pressed', 'true');
  }
  async highScoreValue(): Promise<number> {
    return Number((await this.highScore().getAttribute('data-value')) ?? '0');
  }
  /** Segmented value from `aria-pressed` of the items (`{id}-{item}`). */
  async segmentedValue(id: 'set-difficulty' | 'set-datablock'): Promise<string | null> {
    const items = this.page.locator(`[data-testid^="${id}-"][role="tab"]`);
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const el = items.nth(i);
      if ((await el.getAttribute('aria-pressed')) === 'true') return (await el.getAttribute('data-testid'))!.slice(id.length + 1);
    }
    return null;
  }
  async pickSegmented(id: 'set-difficulty' | 'set-datablock', item: string): Promise<void> {
    const el = this.page.getByTestId(`${id}-${item}`);
    await el.click();
    await expect(el).toHaveAttribute('aria-pressed', 'true');
  }
  /** Label shown on a Select trigger (the design Select mirrors no data-value; the label is the product text). */
  async selectLabel(id: SelectId): Promise<string> {
    return ((await this.page.getByTestId(id).textContent()) ?? '').trim();
  }
  /** Open a Select and pick the option whose label matches; waits for the trigger to show it. */
  async pickSelect(id: SelectId, label: string | RegExp): Promise<void> {
    const trigger = this.page.getByTestId(id);
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = this.selectMenu(id);
    await expect(menu).toBeVisible();
    await menu.getByRole('option', { name: label }).first().click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
  /** Drive the volume range input (0-100 in steps of 5) and wait for the mirror value. */
  async setVolume(pct: number): Promise<void> {
    await this.volume().fill(String(pct));
    await expect(this.volumeValue()).toHaveAttribute('data-value', String(pct));
  }
  async volumePct(): Promise<number> {
    return Number((await this.volumeValue().getAttribute('data-value')) ?? '-1');
  }
  expectVisible(l: Locator) { return expect(l).toBeVisible(); }
}

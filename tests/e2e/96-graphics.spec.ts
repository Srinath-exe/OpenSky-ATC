/*
  Graphics quality (src/components/atc/WorldMap/quality.ts): the Settings "Graphics" section pins a tier for the 3D
  map (its own persisted key, skycontrol_graphics), and the map reports the tier it runs at (`data-quality`) with the
  passes the preset asks for. The 3D world is forced with ?world=3d (test mode keeps the 2D map otherwise) and runs the
  lite path (software GL in CI); ?quality= overrides the persisted pin for a run.
*/
import { test, expect } from './fixtures/test';
import { readLocalStorageJson } from './fixtures/storage';

const APP = { icao: 'KSFO', spawn: 'none', position: 'ground' } as const;

test.describe('graphics quality', () => {
  test('settings pins a tier and persists it; the pin survives a reload @full', async ({ openGame, game, page }) => {
    await openGame(APP);
    await game.settingsBtn().click();
    const section = page.getByTestId('graphics-section');
    await expect(section).toBeVisible();
    await expect(page.getByTestId('gfx-auto')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('gfx-low').click();
    await expect(page.getByTestId('gfx-low')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('skycontrol_graphics'))).toBe('low');
    await page.reload();
    await game.waitReady();
    await game.settingsBtn().click();
    await expect(page.getByTestId('gfx-low')).toHaveAttribute('aria-pressed', 'true');
    // the Settings blob itself is untouched by the pin
    const settings = await readLocalStorageJson<Record<string, unknown> | null>(page, 'skycontrol_settings');
    expect(settings && 'graphics' in settings).toBeFalsy();
  });

  test('the 3D map runs the pinned tier: low drops the depth-of-field and FXAA passes, medium keeps them; a live switch applies without a reload @full', async ({ openGame, game, page }) => {
    await openGame(APP);
    await page.goto(page.url() + '&world=3d&quality=low');
    const map = page.getByTestId('world-map');
    await expect(map).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
    await expect(map).toHaveAttribute('data-quality', 'low');
    type Stats = { tier: string; bokeh: boolean; fxaa: boolean; dpr: number; detected: string };
    const stats = () => page.evaluate(() => (window as unknown as { __worldStats: () => Stats }).__worldStats());
    await expect.poll(async () => (await stats()).bokeh).toBe(false);
    expect((await stats()).fxaa).toBe(false);
    expect(['low', 'medium', 'high']).toContain((await stats()).detected);
    // the full path (nolite) on the medium tier keeps both passes
    await page.goto(page.url().replace('&quality=low', '') + '&nolite=1&quality=medium');
    await expect(map).toHaveAttribute('data-status', 'ready', { timeout: 120_000 });
    await expect(map).toHaveAttribute('data-quality', 'medium');
    await expect.poll(async () => (await stats()).bokeh).toBe(true);
    expect((await stats()).fxaa).toBe(true);
    // live switch from the settings section (no reload): the map re-reports the tier and drops the passes
    await game.settingsBtn().click();
    await page.getByTestId('gfx-low').click();
    await expect(map).toHaveAttribute('data-quality', 'low');
    await expect.poll(async () => (await stats()).bokeh).toBe(false);
  });
});

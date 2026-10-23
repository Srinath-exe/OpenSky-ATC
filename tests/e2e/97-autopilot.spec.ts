/* Autopilot (NavBar): one click puts the AI on both sectors (the sector chips flip to AI); the position
   tabs show the AI dot; a second click hands everything back. The sector chips hand over one sector at a time. */
import { test, expect } from './fixtures/test';

test('autopilot button switches every AI position on and off @full', async ({ openGame, page }) => {
  await openGame({ icao: 'KSFO', spawn: 'none', position: 'tower' });
  const btn = page.getByTestId('nav-autopilot');
  await expect(btn).toHaveAttribute('data-state', 'off');
  await btn.click();
  await expect(btn).toHaveAttribute('data-state', 'on');
  expect(await page.evaluate(() => { const s = window.__atcSim!.settings; return [s.autoApproach, s.autoTower, s.autoGround, s.autoMode]; })).toEqual([true, true, true, false]);
  for (const c of ['airfield', 'approach']) await expect(page.getByTestId(`sector-${c}`)).toHaveAttribute('data-state', 'ai');
  for (const p of ['ground', 'tower', 'approach']) await expect(page.getByTestId(`mode-tab-${p}`)).toHaveAttribute('data-ai', 'true');
  await btn.click();
  await expect(btn).toHaveAttribute('data-state', 'off');
  expect(await page.evaluate(() => { const s = window.__atcSim!.settings; return [s.autoApproach, s.autoTower, s.autoGround]; })).toEqual([false, false, false]);
  await expect(page.getByTestId('mode-tab-tower')).toHaveAttribute('data-ai', 'false');
});

test('sector chips: airfield (ground + tower) and approach go to the AI independently @full', async ({ openGame, page }) => {
  await openGame({ icao: 'KJFK', spawn: 'none', position: 'tower' });
  const settingsOf = () => page.evaluate(() => { const s = window.__atcSim!.settings; return [s.autoGround, s.autoTower, s.autoApproach]; });
  await page.getByTestId('sector-approach').click();
  await expect(page.getByTestId('sector-approach')).toHaveAttribute('data-state', 'ai');
  expect(await settingsOf()).toEqual([false, false, true]);
  await expect(page.getByTestId('mode-tab-approach')).toHaveAttribute('data-ai', 'true');
  await expect(page.getByTestId('mode-tab-ground')).toHaveAttribute('data-ai', 'false');
  await page.getByTestId('sector-approach').click();
  await page.getByTestId('sector-airfield').click();
  expect(await settingsOf()).toEqual([true, true, false]);
  for (const p of ['ground', 'tower']) await expect(page.getByTestId(`mode-tab-${p}`)).toHaveAttribute('data-ai', 'true');
  await expect(page.getByTestId('mode-tab-approach')).toHaveAttribute('data-ai', 'false');
});

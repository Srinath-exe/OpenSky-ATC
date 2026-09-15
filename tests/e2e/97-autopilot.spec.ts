/* Autopilot (NavBar): one click puts the AI on every position (Settings → AI assist switches all on); the position
   tabs show the AI dot; a second click hands everything back. */
import { test, expect } from './fixtures/test';

test('autopilot button switches every AI position on and off @full', async ({ openGame, page }) => {
  await openGame({ icao: 'KSFO', spawn: 'none', position: 'tower' });
  const btn = page.getByTestId('nav-autopilot');
  await expect(btn).toHaveAttribute('data-state', 'off');
  await btn.click();
  await expect(btn).toHaveAttribute('data-state', 'on');
  expect(await page.evaluate(() => { const s = window.__atcSim!.settings; return [s.autoApproach, s.autoTower, s.autoGround, s.autoMode]; })).toEqual([true, true, true, true]);
  for (const p of ['ground', 'tower', 'approach']) await expect(page.getByTestId(`mode-tab-${p}`)).toHaveAttribute('data-ai', 'true');
  await btn.click();
  await expect(btn).toHaveAttribute('data-state', 'off');
  expect(await page.evaluate(() => { const s = window.__atcSim!.settings; return [s.autoApproach, s.autoTower, s.autoGround]; })).toEqual([false, false, false]);
  await expect(page.getByTestId('mode-tab-tower')).toHaveAttribute('data-ai', 'false');
});

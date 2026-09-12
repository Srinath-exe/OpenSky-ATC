/*
  localStorage seeding helpers. Keys mirror src/components/atc/persist.ts (PERSIST_KEYS) and the
  legacy single-value mirrors in src/app/_lib/persist.ts (LS). Everything is applied through
  `page.addInitScript`, i.e. BEFORE the app's first script runs, so call these before `goto`.
*/
import type { Page } from '@playwright/test';

export const LS_KEYS = {
  settings: 'skycontrol_settings',
  highScore: 'skycontrol_high_score',
  startConfig: 'skycontrol_start_config',
  sessionHistory: 'skycontrol_session_history',
  onboardingSeen: 'skycontrol_onboarding_seen',
  prefs: 'skycontrol_prefs',
  // single-value mirrors asserted by 05 §4.2 / §4.8
  tts: 'skycontrol_tts',
  autoTower: 'skycontrol_autotower',
  groundTheme: 'skycontrol_ground_theme',
} as const;

/** Partial of the store's Settings blob (src/components/atc/simStore.ts `Settings`). */
export interface SettingsSeed {
  autoTower?: boolean; autoGround?: boolean; autoHandoff?: boolean; strictFrequencies?: boolean;
  emergencyRate?: 'off' | 'low' | 'normal' | 'high'; groundTheme?: 'satellite' | 'chart'; showRings?: boolean;
  difficulty?: 'low' | 'normal' | 'high'; sound?: boolean; tts?: boolean; volume?: number; pilotDelayS?: number | null;
  readbackErrors?: boolean; region?: 'auto' | 'ICAO' | 'FAA'; instantVectors?: boolean; typedInstant?: boolean;
}

/** Write raw string values before the page loads. */
export async function seedLocalStorage(page: Page, values: Record<string, string>): Promise<void> {
  await page.addInitScript((kv: Record<string, string>) => {
    try { for (const [k, v] of Object.entries(kv)) window.localStorage.setItem(k, v); } catch { /* storage disabled */ }
  }, values);
}

/** Seed the settings blob (merged over the app defaults at load) and its legacy mirrors. */
export async function seedSettings(page: Page, settings: SettingsSeed): Promise<void> {
  const kv: Record<string, string> = { [LS_KEYS.settings]: JSON.stringify(settings) };
  if (settings.tts != null) kv[LS_KEYS.tts] = settings.tts ? '1' : '0';
  if (settings.autoTower != null) kv[LS_KEYS.autoTower] = settings.autoTower ? '1' : '0';
  if (settings.groundTheme) kv[LS_KEYS.groundTheme] = settings.groundTheme;
  await seedLocalStorage(page, kv);
}

/** Mark the first-run tips as seen (they never show in test mode anyway; this covers non-test boots from home). */
export function seedOnboardingSeen(page: Page): Promise<void> {
  return seedLocalStorage(page, { [LS_KEYS.onboardingSeen]: '1' });
}

/** Read one localStorage key from the current page. */
export function readLocalStorage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => { try { return window.localStorage.getItem(k); } catch { return null; } }, key);
}

/** Read and JSON-parse one localStorage key (null when absent / invalid). */
export async function readLocalStorageJson<T = unknown>(page: Page, key: string): Promise<T | null> {
  const raw = await readLocalStorage(page, key);
  if (raw == null) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function writeLocalStorage(page: Page, key: string, value: string | null): Promise<void> {
  return page.evaluate(([k, v]) => { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch { /* ignore */ } }, [key, value] as const);
}

// Page-side persistence for the home and settings routes. Everything the engine
// or the game needs goes through the sim store (`sim.settings` /
// `sim.updateSettings`, which persists `skycontrol_settings`) and its `persist`
// module (00-MASTER-PLAN §2.6); this file only adds
//   - a small UI-prefs blob (`skycontrol_prefs`) for renderer-only choices that
//     the store does not model (data-block density, reduced motion),
//   - the legacy one-value mirrors the e2e suite asserts (05 §4.2: tts,
//     autotower, ground_theme),
//   - React hooks (useSyncExternalStore) over both.
import { useSyncExternalStore } from 'react';
import { sim, DEFAULT_SETTINGS, type Settings, type StartConfig as StoreStartConfig } from '@/components/atc/simStore';
import * as persist from '@/components/atc/persist';
import type { SessionRecord } from '@/components/atc/persist';

export type { Settings, SessionRecord };
export type Position = 'ground' | 'tower' | 'approach';
export type Difficulty = Settings['difficulty'];
export type EmergencyRate = Settings['emergencyRate'];
export type GroundTheme = Settings['groundTheme'];
export type Region = Settings['region'];
export type DataBlockDensity = 'compact' | 'normal' | 'full';

/** Start config written by the home page (the store's shape + the wind preview, which the store may ignore). */
export interface StartConfig extends StoreStartConfig {
  wind?: { dir: number; kts: number };
}

export interface UiPrefs {
  dataBlockDensity: DataBlockDensity;
  reducedMotion: boolean;
}
export const DEFAULT_PREFS: UiPrefs = { dataBlockDensity: 'normal', reducedMotion: false };
export { DEFAULT_SETTINGS };

export const LS = {
  ...persist.PERSIST_KEYS,
  prefs: 'skycontrol_prefs',
  // Single-value mirrors asserted by the e2e suite (05 §4.2 / §4.8).
  tts: 'skycontrol_tts',
  autoTower: 'skycontrol_autotower',
  groundTheme: 'skycontrol_ground_theme',
} as const;

const hasWindow = () => typeof window !== 'undefined';
function readRaw(key: string): string | null {
  if (!hasWindow()) return null;
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeRaw(key: string, value: string | null) {
  if (!hasWindow()) return;
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* quota / private mode */ }
}

// ---------------------------------------------------------------------------
//  Local listeners (prefs + resets) merged with the store subscription
// ---------------------------------------------------------------------------
const listeners = new Set<() => void>();
function notify() { for (const l of listeners) l(); }
function subscribe(fn: () => void) {
  listeners.add(fn);
  const unsub = sim.subscribe(fn);
  return () => { listeners.delete(fn); unsub(); };
}

// ---------------------------------------------------------------------------
//  Settings (store-owned)
// ---------------------------------------------------------------------------
export function getSettings(): Settings { return sim.settings; }

/** Merge a patch into the store (which persists and applies it live) and keep the legacy mirrors in step. */
export function updateSettings(patch: Partial<Settings>): Settings {
  sim.updateSettings(patch);
  if ('tts' in patch) writeRaw(LS.tts, patch.tts ? '1' : '0');
  if ('autoTower' in patch) writeRaw(LS.autoTower, patch.autoTower ? '1' : '0');
  if ('groundTheme' in patch && patch.groundTheme) writeRaw(LS.groundTheme, patch.groundTheme);
  notify();
  return sim.settings;
}

// ---------------------------------------------------------------------------
//  UI prefs (page-owned)
// ---------------------------------------------------------------------------
let prefsCache: { key: string; val: UiPrefs } | null = null;
export function getPrefs(): UiPrefs {
  const raw = readRaw(LS.prefs) ?? '';
  if (prefsCache && prefsCache.key === raw) return prefsCache.val;
  let stored: Partial<UiPrefs> = {};
  try { const v = raw ? JSON.parse(raw) : null; if (v && typeof v === 'object') stored = v; } catch { stored = {}; }
  const val: UiPrefs = { ...DEFAULT_PREFS, ...stored };
  prefsCache = { key: raw, val };
  return val;
}
export function updatePrefs(patch: Partial<UiPrefs>): UiPrefs {
  writeRaw(LS.prefs, JSON.stringify({ ...getPrefs(), ...patch }));
  applyPrefsToDocument();
  notify();
  return getPrefs();
}
/** Reduced motion / density are exposed on <html> as data attributes so any stylesheet or renderer can key on them. */
export function applyPrefsToDocument() {
  if (!hasWindow()) return;
  const p = getPrefs();
  const el = document.documentElement;
  if (p.reducedMotion) el.setAttribute('data-reduced-motion', 'true'); else el.removeAttribute('data-reduced-motion');
  el.setAttribute('data-datablock', p.dataBlockDensity);
}

// ---------------------------------------------------------------------------
//  High score, history, start config, reset
// ---------------------------------------------------------------------------
export function getHighScore(): number { return Math.max(sim.highScore, persist.loadHighScore()); }
export function resetHighScore() {
  persist.saveHighScore(0);
  sim.highScore = 0;
  notify();
}

let historyCache: { key: string; val: SessionRecord[] } | null = null;
/** Newest first, at most 10 (the store keeps 20). */
export function getHistory(): SessionRecord[] {
  const raw = readRaw(LS.sessionHistory) ?? '';
  if (historyCache && historyCache.key === raw) return historyCache.val;
  const val = persist.loadSessionHistory().slice(0, 10);
  historyCache = { key: raw, val };
  return val;
}
export function clearHistory() { persist.clearSessionHistory(); notify(); }

export function writeStartConfig(cfg: StartConfig) { persist.saveStartConfig(cfg); }

/** "Reset all" (UX §G10): settings and prefs back to defaults; the high score is kept. */
export function resetAllSettings() {
  sim.updateSettings({ ...DEFAULT_SETTINGS });
  writeRaw(LS.tts, null); writeRaw(LS.autoTower, null); writeRaw(LS.groundTheme, null);
  writeRaw(LS.prefs, null);
  applyPrefsToDocument();
  notify();
}

/** A session is live in the store (used by "Back to shift"). */
export function sessionRunning(): boolean { return Boolean(sim.engine); }
export function sessionIcao(): string | null { return sim.icao || null; }

// ---------------------------------------------------------------------------
//  Hooks
// ---------------------------------------------------------------------------
export function useSettings(): Settings { return useSyncExternalStore(subscribe, getSettings, () => DEFAULT_SETTINGS); }
export function usePrefs(): UiPrefs { return useSyncExternalStore(subscribe, getPrefs, () => DEFAULT_PREFS); }
export function useHighScore(): number { return useSyncExternalStore(subscribe, getHighScore, () => 0); }
const EMPTY_HISTORY: SessionRecord[] = [];
export function useHistory(): SessionRecord[] { return useSyncExternalStore(subscribe, getHistory, () => EMPTY_HISTORY); }
export function useSessionRunning(): boolean { return useSyncExternalStore(subscribe, sessionRunning, () => false); }

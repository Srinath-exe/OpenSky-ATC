// ============================================================
//  Persistence — every localStorage key the game uses lives here
//  (00-MASTER-PLAN §2.6, UX 04 §G10). SSR-safe: every accessor is a no-op
//  that returns the fallback when `window` / `localStorage` is unavailable
//  or throws (private mode, quota, disabled storage).
//
//  Keys (all `skycontrol_*`):
//    settings         one JSON blob for every settings toggle (Settings)
//    high_score       best session points ever (number)
//    start_config     one-shot StartConfig written by the home page, consumed
//                     once by the game boot
//    session_history  last 20 SessionRecord entries, newest first
//    onboarding_seen  '1' after the first-run tips were dismissed
// ============================================================

export const PERSIST_KEYS = {
  settings: 'skycontrol_settings',
  highScore: 'skycontrol_high_score',
  startConfig: 'skycontrol_start_config',
  sessionHistory: 'skycontrol_session_history',
  onboardingSeen: 'skycontrol_onboarding_seen',
  llm: 'skycontrol_llm',
} as const;

export type PersistKey = (typeof PERSIST_KEYS)[keyof typeof PERSIST_KEYS];

/** Record written when a session ends (restart, airport switch, quit). */
export interface SessionRecord {
  icao: string;
  /** Wall-clock start (ms epoch). */
  startedAt: number;
  /** Wall-clock end (ms epoch). */
  endedAt: number;
  /** Sim seconds played. */
  simTimeS: number;
  points: number;
  /** Best skill reached (0-12). */
  skill: number;
  movements: number;
  departures: number;
  arrivals: number;
  incidents: number;
  emergenciesResolved: number;
  seed: number;
}

export const SESSION_HISTORY_MAX = 20;

// ──────────────────────────────────────────────────────────────────────────────
//  Raw storage access (guarded)
// ──────────────────────────────────────────────────────────────────────────────
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function readRaw(key: PersistKey): string | null {
  try { return storage()?.getItem(key) ?? null; } catch { return null; }
}

export function writeRaw(key: PersistKey, value: string | null): boolean {
  try {
    const s = storage(); if (!s) return false;
    if (value == null) s.removeItem(key); else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readJson<T>(key: PersistKey, fallback: T): T {
  const raw = readRaw(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function writeJson(key: PersistKey, value: unknown): boolean {
  try { return writeRaw(key, JSON.stringify(value)); } catch { return false; }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Typed accessors
// ──────────────────────────────────────────────────────────────────────────────
/** Merge the stored settings blob over `defaults`; unknown keys are kept for forward compatibility. */
export function loadSettings<T extends object>(defaults: T): T {
  const stored = readJson<Partial<T> | null>(PERSIST_KEYS.settings, null);
  if (!stored || typeof stored !== 'object') return { ...defaults };
  return { ...defaults, ...stored };
}

export function saveSettings<T extends object>(settings: T): boolean {
  return writeJson(PERSIST_KEYS.settings, settings);
}

export function loadHighScore(): number {
  const raw = readRaw(PERSIST_KEYS.highScore);
  const n = raw == null ? 0 : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function saveHighScore(n: number): boolean {
  return writeRaw(PERSIST_KEYS.highScore, String(Math.max(0, Math.round(n))));
}

/** Written by the home page; read exactly once by the game boot. */
export function saveStartConfig(cfg: object): boolean {
  return writeJson(PERSIST_KEYS.startConfig, cfg);
}

/** Read and delete the one-shot start config (null when absent or malformed). */
export function consumeStartConfig<T = Record<string, unknown>>(): T | null {
  const cfg = readJson<T | null>(PERSIST_KEYS.startConfig, null);
  writeRaw(PERSIST_KEYS.startConfig, null);
  return cfg && typeof cfg === 'object' ? cfg : null;
}

/** Peek without consuming (settings page "resume" hint). */
export function peekStartConfig<T = Record<string, unknown>>(): T | null {
  const cfg = readJson<T | null>(PERSIST_KEYS.startConfig, null);
  return cfg && typeof cfg === 'object' ? cfg : null;
}

export function loadSessionHistory(): SessionRecord[] {
  const list = readJson<SessionRecord[]>(PERSIST_KEYS.sessionHistory, []);
  return Array.isArray(list) ? list.filter(r => r && typeof r === 'object' && typeof r.icao === 'string') : [];
}

/** Prepend a record; keeps the newest SESSION_HISTORY_MAX. Returns the new list. */
export function pushSessionRecord(rec: SessionRecord): SessionRecord[] {
  const list = [rec, ...loadSessionHistory()].slice(0, SESSION_HISTORY_MAX);
  writeJson(PERSIST_KEYS.sessionHistory, list);
  return list;
}

export function clearSessionHistory(): boolean {
  return writeRaw(PERSIST_KEYS.sessionHistory, null);
}

export function onboardingSeen(): boolean {
  return readRaw(PERSIST_KEYS.onboardingSeen) === '1';
}

export function setOnboardingSeen(seen: boolean): boolean {
  return writeRaw(PERSIST_KEYS.onboardingSeen, seen ? '1' : null);
}

/** "Reset all" in Settings: clears everything except the high score (UX §G10). */
export function resetAll(opts: { keepHighScore?: boolean } = { keepHighScore: true }): void {
  for (const key of Object.values(PERSIST_KEYS)) {
    if (opts.keepHighScore !== false && key === PERSIST_KEYS.highScore) continue;
    writeRaw(key, null);
  }
}

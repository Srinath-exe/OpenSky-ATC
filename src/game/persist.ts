/* localStorage keys shared by the game shell (00-MASTER-PLAN 2.6, UX 04 G10). All prefixed `skycontrol_`. */

export const LS = {
  startConfig: 'skycontrol_start_config',
  highScore: 'skycontrol_high_score',
  settings: 'skycontrol_settings',
  panels: 'skycontrol_panels',
  tipsSeen: 'skycontrol_tips_seen',
  allowNarrow: 'skycontrol_allow_narrow',
  hotkeyBadges: 'skycontrol_hotkey_badges',
  logFilter: 'skycontrol_log_filter',
  cmdHistory: 'skycontrol_cmd_history',
} as const

export function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / private mode: ignore */
  }
}

export function readFlag(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function writeFlag(key: string, on: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (on) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function removeKey(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

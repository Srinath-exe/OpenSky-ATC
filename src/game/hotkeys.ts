/* Single hotkey table (UX 04 G6): the dispatcher, the help tab and the tooltips all read from here so they cannot drift.
   F5 / F6 / F7 / F11 / F12 and Ctrl+letter (except Ctrl+Z, Ctrl+Shift+Z, Ctrl+Enter, Ctrl+K) are never bound. */
import { ACTION_DEFS, type ActionId } from '@/lib/sim/commandTree'

export type HotkeyRegion = 'global' | 'bay' | 'panel' | 'map' | 'log'

export interface Hotkey {
  /** Display form ("F1", "Space", "Shift+/", "M,A"). */
  key: string
  region: HotkeyRegion
  action: string
  when: string
  /** Stable id for testids (`help-hotkey-row-{id}`). */
  id: string
}

export const SHELL_HOTKEYS: readonly Hotkey[] = [
  { id: 'f1', key: 'F1', region: 'global', action: 'Ground position', when: 'Always' },
  { id: 'f2', key: 'F2', region: 'global', action: 'Tower position', when: 'Always' },
  { id: 'f3', key: 'F3', region: 'global', action: 'Approach position', when: 'Radar airspace available' },
  { id: 'bracket-left', key: '[', region: 'global', action: 'Previous position', when: 'No input focused' },
  { id: 'bracket-right', key: ']', region: 'global', action: 'Next position', when: 'No input focused' },
  { id: 'f4', key: 'F4', region: 'global', action: 'Collapse / expand the strip bay', when: 'Always' },
  { id: 'f8', key: 'F8', region: 'global', action: 'Collapse / expand the comm log', when: 'Always' },
  { id: 'f9', key: 'F9', region: 'global', action: 'ATIS / weather panel', when: 'Always' },
  { id: 'f10', key: 'F10', region: 'global', action: 'Vehicles panel', when: 'Ground or Tower position' },
  { id: 'space', key: 'Space', region: 'global', action: 'Pause / resume', when: 'No input or picker focused' },
  { id: 'rate-1', key: '1', region: 'global', action: 'Sim rate 1×', when: 'No input focused' },
  { id: 'rate-2', key: '2', region: 'global', action: 'Sim rate 2×', when: 'No input focused' },
  { id: 'rate-4', key: '4', region: 'global', action: 'Sim rate 4×', when: 'No input focused' },
  { id: 'rate-down', key: ',', region: 'global', action: 'Slower sim rate', when: 'No input focused' },
  { id: 'rate-up', key: '.', region: 'global', action: 'Faster sim rate', when: 'No input focused' },
  { id: 'esc', key: 'Esc', region: 'global', action: 'Blur input → close overlay → deselect → pause menu', when: 'Always' },
  { id: 'tab', key: 'Tab', region: 'bay', action: 'Next strip (alerts → requests → bay order)', when: 'No picker focused' },
  { id: 'shift-tab', key: 'Shift+Tab', region: 'bay', action: 'Previous strip', when: 'No picker focused' },
  { id: 'slash', key: '/', region: 'log', action: 'Focus the command line', when: 'No input focused' },
  { id: 'ctrl-k', key: 'Ctrl+K', region: 'log', action: 'Focus the command line', when: 'Always' },
  { id: 'shift-r', key: 'Shift+R', region: 'log', action: 'Last plane called (prefill callsign)', when: 'No input focused' },
  { id: 'ctrl-space', key: 'Ctrl+Space', region: 'log', action: 'Push-to-talk (hold)', when: 'Always' },
  { id: 'undo', key: 'U', region: 'log', action: 'Undo the last transmission (within its window)', when: 'No input focused' },
  { id: 'ctrl-z', key: 'Ctrl+Z', region: 'log', action: 'Undo the last transmission', when: 'Always' },
  { id: 'help', key: 'Shift+/', region: 'global', action: 'Help overlay', when: 'No input focused' },
  { id: 'alt-f', key: 'Alt+F', region: 'map', action: 'Centre on the selected aircraft', when: 'Aircraft selected' },
  { id: 'enter-req', key: 'Enter', region: 'panel', action: 'Open the highlighted answer to a pending request', when: 'Aircraft with a request selected' },
]

/** Action letters from the command tree (UX 1.3 / G2), rendered in the help tab after the shell keys. */
export function actionHotkeys(): Hotkey[] {
  const rows: Hotkey[] = []
  for (const id of Object.keys(ACTION_DEFS) as ActionId[]) {
    const def = ACTION_DEFS[id]
    if (!def.key) continue
    rows.push({ id, key: def.key, region: 'panel', action: def.label, when: `Aircraft selected · ${def.group}` })
  }
  return rows
}

export const ALL_HOTKEYS = (): Hotkey[] => [...SHELL_HOTKEYS, ...actionHotkeys()]

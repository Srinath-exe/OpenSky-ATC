'use client'
/*
  Keyboard dispatcher for the shell (UX 04 §G6, hotkeys.ts SHELL_HOTKEYS).
  Panel-local keys (action letters, pickers, the command line) run first on
  their own elements and call preventDefault; this hook only sees the rest.
*/
import * as React from 'react'
import { sim } from '@/components/atc/simStore'
import type { PlayerPosition } from '@/lib/sim/types'
import { REQUEST_ANSWER } from '@/lib/sim/commandTree'
import { requestOpenAction } from '@/game/CommandPanel/bus'
import { useHotkeys, keyChord, isEditableTarget, isPickerTarget } from '../hooks/useHotkeys'
import type { ShellState } from '../shellContext'
import { cycleStrip } from './stripCycle'

const POSITIONS: PlayerPosition[] = ['ground', 'tower', 'approach']
const RATES: Array<1 | 2 | 4> = [1, 2, 4]

/** Buttons, links, tabs, switches: Space / Enter belong to them, never to the shell. */
function isInteractiveTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest('button, a[href], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="option"], [role="menuitem"], summary')
}

function stepPosition(dir: 1 | -1, hasRadar: boolean): void {
  const list = hasRadar ? POSITIONS : POSITIONS.filter((p) => p !== 'approach')
  const i = list.indexOf(sim.position)
  const next = list[(Math.max(i, 0) + dir + list.length) % list.length]
  sim.setPosition(next)
}

function stepRate(dir: 1 | -1): void {
  const i = RATES.indexOf(sim.rate)
  const next = RATES[Math.min(RATES.length - 1, Math.max(0, i + dir))]
  sim.setRate(next)
}

/** Enter on a selected aircraft with an open request: open the highlighted answer at the confirm step (G6). */
function openRequestAnswer(): boolean {
  const a = sim.selected()
  if (!a) return false
  const req = a.requests.find((r) => r.answeredAt == null)
  if (!req || sim.time() < a.standbyUntil) return false
  const actionId = REQUEST_ANSWER[req.kind] ?? null
  requestOpenAction({ aircraftId: a.id, actionId, confirm: true })
  return true
}

export interface ShellHotkeyOptions {
  hasRadar: boolean
  openPause: () => void
}

export function useShellHotkeys(shell: ShellState, { hasRadar, openPause }: ShellHotkeyOptions): void {
  const shellRef = React.useRef(shell)
  shellRef.current = shell

  useHotkeys((e) => {
    const s = shellRef.current
    const chord = keyChord(e)
    const editable = isEditableTarget(e.target)
    const picker = isPickerTarget(e.target)

    // ---- always on (F5 / F6 / F7 / F11 / F12 are never bound) ----
    switch (chord) {
      case 'F1': sim.setPosition('ground'); return true
      case 'F2': sim.setPosition('tower'); return true
      case 'F3': if (hasRadar) sim.setPosition('approach'); return true
      case 'F4': s.toggleBay(); return true
      case 'F8': s.toggleLog(); return true
      case 'F9': s.toggle('atis'); return true
      case 'F10': if (sim.position !== 'approach') s.toggle('vehicles'); return true
      case 'Ctrl+K': s.focusCmd(); return true
      case 'Ctrl+Space': s.setPtt(true); return true
      case 'Ctrl+Z': if (editable) return false; sim.undo(); return true
      case 'Escape': {
        if (editable) { (e.target as HTMLElement).blur?.(); return true }
        if (s.closeTop()) return true
        if (sim.selectedId != null) { sim.select(null); return true }
        openPause()
        return true
      }
      default: break
    }

    if (editable) return false

    // ---- inside a picker: only the aircraft-cycling keys (G6 "PageDown / PageUp when a picker has focus") ----
    if (picker) {
      if (chord === 'PageDown') return cycleStrip(1)
      if (chord === 'PageUp') return cycleStrip(-1)
      return false
    }

    const interactive = isInteractiveTarget(e.target)
    switch (chord) {
      case 'Space': if (interactive) return false; sim.togglePause(); return true
      case 'Enter': if (interactive) return false; return openRequestAnswer()
      case '1': sim.setRate(1); return true
      case '2': sim.setRate(2); return true
      case '4': sim.setRate(4); return true
      case ',': stepRate(-1); return true
      case '.': stepRate(1); return true
      case '[': stepPosition(-1, hasRadar); return true
      case ']': stepPosition(1, hasRadar); return true
      case 'Tab': return cycleStrip(1)
      case 'Shift+Tab': return cycleStrip(-1)
      case 'PageDown': return cycleStrip(1)
      case 'PageUp': return cycleStrip(-1)
      case '/': if (e.shiftKey) s.toggle('help'); else s.focusCmd(); return true
      case '?': s.toggle('help'); return true
      case 'U': sim.undo(); return true
      case 'R': {
        if (!e.shiftKey) return false
        if (sim.lastCallsign) s.focusCmd(`${sim.lastCallsign} `)
        return true
      }
      case 'Alt+F': if (sim.selectedId != null) sim.centerOn(sim.selectedId); return true
      default: return false
    }
  })

  // PTT release (Ctrl+Space is a hold).
  React.useEffect(() => {
    const onUp = (e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Control' || e.key === 'Meta') shellRef.current.setPtt(false) }
    const onBlur = () => shellRef.current.setPtt(false)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keyup', onUp); window.removeEventListener('blur', onBlur) }
  }, [])
}

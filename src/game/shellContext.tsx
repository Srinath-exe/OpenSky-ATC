'use client'
/* Shell-level UI state shared by the nav, the floating panels and the keyboard dispatcher (UX 04 §2.1). */
import * as React from 'react'

export type ShellOverlay = 'atis' | 'stats' | 'alerts' | 'vehicles' | 'help' | 'pause' | 'settings' | 'runwayConfig' | 'leaveConfirm'

export interface ShellState {
  bayCollapsed: boolean
  logCollapsed: boolean
  toggleBay: () => void
  toggleLog: () => void
  setLogCollapsed: (b: boolean) => void
  /** Open overlays (dropdowns + modals). Several dropdowns cannot be open at once; modals stack on top. */
  open: Partial<Record<ShellOverlay, boolean>>
  isOpen: (o: ShellOverlay) => boolean
  show: (o: ShellOverlay) => void
  hide: (o: ShellOverlay) => void
  toggle: (o: ShellOverlay) => void
  /** Close the topmost overlay; returns false when nothing was open. */
  closeTop: () => boolean
  /** Command line focus: CommLog registers, the nav / hotkeys call. */
  focusCmd: (prefill?: string) => void
  registerCmdFocus: (fn: ((prefill?: string) => void) | null) => void
  /** Push-to-talk visual (Ctrl+Space or holding the PTT button). */
  ptt: boolean
  setPtt: (b: boolean) => void
  /** Focus region shown on <body data-focus-region> (UX G6 focus model). */
  focusRegion: 'bay' | 'panel' | 'map' | 'log'
}

const DROPDOWNS: ShellOverlay[] = ['atis', 'stats', 'alerts', 'vehicles']
/** Esc closes in this order (last = topmost). */
const STACK: ShellOverlay[] = ['vehicles', 'atis', 'stats', 'alerts', 'runwayConfig', 'settings', 'help', 'leaveConfirm', 'pause']

export const ShellContext = React.createContext<ShellState | null>(null)

export function useShell(): ShellState {
  const ctx = React.useContext(ShellContext)
  if (!ctx) throw new Error('useShell must be used inside <GameShell>')
  return ctx
}

/** Safe variant for components that may render outside the shell (e.g. the design showcase). */
export function useShellOptional(): ShellState | null {
  return React.useContext(ShellContext)
}

export function useOverlayState(): Pick<ShellState, 'open' | 'isOpen' | 'show' | 'hide' | 'toggle' | 'closeTop'> {
  const [open, setOpen] = React.useState<Partial<Record<ShellOverlay, boolean>>>({})
  const show = React.useCallback((o: ShellOverlay) => {
    setOpen((prev) => {
      const next = { ...prev, [o]: true }
      if (DROPDOWNS.includes(o)) for (const d of DROPDOWNS) if (d !== o) next[d] = false
      return next
    })
  }, [])
  const hide = React.useCallback((o: ShellOverlay) => setOpen((prev) => (prev[o] ? { ...prev, [o]: false } : prev)), [])
  const toggle = React.useCallback((o: ShellOverlay) => {
    setOpen((prev) => {
      if (prev[o]) return { ...prev, [o]: false }
      const next = { ...prev, [o]: true }
      if (DROPDOWNS.includes(o)) for (const d of DROPDOWNS) if (d !== o) next[d] = false
      return next
    })
  }, [])
  const openRef = React.useRef(open)
  openRef.current = open
  const isOpen = React.useCallback((o: ShellOverlay) => !!openRef.current[o], [])
  const closeTop = React.useCallback(() => {
    const cur = openRef.current
    for (let i = STACK.length - 1; i >= 0; i--) {
      const o = STACK[i]
      if (cur[o]) { setOpen((prev) => ({ ...prev, [o]: false })); return true }
    }
    return false
  }, [])
  return { open, isOpen, show, hide, toggle, closeTop }
}

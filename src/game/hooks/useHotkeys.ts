'use client'
import * as React from 'react'

/** True when the key event originates from a text field / picker where hotkeys must not fire (UX 04 §9, G6). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return !!el.closest('[data-hotkeys="off"]')
}

/** True when the target sits inside a picker / slider (Dial, Ladder, listbox) that owns Space / arrows / digits. */
export function isPickerTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.closest('[data-testid="strip-bay"]')) return false   // the strip bay is a listbox too, but it keeps the shell hotkeys live
  return !!el.closest('[role="slider"],[role="listbox"],[role="radiogroup"],[role="dialog"] [data-picker],[data-picker]')
}

/** Canonical key string for a KeyboardEvent: "Ctrl+Shift+K", "F1", "Space", "?" (already shifted glyph). */
export function keyChord(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  // Shift+digit: report the digit (the shifted glyph differs per layout) so "Shift+1" is a distinct chord from "1"
  const digit = e.shiftKey ? /^Digit(\d)$/.exec(e.code)?.[1] : undefined
  const key = digit ?? (e.key === ' ' ? 'Space' : e.key)
  if (digit) parts.push('Shift')
  const isGlyph = key.length === 1 && !digit
  if (e.shiftKey && !isGlyph) parts.push('Shift')
  parts.push(isGlyph ? key.toUpperCase() === key.toLowerCase() ? key : key.toUpperCase() : key)
  return parts.join('+')
}

export type HotkeyHandler = (e: KeyboardEvent) => boolean | void

/**
 * Registers a window keydown listener. The handler returns `true` when it consumed the key (preventDefault is then called).
 * Events that are already `defaultPrevented` (handled by a panel-local listener) are ignored.
 */
export function useHotkeys(handler: HotkeyHandler, enabled = true): void {
  const ref = React.useRef(handler)
  ref.current = handler
  React.useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (ref.current(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

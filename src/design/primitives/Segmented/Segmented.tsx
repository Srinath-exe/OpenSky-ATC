'use client'
import * as React from 'react'
import styles from './Segmented.module.css'
import { cx } from '../../utils'

export interface SegmentedItem { id: string; label: React.ReactNode; disabled?: boolean; testId?: string }
export interface SegmentedProps {
  items: SegmentedItem[]
  value: string
  onChange: (id: string) => void
  /** tabular numerals (rate 1x 2x 4x) */
  tabular?: boolean
  small?: boolean
  ariaLabel?: string
  testId?: string
  className?: string
}

/** Week / Month / Quarter / Year style text tabs: no container, 1px underline slides 200ms. */
export function Segmented({ items, value, onChange, tabular = false, small = false, ariaLabel, testId, className }: SegmentedProps) {
  const root = React.useRef<HTMLDivElement>(null)
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({})
  const [line, setLine] = React.useState<{ x: number; w: number } | null>(null)
  const measure = React.useCallback(() => {
    const el = refs.current[value]
    const r0 = root.current
    if (!el || !r0) { setLine(null); return }
    const a = r0.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    setLine({ x: b.left - a.left, w: b.width })
  }, [value])
  React.useLayoutEffect(() => { measure() }, [measure, items])
  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !root.current) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(root.current)
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {})
    return () => ro.disconnect()
  }, [measure])
  const onKey = (e: React.KeyboardEvent) => {
    const enabled = items.filter((i) => !i.disabled)
    const idx = enabled.findIndex((i) => i.id === value)
    let next: SegmentedItem | undefined
    if (e.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length]
    else if (e.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') next = enabled[0]
    else if (e.key === 'End') next = enabled[enabled.length - 1]
    if (next) { e.preventDefault(); onChange(next.id); refs.current[next.id]?.focus() }
  }
  return (
    <div ref={root} role="tablist" aria-label={ariaLabel} data-testid={testId} className={cx(styles.seg, tabular && styles.tabular, small && styles.small, className)} onKeyDown={onKey}>
      {items.map((it) => {
        const active = it.id === value
        return (
          <button key={it.id} ref={(n) => { refs.current[it.id] = n }} type="button" role="tab" aria-selected={active} aria-disabled={it.disabled || undefined} tabIndex={active ? 0 : -1}
            data-testid={it.testId ?? (testId ? `${testId}-${it.id}` : undefined)}
            className={cx(styles.item, active && styles.active, it.disabled && styles.disabled)} onClick={() => { if (!it.disabled) onChange(it.id) }}>
            {it.label}
          </button>
        )
      })}
      <span aria-hidden="true" className={cx(styles.underline, line && styles.visible)} style={line ? { transform: `translateX(${line.x}px)`, width: line.w } : undefined} />
    </div>
  )
}

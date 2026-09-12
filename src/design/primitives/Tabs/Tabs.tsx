'use client'
import * as React from 'react'
import styles from './Tabs.module.css'
import { cx } from '../../utils'
import { Badge } from '../Badge/Badge'

export interface TabItem { id: string; label: React.ReactNode; disabled?: boolean; badge?: number; testId?: string }
export interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  /** compact = 36 tall, 16 gap (in-panel) */
  compact?: boolean
  tabular?: boolean
  ariaLabel?: string
  testId?: string
  className?: string
}

/** Position-tab strip (GROUND / TOWER / APPROACH). The active pill slides (FLIP, 200ms ease-inout). Arrow keys move, Home/End jump. */
export function Tabs({ items, value, onChange, compact = false, tabular = false, ariaLabel, testId, className }: TabsProps) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({})
  const [pill, setPill] = React.useState<{ x: number; w: number } | null>(null)
  const pad = compact ? 12 : 22

  const measure = React.useCallback(() => {
    const el = refs.current[value]
    const list = listRef.current
    if (!el || !list) { setPill(null); return }
    const lr = list.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    setPill({ x: r.left - lr.left - pad, w: r.width + pad * 2 })
  }, [value, pad])

  React.useLayoutEffect(() => { measure() }, [measure, items])
  React.useEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(list)
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {})
    return () => ro.disconnect()
  }, [measure])

  const onKey = (e: React.KeyboardEvent) => {
    const enabled = items.filter((i) => !i.disabled)
    const idx = enabled.findIndex((i) => i.id === value)
    let next: TabItem | undefined
    if (e.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length]
    else if (e.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') next = enabled[0]
    else if (e.key === 'End') next = enabled[enabled.length - 1]
    if (next) { e.preventDefault(); onChange(next.id); refs.current[next.id]?.focus() }
  }

  return (
    <div ref={listRef} role="tablist" aria-label={ariaLabel} data-testid={testId} className={cx(styles.tabs, compact && styles.compact, tabular && styles.tabular, className)} onKeyDown={onKey}>
      <span aria-hidden="true" className={cx(styles.pillTrack, pill && styles.pillVisible)} style={pill ? { transform: `translateX(${pill.x}px)`, width: pill.w } : undefined} />
      {items.map((it) => {
        const active = it.id === value
        return (
          <button
            key={it.id}
            ref={(n) => { refs.current[it.id] = n }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-disabled={it.disabled || undefined}
            tabIndex={active ? 0 : -1}
            data-testid={it.testId ?? (testId ? `${testId}-${it.id}` : undefined)}
            className={cx(styles.tab, active && styles.active, it.disabled && styles.disabled)}
            onClick={() => { if (!it.disabled) onChange(it.id) }}
          >
            {it.label}
            {it.badge !== undefined && it.badge > 0 ? <Badge className={styles.badge} value={it.badge} /> : null}
          </button>
        )
      })}
    </div>
  )
}

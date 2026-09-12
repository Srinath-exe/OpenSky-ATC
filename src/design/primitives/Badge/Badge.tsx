'use client'
import * as React from 'react'
import styles from './Badge.module.css'
import { cx } from '../../utils'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** number (capped at `max`, "99+") or short text (<= 2 glyphs) */
  value?: number | string
  /** s = Ø18 nav counter, m = Ø22 alert index (A24-8) */
  size?: 's' | 'm'
  tone?: 'red' | 'orange' | 'neutral' | 'white'
  /** critical: --red-glow around a brighter core */
  glow?: boolean
  /** new-alert ring pulse (1.2s x2) */
  pulse?: boolean
  /** count "bump" scale 1 -> 1.15 -> 1 on change */
  bumpKey?: number | string
  /** Ø8 dot without numeral (emergency bullet) */
  dot?: boolean
  max?: number
  testId?: string
}

export function Badge({ value, size = 's', tone = 'red', glow = false, pulse = false, bumpKey, dot = false, max = 99, testId, className, ...rest }: BadgeProps) {
  const [bump, setBump] = React.useState(false)
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) { first.current = false; return }
    if (bumpKey === undefined) return
    setBump(true)
    const t = setTimeout(() => setBump(false), 260)
    return () => clearTimeout(t)
  }, [bumpKey])
  const text = typeof value === 'number' ? (value > max ? `${max}+` : String(value)) : value
  return (
    <span
      data-testid={testId}
      className={cx(styles.badge, size === 'm' && styles.m, styles[tone], glow && styles.glow, pulse && styles.pulse, bump && styles.bump, dot && styles.dot, className)}
      aria-label={typeof value === 'number' ? `${value}` : undefined}
      {...rest}
    >
      {dot ? null : text}
    </span>
  )
}

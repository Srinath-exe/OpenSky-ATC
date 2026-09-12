'use client'
import * as React from 'react'
import styles from './StatTile.module.css'
import { cx, useCountUp } from '../../utils'
import { IconCheck } from '../../icons'

export interface StatTileProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: React.ReactNode
  value: number
  /** ok = green filled circle with white check; alert = red filled triangle with "!"; none */
  icon?: 'ok' | 'alert' | 'none' | React.ReactNode
  /** conflict tile with n > 0: inner red stroke + red number (the only tile with an inner stroke) */
  conflict?: boolean
  /** fixed 200px width instead of fluid */
  fixedWidth?: boolean
  countUp?: boolean
  onClick?: React.MouseEventHandler<HTMLDivElement>
  testId?: string
}

function AlertGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.2 18.4 16.6a1.2 1.2 0 0 1-1.04 1.8H2.64a1.2 1.2 0 0 1-1.04-1.8L10 2.2z" fill="var(--red)" />
      <path d="M10 7v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="14.6" r="1.1" fill="currentColor" />
    </svg>
  )
}

export function StatTile({ label, value, icon = 'none', conflict = false, fixedWidth = false, countUp = true, onClick, testId, className, ...rest }: StatTileProps) {
  const shown = useCountUp(value, 600, { enabled: countUp })
  const zero = value === 0
  const iconNode = zero ? null : icon === 'ok' ? <span className={cx(styles.icon, styles.iconOk)}><IconCheck size={12} strokeWidth={2} /></span> : icon === 'alert' ? <span className={cx(styles.icon, styles.iconAlert)}><AlertGlyph /></span> : icon === 'none' ? null : <span className={styles.icon}>{icon}</span>
  const interactive = Boolean(onClick)
  return (
    <div
      data-testid={testId}
      className={cx(styles.tile, fixedWidth && styles.fixed, zero && styles.zero, conflict && !zero && styles.conflict, interactive && styles.interactive, className)}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>) } } : undefined}
      {...rest}
    >
      {iconNode}
      <span className={styles.label}>{label}</span>
      <span className={styles.number} data-testid={testId ? `${testId}-value` : undefined}>{Math.round(shown)}</span>
    </div>
  )
}

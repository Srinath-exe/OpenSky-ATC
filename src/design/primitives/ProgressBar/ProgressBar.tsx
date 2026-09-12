'use client'
import * as React from 'react'
import styles from './ProgressBar.module.css'
import { cx } from '../../utils'

export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 0..1 */
  value?: number
  indeterminate?: boolean
  tone?: 'white' | 'orange' | 'red' | 'green'
  /** 2 (default) or 4 px */
  thickness?: 2 | 4
  label?: React.ReactNode
  /** show "42%" right of the label */
  showValue?: boolean
  /** 200px wide (loading overlay) instead of fluid */
  fixedWidth?: boolean
  testId?: string
}

export function ProgressBar({ value = 0, indeterminate = false, tone = 'white', thickness = 2, label, showValue = false, fixedWidth = false, testId, className, ...rest }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div data-testid={testId} className={cx(styles.root, fixedWidth && styles.fixed, styles[tone], indeterminate && styles.indeterminate, className)} {...rest}>
      {label || showValue ? (
        <div className={styles.row}>
          <span>{label}</span>
          {showValue && !indeterminate ? <span className={styles.value}>{Math.round(pct)}%</span> : null}
        </div>
      ) : null}
      <div className={cx(styles.track, thickness === 4 && styles.h4)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct)} aria-busy={indeterminate || undefined}>
        <span className={styles.fill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

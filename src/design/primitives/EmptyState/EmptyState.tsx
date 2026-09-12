'use client'
import * as React from 'react'
import styles from './EmptyState.module.css'
import { cx } from '../../utils'

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode
  title: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
  compact?: boolean
  /** red title (error card body) */
  error?: boolean
  testId?: string
}

export function EmptyState({ icon, title, hint, action, compact = false, error = false, testId, className, ...rest }: EmptyStateProps) {
  return (
    <div data-testid={testId} className={cx(styles.root, compact && styles.compact, error && styles.error, className)} role={error ? 'alert' : undefined} {...rest}>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <div className={styles.title}>{title}</div>
      {hint ? <div className={styles.hint}>{hint}</div> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  )
}

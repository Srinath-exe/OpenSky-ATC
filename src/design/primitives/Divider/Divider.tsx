'use client'
import * as React from 'react'
import styles from './Divider.module.css'
import { cx } from '../../utils'

export interface DividerProps {
  vertical?: boolean
  /** margin: none / s 8 / m 16 (default) / l 24 */
  spacing?: 'none' | 's' | 'm' | 'l'
  strong?: boolean
  /** centred label-xs --text-4 label */
  label?: React.ReactNode
  testId?: string
  className?: string
}

export function Divider({ vertical = false, spacing = 'm', strong = false, label, testId, className }: DividerProps) {
  if (label) return <div role="separator" data-testid={testId} className={cx(styles.labelled, spacing === 'none' && styles.none, className)}><span className={styles.label}>{label}</span></div>
  return <div role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} data-testid={testId} className={cx(vertical ? styles.v : styles.h, styles[spacing], strong && styles.strong, className)} />
}

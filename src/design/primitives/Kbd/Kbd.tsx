'use client'
import * as React from 'react'
import styles from './Kbd.module.css'
import { cx } from '../../utils'

export interface KbdProps { children?: React.ReactNode; /** render several keys joined by "+" */ keys?: string[]; /** plain --text-3 text, no chrome (inside placeholders) */ plain?: boolean; testId?: string; className?: string }

export function Kbd({ children, keys, plain = false, testId, className }: KbdProps) {
  if (plain) return <span className={cx(styles.plain, className)} data-testid={testId}>{keys ? keys.join('+') : children}</span>
  if (keys && keys.length) {
    return (
      <span className={cx(styles.group, className)} data-testid={testId}>
        {keys.map((k, i) => (
          <React.Fragment key={k + i}>
            {i > 0 ? <span className={styles.plus}>+</span> : null}
            <kbd className={styles.kbd}>{k}</kbd>
          </React.Fragment>
        ))}
      </span>
    )
  }
  return <kbd className={cx(styles.kbd, className)} data-testid={testId}>{children}</kbd>
}

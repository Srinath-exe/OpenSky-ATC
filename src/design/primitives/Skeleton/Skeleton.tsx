'use client'
import * as React from 'react'
import styles from './Skeleton.module.css'
import { cx } from '../../utils'

export interface SkeletonProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** text (12 tall) / number (36x120) / block / circle / pill */
  variant?: 'text' | 'number' | 'block' | 'circle' | 'pill'
  width?: number | string
  height?: number | string
  /** several text lines; the last one is 60% wide */
  lines?: number
  testId?: string
}

export function Skeleton({ variant = 'block', width, height, lines, testId, className, style, ...rest }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <span className={cx(styles.lines, className)} data-testid={testId} aria-hidden="true" style={style}>
        {Array.from({ length: lines }).map((_, i) => <span key={i} className={cx(styles.sk, styles.text)} style={{ width: i === lines - 1 ? '60%' : width ?? '100%' }} />)}
      </span>
    )
  }
  return <span data-testid={testId} aria-hidden="true" className={cx(styles.sk, styles[variant], className)} style={{ width, height, ...style }} {...rest} />
}

'use client'
import * as React from 'react'
import styles from './LoadingOverlay.module.css'
import { cx } from '../../utils'
import { LogoMark } from '../../icons'
import { ProgressBar } from '../ProgressBar/ProgressBar'

export interface LoadingOverlayProps {
  open: boolean
  /** "Loading EGLL…" */
  text?: React.ReactNode
  /** 0..1; omit for indeterminate */
  progress?: number
  /** fixed to the viewport instead of the nearest positioned ancestor */
  fixed?: boolean
  testId?: string
  className?: string
}

/** Airport-load overlay (A11.10). Exit fades over 320ms after `open` turns false. */
export function LoadingOverlay({ open, text = 'Loading…', progress, fixed = false, testId, className }: LoadingOverlayProps) {
  const [mounted, setMounted] = React.useState(open)
  React.useEffect(() => {
    if (open) { setMounted(true); return }
    const t = setTimeout(() => setMounted(false), 330)
    return () => clearTimeout(t)
  }, [open])
  if (!mounted) return null
  return (
    <div role="status" aria-live="polite" aria-busy={open || undefined} data-testid={testId} className={cx(styles.root, fixed && styles.fixed, !open && styles.leaving, className)}>
      <LogoMark size={40} />
      <span className={styles.text}>{text}</span>
      <ProgressBar className={styles.bar} value={progress ?? 0} indeterminate={progress === undefined} />
    </div>
  )
}

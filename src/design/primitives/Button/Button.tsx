'use client'
import * as React from 'react'
import styles from './Button.module.css'
import { cx } from '../../utils'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = white pill (rare); accent = orange main action; secondary = glass; ghost; danger */
  variant?: ButtonVariant
  /** sm 30 / md 36 (default) / lg 40 (A3) */
  size?: ButtonSize
  iconLeft?: React.ReactNode
  iconRight?: React.ReactNode
  loading?: boolean
  selected?: boolean
  fullWidth?: boolean
  /** tabular numerals (stepper pills) */
  tabular?: boolean
  /** one-shot fill flash (A11.4 command issued) - toggle the key to replay */
  flashKey?: number | string
  /** dev-only: render a state statically (showcase / visual QA) */
  forceState?: 'hover' | 'pressed' | 'focus'
  testId?: string
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', iconLeft, iconRight, loading = false, selected = false, fullWidth = false, tabular = false, flashKey, forceState, testId, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const [flashing, setFlashing] = React.useState(false)
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) { first.current = false; return }
    if (flashKey === undefined) return
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 340)
    return () => clearTimeout(t)
  }, [flashKey])
  return (
    <button
      ref={ref}
      type={type}
      data-testid={testId}
      data-variant={variant}
      data-force={forceState}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      aria-pressed={selected || undefined}
      disabled={disabled || loading}
      className={cx(
        styles.btn, styles[variant], styles[size],
        iconLeft && styles.hasLeft, iconRight && styles.hasRight,
        loading && styles.loading, selected && styles.selected, fullWidth && styles.full, tabular && styles.tnum,
        flashing && styles.flash, className,
      )}
      {...rest}
    >
      {iconLeft ? <span className={styles.icon}>{iconLeft}</span> : null}
      {children !== undefined && children !== null ? <span className={styles.label}>{children}</span> : null}
      {iconRight ? <span className={styles.icon}>{iconRight}</span> : null}
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
    </button>
  )
})

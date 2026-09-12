'use client'
import * as React from 'react'
import styles from './IconButton.module.css'
import { cx } from '../../utils'
import { Badge } from '../Badge/Badge'

export type IconButtonSize = 32 | 36 | 40 | 44 | 56
export type IconButtonVariant = 'glass' | 'map' | 'solid' | 'ghost' | 'raised'

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name, required */
  label: string
  /** 32 (inline), 36 (pause), 40 (nav, default), 44 (map controls), 56 (mobile header) */
  size?: IconButtonSize
  variant?: IconButtonVariant
  /** Pass an Icon; size is set for you per spec: 40->20, 44->18, 56->22, 32/36->16 */
  icon: React.ReactElement<{ size?: number }>
  /** selected state: --bg-3 */
  active?: boolean
  /** icon in --orange (map "follow on") */
  accentIcon?: boolean
  /** feed-lost style: red-tint fill + red icon */
  danger?: boolean
  loading?: boolean
  /** red counter badge (Ø18) at -4/-4 */
  badge?: number
  badgePulse?: boolean
  /** 1px .12 ring (avatar style) */
  ring?: boolean
  /** dev-only: render a state statically (showcase / visual QA) */
  forceState?: 'hover' | 'pressed' | 'focus'
  testId?: string
}

const ICON_FOR_SIZE: Record<IconButtonSize, number> = { 32: 16, 36: 16, 40: 20, 44: 18, 56: 22 }

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 40, variant = 'glass', icon, active = false, accentIcon = false, danger = false, loading = false, badge, badgePulse = false, ring = false, forceState, testId, className, disabled, type = 'button', ...rest },
  ref,
) {
  const iconEl = React.isValidElement(icon) ? React.cloneElement(icon, { size: icon.props.size ?? ICON_FOR_SIZE[size] }) : icon
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      aria-pressed={active || undefined}
      aria-busy={loading || undefined}
      data-testid={testId}
      data-force={forceState}
      disabled={disabled || loading}
      className={cx(styles.btn, styles[`s${size}` as 's40'], styles[variant], active && styles.active, accentIcon && styles.accentIcon, danger && styles.danger, loading && styles.loading, ring && styles.ring, className)}
      {...rest}
    >
      <span className={styles.icon}>{iconEl}</span>
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
      {badge !== undefined && badge > 0 ? <Badge className={styles.badge} value={badge} pulse={badgePulse} testId={testId ? `${testId}-badge` : undefined} /> : null}
    </button>
  )
})

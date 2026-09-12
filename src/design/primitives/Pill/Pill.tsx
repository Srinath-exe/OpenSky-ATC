'use client'
import * as React from 'react'
import styles from './Pill.module.css'
import { cx } from '../../utils'

export type PillSize = 'xs' | 's' | 'm' | 'l'
export type PillTone = 'neutral' | 'solid' | 'outline' | 'dim' | 'green' | 'red' | 'red-solid' | 'orange' | 'glass' | 'tag' | 'chip'
export type DotColor = 'green' | 'red' | 'orange' | 'white' | 'grey' | (string & {})

export interface PillProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children' | 'onClick'> {
  /** xs 24 / s 30 / m 36 / l 40 (A3) */
  size?: PillSize
  /** neutral (--bg-2 count pill), solid (--bg-3), outline (status), dim (outline, --text-3), green, red, red-solid (EMERG), orange (advisory), glass (map pill), tag (radar callsign tag), chip (plate chip over glass) */
  tone?: PillTone
  /** leading status dot */
  dot?: DotColor
  dotGlow?: boolean
  /** leading icon (sized per A3 automatically) */
  icon?: React.ReactElement<{ size?: number }>
  /** colour only the icon (signal chips: GPS orange, LTE green) */
  iconTone?: 'orange' | 'green' | 'red' | 'white' | 'none'
  /** trailing element, usually a 14px chevron-down */
  trailing?: React.ReactNode
  /** count pill: number before the label with a 6px gap */
  count?: number | string
  tabular?: boolean
  uppercase?: boolean
  /** renders a <button> with hover / pressed / focus states */
  interactive?: boolean
  onClick?: React.MouseEventHandler<HTMLElement>
  selected?: boolean
  disabled?: boolean
  /** dev-only: render a state statically (showcase / visual QA) */
  forceState?: 'hover' | 'pressed' | 'focus'
  testId?: string
  children?: React.ReactNode
}

const ICON_FOR: Record<PillSize, number> = { xs: 12, s: 14, m: 16, l: 18 }
const DOT_COLOR: Record<string, string> = { green: 'var(--green)', red: 'var(--red)', orange: 'var(--orange)', white: 'var(--text-1)', grey: 'var(--text-3)' }
const ICON_TONE: Record<string, string> = { orange: 'var(--orange)', green: 'var(--green)', red: 'var(--red)', white: 'var(--text-1)' }

export const Pill = React.forwardRef<HTMLElement, PillProps>(function Pill(
  { size = 's', tone = 'neutral', dot, dotGlow = false, icon, iconTone = 'none', trailing, count, tabular = false, uppercase = false, interactive = false, onClick, selected = false, disabled = false, forceState, testId, className, children, ...rest },
  ref,
) {
  const toneClass = tone === 'red-solid' ? styles.redSolid : tone === 'chip' ? styles.chipOnGlass : styles[tone]
  const iconEl = icon && React.isValidElement(icon) ? React.cloneElement(icon, { size: icon.props.size ?? ICON_FOR[size] }) : icon
  const cls = cx(styles.pill, styles[size], toneClass, (icon || dot) && styles.hasIcon, trailing && styles.hasTrailing, interactive && styles.interactive, selected && styles.selected, disabled && styles.disabled, tabular && styles.tnum, uppercase && styles.uppercase, className)
  const content = (
    <>
      {dot ? <span className={cx(styles.dot, dotGlow && styles.dotGlow)} style={{ color: DOT_COLOR[dot] ?? dot }} aria-hidden="true" /> : null}
      {iconEl ? <span className={styles.icon} style={iconTone !== 'none' ? { color: ICON_TONE[iconTone] } : undefined}>{iconEl}</span> : null}
      {count !== undefined ? <span className={styles.count}>{count}</span> : null}
      {children !== undefined ? <span className={styles.label}>{children}</span> : null}
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </>
  )
  if (interactive) {
    return (
      <button ref={ref as React.Ref<HTMLButtonElement>} type="button" data-testid={testId} data-force={forceState} className={cls} disabled={disabled} aria-pressed={selected || undefined} onClick={onClick} {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
        {content}
      </button>
    )
  }
  return (
    <span ref={ref as React.Ref<HTMLSpanElement>} data-testid={testId} data-force={forceState} className={cls} aria-disabled={disabled || undefined} onClick={onClick} {...rest}>
      {content}
    </span>
  )
})

/** Plate chip group: circle (wake letter) overlapping a pill (squawk / registration) - 4.11 / A12. */
export interface PlateChipProps { letter: string; value: string; size?: 'm' | 'l'; onGlass?: boolean; testId?: string; className?: string }
export function PlateChip({ letter, value, size = 'm', onGlass = false, testId, className }: PlateChipProps) {
  return (
    <span data-testid={testId} className={cx(styles.plate, size === 'l' && styles.plateL, onGlass && styles.plateOnGlass, className)}>
      <span className={styles.plateCircle}>{letter}</span>
      <span className={styles.platePill}>{value}</span>
    </span>
  )
}

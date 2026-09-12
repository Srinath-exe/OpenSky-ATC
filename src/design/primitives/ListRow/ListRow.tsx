'use client'
import * as React from 'react'
import styles from './ListRow.module.css'
import { cx } from '../../utils'
import { IconChevronRight } from '../../icons'

export interface ListRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** leading 18px icon in --text-2 */
  icon?: React.ReactNode
  iconTone?: 'neutral' | 'orange' | 'green' | 'red'
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** trailing tabular value (--text-2) */
  meta?: React.ReactNode
  metaTone?: 'neutral' | 'orange'
  /** trailing slot (toggle, pill, button) */
  trailing?: React.ReactNode
  chevron?: boolean
  selected?: boolean
  disabled?: boolean
  loading?: boolean
  /** no negative margin / hover bleed (inside tight panels) */
  flush?: boolean
  /** 2px left rule variant (alert "affected" items) */
  rule?: boolean
  href?: string
  onClick?: React.MouseEventHandler<HTMLElement>
  /** dev-only: render a state statically (showcase / visual QA) */
  forceState?: 'hover' | 'pressed' | 'focus'
  testId?: string
}

export const ListRow = React.forwardRef<HTMLDivElement, ListRowProps>(function ListRow(
  { icon, iconTone = 'neutral', title, subtitle, meta, metaTone = 'neutral', trailing, chevron = false, selected = false, disabled = false, loading = false, flush = false, rule = false, href, onClick, forceState, testId, className, ...rest },
  ref,
) {
  const interactive = Boolean(onClick || href) && !disabled && !loading
  const cls = cx(styles.row, flush && styles.flush, rule && styles.rule, interactive && styles.interactive, selected && styles.selected, disabled && styles.disabled, className)
  const inner = loading ? (
    <>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <span className={styles.text}>
        <span className={styles.skeletonLine} style={{ width: '55%' }} />
        <span className={styles.skeletonLine} style={{ width: '35%', height: 10 }} />
      </span>
    </>
  ) : (
    <>
      {icon ? <span className={cx(styles.icon, iconTone === 'orange' && styles.iconOrange, iconTone === 'green' && styles.iconGreen, iconTone === 'red' && styles.iconRed)}>{icon}</span> : null}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </span>
      {meta !== undefined ? <span className={cx(styles.meta, metaTone === 'orange' && styles.metaOrange)}>{meta}</span> : null}
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      {chevron ? <span className={styles.chevron}><IconChevronRight size={16} /></span> : null}
    </>
  )
  if (href && interactive) {
    return <a href={href} className={cls} data-testid={testId} aria-current={selected || undefined} onClick={onClick as React.MouseEventHandler<HTMLAnchorElement>}>{inner}</a>
  }
  return (
    <div
      ref={ref}
      data-testid={testId}
      data-force={forceState}
      className={cls}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-disabled={disabled || undefined}
      aria-selected={selected || undefined}
      aria-busy={loading || undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(e as unknown as React.MouseEvent<HTMLElement>) } } : undefined}
      {...rest}
    >
      {inner}
    </div>
  )
})

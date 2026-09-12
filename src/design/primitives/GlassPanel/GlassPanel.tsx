'use client'
import * as React from 'react'
import styles from './GlassPanel.module.css'
import { cx } from '../../utils'
import { IconArrowUpRight, IconChevronUp } from '../../icons'

export type GlassVariant = 'glass' | 'glass-strong' | 'solid' | 'lit' | 'prism' | 'nested'

export interface GlassPanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** glass (default), glass-strong (readable over bright map), solid (--bg-1 on shell), lit (selected glass), prism (refraction rim), nested (--bg-2 tile inside a panel) */
  variant?: GlassVariant
  /** title-m by default; `titleSize="l"` renders title-l (Warning panel) */
  title?: React.ReactNode
  titleSize?: 'm' | 'l'
  /** "(2 lines)" style parenthetical after the title, --text-3 */
  parenthetical?: React.ReactNode
  /** body-s --text-3 line under the title (timestamps) */
  subtitle?: React.ReactNode
  /** Replaces the default title block entirely */
  header?: React.ReactNode
  /** Slot right of the title, before the affordance */
  headerRight?: React.ReactNode
  /** Corner affordance: "open" = arrow-up-right, "collapse" = chevron-up (rotates when collapsed), "none" */
  affordance?: 'open' | 'collapse' | 'none'
  affordanceLabel?: string
  onAffordance?: () => void
  collapsed?: boolean
  /** Title set in --text-2 because the card carries a display number (A1-3) */
  hasDisplayNumber?: boolean
  /** Card lifts on hover and is clickable / focusable (only cards that open something) */
  interactive?: boolean
  selected?: boolean
  disabled?: boolean
  /** Error card state (A11.10): body replaced by message + Retry */
  error?: string
  onRetry?: () => void
  padding?: 'card' | 'card-lg' | 'tile' | 'none'
  radius?: 'card' | 'card-lg' | 'inner'
  /** Section 7 enter animation */
  enter?: boolean
  /** 24px gap between header and body (title -> KPI) */
  headerGap?: boolean
  /** dev-only: render a state statically (showcase / visual QA) */
  forceState?: 'hover' | 'pressed' | 'focus'
  testId?: string
  as?: 'div' | 'section' | 'article' | 'aside' | 'nav'
}

export const GlassPanel = React.forwardRef<HTMLDivElement, GlassPanelProps>(function GlassPanel(
  {
    variant = 'glass', title, titleSize = 'm', parenthetical, subtitle, header, headerRight, affordance = 'none', affordanceLabel,
    onAffordance, collapsed = false, hasDisplayNumber = false, interactive = false, selected = false, disabled = false, error, onRetry,
    padding = 'card', radius = 'card', enter = false, headerGap = false, forceState, testId, as = 'div', className, children, onClick, onKeyDown, ...rest
  },
  ref,
) {
  const Tag = as as 'div'
  const variantClass = {
    glass: styles.glass,
    'glass-strong': styles.glassStrong,
    solid: styles.solid,
    lit: styles.lit,
    prism: styles.prism,
    nested: styles.nested,
  }[variant]
  const hasHeader = Boolean(header || title || affordance !== 'none' || headerRight)
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (interactive && onClick && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
      e.preventDefault()
      onClick(e as unknown as React.MouseEvent<HTMLDivElement>)
    }
  }
  return (
    <Tag
      ref={ref}
      data-testid={testId}
      data-variant={variant}
      data-force={forceState}
      data-selected={selected || undefined}
      className={cx(
        styles.panel,
        variantClass,
        radius === 'card-lg' && styles.radiusCardLg,
        radius === 'inner' && styles.radiusInner,
        padding === 'card-lg' && styles.padCardLg,
        padding === 'tile' && styles.padTile,
        padding === 'none' && styles.padNone,
        interactive && styles.interactive,
        selected && styles.selected,
        disabled && styles.disabled,
        error && styles.error,
        enter && styles.enter,
        className,
      )}
      role={interactive && onClick ? 'button' : undefined}
      tabIndex={interactive && onClick && !disabled ? 0 : undefined}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      onKeyDown={handleKey}
      {...rest}
    >
      {hasHeader ? (
        <div className={styles.header}>
          {header ?? (
            <div className={styles.titleBlock}>
              {title ? (
                <div className={cx(styles.title, titleSize === 'l' && styles.titleL, hasDisplayNumber && styles.titleDim)}>
                  <span>{title}</span>
                  {parenthetical ? <span className={styles.paren}>{parenthetical}</span> : null}
                </div>
              ) : null}
              {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
            </div>
          )}
          {headerRight || affordance !== 'none' ? (
            <div className={styles.headerRight}>
              {headerRight}
              {affordance === 'open' ? (
                <button type="button" className={styles.affordance} aria-label={affordanceLabel ?? 'Open detail'} onClick={(e) => { e.stopPropagation(); onAffordance?.() }} data-testid={testId ? `${testId}-open` : undefined}>
                  <IconArrowUpRight size={18} />
                </button>
              ) : null}
              {affordance === 'collapse' ? (
                <button type="button" className={cx(styles.affordance, styles.affordanceCollapse)} aria-label={affordanceLabel ?? (collapsed ? 'Expand' : 'Collapse')} aria-expanded={!collapsed} onClick={(e) => { e.stopPropagation(); onAffordance?.() }} data-testid={testId ? `${testId}-collapse` : undefined}>
                  <IconChevronUp size={16} className={cx(styles.chevron, collapsed && styles.chevronCollapsed)} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className={cx(styles.body, styles.errorBody, hasHeader && styles.bodyAfterHeader)} role="alert">
          <div className={styles.errorText}>{error}</div>
          {onRetry ? <button type="button" className={styles.retry} onClick={(e) => { e.stopPropagation(); onRetry() }}>Retry</button> : null}
        </div>
      ) : collapsed ? null : (
        <div className={cx(styles.body, hasHeader && (headerGap ? styles.headerGap : styles.bodyAfterHeader))}>{children}</div>
      )}
    </Tag>
  )
})

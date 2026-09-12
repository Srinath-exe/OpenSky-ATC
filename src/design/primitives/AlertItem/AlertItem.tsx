'use client'
import * as React from 'react'
import styles from './AlertItem.module.css'
import { cx } from '../../utils'
import { Badge } from '../Badge/Badge'
import { Button } from '../Button/Button'
import { IconChevronDown, IconSparkles, IconCheck } from '../../icons'

export type AlertSeverity = 'critical' | 'warning' | 'advisory' | 'info'

export interface AlertAffected { name: React.ReactNode; detail?: React.ReactNode; testId?: string }
export interface AlertRecommend {
  /** full command text, e.g. "BAW123 turn left heading 270" */
  text: string
  onAccept?: () => void
  /** already issued: row shows a check and the text in --text-3 */
  done?: boolean
  loading?: boolean
}

export interface AlertItemProps {
  severity: AlertSeverity
  /** badge numeral (pair index) */
  index: number | string
  title: React.ReactNode
  /** "4m ago" */
  time?: React.ReactNode
  expanded?: boolean
  onToggle?: (expanded: boolean) => void
  /** "Affected aircraft:" */
  affectedLabel?: React.ReactNode
  affected?: AlertAffected[]
  description?: React.ReactNode
  recommend?: AlertRecommend
  /** extra action buttons (Ack, Resolve) */
  actions?: React.ReactNode
  /** new-alert badge ring pulse */
  pulse?: boolean
  testId?: string
  className?: string
}

export function AlertItem({ severity, index, title, time, expanded: expandedProp, onToggle, affectedLabel = 'Affected aircraft:', affected, description, recommend, actions, pulse = false, testId, className }: AlertItemProps) {
  const [inner, setInner] = React.useState(false)
  const expanded = expandedProp ?? inner
  const hasBody = Boolean((affected && affected.length) || description || recommend || actions)
  const toggle = () => { const next = !expanded; if (expandedProp === undefined) setInner(next); onToggle?.(next) }
  const badgeTone = severity === 'advisory' ? 'orange' : severity === 'info' ? 'neutral' : 'red'
  return (
    <div data-testid={testId} data-severity={severity} className={cx(styles.item, styles[severity], className)}>
      <button type="button" className={styles.head} onClick={hasBody ? toggle : undefined} aria-expanded={hasBody ? expanded : undefined} data-testid={testId ? `${testId}-toggle` : undefined}>
        <Badge className={styles.badge} size="m" tone={badgeTone} value={index} glow={severity === 'critical'} pulse={pulse} />
        <span className={styles.titles}>
          <span className={styles.title}>{title}</span>
          {time ? <span className={styles.time}>{time}</span> : null}
        </span>
        {hasBody ? <span className={cx(styles.chevron, expanded && styles.chevronOpen)}><IconChevronDown size={16} /></span> : null}
      </button>
      {hasBody ? (
        <div className={cx(styles.bodyWrap, expanded && styles.bodyOpen)} aria-hidden={!expanded}>
          <div className={styles.body}>
            <div className={styles.bodyInner}>
              {description ? <div className={styles.description}>{description}</div> : null}
              {affected && affected.length ? (
                <>
                  <div className={styles.sectionLabel}>{affectedLabel}</div>
                  <div className={styles.affected}>
                    {affected.map((a, i) => (
                      <div key={i} className={styles.affectedItem} data-testid={a.testId}>
                        <span className={styles.affectedName}>{a.name}</span>
                        {a.detail ? <span className={styles.affectedDetail}>{a.detail}</span> : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              {recommend ? (
                <div className={styles.recommend}>
                  <span className={styles.recommendIcon}>{recommend.done ? <span className={styles.doneIcon}><IconCheck size={18} /></span> : <IconSparkles size={18} />}</span>
                  <span className={styles.recommendText}>
                    <span className={styles.recommendTitle}>Recommend</span>
                    {recommend.done ? (
                      <span className={styles.recommendDone}>{recommend.text}</span>
                    ) : (
                      <Button variant="accent" size="md" fullWidth loading={recommend.loading} onClick={(e) => { e.stopPropagation(); recommend.onAccept?.() }} testId={testId ? `${testId}-recommend` : undefined}>{recommend.text}</Button>
                    )}
                  </span>
                </div>
              ) : null}
              {actions ? <div className={styles.actions}>{actions}</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Group header row for the alerts panel: icon 18 + title-m + (parenthetical). */
export interface AlertGroupProps { icon?: React.ReactNode; title: React.ReactNode; parenthetical?: React.ReactNode; count?: number; countTone?: 'red' | 'white' | 'text-2' | 'text-3'; children?: React.ReactNode; testId?: string; className?: string }
export function AlertGroup({ icon, title, parenthetical, count, countTone = 'white', children, testId, className }: AlertGroupProps) {
  const countCls = countTone === 'red' ? styles.countRed : countTone === 'text-2' ? styles.countText2 : countTone === 'text-3' ? styles.countText3 : styles.countWhite
  return (
    <section data-testid={testId} className={cx(styles.group, className)}>
      <header className={styles.groupHead}>
        {icon ? <span className={styles.groupIcon}>{icon}</span> : null}
        <span>{title}</span>
        {parenthetical ? <span className={styles.groupParen}>{parenthetical}</span> : null}
        {count !== undefined ? <span className={cx(styles.groupCount, countCls)}>{count}</span> : null}
      </header>
      <div className={styles.groupItems}>{children}</div>
    </section>
  )
}

'use client'
import * as React from 'react'
import styles from './Stepper.module.css'
import { cx } from '../../utils'
import { Pill } from '../Pill/Pill'
import { Button } from '../Button/Button'
import { Kbd } from '../Kbd/Kbd'
import { IconChevronRight, IconArrowLeft, IconSend } from '../../icons'

export interface StepperStep {
  id: string
  /** chip label when not yet answered ("Heading") */
  label: string
  /** chosen value once answered ("270") - shown in the chip */
  value?: string
  testId?: string
}

export interface StepperProps {
  steps: StepperStep[]
  activeIndex: number
  /** jump back to a completed step */
  onStepClick?: (index: number) => void
  title?: React.ReactNode
  subtitle?: React.ReactNode
  /** phrase preview: pass strings or nodes; strings inside <strong> are white */
  summary?: React.ReactNode
  children?: React.ReactNode
  onBack?: () => void
  onCancel?: () => void
  onConfirm?: () => void
  backLabel?: string
  cancelLabel?: string
  confirmLabel?: string
  confirmDisabled?: boolean
  confirmLoading?: boolean
  /** show the Enter kbd hint on the confirm button */
  confirmHotkey?: boolean
  /** Enter confirms and Escape cancels when focus is inside (but not in an input) */
  keyboard?: boolean
  testId?: string
  className?: string
}

/** Multi-step command builder chrome (04 command tree). Breadcrumb chips: done = solid --bg-3 with the value, active = accent, upcoming = outline --text-3. */
export function Stepper({ steps, activeIndex, onStepClick, title, subtitle, summary, children, onBack, onCancel, onConfirm, backLabel = 'Back', cancelLabel = 'Cancel', confirmLabel = 'Transmit', confirmDisabled = false, confirmLoading = false, confirmHotkey = true, keyboard = true, testId, className }: StepperProps) {
  const onKey = (e: React.KeyboardEvent) => {
    if (!keyboard) return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === 'Enter' && onConfirm && !confirmDisabled && !confirmLoading) { e.preventDefault(); onConfirm() }
    else if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel() }
    else if (e.key === 'Backspace' && onBack && activeIndex > 0) { e.preventDefault(); onBack() }
  }
  return (
    <div data-testid={testId} className={cx(styles.root, className)} onKeyDown={onKey} tabIndex={-1}>
      {title ? <div><div className={styles.title}>{title}</div>{subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}</div> : null}
      <div className={styles.crumbs} role="list" aria-label="Steps">
        {steps.map((s, i) => {
          const done = i < activeIndex
          const active = i === activeIndex
          const chip = (
            <Pill
              key={s.id}
              size="xs"
              tone={done ? 'solid' : active ? 'orange' : 'dim'}
              interactive={done && Boolean(onStepClick)}
              onClick={done && onStepClick ? () => onStepClick(i) : undefined}
              testId={s.testId ?? (testId ? `${testId}-step-${s.id}` : undefined)}
              aria-current={active ? 'step' : undefined}
            >
              {done && s.value ? s.value : s.label}
            </Pill>
          )
          return (
            <React.Fragment key={s.id}>
              {i > 0 ? <span className={styles.sep} aria-hidden="true"><IconChevronRight size={12} /></span> : null}
              <span role="listitem">{chip}</span>
            </React.Fragment>
          )
        })}
      </div>
      {children !== undefined ? <div className={styles.body}>{children}</div> : null}
      {summary ? <div className={styles.summary} data-testid={testId ? `${testId}-summary` : undefined}>{summary}</div> : null}
      {onBack || onCancel || onConfirm ? (
        <div className={styles.footer}>
          {onBack ? <Button variant="ghost" iconLeft={<IconArrowLeft size={16} />} onClick={onBack} disabled={activeIndex === 0} testId={testId ? `${testId}-back` : undefined}>{backLabel}</Button> : null}
          <span className={styles.spacer} />
          {onCancel ? <Button variant="ghost" onClick={onCancel} testId={testId ? `${testId}-cancel` : undefined}>{cancelLabel}</Button> : null}
          {onConfirm ? (
            <Button variant="accent" iconLeft={<IconSend size={16} />} onClick={onConfirm} disabled={confirmDisabled} loading={confirmLoading} testId={testId ? `${testId}-confirm` : undefined}>
              {confirmLabel}
              {confirmHotkey ? <Kbd className={styles.hotkey}>Enter</Kbd> : null}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Helper to render a summary phrase with white fixes: <StepperSummary parts={[{text:'BAW123', strong:true}, ' turn left heading ', {text:'270', strong:true}]} /> */
export function StepperSummary({ parts }: { parts: Array<string | { text: string; strong?: boolean }> }) {
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <span key={i} className={p.strong ? styles.summaryStrong : undefined}>{p.text}</span>))}
    </>
  )
}

'use client'
import * as React from 'react'
import styles from './Toggle.module.css'
import { cx, useStableId } from '../../utils'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: React.ReactNode
  description?: React.ReactNode
  disabled?: boolean
  /** label on the left (settings rows) or right */
  labelPosition?: 'left' | 'right'
  name?: string
  /** dev-only: render a state statically (showcase / visual QA) */
  forceState?: 'hover' | 'pressed' | 'focus'
  testId?: string
  className?: string
}

export function Toggle({ checked, onChange, label, description, disabled = false, labelPosition = 'right', name, forceState, testId, className }: ToggleProps) {
  const id = useStableId('toggle')
  const button = (
    <button
      id={id}
      type="button"
      role="switch"
      name={name}
      aria-checked={checked}
      aria-labelledby={label ? `${id}-label` : undefined}
      disabled={disabled}
      data-testid={testId}
      data-force={forceState}
      className={cx(styles.track, checked && styles.on)}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  )
  if (!label) return <span className={cx(styles.wrap, disabled && styles.disabled, className)}>{button}</span>
  const text = (
    <span id={`${id}-label`} className={styles.label} onClick={() => { if (!disabled) onChange(!checked) }}>
      {label}
      {description ? <span className={styles.sub}>{description}</span> : null}
    </span>
  )
  return (
    <span className={cx(styles.wrap, disabled && styles.disabled, className)}>
      {labelPosition === 'left' ? text : null}
      {button}
      {labelPosition === 'right' ? text : null}
    </span>
  )
}

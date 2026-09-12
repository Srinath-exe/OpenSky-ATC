'use client'
import * as React from 'react'
import styles from './Checkbox.module.css'
import { cx, useStableId } from '../../utils'
import { IconCheck } from '../../icons'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  indeterminate?: boolean
  label?: React.ReactNode
  description?: React.ReactNode
  disabled?: boolean
  error?: boolean
  name?: string
  testId?: string
  className?: string
}

export function Checkbox({ checked, onChange, indeterminate = false, label, description, disabled = false, error = false, name, testId, className }: CheckboxProps) {
  const id = useStableId('cb')
  const toggle = () => { if (!disabled) onChange(!checked) }
  return (
    <span className={cx(styles.wrap, disabled && styles.disabled, className)}>
      <button
        id={id}
        type="button"
        role="checkbox"
        name={name}
        aria-checked={indeterminate ? 'mixed' : checked}
        aria-labelledby={label ? `${id}-label` : undefined}
        disabled={disabled}
        data-testid={testId}
        className={cx(styles.box, checked && !indeterminate && styles.checked, indeterminate && styles.indeterminate, error && styles.error)}
        onClick={toggle}
      >
        <span className={styles.mark} aria-hidden="true">{indeterminate ? <span className={styles.dash} /> : <IconCheck size={12} strokeWidth={2} />}</span>
      </button>
      {label ? (
        <span id={`${id}-label`} className={styles.label} onClick={toggle}>
          {label}
          {description ? <span className={styles.sub}>{description}</span> : null}
        </span>
      ) : null}
    </span>
  )
}

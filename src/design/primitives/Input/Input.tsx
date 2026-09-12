'use client'
import * as React from 'react'
import styles from './Input.module.css'
import { cx, useStableId } from '../../utils'

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  label?: React.ReactNode
  /** leading 16px icon in --text-3 (search / terminal) */
  prefixIcon?: React.ReactNode
  /** trailing slot: Kbd hint, ghost IconButton, spinner */
  suffix?: React.ReactNode
  /** error message: red border + body-s red helper 6px below, no red fill */
  error?: string
  helper?: React.ReactNode
  /** l 40 (default) / m 36 */
  size?: 'l' | 'm'
  /** glass over map / solid --bg-2 on shell (default) / transparent */
  surface?: 'solid' | 'glass' | 'transparent'
  tabular?: boolean
  fullWidth?: boolean
  /** bump to replay the +-3px shake (parse error) */
  shakeKey?: number | string
  /** bump to replay the accepted border flash */
  acceptKey?: number | string
  wrapClassName?: string
  /** dev-only: render a state statically (showcase / visual QA) */
  forceState?: 'hover' | 'pressed' | 'focus'
  testId?: string
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, prefixIcon, suffix, error, helper, size = 'l', surface = 'solid', tabular = false, fullWidth = false, shakeKey, acceptKey, wrapClassName, forceState, testId, className, style, disabled, id: idProp, onFocus, onBlur, ...rest },
  ref,
) {
  const autoId = useStableId('input')
  const id = idProp ?? autoId
  const [focused, setFocused] = React.useState(false)
  const [shaking, setShaking] = React.useState(false)
  const [accepted, setAccepted] = React.useState(false)
  const first = React.useRef(true)
  const firstA = React.useRef(true)
  React.useEffect(() => {
    if (first.current) { first.current = false; return }
    if (shakeKey === undefined) return
    setShaking(true)
    const t = setTimeout(() => setShaking(false), 260)
    return () => clearTimeout(t)
  }, [shakeKey])
  React.useEffect(() => {
    if (firstA.current) { firstA.current = false; return }
    if (acceptKey === undefined) return
    setAccepted(true)
    const t = setTimeout(() => setAccepted(false), 340)
    return () => clearTimeout(t)
  }, [acceptKey])
  const describedBy = error ? `${id}-error` : helper ? `${id}-helper` : undefined
  return (
    <div className={cx(styles.field, fullWidth && styles.full, className)} style={style}>
      {label ? <label htmlFor={id} className={styles.label}>{label}</label> : null}
      <div className={cx(styles.wrap, size === 'm' && styles.m, surface === 'glass' && styles.glass, surface === 'transparent' && styles.transparent, (focused || forceState === 'focus') && styles.focused, prefixIcon && styles.hasPrefix, suffix && styles.hasSuffix, error && styles.error, disabled && styles.disabled, tabular && styles.tabular, shaking && styles.shake, accepted && styles.accepted, wrapClassName)} data-force={forceState} data-testid={testId ? `${testId}-wrap` : undefined}>
        {prefixIcon ? <span className={styles.prefix}>{prefixIcon}</span> : null}
        <input
          ref={ref}
          id={id}
          data-testid={testId}
          className={styles.input}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onFocus={(e) => { setFocused(true); onFocus?.(e) }}
          onBlur={(e) => { setFocused(false); onBlur?.(e) }}
          {...rest}
        />
        {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
      </div>
      {error ? <div id={`${id}-error`} className={cx(styles.helper, styles.helperError)} role="alert">{error}</div> : helper ? <div id={`${id}-helper`} className={styles.helper}>{helper}</div> : null}
    </div>
  )
})

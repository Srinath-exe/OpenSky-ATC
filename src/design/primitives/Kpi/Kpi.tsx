'use client'
import * as React from 'react'
import styles from './Kpi.module.css'
import { cx, splitNumber, useCountUp, formatThousands } from '../../utils'
import { IconArrowUp, IconArrowDown } from '../../icons'

export interface KpiProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'prefix'> {
  /** Number (formatted with thousands comma, `decimals`) or pre-formatted string ("FL350", "78.3"); optional when `hi`/`lo` are given */
  value?: number | string
  decimals?: number
  /** Where the dim trailing group starts: auto (first comma, else decimal), comma, decimal, none; or explicit `hi`/`lo` */
  split?: 'auto' | 'comma' | 'decimal' | 'none'
  hi?: string
  lo?: string
  /** Unit sits on the baseline in body-s --text-2 ("%" has no gap - A1-7) */
  unit?: React.ReactNode
  unitTone?: 'text-2' | 'text-3' | 'text-4'
  /** Same-size dim suffix ("min" after "± 2.5") */
  suffixDisplay?: string
  /** "± ", "HDG ", "FL" - rendered verbatim before the number (include a trailing space when the format wants one); white, or --text-2 with `prefixDim` */
  prefix?: string
  prefixDim?: boolean
  /** xl 44 / l 36 / m 28 */
  size?: 'xl' | 'l' | 'm'
  /** label-xs --text-3 above (metrics grid) */
  label?: React.ReactNode
  /** delta arrow + value, right of the unit */
  delta?: number
  deltaUnit?: string
  /** how to colour delta: up=text-2/down=orange (late) by default */
  deltaTone?: 'auto' | 'neutral' | 'red' | 'green'
  tabular?: boolean
  /** 600ms count-up on increase (numbers only) */
  countUp?: boolean
  /** whole number --text-3 (zero state) */
  dim?: boolean
  red?: boolean
  testId?: string
}

export function Kpi({ value = '', decimals = 0, split = 'auto', hi, lo, unit, unitTone = 'text-2', suffixDisplay, prefix, prefixDim = false, size = 'xl', label, delta, deltaUnit = '', deltaTone = 'auto', tabular = false, countUp = false, dim = false, red = false, testId, className, ...rest }: KpiProps) {
  const numeric = typeof value === 'number' ? value : NaN
  const animated = useCountUp(Number.isFinite(numeric) ? numeric : 0, 600, { enabled: countUp && Number.isFinite(numeric) })
  const shown = Number.isFinite(numeric) ? (countUp ? animated : numeric) : NaN
  let formatted: string
  if (typeof value === 'string') formatted = value
  else formatted = decimals > 0 ? shown.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : formatThousands(shown)
  const parts = hi !== undefined ? { hi, lo: lo ?? '' } : splitNumber(formatted, split)
  const isEmpty = hi === undefined && (value === '' || value === '—' || (typeof value === 'number' && !Number.isFinite(value)))
  const unitIsPct = unit === '%'
  const deltaCls = deltaTone === 'red' ? styles.deltaRed : deltaTone === 'green' ? styles.deltaGreen : deltaTone === 'neutral' ? styles.deltaUp : (delta ?? 0) > 0 ? styles.deltaDown : styles.deltaUp
  const body = (
    <div data-testid={testId} className={cx(styles.kpi, styles[size], tabular && styles.tnum, dim && styles.dim, isEmpty && styles.empty, red && styles.red, !label && className)} aria-label={typeof value === 'number' ? `${prefix ?? ''}${formatted}${unit ? ` ${unit}` : ''}` : undefined} {...(!label ? rest : {})}>
      {isEmpty ? <span className={styles.hi}>{prefix ? <span className={cx(styles.prefix, prefixDim && styles.prefixDim)}>{prefix}</span> : null}—</span> : (
        <span>
          {prefix ? <span className={cx(styles.prefix, prefixDim && styles.prefixDim)}>{prefix}</span> : null}
          <span className={styles.hi}>{parts.hi}</span>
          {parts.lo ? <span className={styles.lo}>{parts.lo}</span> : null}
        </span>
      )}
      {suffixDisplay ? <span className={styles.loDisplay}>{suffixDisplay}</span> : null}
      {unit ? <span className={cx(styles.unit, unitTone === 'text-3' && styles.unitDim, unitTone === 'text-4' && styles.lo, unitIsPct && styles.unitPct)}>{unit}</span> : null}
      {delta !== undefined ? (
        <span className={cx(styles.delta, deltaCls)} aria-label={`${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta)}${deltaUnit}`}>
          {delta >= 0 ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />}
          {Math.abs(delta)}{deltaUnit}
        </span>
      ) : null}
    </div>
  )
  if (!label) return body
  return (
    <div className={cx(styles.block, className)} {...rest}>
      <span className={styles.label}>{label}</span>
      {body}
    </div>
  )
}

'use client'
import * as React from 'react'
import styles from './Ladder.module.css'
import { cx, clamp } from '../../utils'
import { Button } from '../Button/Button'
import { Kpi } from '../Kpi/Kpi'
import { IconArrowUp, IconArrowDown } from '../../icons'

export interface LadderProps {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  /** snap step (1000 ft / 10 kt) */
  step: number
  /** labelled major tick every n units (5000 / 50) */
  majorEvery?: number
  /** aircraft's current value: white dashed marker + tinted range to the target */
  current?: number
  /** ALT / SPD */
  label?: string
  unit?: string
  /** formats tick labels (default: "5k" for whole thousands, else thousands comma) */
  formatTick?: (v: number) => string
  /** formats the marker chip (default: thousands comma) */
  formatValue?: (v: number) => string
  /** plot height (240) */
  height?: number
  width?: number
  /** A11.4 quick step pills, e.g. [3000, 1000, -1000, -3000]; rendered right of the ladder */
  quickSteps?: number[]
  quickLabel?: (v: number) => string
  stepsLayout?: 'column' | 'row'
  /** hide the header (label + big number) */
  hideHeader?: boolean
  disabled?: boolean
  onGlass?: boolean
  testId?: string
  className?: string
}

const defaultTick = (v: number) => (Math.abs(v) >= 1000 && v % 1000 === 0 ? `${v / 1000}k` : v.toLocaleString('en-US'))
const defaultValue = (v: number) => v.toLocaleString('en-US')

/** Vertical picker: drag / click / wheel on the ruler, arrows (step), PageUp/Down (5 steps), Home/End. */
export function Ladder({ value, onChange, min, max, step, majorEvery, current, label = 'ALT', unit = 'ft', formatTick = defaultTick, formatValue, height = 240, width = 128, quickSteps, quickLabel, stepsLayout = 'column', hideHeader = false, disabled = false, onGlass = false, testId, className }: LadderProps) {
  const svgRef = React.useRef<SVGSVGElement>(null)
  const dragging = React.useRef(false)
  const major = majorEvery ?? step * 5
  const PAD = 14
  const inner = height - PAD * 2
  const y = (v: number) => PAD + inner - ((v - min) / Math.max(1e-9, max - min)) * inner
  const snap = (v: number) => clamp(Math.round(v / step) * step, min, max)
  const set = (v: number) => { if (!disabled) onChange(snap(v)) }
  const fromPointer = (e: React.PointerEvent | PointerEvent) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    const py = ((e.clientY - r.top) / r.height) * height
    set(min + ((PAD + inner - py) / inner) * (max - min))
  }
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => { if (disabled) return; dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus({ preventScroll: true }); fromPointer(e) }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => { if (dragging.current) fromPointer(e) }
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => { dragging.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ } }
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); set(value + step); break
      case 'ArrowDown': e.preventDefault(); set(value - step); break
      case 'PageUp': e.preventDefault(); set(value + step * 5); break
      case 'PageDown': e.preventDefault(); set(value - step * 5); break
      case 'Home': e.preventDefault(); set(current ?? min); break
      case 'End': e.preventDefault(); set(max); break
    }
  }
  React.useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const h = (e: WheelEvent) => { if (!disabled) { e.preventDefault(); set(value + (e.deltaY < 0 ? step : -step)) } }
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  })

  const ticks: React.ReactNode[] = []
  const rulerX = 48
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6
    const active = Math.round(v) === Math.round(value)
    ticks.push(<line key={v} className={cx(styles.tick, !isMajor && styles.tickMinor)} x1={rulerX} x2={rulerX + (isMajor ? 10 : 6)} y1={y(v)} y2={y(v)} />)
    if (isMajor) ticks.push(<text key={`t${v}`} className={cx(styles.tickLabel, active && styles.tickLabelActive)} x={rulerX - 8} y={y(v)} textAnchor="end">{formatTick(v)}</text>)
  }
  const chipText = (formatValue ?? defaultValue)(value)
  const chipW = Math.max(40, chipText.length * 7 + 14)
  const chipX = Math.min(rulerX + 18, width - chipW - 6)
  const vy = y(value)
  const cy = current !== undefined ? y(clamp(current, min, max)) : null

  return (
    <div data-testid={testId} className={cx(styles.root, disabled && styles.disabled, className)}>
      {!hideHeader ? (
        <div className={styles.head}>
          <span className={styles.label}>{label}</span>
          <Kpi size="m" value={value} unit={unit} tabular testId={testId ? `${testId}-value` : undefined} />
        </div>
      ) : null}
      <div className={styles.body}>
        <svg
          ref={svgRef}
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="slider"
          aria-label={label}
          aria-orientation="vertical"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={`${chipText} ${unit}`}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKey}
          data-testid={testId ? `${testId}-svg` : undefined}
        >
          <rect className={cx(styles.track, onGlass && styles.trackGlass)} x={0} y={0} width={width} height={height} rx={12} />
          {cy !== null ? <rect className={styles.range} x={rulerX} width={width - rulerX} y={Math.min(cy, vy)} height={Math.max(0, Math.abs(cy - vy))} /> : null}
          {ticks}
          {cy !== null ? (
            <g>
              <line className={styles.currentLine} x1={rulerX} x2={width - 6} y1={cy} y2={cy} />
              <path className={styles.currentTri} d={`M${width - 4},${cy} l-6,-4 v8 z`} />
            </g>
          ) : null}
          <line className={styles.valueLine} x1={rulerX} x2={width - 6} y1={vy} y2={vy} />
          <g>
            <rect className={styles.valueChip} x={chipX} y={vy - 11} width={chipW} height={22} rx={11} />
            <rect className={styles.valueChipFill} x={chipX} y={vy - 11} width={chipW} height={22} rx={11} />
            <text className={styles.valueText} x={chipX + chipW / 2} y={vy + 0.5}>{chipText}</text>
          </g>
          <rect className={styles.hit} x={0} y={0} width={width} height={height} />
        </svg>
        {quickSteps?.length ? (
          <div className={cx(styles.steps, stepsLayout === 'row' && styles.stepsRow)}>
            {quickSteps.map((q) => (
              <Button key={q} size="md" tabular disabled={disabled || value + q < min || value + q > max} iconLeft={q > 0 ? <IconArrowUp size={14} /> : <IconArrowDown size={14} />} onClick={() => set(value + q)} testId={testId ? `${testId}-step-${q}` : undefined} className={styles.stepBtn}>
                {quickLabel ? quickLabel(q) : Math.abs(q) >= 1000 ? `${Math.abs(q) / 1000}k` : String(Math.abs(q))}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

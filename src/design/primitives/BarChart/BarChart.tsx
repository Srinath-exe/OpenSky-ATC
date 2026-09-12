'use client'
import * as React from 'react'
import styles from './BarChart.module.css'
import { cx } from '../../utils'
import { IconArrowUp, IconArrowDown } from '../../icons'

export interface BarDatum {
  label: string
  /** floating range [min, max] of the current series (orange); a single number is drawn as a min-length bar at that value */
  current: [number, number] | number
  /** comparison series (grey) */
  compare?: [number, number] | number
  /** value shown in the tooltip (defaults to current max) */
  value?: number
  /** delta shown next to the tooltip value ("142 up 4") */
  delta?: number
  testId?: string
}

export interface BarChartProps {
  data: BarDatum[]
  /** y gridlines + labels on the right (e.g. [50000, 100000, 150000]) */
  yTicks: number[]
  /** domain; defaults to [min(yTicks, data), max(yTicks, data)] */
  domain?: [number, number]
  formatY?: (v: number) => string
  formatValue?: (v: number) => string
  /** plot height in px (220 desktop) */
  height?: number
  selected?: number | null
  onSelect?: (index: number | null) => void
  /** show tooltip on the selected column */
  tooltip?: boolean
  /** legend labels; omit to hide (single-series) */
  legend?: { current: string; compare?: string }
  /** draw-in animation (bars scale-Y with 30ms stagger) */
  animate?: boolean
  onGlass?: boolean
  ariaLabel?: string
  testId?: string
  className?: string
}

const AXIS_W = 44
const AXIS_GAP = 12
const MIN_BAR = 4

function fmtK(v: number): string {
  if (Math.abs(v) >= 1000) return `${Math.round(v / 1000)}k`
  return String(Math.round(v))
}
function toRange(v: [number, number] | number | undefined): [number, number] | null {
  if (v === undefined) return null
  return typeof v === 'number' ? [v, v] : v
}

export function BarChart({ data, yTicks, domain, formatY = fmtK, formatValue = (v) => Math.round(v).toLocaleString('en-US'), height = 220, selected = null, onSelect, tooltip = true, legend, animate = true, onGlass = false, ariaLabel = 'Bar chart', testId, className }: BarChartProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(400)
  const [hover, setHover] = React.useState<number | null>(null)
  const [focusIdx, setFocusIdx] = React.useState<number | null>(null)
  const [focused, setFocused] = React.useState(false)
  const gradId = React.useId().replace(/:/g, '')

  React.useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width; if (w) setWidth(w) })
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width || 400)
    return () => ro.disconnect()
  }, [])

  const all = data.flatMap((d) => [...(toRange(d.current) ?? []), ...(toRange(d.compare) ?? [])])
  const dMin = domain?.[0] ?? Math.min(...yTicks, ...all)
  const dMax = domain?.[1] ?? Math.max(...yTicks, ...all)
  const plotW = Math.max(0, width - AXIS_W)
  const totalH = height + AXIS_GAP + 16
  const y = (v: number) => height - ((v - dMin) / Math.max(1e-9, dMax - dMin)) * height
  const n = Math.max(1, data.length)
  const pitch = plotW / n

  const select = (i: number | null) => onSelect?.(i)
  const onKey = (e: React.KeyboardEvent) => {
    if (!data.length) return
    const cur = focusIdx ?? selected ?? 0
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = e.key === 'ArrowRight' ? Math.min(data.length - 1, cur + 1) : Math.max(0, cur - 1)
      setFocusIdx(next)
      if (selected !== null) select(next)
    } else if (e.key === 'Home') { e.preventDefault(); setFocusIdx(0) }
    else if (e.key === 'End') { e.preventDefault(); setFocusIdx(data.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(cur === selected ? null : cur) }
    else if (e.key === 'Escape') { select(null) }
  }

  const sel = selected !== null && selected >= 0 && selected < data.length ? data[selected] : null
  const selRange = sel ? toRange(sel.current) : null
  const tooltipX = selected !== null ? selected * pitch + pitch / 2 - 4.5 : 0
  const tooltipClampedX = Math.max(50, Math.min(plotW - 50, tooltipX))
  const tooltipBottom = selRange ? totalH - y(Math.max(selRange[0], selRange[1])) + 8 : 0

  return (
    <div ref={rootRef} data-testid={testId} className={cx(styles.root, onGlass && styles.onGlass, animate && styles.animate, className)}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${Math.max(1, width)} ${totalH}`}
        width={Math.max(1, width)}
        height={totalH}
        role="group"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => { setFocused(true); if (focusIdx === null) setFocusIdx(selected ?? 0) }}
        onBlur={() => setFocused(false)}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`${gradId}-band`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(245,147,63,0.03)" />
            <stop offset="0.5" stopColor="rgba(245,147,63,0.08)" />
            <stop offset="1" stopColor="rgba(245,147,63,0.03)" />
          </linearGradient>
        </defs>
        {/* grid + y labels (right) */}
        {yTicks.map((t, i) => (
          <g key={t}>
            <line className={cx(styles.grid, (i === 0 || i === yTicks.length - 1) && yTicks.length > 3 && styles.gridFaint)} x1={0} x2={plotW} y1={y(t)} y2={y(t)} />
            <text className={styles.yLabel} x={width} y={y(t)}>{formatY(t)}</text>
          </g>
        ))}
        {/* columns */}
        {data.map((d, i) => {
          const x0 = i * pitch
          const cx0 = x0 + pitch / 2
          const cur = toRange(d.current)
          const cmp = toRange(d.compare)
          const isSel = selected === i
          const isHover = hover === i && !isSel
          const isFocus = focused && focusIdx === i && !isSel
          const bar = (r: [number, number], x: number, cls: string, delay: number, key: string) => {
            let y1 = y(Math.max(r[0], r[1]))
            let y2 = y(Math.min(r[0], r[1]))
            if (y2 - y1 < MIN_BAR) { const mid = (y1 + y2) / 2; y1 = mid - MIN_BAR / 2; y2 = mid + MIN_BAR / 2 }
            return <line key={key} className={cx(styles.bar, cls)} x1={x} x2={x} y1={y1} y2={y2} style={{ animationDelay: `${delay}ms` }} />
          }
          return (
            <g key={d.label + i} className={styles.column} data-testid={d.testId} onMouseEnter={() => setHover(i)} onClick={() => select(isSel ? null : i)}>
              <rect className={cx(styles.band, isHover && styles.bandHover, isSel && styles.bandSelected, isFocus && styles.bandFocus)} x={x0 + 4} y={0} width={Math.max(0, pitch - 8)} height={height} rx={6} fill={`url(#${gradId}-band)`} />
              <rect className={styles.hit} x={x0} y={0} width={pitch} height={height + AXIS_GAP + 16} />
              {cur ? bar(cur, cx0 - 4.5, styles.barCurrent, i * 30, 'c') : null}
              {cmp ? bar(cmp, cx0 + 2.5, styles.barCompare, i * 30 + 15, 'p') : null}
              <text className={cx(styles.xLabel, isSel && styles.xLabelSelected)} x={cx0} y={height + AXIS_GAP}>{d.label}</text>
            </g>
          )
        })}
      </svg>
      {tooltip && sel && selRange ? (
        <div className={styles.tooltip} style={{ left: tooltipClampedX, bottom: tooltipBottom }} role="status" data-testid={testId ? `${testId}-tooltip` : undefined}>
          <span>{formatValue(sel.value ?? Math.max(selRange[0], selRange[1]))}</span>
          {sel.delta !== undefined ? <span className={styles.tooltipDelta}>{sel.delta >= 0 ? <IconArrowUp size={10} /> : <IconArrowDown size={10} />}{Math.abs(sel.delta)}</span> : null}
        </div>
      ) : null}
      {legend ? (
        <div className={styles.legend}>
          <span className={styles.legendItem}><span className={cx(styles.swatch, styles.swatchCurrent)} />{legend.current}</span>
          {legend.compare ? <span className={styles.legendItem}><span className={cx(styles.swatch, styles.swatchCompare)} />{legend.compare}</span> : null}
        </div>
      ) : null}
      <table className={styles.srTable}>
        <caption>{ariaLabel}</caption>
        <tbody>{data.map((d) => { const r = toRange(d.current); return <tr key={d.label}><th scope="row">{d.label}</th><td>{r ? formatValue(d.value ?? Math.max(r[0], r[1])) : '—'}</td></tr> })}</tbody>
      </table>
    </div>
  )
}

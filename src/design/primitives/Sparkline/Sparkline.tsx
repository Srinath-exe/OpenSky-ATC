'use client'
import * as React from 'react'
import styles from './Sparkline.module.css'
import { cx } from '../../utils'

export interface SparklineProps {
  /** samples, evenly spaced (one per minute -> one per px at 1x is the ideal) */
  data: number[]
  /** y domain; defaults to [min(yTicks,data), max(yTicks,data)] */
  domain?: [number, number]
  /** y gridlines + labels on the right (25 50 75 100) */
  yTicks?: number[]
  formatY?: (v: number) => string
  formatValue?: (v: number) => string
  /** x labels spread evenly across the plot (first left-aligned, last right-aligned) */
  xLabels?: string[]
  /** horizontal dashed target line */
  target?: number
  /** "Target:" caption top-left and ">80%" label above the line at right */
  targetCaption?: string
  targetLabel?: string
  /** segments at/above target get the white treatment (dots at crossings + band) */
  highlightAbove?: boolean
  /** segments below this value get the orange treatment */
  lowThreshold?: number
  /** plot height (120) */
  height?: number
  /** last point Ø5 white dot with pulsing halo */
  showCurrent?: boolean
  /** vertical cursor line at sample index (controlled) */
  cursor?: number | null
  onCursorChange?: (index: number | null) => void
  /** tooltip at the cursor (value + x label) */
  cursorTooltip?: boolean
  animate?: boolean
  onGlass?: boolean
  ariaLabel?: string
  testId?: string
  className?: string
}

const AXIS_W = 44
const AXIS_GAP = 12

type Segment = { start: number; end: number; kind: 'hi' | 'lo' }

function findSegments(data: number[], pred: (v: number) => boolean, kind: 'hi' | 'lo'): Segment[] {
  const segs: Segment[] = []
  let start = -1
  for (let i = 0; i < data.length; i++) {
    const on = pred(data[i])
    if (on && start === -1) start = i
    if (!on && start !== -1) { segs.push({ start, end: i - 1, kind }); start = -1 }
  }
  if (start !== -1) segs.push({ start, end: data.length - 1, kind })
  return segs.filter((s) => s.end > s.start)
}

export function Sparkline({ data, domain, yTicks, formatY = (v) => `${Math.round(v)}%`, formatValue = (v) => `${v.toFixed(1)}`, xLabels, target, targetCaption, targetLabel, highlightAbove = true, lowThreshold, height = 120, showCurrent = false, cursor = null, onCursorChange, cursorTooltip = true, animate = true, onGlass = false, ariaLabel = 'Sparkline', testId, className }: SparklineProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(400)
  const [localCursor, setLocalCursor] = React.useState<number | null>(null)
  const cur = cursor ?? localCursor
  const setCursor = (i: number | null) => { setLocalCursor(i); onCursorChange?.(i) }

  React.useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width; if (w) setWidth(w) })
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width || 400)
    return () => ro.disconnect()
  }, [])

  const ticks = yTicks ?? []
  const dMin = domain?.[0] ?? Math.min(...ticks, ...data)
  const dMax = domain?.[1] ?? Math.max(...ticks, ...data)
  const plotW = Math.max(0, width - (ticks.length ? AXIS_W : 0))
  const totalH = height + (xLabels?.length ? AXIS_GAP + 16 : 0)
  const n = data.length
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * plotW)
  const y = (v: number) => height - ((v - dMin) / Math.max(1e-9, dMax - dMin)) * height
  const pathFor = (from: number, to: number) => data.slice(from, to + 1).map((v, k) => `${k === 0 ? 'M' : 'L'}${x(from + k).toFixed(2)},${y(v).toFixed(2)}`).join('')
  const basePath = n ? pathFor(0, n - 1) : ''
  const hiSegs = target !== undefined && highlightAbove ? findSegments(data, (v) => v >= target, 'hi') : []
  const loSegs = lowThreshold !== undefined ? findSegments(data, (v) => v < lowThreshold, 'lo') : []
  const approxLen = n ? n * 3 + plotW : 0

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * width
    if (px > plotW || n === 0) { setCursor(null); return }
    setCursor(Math.max(0, Math.min(n - 1, Math.round((px / Math.max(1, plotW)) * (n - 1)))))
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!n) return
    const c = cur ?? n - 1
    if (e.key === 'ArrowRight') { e.preventDefault(); setCursor(Math.min(n - 1, c + 1)) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setCursor(Math.max(0, c - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0) }
    else if (e.key === 'End') { e.preventDefault(); setCursor(n - 1) }
    else if (e.key === 'Escape') setCursor(null)
  }
  const xLabelFor = (i: number) => (xLabels && n > 1 ? xLabels[Math.round((i / (n - 1)) * (xLabels.length - 1))] : undefined)

  return (
    <div ref={rootRef} data-testid={testId} className={cx(styles.root, animate && styles.animate, onGlass && styles.onGlass, className)} style={{ '--len': approxLen } as React.CSSProperties}>
      {targetCaption ? <div className={styles.header}><span>{targetCaption}</span></div> : null}
      <svg className={styles.svg} viewBox={`0 0 ${Math.max(1, width)} ${totalH}`} width={Math.max(1, width)} height={totalH} role="group" aria-label={ariaLabel} tabIndex={0} onKeyDown={onKey} onMouseMove={onMove} onMouseLeave={() => setCursor(null)}>
        {ticks.map((t, i) => (
          <g key={t}>
            <line className={cx(styles.grid, (i === 0 || i === ticks.length - 1) && ticks.length > 2 && styles.gridFaint)} x1={0} x2={plotW} y1={y(t)} y2={y(t)} />
            <text className={styles.yLabel} x={width} y={y(t)}>{formatY(t)}</text>
          </g>
        ))}
        {[...hiSegs, ...loSegs].map((s) => (
          <rect key={`b${s.kind}${s.start}`} className={cx(styles.band, s.kind === 'lo' && styles.bandOrange)} x={x(s.start)} y={0} width={Math.max(1, x(s.end) - x(s.start))} height={height} />
        ))}
        {target !== undefined ? (
          <g>
            <line className={styles.target} x1={0} x2={plotW} y1={y(target)} y2={y(target)} />
            {targetLabel ? <text className={styles.targetLabel} x={plotW} y={y(target) - 8}>{targetLabel}</text> : null}
          </g>
        ) : null}
        {basePath ? <path className={styles.line} d={basePath} /> : null}
        {hiSegs.map((s) => <path key={`h${s.start}`} className={styles.hi} d={pathFor(s.start, s.end)} />)}
        {loSegs.map((s) => <path key={`l${s.start}`} className={styles.lo} d={pathFor(s.start, s.end)} />)}
        {[...hiSegs, ...loSegs].flatMap((s) => [s.start, s.end].map((i) => (
          <circle key={`d${s.kind}${i}`} className={cx(styles.dot, s.kind === 'lo' && styles.dotOrange)} cx={x(i)} cy={y(data[i])} r={3.5} />
        )))}
        {showCurrent && n ? (
          <g>
            <circle className={styles.currentHalo} cx={x(n - 1)} cy={y(data[n - 1])} r={6} />
            <circle className={styles.current} cx={x(n - 1)} cy={y(data[n - 1])} r={2.5} />
          </g>
        ) : null}
        {cur !== null && cur >= 0 && cur < n ? (
          <g>
            <line className={styles.cursor} x1={x(cur)} x2={x(cur)} y1={0} y2={height} />
            <circle className={styles.cursorDot} cx={x(cur)} cy={y(data[cur])} r={3} />
          </g>
        ) : null}
        {xLabels?.map((l, i) => {
          const px = xLabels.length === 1 ? 0 : (i / (xLabels.length - 1)) * plotW
          const anchor = i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'
          return <text key={l + i} className={cx(styles.xLabel, (i === 0 || i === xLabels.length - 1) && xLabels.length > 3 && styles.xLabelFar)} x={px} y={height + AXIS_GAP} textAnchor={anchor}>{l}</text>
        })}
        <rect className={styles.hit} x={0} y={0} width={plotW} height={height} />
      </svg>
      {cursorTooltip && cur !== null && cur >= 0 && cur < n ? (
        <div className={styles.tooltip} style={{ left: x(cur), top: Math.max(0, y(data[cur]) - 34 + (targetCaption ? 17 : 0)) }} role="status">
          <span>{formatValue(data[cur])}</span>
          {xLabelFor(cur) ? <span className={styles.tooltipDim}>{xLabelFor(cur)}</span> : null}
        </div>
      ) : null}
      <table className={styles.srTable}><caption>{ariaLabel}</caption><tbody><tr><td>{n ? `${formatValue(data[n - 1])} latest` : '—'}</td></tr></tbody></table>
    </div>
  )
}

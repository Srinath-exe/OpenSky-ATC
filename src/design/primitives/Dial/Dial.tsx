'use client'
import * as React from 'react'
import styles from './Dial.module.css'
import { cx, wrapHeading } from '../../utils'
import { Button } from '../Button/Button'
import { IconRotateCcw, IconRotateCw } from '../../icons'

export interface DialProps {
  /** selected heading 0-359 */
  value: number
  onChange: (heading: number) => void
  /** aircraft's current heading: white marker + turn arc from it to the target */
  current?: number
  /** turn direction for the arc; auto = shortest */
  turn?: 'left' | 'right' | 'auto'
  /** snap step in degrees (5 default; 1 with Shift held on keyboard) */
  step?: number
  /** px (200) */
  size?: number
  label?: string
  disabled?: boolean
  /** quick +-10 / +-30 pills below */
  quickSteps?: number[]
  onGlass?: boolean
  testId?: string
  className?: string
}

const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180
/* Rounded to 1/1000 px so server and client render identical attributes (trig noise differs across runtimes). */
const r3 = (v: number) => Math.round(v * 1000) / 1000
function polar(cx: number, cy: number, r: number, deg: number) { return { x: r3(cx + r * Math.cos(toRad(deg))), y: r3(cy + r * Math.sin(toRad(deg))) } }
function arcPath(cx: number, cy: number, r: number, from: number, to: number, clockwise: boolean) {
  let sweep = clockwise ? wrapHeading(to - from) : wrapHeading(from - to)
  if (sweep === 0) return ''
  if (sweep >= 359.5) sweep = 359.5
  const s = polar(cx, cy, r, from)
  const e = polar(cx, cy, r, clockwise ? from + sweep : from - sweep)
  return `M${s.x.toFixed(2)},${s.y.toFixed(2)}A${r},${r} 0 ${sweep > 180 ? 1 : 0} ${clockwise ? 1 : 0} ${e.x.toFixed(2)},${e.y.toFixed(2)}`
}
const CARDINAL: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }

/** Circular heading picker 0-359: drag / click on the ring, arrows (step), Shift+arrows (1), PageUp/Down (30), Home (current), End (reciprocal). */
export function Dial({ value, onChange, current, turn = 'auto', step = 5, size = 200, label = 'HDG', disabled = false, quickSteps, onGlass = false, testId, className }: DialProps) {
  const svgRef = React.useRef<SVGSVGElement>(null)
  const dragging = React.useRef(false)
  const c = size / 2
  const rOuter = c - 2
  const rTick = rOuter - 6
  const rLabel = rOuter - 30
  const valueSize = size >= 180 ? 36 : size >= 140 ? 26 : 20
  const showHint = size >= 160
  const rArc = rOuter - 3
  const heading = wrapHeading(value)

  const clockwise = (() => {
    if (current === undefined) return true
    if (turn === 'right') return true
    if (turn === 'left') return false
    return wrapHeading(heading - current) <= 180
  })()
  const delta = current === undefined ? 0 : clockwise ? wrapHeading(heading - current) : wrapHeading(current - heading)

  const set = (h: number) => { if (!disabled) onChange(wrapHeading(h)) }
  const fromPointer = (e: React.PointerEvent | PointerEvent, snap = step) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    const deg = wrapHeading((Math.atan2(dy, dx) * 180) / Math.PI + 90)
    set(Math.round(deg / snap) * snap)
  }
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus({ preventScroll: true })
    fromPointer(e, e.shiftKey ? 1 : step)
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => { if (dragging.current) fromPointer(e, e.shiftKey ? 1 : step) }
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => { dragging.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ } }
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return
    const s = e.shiftKey ? 1 : step
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': e.preventDefault(); set(heading + s); break
      case 'ArrowLeft': case 'ArrowDown': e.preventDefault(); set(heading - s); break
      case 'PageUp': e.preventDefault(); set(heading + 30); break
      case 'PageDown': e.preventDefault(); set(heading - 30); break
      case 'Home': e.preventDefault(); set(current ?? 0); break
      case 'End': e.preventDefault(); set((current ?? heading) + 180); break
    }
  }

  const ticks: React.ReactNode[] = []
  for (let d = 0; d < 360; d += 10) {
    const major = d % 30 === 0
    const a = polar(c, c, rOuter, d)
    const b = polar(c, c, major ? rTick - 4 : rTick, d)
    ticks.push(<line key={d} className={cx(styles.tick, major && styles.tickMajor)} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />)
    if (major) {
      const p = polar(c, c, rLabel, d)
      const txt = CARDINAL[d] ?? String(d / 10)
      ticks.push(<text key={`l${d}`} className={cx(styles.label, CARDINAL[d] && styles.labelCardinal)} x={p.x} y={p.y}>{txt}</text>)
    }
  }
  const knob = polar(c, c, rArc, heading)
  const knobIn = polar(c, c, rArc - 14, heading)
  const curP = current !== undefined ? polar(c, c, rArc, current) : null
  const curIn = current !== undefined ? polar(c, c, rArc - 10, current) : null
  const hint = current === undefined ? null : delta === 0 ? 'On heading' : `${clockwise ? 'R' : 'L'} ${delta}°`

  return (
    <div data-testid={testId} className={cx(styles.root, disabled && styles.disabled, className)}>
      <svg
        ref={svgRef}
        className={styles.svg}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={heading}
        aria-valuetext={`heading ${String(heading).padStart(3, '0')}${hint ? `, ${hint}` : ''}`}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKey}
        data-testid={testId ? `${testId}-svg` : undefined}
      >
        <circle className={cx(styles.face, onGlass && styles.faceGlass)} cx={c} cy={c} r={rOuter} />
        <circle className={styles.ring} cx={c} cy={c} r={rOuter} />
        <circle className={styles.arcTrack} cx={c} cy={c} r={rArc} />
        {ticks}
        {current !== undefined ? <path className={styles.arc} d={arcPath(c, c, rArc, current, heading, clockwise)} /> : null}
        {curP && curIn ? (
          <g>
            <line className={styles.currentLine} x1={curIn.x} y1={curIn.y} x2={c} y2={c} />
            <circle className={styles.current} cx={curP.x} cy={curP.y} r={4} />
          </g>
        ) : null}
        <line className={styles.knobLine} x1={knobIn.x} y1={knobIn.y} x2={knob.x} y2={knob.y} />
        <circle className={styles.knob} cx={knob.x} cy={knob.y} r={6} />
        <g className={styles.centre}>
          {showHint ? <text className={styles.centreLabel} x={c} y={c - valueSize * 0.85}>{label}</text> : null}
          <text className={styles.centreValue} x={c} y={c} style={{ fontSize: valueSize }}>{String(heading).padStart(3, '0')}</text>
          {hint && showHint ? <text className={cx(styles.centreHint, delta !== 0 && styles.centreHintOrange)} x={c} y={c + valueSize * 0.95}>{hint}</text> : null}
        </g>
      </svg>
      {quickSteps?.length ? (
        <div className={styles.quick}>
          {quickSteps.map((q) => (
            <Button key={q} size="sm" tabular disabled={disabled} iconLeft={q < 0 ? <IconRotateCcw size={14} /> : <IconRotateCw size={14} />} onClick={() => set(heading + q)} testId={testId ? `${testId}-step-${q}` : undefined}>{Math.abs(q)}</Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

'use client'
/* Small shared helpers for the primitives. */
import * as React from 'react'

/** className joiner: cx('a', cond && 'b', undefined) */
export function cx(...parts: Array<string | number | bigint | boolean | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
}

/** Controlled / uncontrolled value helper. */
export function useControllable<T>(value: T | undefined, defaultValue: T, onChange?: (v: T) => void): [T, (v: T) => void] {
  const [inner, setInner] = React.useState<T>(defaultValue)
  const isControlled = value !== undefined
  const current = isControlled ? (value as T) : inner
  const set = React.useCallback(
    (v: T) => {
      if (!isControlled) setInner(v)
      onChange?.(v)
    },
    [isControlled, onChange],
  )
  return [current, set]
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return reduced
}

/** Count-up from previous to next over `duration` ms (section 7). Decreasing values snap (A7). */
export function useCountUp(target: number, duration = 600, options: { animateDecrease?: boolean; enabled?: boolean } = {}): number {
  const { animateDecrease = false, enabled = true } = options
  const reduced = usePrefersReducedMotion()
  const [display, setDisplay] = React.useState(target)
  const fromRef = React.useRef(target)
  const rafRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    const from = fromRef.current
    if (!enabled || reduced || target === from || (target < from && !animateDecrease)) {
      fromRef.current = target
      setDisplay(target)
      return
    }
    const start = performance.now()
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const v = from + (target - from) * ease(p)
      setDisplay(p >= 1 ? target : v)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      fromRef.current = target
    }
  }, [target, duration, animateDecrease, enabled, reduced])
  return display
}

export function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === 'function') ref(node)
      else (ref as React.MutableRefObject<T | null>).current = node
    }
  }
}

let idCounter = 0
export function useStableId(prefix = 'ds'): string {
  const reactId = React.useId()
  return `${prefix}-${reactId.replace(/[:]/g, '')}`
}
export function nextId(prefix = 'ds'): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

/** Clamp helper. */
export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Wrap a heading into 0..359. */
export const wrapHeading = (h: number) => ((Math.round(h) % 360) + 360) % 360

/** A9 number formatting. */
export function formatThousands(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
export function formatAltitude(ft: number): { hi: string; lo: string; unit: string; fl: boolean } {
  if (ft <= 0) return { hi: 'SFC', lo: '', unit: '', fl: false }
  if (ft >= 18000) return { hi: 'FL', lo: String(Math.round(ft / 100)).padStart(3, '0'), unit: '', fl: true }
  const s = formatThousands(ft)
  const i = s.indexOf(',')
  if (i === -1) return { hi: s, lo: '', unit: 'ft', fl: false }
  return { hi: s.slice(0, i + 1), lo: s.slice(i + 1), unit: 'ft', fl: false }
}
export function formatHeading(h: number): string {
  return String(wrapHeading(h)).padStart(3, '0')
}
export function formatSpeed(kt: number): string {
  return `${Math.round(kt)}`
}
export function formatDistanceNm(nm: number): string {
  return `${nm.toFixed(1)} nm`
}
export function formatPercent(p: number): string {
  return `${p.toFixed(1)}%`
}
export function formatSigned(n: number, unit = ''): string {
  const s = Math.abs(n)
  const sign = n < 0 ? '−' : n > 0 ? '+' : '±'
  return `${sign}${formatThousands(s)}${unit}`
}
export function formatTimeZ(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}
export function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
export function formatRelative(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m ago`
}
/** Split a formatted number into the white leading group and the dimmed trailing group (2.2 big-number pattern). */
export function splitNumber(s: string, mode: 'auto' | 'comma' | 'decimal' | 'none' = 'auto'): { hi: string; lo: string } {
  if (mode === 'none') return { hi: s, lo: '' }
  const ci = s.indexOf(',')
  const di = s.indexOf('.')
  let cut = -1
  if (mode === 'comma') cut = ci
  else if (mode === 'decimal') cut = di
  else cut = ci !== -1 ? ci : di
  if (cut === -1) return { hi: s, lo: '' }
  return { hi: s.slice(0, cut + 1), lo: s.slice(cut + 1) }
}

'use client'
/*
  Tab / Shift+Tab strip cycling (UX 04 §G6: "alerts -> requests -> bay order").
  The StripBay may register its own cycler (`registerStripCycler`) to own focus
  and scrolling; without one the shell cycles the selection straight on the
  store and scrolls the matching `strip-{cs}` element into view.
*/
import { sim } from '@/components/atc/simStore'
import type { AircraftState } from '@/lib/sim/types'

export type StripCycler = (dir: 1 | -1) => boolean

let custom: StripCycler | null = null

/** StripBay hook: return true when the cycle was handled. Returns the unregister function. */
export function registerStripCycler(fn: StripCycler): () => void {
  custom = fn
  return () => { if (custom === fn) custom = null }
}

/** Strips of the current position in cycling order: alerted first, then open requests, then bay order. */
export function stripOrder(): AircraftState[] {
  const bays = sim.stripsFor(sim.position)
  const list = bays.flatMap((b) => b.items)
  const alerted = new Set(sim.alerts().flatMap((a) => a.subjects))
  const t = sim.time()
  const rank = (a: AircraftState) => (alerted.has(a.callsign) ? 0 : a.requests.some((r) => r.answeredAt == null) && t >= a.standbyUntil ? 1 : 2)
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a)
}

export function cycleStrip(dir: 1 | -1): boolean {
  if (custom && custom(dir)) return true
  const order = stripOrder()
  if (!order.length) return false
  const idx = order.findIndex((a) => a.id === sim.selectedId)
  const next = idx < 0 ? (dir > 0 ? 0 : order.length - 1) : (idx + dir + order.length) % order.length
  const a = order[next]
  sim.select(a.id)
  if (typeof document !== 'undefined') {
    const el = document.querySelector<HTMLElement>(`[data-testid="strip-${a.callsign}"]`)
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
      if (typeof el.focus === 'function') el.focus({ preventScroll: true })
    }
  }
  return true
}

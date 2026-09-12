'use client'
/* Thin wrappers over the store's `useSim` selector hook (06-CONTRACTS §7 / W2-STORE interface). */
import { sim, useSim, useSimVersion } from '@/components/atc/simStore'
import type { SimStore, RadioLine, Toast, Settings, StartConfig, Position, StripBay } from '@/components/atc/simStore'
import type { AircraftState } from '@/lib/sim/types'

export { sim, useSim, useSimVersion }
export type { SimStore, RadioLine, Toast, Settings, StartConfig, Position, StripBay }

export function useSelectedAircraft(): AircraftState | null {
  return useSim((s) => s.selected())
}

export function usePosition(): Position {
  return useSim((s) => s.position)
}

export function useSimTime(): number {
  return useSim((s) => s.time())
}

export function usePaused(): boolean {
  return useSim((s) => s.paused)
}

export function useRate(): 1 | 2 | 4 {
  return useSim((s) => s.rate)
}

export function useLoading(): boolean {
  return useSim((s) => s.loading)
}

/** Sim clock "HH:MM:SS" from sim seconds (session clock starts at 00:00:00). */
export function formatSimClock(simS: number): string {
  const s = Math.max(0, Math.floor(simS))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
}

/** "mm:ss" for short timers / log stamps. */
export function formatMmSs(simS: number): string {
  const s = Math.max(0, Math.floor(simS))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 60))}:${p(s % 60)}`
}

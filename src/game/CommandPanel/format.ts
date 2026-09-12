'use client'
/* Shared display helpers for the game panels (A9 formatting, stage tones, wake letters). */
import type { PillTone } from '@/design'
import type { AircraftState, Stage, PlayerPosition, Position, PilotRequest } from '@/lib/sim/types'
import { stageLabel } from '@/lib/sim/stage'
import { magneticHeading, trueHeading, altitudeLabel } from '@/lib/sim/phraseology'

export { magneticHeading, trueHeading, altitudeLabel }

/** Wake letter for display: weight class 'S' (super) shows as "J" (UX §G13.19). */
export function wakeLetter(cls: string): string { return cls === 'S' ? 'J' : cls }

export function kindLabel(a: AircraftState): 'DEP' | 'ARR' { return a.plan.kind === 'departure' ? 'DEP' : 'ARR' }

/** Pill tone for a stage chip (stage.ts tones -> design pill tones). */
export function stageTone(stage: Stage): PillTone {
  const t = stageLabel(stage).tone
  return t === 'danger' ? 'red' : t === 'warn' ? 'orange' : t === 'air' ? 'solid' : t === 'ground' ? 'neutral' : 'dim'
}

export function pad3(n: number): string { return String(Math.round(n)).padStart(3, '0') }

/** Magnetic heading as 3 digits ("270"), never 000. */
export function fmtHdgMag(trueDeg: number, magVar: number): string { return pad3(magneticHeading(trueDeg, magVar)) }

/** mm:ss from seconds (clamped at 0). */
export function fmtMMSS(s: number): string {
  const v = Math.max(0, Math.round(s))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}

/** Seconds -> "2.9 s" (undo ring). */
export function fmtSeconds1(s: number): string { return `${Math.max(0, s).toFixed(1)} s` }

/** UTC clock HH:MMZ from a real Date offset by sim seconds. */
export function fmtClockZ(offsetS = 0): string {
  const d = new Date(Date.now() + offsetS * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}

export const POSITION_LABEL: Record<Position, string> = { ground: 'GROUND', tower: 'TOWER', departure: 'DEPARTURE', approach: 'APPROACH', external: 'CENTRE' }
export const PLAYER_POSITIONS: PlayerPosition[] = ['ground', 'tower', 'approach']

/** Owner tab of a frequency position (POSITION_OWNER without importing the table twice). */
export function ownerTab(p: Position): PlayerPosition | null {
  return p === 'ground' ? 'ground' : p === 'tower' ? 'tower' : p === 'approach' || p === 'departure' ? 'approach' : null
}

/** Open pilot request (answeredAt == null) or null. */
export function openRequest(a: AircraftState): PilotRequest | null {
  return a.requests.find(r => r.answeredAt == null) ?? null
}

/** Short REQ chip text per request kind (UX §G8). */
export function requestShort(r: PilotRequest): string {
  switch (r.kind) {
    case 'pushback': return 'req push'
    case 'startup': return 'req start'
    case 'taxi': return 'ready to taxi'
    case 'cross': return `req cross ${r.param ?? ''}`.trim()
    case 'ready': return 'ready for dep'
    case 'with_you': return 'with you'
    case 'higher': return 'req higher'
    case 'lower': return 'req lower'
    case 'direct': return `req direct ${r.param ?? ''}`.trim()
    case 'hold': return 'req hold'
    case 'taxi_in': return 'req taxi'
    case 'say_again': return 'say again'
    case 'radio_check': return 'radio check'
    case 'cancel_mayday': return 'cancel mayday'
    case 'return_to_stand': return 'req return'
    case 'wind_check': return 'wind check'
    case 'confirm_cleared': return 'confirm cleared'
    case 'further': return 'req further'
    case 'intersection': return 'req intersection'
    case 'runway_vacated': return 'rwy vacated'
    case 'going_around': return 'going around'
    case 'clearance': return 'req clearance'
    default: return 'request'
  }
}

/** Altitude for KPIs: {value, unit} — feet below the transition altitude, FL above. */
export function altParts(ft: number, transitionAltFt: number): { hi: string; lo: string; unit: string } {
  if (ft <= 0) return { hi: 'SFC', lo: '', unit: '' }
  if (ft > transitionAltFt) return { hi: 'FL', lo: String(Math.round(ft / 100)).padStart(3, '0'), unit: '' }
  const s = Math.round(ft).toLocaleString('en-US')
  const i = s.indexOf(',')
  return i === -1 ? { hi: s, lo: '', unit: 'ft' } : { hi: s.slice(0, i + 1), lo: s.slice(i + 1), unit: 'ft' }
}

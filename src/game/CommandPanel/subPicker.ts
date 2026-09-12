'use client'
/*
  Sub-pickers for "+ ADD PART" chips (UX §1.5): a part that needs a value opens the matching picker
  inline on the confirm step. The step is borrowed from the action whose stepper already builds it
  (same candidates, defaults and validation surface), or synthesised when no action carries it.
*/
import type { ActionCtx, ActionParams, PartChip, PickerStep } from '@/lib/sim/commandTree'
import { runwayChips } from '@/lib/sim/commandTree'
import type { AircraftState } from '@/lib/sim/types'
import { partPickerType, PART_LABEL } from './draft'
import { sim } from './store'

type RunwayStep = Extract<PickerStep, { type: 'runway' }>
type DirectionStep = Extract<PickerStep, { type: 'direction' }>
type TaxiwayStep = Extract<PickerStep, { type: 'taxiway' }>

function runwayStep(id: string, label: string, mode: RunwayStep['mode'], a: AircraftState, ctx: ActionCtx | null, def: string | null = null): RunwayStep {
  const candidates = ctx ? runwayChips(mode, a, ctx) : []
  return { id, label, type: 'runway', mode, default: def ?? candidates.find(c => c.enabled)?.name ?? null, locked: false, approachModes: false, optional: false, candidates }
}
function directionStep(id: string, label: string, options: DirectionStep['options']): DirectionStep {
  return { id, label, type: 'direction', options, default: null, enabledOptions: options, taxiwayOptions: [], optional: false }
}
function taxiwayStep(id: string, label: string, mode: TaxiwayStep['mode'], ctx: ActionCtx | null): TaxiwayStep {
  return { id, label, type: 'taxiway', mode, default: null, nextExitChips: false, optional: false, candidates: ctx?.taxiways ?? [], exits: [] }
}
function borrow<T extends PickerStep['type']>(actionId: Parameters<typeof sim.stepsFor>[0], type: T, a: AircraftState): Extract<PickerStep, { type: T }> | null {
  const s = sim.stepsFor(actionId, a).find(x => x.type === type)
  return (s as Extract<PickerStep, { type: T }> | undefined) ?? null
}

/** The picker step a part opens, or null for toggles / parts that navigate to an existing step. */
export function subStepFor(part: PartChip, a: AircraftState, ctx: ActionCtx | null): PickerStep | null {
  const type = partPickerType(part)
  if (!type) return null
  const label = PART_LABEL[part]
  switch (part) {
    case 'then_ils': return borrow('action-ils', 'runway', a) ?? runwayStep(part, label, 'ils', a, ctx)
    case 'expect_runway': return borrow('action-expect-runway', 'runway', a) ?? runwayStep(part, label, 'expect', a, ctx)
    case 'lahso': return runwayStep(part, label, 'lahso', a, ctx)
    case 'hold_short_of': return runwayStep(part, label, 'cross', a, ctx, ctx?.nextCrossingRunway ?? null)
    case 'cross_runway': return runwayStep(part, label, 'cross', a, ctx, ctx?.nextCrossingRunway ?? null)
    case 'when_passing_alt': case 'descend_to': case 'climb_to': {
      const s = borrow('action-altitude', 'altitude', a)
      if (!s) return null
      return { ...s, id: part, label, expediteToggle: false, pilotsDiscretion: false }
    }
    case 'after_fix': { const s = borrow('action-direct', 'fix', a); return s ? { ...s, id: part, label } : null }
    case 'speed': { const s = borrow('action-speed', 'speed', a); return s ? { ...s, id: part, label } : null }
    case 'after_dep_hdg': case 'fly_heading': { const s = borrow('action-heading', 'heading', a); return s ? { ...s, id: part, label, presets: ['runway', 'current'] } : null }
    case 'turn_lr': case 'next_exit': return directionStep(part, label, ['L', 'R'])
    case 'face': { const s = borrow('action-pushback', 'direction', a); return s ? { ...s, id: part, label } : directionStep(part, label, ['any', 'N', 'E', 'S', 'W']) }
    case 'behind_landing': { const s = borrow('action-lineup', 'aircraft', a); return s ? { ...s, id: part, label, optional: false } : null }
    case 'exit_at': { const s = borrow('action-exit', 'taxiway', a); return s && (s.exits.length || s.candidates.length) ? { ...s, id: part, label, nextExitChips: false, optional: false } : taxiwayStep(part, label, 'exit', ctx) }
    case 'intersection': return taxiwayStep(part, label, 'intersection', ctx)
    case 'contact': { const s = borrow('action-handoff', 'position', a); return s ? { ...s, id: part, label } : null }
    case 'via': case 'then_taxi': { const s = borrow('action-taxi-runway', 'taxiway-route', a); return s ? { ...s, id: part, label, contactTowerChip: false } : null }
    default: return null
  }
}

/** Extract the part value from the sub-picker's params. undefined = nothing chosen yet. */
export function subValue(part: PartChip, p: ActionParams, turnDeg: number): unknown {
  switch (partPickerType(part)) {
    case 'runway': return p.runway
    case 'altitude': return p.altitude
    case 'fix': return p.fix
    case 'speed': return p.speed
    case 'heading': return p.heading
    case 'direction': return part === 'turn_lr' ? (p.direction === 'L' || p.direction === 'R' ? { dir: p.direction, deg: turnDeg } : undefined) : p.direction
    case 'aircraft': return p.aircraft
    case 'taxiway': return p.taxiway
    case 'position': return p.position
    case 'taxiway-route': return p.route ? { via: p.route.via, auto: p.route.auto } : undefined
    default: return undefined
  }
}

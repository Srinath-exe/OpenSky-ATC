'use client'
import type { ActionCtx, ActionId, ActionParams, PickerStep } from '@/lib/sim/commandTree'
import type { AircraftState } from '@/lib/sim/types'

export type StepOf<T extends PickerStep['type']> = Extract<PickerStep, { type: T }>

export interface PickerProps<T extends PickerStep['type']> {
  step: StepOf<T>
  params: ActionParams
  onChange: (patch: Partial<ActionParams>) => void
  /** Enter inside the picker = accept the step (next / confirm). */
  onAccept: () => void
  a: AircraftState
  ctx: ActionCtx | null
  actionId: ActionId
  /** sim time (s) — live from the store */
  time: number
  /** test-id prefix override for text chips (picker-info / picker-unable-reason / ...) */
  testPrefix?: string
}

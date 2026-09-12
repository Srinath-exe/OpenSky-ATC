'use client'
/* Renders the picker for one stepper step (UX §1.2 picker types -> the existing picker components). */
import * as React from 'react'
import type { ActionCtx, ActionId, ActionParams, PickerStep } from '@/lib/sim/commandTree'
import type { AircraftState } from '@/lib/sim/types'
import { RunwayPicker, RoutePicker, HeadingPicker, AltitudePicker, SpeedPicker, FixList, HoldPicker, DirectionPicker, TaxiwayPicker, GatePicker, AircraftPicker, VehiclePicker, PositionPicker, TextPicker } from './pickers'

export interface PickerBodyProps {
  step: PickerStep
  params: ActionParams
  onChange: (patch: Partial<ActionParams>) => void
  onAccept: () => void
  a: AircraftState
  ctx: ActionCtx | null
  actionId: ActionId
  time: number
  testPrefix?: string
}

export function PickerBody({ step, params, onChange, onAccept, a, ctx, actionId, time, testPrefix }: PickerBodyProps) {
  const common = { params, onChange, onAccept, a, ctx, actionId, time, testPrefix }
  switch (step.type) {
    case 'runway': return <RunwayPicker step={step} {...common} />
    case 'taxiway-route': return <RoutePicker step={step} {...common} />
    case 'heading': return <HeadingPicker step={step} {...common} />
    case 'altitude': return <AltitudePicker step={step} {...common} />
    case 'speed': return <SpeedPicker step={step} {...common} />
    case 'fix': return <FixList candidates={step.candidates} value={params.fix ?? null} onSelect={(fix) => onChange({ fix })} onAccept={onAccept} label={step.label} testPrefix={testPrefix ?? 'picker-fix'} />
    case 'hold': return <HoldPicker step={step} {...common} />
    case 'direction': return <DirectionPicker step={step} {...common} />
    case 'taxiway': return <TaxiwayPicker step={step} {...common} />
    case 'gate': return <GatePicker step={step} {...common} />
    case 'aircraft': return <AircraftPicker step={step} {...common} />
    case 'vehicle': return <VehiclePicker step={step} {...common} />
    case 'position': return <PositionPicker step={step} {...common} />
    case 'text': return <TextPicker step={step} {...common} />
    case 'confirm': return null
  }
}

/** Typewriter reveal for readbacks (UX §7.2); full text at once under reduced motion. */
export function useTypewriter(text: string, cps = 45): string {
  const [n, setN] = React.useState(0)
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const fn = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  React.useEffect(() => {
    setN(0)
    if (!text || reduced) return
    let i = 0
    const id = setInterval(() => {
      i += 1
      setN(i)
      if (i >= text.length) clearInterval(id)
    }, Math.max(8, 1000 / cps))
    return () => clearInterval(id)
  }, [text, reduced, cps])
  return reduced ? text : text.slice(0, n)
}

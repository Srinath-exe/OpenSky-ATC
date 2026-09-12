'use client'
/* picker-vehicle: cards per vehicle with station / en route / on scene state and ETA; multi-select for ARFF (Space toggles). */
import * as React from 'react'
import s from './pickers.module.css'
import { FireTruck, Ambulance, FollowMeCar, Tug, Fuel, Deice, Icon, cx } from '@/design'
import type { VehicleType, VehicleState } from '@/lib/sim/types'
import { fmtMMSS } from '../format'
import type { PickerProps } from './types'

export function vehicleGlyph(type: VehicleType, size = 18): React.ReactNode {
  switch (type) {
    case 'arff': return <FireTruck size={size} />
    case 'ambulance': return <Ambulance size={size} />
    case 'followme': return <FollowMeCar size={size} />
    case 'tug': return <Tug size={size} />
    case 'fuel': return <Fuel size={size} />
    case 'deice': return <Deice size={size} />
    case 'ops': return <Icon name="route" size={size} />
    case 'sweeper': return <Icon name="wind" size={size} />
    case 'bird': return <Icon name="zap" size={size} />
    default: return <Icon name="circle" size={size} />
  }
}
export const VEHICLE_STATE_LABEL: Record<VehicleState, string> = { standby: 'Station', enroute: 'En route', onscene: 'On scene', returning: 'Returning' }

export function VehiclePicker({ step, params, onChange, onAccept, testPrefix }: PickerProps<'vehicle'>) {
  const sel = params.vehicles ?? []
  const [cursor, setCursor] = React.useState(0)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  const toggle = (id: string) => {
    const c = step.candidates.find(x => x.id === id)
    if (!c || !c.enabled) return
    const next = step.multi ? (sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]) : [id]
    onChange({ vehicles: next, vehicleType: c.type })
  }
  const prefix = testPrefix ?? 'picker-vehicle'
  return (
    <div ref={ref} className={s.picker} tabIndex={-1} data-testid="picker-vehicle" onKeyDown={e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(step.candidates.length - 1, c + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)) }
      else if (e.key === ' ') { e.preventDefault(); const c = step.candidates[cursor]; if (c) toggle(c.id) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (sel.length) onAccept() }
    }}>
      <div className={s.between}><span className={s.label}>{step.label}</span><span className={s.hint}>{sel.length} selected · Space toggles</span></div>
      <div className={s.list} role="listbox" aria-multiselectable={step.multi} aria-label="Vehicles">
        {step.candidates.map((c, i) => (
          <button key={c.id} type="button" role="option" aria-selected={sel.includes(c.id)} aria-pressed={sel.includes(c.id)} className={cx(s.vehCard, i === cursor && s.chipSelected)} disabled={!c.enabled} onClick={() => { setCursor(i); toggle(c.id) }} data-testid={`${prefix}-${c.id}`} data-state={c.enabled ? 'enabled' : 'disabled'} data-vehicle-state={c.state}>
            <span className={s.vehGlyph}>{vehicleGlyph(c.type)}</span>
            <span><div className={s.vehName}>{c.callsign}</div><div className={s.vehState}>{VEHICLE_STATE_LABEL[c.state]}{c.etaS != null && c.state === 'enroute' ? ` · ETA ${fmtMMSS(c.etaS)}` : ''}</div></span>
            <span className={cx(s.badge, sel.includes(c.id) && s.badgeOrange)}>{c.type.toUpperCase()}</span>
          </button>
        ))}
        {!step.candidates.length ? <div className={s.empty}>No vehicles available</div> : null}
      </div>
    </div>
  )
}

'use client'
/* picker-aircraft: nearby traffic (behind-landing / give-way / break-off) with bearing and distance; hovering highlights the aircraft on the map. */
import * as React from 'react'
import s from './pickers.module.css'
import { cx } from '@/design'
import { sim } from '../store'
import type { PickerProps } from './types'

export function AircraftPicker({ step, params, onChange, onAccept }: PickerProps<'aircraft'>) {
  const value = params.aircraft ?? null
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { ref.current?.focus({ preventScroll: true }); return () => sim.hover(null) }, [])
  const idOf = (cs: string) => sim.engine?.find(cs)?.id ?? null
  const move = (d: number) => {
    if (!step.candidates.length) return
    const i = step.candidates.findIndex(c => c.callsign === value)
    onChange({ aircraft: step.candidates[(i + d + step.candidates.length) % step.candidates.length].callsign })
  }
  return (
    <div ref={ref} className={s.picker} tabIndex={-1} data-testid="picker-aircraft" onKeyDown={e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (value || step.optional) onAccept() }
    }}>
      <span className={s.label}>{step.label}{step.optional ? ' · optional' : ''}</span>
      <div className={s.list} role="listbox" aria-label={step.label}>
        {step.candidates.map(c => (
          <button key={c.callsign} type="button" role="option" aria-selected={value === c.callsign} aria-pressed={value === c.callsign} className={cx(s.listRow)} onClick={() => onChange({ aircraft: c.callsign })} onDoubleClick={() => { onChange({ aircraft: c.callsign }); onAccept() }} onMouseEnter={() => sim.hover(idOf(c.callsign))} onMouseLeave={() => sim.hover(null)} data-testid={`${step.mode === 'break_off' ? 'picker-emerg-break' : 'picker-aircraft'}-${c.callsign}`}>
            <span className={s.listTitle}>{c.callsign} <span className={s.listMeta}>{c.type}</span></span>
            <span className={s.listMeta}>{c.onFinalNM != null ? `${c.onFinalNM.toFixed(1)} NM final` : `${String(c.bearingMag).padStart(3, '0')}° / ${c.distM} m`}</span>
          </button>
        ))}
        {!step.candidates.length ? <div className={s.empty}>{step.mode === 'behind_landing' || step.mode === 'break_off' ? 'No other traffic on final' : 'No traffic nearby'}</div> : null}
      </div>
      {step.optional && !step.candidates.length ? <span className={s.hint}>Enter to skip</span> : null}
    </div>
  )
}

'use client'
/* picker-position: GROUND 121.9 · TOWER 118.5 · DEPARTURE · APPROACH chips (next logical pre-selected); 1-4 / Enter; "when vacated" toggle on rollout. */
import * as React from 'react'
import s from './pickers.module.css'
import { Toggle, cx } from '@/design'
import type { Position } from '@/lib/sim/types'
import type { PickerProps } from './types'

export function PositionPicker({ step, params, onChange, onAccept }: PickerProps<'position'>) {
  const value = params.position ?? null
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  return (
    <div ref={ref} className={s.picker} tabIndex={-1} data-testid="picker-position" onKeyDown={e => {
      if (e.key >= '1' && e.key <= '4') { const c = step.candidates[Number(e.key) - 1]; if (c?.enabled) { e.preventDefault(); onChange({ position: c.position }) } }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (value) onAccept() }
    }}>
      <span className={s.label}>{step.label}</span>
      <div className={s.grid2} role="radiogroup" aria-label="Position">
        {step.candidates.map((c, i) => (
          <button key={c.position} type="button" role="radio" aria-checked={value === c.position} aria-pressed={value === c.position} className={s.chip} disabled={!c.enabled} title={!c.enabled ? 'Already on this frequency' : undefined} onClick={() => onChange({ position: c.position as Position })} onDoubleClick={() => { onChange({ position: c.position as Position }); onAccept() }} data-testid={`picker-position-${c.position}`} data-state={c.enabled ? 'enabled' : 'disabled'}>
            <span className={s.kbdIdx}>{i + 1}</span>
            <span className={s.chipTitle}>{c.label}</span>
            <span className={cx(s.chipSub)}>{c.freq || '—'}</span>
          </button>
        ))}
      </div>
      {step.when === 'when_vacated' ? <Toggle checked={params.when === 'when_vacated'} onChange={v => onChange({ when: v ? 'when_vacated' : 'now' })} label="When vacated" testId="picker-position-when-vacated" /> : null}
    </div>
  )
}

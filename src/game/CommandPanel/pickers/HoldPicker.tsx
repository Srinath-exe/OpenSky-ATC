'use client'
/* picker-hold: fix -> inbound course (dial) -> turns L/R -> leg length -> EFC (+10 / +20 min, shown HH:MMZ). */
import * as React from 'react'
import s from './pickers.module.css'
import { Dial, Segmented, Pill, cx } from '@/design'
import { magneticHeading, trueHeading } from '@/lib/sim/phraseology'
import type { TurnDir } from '@/lib/sim/commandAst'
import { FixList } from './FixPicker'
import { fmtClockZ } from '../format'
import type { PickerProps } from './types'

export function HoldPicker({ step, params, onChange, onAccept, a, ctx }: PickerProps<'hold'>) {
  const magVar = ctx?.magVar ?? 0
  const hold = params.hold ?? { fix: step.defaultFix ?? '', inbound: step.defaultInbound, dir: step.defaultDir, legTimeMin: 1, legNM: null, efc: null }
  const set = (patch: Partial<NonNullable<typeof params.hold>>) => onChange({ hold: { ...hold, ...patch } })
  const chip = step.candidates.find(c => c.name === hold.fix)
  const inboundMag = hold.inbound != null ? magneticHeading(hold.inbound, magVar) : (chip?.holdHeading != null ? magneticHeading(chip.holdHeading, magVar) : (chip ? chip.bearingMag : magneticHeading(a.heading, magVar)))
  const legKey = hold.legNM ? '4nm' : hold.legTimeMin === 1.5 ? '1.5m' : '1m'
  const efcDelta = hold.efc != null ? Math.round((hold.efc - step.time) / 60) : null
  return (
    <div className={cx(s.picker, s.holdGrid)} data-testid="picker-hold">
      <FixList candidates={step.candidates} value={hold.fix || null} onSelect={name => { const c = step.candidates.find(x => x.name === name); set({ fix: name, inbound: c?.holdHeading ?? (c ? trueHeading(c.bearingMag, magVar) : hold.inbound) }) }} onAccept={() => { /* stay on the builder */ }} label="Hold at" autoFocus={false} />
      <div className={s.dialWrap}>
        <Dial value={inboundMag % 360} onChange={h => set({ inbound: trueHeading(h === 0 ? 360 : h, magVar) })} current={magneticHeading(a.heading, magVar) % 360} turn={hold.dir === 'L' ? 'left' : 'right'} size={150} label="INB" onGlass testId="picker-hold-inbound" />
        <div className={s.dialSide}>
          <span className={s.label}>Turns</span>
          <Segmented small ariaLabel="Turns" items={[{ id: 'L', label: 'left', testId: 'picker-hold-turns-left' }, { id: 'R', label: 'right', testId: 'picker-hold-turns-right' }]} value={hold.dir ?? 'R'} onChange={id => set({ dir: id as TurnDir })} />
          <span className={s.label}>Leg</span>
          <div className={s.rowTight}>
            {step.legOptions.map(o => {
              const key = o.legNM ? '4nm' : o.legTimeMin === 1.5 ? '1.5m' : '1m'
              return <Pill key={key} size="s" tone={legKey === key ? 'orange' : 'neutral'} interactive selected={legKey === key} onClick={() => set({ legTimeMin: o.legTimeMin, legNM: o.legNM })} tabular testId={`picker-hold-leg-${key}`}>{o.label}</Pill>
            })}
          </div>
          <span className={s.label}>Expect further clearance</span>
          <div className={s.rowTight}>
            <Pill size="s" tone={hold.efc == null ? 'orange' : 'neutral'} interactive selected={hold.efc == null} onClick={() => set({ efc: null })} testId="picker-hold-efc-none">none</Pill>
            {step.efcOptionsMin.map(m => <Pill key={m} size="s" tone={efcDelta === m ? 'orange' : 'neutral'} interactive selected={efcDelta === m} onClick={() => set({ efc: step.time + m * 60 })} tabular testId={`picker-hold-efc-${m}`}>+{m}</Pill>)}
            <Pill size="s" tone={efcDelta === 30 ? 'orange' : 'neutral'} interactive selected={efcDelta === 30} onClick={() => set({ efc: step.time + 30 * 60 })} tabular testId="picker-hold-efc-30">+30</Pill>
          </div>
          {hold.efc != null ? <div className={s.efc}><span className={s.efcTime}>{fmtClockZ(hold.efc - step.time)}</span><span className={s.hint}>EFC</span></div> : null}
          <span className={cx(s.hint, s.tnum)}>{hold.fix ? `Hold ${hold.fix} inbound ${String(inboundMag).padStart(3, '0')} ${hold.dir === 'L' ? 'left' : 'right'} turns` : 'Pick a fix'}</span>
        </div>
      </div>
      <div className={s.between}>
        <span className={s.hint}>Enter to continue</span>
        <button type="button" className={s.twy} onClick={onAccept} disabled={!hold.fix} data-testid="picker-hold-accept">Next</button>
      </div>
    </div>
  )
}

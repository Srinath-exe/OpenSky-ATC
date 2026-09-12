/* picker-altitude: Ladder with FL labels above the transition altitude, MSA / ceiling / GS bands, EXPEDITE and pilot's-discretion toggles, half-step toggle, digit type-in. */
'use client'
import * as React from 'react'
import s from './pickers.module.css'
import { Ladder, Toggle, Input, Button, cx } from '@/design'
import { altitudeLabel } from '@/lib/sim/phraseology'
import type { PickerProps } from './types'

/** "3" -> 3000, "35" -> 3500, "130" -> FL130 (UX §1.2 digit rule). */
export function parseAltitudeDigits(t: string): number | null {
  const d = t.replace(/\D/g, '')
  if (!d) return null
  const n = parseInt(d, 10)
  if (d.length <= 1) return n * 1000
  if (d.length === 2) return n * 100 * (n < 20 ? 10 : 1) / (n < 20 ? 1 : 1) === n * 1000 ? n * 1000 : n * 100
  if (d.length === 3) return n * 100
  return n
}

export function AltitudePicker({ step, params, onChange, onAccept, a }: PickerProps<'altitude'>) {
  const ta = step.transitionAltFt
  const [half, setHalf] = React.useState(step.halfSteps)
  const stepFt = half ? 500 : 1000
  const value = params.altitude ?? step.default ?? Math.max(step.min, Math.round(a.altitude / 1000) * 1000)
  const [text, setText] = React.useState('')
  const set = (v: number) => onChange({ altitude: Math.min(step.max, Math.max(step.min, Math.round(v / 100) * 100)) })
  const commitText = () => { const v = parseAltitudeDigits(text); if (v != null) set(v); setText('') }
  const msa = step.rungs.find(r => r.band === 'msa')
  const ceil = step.rungs.find(r => r.band === 'ceiling')
  const gs = step.rungs.find(r => r.band === 'gs')
  const verb = value > a.altitude + 50 ? 'climb' : value < a.altitude - 50 ? 'descend' : 'maintain'
  return (
    <div className={s.picker} data-testid="picker-altitude" onKeyDown={e => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'e' || e.key === 'E') { e.preventDefault(); onChange({ expedite: !params.expedite }) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onAccept() }
    }}>
      <div className={s.ladderWrap}>
        <Ladder
          value={value}
          onChange={set}
          min={step.min}
          max={step.max}
          step={stepFt}
          majorEvery={5000}
          current={Math.round(a.altitude)}
          label="ALT"
          unit="ft"
          formatTick={v => altitudeLabel(v, ta)}
          formatValue={v => altitudeLabel(v, ta)}
          height={240}
          width={120}
          quickSteps={[3000, 1000, -1000, -3000]}
          onGlass
          testId="picker-alt-ladder"
        />
        <div className={s.ladderSide}>
          <span className={s.label}>{step.label} · {verb}</span>
          <Input size="m" surface="glass" tabular value={text} placeholder="3 / 35 / 130" onChange={e => setText(e.target.value.replace(/\D/g, '').slice(0, 5))} onBlur={() => { if (text) commitText() }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitText(); onAccept() } }} inputMode="numeric" aria-label="Altitude" wrapClassName={s.numInput} testId="picker-alt-input" />
          {step.expediteToggle ? <Toggle checked={!!params.expedite} onChange={v => onChange({ expedite: v })} label="Expedite" testId="picker-alt-expedite" /> : null}
          {step.pilotsDiscretion ? <Toggle checked={!!params.pilotsDiscretion} onChange={v => onChange({ pilotsDiscretion: v })} label="At discretion" testId="picker-alt-discretion" /> : null}
          <Toggle checked={half} onChange={setHalf} label="500 ft steps" testId="picker-alt-half-steps" />
          <div className={s.bands} aria-label="Altitude bands">
            {msa ? <span className={s.band} data-testid="picker-alt-band-msa"><span className={cx(s.bandSwatch, s.bandMsa)} />below MSA {altitudeLabel(step.min, ta)}</span> : <span className={s.band} data-testid="picker-alt-band-msa"><span className={cx(s.bandSwatch, s.bandMsa)} />floor {altitudeLabel(step.min, ta)}</span>}
            {ceil ? <span className={s.band} data-testid="picker-alt-band-ceiling"><span className={cx(s.bandSwatch, s.bandCeil)} />above ceiling {altitudeLabel(ceil.ft, ta)}</span> : <span className={s.band} data-testid="picker-alt-band-ceiling"><span className={cx(s.bandSwatch, s.bandCeil)} />ceiling {altitudeLabel(step.max, ta)}</span>}
            {gs ? <span className={s.band} data-testid="picker-alt-band-gs"><span className={cx(s.bandSwatch, s.bandGs)} />GS intercept {altitudeLabel(gs.ft, ta)}</span> : null}
          </div>
          <div className={s.rowTight}>
            {step.commandedFt != null ? <Button size="sm" variant="ghost" tabular onClick={() => set(step.commandedFt!)}>assigned {altitudeLabel(step.commandedFt, ta)}</Button> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

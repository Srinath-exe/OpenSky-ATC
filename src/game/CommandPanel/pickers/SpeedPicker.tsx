'use client'
/* picker-speed: chip rail min..max in 10-kt steps (type envelope), quick chips, final approach speed, resume normal, "until 4 NM", plus a Ladder for drag/wheel. */
import * as React from 'react'
import s from './pickers.module.css'
import { Ladder, Button, Toggle, cx } from '@/design'
import type { PickerProps } from './types'

export function SpeedPicker({ step, params, onChange, onAccept, a, ctx }: PickerProps<'speed'>) {
  const value = params.speed ?? step.default ?? step.max
  const resume = value === 'resume'
  const num = resume ? Math.round(a.targetSpeed / 10) * 10 : (value as number)
  const set = (v: number) => onChange({ speed: Math.min(step.max, Math.max(step.min, Math.round(v / 10) * 10)) })
  const below100 = a.altitude < 10000
  return (
    <div className={s.picker} data-testid="picker-speed" onKeyDown={e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onAccept() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); set(num + 10) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); set(num - 10) }
    }}>
      <div className={s.ladderWrap}>
        <Ladder value={num} onChange={set} min={step.min} max={step.max} step={10} majorEvery={50} current={Math.round(a.speed)} label="SPD" unit="kt" formatTick={v => String(v)} height={200} width={110} quickSteps={[20, 10, -10, -20]} onGlass disabled={resume} testId="picker-speed-ladder" />
        <div className={s.ladderSide}>
          <span className={s.label}>{step.label} · {a.perf.icaoCode} {step.min}–{step.max} kt</span>
          <div className={s.rail} role="radiogroup" aria-label="Speed" data-testid="picker-speed-rail">
            {step.quick.map(k => (
              <button key={k} type="button" className={s.speedChip} aria-pressed={!resume && num === k} onClick={() => set(k)} data-testid={`picker-speed-chip-${k}`}>
                {k}
                {k === 250 && below100 ? <span className={s.speedNote} data-testid="picker-speed-chip-250-note">{step.note250}</span> : null}
              </button>
            ))}
          </div>
          <div className={s.rowTight}>
            {step.presets.includes('final') ? <Button size="sm" variant={!resume && num === step.finalApproachKt ? 'accent' : 'secondary'} tabular onClick={() => onChange({ speed: Math.max(step.min, Math.round(step.finalApproachKt / 10) * 10) })} testId="picker-speed-final">final approach {step.finalApproachKt}</Button> : null}
            {step.presets.includes('resume') ? <Button size="sm" variant={resume ? 'accent' : 'secondary'} onClick={() => onChange({ speed: 'resume', untilNM: null })} testId="picker-speed-resume">resume normal speed</Button> : null}
          </div>
          {step.presets.includes('until4') ? <Toggle checked={params.untilNM === 4} onChange={v => onChange({ untilNM: v ? 4 : null })} label="until 4 NM" description={ctx?.distToThresholdNM != null ? `${ctx.distToThresholdNM.toFixed(1)} NM to threshold` : undefined} disabled={resume} testId="picker-speed-until-4nm" /> : null}
          <span className={cx(s.hint, s.tnum)}>{a.callsign} now {Math.round(a.speed)} kt{a.cmdIas != null ? ` · assigned ${a.cmdIas}` : ''}</span>
        </div>
      </div>
    </div>
  )
}

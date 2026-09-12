'use client'
/* picker-heading: Dial (magnetic display, TRUE in the AST), L / R / shortest, ±5 ±10 nudges, type-in, runway-heading / present-heading presets. */
import * as React from 'react'
import s from './pickers.module.css'
import { Dial, Segmented, Button, Input, cx } from '@/design'
import { magneticHeading, trueHeading } from '@/lib/sim/phraseology'
import type { TurnDir } from '@/lib/sim/commandAst'
import type { PickerProps } from './types'

export function HeadingPicker({ step, params, onChange, onAccept, a }: PickerProps<'heading'>) {
  const magVar = step.magVar
  const currentMag = magneticHeading(step.currentHeadingTrue, magVar)
  const valueTrue = params.heading ?? step.default ?? step.currentHeadingTrue
  const valueMag = magneticHeading(valueTrue, magVar)
  const [text, setText] = React.useState(String(valueMag).padStart(3, '0'))
  React.useEffect(() => { setText(String(valueMag).padStart(3, '0')) }, [valueMag])
  const setMag = (m: number) => { const mm = ((Math.round(m) % 360) + 360) % 360; onChange({ heading: trueHeading(mm === 0 ? 360 : mm, magVar) }) }
  const dir: TurnDir | null = params.dir ?? null
  const turn = dir === 'L' ? 'left' : dir === 'R' ? 'right' : 'auto'
  const commitText = () => {
    const n = parseInt(text, 10)
    if (Number.isFinite(n) && n >= 1 && n <= 360) setMag(n)
    else setText(String(valueMag).padStart(3, '0'))
  }
  const runwayMag = step.runwayHeadingTrue != null ? magneticHeading(step.runwayHeadingTrue, magVar) : null
  const delta = ((valueMag - currentMag + 540) % 360) - 180
  return (
    <div className={s.picker} data-testid="picker-heading" onKeyDown={e => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'l' || e.key === 'L') { e.preventDefault(); onChange({ dir: 'L' }) }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); onChange({ dir: 'R' }) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onAccept() }
    }}>
      <div className={s.dialWrap}>
        <Dial value={valueMag % 360} onChange={h => setMag(h === 0 ? 360 : h)} current={currentMag % 360} turn={turn} step={step.stepDeg} size={180} label="HDG" onGlass testId="picker-heading-dial" />
        <div className={s.dialSide}>
          <span className={s.label}>{step.label}</span>
          <Input
            size="m"
            surface="glass"
            tabular
            value={text}
            onChange={e => setText(e.target.value.replace(/\D/g, '').slice(0, 3))}
            onBlur={commitText}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitText(); onAccept() } }}
            inputMode="numeric"
            aria-label="Heading"
            wrapClassName={s.numInput}
            testId="picker-heading-input"
          />
          {step.allowDir ? (
            <Segmented small ariaLabel="Turn direction" items={[{ id: 'L', label: 'L', testId: 'picker-heading-left' }, { id: 'auto', label: 'shortest', testId: 'picker-heading-shortest' }, { id: 'R', label: 'R', testId: 'picker-heading-right' }]} value={dir ?? 'auto'} onChange={id => onChange({ dir: id === 'auto' ? null : (id as TurnDir) })} />
          ) : null}
          <div className={s.rowTight}>
            <Button size="sm" tabular onClick={() => setMag(valueMag - 10)} testId="picker-heading-minus10">−10</Button>
            <Button size="sm" tabular onClick={() => setMag(valueMag - 5)} testId="picker-heading-minus5">−5</Button>
            <Button size="sm" tabular onClick={() => setMag(valueMag + 5)} testId="picker-heading-plus5">+5</Button>
            <Button size="sm" tabular onClick={() => setMag(valueMag + 10)} testId="picker-heading-plus10">+10</Button>
          </div>
          <div className={s.rowTight}>
            {step.presets.includes('runway') && runwayMag != null ? <Button size="sm" variant="ghost" tabular onClick={() => setMag(runwayMag)} testId="picker-heading-runway-hdg">runway {String(runwayMag).padStart(3, '0')}</Button> : null}
            {step.presets.includes('current') ? <Button size="sm" variant="ghost" tabular onClick={() => setMag(currentMag)} testId="picker-heading-current">present {String(currentMag).padStart(3, '0')}</Button> : null}
          </div>
          <span className={cx(s.hint, s.tnum)}>{a.callsign} now {String(currentMag).padStart(3, '0')}° · turn {delta === 0 ? '—' : `${Math.abs(delta)}° ${dir ? (dir === 'L' ? 'left' : 'right') : delta < 0 ? 'left' : 'right'}`}</span>
        </div>
      </div>
    </div>
  )
}

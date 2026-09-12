'use client'
/* picker-direction: LEFT / RIGHT big chips, N/E/S/W compass for pushback facing (+ "as required"), face-taxiway chips. */
import * as React from 'react'
import s from './pickers.module.css'
import { IconArrowLeft, IconArrowRight, Pill, cx } from '@/design'
import type { PickerProps } from './types'

type Opt = 'L' | 'R' | 'N' | 'E' | 'S' | 'W' | 'any'

export function DirectionPicker({ step, params, onChange, onAccept }: PickerProps<'direction'>) {
  const value = (params.direction as Opt | undefined) ?? null
  const has = (o: Opt) => step.options.includes(o)
  const en = (o: Opt) => step.enabledOptions.includes(o)
  const pick = (o: Opt) => { onChange({ direction: o, taxiway: undefined }) }
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  return (
    <div ref={ref} className={s.picker} tabIndex={-1} data-testid="picker-direction" onKeyDown={e => {
      const k = e.key.toUpperCase()
      if ((k === 'L' || k === 'ARROWLEFT') && has('L')) { e.preventDefault(); pick('L') }
      else if ((k === 'R' || k === 'ARROWRIGHT') && has('R')) { e.preventDefault(); pick('R') }
      else if ((k === 'N' || k === 'E' || k === 'S' || k === 'W') && has(k as Opt) && en(k as Opt)) { e.preventDefault(); pick(k as Opt) }
      else if (k === 'ENTER') { e.preventDefault(); e.stopPropagation(); onAccept() }
    }}>
      <span className={s.label}>{step.label}</span>
      {has('L') || has('R') ? (
        <div className={s.dirBig}>
          {has('L') ? <button type="button" className={s.dirBtn} aria-pressed={value === 'L'} onClick={() => pick('L')} onDoubleClick={() => { pick('L'); onAccept() }} data-testid="picker-dir-left"><IconArrowLeft size={18} />LEFT</button> : null}
          {has('R') ? <button type="button" className={s.dirBtn} aria-pressed={value === 'R'} onClick={() => pick('R')} onDoubleClick={() => { pick('R'); onAccept() }} data-testid="picker-dir-right">RIGHT<IconArrowRight size={18} /></button> : null}
        </div>
      ) : null}
      {has('N') ? (
        <div className={s.compass} role="radiogroup" aria-label="Facing">
          <span />
          <button type="button" className={s.compassBtn} aria-pressed={value === 'N'} disabled={!en('N')} onClick={() => pick('N')} data-testid="picker-dir-N">N</button>
          <span />
          <button type="button" className={s.compassBtn} aria-pressed={value === 'W'} disabled={!en('W')} onClick={() => pick('W')} data-testid="picker-dir-W">W</button>
          <span className={s.compassCentre}>face</span>
          <button type="button" className={s.compassBtn} aria-pressed={value === 'E'} disabled={!en('E')} onClick={() => pick('E')} data-testid="picker-dir-E">E</button>
          <span />
          <button type="button" className={s.compassBtn} aria-pressed={value === 'S'} disabled={!en('S')} onClick={() => pick('S')} data-testid="picker-dir-S">S</button>
          <span />
        </div>
      ) : null}
      <div className={s.rowTight}>
        {has('any') ? <Pill size="s" tone={value === 'any' ? 'orange' : 'neutral'} interactive selected={value === 'any'} onClick={() => pick('any')} testId="picker-dir-any">as required</Pill> : null}
        {step.taxiwayOptions.map(t => <Pill key={t} size="s" tone={params.taxiway === t ? 'orange' : 'neutral'} interactive selected={params.taxiway === t} onClick={() => onChange({ taxiway: t, direction: 'any' })} testId={`picker-dir-twy-${t}`}>face {t}</Pill>)}
      </div>
      {step.optional ? <span className={cx(s.hint)}>Optional — Enter to skip</span> : null}
    </div>
  )
}

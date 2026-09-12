'use client'
/*
  picker-text: chip lists (report items, unable reasons, emergency scopes / locations / options, hold-short targets,
  hold-position reasons, correction fields ...). Test ids follow the UX inventory per action (picker-info-*, picker-unable-reason-*,
  picker-emerg-scope-*, picker-emerg-location-*, picker-emerg-sterile / -number-one / -straight-in, picker-exit-expedite ...).
  "Hold short of" chips open the runway / taxiway sub-list inline; "Correction" adds a value input.
*/
import * as React from 'react'
import s from './pickers.module.css'
import { Pill, Input, cx } from '@/design'
import type { ActionId } from '@/lib/sim/commandTree'
import type { PickerProps } from './types'

const PREFIX: Partial<Record<ActionId, string>> = {
  'action-report': 'picker-info', 'emerg-ack': 'picker-info', 'action-unable': 'picker-unable-reason', 'emerg-hold-all': 'picker-emerg-scope',
  'emerg-dispatch': 'picker-emerg-location', 'action-hold-short': 'picker-holdshort', 'action-hold-position': 'picker-holdpos', 'action-cross': 'picker-cross',
  'action-exit': 'picker-exit', 'action-correction': 'picker-correction', 'action-giveway': 'picker-giveway', 'emerg-stop-runway': 'picker-emerg-stop',
  'emerg-reopen': 'picker-emerg-reopen', 'action-turnaround': 'picker-turnaround',
}
const SPECIAL: Record<string, string> = { 'emerg-priority:straight_in': 'picker-emerg-straight-in', 'emerg-priority:number_one': 'picker-emerg-number-one', 'emerg-priority:sterile': 'picker-emerg-sterile', 'action-exit:expedite': 'picker-exit-expedite' }

export function textChipTestId(actionId: ActionId, value: string, override?: string): string {
  const sp = SPECIAL[`${actionId}:${value}`]
  if (sp) return sp
  const prefix = override ?? PREFIX[actionId] ?? 'picker-text'
  return `${prefix}-${value.replace(/_/g, '-')}`
}

export function TextPicker({ step, params, onChange, onAccept, actionId, ctx, testPrefix }: PickerProps<'text'>) {
  const sel = params.chips ?? []
  const ref = React.useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = React.useState(0)
  React.useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  const toggle = (v: string) => {
    if (step.multi) onChange({ chips: sel.includes(v) ? sel.filter(x => x !== v) : [...sel, v] })
    else onChange({ chips: [v] })
    if (actionId === 'action-hold-short') {
      if (v === 'next') onChange({ chips: [v], runway: ctx?.nextCrossingRunway ?? params.runway, taxiway: undefined })
      else if (v === 'here') onChange({ chips: [v], runway: undefined, taxiway: undefined })
    }
  }
  const isHoldShort = actionId === 'action-hold-short'
  const holdRunway = isHoldShort && sel.includes('runway')
  const holdTaxiway = isHoldShort && sel.includes('taxiway')
  const runways = ctx?.runways ?? []
  const taxiways = ctx?.taxiways ?? []
  const isCorrection = actionId === 'action-correction'
  const ready = step.multi ? true : sel.length > 0 && (!holdRunway || !!params.runway) && (!holdTaxiway || !!params.taxiway) && (!isCorrection || params.value != null && params.value !== '')
  return (
    <div ref={ref} className={s.picker} tabIndex={-1} data-testid="picker-text" onKeyDown={e => {
      if (e.target instanceof HTMLInputElement) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (ready) onAccept() } return }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(step.options.length - 1, c + 1)) }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)) }
      else if (e.key === ' ') { e.preventDefault(); const o = step.options[cursor]; if (o) toggle(o.value) }
      else if (e.key >= '1' && e.key <= '9') { const o = step.options[Number(e.key) - 1]; if (o) { e.preventDefault(); toggle(o.value) } }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (ready || step.optional) onAccept() }
    }}>
      <div className={s.between}><span className={s.label}>{step.label}</span>{step.multi ? <span className={s.hint}>Space toggles</span> : null}</div>
      <div className={s.rowTight} role={step.multi ? 'group' : 'radiogroup'} aria-label={step.label}>
        {step.options.map((o, i) => (
          <Pill key={o.value} size="m" tone={sel.includes(o.value) ? 'orange' : 'neutral'} interactive selected={sel.includes(o.value)} onClick={() => { setCursor(i); toggle(o.value) }} className={cx(i === cursor && s.chipSelected)} testId={textChipTestId(actionId, o.value, testPrefix)} data-value={o.value}>{o.label}</Pill>
        ))}
      </div>
      {holdRunway ? (
        <div className={s.popover}>
          <span className={s.label}>Runway</span>
          <div className={s.rowTight}>{runways.map(r => <Pill key={r.name} size="s" tone={params.runway === r.name ? 'orange' : 'neutral'} interactive selected={params.runway === r.name} onClick={() => onChange({ runway: r.name })} testId={`picker-holdshort-runway-${r.name}`}>{r.name}</Pill>)}</div>
        </div>
      ) : null}
      {holdTaxiway ? (
        <div className={s.popover}>
          <span className={s.label}>Taxiway</span>
          <div className={s.twyRail}>{taxiways.map(t => <button key={t} type="button" className={cx(s.twy, params.taxiway === t && s.chipSelected)} onClick={() => onChange({ taxiway: t })} data-testid={`picker-holdshort-taxiway-${t}`}>{t}</button>)}</div>
        </div>
      ) : null}
      {isCorrection ? (
        <Input size="m" surface="glass" tabular value={params.value == null ? '' : String(params.value)} onChange={e => onChange({ value: e.target.value.toUpperCase() })} placeholder="Correct value" aria-label="Correct value" fullWidth testId="picker-correction-value" autoComplete="off" />
      ) : null}
      {step.optional ? <span className={s.hint}>Optional — Enter to continue</span> : null}
    </div>
  )
}

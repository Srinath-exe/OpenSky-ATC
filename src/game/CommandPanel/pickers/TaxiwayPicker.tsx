'use client'
/* picker-taxiway: exits ahead (distance, side, engine default) or all taxiways; "next available exit L/R" chips; type letters to filter. */
import * as React from 'react'
import s from './pickers.module.css'
import { Input, IconArrowLeft, IconArrowRight, cx } from '@/design'
import type { PickerProps } from './types'

export function TaxiwayPicker({ step, params, onChange, onAccept }: PickerProps<'taxiway'>) {
  const [q, setQ] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { inputRef.current?.focus({ preventScroll: true }) }, [])
  const isSecond = step.id === 'taxiway2'
  const value = isSecond ? params.taxiway2 ?? null : params.taxiway ?? null
  const nextDir = !isSecond && params.exit?.kind === 'next' ? params.exit.dir : null
  const pick = (t: string) => {
    if (isSecond) onChange({ taxiway2: t })
    else onChange({ taxiway: t, exit: { kind: 'taxiway', taxiway: t }, direction: undefined })
  }
  const pickNext = (dir: 'L' | 'R') => onChange({ taxiway: undefined, exit: { kind: 'next', dir }, direction: dir })
  const exits = step.exits.filter(e => !q || e.taxiway.toUpperCase().startsWith(q))
  const names = step.candidates.filter(n => !q || n.toUpperCase().startsWith(q))
  const list = exits.length ? exits.map(e => e.taxiway) : names
  return (
    <div className={s.picker} data-testid={`picker-taxiway${isSecond ? '-2' : ''}`} onKeyDown={e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!value && !nextDir && list.length === 1) pick(list[0]); if (value || nextDir || list.length === 1 || step.optional) onAccept(); return }
      if (e.target instanceof HTMLInputElement) return
      if (step.nextExitChips && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); pickNext('L') }
      if (step.nextExitChips && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); pickNext('R') }
    }}>
      <span className={s.label}>{step.label}</span>
      {step.nextExitChips ? (
        <div className={s.dirBig}>
          <button type="button" className={s.dirBtn} aria-pressed={nextDir === 'L'} onClick={() => pickNext('L')} data-testid="picker-exit-next-left"><IconArrowLeft size={18} />next exit left</button>
          <button type="button" className={s.dirBtn} aria-pressed={nextDir === 'R'} onClick={() => pickNext('R')} data-testid="picker-exit-next-right">next exit right<IconArrowRight size={18} /></button>
        </div>
      ) : null}
      <Input ref={inputRef} size="m" surface="glass" value={q} onChange={e => setQ(e.target.value.toUpperCase())} placeholder="Taxiway" aria-label="Filter taxiways" fullWidth testId={`picker-taxiway${isSecond ? '-2' : ''}-search`} autoComplete="off" spellCheck={false} />
      {exits.length ? (
        <div className={s.grid}>
          {exits.map(e => (
            <button key={e.taxiway} type="button" className={s.chip} aria-pressed={value === e.taxiway} disabled={!e.enabled} title={e.enabled ? `${e.distAheadM} m ahead` : e.reason} onClick={() => pick(e.taxiway)} onDoubleClick={() => { pick(e.taxiway); onAccept() }} data-testid={`picker-taxiway-${e.taxiway}`} data-state={e.enabled ? 'enabled' : 'disabled'} data-reason={e.enabled ? '' : e.reason}>
              <span className={s.chipRow}><span className={s.chipTitle}>{e.taxiway}</span><span className={s.chipBadges}>{e.engineDefault ? <span className={cx(s.badge, s.badgeOrange)}>pilot</span> : null}{e.highSpeed ? <span className={s.badge}>HS</span> : null}</span></span>
              <span className={s.chipSub}>{e.distAheadM} m · {e.dir === 'L' ? 'left' : 'right'}</span>
              {!e.enabled ? <span className={s.chipReason}>{e.reason}</span> : null}
            </button>
          ))}
        </div>
      ) : names.length ? (
        <div className={s.twyRail} role="listbox" aria-label="Taxiways">
          {names.map(n => <button key={n} type="button" role="option" aria-selected={value === n} className={cx(s.twy, value === n && s.chipSelected)} onClick={() => pick(n)} onDoubleClick={() => { pick(n); onAccept() }} data-testid={`picker-taxiway-${n}`}>{n}</button>)}
        </div>
      ) : <div className={s.empty}>{step.mode === 'exit' || step.mode === 'vacate' ? 'No exits ahead' : `No taxiway "${q}"`}</div>}
    </div>
  )
}

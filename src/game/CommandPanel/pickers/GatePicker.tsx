'use client'
/* picker-gate: terminal-grouped stands; free = white, occupied = dim with "occupied by ..." (R19); assigned stand pre-selected; type to filter. */
import * as React from 'react'
import s from './pickers.module.css'
import { Input, IconSearch, cx } from '@/design'
import type { PickerProps } from './types'

export function GatePicker({ step, params, onChange, onAccept }: PickerProps<'gate'>) {
  const [q, setQ] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { inputRef.current?.focus({ preventScroll: true }) }, [])
  const value = params.stand ?? null
  const list = step.candidates.filter(c => !q || c.ref.toUpperCase().includes(q))
  const groups = new Map<string, typeof list>()
  for (const c of list) { const g = groups.get(c.terminal) ?? []; g.push(c); groups.set(c.terminal, g) }
  const move = (d: number) => {
    const en = list.filter(c => c.enabled || c.assigned)
    if (!en.length) return
    const i = en.findIndex(c => c.ref === value)
    onChange({ stand: en[(i + d + en.length) % en.length].ref })
  }
  return (
    <div className={s.picker} data-testid="picker-gate" onKeyDown={e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!value && list.length === 1) onChange({ stand: list[0].ref }); if (value || list.length === 1) onAccept() }
    }}>
      <div className={s.between}><span className={s.label}>{step.label}</span><span className={s.hint}>{step.candidates.filter(c => c.enabled).length} free</span></div>
      <Input ref={inputRef} size="m" surface="glass" prefixIcon={<IconSearch size={16} />} value={q} onChange={e => setQ(e.target.value.toUpperCase())} placeholder="Stand" aria-label="Search stands" fullWidth testId="picker-gate-search" autoComplete="off" spellCheck={false} />
      <div className={s.list} role="listbox" aria-label="Stands">
        {[...groups].map(([terminal, items]) => (
          <React.Fragment key={terminal}>
            <div className={s.section}>{terminal}</div>
            {items.map(c => (
              <button key={c.ref} type="button" role="option" aria-selected={value === c.ref} aria-pressed={value === c.ref} className={cx(s.listRow, !c.enabled && s.listRowDim)} disabled={!c.enabled && !c.assigned} title={c.reason || undefined} onClick={() => onChange({ stand: c.ref })} onDoubleClick={() => { onChange({ stand: c.ref }); onAccept() }} data-testid={`picker-gate-${c.ref}`} data-state={c.enabled ? 'enabled' : 'disabled'} data-reason={c.reason}>
                <span className={s.listTitle}>{c.ref}{c.assigned ? <span className={cx(s.badge, s.badgeOrange)}> assigned</span> : null}</span>
                <span className={s.listMeta}>{c.enabled ? 'free' : c.reason}</span>
              </button>
            ))}
          </React.Fragment>
        ))}
        {!list.length ? <div className={s.empty}>{step.candidates.length ? `No stand "${q}"` : 'No free stands'}</div> : null}
      </div>
    </div>
  )
}

'use client'
/* picker-fix: searchable list sorted by distance (fixes behind the nose sink to the bottom), bearing (mag) + NM per row; arrows / Enter. */
import * as React from 'react'
import s from './pickers.module.css'
import { Input, IconSearch, cx } from '@/design'
import type { FixChip } from '@/lib/sim/commandTree'

export interface FixListProps {
  candidates: FixChip[]
  value: string | null
  onSelect: (name: string) => void
  onAccept: () => void
  testPrefix?: string
  label?: string
  autoFocus?: boolean
}

export function FixList({ candidates, value, onSelect, onAccept, testPrefix = 'picker-fix', label, autoFocus = true }: FixListProps) {
  const [q, setQ] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { if (autoFocus) inputRef.current?.focus({ preventScroll: true }) }, [autoFocus])
  const list = candidates.filter(c => !q || c.name.toUpperCase().startsWith(q.toUpperCase()))
  const move = (d: number) => {
    if (!list.length) return
    const i = list.findIndex(c => c.name === value)
    onSelect(list[(i + d + list.length) % list.length].name)
  }
  return (
    <div className={s.picker} onKeyDown={e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!value && list.length) onSelect(list[0].name); if (value || list.length) onAccept() }
    }}>
      {label ? <span className={s.label}>{label}</span> : null}
      <Input ref={inputRef} size="m" surface="glass" prefixIcon={<IconSearch size={16} />} value={q} onChange={e => setQ(e.target.value.toUpperCase())} placeholder="Fix" aria-label="Search fixes" fullWidth testId={`${testPrefix}-search`} autoComplete="off" spellCheck={false} />
      <div className={s.list} role="listbox" aria-label="Fixes">
        {list.map(c => (
          <button key={c.name} type="button" role="option" aria-selected={value === c.name} aria-pressed={value === c.name} className={cx(s.listRow, c.behind && s.listRowDim)} onClick={() => onSelect(c.name)} onDoubleClick={() => { onSelect(c.name); onAccept() }} data-testid={`${testPrefix}-${c.name}`}>
            <span className={s.listTitle}>{c.name}</span>
            <span className={s.listMeta}>{String(c.bearingMag).padStart(3, '0')}° / {c.distNM.toFixed(1)} NM{c.behind ? ' · behind' : ''}</span>
          </button>
        ))}
        {!list.length ? <div className={s.empty}>{candidates.length ? `No fix "${q}"` : 'No fixes loaded'}</div> : null}
      </div>
    </div>
  )
}

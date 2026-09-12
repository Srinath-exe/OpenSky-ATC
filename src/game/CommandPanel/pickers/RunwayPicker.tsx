'use client'
/* picker-runway (UX §1.2, §G4): active-for-role first, wind head/cross per end, disabled chips carry the reason; 1-9 / arrows / Enter. */
import * as React from 'react'
import s from './pickers.module.css'
import { Segmented, IconWind, cx } from '@/design'
import type { ApproachType } from '@/lib/sim/commandAst'
import type { PickerProps } from './types'

export function RunwayPicker({ step, params, onChange, onAccept, ctx }: PickerProps<'runway'>) {
  const ref = React.useRef<HTMLDivElement>(null)
  const chips = step.locked && step.default ? step.candidates.filter(c => c.name === step.default) : step.candidates
  const selected = params.runway ?? null
  const mode: ApproachType = params.approachType ?? 'ILS'
  const pick = (name: string) => { onChange({ runway: name }) }
  React.useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key >= '1' && e.key <= '9') {
      const c = chips[Number(e.key) - 1]
      if (c && c.enabled) { e.preventDefault(); pick(c.name) }
      return
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const en = chips.filter(c => c.enabled)
      if (!en.length) return
      const i = Math.max(0, en.findIndex(c => c.name === selected))
      const n = (i + (e.key === 'ArrowRight' ? 1 : en.length - 1)) % en.length
      pick(en[n].name)
      return
    }
    if (e.key === 'Enter' && selected) { e.preventDefault(); e.stopPropagation(); onAccept() }
  }
  const wind = ctx?.wind
  return (
    <div ref={ref} className={s.picker} tabIndex={-1} onKeyDown={onKey} role="radiogroup" aria-label={step.label} data-testid="picker-runway">
      <div className={s.between}>
        <span className={s.label}>{step.label}{step.locked ? ' · locked' : ''}</span>
        {wind ? <span className={cx(s.hint, s.tnum, s.inlineRow)}><IconWind size={12} />{String(Math.round(wind.dir)).padStart(3, '0')}° / {Math.round(wind.kts)}{wind.gust > wind.kts ? `G${Math.round(wind.gust)}` : ''} kt</span> : null}
      </div>
      {step.approachModes ? (
        <Segmented
          small
          ariaLabel="Approach type"
          items={[{ id: 'ILS', label: 'ILS', testId: 'picker-runway-mode-ils' }, { id: 'LOC', label: 'LOC', testId: 'picker-runway-mode-loc' }, { id: 'VISUAL', label: 'VIS', testId: 'picker-runway-mode-visual' }]}
          value={mode}
          onChange={id => onChange({ approachType: id as ApproachType })}
        />
      ) : null}
      {chips.length ? (
        <div className={s.grid}>
          {chips.map((c, i) => {
            const enabled = c.enabled || (mode === 'VISUAL' && c.reason === 'No ILS on this airport')
            return (
              <button
                key={c.name}
                type="button"
                role="radio"
                aria-checked={selected === c.name}
                aria-pressed={selected === c.name}
                className={s.chip}
                disabled={!enabled}
                title={!enabled ? c.reason : `${c.name} · ${c.sub}`}
                data-testid={`picker-runway-${c.name}`}
                data-state={enabled ? 'enabled' : 'disabled'}
                data-reason={enabled ? '' : c.reason}
                onClick={() => pick(c.name)}
                onDoubleClick={() => { pick(c.name); onAccept() }}
              >
                {i < 9 ? <span className={s.kbdIdx}>{i + 1}</span> : null}
                <span className={s.chipRow}><span className={s.chipTitle}>{c.name}</span></span>
                <span className={cx(s.chipSub, c.tailwind && s.chipSubOrange)}>{c.sub}</span>
                <span className={s.chipBadges}>
                  {c.badges.map(b => <span key={b} className={cx(s.badge, b === 'DEP' || b === 'ARR' ? s.badgeGreen : b === 'NO ILS' ? undefined : s.badgeRed)}>{b}</span>)}
                </span>
                {!enabled && c.reason ? <span className={s.chipReason}>{c.reason}</span> : null}
              </button>
            )
          })}
        </div>
      ) : <div className={s.empty}>No runway data</div>}
    </div>
  )
}

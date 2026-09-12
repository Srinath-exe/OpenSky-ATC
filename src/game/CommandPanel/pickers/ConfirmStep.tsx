'use client'
/*
  confirm: the exact transmission (phraseology preview) + expected readback, part chips with remove,
  "+ ADD PART" chips (UX §1.5), aggregated warnings (amber TRANSMIT ANYWAY, 600 ms hold with a progress
  fill) and hard blocks (button replaced by the reason). Enter transmits, Backspace goes back, Esc cancels.
*/
import * as React from 'react'
import s from './pickers.module.css'
import { Button, Kbd, Pill, IconX, IconPlus, IconSend, IconTriangleAlert, IconCircleAlert, cx } from '@/design'
import type { PartChip, ValidationResult } from '@/lib/sim/commandTree'
import type { Draft } from '../draft'
import { PART_LABEL, TOGGLE_PARTS } from '../draft'

export interface ConfirmStepProps {
  draft: Draft
  parts: PartChip[]
  validation: ValidationResult
  transmission: string
  readback: string
  onTransmit: () => void
  onAddPart: (part: PartChip) => void
  onRemovePart: (i: number) => void
  onEditStep: (i: number) => void
  cooldown: boolean
  children?: React.ReactNode
}

const HOLD_MS = 600

export function ConfirmStep({ draft, parts, validation, transmission, readback, onTransmit, onAddPart, onRemovePart, onEditStep, cooldown, children }: ConfirmStepProps) {
  const [showParts, setShowParts] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const holdRef = React.useRef<{ start: number; raf: number } | null>(null)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { if (!draft.sub) ref.current?.focus({ preventScroll: true }) }, [draft.sub])

  const hard = validation.errors
  const soft = validation.warnings
  const blocked = hard.length > 0
  const needsHold = !blocked && soft.length > 0
  const applied = new Set(draft.parts.map(p => p.part))
  const addable = parts.filter(p => !applied.has(p) || TOGGLE_PARTS.includes(p))
  const maxParts = (draft.params.then?.length ?? 0) >= 3

  const startHold = () => {
    if (blocked || cooldown || holdRef.current) return
    const start = performance.now()
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / HOLD_MS)
      setProgress(p)
      if (p >= 1) { holdRef.current = null; setProgress(0); onTransmit(); return }
      holdRef.current = { start, raf: requestAnimationFrame(tick) }
    }
    holdRef.current = { start, raf: requestAnimationFrame(tick) }
  }
  const cancelHold = () => { if (holdRef.current) { cancelAnimationFrame(holdRef.current.raf); holdRef.current = null } setProgress(0) }
  React.useEffect(() => () => cancelHold(), [])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.key === '+' || (e.key === '=' && e.shiftKey)) { e.preventDefault(); setShowParts(v => !v); return }
    if (e.key === 'Enter' && needsHold) {
      e.preventDefault(); e.stopPropagation()
      if (!e.repeat) startHold()
    }
  }
  const onKeyUp = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && needsHold) cancelHold() }

  return (
    <div ref={ref} className={s.picker} tabIndex={-1} onKeyDown={onKey} onKeyUp={onKeyUp} data-testid="confirm-step" role="dialog" aria-label="Confirm transmission">
      <div className={s.summary} data-testid="confirm-summary">
        <span className={s.summaryWho}>Transmit</span>
        <span className={s.summaryText}>{transmission || '—'}</span>
        {readback ? (<><span className={s.summaryWho}>Expected readback</span><span className={s.summaryRb}>{readback}</span></>) : null}
      </div>
      {draft.parts.length ? (
        <div className={s.partChips} aria-label="Parts">
          {draft.parts.map((p, i) => (
            <span key={`${p.part}-${i}`} className={s.partChip} data-testid={`confirm-part-${i}`}>
              {p.label}
              <button type="button" className={s.partRemove} aria-label={`Remove ${p.label}`} onClick={() => onRemovePart(i)} data-testid={`confirm-part-${i}-remove`}><IconX size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}
      {children}
      {addable.length && !draft.sub ? (
        <div className={s.addParts}>
          <Pill size="s" tone={showParts ? 'solid' : 'outline'} icon={<IconPlus size={14} />} interactive selected={showParts} onClick={() => setShowParts(v => !v)} testId="confirm-add-part">ADD PART</Pill>
          {showParts ? addable.map(p => (
            <Pill key={p} size="s" tone={applied.has(p) ? 'orange' : 'neutral'} interactive selected={applied.has(p)} disabled={maxParts && !TOGGLE_PARTS.includes(p) && !applied.has(p)} onClick={() => { onAddPart(p); if (TOGGLE_PARTS.includes(p)) return; setShowParts(false) }} testId={`confirm-add-${p.replace(/_/g, '-')}`}>{PART_LABEL[p]}</Pill>
          )) : null}
        </div>
      ) : null}
      {(hard.length || soft.length) ? (
        <div className={s.issues}>
          {hard.map((e, i) => <div key={`h${i}`} className={cx(s.issue, s.issueHard)} data-testid={i === 0 ? 'confirm-blocked-reason' : `confirm-blocked-${i}`} data-reason={e.text}><IconCircleAlert size={14} className={s.issueIcon} /><span>{e.part ? `${e.part}: ` : ''}{e.text}</span></div>)}
          {soft.map((w, i) => <div key={`w${i}`} className={cx(s.issue, s.issueWarn)} data-testid={`confirm-warning-${i}`}><IconTriangleAlert size={14} className={s.issueIcon} /><span>{w.part ? `${w.part}: ` : ''}{w.text}</span></div>)}
        </div>
      ) : null}
      <div className={s.confirmFooter}>
        <span className={s.spacer} />
        {draft.steps.length > 1 ? <Button variant="ghost" size="sm" onClick={() => onEditStep(draft.index - 1)} testId="step-back">Back</Button> : null}
        {blocked ? null : needsHold ? (
          <Button
            variant="accent"
            className={s.holdBtn}
            iconLeft={<IconSend size={16} />}
            disabled={cooldown}
            onPointerDown={e => { e.preventDefault(); startHold() }}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
            testId="confirm-transmit-anyway"
            aria-label="Transmit anyway (hold)"
          >
            <span className={s.holdRing} data-testid="confirm-hold-ring" style={{ ['--hold-progress' as string]: `${Math.round(progress * 100)}%` }} />
            TRANSMIT ANYWAY <Kbd>Enter</Kbd>
          </Button>
        ) : (
          <span data-testid="confirm-transmit" aria-disabled={cooldown || undefined} data-state={cooldown ? 'disabled' : 'enabled'} className={s.inlineRow}>
            <Button variant="accent" iconLeft={<IconSend size={16} />} disabled={cooldown} onClick={onTransmit} testId="btn-transmit">TRANSMIT <Kbd>Enter</Kbd></Button>
          </span>
        )}
      </div>
    </div>
  )
}

'use client'
/*
  Command panel (UX 04 §1 command tree, §2.1 "Command panel", §G2/§G3/§G6/§G9; design 01 A12 detail panel,
  A11.4/A11.5). Right floating glass panel that slides in when an aircraft is selected:
    header (callsign, type/wake, DEP/ARR, stage chip, View in TOWER, locate, pin, close)
    REQ band (pending pilot request: one-tap answer / unable / standby)
    EMERGENCY band (level · type, POB / fuel / status, checklist, emergency actions)
    KPI row ALT / SPD / HDG with target arrows (click opens the picker)
    quick row + phase-gated actions grid (enabled / disabled-with-reason / hidden) with hotkeys
    stepper: pickers per step, validation on every change, confirm step with the exact transmission,
    TRANSMIT -> sim.transmit -> inline result (ok / unable / partial + streamed readback) + UNDO chip.
  Keyboard: hotkeys pick actions (resolveHotkey, M-chords), Enter confirms / opens the REQ answer,
  Esc back / cancel / deselect, Backspace steps back.
*/
import * as React from 'react'
import styles from './CommandPanel.module.css'
import { GlassPanel, Button, IconButton, Pill, Kpi, Kbd, Tooltip, Stepper, ScrollArea, Icon, IconX, IconArrowUp, IconArrowDown, IconRotateCcw, IconRotateCw, IconSiren, IconCheck, IconCircleAlert, IconTriangleAlert, IconPlaneLanding, IconPlaneTakeoff, cx } from '@/design'
import type { ActionCtx, ActionId, ActionRow, ActionParams, PartChip, PickerStep, ValidationResult } from '@/lib/sim/commandTree'
import { resolveHotkey, POSITION_DEFAULT_ROW, ACTION_DEFS, transmissionPreview, toAst, enabledActionsForStage, HOTKEY_FAMILIES } from '@/lib/sim/commandTree'
import { readback as phraseReadback } from '@/lib/sim/phraseology'
import { isSilent } from '@/lib/sim/dispatch'
import type { DispatchResult } from '@/lib/sim/dispatch'
import type { CommandAST } from '@/lib/sim/commandAst'
import { stageLabel } from '@/lib/sim/stage'
import { ALL_STAGES } from '@/lib/sim/types'
import type { AircraftState, EmergencyChecklistItem, PilotRequest, PlayerPosition, Stage } from '@/lib/sim/types'
import { sim, useSim } from './store'
import { onOpenAction } from './bus'
import type { OpenActionDetail } from './bus'
import { defaultParams, stepSatisfied, stepValueLabel, applyPart, removePart, patchAst, needsPatch, TOGGLE_PARTS, PART_LABEL } from './draft'
import type { Draft } from './draft'
import { parkDraft, takeParkedDraft, useParkedDraft } from './parked'
import { subStepFor, subValue } from './subPicker'
import { PickerBody, useTypewriter } from './PickerBody'
import { ConfirmStep } from './pickers'
import { wakeLetter, kindLabel, stageTone, fmtHdgMag, fmtMMSS, openRequest, requestShort, altParts, ownerTab, PLAYER_POSITIONS, POSITION_LABEL } from './format'
import { isEditableTarget } from '../hooks/useHotkeys'
import { useShellOptional } from '../shellContext'
import type { RadioLine } from '@/components/atc/simStore'

const COOLDOWN_MS = 400
const CHORD_MS = 1500
const CHECKLIST_LABEL: Record<EmergencyChecklistItem, string> = {
  acknowledge: 'Ack', souls_fuel: 'POB / fuel', priority_runway: 'Priority rwy', arff: 'ARFF', ambulance: 'Ambulance',
  hold_traffic: 'Hold traffic', runway_closed: 'Rwy closed', runway_reopened: 'Rwy reopened', inspection: 'Inspection',
}
const GROUP_LABEL: Record<ActionRow['group'], string> = { ground: 'Ground', tower: 'Tower', approach: 'Approach', meta: 'Radio', emergency: 'Emergency' }
const GROUP_ORDER: ActionRow['group'][] = ['ground', 'tower', 'approach', 'meta']
const EMERGENCY_TYPE_LABEL: Record<string, string> = {
  engine_fire: 'engine fire', engine_failure: 'engine failure', medical: 'medical', fuel: 'fuel', depressurization: 'depressurization',
  bird_strike: 'bird strike', gear: 'gear', smoke: 'smoke', hydraulic: 'hydraulic', hijack: 'unlawful interference', radio_failure: 'radio failure',
  general: 'emergency', brake_fire: 'brake fire',
}

interface LastTx {
  key: number
  callsign: string
  actionId: ActionId
  /** Sim time of the transmission. */
  at: number
  result: DispatchResult
  ast: CommandAST | null
  /** Radio key of the ATC line (readback lines after it belong to this transmission). */
  atcKey: number | null
}

export interface CommandPanelProps {
  /** Keep the panel open (empty cheat-sheet) when nothing is selected. */
  pinned?: boolean
  onPinnedChange?: (b: boolean) => void
  className?: string
}

let txKey = 0

// Open-action requests from strips / the shell (bus): the outer CommandPanel selects the aircraft, the
// mounted PanelBody for that aircraft consumes the request (module-level so it survives the remount).
let pendingOpen: OpenActionDetail | null = null
let pendingSeq = 0
const pendingListeners = new Set<() => void>()
function subscribePending(fn: () => void) { pendingListeners.add(fn); return () => { pendingListeners.delete(fn) } }
function usePendingOpenSeq(): number { return React.useSyncExternalStore(subscribePending, () => pendingSeq, () => 0) }

function isInteractiveTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest('button, a[href], [role="button"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"]')
}

/** Right floating command panel. Renders nothing when no aircraft is selected (unless pinned). */
export function CommandPanel({ pinned: pinnedProp, onPinnedChange, className }: CommandPanelProps) {
  const a = useSim((s) => s.selected())
  const position = useSim((s) => s.position)
  const [pinnedLocal, setPinnedLocal] = React.useState(false)
  const pinned = pinnedProp ?? pinnedLocal
  const setPinned = (b: boolean) => { setPinnedLocal(b); onPinnedChange?.(b) }
  React.useEffect(() => onOpenAction((d) => {
    pendingOpen = d
    pendingSeq += 1
    for (const l of pendingListeners) l()
    if (sim.selectedId !== d.aircraftId) sim.select(d.aircraftId)
  }), [])
  if (!a) return pinned ? <EmptyPanel position={position} onUnpin={() => setPinned(false)} className={className} /> : null
  return <PanelBody key={a.id} a={a} position={position} pinned={pinned} onPin={() => setPinned(!pinned)} className={className} />
}

// ──────────────────────────────────────────────────────────────────────────────
//  Panel body (mounted per selected aircraft)
// ──────────────────────────────────────────────────────────────────────────────
function PanelBody({ a, position, pinned, onPin, className }: { a: AircraftState; position: PlayerPosition; pinned: boolean; onPin: () => void; className?: string }) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const shell = useShellOptional()
  const time = useSim((s) => s.time())
  const paused = useSim((s) => s.paused)
  const rows = useSim((s) => s.actionsFor(a), [a.id])
  const ctx = useSim((s) => s.actionCtx(a), [a.id])
  const stage = useSim((s) => s.stageOf(a), [a.id])
  const undoLine = useSim((s) => s.undoableLine())
  const alerts = useSim((s) => s.alertsFor(a.callsign), [a.callsign])
  const radio = useSim((s) => s.radio)
  const settings = useSim((s) => s.settings)
  const hasRadar = useSim((s) => !!s.radar)
  const parked = useParkedDraft(a.id)

  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [subParams, setSubParams] = React.useState<ActionParams>({})
  const [turnDeg, setTurnDeg] = React.useState(30)
  const [last, setLast] = React.useState<LastTx | null>(null)
  const [cooldown, setCooldown] = React.useState(false)
  const [chord, setChord] = React.useState<string | null>(null)
  const [emergOpen, setEmergOpen] = React.useState(true)
  const lastHotkey = React.useRef<{ key: string; id: ActionId } | null>(null)
  const chordTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = React.useRef(draft); draftRef.current = draft
  const rowsRef = React.useRef(rows); rowsRef.current = rows
  const pendingSeqNow = usePendingOpenSeq()

  // Focus the panel when an aircraft is selected (UX §G6 focus model: selecting moves focus to the panel).
  React.useEffect(() => {
    const el = rootRef.current
    if (!el) return
    if (isEditableTarget(document.activeElement)) return
    el.focus({ preventScroll: true })
  }, [])

  // Park an unfinished draft when the panel unmounts (another aircraft selected / deselected).
  React.useEffect(() => () => {
    const d = draftRef.current
    if (d && sim.engine?.byId(d.aircraftId)) parkDraft(d)
  }, [])

  const step: PickerStep | null = draft ? draft.steps[draft.index] ?? null : null

  // ── open / navigate ──
  const openRow = React.useCallback((row: ActionRow, opts: { confirm?: boolean; transmitNow?: boolean } = {}) => {
    if (row.state !== 'enabled') {
      sim.pushToast({ kind: 'attention', text: `${row.label} — ${row.reasonText || 'not available'}`, duration: 2500 })
      return
    }
    const c = sim.actionCtx(a)
    const steps = row.steps.length ? row.steps : sim.stepsFor(row.id, a)
    const params = defaultParams(steps, c?.nextCrossingRunway ?? null)
    let index = 0
    if (opts.confirm) {
      const firstMissing = steps.findIndex((s) => s.type !== 'confirm' && !stepSatisfied(s, params))
      index = firstMissing >= 0 ? firstMissing : steps.length - 1
    }
    const d: Draft = { actionId: row.id, aircraftId: a.id, callsign: a.callsign, steps, index, params, parts: [], patch: {}, sub: null, fromRequest: !!opts.confirm }
    setSubParams({})
    setDraft(d)
    if (opts.transmitNow && index === steps.length - 1) {
      const v = sim.validate(row.id, params, a)
      if (v.ok) transmitDraft(d)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a])

  const openById = React.useCallback((id: ActionId, opts: { confirm?: boolean } = {}) => {
    const row = rowsRef.current.find((r) => r.id === id)
    if (row) openRow(row, opts)
    else sim.pushToast({ kind: 'attention', text: `${ACTION_DEFS[id].label} is not available for ${a.callsign} now`, duration: 2500 })
  }, [openRow, a.callsign])

  // Requests from strips (box clicks, REQ chips, Enter) — UX §10 strip-{cs}-box-*.
  React.useEffect(() => {
    const p = pendingOpen
    if (!p || p.aircraftId !== a.id) return
    pendingOpen = null
    if (p.actionId) openById(p.actionId, { confirm: p.confirm })
    rootRef.current?.focus({ preventScroll: true })
  }, [pendingSeqNow, a.id, openById])

  const cancelDraft = React.useCallback(() => { setDraft(null); setSubParams({}) }, [])
  const setIndex = (i: number) => setDraft((d) => (d ? { ...d, index: Math.max(0, Math.min(d.steps.length - 1, i)), sub: null } : d))
  const back = () => { if (!draft) return; if (draft.sub) { setDraft({ ...draft, sub: null }); return } if (draft.index > 0) setIndex(draft.index - 1); else cancelDraft() }
  const acceptStep = () => {
    if (!draft || !step) return
    if (step.type === 'confirm') { transmitDraft(draft); return }
    if (!stepSatisfied(step, draft.params)) return
    setIndex(draft.index + 1)
  }
  const patchParams = (patch: Partial<ActionParams>) => setDraft((d) => (d ? { ...d, params: { ...d.params, ...patch } } : d))

  // ── validation + preview (recomputed on every store emit: engine state moves) ──
  const validation: ValidationResult | null = draft ? sim.validate(draft.actionId, draft.params, a) : null
  const previewAst = validation?.ast ? (needsPatch(draft!.patch) ? patchAst(validation.ast, draft!.patch) : validation.ast) : null
  const txText = previewAst && ctx ? transmissionPreview(previewAst, ctx) : ''
  const rbText = React.useMemo(() => {
    if (!previewAst || !ctx?.phraseCtx) return ''
    try { return phraseReadback(previewAst, ctx.phraseCtx) } catch { return '' }
  }, [previewAst, ctx])

  // ── transmit ──
  function transmitDraft(d: Draft) {
    if (cooldown) return
    const before = sim.radio.length
    let result: DispatchResult
    let ast: CommandAST | null = null
    try {
      ast = toAst(d.actionId, d.params, a.callsign, a)
      if (needsPatch(d.patch)) ast = patchAst(ast, d.patch)
      result = needsPatch(d.patch) ? sim.dispatchAst(ast) : sim.transmit(d.actionId, d.params, a)
    } catch (err) {
      result = { ok: false, code: 'invalid_param', transmission: '', readback: '', reason: err instanceof Error ? err.message : String(err), warnings: [] }
    }
    const atc = sim.radio.slice(before).find((l) => l.who === 'ATC' && l.callsign === a.callsign) ?? null
    setLast({ key: ++txKey, callsign: a.callsign, actionId: d.actionId, at: sim.time(), result, ast, atcKey: atc?.key ?? null })
    setDraft(null); setSubParams({})
    setCooldown(true)
    setTimeout(() => setCooldown(false), COOLDOWN_MS)
    rootRef.current?.focus({ preventScroll: true })
  }

  // ── parts (confirm step) ──
  const onAddPart = (part: PartChip) => {
    if (!draft) return
    if (part === 'via') { const i = draft.steps.findIndex((s) => s.type === 'taxiway-route'); if (i >= 0) setIndex(i); return }
    if (TOGGLE_PARTS.includes(part)) { setDraft({ ...draft, ...applyPart(draft, part, undefined, a, { trafficText: trafficText(a, ctx) }) }); return }
    const s = subStepFor(part, a, ctx)
    if (!s) return
    setSubParams(defaultParams([s], ctx?.nextCrossingRunway ?? null))
    setDraft({ ...draft, sub: { part, step: s, title: PART_LABEL[part] } })
  }
  const acceptSub = () => {
    if (!draft?.sub) return
    const value = subValue(draft.sub.part, subParams, turnDeg)
    if (value === undefined) return
    setDraft({ ...draft, ...applyPart(draft, draft.sub.part, value, a), sub: null })
    setSubParams({})
  }
  const onRemovePart = (i: number) => { if (draft) setDraft({ ...draft, ...removePart(draft, i, a) }) }

  // ── hotkeys (UX §1.3, §G6): letters pick actions, Enter confirms, Esc cancels, Backspace goes back ──
  const handleKey = (e: KeyboardEvent, fromPanel: boolean): boolean => {
    if (e.defaultPrevented) return false
    if (isEditableTarget(e.target)) return false
    const d = draftRef.current
    const list = rowsRef.current
    const key = e.key
    const ctrl = e.ctrlKey || e.metaKey
    // Enter / Space on a focused button, option or tab belongs to that control (no double activation).
    if ((key === 'Enter' || key === ' ') && isInteractiveTarget(e.target)) return false
    if (fromPanel && ((key === 'u' || key === 'U') && !ctrl && !d)) return sim.undo()
    if (fromPanel && ctrl && !e.shiftKey && (key === 'z' || key === 'Z')) return sim.undo()
    if (d) {
      if (key === 'Escape') { if (d.sub) setDraft({ ...d, sub: null }); else cancelDraft(); return true }
      if (key === 'Backspace') { back(); return true }
      if (key === 'Enter') {
        if (d.sub) { acceptSub(); return true }
        const s = d.steps[d.index]
        if (s?.type === 'confirm') {
          const v = sim.validate(d.actionId, d.params, a)
          if (v.errors.length) return true
          if (v.warnings.length && !ctrl) return true // ConfirmStep owns the press-and-hold Enter; a plain Enter elsewhere is swallowed
          transmitDraft(d); return true
        }
        acceptStep(); return true
      }
      // second press of the family letter cycles the alternatives (§G2) while still on the first step
      if (!ctrl && !e.altKey && key.length === 1 && /[a-z]/i.test(key) && d.index === 0 && !d.sub) {
        const K = key.toUpperCase()
        if (HOTKEY_FAMILIES[K]?.includes(d.actionId)) {
          const next = resolveHotkey(K, list, d.actionId)
          if (next && next.id !== d.actionId) { openRow(next); return true }
        }
      }
      return false
    }
    if (key === 'Escape') { if (fromPanel) { if (shell?.closeTop()) return true; sim.select(null); return true } return false }
    if (key === 'Enter') {
      const p = list.find((r) => r.primary && r.state === 'enabled')
      if (p) { openRow(p, { confirm: true, transmitNow: ctrl }); return true }
      return false
    }
    if (ctrl || e.altKey || e.shiftKey) return false
    if (key.length !== 1 || !/[a-z]/i.test(key)) return false
    const K = key.toUpperCase()
    if (!fromPanel && K === 'F' && document.body.dataset.focusRegion === 'map') return false
    if (chordTimer.current) {
      clearTimeout(chordTimer.current); chordTimer.current = null; setChord(null)
      const row = resolveHotkey(`M,${K}`, list)
      if (row) { openRow(row); return true }
      return K === 'M'
    }
    if (K === 'M' && list.some((r) => r.group === 'emergency')) {
      setChord('M')
      chordTimer.current = setTimeout(() => { chordTimer.current = null; setChord(null) }, CHORD_MS)
      return true
    }
    const after = lastHotkey.current?.key === K ? lastHotkey.current.id : null
    const row = resolveHotkey(K, list, after)
    if (!row) return false
    lastHotkey.current = { key: K, id: row.id }
    openRow(row)
    return true
  }
  const handleKeyRef = React.useRef(handleKey); handleKeyRef.current = handleKey

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current
      if (root && root.contains(e.target as Node)) return // handled by the panel's own onKeyDown
      if (handleKeyRef.current(e, false)) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  React.useEffect(() => () => { if (chordTimer.current) clearTimeout(chordTimer.current) }, [])

  // ── derived header data ──
  const req = openRequest(a)
  const reqVisible = req && time >= a.standbyUntil ? req : null
  const emergency = a.emergency && a.emergency.status !== 'resolved' ? a.emergency : null
  const owner = ownerTab(a.onFrequency)
  const inMyBay = sim.bayOf(a, position) != null
  const viewIn = !inMyBay ? (PLAYER_POSITIONS.find((p) => p !== position && (p !== 'approach' || hasRadar) && sim.bayOf(a, p) != null) ?? null) : null
  const offFreq = owner != null && owner !== position
  const aiTag = (owner === 'tower' && settings.autoTower) || (owner === 'ground' && settings.autoGround)
  const label = stageLabel(stage)
  const primary = rows.find((r) => r.primary && r.state === 'enabled') ?? null
  const emergencyRows = rows.filter((r) => r.group === 'emergency')
  const normalRows = rows.filter((r) => r.group !== 'emergency')
  const quick = quickRows(rows, position, primary)
  const undoForMe = undoLine && undoLine.callsign === a.callsign ? undoLine : null

  const onRootKey = (e: React.KeyboardEvent) => { if (handleKey(e.nativeEvent, true)) { e.preventDefault(); e.stopPropagation() } }

  return (
    <GlassPanel
      ref={rootRef}
      variant="glass-strong"
      padding="card"
      radius="card-lg"
      className={cx(styles.panel, className)}
      as="aside"
      aria-label={`${a.callsign} command panel`}
      tabIndex={-1}
      onKeyDown={onRootKey}
      data-testid="detail-panel"
      data-callsign={a.callsign}
      data-stage={stage}
      data-kind={a.plan.kind}
      data-conflict={a.conflict ? 'true' : undefined}
      data-emergency={emergency ? 'true' : undefined}
      data-draft={draft ? draft.actionId : undefined}
      data-hotkeys={draft ? 'draft' : 'root'}
    >
      <div className={styles.body}>
        <header className={styles.header}>
          <div className={styles.headRow}>
            <span className={styles.callsign} data-testid="detail-callsign">{a.callsign}</span>
            <Pill size="xs" tone="solid" icon={a.plan.kind === 'departure' ? <IconPlaneTakeoff /> : <IconPlaneLanding />} testId="badge-kind" data-kind={a.plan.kind}>{kindLabel(a)}</Pill>
            <span className={styles.headSpacer} />
            <div className={styles.headIcons}>
              <IconButton size={32} variant="ghost" label="Centre map on aircraft" icon={<Icon name="locate-fixed" />} onClick={() => sim.centerOn(a.id)} testId="panel-locate" />
              <IconButton size={32} variant="ghost" label={pinned ? 'Unpin panel' : 'Keep panel open'} icon={<Icon name="map-pin" />} active={pinned} onClick={onPin} aria-pressed={pinned} testId="panel-pin" />
              <span data-testid="panel-close">
                <IconButton size={32} variant="ghost" label="Close" icon={<IconX />} onClick={() => sim.select(null)} testId="detail-close" />
              </span>
            </div>
          </div>
          <div className={styles.chips}>
            <span className={styles.sub} data-testid="detail-sub" data-wake={a.perf.weightClass}>
              {a.airline} · {a.perf.icaoCode}/<span data-testid="panel-wake">{wakeLetter(a.perf.weightClass)}</span>
              {a.plan.dest ? ` · ${a.plan.dest}` : ''}
            </span>
          </div>
          <div className={styles.chips}>
            <Tooltip content={label.long} placement="bottom">
              <Pill size="s" tone={stageTone(stage)} uppercase testId="panel-stage" data-stage={stage}>{label.short}</Pill>
            </Tooltip>
            <span data-testid="panel-phase-chip" data-phase={a.phase} hidden />
            <span data-testid="panel-kind" data-kind={a.plan.kind} hidden />
            {a.plan.runway ? <Pill size="s" tone="outline" tabular testId="panel-runway">RWY {a.plan.runway}</Pill> : null}
            {a.plan.gateRef ? <Pill size="s" tone="outline" tabular testId="panel-stand">STAND {a.plan.gateRef}</Pill> : null}
            {a.pendingCmds.length ? <Pill size="s" tone="orange" dot="orange" testId="panel-pending">{a.pendingCmds.length} pending</Pill> : null}
            {aiTag ? <Pill size="s" tone="dim" testId="panel-ai-tag">AI</Pill> : null}
            {viewIn ? (
              <button type="button" className={styles.link} onClick={() => sim.setPosition(viewIn)} data-testid={`panel-view-in-${viewIn}`}>
                View in {POSITION_LABEL[viewIn]} <Icon name="arrow-up-right" size={14} />
              </button>
            ) : null}
          </div>
          {offFreq ? (
            <div className={cx(styles.note, settings.strictFrequencies && styles.noteWarn)} data-testid="panel-onfreq-note">
              <Icon name="radio" size={14} /> On {POSITION_LABEL[a.onFrequency]} frequency{settings.strictFrequencies ? ' — not on your frequency' : ''}
            </div>
          ) : null}
          {paused ? <div className={cx(styles.note, styles.noteWarn)} data-testid="panel-paused-note"><Icon name="pause" size={14} /> Paused — commands disabled</div> : null}
          {parked && !draft ? (
            <div className={styles.chips}>
              <Pill size="s" tone="orange" icon={<Icon name="rotate-ccw" />} interactive onClick={() => { const d = takeParkedDraft(a.id); if (d) setDraft(d) }} testId="panel-draft-resume">Resume draft · {ACTION_DEFS[parked.draft.actionId].label}</Pill>
            </div>
          ) : null}
        </header>

        <ScrollArea className={styles.scroll} fade>
          <div className={styles.stack}>
            {alerts.length ? <AlertBanner callsign={a.callsign} alerts={alerts} /> : null}
            {emergency ? (
              <EmergencyBand a={a} time={time} open={emergOpen} onToggle={() => setEmergOpen((v) => !v)} rows={emergencyRows} onOpen={openRow} chord={chord} />
            ) : null}
            {reqVisible && !draft ? <RequestBand req={reqVisible} time={time} primary={primary} rows={rows} onOpen={openRow} onOpenById={openById} /> : null}

            <Metrics a={a} ctx={ctx} stage={stage} rows={rows} onOpenById={openById} />

            {last && last.callsign === a.callsign ? <ResultBlock last={last} radio={radio} time={time} undo={undoForMe} onDismiss={() => setLast(null)} /> : null}

            {draft && step ? (
              <DraftStepper
                draft={draft} step={step} a={a} ctx={ctx} time={time} validation={validation!} txText={txText} rbText={rbText} cooldown={cooldown}
                subParams={subParams} setSubParams={setSubParams} turnDeg={turnDeg} setTurnDeg={setTurnDeg}
                onChange={patchParams} onAccept={acceptStep} onBack={back} onCancel={cancelDraft} onStepClick={setIndex}
                onTransmit={() => transmitDraft(draft)} onAddPart={onAddPart} onRemovePart={onRemovePart} onAcceptSub={acceptSub} onCancelSub={() => setDraft({ ...draft, sub: null })}
              />
            ) : (
              <ActionGrid rows={normalRows} quick={quick} onOpen={openRow} chord={chord} />
            )}
          </div>
        </ScrollArea>

        <footer className={styles.footer}>
          <span className={styles.kbdHints}>
            {draft ? (<><Kbd>Esc</Kbd> cancel <Kbd>Backspace</Kbd> back</>) : primary ? (<><Kbd>Enter</Kbd> {primary.label}</>) : (<><Kbd>Esc</Kbd> deselect</>)}
          </span>
          <span className={styles.spacer} />
          {undoForMe && !draft ? <UndoChip line={undoForMe} time={time} /> : null}
          {draft ? <Button variant="ghost" size="sm" onClick={cancelDraft} testId="btn-cancel">Cancel</Button> : null}
        </footer>
      </div>
    </GlassPanel>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
//  Pieces
// ──────────────────────────────────────────────────────────────────────────────
function quickRows(rows: ActionRow[], position: PlayerPosition, primary: ActionRow | null): ActionRow[] {
  const out: ActionRow[] = []
  if (primary) out.push(primary)
  for (const id of POSITION_DEFAULT_ROW[position]) {
    const r = rows.find((x) => x.id === id && x.state === 'enabled' && x.group !== 'emergency')
    if (r && !out.includes(r)) out.push(r)
  }
  for (const r of rows) { if (out.length >= 5) break; if (r.state === 'enabled' && r.group !== 'emergency' && r.group !== 'meta' && !out.includes(r)) out.push(r) }
  return out.slice(0, 5)
}

function trafficText(a: AircraftState, ctx: ActionCtx | null): string | null {
  const rwy = a.plan.runway ?? a.assignedRunway
  if (!rwy || !ctx) return null
  const arr = ctx.arrivalOnFinal(rwy)
  return arr ? `traffic ${arr.callsign} ${arr.nm.toFixed(0)}-mile final` : null
}

function AlertBanner({ callsign, alerts }: { callsign: string; alerts: ReturnType<typeof sim.alertsFor> }) {
  const al = alerts[0]
  return (
    <div className={cx(styles.band, styles.bandAlert)} role="alert" data-testid="panel-alert-banner" data-kind={al.kind} data-severity={al.severity}>
      <div className={styles.bandHead} role="presentation">
        <span className={cx(styles.bandIcon, styles.bandIconRed)}><IconTriangleAlert size={16} /></span>
        <span className={cx(styles.bandTitle, styles.bandTitleRed)}>{al.title}</span>
        <span className={styles.bandMeta}>{alerts.length > 1 ? `+${alerts.length - 1}` : al.kind.toUpperCase()}</span>
      </div>
      {al.detail ? <div className={styles.bandText} data-testid="panel-alert-geometry">{al.detail}</div> : null}
      <div className={styles.bandActions}>
        {!al.ack ? <Button size="sm" variant="secondary" onClick={() => sim.ackAlert(al.id)} testId="panel-alert-ack">Ack</Button> : <Pill size="xs" tone="dim">acknowledged</Pill>}
        {al.subjects.filter((s) => s !== callsign).map((s) => (
          <Button key={s} size="sm" variant="ghost" onClick={() => { const o = sim.find(s); if (o) sim.select(o.id) }} testId={`panel-alert-pair-${s}`}>{s}</Button>
        ))}
      </div>
    </div>
  )
}

function RequestBand({ req, time, primary, rows, onOpen, onOpenById }: { req: PilotRequest; time: number; primary: ActionRow | null; rows: ActionRow[]; onOpen: (r: ActionRow, o?: { confirm?: boolean }) => void; onOpenById: (id: ActionId, o?: { confirm?: boolean }) => void }) {
  const age = Math.max(0, time - req.at)
  const unable = rows.find((r) => r.id === 'action-unable')
  const standby = rows.find((r) => r.id === 'action-standby')
  return (
    <div className={cx(styles.band, styles.bandReq)} data-testid="panel-req-band" data-request={req.kind} data-age={Math.round(age)}>
      <button type="button" className={styles.bandHead} onClick={() => { if (primary) onOpen(primary, { confirm: true }) }} disabled={!primary} aria-label={`Request: ${req.text}`} data-testid="panel-req-open">
        <span className={cx(styles.bandIcon, styles.bandIconOrange)}><Icon name="radio" size={16} /></span>
        <span className={cx(styles.bandTitle, styles.bandTitleOrange)}>REQ · {requestShort(req)}</span>
        <span className={styles.bandMeta} data-testid="panel-req-age">{fmtMMSS(age)}{req.recalls ? ` · ×${req.recalls + 1}` : ''}</span>
      </button>
      <div className={styles.bandText}>{req.text}</div>
      <div className={styles.bandActions}>
        {primary ? <Button size="sm" variant="accent" onClick={() => onOpen(primary, { confirm: true })} testId="panel-req-answer">{primary.label}{primary.hotkey ? <Kbd className={styles.actionKbd}>{primary.hotkey}</Kbd> : <Kbd className={styles.actionKbd}>Enter</Kbd>}</Button> : null}
        <Button size="sm" variant="secondary" disabled={!unable || unable.state !== 'enabled'} onClick={() => onOpenById('action-unable')} testId="panel-req-unable">Unable <Kbd className={styles.actionKbd}>N</Kbd></Button>
        <Button size="sm" variant="secondary" disabled={!standby || standby.state !== 'enabled'} onClick={() => onOpenById('action-standby', { confirm: true })} testId="panel-req-standby">Standby <Kbd className={styles.actionKbd}>Y</Kbd></Button>
      </div>
    </div>
  )
}

function EmergencyBand({ a, time, open, onToggle, rows, onOpen, chord }: { a: AircraftState; time: number; open: boolean; onToggle: () => void; rows: ActionRow[]; onOpen: (r: ActionRow) => void; chord: string | null }) {
  const em = a.emergency!
  const checklist = Object.keys(CHECKLIST_LABEL) as EmergencyChecklistItem[]
  return (
    <div className={cx(styles.band, styles.bandEmerg)} role="region" aria-label="Emergency" data-testid="panel-emerg-band" data-level={em.level} data-type={em.type} data-status={em.status}>
      <button type="button" className={styles.bandHead} onClick={onToggle} aria-expanded={open} data-testid="panel-emerg-toggle">
        <span className={cx(styles.bandIcon, styles.bandIconRed)}><IconSiren size={16} /></span>
        <span className={cx(styles.bandTitle, styles.bandTitleRed)}>{em.level} · {EMERGENCY_TYPE_LABEL[em.type] ?? em.type}</span>
        <span className={styles.bandMeta}>{fmtMMSS(Math.max(0, time - em.declaredAt))}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>
      <div className={styles.fields}>
        <span className={styles.field}><span className={styles.fieldLabel}>POB</span><span data-testid="emerg-band-pob">{em.soulsOnBoard || '—'}</span></span>
        <span className={styles.field}><span className={styles.fieldLabel}>Fuel</span><span data-testid="emerg-band-fuel">{em.fuelMin != null ? `${Math.max(0, Math.round(em.fuelMin))} min` : (a.fuelMin != null ? `${Math.round(a.fuelMin)} min` : '—')}</span></span>
        <span className={styles.field}><span className={styles.fieldLabel}>Status</span><span data-testid="emerg-band-status">{em.status.replace(/_/g, ' ')}</span></span>
        {em.squawk ? <span className={styles.field}><span className={styles.fieldLabel}>Sqk</span><span>{em.squawk}</span></span> : null}
        {em.runway ? <span className={styles.field}><span className={styles.fieldLabel}>Rwy</span><span>{em.runway}{em.sterile ? ' sterile' : ''}</span></span> : null}
      </div>
      {open ? (
        <>
          {em.requests.length ? <div className={styles.bandText}>{em.requests[em.requests.length - 1]}</div> : null}
          <div className={styles.checklist} aria-label="Emergency checklist" data-testid="panel-emerg-checklist">
            {checklist.map((k) => (
              <span key={k} className={styles.check} data-done={em.checklist[k] != null ? 'true' : 'false'} data-testid={`emerg-check-${k.replace(/_/g, '-')}`}>
                {em.checklist[k] != null ? <IconCheck size={12} /> : <span aria-hidden="true">·</span>}{CHECKLIST_LABEL[k]}
              </span>
            ))}
          </div>
          {rows.length ? (
            <div className={styles.emergGrid}>
              {rows.map((r) => <ActionButton key={r.id} row={r} onOpen={onOpen} danger />)}
            </div>
          ) : null}
          {chord === 'M' ? <span className={styles.chordHint}><Kbd>M</Kbd> then a letter…</span> : null}
        </>
      ) : null}
    </div>
  )
}

function Metrics({ a, ctx, stage, rows, onOpenById }: { a: AircraftState; ctx: ActionCtx | null; stage: Stage; rows: ActionRow[]; onOpenById: (id: ActionId) => void }) {
  const magVar = ctx?.magVar ?? 0
  const ta = ctx?.transitionAltFt ?? 6000
  const air = a.altitude > 0 || stage.startsWith('arr_') || stage === 'dep_climb' || stage === 'dep_level' || stage === 'go_around' || stage === 'takeoff_air'
  const alt = altParts(a.altitude, ta)
  const altTarget = air ? (a.cmdAltitude ?? a.targetAltitude) : null
  const altDiff = altTarget != null ? altTarget - a.altitude : 0
  const spdTarget = air ? (a.cmdIas ?? a.targetSpeed) : null
  const spdDiff = spdTarget != null ? spdTarget - a.speed : 0
  const hdgDiff = ((a.targetHeading - a.heading + 540) % 360) - 180
  const hdgTarget = Math.abs(hdgDiff) > 2 ? a.targetHeading : null
  const can = (id: ActionId) => rows.some((r) => r.id === id && r.state === 'enabled')
  const altT = altTarget != null ? altParts(altTarget, ta) : null
  return (
    <div className={styles.metrics} role="group" aria-label="Live metrics">
      <button type="button" className={styles.metric} onClick={() => onOpenById('action-altitude')} disabled={!can('action-altitude')} data-testid="panel-metric-alt" title="Climb / descend">
        <span className={styles.metricLabel}>Alt</span>
        {alt.hi === 'FL'
          ? <Kpi size="m" prefix="FL" prefixDim hi={alt.lo} lo="" tabular testId="metric-alt" data-value={Math.round(a.altitude)} />
          : <Kpi size="m" hi={alt.hi} lo={alt.lo} unit={alt.unit || undefined} unitTone="text-3" testId="metric-alt" data-value={Math.round(a.altitude)} />}
        {altTarget != null && Math.abs(altDiff) > 50 ? (
          <span className={styles.target} data-testid="metric-alt-target" data-dir={altDiff > 0 ? 'up' : 'dn'} data-value={Math.round(altTarget)}>
            {altDiff > 0 ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />}{altT!.hi}{altT!.lo}{altT!.unit ? ` ${altT!.unit}` : ''}
          </span>
        ) : <span className={cx(styles.target, styles.targetEmpty)}>{air ? 'level' : 'ground'}</span>}
      </button>
      <button type="button" className={styles.metric} onClick={() => onOpenById('action-speed')} disabled={!can('action-speed')} data-testid="panel-metric-spd" title="Speed">
        <span className={styles.metricLabel}>Spd</span>
        <Kpi size="m" value={Math.round(a.speed)} unit="kt" unitTone="text-3" testId="metric-spd" data-value={Math.round(a.speed)} />
        {spdTarget != null && Math.abs(spdDiff) > 5 ? (
          <span className={styles.target} data-testid="metric-spd-target" data-dir={spdDiff > 0 ? 'up' : 'dn'} data-value={Math.round(spdTarget)}>
            {spdDiff > 0 ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />}{Math.round(spdTarget)}
          </span>
        ) : <span className={cx(styles.target, styles.targetEmpty)}>{a.cmdIas != null ? `asg ${a.cmdIas}` : 'own'}</span>}
      </button>
      <button type="button" className={styles.metric} onClick={() => onOpenById('action-heading')} disabled={!can('action-heading')} data-testid="panel-metric-hdg" title="Vector">
        <span className={styles.metricLabel}>Hdg</span>
        <Kpi size="m" value={fmtHdgMag(a.heading, magVar)} unit="°" unitTone="text-3" tabular testId="metric-hdg" data-value={Math.round(a.heading)} />
        {hdgTarget != null ? (
          <span className={styles.target} data-testid="metric-hdg-target" data-dir={(a.turnDir ?? (hdgDiff < 0 ? 'L' : 'R')) === 'L' ? 'l' : 'r'} data-value={Math.round(hdgTarget)}>
            {(a.turnDir ?? (hdgDiff < 0 ? 'L' : 'R')) === 'L' ? <IconRotateCcw size={12} /> : <IconRotateCw size={12} />}{fmtHdgMag(hdgTarget, magVar)}
          </span>
        ) : <span className={cx(styles.target, styles.targetEmpty)}>{a.navMode === 'ils' || a.navMode === 'loc' ? a.navMode.toUpperCase() : a.navMode === 'direct' && a.directTargetName ? `DCT ${a.directTargetName}` : a.navMode === 'hold' && a.holdFixName ? `HLD ${a.holdFixName}` : 'steady'}</span>}
      </button>
    </div>
  )
}

function ActionButton({ row, onOpen, danger = false, className }: { row: ActionRow; onOpen: (r: ActionRow) => void; danger?: boolean; className?: string }) {
  const disabled = row.state !== 'enabled'
  const btn = (
    <Button
      variant={row.primary ? 'accent' : danger && (row.id === 'emerg-hold-all' || row.id === 'emerg-breakoff' || row.id === 'emerg-stop-runway') ? 'danger' : 'secondary'}
      size="md"
      className={cx(styles.actionBtn, className)}
      disabled={disabled}
      onClick={() => onOpen(row)}
      testId={row.id}
      data-state={row.state}
      data-reason={row.reasonText}
      data-hotkey={row.hotkey ?? ''}
      data-primary={row.primary ? 'true' : undefined}
      data-group={row.group}
      aria-label={disabled ? `${row.label} — ${row.reasonText}` : row.label}
    >
      <span className={styles.actionLabel}>{row.label}</span>
      {row.hotkey ? <Kbd className={styles.actionKbd}>{row.hotkey}</Kbd> : null}
    </Button>
  )
  if (disabled) return <Tooltip content={row.reasonText || 'Not available'} placement="left" block>{btn}</Tooltip>
  if (row.soft.length) return <Tooltip content={row.soft.join(' · ')} kbd={row.hotkey ? [row.hotkey] : undefined} placement="left" block>{btn}</Tooltip>
  return btn
}

function ActionGrid({ rows, quick, onOpen, chord }: { rows: ActionRow[]; quick: ActionRow[]; onOpen: (r: ActionRow) => void; chord: string | null }) {
  const groups = GROUP_ORDER.map((g) => ({ g, items: rows.filter((r) => r.group === g) })).filter((x) => x.items.length)
  const multi = groups.length > 1
  return (
    <div className={styles.section} data-testid="panel-actions">
      {quick.length ? (
        <div className={styles.quick} role="toolbar" aria-label="Quick actions" data-testid="panel-quick-row">
          {quick.map((r) => (
            <Pill key={r.id} size="m" tone={r.primary ? 'orange' : 'solid'} interactive onClick={() => onOpen(r)} testId={`quick-${r.id}`} data-action={r.id} data-hotkey={r.hotkey ?? ''}>
              {r.label}{r.hotkey ? <Kbd className={styles.actionKbd}>{r.hotkey}</Kbd> : null}
            </Pill>
          ))}
        </div>
      ) : null}
      <div className={styles.sectionTitle}>
        <span>Actions</span>
        {chord === 'M' ? <span className={styles.chordHint}><Kbd>M</Kbd> then a letter…</span> : <span>{rows.filter((r) => r.state === 'enabled').length} available</span>}
      </div>
      {groups.map(({ g, items }) => (
        <React.Fragment key={g}>
          {multi ? <div className={styles.groupLabel}>{GROUP_LABEL[g]}</div> : null}
          <div className={styles.grid} role="group" aria-label={GROUP_LABEL[g]}>
            {items.map((r) => <ActionButton key={r.id} row={r} onOpen={onOpen} />)}
          </div>
        </React.Fragment>
      ))}
      {!rows.length ? <span className={styles.hint}>No radio actions in this stage.</span> : null}
    </div>
  )
}

interface DraftStepperProps {
  draft: Draft; step: PickerStep; a: AircraftState; ctx: ActionCtx | null; time: number; validation: ValidationResult; txText: string; rbText: string; cooldown: boolean
  subParams: ActionParams; setSubParams: React.Dispatch<React.SetStateAction<ActionParams>>; turnDeg: number; setTurnDeg: (n: number) => void
  onChange: (p: Partial<ActionParams>) => void; onAccept: () => void; onBack: () => void; onCancel: () => void; onStepClick: (i: number) => void
  onTransmit: () => void; onAddPart: (p: PartChip) => void; onRemovePart: (i: number) => void; onAcceptSub: () => void; onCancelSub: () => void
}

function DraftStepper(p: DraftStepperProps) {
  const { draft, step, a, ctx, time, validation, txText, rbText, cooldown, subParams, setSubParams, turnDeg, setTurnDeg, onChange, onAccept, onBack, onCancel, onStepClick, onTransmit, onAddPart, onRemovePart, onAcceptSub, onCancelSub } = p
  const magVar = ctx?.magVar ?? 0
  const ta = ctx?.transitionAltFt ?? 6000
  const crumbs = draft.steps.map((s, i) => ({ id: s.id, label: s.label, value: stepValueLabel(s, draft.params, magVar, ta), testId: `step-${i}` }))
  const isConfirm = step.type === 'confirm'
  const satisfied = stepSatisfied(step, draft.params)
  const def = ACTION_DEFS[draft.actionId]
  const rootRef = React.useRef<HTMLDivElement>(null)
  // The stepper lives below the bands + KPI row inside the panel's scroll region: bring the active step (and its
  // TRANSMIT / Next footer) into view whenever the step changes, otherwise the confirm bar can sit below the fold.
  React.useEffect(() => {
    const el = rootRef.current
    if (!el || typeof el.scrollIntoView !== 'function') return
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    try { el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' }) } catch { /* jsdom */ }
  }, [draft.actionId, draft.index, draft.sub?.part])
  return (
    <div ref={rootRef} className={styles.stepper} data-testid={`stepper-${draft.actionId}`} data-step={draft.index} data-step-type={step.type}>
      <Stepper steps={crumbs} activeIndex={draft.index} onStepClick={onStepClick} title={<span data-testid="step-title">{def.label}</span>} subtitle={isConfirm || (step.label === def.label && !step.optional) ? undefined : `${step.label}${step.optional ? ' · optional' : ''}`} keyboard={false} testId="stepper">
        {isConfirm ? (
          <ConfirmStep
            draft={draft}
            parts={step.parts}
            validation={validation}
            transmission={txText}
            readback={rbText}
            onTransmit={onTransmit}
            onAddPart={onAddPart}
            onRemovePart={onRemovePart}
            onEditStep={onStepClick}
            cooldown={cooldown}
          >
            {draft.sub ? (
              <div className={styles.subBox} data-testid={`sub-picker-${draft.sub.part.replace(/_/g, '-')}`}>
                <div className={styles.subHead}>
                  <span className={styles.subTitle}>{draft.sub.title}</span>
                  <IconButton size={32} variant="ghost" label="Close part" icon={<IconX />} onClick={onCancelSub} testId="sub-picker-close" />
                </div>
                <PickerBody step={draft.sub.step} params={subParams} onChange={(patch) => setSubParams((s) => ({ ...s, ...patch }))} onAccept={onAcceptSub} a={a} ctx={ctx} actionId={draft.actionId} time={time} testPrefix={`picker-${draft.sub.part.replace(/_/g, '-')}`} />
                {draft.sub.part === 'turn_lr' ? (
                  <div className={styles.degRow}>
                    <span className={styles.hint}>Degrees</span>
                    {[10, 20, 30, 45].map((d) => <Pill key={d} size="s" tone={turnDeg === d ? 'orange' : 'neutral'} interactive selected={turnDeg === d} onClick={() => setTurnDeg(d)} tabular testId={`picker-takeoff-turn-deg-${d}`}>{d}°</Pill>)}
                  </div>
                ) : null}
                <div className={styles.stepFooter}>
                  <span className={styles.spacer} />
                  <Button size="sm" variant="ghost" onClick={onCancelSub} testId="sub-picker-cancel">Cancel</Button>
                  <Button size="sm" variant="accent" onClick={onAcceptSub} disabled={subValue(draft.sub.part, subParams, turnDeg) === undefined} testId="sub-picker-add">Add part <Kbd>Enter</Kbd></Button>
                </div>
              </div>
            ) : null}
          </ConfirmStep>
        ) : (
          <>
            <div data-picker="true">
              <PickerBody step={step} params={draft.params} onChange={onChange} onAccept={onAccept} a={a} ctx={ctx} actionId={draft.actionId} time={time} />
            </div>
            <div className={styles.stepFooter}>
              <span className={styles.hint}>{satisfied ? 'Enter to continue' : 'Pick a value'}</span>
              <span className={styles.spacer} />
              <Button size="sm" variant="ghost" onClick={onBack} testId="step-back">{draft.index === 0 ? 'Cancel' : 'Back'}</Button>
              <span data-testid="step-cancel" hidden onClick={onCancel} />
              <Button size="sm" variant="accent" onClick={onAccept} disabled={!satisfied} testId="step-next">Next <Kbd>Enter</Kbd></Button>
            </div>
          </>
        )}
      </Stepper>
    </div>
  )
}

function ResultBlock({ last, radio, time, undo, onDismiss }: { last: LastTx; radio: RadioLine[]; time: number; undo: RadioLine | null; onDismiss: () => void }) {
  const r = last.result
  const silent = !r.ok && isSilent(r.code)
  const status: 'ok' | 'unable' | 'partial' | 'error' | 'queried' = r.ok ? (r.code === 'partial' ? 'partial' : 'ok') : silent ? 'error' : r.code.startsWith('unable') ? 'unable' : r.code === 'queried' ? 'queried' : 'error'
  const rb = React.useMemo(() => {
    if (last.atcKey == null) return null
    const after = radio.filter((l) => l.who === 'PILOT' && l.callsign === last.callsign && l.key > last.atcKey!)
    return after.find((l) => l.status != null) ?? after[0] ?? null
  }, [radio, last])
  const typed = useTypewriter(rb?.text ?? '')
  const waiting = !silent && !rb
  const label = status === 'ok' ? (r.code === 'ok_conditional' ? 'Transmitted · conditional' : r.code === 'ok_queued' ? 'Transmitted' : 'Transmitted') : status === 'partial' ? 'Partial — pilot unable part' : status === 'unable' ? 'Pilot unable' : status === 'queried' ? 'Pilot queried' : 'Not transmitted'
  const tone = status === 'ok' ? 'green' : status === 'partial' ? 'orange' : status === 'queried' ? 'orange' : 'red'
  return (
    <div className={styles.result} role="status" data-testid="panel-result" data-status={status} data-code={r.code} data-action={last.actionId}>
      <div className={styles.resultHead}>
        <Pill size="xs" tone={tone} dot={tone} testId="panel-result-status">{label}</Pill>
        {r.warnings?.length ? <Pill size="xs" tone="dim" icon={<IconTriangleAlert />}>{r.warnings.length} warning{r.warnings.length > 1 ? 's' : ''}</Pill> : null}
        <span className={styles.spacer} />
        {undo ? <span className={styles.undoRing} data-testid="panel-result-undo-window">undo {Math.max(0, (undo.undoUntil ?? time) - time).toFixed(1)} s</span> : null}
        <IconButton size={32} variant="ghost" label="Dismiss" icon={<IconX />} onClick={onDismiss} testId="panel-result-dismiss" />
      </div>
      <div className={styles.resultLine} data-dim={silent ? 'true' : undefined}>
        <span className={styles.resultWho}>{silent ? 'SYS' : 'ATC'}</span>
        <span className={styles.resultText} data-error={silent ? 'true' : undefined} data-testid="panel-result-tx">{silent ? (r.reason ?? r.code) : r.transmission}</span>
      </div>
      {!silent ? (
        <div className={styles.resultLine} data-dim={waiting ? 'true' : undefined}>
          <span className={styles.resultWho}>PILOT</span>
          <span className={styles.resultText} data-testid="panel-result-rb" data-status={rb?.status ?? 'pending'}>
            {rb ? typed : 'awaiting readback'}{(waiting || (rb && typed.length < rb.text.length)) ? <span className={styles.cursor} aria-hidden="true" /> : null}
          </span>
        </div>
      ) : null}
      {r.refused?.length ? <div className={styles.note}><IconCircleAlert size={14} /> Refused: {r.refused.join(', ')}</div> : null}
    </div>
  )
}

function UndoChip({ line, time }: { line: RadioLine; time: number }) {
  const remaining = line.undoUntil != null ? Math.max(0, line.undoUntil - time) : 0
  return (
    <Pill size="s" tone="orange" icon={<Icon name="undo-2" />} interactive onClick={() => sim.undo()} tabular testId="btn-undo" data-remaining={remaining.toFixed(1)} aria-label={`Undo, ${remaining.toFixed(1)} seconds left`}>
      <span className={styles.undoRing}>Undo · {remaining.toFixed(1)} s</span>
    </Pill>
  )
}

/** Pinned-empty state (UX §G10): the stage -> action matrix for the current position as a cheat sheet. */
function EmptyPanel({ position, onUnpin, className }: { position: PlayerPosition; onUnpin: () => void; className?: string }) {
  return (
    <GlassPanel variant="glass-strong" padding="card" radius="card-lg" className={cx(styles.panel, className)} as="aside" aria-label="Command panel" title="No aircraft selected" subtitle={`${POSITION_LABEL[position]} · click an aircraft or a strip`} headerRight={<IconButton size={32} variant="ghost" label="Unpin" icon={<IconX />} onClick={onUnpin} testId="panel-pin" />} testId="detail-panel">
      <div className={styles.empty} data-testid="detail-empty">
        <ScrollArea className={styles.scroll} fade>
          <div className={styles.matrix} data-testid="panel-empty-matrix">
            {ALL_STAGES.filter((s) => s !== 'departed').map((s) => (
              <div key={s} className={styles.matrixRow} data-testid={`panel-empty-matrix-${s}`}>
                <span className={styles.matrixStage}>{stageLabel(s).short}</span>
                <span className={styles.matrixActions}>
                  {enabledActionsForStage(s).filter((id) => !id.startsWith('emerg-')).slice(0, 8).map((id) => <span key={id} className={styles.matrixAction}>{ACTION_DEFS[id].label}{ACTION_DEFS[id].key ? ` ${ACTION_DEFS[id].key}` : ''}</span>)}
                </span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </GlassPanel>
  )
}

'use client'
/*
  One flight strip (UX 04 §3.1 anatomy, §3.2 colour coding, §10 strip-* ids; design 01 A12 strip states):
  4px kind/state bar, callsign · type/wake · stand ▸ rwy · fix, stage chip, timer since the last pilot call,
  REQ chip with age, pending-command dot, alt/spd/hdg for airborne aircraft, emergency band, conflict tint,
  clearance boxes (P T W O F / I L E F) that open the matching action, resume-draft chip, archive.
*/
import * as React from 'react'
import styles from './StripBay.module.css'
import { Pill, Icon, IconX, IconPlaneLanding, IconPlaneTakeoff, cx } from '@/design'
import type { ActionId } from '@/lib/sim/commandTree'
import type { AircraftState, Alert, PlayerPosition, Stage } from '@/lib/sim/types'
import type { BayId } from '@/lib/sim/stage'
import { stageLabel, isAirStage } from '@/lib/sim/stage'
import { describe } from '@/lib/sim/commandAst'
import { sim } from '../CommandPanel/store'
import { requestOpenAction } from '../CommandPanel/bus'
import { wakeLetter, stageTone, fmtHdgMag, fmtMMSS, openRequest, requestShort, altParts, ownerTab } from '../CommandPanel/format'

const TIMER_WARN_S = 45
const TIMER_LATE_S = 90
const EMERGENCY_TYPE: Record<string, string> = {
  engine_fire: 'engine fire', engine_failure: 'engine failure', medical: 'medical', fuel: 'fuel', depressurization: 'depress', bird_strike: 'bird strike',
  gear: 'gear', smoke: 'smoke', hydraulic: 'hydraulic', hijack: 'hijack', radio_failure: 'NORDO', general: 'emergency', brake_fire: 'brake fire',
}

interface BoxDef { key: string; label: string; action: ActionId; done: (a: AircraftState, stage: Stage) => boolean }
const DEP_BOXES: BoxDef[] = [
  { key: 'P', label: 'Push / start', action: 'action-pushback', done: (a) => a.pushback.stage !== 'none' || a.startup.startedAt != null },
  { key: 'T', label: 'Taxi', action: 'action-taxi-runway', done: (a, s) => !!a.plan.taxiRoute?.length || ['taxi_out', 'hold_short_dep', 'hold_short_cross', 'lineup', 'takeoff_roll', 'takeoff_air', 'dep_climb', 'dep_level'].includes(s) },
  { key: 'W', label: 'Line up', action: 'action-lineup', done: (a, s) => ['lineup', 'takeoff_roll', 'takeoff_air', 'dep_climb', 'dep_level'].includes(s) },
  { key: 'O', label: 'Take off', action: 'action-takeoff', done: (a, s) => a.takeoffCleared || ['takeoff_roll', 'takeoff_air', 'dep_climb', 'dep_level'].includes(s) },
  { key: 'F', label: 'Handoff', action: 'action-handoff', done: (a) => a.handedTo != null || a.onFrequency === 'departure' || a.onFrequency === 'external' },
]
const ARR_BOXES: BoxDef[] = [
  { key: 'I', label: 'Approach', action: 'action-ils', done: (a) => a.ilsArmed || a.ilsCaptured },
  { key: 'L', label: 'Land', action: 'action-land', done: (a) => a.landingCleared },
  { key: 'E', label: 'Exit', action: 'action-exit', done: (a, s) => a.exitTaxiway != null || ['taxi_in', 'arrived'].includes(s) },
  { key: 'F', label: 'Handoff', action: 'action-handoff', done: (a) => a.handedTo != null || a.onFrequency === 'ground' },
]

export interface StripCardProps {
  a: AircraftState
  stage: Stage
  bay: BayId
  position: PlayerPosition
  time: number
  selected: boolean
  hovered: boolean
  alerts: Alert[]
  hasDraft: boolean
  archived: boolean
  dragging: boolean
  drop: 'before' | 'after' | null
  shake: boolean
  onArchive: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

export const StripCard = React.memo(function StripCard(p: StripCardProps) {
  const { a, stage, bay, position, time, selected, hovered, alerts, hasDraft, archived, dragging, drop, shake, onArchive, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd } = p
  const dep = a.plan.kind === 'departure'
  const air = isAirStage(stage)
  const req = openRequest(a)
  const reqOpen = req && time >= a.standbyUntil ? req : null
  const emergency = a.emergency && a.emergency.status !== 'resolved' ? a.emergency : null
  const owner = ownerTab(a.onFrequency)
  const ghost = owner != null && owner !== position
  const conflict = !!a.conflict || alerts.some((al) => al.severity !== 'info')
  const acked = alerts.length > 0 && alerts.every((al) => al.ack)
  const finished = stage === 'arrived' || stage === 'departed'
  const label = stageLabel(stage)
  const since = a.lastTransmissionAt >= 0 ? time - a.lastTransmissionAt : null
  const timerTone = since == null ? 'none' : since >= TIMER_LATE_S ? 'late' : since >= TIMER_WARN_S ? 'warn' : 'none'
  const tone = emergency || conflict ? 'red' : ghost ? 'ghost' : dep ? 'dep' : 'arr'
  const magVar = sim.engine?.magVar ?? 0
  const ta = sim.engine?.transitionAltFt ?? 6000
  const alt = altParts(a.altitude, ta)
  const boxes = dep ? DEP_BOXES : ARR_BOXES
  const nextHold = a.holdShortRunway ? `hold ${a.holdShortRunway}` : a.holdShortTaxiway ? `hold ${a.holdShortTaxiway}` : null
  const route = dep
    ? [a.plan.taxiRoute?.length ? `via ${a.plan.taxiRoute.slice(0, 4).join(' ')}` : null, nextHold].filter(Boolean).join(' · ')
    : [a.ilsCaptured ? `ILS ${a.assignedRunway ?? a.plan.runway ?? ''} est` : a.ilsArmed ? `ILS ${a.assignedRunway ?? ''} armed` : a.navMode === 'direct' && a.directTargetName ? `DCT ${a.directTargetName}` : a.navMode === 'hold' && a.holdFixName ? `HLD ${a.holdFixName}` : null, a.plan.gateRef || a.reservedStand ? `stand ${a.plan.gateRef ?? a.reservedStand}` : null, nextHold].filter(Boolean).join(' · ')
  const pending = a.pendingCmds.length
  const pendingText = pending ? a.pendingCmds.map((c) => (c.ast ? describe(c.ast) : c.kind)).join(', ') : ''
  const distNM = !dep && air && a.plan.runway ? sim.engine?.distToThresholdNM(a, a.plan.runway) ?? null : null

  const select = () => sim.select(a.id)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter') { e.preventDefault(); select(); requestOpenAction({ aircraftId: a.id, actionId: null }) }
    else if (e.key === 'Delete') { e.preventDefault(); if (finished) onArchive() }
  }
  const openBox = (e: React.MouseEvent, action: ActionId) => { e.stopPropagation(); requestOpenAction({ aircraftId: a.id, actionId: action }) }

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className={styles.strip}
      draggable
      onClick={select}
      onDoubleClick={(e) => { e.preventDefault(); sim.centerOn(a.id) }}
      onMouseEnter={() => sim.hover(a.id)}
      onMouseLeave={() => sim.hover(null)}
      onKeyDown={onKey}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-testid={`strip-${a.callsign}`}
      data-id={a.id}
      data-stage={stage}
      data-phase={a.phase}
      data-kind={a.plan.kind}
      data-bay={bay}
      data-selected={selected ? 'true' : 'false'}
      data-hovered={hovered ? 'true' : undefined}
      data-conflict={conflict ? 'true' : 'false'}
      data-acked={acked ? 'true' : undefined}
      data-emergency={emergency ? 'true' : 'false'}
      data-req={reqOpen ? reqOpen.kind : ''}
      data-alert={alerts[0]?.kind ?? ''}
      data-onfreq={a.onFrequency}
      data-ghost={ghost ? 'true' : undefined}
      data-archived={archived ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      data-drop={drop ?? undefined}
      data-shake={shake ? 'true' : undefined}
      aria-label={`${a.callsign} ${a.perf.icaoCode} ${label.long}`}
    >
      <span className={styles.bar} data-tone={tone} data-req={reqOpen ? 'true' : undefined} aria-hidden="true" />
      {emergency ? (
        <div className={styles.emergBand} data-testid={`strip-${a.callsign}-emerg`} data-level={emergency.level}>
          <Icon name="siren" size={12} />
          <span>{emergency.level} · {EMERGENCY_TYPE[emergency.type] ?? emergency.type}</span>
          <span>{emergency.fuelMin != null ? `fuel ${Math.max(0, Math.round(emergency.fuelMin))} min` : a.fuelMin != null ? `fuel ${Math.round(a.fuelMin)} min` : `POB ${emergency.soulsOnBoard || '—'}`}</span>
        </div>
      ) : null}
      <div className={styles.row}>
        <span className={styles.handle} data-testid="strip-drag-handle" aria-hidden="true"><Icon name="menu" size={12} /></span>
        <span className={styles.cs} data-testid="strip-cs">{a.callsign}</span>
        <span className={styles.type}>{a.perf.icaoCode}/{wakeLetter(a.perf.weightClass)}</span>
        <span className={styles.route} data-ghost={stage === 'departed' ? 'true' : undefined}>
          <span className={styles.arrow} data-testid={`strip-${a.callsign}-arrow`} aria-label={dep ? 'departure' : 'arrival'}>{dep ? <IconPlaneTakeoff size={12} /> : <IconPlaneLanding size={12} />}</span>
          <span data-testid="strip-kind" hidden>{dep ? 'D' : 'A'}</span>
          {dep ? (a.plan.gateRef ? `${a.plan.gateRef} ` : '') : (a.plan.fix ? `${a.plan.fix} ` : '')}
          <Icon name="arrow-right" size={11} />
          <button type="button" className={styles.rwyBtn} onClick={(e) => openBox(e, dep ? 'action-taxi-runway' : 'action-expect-runway')} title="Runway" data-testid={`strip-${a.callsign}-runway`}>{a.plan.runway ?? a.assignedRunway ?? '—'}</button>
        </span>
        <span className={styles.right}>
          {ghost && owner ? <span className={styles.tag} data-testid={`strip-${a.callsign}-ghost`}>{owner === 'ground' ? 'GND' : owner === 'tower' ? 'TWR' : 'APP'}</span> : null}
          <Pill size="xs" tone={stageTone(stage)} uppercase testId="strip-phase" data-phase={a.phase} data-stage={stage}>{label.short}</Pill>
        </span>
      </div>
      <div className={cx(styles.row, styles.row2)}>
        {air ? (
          <span className={styles.metrics}>
            <span data-testid="strip-alt" data-value={Math.round(a.altitude)}>{alt.hi}{alt.lo}{alt.unit ? <small> {alt.unit}</small> : null}</span>
            <span data-testid="strip-spd" data-value={Math.round(a.speed)}>{Math.round(a.speed)}<small> kt</small></span>
            <span data-testid="strip-hdg" data-value={Math.round(a.heading)}>{fmtHdgMag(a.heading, magVar)}<small>°</small></span>
            {distNM != null && distNM < 30 ? <span data-testid={`strip-${a.callsign}-dist`}>{distNM.toFixed(1)}<small> NM</small></span> : null}
          </span>
        ) : (
          <span data-testid="strip-alt" data-value={0} hidden>GND</span>
        )}
        {route ? <span className={styles.meta} title={route}>{route}</span> : null}
        <span className={styles.right}>
          {since != null && !finished ? <span className={styles.timer} data-tone={timerTone} data-testid={`strip-${a.callsign}-timer`} title="Since last pilot call">{fmtMMSS(since)}</span> : null}
          {a.sequenceNo != null ? <span className={styles.tag} data-testid={`strip-${a.callsign}-seq`}>#{a.sequenceNo}</span> : null}
          {a.heldByEmergency ? <span className={cx(styles.tag, styles.tagRed)} data-testid={`strip-${a.callsign}-held`}>HELD</span> : null}
          {alerts.length ? (
            <button type="button" className={cx(styles.tag, styles.tagRed)} onClick={(e) => { e.stopPropagation(); select() }} data-testid={`strip-${a.callsign}-alert`} title={alerts[0].title}>{alerts[0].kind === 'stca' ? 'STCA' : alerts[0].kind === 'msaw' ? 'MSAW' : alerts[0].kind === 'wake' ? 'WAKE' : alerts[0].kind === 'emergency' ? 'EMERG' : 'RWY'}</button>
          ) : null}
          {reqOpen ? (
            <button type="button" className={cx(styles.tag, styles.tagOrange)} onClick={(e) => { e.stopPropagation(); requestOpenAction({ aircraftId: a.id, actionId: reqOpen.suggestedAction ?? null, confirm: true }) }} data-testid={`strip-${a.callsign}-req`} data-kind={reqOpen.kind} title={reqOpen.text}>REQ · {requestShort(reqOpen)} · {fmtMMSS(Math.max(0, time - reqOpen.at))}</button>
          ) : null}
          {pending ? <span className={styles.pendingDot} data-testid={`strip-${a.callsign}-pending`} title={pendingText}>{pending}</span> : null}
          {hasDraft ? <Pill size="xs" tone="orange" interactive onClick={(e) => { e.stopPropagation(); requestOpenAction({ aircraftId: a.id, actionId: null }) }} testId={`strip-${a.callsign}-draft`}>Resume draft</Pill> : null}
          {!finished ? (
            <span className={styles.boxes} aria-label="Clearances">
              {boxes.map((b) => (
                <button key={b.key} type="button" className={styles.box} data-done={b.done(a, stage) ? 'true' : 'false'} onClick={(e) => openBox(e, b.action)} title={b.label} aria-label={`${b.label}${b.done(a, stage) ? ' (done)' : ''}`} aria-pressed={b.done(a, stage)} data-testid={`strip-${a.callsign}-box-${b.key}`}>{b.key}</button>
              ))}
            </span>
          ) : (
            <button type="button" className={styles.archive} onClick={(e) => { e.stopPropagation(); onArchive() }} aria-label="Archive strip" data-testid={`strip-${a.callsign}-archive`}><IconX size={12} /></button>
          )}
        </span>
      </div>
    </div>
  )
})

'use client'
/* Alert stack + alerts drawer (UX 04 §5, §10 "Alerts"; design 01 §4.12, A13). */
import * as React from 'react'
import styles from './AlertStack.module.css'
import { AlertItem, AlertGroup, Button, Pill, GlassPanel, ListRow, ScrollArea, EmptyState, IconButton, Icon, IconX, IconSiren, IconSeparation, IconPlaneLanding, IconWind, IconInfo, cx } from '@/design'
import type { Alert, AlertKind, AlertSeverity } from '@/lib/sim/types'
import { sim, useSim, formatMmSs } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'

const MAX_STACK = 3
const AUTO_DISMISS_MS: Record<AlertSeverity, number> = { info: 6000, warning: 12000, critical: 0 }
const MUTE_MS = 60_000

function toItemSeverity(s: AlertSeverity): 'critical' | 'warning' | 'info' {
  return s === 'critical' ? 'critical' : s === 'warning' ? 'warning' : 'info'
}
const KIND_LABEL: Record<AlertKind, string> = {
  stca: 'STCA', msaw: 'MSAW', runway_incursion: 'RWY', occupied_runway_clearance: 'RWY', ground_conflict: 'GND', wake: 'WAKE',
  go_around: 'GA', emergency: 'EMERG', diversion_risk: 'DIV', delay: 'DELAY', request: 'REQ', handoff: 'H/O', runway_status: 'RWY', deadlock: 'GND',
}
type Family = 'separation' | 'runway' | 'emergency' | 'wake' | 'other'
const FAMILY: Record<AlertKind, Family> = {
  stca: 'separation', msaw: 'separation', diversion_risk: 'separation',
  runway_incursion: 'runway', occupied_runway_clearance: 'runway', ground_conflict: 'runway', runway_status: 'runway', deadlock: 'runway', go_around: 'runway',
  emergency: 'emergency', wake: 'wake', delay: 'other', request: 'other', handoff: 'other',
}
const FAMILY_META: Record<Family, { title: string; icon: React.ReactNode; order: number }> = {
  emergency: { title: 'Emergency', icon: <IconSiren size={18} />, order: 0 },
  runway: { title: 'Runway', icon: <IconPlaneLanding size={18} />, order: 1 },
  separation: { title: 'Separation', icon: <IconSeparation size={18} />, order: 2 },
  wake: { title: 'Wake turbulence', icon: <IconWind size={18} />, order: 3 },
  other: { title: 'Advisories', icon: <IconInfo size={18} />, order: 4 },
}
const SEV_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }

function selectSubject(a: Alert, index = 0): number | null {
  const id = a.subjectIds[index] ?? a.subjectIds[0]
  if (id == null) return null
  sim.select(id)
  return id
}

function locate(a: Alert) {
  const id = selectSubject(a)
  if (id != null) sim.centerOn(id)
}

/** One stacked alert card: ACK / SELECT / locate / MUTE (critical) — UX §5.2 step 1. */
function StackItem({ a, now, muted, onMute }: { a: Alert; now: number; muted: boolean; onMute: () => void }) {
  const [pair, setPair] = React.useState(0)
  const cs = a.subjects[0] ?? ''
  const marker = a.kind === 'stca' ? 'stca-alert' : a.kind === 'emergency' ? `emergency-banner-${cs}` : undefined
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter') { e.preventDefault(); sim.ackAlert(a.id) }
    else if (e.key === 'Tab' && a.subjectIds.length > 1 && !e.shiftKey) { e.preventDefault(); const n = (pair + 1) % a.subjectIds.length; setPair(n); selectSubject(a, n) }
  }
  return (
    <div className={styles.item} tabIndex={0} data-testid={`toast-${a.id}`} data-severity={a.severity} data-kind={a.kind} onKeyDown={onKey} aria-label={`${a.title}. ${a.detail}`}>
      <div data-testid={marker} className={styles.card}>
        <AlertItem
          severity={toItemSeverity(a.severity)}
          index={KIND_LABEL[a.kind]}
          title={a.title}
          time={formatMmSs(Math.max(0, now - a.createdAt))}
          expanded
          pulse={a.severity === 'critical' && !a.ack}
          affected={a.subjects.map((s) => ({ name: s, detail: a.geometry.runway ? `RWY ${a.geometry.runway}` : undefined, testId: `toast-${a.id}-pair-${s}` }))}
          affectedLabel={a.subjects.length ? 'Involved:' : undefined}
          description={a.detail || undefined}
          testId={`alert-${a.id}`}
          actions={
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" onClick={() => sim.ackAlert(a.id)} testId={`toast-${a.id}-ack`}>Ack</Button>
              {a.subjectIds.length ? <Button size="sm" variant="ghost" onClick={() => { const n = a.subjectIds.length > 1 ? (pair + 1) % a.subjectIds.length : 0; setPair(n); selectSubject(a, n) }} testId={`toast-${a.id}-select`}>Select</Button> : null}
              {a.subjectIds.length ? <IconButton size={32} variant="ghost" label="Centre map" icon={<Icon name="locate-fixed" size={16} />} onClick={() => locate(a)} testId={`toast-${a.id}-locate`} /> : null}
              {a.severity === 'critical' ? <Button size="sm" variant="ghost" onClick={onMute} disabled={muted} testId={`toast-${a.id}-mute`}>{muted ? 'Muted' : 'Mute 1 min'}</Button> : null}
            </div>
          }
        />
      </div>
    </div>
  )
}

/** Top-centre stack: unacknowledged alerts (max 3, "+N" overflow), acknowledged ones collapse into pills; resolved pills turn green for 3 s. */
export function AlertStack() {
  const shell = useShell()
  const alerts = useSim((s) => s.alerts())
  const now = useSim((s) => Math.floor(s.engine?.time ?? 0))
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set())
  const [mutedUntil, setMutedUntil] = React.useState(0)
  const [resolved, setResolved] = React.useState<Array<{ id: string; title: string; delta: number; k: number }>>([])
  const seen = React.useRef<Map<string, Alert>>(new Map())
  const timers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Auto-dismiss timers (real time) for info / warning; resolved-pill bookkeeping.
  React.useEffect(() => {
    const live = new Set(alerts.map((a) => a.id))
    for (const a of alerts) {
      if (!seen.current.has(a.id)) {
        seen.current.set(a.id, a)
        const ms = AUTO_DISMISS_MS[a.severity]
        if (ms > 0) timers.current.set(a.id, setTimeout(() => setHidden((h) => new Set(h).add(a.id)), ms))
      } else seen.current.set(a.id, a)
    }
    for (const [id, prev] of Array.from(seen.current.entries())) {
      if (live.has(id)) continue
      seen.current.delete(id)
      const t = timers.current.get(id)
      if (t) { clearTimeout(t); timers.current.delete(id) }
      const rec = sim.engine?.alerts.byId(id)
      const delta = rec?.scoreDelta ?? 0
      const k = Date.now()
      setResolved((r) => [...r, { id, title: prev.title, delta, k }])
      setTimeout(() => setResolved((r) => r.filter((x) => x.k !== k)), 3000)
    }
  }, [alerts])
  React.useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)) }, [])

  const mute = React.useCallback(() => {
    const until = Date.now() + MUTE_MS
    setMutedUntil(until)
    const wasOn = sim.settings.sound
    if (wasOn) sim.updateSettings({ sound: false })
    setTimeout(() => { setMutedUntil(0); if (wasOn) sim.updateSettings({ sound: true }) }, MUTE_MS)
  }, [])
  const muted = mutedUntil > Date.now()

  const unacked = alerts.filter((a) => !a.ack && !hidden.has(a.id)).sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || x.createdAt - y.createdAt)
  const acked = alerts.filter((a) => a.ack)
  const visible = unacked.slice(0, MAX_STACK)
  const overflow = unacked.length - visible.length

  if (!visible.length && !acked.length && !resolved.length) return null
  return (
    <div className={styles.stack} role="region" aria-label="Alerts" aria-live="assertive" data-testid="alert-stack">
      {visible.map((a) => <StackItem key={a.id} a={a} now={now} muted={muted} onMute={mute} />)}
      {overflow > 0 ? <Pill size="s" tone="solid" interactive className={styles.overflow} onClick={() => shell.show('alerts')} testId="toast-overflow">+{overflow} more</Pill> : null}
      {acked.length || resolved.length ? (
        <div className={styles.pills}>
          {acked.map((a) => (
            <Pill key={a.id} size="s" tone={a.severity === 'critical' ? 'red' : 'solid'} dot={a.severity === 'info' ? 'grey' : 'red'} interactive tabular onClick={() => selectSubject(a)} testId={`alert-pill-${a.id}`} title={a.detail}>
              {KIND_LABEL[a.kind]} {a.subjects.join('/')}
            </Pill>
          ))}
          {resolved.map((r) => (
            <Pill key={r.k} size="s" tone="green" dot="green" tabular testId={`alert-resolved-${r.id}`}>
              Resolved{r.delta ? ` · ${r.delta > 0 ? '+' : '−'}${Math.abs(r.delta)}` : ''}
            </Pill>
          ))}
        </div>
      ) : null}
    </div>
  )
}

type Filter = 'critical' | 'warning' | 'info'

/** Alerts drawer (bell): every alert of the session with state, duration and score impact; filters; clear resolved. */
export function AlertsDrawer() {
  const shell = useShell()
  const version = useSim((s) => s.version)
  const now = useSim((s) => Math.floor(s.engine?.time ?? 0))
  void version
  const all: Alert[] = sim.engine?.alerts.list() ?? []
  const [filters, setFilters] = React.useState<Set<Filter>>(() => new Set<Filter>(['critical', 'warning', 'info']))
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (ref.current?.contains(t) || t.closest?.('[data-dropdown-trigger="alerts"]')) return
      shell.hide('alerts')
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [shell])
  const toggleFilter = (f: Filter) => setFilters((s) => { const n = new Set(s); if (n.has(f)) n.delete(f); else n.add(f); return n })
  const rows = all.filter((a) => filters.has(a.severity)).sort((x, y) => Number(x.resolvedAt != null) - Number(y.resolvedAt != null) || SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || y.createdAt - x.createdAt)
  const groups = new Map<Family, Alert[]>()
  for (const a of rows) { const f = FAMILY[a.kind]; if (!groups.has(f)) groups.set(f, []); groups.get(f)!.push(a) }
  const ordered = Array.from(groups.entries()).sort((x, y) => FAMILY_META[x[0]].order - FAMILY_META[y[0]].order)
  const resolvedCount = all.filter((a) => a.resolvedAt != null).length
  return (
    <GlassPanel
      ref={ref}
      variant="glass-strong"
      title="Alerts"
      titleSize="l"
      parenthetical={all.length ? `(${all.length})` : undefined}
      padding="card-lg"
      radius="card-lg"
      className={styles.drawer}
      role="dialog"
      aria-label="Alerts drawer"
      headerRight={<IconButton size={32} variant="ghost" label="Close" icon={<IconX size={16} />} onClick={() => shell.hide('alerts')} testId="alerts-drawer-close" />}
      testId="alerts-drawer"
    >
      <div className={styles.drawerBody}>
        <div className={styles.filters}>
          {(['critical', 'warning', 'info'] as Filter[]).map((f) => (
            <Pill key={f} size="s" tone={filters.has(f) ? 'solid' : 'outline'} interactive selected={filters.has(f)} aria-pressed={filters.has(f)} dot={f === 'critical' ? 'red' : f === 'warning' ? 'orange' : 'grey'} onClick={() => toggleFilter(f)} testId={`alerts-filter-${f}`}>
              {f[0].toUpperCase() + f.slice(1)}
            </Pill>
          ))}
          <span className={styles.filterSpacer} />
          <Button size="sm" variant="ghost" disabled={!resolvedCount} onClick={() => { sim.engine?.alerts.clearResolved(); }} testId="alerts-clear-resolved">Clear resolved</Button>
        </div>
        <ScrollArea className={styles.scroll} maxHeight="calc(100vh - 260px)">
          {ordered.length === 0 ? (
            <EmptyState compact className={styles.empty} icon={<Icon name="circle-check" size={24} />} title="No alerts" hint="Separation, runway and emergency alerts appear here" testId="alerts-empty" />
          ) : ordered.map(([family, items]) => (
            <AlertGroup key={family} icon={FAMILY_META[family].icon} title={FAMILY_META[family].title} count={items.length} countTone={items.some((a) => a.severity === 'critical' && a.resolvedAt == null) ? 'red' : 'text-2'}>
              <div className={styles.rows}>
                {items.map((a) => {
                  const state = a.resolvedAt != null ? 'resolved' : a.ack ? 'acked' : 'active'
                  const dur = (a.resolvedAt ?? now) - a.createdAt
                  return (
                    <ListRow
                      key={a.id}
                      flush
                      icon={<Icon name={a.severity === 'critical' ? 'triangle-alert' : a.severity === 'warning' ? 'circle-alert' : 'info'} size={18} />}
                      iconTone={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'orange' : 'neutral'}
                      title={a.title}
                      subtitle={`${a.subjects.join(' · ')}${a.detail ? ` — ${a.detail}` : ''}`}
                      meta={<span className={styles.rowMeta}>
                        <span className={styles.state} data-state={state} data-testid={`alerts-row-${a.id}-state`}>{state}</span>
                        <span className={cx('tabular')}>{formatMmSs(Math.max(0, dur))}</span>
                        <span className={styles.scoreDelta} data-neg={a.scoreDelta < 0} data-pos={a.scoreDelta > 0} data-testid={`alerts-row-${a.id}-score`}>{a.scoreDelta ? (a.scoreDelta > 0 ? `+${a.scoreDelta}` : `−${Math.abs(a.scoreDelta)}`) : '—'}</span>
                      </span>}
                      onClick={() => { if (a.subjectIds.length) locate(a) }}
                      testId={`alerts-row-${a.id}`}
                    />
                  )
                })}
              </div>
            </AlertGroup>
          ))}
        </ScrollArea>
      </div>
    </GlassPanel>
  )
}

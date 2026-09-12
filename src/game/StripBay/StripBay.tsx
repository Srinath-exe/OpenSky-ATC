'use client'
/*
  Strip bay (UX 04 §2.1 "Strip bay", §2.2 bays per position, §3 flight strips, §G7 bay mapping, §10 "Strip bay" ids;
  design 01 A12 strip states). Left floating glass bay: bays from sim.stripsFor(position) with headers + counts,
  strip cards, filters ALL / DEP / ARR / REQ / ALERT + search (persisted per position), collapse to a 44px rail with
  per-bay counts (REQ / ALERT dots), drag reorder within a bay (SEQUENCE reorder writes the landing sequence number),
  vehicle strips in the VEHICLES bay, Tab cycling via a forwarded ref (focusNext / focusPrev) and the shell's cycler.
*/
import * as React from 'react'
import styles from './StripBay.module.css'
import { GlassPanel, IconButton, Pill, Input, ScrollArea, Icon, IconSearch, IconChevronUp, IconChevronLeft, IconChevronRight, cx } from '@/design'
import type { AircraftState, Alert, PlayerPosition, Vehicle } from '@/lib/sim/types'
import type { BayId } from '@/lib/sim/stage'
import { sim, useSim } from '../CommandPanel/store'
import type { StripBay as BayData } from '@/components/atc/simStore'
import { useParkedIds } from '../CommandPanel/parked'
import { fmtMMSS, openRequest } from '../CommandPanel/format'
import { vehicleGlyph, VEHICLE_STATE_LABEL } from '../CommandPanel/pickers'
import { useShellOptional } from '../shellContext'
import { usePersistedState } from '../hooks/usePersistedState'
import { LS, readJson, writeJson } from '../persist'
import { registerStripCycler } from '../GameShell/stripCycle'
import { StripCard } from './StripCard'

export type StripFilter = 'all' | 'dep' | 'arr' | 'req' | 'alert'
export type BaySort = 'auto' | 'callsign' | 'time' | 'runway'
const FILTERS: Array<{ id: StripFilter; label: string }> = [{ id: 'all', label: 'ALL' }, { id: 'dep', label: 'DEP' }, { id: 'arr', label: 'ARR' }, { id: 'req', label: 'REQ' }, { id: 'alert', label: 'ALERT' }]
const SORTS: Array<{ id: BaySort; label: string }> = [{ id: 'auto', label: 'Auto' }, { id: 'callsign', label: 'Callsign' }, { id: 'time', label: 'Time' }, { id: 'runway', label: 'Runway' }]
const FLASH_MS = 600

export interface StripBayHandle {
  /** Select the next strip in cycling order (alerts → requests → bay order) and focus it. */
  focusNext: () => boolean
  focusPrev: () => boolean
  /** Focus (and select) one strip by aircraft id; returns false when it is not in the bay. */
  focusStrip: (id: number) => boolean
  collapsed: boolean
  setCollapsed: (b: boolean) => void
}

export interface StripBayProps {
  className?: string
  /** Controlled collapse (defaults to the shell's bayCollapsed, else local persisted state). */
  collapsed?: boolean
  onCollapsedChange?: (b: boolean) => void
}

interface FilterPrefs { filter: StripFilter }

function readCollapsed(): boolean { return !!readJson<{ bay?: boolean }>(LS.panels, {}).bay }

export const StripBay = React.forwardRef<StripBayHandle, StripBayProps>(function StripBay({ className, collapsed: collapsedProp, onCollapsedChange }, ref) {
  const shell = useShellOptional()
  const position = useSim((s) => s.position)
  const bays = useSim((s) => s.stripsFor(s.position))
  const vehicles = useSim((s) => s.vehicles())
  const selectedId = useSim((s) => s.selectedId)
  const hoveredId = useSim((s) => s.hoveredId)
  const alerts = useSim((s) => s.alerts())
  const time = useSim((s) => Math.floor(s.time()))
  const counts = useSim((s) => s.counts())
  const nextSpawnAt = useSim((s) => s.nextSpawnAt)
  const autoSpawn = useSim((s) => s.autoSpawn)
  const parkedIds = useParkedIds()

  const [localCollapsed, setLocalCollapsed] = React.useState(false)
  React.useEffect(() => { if (!shell && collapsedProp == null) setLocalCollapsed(readCollapsed()) }, [shell, collapsedProp])
  const collapsed = collapsedProp ?? shell?.bayCollapsed ?? localCollapsed
  const setCollapsed = React.useCallback((b: boolean) => {
    onCollapsedChange?.(b)
    if (collapsedProp != null) return
    if (shell) { if (shell.bayCollapsed !== b) shell.toggleBay(); return }
    setLocalCollapsed(b)
    writeJson(LS.panels, { ...readJson<Record<string, unknown>>(LS.panels, {}), bay: b })
  }, [shell, collapsedProp, onCollapsedChange])

  const [prefs, setPrefs] = usePersistedState<FilterPrefs>(`skycontrol_filters_${position}`, { filter: 'all' })
  const filter = prefs.filter
  const setFilter = (f: StripFilter) => setPrefs({ filter: f })
  const [search, setSearch] = React.useState('')
  const [collapsedBays, setCollapsedBays] = React.useState<Set<BayId>>(() => new Set())
  const [sortOpen, setSortOpen] = React.useState<BayId | null>(null)
  const [sorts, setSorts] = React.useState<Partial<Record<BayId, BaySort>>>({})
  const [archived, setArchived] = React.useState<Set<number>>(() => new Set())
  const [order, setOrder] = React.useState<Partial<Record<BayId, number[]>>>({})
  const [drag, setDrag] = React.useState<{ id: number; bay: BayId } | null>(null)
  const [drop, setDrop] = React.useState<{ id: number; where: 'before' | 'after' } | null>(null)
  const [overBay, setOverBay] = React.useState<BayId | null>(null)
  const [shakeId, setShakeId] = React.useState<number | null>(null)
  const [flash, setFlash] = React.useState<Set<BayId>>(() => new Set())
  const rootRef = React.useRef<HTMLDivElement>(null)
  const prevBayOf = React.useRef<Map<number, BayId>>(new Map())

  const alertsByCs = React.useMemo(() => {
    const m = new Map<string, Alert[]>()
    for (const al of alerts) for (const cs of al.subjects) { const l = m.get(cs) ?? []; l.push(al); m.set(cs, l) }
    return m
  }, [alerts])

  const matches = React.useCallback((a: AircraftState): boolean => {
    if (archived.has(a.id)) return false
    switch (filter) {
      case 'dep': if (a.plan.kind !== 'departure') return false; break
      case 'arr': if (a.plan.kind !== 'arrival') return false; break
      case 'req': if (!(openRequest(a) && time >= a.standbyUntil)) return false; break
      case 'alert': if (!(a.conflict || alertsByCs.has(a.callsign) || (a.emergency && a.emergency.status !== 'resolved'))) return false; break
      default: break
    }
    if (!search) return true
    const q = search.toUpperCase()
    return a.callsign.includes(q) || a.perf.icaoCode.includes(q) || (a.plan.gateRef ?? '').toUpperCase().includes(q) || (a.plan.runway ?? '').toUpperCase().includes(q) || (a.plan.fix ?? '').toUpperCase().includes(q) || a.airline.toUpperCase().includes(q)
  }, [filter, search, time, alertsByCs, archived])

  /** Bay items after the manual order, sort and filters. */
  const visible = React.useMemo(() => {
    const out = new Map<BayId, AircraftState[]>()
    for (const b of bays) {
      let items = b.items.filter(matches)
      const sort = sorts[b.bay] ?? 'auto'
      if (sort === 'callsign') items = [...items].sort((x, y) => x.callsign.localeCompare(y.callsign))
      else if (sort === 'time') items = [...items].sort((x, y) => x.spawnedAt - y.spawnedAt)
      else if (sort === 'runway') items = [...items].sort((x, y) => (x.plan.runway ?? '').localeCompare(y.plan.runway ?? '') || x.callsign.localeCompare(y.callsign))
      const man = order[b.bay]
      if (man && sort === 'auto') {
        const idx = (a: AircraftState) => { const i = man.indexOf(a.id); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
        const emerg = (a: AircraftState) => (a.emergency && a.emergency.status !== 'resolved' ? 0 : 1)
        items = [...items].sort((x, y) => emerg(x) - emerg(y) || idx(x) - idx(y))
      }
      out.set(b.bay, items)
    }
    return out
  }, [bays, matches, sorts, order])

  // Destination bay header flashes once when a strip arrives (UX §3.3 auto-flow).
  React.useEffect(() => {
    const now = new Map<number, BayId>()
    const changed = new Set<BayId>()
    for (const b of bays) for (const a of b.items) { now.set(a.id, b.bay); const prev = prevBayOf.current.get(a.id); if (prev && prev !== b.bay) changed.add(b.bay) }
    prevBayOf.current = now
    if (!changed.size) return
    setFlash((f) => new Set([...f, ...changed]))
    const t = setTimeout(() => setFlash((f) => { const n = new Set(f); for (const b of changed) n.delete(b); return n }), FLASH_MS)
    return () => clearTimeout(t)
  }, [bays])

  // Selected strip scrolls into view (UX §3.4).
  React.useEffect(() => {
    if (selectedId == null || !rootRef.current) return
    const el = rootRef.current.querySelector<HTMLElement>(`[data-id="${selectedId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  // Cycling order: alerts → requests → bay order (UX §3.3 keyboard).
  const cycleOrder = React.useCallback((): AircraftState[] => {
    const list: AircraftState[] = []
    for (const b of bays) for (const a of visible.get(b.bay) ?? []) list.push(a)
    const rank = (a: AircraftState) => (alertsByCs.has(a.callsign) || a.conflict ? 0 : openRequest(a) && time >= a.standbyUntil ? 1 : 2)
    return list.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a)
  }, [bays, visible, alertsByCs, time])
  const focusStrip = React.useCallback((id: number): boolean => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)
    sim.select(id)
    if (!el) return false
    el.scrollIntoView({ block: 'nearest' })
    el.focus({ preventScroll: true })
    return true
  }, [])
  const cycle = React.useCallback((dir: 1 | -1): boolean => {
    const list = cycleOrder()
    if (!list.length) return false
    const i = list.findIndex((a) => a.id === sim.selectedId)
    const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length
    focusStrip(list[next].id)
    return true
  }, [cycleOrder, focusStrip])
  React.useImperativeHandle(ref, () => ({ focusNext: () => cycle(1), focusPrev: () => cycle(-1), focusStrip, collapsed, setCollapsed }), [cycle, focusStrip, collapsed, setCollapsed])
  React.useEffect(() => registerStripCycler((dir) => cycle(dir)), [cycle])

  // ↑/↓ inside the bay move the selection within the visible list.
  const onBayKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.key === 'ArrowDown') { e.preventDefault(); cycleFlat(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cycleFlat(-1) }
  }
  const cycleFlat = (dir: 1 | -1) => {
    const list: AircraftState[] = []
    for (const b of bays) for (const a of visible.get(b.bay) ?? []) list.push(a)
    if (!list.length) return
    const i = list.findIndex((a) => a.id === sim.selectedId)
    const next = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + dir))
    focusStrip(list[next].id)
  }

  // Drag reorder within a bay; cross-bay drops snap back with a shake (UX §3.3).
  const onDragStart = (a: AircraftState, bay: BayId) => (e: React.DragEvent) => {
    setDrag({ id: a.id, bay })
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', a.callsign) } catch { /* ignore */ }
  }
  const onDragOver = (a: AircraftState, bay: BayId) => (e: React.DragEvent) => {
    if (!drag) return
    e.preventDefault()
    e.dataTransfer.dropEffect = drag.bay === bay ? 'move' : 'none'
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const where: 'before' | 'after' = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
    if (a.id !== drag.id) setDrop((d) => (d && d.id === a.id && d.where === where ? d : { id: a.id, where }))
    setOverBay(bay)
  }
  const onDrop = (target: AircraftState, bay: BayId) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!drag) return
    if (drag.bay !== bay) { setShakeId(drag.id); setTimeout(() => setShakeId(null), 300); reset(); return }
    const list = (visible.get(bay) ?? []).map((x) => x.id).filter((id) => id !== drag.id)
    const ti = list.indexOf(target.id)
    const at = ti < 0 ? list.length : drop?.where === 'after' ? ti + 1 : ti
    list.splice(at, 0, drag.id)
    setOrder((o) => ({ ...o, [bay]: list }))
    if (bay === 'SEQUENCE') {
      list.forEach((id, i) => { const ac = sim.byId(id); if (ac) ac.sequenceNo = i + 1 })
      sim.emit()
    }
    reset()
  }
  const reset = () => { setDrag(null); setDrop(null); setOverBay(null) }

  const archive = (a: AircraftState) => setArchived((s) => new Set(s).add(a.id))

  const railCounts = bays.map((b) => {
    const items = b.bay === 'VEHICLES' ? [] : b.items
    const req = items.filter((a) => openRequest(a) && time >= a.standbyUntil).length
    const alert = items.filter((a) => a.conflict || alertsByCs.has(a.callsign) || (a.emergency && a.emergency.status !== 'resolved')).length
    const n = b.bay === 'VEHICLES' ? vehicles.filter((v) => v.state !== 'standby').length : items.length
    return { bay: b.bay, title: b.title, n, req, alert }
  })
  const total = bays.reduce((n, b) => n + b.items.length, 0)
  const nextIn = autoSpawn && nextSpawnAt > time ? fmtMMSS(nextSpawnAt - time) : null

  if (collapsed) {
    return (
      <GlassPanel ref={rootRef} variant="glass" padding="none" radius="inner" className={cx(styles.bay, styles.rail, className)} as="nav" aria-label="Strip bay (collapsed)" testId="strip-bay" data-collapsed="true" data-position={position}>
        <div className={styles.railList}>
          <IconButton size={36} variant="ghost" label="Expand strip bay" icon={<IconChevronRight />} onClick={() => setCollapsed(false)} testId="bay-collapse" aria-expanded={false} />
          {railCounts.map((r) => (
            <button key={r.bay} type="button" className={styles.railBtn} onClick={() => { setCollapsed(false); setTimeout(() => rootRef.current?.querySelector<HTMLElement>(`[data-bay-section="${r.bay}"]`)?.scrollIntoView({ block: 'start' }), 50) }} title={`${r.title}: ${r.n}`} aria-label={`${r.title}, ${r.n} strips${r.req ? `, ${r.req} requests` : ''}${r.alert ? `, ${r.alert} alerts` : ''}`} data-testid={`bay-rail-count-${r.bay}`} data-count={r.n} data-req={r.req} data-alert={r.alert}>
              {r.n}
              <span className={styles.railLabel}>{r.title.split(' ')[0]}</span>
              {r.req || r.alert ? (
                <span className={styles.railDots}>
                  {r.alert ? <span className={cx(styles.dot, styles.dotAlert)} /> : null}
                  {r.req ? <span className={cx(styles.dot, styles.dotReq)} /> : null}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </GlassPanel>
    )
  }

  return (
    <GlassPanel ref={rootRef} variant="glass" padding="none" radius="card-lg" className={cx(styles.bay, className)} as="nav" aria-label="Strip bay" onKeyDown={onBayKey} testId="strip-bay" data-collapsed="false" data-position={position} data-filter={filter}>
      <div className={styles.head}>
        <span className={styles.title}>Strips</span>
        <span className={styles.titleSub} data-testid="bay-total" data-value={total}>{total}{counts.req ? ` · ${counts.req} REQ` : ''}</span>
        <span className={styles.spacer} />
        <IconButton size={32} variant="ghost" label="Collapse strip bay" icon={<IconChevronLeft />} onClick={() => setCollapsed(true)} testId="bay-collapse" aria-expanded />
      </div>
      <div className={styles.filters} role="toolbar" aria-label="Strip filters">
        {FILTERS.map((f) => (
          <Pill key={f.id} size="xs" tone={filter === f.id ? 'solid' : 'dim'} interactive selected={filter === f.id} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id} testId={`bay-filter-${f.id}`}>{f.label}</Pill>
        ))}
      </div>
      <div className={styles.search}>
        <Input size="m" surface="glass" prefixIcon={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Callsign, type, stand" aria-label="Search strips" fullWidth testId="bay-search" autoComplete="off" spellCheck={false} data-hotkeys="off" />
      </div>
      <ScrollArea className={styles.scroll} fade>
        <div className={styles.sections} role="listbox" aria-label="Flight strips" aria-activedescendant={undefined}>
          {bays.map((b) => (
            <BaySection
              key={b.bay}
              bay={b}
              items={visible.get(b.bay) ?? []}
              vehicles={b.bay === 'VEHICLES' ? vehicles.filter((v) => v.state !== 'standby') : null}
              position={position}
              time={time}
              collapsed={collapsedBays.has(b.bay)}
              onToggle={() => setCollapsedBays((s) => { const n = new Set(s); if (n.has(b.bay)) n.delete(b.bay); else n.add(b.bay); return n })}
              sort={sorts[b.bay] ?? 'auto'}
              sortOpen={sortOpen === b.bay}
              onSortToggle={() => setSortOpen((s) => (s === b.bay ? null : b.bay))}
              onSort={(k) => { setSorts((s) => ({ ...s, [b.bay]: k })); setSortOpen(null) }}
              flash={flash.has(b.bay)}
              over={overBay === b.bay && !!drag && drag.bay === b.bay}
              nextIn={nextIn}
              selectedId={selectedId}
              hoveredId={hoveredId}
              alertsByCs={alertsByCs}
              parkedIds={parkedIds}
              drag={drag}
              drop={drop}
              shakeId={shakeId}
              onArchive={archive}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragLeave={() => setDrop(null)}
              onDragEnd={reset}
            />
          ))}
        </div>
      </ScrollArea>
    </GlassPanel>
  )
})

interface BaySectionProps {
  bay: BayData; items: AircraftState[]; vehicles: Vehicle[] | null; position: PlayerPosition; time: number
  collapsed: boolean; onToggle: () => void; sort: BaySort; sortOpen: boolean; onSortToggle: () => void; onSort: (k: BaySort) => void
  flash: boolean; over: boolean; nextIn: string | null; selectedId: number | null; hoveredId: number | null
  alertsByCs: Map<string, Alert[]>; parkedIds: ReadonlySet<number>; drag: { id: number; bay: BayId } | null; drop: { id: number; where: 'before' | 'after' } | null; shakeId: number | null
  onArchive: (a: AircraftState) => void
  onDragStart: (a: AircraftState, bay: BayId) => (e: React.DragEvent) => void
  onDragOver: (a: AircraftState, bay: BayId) => (e: React.DragEvent) => void
  onDrop: (a: AircraftState, bay: BayId) => (e: React.DragEvent) => void
  onDragLeave: () => void
  onDragEnd: () => void
}

const EMPTY_ALERTS: Alert[] = []

function BaySection(p: BaySectionProps) {
  const { bay, items, vehicles, position, time, collapsed, onToggle, sort, sortOpen, onSortToggle, onSort, flash, over, nextIn, selectedId, hoveredId, alertsByCs, parkedIds, drag, drop, shakeId, onArchive, onDragStart, onDragOver, onDrop, onDragLeave, onDragEnd } = p
  const isVeh = bay.bay === 'VEHICLES'
  const count = isVeh ? (vehicles?.length ?? 0) : items.length
  const req = items.filter((a) => openRequest(a) && time >= a.standbyUntil).length
  const alert = items.filter((a) => a.conflict || alertsByCs.has(a.callsign)).length
  return (
    <section className={styles.section} data-testid={`strip-bay-${bay.bay}`} data-bay-section={bay.bay} data-count={count} data-flash={flash ? 'true' : undefined} data-over={over ? 'true' : undefined} aria-label={bay.title}>
      <div className={styles.sectionRow}>
        <button type="button" className={styles.sectionHead} onClick={onToggle} aria-expanded={!collapsed} data-testid={`bay-section-${bay.bay}`}>
          <span>{bay.title}</span>
          <span className={styles.sectionCount} data-testid={`bay-count-${bay.bay}`}>{count}</span>
          {alert ? <span className={cx(styles.dot, styles.dotAlert)} aria-label={`${alert} alerts`} /> : null}
          {req ? <span className={cx(styles.dot, styles.dotReq)} aria-label={`${req} requests`} /> : null}
          <span className={styles.chev} data-open={collapsed ? 'false' : 'true'} data-testid={`bay-collapse-section-${bay.bay}`}><IconChevronUp size={14} /></span>
        </button>
        {!isVeh ? <IconButton size={32} variant="ghost" label={`Sort ${bay.title}`} icon={<Icon name="list-filter" />} active={sortOpen} onClick={onSortToggle} testId={`bay-sort-${bay.bay}`} /> : null}
      </div>
      {sortOpen ? (
        <div className={styles.sortRow} role="radiogroup" aria-label="Sort">
          {SORTS.map((s) => <Pill key={s.id} size="xs" tone={sort === s.id ? 'orange' : 'neutral'} interactive selected={sort === s.id} onClick={() => onSort(s.id)} testId={`bay-sort-opt-${bay.bay}-${s.id}`}>{s.label}</Pill>)}
        </div>
      ) : null}
      {collapsed ? null : isVeh ? (
        <div className={styles.list}>
          {vehicles?.map((v) => <VehicleStrip key={v.id} v={v} time={time} />)}
          {!vehicles?.length ? <div className={styles.empty} data-testid={`bay-empty-${bay.bay}`}>All vehicles at station</div> : null}
        </div>
      ) : (
        <div className={styles.list}>
          {items.map((a) => (
            <StripCard
              key={a.id}
              a={a}
              stage={sim.stageOf(a)}
              bay={bay.bay}
              position={position}
              time={time}
              selected={a.id === selectedId}
              hovered={a.id === hoveredId}
              alerts={alertsByCs.get(a.callsign) ?? EMPTY_ALERTS}
              hasDraft={parkedIds.has(a.id)}
              archived={false}
              dragging={drag?.id === a.id}
              drop={drop?.id === a.id ? drop.where : null}
              shake={shakeId === a.id}
              onArchive={() => onArchive(a)}
              onDragStart={onDragStart(a, bay.bay)}
              onDragOver={onDragOver(a, bay.bay)}
              onDragLeave={onDragLeave}
              onDrop={onDrop(a, bay.bay)}
              onDragEnd={onDragEnd}
            />
          ))}
          {!items.length ? <div className={styles.empty} data-testid={`bay-empty-${bay.bay}`}>{bay.items.length ? 'No strips match the filter' : `No traffic${nextIn ? ` — next spawn in ${nextIn}` : ''}`}</div> : null}
        </div>
      )}
    </section>
  )
}

/** Vehicle strip (UX §3.1): "FIRE 1  ARFF  → RWY 27L  EN ROUTE 01:20  [RECALL]". */
function VehicleStrip({ v, time }: { v: Vehicle; time: number }) {
  const eta = v.etaAt != null && v.state === 'enroute' ? Math.max(0, v.etaAt - time) : null
  const target = v.target ? (v.target.kind === 'runway' ? `RWY ${v.target.runway}` : v.target.kind === 'aircraft' ? v.target.callsign : v.target.kind === 'stand' ? `STAND ${v.target.ref}` : v.target.kind === 'point' ? 'map point' : 'station') : null
  const holding = v.holdShortRunway && !v.holdReleased
  return (
    <div className={styles.strip} role="option" aria-selected={false} tabIndex={0} data-testid={`strip-vehicle-${v.id}`} data-state={v.state} data-type={v.type} aria-label={`${v.callsign} ${VEHICLE_STATE_LABEL[v.state]}`}>
      <span className={styles.bar} data-tone={v.type === 'arff' ? 'red' : 'ghost'} aria-hidden="true" />
      <div className={styles.row}>
        <span className={styles.vehGlyph}>{vehicleGlyph(v.type, 14)}</span>
        <span className={styles.cs}>{v.callsign}</span>
        <span className={styles.type}>{v.type.toUpperCase()}</span>
        {target ? <span className={styles.route}><Icon name="arrow-right" size={12} />{target}</span> : null}
        <span className={styles.right}>
          <Pill size="xs" tone={v.state === 'onscene' ? 'green' : v.state === 'enroute' ? 'orange' : 'dim'} uppercase testId={`strip-vehicle-${v.id}-state`}>{VEHICLE_STATE_LABEL[v.state]}</Pill>
        </span>
      </div>
      <div className={cx(styles.row, styles.row2)}>
        <span className={styles.meta}>{holding ? `holding short ${v.holdShortRunway}` : eta != null ? `ETA ${fmtMMSS(eta)}` : v.onRunway ? `on runway ${v.onRunway}` : ''}</span>
        <span className={styles.right}>
          {holding ? <Pill size="xs" tone="orange" interactive onClick={(e) => { e.stopPropagation(); sim.dispatchAst({ kind: 'vehicleOp', id: v.id, op: 'cross', runway: v.holdShortRunway }) }} testId={`strip-vehicle-${v.id}-cross`}>Cross</Pill> : null}
          <Pill size="xs" tone="neutral" interactive onClick={(e) => { e.stopPropagation(); sim.recallVehicle(v.id) }} testId={`strip-vehicle-${v.id}-recall`}>Recall</Pill>
        </span>
      </div>
    </div>
  )
}

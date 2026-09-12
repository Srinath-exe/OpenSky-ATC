'use client'
/* ATIS / weather dropdown (UX 04 §2.1, §10 "ATIS / weather panel"; design 01 §8 ATIS chip). */
import * as React from 'react'
import styles from './AtisWeather.module.css'
import { GlassPanel, Button, Pill, Menu, IconButton, Icon, IconX, cx, formatThousands } from '@/design'
import type { RunwayState, RunwayStatus } from '@/lib/sim/types'
import { makeAst } from '@/lib/sim/commandAst'
import { sim, useSim, formatSimClock } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'

const STATUS_TONE: Record<RunwayStatus, 'green' | 'red' | 'orange' | 'solid'> = { open: 'green', closed: 'red', sterile: 'orange', inspection: 'solid' }
const STATUS_OPTIONS: Array<{ status: RunwayStatus; label: string; suffix: string }> = [
  { status: 'open', label: 'Open', suffix: 'open' },
  { status: 'closed', label: 'Close', suffix: 'close' },
  { status: 'sterile', label: 'Sterile', suffix: 'sterile' },
  { status: 'inspection', label: 'Inspection', suffix: 'inspect' },
]

/** Runway status chip with the A11.1 status menu (open / close / sterile / inspection). */
function RunwayStatusChip({ r }: { r: RunwayState }) {
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])
  const choose = (status: RunwayStatus) => { if (status !== r.status) sim.setRunwayStatus(r.name, status); setOpen(false) }
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % STATUS_OPTIONS.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + STATUS_OPTIONS.length) % STATUS_OPTIONS.length) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(STATUS_OPTIONS[active].status) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
  }
  const occupied = r.occupiedBy.length ? ` · ${r.occupiedBy.map((o) => o.callsign).join(', ')}` : ''
  return (
    <div ref={ref} className={styles.rwyCell} onKeyDown={onKey}>
      <Pill
        size="s"
        tone={STATUS_TONE[r.status]}
        dot={r.occupiedBy.length ? 'red' : r.status === 'open' ? 'green' : undefined}
        interactive
        tabular
        uppercase
        selected={open}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${r.name}: ${r.status}${r.statusReason ? ` (${r.statusReason})` : ''}${occupied}${r.surface !== 'dry' ? ` · ${r.surface}` : ''}`}
        data-status={r.status}
        testId={`atis-runway-${r.name}-status`}
      >
        {r.name} {r.status}
      </Pill>
      {open ? (
        <Menu
          className={styles.rwyMenu}
          placement="bottom"
          value={r.status}
          activeIndex={active}
          onActiveChange={setActive}
          onSelect={(v) => choose(v as RunwayStatus)}
          options={STATUS_OPTIONS.map((o) => ({ value: o.status, label: o.label, testId: `atis-runway-${r.name}-${o.suffix}` }))}
        />
      ) : null}
    </div>
  )
}

function Kpi({ label, value, unit, dim, testId, children }: { label: string; value: React.ReactNode; unit?: string; dim?: boolean; testId?: string; children?: React.ReactNode }) {
  return (
    <div className={styles.kpi} data-testid={testId}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={cx(styles.kpiValue, dim && styles.kpiDim)}>{children}{value}{unit ? <span className={styles.kpiUnit}>{unit}</span> : null}</span>
    </div>
  )
}

export function AtisWeather() {
  const shell = useShell()
  const atis = useSim((s) => s.atis())
  const wx = useSim((s) => s.weather())
  const rwys = useSim((s) => s.runways())
  const suggestion = useSim((s) => s.suggestedRunways())
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (ref.current?.contains(t) || t.closest?.('[data-dropdown-trigger="atis"]') || t.closest?.('[role="dialog"]')) return
      shell.hide('atis')
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [shell])

  const dep = rwys.filter((r) => r.activeDep)
  const arr = rwys.filter((r) => r.activeArr)
  const broadcast = () => { if (atis) sim.dispatchAst(makeAst('broadcast', null, { text: `All stations, information ${atis.letter}: ${atis.text}` })) }
  const windDir = wx?.windDirTrue ?? atis?.wind.dir ?? 0
  const windKt = wx?.windKt ?? atis?.wind.kts ?? 0
  const gust = wx?.gustKt ?? atis?.wind.gust ?? 0
  const visM = wx?.visM ?? atis?.visM ?? 0
  const visText = visM >= 10000 ? '10+' : visM >= 5000 ? (visM / 1000).toFixed(0) : visM >= 1000 ? (visM / 1000).toFixed(1) : String(visM)
  const visUnit = visM >= 1000 ? 'km' : 'm'

  return (
    <GlassPanel
      ref={ref}
      variant="glass-strong"
      className={styles.panel}
      role="dialog"
      aria-label="ATIS and weather"
      padding="card-lg"
      radius="card-lg"
      header={
        <button type="button" className={styles.letterBtn} onClick={broadcast} title="Re-broadcast ATIS" data-testid="atis-letter">
          <span className={styles.letter}>Information {atis?.letter ?? '—'}</span>
          <span className={styles.letterWord}>{atis ? `issued ${formatSimClock(atis.issuedAt)}` : 'no ATIS'}</span>
        </button>
      }
      headerRight={<IconButton size={32} variant="ghost" label="Close" icon={<IconX size={16} />} onClick={() => shell.hide('atis')} testId="atis-close" />}
      testId="atis-panel"
    >
      <div className={styles.body} key={atis?.letter ?? 'none'}>
        <div className={styles.kpis}>
          <Kpi label="Wind" value={`${String(Math.round(windDir)).padStart(3, '0')}/${String(Math.round(windKt)).padStart(2, '0')}`} unit={gust ? `G${Math.round(gust)}` : 'kt'} testId="atis-wind">
            <span className={styles.windArrow} style={{ transform: `rotate(${(windDir + 180) % 360}deg)` }} data-testid="atis-wind-arrow" aria-label={`wind from ${Math.round(windDir)}`}>
              <Icon name="arrow-up" size={16} />
            </span>
          </Kpi>
          <Kpi label="Visibility" value={visText} unit={visUnit} testId="atis-vis" />
          <Kpi label="Cloud" value={wx?.cloud ?? atis?.cloud ?? '—'} testId="atis-cloud" />
          <Kpi label="QNH" value={wx?.qnh != null ? Math.round(wx.qnh) : atis?.qnh != null ? Math.round(atis.qnh) : '—'} unit="hPa" testId="atis-qnh" />
          <Kpi label="Temp / dew" value={`${Math.round(wx?.tempC ?? atis?.tempC ?? 0)}/${Math.round(wx?.dewC ?? atis?.dewC ?? 0)}`} unit="°C" testId="atis-temp" />
        </div>

        {suggestion ? (
          <div className={styles.banner} role="status" data-testid="rwy-change-banner">
            <span className={styles.bannerIcon}><Icon name="wind" size={18} /></span>
            <span className={styles.bannerText}>
              Runway change suggested: DEP {suggestion.dep.join('/')} · ARR {suggestion.arr.join('/')}
              <small>{suggestion.reason}</small>
            </span>
            <Button size="sm" variant="accent" onClick={() => sim.setActiveRunways(suggestion.dep, suggestion.arr)} testId="rwy-change-apply">Apply</Button>
          </div>
        ) : null}

        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>Active runways</span>
            <Button size="sm" variant="ghost" onClick={() => shell.show('runwayConfig')} testId="atis-runway-config">Change</Button>
          </div>
          <div className={styles.row}>
            <span className={styles.roleLabel}>Departures</span>
            {dep.length ? dep.map((r) => <Pill key={r.name} size="s" tone="solid" tabular icon={<Icon name="plane-takeoff" size={14} />} testId={`atis-dep-${r.name}`}>{r.name}</Pill>) : <Pill size="s" tone="dim">none</Pill>}
          </div>
          <div className={styles.row}>
            <span className={styles.roleLabel}>Arrivals</span>
            {arr.length ? arr.map((r) => <Pill key={r.name} size="s" tone="solid" tabular icon={<Icon name="plane-landing" size={14} />} testId={`atis-arr-${r.name}`}>{r.name}</Pill>) : <Pill size="s" tone="dim">none</Pill>}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}><span>Runway status</span><span>{wx?.runwayCondition && wx.runwayCondition !== 'dry' ? `surface ${wx.runwayCondition}` : 'surface dry'}</span></div>
          <div className={styles.rwyGrid}>
            {rwys.map((r) => <RunwayStatusChip key={r.name} r={r} />)}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}><span>Broadcast</span><span>TL {atis?.transitionLevel ?? '—'}</span></div>
          <p className={styles.text} data-testid="atis-text">{atis?.text ?? 'ATIS not available.'}</p>
          <div className={styles.footer}>
            <Button size="sm" variant="secondary" iconLeft={<Icon name="radio" size={14} />} onClick={broadcast} disabled={!atis} testId="atis-broadcast">Broadcast ATIS</Button>
          </div>
        </div>
        <span className="sr-only">{formatThousands(visM)} metres visibility</span>
      </div>
    </GlassPanel>
  )
}

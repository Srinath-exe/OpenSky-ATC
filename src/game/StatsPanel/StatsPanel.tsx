'use client'
/* Score breakdown popover (00-MASTER-PLAN §2.5 "StatsPanel", UX 04 §10 score-chip, §G11; design 01 §4.5, §4.7, A8). */
import * as React from 'react'
import styles from './StatsPanel.module.css'
import { GlassPanel, IconButton, IconX, Kpi, BarChart, Sparkline, ScrollArea, EmptyState, Icon, formatThousands } from '@/design'
import type { BarDatum } from '@/design'
import type { ScoreCode, ScoreEvent, SessionStats } from '@/lib/sim/types'
import { sim, useSim, formatSimClock, formatMmSs } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'

/** UX §G11 rows: key -> label + the score codes that feed it. */
const ROWS: Array<{ key: string; label: string; codes: ScoreCode[] }> = [
  { key: 'movements', label: 'Movements', codes: ['MOVEMENT', 'PARKED', 'HOLD_POINT', 'WAKE_EFFICIENT'] },
  { key: 'established', label: 'Established on approach', codes: ['ESTABLISHED'] },
  { key: 'landed', label: 'Landed', codes: ['LANDED'] },
  { key: 'departed_handoff', label: 'Departures handed off', codes: ['DEPARTED_HANDOFF'] },
  { key: 'safety', label: 'Good catches and safety go-arounds', codes: ['GOOD_CATCH', 'SAFETY_GA', 'STCA_RESOLVED', 'LAHSO_SAVE', 'BIRDS_ACTIONED', 'INSPECTION_CLEAN', 'RWY_CHANGE_DONE', 'STREAK'] },
  { key: 'emergency_bonus', label: 'Emergencies handled', codes: ['EMERGENCY_DONE', 'ARFF_ON_TIME'] },
  { key: 'separation_loss', label: 'Separation loss', codes: ['SEPARATION_LOSS', 'COLLISION_AIR', 'MSAW_PERSIST', 'RESTRICTED_AREA'] },
  { key: 'ground_conflict', label: 'Ground conflict', codes: ['GROUND_CONFLICT', 'TAXI_CONFLICT', 'COLLISION_GND', 'DEADLOCK'] },
  { key: 'runway_incursion', label: 'Runway incursion', codes: ['RWY_INCURSION', 'LUAW_UNSAFE', 'CLOSED_RUNWAY_CLEARANCE'] },
  { key: 'wake', label: 'Wake turbulence', codes: ['WAKE_DEP', 'WAKE_FINAL'] },
  { key: 'go_around', label: 'Unhandled go-arounds', codes: ['GA_UNHANDLED'] },
  { key: 'diversion', label: 'Diversions', codes: ['DIVERSION', 'DIVERSION_UNHANDLED'] },
  { key: 'fuel_exhaustion', label: 'Fuel exhaustion', codes: ['FUEL_EXHAUSTION'] },
  { key: 'unanswered_request', label: 'Unanswered requests', codes: ['UNANSWERED_REQUEST'] },
  { key: 'readback_error_missed', label: 'Readback errors missed', codes: ['READBACK_ERROR_MISSED'] },
  { key: 'sterile_runway_violation', label: 'Sterile runway violations', codes: ['STERILE_RUNWAY_VIOLATION'] },
  { key: 'delay', label: 'Delays and late handoffs', codes: ['DELAY_15', 'DELAY_30', 'HANDOFF_LATE', 'TAXI_INCOMPLETE', 'EXIT_INCOMPLETE', 'PERFORMANCE_TAILWIND', 'EMERGENCY_CHECKLIST_MISS'] },
]

function movementBuckets(s: SessionStats): BarDatum[] {
  const src = s.movementsHistory
  const out: BarDatum[] = []
  for (let i = 0; i < src.length; i += 2) {
    const a = src[i], b = src[i + 1]
    const dep = a.dep + (b?.dep ?? 0), arr = a.arr + (b?.arr ?? 0)
    const at = a.at
    out.push({ label: formatMmSs(at).slice(0, 5).replace(/^0/, '') || '0', current: dep + arr, compare: arr, value: dep + arr, testId: `stats-bar-${Math.round(at)}` })
  }
  return out.slice(-12)
}

function ticksFor(max: number, steps = 3): number[] {
  const top = Math.max(steps, Math.ceil(max / steps) * steps)
  const out: number[] = []
  for (let i = 1; i <= steps; i++) out.push(Math.round((top / steps) * i))
  return out
}

export function StatsPanel() {
  const shell = useShell()
  const stats = useSim((s) => s.stats())
  const hi = useSim((s) => s.highScore)
  const time = useSim((s) => Math.floor(s.time()))
  const icao = useSim((s) => s.icao)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (ref.current?.contains(t) || t.closest?.('[data-dropdown-trigger="stats"]')) return
      shell.hide('stats')
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [shell])

  const [selectedBar, setSelectedBar] = React.useState<number | null>(null)
  const bars = React.useMemo(() => movementBuckets(stats), [stats])
  const barMax = bars.reduce((m, b) => Math.max(m, typeof b.current === 'number' ? b.current : b.current[1]), 0)
  const delays = React.useMemo(() => stats.delaySamples.slice(-60).map((s) => Math.round(s / 6) / 10), [stats.delaySamples])
  const delayMax = delays.reduce((m, v) => Math.max(m, v), 0)

  const ledgerByCode = React.useMemo(() => {
    const m = new Map<ScoreCode, { n: number; pts: number }>()
    for (const ev of stats.ledger) { const cur = m.get(ev.code) ?? { n: 0, pts: 0 }; cur.n++; cur.pts += ev.points; m.set(ev.code, cur) }
    return m
  }, [stats.ledger])
  const rows = ROWS.map((r) => {
    let n = 0, pts = 0
    for (const c of r.codes) { const v = ledgerByCode.get(c); if (v) { n += v.n; pts += v.pts } }
    return { ...r, n, pts }
  }).filter((r) => r.n > 0)
  const incidents: ScoreEvent[] = React.useMemo(() => stats.ledger.filter((ev) => ev.points < 0).slice(-8).reverse(), [stats.ledger])
  const handled = Math.max(1, stats.departures + stats.arrivals)
  const freqLoad = stats.transmissions / handled

  return (
    <GlassPanel
      ref={ref}
      variant="glass-strong"
      title="Score"
      titleSize="l"
      subtitle={`${icao} · session ${formatSimClock(time)} · seed ${sim.seed}`}
      padding="card-lg"
      radius="card-lg"
      headerGap
      className={styles.panel}
      role="dialog"
      aria-label="Score breakdown"
      headerRight={<IconButton size={32} variant="ghost" label="Close" icon={<IconX size={16} />} onClick={() => shell.hide('stats')} testId="score-breakdown-close" />}
      testId="score-breakdown"
    >
      <ScrollArea className={styles.scroll} maxHeight="calc(100vh - 220px)">
        <div className={styles.body}>
          <div className={styles.head}>
            <div className={styles.headCell}><span className={styles.headLabel}>Points</span><Kpi size="m" value={stats.points} split="comma" countUp testId="score-points" /></div>
            <div className={styles.headCell}><span className={styles.headLabel}>Skill</span><Kpi size="m" value={stats.skill} decimals={1} split="decimal" unit="/ 12" unitTone="text-3" testId="score-skill" /></div>
            <div className={styles.headCell}><span className={styles.headLabel}>Best skill</span><Kpi size="m" value={stats.score} decimals={1} split="decimal" dim testId="score-best-skill" /></div>
            <div className={styles.headCell}><span className={styles.headLabel}>High score</span><Kpi size="m" value={hi} split="comma" dim={hi <= stats.points} testId="score-highscore" /></div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}><span>Movements per 10 min</span><span>{Math.round(stats.movementsPerHour)} / h · {stats.departures} dep · {stats.arrivals} arr</span></div>
            <div className={styles.chartWrap}>
              {bars.length ? (
                <BarChart data={bars} yTicks={ticksFor(barMax)} height={160} selected={selectedBar} onSelect={setSelectedBar} tooltip legend={{ current: 'Movements', compare: 'Arrivals' }} onGlass ariaLabel="Movements per ten minutes" testId="stats-movements" />
              ) : (
                <EmptyState compact icon={<Icon name="plane" size={24} />} title="No movements yet" hint="Takeoffs and landings fill this chart every ten minutes" testId="stats-movements-empty" />
              )}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}><span>Delay</span><span>avg {formatMmSs(stats.delayAvgS)} · p95 {formatMmSs(stats.delayP95S)}</span></div>
            <div className={styles.chartWrap}>
              {delays.length >= 2 ? (
                <Sparkline data={delays} yTicks={ticksFor(Math.max(1, delayMax), 2)} formatY={(v) => `${v} min`} formatValue={(v) => `${v.toFixed(1)} min`} height={96} showCurrent cursorTooltip onGlass ariaLabel="Delay per aircraft, minutes" testId="stats-delay" />
              ) : (
                <EmptyState compact icon={<Icon name="timer" size={24} />} title="No delay samples yet" hint="Each aircraft that reaches its stand or leaves the airspace adds a point" testId="stats-delay-empty" />
              )}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}><span>Breakdown</span><span>{stats.ledger.length} entries</span></div>
            <div className={styles.rows} data-testid="score-rows">
              {rows.length === 0 ? <div className={styles.empty}>Nothing scored yet.</div> : null}
              {rows.map((r) => (
                <div key={r.key} className={styles.row} data-neg={r.pts < 0} data-pos={r.pts > 0} data-testid={`score-row-${r.key}`} data-value={r.pts}>
                  <span className={styles.rowLabel}>{r.label}</span>
                  <span className={styles.rowCount}>×{r.n}</span>
                  <span className={styles.rowValue}>{r.pts > 0 ? '+' : r.pts < 0 ? '−' : ''}{formatThousands(Math.abs(r.pts))}</span>
                </div>
              ))}
              <div className={styles.row} data-info="true" data-testid="score-row-frequency_load" data-value={freqLoad.toFixed(1)}>
                <span className={styles.rowLabel}>Frequency load</span>
                <span className={styles.rowCount}>{stats.transmissions} tx</span>
                <span className={styles.rowValue}>{freqLoad.toFixed(1)} / acft</span>
              </div>
              <div className={styles.row} data-info="true" data-testid="score-row-responsiveness" data-value={Math.round(stats.responsivenessMeanS)}>
                <span className={styles.rowLabel}>Responsiveness</span>
                <span className={styles.rowCount}>{stats.unansweredRequests ? `${stats.unansweredRequests} unanswered` : ''}</span>
                <span className={styles.rowValue}>{stats.responsivenessMeanS ? `${Math.round(stats.responsivenessMeanS)} s` : '—'}</span>
              </div>
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}><span>Incidents</span><span>{stats.goAroundsPilot} pilot GA · {stats.diversions} div · {stats.emergenciesResolved}/{stats.emergenciesDeclared} emerg</span></div>
            <div className={styles.rows} data-testid="score-incidents">
              {incidents.length === 0 ? <div className={styles.empty} data-testid="score-incidents-empty">No incidents. Keep it that way.</div> : null}
              {incidents.map((ev, i) => (
                <div key={`${ev.at}-${ev.code}-${i}`} className={styles.incident} data-testid={`score-incident-${i}`} data-code={ev.code}>
                  <span className={styles.incidentTime}>{formatMmSs(ev.at)}</span>
                  <span className={styles.incidentText}><strong>{ev.primary}{ev.secondary ? ` / ${ev.secondary}` : ''}</strong> · {ev.detail || ev.code.toLowerCase().replace(/_/g, ' ')}</span>
                  <span className={styles.incidentPts}>−{Math.abs(ev.points)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.foot}>
            <span>Session <strong>{formatSimClock(time)}</strong></span>
            <span>Streak <strong>{formatMmSs(stats.streakS)}</strong></span>
            <span>ARFF response <strong>{stats.arffResponseS.length ? `${Math.round(stats.arffResponseS.reduce((a, b) => a + b, 0) / stats.arffResponseS.length)} s` : '—'}</strong></span>
          </div>
        </div>
      </ScrollArea>
    </GlassPanel>
  )
}

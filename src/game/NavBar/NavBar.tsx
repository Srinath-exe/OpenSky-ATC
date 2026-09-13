'use client'
/* Top bar (UX 04 §2.1 / §10 "Top bar", design 01 §4.9, A11.8, A11.9, A15). */
import * as React from 'react'
import Link from 'next/link'
import styles from './NavBar.module.css'
import { Tabs, Pill, IconButton, Segmented, Tooltip, LogoMark, IconPause, IconPlay, IconBell, IconSettings, Icon, cx, useCountUp, formatThousands } from '@/design'
import type { PlayerPosition } from '@/lib/sim/types'
import { sim, useSim } from '../hooks/useSimSelector'
import { formatSimClock } from '../hooks/useSimSelector'
import { useUtcClock } from '../hooks/useClock'
import { useShell } from '../shellContext'
import { TxIndicator } from '../TxIndicator/TxIndicator'

const POSITIONS: PlayerPosition[] = ['ground', 'tower', 'approach']

/** Position tabs: the design-system Tabs primitive plus `aria-pressed` mirrored from `aria-selected` (05 §3.1 convention). */
function PositionTabs() {
  const position = useSim((s) => s.position)
  const hasRadar = useSim((s) => !!s.radar)
  const icao = useSim((s) => s.icao)
  const ai = useSim((s) => `${s.settings.autoGround ? 'g' : ''}${s.settings.autoTower ? 't' : ''}${s.settings.autoApproach ? 'a' : ''}`)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((b) => {
      b.setAttribute('aria-pressed', b.getAttribute('aria-selected') === 'true' ? 'true' : 'false')
      // a dot on positions an AI assist is working (settings: AI assist)
      const id = b.dataset.testid ?? ''
      const on = (id.endsWith('ground') && ai.includes('g')) || (id.endsWith('tower') && ai.includes('t')) || (id.endsWith('approach') && ai.includes('a'))
      b.setAttribute('data-ai', on ? 'true' : 'false')
      b.title = on ? 'AI assist is active on this position' : ''
    })
  }, [position, hasRadar, ai])
  const items = POSITIONS.map((p) => ({ id: p, label: p.toUpperCase(), testId: `mode-tab-${p}`, disabled: p === 'approach' && !hasRadar }))
  const tabs = (
    <div ref={ref} className={styles.tabs} data-testid="position-tabs">
      <Tabs ariaLabel="Position" items={items} value={position} onChange={(id) => sim.setPosition(id as PlayerPosition)} />
    </div>
  )
  if (hasRadar) return tabs
  return <Tooltip content={`No radar airspace for ${icao || 'this airport'}`} placement="bottom">{tabs}</Tooltip>
}

function AtisChip() {
  const shell = useShell()
  const atis = useSim((s) => s.atis())
  const rwys = useSim((s) => s.runways())
  const open = !!shell.open.atis
  // more than two ends: "27R/27L +2" keeps the chip from clipping mid-token at 1600 px (full list in the ATIS panel)
  const short = (list: string[]) => (list.length > 2 ? `${list.slice(0, 2).join('/')} +${list.length - 2}` : list.join('/')) || '—'
  const dep = short(atis?.activeDep?.length ? atis.activeDep : rwys.filter((r) => r.activeDep).map((r) => r.name))
  const arr = short(atis?.activeArr?.length ? atis.activeArr : rwys.filter((r) => r.activeArr).map((r) => r.name))
  const wind = atis ? `${String(Math.round(atis.wind.dir)).padStart(3, '0')}/${String(Math.round(atis.wind.kts)).padStart(2, '0')}${atis.wind.gust ? `G${Math.round(atis.wind.gust)}` : ''}` : '—'
  return (
    <Pill
      size="m"
      tone="glass"
      interactive
      selected={open}
      tabular
      icon={<Icon name="radio" size={16} />}
      iconTone={atis ? 'orange' : 'none'}
      className={styles.atisChip}
      onClick={() => shell.toggle('atis')}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-dropdown-trigger="atis"
      testId="atis-chip"
    >
      <span className={styles.atisLetter}>ATIS {atis?.letter ?? '—'}</span>
      <span className={cx(styles.atisSep, styles.atisWide)}>·</span>
      <span className={cx(styles.atisPart, styles.atisWide)}>{dep === arr ? dep : `${dep} / ${arr}`}</span>
      <span className={styles.atisSep}>·</span>
      <span className={styles.atisPart} data-testid="wind">{wind}</span>
      <span className={cx(styles.atisSep, styles.atisWideQnh)}>·</span>
      <span className={cx(styles.atisPart, styles.atisWideQnh)}>Q{atis?.qnh ?? '—'}</span>
      {atis?.cloud ? <span className={cx(styles.atisSep, styles.atisWideCloud)}>·</span> : null}
      {atis?.cloud ? <span className={cx(styles.atisPart, styles.atisWideCloud)}>{atis.cloud}</span> : null}
    </Pill>
  )
}

function Clock() {
  const utc = useUtcClock()
  const simT = useSim((s) => Math.floor(s.engine?.time ?? 0))
  const rate = useSim((s) => s.rate)
  const paused = useSim((s) => s.paused)
  const [open, setOpen] = React.useState(false)
  const wrap = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); e.stopPropagation() } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <div ref={wrap} className={styles.clockWrap}>
      <button type="button" className={styles.clock} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" data-testid="clock-utc" title="Sim time and rate">
        <span data-testid="clock">{utc ? `${utc}Z` : '--:--:--Z'}</span>
        <span className={styles.clockSim}>{formatSimClock(simT)}</span>
      </button>
      {open ? (
        <div className={styles.popover} role="dialog" aria-label="Sim time" data-testid="clock-popover">
          <div className={styles.popRow}><span>UTC</span><strong>{utc}Z</strong></div>
          <div className={styles.popRow}><span>Session</span><strong>{formatSimClock(simT)}</strong></div>
          <div className={styles.popRow}><span>Rate</span><strong>{paused ? 'Paused' : `${rate}×`}</strong></div>
        </div>
      ) : null}
    </div>
  )
}

function RateControl() {
  const rate = useSim((s) => s.rate)
  const paused = useSim((s) => s.paused)
  const [ff, setFf] = React.useState(false)
  const prevRate = React.useRef<1 | 2 | 4>(1)
  const startFf = () => { if (ff) return; prevRate.current = sim.rate; setFf(true); sim.setRate(4); if (sim.paused) sim.setPaused(false) }
  const stopFf = () => { if (!ff) return; setFf(false); sim.setRate(prevRate.current) }
  return (
    <div className={styles.rateGroup} role="group" aria-label="Sim rate">
      <Tooltip content={paused ? 'Resume' : 'Pause'} kbd={['Space']} placement="bottom">
        <IconButton
          size={36}
          variant="ghost"
          label={paused ? 'Resume' : 'Pause'}
          icon={paused ? <IconPlay size={16} /> : <IconPause size={16} />}
          active={paused}
          aria-pressed={paused}
          data-state={paused ? 'paused' : 'running'}
          onClick={() => sim.togglePause()}
          testId="rate-pause"
        />
      </Tooltip>
      <Segmented
        ariaLabel="Rate"
        tabular
        value={String(rate)}
        onChange={(id) => sim.setRate(Number(id) as 1 | 2 | 4)}
        items={[
          { id: '1', label: '1×', testId: 'rate-1x' },
          { id: '2', label: '2×', testId: 'rate-2x' },
          { id: '4', label: '4×', testId: 'rate-4x' },
        ]}
      />
      <Tooltip content="Hold to fast-forward" placement="bottom">
        <button
          type="button"
          className={styles.ff}
          aria-label="Fast forward (hold)"
          data-state={ff ? 'on' : 'off'}
          data-testid="rate-ff"
          onPointerDown={startFf}
          onPointerUp={stopFf}
          onPointerLeave={stopFf}
          onPointerCancel={stopFf}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startFf() } }}
          onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') stopFf() }}
        >
          <Icon name="zap" size={16} />
        </button>
      </Tooltip>
    </div>
  )
}

/** Score with a live delta float (UX 04 §7.1 "Score"): number rolls, `+n` floats up, `−n` shakes in red. */
function ScoreChip() {
  const shell = useShell()
  const score = useSim((s) => s.score())
  const hi = useSim((s) => s.highScore)
  const shown = useCountUp(score, 600, { animateDecrease: false })
  const prev = React.useRef(score)
  const [delta, setDelta] = React.useState<{ v: number; k: number } | null>(null)
  React.useEffect(() => {
    const d = score - prev.current
    prev.current = score
    if (d === 0) return
    setDelta({ v: d, k: Date.now() })
    const t = setTimeout(() => setDelta(null), 1300)
    return () => clearTimeout(t)
  }, [score])
  const open = !!shell.open.stats
  return (
    <button type="button" className={styles.score} onClick={() => shell.toggle('stats')} aria-expanded={open} aria-haspopup="dialog" data-open={open} data-dropdown-trigger="stats" data-testid="score-chip" title="Score breakdown">
      <span className={styles.scoreLabel}>Score</span>
      <span className={styles.scoreValue} data-testid="score" data-value={score}><span key={delta?.k ?? 0} className={delta ? styles.scoreBump : undefined}>{formatThousands(shown)}</span></span>
      {hi > 0 ? <span className={styles.scoreHi} data-testid="score-hi">HI {formatThousands(hi)}</span> : null}
      {delta ? <span key={delta.k} className={styles.scoreDelta} data-neg={delta.v < 0} aria-hidden="true">{delta.v > 0 ? `+${formatThousands(delta.v)}` : `−${formatThousands(-delta.v)}`}</span> : null}
    </button>
  )
}

function AlertsBell() {
  const shell = useShell()
  const unacked = useSim((s) => s.alerts().filter((a) => !a.ack && a.severity !== 'info').length)
  const [pulseKey, setPulseKey] = React.useState(0)
  const prev = React.useRef(unacked)
  React.useEffect(() => { if (unacked > prev.current) setPulseKey((k) => k + 1); prev.current = unacked }, [unacked])
  const open = !!shell.open.alerts
  return (
    <Tooltip content="Alerts" placement="bottom">
      <IconButton
        size={40}
        variant="glass"
        label={unacked ? `Alerts, ${unacked} unacknowledged` : 'Alerts'}
        icon={<IconBell size={20} />}
        badge={unacked || undefined}
        badgePulse={pulseKey > 0}
        active={open}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-dropdown-trigger="alerts"
        data-count={unacked}
        onClick={() => shell.toggle('alerts')}
        testId="alerts-bell"
      />
    </Tooltip>
  )
}

export function NavBar() {
  const shell = useShell()
  const icao = useSim((s) => s.icao)
  const name = useSim((s) => s.airspace?.name ?? s.engine?.airportName ?? s.icao)
  const escalated = useSim((s) => {
    const t = s.engine?.time ?? 0
    return s.alerts().some((a) => a.severity === 'critical' && !a.ack && t - a.createdAt > 10)
  })
  const position = useSim((s) => s.position)
  return (
    <nav className={styles.nav} data-escalated={escalated} aria-label="Top bar">
      <div className={styles.left}>
        <Link href="/" prefetch={false} className={styles.brand} data-testid="brand-home" onClick={(e) => { if (sim.engine) { e.preventDefault(); shell.show('leaveConfirm') } }} title="Home">
          <span className={styles.brandMark}><LogoMark size={28} /></span>
          <span className={styles.brandText}>
            <span className={styles.brandWord}>Skycontrol</span>
            <span className={styles.brandSub}>{name && name !== icao ? `${name} · ${icao}` : icao || 'No airport'}</span>
          </span>
        </Link>
        <Pill size="s" tone="outline" interactive tabular onClick={() => shell.show('runwayConfig')} testId="airport-badge" title="Airport and runway configuration">{icao || '—'}</Pill>
        <span className={styles.divider} aria-hidden="true" />
        <PositionTabs />
      </div>
      <div className={styles.center}>
        <AtisChip />
      </div>
      <div className={styles.right}>
        <Clock />
        <RateControl />
        <ScoreChip />
        <AlertsBell />
        <TxIndicator />
        <Tooltip content="Settings" placement="bottom">
          <IconButton size={40} variant="glass" label="Settings" icon={<IconSettings size={20} />} active={!!shell.open.settings} onClick={() => shell.toggle('settings')} testId="settings-btn" />
        </Tooltip>
        <Tooltip content="Help" kbd={['?']} placement="bottom">
          <IconButton size={40} variant="glass" label="Help" icon={<Icon name="help-circle" size={20} />} active={!!shell.open.help} onClick={() => shell.toggle('help')} testId="help-btn" />
        </Tooltip>
      </div>
      <span className="sr-only" aria-live="polite">{position} position</span>
    </nav>
  )
}

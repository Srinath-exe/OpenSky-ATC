'use client'
/*
  GameShell — the single game screen (00-MASTER-PLAN §2.5, UX 04 §2).
  Grid: NavBar / full-bleed map or radar with floating glass panels / comm log.
  Owns the ShellContext (panel collapse, overlays, focus region, PTT), the
  keyboard dispatcher, the <body data-*> mirrors and the overlay hosts.
*/
import * as React from 'react'
import dynamic from 'next/dynamic'
import styles from './GameShell.module.css'
import { Pill, GlassPanel, Button, LoadingOverlay, IconPause } from '@/design'
import { sim, useSim } from '../hooks/useSimSelector'
import { usePersistedState } from '../hooks/usePersistedState'
import { LS } from '../persist'
import { ShellContext, useOverlayState } from '../shellContext'
import type { ShellState } from '../shellContext'
import { NavBar } from '../NavBar/NavBar'
import { AlertStack, AlertsDrawer } from '../AlertStack/AlertStack'
import { RunwayBars } from '../RunwayBars/RunwayBars'
import { hasWorld, prefetchWorld } from '@/components/atc/WorldMap/worldList'
import { AtisWeather } from '../AtisWeather/AtisWeather'
import { RunwayConfigDialog } from '../AtisWeather/RunwayConfigDialog'
import { StripBay } from '@/game/StripBay'
import type { StripBayHandle } from '@/game/StripBay'
import { CommandPanel } from '@/game/CommandPanel'
import { VehiclePanel } from '@/game/VehiclePanel'
import { CommLog } from '../CommLog/CommLog'
import { StatsPanel } from '../StatsPanel/StatsPanel'
import { HelpOverlay } from '../HelpOverlay/HelpOverlay'
import { OnboardingTips } from '../HelpOverlay/OnboardingTips'
import { PauseMenu } from '../PauseMenu/PauseMenu'
import { SettingsModal } from '../SettingsModal/SettingsModal'
import { HoldingScreen } from '../HoldingScreen/HoldingScreen'
import { ToastHost } from './ToastHost'
import { LeaveConfirm } from './LeaveConfirm'
import { LiquidGlassDefs } from './LiquidGlassDefs'
import { useShellHotkeys } from './useShellHotkeys'

const GroundView = dynamic(() => import('@/components/atc/GroundView'), { ssr: false, loading: () => <div className={styles.viewPending}>Loading map</div> })
// the 3D world (three.js + the map code) is its own chunk: the shell is interactive while it downloads, and its world
// files are fetched in parallel with it (prefetchWorld)
const WorldMap = dynamic(() => import('@/components/atc/WorldMap/WorldMap').then((m) => m.WorldMap), { ssr: false, loading: () => <div className={styles.viewPending}>Building the world</div> })
const ApproachView = dynamic(() => import('@/components/atc/ApproachView'), { ssr: false, loading: () => <div className={styles.viewPending}>Loading radar</div> })

interface PanelPrefs { bay: boolean; log: boolean }
const DEFAULT_PANELS: PanelPrefs = { bay: false, log: false }

type FocusRegion = ShellState['focusRegion']

export interface GameShellProps {
  /** Airport data is being fetched (page-owned so the overlay sits over the map, not the nav). */
  loading?: boolean
  loadError?: string | null
  onRetry?: () => void
}

export function GameShell({ loading = false, loadError = null, onRetry }: GameShellProps) {
  const overlays = useOverlayState()
  const { open, isOpen, show, hide, toggle, closeTop } = overlays
  const [panels, setPanels] = usePersistedState<PanelPrefs>(LS.panels, DEFAULT_PANELS)
  const [ptt, setPttState] = React.useState(false)
  const [focusRegion, setFocusRegion] = React.useState<FocusRegion>('map')
  const cmdFocus = React.useRef<((prefill?: string) => void) | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  /** StripBay handle (focusNext / focusPrev / focusStrip); the bay also registers the shell cycler used by Tab. */
  const bayRef = React.useRef<StripBayHandle>(null)

  const position = useSim((s) => s.position)
  const paused = useSim((s) => s.paused)
  const rate = useSim((s) => s.rate)
  const hasRadar = useSim((s) => !!s.radar)
  const hasEngine = useSim((s) => !!s.engine)
  const selectedId = useSim((s) => s.selectedId)
  const icao = useSim((s) => s.icao)

  const toggleBay = React.useCallback(() => setPanels((p) => ({ ...p, bay: !p.bay })), [setPanels])
  const toggleLog = React.useCallback(() => setPanels((p) => ({ ...p, log: !p.log })), [setPanels])
  const setLogCollapsed = React.useCallback((b: boolean) => setPanels((p) => (p.log === b ? p : { ...p, log: b })), [setPanels])
  const setPtt = React.useCallback((b: boolean) => setPttState((prev) => (prev === b ? prev : b)), [])
  const focusCmd = React.useCallback((prefill?: string) => {
    if (panels.log) {
      // let a collapsed log expand before focusing
      setPanels((p) => ({ ...p, log: false }))
      window.setTimeout(() => cmdFocus.current?.(prefill), 0)
      return
    }
    cmdFocus.current?.(prefill)
  }, [panels.log, setPanels])
  const registerCmdFocus = React.useCallback((fn: ((prefill?: string) => void) | null) => { cmdFocus.current = fn }, [])

  const shell = React.useMemo<ShellState>(() => ({
    bayCollapsed: panels.bay,
    logCollapsed: panels.log,
    toggleBay, toggleLog, setLogCollapsed,
    open, isOpen, show, hide, toggle, closeTop,
    focusCmd, registerCmdFocus,
    ptt, setPtt,
    focusRegion,
  }), [panels.bay, panels.log, toggleBay, toggleLog, setLogCollapsed, open, isOpen, show, hide, toggle, closeTop, focusCmd, registerCmdFocus, ptt, setPtt, focusRegion])

  const openPause = React.useCallback(() => show('pause'), [show])
  useShellHotkeys(shell, { hasRadar, openPause })

  // <body data-mode data-focus-region data-paused data-rate> (UX G12) + data-ptt for the TX indicator styling.
  React.useEffect(() => {
    const b = document.body
    b.setAttribute('data-mode', position)
    b.setAttribute('data-paused', paused ? 'true' : 'false')
    b.setAttribute('data-rate', String(rate))
    b.setAttribute('data-focus-region', focusRegion)
    b.setAttribute('data-ptt', ptt ? 'true' : 'false')
    return () => { for (const k of ['data-mode', 'data-paused', 'data-rate', 'data-focus-region', 'data-ptt']) b.removeAttribute(k) }
  }, [position, paused, rate, focusRegion, ptt])

  // Focus model (G6): the region owning keyboard focus, from the nearest [data-region]; selecting an aircraft moves it to the panel.
  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null
      const region = el?.closest?.('[data-region]')?.getAttribute('data-region') as FocusRegion | null | undefined
      if (region) setFocusRegion(region)
    }
    root.addEventListener('focusin', onFocus)
    return () => root.removeEventListener('focusin', onFocus)
  }, [])
  React.useEffect(() => { if (selectedId != null) setFocusRegion('panel') }, [selectedId])

  // The map toolbar's truck button asks the shell to toggle the vehicles panel (GroundView bridge event).
  React.useEffect(() => {
    const onToggle = (e: Event) => {
      const want = (e as CustomEvent<{ open?: boolean }>).detail?.open
      if (want == null) toggle('vehicles')
      else if (want) show('vehicles')
      else hide('vehicles')
    }
    window.addEventListener('atc:toggle-vehicles-panel', onToggle)
    return () => window.removeEventListener('atc:toggle-vehicles-panel', onToggle)
  }, [toggle, show, hide])
  const vehiclesOpen = !!open.vehicles && position !== 'approach'
  React.useEffect(() => { (sim as unknown as { vehiclesPanelOpen?: boolean }).vehiclesPanelOpen = vehiclesOpen }, [vehiclesOpen])

  // Approach tab without radar airspace falls back to tower (G10).
  React.useEffect(() => { if (hasEngine && !hasRadar && position === 'approach') sim.setPosition('tower') }, [hasEngine, hasRadar, position])

  const view = position === 'approach' && hasRadar ? 'radar' : 'ground'
  // the procedural 3D world is the ground/tower map; the 2D map remains the tested surface (test mode, or ?world=2d)
  // and the fallback for an airport without baked world data
  const worldAvailable = hasWorld(icao)
  const [worldPref] = React.useState<'3d' | '2d' | 'auto'>(() => {
    if (typeof window === 'undefined') return 'auto'
    const q = new URLSearchParams(window.location.search)
    const w = q.get('world')
    if (w === '3d') return '3d'
    if (w === '2d' || q.get('test') === '1' || q.get('test') === 'true') return '2d'
    return 'auto'
  })
  // sim.testMode is set by load(), after this component first mounts — read it at render time (the map only mounts once the engine exists)
  const use3d = worldAvailable && (worldPref === '3d' || (worldPref === 'auto' && !sim.testMode))
  React.useEffect(() => { if (worldAvailable && worldPref !== '2d' && !sim.testMode) prefetchWorld(icao) }, [icao, worldAvailable, worldPref])

  return (
    <ShellContext.Provider value={shell}>
      <div
        ref={rootRef}
        className={styles.shell}
        data-testid="game-shell"
        data-mode={position}
        data-paused={paused}
        data-bay-collapsed={panels.bay}
        data-log-collapsed={panels.log}
        data-has-panel={selectedId != null}
      >
        <NavBar />

        <main className={styles.main} aria-label="Map and panels">
          <div className={styles.view} data-region="map" data-view={view} data-testid={`view-${view}`}>
            {hasEngine ? (view === 'radar' ? <ApproachView key={`radar-${icao}`} /> : use3d ? <WorldMap key={`world-${icao}`} /> : <GroundView key={`ground-${icao}`} />) : null}
          </div>

          {paused ? (
            <div className={styles.paused}>
              <Pill size="s" tone="solid" icon={<IconPause size={14} />} iconTone="white" className={styles.pausedPill} testId="paused-pill">Paused</Pill>
            </div>
          ) : null}

          <AlertStack />
          <RunwayBars />

          <div className={styles.bay} data-region="bay">
            <StripBay ref={bayRef} />
          </div>
          <div className={styles.panel} data-region="panel">
            <CommandPanel />
          </div>

          {vehiclesOpen ? (
            <div className={styles.vehicles} data-region="panel">
              <VehiclePanel />
            </div>
          ) : null}

          {open.atis ? <AtisWeather /> : null}
          {open.alerts ? <AlertsDrawer /> : null}
          {open.stats ? <StatsPanel /> : null}

          <ToastHost />
          <OnboardingTips />

          {loading || (!hasEngine && !loadError) ? (
            <div className={styles.loadWrap} data-testid="load-overlay">
              <LoadingOverlay open text={`Loading ${icao || 'airport'}…`} testId="loading-overlay" />
            </div>
          ) : null}
          {loadError && !loading ? (
            <div className={styles.loadError} role="alert">
              <GlassPanel variant="solid" title="Airport failed to load" subtitle={icao || undefined} className={styles.loadErrorCard} testId="loading-error-card">
                <div className={styles.loadErrorBody}>
                  <p className={styles.loadErrorText} data-testid="loading-error">{loadError}</p>
                  <div className={styles.loadErrorActions}>
                    <Button variant="accent" onClick={onRetry} testId="loading-retry">Retry</Button>
                    <Button variant="ghost" onClick={() => show('leaveConfirm')} testId="loading-home">Home</Button>
                  </div>
                </div>
              </GlassPanel>
            </div>
          ) : null}
        </main>

        <div className={styles.logRow} data-region="log">
          <CommLog />
        </div>

        <RunwayConfigDialog open={!!open.runwayConfig} onClose={() => hide('runwayConfig')} />
        <HelpOverlay />
        <PauseMenu />
        <SettingsModal />
        <LeaveConfirm />
        <HoldingScreen />
        <LiquidGlassDefs />
      </div>
    </ShellContext.Provider>
  )
}

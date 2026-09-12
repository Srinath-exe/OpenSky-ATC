'use client'
/* First-run coach marks (UX 04 §8): five skippable tips that advance on their own when the player does the thing; persisted once seen. */
import * as React from 'react'
import styles from './HelpOverlay.module.css'
import { GlassPanel, Button, Kbd } from '@/design'
import { onboardingSeen, setOnboardingSeen } from '@/components/atc/persist'
import { sim, useSim } from '../hooks/useSimSelector'
import { useShell } from '../shellContext'

export const EV_REPLAY_TIPS = 'atc:replay-tips'
const STEPS = 5

export function OnboardingTips() {
  const shell = useShell()
  const hasEngine = useSim((s) => !!s.engine)
  const testMode = useSim((s) => s.testMode)
  const selectedId = useSim((s) => s.selectedId)
  const atcLines = useSim((s) => s.radio.reduce((n, l) => n + (l.who === 'ATC' ? 1 : 0), 0))
  const pilotLines = useSim((s) => s.radio.reduce((n, l) => n + (l.who === 'PILOT' && l.status !== undefined ? 1 : 0), 0))
  const firstDep = useSim((s) => s.aircraft().find((a) => a.plan.kind === 'departure')?.callsign ?? null)
  const depRunway = useSim((s) => s.runways().find((r) => r.activeDep)?.name ?? null)
  const delayS = useSim((s) => s.settings.pilotDelayS ?? 3)

  const [visible, setVisible] = React.useState(false)
  const [step, setStep] = React.useState(0)
  const stepRef = React.useRef(0)
  stepRef.current = step
  const base = React.useRef({ atc: 0, pilot: 0 })

  React.useEffect(() => {
    if (!hasEngine || testMode) return
    if (!onboardingSeen()) { setVisible(true); setStep(0) }
  }, [hasEngine, testMode])
  React.useEffect(() => {
    const replay = () => { setOnboardingSeen(false); setVisible(true); setStep(0) }
    window.addEventListener(EV_REPLAY_TIPS, replay)
    return () => window.removeEventListener(EV_REPLAY_TIPS, replay)
  }, [])

  const finish = React.useCallback(() => { setVisible(false); setOnboardingSeen(true) }, [])
  const next = React.useCallback(() => {
    base.current = { atc: sim.radio.filter((l) => l.who === 'ATC').length, pilot: sim.radio.filter((l) => l.who === 'PILOT' && l.status !== undefined).length }
    if (stepRef.current + 1 >= STEPS) finish()
    else setStep(stepRef.current + 1)
  }, [finish])

  // Auto-advance when the tip's action happened.
  React.useEffect(() => {
    if (!visible) return
    if (step === 0 && selectedId != null) next()
    else if (step === 1 && atcLines > base.current.atc) next()
    else if (step === 2 && pilotLines > base.current.pilot) next()
    else if (step === 3 && pilotLines > base.current.pilot) next()
  }, [visible, step, selectedId, atcLines, pilotLines, next])

  // Enter = next, Esc = skip (capture so the shell dispatcher does not also act); never while a panel or input has focus.
  React.useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      // only when nothing in a panel owns the keyboard (body or the map surface)
      const free = !t || t === document.body || !!t.closest?.('[data-region="map"], [data-onboarding]')
      if (!free) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish() }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [visible, finish, next])

  if (!visible || !hasEngine || shell.open.help || shell.open.pause) return null
  const cs = firstDep ?? 'the first departure'
  const rwy = depRunway ?? 'the active runway'
  const text: React.ReactNode[] = [
    <>This is <strong>{cs}</strong> — click it on the map or in the strip bay on the left.</>,
    <>Only valid actions show in the panel on the right. Press <Kbd>P</Kbd> or click <strong>Pushback approved</strong>, then transmit with <Kbd>Enter</Kbd>.</>,
    <>Pick the runway when asked — wind favours <strong>{rwy}</strong>. After transmitting you have <strong>{delayS} s</strong> to undo with <Kbd>U</Kbd>.</>,
    <>Listen for the readback in the comm log below — the clearance box on the strip ticks when it matches.</>,
    <>Try <Kbd>T</Kbd> to taxi. Tip: type taxiway letters in the command line (<Kbd>/</Kbd> focuses it) and <Kbd>?</Kbd> opens the full help.</>,
  ]
  return (
    <GlassPanel variant="lit" padding="tile" radius="inner" className={styles.tips} role="status" aria-live="polite" data-step={step} data-onboarding="true" testId={`tip-${step + 1}`}>
      <div className={styles.tipBody}>
        <span className={styles.tipText}>{text[step]}</span>
        <div className={styles.tipFoot}>
          <span className={styles.tipDots} aria-label={`Tip ${step + 1} of ${STEPS}`}>
            {Array.from({ length: STEPS }, (_, i) => <span key={i} className={styles.tipDot} data-on={i === step} data-done={i < step} data-testid={`tip-progress-${i + 1}`} />)}
          </span>
          <Button size="sm" variant="ghost" onClick={finish} testId="tip-skip-all">Skip</Button>
          <Button size="sm" variant="accent" onClick={next} testId="tip-next">{step + 1 >= STEPS ? 'Done' : 'Next'}</Button>
        </div>
      </div>
    </GlassPanel>
  )
}

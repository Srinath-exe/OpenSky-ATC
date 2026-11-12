'use client'
/* "Desktop required" holding screen below 1280 px (UX 04 §2.3, §G10): the game keeps running underneath; "Continue anyway" stores
   `skycontrol_allow_narrow` so the choice sticks. */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import styles from './HoldingScreen.module.css'
import { GlassPanel, Button, cx } from '@/design'
import { LS, readFlag, writeFlag } from '../persist'

export const MIN_GAME_WIDTH = 1280
const PHONE_WIDTH = 700

export function HoldingScreen() {
  const router = useRouter()
  const [width, setWidth] = React.useState<number | null>(null)
  const [allowed, setAllowed] = React.useState(true)
  React.useEffect(() => {
    setAllowed(readFlag(LS.allowNarrow))
    const measure = () => setWidth(window.innerWidth)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  if (width == null || width >= MIN_GAME_WIDTH || allowed) return null
  if (width < PHONE_WIDTH) return <PhoneScreen onContinue={() => { writeFlag(LS.allowNarrow, true); setAllowed(true) }} />
  return (
    <div className={styles.root} role="dialog" aria-modal="true" aria-labelledby="desktop-required-title" data-testid="desktop-required" data-width={width}>
      <GlassPanel variant="solid" title={<span id="desktop-required-title">Desktop required</span>} subtitle={`This window is ${width} px wide; the shift needs ${MIN_GAME_WIDTH} px`} className={styles.card} padding="card-lg" radius="card-lg">
        <div className={styles.body}>
          <div className={styles.preview} aria-hidden="true">
            <div className={styles.pNav} />
            <div className={styles.pBay}>
              <span className={cx(styles.pStrip, styles.pStrip1, styles.pStripLit)} />
              <span className={cx(styles.pStrip, styles.pStrip2)} />
              <span className={cx(styles.pStrip, styles.pStrip3)} />
            </div>
            <div className={styles.pRunway} />
            <span className={cx(styles.pDot, styles.pDot1)} />
            <span className={cx(styles.pDot, styles.pDot2)} />
            <div className={styles.pPanel} />
            <div className={styles.pLog} />
          </div>
          <p className={styles.text}>
            The strip bay, the map and the command panel sit side by side and need <strong>{MIN_GAME_WIDTH} px</strong> of width. Widen the window or lower the browser zoom. You can continue anyway; panels will overlap.
          </p>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => router.push('/start')} testId="desktop-required-home">Home</Button>
            <Button variant="secondary" onClick={() => { writeFlag(LS.allowNarrow, true); setAllowed(true) }} testId="desktop-required-continue">Continue anyway</Button>
          </div>
        </div>
      </GlassPanel>
    </div>
  )
}

/** Phones: the shift is played at a desk. Send the link on, or go back to the film and the training story. */
function PhoneScreen({ onContinue }: { onContinue: () => void }) {
  const router = useRouter()
  const [sent, setSent] = React.useState<string | null>(null)
  const share = async () => {
    const url = window.location.origin + '/start'
    try {
      if (navigator.share) { await navigator.share({ title: 'SKYCONTROL', text: 'Air traffic control at SFO, by voice, in the browser', url }); return }
      await navigator.clipboard.writeText(url); setSent('Link copied')
    } catch { /* closed the share sheet */ }
  }
  return (
    <div className={cx(styles.root, styles.phone)} role="dialog" aria-modal="true" aria-labelledby="phone-title" data-testid="desktop-required" data-phone="true">
      <div className={styles.phoneCard}>
        <p className={styles.phoneKicker}>SKYCONTROL · KSFO</p>
        <h2 id="phone-title" className={styles.phoneTitle}>The tower is on a computer.</h2>
        <p className={styles.phoneText}>Strips, radar and the radio sit side by side and need a laptop-wide screen, a keyboard and a microphone. Send yourself the link and open it at a desk.</p>
        <div className={styles.phoneActions}>
          <Button variant="accent" onClick={share} testId="phone-share">{sent ?? 'Send me the link'}</Button>
          <Button variant="secondary" onClick={() => router.push('/')} testId="phone-film">Watch the film</Button>
          <button type="button" className={styles.phoneAnyway} onClick={onContinue} data-testid="desktop-required-continue">Try it here anyway</button>
        </div>
      </div>
    </div>
  )
}

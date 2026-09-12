'use client'
/* "Desktop required" holding screen below 1280 px (UX 04 §2.3, §G10): the game keeps running underneath; "Continue anyway" stores
   `skycontrol_allow_narrow` so the choice sticks. */
import * as React from 'react'
import { useRouter } from 'next/navigation'
import styles from './HoldingScreen.module.css'
import { GlassPanel, Button, cx } from '@/design'
import { LS, readFlag, writeFlag } from '../persist'

export const MIN_GAME_WIDTH = 1280

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
            <Button variant="ghost" onClick={() => router.push('/')} testId="desktop-required-home">Home</Button>
            <Button variant="secondary" onClick={() => { writeFlag(LS.allowNarrow, true); setAllowed(true) }} testId="desktop-required-continue">Continue anyway</Button>
          </div>
        </div>
      </GlassPanel>
    </div>
  )
}

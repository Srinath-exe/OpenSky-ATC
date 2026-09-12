'use client'
import * as React from 'react'
import styles from './TxIndicator.module.css'
import { Icon, Tooltip } from '@/design'
import { sim, useSim } from '../hooks/useSimSelector'
import { useShellOptional } from '../shellContext'

const LIT_MS = 1200

/** `data-state="tx|idle"` while transmitting / PTT; `aria-pressed` mirrors the ATC voice (TTS) toggle. */
export function TxIndicator() {
  const shell = useShellOptional()
  const lastAtcKey = useSim((s) => {
    for (let i = s.radio.length - 1; i >= 0; i--) if (s.radio[i].who === 'ATC') return s.radio[i].key
    return -1
  })
  const tts = useSim((s) => s.tts)
  const [lit, setLit] = React.useState(false)
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) { first.current = false; return }
    if (lastAtcKey < 0) return
    setLit(true)
    const t = setTimeout(() => setLit(false), LIT_MS)
    return () => clearTimeout(t)
  }, [lastAtcKey])
  const on = lit || !!shell?.ptt
  return (
    <Tooltip content={tts ? 'ATC voice on' : 'ATC voice off'} placement="bottom">
      <button
        type="button"
        className={styles.tx}
        data-state={on ? 'tx' : 'idle'}
        data-voice={tts ? 'on' : 'off'}
        aria-pressed={tts}
        aria-label={`Transmit indicator, ${on ? 'transmitting' : 'idle'}. ATC voice ${tts ? 'on' : 'off'}`}
        onClick={() => sim.toggleTTS()}
        data-testid="tx-indicator"
      >
        <span className={styles.dot} aria-hidden="true" />
        <span>TX</span>
        <span className={styles.wave} aria-hidden="true"><span className={styles.bar} /><span className={styles.bar} /><span className={styles.bar} /></span>
        <span className={styles.voice} aria-hidden="true"><Icon name={tts ? 'volume-2' : 'volume-x'} size={14} /></span>
      </button>
    </Tooltip>
  )
}

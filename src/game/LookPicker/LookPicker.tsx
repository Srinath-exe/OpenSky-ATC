'use client'
/* First game only: the player picks how the map looks (WorldMap/cinematic.ts) before the coach marks start. Both
   looks share the live sky and weather; Cinematic adds the filmic finish. Changeable any time in Settings > Graphics. */
import * as React from 'react'
import styles from './LookPicker.module.css'
import { Modal } from '@/design'
import { useSim } from '../hooks/useSimSelector'
import { setLook, useLook, useLookChosen, type Look } from '@/components/atc/WorldMap/cinematic'

const LOOKS: { id: Look; name: string; line: string }[] = [
  { id: 'standard', name: 'Standard', line: 'Clean and true to life. Sharpest for long shifts.' },
  { id: 'cinematic', name: 'Cinematic', line: 'Glowing lights, rich colour, a film grade. Made for watching.' },
]

export function LookPicker() {
  const hasEngine = useSim((s) => !!s.engine)
  const testMode = useSim((s) => s.testMode)
  const chosen = useLookChosen()
  const current = useLook()
  const [pick, setPick] = React.useState<Look>(current)
  const open = hasEngine && !testMode && !chosen
  return (
    <Modal open={open} onClose={() => setLook(pick)} title="How should your airport look?" wide dismissOnScrim={false}
      confirmLabel={`Use ${pick === 'cinematic' ? 'Cinematic' : 'Standard'}`} cancelLabel="" onConfirm={() => setLook(pick)}
      footerLeft={<span className={styles.note}>Change it any time in Settings › Graphics</span>} testId="look-picker">
      <div className={styles.grid} role="radiogroup" aria-label="Map look">
        {LOOKS.map((l) => (
          <button key={l.id} type="button" role="radio" aria-checked={pick === l.id} className={styles.card} data-on={pick === l.id || undefined}
            onClick={() => setPick(l.id)} onDoubleClick={() => setLook(l.id)} data-testid={`look-${l.id}`}>
            <img className={styles.img} src={`/looks/${l.id}.jpg`} alt={`The airport in the ${l.name} look`} width={640} height={360} />
            <span className={styles.name}>{l.name}</span>
            <span className={styles.line}>{l.line}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

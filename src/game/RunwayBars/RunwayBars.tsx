'use client'
/* Tower runway status bars (UX 04 §2.2, 03 §2.7 wake timer): one pill per active end — free / lined-up / occupied / closed,
   the occupant, and the wake-turbulence countdown after a heavy departs (`wake-timer-{rwy}`). Bottom-centre of the map. */
import * as React from 'react'
import styles from './RunwayBars.module.css'
import { cx } from '@/design'
import { useSim } from '../hooks/useSimSelector'
import { runwayOccupancy, type RunwayOccupancy } from '@/components/atc/GroundView/runwayStatus'

function mmss(s: number): string { const m = Math.floor(s / 60), r = Math.max(0, Math.round(s - m * 60)); return `${m}:${String(r).padStart(2, '0')}` }

export function RunwayBars() {
  const position = useSim((s) => s.position)
  const rows = useSim((s) => (s.engine ? runwayOccupancy(s.engine).filter((r) => r.activeDep || r.activeArr) : []) as RunwayOccupancy[])
  if (position !== 'tower' || !rows.length) return null
  return (
    <div className={styles.row} data-testid="runway-bars" aria-label="Runway status">
      {rows.map((r) => {
        const label = r.state === 'closed' ? r.status : r.state === 'emerg' ? 'sterile' : r.state === 'lined' ? 'lined up' : r.state === 'occupied' ? 'occupied' : r.arrivalOnFinalNM != null && r.arrivalOnFinalNM <= 4 ? `final ${r.arrivalOnFinalNM.toFixed(1)}` : 'free'
        return (
          <div key={r.name} className={cx(styles.bar, styles[r.state])} data-testid={`runway-bar-${r.name}`} data-state={r.state}>
            <span className={styles.name}>{r.name}</span>
            <span className={styles.state} data-testid={`runway-bar-${r.name}-state`}>{label}</span>
            {r.occupant ? <span className={styles.occ}>{r.occupant}</span> : null}
            {r.wakeRemainingS > 0 ? (
              <span className={styles.wake} data-testid={`wake-timer-${r.name}`} data-value={Math.ceil(r.wakeRemainingS)} title="Wake turbulence separation">WT {mmss(r.wakeRemainingS)}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

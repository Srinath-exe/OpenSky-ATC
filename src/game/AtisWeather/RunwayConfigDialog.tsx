'use client'
/* Runway configuration dialog (UX 04 §10 "ATIS": rwycfg-*, airport-dialog; G3 apply-when-clear). */
import * as React from 'react'
import styles from './AtisWeather.module.css'
import { Modal, Button, Pill, Checkbox } from '@/design'
import type { RunwayState } from '@/lib/sim/types'
import type { WeightClass } from '@/lib/sim/aircraftDB'
import { sim, useSim } from '../hooks/useSimSelector'

const WEIGHTS: Array<{ cls: WeightClass; label: string }> = [
  { cls: 'L', label: 'L' }, { cls: 'M', label: 'M' }, { cls: 'H', label: 'H' }, { cls: 'S', label: 'J' },
]
const ALL_WEIGHTS: WeightClass[] = ['L', 'M', 'H', 'S']

interface EndDraft { dep: boolean; arr: boolean; weights: WeightClass[] }

function draftFrom(rwys: RunwayState[]): Record<string, EndDraft> {
  const d: Record<string, EndDraft> = {}
  for (const r of rwys) d[r.name] = { dep: r.activeDep, arr: r.activeArr, weights: r.weightAllow ? [...r.weightAllow] : [...ALL_WEIGHTS] }
  return d
}

function windText(r: RunwayState): { text: string; tail: boolean } {
  const head = Math.round(r.windHeadKt)
  const cross = Math.round(Math.abs(r.windCrossKt))
  const tail = head < -5
  return { text: `${head >= 0 ? 'Head' : 'Tail'} ${Math.abs(head)} kt · Cross ${cross} kt`, tail }
}

function applyDraft(draft: Record<string, EndDraft>) {
  const dep = Object.entries(draft).filter(([, v]) => v.dep).map(([k]) => k)
  const arr = Object.entries(draft).filter(([, v]) => v.arr).map(([k]) => k)
  const weights: Record<string, WeightClass[]> = {}
  let anyWeight = false
  for (const [k, v] of Object.entries(draft)) if (v.weights.length < ALL_WEIGHTS.length) { weights[k] = v.weights; anyWeight = true }
  sim.engine?.setRunwayWeightAllow(anyWeight ? weights : null)
  sim.setActiveRunways(dep, arr)
}

export function RunwayConfigDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rwys = useSim((s) => s.runways())
  const [draft, setDraft] = React.useState<Record<string, EndDraft>>({})
  const [whenClear, setWhenClear] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  React.useEffect(() => { if (open) { setDraft(draftFrom(sim.runways())); setWhenClear(false); setPending(false) } }, [open])

  const depCount = Object.values(draft).filter((d) => d.dep).length
  const arrCount = Object.values(draft).filter((d) => d.arr).length
  const blocked = depCount === 0 ? 'Select at least one departure runway' : arrCount === 0 ? 'Select at least one arrival runway' : null
  const setEnd = (name: string, patch: Partial<EndDraft>) => setDraft((d) => ({ ...d, [name]: { ...d[name], ...patch } }))
  const toggleWeight = (name: string, cls: WeightClass) => setDraft((d) => {
    const cur = d[name].weights
    const next = cur.includes(cls) ? cur.filter((c) => c !== cls) : [...cur, cls]
    return { ...d, [name]: { ...d[name], weights: next.length ? next : cur } }
  })

  // G3: apply when every runway is physically clear (poll the engine each second).
  React.useEffect(() => {
    if (!pending) return
    const tick = () => {
      const e = sim.engine
      if (!e) { setPending(false); return }
      const busy = e.runwayStates().some((r) => r.occupiedBy.length > 0)
      if (!busy) { applyDraft(draft); setPending(false); onClose() }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [pending, draft, onClose])

  const apply = () => {
    if (blocked) return
    if (whenClear) { setPending(true); return }
    applyDraft(draft)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Active runways"
      showClose
      wide
      testId="airport-dialog"
      footerLeft={
        <span className={styles.cfgFooterLeft}>
          <Checkbox checked={whenClear} onChange={setWhenClear} label="Apply when runways are clear" testId="rwycfg-apply-when-clear" />
          {blocked ? <span className={styles.blocked} data-testid="rwycfg-blocked-reason">{blocked}</span> : null}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} testId="rwycfg-cancel">Cancel</Button>
          <Button variant="accent" onClick={apply} disabled={!!blocked} loading={pending} testId="rwycfg-apply">{pending ? 'Waiting for clear' : 'Apply'}</Button>
        </>
      }
    >
      <div className={styles.cfgRows} role="group" aria-label="Runway ends">
        {rwys.map((r) => {
          const d = draft[r.name]
          if (!d) return null
          const w = windText(r)
          return (
            <div key={r.name} className={styles.cfgRow} data-testid={`rwycfg-end-${r.name}`}>
              <span className={styles.cfgName}>{r.name}</span>
              <span className={styles.cfgMeta}>
                <span className={styles.cfgSub}>{String(Math.round(r.headingMag)).padStart(3, '0')}° · {Math.round(r.lengthM)} m · {r.hasIls ? (r.ilsEstimated ? 'ILS (est.)' : 'ILS') : 'no ILS'} · {r.status}</span>
                <span className={styles.cfgSub} data-tail={w.tail}>{w.text}</span>
              </span>
              <span className={styles.cfgControls}>
                <span className={styles.cfgRoles}>
                  <Pill size="s" tone={d.dep ? 'orange' : 'outline'} interactive selected={d.dep} aria-pressed={d.dep} onClick={() => setEnd(r.name, { dep: !d.dep })} testId={`rwycfg-end-${r.name}-dep`}>DEP</Pill>
                  <Pill size="s" tone={d.arr ? 'orange' : 'outline'} interactive selected={d.arr} aria-pressed={d.arr} onClick={() => setEnd(r.name, { arr: !d.arr })} testId={`rwycfg-end-${r.name}-arr`}>ARR</Pill>
                </span>
                <span className={styles.cfgWeights} role="group" aria-label={`Allowed weight classes ${r.name}`}>
                  {WEIGHTS.map((wc) => (
                    <Pill key={wc.cls} size="xs" tone={d.weights.includes(wc.cls) ? 'solid' : 'dim'} interactive selected={d.weights.includes(wc.cls)} aria-pressed={d.weights.includes(wc.cls)} onClick={() => toggleWeight(r.name, wc.cls)} testId={`rwycfg-end-${r.name}-weight-${wc.label}`}>{wc.label}</Pill>
                  ))}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

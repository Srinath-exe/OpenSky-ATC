'use client'
/*
  Vehicles panel (UX 04 §6 ground vehicles UX, §2.1 "Vehicles panel", §10 "Vehicles panel" ids). Ground / Tower only.
  Fleet list from sim.vehicles() with state chips + ETA + target; dispatch flow (vehicles -> target: selected
  aircraft / runway end / stand / station -> confirm -> sim.dispatchVehicle); recall (sim.recallVehicle); hold /
  continue / cross radio ops (vehicleOp AST); ARFF quick-dispatch for the aircraft in emergency (btn-arff-dispatch);
  runway-inspection hint when an OPS car is sent to a runway (status inspection -> open).
*/
import * as React from 'react'
import styles from './VehiclePanel.module.css'
import { GlassPanel, Button, IconButton, Pill, Kbd, Input, ScrollArea, Icon, IconX, IconSiren, IconCheck, cx } from '@/design'
import type { AircraftState, Vehicle, VehicleTarget, VehicleType } from '@/lib/sim/types'
import { sim, useSim } from '../CommandPanel/store'
import { fmtMMSS } from '../CommandPanel/format'
import { vehicleGlyph, VEHICLE_STATE_LABEL } from '../CommandPanel/pickers'
import { onMapTap } from '../CommandPanel/bus'
import { useShellOptional } from '../shellContext'

type TargetKind = 'aircraft' | 'runway' | 'stand' | 'map' | 'station'
type FlowStep = 'vehicles' | 'target' | 'confirm'
interface Flow { step: FlowStep; ids: string[]; kind: TargetKind | null; runway: string | null; stand: string; aircraftId: number | null; point: { x: number; y: number } | null }

const TYPE_LABEL: Record<VehicleType, string> = { arff: 'ARFF', ambulance: 'Ambulance', followme: 'Follow-me', tug: 'Tug', fuel: 'Fuel', deice: 'De-ice', ops: 'Ops', sweeper: 'Sweeper', bird: 'Bird control' }
const TYPE_ORDER: VehicleType[] = ['arff', 'ambulance', 'followme', 'tug', 'ops', 'sweeper', 'bird', 'fuel', 'deice']

export interface VehiclePanelProps {
  className?: string
  /** Called by the close button; defaults to hiding the shell's `vehicles` overlay. */
  onClose?: () => void
}

function targetLabel(t: VehicleTarget | null): string {
  if (!t) return ''
  switch (t.kind) {
    case 'runway': return `RWY ${t.runway}`
    case 'aircraft': return t.callsign
    case 'stand': return `STAND ${t.ref}`
    case 'point': return 'map point'
    case 'station': return 'station'
  }
}

function emergencyAircraft(list: AircraftState[], selectedId: number | null): AircraftState | null {
  const active = list.filter((a) => a.emergency && a.emergency.status !== 'resolved' && a.emergency.status !== 'stopped')
  if (!active.length) return null
  return active.find((a) => a.id === selectedId) ?? active[0]
}

function emergencyTarget(a: AircraftState): VehicleTarget {
  const rwy = a.emergency?.runway ?? (a.plan.kind === 'arrival' || a.ilsArmed ? a.assignedRunway ?? a.plan.runway ?? null : a.plan.runway ?? null)
  return rwy ? { kind: 'runway', runway: rwy } : { kind: 'aircraft', id: a.id, callsign: a.callsign }
}

export function VehiclePanel({ className, onClose }: VehiclePanelProps) {
  const shell = useShellOptional()
  const vehicles = useSim((s) => s.vehicles())
  const runways = useSim((s) => s.runways())
  const aircraft = useSim((s) => s.aircraft())
  const selectedId = useSim((s) => s.selectedId)
  const time = useSim((s) => Math.floor(s.time()))
  const [flow, setFlow] = React.useState<Flow | null>(null)
  const [result, setResult] = React.useState<{ ok: boolean; text: string; k: number } | null>(null)
  const close = onClose ?? (() => shell?.hide('vehicles'))

  const selected = selectedId != null ? aircraft.find((a) => a.id === selectedId) ?? null : null
  const emerg = emergencyAircraft(aircraft, selectedId)
  const sorted = React.useMemo(() => [...vehicles].sort((x, y) => TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type) || x.id.localeCompare(y.id)), [vehicles])
  const responding = vehicles.filter((v) => v.state !== 'standby').length

  React.useEffect(() => onMapTap((d) => setFlow((f) => (f && f.step === 'target' ? { ...f, kind: 'map', point: { x: d.x, y: d.y } } : f))), [])

  const report = (ok: boolean, text: string) => setResult({ ok, text, k: Date.now() })

  const startFlow = (ids: string[] = [], step: FlowStep = ids.length ? 'target' : 'vehicles') => {
    const first = ids[0] ? vehicles.find((v) => v.id === ids[0]) : null
    const kind: TargetKind | null = selected ? 'aircraft' : first && (first.type === 'ops' || first.type === 'arff' || first.type === 'sweeper' || first.type === 'bird') ? 'runway' : null
    setFlow({ step, ids, kind, runway: kind === 'runway' ? (runways.find((r) => r.activeDep)?.name ?? runways[0]?.name ?? null) : null, stand: '', aircraftId: selected?.id ?? null, point: null })
    setResult(null)
  }
  const toggleId = (id: string) => setFlow((f) => (f ? { ...f, ids: f.ids.includes(id) ? f.ids.filter((x) => x !== id) : [...f.ids, id] } : f))

  const flowTarget = (f: Flow): VehicleTarget | null => {
    switch (f.kind) {
      case 'aircraft': { const a = f.aircraftId != null ? aircraft.find((x) => x.id === f.aircraftId) : null; return a ? { kind: 'aircraft', id: a.id, callsign: a.callsign } : null }
      case 'runway': return f.runway ? { kind: 'runway', runway: f.runway } : null
      case 'stand': return f.stand.trim() ? { kind: 'stand', ref: f.stand.trim().toUpperCase() } : null
      case 'map': return f.point ? { kind: 'point', xy: f.point } : null
      case 'station': return { kind: 'station' }
      default: return null
    }
  }

  const dispatch = (ids: string[], target: VehicleTarget) => {
    const okIds: string[] = []
    const errors: string[] = []
    let eta: number | null = null
    for (const id of ids) {
      if (target.kind === 'station') { if (sim.recallVehicle(id).ok) okIds.push(id); else errors.push(id); continue }
      const r = sim.dispatchVehicle(id, target)
      if (r.ok) { okIds.push(id); const v = sim.engine?.fleet.byId(id); if (v?.etaAt != null) eta = Math.max(eta ?? 0, v.etaAt - sim.time()) } else errors.push(`${id}: ${r.reason ?? r.code}`)
    }
    const names = okIds.map((id) => vehicles.find((v) => v.id === id)?.callsign ?? id).join(', ')
    if (okIds.length) report(!errors.length, `${names} → ${targetLabel(target)}${eta != null ? ` · ETA ${fmtMMSS(eta)}` : ''}${errors.length ? ` · ${errors.join('; ')}` : ''}`)
    else report(false, errors.join('; ') || 'Nothing dispatched')
    setFlow(null)
  }

  const quickArff = () => {
    if (!emerg) return
    const r = sim.dispatchVehicle('arff', emergencyTarget(emerg))
    report(r.ok, r.ok ? `ARFF dispatched → ${targetLabel(emergencyTarget(emerg))} for ${emerg.callsign}` : (r.reason ?? r.code))
  }

  const arffOnScene = emerg ? vehicles.filter((v) => v.type === 'arff' && v.state !== 'standby').length : 0
  const flowTargetValue = flow ? flowTarget(flow) : null
  const flowVehicles = flow ? flow.ids.map((id) => vehicles.find((v) => v.id === id)).filter((v): v is Vehicle => !!v) : []
  const inspection = flow?.kind === 'runway' && flowVehicles.some((v) => v.type === 'ops' || v.type === 'sweeper')
  const closesRunway = flow?.kind === 'runway' && flowVehicles.some((v) => v.type === 'arff' || v.type === 'sweeper')

  return (
    <GlassPanel
      variant="glass-strong"
      padding="card"
      radius="card-lg"
      className={cx(styles.panel, className)}
      role="dialog"
      aria-label="Vehicles"
      title="Vehicles"
      parenthetical={`(${responding} responding)`}
      headerRight={<IconButton size={32} variant="ghost" label="Close" icon={<IconX />} onClick={close} testId="veh-panel-close" />}
      testId="vehicle-panel"
      data-responding={responding}
    >
      <div className={styles.body}>
        {emerg ? (
          <div className={styles.emerg} data-testid="veh-emergency" data-callsign={emerg.callsign}>
            <div className={styles.emergHead}><IconSiren size={16} /> {emerg.emergency!.level} · {emerg.callsign}</div>
            <div className={styles.emergText}>{emerg.emergency!.type.replace(/_/g, ' ')} · target {targetLabel(emergencyTarget(emerg))}{arffOnScene ? ` · ${arffOnScene} ARFF responding` : ''}</div>
            <div className={styles.row}>
              <Button variant="danger" size="sm" iconLeft={<IconSiren size={14} />} onClick={quickArff} disabled={!vehicles.some((v) => v.type === 'arff' && v.state === 'standby')} testId="btn-arff-dispatch">Send ARFF <Kbd>M,D</Kbd></Button>
              {emerg.emergency!.type === 'medical' || emerg.emergency!.type === 'smoke' ? <Button variant="secondary" size="sm" onClick={() => dispatch(vehicles.filter((v) => v.type === 'ambulance' && v.state === 'standby').map((v) => v.id), emergencyTarget(emerg))} disabled={!vehicles.some((v) => v.type === 'ambulance' && v.state === 'standby')} testId="btn-ambulance-dispatch">Ambulance</Button> : null}
            </div>
          </div>
        ) : null}

        {result ? (
          <div className={styles.result} role="status" data-ok={result.ok ? 'true' : 'false'} data-testid="veh-result">
            {result.ok ? <IconCheck size={14} /> : <Icon name="circle-alert" size={14} />}<span>{result.text}</span>
          </div>
        ) : null}

        {flow ? (
          <div
            className={styles.flow}
            data-testid="veh-flow"
            data-step={flow.step}
            data-picker="true"
            onKeyDown={(e) => {
              if (e.target instanceof HTMLInputElement && e.key !== 'Enter' && e.key !== 'Escape') return
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFlow(null) }
              else if (e.key === 'Enter') {
                e.preventDefault(); e.stopPropagation()
                if (flow.step === 'vehicles' && flow.ids.length) setFlow({ ...flow, step: 'target' })
                else if (flow.step === 'target' && flowTargetValue) setFlow({ ...flow, step: 'confirm' })
                else if (flow.step === 'confirm' && flowTargetValue) dispatch(flow.ids, flowTargetValue)
              }
            }}
          >
            <div className={styles.row}>
              <span className={styles.flowTitle}>{flow.step === 'vehicles' ? '1 · Vehicles' : flow.step === 'target' ? '2 · Target' : '3 · Confirm'}</span>
              <span className={styles.spacer} />
              <Button size="sm" variant="ghost" onClick={() => setFlow(null)} testId="veh-cancel">Cancel <Kbd>Esc</Kbd></Button>
            </div>
            {flow.step === 'vehicles' ? (
              <>
                <div className={styles.list} role="listbox" aria-multiselectable aria-label="Vehicles">
                  {sorted.map((v) => (
                    <VehicleCard key={v.id} v={v} time={time} selectable selected={flow.ids.includes(v.id)} onToggle={() => toggleId(v.id)} />
                  ))}
                </div>
                <div className={styles.footer}>
                  <span className={styles.hint}>{flow.ids.length} selected</span>
                  <span className={styles.spacer} />
                  <Button size="sm" variant="accent" disabled={!flow.ids.length} onClick={() => setFlow({ ...flow, step: 'target' })} testId="veh-next">Next</Button>
                </div>
              </>
            ) : null}
            {flow.step === 'target' ? (
              <>
                <div className={styles.row} role="radiogroup" aria-label="Target type">
                  <Pill size="s" tone={flow.kind === 'aircraft' ? 'orange' : 'neutral'} interactive selected={flow.kind === 'aircraft'} disabled={!selected} onClick={() => setFlow({ ...flow, kind: 'aircraft', aircraftId: selected?.id ?? null })} testId="veh-target-aircraft">{selected ? selected.callsign : 'aircraft'}</Pill>
                  <Pill size="s" tone={flow.kind === 'runway' ? 'orange' : 'neutral'} interactive selected={flow.kind === 'runway'} onClick={() => setFlow({ ...flow, kind: 'runway', runway: flow.runway ?? runways[0]?.name ?? null })} testId="veh-target-runway">runway</Pill>
                  <Pill size="s" tone={flow.kind === 'stand' ? 'orange' : 'neutral'} interactive selected={flow.kind === 'stand'} onClick={() => setFlow({ ...flow, kind: 'stand' })} testId="veh-target-stand">stand</Pill>
                  <Pill size="s" tone={flow.kind === 'map' ? 'orange' : 'neutral'} interactive selected={flow.kind === 'map'} onClick={() => setFlow({ ...flow, kind: 'map' })} testId="veh-target-map">map point</Pill>
                  <Pill size="s" tone={flow.kind === 'station' ? 'orange' : 'neutral'} interactive selected={flow.kind === 'station'} onClick={() => setFlow({ ...flow, kind: 'station' })} testId="veh-target-station">station</Pill>
                </div>
                {flow.kind === 'runway' ? (
                  <div className={styles.grid} role="radiogroup" aria-label="Runway end">
                    {runways.map((r) => (
                      <button key={r.name} type="button" className={styles.runwayChip} aria-pressed={flow.runway === r.name} onClick={() => setFlow({ ...flow, runway: r.name })} data-testid={`veh-target-runway-${r.name}`} data-status={r.status}>
                        <span className={styles.runwayName}>{r.name}</span>
                        <span className={styles.runwayStatus} data-status={r.status}>{r.status}{r.occupiedBy.length ? ` · ${r.occupiedBy[0].callsign}` : ''}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {flow.kind === 'stand' ? <Input size="m" surface="glass" value={flow.stand} onChange={(e) => setFlow({ ...flow, stand: e.target.value.toUpperCase() })} placeholder="Stand ref, e.g. 512" aria-label="Stand" fullWidth testId="veh-target-stand-input" autoComplete="off" data-hotkeys="off" /> : null}
                {flow.kind === 'map' ? <span className={cx(styles.hint, !flow.point && styles.hintOrange)} data-testid="veh-map-point-marker" data-set={flow.point ? 'true' : 'false'}>{flow.point ? `Point set (${Math.round(flow.point.x)}, ${Math.round(flow.point.y)} m)` : 'Click the map to drop the marker'}</span> : null}
                {flow.kind === 'aircraft' && !selected ? <span className={cx(styles.hint, styles.hintOrange)}>Select an aircraft first</span> : null}
                {inspection ? <span className={cx(styles.hint, styles.hintOrange)} data-testid="veh-inspection-hint">Runway {flow.runway} goes to INSPECTION while the car drives its length, then reopens.</span> : closesRunway && flow.kind === 'runway' ? <span className={cx(styles.hint, styles.hintOrange)} data-testid="veh-closure-hint">Runway {flow.runway} stays closed while a vehicle is on it; reopen it explicitly afterwards.</span> : null}
                <div className={styles.footer}>
                  <Button size="sm" variant="ghost" onClick={() => setFlow({ ...flow, step: 'vehicles' })} testId="veh-back">Back</Button>
                  <span className={styles.spacer} />
                  <Button size="sm" variant="accent" disabled={!flowTargetValue} onClick={() => setFlow({ ...flow, step: 'confirm' })} testId="veh-next">Next</Button>
                </div>
              </>
            ) : null}
            {flow.step === 'confirm' && flowTargetValue ? (
              <>
                <div className={styles.summary} data-testid="veh-summary">{flowVehicles.map((v) => v.callsign).join(', ')} → {targetLabel(flowTargetValue)}</div>
                {inspection ? <span className={styles.hint} data-testid="veh-inspection-hint">Runway status: inspection → open when the car clears.</span> : null}
                <div className={styles.footer}>
                  <Button size="sm" variant="ghost" onClick={() => setFlow({ ...flow, step: 'target' })} testId="veh-back">Back</Button>
                  <span className={styles.spacer} />
                  <span data-testid="veh-confirm">
                    <Button size="sm" variant="accent" iconLeft={<Icon name="corner-down-left" size={14} />} onClick={() => dispatch(flow.ids, flowTargetValue)} testId="vehicle-dispatch">Dispatch <Kbd>Enter</Kbd></Button>
                  </span>
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className={styles.row}>
            <Button size="sm" variant="accent" iconLeft={<Icon name="route" size={14} />} onClick={() => startFlow()} disabled={!vehicles.length} testId="veh-new-dispatch">Dispatch…</Button>
            <span className={styles.hint}>{vehicles.length ? `${vehicles.length - responding} at station` : 'No fleet at this airport'}</span>
          </div>
        )}

        <ScrollArea className={styles.scroll} fade>
          <div className={styles.list} data-testid="vehicle-list">
            {sorted.map((v) => (
              <VehicleCard key={v.id} v={v} time={time} onDispatch={() => startFlow([v.id])} onRetask={() => startFlow([v.id], 'target')} />
            ))}
            {!sorted.length ? <span className={styles.hint}>No vehicles available.</span> : null}
          </div>
        </ScrollArea>

        <RunwayStatusRow runways={runways} />
      </div>
    </GlassPanel>
  )
}

function VehicleCard({ v, time, selectable = false, selected = false, onToggle, onDispatch, onRetask }: { v: Vehicle; time: number; selectable?: boolean; selected?: boolean; onToggle?: () => void; onDispatch?: () => void; onRetask?: () => void }) {
  const eta = v.etaAt != null && v.state === 'enroute' ? Math.max(0, v.etaAt - time) : null
  const holding = !!v.holdShortRunway && !v.holdReleased && v.state === 'enroute'
  const tone = v.state === 'onscene' ? 'green' : v.state === 'enroute' ? 'orange' : v.state === 'returning' ? 'solid' : 'dim'
  const op = (o: 'hold' | 'continue' | 'cross' | 'rtb') => sim.dispatchAst({ kind: 'vehicleOp', id: v.id, op: o, runway: o === 'cross' ? v.holdShortRunway : null })
  const Root = selectable ? 'button' : 'div'
  return (
    <Root
      type={selectable ? 'button' : undefined}
      role={selectable ? 'option' : undefined}
      aria-selected={selectable ? selected : undefined}
      className={styles.card}
      onClick={selectable ? onToggle : undefined}
      data-testid={selectable ? `veh-pick-${v.id}` : `vehicle-${v.id}`}
      data-state={v.state}
      data-type={v.type}
      data-selected={selected ? 'true' : undefined}
      aria-label={`${v.callsign} ${TYPE_LABEL[v.type]} ${VEHICLE_STATE_LABEL[v.state]}`}
    >
      <span className={styles.glyph}>{selectable ? <span className={styles.check} data-on={selected ? 'true' : 'false'}>{selected ? <IconCheck size={12} /> : null}</span> : vehicleGlyph(v.type, 18)}</span>
      <span className={styles.main} data-testid={selectable ? undefined : `veh-card-${v.id}`}>
        <span className={styles.name}>{v.callsign} <span className={styles.typeTag}>{TYPE_LABEL[v.type]}</span></span>
        <span className={styles.sub}>
          <span data-testid={selectable ? undefined : `veh-card-${v.id}-status`} data-state={v.state}>{VEHICLE_STATE_LABEL[v.state]}</span>
          {v.target ? ` → ${targetLabel(v.target)}` : ''}
          {eta != null ? <> · ETA <span data-testid={selectable ? undefined : `veh-card-${v.id}-eta`} data-value={Math.round(eta)}>{fmtMMSS(eta)}</span></> : null}
          {holding ? ` · holding short ${v.holdShortRunway}` : v.onRunway ? ` · on RWY ${v.onRunway}` : ''}
        </span>
      </span>
      <span className={styles.actions}>
        {v.type === 'arff' && !selectable ? <Pill size="xs" tone={tone} uppercase testId={`arff-vehicle-${v.id}`} data-state={v.state}>{VEHICLE_STATE_LABEL[v.state]}</Pill> : selectable ? <Pill size="xs" tone={tone} uppercase>{VEHICLE_STATE_LABEL[v.state]}</Pill> : null}
        {!selectable && v.state === 'standby' ? <Button size="sm" variant="secondary" onClick={onDispatch} testId={`veh-card-${v.id}-dispatch`}>Dispatch</Button> : null}
        {!selectable && v.state !== 'standby' ? (
          <>
            {holding ? <Button size="sm" variant="accent" onClick={() => op('cross')} testId={`veh-card-${v.id}-cross`}>Cross {v.holdShortRunway}</Button> : null}
            {v.state === 'enroute' && !holding ? (v.trafficHold ? <Button size="sm" variant="secondary" onClick={() => op('continue')} testId={`veh-card-${v.id}-continue`}>Continue</Button> : <Button size="sm" variant="secondary" onClick={() => op('hold')} testId={`veh-card-${v.id}-hold`}>Hold</Button>) : null}
            <Button size="sm" variant="ghost" onClick={onRetask} testId={`veh-card-${v.id}-retask`}>Re-task</Button>
            <span data-testid={`veh-card-${v.id}-recall`}>
              <Button size="sm" variant="secondary" onClick={() => sim.recallVehicle(v.id)} disabled={v.state === 'returning'} testId={`vehicle-recall-${v.id}`}>Recall</Button>
            </span>
          </>
        ) : null}
      </span>
    </Root>
  )
}

function RunwayStatusRow({ runways }: { runways: ReturnType<typeof sim.runways> }) {
  const notOpen = runways.filter((r) => r.status !== 'open')
  const seen = new Set<string>()
  const rows = notOpen.filter((r) => { if (seen.has(r.ref)) return false; seen.add(r.ref); return true })
  if (!rows.length) return <div className={styles.status}><span className={styles.hint}>All runways open</span></div>
  return (
    <div className={styles.status} aria-label="Runway status">
      {rows.map((r) => (
        <Pill key={r.ref} size="xs" tone={r.status === 'inspection' ? 'orange' : 'red'} uppercase interactive onClick={() => sim.setRunwayStatus(r.name, 'open', 'controller')} title="Click to reopen" testId={`veh-runway-${r.name}-status`} data-status={r.status}>{r.ref} · {r.status}</Pill>
      ))}
    </div>
  )
}

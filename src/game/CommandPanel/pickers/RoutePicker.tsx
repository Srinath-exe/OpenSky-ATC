'use client'
/*
  picker-taxiroute (UX §1.2, §G4): ordered taxiway chips, AUTO / CLEAR, hold-short and cross-runway
  pills, intersection target, "contact tower at hold" toggle, via-taxiway rail (engine.air.taxiwayNames),
  typed letters + Space/Enter, Backspace removes the last chip. Map taps arrive as "atc:route-tap" events.
*/
import * as React from 'react'
import s from './pickers.module.css'
import { Pill, Button, IconChevronRight, IconX, IconMap, cx } from '@/design'
import type { HoldShortTarget } from '@/lib/sim/commandAst'
import { makeAst } from '@/lib/sim/commandAst'
import { onRouteTap } from '../bus'
import type { PickerProps } from './types'

type Route = NonNullable<PickerProps<'taxiway-route'>['params']['route']>
const MAX = 12

export function RoutePicker({ step, params, onChange, onAccept, ctx, a }: PickerProps<'taxiway-route'>) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [typed, setTyped] = React.useState('')
  const [menu, setMenu] = React.useState<'hold' | 'cross' | 'intersection' | null>(null)
  const route: Route = params.route ?? { via: [], auto: true, holdShortOf: null, cross: [], intersection: null }
  const set = (patch: Partial<Route>) => onChange({ route: { ...route, ...patch } })
  const twys = step.taxiways
  const valid = (name: string) => twys.length === 0 || twys.includes(name)

  const append = (name: string) => {
    const n = name.toUpperCase().trim()
    if (!n || !valid(n) || route.via.length >= Math.min(MAX, step.maxChips)) return
    if (route.via[route.via.length - 1] === n) return
    set({ via: [...route.via, n], auto: false })
    setTyped('')
  }
  const removeFrom = (i: number) => set({ via: route.via.slice(0, i), auto: i === 0 })
  const clear = () => set({ via: [], auto: false })
  const auto = () => set({ via: [], auto: true })

  React.useEffect(() => onRouteTap(d => {
    if (d.taxiway) append(d.taxiway)
    else if (d.runway && step.allowHoldShort) set({ holdShortOf: { kind: 'runway', runway: d.runway.toUpperCase() } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [route, step.allowHoldShort])

  React.useEffect(() => {
    document.body.dataset.routeBuild = '1'
    inputRef.current?.focus({ preventScroll: true })
    return () => { delete document.body.dataset.routeBuild }
  }, [])

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      if (typed.trim()) { append(typed); return }
      onAccept(); return
    }
    if (e.key === ' ' || e.key === ',') { e.preventDefault(); if (typed.trim()) append(typed); return }
    if (e.key === 'Backspace' && !typed) { e.preventDefault(); e.stopPropagation(); if (route.via.length) removeFrom(route.via.length - 1); return }
    if (e.key === 'Escape') { if (menu) { e.preventDefault(); e.stopPropagation(); setMenu(null) } }
  }

  const suggestions = typed ? twys.filter(t => t.startsWith(typed.toUpperCase())).slice(0, 12) : twys
  const hs = route.holdShortOf
  const hsLabel = hs ? (hs.kind === 'runway' ? `hold short ${hs.runway}` : hs.kind === 'taxiway' ? `hold short ${hs.taxiway}` : `hold at ${hs.label}`) : null
  const hsNode = hs ? (hs.kind === 'runway' ? hs.runway : hs.kind === 'taxiway' ? hs.taxiway : hs.nodeId) : undefined
  const holdOptions = step.holdShortSuggestions
  const runwayNames = (ctx?.runways ?? []).map(r => r.name)
  const crossOptions = runwayNames.length ? runwayNames : holdOptions
  const intersections = ctx?.intersections ?? []

  return (
    <div className={s.picker} data-testid="picker-route">
      <div className={s.between}>
        <span className={s.label}>{step.label}</span>
        <span className={cx(s.hint, s.inlineRow)}><IconMap size={12} />tap taxiways on the map</span>
      </div>
      <div className={cx(s.routeBar, s.routeBarActive)} onClick={() => inputRef.current?.focus()} role="group" aria-label="Route" data-testid="picker-taxiroute-map-mode">
        {step.destKind !== 'node' ? (
          <Pill size="xs" tone="solid" testId="picker-route-dest" data-kind={step.destKind}>
            {step.destKind === 'runway' ? `RWY ${params.runway ?? ''}`.trim() : step.destKind === 'stand' ? `STAND ${params.stand ?? ''}`.trim() : 'point'}
          </Pill>
        ) : null}
        {route.auto && !route.via.length ? <Pill size="xs" tone="orange" testId="picker-route-chip-auto">AUTO</Pill> : null}
        {route.via.map((v, i) => (
          <React.Fragment key={`${v}-${i}`}>
            <span className={s.routeSep}><IconChevronRight size={12} /></span>
            <Pill size="xs" tone="solid" interactive onClick={() => removeFrom(i)} title="Remove from here" testId={`picker-route-chip-${i}`}>{v}</Pill>
          </React.Fragment>
        ))}
        {hsLabel ? (
          <>
            <span className={s.routeSep}><IconChevronRight size={12} /></span>
            <Pill size="xs" tone="orange" interactive onClick={() => set({ holdShortOf: null })} trailing={<IconX size={12} />} testId="picker-route-pill-0" data-node={hsNode}>{hsLabel}</Pill>
          </>
        ) : null}
        {route.cross?.map((c, i) => (
          <React.Fragment key={`x-${c}`}>
            <span className={s.routeSep}><IconChevronRight size={12} /></span>
            <Pill size="xs" tone="orange" interactive onClick={() => set({ cross: route.cross!.filter(x => x !== c) })} trailing={<IconX size={12} />} testId={`picker-route-pill-${i + 1}`}>cross {c}</Pill>
          </React.Fragment>
        ))}
        {route.intersection ? (
          <>
            <span className={s.routeSep}><IconChevronRight size={12} /></span>
            <Pill size="xs" tone="solid" interactive onClick={() => set({ intersection: null })} trailing={<IconX size={12} />} testId="picker-route-intersection-chip">at {route.intersection}</Pill>
          </>
        ) : null}
        <input
          ref={inputRef}
          className={s.routeInput}
          value={typed}
          onChange={e => setTyped(e.target.value.toUpperCase())}
          onKeyDown={onKey}
          placeholder={route.via.length ? '' : 'type taxiway'}
          aria-label="Taxiway letters"
          data-testid="picker-route-input"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className={s.rowTight}>
        <Button size="sm" variant={route.auto && !route.via.length ? 'accent' : 'secondary'} onClick={auto} testId="picker-route-auto">AUTO</Button>
        <Button size="sm" variant="ghost" onClick={clear} disabled={!route.via.length && !route.auto} testId="picker-route-clear">CLEAR</Button>
        {step.allowHoldShort ? <Button size="sm" variant="secondary" selected={menu === 'hold'} onClick={() => setMenu(m => m === 'hold' ? null : 'hold')} testId="picker-route-holdshort">hold short of</Button> : null}
        {step.allowCross ? <Button size="sm" variant="secondary" selected={menu === 'cross'} onClick={() => setMenu(m => m === 'cross' ? null : 'cross')} testId="picker-route-cross">cross runway</Button> : null}
        {step.allowIntersection && intersections.length ? <Button size="sm" variant="secondary" selected={menu === 'intersection'} onClick={() => setMenu(m => m === 'intersection' ? null : 'intersection')} testId="picker-route-intersection">at intersection</Button> : null}
      </div>
      {menu === 'hold' ? (
        <div className={s.popover} role="listbox" aria-label="Hold short of">
          <span className={s.label}>Runways</span>
          <div className={s.rowTight}>
            {holdOptions.map(r => <Pill key={r} size="s" tone={hs?.kind === 'runway' && hs.runway === r ? 'orange' : 'neutral'} interactive onClick={() => { set({ holdShortOf: { kind: 'runway', runway: r } as HoldShortTarget }); setMenu(null) }} testId={`picker-route-holdshort-${r}`}>{r}</Pill>)}
          </div>
          {twys.length ? (<>
            <span className={s.label}>Taxiways</span>
            <div className={s.twyRail}>
              {twys.map(t => <button key={t} type="button" className={s.twy} onClick={() => { set({ holdShortOf: { kind: 'taxiway', taxiway: t } }); setMenu(null) }} data-testid={`picker-route-holdshort-twy-${t}`}>{t}</button>)}
            </div>
          </>) : null}
        </div>
      ) : null}
      {menu === 'cross' ? (
        <div className={s.popover} role="listbox" aria-label="Cross runway">
          <div className={s.rowTight}>
            {crossOptions.map(r => <Pill key={r} size="s" tone={route.cross?.includes(r) ? 'orange' : 'neutral'} interactive onClick={() => { const cross = route.cross?.includes(r) ? route.cross.filter(x => x !== r) : [...(route.cross ?? []), r]; set({ cross }); setMenu(null) }} testId={`picker-route-cross-${r}`}>{r}</Pill>)}
          </div>
        </div>
      ) : null}
      {menu === 'intersection' ? (
        <div className={s.popover} role="listbox" aria-label="Intersection">
          <div className={s.twyRail}>
            {intersections.map(n => <button key={n.nodeId} type="button" className={s.twy} onClick={() => { set({ intersection: n.label }); setMenu(null) }} data-testid={`picker-route-intersection-${n.label}`}>{n.label}</button>)}
          </div>
        </div>
      ) : null}
      {twys.length ? (
        <div>
          <span className={s.label}>Via taxiway</span>
          <div className={s.twyRail} role="list" aria-label="Taxiways">
            {suggestions.map(t => <button key={t} type="button" className={s.twy} onClick={() => append(t)} disabled={route.via.length >= MAX} data-testid={`picker-route-twy-${t}`}>{t}</button>)}
            {!suggestions.length ? <span className={s.hint}>No taxiway "{typed}"</span> : null}
          </div>
        </div>
      ) : null}
      {step.contactTowerChip ? (
        <div className={s.toggleRow}>
          <span className={s.hint}>Contact tower at the holding point</span>
          <Pill size="s" tone={(params.then ?? []).some(t => t.kind === 'contact') ? 'orange' : 'outline'} interactive selected={(params.then ?? []).some(t => t.kind === 'contact')} onClick={() => {
            const has = (params.then ?? []).some(t => t.kind === 'contact')
            onChange({ then: has ? (params.then ?? []).filter(t => t.kind !== 'contact') : [...(params.then ?? []), makeAst('contact', a.callsign, { position: 'tower', when: 'at_hold' })] })
          }} testId="picker-route-contact-tower">at hold</Pill>
        </div>
      ) : null}
      {ctx?.nextCrossingRunway && !hs ? <span className={cx(s.hint, s.hintOrange)}>Route crosses runway {ctx.nextCrossingRunway} — add a hold-short pill or the pilot will stop and request crossing.</span> : null}
    </div>
  )
}

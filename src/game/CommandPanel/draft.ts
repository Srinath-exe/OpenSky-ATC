'use client'
/*
  Draft = one command being built in the stepper (UX §1.1 rule 2: every action
  is a linear stepper with defaults, so the fast path is hotkey -> Enter -> Enter).
  Pure helpers: no React, no store. The panel owns the state.
*/
import type { ActionId, ActionParams, PickerStep, PartChip } from '@/lib/sim/commandTree'
import type { AircraftState, PendingCondition, Position } from '@/lib/sim/types'
import type { CommandAST, SingleAircraftCommand, TurnDir } from '@/lib/sim/commandAst'
import { makeAst, describe } from '@/lib/sim/commandAst'

export interface DraftPart { part: PartChip; label: string; thenKind?: SingleAircraftCommand['kind'] }
export interface AstPatch { when?: PendingCondition | null; reportEstablished?: boolean; trafficInfo?: string | null }
export interface SubPicker { part: PartChip; step: PickerStep; title: string }

export interface Draft {
  actionId: ActionId
  aircraftId: number
  callsign: string
  steps: PickerStep[]
  index: number
  params: ActionParams
  parts: DraftPart[]
  patch: AstPatch
  sub: SubPicker | null
  /** true when opened from a REQ band / Enter (lands on the confirm step). */
  fromRequest: boolean
}

export const PART_LABEL: Record<PartChip, string> = {
  then_ils: 'then cleared ILS', when_passing_alt: 'when passing', after_fix: 'after fix', descend_to: 'descend to', speed: 'speed',
  report_established: 'report established', immediate: 'immediate', after_dep_hdg: 'after departure heading', turn_lr: 'turn L/R',
  climb_to: 'climb to', contact_on_reaching: 'on reaching contact departure', wind: 'wind', behind_landing: 'behind landing',
  traffic_final: 'traffic on final', lahso: 'hold short of (LAHSO)', exit_at: 'exit at', next_exit: 'next exit L/R', via: 'via',
  hold_short_of: 'hold short of', cross_runway: 'cross runway', intersection: 'at intersection', contact_tower_at_hold: 'contact tower at hold',
  expect_runway: 'expect runway', face: 'face', then_taxi: 'after pushback taxi', fly_heading: 'fly heading', runway_heading: 'runway heading',
  contact: 'contact', expedite: 'expedite',
}

/** Parts that are pure toggles (no sub-picker). */
export const TOGGLE_PARTS: ReadonlyArray<PartChip> = ['report_established', 'immediate', 'contact_on_reaching', 'wind', 'traffic_final', 'contact_tower_at_hold', 'runway_heading', 'expedite']

/** Picker type a part needs (null = toggle / navigates back to a step). */
export function partPickerType(part: PartChip): PickerStep['type'] | null {
  switch (part) {
    case 'then_ils': case 'lahso': case 'hold_short_of': case 'cross_runway': case 'expect_runway': return 'runway'
    case 'when_passing_alt': case 'descend_to': case 'climb_to': return 'altitude'
    case 'after_fix': return 'fix'
    case 'speed': return 'speed'
    case 'after_dep_hdg': case 'fly_heading': return 'heading'
    case 'turn_lr': case 'next_exit': case 'face': return 'direction'
    case 'behind_landing': return 'aircraft'
    case 'exit_at': case 'intersection': return 'taxiway'
    case 'contact': return 'position'
    case 'via': case 'then_taxi': return 'taxiway-route'
    default: return null
  }
}

/** Defaults for every step (§G4 default rule: the step's default, already "last used" aware). */
export function defaultParams(steps: PickerStep[], nextCrossingRunway: string | null): ActionParams {
  const p: ActionParams = {}
  for (const s of steps) {
    switch (s.type) {
      case 'runway': if (s.default) p.runway = s.default; break
      case 'taxiway-route':
        p.route = { via: [], auto: true, holdShortOf: nextCrossingRunway && s.allowHoldShort ? { kind: 'runway', runway: nextCrossingRunway } : null, cross: [], intersection: null }
        break
      case 'heading': if (s.default != null) p.heading = s.default; p.dir = null; break
      case 'altitude': if (s.default != null) p.altitude = s.default; p.expedite = false; break
      case 'speed': if (s.default != null) p.speed = s.default; break
      case 'fix': if (s.default) p.fix = s.default; break
      case 'hold': p.hold = { fix: s.defaultFix ?? '', inbound: s.defaultInbound, dir: s.defaultDir, legTimeMin: 1, legNM: null, efc: null }; break
      case 'direction': if (s.default) p.direction = s.default; break
      case 'taxiway': if (s.default) { if (s.id === 'taxiway2') p.taxiway2 = s.default; else p.taxiway = s.default } break
      case 'gate': if (s.default) p.stand = s.default; break
      case 'vehicle': p.vehicles = s.candidates.filter(c => c.preselected).map(c => c.id); p.vehicleType = s.preselect[0] ?? 'arff'; break
      case 'position': if (s.default) p.position = s.default; p.when = s.when; break
      case 'text': p.chips = [...s.default]; break
      default: break
    }
  }
  p.then = []
  return p
}

/** Is the mandatory value for a step present? (optional steps always pass). */
export function stepSatisfied(step: PickerStep, p: ActionParams): boolean {
  if (step.optional) return true
  switch (step.type) {
    case 'runway': return !!p.runway
    case 'taxiway-route': return true
    case 'heading': return p.heading != null
    case 'altitude': return p.altitude != null
    case 'speed': return p.speed != null
    case 'fix': return !!p.fix
    case 'hold': return !!p.hold?.fix
    case 'direction': return !!p.direction
    case 'taxiway': return step.id === 'taxiway2' ? !!p.taxiway2 : !!p.taxiway || (step.nextExitChips && (p.direction === 'L' || p.direction === 'R')) || !!p.exit
    case 'gate': return !!p.stand
    case 'aircraft': return !!p.aircraft
    case 'vehicle': return !!p.vehicles?.length
    case 'position': return !!p.position
    case 'text': return step.multi ? true : !!p.chips?.length
    case 'confirm': return true
  }
}

/** Short value label for a completed step chip in the breadcrumb. */
export function stepValueLabel(step: PickerStep, p: ActionParams, magVar: number, transitionAltFt: number): string | undefined {
  const fl = (ft: number) => (ft > transitionAltFt ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : String(ft))
  switch (step.type) {
    case 'runway': return p.runway
    case 'taxiway-route': return p.route?.auto && !p.route.via.length ? 'AUTO' : p.route?.via.length ? `via ${p.route.via.join(' ')}` : undefined
    case 'heading': return p.heading != null ? String(((Math.round(p.heading - magVar) % 360) + 360) % 360 || 360).padStart(3, '0') : undefined
    case 'altitude': return p.altitude != null ? fl(p.altitude) : undefined
    case 'speed': return p.speed === 'resume' ? 'resume' : p.speed != null ? `${p.speed} kt` : undefined
    case 'fix': return p.fix
    case 'hold': return p.hold?.fix ? `HLD ${p.hold.fix}` : undefined
    case 'direction': return p.direction === 'any' ? 'as required' : p.direction
    case 'taxiway': return step.id === 'taxiway2' ? p.taxiway2 : p.taxiway ?? (p.exit?.kind === 'next' ? `next ${p.exit.dir}` : undefined)
    case 'gate': return p.stand
    case 'aircraft': return p.aircraft
    case 'vehicle': return p.vehicles?.length ? `${p.vehicles.length} veh` : undefined
    case 'position': return p.position?.toUpperCase()
    case 'text': return p.chips?.length ? step.options.filter(o => p.chips!.includes(o.value)).map(o => o.label).join(', ') : undefined
    case 'confirm': return undefined
  }
}

/**
 * Apply a "+ ADD PART" value to the draft (UX §1.5 table). Returns the updated
 * params/parts/patch; toggles flip when applied twice.
 */
export function applyPart(d: Draft, part: PartChip, value: unknown, a: AircraftState | null, opts: { trafficText?: string | null } = {}): Pick<Draft, 'params' | 'parts' | 'patch'> {
  const params: ActionParams = { ...d.params, then: [...(d.params.then ?? [])], route: d.params.route ? { ...d.params.route, via: [...d.params.route.via], cross: [...(d.params.route.cross ?? [])] } : d.params.route, goAround: { ...(d.params.goAround ?? {}) } }
  const parts = d.parts.filter(x => x.part !== part)
  const patch: AstPatch = { ...d.patch }
  const cs = d.callsign
  const has = d.parts.some(x => x.part === part)
  const pushThen = (ast: SingleAircraftCommand, label: string) => {
    params.then = (params.then ?? []).filter(t => t.kind !== ast.kind)
    params.then.push(ast)
    parts.push({ part, label, thenKind: ast.kind })
  }
  const dropThen = (kind: SingleAircraftCommand['kind']) => { params.then = (params.then ?? []).filter(t => t.kind !== kind) }
  const isGoAround = d.actionId === 'action-goaround'
  const isTakeoff = d.actionId === 'action-takeoff'
  const isExit = d.actionId === 'action-exit'
  const rwy = params.runway ?? a?.plan.runway ?? a?.assignedRunway ?? ''

  switch (part) {
    case 'then_ils': { const r = String(value ?? ''); pushThen(makeAst('ils', cs, { runway: r }), `then ILS ${r}`); break }
    case 'when_passing_alt': { const ft = Number(value); const above = a ? ft > a.altitude : true; patch.when = { type: above ? 'at_or_above_alt' : 'at_or_below_alt', ft }; parts.push({ part, label: `when passing ${ft}` }); break }
    case 'after_fix': { const f = String(value ?? ''); patch.when = { type: 'after_fix', fix: f }; parts.push({ part, label: `after ${f}` }); break }
    case 'descend_to': { const ft = Number(value); pushThen(makeAst('altitude', cs, { ft }), `descend ${ft}`); break }
    case 'climb_to': {
      const ft = Number(value)
      if (isTakeoff) { params.initialAlt = ft; parts.push({ part, label: `climb ${ft}` }) }
      else if (isGoAround) { params.goAround = { ...params.goAround, alt: ft }; parts.push({ part, label: `climb ${ft}` }) }
      else pushThen(makeAst('altitude', cs, { ft }), `climb ${ft}`)
      break
    }
    case 'speed': { const kts = value === 'resume' ? 'resume' : Number(value); pushThen(makeAst('speed', cs, { kts }), kts === 'resume' ? 'resume normal speed' : `speed ${kts}`); break }
    case 'report_established': { patch.reportEstablished = has ? true : false; if (!has) parts.push({ part, label: 'no report established' }); break }
    case 'immediate': { params.immediate = !has; if (!has) parts.push({ part, label: 'immediate' }); break }
    case 'after_dep_hdg': { const h = Number(value); params.afterDepHdg = h; params.turn = null; parts.push({ part, label: `after departure heading` }); break }
    case 'turn_lr': { const v = value as { dir: TurnDir; deg: number }; params.turn = v; params.afterDepHdg = null; parts.push({ part, label: `turn ${v.dir === 'L' ? 'left' : 'right'} ${v.deg}°` }); break }
    case 'contact_on_reaching': { params.contactDeparture = !has; if (!has) parts.push({ part, label: 'contact departure on reaching' }); break }
    case 'wind': { params.wind = has ? true : false; if (!has) parts.push({ part, label: 'no wind' }); break }
    case 'behind_landing': { const c = String(value ?? ''); params.aircraft = c; parts.push({ part, label: `behind ${c}` }); break }
    case 'traffic_final': { patch.trafficInfo = has ? null : (opts.trafficText ?? null); if (!has) parts.push({ part, label: opts.trafficText ?? 'traffic on final' }); break }
    case 'lahso': { const r = String(value ?? ''); params.lahso = r; parts.push({ part, label: `hold short ${r}` }); break }
    case 'exit_at': { const t = String(value ?? ''); params.exit = { kind: 'taxiway', taxiway: t }; params.taxiway = t; parts.push({ part, label: `exit at ${t}` }); break }
    case 'next_exit': { const dir = value as TurnDir; params.exit = { kind: 'next', dir }; params.direction = dir; parts.push({ part, label: `next exit ${dir === 'L' ? 'left' : 'right'}` }); break }
    case 'hold_short_of': {
      const r = String(value ?? '')
      params.route = { ...(params.route ?? { via: [], auto: true }), holdShortOf: { kind: 'runway', runway: r } }
      parts.push({ part, label: `hold short ${r}` })
      break
    }
    case 'cross_runway': {
      const r = String(value ?? '')
      const cross = [...(params.route?.cross ?? [])]; if (!cross.includes(r)) cross.push(r)
      params.route = { ...(params.route ?? { via: [], auto: true }), cross }
      parts.push({ part, label: `cross ${cross.join(', ')}` })
      break
    }
    case 'intersection': { const t = String(value ?? ''); params.route = { ...(params.route ?? { via: [], auto: true }), intersection: t }; parts.push({ part, label: `intersection ${t}` }); break }
    case 'contact_tower_at_hold': { if (has) dropThen('contact'); else pushThen(makeAst('contact', cs, { position: 'tower', when: 'at_hold' }), 'contact tower at hold'); break }
    case 'expect_runway': { const r = String(value ?? ''); params.runway = r; parts.push({ part, label: `expect ${r}` }); break }
    case 'face': { const dir = value as ActionParams['direction']; params.direction = dir; parts.push({ part, label: dir === 'any' ? 'face as required' : `face ${dir}` }); break }
    case 'then_taxi': {
      const v = value as { via: string[]; auto: boolean }
      pushThen(makeAst('taxi', cs, { dest: { kind: 'runway', runway: rwy, intersection: null }, via: v.via, auto: v.auto || !v.via.length, holdShortOf: null, cross: [] }), `then taxi ${rwy}${v.via.length ? ' via ' + v.via.join(' ') : ''}`)
      break
    }
    case 'fly_heading': {
      const h = Number(value)
      if (isGoAround) { params.goAround = { ...params.goAround, heading: h }; parts.push({ part, label: 'fly heading' }) }
      else if (isTakeoff) { params.afterDepHdg = h; parts.push({ part, label: 'after departure heading' }) }
      else pushThen(makeAst('heading', cs, { hdg: h, dir: null }), 'fly heading')
      break
    }
    case 'runway_heading': {
      if (isGoAround) params.goAround = { ...params.goAround, heading: has ? null : 'runway' }
      else if (isTakeoff) params.afterDepHdg = has ? null : 'runway'
      if (!has) parts.push({ part, label: 'runway heading' })
      break
    }
    case 'contact': {
      const pos = value as Position
      if (isGoAround) { params.goAround = { ...params.goAround, contact: pos }; parts.push({ part, label: `contact ${pos}` }) }
      else if (isExit) { params.position = pos; parts.push({ part, label: `contact ${pos}` }) }
      else pushThen(makeAst('contact', cs, { position: pos, when: 'now' }), `contact ${pos}`)
      break
    }
    case 'expedite': { params.expedite = !has; if (!has) parts.push({ part, label: 'expedite' }); break }
    case 'via': break
  }
  return { params, parts, patch }
}

/** Remove a part chip (inverse of applyPart for the display list). */
export function removePart(d: Draft, i: number, a: AircraftState | null): Pick<Draft, 'params' | 'parts' | 'patch'> {
  const p = d.parts[i]
  if (!p) return { params: d.params, parts: d.parts, patch: d.patch }
  if (TOGGLE_PARTS.includes(p.part)) return applyPart(d, p.part, undefined, a) // toggles flip back
  const params: ActionParams = { ...d.params, then: (d.params.then ?? []).filter(t => t.kind !== p.thenKind) }
  const patch: AstPatch = { ...d.patch }
  switch (p.part) {
    case 'when_passing_alt': case 'after_fix': patch.when = null; break
    case 'after_dep_hdg': case 'fly_heading': if (d.actionId === 'action-takeoff') params.afterDepHdg = null; if (d.actionId === 'action-goaround') params.goAround = { ...params.goAround, heading: null }; break
    case 'turn_lr': params.turn = null; break
    case 'climb_to': if (d.actionId === 'action-takeoff') params.initialAlt = null; if (d.actionId === 'action-goaround') params.goAround = { ...params.goAround, alt: null }; break
    case 'behind_landing': params.aircraft = undefined; break
    case 'lahso': params.lahso = null; break
    case 'exit_at': case 'next_exit': params.exit = null; params.taxiway = undefined; if (p.part === 'next_exit') params.direction = undefined; break
    case 'hold_short_of': params.route = params.route ? { ...params.route, holdShortOf: null } : params.route; break
    case 'cross_runway': params.route = params.route ? { ...params.route, cross: [] } : params.route; break
    case 'intersection': params.route = params.route ? { ...params.route, intersection: null } : params.route; break
    case 'contact': if (d.actionId === 'action-goaround') params.goAround = { ...params.goAround, contact: null }; if (d.actionId === 'action-exit') params.position = undefined; break
    default: break
  }
  return { params, parts: d.parts.filter((_, k) => k !== i), patch }
}

/** Apply the AST-level tweaks (condition, report established, traffic info) to the built AST. */
export function patchAst(ast: CommandAST, patch: AstPatch): CommandAST {
  const apply = (p: SingleAircraftCommand): SingleAircraftCommand => {
    let out = p
    if (patch.when !== undefined && (out.kind === 'heading' || out.kind === 'altitude')) out = { ...out, when: patch.when }
    if (patch.reportEstablished !== undefined && out.kind === 'ils') out = { ...out, reportEstablished: patch.reportEstablished }
    if (patch.trafficInfo !== undefined && (out.kind === 'lineup' || out.kind === 'clearedLand')) out = { ...out, trafficInfo: patch.trafficInfo }
    return out
  }
  if (ast.kind === 'sequence') return { ...ast, parts: ast.parts.map(apply) }
  if ('callsign' in ast) return apply(ast as SingleAircraftCommand)
  return ast
}

export function needsPatch(patch: AstPatch): boolean { return patch.when !== undefined || patch.reportEstablished !== undefined || patch.trafficInfo !== undefined }

export function describeParts(then: SingleAircraftCommand[] | undefined): string[] { return (then ?? []).map(describe) }

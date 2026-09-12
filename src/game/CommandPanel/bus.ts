'use client'
/*
  Tiny cross-panel event bus (no store coupling): the strip bay asks the
  command panel to open an action ("box" click, REQ chip); map renderers may
  feed the route builder ("atc:route-tap") and the vehicle panel ("atc:map-tap").
*/
import type { ActionId } from '@/lib/sim/commandTree'

export interface OpenActionDetail { aircraftId: number; actionId: ActionId | null; /** jump straight to the confirm step */ confirm?: boolean }
export interface RouteTapDetail { taxiway?: string; runway?: string; nodeId?: string }
export interface MapTapDetail { x: number; y: number }

export const EV_OPEN_ACTION = 'atc:open-action'
export const EV_ROUTE_TAP = 'atc:route-tap'
export const EV_MAP_TAP = 'atc:map-tap'

export function requestOpenAction(detail: OpenActionDetail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenActionDetail>(EV_OPEN_ACTION, { detail }))
}

export function onOpenAction(fn: (d: OpenActionDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const h = (e: Event) => fn((e as CustomEvent<OpenActionDetail>).detail)
  window.addEventListener(EV_OPEN_ACTION, h)
  return () => window.removeEventListener(EV_OPEN_ACTION, h)
}

export function onRouteTap(fn: (d: RouteTapDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const h = (e: Event) => fn((e as CustomEvent<RouteTapDetail>).detail)
  window.addEventListener(EV_ROUTE_TAP, h)
  return () => window.removeEventListener(EV_ROUTE_TAP, h)
}

export function onMapTap(fn: (d: MapTapDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const h = (e: Event) => fn((e as CustomEvent<MapTapDetail>).detail)
  window.addEventListener(EV_MAP_TAP, h)
  return () => window.removeEventListener(EV_MAP_TAP, h)
}

/** True while an input-like element owns the keyboard (hotkeys must not fire). */
export function keyboardOwnedByInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

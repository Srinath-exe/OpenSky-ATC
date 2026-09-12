'use client'
/*
  Parked drafts (UX §1.6): clicking another aircraft while a command is being built parks the
  draft for 20 s as a "Resume draft" chip on the first aircraft's strip and panel header.
  Tiny module store so the StripBay and the CommandPanel share it without touching simStore.
*/
import * as React from 'react'
import type { Draft } from './draft'

export const PARK_TTL_MS = 20_000

export interface ParkedDraft { draft: Draft; parkedAt: number; expiresAt: number }

const parked = new Map<number, ParkedDraft>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let version = 0

function notify() { version++; for (const l of listeners) l() }

export function parkDraft(draft: Draft): void {
  const now = Date.now()
  const id = draft.aircraftId
  const t = timers.get(id)
  if (t) clearTimeout(t)
  parked.set(id, { draft, parkedAt: now, expiresAt: now + PARK_TTL_MS })
  timers.set(id, setTimeout(() => { parked.delete(id); timers.delete(id); notify() }, PARK_TTL_MS))
  notify()
}

export function takeParkedDraft(aircraftId: number): Draft | null {
  const p = parked.get(aircraftId)
  if (!p) return null
  parked.delete(aircraftId)
  const t = timers.get(aircraftId)
  if (t) clearTimeout(t)
  timers.delete(aircraftId)
  notify()
  return p.draft
}

export function dropParkedDraft(aircraftId: number): void {
  if (!parked.has(aircraftId)) return
  parked.delete(aircraftId)
  const t = timers.get(aircraftId)
  if (t) clearTimeout(t)
  timers.delete(aircraftId)
  notify()
}

export function getParkedDraft(aircraftId: number): ParkedDraft | null { return parked.get(aircraftId) ?? null }

export function subscribeParked(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Reactive parked draft for an aircraft (null when none). */
export function useParkedDraft(aircraftId: number | null): ParkedDraft | null {
  const v = React.useSyncExternalStore(subscribeParked, () => version, () => 0)
  void v
  return aircraftId == null ? null : getParkedDraft(aircraftId)
}

/** Reactive set of aircraft ids with a parked draft (strip chips). */
export function useParkedIds(): ReadonlySet<number> {
  const v = React.useSyncExternalStore(subscribeParked, () => version, () => 0)
  return React.useMemo(() => new Set(parked.keys()), [v])
}

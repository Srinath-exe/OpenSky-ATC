'use client'
/*
  The coach: runs a tutorial chapter on the live sim. Plays the chapter's story (the raea film), builds its scene, sends
  the map its cues, then watches. Goals are checked a few times a second and stay met once met; any order, any wording.
  The coach also answers what the player does (or what happens) with a short note.
*/
import * as React from 'react'
import { sim } from '@/components/atc/simStore'
import type { SimEvent } from '@/lib/sim/types'
import { sendCue, mapListening } from '@/components/atc/WorldMap/tutor'
import { executeText } from '@/lib/sim/dispatch'
import { CHAPTERS, setRunner, type Chapter, type Goal, type Live, type Tab } from './lessons'

export interface CoachNote { id: number; text: string; tone: 'info' | 'done' | 'warn' }
export interface TutorState {
  tab: Tab
  chapter: Chapter | null
  stage: 'idle' | 'story' | 'live' | 'done'
  met: ReadonlySet<string>
  notes: CoachNote[]
  /** Chapters finished at least once (persisted). */
  progress: Record<string, true>
  version: number
}

const KEY = 'atc.tutor.progress.v1'
const readProgress = (): Record<string, true> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} } }

class Coach {
  state: TutorState = { tab: 'ground', chapter: null, stage: 'idle', met: new Set(), notes: [], progress: {}, version: 0 }
  private live: Live | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<() => void>()
  private noteId = 0
  private fresh = false
  private openKey = ''
  private untap: (() => void) | null = null
  /** Goals that have applied at some point this mission: they stay live (a stop goal must not close as the aircraft stops). */
  private opened = new Set<string>()

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private emit(patch: Partial<TutorState> = {}) { this.state = { ...this.state, ...patch, version: this.state.version + 1 }; for (const l of this.listeners) l() }

  init(): void {
    this.emit({ progress: readProgress() })
    // setup calls go straight to the engine (the store holds a player's call for its undo window, which a scene being
    // built in one go cannot wait for)
    setRunner((e, line) => { const r = executeText(e, line); if (!r.result.ok) console.warn('tutor setup call refused:', line, r.result.code, r.result.reason ?? ''); return r })
    if (!this.untap) { const tap = (evs: SimEvent[]) => this.onEvents(evs); sim.eventTaps.add(tap); this.untap = () => sim.eventTaps.delete(tap) }
  }
  dispose(): void { this.stopTick(); this.untap?.(); this.untap = null; sendCue({ kind: 'clear' }) }

  setTab(tab: Tab): void { if (tab !== this.state.tab) this.emit({ tab }) }

  /** Open a chapter: its story first (unless skipped), then the live scene. */
  open(id: string, opts: { story?: boolean; fresh?: boolean } = {}): void {
    const ch = CHAPTERS.find(c => c.id === id); if (!ch) return
    this.stopTick(); this.live = null
    sendCue({ kind: 'clear' })
    if (sim.position !== ch.tab) sim.setPosition(ch.tab)
    this.fresh = !!opts.fresh
    const story = opts.story !== false && !ch.ui   // every mission opens with its briefing
    this.emit({ tab: ch.tab, chapter: ch, stage: story ? 'story' : 'live', met: new Set(), notes: [] })
    if (story) sim.setPaused(true)
    else this.begin()
  }

  /** The story is over (or skipped): build the scene and hand over. */
  begin(): void {
    const ch = this.state.chapter; const e = sim.engine; if (!ch || !e) return
    sim.autoSpawn = false
    sim.select(null)
    // the briefing paused the sim, and a paused engine refuses every call: unpause before the scene is built (the setup's
    // "pushback approved" / "taxi" were refused here, which left the aircraft on its stand)
    sim.setPaused(false)
    // carry on from where the last mission left the aircraft, unless asked to start again
    const ctx = (!this.fresh && ch.resume ? safe(() => ch.resume!(e), null) : null) ?? ch.setup(e)
    this.fresh = false
    this.live = { e, ctx, events: [], t0: e.time, selectedId: null }
    this.opened = new Set()
    if (ch.tab === 'approach') { const a = e.find(ctx.cs); if (a) { sim.select(a.id); sim.centerOn(a.id) } }
    else if (ch.id !== 'g-push') { const a = e.find(ctx.cs); if (a) sim.select(a.id) }
    sim.emit()
    this.startedWall = performance.now(); this.warned = false
    this.emit({ stage: 'live', met: new Set(), notes: [] })
    // the map's camera and highlights once it has drawn the new scene
    const send = (tries: number) => {
      if (!this.live || this.state.chapter !== ch) return
      if (!mapListening() && tries > 0) { window.setTimeout(() => send(tries - 1), 250); return }
      // a freshly mounted map draws its first frames before the camera can fly smoothly
      if (tries === 80) { window.setTimeout(() => send(79), 400); return }
      for (const c of ch.cues?.(this.live) ?? []) sendCue(c)
    }
    window.setTimeout(() => send(80), 150)
    this.startTick()
  }

  /** Free play: traffic on, the coach steps back. */
  freePlay(): void {
    this.stopTick(); this.live = null; sendCue({ kind: 'clear' })
    sim.autoSpawn = true; sim.setPaused(false)
    this.emit({ chapter: null, stage: 'idle', notes: [] })
  }

  /** Goals in the order the card shows them, with what they are doing now. */
  goals(): Array<{ g: Goal; met: boolean; open: boolean }> {
    const ch = this.state.chapter; const L = this.live; if (!ch) return []
    return ch.goals.map(g => ({ g, met: this.state.met.has(g.id), open: !L || this.isOpen(g, L) }))
  }
  /** The goal to suggest now: the first open, unmet, required one (else the first open optional one). */
  current(): Goal | null {
    const gs = this.goals().filter(x => x.open && !x.met)
    return (gs.find(x => !x.g.optional) ?? gs[0])?.g ?? null
  }
  /** For the mission-complete card: sim time the chapter started, wall time, and whether anything went wrong. */
  t0(): number { return this.live?.t0 ?? 0 }
  startedWall = 0
  warned = false
  /** A lesson the page draws itself (Radio 101) ticks its goals here. */
  markMet(id: string): void {
    const ch = this.state.chapter; if (!ch || this.state.met.has(id)) return
    const met = new Set(this.state.met); met.add(id)
    const finished = ch.goals.every(g => g.optional || met.has(g.id))
    if (finished) { const progress = { ...this.state.progress, [ch.id]: true as const }; try { localStorage.setItem(KEY, JSON.stringify(progress)) } catch { /* */ } this.emit({ met, stage: 'done', progress }) }
    else this.emit({ met })
  }
  phrase(g: Goal | null): string | null { return g?.say && this.live ? safe(() => g.say!(this.live!), null) : null }

  private isOpen(g: Goal, L: Live): boolean {
    if (!g.when || this.opened.has(g.id) || this.state.met.has(g.id)) return true
    if (safe(() => g.when!(L), false)) { this.opened.add(g.id); return true }
    return false
  }
  private startTick() { this.stopTick(); this.timer = setInterval(() => this.tick(), 250) }
  private stopTick() { if (this.timer) clearInterval(this.timer); this.timer = null; this.setFast(false) }

  /** True while the coach is fast-forwarding (the lesson aircraft is pushing back or starting its engines). The tick
   *  steps the sim itself (11 s of sim per 250 ms on top of real time, so 12x), not through the frame loop, so the speed
   *  does not depend on the frame rate. */
  fast = false
  private setFast(on: boolean): void { if (on === this.fast) return; this.fast = on; this.emit() }

  private tick(): void {
    const ch = this.state.chapter, L = this.live; if (!ch || !L || this.state.stage === 'story') { this.setFast(false); return }
    if (ch.tick) safe(() => ch.tick!(L), undefined)
    const a = L.e.find(L.ctx.cs)
    // only while the mission is being played: behind the completion card the sim runs at its own pace
    this.setFast(this.state.stage === 'live' && !!a && (a.phase === 'pushback' || a.phase === 'startup'))
    if (this.fast && !sim.paused) sim.step(0.25 * 11)
    L.selectedId = sim.selectedId
    const met = new Set(this.state.met); let changed = false
    for (const g of ch.goals) {
      if (met.has(g.id)) continue
      if (!this.isOpen(g, L)) continue
      if (safe(() => g.done(L), false)) { met.add(g.id); changed = true; this.note(g.optional ? `Nice: ${g.title.toLowerCase()}.` : `✓ ${g.title}`, 'done', false) }
    }
    // a goal that just became relevant (the aircraft reached the hold, it is airborne…) changes the card too
    const openKey = ch.goals.map(g => (this.isOpen(g, L) ? 1 : 0)).join('')
    if (openKey !== this.openKey) { this.openKey = openKey; if (!changed) { this.emit(); return } }
    if (!changed) return
    const finished = ch.goals.every(g => g.optional || met.has(g.id))
    if (finished && this.state.stage !== 'done') {
      const progress = { ...this.state.progress, [ch.id]: true as const }
      try { localStorage.setItem(KEY, JSON.stringify(progress)) } catch { /* private mode */ }
      this.emit({ met, stage: 'done', progress })
      this.setFast(false)
    } else this.emit({ met })
  }

  private onEvents(evs: SimEvent[]): void {
    const ch = this.state.chapter, L = this.live; if (!ch || !L || !evs.length) return
    L.events.push(...evs)
    if (!ch.react) return
    for (const ev of evs) { const t = safe(() => ch.react!(L, ev), null); if (t) this.note(t, /incursion|too close|too soon|lost/i.test(t) ? 'warn' : 'info') }
  }

  private note(text: string, tone: CoachNote['tone'], emit = true): void {
    if (tone === 'warn') this.warned = true
    const notes = [...this.state.notes, { id: ++this.noteId, text, tone }].slice(-3)
    if (emit) this.emit({ notes }); else this.state = { ...this.state, notes }
  }
  dismissNote(id: number): void { this.emit({ notes: this.state.notes.filter(n => n.id !== id) }) }
}

function safe<T>(fn: () => T, fallback: T): T { try { return fn() } catch { return fallback } }

export const coach = new Coach()
if (typeof window !== 'undefined') (window as unknown as { __coach?: Coach }).__coach = coach   // headless checks drive the missions
export function useCoach<T>(sel: (s: TutorState) => T): T {
  return React.useSyncExternalStore(coach.subscribe, () => sel(coach.state), () => sel(coach.state))
}

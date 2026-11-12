/*
  The tutorial's chapters (SFO, the west plan: departures 01L/01R, arrivals 28L/28R). Pure functions of the engine so the
  browser coach and the headless tests (tests/tutor) run the same scenarios.

  A chapter sets up its scene on the live engine, says what it is about, and lists goals. Goals are checked against the
  engine every tick and can be met in any order, with any wording the game understands: the example phrase is only a
  suggestion. Optional goals are things to try. Nothing waits for the player to follow a script.
*/
import type { SimEngine } from '@/lib/sim/engine'
import type { AircraftState, PlayerPosition, SimEvent } from '@/lib/sim/types'
import type { XY } from '@/lib/sim/projection'

export type Tab = PlayerPosition
export const TABS: Array<{ id: Tab; title: string; blurb: string }> = [
  { id: 'ground', title: 'Ground', blurb: 'Pushback, taxi routes, holding, runway crossings' },
  { id: 'tower', title: 'Tower', blurb: 'Line-up, takeoff, landing, the runway, wake' },
  { id: 'approach', title: 'Approach', blurb: 'Vectors, altitude, speed, the ILS, separation' },
]

/** What the map should show: a camera move, a route lit stretch by stretch, a marker, or nothing. Engine XY metres. */
export type Cue =
  | { kind: 'camera'; at: XY; dist: number; yaw?: number; pitch?: number; ms?: number; follow?: number }
  | { kind: 'route'; id: string; pts: XY[]; legs: Array<{ name: string; s0: number; s1: number; delayMs: number }>; color?: string }
  | { kind: 'mark'; id: string; at: XY; label: string; tone: 'stop' | 'go' | 'info' }
  | { kind: 'clear'; id?: string }

export interface Ctx {
  /** The aircraft the chapter is about (callsign), and others it mentions. */
  cs: string
  others: string[]
  /** Free-form scene data (route preview, runway names). */
  data: Record<string, unknown>
}

export interface Live {
  e: SimEngine
  ctx: Ctx
  /** Events since the chapter started. */
  events: SimEvent[]
  /** Sim time the chapter started. */
  t0: number
  selectedId: number | null
}

export interface Goal {
  id: string
  title: string
  /** One or two sentences: what it is and why a controller does it. */
  why: string
  /** The example call with the real callsign, runway and route. */
  say?: (L: Live) => string | null
  done: (L: Live) => boolean
  /** Something to try: not needed to finish the chapter. */
  optional?: boolean
  /** Show only once this is true (e.g. the aircraft has reached the hold). */
  when?: (L: Live) => boolean
}

export interface Story {
  /** Story frames of the SFO film (0..480) to play, and captions on their frames. */
  from: number
  to: number
  lines: Array<[number, string]>
}

export interface Chapter {
  id: string
  tab: Tab
  title: string
  summary: string
  story?: Story
  setup: (e: SimEngine) => Ctx
  cues?: (L: Live) => Cue[]
  goals: Goal[]
  /** A word from the coach on something the player did (or that happened). */
  react?: (L: Live, ev: SimEvent) => string | null
  /** Carry on from the scene the previous mission left (same aircraft, where it is now); null = build it fresh. */
  resume?: (e: SimEngine) => Ctx | null
  /** Scripted traffic, run a few times a second (e.g. a departure that rolls when ours reaches the hold). */
  tick?: (L: Live) => void
  /** A lesson drawn by the page itself, not on the sim (Radio 101). */
  ui?: 'radio'
}

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------
export const DEP_RWYS = ['01R', '01L'], ARR_RWYS = ['28L', '28R']
const ac = (L: Live, cs = L.ctx.cs): AircraftState | undefined => L.e.find(cs)
/** The pilot read back a command of this kind (any wording) since the chapter started. */
export function saidAny(L: Live, cs: string, kinds: string[]): boolean {
  return L.events.some(ev => ev.type === 'readback' && ev.callsign === cs && ev.data?.type === 'readback' && !!ev.data.ast && (kinds.includes(ev.data.ast.kind) || ((ev.data.ast as { items?: Array<{ kind: string }> }).items ?? []).some(i => kinds.includes(i.kind))))
}
const STOP_KINDS = ['holdPosition', 'giveWay', 'holdShort', 'stop']
const happened = (L: Live, type: SimEvent['type'], cs?: string) => L.events.some(ev => ev.type === type && (!cs || ev.callsign === cs))
const xyOf = (a: AircraftState | undefined): XY => (a ? { x: a.pos.x, y: a.pos.y } : { x: 0, y: 0 })
/** The tutorial's runway set-up and a clean field: no traffic, no auto-spawn, the AI on every position but the player's. */
export function baseScene(e: SimEngine, position: PlayerPosition, parked = true): void {
  e.clear()
  e.setActiveRunways(DEP_RWYS, ARR_RWYS)
  seat(e, position)
  if (parked) e.populateParked(0.7)
}
/** The player's seat for a tab. The game folds ground into the tower seat, so ground and tower lessons are both 'tower';
 *  the AI covers the other seats and never the player's (an AI ground controller would answer our aircraft for us). */
export function seat(e: SimEngine, position: PlayerPosition): void {
  e.playerPosition = position === 'approach' ? 'approach' : 'tower'
  e.settings.autoMode = false
  e.settings.autoGround = position === 'approach'
  e.settings.autoTower = position === 'approach'
  e.settings.autoApproach = position !== 'approach'
  e.settings.emergencyRate = 'off'
  e.settings.pilotErrorRate = 0
  e.settings.pilotDelayOverride = 1   // quick readbacks while learning
}
/** Move the sim on quickly (setup only): fixed steps until pred or maxS. */
function fastForward(e: SimEngine, pred: () => boolean, maxS: number): void {
  for (let t = 0; t < maxS && !pred(); t += 1) e.step(30)   // one sim second a turn
}
function say(e: SimEngine, line: string, run: (e: SimEngine, line: string) => unknown): void { run(e, line) }
/** The command line runner, injected (the store's in the browser, executeText in tests) so setups can give clearances. */
let RUN: (e: SimEngine, line: string) => unknown = () => { throw new Error('tutorial: no command runner') }
export function setRunner(fn: (e: SimEngine, line: string) => unknown): void { RUN = fn }

function freeStand(e: SimEngine, prefer: string[]): string {
  for (const ref of prefer) if (!e.standOccupant(ref)) return ref
  return prefer[0]
}
function clearStand(e: SimEngine, ref: string): void {
  const cs = e.standOccupant(ref); const a = cs ? e.find(cs) : undefined
  if (a) e.remove(a.id)
}
/** A departure on a stand, ready to push, on the ground frequency. */
function departureAtStand(e: SimEngine, cs: string, stand: string, type = 'B738', runway = '01R'): AircraftState {
  clearStand(e, stand)
  e.spawnAt({ callsign: cs, type, kind: 'departure', phase: 'parked', gate: stand, plan: { runway }, onFrequency: 'ground' })
  const a = e.find(cs)!
  e.raiseRequest(a, 'pushback')
  return a
}
export function routePreview(e: SimEngine, a: AircraftState, runway: string, via: string[] = []) {
  return e.previewTaxi(a, { kind: 'runway', runway, intersection: null }, via)
}
function routeCue(id: string, pv: NonNullable<ReturnType<typeof routePreview>>, stepMs = 900): Cue {
  return { kind: 'route', id, pts: pv.path.pts, legs: pv.legs.map((l, i) => ({ ...l, delayMs: 600 + i * stepMs })) }
}
const camOn = (a: AircraftState | undefined, dist: number, pitch = 0.75, yaw?: number, ms = 1600): Cue => ({ kind: 'camera', at: xyOf(a), dist, pitch, yaw, ms })

// ---------------------------------------------------------------------------------------------------------------------
// GROUND: one departure's journey from stand C9 (Terminal 3) to runway 01R, which crosses 01L on the way
// ---------------------------------------------------------------------------------------------------------------------
const GCS = 'DLH455', G_TYPE = 'B744'   // the film's 747: the briefing and the practice show the same aircraft
const G_STAND = ['A8', 'A6', 'A9', 'A10']
const gAc = (e: SimEngine) => e.find(GCS)
/** The departure we follow through the Ground missions, from where the last one left it. */
function keep(e: SimEngine, ok: (a: AircraftState) => boolean, data: Record<string, unknown> = {}): Ctx | null {
  const a = gAc(e); if (!a || !ok(a)) return null
  seat(e, 'ground')
  return { cs: GCS, others: [], data }
}
const holdsAhead = (a: AircraftState) => (a.path?.holds ?? []).filter(h => !h.isDepartureEntry && h.at > a.distAlong - 5)
const toFirstHold = (a: AircraftState) => { const h = holdsAhead(a)[0]; return h ? h.at - a.distAlong : Infinity }
const taxiing = (a: AircraftState) => a.phase === 'taxi' && a.path?.kind === 'taxi'
/** Fresh: the 747 on its stand, asking for pushback. */
function freshPush(e: SimEngine): AircraftState { baseScene(e, 'ground'); return departureAtStand(e, GCS, freeStand(e, G_STAND), G_TYPE) }
/** Fresh, further on: pushed and started, cleared to 01R, taxiing until `until`. */
function freshTaxi(e: SimEngine, until: (a: AircraftState) => boolean): AircraftState {
  const a = freshPush(e)
  say(e, `${GCS} pushback approved`, RUN)
  fastForward(e, () => a.phase === 'startup' || a.phase === 'taxi', 400)
  say(e, `${GCS} taxi to runway 01R`, RUN)
  fastForward(e, () => until(a), 900)
  return a
}
/** Where a path is `s` metres along. */
function pointAt(P: NonNullable<AircraftState['path']>, s: number): { x: number; y: number } {
  let i = 1; while (i < P.pts.length - 1 && P.cum[i] < s) i++
  const a = P.pts[i - 1], b = P.pts[i], L = P.cum[i] - P.cum[i - 1] || 1, t = Math.max(0, Math.min(1, (s - P.cum[i - 1]) / L))
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}
/** Traffic that crosses our route at a junction ahead (an Alaska A320 taxiing in from a side taxiway to its stand), timed
 *  to get there about when we do: the classic give-way. Never head-on on our own taxiway (two aircraft nose to nose on
 *  one lane can only stop). Returns false when no junction ahead works. */
function crossingTraffic(e: SimEngine, a: AircraftState): boolean {
  if (e.find('ASA331')) return true
  const P = a.path; if (!P) return false
  const hold = holdsAhead(a)[0]?.at ?? P.total
  const onRoute = new Set<string>(); const ahead: { id: string; s: number }[] = []
  for (let s = Math.max(0, a.distAlong - 60); s < P.total; s += 6) {
    const id = e.nearestNodeId(pointAt(P, s), 9); if (!id || onRoute.has(id)) continue
    onRoute.add(id); if (s > a.distAlong + 150 && s < Math.min(a.distAlong + 420, hold - 50)) ahead.push({ id, s })
  }
  const xy = (id: string) => e.nodeXY(id)!
  const stands = e.gates.filter(g => !g.occupiedBy && !g.reservedFor && !g.closed).map(g => g.ref)
  for (const J of ahead) {
    const jn = e.air.nodes.get(J.id); if (!jn) continue
    for (const ed of jn.edges) {
      if (ed.type !== 'taxiway' || onRoute.has(ed.to)) continue
      // out along the side taxiway, about as far from the junction as we are
      let prev = J.id, cur = ed.to, d = Math.hypot(xy(cur).x - xy(J.id).x, xy(cur).y - xy(J.id).y)
      const want = Math.min(260, Math.max(110, (J.s - a.distAlong) * 0.6))
      while (d < want) {
        const nx = e.air.nodes.get(cur)?.edges.find(x => x.type === 'taxiway' && x.to !== prev && !onRoute.has(x.to)); if (!nx) break
        d += Math.hypot(xy(nx.to).x - xy(cur).x, xy(nx.to).y - xy(cur).y); prev = cur; cur = nx.to
      }
      if (d < 90) continue
      e.spawnAt({ callsign: 'ASA331', type: 'A320', kind: 'arrival', phase: 'taxi', taxiwayNode: cur, plan: { gateRef: stands[0] }, onFrequency: 'ground' })
      const b = e.find('ASA331'); if (!b) continue
      const jx = xy(J.id)
      for (const ref of stands) {
        // its route must go through the junction and leave our route there (across it, or away from us)
        const pv = e.previewTaxi(b, { kind: 'stand', ref }); const Q = pv?.path; if (!Q) continue
        let through = -1; for (let s = 0; s < Q.total; s += 5) { const p = pointAt(Q, s); if (Math.hypot(p.x - jx.x, p.y - jx.y) < 12) { through = s; break } }
        if (through < 0) continue
        // after the junction it must not come down our taxiway towards us (that is head-on with extra steps)
        const ours: { x: number; y: number }[] = []; for (let s = a.distAlong; s < J.s; s += 6) ours.push(pointAt(P, s))
        let back = false
        for (let s = through + 15; s < Math.min(Q.total, through + 200) && !back; s += 6) { const q = pointAt(Q, s); back = ours.some(o => Math.hypot(o.x - q.x, o.y - q.y) < 22) }
        // nor did it come along our taxiway ahead of the junction (its approach must be from the side)
        let along = false
        for (let s = Math.max(0, through - 120); s < through - 15 && !along; s += 6) { const q = pointAt(Q, s); for (let t = J.s - 5; t < Math.min(P.total, J.s + 150); t += 6) { const o = pointAt(P, t); if (Math.hypot(o.x - q.x, o.y - q.y) < 22) { along = true; break } } }
        if (back || along) continue
        b.plan.gateRef = ref; say(e, `ASA331 taxi to stand ${ref}`, RUN)
        return true
      }
      e.remove(b.id)
    }
  }
  return false
}
/** The give-way scene for our aircraft: crossing traffic at a junction ahead (head-on only as a last resort). */
function opposing(e: SimEngine, a: AircraftState): void {
  if (crossingTraffic(e, a)) return
  if (e.find('ASA331') || !a.path) return
  // ahead on our route, well short of the next hold, never right on top of us
  const s = Math.max(a.distAlong + 120, Math.min(a.distAlong + 380, (holdsAhead(a)[0]?.at ?? a.path.total) - 50))
  const node = e.nearestNodeId(pointAt(a.path, s), 300); if (!node) return
  e.spawnAt({ callsign: 'ASA331', type: 'A320', kind: 'arrival', phase: 'taxi', taxiwayNode: node, plan: { gateRef: freeStand(e, ['A5', 'A3', 'A2', 'A11', 'A12']) }, onFrequency: 'ground' })
  const b = e.find('ASA331'); if (b) say(e, `ASA331 taxi to stand ${b.plan.gateRef}`, RUN)
}
/** A departure lined up on 01L; it rolls when ours gets to the 01L hold. */
function crossTraffic(e: SimEngine): void {
  if (!e.find('SWA902')) e.spawnAt({ callsign: 'SWA902', type: 'B738', kind: 'departure', phase: 'lineup', runway: '01L', plan: { runway: '01L' }, onFrequency: 'tower' })
}
let swaRolled = false
/** The Alaska has come and gone: it got close and is now opening, or it is on its stand (or gone). Tracked per tick. */
function passed(L: Live): boolean {
  const a = ac(L), b = L.e.find('ASA331'); if (!a || !b || b.phase === 'arrived' || b.phase === 'parked') return true
  const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y); const m = Math.min((L.ctx.data.asaMin as number | undefined) ?? 1e9, d); L.ctx.data.asaMin = m
  return m < 250 && d > m + 90
}

const GROUND: Chapter[] = [
  {
    id: 'g-radio', tab: 'ground', title: 'Radio 101', ui: 'radio',
    summary: 'Before you say a word: how controllers say callsigns, numbers and letters.',
    setup: (e) => { freshPush(e); return { cs: GCS, others: [], data: {} } },
    goals: [
      { id: 'callsign', title: 'Callsigns', why: 'Airline name, then the flight number.', done: () => false },
      { id: 'numbers', title: 'Numbers', why: 'Digit by digit; thousands as thousands.', done: () => false },
      { id: 'letters', title: 'Letters', why: 'The phonetic alphabet.', done: () => false },
    ],
  },
  {
    id: 'g-push', tab: 'ground', title: 'Pushback',
    summary: 'Aircraft park nose-in at the gate. To leave they are pushed back by a tug, and you approve it.',
    story: { from: 268, to: 318, lines: [] },
    setup: (e) => { freshPush(e); return { cs: GCS, others: [], data: {} } },
    resume: (e) => keep(e, (a) => a.phase === 'parked'),
    cues: (L) => [{ kind: 'clear' }, camOn(ac(L), 300, 0.62, undefined, 2200), { kind: 'mark', id: 'who', at: xyOf(ac(L)), label: `${L.ctx.cs} · ready to push`, tone: 'info' }],
    goals: [
      { id: 'push', title: 'Approve the pushback', why: 'One short call. The pilot reads it back, then the tug starts pushing.', say: (L) => `${L.ctx.cs} pushback approved`, done: (L) => { const a = ac(L); return !!a && a.phase !== 'parked' } },
      { id: 'watch', title: 'Watch it come off the stand', why: 'The main wheels roll straight back and the nose swings round on the tug, so it ends up lined up on the taxilane.', done: (L) => { const a = ac(L); return !!a && (a.phase === 'startup' || a.phase === 'taxi' || a.pushback.stage === 'tug_disconnect' || a.pushback.stage === 'complete') }, when: (L) => ac(L)?.phase === 'pushback' },
    ],
    react: (L, ev) => (ev.type === 'pushback' && ev.callsign === L.ctx.cs ? 'There it goes. A 747 is pushed at walking pace: give it room.' : null),
  },
  {
    id: 'g-taxi', tab: 'ground', title: 'Taxi route',
    summary: 'A taxi clearance is a destination and a route: the taxiways, in order. The pilot follows exactly what you say.',
    setup: (e) => {
      const a = freshPush(e)
      say(e, `${GCS} pushback approved`, RUN)
      fastForward(e, () => a.phase === 'startup' || a.phase === 'taxi', 400)
      return { cs: GCS, others: [], data: {} }
    },
    resume: (e) => keep(e, (a) => ['pushback', 'startup', 'taxi'].includes(a.phase) && !taxiing(a)),
    cues: (L) => {
      const a = ac(L); const pv = a ? routePreview(L.e, a, '01R') : null
      L.ctx.data.names = pv?.names ?? []
      const mid = pv ? pv.path.pts[Math.floor(pv.path.pts.length / 2)] : xyOf(a)
      const out: Cue[] = [{ kind: 'clear' }, { kind: 'camera', at: mid, dist: 1900, pitch: 1.5, ms: 2400 }]
      if (pv) out.push(routeCue('route', pv, 1000))
      return out
    },
    goals: [
      { id: 'taxi', title: 'Clear it to the runway', why: 'Name the runway and the route, taxiway by taxiway. Leave the route out and the pilot takes the usual one.', say: (L) => { const n = (L.ctx.data.names as string[] | undefined) ?? []; return `${L.ctx.cs} taxi to runway 01R${n.length ? ` via ${n.join(' ')}` : ''}` }, done: (L) => { const a = ac(L); return !!a && (a.plan.taxiRoute?.length ?? 0) > 0 && (a.phase === 'taxi' || a.phase === 'startup') && saidAny(L, L.ctx.cs, ['taxi']) } },
      { id: 'own', title: 'Try a different route', why: 'Give it another route: it re-plans from where it is.', optional: true, done: (L) => L.events.filter(ev => ev.type === 'readback' && ev.callsign === L.ctx.cs && ev.data?.type === 'readback' && ev.data.ast?.kind === 'taxi').length >= 2 },
    ],
    react: (L, ev) => {
      if (ev.type !== 'readback' || ev.callsign !== L.ctx.cs || ev.data?.type !== 'readback' || ev.data.ast?.kind !== 'taxi') return null
      const a = ac(L); const mine = a?.plan.taxiRoute?.join(' ') ?? ''; const sug = ((L.ctx.data.names as string[] | undefined) ?? []).join(' ')
      return mine && sug && mine !== sug ? `Your own route: ${mine}. That works: the pilot follows what you said.` : 'Route given. On the way it has to cross runway 01L: that comes later.'
    },
  },
  {
    id: 'g-stop', tab: 'ground', title: 'Stop and go',
    summary: 'You can stop anything that moves and let it go again. It is the first tool when two aircraft get close.',
    setup: (e) => { freshTaxi(e, (a) => taxiing(a) && a.distAlong > 60); return { cs: GCS, others: [], data: {} } },
    resume: (e) => keep(e, (a) => (taxiing(a) || (a.phase === 'startup' && !!a.plan.taxiRoute)) && toFirstHold(a) > 120),
    cues: (L) => [{ kind: 'clear' }, { ...camOn(ac(L), 420, 0.8), follow: ac(L)?.id }],
    goals: [
      { id: 'hold', title: 'Stop it where it is', why: '"Hold position": it brakes and stays put until you say otherwise.', say: (L) => `${L.ctx.cs} hold position`, done: (L) => saidAny(L, L.ctx.cs, STOP_KINDS) && (ac(L)?.speed ?? 9) < 1, when: (L) => (ac(L)?.speed ?? 0) > 1 },
      { id: 'go', title: 'Let it continue', why: '"Continue taxi": it carries on along the route it already has.', say: (L) => `${L.ctx.cs} continue taxi`, done: (L) => saidAny(L, L.ctx.cs, ['continue']) && (ac(L)?.speed ?? 0) > 2, when: (L) => saidAny(L, L.ctx.cs, STOP_KINDS) },
    ],
  },
  {
    id: 'g-giveway', tab: 'ground', title: 'Giving way',
    summary: 'Two aircraft heading for the same piece of taxiway will meet. Decide who goes first before they do.',
    setup: (e) => { const a = freshTaxi(e, (x) => taxiing(x) && x.distAlong > 40); opposing(e, a); return { cs: GCS, others: ['ASA331'], data: {} } },
    resume: (e) => { const c = keep(e, (a) => (taxiing(a) || (a.phase === 'startup' && !!a.plan.taxiRoute)) && toFirstHold(a) > 160, {}); if (c) { opposing(e, gAc(e)!); c.others = ['ASA331'] } return c },
    cues: (L) => [{ kind: 'clear' }, camOn(ac(L), 800, 1.05, undefined, 2000), ...(L.e.find('ASA331') ? [{ kind: 'mark' as const, id: 'asa', at: xyOf(L.e.find('ASA331')), label: 'ASA331 · coming your way', tone: 'stop' as const }] : [])],
    goals: [
      { id: 'give', title: 'Make one wait for the other', why: '"Give way to ASA331" (or "hold position") keeps them apart. Then both carry on.', say: (L) => `${L.ctx.cs} give way to ASA331`, done: (L) => saidAny(L, L.ctx.cs, STOP_KINDS) || saidAny(L, 'ASA331', STOP_KINDS) },
      { id: 'clear', title: 'Both on their way, no conflict', why: 'When the Alaska has crossed in front, ours goes on by itself. If you told it to hold, say "continue taxi".', say: (L) => { const a = ac(L); return a && a.speed < 1 && passed(L) ? `${L.ctx.cs} continue taxi` : null }, done: (L) => { const a = ac(L); return !happened(L, 'ground_conflict') && !!a && a.speed > 2 && passed(L) }, when: (L) => saidAny(L, L.ctx.cs, STOP_KINDS) || saidAny(L, 'ASA331', STOP_KINDS) },
    ],
    react: (L, ev) => (ev.type === 'ground_conflict' ? 'Too close. Stop one of them with "hold position", then let the other pass.' : null),
  },
  {
    id: 'g-cross', tab: 'ground', title: 'Crossing a runway',
    summary: 'Nobody goes onto a runway without your words. The route stops at every runway it crosses until you clear it across.',
    setup: (e) => { swaRolled = false; freshTaxi(e, (a) => a.phase === 'hold_short'); crossTraffic(e); return { cs: GCS, others: ['SWA902'], data: { rwy: '01L' } } },
    resume: (e) => { swaRolled = false; const c = keep(e, (a) => (taxiing(a) && holdsAhead(a).some(h => h.runway === '01L' || h.runway === '19R')) || (a.phase === 'hold_short' && a.holdShortRunway === '01L'), { rwy: '01L' }); if (c) { crossTraffic(e); c.others = ['SWA902'] } return c },
    tick: (L) => {
      const a = ac(L); if (swaRolled || !a) return
      if (a.phase === 'hold_short' || toFirstHold(a) < 140) { swaRolled = true; say(L.e, 'SWA902 runway 01L cleared for takeoff', RUN) }
    },
    cues: (L) => { const a = ac(L); const h = a?.path?.holds?.find(x => x.runway === '01L' || x.runway === '19R'); const p = h && a?.path ? a.path.pts[a.path.cum.findIndex(c => c >= h.at)] ?? xyOf(a) : xyOf(a); return [{ kind: 'clear' }, { kind: 'camera', at: p, dist: 900, pitch: 0.95, ms: 2000 }, { kind: 'mark', id: 'hold', at: p, label: 'Hold short · runway 01L', tone: 'stop' }] },
    goals: [
      { id: 'wait', title: 'Let the departure go first', why: 'It stops at the 01L hold line by itself. A Southwest 737 is rolling on 01L: crossing in front of it is a runway incursion, the worst thing on the ground. Wait until it is airborne.', done: (L) => { const b = L.e.find('SWA902'); return swaRolled && (!b || (b.phase !== 'takeoff' && b.altitude > 300)) && !L.e.runwayOccupied('01L') } },
      { id: 'cross', title: 'Clear it across', why: 'Name the runway: "cross runway 01L". It crosses, then reports vacated.', say: (L) => `${L.ctx.cs} cross runway 01L`, done: (L) => { const a = ac(L); return !!a && saidAny(L, L.ctx.cs, ['cross']) && a.holdShortRunway !== '01L' && a.phase !== 'hold_short' }, when: (L) => { const b = L.e.find('SWA902'); return swaRolled && (!b || (b.phase !== 'takeoff' && b.altitude > 300)) } },
    ],
    react: (L, ev) => {
      if (ev.type === 'alert' && ev.data?.type === 'alert' && ev.data.alert.kind === 'runway_incursion') return 'Runway incursion: it went onto 01L while it was in use. Hold it, and next time wait for the runway to be clear.'
      if (ev.type === 'airborne' && ev.callsign === 'SWA902') return 'The Southwest is airborne. Runway 01L is clear: you can cross.'
      return null
    },
  },
  {
    id: 'g-handoff', tab: 'ground', title: 'Over to tower',
    summary: 'The runway belongs to the tower. At the last holding point, ground hands the aircraft over.',
    setup: (e) => {
      const a = freshTaxi(e, (x) => x.phase === 'hold_short')
      say(e, `${GCS} cross runway ${a.holdShortRunway ?? '01L'}`, RUN)
      fastForward(e, () => (a.phase === 'hold_short' && a.holdShortRunway !== '01L') || (taxiing(a) && a.path!.total - a.distAlong < 60), 900)
      return { cs: GCS, others: [], data: {} }
    },
    resume: (e) => keep(e, (a) => (taxiing(a) || a.phase === 'hold_short') && a.holdShortRunway !== '01L' && !holdsAhead(a).some(h => h.runway === '01L' || h.runway === '19R')),
    cues: (L) => [{ kind: 'clear' }, camOn(ac(L), 500, 0.8)],
    goals: [
      { id: 'contact', title: 'Hand it to the tower', why: '"Contact tower": the pilot changes frequency and calls the tower, ready for departure. Your job with it is done.', say: (L) => `${L.ctx.cs} contact tower`, done: (L) => ac(L)?.onFrequency === 'tower' || ac(L)?.onFrequency === 'departure' || !ac(L) },
    ],
  },
]

// ---------------------------------------------------------------------------------------------------------------------
// TOWER: the runways. Departures on 01R, arrivals on 28L (they cross: one at a time over the intersection)
// ---------------------------------------------------------------------------------------------------------------------
const TCS = 'SKW5520', LCS = 'DAL2140'
function departureAtHold(e: SimEngine, cs: string, runway = '01R', type = 'E75L'): AircraftState {
  e.spawnAt({ callsign: cs, type, kind: 'departure', phase: 'hold_short', runway, plan: { runway }, onFrequency: 'tower' })
  const a = e.find(cs)!
  e.raiseRequest(a, 'ready')
  return a
}
function arrivalOnFinal(e: SimEngine, cs: string, runway: string, nm: number, type = 'A321', freq: 'tower' | 'approach' = 'tower'): AircraftState {
  const alt = Math.max(200, Math.round(nm * 1852 * Math.tan(3 * Math.PI / 180) * 3.28084 / 100) * 100 - 60)
  e.spawnAt({ callsign: cs, type, kind: 'arrival', phase: 'approach', posRel: { fromRunway: runway, alongNM: -nm - 0.5, altFt: alt + 160 }, ils: runway, speedKts: 170, plan: { runway }, onFrequency: freq })
  const a = e.find(cs)!
  fastForward(e, () => a.ilsCaptured, 30)   // established on the localizer before the player sees it
  return a
}
const thr = (e: SimEngine, rwy: string): XY => e.thresholdXY(rwy) ?? { x: 0, y: 0 }

const TOWER: Chapter[] = [
  {
    id: 't-depart', tab: 'tower', title: 'Line up, take off',
    summary: 'Two steps onto the runway: line up and wait, then the takeoff clearance. Only the tower gives either.',
    story: { from: 352, to: 404, lines: [[353, 'Lined up on the centreline, waiting for one sentence.'], [366, '"Cleared for takeoff." Full power. 160 knots in about forty seconds.'], [392, 'It rotates on its main wheels, nose up eight degrees, and climbs away.']] },
    setup: (e) => { baseScene(e, 'tower'); departureAtHold(e, TCS); return { cs: TCS, others: [], data: {} } },
    cues: (L) => [{ kind: 'clear' }, { kind: 'camera', at: thr(L.e, '01R'), dist: 700, pitch: 0.55, ms: 2200 }, { kind: 'mark', id: 'hp', at: xyOf(ac(L)), label: `${L.ctx.cs} · ready, runway 01R`, tone: 'info' }],
    goals: [
      { id: 'lineup', title: 'Line it up', why: '"Line up and wait": it taxis onto the runway and stops on the centreline. Useful while you wait for the gap.', say: (L) => `${L.ctx.cs} runway 01R line up and wait`, done: (L) => { const a = ac(L); return !!a && ['lineup', 'takeoff', 'climb'].includes(a.phase) } },
      { id: 'takeoff', title: 'Clear it for takeoff', why: 'Runway and clearance in one call. Check the runway and the approach are clear first: nothing on final for 28L near the intersection.', say: (L) => `${L.ctx.cs} runway 01R cleared for takeoff`, done: (L) => { const a = ac(L); return !a || a.phase === 'takeoff' || a.phase === 'climb' || a.altitude > 0 } },
      { id: 'away', title: 'Watch it climb out', why: 'Once airborne it goes to departure by itself. The runway is yours again.', done: (L) => { const a = ac(L); return !a || a.altitude > 400 }, when: (L) => ac(L)?.phase === 'takeoff' },
    ],
  },
  {
    id: 't-land', tab: 'tower', title: 'Cleared to land',
    summary: 'Every arrival needs "cleared to land" before it crosses the threshold. No clearance, no landing: it goes around.',
    story: { from: 146, to: 212, lines: [[148, 'On the ILS, a mile every twenty seconds, three degrees down to the runway.'], [176, 'The tower has to say three words before the threshold: cleared to land.'], [198, 'Touchdown 300 metres in, then off the runway at the first fast exit.']] },
    setup: (e) => { baseScene(e, 'tower'); arrivalOnFrequency(e, LCS, '28L', 7); return { cs: LCS, others: [], data: {} } },
    cues: (L) => [{ kind: 'clear' }, { kind: 'camera', at: thr(L.e, '28L'), dist: 2400, pitch: 0.5, ms: 2400 }],
    goals: [
      { id: 'land', title: 'Clear it to land', why: 'Runway first, then the clearance: "runway 28L, cleared to land". Give it once the runway will be free when it arrives.', say: (L) => `${L.ctx.cs} runway 28L cleared to land`, done: (L) => !!ac(L)?.landingCleared || happened(L, 'touchdown', L.ctx.cs) },
      { id: 'down', title: 'Watch the landing', why: 'It touches down, slows and turns off. Then it belongs to ground.', done: (L) => happened(L, 'touchdown', L.ctx.cs) || ['rollout', 'taxi', 'arrived', 'parked'].includes(ac(L)?.phase ?? ''), when: (L) => !!ac(L)?.landingCleared },
      { id: 'ground', title: 'Send it to ground', why: '"Contact ground" when it is off the runway, so ground can taxi it in.', say: (L) => `${L.ctx.cs} contact ground`, done: (L) => ac(L)?.onFrequency === 'ground' || !ac(L), when: (L) => happened(L, 'touchdown', L.ctx.cs), optional: true },
    ],
  },
  {
    id: 't-gap', tab: 'tower', title: 'One at a time',
    summary: 'At SFO the departure runway crosses the landing runway. A departure can only roll when the next arrival is far enough out.',
    setup: (e) => { baseScene(e, 'tower'); departureAtHold(e, TCS); arrivalOnFrequency(e, LCS, '28L', 3.2); return { cs: TCS, others: [LCS], data: {} } },
    cues: (L) => [{ kind: 'clear' }, { kind: 'camera', at: thr(L.e, '01R'), dist: 2200, pitch: 1.0, ms: 2400 }],
    goals: [
      { id: 'land', title: 'Clear the arrival to land', why: `${LCS} is 3 miles out on 28L. It lands first.`, say: () => `${LCS} runway 28L cleared to land`, done: (L) => !!L.e.find(LCS)?.landingCleared || happened(L, 'touchdown', LCS) },
      { id: 'wait', title: 'Hold the departure until the arrival is past the intersection', why: 'Let it land and slow down past 01R before the departure rolls. "Line up and wait" now is fine; the takeoff clearance waits.', done: (L) => { const b = L.e.find(LCS); return happened(L, 'touchdown', LCS) && (!b || b.speed < 60) } },
      { id: 'go', title: 'Then clear the departure', why: 'Runway free, no one close on final: cleared for takeoff.', say: (L) => `${L.ctx.cs} runway 01R cleared for takeoff`, done: (L) => { const a = ac(L); return !a || a.phase === 'takeoff' || a.phase === 'climb' }, when: (L) => happened(L, 'touchdown', LCS) },
    ],
    react: (L, ev) => (ev.type === 'alert' && ev.data?.type === 'alert' && (ev.data.alert.kind === 'occupied_runway_clearance' || ev.data.alert.kind === 'runway_incursion') ? 'Too soon: both would be at the intersection together. Cancel the takeoff ("hold position, cancel takeoff clearance"), or send the arrival around.' : null),
  },
  {
    id: 't-goaround', tab: 'tower', title: 'Go around',
    summary: 'If the runway will not be clear in time, the arrival climbs away and comes back. It is safe and normal.',
    setup: (e) => {
      baseScene(e, 'tower')
      e.spawnAt({ callsign: 'N731SF', type: 'C208', kind: 'departure', phase: 'lineup', runway: '28L', plan: { runway: '28L' }, onFrequency: 'tower' })
      arrivalOnFrequency(e, LCS, '28L', 2.2)
      return { cs: LCS, others: ['N731SF'], data: {} }
    },
    cues: (L) => [{ kind: 'clear' }, { kind: 'camera', at: thr(L.e, '28L'), dist: 1600, pitch: 0.55, ms: 2000 }, { kind: 'mark', id: 'blk', at: xyOf(L.e.find('N731SF')), label: 'Runway 28L occupied', tone: 'stop' }],
    goals: [
      { id: 'ga', title: 'Send it around', why: 'A Cessna is still on 28L and the arrival is 2 miles out. "Go around": it climbs straight ahead and approach brings it back.', say: (L) => `${L.ctx.cs} go around`, done: (L) => ac(L)?.phase === 'go_around' || happened(L, 'go_around', L.ctx.cs) },
    ],
    react: (L, ev) => (ev.type === 'go_around' && ev.callsign === L.ctx.cs ? 'Going around. Nobody minds: a go-around is always better than a crowded runway.' : null),
  },
]
function arrivalOnFrequency(e: SimEngine, cs: string, rwy: string, nm: number): AircraftState { return arrivalOnFinal(e, cs, rwy, nm, 'A321', 'tower') }

// ---------------------------------------------------------------------------------------------------------------------
// APPROACH: the radar. Arrivals from the south-east, vectored onto the ILS for 28L
// ---------------------------------------------------------------------------------------------------------------------
const ACS = 'UAL1729', BCS = 'AAL2273', CCS = 'DAL1450'
function arrivalAt(e: SimEngine, cs: string, along: number, offset: number, alt: number, hdg: number, type = 'B739'): AircraftState {
  e.spawnAt({ callsign: cs, type, kind: 'arrival', phase: 'descent', posRel: { fromRunway: '28L', alongNM: -along, offsetNM: offset, altFt: alt }, heading: hdg, speedKts: 250, altFt: alt, targets: { alt, ias: 250, hdg }, plan: { runway: '28L' }, onFrequency: 'approach' })
  return e.find(cs)!
}
const norm360 = (d: number) => ((d % 360) + 360) % 360
const L_MAGVAR = (e: SimEngine) => e.air.magVar || 0
/** The final course into a runway (true degrees, the way the aircraft lands) and which side of it a point is: +1 right. */
function finalCourse(e: SimEngine, rwy: string, p: XY): { course: number; side: number } {
  const r = e.runwayByEnd(rwy); const t = e.thresholdXY(rwy); const o = r ? e.thresholdXY(r.other.name) : null
  if (!t || !o) return { course: 0, side: 1 }
  const dx = o.x - t.x, dy = o.y - t.y
  const course = norm360((Math.atan2(dx, dy) * 180) / Math.PI)
  const cross = dx * (p.y - t.y) - dy * (p.x - t.x)
  return { course, side: cross < 0 ? 1 : -1 }
}
/** Where a point is against the 28L final: miles off the centreline, and miles out from the threshold along it. */
function finalGeom(e: SimEngine, p: XY): { offNM: number; alongNM: number } {
  const r = e.runwayByEnd('28L'); const t = e.thresholdXY('28L'); const o = r ? e.thresholdXY(r.other.name) : null
  if (!t || !o) return { offNM: 0, alongNM: 0 }
  const dx = o.x - t.x, dy = o.y - t.y, L = Math.hypot(dx, dy) || 1
  return { offNM: Math.abs(dx * (p.y - t.y) - dy * (p.x - t.x)) / L / 1852, alongNM: -((p.x - t.x) * dx + (p.y - t.y) * dy) / L / 1852 }
}
/** The vectors onto the final from where the aircraft is now (live, so the card follows the aircraft): far out to the
 *  side, a base leg 80 degrees to the final to close the gap; within 3.5 miles, the 30 degree cut the localizer captures
 *  from. Headings are given magnetic, turns the short way round. */
function ilsVector(e: SimEngine, a: AircraftState): { kind: 'base' | 'cut'; hdg: number; turn: string; cutOk: boolean } {
  const { course, side } = finalCourse(e, '28L', a.pos); const g = finalGeom(e, a.pos)
  const ang = g.offNM > 3.5 ? 80 : 30
  const tT = norm360(course + (side > 0 ? -ang : ang)), hdg = Math.round(norm360(tT - L_MAGVAR(e)) / 10) * 10 || 360
  const d = ((tT - a.heading + 540) % 360) - 180
  // already on a good cut: converging at 15 to 35 degrees to the final
  const conv = ((a.targetHeading - course + 540) % 360) - 180
  const cutOk = Math.abs(conv) >= 15 && Math.abs(conv) <= 35 && Math.sign(conv) === (side > 0 ? -1 : 1)
  return { kind: g.offNM > 3.5 ? 'base' : 'cut', hdg, turn: d < 0 ? 'left' : 'right', cutOk }
}
const ilsSay = (L: Live) => { const a = ac(L); if (!a) return null; const v = ilsVector(L.e, a); return `${L.ctx.cs} turn ${v.turn} heading ${String(v.hdg).padStart(3, '0')}` }
const APPROACH: Chapter[] = [
  {
    id: 'a-vectors', tab: 'approach', title: 'Heading, altitude, speed',
    summary: 'On the radar you move aircraft with three numbers: which way, how high, how fast.',
    story: { from: 44, to: 146, lines: [[46, 'The approach radar: every target is an aircraft, every tag its height and speed.'], [80, 'They come in from all sides. Your job is to turn them into one tidy line.'], [118, 'A heading, an altitude, a speed: that is all you say.']] },
    setup: (e) => { baseScene(e, 'approach', false); arrivalAt(e, ACS, 22, -9, 9000, 315); return { cs: ACS, others: [], data: {} } },
    goals: [
      { id: 'hdg', title: 'Turn it', why: '"Turn left heading 270": it banks onto that compass heading and holds it.', say: (L) => `${L.ctx.cs} turn left heading 270`, done: (L) => saidAny(L, L.ctx.cs, ['heading']) },
      { id: 'alt', title: 'Bring it down', why: '"Descend and maintain 5000": it descends and levels at 5000 feet.', say: (L) => `${L.ctx.cs} descend and maintain 5000`, done: (L) => (ac(L)?.targetAltitude ?? 99999) <= 6000 },
      { id: 'spd', title: 'Slow it', why: '"Reduce speed 210": slower aircraft are easier to space.', say: (L) => `${L.ctx.cs} reduce speed 210`, done: (L) => (ac(L)?.targetSpeed ?? 999) <= 220 },
    ],
  },
  {
    id: 'a-ils', tab: 'approach', title: 'Onto the ILS',
    summary: 'The ILS is a radio beam down to the runway. Point the aircraft at it at a shallow angle, then clear the approach.',
    setup: (e) => {
      baseScene(e, 'approach', false)
      const a = arrivalAt(e, ACS, 14, -3, 3000, 0)   // below the glideslope where it will meet the localizer, as it should be
      const { course, side } = finalCourse(e, '28L', a.pos)
      // on a wide base toward the final, 70 degrees to it; the player turns it to a 30 degree cut (headings are magnetic)
      const base = norm360(course + (side > 0 ? -70 : 70)), cut = norm360(course + (side > 0 ? -30 : 30) - L_MAGVAR(e))
      a.heading = a.targetHeading = base; a.speed = 210; a.targetSpeed = 210
      void cut
      return { cs: ACS, others: [], data: {} }
    },
    // the aircraft from the last mission, if it is still well clear of the localizer with room to set up an intercept
    resume: (e) => {
      const a = e.find(ACS); if (!a || a.ilsArmed || a.onFrequency !== 'approach' || a.altitude < 2000) return null
      const g = finalGeom(e, a.pos); if (g.alongNM < 14) return null
      seat(e, 'approach')
      return { cs: ACS, others: [], data: {} }
    },
    goals: [
      { id: 'base', title: 'Turn it towards the final', why: 'Far out to the side it first needs a base leg: about 80 degrees to the final, to close the gap. Close in, this is already done.', say: ilsSay, done: (L) => { const a = ac(L); return !!a && finalGeom(L.e, a.pos).offNM <= 3.5 } },
      { id: 'int', title: 'Point it at the localizer', why: 'About 30 degrees to the final course, so it meets the beam gently. Turned straight at it, it would fly through.', say: ilsSay, done: (L) => { const a = ac(L); return !!a && ilsVector(L.e, a).cutOk }, when: (L) => { const a = ac(L); return !!a && finalGeom(L.e, a.pos).offNM <= 3.5 } },
      { id: 'low', title: 'Bring it down to 3000', why: 'It has to meet the glideslope from below: on the beam above it, it would never catch the slope. "Descend and maintain 3000".', say: (L) => `${L.ctx.cs} descend and maintain 3000`, done: (L) => (ac(L)?.targetAltitude ?? 99999) <= 3500 },
      { id: 'ils', title: 'Clear the ILS', why: '"Cleared ILS runway 28L approach": it turns onto the beam itself and follows the glideslope down.', say: (L) => `${L.ctx.cs} cleared ILS runway 28L approach`, done: (L) => !!ac(L)?.ilsArmed },
      { id: 'cap', title: 'Watch it capture', why: 'The tag shows it locked on. From here it flies itself to the runway.', done: (L) => !!ac(L)?.ilsCaptured, when: (L) => !!ac(L)?.ilsArmed },
      { id: 'twr', title: 'Hand it to the tower', why: '"Contact tower" once it is established. The tower clears it to land.', say: (L) => `${L.ctx.cs} contact tower`, done: (L) => ac(L)?.onFrequency === 'tower', when: (L) => !!ac(L)?.ilsCaptured },
    ],
  },
  {
    id: 'a-sep', tab: 'approach', title: 'Keeping them apart',
    summary: 'Two aircraft must stay 3 miles apart, or 1000 feet above each other. The radar warns you before it happens.',
    setup: (e) => {
      baseScene(e, 'approach', false)
      arrivalAt(e, CCS, 20, -6, 6000, 330)
      arrivalAt(e, BCS, 20, 6, 6000, 240, 'A321')
      return { cs: CCS, others: [BCS], data: {} }
    },
    // the sky carries on: the last mission's United lands in the background while a new pair converges further out
    resume: (e) => {
      if (!e.find(ACS) || e.find(CCS) || e.find(BCS)) return null
      seat(e, 'approach')
      arrivalAt(e, CCS, 20, -6, 6000, 330)
      arrivalAt(e, BCS, 20, 6, 6000, 240, 'A321')
      return { cs: CCS, others: [BCS], data: {} }
    },
    goals: [
      { id: 'split', title: 'Separate them', why: 'They are converging at the same height. Split them by 1000 feet ("climb and maintain 7000") or turn one away.', say: (L) => `${BCS} climb and maintain 7000`, done: (L) => saidAny(L, L.ctx.cs, ['altitude', 'heading']) || saidAny(L, BCS, ['altitude', 'heading']) },
      { id: 'safe', title: 'Keep them apart for a minute', why: 'No separation loss for 60 seconds while they pass.', done: (L) => !happened(L, 'separation_loss') && L.e.time - L.t0 > 60 && (saidAny(L, L.ctx.cs, ['altitude', 'heading']) || saidAny(L, BCS, ['altitude', 'heading'])) },
    ],
    react: (L, ev) => (ev.type === 'separation_loss' ? 'Separation lost: they were under 3 miles and 1000 feet. Turn them apart, then build the gap back.' : null),
  },
]

export const CHAPTERS: Chapter[] = [...GROUND, ...TOWER, ...APPROACH]
export const chaptersOf = (tab: Tab) => CHAPTERS.filter(c => c.tab === tab)
/** The numbered missions of a tab (lessons drawn by the page, like Radio 101, are not counted). */
export const missionsOf = (tab: Tab) => chaptersOf(tab).filter(c => !c.ui)

// Integration: a seeded EGLL session driven ONLY through executeText() (the
// typed-command entry point the store will use), plus a long auto-traffic soak.
//
// Session (segregated mode, arrivals 27L / departures 27R):
//   - 6 departures spawn parked: three on Terminal 4 stands (south of 27L) that
//     push back, start up, taxi via named taxiways S3 N3 holding short of 27L,
//     cross 27L behind a landing aircraft when the crossing lock allows and
//     continue to the A1 / A4 holding points of 27R; three on Terminal 1 stands
//     (between the runways, via A2 A1). Line up, take off (the HEAVY B77W is
//     followed by a MEDIUM so the departure wake timer is exercised), climb,
//     direct CPT, handoff to London Control.
//   - 6 arrivals spawn 17 NM out, 3 NM south of the 27L centreline, 150 s
//     apart: radar contact + descent, a 25-degree intercept vector, ILS, tower
//     handoff, landing clearance with an exit instruction ("continue approach"
//     while the runway is still occupied), taxi to a Terminal 2 stand, arrived.
//   - The last departure to get airborne gets an engine fire: MAYDAY ack,
//     priority + sterile runway 27R, 3 x ARFF to the runway, a right-hand
//     circuit at 2000 ft back onto the 27R ILS, tower handoff, landing, stop on
//     the runway, MAYDAY cancelled, ARFF recalled, runway reopened after inspection.
//   - Wind reversal at the end -> runway suggestion 09L/09R -> runway status
//     command through the parser.
// Every controller decision is a pure function of engine state (no Math.random),
// so two runs with the same seed must produce identical event logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, FIXED, NM_TO_M, KTS_TO_MPS, dist, angleDelta } from '../engine/helpers';
import type { SimEngine } from '../../src/lib/sim/engine';
import { executeText } from '../../src/lib/sim/dispatch';
import type { DispatchResult } from '../../src/lib/sim/dispatch';
import type { AircraftState, SimEvent, SimEventType, Vehicle } from '../../src/lib/sim/types';
import { WAKE_DEPARTURE_S } from '../../src/lib/sim/types';

// ──────────────────────────────────────────────────────────────────────────────
//  Invariant tracking (teleports, NaN, stuck, event shape)
// ──────────────────────────────────────────────────────────────────────────────
const EVENT_TYPES: readonly SimEventType[] = [
  'spawn', 'phase', 'stage', 'reached_hold', 'request', 'readback', 'transmission', 'startup', 'pushback', 'airborne', 'touchdown',
  'runway_vacated', 'arrived', 'departed', 'go_around', 'landing_clearance', 'handoff', 'wake', 'runway_state', 'atis', 'vehicle',
  'emergency', 'alert', 'ground_conflict', 'separation_loss', 'diversion', 'fuel_exhaustion', 'score', 'removed', 'info',
];

interface Invariants {
  teleports: string[];
  nans: string[];
  stuck: string[];
  badEvents: string[];
  events: SimEvent[];
  /** Continuous seconds at 0 kt while cleared to move, per aircraft id. */
  stoppedS: Map<number, number>;
  maxAircraft: number;
  lastAt: number;
}
function newInvariants(): Invariants { return { teleports: [], nans: [], stuck: [], badEvents: [], events: [], stoppedS: new Map(), maxAircraft: 0, lastAt: -1 }; }

const finite = (...xs: number[]) => xs.every(x => typeof x === 'number' && Number.isFinite(x));

function checkEvent(ev: SimEvent, inv: Invariants) {
  const bad = (why: string) => inv.badEvents.push(`${ev.at?.toFixed?.(2)} ${ev.type} ${ev.callsign}: ${why}`);
  if (!EVENT_TYPES.includes(ev.type)) bad(`unknown type ${ev.type}`);
  if (typeof ev.id !== 'number' || !Number.isFinite(ev.id)) bad('id not a number');
  if (typeof ev.callsign !== 'string' || !ev.callsign) bad('callsign missing');
  if (typeof ev.message !== 'string' || !ev.message.trim()) bad('message empty');
  if (!Number.isFinite(ev.at)) bad('at not finite');
  if (ev.at < inv.lastAt - 1e-6) bad(`at ${ev.at} before ${inv.lastAt}`);
  inv.lastAt = Math.max(inv.lastAt, ev.at);
  if (ev.data && ev.data.type !== ev.type) bad(`data.type ${ev.data.type} != ${ev.type}`);
  if (ev.who && !['ATC', 'PILOT', 'SYS', 'AI'].includes(ev.who)) bad(`who ${ev.who}`);
}

/** Advance the engine one fixed substep at a time for `s` seconds, checking teleports / NaN every tick. */
function advance(e: SimEngine, s: number, inv: Invariants) {
  const n = Math.round(s / FIXED);
  const prev = new Map<number, { x: number; y: number; speed: number }>();
  for (const a of e.aircraft) prev.set(a.id, { x: a.pos.x, y: a.pos.y, speed: a.speed });
  for (let i = 0; i < n; i++) {
    const evs = e.step(1);
    for (const ev of evs) { checkEvent(ev, inv); inv.events.push(ev); }
    const windKt = e.wx().windKt + e.wx().gustKt;
    for (const a of e.aircraft) {
      if (!finite(a.pos.x, a.pos.y, a.heading, a.speed, a.altitude, a.targetHeading, a.targetSpeed, a.targetAltitude, a.distAlong)) inv.nans.push(`${e.time.toFixed(2)} ${a.callsign} ${a.phase}`);
      const p = prev.get(a.id);
      if (p) {
        const moved = dist(p, a.pos);
        const allowed = (Math.max(p.speed, a.speed) + windKt) * KTS_TO_MPS * FIXED * 1.5 + 0.05;
        if (moved > allowed) inv.teleports.push(`${e.time.toFixed(2)} ${a.callsign} ${a.phase}: ${moved.toFixed(2)} m > ${allowed.toFixed(2)} m`);
      }
      prev.set(a.id, { x: a.pos.x, y: a.pos.y, speed: a.speed });
    }
    for (const id of [...prev.keys()]) if (!e.byId(id)) prev.delete(id);
  }
  inv.maxAircraft = Math.max(inv.maxAircraft, e.aircraft.length);
  // per-second: vehicles finite + stuck detection
  for (const v of e.fleet.list()) if (!finite(v.pos.x, v.pos.y, v.heading, v.speed)) inv.nans.push(`${e.time.toFixed(2)} ${v.id}`);
  for (const a of e.aircraft) {
    const clearedToMove = (a.phase === 'taxi' && !a.trafficHold) || (a.phase === 'pushback' && a.pushback.stage === 'pushing' && !a.trafficHold) || (a.phase === 'rollout' && !a.emergency);
    const cur = inv.stoppedS.get(a.id) ?? 0;
    if (clearedToMove && a.speed < 0.5) {
      inv.stoppedS.set(a.id, cur + s);
      if (cur + s > 120 && !inv.stuck.some(x => x.startsWith(a.callsign))) inv.stuck.push(`${a.callsign} ${a.phase} stopped ${Math.round(cur + s)} s at ${e.time.toFixed(0)} (path ${a.path ? `${a.distAlong.toFixed(0)}/${a.path.total.toFixed(0)} holds ${a.path.holds?.length ?? 0}` : 'none'}, holdReleased ${a.holdReleased})`);
    } else inv.stoppedS.set(a.id, 0);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  The scripted controller (state machine per callsign, text commands only)
// ──────────────────────────────────────────────────────────────────────────────
const DEP_RWY = '27R', ARR_RWY = '27L';
interface DepPlan { cs: string; type: string; stand: string; taxi: string; crossing: boolean; late: boolean }
const DEPARTURES: readonly DepPlan[] = [
  { cs: 'BAW117', type: 'A320', stand: '401', taxi: 'taxi to holding point runway 27R at A4 via S3 N3 hold short of runway 27L', crossing: true, late: false },
  { cs: 'UAE5', type: 'B77W', stand: '412', taxi: 'taxi to holding point runway 27R via S3 N3 A1 hold short of runway 27L', crossing: true, late: false },
  { cs: 'AFR1170', type: 'A320', stand: '416', taxi: 'taxi to holding point runway 27R at A4 via S3 N3 hold short of runway 27L', crossing: true, late: true },
  { cs: 'KLM3', type: 'E190', stand: '209', taxi: 'taxi to holding point runway 27R via A2 A1', crossing: false, late: false },
  { cs: 'DLH2', type: 'B738', stand: '211', taxi: 'taxi to holding point runway 27R via A2 A1', crossing: false, late: false },
  { cs: 'SWR7', type: 'A320', stand: '213', taxi: 'taxi to holding point runway 27R via A2 A1', crossing: false, late: false },
];
const HEAVY_CS = 'UAE5';
/** Arrival stream 150 s apart (about 6 NM on final); every gap gives one T4 departure a crossing behind the lander. */
const ARRIVALS = [
  { cs: 'EIN1', type: 'A320', stand: '216', at: 15 },
  { cs: 'QTR4', type: 'B738', stand: '218', at: 165 },
  { cs: 'AAL9', type: 'A321', stand: '220', at: 315 },
  { cs: 'SIA6', type: 'A320', stand: '231', at: 465 },
  { cs: 'DAL8', type: 'B738', stand: '233', at: 615 },
  { cs: 'CPA2', type: 'A320', stand: '238', at: 765 },
] as const;
/** Crossing time budget for the crossingSafe lock (03 D12 assumes 35 s; the S3/N3 dogleg takes a heavy ~80 s). */
const CROSSING_S = 85;

interface Issued { at: number; text: string; result: DispatchResult }

class Controller {
  readonly issued: Issued[] = [];
  readonly memo = new Map<string, string>();
  readonly stamp = new Map<string, number>();
  fireDeclaredAt: number | null = null;
  /** The last departure to get airborne becomes the engine-fire return (decided at run time, so the runway is free for it). */
  fireCs: string | null = null;
  windReversedAt: number | null = null;
  constructor(readonly e: SimEngine, readonly log: string[]) {}

  say(text: string): DispatchResult {
    const r = executeText(this.e, text).result;
    this.issued.push({ at: this.e.time, text, result: r });
    this.log.push(`${this.e.time.toFixed(0).padStart(5)} ATC> ${text}  [${r.code}${r.reason ? ' ' + r.reason : ''}]`);
    return r;
  }
  /** Issue `text` once per (callsign, key). */
  once(key: string, text: string): boolean {
    if (this.memo.has(key)) return false;
    this.memo.set(key, text);
    this.stamp.set(key, this.e.time);
    this.say(text);
    return true;
  }
  done(key: string): boolean { return this.memo.has(key); }
  since(key: string): number { const t = this.stamp.get(key); return t == null ? Infinity : this.e.time - t; }

  request(a: AircraftState, kind: string): boolean { return a.requests.some(r => r.kind === kind && r.answeredAt == null); }
  frame(runway: string, a: AircraftState): { along: number; cross: number } {
    const rs = this.e.runwayState(runway)!; const thr = this.e.thresholdXY(runway)!;
    const h = rs.headingTrue * Math.PI / 180;
    const dx = a.pos.x - thr.x, dy = a.pos.y - thr.y;
    return { along: dx * Math.sin(h) + dy * Math.cos(h), cross: dx * Math.cos(h) - dy * Math.sin(h) };
  }

  tick() {
    const e = this.e;
    for (const a of e.aircraft) {
      if (a.plan.kind === 'departure') { if (a.callsign === this.fireCs && a.emergency) this.emergency(a); else this.departure(a); }
      else this.arrival(a);
    }
    this.systems();
  }

  /** Apron sequencing: one pushback at a time per lane (nobody pushing / waiting for engines on the lane within 250 m). */
  pushbackLaneFree(a: AircraftState): boolean {
    return !this.e.aircraft.some(o => o.id !== a.id && o.plan.kind === 'departure' && dist(o.pos, a.pos) < 250
      && (o.phase === 'pushback' || (o.phase === 'startup' && o.pushback.stage === 'complete') || (o.phase === 'taxi' && o.speed < 1 && dist(o.pos, a.pos) < 150)));
  }

  departure(a: AircraftState) {
    const e = this.e, cs = a.callsign;
    const plan = DEPARTURES.find(d => d.cs === cs);
    switch (a.phase) {
      case 'parked':
        if (this.request(a, 'pushback') && this.pushbackLaneFree(a)) {
          // the "late" departure shares the HEAVY's lane and waits until it has pushed back, so a MEDIUM always follows it on 27R
          const heavy = e.find(HEAVY_CS);
          if (plan?.late && heavy && (heavy.phase === 'parked' || heavy.phase === 'pushback')) return;
          this.once(`${cs}:push`, `${cs} pushback approved start up approved expect runway ${DEP_RWY}`);
        }
        return;
      case 'startup':
        if (this.request(a, 'taxi') && plan) this.once(`${cs}:taxi`, `${cs} ${plan.taxi}`);
        return;
      case 'hold_short': {
        const req = a.requests.find(r => r.answeredAt == null);
        if (a.holdShortRunway === ARR_RWY && req?.kind === 'cross' && !a.holdReleased) {
          // crossing lock (03 D12): runway open, no vehicle, nobody lined up / rolling / crossing, a landing aircraft only when it
          // has rolled past the crossing point ("behind the landing traffic"), nearest arrival far enough for the whole crossing
          const rs = e.runwayState(ARR_RWY)!;
          const lander = rs.occupiedBy.length === 1 && rs.occupiedBy[0].kind === 'rollout' ? rs.occupiedBy[0].callsign : null;
          const clear = rs.status === 'open' && (!rs.occupiedBy.length || lander) && e.fleet.onRunway(rs.ref).length === 0 && e.crossingSafe(ARR_RWY, CROSSING_S) && !e.aircraft.some(o => o.id !== a.id && o.pendingCmds.some(c => c.kind === 'cross'));
          if (clear) this.once(`${cs}:cross`, lander ? `${cs} cross runway ${ARR_RWY} behind ${lander}` : `${cs} cross runway ${ARR_RWY}`);
          else this.once(`${cs}:standby:${req.id}`, `${cs} standby`);
        }
        if (a.holdShortRunway === DEP_RWY && a.onFrequency === 'tower' && req?.kind === 'ready' && !this.done(`${cs}:luaw`)) {
          const rs = e.runwayState(DEP_RWY)!;
          const free = !e.runwayOccupant(DEP_RWY, a.id) && rs.status === 'open' && !e.arrivalOnFinal(DEP_RWY, 6) && !e.aircraft.some(o => o.id !== a.id && o.pendingCmds.some(c => c.kind === 'lineup' || c.kind === 'takeoff'));
          if (free) this.once(`${cs}:luaw`, `${cs} line up and wait ${DEP_RWY}`);
          else this.once(`${cs}:standby:${req.id}`, `${cs} standby`);
        }
        return;
      }
      case 'lineup':
        if (a.speed < 0.5 && a.distAlong >= (a.path?.total ?? 0) - 1 && !this.done(`${cs}:cto`)) {
          const wake = e.wakeTimerRemainingS(DEP_RWY, a.wakeCategory);
          if (wake === 0 && !e.runwayOccupant(DEP_RWY, a.id) && e.runwayPhysicallyClear(DEP_RWY, a.id) && !e.arrivalOnFinal(DEP_RWY, 4)) this.once(`${cs}:cto`, `${cs} fly runway heading climb 6000 cleared for takeoff ${DEP_RWY}`);
        }
        return;
      case 'takeoff': return;
      case 'climb': case 'cruise': case 'descent': case 'departed': {
        // the last departure to get airborne is the engine-fire return: declared climbing through 1500 ft
        if (this.fireCs == null && DEPARTURES.every(d => !e.find(d.cs) || e.find(d.cs)!.delay.airborneAt != null)) {
          const last = DEPARTURES.map(d => e.find(d.cs)).filter((x): x is AircraftState => !!x).reduce((b, x) => (x.delay.airborneAt! > b.delay.airborneAt! ? x : b));
          this.fireCs = last.callsign;
        }
        if (cs === this.fireCs && !a.emergency && a.altitude >= 1500 && this.fireDeclaredAt == null) {
          this.fireDeclaredAt = e.time; e.declareEmergency(a, 'engine_fire');
          this.log.push(`${e.time.toFixed(0).padStart(5)} SIM> ${cs} engine fire declared at ${Math.round(a.altitude)} ft`);
          return;
        }
        if (a.onFrequency !== 'departure' || a.handedTo) return;
        if (this.request(a, 'with_you')) this.once(`${cs}:rc`, `${cs} radar contact climb FL80`);
        if (this.done(`${cs}:rc`) && this.since(`${cs}:rc`) >= 8) this.once(`${cs}:dct`, `${cs} direct CPT`);
        if (this.done(`${cs}:dct`) && (a.altitude >= 6500 || dist(a.pos, e.centerXY) > 20 * NM_TO_M)) this.once(`${cs}:ho`, `${cs} contact london control 133.175 good day`);
        return;
      }
      default: return;
    }
  }

  emergency(a: AircraftState) {
    const e = this.e, cs = a.callsign, em = a.emergency!;
    const k = (s: string) => `${cs}:em:${s}`;
    if (this.once(k('ack'), `${cs} roger mayday squawk 7700 say souls on board and fuel remaining`)) return;
    if (this.since(k('ack')) < 3) return;
    if (this.once(k('prio'), `${cs} priority runway ${DEP_RWY} number one runway sterile`)) return;
    if (this.since(k('prio')) < 3) return;
    if (this.once(k('arff'), `dispatch 3 fire to runway ${DEP_RWY}`)) return;
    if (this.since(k('arff')) < 3) return;
    const rs = e.runwayState(DEP_RWY)!;
    const rh = rs.headingTrue;
    const H = (d: number) => String(Math.round(((rh + d) % 360 + 360) % 360) || 360).padStart(3, '0');
    const f = this.frame(DEP_RWY, a);
    const airborne = a.phase === 'climb' || a.phase === 'cruise' || a.phase === 'descent' || a.phase === 'approach' || a.phase === 'landing' || a.phase === 'go_around';
    if (airborne && !a.ilsArmed) {
      // tight right-hand circuit at 2000 ft: a 180-degree right turn onto the downwind (2 NM north of the runway), base
      // at 7 NM, 25-degree intercept onto a 6.5 NM final (f.along < 0 = east of the 27R threshold on the approach side;
      // f.cross > 0 = north of the centreline)
      if (this.once(k('dw'), `${cs} turn right heading ${H(180)} maintain 2000`)) return;
      if (!this.done(k('base')) && f.along < -7 * NM_TO_M && Math.abs(angleDelta(a.heading, rh + 180)) < 10) { this.once(k('base'), `${cs} turn right heading ${H(270)}`); return; }
      if (this.done(k('base')) && !this.done(k('icpt')) && f.cross < 1.3 * NM_TO_M) { this.once(k('icpt'), `${cs} turn right heading ${H(335)} cleared ILS ${DEP_RWY}`); return; }
      return;
    }
    if (airborne && a.ilsCaptured && a.onFrequency !== 'tower' && a.handedTo == null) { this.once(k('twr'), `${cs} contact tower`); return; }
    if (airborne && a.onFrequency === 'tower' && !a.landingCleared && (a.phase === 'landing' || a.ilsCaptured) && !a.pendingCmds.some(c => c.kind === 'clearedLand')) {
      const d = e.distToThresholdNM(a, DEP_RWY) ?? 99;
      if (d <= 7) this.once(k('land'), `${cs} cleared to land ${DEP_RWY}`);
      return;
    }
    if (a.phase === 'rollout' && em.stoppedAt != null && e.time - em.stoppedAt >= 20) {
      if (this.once(k('cancel'), `${cs} roger mayday cancelled`)) return;
      if (this.since(k('cancel')) >= 10) {
        for (const id of [1, 2, 3]) if (this.once(k(`recall${id}`), `recall fire ${id}`)) return;
        if (this.since(k('recall3')) >= 5) this.once(k('reopen'), `reopen runway ${DEP_RWY} after inspection`);
      }
    }
  }

  arrival(a: AircraftState) {
    const e = this.e, cs = a.callsign;
    const k = (s: string) => `${cs}:${s}`;
    const rs = e.runwayState(ARR_RWY)!;
    const rh = rs.headingTrue;
    const H = (d: number) => String(Math.round(((rh + d) % 360 + 360) % 360) || 360).padStart(3, '0');
    switch (a.phase) {
      case 'approach': case 'cruise': case 'climb': case 'descent': {
        if (a.onFrequency === 'approach') {
          if (this.request(a, 'with_you') || e.time - a.spawnedAt >= 5) this.once(k('rc'), `${cs} radar contact descend 3000`);
          if (this.done(k('rc')) && this.since(k('rc')) >= 6) this.once(k('vec'), `${cs} turn right heading ${H(25)}`);
          if (this.done(k('vec')) && this.since(k('vec')) >= 10) this.once(k('ils'), `${cs} cleared ILS ${ARR_RWY}`);
          if (a.ilsCaptured && !this.done(k('spd'))) this.once(k('spd'), `${cs} reduce speed 180`);
        } else if (a.onFrequency === 'tower') this.towerArrival(a);
        return;
      }
      case 'landing': if (a.onFrequency === 'tower') this.towerArrival(a); return;
      case 'rollout': return;
      case 'taxi': case 'hold_short':
        if (this.request(a, 'taxi_in') && a.phase === 'taxi') this.once(k('taxiin'), `${cs} taxi to stand ${a.plan.gateRef}`);
        if (a.phase === 'hold_short' && a.holdShortRunway && this.request(a, 'cross') && !a.holdReleased && !e.runwayOccupied(a.holdShortRunway) && e.crossingSafe(a.holdShortRunway)) this.once(k('cross:' + a.holdShortRunway), `${cs} cross runway ${a.holdShortRunway}`);
        return;
      default: return;
    }
  }
  towerArrival(a: AircraftState) {
    const e = this.e, cs = a.callsign;
    const k = (s: string) => `${cs}:${s}`;
    if (this.request(a, 'with_you')) this.once(k('twr'), `${cs} roger`);
    if (a.landingCleared || !(a.phase === 'landing' || a.ilsCaptured) || a.pendingCmds.some(c => c.kind === 'clearedLand')) return;
    const d = e.distToThresholdNM(a, ARR_RWY) ?? 99;
    const occ = e.runwayOccupant(ARR_RWY, a.id);
    if (d <= 6.5 && !occ && e.runwayPhysicallyClear(ARR_RWY, a.id)) { this.memo.delete(k('land')); this.once(k('land'), `${cs} cleared to land ${ARR_RWY} exit at N10`); return; }
    if (d <= 4.3 && occ) this.once(k('cont'), `${cs} continue approach expect late landing clearance`);
  }

  systems() {
    const e = this.e;
    // Wind reversal once every arrival is on the ground and the fire ship is stopped: the model must suggest 09L/09R.
    const arrivalsDown = ARRIVALS.every(x => { const a = e.find(x.cs); return !a || a.delay.touchdownAt != null; });
    const fire = this.fireCs ? e.find(this.fireCs) : undefined;
    const fireDone = this.fireDeclaredAt != null && (!fire || (fire.emergency?.stoppedAt != null));
    if (this.windReversedAt == null && arrivalsDown && fireDone) {
      this.windReversedAt = e.time;
      e.setWind(100, 18);
      this.log.push(`${e.time.toFixed(0).padStart(5)} SIM> wind reversed 100/18`);
    }
    if (this.windReversedAt != null && e.suggestedRunways && !this.done('rwychange')) {
      this.once('rwychange', `close runway ${ARR_RWY} easterly`);
    }
    if (this.done('rwychange') && this.since('rwychange') >= 30 && !this.done('rwyreopen')) {
      const s = e.suggestedRunways;
      if (s) e.setActiveRunways(s.dep, s.arr);
      this.once('rwyreopen', `reopen runway ${ARR_RWY}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Session driver
// ──────────────────────────────────────────────────────────────────────────────
interface SessionResult {
  e: SimEngine; ctl: Controller; inv: Invariants; log: string[]; elapsedS: number;
  digest: string; stands: Record<string, string>;
}

function runSession(seed: number, maxMin = 36): SessionResult {
  const e = makeEngine('EGLL', { seed, ends: ['27R', '27L'], pilotDelay: null });
  e.settings.despawnParked = false;
  const log: string[] = [];
  const ctl = new Controller(e, log);
  const inv = newInvariants();
  const stands: Record<string, string> = {};
  for (const d of DEPARTURES) {
    const a = e.spawnDeparture({ callsign: d.cs, type: d.type, runway: DEP_RWY, stand: d.stand });
    if (!a) throw new Error(`spawn ${d.cs} at ${d.stand} failed`);
    stands[d.cs] = a.plan.gateRef!;
  }
  for (const ev of e.step(0)) { checkEvent(ev, inv); inv.events.push(ev); }
  const spawned = new Set<string>();
  const complete = () => {
    // departures gone (the fire ship is towed clear when the runway reopens), arrivals parked, ARFF recalled,
    // runway change applied after the wind reversal
    const deps = DEPARTURES.every(d => { const a = e.find(d.cs); return !a || a.phase === 'departed'; });
    const arrs = ARRIVALS.every(x => { const a = e.find(x.cs); return !!a && a.phase === 'arrived'; });
    return deps && arrs && ctl.fireDeclaredAt != null && ctl.done(`${ctl.fireCs}:em:recall3`) && ctl.done('rwyreopen') && ARRIVALS.every(x => spawned.has(x.cs));
  };
  const t0 = e.time;
  while (e.time - t0 < maxMin * 60) {
    for (const x of ARRIVALS) {
      if (!spawned.has(x.cs) && e.time - t0 >= x.at) {
        spawned.add(x.cs);
        const a = e.spawnAt({ callsign: x.cs, type: x.type, kind: 'arrival', phase: 'approach', posRel: { fromRunway: ARR_RWY, alongNM: -17, offsetNM: -3, altFt: 5000 }, heading: e.runwayState(ARR_RWY)!.headingTrue, speedKts: 220, onFrequency: 'approach', plan: { gateRef: x.stand } });
        stands[x.cs] = a.plan.gateRef!;
        log.push(`${e.time.toFixed(0).padStart(5)} SIM> spawn arrival ${x.cs} ${x.type} -> stand ${a.plan.gateRef}`);
      }
    }
    ctl.tick();
    const n0 = inv.events.length;
    advance(e, 1, inv);
    for (const ev of inv.events.slice(n0)) if (['go_around', 'diversion', 'emergency', 'runway_state', 'vehicle', 'ground_conflict', 'separation_loss', 'reached_hold', 'airborne', 'touchdown', 'arrived', 'departed', 'handoff', 'wake'].includes(ev.type) || (ev.type === 'startup' && /hot start/.test(ev.message))) log.push(`${ev.at.toFixed(0).padStart(5)} ${ev.type.padEnd(14)} ${ev.callsign}: ${ev.message}`);
    if (complete() && e.time - t0 > 60) break;
  }
  const elapsedS = e.time - t0;
  // cool-down: the recalled ARFF drive back to the station at their normal 15 kt (an empty field, so cheap to run)
  const t1 = e.time;
  while (e.time - t1 < 600 && !e.fleet.list().filter(v => v.type === 'arff').every(v => v.state === 'standby')) advance(e, 1, inv);
  const digest = inv.events.map(ev => `${ev.at.toFixed(3)}|${ev.type}|${ev.callsign}|${ev.message}`).join('\n')
    + '\n' + JSON.stringify({ stats: e.stats, aircraft: e.snapshotForTest(), vehicles: e.fleet.list().map(v => ({ id: v.id, state: v.state, x: v.pos.x, y: v.pos.y })), wx: e.wx(), runways: e.runwayStates().map(r => ({ n: r.name, s: r.status, d: r.activeDep, a: r.activeArr })) });
  return { e, ctl, inv, log, elapsedS, digest, stands };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────────────────────────────────
/** The session seed. A different seed changes the random pilot timings (request delays, hot starts, exits) but not the script. */
const SEED = Number(process.env.INTEG_SEED ?? 2);

test('integration: seeded EGLL session by typed commands — 6 departures (crossing 27L), 6 arrivals, engine fire + ARFF, wind reversal', (t) => {
  const s = runSession(SEED);
  const { e, ctl, inv } = s;
  t.diagnostic(`seed ${SEED}: ${(s.elapsedS / 60).toFixed(1)} sim-min, ${ctl.issued.length} commands, ${inv.events.length} events, score ${e.stats.points}, skill ${e.stats.skill.toFixed(2)}, fire ship ${ctl.fireCs}, ARFF ${e.stats.arffResponseS.map(x => x.toFixed(0)).join('/')} s`);
  const dump = () => `\n--- log (last 60) ---\n${s.log.slice(-60).join('\n')}\n--- ledger ---\n${e.stats.ledger.map(l => `${l.at.toFixed(0)} ${l.code} ${l.primary} ${l.detail}`).join('\n')}`;
  if (process.env.INTEG_DEBUG) console.log(s.log.join('\n'));

  // every command was parsed and accepted (no silent refusals from the controller's script)
  const bad = ctl.issued.filter(i => !i.result.ok);
  assert.deepEqual(bad.map(i => `${i.at.toFixed(0)} ${i.text} -> ${i.result.code}: ${i.result.reason}`), [], `refused commands${dump()}`);
  for (const i of ctl.issued) assert.ok(i.result.transmission.length > 0, `${i.text} transmitted`);

  // all 12 movements complete (6 take-offs, 6 arrivals parked) inside the session
  const FIRE_CS = ctl.fireCs!;
  assert.ok(FIRE_CS, 'a departure became the engine-fire return');
  assert.notEqual(FIRE_CS, HEAVY_CS, 'the HEAVY departed ahead of at least one MEDIUM');
  for (const d of DEPARTURES) {
    assert.ok(e.stats.ledger.some(l => l.code === 'MOVEMENT' && l.primary === d.cs && /takeoff/.test(l.detail)), `${d.cs} took off${dump()}`);
    const a = e.find(d.cs);
    if (d.cs !== FIRE_CS) assert.ok(!a || a.phase === 'departed', `${d.cs} handed off / left the TMA (phase ${a?.phase})`);
  }
  for (const x of ARRIVALS) {
    const a = e.find(x.cs)!;
    assert.ok(a, `${x.cs} still exists`);
    assert.equal(a.phase, 'arrived', `${x.cs} parked${dump()}`);
    assert.equal(a.plan.gateRef, x.stand, `${x.cs} parked on its reserved stand`);
    assert.ok(e.gateStates().find(g => g.ref === x.stand)!.occupiedBy === a.id, `${x.cs} occupies ${x.stand}`);
    assert.ok(e.stats.ledger.some(l => l.code === 'LANDED' && l.primary === x.cs), `${x.cs} LANDED scored`);
    assert.ok(e.stats.ledger.some(l => l.code === 'ESTABLISHED' && l.primary === x.cs), `${x.cs} established on the ILS`);
    assert.ok(inv.events.some(ev => ev.type === 'runway_vacated' && ev.callsign === x.cs), `${x.cs} vacated`);
    assert.ok(a.delay.touchdownAt != null && a.delay.vacatedAt != null && a.delay.vacatedAt - a.delay.touchdownAt <= 90, `${x.cs} runway occupancy ${(a.delay.vacatedAt ?? 0) - (a.delay.touchdownAt ?? 0)} s`);
    assert.equal(a.goAroundCount, 0, `${x.cs} no go-around`);
  }
  // 12 scheduled movements; the emergency return stops on the runway and is towed, so it is not a counted (vacated) landing
  assert.equal(e.stats.movements, 12, `movements ${e.stats.movements}`);
  assert.ok(s.elapsedS <= 35 * 60, `session finished in ${(s.elapsedS / 60).toFixed(1)} min`);

  // the named-taxiway crossing: every T4 departure held short of 27L at a hold node and was cleared across; nobody else crossed
  for (const d of DEPARTURES) {
    if (d.crossing) {
      assert.ok(ctl.done(`${d.cs}:cross`), `${d.cs} was cleared across ${ARR_RWY}`);
      assert.ok(inv.events.some(ev => ev.type === 'reached_hold' && ev.callsign === d.cs && ev.message.includes(ARR_RWY)), `${d.cs} reached the ${ARR_RWY} hold`);
      assert.ok(inv.events.some(ev => ev.type === 'runway_vacated' && ev.callsign === d.cs), `${d.cs} vacated ${ARR_RWY} after crossing`);
    } else {
      assert.ok(!ctl.done(`${d.cs}:cross`) && !inv.events.some(ev => ev.type === 'reached_hold' && ev.callsign === d.cs && ev.message.includes(ARR_RWY)), `${d.cs} (Terminal 1) never crossed ${ARR_RWY}`);
    }
    assert.ok(e.stats.ledger.some(l => l.code === 'HOLD_POINT' && l.primary === d.cs && l.runway === DEP_RWY), `${d.cs} reached the ${DEP_RWY} holding point`);
  }

  // clean session: no diversions, incursions, separation / wake losses, collisions, unhandled go-arounds
  const negatives = e.stats.ledger.filter(l => ['DIVERSION', 'DIVERSION_UNHANDLED', 'RWY_INCURSION', 'SEPARATION_LOSS', 'WAKE_FINAL', 'WAKE_DEP', 'COLLISION_AIR', 'COLLISION_GND', 'GA_UNHANDLED', 'LUAW_UNSAFE', 'STERILE_RUNWAY_VIOLATION', 'FUEL_EXHAUSTION', 'READBACK_ERROR_MISSED', 'CLOSED_RUNWAY_CLEARANCE', 'EMERGENCY_CHECKLIST_MISS'].includes(l.code));
  assert.deepEqual(negatives.map(l => `${l.at.toFixed(0)} ${l.code} ${l.primary} ${l.detail}`), [], `no safety incidents${dump()}`);
  assert.equal(e.stats.diversions, 0);
  assert.equal(inv.events.filter(ev => ev.type === 'diversion').length, 0);
  assert.equal(inv.events.filter(ev => ev.type === 'separation_loss' || ev.type === 'ground_conflict').length, 0, `no conflicts${dump()}`);
  assert.ok(e.stats.points > 0, `score ${e.stats.points}${dump()}`);
  assert.ok(e.stats.skill > 0);

  // wake timers respected: every take-off clearance waited for the departure wake matrix (HEAVY UAE5 ahead of MEDIUM AFR1170)
  const rot = new Map<string, { at: number; cat: AircraftState['wakeCategory'] }>();
  for (const ev of inv.events) if (ev.type === 'wake' && ev.data?.type === 'wake') rot.set(ev.data.leader, { at: ev.at, cat: (ev.message.match(/\((\w+)\)/)?.[1] ?? 'MEDIUM') as AircraftState['wakeCategory'] });
  const takeoffs = inv.events.filter(ev => ev.type === 'transmission' && ev.data?.type === 'transmission' && ev.data.ast.kind === 'takeoff').map(ev => ({ cs: ev.callsign, at: ev.at }));
  assert.ok(takeoffs.length >= 6, 'six takeoff clearances transmitted');
  const heavyRot = rot.get(HEAVY_CS);
  assert.ok(heavyRot && heavyRot.cat === 'HEAVY', 'wake timer event for the HEAVY departure');
  const follower = takeoffs.find(t => t.at > heavyRot!.at)!;
  assert.ok(follower, 'a departure was cleared after the heavy');
  assert.ok(follower.at - heavyRot!.at >= WAKE_DEPARTURE_S.HEAVY.MEDIUM, `${follower.cs} cleared ${(follower.at - heavyRot!.at).toFixed(0)} s after the heavy rotated (>= ${WAKE_DEPARTURE_S.HEAVY.MEDIUM})`);
  for (const t of takeoffs) for (const [leader, r] of rot) if (r.at < t.at && leader !== t.cs) {
    const fol = e.find(t.cs)?.wakeCategory ?? 'MEDIUM';
    assert.ok(t.at - r.at >= WAKE_DEPARTURE_S[r.cat][fol], `${t.cs} cleared ${(t.at - r.at).toFixed(0)} s after ${leader} (${r.cat} -> ${fol} needs ${WAKE_DEPARTURE_S[r.cat][fol]} s)`);
  }

  // engine fire: MAYDAY handled end-to-end, ARFF reached the runway within the ICAO limit and returned to station
  const fire = e.find(FIRE_CS);
  const emEvents = inv.events.filter(ev => ev.type === 'emergency' && ev.callsign === FIRE_CS);
  assert.ok(emEvents.some(ev => /MAYDAY/.test(ev.message)), 'MAYDAY pilot line');
  assert.ok(emEvents.some(ev => ev.data?.type === 'emergency' && ev.data.change === 'landed'), 'emergency landed event');
  assert.ok(emEvents.some(ev => ev.data?.type === 'emergency' && ev.data.change === 'stopped'), 'emergency stopped event');
  assert.ok(emEvents.some(ev => ev.data?.type === 'emergency' && ev.data.change === 'resolved'), 'emergency resolved (MAYDAY cancelled)');
  assert.ok(!fire, 'fire ship towed clear when the runway reopened after inspection');
  // EGLL is modelled with the single Fire HQ station between the runways: the 27R touchdown zone is ~2.5 km away, so the
  // response lands just outside the 180 s ICAO figure (ARFF_ON_TIME is scored at KSFO in tests/engine/emergency.test.ts).
  assert.ok(e.stats.arffResponseS.length === 1 && e.stats.arffResponseS[0] <= 240, `ARFF response ${e.stats.arffResponseS} s`);
  const fireTd = inv.events.find(ev => ev.type === 'touchdown' && ev.callsign === FIRE_CS);
  const arffOn = inv.events.filter(ev => ev.type === 'vehicle' && /on scene RWY 27R/.test(ev.message));
  assert.ok(fireTd && arffOn.length === 3 && arffOn.every(ev => ev.at < fireTd.at), 'all three ARFF in position before the emergency touched down');
  assert.ok(e.stats.ledger.some(l => l.code === 'EMERGENCY_DONE' || l.code === 'INSPECTION_CLEAN'), 'emergency scored');
  const vehEvents = inv.events.filter(ev => ev.type === 'vehicle');
  for (const id of ['FIRE1', 'FIRE2', 'FIRE3']) {
    assert.ok(vehEvents.some(ev => ev.callsign === id && /on scene RWY 27R/.test(ev.message)), `${id} on scene at runway 27R`);
    assert.ok(vehEvents.some(ev => ev.callsign === id && /at station/.test(ev.message)), `${id} returned to station`);
    const v = e.fleet.byId(id)!;
    assert.equal(v.state, 'standby', `${id} back on standby`);
  }
  const rwyStates = inv.events.filter(ev => ev.type === 'runway_state' && ev.data?.type === 'runway_state');
  assert.ok(rwyStates.some(ev => ev.data?.type === 'runway_state' && ev.data.runway === DEP_RWY && ev.data.status === 'sterile'), '27R sterile for the emergency');
  assert.ok(rwyStates.some(ev => ev.data?.type === 'runway_state' && ev.data.runway === DEP_RWY && ev.data.status === 'closed'), '27R closed after the stop');
  assert.equal(e.runwayState(DEP_RWY)!.status, 'open', '27R reopened after inspection');
  assert.equal(e.runwayState(DEP_RWY)!.occupiedBy.length, 0);
  assert.equal(e.stats.emergenciesDeclared, 1);
  assert.equal(e.stats.emergenciesResolved, 1);

  // wind reversal -> ATIS + suggestion 09L/09R -> runway status command through the parser -> runway change applied
  assert.ok(ctl.windReversedAt != null, 'wind reversed');
  const atisAfter = inv.events.filter(ev => ev.type === 'atis' && ev.at >= ctl.windReversedAt!);
  assert.ok(atisAfter.some(ev => /09[LR]/.test(ev.message) && /recommended/.test(ev.message)), `runway suggestion broadcast: ${atisAfter.map(ev => ev.message).join(' | ')}`);
  assert.ok(ctl.done('rwychange') && ctl.done('rwyreopen'), 'runway status commands issued');
  assert.ok(rwyStates.some(ev => ev.at >= ctl.windReversedAt! && ev.data?.type === 'runway_state' && ev.data.runway === ARR_RWY && ev.data.status === 'closed' && /easterly/.test(ev.message)), 'runway 27L closed by the typed command');
  assert.ok(e.activeEnds('arr').some(r => r.name.startsWith('09')) && e.activeEnds('dep').some(r => r.name.startsWith('09')), `09s active after the change: dep ${e.activeEnds('dep').map(r => r.name)} arr ${e.activeEnds('arr').map(r => r.name)}`);
  assert.equal(e.suggestedRunways, null, 'no pending suggestion once applied');
  assert.equal(e.runwayState(ARR_RWY)!.status, 'open');

  // invariants: no teleports, NaN, stuck aircraft, malformed events
  assert.deepEqual(inv.teleports.slice(0, 5), [], `teleports (${inv.teleports.length})`);
  assert.deepEqual(inv.nans.slice(0, 5), [], 'NaN');
  assert.deepEqual(inv.stuck, [], `stuck aircraft${dump()}`);
  assert.deepEqual(inv.badEvents.slice(0, 5), [], `malformed events (${inv.badEvents.length})`);
  assert.ok(inv.events.length > 300, `${inv.events.length} events`);
  // transmissions/readbacks: every accepted aircraft command produced a readback event
  const rb = inv.events.filter(ev => ev.type === 'readback');
  assert.ok(rb.length >= ctl.issued.filter(i => i.result.ok && i.result.readback).length * 0.9, `${rb.length} readbacks for ${ctl.issued.length} commands`);
});

test('integration: the scripted session is deterministic across two runs with the same seed', () => {
  const a = runSession(SEED, 10);
  const b = runSession(SEED, 10);
  assert.equal(a.elapsedS, b.elapsedS);
  assert.equal(a.inv.events.length, b.inv.events.length);
  if (a.digest !== b.digest) {
    const la = a.digest.split('\n'), lb = b.digest.split('\n');
    const i = la.findIndex((l, idx) => l !== lb[idx]);
    assert.fail(`digest differs at line ${i}:\n  A: ${la[i]}\n  B: ${lb[i]}`);
  }
  assert.deepEqual(a.ctl.issued.map(i => `${i.at.toFixed(2)} ${i.text} ${i.result.code}`), b.ctl.issued.map(i => `${i.at.toFixed(2)} ${i.text} ${i.result.code}`));
  const c = runSession(SEED + 1, 3);
  assert.notEqual(c.digest, a.digest.slice(0, c.digest.length), 'a different seed differs');
});

test('integration soak: 45 sim-minutes of the engine\'s own auto traffic at high density — no exceptions, bounded count, nobody stuck', (t) => {
  const e = makeEngine('EGLL', { seed: 11, ends: ['27R', '27L'], pilotDelay: null, emergencies: 'normal' });
  e.settings.autoTower = true;
  e.settings.autoGround = true;
  const inv = newInvariants();
  const CAP = 22;
  let nextSpawn = 0, spawns = 0, toggle = 0;
  const t0 = e.time;
  const counts: number[] = [];
  while (e.time - t0 < 45 * 60) {
    if (e.time >= nextSpawn && e.aircraft.length < CAP) {
      // alternate departures / arrivals the way the store's autospawn does (deterministic here)
      const a = (toggle++ % 3 === 2) ? e.spawnArrival() : e.spawnDeparture();
      if (a) spawns++;
      nextSpawn = e.time + 40;
    }
    // keep departures flowing without a controller: the AI tower clears takeoffs/crossings/landings; the sim cannot
    // push back or taxi by itself, so drive those two clearances from the pilot requests (as the AI ground would)
    for (const a of e.aircraft) {
      const req = a.requests.find(r => r.answeredAt == null);
      if (!req) continue;
      if (req.kind === 'pushback' && a.phase === 'parked') executeText(e, `${a.callsign} pushback approved start up approved`);
      else if (req.kind === 'startup' && a.phase === 'parked') executeText(e, `${a.callsign} start up approved`);
      else if (req.kind === 'taxi' && a.phase === 'startup' && a.plan.runway) executeText(e, `${a.callsign} taxi to holding point runway ${a.plan.runway}`);
      else if (req.kind === 'ready' && a.phase === 'hold_short' && a.onFrequency === 'ground') executeText(e, `${a.callsign} contact tower`);
      else if (req.kind === 'with_you' && a.plan.kind === 'departure' && a.onFrequency === 'departure') executeText(e, `${a.callsign} radar contact climb FL80`);
      else if (req.kind === 'higher') executeText(e, `${a.callsign} climb FL90`);
      else if (req.kind === 'with_you' && a.plan.kind === 'arrival' && a.onFrequency === 'approach') executeText(e, `${a.callsign} radar contact descend 4000`);
      else if (req.kind === 'lower') executeText(e, `${a.callsign} descend 4000`);
      else if (req.kind === 'direct' && typeof req.param === 'string') executeText(e, `${a.callsign} direct ${req.param}`);
      else if (req.kind === 'taxi_in' && a.phase === 'taxi' && a.plan.gateRef) executeText(e, `${a.callsign} taxi to stand ${a.plan.gateRef}`);
      else if (req.kind === 'going_around') executeText(e, `${a.callsign} roger`);
    }
    // arrivals: vector onto the 27L ILS from wherever they are, hand off departures leaving the TMA
    for (const a of e.aircraft) {
      if (a.plan.kind === 'arrival' && !a.ilsArmed && a.onFrequency === 'approach' && a.altitude <= 4100 && a.phase === 'approach') executeText(e, `${a.callsign} cleared ILS 27L`);
      if (a.plan.kind === 'departure' && a.onFrequency === 'departure' && a.handedTo == null && (a.altitude >= 7500 || dist(a.pos, e.centerXY) > 22 * NM_TO_M)) executeText(e, `${a.callsign} contact london control`);
    }
    advance(e, 1, inv);
    if (Math.round(e.time) % 60 === 0) counts.push(e.aircraft.length);
  }
  t.diagnostic(`soak: ${spawns} spawns, max ${inv.maxAircraft} aircraft, ${e.stats.movements} movements, ${e.stats.diversions} diversions, ${e.stats.emergenciesDeclared} emergencies, incidents ${JSON.stringify(e.stats.incidents)}`);
  assert.ok(spawns >= 40, `${spawns} spawns`);
  assert.ok(inv.maxAircraft <= CAP + 2, `bounded aircraft count (max ${inv.maxAircraft})`);
  assert.ok(counts.some(c => c >= 12), `high density reached (${Math.max(...counts)} aircraft)`);
  assert.deepEqual(inv.nans.slice(0, 5), [], 'NaN');
  assert.deepEqual(inv.teleports.slice(0, 5), [], `teleports (${inv.teleports.length})`);
  assert.deepEqual(inv.badEvents.slice(0, 5), [], `malformed events (${inv.badEvents.length})`);
  assert.deepEqual(inv.stuck, [], 'stuck aircraft');
  assert.ok(e.stats.movements >= 10, `${e.stats.movements} movements`);
  assert.ok(e.aircraft.every(a => Number.isFinite(a.altitude)));
  const vehicles: Vehicle[] = e.fleet.list();
  assert.ok(vehicles.every(v => finite(v.pos.x, v.pos.y)), 'vehicle positions finite');
});

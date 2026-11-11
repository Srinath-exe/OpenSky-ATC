// The pilot's eyes and ears (docs/spec/13-PILOT-BRAIN.md §4.3): what a crew notices without being told.
//
//  - Looking ahead. A pilot projects the next minute: will the runway be clear when we get there? Is that traffic going
//    to pass close? When the answer is no, the pilot speaks before it becomes a go-around or a loss of separation.
//  - The party line. Everybody on a frequency hears everybody else's clearances. A crew cleared to land on a runway
//    where they just heard another aircraft cleared to line up says so; a crew following a go-around for wind asks for
//    a wind check.
//
// Everything here is deterministic and read from the simulator's state (the ledger for what was said, the runway
// occupants and positions for what can be seen). It never changes the state: it only asks (through the same
// question-and-confirm flow as the ledger) or raises a pilot call the controller can answer.
import type { SimEngine } from './engine';
import type { AircraftState, PilotRequest, RunwayState } from './types';
import type { SingleAircraftCommand } from './commandAst';
import { isAirborne } from './aircraft';
import { ALERT_CONST, cpa, verticalSpeedFpm } from './alerts';
import { ledgerOf, type LedgerEntry, type PilotQuery } from './ledger';
import { alongTrack, angleDelta, headingTo, NM_TO_M } from './projection';

export const MIND_CONST = {
  /** A crew on final watches the runway from here (NM to the threshold). */
  landLookNM: 3.5,
  /** Inside this the engine's own go-around rules take over. */
  landLookMinNM: 1.1,
  /** The runway must be predicted clear this long before we cross the threshold (s). */
  marginS: 10,
  /** A line-up or a crossing in front of an arrival this close is questioned (NM); same figure the engine scores. */
  finalNM: 2,
  /** Converging traffic: predicted to pass closer than this (NM and ft) within lookS, and not there yet. */
  cpaNM: 1.5, cpaFt: 600, lookS: 75, minS: 8,
  /** What a crew can see on its traffic display: this close and within this much height now. */
  seeNM: 6, seeFt: 2000,
  /** The same concern is not repeated within this (s). */
  repeatS: 180,
  /** A pilot's own call stays open this long without an answer (s). */
  openS: 50,
  /** A follower this close behind a weather go-around asks for the wind (NM to the threshold). */
  followNM: 8,
} as const;

interface Threat { callsign: string; state: string; heard: LedgerEntry | null }
type Q = Omit<PilotQuery, 'at' | 'ast'>;

const clearedWords = (e: LedgerEntry) => e.kind === 'lineup' ? 'cleared to line up' : e.kind === 'takeoff' ? 'cleared for takeoff' : e.kind === 'cross' ? 'cleared to cross' : 'cleared to land';

export class PilotMind {
  private said = new Map<string, number>();
  private joined = new Map<number, { freq: string; since: number }>();
  private gaCount = new Map<number, number>();
  private mine = new Set<number>();
  /** What the pilots noticed, for tests and the self-play scoreboard. */
  readonly stats = { runwayCalls: 0, trafficCalls: 0, windChecks: 0, questions: 0 };
  enabled = true;

  private once(key: string, time: number, repeatS: number = MIND_CONST.repeatS): boolean {
    const t = this.said.get(key);
    if (t != null && time - t < repeatS) return false;
    this.said.set(key, time);
    return true;
  }

  /** Since when this aircraft has been listening on its frequency. */
  private since(a: AircraftState): number {
    const j = this.joined.get(a.id);
    return j && j.freq === a.onFrequency ? j.since : a.spawnedAt ?? 0;
  }

  /** The runway clearance `other` holds that `a` heard on the frequency, if any. */
  private heard(e: SimEngine, a: AircraftState, other: AircraftState, rs: RunwayState): LedgerEntry | null {
    if (other.onFrequency !== a.onFrequency) return null;
    const since = this.since(a);
    const list = ledgerOf(e).active(other.callsign);
    for (let i = list.length - 1; i >= 0; i--) {
      const en = list[i]; const p = en.ast;
      if (en.at < since) continue;
      if ((p.kind === 'lineup' || p.kind === 'takeoff' || p.kind === 'cross' || p.kind === 'clearedLand') && e.runwayState(p.runway)?.ref === rs.ref) return en;
    }
    return null;
  }

  /** Will something still be on the runway when an aircraft `etaS` away reaches the threshold? */
  runwayThreat(e: SimEngine, a: AircraftState, rs: RunwayState, etaS: number): Threat | null {
    for (const o of rs.occupiedBy) {
      if (o.id === a.id) continue;
      const ac = typeof o.id === 'number' ? e.aircraft.find((x) => x.id === o.id) ?? null : null;
      let clearIn: number; let state: string;
      switch (o.kind) {
        case 'landing': continue;                      // the one ahead on final: the spacing is the controller's plan
        case 'takeoff': clearIn = ac && ac.speed > 80 ? 15 : 40; state = 'departing'; break;
        case 'lineup': clearIn = rs.takeoffClearance === o.callsign ? 55 : Infinity; state = 'lined up'; break;
        case 'rollout': clearIn = Math.max(15, 50 - (e.time - o.since)); state = 'still on the runway'; break;
        case 'crossing': clearIn = 25; state = 'crossing'; break;
        case 'vehicle': clearIn = Infinity; state = 'on the runway'; break;
        default: clearIn = Infinity; state = 'on the runway';
      }
      if (etaS < clearIn + MIND_CONST.marginS) return { callsign: o.callsign, state: o.kind === 'vehicle' ? 'vehicle on the runway' : `traffic ${state}`, heard: ac ? this.heard(e, a, ac, rs) : null };
    }
    let v: { callsign: string } | null = null;
    try { v = e.fleet.onRunway(rs.ref)[0] ?? null; } catch { v = null; }
    return v ? { callsign: v.callsign, state: 'vehicle on the runway', heard: null } : null;
  }

  private etaS(e: SimEngine, a: AircraftState, runway: string): { nm: number; s: number } | null {
    const nm = e.distToThresholdNM(a, runway);
    if (nm == null) return null;
    return { nm, s: (nm / Math.max(60, a.speed)) * 3600 };
  }

  private threatWords(e: SimEngine, t: Threat): string {
    return t.heard ? `we heard ${e.telephony(t.callsign)} ${clearedWords(t.heard)}` : t.state;
  }

  /**
   * An instruction is about to be accepted: does what the pilot sees or heard make it look wrong? Returns the question
   * (asked through the ledger's confirm flow: the same instruction again, or "roger", confirms it).
   */
  check(e: SimEngine, a: AircraftState, part: SingleAircraftCommand): Q | null {
    if (!this.enabled) return null;
    let q: Q | null = null;
    if (part.kind === 'clearedLand' && isAirborne(a)) {
      const rs = e.runwayState(part.runway); const eta = rs && this.etaS(e, a, rs.name);
      if (rs && eta && eta.nm <= MIND_CONST.landLookNM) {
        const t = this.runwayThreat(e, a, rs, eta.s);
        if (t) {
          this.said.set(`land:${a.id}:${t.callsign}`, e.time);
          q = { earlier: t.heard, rule: 'runway_traffic', question: `${this.threatWords(e, t)}, confirm cleared to land runway ${rs.name}` };
        }
      }
    } else if ((part.kind === 'lineup' || part.kind === 'cross') && !part.behind && a.phase === 'hold_short') {
      const rs = e.runwayState(part.runway);
      if (rs) {
        const arr = e.arrivalOnFinal(rs.name, MIND_CONST.finalNM);
        const verb = part.kind === 'lineup' ? 'line up' : 'cross';
        if (arr) {
          const h = this.heard(e, a, arr.a, rs);
          const nm = Math.max(1, Math.round(arr.nm));
          q = { earlier: h, rule: 'traffic_on_final', question: `${h && h.kind === 'clearedLand' ? `${e.telephony(arr.callsign)} is cleared to land, ${nm} mile final` : `traffic on ${nm} mile final`}, confirm ${verb} runway ${rs.name}` };
        } else if (part.kind === 'cross') {
          const dep = e.aircraft.find((x) => x.id !== a.id && !isAirborne(x) && (x.phase === 'takeoff' || (x.phase === 'lineup' && rs.takeoffClearance === x.callsign)) && !!x.plan.runway && e.runwayState(x.plan.runway)?.ref === rs.ref);
          if (dep && alongTrack(a.pos, dep.pos, dep.heading) > -50) {
            const h = this.heard(e, a, dep, rs);
            q = { earlier: h, rule: 'departure_rolling', question: `${h ? `${e.telephony(dep.callsign)} is cleared for takeoff` : 'traffic departing'}, confirm cross runway ${rs.name}` };
          }
        }
      }
    }
    else if (part.kind === 'altitude' && isAirborne(a) && !(a.phase === 'landing' || a.ilsCaptured || a.gsCaptured || a.navMode === 'visual') && !a.emergency) {
      // the floor the engine's own low-altitude warning uses: a descent below it away from the airfield is questioned
      const dNM = Math.hypot(a.pos.x - e.centerXY.x, a.pos.y - e.centerXY.y) / NM_TO_M;
      const floor = ALERT_CONST.msawDefaultFloorFt;
      if (dNM > ALERT_CONST.msawNearNM && part.ft < floor && part.ft < a.altitude) q = { earlier: null, rule: 'below_safe_level', question: `${Math.round(dNM)} miles out, minimum safe altitude ${floor}, confirm ${Math.round(part.ft)} feet` };
    } else if (part.kind === 'contact' && part.position === 'ground' && isAirborne(a)) {
      q = { earlier: null, rule: 'wrong_frequency', question: `we're airborne, confirm contact ${e.unitName('ground')}` };
    }
    if (q) this.stats.questions++;
    return q;
  }

  /** Any instruction to an aircraft answers the call its pilot made. */
  answer(e: SimEngine, a: AircraftState): void {
    const req = a.requests[0];
    if (!req || req.answeredAt != null || !this.mine.has(req.id)) return;
    req.answeredAt = e.time; req.answeredBy = 'player';
    this.mine.delete(req.id);
    e.emit('request', a, `${a.callsign} request ${req.kind} answered`, { type: 'request', request: req, change: 'answered' });
    a.requests = [];
  }

  private call(e: SimEngine, a: AircraftState, kind: PilotRequest['kind'], param: string | number | null, text: string): boolean {
    const open = a.requests[0];
    if (open && open.answeredAt == null && !(kind === 'confirm_cleared')) return false;   // one call at a time; the runway comes first
    if (e.time < a.standbyUntil) return false;
    const req = e.raiseRequest(a, kind, param, text);
    if (!req || req.text !== text) return false;
    req.expiresAt = e.time + MIND_CONST.openS;
    this.mine.add(req.id);
    return true;
  }

  /** Once per simulated second. */
  tick(e: SimEngine): void {
    if (!this.enabled) return;
    const now = e.time;
    for (const a of e.aircraft) {
      const j = this.joined.get(a.id);
      if (!j || j.freq !== a.onFrequency) this.joined.set(a.id, { freq: a.onFrequency, since: j ? now : a.spawnedAt ?? now });
    }
    this.lookAtRunway(e);
    this.listen(e);
    if (Math.round(now) % 2 === 0) this.lookForTraffic(e);
    if (this.said.size > 4000) for (const [k, t] of this.said) if (now - t > 600) this.said.delete(k);
  }

  /** Cleared to land, and the runway will not be clear when we get there: ask before it becomes a go-around. */
  private lookAtRunway(e: SimEngine): void {
    for (const a of e.aircraft) {
      if (!a.landingCleared || !isAirborne(a) || a.phase === 'go_around') continue;
      const rw = a.plan.runway ?? a.assignedRunway; if (!rw) continue;
      const rs = e.runwayState(rw); const eta = rs && this.etaS(e, a, rs.name);
      if (!rs || !eta || eta.nm > MIND_CONST.landLookNM || eta.nm < MIND_CONST.landLookMinNM) continue;
      const t = this.runwayThreat(e, a, rs, eta.s);
      if (!t || !this.once(`land:${a.id}:${t.callsign}`, now(e))) continue;
      const text = `${e.unitName(a.onFrequency)}, ${e.telephony(a.callsign)}, ${Math.max(1, Math.round(eta.nm))} mile final, ${this.threatWords(e, t)}, confirm cleared to land?`;
      if (this.call(e, a, 'confirm_cleared', Math.round(eta.nm), text)) this.stats.runwayCalls++;
    }
  }

  /** The party line: a go-around for wind ahead of us on the same approach. */
  private listen(e: SimEngine): void {
    for (const a of e.aircraft) {
      const before = this.gaCount.get(a.id) ?? 0;
      if (a.goAroundCount === before) continue;
      this.gaCount.set(a.id, a.goAroundCount);
      if (a.goAroundCount < before) continue;
      const req = a.requests[0];
      const reason = req && req.kind === 'going_around' && typeof req.param === 'string' ? req.param : '';
      if (!/wind|gust|shear/i.test(reason)) continue;
      const rw = a.plan.runway ?? a.assignedRunway; const rs = rw ? e.runwayState(rw) : undefined; if (!rs) continue;
      let next: { b: AircraftState; nm: number } | null = null;
      for (const b of e.aircraft) {
        if (b.id === a.id || !isAirborne(b) || b.phase === 'go_around' || b.onFrequency !== a.onFrequency) continue;
        const brw = b.plan.runway ?? b.assignedRunway; if (!brw || e.runwayState(brw)?.ref !== rs.ref) continue;
        if (!(b.ilsCaptured || b.phase === 'landing' || b.navMode === 'visual')) continue;
        const nm = e.distToThresholdNM(b, brw); if (nm == null || nm > MIND_CONST.followNM) continue;
        if (!next || nm < next.nm) next = { b, nm };
      }
      if (!next || !this.once(`wind:${next.b.id}`, e.time)) continue;
      const b = next.b;
      if (this.call(e, b, 'wind_check', null, `${e.unitName(b.onFrequency)}, ${e.telephony(b.callsign)}, copied the go-around ahead, request wind check.`)) this.stats.windChecks++;
    }
  }

  /** Two aircraft predicted to pass close: the one that has the other in front reports it. */
  private lookForTraffic(e: SimEngine): void {
    const air = e.aircraft.filter((a) => isAirborne(a) && a.altitude > 1500 && a.phase !== 'landing' && a.phase !== 'takeoff' && a.emergency?.type !== 'radio_failure');
    for (let i = 0; i < air.length; i++) for (let k = i + 1; k < air.length; k++) {
      const a = air[i], b = air[k];
      if (a.ilsCaptured && b.ilsCaptured) continue;     // both established: parallel or in-trail approaches
      if (Math.abs(a.altitude - b.altitude) > 4000) continue;
      const va = { pos: a.pos, heading: a.heading, speedKt: a.speed, altFt: a.altitude, vsFpm: verticalSpeedFpm(a) };
      const vb = { pos: b.pos, heading: b.heading, speedKt: b.speed, altFt: b.altitude, vsFpm: verticalSpeedFpm(b) };
      const c = cpa(va, vb, MIND_CONST.lookS);
      if (c.nowNM > MIND_CONST.seeNM || Math.abs(a.altitude - b.altitude) > MIND_CONST.seeFt) continue;
      // each aircraft levels at its cleared altitude: do not extrapolate a climb or descent through it
      const at = (x: AircraftState, vs: number) => { const p = x.altitude + vs * c.tS / 60; return vs > 0 ? Math.min(p, Math.max(x.targetAltitude, x.altitude)) : vs < 0 ? Math.max(p, Math.min(x.targetAltitude, x.altitude)) : p; };
      const vert = Math.abs(at(a, va.vsFpm) - at(b, vb.vsFpm));
      if (!(c.distNM < MIND_CONST.cpaNM && vert < MIND_CONST.cpaFt && c.tS >= MIND_CONST.minS && c.nowNM > c.distNM + 0.5)) continue;
      const relA = Math.abs(angleDelta(a.heading, headingTo(a.pos, b.pos))), relB = Math.abs(angleDelta(b.heading, headingTo(b.pos, a.pos)));
      const [me, other] = relA <= relB ? [a, b] : [b, a];
      if (!this.once(`cv:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`, e.time)) continue;
      const rel = angleDelta(me.heading, headingTo(me.pos, other.pos));
      const clock = ((Math.round(rel / 30) % 12) + 12) % 12 || 12;
      const dz = other.altitude - me.altitude;
      const level = Math.abs(dz) < 300 ? 'same level' : `${Math.round(Math.abs(dz) / 100) * 100} feet ${dz > 0 ? 'above' : 'below'}`;
      const text = `${e.unitName(me.onFrequency)}, ${e.telephony(me.callsign)}, traffic ${clock} o'clock, ${Math.max(1, Math.round(c.nowNM))} miles, ${level}, converging.`;
      if (this.call(e, me, 'concern', other.callsign, text)) this.stats.trafficCalls++;
    }
  }
}

const now = (e: SimEngine) => e.time;

// one mind per engine, without touching the engine class
const MINDS = new WeakMap<object, PilotMind>();
export function mindOf(engine: object): PilotMind {
  let m = MINDS.get(engine);
  if (!m) { m = new PilotMind(); MINDS.set(engine, m); }
  return m;
}

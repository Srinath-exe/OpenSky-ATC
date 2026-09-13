// ============================================================
//  Alerts (W1-SYSTEMS implements; W1-ENGINE calls)
//
//  STCA (CPA prediction <= 60 s / actual loss), MSAW, runway incursion
//  (aircraft + vehicles), wake infringement on final, ground conflict / deadlock,
//  emergency mirror, delay / holding-fuel, unanswered pilot requests, plus the
//  informational kinds raised by the engine through raise() (UX 04 §5.1
//  catalogue). Alerts are objects with ack/resolve state kept for the session;
//  the same (kind, subjects) never spawns duplicate alerts (the existing one
//  updates its geometry). Auto-resolution has a short hysteresis so a pair
//  hovering around the minima does not flap.
//
//  Kind mapping for conditions without their own AlertKind (types.ts is a
//  W0 contract): "no landing clearance" and "request timeout" use `request`,
//  "stopped on runway" uses `runway_status`, "holding > 20 min" uses `delay`;
//  severities are set explicitly per condition (ALERT_SEVERITY is the default
//  for raise()).
// ============================================================
import type { XY } from './projection';
import { KTS_TO_MPS, NM_TO_M } from './projection';
import { isAirbornePhase } from './stage';
import type { AircraftState, Alert, AlertKind, AlertSeverity, RunwayState, SimEvent, Vehicle } from './types';
import { WAKE_FINAL_NM } from './types';

// ──────────────────────────────────────────────────────────────────────────────
//  Constants (03 §3.10, §3.11, §8; UX §5.1)
// ──────────────────────────────────────────────────────────────────────────────
export const ALERT_CONST = {
  /** STCA look-ahead, s (stage 1 amber); stage 2 red within this many s or actual loss. */
  stcaLookaheadS: 60,
  stcaRedS: 30,
  /** Radar minima. */
  horizSepNM: 3,
  vertSepFt: 1000,
  /** Reduced minima exceptions (03 §8): below this AGL on final pairs are not alerted; diverging departures >= 15 deg; 60 s go-around grace. */
  reducedFinalFt: 1600,
  divergingDeg: 15,
  goAroundGraceS: 60,
  /** MSAW look-ahead, s. */
  msawLookaheadS: 60,
  /** MSAW default floor (ft AGL) outside `msawNearNM` of the airport when the engine has no MVA polygons. */
  msawDefaultFloorFt: 1500,
  msawNearNM: 5,
  /** Runway incursion: arrival inside this many NM or a rolling departure makes a runway "in use". */
  incursionArrivalNM: 2,
  /** Ground conflict distance, m. */
  groundConflictM: 60,
  /** Deadlock: head-on pair within this many m, both stopped for this many s (03 §C6). */
  deadlockM: 100,
  deadlockStoppedS: 15,
  /** Escalation: unacked critical after this many s tints the top bar (UI reads `escalated`). */
  escalateS: 10,
  /** Auto-dismiss for info alerts, s (UI). */
  infoAutoDismissS: 6,
  warnAutoDismissS: 12,
  /** Delay alert thresholds (UX §5.1). */
  delayAirborneS: 25 * 60,
  delayHoldShortS: 10 * 60,
  /** Holding-fuel alert: airborne holding longer than this, s. */
  holdingFuelS: 20 * 60,
  /** No landing clearance: raise when an uncleared arrival is inside this many NM of the threshold. */
  noClearanceNM: 2.5,
  /** Stopped on a runway longer than this, s. */
  stoppedOnRunwayS: 60,
  /** Pilot request unanswered longer than this, s. */
  requestTimeoutS: 90,
  /** Hysteresis: a computed condition must be clear for this many s before its alert auto-resolves. */
  resolveHoldS: 5,
  /** Wake infringement lateral tolerance on final, NM. */
  wakeLateralNM: 0.5,
} as const;

export const ALERT_SEVERITY: Record<AlertKind, AlertSeverity> = {
  stca: 'critical', msaw: 'critical', runway_incursion: 'critical', emergency: 'critical',
  occupied_runway_clearance: 'warning', ground_conflict: 'warning', wake: 'warning', go_around: 'warning',
  diversion_risk: 'warning', deadlock: 'warning',
  delay: 'info', request: 'info', handoff: 'info', runway_status: 'info',
};

// ──────────────────────────────────────────────────────────────────────────────
//  CPA maths (implemented)
// ──────────────────────────────────────────────────────────────────────────────
export interface CpaResult {
  /** Seconds until closest point of approach (0 when already diverging). */
  tS: number;
  /** Horizontal distance at CPA, NM. */
  distNM: number;
  /** Vertical separation at CPA, ft (linear extrapolation of climb/descent). */
  vertFt: number;
  /** Current horizontal distance, NM. */
  nowNM: number;
  nowVertFt: number;
}

/** Linear closest-point-of-approach for two airborne aircraft using current ground vectors and vertical rates (ft/min). */
export function cpa(a: { pos: XY; heading: number; speedKt: number; altFt: number; vsFpm: number }, b: { pos: XY; heading: number; speedKt: number; altFt: number; vsFpm: number }, maxS: number = ALERT_CONST.stcaLookaheadS): CpaResult {
  const DEG = Math.PI / 180;
  const va = { x: Math.sin(a.heading * DEG) * a.speedKt * KTS_TO_MPS, y: Math.cos(a.heading * DEG) * a.speedKt * KTS_TO_MPS };
  const vb = { x: Math.sin(b.heading * DEG) * b.speedKt * KTS_TO_MPS, y: Math.cos(b.heading * DEG) * b.speedKt * KTS_TO_MPS };
  const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
  const dvx = vb.x - va.x, dvy = vb.y - va.y;
  const dv2 = dvx * dvx + dvy * dvy;
  let t = dv2 < 1e-9 ? 0 : -(dx * dvx + dy * dvy) / dv2;
  t = Math.max(0, Math.min(maxS, t));
  const cx = dx + dvx * t, cy = dy + dvy * t;
  const vert = (b.altFt + b.vsFpm * t / 60) - (a.altFt + a.vsFpm * t / 60);
  const modeC = (ft: number) => Math.round(ft / 100) * 100;   // 100 ft Mode C increments, as the engine's separation check
  return { tS: t, distNM: Math.hypot(cx, cy) / NM_TO_M, vertFt: Math.abs(vert), nowNM: Math.hypot(dx, dy) / NM_TO_M, nowVertFt: Math.abs(modeC(b.altFt) - modeC(a.altFt)) };
}

/**
 * Earliest time (s, within maxS) at which a pair is predicted to infringe BOTH
 * `sepNM` horizontally and `vertFt` vertically, or null when it never does.
 * Unlike cpa() this finds the first infringement, not the closest point.
 */
export function timeToInfringement(a: { pos: XY; heading: number; speedKt: number; altFt: number; vsFpm: number }, b: { pos: XY; heading: number; speedKt: number; altFt: number; vsFpm: number }, sepNM: number, vertFt: number, maxS: number = ALERT_CONST.stcaLookaheadS): number | null {
  const DEG = Math.PI / 180;
  const va = { x: Math.sin(a.heading * DEG) * a.speedKt * KTS_TO_MPS, y: Math.cos(a.heading * DEG) * a.speedKt * KTS_TO_MPS };
  const vb = { x: Math.sin(b.heading * DEG) * b.speedKt * KTS_TO_MPS, y: Math.cos(b.heading * DEG) * b.speedKt * KTS_TO_MPS };
  const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
  const dvx = vb.x - va.x, dvy = vb.y - va.y;
  const R = sepNM * NM_TO_M;
  // horizontal: |d + v t| < R  -> quadratic
  const A = dvx * dvx + dvy * dvy, B = 2 * (dx * dvx + dy * dvy), C = dx * dx + dy * dy - R * R;
  let h0: number, h1: number;
  if (A < 1e-9) { if (C >= 0) return null; h0 = 0; h1 = maxS; }
  else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    h0 = (-B - s) / (2 * A); h1 = (-B + s) / (2 * A);
    if (h1 < 0) return null;
    h0 = Math.max(0, h0); h1 = Math.min(maxS, h1);
    if (h0 > h1) return null;
  }
  // vertical: |dz + dvz t| < V
  const dz = b.altFt - a.altFt, dvz = (b.vsFpm - a.vsFpm) / 60;
  let v0: number, v1: number;
  if (Math.abs(dvz) < 1e-9) { if (Math.abs(dz) >= vertFt) return null; v0 = 0; v1 = maxS; }
  else {
    const t1 = (-vertFt - dz) / dvz, t2 = (vertFt - dz) / dvz;
    v0 = Math.max(0, Math.min(t1, t2)); v1 = Math.min(maxS, Math.max(t1, t2));
    if (v0 > v1) return null;
  }
  const t = Math.max(h0, v0);
  return t <= Math.min(h1, v1) ? t : null;
}

/** Vertical speed estimate (ft/min) from an aircraft's target vs current altitude and perf. */
export function verticalSpeedFpm(a: AircraftState): number {
  if (Math.abs(a.targetAltitude - a.altitude) < 50) return 0;
  const up = a.targetAltitude > a.altitude;
  const r = up ? a.perf.maxClimbRate : -a.perf.maxDescentRate;
  return a.expedite ? r * 1.5 : r;
}

function track(a: AircraftState) {
  return { pos: a.pos, heading: a.heading, speedKt: a.speed, altFt: a.altitude, vsFpm: verticalSpeedFpm(a) };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Engine
// ──────────────────────────────────────────────────────────────────────────────
/** Read-only engine view for the alert pass. */
export interface AlertStepCtx {
  time: number;
  /** Required separation for a pair (wake-aware), NM. */
  requiredSepNM(a: AircraftState, b: AircraftState): number;
  /** Reduced-minima exception for a pair (parallel ILS, both on final < 1600 ft, diverging deps, GA grace). */
  reducedMinima(a: AircraftState, b: AircraftState): boolean;
  /** MSA / restricted-area floor at a position (ft), null when unknown. */
  msaAt(pos: XY): number | null;
  /** Whether a ground entity is inside a runway strip without a clearance for it. */
  onRunwayWithoutClearance(id: number | string): string | null;
  /** Arrival on final to a runway within N NM (callsign) or null. */
  arrivalOnFinal(runway: string, nm: number): string | null;
  /** Runway with a rolling departure (callsign) or null. */
  rollingDeparture(runway: string): string | null;
  /** Wake-timer status per runway. */
  wakeTimerRemainingS(runway: string): number;
  /** Optional: airport reference point (for the MSAW default floor outside 5 NM and diversion risk). */
  centerXY?: XY;
  /** Optional: airspace radius (m) for diversion-risk alerts. */
  airspaceRadiusM?: number;
  /** Optional: distance to threshold (NM) for an arrival, for the no-landing-clearance and wake checks. */
  distToThresholdNM?(a: AircraftState): number | null;
  /** Optional: id of the selected aircraft (sound inhibit is UI-side; kept for parity). */
  selectedId?: number | null;
}

export interface AlertStepResult {
  /** Alerts raised or updated this step (for toasts/sounds). */
  changed: Alert[];
  /** Alerts resolved this step. */
  resolved: Alert[];
  events: SimEvent[];
}

/**
 * Alert engine. One per session, owned by the engine; step() runs once per
 * frame after checkSeparation (not per substep).
 *
 *   step(aircraft, vehicles, runways, dt, ctx)
 *     - STCA: for every airborne pair not under reduced minima, cpa(); stage 1
 *       (predicted, warning) when distNM < required && vertFt < 1000 within
 *       60 s; stage 2 (critical) within 30 s or actual loss. Key 'stca:A-B'
 *       (ids sorted) so the same pair updates instead of duplicating.
 *     - MSAW: airborne, not on final, predicted altitude 60 s ahead below msaAt.
 *     - runway_incursion: any aircraft/vehicle onRunwayWithoutClearance, or an
 *       entity on a runway that has an arrival < 2 NM / rolling departure.
 *     - wake: trailing aircraft inside the wake distance on final, or a takeoff
 *       clearance issued with a wake timer running (raised by dispatch via raise()).
 *     - ground_conflict / deadlock: converging ground pairs within 60 m; head-on
 *       pairs stopped >= 15 s within 100 m.
 *     - emergency: mirrors a.emergency (critical) until resolved.
 *     - delay / holding fuel / request timeouts / no landing clearance /
 *       stopped on runway: informational-to-warning conditions from state.
 *     - Resolution: when the condition clears for `resolveHoldS` -> resolvedAt =
 *       now, event 'alert' change 'resolved'; ack state kept.
 *   raise(kind, subjects, title, detail, geometry?) -> manual raise from the
 *       engine/dispatch (occupied_runway_clearance, emergency, go_around,
 *       runway_status, handoff, request, delay). Dedupe by (kind, subjects).
 *   ack(id) -> ack = true, ackAt = now; returns false when unknown.
 *   resolve(id) -> force-resolve (runway reopened, emergency resolved).
 *   list() / active() / byId()
 *   stca() -> { pairs, active } for the test API.
 */
export class AlertEngine {
  private alerts: Alert[] = [];
  private seq = 0;
  /** Alerts whose lifecycle this engine manages (auto-resolve); externally raised ones are left to resolve(). */
  private managed = new Set<string>();
  /** Last sim time each managed alert's condition was observed true. */
  private lastSeen = new Map<string, number>();
  /** Ground pairs: time each pair was first seen stopped head-on (deadlock timer). */
  private headOnSince = new Map<string, number>();
  /** Runway occupancy: first time each entity was seen stopped on a runway. */
  private stoppedSince = new Map<string, number>();

  step(aircraft: readonly AircraftState[], vehicles: readonly Vehicle[], runways: readonly RunwayState[], dt: number, ctx: AlertStepCtx): AlertStepResult {
    void dt;
    const now = ctx.time;
    const changed: Alert[] = [];
    const resolved: Alert[] = [];
    const events: SimEvent[] = [];
    const seen = new Set<string>();

    const touch = (kind: AlertKind, subjects: string[], subjectIds: number[], title: string, detail: string, geometry: Partial<Alert['geometry']>, severity: AlertSeverity, predicted = false): Alert => {
      const before = this.find(kind, subjects);
      const wasNew = !before;
      const prevSev = before?.severity;
      const prevPred = before?.predicted;
      const a = this.raise(kind, subjects, title, detail, now, geometry, subjectIds);
      a.severity = severity;
      a.predicted = predicted;
      a.title = title;
      this.managed.add(a.id);
      this.lastSeen.set(a.id, now);
      seen.add(a.id);
      if (wasNew) {
        changed.push(a);
        events.push(this.event(a, 'raised', now));
      } else if (prevSev !== severity || prevPred !== predicted) {
        if (severity === 'critical' && prevSev !== 'critical') { a.ack = false; a.ackAt = null; } // escalation re-arms the sound
        changed.push(a);
        events.push(this.event(a, 'updated', now));
      }
      return a;
    };

    const byId = new Map<number, AircraftState>();
    for (const a of aircraft) byId.set(a.id, a);
    const airborne = aircraft.filter(a => isAirbornePhase(a.phase) && a.phase !== 'departed');
    const ground = aircraft.filter(a => !isAirbornePhase(a.phase) && a.phase !== 'arrived' && a.phase !== 'departed');

    // ── STCA ──
    for (let i = 0; i < airborne.length; i++) {
      for (let j = i + 1; j < airborne.length; j++) {
        const a = airborne[i], b = airborne[j];
        if (ctx.reducedMinima(a, b)) continue;
        const req = Math.max(0.1, ctx.requiredSepNM(a, b));
        const ta = track(a), tb = track(b);
        const r = cpa(ta, tb, ALERT_CONST.stcaLookaheadS);
        const actual = r.nowNM < req && r.nowVertFt < ALERT_CONST.vertSepFt;
        const tInf = actual ? 0 : timeToInfringement(ta, tb, req, ALERT_CONST.vertSepFt, ALERT_CONST.stcaLookaheadS);
        const predicted = !actual && tInf != null && r.distNM < req && r.vertFt < ALERT_CONST.vertSepFt;
        if (!actual && !predicted) continue;
        const red = actual || (tInf != null && tInf <= ALERT_CONST.stcaRedS);
        const detail = actual
          ? `${r.nowNM.toFixed(1)} NM / ${Math.round(r.nowVertFt)} ft — separation lost (min ${req.toFixed(1)} NM)`
          : `${r.nowNM.toFixed(1)} NM / ${Math.round(r.nowVertFt)} ft, closing ${Math.round(tInf ?? r.tS)} s (CPA ${r.distNM.toFixed(1)} NM)`;
        touch('stca', [a.callsign, b.callsign], [a.id, b.id], actual ? 'SEPARATION LOSS' : 'STCA', detail,
          { distNM: round1(r.nowNM), vertFt: Math.round(r.nowVertFt), cpaS: Math.round(actual ? 0 : (tInf ?? r.tS)), cpaNM: round1(r.distNM), runway: null },
          red ? 'critical' : 'warning', !actual);
      }
    }

    // ── MSAW ──
    for (const a of airborne) {
      if (a.phase === 'takeoff' || a.phase === 'go_around') continue;
      // phase 'approach' only means "under approach control" here; the exemption is for aircraft actually on an approach
      const onApproach = a.phase === 'landing' || a.ilsCaptured || a.gsCaptured || a.navMode === 'visual';
      if (onApproach) continue;
      if (a.plan.kind === 'departure' && a.altitude < 1500 && a.phase === 'climb') continue; // initial climb
      let floor = ctx.msaAt(a.pos);
      if (floor == null && ctx.centerXY) {
        const dNM = Math.hypot(a.pos.x - ctx.centerXY.x, a.pos.y - ctx.centerXY.y) / NM_TO_M;
        floor = dNM > ALERT_CONST.msawNearNM ? ALERT_CONST.msawDefaultFloorFt : null;
      }
      if (floor == null) continue;
      const vs = verticalSpeedFpm(a);
      const predictedAlt = a.altitude + vs * (ALERT_CONST.msawLookaheadS / 60);
      const below = a.altitude < floor;
      const willBe = vs < 0 && predictedAlt < floor && a.targetAltitude < floor;
      if (!below && !willBe) continue;
      touch('msaw', [a.callsign], [a.id], 'MSAW', below ? `${Math.round(a.altitude)} ft below MSA ${floor} ft` : `descending through MSA ${floor} ft within 60 s (${Math.round(a.altitude)} ft)`,
        { distNM: null, vertFt: Math.round(floor - a.altitude), cpaS: below ? 0 : ALERT_CONST.msawLookaheadS, cpaNM: null, runway: null }, below ? 'critical' : 'warning', !below);
    }

    // ── runway incursion ──
    for (const a of ground) {
      const rwy = ctx.onRunwayWithoutClearance(a.id);
      if (rwy) {
        const other = ctx.arrivalOnFinal(rwy, ALERT_CONST.incursionArrivalNM) ?? ctx.rollingDeparture(rwy);
        touch('runway_incursion', other && other !== a.callsign ? [a.callsign, other] : [a.callsign], [a.id], 'RUNWAY INCURSION',
          `${a.callsign} on runway ${rwy} without clearance${other ? `, ${other} ${ctx.rollingDeparture(rwy) === other ? 'rolling' : 'on short final'}` : ''}`,
          { runway: rwy, distNM: null, vertFt: null, cpaS: null, cpaNM: null }, 'critical');
      }
    }
    for (const v of vehicles) {
      if (v.state === 'standby') continue;
      const rwy = ctx.onRunwayWithoutClearance(v.id);
      if (rwy && !v.holdReleased) {
        const other = ctx.arrivalOnFinal(rwy, ALERT_CONST.incursionArrivalNM) ?? ctx.rollingDeparture(rwy);
        touch('runway_incursion', other ? [v.id, other] : [v.id], [], 'RUNWAY INCURSION', `${v.callsign} on runway ${rwy} without clearance${other ? `, ${other} inbound` : ''}`,
          { runway: rwy, distNM: null, vertFt: null, cpaS: null, cpaNM: null }, 'critical');
      }
    }
    // occupants of a runway "in use" by a landing / rolling aircraft (crossing under an arrival)
    const seenRunways = new Set<string>();
    for (const r of runways) {
      if (seenRunways.has(r.ref)) continue;
      seenRunways.add(r.ref);
      const arrival = ctx.arrivalOnFinal(r.name, ALERT_CONST.incursionArrivalNM) ?? ctx.arrivalOnFinal(r.reciprocal, ALERT_CONST.incursionArrivalNM);
      const rolling = ctx.rollingDeparture(r.name) ?? ctx.rollingDeparture(r.reciprocal);
      const user = arrival ?? rolling;
      if (!user) continue;
      for (const occ of r.occupiedBy) {
        if (occ.callsign === user) continue;
        if (occ.kind === 'takeoff' || occ.kind === 'landing' || occ.kind === 'rollout') {
          if (!arrival) continue; // two departures: the engine's runway rule scores it; the incursion is the arrival case
        }
        const isVehicle = typeof occ.id === 'string';
        const veh = isVehicle ? vehicles.find(v => v.id === occ.id) : null;
        if (veh && veh.state === 'standby') continue;
        touch('runway_incursion', [occ.callsign, user], isVehicle ? [] : [occ.id as number], 'RUNWAY INCURSION',
          `${occ.callsign} ${occ.kind === 'crossing' ? 'crossing' : occ.kind === 'vehicle' ? 'vehicle on' : occ.kind === 'lineup' ? 'lined up on' : 'on'} runway ${r.name}, ${user} ${arrival ? 'inside 2 NM' : 'rolling'}`,
          { runway: r.name, distNM: null, vertFt: null, cpaS: null, cpaNM: null }, 'critical');
      }
    }

    // ── wake on final ──
    const onFinal = airborne.filter(a => (a.ilsCaptured || a.phase === 'landing' || a.navMode === 'visual') && (a.assignedRunway || a.plan.runway));
    const dtt = (a: AircraftState): number | null => {
      if (ctx.distToThresholdNM) { const d = ctx.distToThresholdNM(a); if (d != null) return d; }
      if (a.path && a.phase === 'landing') return Math.max(0, a.thresholdDist - a.distAlong) / NM_TO_M;
      return null;
    };
    for (let i = 0; i < onFinal.length; i++) {
      for (let j = 0; j < onFinal.length; j++) {
        if (i === j) continue;
        const lead = onFinal[i], trail = onFinal[j];
        const rl = lead.assignedRunway ?? lead.plan.runway, rt = trail.assignedRunway ?? trail.plan.runway;
        if (rl !== rt) continue;
        const dl = dtt(lead), dtr = dtt(trail);
        let gap: number;
        if (dl != null && dtr != null) { if (dtr <= dl) continue; gap = dtr - dl; }
        else {
          // fall back to straight-line distance with the leader ahead along the trailer's heading
          const DEG = Math.PI / 180;
          const ahead = (lead.pos.x - trail.pos.x) * Math.sin(trail.heading * DEG) + (lead.pos.y - trail.pos.y) * Math.cos(trail.heading * DEG);
          if (ahead <= 0) continue;
          const hdgDiff = Math.abs(((lead.heading - trail.heading + 540) % 360) - 180);
          if (hdgDiff > 45) continue; // not on the same track
          const lateral = Math.abs((lead.pos.x - trail.pos.x) * Math.cos(trail.heading * DEG) - (lead.pos.y - trail.pos.y) * Math.sin(trail.heading * DEG));
          if (lateral / NM_TO_M > ALERT_CONST.wakeLateralNM) continue;
          gap = ahead / NM_TO_M;
        }
        if (Math.abs(lead.altitude - trail.altitude) > ALERT_CONST.vertSepFt && trail.altitude < lead.altitude) continue; // trailer well below: no wake
        const req = Math.max(WAKE_FINAL_NM[lead.wakeCategory][trail.wakeCategory], ctx.requiredSepNM(lead, trail));
        if (gap >= req) continue;
        touch('wake', [trail.callsign, lead.callsign], [trail.id, lead.id], 'WAKE', `${trail.callsign} ${gap.toFixed(1)} NM behind ${lead.callsign} (${lead.wakeCategory}), minimum ${req} NM`,
          { distNM: round1(gap), vertFt: Math.round(Math.abs(lead.altitude - trail.altitude)), cpaS: null, cpaNM: round1(req), runway: rl ?? null }, gap < req - 1 ? 'critical' : 'warning');
      }
    }

    // ── ground conflict / deadlock ──
    const moving = (a: AircraftState) => a.speed > 1;
    for (let i = 0; i < ground.length; i++) {
      for (let j = i + 1; j < ground.length; j++) {
        const a = ground[i], b = ground[j];
        if (a.phase === 'parked' || b.phase === 'parked') continue;
        const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        const headOn = Math.abs(((a.heading - b.heading + 540) % 360) - 180) > 150;
        if (d <= ALERT_CONST.groundConflictM && (moving(a) || moving(b)) && a.followId !== b.id && b.followId !== a.id && a.giveWayTo !== b.id && b.giveWayTo !== a.id) {
          touch('ground_conflict', [a.callsign, b.callsign], [a.id, b.id], 'GROUND CONFLICT', `${Math.round(d)} m${headOn ? ', nose to nose' : ''}`,
            { distNM: round1(d / NM_TO_M), vertFt: null, cpaS: null, cpaNM: null, runway: null }, 'warning');
        }
        if (d <= ALERT_CONST.deadlockM && headOn && !moving(a) && !moving(b) && (a.phase === 'taxi' || a.phase === 'hold_short') && (b.phase === 'taxi' || b.phase === 'hold_short')) {
          const since = this.headOnSince.get(key) ?? now;
          this.headOnSince.set(key, since);
          if (now - since >= ALERT_CONST.deadlockStoppedS) {
            touch('deadlock', [a.callsign, b.callsign], [a.id, b.id], 'DEADLOCK', `head-on, both stopped ${Math.round(now - since)} s, ${Math.round(d)} m apart — reroute one`,
              { distNM: round1(d / NM_TO_M), vertFt: null, cpaS: null, cpaNM: null, runway: null }, 'warning');
          }
        } else this.headOnSince.delete(key);
      }
    }

    // ── emergency mirror ──
    for (const a of aircraft) {
      const e = a.emergency;
      if (!e || e.status === 'resolved') continue;
      const sev: AlertSeverity = e.status === 'stopped' || e.status === 'landed' ? 'warning' : 'critical';
      const detail = `${e.level} ${e.type.replace('_', ' ')} — ${e.status.replace('_', ' ')}${e.fuelMin != null ? `, fuel ${Math.round(e.fuelMin)} min` : ''}${e.runway ? `, runway ${e.runway}` : ''}`;
      const al = touch('emergency', [a.callsign], [a.id], e.level === 'PAN' ? 'PAN PAN' : 'MAYDAY', detail, { runway: e.runway, distNM: null, vertFt: null, cpaS: null, cpaNM: null }, sev);
      if (!al.detail.startsWith(e.pilotLine) && e.pilotLine && al.createdAt === now) al.detail = `${e.pilotLine} ${detail}`;
    }

    // ── no landing clearance (arrival inside 2.5 NM without clearance) ──
    for (const a of onFinal) {
      if (a.landingCleared || a.goAround) continue;
      const d = dtt(a);
      if (d == null || d > ALERT_CONST.noClearanceNM) continue;
      touch('request', [a.callsign], [a.id], 'NO LANDING CLEARANCE', `${a.callsign} ${d.toFixed(1)} NM final, not cleared to land`,
        { distNM: round1(d), vertFt: Math.round(a.altitude), cpaS: null, cpaNM: null, runway: a.assignedRunway ?? a.plan.runway ?? null }, d <= 1.5 ? 'critical' : 'warning');
    }

    // ── stopped on a runway > 60 s (disabled aircraft / vehicle) ──
    const stoppedNow = new Set<string>();
    const seenRefs = new Set<string>();
    for (const r of runways) {
      if (seenRefs.has(r.ref)) continue;
      seenRefs.add(r.ref);
      for (const occ of r.occupiedBy) {
        const isVehicle = typeof occ.id === 'string';
        const ent = isVehicle ? vehicles.find(v => v.id === occ.id) : byId.get(occ.id as number);
        if (!ent) continue;
        const speed = ent.speed;
        const key = `${occ.id}@${r.ref}`;
        if (speed > 2 || occ.kind === 'inspection') { this.stoppedSince.delete(key); continue; }
        stoppedNow.add(key);
        const since = this.stoppedSince.get(key) ?? Math.max(occ.since, now);
        this.stoppedSince.set(key, since);
        const stoppedS = now - since;
        if (stoppedS < ALERT_CONST.stoppedOnRunwayS) continue;
        const ac = !isVehicle ? (ent as AircraftState) : null;
        if (ac && ac.phase === 'lineup' && stoppedS < 180) continue; // lined up waiting is normal until 180 s (03 §A14)
        if (r.status !== 'open' && !ac) continue;                      // vehicles on a closed/inspection runway are expected
        touch('runway_status', [occ.callsign], ac ? [ac.id] : [], 'STOPPED ON RUNWAY', `${occ.callsign} stopped on runway ${r.name} for ${Math.round(stoppedS)} s`,
          { runway: r.name, distNM: null, vertFt: null, cpaS: Math.round(stoppedS), cpaNM: null }, 'warning');
      }
    }
    for (const k of [...this.stoppedSince.keys()]) if (!stoppedNow.has(k)) this.stoppedSince.delete(k);

    // ── delay / holding fuel / unanswered requests ──
    for (const a of aircraft) {
      if (a.phase === 'arrived' || a.phase === 'departed') continue;
      const holdingS = a.delay.holdingS;
      if (a.navMode === 'hold' && holdingS >= ALERT_CONST.holdingFuelS) {
        touch('delay', [a.callsign], [a.id], 'HOLDING 20+ MIN', `${a.callsign} holding ${Math.round(holdingS / 60)} min${a.fuelMin != null ? `, fuel ${Math.round(a.fuelMin)} min` : ''}${a.fuelMin != null && a.fuelMin < 30 ? ' — diversion likely' : ''}`,
          { distNM: null, vertFt: null, cpaS: Math.round(holdingS), cpaNM: null, runway: null }, a.fuelMin != null && a.fuelMin < 30 ? 'warning' : 'info');
      } else if (a.delay.airborneS >= ALERT_CONST.delayAirborneS && isAirbornePhase(a.phase) && a.plan.kind === 'arrival') {
        touch('delay', [a.callsign], [a.id], 'DELAY', `${a.callsign} airborne ${Math.round(a.delay.airborneS / 60)} min in the TMA`,
          { distNM: null, vertFt: null, cpaS: Math.round(a.delay.airborneS), cpaNM: null, runway: null }, 'info');
      } else if (a.delay.holdShortWaitS >= ALERT_CONST.delayHoldShortS && a.phase === 'hold_short') {
        touch('delay', [a.callsign], [a.id], 'DELAY', `${a.callsign} holding short ${Math.round(a.delay.holdShortWaitS / 60)} min`,
          { distNM: null, vertFt: null, cpaS: Math.round(a.delay.holdShortWaitS), cpaNM: null, runway: a.holdShortRunway }, 'info');
      }
      const req = a.requests.find(r => r.answeredAt == null && (r.expiresAt == null || r.expiresAt > now));
      if (req && now - req.at >= ALERT_CONST.requestTimeoutS && req.kind !== 'with_you') {
        touch('request', [a.callsign], [a.id], 'REQUEST UNANSWERED', `${a.callsign} ${req.kind.replace('_', ' ')} unanswered ${Math.round(now - req.at)} s${req.recalls ? ` (${req.recalls} recalls)` : ''}`,
          { distNM: null, vertFt: null, cpaS: Math.round(now - req.at), cpaNM: null, runway: null }, 'info');
      }
    }

    // ── diversion risk (departure near the boundary too low, or arrival heading out) ──
    if (ctx.centerXY && ctx.airspaceRadiusM) {
      const c = ctx.centerXY, R = ctx.airspaceRadiusM;
      for (const a of airborne) {
        const d = Math.hypot(a.pos.x - c.x, a.pos.y - c.y);
        if (R - d > 2 * NM_TO_M) continue;
        const DEG = Math.PI / 180;
        const outbound = ((a.pos.x - c.x) * Math.sin(a.heading * DEG) + (a.pos.y - c.y) * Math.cos(a.heading * DEG)) > 0;
        if (!outbound) continue;
        if (a.plan.kind === 'departure' && a.altitude <= 9000 && a.onFrequency !== 'external') {
          touch('diversion_risk', [a.callsign], [a.id], 'BOUNDARY', `${a.callsign} ${((R - d) / NM_TO_M).toFixed(1)} NM from the boundary at ${Math.round(a.altitude)} ft, not handed off`,
            { distNM: round1((R - d) / NM_TO_M), vertFt: Math.round(a.altitude), cpaS: null, cpaNM: null, runway: null }, 'warning');
        } else if (a.plan.kind === 'arrival') {
          touch('diversion_risk', [a.callsign], [a.id], 'LEAVING AIRSPACE', `${a.callsign} arrival heading out of the TMA, ${((R - d) / NM_TO_M).toFixed(1)} NM to the boundary`,
            { distNM: round1((R - d) / NM_TO_M), vertFt: Math.round(a.altitude), cpaS: null, cpaNM: null, runway: null }, 'warning');
        }
      }
    }

    // ── auto-resolution of managed alerts with hysteresis ──
    const alive = new Set<string>();
    for (const a of aircraft) alive.add(a.callsign);
    for (const v of vehicles) alive.add(v.id);
    for (const al of this.alerts) {
      if (al.resolvedAt != null || !this.managed.has(al.id)) continue;
      if (seen.has(al.id)) continue;
      const last = this.lastSeen.get(al.id) ?? al.updatedAt;
      const gone = al.subjects.some(s => !alive.has(s));
      if (gone || now - last >= ALERT_CONST.resolveHoldS) {
        al.resolvedAt = now;
        resolved.push(al);
        events.push(this.event(al, 'resolved', now));
      }
    }
    return { changed, resolved, events };
  }

  private event(alert: Alert, change: 'raised' | 'updated' | 'acked' | 'resolved', time: number): SimEvent {
    const msg = change === 'resolved' ? `${alert.title} resolved: ${alert.subjects.join(' / ')}` : `${alert.title}: ${alert.subjects.join(' / ')} — ${alert.detail}`;
    return { type: 'alert', id: alert.subjectIds[0] ?? -1, callsign: alert.subjects[0] ?? 'SYSTEM', message: msg, at: time, who: 'SYS', data: { type: 'alert', alert, change } };
  }

  private key(kind: AlertKind, subjects: string[]): string { return `${kind}:${[...subjects].sort().join('/')}`; }
  private find(kind: AlertKind, subjects: string[]): Alert | undefined {
    const key = this.key(kind, subjects);
    return this.alerts.find(a => a.resolvedAt == null && this.key(a.kind, a.subjects) === key);
  }

  raise(kind: AlertKind, subjects: string[], title: string, detail: string, time: number, geometry: Partial<Alert['geometry']> = {}, subjectIds: number[] = []): Alert {
    const existing = this.find(kind, subjects);
    if (existing) {
      existing.detail = detail; existing.updatedAt = time;
      existing.geometry = { ...existing.geometry, ...geometry };
      if (subjectIds.length && !existing.subjectIds.length) existing.subjectIds = subjectIds;
      return existing;
    }
    const alert: Alert = {
      id: `al${++this.seq}`, kind, severity: ALERT_SEVERITY[kind], subjects, subjectIds, title, detail,
      geometry: { distNM: null, vertFt: null, cpaS: null, cpaNM: null, runway: null, ...geometry },
      createdAt: time, updatedAt: time, ack: false, ackAt: null, resolvedAt: null, scoreDelta: 0, predicted: false,
    };
    this.alerts.push(alert);
    return alert;
  }

  /** Runway-change suggestion from the weather model (UX §5.1 "Runway status change" / weather kind). */
  raiseWeather(suggestion: { dep: string[]; arr: string[]; reason: string }, time: number): Alert {
    const subjects = [...new Set([...suggestion.arr, ...suggestion.dep])];
    return this.raise('runway_status', subjects, 'RUNWAY CHANGE SUGGESTED', suggestion.reason, time, { runway: suggestion.arr[0] ?? null });
  }

  ack(id: string, time = 0): boolean {
    const i = this.alerts.findIndex(x => x.id === id);
    const a = i >= 0 ? this.alerts[i] : null;
    if (!a || a.ack) return false;
    // new object: `activeAlerts()` consumers compare by identity (simStore.useSim shallow-equal)
    this.alerts[i] = { ...a, ack: true, ackAt: time };
    return true;
  }

  resolve(id: string, time = 0): boolean {
    const i = this.alerts.findIndex(x => x.id === id);
    const a = i >= 0 ? this.alerts[i] : null;
    if (!a || a.resolvedAt != null) return false;
    this.alerts[i] = { ...a, resolvedAt: time };
    this.managed.delete(id);
    return true;
  }

  /** Resolve every active alert of a kind (optionally only those naming a subject). */
  resolveKind(kind: AlertKind, subject: string | null, time: number): number {
    let n = 0;
    for (const a of this.alerts) {
      if (a.resolvedAt != null || a.kind !== kind) continue;
      if (subject && !a.subjects.includes(subject)) continue;
      a.resolvedAt = time; this.managed.delete(a.id); n++;
    }
    return n;
  }

  list(): Alert[] { return this.alerts; }
  active(): Alert[] { return this.alerts.filter(a => a.resolvedAt == null); }
  byId(id: string): Alert | undefined { return this.alerts.find(a => a.id === id); }
  /** Active alerts naming a subject (callsign / vehicle id). */
  forSubject(subject: string): Alert[] { return this.active().filter(a => a.subjects.includes(subject)); }
  /** Unacknowledged critical alerts older than escalateS (UI top-bar tint). */
  escalated(time: number): Alert[] { return this.active().filter(a => a.severity === 'critical' && !a.ack && time - a.createdAt >= ALERT_CONST.escalateS); }
  /** Drop resolved alerts (UI "Clear resolved"). */
  clearResolved(): void { this.alerts = this.alerts.filter(a => a.resolvedAt == null); }
  clear(): void { this.alerts = []; this.managed.clear(); this.lastSeen.clear(); this.headOnSince.clear(); this.stoppedSince.clear(); }

  /** Test API shape (05 §2.2 `stca()`). */
  stca(): { pairs: [string, string][]; active: boolean } {
    const pairs = this.active().filter(a => a.kind === 'stca').map(a => [a.subjects[0], a.subjects[1]] as [string, string]);
    return { pairs, active: pairs.length > 0 };
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

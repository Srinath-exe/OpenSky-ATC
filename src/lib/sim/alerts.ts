// ============================================================
//  Alerts — CONTRACT STUB (W1-SYSTEMS implements; W1-ENGINE calls)
//
//  STCA (CPA prediction <= 60 s / actual loss), MSAW, runway incursion
//  (aircraft + vehicles), wake-timer violations, plus the informational kinds
//  (UX 04 §5.1 catalogue). Alerts are objects with ack/resolve state kept for
//  the session; the same pair never spawns duplicate alerts (existing one
//  updates its geometry). The CPA maths is IMPLEMENTED here (pure).
// ============================================================
import type { XY } from './projection';
import { KTS_TO_MPS, NM_TO_M } from './projection';
import type { AircraftState, Alert, AlertKind, AlertSeverity, RunwayState, SimEvent, Vehicle } from './types';

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
  /** Runway incursion: arrival inside this many NM or a rolling departure makes a runway "in use". */
  incursionArrivalNM: 2,
  /** Ground conflict distance, m. */
  groundConflictM: 60,
  /** Escalation: unacked critical after this many s tints the top bar (UI reads `escalated`). */
  escalateS: 10,
  /** Auto-dismiss for info alerts, s (UI). */
  infoAutoDismissS: 6,
  warnAutoDismissS: 12,
  /** Delay alert thresholds (UX §5.1). */
  delayAirborneS: 25 * 60,
  delayHoldShortS: 10 * 60,
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
export function cpa(a: { pos: XY; heading: number; speedKt: number; altFt: number; vsFpm: number }, b: { pos: XY; heading: number; speedKt: number; altFt: number; vsFpm: number }, maxS = ALERT_CONST.stcaLookaheadS): CpaResult {
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
  return { tS: t, distNM: Math.hypot(cx, cy) / NM_TO_M, vertFt: Math.abs(vert), nowNM: Math.hypot(dx, dy) / NM_TO_M, nowVertFt: Math.abs(b.altFt - a.altFt) };
}

/** Vertical speed estimate (ft/min) from an aircraft's target vs current altitude and perf. */
export function verticalSpeedFpm(a: AircraftState): number {
  if (Math.abs(a.targetAltitude - a.altitude) < 50) return 0;
  const up = a.targetAltitude > a.altitude;
  const r = up ? a.perf.maxClimbRate : -a.perf.maxDescentRate;
  return a.expedite ? r * 1.5 : r;
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
 *       entity entering a runway that has an arrival < 2 NM / rolling departure.
 *     - wake: trailing aircraft inside the wake distance on final, or a takeoff
 *       clearance issued with a wake timer running (raised by dispatch via raise()).
 *     - ground_conflict: from the engine's ground_conflict events.
 *     - Resolution: when the condition clears -> resolvedAt = now, event
 *       'alert' change 'resolved'; ack state kept.
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

  step(aircraft: readonly AircraftState[], vehicles: readonly Vehicle[], runways: readonly RunwayState[], dt: number, ctx: AlertStepCtx): AlertStepResult {
    void aircraft; void vehicles; void runways; void dt; void ctx;
    throw new Error('not implemented');
  }

  raise(kind: AlertKind, subjects: string[], title: string, detail: string, time: number, geometry: Partial<Alert['geometry']> = {}, subjectIds: number[] = []): Alert {
    const key = `${kind}:${[...subjects].sort().join('/')}`;
    const existing = this.alerts.find(a => a.resolvedAt == null && `${a.kind}:${[...a.subjects].sort().join('/')}` === key);
    if (existing) {
      existing.detail = detail; existing.updatedAt = time;
      existing.geometry = { ...existing.geometry, ...geometry };
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

  ack(id: string, time = 0): boolean {
    const a = this.alerts.find(x => x.id === id);
    if (!a || a.ack) return false;
    a.ack = true; a.ackAt = time;
    return true;
  }

  resolve(id: string, time = 0): boolean {
    const a = this.alerts.find(x => x.id === id);
    if (!a || a.resolvedAt != null) return false;
    a.resolvedAt = time;
    return true;
  }

  list(): Alert[] { return this.alerts; }
  active(): Alert[] { return this.alerts.filter(a => a.resolvedAt == null); }
  byId(id: string): Alert | undefined { return this.alerts.find(a => a.id === id); }
  /** Drop resolved alerts (UI "Clear resolved"). */
  clearResolved(): void { this.alerts = this.alerts.filter(a => a.resolvedAt == null); }
  clear(): void { this.alerts = []; }

  /** Test API shape (05 §2.2 `stca()`). */
  stca(): { pairs: [string, string][]; active: boolean } {
    const pairs = this.active().filter(a => a.kind === 'stca').map(a => [a.subjects[0], a.subjects[1]] as [string, string]);
    return { pairs, active: pairs.length > 0 };
  }
}

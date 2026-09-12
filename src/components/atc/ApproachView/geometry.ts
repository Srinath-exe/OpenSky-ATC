// ============================================================
//  Pure geometry for the scope: turn predictors (bank-limited, same law as
//  aircraft.ts), racetrack holds, closest point of approach, bearings.
// ============================================================
import type { XY } from '@/lib/sim/projection';
import { advance, angleDelta, headingTo, KTS_TO_MPS, NM_TO_M } from '@/lib/sim/projection';
import type { AircraftState } from '@/lib/sim/types';

const DEG = Math.PI / 180;
const G = 9.81;
const BANK = 25 * DEG;

/** Turn rate (deg/s) the physics uses: min(perf × 1.6, 25° bank) — aircraft.ts stepAirborneFree. */
export function turnRateDegS(speedKt: number, perfTurnRate: number): number {
  const v = Math.max(60, speedKt) * KTS_TO_MPS;
  return Math.min(perfTurnRate * 1.6, ((G * Math.tan(BANK)) / v) * 180 / Math.PI);
}
/** Turn radius in metres for the same law. */
export function turnRadiusM(speedKt: number, perfTurnRate: number): number {
  const v = Math.max(60, speedKt) * KTS_TO_MPS;
  return v / (turnRateDegS(speedKt, perfTurnRate) * DEG);
}

/** Shortest / forced turn sense: +1 right, -1 left. */
export function turnSense(from: number, to: number, dir: 'L' | 'R' | null): 1 | -1 {
  if (dir === 'R') return 1;
  if (dir === 'L') return -1;
  return angleDelta(from, to) >= 0 ? 1 : -1;
}

/**
 * Predicted track: turn from `hdg` to `target` at the bank-limited rate, then straight,
 * for `totalS` seconds at ground speed `speedKt`. Points every ~2 s.
 */
export function turnPredictor(pos: XY, hdg: number, target: number, dir: 'L' | 'R' | null, speedKt: number, perfTurnRate: number, totalS = 60): XY[] {
  const pts: XY[] = [pos];
  const v = Math.max(60, speedKt) * KTS_TO_MPS;
  const rate = turnRateDegS(speedKt, perfTurnRate);
  const sense = turnSense(hdg, target, dir);
  let h = hdg;
  let p = pos;
  let remaining = sense > 0 ? ((target - hdg) % 360 + 360) % 360 : ((hdg - target) % 360 + 360) % 360;
  if (remaining > 359) remaining = 0;
  let t = 0;
  const dt = 2;
  while (t < totalS) {
    const step = Math.min(dt, totalS - t);
    if (remaining > 0.01) {
      const dh = Math.min(remaining, rate * step);
      // integrate along the arc with the mean heading of the sub-step
      p = advance(p, h + sense * dh / 2, v * (dh / rate));
      h = (h + sense * dh + 360) % 360;
      remaining -= dh;
      const rest = step - dh / rate;
      if (rest > 0) p = advance(p, h, v * rest);
    } else {
      p = advance(p, h, v * step);
    }
    pts.push(p);
    t += step;
  }
  return pts;
}

/**
 * Racetrack hold outline: inbound leg ends at the fix, standard turns on the
 * `dir` side, leg length in metres. Returns a closed polyline (world XY).
 */
export function racetrack(fix: XY, inboundHdg: number, dir: 'L' | 'R', legM: number, rM: number): XY[] {
  const sense = dir === 'R' ? 1 : -1;
  const outboundHdg = (inboundHdg + 180) % 360;
  const pts: XY[] = [];
  const arc = (centre: XY, startHdgFromCentre: number, sweep: number, steps = 18) => {
    for (let i = 0; i <= steps; i++) pts.push(advance(centre, startHdgFromCentre + (sense * sweep * i) / steps, rM));
  };
  // Turn 1 at the fix: centre is abeam the fix on the turn side.
  const c1 = advance(fix, inboundHdg + sense * 90, rM);
  arc(c1, inboundHdg - sense * 90, 180);
  // Outbound leg
  const legEndOut = advance(pts[pts.length - 1], outboundHdg, legM);
  pts.push(legEndOut);
  // Turn 2 back to inbound
  const c2 = advance(legEndOut, outboundHdg + sense * 90, rM);
  arc(c2, outboundHdg - sense * 90, 180);
  pts.push(fix);
  return pts;
}

export interface Cpa { t: number; pa: XY; pb: XY; distNM: number; vertFt: number }

/** Closest point of approach under constant velocity. `null` when diverging. */
export function cpa(a: AircraftState, b: AircraftState, maxS = 120): Cpa | null {
  const va = vel(a), vb = vel(b);
  const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
  const dvx = vb.x - va.x, dvy = vb.y - va.y;
  const dv2 = dvx * dvx + dvy * dvy;
  if (dv2 < 1e-6) return null;
  const t = -(dx * dvx + dy * dvy) / dv2;
  if (t <= 0 || t > maxS) return null;
  const pa = { x: a.pos.x + va.x * t, y: a.pos.y + va.y * t };
  const pb = { x: b.pos.x + vb.x * t, y: b.pos.y + vb.y * t };
  const distNM = Math.hypot(pb.x - pa.x, pb.y - pa.y) / NM_TO_M;
  return { t, pa, pb, distNM, vertFt: Math.abs(a.altitude - b.altitude) };
}

function vel(a: AircraftState): XY {
  const v = a.speed * KTS_TO_MPS;
  return { x: Math.sin(a.heading * DEG) * v, y: Math.cos(a.heading * DEG) * v };
}

export const magnetic = (trueDeg: number, magVar: number) => ((Math.round(trueDeg - magVar) % 360) + 360) % 360;
export const trueFromMag = (magDeg: number, magVar: number) => ((Math.round(magDeg + magVar) % 360) + 360) % 360;
export const bearingTrue = (from: XY, to: XY) => headingTo(from, to);
export const distNM = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y) / NM_TO_M;
export const hdg3 = (h: number) => String(((Math.round(h) % 360) + 360) % 360 || 360).padStart(3, '0');
/** Altitude in hundreds of feet, 3 digits (radar convention). */
export const alt100 = (ft: number) => String(Math.max(0, Math.round(ft / 100))).padStart(3, '0');

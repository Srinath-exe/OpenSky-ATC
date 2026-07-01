// ============================================================
//  ILS (Instrument Landing System) geometry helpers.
//
//  Coordinate convention: x = east (metres), y = north (metres),
//  headings in compass degrees (0=N, 90=E).
//
//  r.rwdHdg = runway true heading = the heading you fly when landing
//  (e.g. 270 for 27L — you fly westbound to land).
//  featherHdg = (rwdHdg+180)%360 = direction FROM threshold TOWARD
//  approaching traffic = the direction the ILS feather points on the radar.
// ============================================================

import { XY, angleDelta } from './projection';

const DEG = Math.PI / 180;
const FT_PER_M = 3.28084;

export interface ILSRunway {
  name: string;        // e.g. "27L"
  thrXY: XY;           // threshold in local metres
  rwdHdg: number;      // runway true heading (landing direction), e.g. 270
  locCourse: number;   // true LOC course (same as rwdHdg unless offset)
  gsDeg: number;       // glideslope angle, typically 3.0
  thrElevFt: number;   // threshold elevation ft
}

// Direction FROM threshold TOWARD approaching aircraft
export const featherHdg = (r: ILSRunway) => (r.rwdHdg + 180) % 360;

// Along-track distance (m) from threshold in the feather direction.
// Positive = aircraft is on the approach side (ahead of threshold inbound).
export function distAlongFwd(pos: XY, r: ILSRunway): number {
  const fwd = featherHdg(r) * DEG;
  const dx = pos.x - r.thrXY.x, dy = pos.y - r.thrXY.y;
  return dx * Math.sin(fwd) + dy * Math.cos(fwd);
}

// Cross-track error in metres (positive = right of centerline from landing pilot's view).
function crossTrackM(pos: XY, r: ILSRunway): number {
  const rHdg = ((r.rwdHdg + 90) % 360) * DEG; // 90° right of approach
  const dx = pos.x - r.thrXY.x, dy = pos.y - r.thrXY.y;
  return dx * Math.sin(rHdg) + dy * Math.cos(rHdg);
}

// Signed localizer deviation (degrees). Positive → right of centerline → steer left.
export function locDevDeg(pos: XY, r: ILSRunway): number {
  const along = distAlongFwd(pos, r);
  const cross = crossTrackM(pos, r);
  if (along < -50) return 999; // behind threshold — no signal
  return Math.atan2(cross, Math.max(500, along)) / DEG;
}

// Glideslope altitude (ft) at a given along-track distance from the threshold.
export function gsAltFt(distAlongM: number, r: ILSRunway): number {
  if (distAlongM <= 0) return r.thrElevFt;
  return r.thrElevFt + distAlongM * Math.tan(r.gsDeg * DEG) * FT_PER_M;
}

// Along-track distance (m) from threshold that yields a given altitude (ft).
export function gsDistM(altFt: number, r: ILSRunway): number {
  const h = Math.max(0, altFt - r.thrElevFt);
  return h / (Math.tan(r.gsDeg * DEG) * FT_PER_M);
}

// Straight-line distance from aircraft to threshold (m).
export function distFromThrM(pos: XY, r: ILSRunway): number {
  return Math.hypot(pos.x - r.thrXY.x, pos.y - r.thrXY.y);
}

// Can the aircraft capture the localizer?
//   • Must be on the approach side (along > 200 m)
//   • Within the localizer cone (|dev| < 1.5°)
//   • Intercept angle ≤ 60° (relative to runway/LOC heading)
export function canCaptureLoc(pos: XY, hdg: number, r: ILSRunway): boolean {
  const along = distAlongFwd(pos, r);
  const dev = locDevDeg(pos, r);
  const intercept = Math.abs(angleDelta(hdg, r.rwdHdg));
  return along > 200 && Math.abs(dev) < 1.5 && intercept <= 60;
}

// Is the aircraft above the glideslope at its current position?
// (>200 ft above = missed approach condition on first intercept)
export function aboveGlideslope(pos: XY, altFt: number, r: ILSRunway): boolean {
  const along = distAlongFwd(pos, r);
  if (along < 500) return false;
  return altFt > gsAltFt(along, r) + 200;
}

// Target heading to track the localizer (proportional correction, clamped ±30°).
export function locTargetHdg(pos: XY, r: ILSRunway): number {
  const dev = locDevDeg(pos, r);
  const corr = Math.max(-30, Math.min(30, dev * 2.5));
  return ((r.rwdHdg - corr) + 360) % 360;
}

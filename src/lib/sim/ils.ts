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
//
//  Altitudes are ft AGL of the airport (thrElevFt is the threshold elevation
//  above the airport datum, normally 0; B22: kept so a per-runway elevation
//  can be applied once airspace files carry it).
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
  thrElevFt: number;   // threshold elevation ft (relative to airport datum)
  /** True when synthesised from OSM geometry rather than an airspace record (UI shows "ILS (est.)"). */
  estimated?: boolean;
}

/** ILS intercept rules (03 §3.7 / §8). */
export const ILS_CONST = {
  locRangeNM: 25,
  gsRangeNM: 12,
  /** Localizer capture half-cone, degrees. */
  captureDeg: 2.5,
  /** Max intercept angle (ICAO 30 deg; arcade 45). */
  interceptDeg: 30,
  interceptDegArcade: 45,
  /** Above-glideslope tolerance before the capture is rejected, ft. */
  aboveGsFt: 200,
} as const;

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
export function crossTrackM(pos: XY, r: ILSRunway): number {
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
// Threshold crossing height 50 ft is part of the 3° slope from the touchdown
// zone, so the slope reaches the runway ~300 m past the threshold.
export const TCH_FT = 50;
export function gsAltFt(distAlongM: number, r: ILSRunway): number {
  const tdz = TCH_FT / (Math.tan(r.gsDeg * DEG) * FT_PER_M); // ~290 m past threshold at 3°
  const d = distAlongM + tdz;
  if (d <= 0) return r.thrElevFt;
  return r.thrElevFt + d * Math.tan(r.gsDeg * DEG) * FT_PER_M;
}

// Along-track distance (m) from threshold that yields a given altitude (ft).
export function gsDistM(altFt: number, r: ILSRunway): number {
  const h = Math.max(0, altFt - r.thrElevFt);
  const tdz = TCH_FT / (Math.tan(r.gsDeg * DEG) * FT_PER_M);
  return h / (Math.tan(r.gsDeg * DEG) * FT_PER_M) - tdz;
}

// Straight-line distance from aircraft to threshold (m).
export function distFromThrM(pos: XY, r: ILSRunway): number {
  return Math.hypot(pos.x - r.thrXY.x, pos.y - r.thrXY.y);
}

// Can the aircraft capture the localizer?
//   • Must be on the approach side (along > 200 m) and inside LOC range
//   • Within the localizer cone (|dev| < 2.5°)
//   • Intercept angle ≤ 30° (45° arcade)
export function canCaptureLoc(pos: XY, hdg: number, r: ILSRunway, arcade = false): boolean {
  const along = distAlongFwd(pos, r);
  const dev = locDevDeg(pos, r);
  const intercept = Math.abs(angleDelta(hdg, r.locCourse));
  const maxInt = arcade ? ILS_CONST.interceptDegArcade : ILS_CONST.interceptDeg;
  return along > 200 && along < ILS_CONST.locRangeNM * 1852 && Math.abs(dev) < ILS_CONST.captureDeg && intercept <= maxInt;
}

/** True when the aircraft is pointed at the localizer but too steep (will fly through). */
export function overshootsLoc(pos: XY, hdg: number, r: ILSRunway, arcade = false): boolean {
  const along = distAlongFwd(pos, r);
  const dev = locDevDeg(pos, r);
  const intercept = Math.abs(angleDelta(hdg, r.locCourse));
  const maxInt = arcade ? ILS_CONST.interceptDegArcade : ILS_CONST.interceptDeg;
  return along > 200 && Math.abs(dev) < ILS_CONST.captureDeg && intercept > maxInt;
}

// Is the aircraft above the glideslope at its current position?
// (>200 ft above = missed approach condition on first intercept)
export function aboveGlideslope(pos: XY, altFt: number, r: ILSRunway): boolean {
  const along = distAlongFwd(pos, r);
  if (along < 500) return false;
  return altFt > gsAltFt(along, r) + ILS_CONST.aboveGsFt;
}

// Target heading to track the localizer (proportional correction, clamped ±30°).
export function locTargetHdg(pos: XY, r: ILSRunway): number {
  const dev = locDevDeg(pos, r);
  const corr = Math.max(-30, Math.min(30, dev * 2.5));
  return ((r.locCourse - corr) + 360) % 360;
}

/** Build an ILS record from runway end geometry (used when the airspace file has none). */
export function ilsFromGeometry(name: string, thrXY: XY, rwyHdgTrue: number, thrElevFt = 0): ILSRunway {
  return { name, thrXY, rwdHdg: rwyHdgTrue, locCourse: rwyHdgTrue, gsDeg: 3, thrElevFt, estimated: true };
}

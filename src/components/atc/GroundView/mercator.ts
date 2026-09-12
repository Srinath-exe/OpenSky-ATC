// ============================================================
//  Web-Mercator helpers for the overlay canvas.
//
//  MapLibre with pitch 0 / bearing 0 maps a unit-mercator point m to
//      screen = (m − centre) · worldSize + (W/2, H/2)      (CSS px)
//  with worldSize = 512 · 2^zoom. Static geometry is converted to unit mercator
//  once per airport; per frame only this affine transform runs (no map.project
//  calls, no allocations), which is what keeps 20 aircraft + 10 vehicles + a
//  few hundred hold bars at 60 fps.
// ============================================================
import type { LocalProjection, XY } from '@/lib/sim/projection';

const D2R = Math.PI / 180;
const EARTH_R = 6378137;
export const TILE = 512;

export interface Merc { x: number; y: number }

/** lng/lat → unit mercator (0..1). */
export function mercFromLngLat(lng: number, lat: number, out: Merc = { x: 0, y: 0 }): Merc {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  out.x = (180 + lng) / 360;
  out.y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))) / 360;
  return out;
}

/** Engine XY (local metres) → unit mercator. */
export function mercFromXY(proj: LocalProjection, x: number, y: number, out: Merc = { x: 0, y: 0 }): Merc {
  const ll = proj.toLngLat(x, y);
  return mercFromLngLat(ll.lng, ll.lat, out);
}

/** Camera snapshot for one frame. */
export interface FrameCam {
  cx: number;      // centre unit mercator
  cy: number;
  ws: number;      // world size px (512 · 2^zoom)
  w: number;       // container CSS px
  h: number;
  zoom: number;
  /** CSS px per metre at the map centre latitude. */
  pxPerM: number;
  centreLat: number;
}

export function frameCam(centerLng: number, centerLat: number, zoom: number, w: number, h: number, out: FrameCam): FrameCam {
  const m = mercFromLngLat(centerLng, centerLat);
  out.cx = m.x; out.cy = m.y;
  out.ws = TILE * Math.pow(2, zoom);
  out.w = w; out.h = h; out.zoom = zoom;
  out.centreLat = centerLat;
  out.pxPerM = out.ws / (2 * Math.PI * EARTH_R * Math.cos(centerLat * D2R));
  return out;
}

/** unit mercator → CSS px in the container. */
export function toScreen(cam: FrameCam, mx: number, my: number, out: XY): XY {
  out.x = (mx - cam.cx) * cam.ws + cam.w / 2;
  out.y = (my - cam.cy) * cam.ws + cam.h / 2;
  return out;
}

/** CSS px → unit mercator. */
export function toMerc(cam: FrameCam, sx: number, sy: number, out: Merc): Merc {
  out.x = (sx - cam.w / 2) / cam.ws + cam.cx;
  out.y = (sy - cam.h / 2) / cam.ws + cam.cy;
  return out;
}

export function mercToLngLat(mx: number, my: number): { lng: number; lat: number } {
  const lng = mx * 360 - 180;
  const y2 = 180 - my * 360;
  const lat = (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
  return { lng, lat };
}

/** Screen-space bearing (deg, 0 = up, clockwise) — north-up map so it equals true heading. */
export function bearingScreen(x0: number, y0: number, x1: number, y1: number): number {
  return (Math.atan2(x1 - x0, -(y1 - y0)) / D2R + 360) % 360;
}

/** Convert a list of lng/lat points into a flat Float64Array [x0,y0,x1,y1,…] of unit mercator. */
export function packLngLat(pts: Array<{ lng: number; lat: number }>): Float64Array {
  const out = new Float64Array(pts.length * 2);
  const m = { x: 0, y: 0 };
  for (let i = 0; i < pts.length; i++) { mercFromLngLat(pts[i].lng, pts[i].lat, m); out[i * 2] = m.x; out[i * 2 + 1] = m.y; }
  return out;
}

/** Convert engine XY points into packed unit mercator. */
export function packXY(proj: LocalProjection, pts: XY[]): Float64Array {
  const out = new Float64Array(pts.length * 2);
  const m = { x: 0, y: 0 };
  for (let i = 0; i < pts.length; i++) { mercFromXY(proj, pts[i].x, pts[i].y, m); out[i * 2] = m.x; out[i * 2 + 1] = m.y; }
  return out;
}

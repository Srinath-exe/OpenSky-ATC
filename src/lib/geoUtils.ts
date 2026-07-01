/**
 * Geo utilities for ground movement physics.
 * Uses haversine for lat/lng distance and movement.
 */

const R = 6_371_000; // Earth radius in meters

function toRad(deg: number): number { return (deg * Math.PI) / 180; }
function toDeg(rad: number): number { return (rad * 180) / Math.PI; }

export interface GeoPosition {
  lat: number;
  lng: number;
}

/** Great-circle distance in meters between two lat/lng points. */
export function haversine(a: GeoPosition, b: GeoPosition): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat2 = Math.sin(dLat / 2);
  const sinDLng2 = Math.sin(dLng / 2);
  const x = sinDLat2 * sinDLat2 + Math.cos(lat1) * Math.cos(lat2) * sinDLng2 * sinDLng2;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

/** Initial bearing (heading) from a to b in degrees [0,360). */
export function bearing(a: GeoPosition, b: GeoPosition): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const brng = Math.atan2(y, x);
  return (toDeg(brng) + 360) % 360;
}

/** Normalize angle to [-180, 180]. */
export function angleDiff(current: number, target: number): number {
  let diff = (target - current + 360) % 360;
  if (diff > 180) diff -= 360;
  return diff;
}

/** Move a point `distanceMeters` along `headingDeg` using great-circle. */
export function moveAlongBearing(pos: GeoPosition, headingDeg: number, distanceMeters: number): GeoPosition {
  const lat1 = toRad(pos.lat);
  const lng1 = toRad(pos.lng);
  const h = toRad(headingDeg);
  const d = distanceMeters / R;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinD = Math.sin(d);
  const cosD = Math.cos(d);
  const sinH = Math.sin(h);
  const cosH = Math.cos(h);

  const lat2 = Math.asin(sinLat1 * cosD + cosLat1 * sinD * cosH);
  const lng2 = lng1 + Math.atan2(sinH * sinD * cosLat1, cosD - sinLat1 * Math.sin(lat2));

  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

/** Clamp a value between min and max. */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Linear interpolation between a and b by factor t [0,1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

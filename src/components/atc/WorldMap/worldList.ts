/*
  Which airports have a baked 3D world, and where its files live - kept free of three.js so the game shell can decide
  (and start the downloads) before the map bundle has arrived.
*/
/** Airports with a baked world (public/world/<ICAO>/meta.json). */
export const WORLD_AIRPORTS = new Set(['KSFO', 'EGLL', 'KJFK', 'KLAX', 'KBOS', 'VIDP']);
export function hasWorld(icao: string | null | undefined): boolean { return !!icao && WORLD_AIRPORTS.has(icao.toUpperCase()); }

/** Bumped when the baked files change: the files are served immutable for a year under this query string. */
export const WORLD_ASSET_VERSION = '2';
export function worldUrl(icao: string, file: string): string { return `/world/${icao.toUpperCase()}/${file}?v=${WORLD_ASSET_VERSION}`; }
export const WORLD_FILES = ['meta.json', 'vectors.json', 'height.webp', 'land.webp'] as const;

const prefetched = new Set<string>();
/** Warm the HTTP cache for an airport's world files (the map's loader then reads them from the cache). Idempotent. */
export function prefetchWorld(icao: string | null | undefined): void {
  if (!hasWorld(icao) || typeof window === 'undefined') return;
  const key = icao!.toUpperCase(); if (prefetched.has(key)) return; prefetched.add(key);
  for (const f of WORLD_FILES) { try { fetch(worldUrl(key, f), { priority: 'low' } as RequestInit).catch(() => {}); } catch { /* fetch unavailable */ } }
}

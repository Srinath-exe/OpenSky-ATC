// ============================================================
//  Camera presets (UX 04 §4 "Camera presets" / §2.2 per-mode list).
//  Auto presets are derived from the airport geometry; user slots 1-6 are
//  stored per position under `skycontrol_ground_presets` (00 §2.6 key space).
// ============================================================
import type { SimEngine } from '@/lib/sim/engine';
import { advance, NM_TO_M } from '@/lib/sim/projection';
import type { GroundGeometry } from './geometry';
import { mercToLngLat } from './mercator';
import type { PlayerPosition } from './bridge';

export interface CameraPreset {
  id: string;
  label: string;
  /** Either a centre+zoom or bounds to fit. */
  center?: [number, number];
  zoom?: number;
  bounds?: [[number, number], [number, number]];
}

export interface UserPreset { center: [number, number]; zoom: number; savedAt: number }

const LS_PRESETS = 'skycontrol_ground_presets';
export const USER_SLOTS = 6;

/** Auto-generated presets for a position (UX §2.2 "Camera presets" row). */
export function autoPresets(engine: SimEngine, geom: GroundGeometry, position: PlayerPosition): CameraPreset[] {
  const out: CameraPreset[] = [{ id: 'overview', label: 'Overview', bounds: geom.bounds }];
  if (position === 'tower') {
    for (const rs of engine.runwayStates()) {
      const e = geom.endByName.get(rs.name); if (!e) continue;
      if (rs.activeArr) {
        const mid = advance(e.thrXY, (e.hdg + 180) % 360, 4.5 * NM_TO_M);
        const ll = engine.proj.toLngLat(mid.x, mid.y);
        out.push({ id: `final-${rs.name}`, label: `Final ${rs.name} (10 NM)`, center: [ll.lng, ll.lat], zoom: 11.6 });
      }
      if (rs.activeDep) {
        const ll = mercToLngLat(e.thr.x, e.thr.y);
        out.push({ id: `dep-${rs.name}`, label: `Departure ${rs.name}`, center: [ll.lng, ll.lat], zoom: 14.6 });
      }
    }
  } else {
    for (const a of geom.aprons) out.push({ id: `apron-${slug(a.name)}`, label: a.name, center: [a.lng, a.lat], zoom: 16 });
    for (const rw of geom.runways) for (const e of rw.ends) {
      const ll = mercToLngLat(e.thr.x, e.thr.y);
      out.push({ id: `rwy-${e.name}`, label: `RWY ${e.name}`, center: [ll.lng, ll.lat], zoom: 15.4 });
    }
  }
  return out;
}

function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'apron'; }

type Store = Record<string, Array<UserPreset | null>>;

function readStore(): Store {
  if (typeof window === 'undefined') return {};
  try { const raw = localStorage.getItem(LS_PRESETS); return raw ? (JSON.parse(raw) as Store) : {}; } catch { return {}; }
}
function writeStore(s: Store): void {
  try { localStorage.setItem(LS_PRESETS, JSON.stringify(s)); } catch { /* ignore */ }
}
function key(icao: string, position: PlayerPosition): string { return `${icao}:${position}`; }

export function loadUserPresets(icao: string, position: PlayerPosition): Array<UserPreset | null> {
  const arr = readStore()[key(icao, position)] ?? [];
  const out: Array<UserPreset | null> = [];
  for (let i = 0; i < USER_SLOTS; i++) out.push(arr[i] ?? null);
  return out;
}

export function saveUserPreset(icao: string, position: PlayerPosition, slot: number, cam: { center: [number, number]; zoom: number }): Array<UserPreset | null> {
  const s = readStore();
  const arr = loadUserPresets(icao, position);
  arr[slot] = { center: cam.center, zoom: cam.zoom, savedAt: Date.now() };
  s[key(icao, position)] = arr;
  writeStore(s);
  return arr;
}

export function clearUserPreset(icao: string, position: PlayerPosition, slot: number): Array<UserPreset | null> {
  const s = readStore();
  const arr = loadUserPresets(icao, position);
  arr[slot] = null;
  s[key(icao, position)] = arr;
  writeStore(s);
  return arr;
}

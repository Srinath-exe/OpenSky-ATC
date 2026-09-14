/*
  Graphics quality for the 3D world map — so the same scene runs on a phone, an office laptop and a gaming desktop.

  Three tiers (high / medium / low) fix what is expensive per pixel and per aircraft: render resolution, the depth-of-field
  pass, anti-aliasing, terrain mesh density, the distance up to which detailed aircraft models are drawn, rain density and a
  frame-rate cap. `detectTier()` picks a tier from the GPU (renderer string), memory, cores and the pointer type;
  the player can pin a tier in Settings ("skycontrol_graphics"). On top of the tier, `AdaptiveResolution` scales the render
  resolution frame by frame from the measured frame time, so a device that cannot hold the target rate at the tier's
  resolution renders fewer pixels instead of dropping frames (and climbs back when it has headroom).
*/
import { useSyncExternalStore } from 'react';

export type Tier = 'high' | 'medium' | 'low';
export type GraphicsPref = 'auto' | Tier;

export interface QualityPreset {
  tier: Tier;
  /** Render pixel ratio cap (× CSS pixels) and the floor the adaptive scaler may go down to. */
  dprMax: number;
  dprMin: number;
  /** Terrain mesh subdivisions per side. */
  terrainSegments: number;
  /** Depth-of-field (tilt-shift) post pass. */
  bokeh: boolean;
  /** FXAA post pass (MSAA is not available through the post-processing chain). */
  fxaa: boolean;
  /** Camera distance (m) below which the detailed GLB models replace the silhouettes. */
  modelDist: number;
  /** Rain particle count. */
  rain: number;
  /** Frame-rate cap (0 = the display's rate). */
  fpsCap: number;
  /** Anisotropic filtering for the land texture. */
  anisotropy: number;
  /** Budget for the world's buildings (the airport's own are always kept) and whether their sun shadows are drawn. */
  buildings: number;
  buildingShadows: boolean;
  /** Road relief step (m) and whether secondary streets are drawn. */
  roadStep: number;
  minorRoads: boolean;
}

export const PRESETS: Record<Tier, QualityPreset> = {
  high: { tier: 'high', dprMax: 1.5, dprMin: 0.75, terrainSegments: 512, bokeh: true, fxaa: true, modelDist: 6500, rain: 1800, fpsCap: 0, anisotropy: 8, buildings: Infinity, buildingShadows: true, roadStep: 60, minorRoads: true },
  medium: { tier: 'medium', dprMax: 1.0, dprMin: 0.6, terrainSegments: 384, bokeh: true, fxaa: true, modelDist: 4500, rain: 1000, fpsCap: 0, anisotropy: 4, buildings: 2500, buildingShadows: true, roadStep: 90, minorRoads: true },
  low: { tier: 'low', dprMax: 1.0, dprMin: 0.5, terrainSegments: 256, bokeh: false, fxaa: false, modelDist: 2500, rain: 500, fpsCap: 30, anisotropy: 2, buildings: 1200, buildingShadows: false, roadStep: 120, minorRoads: false },
};

export interface DeviceInfo { gpu: string; cores: number; memoryGB: number | null; coarse: boolean; saveData: boolean; software: boolean }

/** What the device looks like (the GPU string needs a live WebGL context; pass the renderer's). */
export function describeDevice(gl?: WebGLRenderingContext | WebGL2RenderingContext | null): DeviceInfo {
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } });
  let gpu = '';
  try {
    if (gl) { const ext = gl.getExtension('WEBGL_debug_renderer_info'); gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)); }
  } catch { gpu = ''; }
  const software = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|mesa offscreen|virtualbox|vmware/i.test(gpu);
  return {
    gpu, cores: nav?.hardwareConcurrency ?? 4, memoryGB: nav?.deviceMemory ?? null,
    coarse: typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)').matches : false,
    saveData: !!nav?.connection?.saveData, software,
  };
}

/** Tier from the device description (conservative: unknown mobile GPUs land on medium, integrated desktop GPUs on medium, weak or software GPUs on low). */
export function tierFor(d: DeviceInfo): Tier {
  const g = d.gpu.toLowerCase();
  if (d.software || d.saveData) return 'low';
  if ((d.memoryGB != null && d.memoryGB <= 2) || d.cores <= 2) return 'low';
  // known weak mobile / old integrated parts
  if (/mali-4|mali-t|mali-g5[0-2]\b|adreno \(tm\) [345]\d\d|adreno [345]\d\d|powervr|videocore|intel\(r\) hd graphics( [2-5]\d\d\d| 4\d\d| 5\d\d| 6\d\d)?$|gma |geforce (8|9|gt 2|gt 4|210|610|710)/.test(g)) return 'low';
  // discrete desktop GPUs and Apple silicon Macs: high
  if (/nvidia|geforce|rtx|quadro|radeon (rx|pro|vii)|radeon r[79]|apple m\d|apple gpu.*mac|arc\(tm\) a/.test(g) && !d.coarse) return 'high';
  // phones / tablets, integrated laptop GPUs (Iris, UHD, Vega, Adreno 6xx+, Mali-G7x+), unknown: medium
  if (d.coarse) return 'medium';
  if (/iris|uhd|intel|vega|radeon graphics|amd radeon\(tm\)|mali|adreno|apple/.test(g)) return 'medium';
  return d.cores >= 8 ? 'high' : 'medium';
}

export function detectTier(gl?: WebGLRenderingContext | WebGL2RenderingContext | null): { tier: Tier; device: DeviceInfo } {
  const device = describeDevice(gl);
  return { tier: tierFor(device), device };
}

/** The preset for a preference: a pinned tier, or the detected one. Test / lite mode pins low (software GL). */
export function presetFor(pref: GraphicsPref, detected: Tier): QualityPreset {
  const tier = pref === 'auto' ? detected : pref;
  return PRESETS[tier];
}

// ── persisted preference (its own key: the Settings blob and its defaults stay untouched) ─────────────────────────────
const KEY = 'skycontrol_graphics';
const listeners = new Set<() => void>();
let cached: GraphicsPref | null = null;
function read(): GraphicsPref {
  if (cached) return cached;
  let v: string | null = null;
  try { v = typeof window === 'undefined' ? null : localStorage.getItem(KEY); } catch { v = null; }
  if (typeof window !== 'undefined') { const q = new URLSearchParams(window.location.search).get('quality'); if (q === 'high' || q === 'medium' || q === 'low' || q === 'auto') v = q; }
  cached = v === 'high' || v === 'medium' || v === 'low' ? v : 'auto';
  return cached;
}
export function getGraphicsPref(): GraphicsPref { return read(); }
export function setGraphicsPref(p: GraphicsPref): void {
  cached = p;
  try { localStorage.setItem(KEY, p); } catch { /* private mode */ }
  for (const l of listeners) l();
}
export function subscribeGraphics(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function useGraphicsPref(): GraphicsPref { return useSyncExternalStore(subscribeGraphics, read, () => 'auto' as GraphicsPref); }

// ── detected tier shared with the settings UI (set by the map once it has a GL context) ──────────────────────────────
let detectedInfo: { tier: Tier; device: DeviceInfo } | null = null;
export function publishDetected(info: { tier: Tier; device: DeviceInfo }): void { detectedInfo = info; for (const l of listeners) l(); }
export function getDetected(): { tier: Tier; device: DeviceInfo } | null { return detectedInfo; }
export function useDetected(): { tier: Tier; device: DeviceInfo } | null { return useSyncExternalStore(subscribeGraphics, () => detectedInfo, () => null); }

/**
 * Frame-time driven render scale. Feed it the wall-clock time of every rendered frame; `dpr` moves down in steps while the
 * average frame is slower than the target and back up when there is clear headroom. Changes are rate-limited so it settles
 * instead of oscillating, and long gaps (tab switches, loads) are ignored.
 */
export class AdaptiveResolution {
  dpr: number;
  private samples: number[] = [];
  private cooldown = 0;
  private last = 0;
  /** Frame interval that is too slow (scale down) / fast enough to scale back up (below the display's vsync interval
   *  so a locked 60 Hz counts as headroom). */
  constructor(public max: number, public min: number, public targetMs = 22, public upMs = 17.5, public stepPx = 0.1) { this.dpr = max; }
  setRange(max: number, min: number): void { this.max = max; this.min = min; this.dpr = Math.min(max, Math.max(min, this.dpr)); this.samples.length = 0; }
  /** Returns true when the render scale changed. */
  sample(now: number): boolean {
    const dt = this.last ? now - this.last : 0; this.last = now;
    if (dt <= 0 || dt > 250) return false;
    this.samples.push(dt); if (this.samples.length > 40) this.samples.shift();
    if (this.cooldown > 0) { this.cooldown--; return false; }
    if (this.samples.length < 30) return false;
    const avg = this.samples.reduce((s, x) => s + x, 0) / this.samples.length;
    let next = this.dpr;
    if (avg > this.targetMs && this.dpr > this.min) next = Math.max(this.min, +(this.dpr - this.stepPx).toFixed(2));
    else if (avg < this.upMs && this.dpr < this.max) next = Math.min(this.max, +(this.dpr + this.stepPx).toFixed(2));
    if (next === this.dpr) return false;
    const down = next < this.dpr; this.dpr = next; this.cooldown = down ? 45 : 90; this.samples.length = 0;
    return true;
  }
}

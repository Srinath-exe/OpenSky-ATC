/*
  World data for the procedural 3D map (baked by scripts/bake_world.py into public/world/<ICAO>/).
  Everything is expressed in the sim's local frame: metres east (x) / north (y) of the airport reference point.
*/
import * as THREE from 'three';
import { LocalProjection } from '@/lib/sim/projection';
import { hasWorld, WORLD_AIRPORTS, worldUrl } from './worldList';
export { hasWorld, WORLD_AIRPORTS };

export interface WorldMeta {
  icao: string;
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  grid: number;
  hMin: number;
  hMax: number;
  center: { lng: number; lat: number };
}
export interface WorldVectors {
  roads: Record<'motorway' | 'trunk' | 'primary' | 'secondary' | 'rail', [number, number][][]>;
  buildings: { p: [number, number][]; h: number | null; k: 'terminal' | 'hangar' | 'b' }[];
}
export interface World {
  meta: WorldMeta;
  /** Row 0 = north. Metres. */
  heights: Float32Array;
  heightTex: THREE.DataTexture;
  landTex: THREE.Texture;
  vectors: WorldVectors;
  proj: LocalProjection;
  /** World extent in local metres (x east, y north). */
  extent: { minX: number; maxX: number; minY: number; maxY: number };
  heightAt(x: number, y: number): number;
  toLocal(lng: number, lat: number): { x: number; y: number };
  /** Level the terrain under the airfield (SRTM noise would poke through the apron surfaces). */
  flatten(points: { x: number; y: number }[], padM: number): number;
  /** 1 inside the levelled airfield (set by flatten), grid-aligned like the height texture. */
  fieldTex: THREE.DataTexture;
}

async function loadImageData(url: string, fallback?: string): Promise<ImageData> {
  const img = new Image();
  img.decoding = 'async';
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => { if (fallback && img.src.indexOf(fallback) < 0) { img.src = fallback; } else rej(new Error(`image ${url}`)); };
    img.src = url;
  });
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export async function loadWorld(icao: string, refLat: number, refLng: number): Promise<World> {
  const u = (f: string) => worldUrl(icao, f);
  // everything in flight at once (the land texture is the largest file); WebP with the original PNGs as the fallback
  const landP = new THREE.TextureLoader().loadAsync(u('land.webp')).catch(() => new THREE.TextureLoader().loadAsync(u('land.png')));
  const [meta, vectors, hImg] = await Promise.all([
    fetch(u('meta.json')).then(r => r.json() as Promise<WorldMeta>),
    fetch(u('vectors.json')).then(r => r.json() as Promise<WorldVectors>),
    loadImageData(u('height.webp'), u('height.png')),
  ]);
  const n = meta.grid;
  const heights = new Float32Array(n * n);
  const k = (meta.hMax - meta.hMin) / 65535;
  for (let i = 0; i < n * n; i++) heights[i] = meta.hMin + (hImg.data[i * 4] * 256 + hImg.data[i * 4 + 1]) * k;
  // float texture: row 0 = north, so flip so that v=0 is south (three's UV convention)
  const tex = new Float32Array(n * n);
  for (let r = 0; r < n; r++) tex.set(heights.subarray(r * n, (r + 1) * n), (n - 1 - r) * n);
  const fieldData = new Uint8Array(n * n);
  const fieldTex = new THREE.DataTexture(fieldData, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  fieldTex.magFilter = THREE.LinearFilter; fieldTex.minFilter = THREE.LinearFilter; fieldTex.needsUpdate = true;
  const heightTex = new THREE.DataTexture(tex, n, n, THREE.RedFormat, THREE.FloatType);
  heightTex.magFilter = THREE.LinearFilter; heightTex.minFilter = THREE.LinearFilter;
  heightTex.wrapS = heightTex.wrapT = THREE.ClampToEdgeWrapping; heightTex.needsUpdate = true;
  const landTex = await landP;
  landTex.colorSpace = THREE.NoColorSpace; landTex.wrapS = landTex.wrapT = THREE.ClampToEdgeWrapping;
  landTex.minFilter = THREE.LinearMipmapLinearFilter; landTex.magFilter = THREE.LinearFilter; landTex.anisotropy = 8;

  const proj = new LocalProjection(refLat, refLng);
  const sw = proj.toXY(meta.bbox.minLat, meta.bbox.minLng), ne = proj.toXY(meta.bbox.maxLat, meta.bbox.maxLng);
  const extent = { minX: sw.x, maxX: ne.x, minY: sw.y, maxY: ne.y };
  const heightAt = (x: number, y: number): number => {
    const u = (x - extent.minX) / (extent.maxX - extent.minX), v = (extent.maxY - y) / (extent.maxY - extent.minY);
    const fx = Math.min(n - 1.001, Math.max(0, u * (n - 1))), fy = Math.min(n - 1.001, Math.max(0, v * (n - 1)));
    const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
    const h00 = heights[y0 * n + x0], h10 = heights[y0 * n + x0 + 1], h01 = heights[(y0 + 1) * n + x0], h11 = heights[(y0 + 1) * n + x0 + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  };
  const flatten = (points: { x: number; y: number }[], padM: number): number => {
    if (!points.length) return 0;
    // convex hull (monotone chain) of the airfield nodes, padded; inside -> median height of the hull's samples
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: typeof pts = []; for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    const upper: typeof pts = []; for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length, cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
    const padded = hull.map(p => { const d = Math.hypot(p.x - cx, p.y - cy) || 1; return { x: p.x + (p.x - cx) / d * padM, y: p.y + (p.y - cy) / d * padM }; });
    const inside = (x: number, y: number) => { let c = false; for (let i = 0, j = padded.length - 1; i < padded.length; j = i++) { const a = padded[i], b = padded[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
    const sx = (extent.maxX - extent.minX) / (n - 1), sy = (extent.maxY - extent.minY) / (n - 1);
    const samples: number[] = []; const idx: number[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) { const x = extent.minX + c * sx, y = extent.maxY - r * sy; if (inside(x, y)) { idx.push(r * n + c); samples.push(heights[r * n + c]); } }
    if (!samples.length) return 0;
    samples.sort((a, b) => a - b); const med = samples[samples.length >> 1];
    for (const i of idx) { heights[i] = med; const r = (i / n) | 0, c = i % n; fieldData[(n - 1 - r) * n + c] = 255; }
    for (let r = 0; r < n; r++) tex.set(heights.subarray(r * n, (r + 1) * n), (n - 1 - r) * n);
    heightTex.needsUpdate = true; fieldTex.needsUpdate = true;
    return med;
  };
  return { meta, heights, heightTex, landTex, vectors, proj, extent, heightAt, toLocal: (lng, lat) => proj.toXY(lat, lng), flatten, fieldTex };
}

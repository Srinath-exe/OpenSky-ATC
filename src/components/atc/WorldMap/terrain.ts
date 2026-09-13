/*
  Scene builders for the procedural world: terrain (height + land shading in a shader), water, roads, buildings,
  airport surfaces with generated markings. three.js frame: x = east, y = up, z = -north (metres).
*/
import * as THREE from 'three';
import type { World } from './world';
import type { OsmAirport } from '@/lib/osmAirport';

export const toV3 = (x: number, y: number, h: number) => new THREE.Vector3(x, h, -y);

/** Materials whose opacity fades with camera distance (detail lines vanish when zoomed out, like a game map LOD). */
export interface Fade { mat: THREE.Material & { opacity: number }; base: number; near: number; far: number }
export function applyFades(fades: Fade[], dist: number): void {
  for (const f of fades) { const t = 1 - Math.min(1, Math.max(0, (dist - f.near) / (f.far - f.near))); f.mat.opacity = f.base * t; f.mat.visible = t > 0.01; }
}

// ── palette (design 01 §1 / the TheTrail reference: muted greens, neutral greys, near-black water, orange accent) ──
export const PALETTE = {
  bg: 0x0b0b0c,
  water: new THREE.Color('#10161b'),
  waterDeep: new THREE.Color('#0b0f13'),
  vegDark: new THREE.Color('#2a4224'),
  veg: new THREE.Color('#41703a'),
  vegLight: new THREE.Color('#6e8b52'),
  field: new THREE.Color('#4a5740'),
  urban: new THREE.Color('#4b4d4b'),
  urbanLight: new THREE.Color('#7f817e'),
  bare: new THREE.Color('#6b6558'),
  rock: new THREE.Color('#4f4d49'),
  road: new THREE.Color('#d9d9d6'),
  roadMinor: new THREE.Color('#8f9190'),
  rail: new THREE.Color('#6a6c6b'),
  asphalt: new THREE.Color('#2e3032'),
  concrete: new THREE.Color('#6d6f6c'),
  marking: new THREE.Color('#e8e8e4'),
  taxiLine: new THREE.Color('#e0b23a'),
  building: new THREE.Color('#77797a'),
  terminal: new THREE.Color('#9a9c9a'),
  orange: new THREE.Color('#f5933f'),
};

const TERRAIN_VERT = /* glsl */ `
  uniform sampler2D uHeight;
  uniform vec4 uExtent;   // minX, minY(north), sizeX, sizeY
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    float h = texture2D(uHeight, uv).r;
    vec3 p = vec3(position.x, h, position.z);
    vWorld = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const TERRAIN_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uHeight;
  uniform sampler2D uLand;
  uniform vec2 uTexel;       // 1/grid
  uniform vec2 uMetersPerTexel;
  uniform vec3 uLight;       // normalized, world space (toward the sun / moon)
  uniform vec3 uSunColor;
  uniform float uSunI, uHemiI, uDay, uWet;
  uniform vec3 uCam;
  uniform float uFogNear, uFogFar;
  uniform vec3 uFog;
  uniform vec4 uEdge;        // world extent in three space: minX, minZ, maxX, maxZ
  uniform vec3 cWater, cWaterDeep, cVegDark, cVeg, cVegLight, cUrban, cUrbanLight, cBare, cRock;
  uniform float uTime;
  uniform sampler2D uFieldMask;   // 1 inside the levelled airfield: grass between the surfaces, whatever the imagery says
  uniform vec3 cField;
  varying vec2 vUv;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }

  void main() {
    // normal from the height field (central differences at texture resolution)
    float hl = texture2D(uHeight, vUv - vec2(uTexel.x, 0.0)).r;
    float hr = texture2D(uHeight, vUv + vec2(uTexel.x, 0.0)).r;
    float hd = texture2D(uHeight, vUv - vec2(0.0, uTexel.y)).r;
    float hu = texture2D(uHeight, vUv + vec2(0.0, uTexel.y)).r;
    // height field h(east, north); three's z = -north, so a slope rising to the north tilts the normal to +z
    vec3 n = normalize(vec3((hl - hr) / (2.0 * uMetersPerTexel.x), 1.0, (hu - hd) / (2.0 * uMetersPerTexel.y)));
    float slope = 1.0 - n.y;

    float night = 1.0 - uDay;
    vec4 land = texture2D(uLand, vUv);
    float veg = land.r, bright = land.g, water = land.b, grain = land.a;
    float h = vWorld.y;
    float field = texture2D(uFieldMask, vUv).r;

    // land colour: vegetation ramps, urban greys keyed by brightness, bare/rock on steep or high ground
    vec3 vegCol = mix(cVegDark, cVeg, smoothstep(0.15, 0.6, veg));
    vegCol = mix(vegCol, cVegLight, smoothstep(0.55, 0.95, veg) * 0.6);
    vec3 urbanCol = mix(cUrban, cUrbanLight, smoothstep(0.2, 0.75, bright) * 0.25);
    vec3 col = mix(urbanCol, vegCol, smoothstep(0.08, 0.45, veg));
    col = mix(col, cField * (0.9 + 0.2 * veg), field * 0.85);
    col = mix(col, cBare, smoothstep(0.35, 0.7, slope * 2.2) * (1.0 - veg) * 0.7);
    col = mix(col, cRock, smoothstep(320.0, 560.0, h) * 0.35);
    // fine texture so flats do not read as plastic
    float detail = noise(vWorld.xz * 0.06) * 0.5 + noise(vWorld.xz * 0.31) * 0.5;
    col *= 0.95 + 0.07 * detail;

    // lighting: sun + hemisphere, slopes toward the light lit, away in cool shadow
    float ndl = clamp(dot(n, uLight), 0.0, 1.0);
    float hemi = 0.55 + 0.45 * n.y;
    vec3 lit = vec3(0.4 * hemi * uHemiI) + uSunColor * (ndl * uSunI);
    col *= lit;
    // shadow-side tint (cooler)
    col = mix(col, col * vec3(0.85, 0.9, 1.05), (1.0 - ndl) * 0.35 * uDay);
    // rain: darker, slightly glossy ground
    col *= 1.0 - 0.22 * uWet;
    // night: the city switches on — sparse warm lights on built-up texels plus a faint sodium haze
    float urban = (1.0 - smoothstep(0.08, 0.4, veg)) * (1.0 - water) * (1.0 - field) * smoothstep(0.12, 0.35, bright);
    vec2 cell = floor(vWorld.xz / 28.0);
    float lamp = step(0.955, hash(cell)) * (0.6 + 0.4 * hash(cell + 3.1));
    vec2 cellUv = fract(vWorld.xz / 28.0) - 0.5; float dot2 = 1.0 - smoothstep(0.0, 0.32, length(cellUv));
    col += vec3(1.0, 0.72, 0.42) * lamp * dot2 * urban * night * 1.4;
    col += vec3(0.32, 0.22, 0.12) * urban * night * 0.16;

    // water: dark, slightly deeper further from shore, faint moving sheen
    vec3 viewDir = normalize(uCam - vWorld);
    vec3 hv = normalize(viewDir + uLight);
    float spec = pow(clamp(dot(vec3(0.0, 1.0, 0.0), hv), 0.0, 1.0), 180.0);
    float ripple = noise(vWorld.xz * 0.004 + vec2(uTime * 0.02, 0.0)) * 0.5 + noise(vWorld.xz * 0.015 - vec2(0.0, uTime * 0.03)) * 0.5;
    vec3 waterCol = (mix(cWater, cWaterDeep, 0.5 + 0.5 * ripple) + ripple * 0.006) * (0.35 + 0.65 * uDay) + uSunColor * spec * (0.25 + 0.2 * night);
    // soft shoreline: the mask is bilinear so the edge blends over ~1 texel
    float shore = smoothstep(0.2, 0.5, water) * (1.0 - smoothstep(0.5, 0.8, water));
    col = mix(col, waterCol, smoothstep(0.35, 0.65, water));
    col += shore * vec3(0.05, 0.06, 0.06);   // faint pale rim where land meets water

    // distance fog to the page background + a soft fade at the world's edge (no hard rectangle)
    float d = distance(uCam, vWorld);
    float fog = smoothstep(uFogNear, uFogFar, d);
    vec2 e = min(vWorld.xz - uEdge.xy, uEdge.zw - vWorld.xz);
    float edge = 1.0 - smoothstep(600.0, 3200.0, min(e.x, e.y));
    col = mix(col, uFog, max(fog, edge));
    gl_FragColor = vec4(col, 1.0);
  }`;

export interface TerrainHandle { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> }

export function buildTerrain(world: World, segments = 512): TerrainHandle {
  const { extent } = world;
  const w = extent.maxX - extent.minX, hgt = extent.maxY - extent.minY;
  const geo = new THREE.PlaneGeometry(w, hgt, segments, segments);
  geo.rotateX(-Math.PI / 2);                                  // XZ plane, +y up; uv (0,0) is the SW corner after the rotation
  geo.translate((extent.minX + extent.maxX) / 2, 0, -(extent.minY + extent.maxY) / 2);
  const uniforms: Record<string, THREE.IUniform> = {
    uHeight: { value: world.heightTex }, uLand: { value: world.landTex },
    uExtent: { value: new THREE.Vector4(extent.minX, extent.minY, w, hgt) },
    uTexel: { value: new THREE.Vector2(1 / world.meta.grid, 1 / world.meta.grid) },
    uMetersPerTexel: { value: new THREE.Vector2(w / world.meta.grid, hgt / world.meta.grid) },
    uLight: { value: new THREE.Vector3(-0.55, 0.62, 0.55).normalize() },
    uSunColor: { value: new THREE.Color('#fff3e0') }, uSunI: { value: 1.0 }, uHemiI: { value: 1.0 }, uDay: { value: 1 }, uWet: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uFogNear: { value: 9000 }, uFogFar: { value: 32000 }, uFog: { value: new THREE.Color(PALETTE.bg) },
    uEdge: { value: new THREE.Vector4(extent.minX, -extent.maxY, extent.maxX, -extent.minY) },
    uTime: { value: 0 },
    uFieldMask: { value: world.fieldTex }, cField: { value: PALETTE.field },
    cWater: { value: PALETTE.water }, cWaterDeep: { value: PALETTE.waterDeep }, cVegDark: { value: PALETTE.vegDark }, cVeg: { value: PALETTE.veg },
    cVegLight: { value: PALETTE.vegLight }, cUrban: { value: PALETTE.urban }, cUrbanLight: { value: PALETTE.urbanLight }, cBare: { value: PALETTE.bare }, cRock: { value: PALETTE.rock },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'terrain';
  return { mesh, uniforms };
}

// ── polylines draped on the terrain ──────────────────────────────────────────
function drapedSegments(world: World, lines: [number, number][][], lift: number, step = 60): Float32Array {
  const out: number[] = [];
  const ex = world.extent, margin = 2200;
  const inner = (x: number, y: number) => x > ex.minX + margin && x < ex.maxX - margin && y > ex.minY + margin && y < ex.maxY - margin;
  for (const line of lines) {
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i < line.length; i++) {
      const p = world.toLocal(line[i][0], line[i][1]);
      if (!inner(p.x, p.y)) { prev = null; continue; }
      const cur = toV3(p.x, p.y, world.heightAt(p.x, p.y) + lift);
      if (prev) {
        // subdivide long segments so the line follows the relief
        const len = prev.distanceTo(cur), n = Math.max(1, Math.min(40, Math.ceil(len / step)));
        let a = prev;
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const x = prev.x + (cur.x - prev.x) * t, z = prev.z + (cur.z - prev.z) * t;
          const b = k === n ? cur : new THREE.Vector3(x, world.heightAt(x, -z) + lift, z);
          out.push(a.x, a.y, a.z, b.x, b.y, b.z); a = b;
        }
      }
      prev = cur;
    }
  }
  return new Float32Array(out);
}

export function buildRoads(world: World, fades: Fade[]): THREE.Group {
  const g = new THREE.Group(); g.name = 'roads';
  const r = world.vectors.roads;
  const add = (lines: [number, number][][], color: THREE.Color, opacity: number, lift: number, near: number, far: number) => {
    if (!lines.length) return;
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(drapedSegments(world, lines, lift), 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const m = new THREE.LineSegments(geo, mat); m.frustumCulled = false; g.add(m);
    fades.push({ mat, base: opacity, near, far });
  };
  add(r.secondary, PALETTE.roadMinor, 0.3, 1.2, 2500, 7000);
  add(r.primary, PALETTE.roadMinor, 0.5, 1.4, 5000, 14000);
  add(r.rail, PALETTE.rail, 0.5, 1.4, 6000, 20000);
  add([...r.trunk, ...r.motorway], PALETTE.road, 0.6, 1.8, 12000, 45000);
  return g;
}

// ── buildings (extruded footprints) ──────────────────────────────────────────
export function buildBuildings(world: World): THREE.Mesh {
  const geos: THREE.BufferGeometry[] = [];
  const colors: number[] = [];
  for (const b of world.vectors.buildings) {
    const pts = b.p.map(([lng, lat]) => world.toLocal(lng, lat));
    if (pts.length < 4) continue;
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));   // (east, north); rotateX(-90°) maps north to -z
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const base = world.heightAt(cx, cy);
    const h = b.h ?? (b.k === 'terminal' ? 16 : b.k === 'hangar' ? 14 : 7);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);                 // extrude along +y
    geo.translate(0, base, 0);
    const c = b.k === 'terminal' ? PALETTE.terminal : PALETTE.building;
    // roofs a shade lighter than the walls so the blocks read as volumes from the tilted camera
    const n = geo.getAttribute('position').count; const nor = geo.getAttribute('normal');
    for (let i = 0; i < n; i++) { const k = nor.getY(i) > 0.5 ? 1.1 : 0.86; colors.push(c.r * k, c.g * k, c.b * k); }
    geos.push(geo);
  }
  const merged = mergeGeometries(geos);
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // night: rows of lit windows on the walls (world-space cells, a stable hash decides which are lit), a faint roof glow
  const uNight = { value: 0 }; mat.userData.uNight = uNight;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\nuniform float uNight;\nfloat bhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float wall = 1.0 - smoothstep(0.35, 0.65, abs(vWNormal.y));
          vec2 tng = normalize(vec2(-vWNormal.z, vWNormal.x) + vec2(1e-4, 0.0));
          float along = dot(vWPos.xz, tng);
          vec2 cell = vec2(floor(along / 3.4), floor(vWPos.y / 3.6));
          vec2 f = vec2(fract(along / 3.4), fract(vWPos.y / 3.6));
          float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.28, f.y) * step(f.y, 0.78);
          float seed = bhash(cell + floor(vWNormal.xz * 7.0));
          float lit = step(0.62, seed) * (0.55 + 0.45 * bhash(cell * 1.7 + 0.3));   // ~40 % of the windows, varied brightness
          vec3 tone = mix(vec3(1.0, 0.84, 0.6), vec3(0.85, 0.92, 1.0), step(0.9, seed));
          totalEmissiveRadiance += tone * win * lit * wall * uNight * 0.85;
        }`);
  };
  mat.customProgramCacheKey = () => 'buildings-night';
  const mesh = new THREE.Mesh(merged, mat); mesh.name = 'buildings';
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(merged, 25), new THREE.LineBasicMaterial({ color: 0x0b0b0c, transparent: true, opacity: 0.35 }));
  mesh.add(edges);
  return mesh;
}

export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  geos = geos.map(g => (g.index ? g.toNonIndexed() : g));   // indexed inputs (ribbons) must be expanded before concatenation
  let count = 0; for (const g of geos) count += g.getAttribute('position').count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0; let hasUv = true;
  for (const g of geos) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position').array as Float32Array; const n = g.getAttribute('normal').array as Float32Array;
    const u = g.getAttribute('uv'); if (u) uv.set(u.array as Float32Array, (o / 3) * 2); else hasUv = false;
    pos.set(p, o); nor.set(n, o); o += p.length; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (hasUv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

// ── procedural surface grain (canvas noise, tiled) ────────────────────────────
function grainTexture(base: number, amp: number, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!; const img = ctx.createImageData(size, size);
  let seed = 1234;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < size * size; i++) { const v = Math.max(0, Math.min(255, base + (rnd() - 0.5) * amp + (rnd() - 0.5) * amp * 0.5)); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 24, 1 / 24); t.anisotropy = 8; t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Runway designator as a canvas texture ("28L"), white on transparent, for the threshold number plates. */
export function designatorTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, 256, 128);
  ctx.fillStyle = '#e8e8e4'; ctx.font = '700 104px "DM Sans", "Helvetica Neue", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/** Surfaces lifted by the apron floodlights at night (apron, taxiways, runways). */
const SURFACE_MATS: THREE.MeshLambertMaterial[] = [];   // aprons: floodlit
const PAVEMENT_MATS: THREE.MeshLambertMaterial[] = [];  // taxiways / runways: dark, only their own lights
export function setSurfaceNight(n: number): void {
  for (const m of SURFACE_MATS) m.emissive.setRGB(0.085 * n, 0.076 * n, 0.06 * n);
  for (const m of PAVEMENT_MATS) m.emissive.setRGB(0.018 * n, 0.018 * n, 0.02 * n);
}
/** Apron concrete (grained). */
export function apronMaterial(): THREE.MeshLambertMaterial { const m = new THREE.MeshLambertMaterial({ color: PALETTE.concrete, side: THREE.DoubleSide, map: grainTexture(210, 50) }); SURFACE_MATS.push(m); return m; }

// ── airport surfaces with generated markings ──────────────────────────────────
/** Runway widths (m) by airport, optionally per runway ref ("13R/31L"); anything else is 45 m. */
const RUNWAY_WIDTH: Record<string, number | Record<string, number>> = {
  KSFO: 61, EGLL: 50, KLAX: { '07R/25L': 61 }, KJFK: { '13L/31R': 46 }, KBOS: { '15L/33R': 30, '14/32': 30 }, VIDP: { '11L/29R': 60, '11/29': 60 },
};
const DEFAULT_RUNWAY_WIDTH: Record<string, number> = { KLAX: 46, KJFK: 61, KBOS: 46 };
function runwayWidth(icao: string, ref: string): number {
  const w = RUNWAY_WIDTH[icao];
  if (typeof w === 'number') return w;
  if (w) { const [a, b] = ref.split('/'); const alt = b && a ? `${b}/${a}` : ref; if (w[ref] != null) return w[ref]; if (w[alt] != null) return w[alt]; }
  return DEFAULT_RUNWAY_WIDTH[icao] ?? 45;
}
export const TAXIWAY_WIDTH = 23;

export function ribbon(a: THREE.Vector3, b: THREE.Vector3, width: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a); dir.y = 0; dir.normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
  const p = [a.clone().add(side), a.clone().sub(side), b.clone().sub(side), b.clone().add(side)];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p.flatMap(v => [v.x, v.y, v.z]), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(p.flatMap(v => [v.x, v.z]), 2));   // world-planar UVs (the grain texture repeats every 24 m)
  geo.setIndex([0, 1, 2, 0, 2, 3]); geo.computeVertexNormals();
  return geo;
}
function polygonGeo(pts: { x: number; y: number }[], h: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));   // (east, north)
  const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2); geo.translate(0, h, 0);   // faces +y, north -> -z
  const pos = geo.getAttribute('position'); const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i); uv[i * 2 + 1] = pos.getZ(i); }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

export interface NightHandle { setNight(n: number): void }

/** Soft white dot (radial alpha) for point lights. */
function dotTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 64; const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.85)'); g.addColorStop(0.65, 'rgba(255,255,255,0.25)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 128; const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,214,150,0.55)'); g.addColorStop(0.35, 'rgba(255,190,110,0.18)'); g.addColorStop(1, 'rgba(255,170,90,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}


export function buildAirport(world: World, air: OsmAirport, fades: Fade[], night: NightHandle[] = []): THREE.Group {
  const g = new THREE.Group(); g.name = 'airport';
  const c = world.toLocal(air.center.lng, air.center.lat);
  const base = world.heightAt(c.x, c.y);
  const xy = (id: string) => { const n = air.nodes.get(id)!; return world.toLocal(n.lng, n.lat); };
  const flat = new THREE.MeshLambertMaterial({ color: PALETTE.asphalt, side: THREE.DoubleSide, map: grainTexture(200, 70) }); PAVEMENT_MATS.push(flat);
  const concrete = apronMaterial();
  const mark = new THREE.MeshBasicMaterial({ color: PALETTE.marking, side: THREE.DoubleSide });

  // Surface stack (metres above the levelled field): taxiway ribbons 0.5 < aprons 0.6 < markings 0.75+. The apron is one
  // continuous slab, so the taxi lanes that cross it are only their painted centrelines - not asphalt strips.
  for (const b of air.buildings) {
    const pts = b.polygon.map(p => world.toLocal(p.lng, p.lat));
    if (pts.length < 3) continue;
    if (b.kind === 'apron') { const m = new THREE.Mesh(polygonGeo(pts, base + 0.6), concrete); m.renderOrder = 1; g.add(m); }
  }
  // taxiways: ribbons along the taxi graph edges (stand lead-ins excluded: those are painted lines on the apron) + a
  // yellow centreline; a disc at every junction / bend fills the notches between ribbons
  const twyGeos: THREE.BufferGeometry[] = []; const centre: number[] = [];
  const seen = new Set<string>(); const capped = new Set<string>();
  const capGeo = new THREE.CircleGeometry(TAXIWAY_WIDTH / 2, 14); capGeo.rotateX(-Math.PI / 2);
  for (const n of air.nodes.values()) for (const e of n.edges) {
    if (e.type !== 'taxiway' || e.leadIn) continue;
    const key = n.id < e.to ? `${n.id}|${e.to}` : `${e.to}|${n.id}`; if (seen.has(key)) continue; seen.add(key);
    const a = xy(n.id), b = xy(e.to);
    const va = toV3(a.x, a.y, base + 0.5), vb = toV3(b.x, b.y, base + 0.5);
    twyGeos.push(ribbon(va, vb, TAXIWAY_WIDTH));
    centre.push(va.x, va.y + 0.35, va.z, vb.x, vb.y + 0.35, vb.z);
    for (const [id, v] of [[n.id, va], [e.to, vb]] as [string, THREE.Vector3][]) {
      if (capped.has(id)) continue; capped.add(id);
      const nd = air.nodes.get(id)!; if (nd.edges.filter(x => x.type === 'taxiway' && !x.leadIn).length < 2) continue;
      const cg = capGeo.clone(); cg.translate(v.x, v.y, v.z);
      const pos = cg.getAttribute('position'); const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i); uv[i * 2 + 1] = pos.getZ(i); }
      cg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); twyGeos.push(cg);
    }
  }
  if (twyGeos.length) g.add(new THREE.Mesh(mergeGeometries(twyGeos), flat));
  const cl = new THREE.BufferGeometry(); cl.setAttribute('position', new THREE.Float32BufferAttribute(centre, 3));
  const clMat = new THREE.LineBasicMaterial({ color: PALETTE.taxiLine, transparent: true, opacity: 0.8 });
  g.add(new THREE.LineSegments(cl, clMat)); fades.push({ mat: clMat, base: 0.8, near: 1200, far: 4200 });

  // runways: surface, edge lines, centreline dashes, threshold bars
  const markGeos: THREE.BufferGeometry[] = [];
  for (const r of air.runways) {
    const rw = runwayWidth(air.icao, r.ref);
    const [e0, e1] = r.ends; const a = world.toLocal(e0.lng, e0.lat), b = world.toLocal(e1.lng, e1.lat);
    const va = toV3(a.x, a.y, base + 0.65), vb = toV3(b.x, b.y, base + 0.65);
    const rm = new THREE.Mesh(ribbon(va, vb, rw), flat); rm.renderOrder = 2; g.add(rm);
    const dir = new THREE.Vector3().subVectors(vb, va); const len = dir.length(); dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const at = (d: number) => va.clone().addScaledVector(dir, d).setY(base + 0.8);
    // edge lines
    for (const s of [-1, 1]) { const o = side.clone().multiplyScalar(s * (rw / 2 - 0.9)); markGeos.push(ribbon(at(0).add(o), at(len).add(o), 0.9)); }
    // centreline: 30 m dash / 20 m gap
    for (let d = 60; d < len - 60; d += 50) markGeos.push(ribbon(at(d), at(Math.min(len - 60, d + 30)), 0.9));
    // threshold bars at both ends: stripes 30 m long, 1.8 m wide, both sides of the centre
    const stripes = rw >= 55 ? 8 : rw >= 40 ? 6 : 4; const gap = rw / (stripes + 1);
    for (const end of [0, 1]) {
      for (let i = 0; i < stripes; i++) {
        const off = side.clone().multiplyScalar(-rw / 2 + gap * (i + 1)); if (Math.abs(off.length()) < 2) continue;
        const d0 = end === 0 ? 6 : len - 36, d1 = d0 + 30;
        markGeos.push(ribbon(at(d0).add(off), at(d1).add(off), 1.8));
      }
      // touchdown-zone / aiming point bars
      const d0 = end === 0 ? 300 : len - 345; if (d0 > 0 && d0 + 45 < len) for (const s of [-1, 1]) markGeos.push(ribbon(at(d0).add(side.clone().multiplyScalar(s * 9)), at(d0 + 45).add(side.clone().multiplyScalar(s * 9)), 4));
    }
  }
  if (markGeos.length) { const mm = new THREE.Mesh(mergeGeometries(markGeos), mark); mm.renderOrder = 3; g.add(mm); }
  // designator plates just past each threshold (numbers read toward the landing aircraft) + runway / threshold lights
  const lightPos: number[] = []; const lightCol: number[] = [];
  const pushLight = (v: THREE.Vector3, c: THREE.Color) => { lightPos.push(v.x, v.y + 0.6, v.z); lightCol.push(c.r, c.g, c.b); };
  const white = new THREE.Color('#f4f1e6'), green = new THREE.Color('#3ee06a'), red = new THREE.Color('#ff3b30'), amber = new THREE.Color('#ffb020');
  for (const r of air.runways) {
    const rw = runwayWidth(air.icao, r.ref);
    const [e0, e1] = r.ends; const a = world.toLocal(e0.lng, e0.lat), b = world.toLocal(e1.lng, e1.lat);
    const va = toV3(a.x, a.y, base + 0.78), vb = toV3(b.x, b.y, base + 0.78);
    const dir = new THREE.Vector3().subVectors(vb, va); const len = dir.length(); dir.normalize(); const side = new THREE.Vector3(-dir.z, 0, dir.x);
    for (const [end, name, sign] of [[va, e0.name, 1], [vb, e1.name, -1]] as [THREE.Vector3, string, number][]) {
      const d = dir.clone().multiplyScalar(sign);
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(rw * 0.55, rw * 0.28), new THREE.MeshBasicMaterial({ map: designatorTexture(name), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      plate.rotation.x = -Math.PI / 2; plate.rotation.z = Math.atan2(-d.x, -d.z);   // top of the glyphs points down the runway (as seen on approach)
      plate.position.copy(end).addScaledVector(d, 62).setY(base + 0.82); plate.renderOrder = 4;
      g.add(plate);
    }
    // edge lights every 60 m (white, amber in the last 600 m), threshold green / end red
    for (let dd = 30; dd < len - 30; dd += 60) {
      const c = dd < 600 || dd > len - 600 ? amber : white;
      for (const sgn of [-1, 1]) pushLight(va.clone().addScaledVector(dir, dd).addScaledVector(side, sgn * (rw / 2 + 1.5)), c);
    }
    for (let i = -Math.floor(rw / 6); i <= Math.floor(rw / 6); i++) {
      pushLight(va.clone().addScaledVector(side, i * 3), green); pushLight(va.clone().addScaledVector(dir, -2).addScaledVector(side, i * 3), red);
      pushLight(vb.clone().addScaledVector(side, i * 3), green); pushLight(vb.clone().addScaledVector(dir, 2).addScaledVector(side, i * 3), red);
    }
  }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lightPos, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(lightCol, 3));
  const dot = dotTexture();
  const lm = new THREE.PointsMaterial({ size: 2.6, vertexColors: true, transparent: true, opacity: 0.95, sizeAttenuation: true, depthWrite: false, map: dot, blending: THREE.AdditiveBlending });
  g.add(new THREE.Points(lg, lm)); const rwFade: Fade = { mat: lm, base: 0.95, near: 2500, far: 7000 }; fades.push(rwFade);
  // night: taxiway edge lights (blue) + centreline lights (green) along the taxi graph, apron floodlight glows at the terminals
  const tPos: number[] = []; const tCol: number[] = []; const blue = new THREE.Color('#4f8cff'), grn = new THREE.Color('#38e07a');
  const seenN = new Set<string>();
  for (const n of air.nodes.values()) for (const e of n.edges) {
    if (e.type !== 'taxiway' || e.leadIn) continue;
    const key = n.id < e.to ? `${n.id}|${e.to}` : `${e.to}|${n.id}`; if (seenN.has(key)) continue; seenN.add(key);
    const a = xy(n.id), b = xy(e.to); const va = toV3(a.x, a.y, base + 0.9), vb = toV3(b.x, b.y, base + 0.9);
    const d = new THREE.Vector3().subVectors(vb, va); const L = d.length(); if (L < 8) continue; d.normalize(); const sd = new THREE.Vector3(-d.z, 0, d.x);
    for (let t = 15; t < L - 5; t += 30) { const c = va.clone().addScaledVector(d, t); tCol.push(grn.r, grn.g, grn.b); tPos.push(c.x, c.y, c.z); }
    for (let t = 10; t < L - 5; t += 45) for (const sgn of [-1, 1]) { const c = va.clone().addScaledVector(d, t).addScaledVector(sd, sgn * (TAXIWAY_WIDTH / 2 + 1)); tCol.push(blue.r, blue.g, blue.b); tPos.push(c.x, c.y, c.z); }
  }
  const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(tPos, 3)); tg.setAttribute('color', new THREE.Float32BufferAttribute(tCol, 3));
  const tm = new THREE.PointsMaterial({ size: 2.0, vertexColors: true, transparent: true, opacity: 0, sizeAttenuation: true, depthWrite: false, map: dot, blending: THREE.AdditiveBlending });
  const tp = new THREE.Points(tg, tm); tp.visible = false; g.add(tp);
  // apron floodlight pools: flat glow discs on the surface (depth-tested, so the buildings sit on top of them)
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const glows: THREE.Mesh[] = []; const glowGeo = new THREE.PlaneGeometry(1, 1); glowGeo.rotateX(-Math.PI / 2);
  for (const b of air.buildings) {
    if (b.kind !== 'terminal' && b.kind !== 'apron') continue;
    const c = world.toLocal(b.centroid.lng, b.centroid.lat); const r = Math.sqrt(b.areaM2) * (b.kind === 'apron' ? 0.8 : 1.15);
    const sp = new THREE.Mesh(glowGeo, glowMat); sp.position.copy(toV3(c.x, c.y, base + 1.2)); sp.scale.set(r, 1, r); sp.visible = false; sp.renderOrder = 6; g.add(sp); glows.push(sp);
  }
  let curNight = 0;
  night.push({ setNight: (n) => {
    curNight = n; tm.opacity = 0.95 * n; tp.visible = n > 0.03; glowMat.opacity = 0.5 * n; for (const sp of glows) sp.visible = n > 0.03;
    lm.size = 2.6 + 2.4 * n; tm.size = 2.0 + 1.0 * n; rwFade.base = 0.95; rwFade.far = 7000 + 9000 * n;   // runway lights carry further at night
  } });
  void curNight;

  // holding position bars (double yellow across the taxiway)
  const holdGeos: THREE.BufferGeometry[] = [];
  for (const hp of air.holdingPositions) {
    const n = air.nodes.get(hp.nodeId); if (!n) continue;
    const p = world.toLocal(n.lng, n.lat);
    const other = n.edges.find(e => e.type === 'taxiway'); if (!other) continue;
    const q = xy(other.to); const dir = new THREE.Vector3(q.x - p.x, 0, -(q.y - p.y)).normalize(); const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const centre = toV3(p.x, p.y, base + 0.8);
    holdGeos.push(ribbon(centre.clone().addScaledVector(side, -TAXIWAY_WIDTH / 2), centre.clone().addScaledVector(side, TAXIWAY_WIDTH / 2), 0.6));
    const c2 = centre.clone().addScaledVector(dir, 1.5);
    holdGeos.push(ribbon(c2.clone().addScaledVector(side, -TAXIWAY_WIDTH / 2), c2.clone().addScaledVector(side, TAXIWAY_WIDTH / 2), 0.6));
  }
  if (holdGeos.length) { const hm = new THREE.MeshBasicMaterial({ color: PALETTE.taxiLine, side: THREE.DoubleSide, transparent: true }); const hmesh = new THREE.Mesh(mergeGeometries(holdGeos), hm); hmesh.renderOrder = 3; g.add(hmesh); fades.push({ mat: hm, base: 1, near: 1500, far: 4000 }); }
  g.userData.base = base;
  return g;
}

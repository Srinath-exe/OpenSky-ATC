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
  uniform vec3 uLight;       // normalized, world space
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
    float lit = 0.4 * hemi + 1.0 * ndl;
    col *= lit;
    // shadow-side tint (cooler)
    col = mix(col, col * vec3(0.85, 0.9, 1.05), (1.0 - ndl) * 0.35);

    // water: dark, slightly deeper further from shore, faint moving sheen
    vec3 viewDir = normalize(uCam - vWorld);
    vec3 hv = normalize(viewDir + uLight);
    float spec = pow(clamp(dot(vec3(0.0, 1.0, 0.0), hv), 0.0, 1.0), 180.0);
    float ripple = noise(vWorld.xz * 0.004 + vec2(uTime * 0.02, 0.0)) * 0.5 + noise(vWorld.xz * 0.015 - vec2(0.0, uTime * 0.03)) * 0.5;
    vec3 waterCol = mix(cWater, cWaterDeep, 0.5 + 0.5 * ripple) + spec * 0.25 + ripple * 0.006;
    // soft shoreline: the mask is bilinear so the edge blends over ~1 texel
    col = mix(col, waterCol, smoothstep(0.35, 0.65, water));

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
    uLight: { value: new THREE.Vector3(-0.55, 0.62, 0.55).normalize() },   // sun from the north-west, mid elevation (long relief shadows)
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
    const n = geo.getAttribute('position').count;
    for (let i = 0; i < n; i++) colors.push(c.r, c.g, c.b);
    geos.push(geo);
  }
  const merged = mergeGeometries(geos);
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(merged, mat); mesh.name = 'buildings';
  return mesh;
}

function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  geos = geos.map(g => (g.index ? g.toNonIndexed() : g));   // indexed inputs (ribbons) must be expanded before concatenation
  let count = 0; for (const g of geos) count += g.getAttribute('position').count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of geos) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position').array as Float32Array; const n = g.getAttribute('normal').array as Float32Array;
    pos.set(p, o); nor.set(n, o); o += p.length; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

// ── airport surfaces with generated markings ──────────────────────────────────
const RUNWAY_WIDTH: Record<string, number> = { KSFO: 61 };
const TAXIWAY_WIDTH = 23;

function ribbon(a: THREE.Vector3, b: THREE.Vector3, width: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a); dir.y = 0; dir.normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
  const p = [a.clone().add(side), a.clone().sub(side), b.clone().sub(side), b.clone().add(side)];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p.flatMap(v => [v.x, v.y, v.z]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]); geo.computeVertexNormals();
  return geo;
}
function polygonGeo(pts: { x: number; y: number }[], h: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));   // (east, north)
  const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2); geo.translate(0, h, 0);   // faces +y, north -> -z
  return geo;
}

export function buildAirport(world: World, air: OsmAirport, fades: Fade[]): THREE.Group {
  const g = new THREE.Group(); g.name = 'airport';
  const c = world.toLocal(air.center.lng, air.center.lat);
  const base = world.heightAt(c.x, c.y);
  const xy = (id: string) => { const n = air.nodes.get(id)!; return world.toLocal(n.lng, n.lat); };
  const flat = new THREE.MeshLambertMaterial({ color: PALETTE.asphalt, side: THREE.DoubleSide });
  const concrete = new THREE.MeshLambertMaterial({ color: PALETTE.concrete, side: THREE.DoubleSide });
  const mark = new THREE.MeshBasicMaterial({ color: PALETTE.marking, side: THREE.DoubleSide });

  // aprons + terminals from the airport data (the world's building layer covers the rest)
  for (const b of air.buildings) {
    const pts = b.polygon.map(p => world.toLocal(p.lng, p.lat));
    if (pts.length < 3) continue;
    if (b.kind === 'apron') g.add(new THREE.Mesh(polygonGeo(pts, base + 0.25), concrete));
  }
  // taxiways: ribbons along the taxi graph edges + a yellow centreline
  const twyGeos: THREE.BufferGeometry[] = []; const centre: number[] = [];
  const seen = new Set<string>();
  for (const n of air.nodes.values()) for (const e of n.edges) {
    if (e.type !== 'taxiway') continue;
    const key = n.id < e.to ? `${n.id}|${e.to}` : `${e.to}|${n.id}`; if (seen.has(key)) continue; seen.add(key);
    const a = xy(n.id), b = xy(e.to);
    const va = toV3(a.x, a.y, base + 0.5), vb = toV3(b.x, b.y, base + 0.5);
    twyGeos.push(ribbon(va, vb, TAXIWAY_WIDTH));
    centre.push(va.x, va.y + 0.35, va.z, vb.x, vb.y + 0.35, vb.z);
  }
  if (twyGeos.length) g.add(new THREE.Mesh(mergeGeometries(twyGeos), flat));
  const cl = new THREE.BufferGeometry(); cl.setAttribute('position', new THREE.Float32BufferAttribute(centre, 3));
  const clMat = new THREE.LineBasicMaterial({ color: PALETTE.taxiLine, transparent: true, opacity: 0.8 });
  g.add(new THREE.LineSegments(cl, clMat)); fades.push({ mat: clMat, base: 0.8, near: 1200, far: 4200 });

  // runways: surface, edge lines, centreline dashes, threshold bars
  const rw = RUNWAY_WIDTH[air.icao] ?? 45;
  const markGeos: THREE.BufferGeometry[] = [];
  for (const r of air.runways) {
    const [e0, e1] = r.ends; const a = world.toLocal(e0.lng, e0.lat), b = world.toLocal(e1.lng, e1.lat);
    const va = toV3(a.x, a.y, base + 0.6), vb = toV3(b.x, b.y, base + 0.6);
    g.add(new THREE.Mesh(ribbon(va, vb, rw), flat));
    const dir = new THREE.Vector3().subVectors(vb, va); const len = dir.length(); dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const at = (d: number) => va.clone().addScaledVector(dir, d).setY(base + 0.75);
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
  if (markGeos.length) g.add(new THREE.Mesh(mergeGeometries(markGeos), mark));

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
  if (holdGeos.length) { const hm = new THREE.MeshBasicMaterial({ color: PALETTE.taxiLine, side: THREE.DoubleSide, transparent: true }); g.add(new THREE.Mesh(mergeGeometries(holdGeos), hm)); fades.push({ mat: hm, base: 1, near: 1500, far: 4000 }); }
  return g;
}

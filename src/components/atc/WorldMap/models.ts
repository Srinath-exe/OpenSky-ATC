/*
  Aircraft 3D models for the world map (public/models/aircraft/<TYPE>.glb — Flightradar24 community models, GPLv2,
  converted by scripts/convert_models.sh). Loaded once per type and normalised: nose toward -z, +y up, wheels on y = 0,
  length scaled to the performance database, so every model behaves like the built-in silhouette.
*/
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group | null>>();

/** Normalised template for a type (unit-length: 1 m nose-to-tail — `instantiate` scales it), or null when no model exists. */
export function loadAircraftModel(type: string): Promise<THREE.Group | null> {
  const key = type.toUpperCase();
  let p = cache.get(key);
  if (!p) {
    p = loader.loadAsync(`/models/aircraft/${key}.glb`).then((gltf) => normalise(gltf.scene, 1)).catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** Per-aircraft instance: a clone of the template scaled to the aircraft's real length, painted in the airline's
 *  livery. Materials are cloned so the livery and tint() are per instance. */
export function instantiate(template: THREE.Group, lengthM: number, callsign?: string): THREE.Group {
  const g = template.clone(true);
  g.scale.setScalar(lengthM);
  const livery = liveryFor(callsign ?? '');
  g.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    m.material = Array.isArray(m.material) ? m.material.map((x) => paint(x.clone(), livery)) : paint(m.material.clone(), livery);
  });
  return g;
}

/* ── liveries ────────────────────────────────────────────────────────────────
   The community models are plain white. A livery is painted procedurally: every vertex of a normalised template is
   classified once (tail fin / engines / lower fuselage / rest) into a `livery` attribute, and a small shader patch
   recolours those regions per instance with the airline's colours - the paint texture's shading and details are kept.
*/
export interface Livery { primary: THREE.Color; secondary: THREE.Color; belly: THREE.Color | null; engines: THREE.Color | null }
type Hex = number;
/** ICAO airline code -> [tail, accent, belly?, engines?]; belly / engines default to white / tail colour. */
const AIRLINES: Record<string, [Hex, Hex, Hex?, Hex?]> = {
  UAL: [0x1a3a8c, 0x1a3a8c, 0xdfe6f2, 0x1a3a8c], DAL: [0xc8102e, 0x003a70, 0x003a70, 0xffffff], AAL: [0x9da5ad, 0xc8102e, 0xcfd4d9, 0xbfc6cc],
  SWA: [0x304cb2, 0xf9b612, 0xd22b2b, 0x304cb2], JBU: [0x0033a0, 0x0033a0, 0xffffff, 0xffffff], ASA: [0x00426a, 0x38b54a, 0xffffff, 0x00426a],
  NKS: [0xf5d000, 0x111111, 0xf5d000, 0xf5d000], FFT: [0x0b7a3b, 0x0b7a3b, 0xffffff, 0xffffff], SKW: [0x1c3f94, 0x1c3f94, 0xffffff, 0xffffff],
  FDX: [0x4d148c, 0xff6600, 0xffffff, 0x4d148c], UPS: [0x351c15, 0xffb500, 0x351c15, 0xffffff], ACA: [0xd52b1e, 0x111111, 0x111111, 0xffffff],
  WJA: [0x0c2340, 0x00a8b3, 0xffffff, 0xffffff], BAW: [0x1f3a93, 0xd0021b, 0x1f3a93, 0xffffff], VIR: [0xd0021b, 0xd0021b, 0xffffff, 0xd0021b],
  DLH: [0x0a1d5a, 0xf9ba00, 0xffffff, 0xffffff], AFR: [0xffffff, 0x002157, 0xffffff, 0xffffff], KLM: [0x00a1de, 0x00a1de, 0xffffff, 0x00a1de],
  SWR: [0xe30613, 0xe30613, 0xffffff, 0xe30613], IBE: [0xd7192d, 0xf7b500, 0xffffff, 0xffffff], EIN: [0x00843d, 0x00843d, 0xffffff, 0x00843d],
  RYR: [0x073590, 0xf1c933, 0x073590, 0xffffff], EZY: [0xff6600, 0xff6600, 0xffffff, 0xff6600], WZZ: [0xc6007e, 0x2a1a6e, 0xc6007e, 0xffffff],
  SAS: [0x00205b, 0x00205b, 0xd1d5e0, 0xffffff], FIN: [0x0b1560, 0x0b1560, 0xffffff, 0xffffff], TAP: [0xd7001d, 0x2e7d32, 0xffffff, 0xffffff],
  AZA: [0x00814f, 0xd2232a, 0xffffff, 0xffffff], THY: [0xc70a0c, 0xc70a0c, 0xffffff, 0xffffff], AUA: [0xd7192d, 0xd7192d, 0xffffff, 0xd7192d],
  UAE: [0xffffff, 0xd71921, 0xffffff, 0xffffff], QTR: [0x5c0632, 0x5c0632, 0x8a8a8a, 0x5c0632], ETD: [0xbd8b13, 0x2b1e14, 0xffffff, 0xbd8b13],
  SVA: [0x006c35, 0x006c35, 0xffffff, 0xffffff], ETH: [0x078930, 0xfcdd09, 0xffffff, 0xda121a], SIA: [0xf4b400, 0x003a70, 0xffffff, 0xffffff],
  CPA: [0x006564, 0x006564, 0xffffff, 0x006564], JAL: [0xffffff, 0xd7192d, 0xffffff, 0xffffff], ANA: [0x0e2a7a, 0x0e2a7a, 0xffffff, 0x0e2a7a],
  KAL: [0x5db2ff, 0x5db2ff, 0x5db2ff, 0x5db2ff], AAR: [0xc41230, 0xc41230, 0xffffff, 0xffffff], CCA: [0xc8102e, 0xc8102e, 0xffffff, 0xffffff],
  CES: [0x0b3a8c, 0xc8102e, 0xffffff, 0xffffff], CSN: [0x1c3f94, 0xc8102e, 0xffffff, 0xffffff], EVA: [0x1a5a3a, 0xff7f00, 0xffffff, 0x1a5a3a],
  CAL: [0xc8b273, 0x1f3a93, 0xffffff, 0xffffff], QFA: [0xe0001b, 0xe0001b, 0xffffff, 0xffffff], ANZ: [0x111111, 0x111111, 0xffffff, 0x111111],
  AIC: [0xd7192d, 0xf58220, 0xffffff, 0xffffff], MAS: [0x1c3f94, 0xc8102e, 0xffffff, 0xffffff], THA: [0x5b2c8a, 0xf5b400, 0xffffff, 0xffffff],
  GIA: [0x0e5aa7, 0x1abc9c, 0xffffff, 0xffffff], LAN: [0x1b2a5a, 0xe30a45, 0xffffff, 0x1b2a5a], TAM: [0x1b2a5a, 0xe30a45, 0xffffff, 0x1b2a5a],
  AMX: [0x0b2265, 0xe4002b, 0xffffff, 0x0b2265], AVA: [0xd7192d, 0xd7192d, 0xffffff, 0xffffff], CMP: [0x1c3f94, 0x1c3f94, 0xffffff, 0xffffff],
  VOI: [0x5c2d91, 0x5c2d91, 0xffffff, 0xffffff], VLG: [0xffcc00, 0x8f8f8f, 0xffffff, 0xffffff], NAX: [0xd81e05, 0xd81e05, 0xffffff, 0xffffff],
  ICE: [0xf6c000, 0x003a70, 0xffffff, 0xffffff], CFG: [0xffd700, 0x1f2b6c, 0xffffff, 0xffffff], EWG: [0x9c1e6e, 0x9c1e6e, 0xffffff, 0xffffff],
  BEL: [0x1f3a93, 0xd0021b, 0xffffff, 0xffffff], LOT: [0x0d2c6b, 0x0d2c6b, 0xffffff, 0xffffff], CSA: [0x0d2c6b, 0xd7192d, 0xffffff, 0xffffff],
  AFL: [0x0d2c6b, 0xe4002b, 0xffffff, 0xffffff], ELY: [0x0d2c6b, 0x0d2c6b, 0xffffff, 0xffffff], MSR: [0x0d2c6b, 0xd4a017, 0xffffff, 0xffffff],
  RJA: [0x4a2c5a, 0x4a2c5a, 0xffffff, 0xffffff], GLO: [0xff6600, 0xff6600, 0xffffff, 0xffffff], AZU: [0x0d2c6b, 0x0d2c6b, 0xffffff, 0xffffff],
  HAL: [0x5b2c8a, 0xe4007c, 0xffffff, 0x5b2c8a], VRD: [0xd7192d, 0x9c1e6e, 0xffffff, 0xffffff], SCX: [0x1f3a93, 0xffcc00, 0xffffff, 0xffffff],
  AAY: [0x0a6ab5, 0xf7941d, 0xffffff, 0xffffff], ENY: [0x9da5ad, 0xc8102e, 0xcfd4d9, 0xbfc6cc], RPA: [0x1a3a8c, 0x1a3a8c, 0xdfe6f2, 0x1a3a8c],
  EDV: [0xc8102e, 0x003a70, 0x003a70, 0xffffff], QXE: [0x00426a, 0x38b54a, 0xffffff, 0x00426a], ABX: [0x1c3f94, 0x1c3f94, 0xffffff, 0xffffff],
  GTI: [0xffd200, 0x00205b, 0xffffff, 0xffffff], CLX: [0x0d2c6b, 0xd7192d, 0xffffff, 0xffffff], BOX: [0x1c1c1c, 0xf9ba00, 0xffffff, 0xffffff],
};
const liveryCache = new Map<string, Livery>();
export function liveryFor(callsign: string): Livery {
  const code = callsign.slice(0, 3).toUpperCase();
  let l = liveryCache.get(code);
  if (l) return l;
  const spec = AIRLINES[code];
  if (spec) l = { primary: new THREE.Color(spec[0]), secondary: new THREE.Color(spec[1]), belly: spec[2] != null ? new THREE.Color(spec[2]) : null, engines: spec[3] != null ? new THREE.Color(spec[3]) : new THREE.Color(spec[0]) };
  else if (!/^[A-Z]{3}$/.test(code)) l = { primary: new THREE.Color(0xffffff), secondary: new THREE.Color(0xc8102e), belly: null, engines: null };   // GA registrations: white, red trim
  else {
    // unknown airline: a stable, saturated tail colour from the code so each carrier still looks distinct
    let h = 0; for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
    l = { primary: new THREE.Color().setHSL(h / 360, 0.62, 0.34), secondary: new THREE.Color().setHSL(((h + 40) % 360) / 360, 0.7, 0.5), belly: null, engines: new THREE.Color().setHSL(h / 360, 0.62, 0.34) };
  }
  liveryCache.set(code, l);
  return l;
}

/** Patch a cloned material with the livery shader: regions from the `livery` vertex attribute, colours as uniforms. */
function paint(mat: THREE.Material, livery: Livery): THREE.Material {
  const m = mat as THREE.MeshStandardMaterial;
  if (!('map' in m)) return mat;
  const white = new THREE.Color(0xffffff);
  const u = {
    uTail: { value: livery.primary }, uAccent: { value: livery.secondary },
    uBelly: { value: livery.belly ?? white }, uEngine: { value: livery.engines ?? livery.primary },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float livery;\nvarying float vLivery;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLivery = livery;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLivery;\nuniform vec3 uTail, uAccent, uBelly, uEngine;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          float paintable = smoothstep(0.42, 0.62, luma);                 // only the white paint takes colour; dark parts stay
          vec3 col = vLivery > 3.5 ? uAccent : vLivery > 2.5 ? uBelly : vLivery > 1.5 ? uEngine : vLivery > 0.5 ? uTail : diffuseColor.rgb;
          float shade = 0.55 + 0.45 * luma;
          diffuseColor.rgb = mix(diffuseColor.rgb, col * shade, paintable * step(0.5, vLivery));
        }`);
  };
  m.customProgramCacheKey = () => 'livery';
  m.needsUpdate = true;
  return m;
}

/** Classify the template's vertices into livery regions (attribute `livery`: 0 rest, 1 tail fin, 2 engines, 3 lower fuselage, 4 accent band). */
function classify(wrap: THREE.Group): void {
  wrap.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const meshes: THREE.Mesh[] = [];
  wrap.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry?.attributes?.position) meshes.push(m); });
  // fuselage cross-section from the vertices near the centreline in the middle third
  const ys: number[] = [];
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); if (Math.abs(v.x) < 0.04 && v.z > -0.2 && v.z < 0.2) ys.push(v.y); }
  }
  ys.sort((a, b) => a - b);
  if (ys.length < 20) return;
  const yBot = ys[Math.floor(ys.length * 0.04)], yTop = ys[Math.floor(ys.length * 0.96)];
  const radius = (yTop - yBot) / 2, yMid = (yTop + yBot) / 2;
  const done = new Set<THREE.BufferGeometry>();
  for (const m of meshes) {
    const geo = m.geometry; if (done.has(geo)) continue; done.add(geo);
    const pos = geo.attributes.position; const out = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const ax = Math.abs(v.x);
      let r = 0;
      if (v.z > 0.22 && v.y > yTop + radius * 0.35 && ax < radius * 2.2) r = 1;                                   // vertical stabiliser (+ a T-tail)
      else if (v.y < yMid && v.y > 0.004 && ax > radius * 1.25 && ax < radius * 6 && v.z > -0.32 && v.z < 0.18) r = 2;  // wing-mounted engines
      else if (ax < radius * 1.15 && v.y < yBot + radius * 0.9 && v.z > -0.46 && v.z < 0.34) r = 3;              // lower fuselage
      else if (ax < radius * 1.15 && v.y > yBot + radius * 0.9 && v.y < yBot + radius * 1.12 && v.z > -0.42 && v.z < 0.3) r = 4;  // cheat line
      out[i] = r;
    }
    geo.setAttribute('livery', new THREE.BufferAttribute(out, 1));
  }
}

/** Selection / hover tint via emissive (null clears). */
export function tint(group: THREE.Group, color: THREE.Color | null): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const s = mat as THREE.MeshStandardMaterial;
      if (!('emissive' in s)) continue;
      if (color) { s.emissive.copy(color); s.emissiveIntensity = color.equals(new THREE.Color(0x404040)) ? 1 : 0.55; } else { s.emissive.setHex(0x000000); s.emissiveIntensity = 1; }
    }
  });
}

function normalise(scene: THREE.Group, lengthM: number): THREE.Group {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3(); box.getSize(size);
  const ext = [size.x, size.y, size.z];
  const up = ext.indexOf(Math.min(...ext));                 // an airliner is flattest top-to-bottom
  const long = ext.indexOf(Math.max(...ext));               // and longest nose-to-tail
  const lat = 3 - up - long;
  // the tail fin is the highest part: its centre along the long axis tells which end is the nose
  let finMax = -Infinity, finCentre = 0;
  const mb = new THREE.Box3();
  scene.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    mb.setFromObject(m);
    const top = mb.max.getComponent(up);
    if (top > finMax) { finMax = top; finCentre = (mb.min.getComponent(long) + mb.max.getComponent(long)) / 2; }
  });
  const centre = new THREE.Vector3(); box.getCenter(centre);
  const noseSign = finCentre > centre.getComponent(long) ? -1 : 1;
  // basis: model long axis * noseSign -> -z, model up -> +y, x = y × z (right-handed)
  const axis = (i: number, s: number) => new THREE.Vector3().setComponent(i, s);
  const zAxis = axis(long, -noseSign);                      // model direction that becomes +z (tail)
  const yAxis = axis(up, 1);
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
  void lat;
  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).invert();   // world <- model
  const scale = lengthM / Math.max(1e-3, ext[long]);
  const wrap = new THREE.Group();
  const inner = new THREE.Group();
  inner.applyMatrix4(basis);
  inner.scale.multiplyScalar(scale);
  inner.add(scene);
  wrap.add(inner);
  // centre on the ground contact point
  wrap.updateMatrixWorld(true);
  const wb = new THREE.Box3().setFromObject(wrap);
  const c = new THREE.Vector3(); wb.getCenter(c);
  inner.position.sub(new THREE.Vector3(c.x, wb.min.y, c.z));
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) { const s = mat as THREE.MeshStandardMaterial; if ('metalness' in s) { s.metalness = Math.min(s.metalness ?? 0, 0.2); s.roughness = Math.max(s.roughness ?? 1, 0.6); } s.side = THREE.FrontSide; }
  });
  classify(wrap);
  return wrap;
}

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

/** Per-aircraft instance: a clone of the template scaled to the aircraft's real length. Materials are cloned so tint() is per instance. */
export function instantiate(template: THREE.Group, lengthM: number): THREE.Group {
  const g = template.clone(true);
  g.scale.setScalar(lengthM);
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone(); });
  return g;
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
  return wrap;
}

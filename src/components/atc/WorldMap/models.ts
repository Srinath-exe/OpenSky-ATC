/*
  Aircraft 3D models for the world map (public/models/aircraft/<TYPE>.glb — Flightradar24 community models, GPLv2,
  converted by scripts/convert_models.sh). Loaded once per type and normalised: nose toward -z, +y up, wheels on y = 0,
  length scaled to the performance database, so every model behaves like the built-in silhouette.
*/
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const loader = new GLTFLoader();
/** Bumped when the model files change (they are served immutable under this query string). */
const MODEL_VERSION = '1';
/** Nose wheel position as a fraction of the length behind the nose (models and the built-in silhouette agree). */
export const NOSE_WHEEL = 0.12;
/** Night amount shared by every liveried material (apron floodlighting lifts the paint so aircraft do not go black). */
const NIGHT = { value: 0 };
/** How far the airframe is lifted onto its gear (unit length: 0.02 = 0.8 m on a 737 - the nacelles clear the ground). */
const GEAR_LIFT = 0.02;
const STRUT_MAT = new THREE.MeshLambertMaterial({ color: 0xb8bcc2 });
const TYRE_MAT = new THREE.MeshLambertMaterial({ color: 0x1c1d1f });
const STRUT_GEO = new THREE.CylinderGeometry(0.0045, 0.0045, 1, 6);
const TYRE_GEO = new THREE.CylinderGeometry(0.0115, 0.0115, 0.0065, 12); TYRE_GEO.rotateZ(Math.PI / 2);
/**
 * Nose gear at the origin (twin wheel), main gear a wheelbase (0.37 L) aft on a 0.16 L track (dual wheels), in the unit
 * frame: struts from the ground up into the belly, tyres of 1 % of the length in diameter. One draw call per part.
 */
function buildGear(bellyY: number, r: number): THREE.Group {
  const gear = new THREE.Group(); gear.name = 'gear';
  const strut = (x: number, z: number, top: number) => { const m = new THREE.Mesh(STRUT_GEO, STRUT_MAT); m.scale.y = top; m.position.set(x, top / 2, z); m.frustumCulled = false; m.userData.gear = true; gear.add(m); };
  const tyre = (x: number, z: number) => { const m = new THREE.Mesh(TYRE_GEO, TYRE_MAT); m.position.set(x, 0.0115, z); m.frustumCulled = false; m.userData.gear = true; gear.add(m); };
  const track = Math.max(0.1, Math.min(0.2, r * 3.2));
  strut(0, 0, bellyY + 0.01); tyre(-0.006, 0); tyre(0.006, 0);
  for (const sx of [-1, 1]) { strut(sx * track / 2, 0.37, bellyY + r * 0.6); tyre(sx * track / 2 - 0.0075, 0.37); tyre(sx * track / 2 + 0.0075, 0.37); }
  return gear;
}
/** Gear down: on the ground, and airborne below 400 ft (the last stretch of the approach / just after lift-off). */
export function setGear(model: THREE.Group, down: boolean): void { const gear = model.getObjectByName('gear'); if (gear && gear.visible !== down) gear.visible = down; }
export function setModelNight(n: number): void { NIGHT.value = n; }
const cache = new Map<string, Promise<THREE.Group | null>>();
if (typeof window !== 'undefined') (window as unknown as { __acModels?: unknown }).__acModels = { cache, matSignature: (m: THREE.Material) => matSignature(m) };   // debugging hook

/** Normalised template for a type (unit-length: 1 m nose-to-tail — `instantiate` scales it), or null when no model exists. */
export function loadAircraftModel(type: string): Promise<THREE.Group | null> {
  const key = type.toUpperCase();
  let p = cache.get(key);
  if (!p) {
    p = loader.loadAsync(`/models/aircraft/${key}.glb?v=${MODEL_VERSION}`).then((gltf) => { const w = normalise(gltf.scene, 1, key); return w; }).catch(() => null);
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
  const frame = (template.userData.frame as Frame | undefined) ?? { yBot: 0.02, yTop: 0.12, r: 0.05, maxAx: 0.45, finTop: 0.25, finZ0: 0.3, finZ1: 0.5, finTipZ0: 0.45 };
  // landing gear: the community models are in-flight airframes resting on their bellies / nacelles. The airframe is
  // lifted onto a nose strut at the origin (the nose-wheel point) and two main struts a wheelbase aft; the group is
  // hidden in the air (WorldMap toggles it: down on the ground and inside the last few hundred feet)
  const inner = g.children[0]; if (inner) inner.position.y += GEAR_LIFT;
  g.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    const part = (m.userData.part as number) ?? 0;
    m.material = Array.isArray(m.material) ? m.material.map((x) => paint(x.clone(), livery, frame, part)) : paint(m.material.clone(), livery, frame, part);
  });
  g.add(buildGear(frame.yBot + GEAR_LIFT, frame.r));
  return g;
}

/* ── liveries ────────────────────────────────────────────────────────────────
   The community models are plain white. A livery is painted procedurally, per FRAGMENT, from the vertex position in the
   template frame (attribute `lpos`): fuselage / belly / top-coat colours, a cheat line, the fin design (solid, diagonal
   pennant, top band, disc, brush swoosh, horizontal stripes, chevron, cross, rudder flag), engine colour and the airline
   titles drawn on the forward fuselage from a text texture - so a BA 787 has its blue belly and Chatham pennant, a KLM
   737 its blue top, a Lufthansa A320 the yellow disc, an Emirates 380 the red titles and the flag on the rudder. Brand
   colours and layouts only: no trademarked artwork is bundled.
*/
type Hex = number;
export type TailStyle = 'solid' | 'diag' | 'band' | 'disc' | 'swoosh' | 'stripes' | 'chevron' | 'cross' | 'rudder';
const TAIL_STYLE: Record<TailStyle, number> = { solid: 0, diag: 1, band: 2, disc: 3, swoosh: 4, stripes: 5, chevron: 6, cross: 7, rudder: 8 };
/** Per-airline design. Fractions are of the fuselage radius (belly / top) or unit length (nothing else). */
interface LiverySpec {
  fus?: Hex;                              // fuselage base (white)
  belly?: [Hex, number];                  // lower fuselage colour, height in radii above the belly line
  top?: [Hex, number];                    // upper fuselage colour (KLM), depth in radii below the crown
  cheat?: [Hex, number, number];          // colour, centre (radii above the mid line), half-width (radii)
  tail: [TailStyle, Hex, Hex?, Hex?];     // style, base, second, third
  eng?: Hex;                              // nacelles (default: fuselage base)
  titles?: [string, Hex, number?];        // text, colour, weight 0..1 (default 0.7)
}
const W = 0xffffff;
const LIVERIES: Record<string, LiverySpec> = {
  BAW: { belly: [0x0b2a6a, 0.85], tail: ['diag', 0x0b2a6a, W, 0xd0021b], titles: ['BRITISH AIRWAYS', 0x0b2a6a] },
  VIR: { tail: ['solid', 0xd0021b], eng: 0xd0021b, titles: ['virgin atlantic', 0xd0021b] },
  EIN: { tail: ['disc', 0x0b7a5a, W], eng: 0x0b7a5a, titles: ['Aer Lingus', 0x0b7a5a] },
  EZY: { tail: ['solid', 0xff6600], titles: ['easyJet', 0xff6600] },
  RYR: { belly: [0x073590, 0.9], tail: ['disc', 0x073590, 0xf1c933], titles: ['RYANAIR', 0x073590] },
  DLH: { tail: ['disc', 0x0a1d5a, 0xf9ba00], titles: ['Lufthansa', 0x0a1d5a] },
  AFR: { cheat: [0x002157, 0.15, 0.08], tail: ['diag', W, 0x002157, 0xe1000f], titles: ['AIRFRANCE', 0x002157] },
  TRA: { tail: ['solid', 0x00a85a], eng: 0x00a85a, titles: ['transavia', 0x00a85a] },
  KLM: { top: [0x00a1de, 1.05], tail: ['disc', 0x00a1de, W], eng: W, titles: ['KLM', W, 0.9] },
  SWR: { tail: ['cross', 0xe30613, W], eng: W, titles: ['SWISS', 0x111111] },
  UAE: { tail: ['rudder', W, 0xd71921, 0x00732f], titles: ['Emirates', 0xd71921] },
  FDB: { tail: ['swoosh', 0x0d3d8c, 0xf58220], eng: 0x0d3d8c, titles: ['flydubai', 0x0d3d8c] },
  QTR: { belly: [0x8a8a8a, 0.55], tail: ['disc', 0x5c0632, W], eng: 0x5c0632, titles: ['QATAR', 0x5c0632] },
  ETD: { tail: ['diag', 0xc9a24a, 0x8a5a1c, 0x3a2410], eng: 0xc9a24a, titles: ['ETIHAD', 0x8a5a1c] },
  THY: { belly: [0xb8bcc2, 0.4], tail: ['disc', 0xc70a0c, W], titles: ['TURKISH AIRLINES', 0xc70a0c] },
  AIC: { belly: [0xa61e2a, 0.5], tail: ['band', 0xa61e2a, 0xd4a017], eng: 0xa61e2a, titles: ['AIR INDIA', 0xa61e2a] },
  IGO: { belly: [0x001b71, 0.95], tail: ['solid', 0x001b71], eng: 0x001b71, titles: ['IndiGo', 0x001b71] },
  SIA: { cheat: [0x003a70, -0.05, 0.1], tail: ['swoosh', 0x003a70, 0xf4b400], titles: ['SINGAPORE AIRLINES', 0x003a70] },
  SCO: { tail: ['solid', 0xffd200], eng: 0xffd200, titles: ['scoot', 0xffd200, 0.9] },
  CPA: { belly: [0x3f5a55, 0.5], tail: ['swoosh', 0x006564, W], eng: 0x006564, titles: ['CATHAY PACIFIC', 0x006564] },
  HKE: { tail: ['solid', 0x6d3c9c], eng: 0x6d3c9c, titles: ['HK Express', 0x6d3c9c] },
  CES: { tail: ['diag', 0x0b3a8c, W, 0xc8102e], titles: ['CHINA EASTERN', 0x0b3a8c] },
  CCA: { tail: ['disc', 0xc8102e, W], titles: ['AIR CHINA', 0x0b2a6a] },
  ANA: { cheat: [0x0e2a7a, 0.05, 0.07], tail: ['solid', 0x0e2a7a], eng: 0x0e2a7a, titles: ['ANA', 0x0e2a7a, 0.9] },
  JAL: { tail: ['disc', W, 0xd7192d], titles: ['JAPAN AIRLINES', 0x333333] },
  QFA: { tail: ['chevron', 0xe0001b, W], titles: ['QANTAS', 0xe0001b] },
  VOZ: { tail: ['solid', 0xe4002b], titles: ['virgin australia', 0xe4002b] },
  JST: { tail: ['solid', 0xff5a00], eng: 0xff5a00, titles: ['Jetstar', 0x222222] },
  ANZ: { tail: ['swoosh', 0x111111, W], eng: 0x111111, titles: ['AIR NEW ZEALAND', 0x111111] },
  UAL: { belly: [0x1a3a8c, 0.8], tail: ['disc', 0x1a3a8c, 0x5f9be6], eng: 0x1a3a8c, titles: ['UNITED', 0x1a3a8c] },
  AAL: { fus: 0xd6dadf, tail: ['stripes', 0x0b2a6a, W, 0xc8102e], eng: 0xbfc6cc, titles: ['American', 0x2a3441] },
  DAL: { belly: [0x003a70, 0.75], tail: ['chevron', 0x003a70, 0xc8102e], eng: W, titles: ['DELTA', 0x003a70] },
  SWA: { fus: 0x304cb2, belly: [0xd22b2b, 0.45], cheat: [0xf9b612, -0.55, 0.06], tail: ['stripes', 0x304cb2, 0xf9b612, 0xd22b2b], eng: 0x304cb2, titles: ['Southwest', W] },
  JBU: { tail: ['solid', 0x0033a0], titles: ['jetBlue', 0x0033a0] },
  ASA: { tail: ['disc', 0x00426a, W], eng: 0x00426a, titles: ['Alaska', 0x00426a] },
  SKW: { tail: ['swoosh', 0x1c3f94, W], titles: ['SkyWest', 0x1c3f94] },
  FDX: { tail: ['diag', 0x4d148c, 0xff6600, 0xff6600], eng: 0x4d148c, titles: ['FedEx', 0x4d148c] },
  UPS: { belly: [0x351c15, 0.7], tail: ['disc', 0x351c15, 0xffb500], titles: ['UPS', 0x351c15] },
  NKS: { fus: 0xf5d000, tail: ['solid', 0x111111], eng: 0x111111, titles: ['spirit', 0x111111] },
  FFT: { tail: ['solid', 0x0b7a3b], titles: ['FRONTIER', 0x0b7a3b] },
  ACA: { tail: ['disc', 0x111111, 0xd52b1e], eng: 0x111111, titles: ['AIR CANADA', 0x111111] },
  WJA: { tail: ['solid', 0x0c2340], eng: 0x00a8b3, titles: ['WestJet', 0x0c2340] },
  IBE: { tail: ['diag', 0xd7192d, 0xf7b500, 0xf7b500], titles: ['IBERIA', 0xd7192d] },
  WZZ: { fus: W, belly: [0xc6007e, 0.8], tail: ['solid', 0xc6007e], eng: 0x2a1a6e, titles: ['wizz air', 0xc6007e] },
  SAS: { belly: [0xd1d5e0, 0.6], tail: ['stripes', 0x00205b, 0x00205b, 0x00205b], titles: ['SAS', 0x00205b, 0.9] },
  FIN: { tail: ['solid', 0x0b1560], titles: ['FINNAIR', 0x0b1560] },
  TAP: { tail: ['diag', 0xd7001d, 0x2e7d32, 0x2e7d32], titles: ['TAP', 0xd7001d, 0.9] },
  AZA: { tail: ['diag', 0x00814f, W, 0xd2232a], titles: ['ITA', 0x00814f, 0.9] },
  AUA: { tail: ['stripes', 0xd7192d, W, 0xd7192d], eng: 0xd7192d, titles: ['Austrian', 0xd7192d] },
  SVA: { tail: ['solid', 0x006c35], titles: ['SAUDIA', 0x006c35] },
  ETH: { tail: ['stripes', 0x078930, 0xfcdd09, 0xda121a], eng: 0x078930, titles: ['ETHIOPIAN', 0x078930] },
  KAL: { fus: 0x5db2ff, tail: ['disc', 0x5db2ff, W], eng: 0x5db2ff, titles: ['KOREAN AIR', W] },
  AAR: { tail: ['solid', 0xc41230], titles: ['ASIANA', 0xc41230] },
  CSN: { tail: ['solid', 0x1c3f94], titles: ['CHINA SOUTHERN', 0x1c3f94] },
  EVA: { tail: ['band', 0x1a5a3a, 0xff7f00], eng: 0x1a5a3a, titles: ['EVA AIR', 0x1a5a3a] },
  CAL: { tail: ['solid', 0xc8b273], titles: ['CHINA AIRLINES', 0x1f3a93] },
  MAS: { cheat: [0xc8102e, 0.05, 0.07], tail: ['solid', 0x1c3f94], titles: ['malaysia', 0x1c3f94] },
  THA: { tail: ['diag', 0x5b2c8a, 0xf5b400, 0xd7192d], titles: ['THAI', 0x5b2c8a] },
  GIA: { tail: ['solid', 0x0e5aa7], titles: ['garuda indonesia', 0x0e5aa7] },
  LAN: { tail: ['solid', 0x1b2a5a], eng: 0x1b2a5a, titles: ['LATAM', 0x1b2a5a] },
  AMX: { tail: ['solid', 0x0b2265], eng: 0x0b2265, titles: ['AEROMEXICO', 0x0b2265] },
  HAL: { tail: ['solid', 0x5b2c8a], eng: 0x5b2c8a, titles: ['Hawaiian', 0x5b2c8a] },
  NAX: { tail: ['solid', 0xd81e05], titles: ['norwegian', 0xd81e05] },
  VLG: { tail: ['solid', 0xffcc00], titles: ['vueling', 0x8f8f8f] },
  ICE: { tail: ['solid', 0xf6c000], titles: ['ICELANDAIR', 0x003a70] },
  EWG: { tail: ['solid', 0x9c1e6e], titles: ['eurowings', 0x9c1e6e] },
  LOT: { tail: ['solid', 0x0d2c6b], titles: ['LOT', 0x0d2c6b, 0.9] },
  AFL: { tail: ['solid', 0x0d2c6b], titles: ['AEROFLOT', 0x0d2c6b] },
  MSR: { tail: ['solid', 0x0d2c6b], titles: ['EGYPTAIR', 0x0d2c6b] },
  GTI: { tail: ['solid', 0xffd200], titles: ['ATLAS', 0x00205b] },
};
LIVERIES.ENY = LIVERIES.AAL; LIVERIES.RPA = LIVERIES.UAL; LIVERIES.EDV = LIVERIES.DAL; LIVERIES.QXE = LIVERIES.ASA;

export interface Livery {
  fus: THREE.Color; belly: THREE.Color; bellyH: number; top: THREE.Color; topH: number;
  cheat: THREE.Color; cheatY: number; cheatW: number;
  tailStyle: number; tail1: THREE.Color; tail2: THREE.Color; tail3: THREE.Color; engines: THREE.Color;
  titles: THREE.Texture | null;
}
const liveryCache = new Map<string, Livery>();
const titlesCache = new Map<string, THREE.Texture>();
/** Airline titles as a transparent text texture (one per airline), drawn on the forward fuselage by the shader. */
function titlesTexture(text: string, color: Hex, weight = 0.7): THREE.Texture {
  const key = `${text}|${color}|${weight}`; const hit = titlesCache.get(key); if (hit) return hit;
  const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
  const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height);
  const heavy = weight >= 0.85;
  ctx.font = `${heavy ? 800 : 700} ${heavy ? 112 : 96}px "DM Sans", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  const w = ctx.measureText(text).width; const scale = Math.min(1, (c.width - 40) / w);
  ctx.save(); ctx.translate(20, c.height / 2); ctx.scale(scale, 1); ctx.fillText(text, 0, 4); ctx.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.minFilter = THREE.LinearMipmapLinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  // the text's real width as a fraction of the canvas (for the shader's UV span)
  t.userData.span = Math.min(1, (w * scale + 40) / c.width);
  titlesCache.set(key, t); return t;
}
export function liveryFor(callsign: string): Livery {
  const code = callsign.slice(0, 3).toUpperCase();
  let l = liveryCache.get(code);
  if (l) return l;
  let spec: LiverySpec | undefined = LIVERIES[code];
  if (!spec && !/^[A-Z]{3}$/.test(code)) spec = { tail: ['band', W, 0xc8102e] };   // GA registrations: white, red trim
  if (!spec) {
    // unknown airline: a stable, saturated tail colour from the code so each carrier still looks distinct
    let h = 0; for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const c1 = new THREE.Color().setHSL(h / 360, 0.62, 0.34).getHex(), c2 = new THREE.Color().setHSL(((h + 40) % 360) / 360, 0.7, 0.5).getHex();
    spec = { tail: [(['solid', 'diag', 'disc', 'swoosh', 'band'] as TailStyle[])[h % 5], c1, c2, c2], eng: c1, titles: [code, c1] };
  }
  const col = (x: Hex | undefined, d: Hex) => new THREE.Color(x ?? d);
  const fus = spec.fus ?? W;
  l = {
    fus: col(fus, W), belly: col(spec.belly?.[0], fus), bellyH: spec.belly?.[1] ?? 0, top: col(spec.top?.[0], fus), topH: spec.top?.[1] ?? 0,
    cheat: col(spec.cheat?.[0], fus), cheatY: spec.cheat?.[1] ?? 0, cheatW: spec.cheat?.[2] ?? 0,
    tailStyle: TAIL_STYLE[spec.tail[0]], tail1: col(spec.tail[1], fus), tail2: col(spec.tail[2], fus), tail3: col(spec.tail[3], spec.tail[2] ?? fus),
    engines: col(spec.eng, fus),
    titles: spec.titles && typeof document !== 'undefined' ? titlesTexture(spec.titles[0], spec.titles[1], spec.titles[2]) : null,
  };
  liveryCache.set(code, l);
  return l;
}

/** Template measurements used by the livery shader (normalised frame: unit length, nose -z, wheels on y = 0). */
interface Frame { yBot: number; yTop: number; r: number; maxAx: number; finTop: number; finZ0: number; finZ1: number; finTipZ0: number }
/** Light positions in the template frame (unit length; multiply by the aircraft length). */
export interface LightSpec { tipL: THREE.Vector3; tipR: THREE.Vector3; tail: THREE.Vector3; beaconTop: THREE.Vector3; beaconBot: THREE.Vector3; nose: THREE.Vector3; landL: THREE.Vector3; landR: THREE.Vector3 }
/** Generic light positions for the built-in silhouette (metres), used until the real model is loaded. */
export function genericLights(lengthM: number, spanM: number): LightSpec {
  const zc = (0.5 - NOSE_WHEEL) * lengthM;   // frame origin = nose wheel, +z toward the tail
  return {
    tipL: new THREE.Vector3(-spanM / 2, 2.5, zc + lengthM * 0.1), tipR: new THREE.Vector3(spanM / 2, 2.5, zc + lengthM * 0.1), tail: new THREE.Vector3(0, lengthM * 0.2, zc + lengthM * 0.45),
    beaconTop: new THREE.Vector3(0, lengthM * 0.11, zc), beaconBot: new THREE.Vector3(0, 1.2, zc), nose: new THREE.Vector3(0, 1, -lengthM * 0.1),
    landL: new THREE.Vector3(-lengthM * 0.08, 1.5, zc - lengthM * 0.08), landR: new THREE.Vector3(lengthM * 0.08, 1.5, zc - lengthM * 0.08),
  };
}
/** The template's measured light positions scaled to an aircraft's length, or null when the model has none. */
export function lightsOf(template: THREE.Group, lengthM: number): LightSpec | null {
  const l = template.userData.lights as LightSpec | undefined; if (!l) return null;
  const out = {} as LightSpec;
  for (const k of Object.keys(l) as (keyof LightSpec)[]) out[k] = l[k].clone().multiplyScalar(lengthM);
  // the template origin is the nose wheel already (normalise), so no offset is needed here
  return out;
}

/**
 * Patch a cloned material with the livery shader. Regions are decided per FRAGMENT from the vertex position in the
 * template frame (attribute `lpos`), so the bands are clean whatever the mesh tessellation; a mesh that is a whole
 * engine nacelle is painted as one part (uPart = 2).
 */
function paint(mat: THREE.Material, livery: Livery, frame: Frame, part: number): THREE.Material {
  const m = mat as THREE.MeshStandardMaterial;
  if (!('map' in m)) return mat;
  const u = {
    uFus: { value: livery.fus }, uBelly: { value: livery.belly }, uTop: { value: livery.top }, uCheat: { value: livery.cheat },
    uBands: { value: new THREE.Vector4(livery.bellyH, livery.topH, livery.cheatY, livery.cheatW) },
    uTail1: { value: livery.tail1 }, uTail2: { value: livery.tail2 }, uTail3: { value: livery.tail3 }, uTailStyle: { value: livery.tailStyle },
    uEngine: { value: livery.engines },
    uFrame: { value: new THREE.Vector4(frame.yBot, frame.yTop, frame.r, frame.maxAx) },
    uFin: { value: new THREE.Vector4(frame.finZ0, frame.finZ1, frame.finTop, frame.finTipZ0) },   // root LE, TE, top, tip LE
    uTitles: { value: livery.titles }, uTitleSpan: { value: livery.titles ? (livery.titles.userData.span as number) : 1 }, uHasTitles: { value: livery.titles ? 1 : 0 },
    uPart: { value: part }, uNight: NIGHT,
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 lpos;\nvarying vec3 vLpos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLpos = lpos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLpos;
        uniform vec3 uFus, uBelly, uTop, uCheat, uTail1, uTail2, uTail3, uEngine;
        uniform vec4 uBands, uFrame, uFin;
        uniform float uTailStyle, uPart, uNight, uHasTitles, uTitleSpan;
        uniform sampler2D uTitles;
        // fin design in fin space: fu 0 (leading edge root) .. 1 (trailing edge), fv 0 (root) .. 1 (tip)
        vec3 finColour(float fu, float fv) {
          int st = int(uTailStyle + 0.5);
          if (st == 1) { float d = fu * 0.55 + fv * 0.45; return d > 0.72 ? uTail3 : d > 0.58 ? uTail2 : uTail1; }
          if (st == 2) return fv > 0.62 ? uTail2 : uTail1;
          if (st == 3) { vec2 q = vec2((fu - 0.52) * 1.6, fv - 0.5); return length(q) < 0.26 ? uTail2 : uTail1; }
          if (st == 4) { float c = 0.28 + 0.5 * fu * fu; return abs(fv - c) < 0.09 + 0.08 * fu ? uTail2 : uTail1; }
          if (st == 5) return fv > 0.66 ? uTail3 : fv > 0.33 ? uTail2 : uTail1;
          if (st == 6) return (abs(fu - 0.5) < 0.28 * (1.0 - fv) && fv < 0.72 && fv > 0.08) ? uTail2 : uTail1;
          if (st == 7) return ((abs(fu - 0.5) < 0.09 && fv > 0.2 && fv < 0.85) || (abs(fv - 0.52) < 0.09 && fu > 0.22 && fu < 0.78)) ? uTail2 : uTail1;
          if (st == 8) { if (fu < 0.72) return uTail1; float b = (fu - 0.72) / 0.28; return b < 0.25 ? uTail2 : b < 0.5 ? uTail3 : b < 0.75 ? uTail1 : vec3(0.08); }
          return uTail1;
        }`)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += diffuseColor.rgb * uNight * vec3(0.30, 0.27, 0.22);')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          float paintable = smoothstep(0.3, 0.55, luma);                  // only the light paint takes colour; dark details stay
          float yBot = uFrame.x, yTop = uFrame.y, r = uFrame.z, maxAx = uFrame.w, yMid = 0.5 * (yBot + yTop);
          vec3 p = vLpos; float ax = abs(p.x);
          bool onFus = length(vec2(p.x, p.y - yMid)) < r * 1.12 && p.z > -0.46 && p.z < 0.36;
          bool finZone = p.z > 0.24 && ax < r * 0.55 && p.y > yTop - r * 0.4;
          bool tTail = p.z > 0.2 && p.y > yTop + r * 0.35 && ax < r * 2.4;
          vec3 col = uFus; float w = 1.0;
          if (uPart > 1.5 && ax > r * 0.9) col = uEngine;                                                                 // nacelle mesh
          else if (finZone || tTail) {                                                                                     // fin + rear spine
            float fv = clamp((p.y - yTop) / max(0.02, uFin.z - yTop), 0.0, 1.0);
            float le = mix(uFin.x, uFin.w, (fv - 0.4) / 0.475);                                                        // swept leading edge (measured at 40 % and 88 % height)
            float fu = clamp((p.z - le) / max(0.02, uFin.y - le), 0.0, 1.0);
            col = finColour(fu, fv);
          }
          else if (p.z > 0.31 && ax > r * 0.6 && p.y > yBot - r * 0.4 && p.y < yTop + r * 0.9) col = uTail1;              // tailplane
          else if (ax > maxAx * 0.86 && p.z < 0.3) col = uTail1;                                                          // wingtips
          else if (onFus) {
            float h = (p.y - yBot) / r;                                                                                   // 0 belly line .. 2 crown
            if (uBands.x > 0.0 && h < uBands.x) col = uBelly;                                                             // lower fuselage
            else if (uBands.y > 0.0 && h > 2.0 - uBands.y) col = uTop;                                                    // top coat
            if (uBands.w > 0.0 && abs((p.y - yMid) / r - uBands.z) < uBands.w) col = uCheat;                              // cheat line
            // titles on both sides of the forward fuselage, above the window line, reading nose to tail
            if (uHasTitles > 0.5 && abs(p.x) > r * 0.35) {
              float tu = (p.z + 0.40) / (0.30 * uTitleSpan);
              if (p.x > 0.0) tu = 1.0 - tu;   // +x is the port side (x = up × tail)
              float tv = ((p.y - yMid) / r - 0.12) / 0.5;
              if (tu > 0.0 && tu < 1.0 && tv > 0.0 && tv < 1.0) { vec4 t = texture2D(uTitles, vec2(tu, tv)); col = mix(col, t.rgb, t.a); }
            }
          }
          else w = 0.0;
          float shade = min(1.0, 0.7 + 0.35 * luma);
          diffuseColor.rgb = mix(diffuseColor.rgb, col * shade, paintable * w);
        }`);
  };
  m.customProgramCacheKey = () => 'livery2';
  m.needsUpdate = true;
  return m;
}

/** Measure the template (fuselage cross-section, half span), bake the `lpos` attribute, and flag whole-engine meshes. */
function classify(wrap: THREE.Group): void {
  wrap.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const meshes: THREE.Mesh[] = [];
  wrap.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry?.attributes?.position) meshes.push(m); });
  // the wrap origin is the nose wheel; the livery bands are defined in a length-centred frame (z -0.5 nose .. +0.5 tail)
  const zc = 0.5 - NOSE_WHEEL;
  // fuselage cross-section from the vertices near the centreline in the middle third
  const ys: number[] = [];
  let maxAx = 0;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); v.z -= zc;
      if (Math.abs(v.x) < 0.045 && v.z > -0.2 && v.z < 0.2) ys.push(v.y);   // a band wide enough to catch the crown of a low-poly fuselage
      if (Math.abs(v.x) > maxAx) maxAx = Math.abs(v.x);
    }
  }
  ys.sort((a, b) => a - b);
  if (ys.length < 20) return;
  const yBot = ys[Math.floor(ys.length * 0.04)], yTop = ys[Math.floor(ys.length * 0.96)];
  const r = (yTop - yBot) / 2, yMid = (yTop + yBot) / 2;
  // the fin: its top, and the z range of its upper half (root chord shrinks toward the tip, so the design is mapped on
  // the upper half's span - close enough for pennants, discs and stripes)
  let finTop = yTop + r * 2, finZ0 = 0.5, finZ1 = 0.25;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); v.z -= zc;
      if (v.z > 0.2 && Math.abs(v.x) < r * 0.55 && v.y > yTop) { if (v.y > finTop) finTop = v.y; }
    }
  }
  // the swept leading edge: its z at the root band and at the tip band; the trailing edge = the rearmost fin vertex
  const fh = finTop - yTop; let rootZ0 = 0.5, tipZ0 = 0.5;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); v.z -= zc;
      if (v.z <= 0.2 || Math.abs(v.x) >= r * 0.55) continue;
      const t = (v.y - yTop) / fh;
      if (t > 0.3 && t < 0.5 && v.z < rootZ0) rootZ0 = v.z;     // leading edge at 40 % height (above the rear fuselage hump)
      if (t > 0.75 && v.z < tipZ0) tipZ0 = v.z;                  // leading edge at ~88 % height
      if (t > 0.3 && v.z > finZ1) finZ1 = v.z;
    }
  }
  if (rootZ0 >= finZ1 - 0.03) rootZ0 = 0.3; if (tipZ0 >= finZ1 - 0.01) tipZ0 = finZ1 - 0.03;
  finZ0 = rootZ0;
  wrap.userData.frame = { yBot, yTop, r, maxAx, finTop, finZ0, finZ1, finTipZ0: tipZ0 } as Frame;
  // light positions (unit frame): wingtips = outermost vertices, tail = the rearmost high vertex, beacons on the fuselage
  const tipL = new THREE.Vector3(-maxAx, yBot, zc), tipR = new THREE.Vector3(maxAx, yBot, zc), tail = new THREE.Vector3(0, yTop, 0.45 + zc), nose = new THREE.Vector3(0, yBot, -0.5 + zc);
  let bestL = 0, bestR = 0, bestT = -Infinity;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);   // wrap frame (origin = nose wheel)
      if (v.x < -bestL) { bestL = -v.x; tipL.set(v.x, v.y, v.z); }
      if (v.x > bestR) { bestR = v.x; tipR.set(v.x, v.y, v.z); }
      if (v.z - zc > 0.3 && v.y + (v.z - zc) * 0.5 > bestT && Math.abs(v.x) < r) { bestT = v.y + (v.z - zc) * 0.5; tail.set(0, v.y, v.z); }
      if (v.z < nose.z) nose.set(0, yBot, v.z);
    }
  }
  wrap.userData.lights = { tipL, tipR, tail, beaconTop: new THREE.Vector3(0, yTop + 0.004, zc + 0.02), beaconBot: new THREE.Vector3(0, yBot - 0.004, zc - 0.02), nose: new THREE.Vector3(0, yBot * 0.5, nose.z + 0.02), landL: new THREE.Vector3(-r * 1.6, yBot * 0.8, zc - 0.08), landR: new THREE.Vector3(r * 1.6, yBot * 0.8, zc - 0.08) } as LightSpec;
  const done = new Set<THREE.BufferGeometry>();
  const bb = new THREE.Box3();
  for (const m of meshes) {
    bb.setFromObject(m); bb.min.z -= zc; bb.max.z -= zc;
    // a mesh confined to the under-wing engine zone (below the fuselage mid-line, ahead of the wing's trailing edge,
    // no wider than the inboard engines) is a nacelle - one or both engines; the shader paints its outboard fragments
    const size = bb.getSize(new THREE.Vector3());
    m.userData.part = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)) > r * 1.2 && bb.max.y < yMid + r * 0.2 && bb.min.z > -0.36 && bb.max.z < 0.22 && size.z < 0.3 && size.x < r * 9 ? 2 : 0;
    const geo = m.geometry; if (done.has(geo)) continue; done.add(geo);
    const pos = geo.attributes.position; const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z - zc; }
    geo.setAttribute('lpos', new THREE.BufferAttribute(out, 3));
  }
}

/** Selection / hover tint via emissive (null clears). */
export function tint(group: THREE.Group, color: THREE.Color | null): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh || m.userData.gear) return;   // (gear materials are shared by every aircraft)
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const s = mat as THREE.MeshStandardMaterial;
      if (!('emissive' in s)) continue;
      // a lift, not a repaint: the livery stays readable under the selection / hover tint (the ring carries the selection)
      if (color) { s.emissive.copy(color); s.emissiveIntensity = color.equals(new THREE.Color(0x404040)) ? 0.6 : 0.28; } else { s.emissive.setHex(0x000000); s.emissiveIntensity = 1; }
    }
  });
}

function normalise(scene: THREE.Group, lengthM: number, type = ''): THREE.Group {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3(); box.getSize(size);
  const ext = [size.x, size.y, size.z];
  const up = ext.indexOf(Math.min(...ext));                 // an airliner is flattest top-to-bottom
  // The tail fin is the highest part and sits at one END of the fuselage: the mean position of the top 20 % of the
  // vertices is offset along the length axis and centred on the span axis. That picks the length axis even when the
  // wingspan exceeds the length (A319, A332, A388, turboprops, fighters) and tells which end is the nose - a per-mesh
  // bounding-box test cannot, because most models are one mesh spanning the whole aircraft.
  const centre = new THREE.Vector3(); box.getCenter(centre);
  const lo = box.min.getComponent(up), hgt = size.getComponent(up);
  const sum = [0, 0, 0]; let n = 0; const v = new THREE.Vector3();
  scene.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh || !m.geometry?.attributes?.position) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); if (v.getComponent(up) > lo + hgt * 0.8) { n++; for (let k = 0; k < 3; k++) sum[k] += v.getComponent(k) - centre.getComponent(k); } }
  });
  const rel = [0, 1, 2].map(k => (k === up || !n ? 0 : sum[k] / n / Math.max(1e-6, ext[k])));
  const horiz = [0, 1, 2].filter(k => k !== up);
  let long = Math.abs(rel[horiz[0]]) >= Math.abs(rel[horiz[1]]) ? horiz[0] : horiz[1];
  if (Math.abs(rel[long]) < 0.08) long = ext.indexOf(Math.max(...ext));   // no fin found (odd model): longest axis
  const noseSign = rel[long] > 0 ? -1 : 1;                 // fin at the +end -> nose is the -end
  // basis: model long axis * noseSign -> -z, model up -> +y, x = y × z (right-handed)
  const axis = (i: number, s: number) => new THREE.Vector3().setComponent(i, s);
  const zAxis = axis(long, -noseSign);                      // model direction that becomes +z (tail)
  const yAxis = axis(up, 1);
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).invert();   // world <- model
  const scale = lengthM / Math.max(1e-3, ext[long]);
  const wrap = new THREE.Group();
  const inner = new THREE.Group();
  inner.applyMatrix4(basis);
  inner.scale.multiplyScalar(scale);
  inner.add(scene);
  wrap.add(inner);
  // origin = nose-wheel point: on the centreline, 12 % of the length behind the nose, wheels on y = 0. The sim's position
  // is the nose wheel (it is what follows the taxi centreline and stops at the stand's stop mark).
  wrap.updateMatrixWorld(true);
  const wb = new THREE.Box3().setFromObject(wrap);
  const c = new THREE.Vector3(); wb.getCenter(c);
  inner.position.sub(new THREE.Vector3(c.x, wb.min.y, wb.min.z + NOSE_WHEEL * (wb.max.z - wb.min.z)));
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    // one matte finish for every part (the exporters' per-part gloss is invisible at map scale, and identical materials
    // let mergeParts() collapse the parts into fewer draw calls); fins / control surfaces are single-sided sheets in
    // several models, hence DoubleSide
    for (const mat of mats) { const s = mat as THREE.MeshStandardMaterial; if ('metalness' in s) { s.metalness = 0.1; s.roughness = 0.8; } s.side = THREE.DoubleSide; }
  });
  wrap.userData.type = type;
  classify(wrap);
  mergeParts(wrap);
  return wrap;
}

/**
 * Fewer draw calls per aircraft: after classification every mesh that shares a material (and a paint part) is baked
 * into the wrap frame and merged into one geometry - a 747 comes as 190 meshes, and 40 of them on screen were 8000
 * draw calls. Instanced meshes and multi-material meshes are left alone.
 */
/** Materials that render identically (the exporters leave dozens of same-looking copies per model) share one key. */
function matSignature(mat: THREE.Material): string {
  const m = mat as THREE.MeshStandardMaterial;
  const tex = (t: THREE.Texture | null | undefined) => t ? t.uuid : '-';
  return [m.type, tex(m.map), tex(m.emissiveMap), tex(m.normalMap), tex(m.roughnessMap), tex(m.metalnessMap), m.color?.getHex(), m.emissive?.getHex(), m.emissiveIntensity, m.metalness, m.roughness,
    m.transparent, m.opacity, m.alphaTest, m.side, m.blending, m.depthWrite, m.vertexColors].join('|');
}
function mergeParts(wrap: THREE.Group): void {
  wrap.updateMatrixWorld(true);
  const groups = new Map<string, { mat: THREE.Material; part: number; meshes: THREE.Mesh[] }>();
  wrap.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || Array.isArray(m.material) || !m.geometry?.attributes?.position) return;
    const part = (m.userData.part as number) ?? 0; const key = `${matSignature(m.material as THREE.Material)}:${part}`;
    let g = groups.get(key); if (!g) { g = { mat: m.material as THREE.Material, part, meshes: [] }; groups.set(key, g); }
    g.meshes.push(m);
  });
  const v = new THREE.Vector3();
  const toFloat = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): THREE.BufferAttribute => {
    const out = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) { out[i * size] = a.getX(i); if (size > 1) out[i * size + 1] = a.getY(i); if (size > 2) out[i * size + 2] = a.getZ(i); }
    return new THREE.BufferAttribute(out, size);
  };
  for (const g of groups.values()) {
    if (g.meshes.length < 2) continue;
    const geos: THREE.BufferGeometry[] = [];
    for (const m of g.meshes) {
      const src = m.geometry; const geo = new THREE.BufferGeometry();
      // float, non-normalised copies (quantised models) with one attribute set, baked into the wrap frame
      geo.setAttribute('position', toFloat(src.attributes.position, 3));
      geo.setAttribute('normal', src.attributes.normal ? toFloat(src.attributes.normal, 3) : new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 3), 3));
      geo.setAttribute('uv', src.attributes.uv ? toFloat(src.attributes.uv, 2) : new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 2), 2));
      const lpos = src.attributes.lpos as THREE.BufferAttribute | undefined;
      geo.setAttribute('lpos', lpos ? new THREE.BufferAttribute(new Float32Array(lpos.array as Float32Array), 3) : (() => { const a = toFloat(src.attributes.position, 3); for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld); a.setXYZ(i, v.x, v.y, v.z - (0.5 - NOSE_WHEEL)); } return a; })());
      if (src.index) geo.setIndex(src.index.clone()); else { const idx = new Uint32Array(src.attributes.position.count); for (let i = 0; i < idx.length; i++) idx[i] = i; geo.setIndex(new THREE.BufferAttribute(idx, 1)); }
      if (!src.attributes.normal) geo.computeVertexNormals();
      geo.applyMatrix4(m.matrixWorld);
      geos.push(geo);
    }
    const merged = mergeGeometries(geos, false);
    for (const geo of geos) geo.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, g.mat);
    mesh.userData.part = g.part; mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false;
    for (const m of g.meshes) { m.parent?.remove(m); m.geometry.dispose(); }
    wrap.add(mesh);
  }
  // empty groups left behind by the removed meshes cost a traversal each frame: prune them
  const prune = (o: THREE.Object3D) => { for (const c of o.children.slice()) { prune(c); if (!(c as THREE.Mesh).isMesh && !(c as THREE.InstancedMesh).isInstancedMesh && c.children.length === 0) o.remove(c); } };
  prune(wrap);
}

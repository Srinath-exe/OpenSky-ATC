/*
  Sky, sun and weather for the procedural world: solar position from the real UTC clock and the airport's latitude,
  a sky dome shader (zenith / horizon / sun glow, night stars), the lighting rig driven by sun elevation, and the
  weather layer (fog from visibility, cloud deck from the ATIS cloud group, rain darkening) from the sim's WeatherState.
*/
import * as THREE from 'three';
import type { WeatherState } from '@/lib/sim/types';

export type TimeMode = 'auto' | 'day' | 'dusk' | 'night';

/** Sun elevation (deg) and azimuth (deg true) for a UTC epoch (ms) at lat/lng — NOAA approximation, ±0.5°. */
export function sunPosition(epochMs: number, latDeg: number, lngDeg: number): { elevation: number; azimuth: number } {
  const d = epochMs / 86400000 - 10957.5;                       // days since J2000.0
  const g = ((357.529 + 0.98560028 * d) % 360) * Math.PI / 180;
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = ((q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) % 360) * Math.PI / 180;
  const e = (23.439 - 0.00000036 * d) * Math.PI / 180;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = ((gmst + lngDeg / 15) % 24 + 24) % 24;
  const ha = (lst * 15 * Math.PI / 180) - ra;
  const lat = latDeg * Math.PI / 180;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { elevation: el * 180 / Math.PI, azimuth: ((az * 180 / Math.PI) + 360) % 360 };
}

export interface Lighting {
  /** 0 = night … 1 = full day */
  day: number;
  /** direction TO the sun (three space), normalised */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fog: THREE.Color;
  elevation: number;
}

const C = (h: string) => new THREE.Color(h);
const lerpC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));

/** Lighting from sun elevation (deg). Dusk band is -6…+8°. */
export function lightingFor(elevation: number, azimuth: number): Lighting {
  const day = THREE.MathUtils.smoothstep(elevation, -6, 8);
  const twilight = Math.exp(-Math.pow((elevation - 1) / 6, 2));             // peak glow around the horizon
  const az = azimuth * Math.PI / 180, el = Math.max(elevation, -2) * Math.PI / 180;
  // three: x east, z south → azimuth measured from north clockwise: north = -z, east = +x
  const sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  if (elevation < -6) sunDir.set(-0.3, 0.55, 0.4).normalize();                // moonlight from the south-west
  const sunColor = lerpC(lerpC(C('#5a6a8a'), C('#ff9a4a'), twilight), C('#fff3e0'), THREE.MathUtils.smoothstep(elevation, 4, 25));
  const sunIntensity = 0.12 + 1.15 * day + 0.5 * twilight;
  return {
    day, sunDir, sunColor, sunIntensity, elevation,
    hemiSky: lerpC(lerpC(C('#1a2130'), lerpC(C('#7a6a6e'), C('#bfc7d1'), THREE.MathUtils.smoothstep(elevation, 2, 20)), day), C('#b07a5a'), twilight * 0.6),
    hemiGround: lerpC(C('#0a0b0d'), C('#1a1c1a'), day),
    hemiIntensity: 0.35 + 0.6 * day + 0.3 * twilight,   // twilight keeps a warm ambient glow while the sun is on the horizon
    fog: lerpC(C('#07080a'), lerpC(C('#1c1a1e'), C('#0b0b0c'), THREE.MathUtils.smoothstep(elevation, 4, 18)), day),
  };
}

// ── sky dome ──────────────────────────────────────────────────────────────────
const SKY_VERT = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uZenith, uHorizon, uSunColor, uSunDir; uniform float uDay, uGlow, uStars, uCloud;
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    float y = clamp(vDir.y, -0.05, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(y, 0.55));
    float s = max(dot(normalize(vDir), uSunDir), 0.0);
    col += uSunColor * (pow(s, 380.0) * 1.6 + pow(s, 14.0) * 0.25 * uGlow);
    // stars: sparse hash points, only when dark and clear
    vec3 d = normalize(vDir) * 260.0; float st = step(0.9975, hash(floor(d))) * uStars * (1.0 - uCloud);
    col += vec3(st * 0.7);
    // haze near the horizon
    col = mix(col, uHorizon, (1.0 - smoothstep(0.0, 0.18, y)) * 0.6);
    gl_FragColor = vec4(col, 1.0);
  }`;

export function buildSky(): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
  const uniforms: Record<string, THREE.IUniform> = {
    uZenith: { value: C('#0b0b0c') }, uHorizon: { value: C('#1a1a1c') }, uSunColor: { value: C('#ffd9a0') }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uDay: { value: 1 }, uGlow: { value: 0 }, uStars: { value: 0 }, uCloud: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.frustumCulled = false; mesh.renderOrder = -1000;
  return { mesh, uniforms };
}

export function applySky(u: Record<string, THREE.IUniform>, L: Lighting, cloudCover: number): void {
  const twilight = Math.exp(-Math.pow((L.elevation - 1) / 7, 2));
  const dayZen = lerpC(C('#6f8fb5'), C('#3f6a9e'), 0.3), dayHor = C('#c9cfd4');
  const duskZen = C('#1b2233'), duskHor = C('#c86a3a');
  const nightZen = C('#05070c'), nightHor = C('#0d1118');
  let zen = lerpC(nightZen, dayZen, L.day), hor = lerpC(nightHor, dayHor, L.day);
  zen = lerpC(zen, duskZen, twilight * 0.8); hor = lerpC(hor, duskHor, twilight);
  // overcast greys the sky
  zen = lerpC(zen, C('#3a3d42').multiplyScalar(0.3 + 0.7 * L.day), cloudCover * 0.8); hor = lerpC(hor, C('#5a5d62').multiplyScalar(0.3 + 0.7 * L.day), cloudCover * 0.8);
  u.uZenith.value.copy(zen); u.uHorizon.value.copy(hor); u.uSunColor.value.copy(L.sunColor).multiplyScalar(1 - cloudCover * 0.8);
  u.uSunDir.value.copy(L.sunDir); u.uDay.value = L.day; u.uGlow.value = twilight; u.uStars.value = 1 - THREE.MathUtils.smoothstep(L.elevation, -12, -3); u.uCloud.value = cloudCover;
}

// ── weather ───────────────────────────────────────────────────────────────────
export interface WeatherLook { cloudCover: number; cloudBaseM: number; visM: number; wet: number; precip: WeatherState['precip'] }
export function weatherLook(w: WeatherState | null): WeatherLook {
  if (!w) return { cloudCover: 0.1, cloudBaseM: 1500, visM: 10000, wet: 0, precip: 'none' };
  const m = /(FEW|SCT|BKN|OVC)(\d{3})/g; let cover = 0, base = 1500; let hit: RegExpExecArray | null;
  const map: Record<string, number> = { FEW: 0.15, SCT: 0.4, BKN: 0.75, OVC: 1 };
  while ((hit = m.exec(w.cloud))) { cover = Math.max(cover, map[hit[1]]); base = Math.min(base, parseInt(hit[2], 10) * 30.48); }
  if (/OVC|BKN/.test(w.cloud) === false && cover === 0 && w.ceilingFt) { cover = 0.75; base = w.ceilingFt * 0.3048; }
  const wet = w.precip === 'none' ? (w.runwayCondition === 'wet' ? 0.5 : 0) : w.precip === 'drizzle' ? 0.6 : 1;
  return { cloudCover: cover, cloudBaseM: Math.max(250, base), visM: Math.max(400, w.visM), wet, precip: w.precip };
}

const CLOUD_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime, uCover, uDay; uniform vec3 uTint; varying vec2 vUv; varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
  void main() {
    vec2 p = vWorld.xz * 0.00035 + vec2(uTime * 0.004, uTime * 0.0015);
    float n = fbm(p);
    float a = smoothstep(1.0 - uCover * 0.95 - 0.15, 1.0 - uCover * 0.95 + 0.25, n) * 0.85;
    vec3 col = uTint * (0.35 + 0.65 * uDay) * (0.75 + 0.35 * n);
    gl_FragColor = vec4(col, a);
  }`;
const CLOUD_VERT = /* glsl */ `varying vec2 vUv; varying vec3 vWorld; void main(){ vUv = uv; vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export function buildClouds(size: number): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
  const uniforms: Record<string, THREE.IUniform> = { uTime: { value: 0 }, uCover: { value: 0 }, uDay: { value: 1 }, uTint: { value: C('#d8dbe0') } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const geo = new THREE.PlaneGeometry(size, size, 1, 1); geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 50;
  return { mesh, uniforms };
}

/** Rain: a cheap streak field around the camera target (points with vertical motion). */
export function buildRain(count = 1800): { points: THREE.Points; update: (t: number, centre: THREE.Vector3, radius: number, on: number) => void } {
  const pos = new Float32Array(count * 3); const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) { pos[i * 3] = Math.random(); pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = Math.random(); seed[i] = Math.random(); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
  const mat = new THREE.PointsMaterial({ color: 0xbfc8d4, size: 1.6, transparent: true, opacity: 0.0, sizeAttenuation: true, depthWrite: false });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false;
  const update = (t: number, centre: THREE.Vector3, radius: number, on: number) => {
    mat.opacity = 0.45 * on; points.visible = on > 0.02; if (!points.visible) return;
    const arr = geo.getAttribute('position').array as Float32Array; const h = radius * 0.6;
    for (let i = 0; i < count; i++) {
      const fall = ((t * 0.9 + seed[i]) % 1);
      arr[i * 3] = centre.x + (pos[i * 3] - 0.5) * radius * 2; arr[i * 3 + 1] = centre.y + h * (1 - fall); arr[i * 3 + 2] = centre.z + (pos[i * 3 + 2] - 0.5) * radius * 2;
    }
    geo.getAttribute('position').needsUpdate = true;
  };
  return { points, update };
}

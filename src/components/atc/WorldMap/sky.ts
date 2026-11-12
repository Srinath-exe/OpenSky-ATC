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
// Physically based daylight (Preetham's analytic model: Rayleigh + Mie scattering, sun disc), tone-mapped inside the
// shader so the sky sits in the same range as the lit scene; a night sky (light-polluted horizon, stars that twinkle,
// a faint Milky Way, the moon); high cirrus that catches the sunset; overcast greys it all. The low cloud deck, cloud
// shadows and rain are drawn by the weather pass (atmosphere.ts), which has the scene depth.
const SKY_VERT = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
export const NOISE_GLSL = /* glsl */ `
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p) { float v = 0.0, a = 0.5; mat2 r = mat2(0.8, -0.6, 0.6, 0.8); for (int i = 0; i < OCT; i++) { v += a * vnoise(p); p = r * p * 2.03 + 17.1; a *= 0.5; } return v; }
`;
export const SCATTER_GLSL = /* glsl */ `
  const float PI = 3.141592653589793;
  const vec3 RAY = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
  const vec3 MIE = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
  // tone curve on the luminance only (keeps the hue: a per-channel curve turns a bright blue sky white)
  vec3 skyTone(vec3 x) { float l = dot(x, vec3(0.2126, 0.7152, 0.0722)); return min(x / (1.0 + l) * 1.4, vec3(1.0)); }
  // sky radiance toward dir (dir.y >= 0) for the sun at sd; also the extinction along the view (for the sun disc)
  vec3 scatter(vec3 dir, vec3 sd, float turb, float ray, float mieC, float g, out vec3 fex) {
    float sunE = 1000.0 * max(0.0, 1.0 - exp(-((1.6110731556870734 - acos(clamp(sd.y, -1.0, 1.0))) / 1.5)));
    float sunfade = 1.0 - clamp(1.0 - exp(sd.y), 0.0, 1.0);
    vec3 bR = RAY * (ray - (1.0 - sunfade));
    vec3 bM = 0.434 * (0.2 * turb) * 10E-18 * MIE * mieC;
    float za = acos(max(0.0, dir.y));
    float inv = 1.0 / (cos(za) + 0.15 * pow(93.885 - za * 180.0 / PI, -1.253));
    fex = exp(-(bR * 8.4E3 + bM * 1.25E3) * inv);
    float ct = dot(dir, sd);
    float rPh = 0.05968310365946075 * (1.0 + pow(ct * 0.5 + 0.5, 2.0));
    float g2 = g * g; float mPh = 0.07957747154594767 * (1.0 - g2) / pow(1.0 - 2.0 * g * ct + g2, 1.5);
    vec3 bT = (bR * rPh + bM * mPh) / (bR + bM);
    vec3 Lin = pow(sunE * bT * (1.0 - fex), vec3(1.5));
    Lin *= mix(vec3(1.0), pow(sunE * bT * fex, vec3(0.5)), clamp(pow(1.0 - sd.y, 5.0), 0.0, 1.0));
    vec3 t = (Lin + vec3(0.1) * fex) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    return pow(t, vec3(1.0 / (1.2 + 1.2 * sunfade)));
  }
`;
const SKY_FRAG = /* glsl */ `
  precision highp float;
  #define OCT 5
  uniform vec3 uSunDir, uMoonDir, uFog, uSunTint, uNightZen, uNightHor, uGlow;
  uniform float uTurb, uRay, uMieC, uMieG, uExposure, uCover, uNight, uTime, uCirrus, uFlash, uTwilight, uDay;
  uniform vec2 uWind;
  varying vec3 vDir;
  ${NOISE_GLSL}
  ${SCATTER_GLSL}
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec3 d = normalize(vDir); float y = d.y; float h = max(y, 0.0);
    vec3 dh = normalize(vec3(d.x, max(y, 0.0005), d.z));
    vec3 fex; vec3 c = skyTone(scatter(dh, uSunDir, uTurb, uRay, uMieC, uMieG, fex) * uExposure);
    c = max(mix(vec3(luma(c)), c, 1.2), 0.0);
    // night: deep blue zenith, the city's glow low on the horizon
    vec3 night = mix(uNightHor + uGlow * exp(-h * 14.0), uNightZen, pow(h, 0.5));
    // stars (twinkling, dimmed toward the horizon by the thicker air) and a faint band of the Milky Way
    vec3 sp = d * 420.0; vec3 cell = floor(sp); float sh = hash12(cell.xy + cell.z * 17.31);
    float star = step(0.9965, sh) * pow(hash12(cell.zx + 4.7), 6.0) * 2.6;
    vec3 f = fract(sp) - 0.5; star *= smoothstep(0.42, 0.0, length(f));
    star *= 0.65 + 0.35 * sin(uTime * (2.0 + sh * 9.0) + sh * 60.0);
    float band = exp(-pow(dot(d, normalize(vec3(0.45, 0.25, -0.86))) / 0.2, 2.0)) * (0.4 + 0.6 * fbm(d.xz / (d.y + 0.6) * 5.0));
    night += (vec3(star) * mix(vec3(0.8, 0.88, 1.0), vec3(1.0, 0.92, 0.8), hash12(cell.yz)) + vec3(0.010, 0.010, 0.014) * band) * smoothstep(0.02, 0.3, h) * (1.0 - uCover);
    // the moon: lit disc with maria, a soft halo
    float mc = dot(d, uMoonDir);
    float disc = smoothstep(0.99992, 0.99996, mc);
    vec2 mp = vec2(dot(d, normalize(cross(uMoonDir, vec3(0, 1, 0)))), d.y - uMoonDir.y) * 140.0;
    vec3 moon = vec3(0.85, 0.86, 0.9) * (0.75 + 0.25 * vnoise(mp * 3.0)) * disc * 0.9;
    night += moon * (1.0 - uCover * 0.9) + vec3(0.03, 0.035, 0.05) * pow(max(mc, 0.0), 900.0) * (1.0 - uCover * 0.6);
    c += night * uNight;
    // high cirrus: streaks that drift with the upper wind and take the colour of the low sun
    if (uCirrus > 0.0 && y > 0.0) {
      vec2 q = d.xz / (y + 0.06) * 1.4 + uWind * 0.00004;
      float n = fbm(vec2(q.x * 0.9 + q.y * 0.3, q.y * 3.2 - q.x * 0.4) * 0.8);
      float a = smoothstep(0.52, 0.85, n) * uCirrus * smoothstep(0.0, 0.18, y);
      vec3 ci = mix(vec3(0.82, 0.85, 0.9) * (0.25 + 0.75 * uDay), uSunTint * 1.25, uTwilight) + uNightHor * uNight;
      c = mix(c, ci, a * (0.25 + 0.6 * uDay + 0.5 * uTwilight));
    }
    // overcast: the sky goes to a soft grey of the same brightness
    vec3 grey = vec3(luma(c)) * vec3(0.96, 0.98, 1.02) * 0.85 + vec3(0.03) * uDay;
    c = mix(c, grey, uCover * 0.88);
    // the sun: a hot disc (bright enough for the cinematic bloom), extinguished by the air and the cloud
    // haze where the sky meets the ground, so the far terrain melts into it; below the horizon it is all haze
    c = mix(c, uFog, (1.0 - smoothstep(0.0, 0.07, y)) * 0.7);
    c = mix(c, uFog * (1.0 - 0.2 * smoothstep(0.0, 0.25, -y)), smoothstep(0.0, -0.012, y));
    float ct = dot(d, uSunDir);
    float sun = smoothstep(0.99990, 0.99994, ct) * smoothstep(-0.004, 0.002, y);
    c += uSunTint * fex * sun * 18.0 * (1.0 - uCover * 0.95);
    c += uSunTint * pow(max(ct, 0.0), 220.0) * 0.18 * (1.0 - uCover * 0.8);
    c += uFlash * vec3(0.55, 0.6, 0.75) * (0.4 + 0.6 * h);
    gl_FragColor = vec4(c, 1.0);
  }`;

export function buildSky(oct = 5): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
  const uniforms: Record<string, THREE.IUniform> = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, 0.5, 0.8).normalize() }, uFog: { value: C('#1a1a1c') }, uSunTint: { value: C('#ffd9a0') },
    uNightZen: { value: C('#02040b') }, uNightHor: { value: C('#0a0e1a') }, uGlow: { value: C('#17120f') },
    uTurb: { value: 3 }, uRay: { value: 3 }, uMieC: { value: 0.005 }, uMieG: { value: 0.8 }, uExposure: { value: 0.52 },
    uCover: { value: 0 }, uNight: { value: 0 }, uTime: { value: 0 }, uCirrus: { value: 0.5 }, uFlash: { value: 0 }, uTwilight: { value: 0 }, uDay: { value: 1 }, uWind: { value: new THREE.Vector2() },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG.replace('#define OCT 5', `#define OCT ${oct}`), side: THREE.BackSide, depthWrite: false, depthTest: false });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.frustumCulled = false; mesh.renderOrder = -1000;
  return { mesh, uniforms };
}

// the same model on the CPU, for the colour of the horizon in the direction the camera looks (the scene fog takes it,
// so far terrain fades into exactly the sky behind it)
const RAY = [5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5], MIE = [1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14];
function scatterCPU(dir: THREE.Vector3, sd: THREE.Vector3, turb: number, ray: number, mieC: number, g: number, exposure: number): THREE.Color {
  const sunE = 1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - Math.acos(Math.min(1, Math.max(-1, sd.y)))) / 1.5)));
  const sunfade = 1 - Math.min(1, Math.max(0, 1 - Math.exp(sd.y)));
  const za = Math.acos(Math.max(0, dir.y)); const inv = 1 / (Math.cos(za) + 0.15 * Math.pow(93.885 - za * 180 / Math.PI, -1.253));
  const ct = dir.dot(sd); const rPh = 0.05968310365946075 * (1 + Math.pow(ct * 0.5 + 0.5, 2));
  const g2 = g * g; const mPh = 0.07957747154594767 * (1 - g2) / Math.pow(1 - 2 * g * ct + g2, 1.5);
  const out = [0, 0, 0]; const k = Math.min(1, Math.max(0, Math.pow(1 - sd.y, 5)));
  for (let i = 0; i < 3; i++) {
    const bR = RAY[i] * (ray - (1 - sunfade)), bM = 0.434 * (0.2 * turb) * 10E-18 * MIE[i] * mieC;
    const fex = Math.exp(-(bR * 8.4E3 + bM * 1.25E3) * inv); const bT = (bR * rPh + bM * mPh) / (bR + bM);
    let Lin = Math.pow(sunE * bT * (1 - fex), 1.5); Lin *= 1 + (Math.pow(sunE * bT * fex, 0.5) - 1) * k;
    const t = (Lin + 0.1 * fex) * 0.04 + [0, 0.0003, 0.00075][i];
    out[i] = Math.pow(t, 1 / (1.2 + 1.2 * sunfade)) * exposure;
  }
  const l = out[0] * 0.2126 + out[1] * 0.7152 + out[2] * 0.0722;
  return new THREE.Color(...out.map((v) => Math.min(1, v / (1 + l) * 1.4)) as [number, number, number]);
}

export interface SkyState { L: Lighting; cover: number; vis: number; night: number; twilight: number; time: number; flash: number; wind: THREE.Vector2; cirrus: number }
const _dir = new THREE.Vector3();
/** Sets the sky-dome uniforms; returns the haze colour at the horizon toward `look` (xz) for the scene fog. */
export function applySky(u: Record<string, THREE.IUniform>, s: SkyState, look: THREE.Vector3): THREE.Color {
  const { L } = s;
  // clear air: low turbidity; haze and murk raise it (and whiten the sky); dusk gets a little extra for the colour
  const turb = 1.9 + 7 * (1 - Math.min(1, s.vis / 10000)) + 1.2 * s.twilight;
  const sd = L.elevation < -6 ? new THREE.Vector3(L.sunDir.x, Math.sin(L.elevation * Math.PI / 180), L.sunDir.z).normalize() : L.sunDir;
  // a high sun makes a bright sky: expose for it (tone-mapped near white it loses its blue); the low sun gets more
  u.uExposure.value = 0.5 + 0.45 * (1 - THREE.MathUtils.smoothstep(L.elevation, 0, 15));
  u.uSunDir.value.copy(sd); u.uTurb.value = turb; u.uCover.value = s.cover; u.uNight.value = s.night; u.uTime.value = s.time;
  u.uTwilight.value = s.twilight; u.uDay.value = L.day; u.uFlash.value = s.flash; u.uCirrus.value = s.cirrus; (u.uWind.value as THREE.Vector2).copy(s.wind);
  (u.uSunTint.value as THREE.Color).copy(L.sunColor);
  u.uMoonDir.value.set(-sd.x, Math.max(0.42, 0.3 - sd.y * 0.6), -sd.z - 0.2).normalize();
  // the horizon toward the camera's look, the same maths as the shader (scatter + night + overcast)
  _dir.set(look.x, 0, look.z); if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1); _dir.normalize(); _dir.y = 0.03; _dir.normalize();
  const c = scatterCPU(_dir, sd, turb, u.uRay.value as number, 0.005, 0.8, u.uExposure.value as number);
  const nh = (u.uNightHor.value as THREE.Color).clone().add((u.uGlow.value as THREE.Color).clone().multiplyScalar(Math.exp(-0.03 * 14)));
  c.add(nh.multiplyScalar(s.night));
  const l0 = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  c.setRGB(Math.max(0, l0 + (c.r - l0) * 1.2), Math.max(0, l0 + (c.g - l0) * 1.2), Math.max(0, l0 + (c.b - l0) * 1.2));
  const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  c.lerp(new THREE.Color(l * 0.96 * 0.85 + 0.03 * L.day, l * 0.98 * 0.85 + 0.03 * L.day, l * 1.02 * 0.85 + 0.03 * L.day), s.cover * 0.88);
  // murk: low visibility greys the haze
  const murk = 1 - Math.min(1, s.vis / 8000);
  c.lerp(new THREE.Color(0.32, 0.34, 0.36).multiplyScalar(0.15 + 0.85 * L.day), murk * 0.6);
  return c;
}

// ── weather ───────────────────────────────────────────────────────────────────
export interface WeatherLook { cloudCover: number; cloudBaseM: number; visM: number; wet: number; precip: WeatherState['precip']; storm: boolean; windDir: number; windKt: number }
export function weatherLook(w: WeatherState | null): WeatherLook {
  if (!w) return { cloudCover: 0.1, cloudBaseM: 1500, visM: 10000, wet: 0, precip: 'none', storm: false, windDir: 270, windKt: 8 };
  const m = /(FEW|SCT|BKN|OVC)(\d{3})/g; let cover = 0, base = 1500; let hit: RegExpExecArray | null;
  const map: Record<string, number> = { FEW: 0.15, SCT: 0.4, BKN: 0.75, OVC: 1 };
  while ((hit = m.exec(w.cloud))) { cover = Math.max(cover, map[hit[1]]); base = Math.min(base, parseInt(hit[2], 10) * 30.48); }
  if (/OVC|BKN/.test(w.cloud) === false && cover === 0 && w.ceilingFt) { cover = 0.75; base = w.ceilingFt * 0.3048; }
  const wet = w.precip === 'none' ? (w.runwayCondition === 'wet' ? 0.5 : 0) : w.precip === 'drizzle' ? 0.6 : 1;
  return { cloudCover: cover, cloudBaseM: Math.max(250, base), visM: Math.max(400, w.visM), wet, precip: w.precip, storm: /CB|TS/.test(w.cloud), windDir: w.windDirTrue, windKt: w.windKt };
}

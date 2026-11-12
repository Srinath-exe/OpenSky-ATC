/*
  Art-style experiment for the world map: one post pass that re-draws the rendered frame in a different style, from the
  colour and the scene depth (edges from depth and colour discontinuities). Not wired to the UI: window.__worldStyle(n)
  turns it on for screenshots (0 = off). Styles: 1 anime cel, 2 blueprint, 3 16-bit pixel art, 4 watercolour,
  5 neon synthwave, 6 cinematic.
*/
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const FRAG = /* glsl */ `
uniform sampler2D tDiffuse, tDepth; uniform vec2 uRes; uniform float uNear, uFar, uTime, uNight, uDusk; uniform int uStyle;
varying vec2 vUv;
// the frame arrives in linear light (before tone mapping and sRGB): style it as it will look on screen, then hand it back
vec3 toS(vec3 c) { c = c / (1.0 + c * 0.15); return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 toL(vec3 c) { c = pow(max(c, 0.0), vec3(2.2)); return c / max(1.0 - c * 0.15, 0.2); }
float rawZ(vec2 uv) { return texture2D(tDepth, uv).x; }
float lin(vec2 uv) { float z = rawZ(uv) * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 col(vec2 uv) { return toS(texture2D(tDiffuse, uv).rgb); }
float near(vec2 uv) { return 1.0 - smoothstep(2500.0, 7000.0, lin(uv)); }   // outlines fade out toward the horizon
bool sky(vec2 uv) { return rawZ(uv) > 0.99999; }
float edgeD(vec2 uv, float s) {
  vec2 p = s / uRes; float d = lin(uv);
  float dx = abs(lin(uv + vec2(p.x, 0.0)) - lin(uv - vec2(p.x, 0.0)));
  float dy = abs(lin(uv + vec2(0.0, p.y)) - lin(uv - vec2(0.0, p.y)));
  return clamp((dx + dy) / max(d, 1.0) * 9.0, 0.0, 1.0) * near(uv);
}
float edgeC(vec2 uv, float s) {
  vec2 p = s / uRes;
  float tl = luma(col(uv + p * vec2(-1, 1))), t = luma(col(uv + p * vec2(0, 1))), tr = luma(col(uv + p * vec2(1, 1)));
  float l = luma(col(uv + p * vec2(-1, 0))), r = luma(col(uv + p * vec2(1, 0)));
  float bl = luma(col(uv + p * vec2(-1, -1))), b = luma(col(uv + p * vec2(0, -1))), br = luma(col(uv + p * vec2(1, -1)));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl), gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  return clamp(length(vec2(gx, gy)) * 1.4, 0.0, 1.0) * near(uv);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
vec3 sat(vec3 c, float k) { float l = luma(c); return mix(vec3(l), c, k); }
float bayer(vec2 p) { int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0)); int i = x + y * 4;
  float m[16]; m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
  for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0 - 0.5; return 0.0; }
// a painted sky for the stylised looks: day blue, dusk orange to violet, night deep blue with stars
vec3 paintSky(vec2 uv) {
  float h = clamp((uv.y - 0.55) / 0.45, 0.0, 1.0);
  vec3 day = mix(vec3(0.85, 0.93, 1.0), vec3(0.32, 0.6, 0.95), h);
  vec3 dusk = mix(mix(vec3(1.0, 0.62, 0.35), vec3(0.95, 0.42, 0.5), smoothstep(0.0, 0.4, h)), vec3(0.28, 0.2, 0.48), smoothstep(0.35, 1.0, h));
  vec3 night = mix(vec3(0.1, 0.13, 0.28), vec3(0.02, 0.03, 0.1), h);
  vec2 sp = floor(uv * uRes / 3.0); night += step(0.9975, hash(sp)) * (0.6 + 0.4 * hash(sp + 7.0)) * h;
  return uNight > 0.5 ? night : uDusk > 0.5 ? dusk : day;
}

void main() {
  vec2 uv = vUv; vec3 c = col(uv); vec3 o = c; bool isSky = sky(uv);
  float lights = smoothstep(0.82, 0.98, luma(c)) * (1.0 - uDusk * 0.0);
  if (uStyle == 1) {   // anime: saturated flat tones, ink lines, a painted sky, lights that sparkle
    vec3 s = sat(c, 1.55) * (1.05 + uNight * 0.25); float l = luma(s);
    float q = floor(l * 4.0 + 0.5) / 4.0; s *= mix(1.0, (q + 0.05) / (l + 0.05), 0.85);
    s = mix(s, s * vec3(1.06, 0.98, 1.12), 0.5);
    float e = max(edgeD(uv, 1.4), edgeC(uv, 1.0) * 0.7);
    o = mix(s, vec3(0.06, 0.05, 0.12), smoothstep(0.3, 0.6, e) * 0.9);
    o += lights * vec3(1.0, 0.95, 0.8) * 0.6;
    if (isSky) o = paintSky(uv);
  } else if (uStyle == 2) {   // blueprint: white linework on drafting blue; at night the lights are drawn in amber
    vec3 bg = mix(mix(vec3(0.1, 0.3, 0.58), vec3(0.12, 0.22, 0.45), uDusk), vec3(0.03, 0.08, 0.2), uNight);
    vec2 g = fract(uv * uRes / 36.0); float grid = max(step(0.965, g.x), step(0.965, g.y)) * 0.1;
    float line = max(edgeD(uv, 1.0) * 1.3, edgeC(uv, 1.0));
    o = bg + grid + luma(c) * 0.08;
    o = mix(o, vec3(0.88, 0.96, 1.0), smoothstep(0.12, 0.45, line));
    o += lights * mix(vec3(0.7, 0.9, 1.0), vec3(1.0, 0.8, 0.4), uNight) * 0.9;
    if (isSky) o = bg * 0.85 + grid;
  } else if (uStyle == 3) {   // 16-bit pixel art: chunky pixels, few colours, ordered dither, banded sky
    float B = 4.0; vec2 cell = floor(uv * uRes / B); vec2 uq = (cell + 0.5) * B / uRes;
    vec3 s = sat(col(uq), 1.35) * (1.0 + uNight * 0.35); float lv = 6.0;
    if (sky(uq)) s = paintSky(uq);
    s = floor(s * lv + 0.5 + bayer(cell) * 0.85) / lv;
    float e = edgeD(uq, B * 0.8);
    o = mix(s, vec3(0.1, 0.07, 0.16), step(0.45, e) * 0.85);
  } else if (uStyle == 4) {   // watercolour: Kuwahara smoothing, pigment pooled at the edges, paper grain, soft light
    vec2 p = 1.0 / uRes; vec3 m[4]; vec3 s2[4]; for (int k = 0; k < 4; k++) { m[k] = vec3(0); s2[k] = vec3(0); }
    for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
      vec3 v = col(uv + vec2(float(i), float(j)) * p * 1.7);
      if (i <= 0 && j <= 0) { m[0] += v; s2[0] += v * v; } if (i >= 0 && j <= 0) { m[1] += v; s2[1] += v * v; }
      if (i <= 0 && j >= 0) { m[2] += v; s2[2] += v * v; } if (i >= 0 && j >= 0) { m[3] += v; s2[3] += v * v; }
    }
    float best = 1e9; vec3 k = c;
    for (int q = 0; q < 4; q++) { vec3 mu = m[q] / 16.0; vec3 vr = abs(s2[q] / 16.0 - mu * mu); float vv = vr.r + vr.g + vr.b; if (vv < best) { best = vv; k = mu; } }
    vec3 s = sat(k, 1.15) * (1.08 + uNight * 0.3);
    if (isSky) s = mix(paintSky(uv), vec3(1.0), 0.15);
    float e = edgeC(uv, 2.0); s *= 1.0 - e * 0.45;
    float paper = noise(uv * uRes / 2.5) * 0.5 + noise(uv * uRes / 35.0) * 0.5;
    vec3 tint = mix(vec3(1.0, 0.97, 0.9), vec3(0.85, 0.87, 0.98), uNight);
    o = s * tint * (0.88 + 0.16 * paper);
    float vig = smoothstep(0.98, 0.6, length(uv - 0.5) * 1.3); o = mix(mix(tint, o, 0.4), o, vig);
  } else if (uStyle == 5) {   // neon synthwave: dark world, glowing edges by distance, scanlines, sunset grid sky
    float d = clamp(lin(uv) / 5000.0, 0.0, 1.0);
    float e = 0.0; for (int k = 0; k < 8; k++) { float a = float(k) * 0.785; e += edgeD(uv + vec2(cos(a), sin(a)) * 3.0 / uRes, 1.0); } e /= 8.0;
    float e0 = max(edgeD(uv, 1.0), edgeC(uv, 1.0) * 0.6);
    vec3 neon = mix(vec3(1.0, 0.2, 0.78), vec3(0.15, 0.92, 1.0), d);
    float base = mix(0.32, 0.12, uNight);
    o = c * vec3(0.55, 0.4, 0.85) * base + neon * (smoothstep(0.2, 0.6, e0) * 1.1 + e * 0.9);
    o += lights * c * 1.1;
    if (isSky) { float h = clamp((uv.y - 0.55) / 0.45, 0.0, 1.0); o = mix(mix(vec3(1.0, 0.35, 0.55), vec3(0.95, 0.6, 0.2), uDusk), vec3(0.08, 0.02, 0.18), smoothstep(0.0, 0.7, h)) * mix(1.0, 0.55, uNight); }
    o *= 0.87 + 0.13 * sin(uv.y * uRes.y * 3.14159);
  } else if (uStyle == 6) {   // cinematic: bloom, teal/orange grade, contrast, vignette, grain
    vec3 bl = vec3(0); for (int k = 0; k < 12; k++) { float a = float(k) * 0.5236; for (int r = 1; r <= 3; r++) bl += max(col(uv + vec2(cos(a), sin(a)) * float(r) * 7.0 / uRes) - 0.62, 0.0); } bl /= 36.0;
    vec3 s = c + bl * 1.8;
    float l = luma(s); s = mix(s * vec3(0.9, 1.0, 1.1), s * vec3(1.12, 1.0, 0.86), smoothstep(0.15, 0.7, l));
    s = (s - 0.45) * 1.1 + 0.47; s = sat(s, 1.1) * (1.0 + uNight * 0.15);
    s *= smoothstep(1.1, 0.35, length(uv - 0.5) * 1.25) * 0.3 + 0.7;
    s += (hash(uv * uRes + uTime) - 0.5) * 0.03;
    o = s;
  }
  gl_FragColor = vec4(toL(clamp(o, 0.0, 1.0)), 1.0);
}`;

export class StylePass extends Pass {
  private quad: FullScreenQuad;
  private mat: THREE.ShaderMaterial;
  style = 0;
  depthFrom: (() => THREE.Texture | null) | null = null;
  constructor(private camera: THREE.PerspectiveCamera) {
    super();
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 1 }, uFar: { value: 1000 }, uTime: { value: 0 }, uNight: { value: 0 }, uDusk: { value: 0 }, uStyle: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
    this.needsSwap = true;
  }
  /** The time of day the sky is painted for (0 day, 1 dusk, 2 night). */
  setTime(t: number): void { this.mat.uniforms.uNight.value = t === 2 ? 1 : 0; this.mat.uniforms.uDusk.value = t === 1 ? 1 : 0; }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const u = this.mat.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.tDepth.value = this.depthFrom?.() ?? readBuffer.depthTexture; u.uRes.value.set(readBuffer.width, readBuffer.height);
    u.uNear.value = this.camera.near; u.uFar.value = this.camera.far; u.uTime.value = performance.now() / 1000; u.uStyle.value = this.style;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.quad.render(renderer);
  }
}

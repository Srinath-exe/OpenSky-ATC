/*
  The weather over the world map, drawn as one pass over the rendered frame (it needs the scene depth): the low cloud
  deck from the ATIS cloud group - seen from below as a lit ceiling, from above as a broken white layer the airfield
  shows through - with its shadows drifting across the ground under the sun, rain and snow, and lightning in a storm.
  Everything moves with the wind. The sky above the deck (scattering, cirrus, stars) is the dome in sky.ts.
*/
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { NOISE_GLSL } from './sky';

const FRAG = /* glsl */ `
  precision highp float;
  #define OCT 5
  uniform sampler2D tDiffuse, tDepth; uniform mat4 uInvProj, uCamWorld; uniform vec3 uCamPos, uSunDir, uSunCol, uAmb, uHaze;
  uniform float uDeck, uCover, uShadow, uVeil, uRain, uSnow, uTime, uSlant, uFlash, uHazeFar, uDpr, uDay, uSun;
  uniform vec2 uWind;
  varying vec2 vUv;
  ${NOISE_GLSL}
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  // cumulus at the deck: cells ~2.5 km, the coverage from the METAR (FEW 0.15 .. OVC 1)
  float cloudD(vec2 p) {
    vec2 q = (p + uWind) / 2600.0;
    float n = fbm(q) * 0.82 + vnoise(q * 7.3 + 3.7) * 0.18;
    float th = mix(0.7, 0.2, uCover);
    return smoothstep(th, th + 0.17, n);
  }
  float streaks(vec2 px, float w, float sp, float seed, float slant) {
    px.x += px.y * slant; vec2 p = px / vec2(w, w * 12.0); p.y += uTime * sp;
    vec2 id = floor(p), f = fract(p); float r = hash12(id + seed);
    float line = smoothstep(0.09, 0.0, abs(f.x - 0.15 - 0.7 * r));
    return line * smoothstep(0.0, 0.3, f.y) * smoothstep(1.0, 0.6, f.y) * step(0.72, hash12(id + seed + 9.1));
  }
  float flakes(vec2 px, float w, float sp, float seed) {
    vec2 p = px / w; p.y += uTime * sp; p.x += sin(uTime * 0.8 + p.y * 0.35 + seed) * 0.6;
    vec2 id = floor(p), f = fract(p) - 0.5; float r = hash12(id + seed);
    vec2 o = vec2(hash12(id + seed + 3.1), hash12(id + seed + 5.7)) - 0.5;
    return smoothstep(0.16, 0.04, length(f - o * 0.6)) * step(0.55, r);
  }
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb; float z = texture2D(tDepth, vUv).x; bool sky = z > 0.99999;
    vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0); v /= v.w; vec3 W = (uCamWorld * v).xyz;
    vec3 ray = W - uCamPos; float dist = sky ? 1e7 : length(ray); vec3 dir = normalize(ray);
    // cloud shadows on everything under the deck
    if (!sky && uShadow > 0.0 && uSunDir.y > 0.04 && W.y < uDeck) {
      float s = cloudD(W.xz + uSunDir.xz / uSunDir.y * (uDeck - W.y));
      c *= 1.0 - s * uShadow;
    }
    // the deck, where the view ray crosses it before it hits anything
    if (uCover > 0.01 && abs(dir.y) > 1e-4) {
      float t = (uDeck - uCamPos.y) / dir.y;
      if (t > 0.0 && t < dist) {
        vec2 P = uCamPos.xz + dir.xz * t;
        float d = cloudD(P);
        if (d > 0.002) {
          bool below = uCamPos.y < uDeck;
          vec2 toSun = normalize(uSunDir.xz + 1e-4);
          float ls = cloudD(P + toSun * 380.0) * 0.6 + cloudD(P + toSun * 1000.0) * 0.4;
          float lit = exp(-ls * 2.0) * uSun;
          vec3 col;
          if (below) {   // the underside: thick centres dark, thin edges glowing where the sun shines through
            float thin = 1.0 - d;
            col = uAmb * (0.5 + 0.5 * thin) + uSunCol * thin * (0.12 + 0.3 * lit);
            col += uSunCol * pow(max(dot(dir, uSunDir), 0.0), 6.0) * thin * 0.9 * uSun;
          } else {       // the tops in sunlight, the sides away from the sun in their own shade
            col = uAmb * 0.75 + uSunCol * (0.25 + 0.75 * lit) * (0.55 + 0.45 * max(uSunDir.y, 0.0));
          }
          col = mix(col, uHaze, 1.0 - exp(-t / uHazeFar));
          float a = d * (below ? 0.97 : uVeil) * (below ? 1.0 : smoothstep(9000.0, 1500.0, t) * 0.6 + 0.4);
          c = mix(c, col, clamp(a, 0.0, 1.0));
        }
      }
    }
    // precipitation in screen space: three layers of streaks (near ones bigger, faster), slanted by the wind
    vec2 px = gl_FragCoord.xy / uDpr;
    vec3 lightC = uAmb * 1.6 + uSunCol * 0.25 + vec3(0.04);
    if (uRain > 0.0) {
      float r = streaks(px, 7.0, 3.4, 1.0, uSlant) * 0.5 + streaks(px, 11.0, 2.6, 7.0, uSlant * 0.9) * 0.35 + streaks(px * 0.8, 17.0, 1.9, 13.0, uSlant * 0.8) * 0.25;
      c = mix(c, c * 0.82 + uHaze * 0.12, uRain * 0.5);
      c += lightC * r * uRain * 0.32;
    }
    if (uSnow > 0.0) {
      float s = flakes(px, 22.0, 2.2, 1.0) * 0.8 + flakes(px, 34.0, 1.5, 5.0) + flakes(px, 14.0, 3.0, 9.0) * 0.6;
      c = mix(c, c * 0.85 + uHaze * 0.15, uSnow * 0.4);
      c += (lightC * 1.3 + 0.05) * s * uSnow * 0.7;
    }
    c += uFlash * vec3(0.5, 0.55, 0.7) * (sky ? 0.5 : 0.18);
    gl_FragColor = vec4(c, 1.0);
  }`;

export interface WeatherUniforms { deck: number; cover: number; shadow: number; veil: number; rain: number; snow: number; slant: number; flash: number; hazeFar: number; day: number; sun: number }

export class WeatherPass extends Pass {
  private quad: FullScreenQuad;
  readonly mat: THREE.ShaderMaterial;
  /** Reads the scene pass's colour and depth (it is the first pass after it, and always on: it is the copy into the chain). */
  constructor(private camera: THREE.PerspectiveCamera, private src: ScenePass, oct = 5) {
    super();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.5, 0.5, 0.5) }, uHaze: { value: new THREE.Color(0.6, 0.65, 0.7) },
        uDeck: { value: 1500 }, uCover: { value: 0 }, uShadow: { value: 0 }, uVeil: { value: 0.6 }, uRain: { value: 0 }, uSnow: { value: 0 }, uTime: { value: 0 }, uSlant: { value: 0.15 },
        uFlash: { value: 0 }, uHazeFar: { value: 30000 }, uDpr: { value: 1 }, uDay: { value: 1 }, uSun: { value: 1 }, uWind: { value: new THREE.Vector2() },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: FRAG.replace('#define OCT 5', `#define OCT ${oct}`), depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  set(v: Partial<WeatherUniforms>): void {
    const u = this.mat.uniforms;
    for (const [k, val] of Object.entries(v)) { const key = `u${k[0].toUpperCase()}${k.slice(1)}`; if (u[key]) u[key].value = val; }
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    const u = this.mat.uniforms;
    u.tDiffuse.value = this.src.rt.texture; u.tDepth.value = this.src.rt.depthTexture;
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse); u.uCamWorld.value.copy(this.camera.matrixWorld); u.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    u.uDpr.value = renderer.getPixelRatio();
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.quad.render(renderer);
  }
  dispose(): void { this.mat.dispose(); this.quad.dispose(); }
}

/** The scene, drawn into its own target with a depth texture. The post passes read that depth while they write the
 *  composer's buffers, which carry none: no pass ever samples the depth attached to the target it draws into. */
export class ScenePass extends Pass {
  readonly rt: THREE.WebGLRenderTarget;
  constructor(private scene: THREE.Scene, private camera: THREE.Camera, w: number, h: number) {
    super(); this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType) });
  }
  setSize(w: number, h: number): void { this.rt.setSize(Math.max(1, w), Math.max(1, h)); }
  render(renderer: THREE.WebGLRenderer): void { renderer.setRenderTarget(this.rt); renderer.clear(); renderer.render(this.scene, this.camera); }
  dispose(): void { this.rt.dispose(); }
}

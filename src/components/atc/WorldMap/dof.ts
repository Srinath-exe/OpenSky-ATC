/*
  Tilt-shift depth of field for the world map, cheap enough for integrated and mobile GPUs.

  The airfield is always sharp; everything outside a circle around it (far terrain, the city, the bay, the horizon)
  softens with its horizontal distance from the field - decided per pixel from the scene depth the main pass already
  wrote (the composer's render target carries a depth texture), unprojected to a world position.

  Cost: the scene colour is downsampled to a quarter of the resolution, blurred there with a separable 9-tap Gaussian
  (two passes at 1/16 of the pixels), and composited back at full resolution with one depth tap and two colour taps -
  about a fifth of the stock BokehPass (41 taps per pixel plus a second full scene render for the depth), and smoother.
*/
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const COPY = { uniforms: { tDiffuse: { value: null as THREE.Texture | null } }, vertexShader: VERT, fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }` };
const BLUR = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uDir: { value: new THREE.Vector2(1, 0) } },
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;
    // 9-tap Gaussian (sigma ~2.2 px) with the linear-sampling trick: 5 fetches
    void main(){
      vec4 c = texture2D(tDiffuse, vUv) * 0.2270270270;
      c += texture2D(tDiffuse, vUv + uDir * 1.3846153846) * 0.3162162162;
      c += texture2D(tDiffuse, vUv - uDir * 1.3846153846) * 0.3162162162;
      c += texture2D(tDiffuse, vUv + uDir * 3.2307692308) * 0.0702702703;
      c += texture2D(tDiffuse, vUv - uDir * 3.2307692308) * 0.0702702703;
      gl_FragColor = c;
    }`,
};
const COMPOSITE = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null }, tBlur: { value: null as THREE.Texture | null }, tDepth: { value: null as THREE.Texture | null },
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    uField: { value: new THREE.Vector3(0, 0, 3000) },   // field centre x, z and radius (m)
    uRamp: { value: 1400 },                               // metres past the field radius to reach the full blur
  },
  vertexShader: VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tBlur, tDepth; uniform mat4 uInvProj, uCamWorld; uniform vec3 uField; uniform float uRamp; varying vec2 vUv;
    void main(){
      float depth = texture2D(tDepth, vUv).x;
      vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 view = uInvProj * clip; view /= view.w;
      vec3 world = (uCamWorld * vec4(view.xyz, 1.0)).xyz;
      float f = clamp((distance(world.xz, uField.xy) - uField.z) / uRamp, 0.0, 1.0);
      f = f * f * (3.0 - 2.0 * f);
      gl_FragColor = mix(texture2D(tDiffuse, vUv), texture2D(tBlur, vUv), f);
    }`,
};

export class TiltShiftPass extends Pass {
  private rtHalf: THREE.WebGLRenderTarget;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private copy: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private comp: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  /** Composite uniforms: set uField / uInvProj / uCamWorld per frame. */
  uniforms: typeof COMPOSITE.uniforms;
  constructor(private camera: THREE.PerspectiveCamera) {
    super();
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rtHalf = new THREE.WebGLRenderTarget(1, 1, opts); this.rtA = new THREE.WebGLRenderTarget(1, 1, opts); this.rtB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.copy = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(COPY.uniforms), vertexShader: COPY.vertexShader, fragmentShader: COPY.fragmentShader, depthTest: false, depthWrite: false });
    this.blur = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(BLUR.uniforms), vertexShader: BLUR.vertexShader, fragmentShader: BLUR.fragmentShader, depthTest: false, depthWrite: false });
    this.comp = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(COMPOSITE.uniforms) as typeof COMPOSITE.uniforms, vertexShader: COMPOSITE.vertexShader, fragmentShader: COMPOSITE.fragmentShader, depthTest: false, depthWrite: false });
    this.uniforms = this.comp.uniforms as typeof COMPOSITE.uniforms;
    this.quad = new FullScreenQuad(this.comp);
    this.needsSwap = true;
  }
  setSize(width: number, height: number): void {
    this.rtHalf.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.rtA.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2)); this.rtB.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const depth = readBuffer.depthTexture;
    const oldAutoClear = renderer.autoClear; renderer.autoClear = false;
    if (!depth) {   // no depth to decide from: pass the picture through
      this.quad.material = this.copy; this.copy.uniforms.tDiffuse.value = readBuffer.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.quad.render(renderer); renderer.autoClear = oldAutoClear; return;
    }
    // 1. downsample twice (linear filtering boxes 2x2 each step)
    this.quad.material = this.copy; this.copy.uniforms.tDiffuse.value = readBuffer.texture; renderer.setRenderTarget(this.rtHalf); this.quad.render(renderer);
    this.copy.uniforms.tDiffuse.value = this.rtHalf.texture; renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
    // 2. separable blur at quarter resolution (taps 1.5 px apart: a wide, soft blur once upsampled)
    const qw = this.rtA.width, qh = this.rtA.height;
    this.quad.material = this.blur;
    this.blur.uniforms.tDiffuse.value = this.rtA.texture; this.blur.uniforms.uDir.value.set(1.5 / qw, 0); renderer.setRenderTarget(this.rtB); this.quad.render(renderer);
    this.blur.uniforms.tDiffuse.value = this.rtB.texture; this.blur.uniforms.uDir.value.set(0, 1.5 / qh); renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
    // 3. composite at full resolution by the world distance outside the field
    this.quad.material = this.comp;
    this.uniforms.tDiffuse.value = readBuffer.texture; this.uniforms.tBlur.value = this.rtA.texture; this.uniforms.tDepth.value = depth;
    this.uniforms.uInvProj.value.copy(this.camera.projectionMatrixInverse); this.uniforms.uCamWorld.value.copy(this.camera.matrixWorld);
    if (this.renderToScreen) { renderer.setRenderTarget(null); this.quad.render(renderer); }
    else { renderer.setRenderTarget(writeBuffer); renderer.clear(); this.quad.render(renderer); }
    renderer.autoClear = oldAutoClear;
  }
  dispose(): void {
    this.rtHalf.dispose(); this.rtA.dispose(); this.rtB.dispose();
    this.copy.dispose(); this.blur.dispose(); this.comp.dispose(); this.quad.dispose();
  }
}

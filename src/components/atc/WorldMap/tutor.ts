/*
  The tutorial's layer on the 3D map: a cleared route lit taxiway by taxiway as it is named (green centreline lights,
  the way a real field "follows the greens", each stretch tagged with its taxiway's location sign), markers on the
  ground (a hold line, an aircraft that is calling), and camera moves. Driven by window events from the coach
  (src/game/Tutorial), so the map never depends on the tutorial.
*/
import * as THREE from 'three'
import { toV3 } from './terrain'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import type { Cue } from '@/game/Tutorial/lessons'

export const TUTOR_EVENT = 'atc:tutor'
/** True while a 3D map is mounted and listening (the coach waits for it before its first cues). */
let listening = 0
export const mapListening = () => listening > 0
export function markListening(on: boolean): void { listening = Math.max(0, listening + (on ? 1 : -1)) }
export function sendCue(c: Cue): void { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TUTOR_EVENT, { detail: c })) }

type XY = { x: number; y: number }
type CameraCue = Extract<Cue, { kind: 'camera' }>

const VERT = /* glsl */ `
attribute float aOn;
uniform float uTime, uScale, uPx;
varying float vA, vFlash;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float age = uTime - aOn;
  vA = smoothstep(0.0, 220.0, age);
  vFlash = exp(-max(age, 0.0) / 380.0) * step(0.0, age);
  gl_PointSize = clamp(uScale * 9.0 / -mv.z, 4.0, 11.0) * uPx * (1.0 + vFlash * 0.9);
}`
const FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA, vFlash;
void main() {
  vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0;
  float core = smoothstep(1.0, 0.25, r);
  float a = core * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), vFlash * 0.6 + smoothstep(0.5, 0.0, r) * 0.35) * a, a);
}`

interface RouteFx { points: THREE.Points; mat: THREE.ShaderMaterial; t0: number; tags: Array<{ el: HTMLDivElement; pos: THREE.Vector3; at: number }>; bands: Array<{ line: Line2; mat: LineMaterial; at: number }> }
interface MarkFx { ring: THREE.Mesh; el: HTMLDivElement; pos: THREE.Vector3; t0: number }

export class TutorLayer {
  readonly group = new THREE.Group()
  private routes = new Map<string, RouteFx>()
  private marks = new Map<string, MarkFx>()
  /** A camera move for the map to run (it owns the camera). */
  onCamera: (c: CameraCue) => void = () => {}

  constructor(private labelsEl: HTMLElement, private heightAt: (x: number, y: number) => number, private pixelRatio: () => number) {
    this.group.renderOrder = 40
  }

  get active(): boolean { return this.routes.size > 0 || this.marks.size > 0 }

  cue(c: Cue, now: number): void {
    if (c.kind === 'camera') { this.onCamera(c); return }
    if (c.kind === 'clear') { if (c.id) { this.dropRoute(c.id); this.dropMark(c.id) } else { for (const k of [...this.routes.keys()]) this.dropRoute(k); for (const k of [...this.marks.keys()]) this.dropMark(k) } return }
    if (c.kind === 'route') { this.dropRoute(c.id); this.addRoute(c, now); return }
    if (c.kind === 'mark') { this.dropMark(c.id); this.addMark(c, now) }
  }

  private v3(p: XY, lift: number): THREE.Vector3 { return toV3(p.x, p.y, this.heightAt(p.x, p.y) + lift) }

  private addRoute(c: Extract<Cue, { kind: 'route' }>, now: number): void {
    const pts = c.pts; if (pts.length < 2) return
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
    const at = (s: number): XY => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const k = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k } }
    const total = cum[cum.length - 1]
    const legs = c.legs.length ? c.legs : [{ name: '', s0: 0, s1: total, delayMs: 300 }]
    const pos: number[] = [], on: number[] = []
    // a light every 12 m; each stretch sweeps on from its start as its name is said
    for (let s = 0; s <= total; s += 12) {
      const leg = legs.find(l => s >= l.s0 - 0.01 && s <= l.s1 + 0.01) ?? legs[legs.length - 1]
      const p = this.v3(at(s), 1.2); pos.push(p.x, p.y, p.z)
      on.push(leg.delayMs + ((s - leg.s0) / Math.max(1, leg.s1 - leg.s0)) * 650)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aOn', new THREE.Float32BufferAttribute(on, 1))
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uScale: { value: 900 }, uPx: { value: this.pixelRatio() }, uColor: { value: new THREE.Color(c.color ?? '#3bea7a') } } })
    const points = new THREE.Points(g, mat); points.frustumCulled = false; points.renderOrder = 41
    this.group.add(points)
    // a soft green band under the lights, one per stretch, fading in as it is named (screen-space width: reads from far)
    const bands = legs.map(l => {
      const q: number[] = []; for (let s = l.s0; s <= l.s1 + 0.01; s += 6) { const p = this.v3(at(Math.min(s, l.s1)), 0.8); q.push(p.x, p.y, p.z) }
      if (q.length < 6) { const p = this.v3(at(l.s1), 0.8); q.push(p.x, p.y, p.z) }
      const lg = new LineGeometry(); lg.setPositions(q)
      const mat = new LineMaterial({ color: new THREE.Color(c.color ?? '#3bea7a').getHex(), linewidth: 7, transparent: true, opacity: 0, depthWrite: false })
      const line = new Line2(lg, mat); line.renderOrder = 40; line.frustumCulled = false; this.group.add(line)
      return { line, mat, at: l.delayMs }
    })
    // the taxiway's location sign at the start of each named stretch (yellow on black, as on the field)
    const tags = legs.filter(l => l.name).map(l => {
      const el = document.createElement('div'); el.className = 'tutorTag'; el.textContent = l.name; el.style.display = 'none'
      this.labelsEl.appendChild(el)
      return { el, pos: this.v3(at(Math.min(l.s1, l.s0 + Math.min(80, (l.s1 - l.s0) * 0.4))), 6), at: l.delayMs }
    })
    this.routes.set(c.id, { points, mat, t0: now, tags, bands })
  }
  private dropRoute(id: string): void {
    const r = this.routes.get(id); if (!r) return
    this.group.remove(r.points); r.points.geometry.dispose(); r.mat.dispose(); for (const t of r.tags) t.el.remove()
    for (const b of r.bands) { this.group.remove(b.line); b.line.geometry.dispose(); b.mat.dispose() }
    this.routes.delete(id)
  }

  private addMark(c: Extract<Cue, { kind: 'mark' }>, now: number): void {
    const col = c.tone === 'stop' ? 0xff4a3a : c.tone === 'go' ? 0x3bea7a : 0xffffff
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 64), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }))
    ring.rotation.x = -Math.PI / 2; const p = this.v3(c.at, 1.5); ring.position.copy(p); ring.renderOrder = 42
    this.group.add(ring)
    const el = document.createElement('div'); el.className = `tutorMark tutorMark-${c.tone}`; el.textContent = c.label; el.style.display = 'none'
    this.labelsEl.appendChild(el)
    this.marks.set(c.id, { ring, el, pos: this.v3(c.at, 14), t0: now })
  }
  private dropMark(id: string): void {
    const m = this.marks.get(id); if (!m) return
    this.group.remove(m.ring); m.ring.geometry.dispose(); (m.ring.material as THREE.Material).dispose(); m.el.remove(); this.marks.delete(id)
  }

  /** Per frame: light timing, ring pulse, tags and marker labels placed on screen. */
  update(now: number, camera: THREE.PerspectiveCamera, w: number, h: number, camDist: number): void {
    const v = new THREE.Vector3()
    const place = (el: HTMLDivElement, p: THREE.Vector3, show: boolean) => {
      if (!show) { el.style.display = 'none'; return }
      v.copy(p).project(camera)
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { el.style.display = 'none'; return }
      el.style.display = ''; el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`
    }
    for (const r of this.routes.values()) {
      const t = now - r.t0; r.mat.uniforms.uTime.value = t; r.mat.uniforms.uScale.value = h * 0.9; r.mat.uniforms.uPx.value = this.pixelRatio()
      for (const tag of r.tags) place(tag.el, tag.pos, t >= tag.at)
      for (const b of r.bands) { b.mat.resolution.set(w, h); b.mat.opacity = 0.34 * Math.min(1, Math.max(0, (t - b.at) / 500)) }
    }
    for (const m of this.marks.values()) {
      const t = (now - m.t0) / 1000; const base = Math.max(18, camDist * 0.035)
      const k = (t % 1.6) / 1.6
      m.ring.scale.setScalar(base * (0.7 + k * 0.8)); (m.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k)
      place(m.el, m.pos, true)
    }
  }

  dispose(): void { for (const k of [...this.routes.keys()]) this.dropRoute(k); for (const k of [...this.marks.keys()]) this.dropMark(k) }
}

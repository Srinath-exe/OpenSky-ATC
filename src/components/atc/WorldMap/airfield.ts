/*
  The airfield itself: pavement (asphalt runways and taxiways with shoulders, concrete aprons), painted markings to the
  FAA / ICAO precision-runway layout (threshold bars, designators, centreline, aiming points, touchdown zone, side stripes,
  taxiway centrelines, runway holding positions) and the airfield lighting (runway edge / centreline / touchdown zone /
  threshold / end lights, approach lighting with sequenced flashers, PAPIs, taxiway edge and centreline lights, runway
  guard lights). Everything is derived from the OSM airport graph. three.js frame: x = east, y = up, z = -north (metres).
*/
import * as THREE from 'three';
import type { World } from './world';
import type { OsmAirport } from '@/lib/osmAirport';
import { PALETTE, TAXIWAY_WIDTH, apronMaterial, asphaltMaterial, markingLines, markingMaterial, mergeGeometries, ribbon, toV3, type Fade, type NightHandle } from './terrain';

/** Runway widths (m) by airport, optionally per runway ref ("13R/31L"); anything else is 45 m. */
const RUNWAY_WIDTH: Record<string, number | Record<string, number>> = {
  KSFO: 61, EGLL: 50, KLAX: { '07R/25L': 61 }, KJFK: { '13L/31R': 46 }, KBOS: { '15L/33R': 30, '14/32': 30 }, VIDP: { '11L/29R': 60, '11/29': 60 },
  VHHH: 60, WSSS: 60, RJTT: 60, OMDB: 60, LFPG: { '09R/27L': 60, '08L/26R': 60 },
};
const DEFAULT_RUNWAY_WIDTH: Record<string, number> = { KLAX: 46, KJFK: 61, KBOS: 46, YSSY: 45, LFPG: 45 };
export function runwayWidth(icao: string, ref: string): number {
  const w = RUNWAY_WIDTH[icao];
  if (typeof w === 'number') return w;
  if (w) { const [a, b] = ref.split('/'); const alt = b && a ? `${b}/${a}` : ref; if (w[ref] != null) return w[ref]; if (w[alt] != null) return w[alt]; }
  return DEFAULT_RUNWAY_WIDTH[icao] ?? 45;
}
/** Runway ends with a full approach lighting system (the others get runway end identifier lights only). */
const APPROACH_LIGHTS: Record<string, string[]> = { KSFO: ['28L', '28R', '19L'] };

// ── light points ──────────────────────────────────────────────────────────────
/**
 * One airfield light. `dir` (unit, x/z) makes it directional: `color` is what a pilot moving along +dir sees, `color2`
 * what one moving the other way sees (black = dark from that side). `size` is the fitting's apparent size in metres -
 * on screen a light never gets smaller than a crisp point, it dims instead. `day` = brightness by day (0 = off).
 */
export interface Light { p: THREE.Vector3; color: THREE.Color; color2?: THREE.Color; dir?: THREE.Vector3; size: number; day?: number; flash?: number; seq?: number }
const LIGHT_VERT = /* glsl */ `
  attribute vec3 aColor; attribute vec3 color2; attribute vec2 aDir; attribute vec4 aInfo;   // size m, day alpha, flash phase (+1, 0 = steady), sequence (+1)
  uniform float uScale, uNight, uTime, uMinPx;
  varying vec3 vCol; varying float vAlpha;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * wp;
    float d = max(1.0, -mv.z);
    float px = aInfo.x * uScale / d;
    gl_PointSize = clamp(px, uMinPx, uMinPx * 4.2);
    vec3 col = aColor;
    if (dot(aDir, aDir) > 0.01) col = dot(cameraPosition.xz - wp.xz, aDir) < 0.0 ? aColor : color2;
    float a = mix(aInfo.y, 1.0, uNight) * (0.35 + 0.65 * sqrt(clamp(px / uMinPx, 0.0, 1.0))) * smoothstep(0.0, 0.25, px / uMinPx);
    if (aInfo.z > 0.5) a *= step(0.5, fract(uTime * 0.85 + aInfo.z));                          // alternating guard lights
    if (aInfo.w > 0.5) { float ph = fract(uTime * 2.0 - (aInfo.w - 1.0) / 16.0); a *= smoothstep(0.12, 0.0, ph) * 1.6; }   // the rabbit
    vCol = col; vAlpha = a * step(0.02, dot(col, col));
    gl_Position = vAlpha < 0.004 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
  }`;
const LIGHT_FRAG = /* glsl */ `
  varying vec3 vCol; varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float core = 1.0 - smoothstep(0.25, 0.6, r), halo = 1.0 - smoothstep(0.3, 1.0, r);
    gl_FragColor = vec4(vCol * (0.7 * halo + 1.6 * core) * vAlpha, 1.0);
  }`;
export interface LightsHandle { points: THREE.Points; setNight(n: number): void }
export function lightPoints(lights: Light[]): LightsHandle {
  const n = lights.length; const pos = new Float32Array(n * 3), c1 = new Float32Array(n * 3), c2 = new Float32Array(n * 3), dir = new Float32Array(n * 2), info = new Float32Array(n * 4);
  lights.forEach((l, i) => {
    pos.set([l.p.x, l.p.y, l.p.z], i * 3); c1.set([l.color.r, l.color.g, l.color.b], i * 3);
    const o = l.color2 ?? l.color; c2.set([o.r, o.g, o.b], i * 3);
    if (l.dir) dir.set([l.dir.x, l.dir.z], i * 2);
    info.set([l.size, l.day ?? 0, l.flash ?? 0, l.seq ?? 0], i * 4);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aColor', new THREE.BufferAttribute(c1, 3)); geo.setAttribute('color2', new THREE.BufferAttribute(c2, 3));
  geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 2)); geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  const uniforms = { uScale: { value: 1000 }, uNight: { value: 0 }, uTime: { value: 0 }, uMinPx: { value: 2.2 } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: LIGHT_VERT, fragmentShader: LIGHT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.renderOrder = 8;
  const size = new THREE.Vector2(); const t0 = performance.now();
  points.onBeforeRender = (renderer, _s, camera) => {
    renderer.getDrawingBufferSize(size);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 48;
    uniforms.uScale.value = size.y / (2 * Math.tan(fov * Math.PI / 360));
    uniforms.uMinPx.value = 2.6 * Math.max(1, size.y / 900);
    uniforms.uTime.value = (performance.now() - t0) / 1000;
  };
  return { points, setNight: (v) => { uniforms.uNight.value = v; } };
}

// ── geometry helpers ─────────────────────────────────────────────────────────
function discGeo(v: THREE.Vector3, r: number): THREE.BufferGeometry {
  const cg = new THREE.CircleGeometry(r, 16); cg.rotateX(-Math.PI / 2); cg.translate(v.x, v.y, v.z);
  const pos = cg.getAttribute('position'); const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i); uv[i * 2 + 1] = pos.getZ(i); }
  cg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); return cg;
}
function polygonGeo(pts: { x: number; y: number }[], h: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));   // (east, north)
  const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-Math.PI / 2); geo.translate(0, h, 0);   // faces +y, north -> -z
  const pos = geo.getAttribute('position'); const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i); uv[i * 2 + 1] = pos.getZ(i); }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}
function inPoly(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c; }
  return c;
}
/** Runway designator ("28R": digits above the letter, as painted) on a transparent canvas. */
function designatorTexture(names: string[]): { tex: THREE.CanvasTexture; rect(name: string): [number, number, number, number] } {
  const cw = 256, ch = 512; const c = document.createElement('canvas'); c.width = THREE.MathUtils.ceilPowerOfTwo(names.length * cw); c.height = ch;
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const cell = new Map<string, [number, number, number, number]>();
  names.forEach((name, i) => {
    const num = name.replace(/[^0-9]/g, '').replace(/^0/, ''), let_ = name.replace(/[0-9]/g, '');
    const x = i * cw + cw / 2;
    // tall condensed numerals: the canvas is stretched 1 : 2 on the runway (an 18 m numeral is ~6 m wide)
    ctx.save(); ctx.font = '700 196px "DM Sans", "Helvetica Neue", Arial, sans-serif';
    if (let_) { ctx.fillText(num, x, 220, cw - 24); ctx.fillText(let_, x, 480, cw - 24); }
    else ctx.fillText(num, x, 350, cw - 24);
    ctx.restore();
    cell.set(name, [(i * cw) / c.width, 0, ((i + 1) * cw) / c.width, 1]);
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return { tex, rect: (n) => cell.get(n) ?? [0, 0, 0, 0] };
}

/**
 * Which taxi graph edges are lanes across an apron (concrete with a painted centreline) rather than taxiways of their
 * own (an asphalt strip): inside a mapped apron polygon, entered by a stand's lead-in, or within 150 m of stands at
 * both ends (the lanes between two piers run 120 m from either row's stop marks). Short leftovers between apron lanes (a link of under 250 m of "taxiway" surrounded by apron) join them, so
 * no island of asphalt is left in the concrete. Keys are `a|b` with a < b.
 */
export function apronLanes(world: World, air: OsmAirport): Set<string> {
  const polys = air.buildings.filter(b => b.kind === 'apron' && b.polygon.length >= 3).map(b => b.polygon.map(p => world.toLocal(p.lng, p.lat)));
  const stops = air.stands.map(st => world.toLocal(st.lng, st.lat));
  const serves = new Set<string>(air.stands.map(st => st.entryNodeId));
  const xy = (id: string) => { const n = air.nodes.get(id)!; return world.toLocal(n.lng, n.lat); };
  const nearStand = (p: { x: number; y: number }) => stops.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 150);
  const lanes = new Set<string>(); const rest: { key: string; a: string; b: string; len: number }[] = [];
  for (const n of air.nodes.values()) for (const e of n.edges) {
    if (e.type !== 'taxiway' || e.leadIn || n.id >= e.to) continue;
    const a = xy(n.id), b = xy(e.to); const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; const key = `${n.id}|${e.to}`;
    if (polys.some(poly => inPoly(mid, poly)) || serves.has(n.id) || serves.has(e.to) || (nearStand(a) && nearStand(b))) lanes.add(key);
    else rest.push({ key, a: n.id, b: e.to, len: Math.hypot(a.x - b.x, a.y - b.y) });
  }
  // connected groups of the remaining edges: a small group touching apron lanes is apron too
  const byNode = new Map<string, number[]>(); rest.forEach((r, i) => { for (const id of [r.a, r.b]) { const l = byNode.get(id) ?? []; l.push(i); byNode.set(id, l); } });
  const laneNodes = new Set<string>(); for (const k of lanes) for (const id of k.split('|')) laneNodes.add(id);
  const seen = new Uint8Array(rest.length);
  for (let i = 0; i < rest.length; i++) {
    if (seen[i]) continue; const grp: number[] = []; const stack = [i]; seen[i] = 1; let total = 0, touches = 0;
    while (stack.length) { const j = stack.pop()!; grp.push(j); total += rest[j].len; for (const id of [rest[j].a, rest[j].b]) { if (laneNodes.has(id)) touches++; for (const k of byNode.get(id) ?? []) if (!seen[k]) { seen[k] = 1; stack.push(k); } } }
    if (total < 450 && touches >= 2) for (const j of grp) lanes.add(rest[j].key);
  }
  return lanes;
}

export function buildAirport(world: World, air: OsmAirport, fades: Fade[], night: NightHandle[] = []): THREE.Group {
  const g = new THREE.Group(); g.name = 'airport';
  const c = world.toLocal(air.center.lng, air.center.lat);
  const base = world.heightAt(c.x, c.y);
  const xy = (id: string) => { const n = air.nodes.get(id)!; return world.toLocal(n.lng, n.lat); };
  const asphalt = asphaltMaterial(PALETTE.asphalt), shoulder = asphaltMaterial(PALETTE.shoulder);
  const concrete = apronMaterial();
  const white = markingMaterial(PALETTE.marking), yellow = markingMaterial(PALETTE.taxiLine), black = markingMaterial(new THREE.Color('#161718'));

  // Surface stack (metres above the levelled field): stand pads 0.55 < aprons 0.6 < shoulders 0.63 < taxiways 0.66 <
  // runways 0.72 < markings 0.78+.
  const apronPolys: { x: number; y: number }[][] = [];
  const apronGeos: THREE.BufferGeometry[] = [];
  for (const b of air.buildings) {
    if (b.kind !== 'apron') continue;
    const pts = b.polygon.map(p => world.toLocal(p.lng, p.lat));
    if (pts.length < 3) continue;
    apronPolys.push(pts); apronGeos.push(polygonGeo(pts, base + 0.6));
  }
  if (apronGeos.length) { const m = new THREE.Mesh(mergeGeometries(apronGeos), concrete); m.renderOrder = 1; g.add(m); }
  const lanes = apronLanes(world, air);
  /** On an apron: inside a mapped apron polygon, or a lane with stands along it (the same rule the stand pads use). */
  const onApron = (p: { x: number; y: number }) => apronPolys.some(poly => inPoly(p, poly));

  // taxiways: asphalt strips with shoulders along the taxi graph, a disc at every junction / bend. A lane across an
  // apron is not a strip of its own: it is the apron's concrete with a centreline painted on it.
  type Seg = { a: { x: number; y: number }; b: { x: number; y: number }; apron: boolean; name?: string };
  const segs: Seg[] = [];
  for (const n of air.nodes.values()) for (const e of n.edges) {
    if (e.type !== 'taxiway' || e.leadIn || n.id >= e.to) continue;
    const a = xy(n.id), b = xy(e.to);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    void mid;
    segs.push({ a, b, apron: lanes.has(`${n.id}|${e.to}`), name: e.taxiway });
  }
  const twyGeos: THREE.BufferGeometry[] = [], shGeos: THREE.BufferGeometry[] = [], clGeos: THREE.BufferGeometry[] = [], clBack: THREE.BufferGeometry[] = []; const clLine: number[] = [];
  const SH = 3.5;
  const capped = new Map<string, number>();
  for (const sg of segs) {
    const va = toV3(sg.a.x, sg.a.y, base + 0.66), vb = toV3(sg.b.x, sg.b.y, base + 0.66);
    const d = vb.clone().sub(va); const L = d.length(); if (L < 0.05) continue; d.normalize();
    if (!sg.apron) {
      twyGeos.push(ribbon(va, vb, TAXIWAY_WIDTH));
      shGeos.push(ribbon(va.clone().setY(base + 0.63), vb.clone().setY(base + 0.63), TAXIWAY_WIDTH + SH * 2));
      for (const p of [sg.a, sg.b]) { const k = `${p.x.toFixed(1)},${p.y.toFixed(1)}`; capped.set(k, (capped.get(k) ?? 0) + 1); }
    }
    // centreline: a painted stripe (wider than life so it reads from the tower), black-edged on concrete
    const e0 = va.clone().addScaledVector(d, -0.25).setY(base + 0.8), e1 = vb.clone().addScaledVector(d, 0.25).setY(base + 0.8);
    clGeos.push(ribbon(e0, e1, 0.55)); clLine.push(e0.x, e0.y, e0.z, e1.x, e1.y, e1.z);
    if (sg.apron) clBack.push(ribbon(e0.clone().setY(base + 0.77), e1.clone().setY(base + 0.77), 0.95));
  }
  for (const [k, cnt] of capped) {
    void cnt; const [x, y] = k.split(',').map(Number);
    twyGeos.push(discGeo(toV3(x, y, base + 0.66), TAXIWAY_WIDTH / 2)); shGeos.push(discGeo(toV3(x, y, base + 0.63), TAXIWAY_WIDTH / 2 + SH));
  }
  if (shGeos.length) { const m = new THREE.Mesh(mergeGeometries(shGeos), shoulder); m.renderOrder = 1; g.add(m); }
  if (twyGeos.length) { const m = new THREE.Mesh(mergeGeometries(twyGeos), asphalt); m.renderOrder = 2; g.add(m); }

  // runways: surface + shoulders + blast pads, then the paint
  const whiteGeos: THREE.BufferGeometry[] = []; const rubberGeos: THREE.BufferGeometry[] = []; const rwGeos: THREE.BufferGeometry[] = [], rwShGeos: THREE.BufferGeometry[] = [];
  const names = air.runways.flatMap(r => r.ends.map(e => e.name)); const des = designatorTexture(names); const desGeos: THREE.BufferGeometry[] = [];
  const lights: Light[] = [];
  const cWhite = new THREE.Color('#fff2d8'), cWarm = new THREE.Color('#ffe2b0'), cGreen = new THREE.Color('#2fe070'), cRed = new THREE.Color('#ff2e22'), cAmber = new THREE.Color('#ffae20'), cBlue = new THREE.Color('#2f6bff'), cOff = new THREE.Color(0, 0, 0), cFlash = new THREE.Color('#dfeaff');
  const als = APPROACH_LIGHTS[air.icao];
  const rwLines: { a: THREE.Vector3; d: THREE.Vector3; len: number; hw: number }[] = [];
  for (const r of air.runways) {
    const rw = runwayWidth(air.icao, r.ref);
    const [e0, e1] = r.ends; const a = world.toLocal(e0.lng, e0.lat), b = world.toLocal(e1.lng, e1.lat);
    const va = toV3(a.x, a.y, base + 0.72), vb = toV3(b.x, b.y, base + 0.72);
    const dir = new THREE.Vector3().subVectors(vb, va); const len = dir.length(); dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    rwLines.push({ a: va, d: dir, len, hw: rw / 2 });
    rwGeos.push(ribbon(va, vb, rw));
    rwShGeos.push(ribbon(va.clone().addScaledVector(dir, -60).setY(base + 0.64), vb.clone().addScaledVector(dir, 60).setY(base + 0.64), rw + 15));
    const y = base + 0.8;
    // paint, described from one end (s = metres in from that end, t = metres left of the centreline), mirrored for the other
    for (const [end, sgn, name] of [[va, 1, e0.name], [vb, -1, e1.name]] as [THREE.Vector3, number, string][]) {
      const D = dir.clone().multiplyScalar(sgn), S = side.clone().multiplyScalar(sgn);
      const at = (s: number, t: number) => end.clone().addScaledVector(D, s).addScaledVector(S, t).setY(y);
      const bar = (s0: number, s1: number, t: number, w: number) => whiteGeos.push(ribbon(at(s0, t), at(s1, t), w));
      // threshold: 45 m stripes, 1.8 m wide, 1.8 m apart, 3.6 m clear at the centreline
      const nStripe = Math.max(2, Math.min(8, Math.floor((rw / 2 - 3.6) / 3.6) + 1));
      for (let i = 0; i < nStripe; i++) for (const k of [-1, 1]) bar(6, 51, k * (2.7 + i * 3.6), 1.8);
      // designator, read on the approach: digits beyond the letter
      const hasLetter = /[LRC]/.test(name); const dl = hasLetter ? 42 : 20, dw = Math.min(22, rw * 0.36);
      const dg = new THREE.PlaneGeometry(dw, dl); dg.rotateX(-Math.PI / 2); dg.rotateY(Math.atan2(-D.x, -D.z));
      const dc = at(63 + dl / 2, 0).setY(base + 0.82); dg.translate(dc.x, dc.y, dc.z);
      const [u0, , u1] = des.rect(name); const uv = dg.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), hasLetter ? uv.getY(i) : 0.2 + 0.48 * uv.getY(i));
      desGeos.push(dg);
      // aiming point at 300 m (two 45 x 9 m blocks) and the touchdown zone bars every 150 m: 3, [aiming], 2, 2, 1, 1
      const inner = Math.min(11, rw * 0.18);
      if (len > 1500) {
        for (const k of [-1, 1]) bar(306, 351, k * (inner + 4.5), 9);
        for (const [s, cnt] of [[152, 3], [457, 2], [610, 2], [762, 1], [914, 1]] as [number, number][]) {
          if (s > len / 2 - 60) continue;
          for (const k of [-1, 1]) for (let i = 0; i < cnt; i++) bar(s, s + 22.5, k * (inner + 0.9 + i * 3.3), 1.8);
        }
        // tyre rubber over the touchdown zone
        const rg = new THREE.PlaneGeometry(rw * 0.42, 520, 1, 1); rg.rotateX(-Math.PI / 2); rg.rotateY(Math.atan2(-D.x, -D.z)); const rc = at(430, 0).setY(base + 0.76); rg.translate(rc.x, rc.y, rc.z); rubberGeos.push(rg);
      }
    }
    // centreline (36.5 m stripes, 24.5 m gaps) between the designators, and the side stripes
    const c0 = 125, c1 = len - 125;
    for (let s = c0; s < c1 - 20; s += 61) whiteGeos.push(ribbon(va.clone().addScaledVector(dir, s).setY(y), va.clone().addScaledVector(dir, Math.min(c1, s + 36.5)).setY(y), 0.9));
    for (const k of [-1, 1]) whiteGeos.push(ribbon(va.clone().addScaledVector(side, k * (rw / 2 - 1.2)).setY(y), vb.clone().addScaledVector(side, k * (rw / 2 - 1.2)).setY(y), 0.9));

    // ── lights ──
    const L = (s: number, t: number, h = 0.5) => va.clone().addScaledVector(dir, s).addScaledVector(side, t).setY(base + 0.72 + h);
    // edge: every 60 m, white, yellow over the last 600 m as seen by the pilot rolling toward that end
    for (let s = 0; s <= len + 1; s += 60) for (const k of [-1, 1]) {
      lights.push({ p: L(s, k * (rw / 2 + 1.5)), color: len - s < 600 ? cAmber : cWhite, color2: s < 600 ? cAmber : cWhite, dir, size: 4.5, day: 0.35 });
    }
    // centreline: every 15 m; from 900 m to go alternate red / white, the last 300 m red
    for (let s = 15, i = 0; s < len - 5; s += 15, i++) {
      const toGo = (rem: number) => (rem < 300 ? cRed : rem < 900 && i % 2 ? cRed : cWhite);
      lights.push({ p: L(s, 0.5, 0.3), color: toGo(len - s), color2: toGo(s), dir, size: 2.4, day: 0 });
    }
    for (const [idx, end] of r.ends.entries()) {
      const sgn = idx === 0 ? 1 : -1; const D = dir.clone().multiplyScalar(sgn), S = side.clone().multiplyScalar(sgn);
      const P = (s: number, t: number, h = 0.5) => (idx === 0 ? va : vb).clone().addScaledVector(D, s).addScaledVector(S, t).setY(base + 0.72 + h);
      // threshold bar: green toward the approach, red (runway end) toward the runway
      for (let t = -rw / 2; t <= rw / 2 + 0.1; t += 3) lights.push({ p: P(-1, t), color: cGreen, color2: cRed, dir: D, size: 3.6, day: 0.3 });
      // touchdown zone: barrettes of three either side of the centreline every 30 m for 900 m
      if (len > 2000) for (let s = 30; s <= 900; s += 30) for (const k of [-1, 1]) for (let j = 0; j < 3; j++) lights.push({ p: P(s, k * (9 + j * 1.5), 0.3), color: cWhite, color2: cOff, dir: D, size: 1.7, day: 0 });
      // PAPI: four units left of the runway abeam the aiming point (on a 3 degree path: two white, two red)
      for (let j = 0; j < 4; j++) lights.push({ p: P(320, rw / 2 + 15 + j * 9, 0.8), color: j < 2 ? cWhite : cRed, color2: cOff, dir: D, size: 2.8, day: 0.5 });
      if (!als || als.includes(end.name)) {
        // approach lighting: centreline barrettes every 30 m out to 720 m, the 300 m crossbar, red side rows over the
        // inner 270 m, sequenced flashers beyond 300 m
        const full = !!als;
        for (let s = 30; s <= (full ? 720 : 420); s += 30) {
          for (let j = -2; j <= 2; j++) lights.push({ p: P(-s, j * 1.1, 0.9), color: cWarm, color2: cOff, dir: D, size: 3.0, day: 0.25 });
          if (full && s <= 270) for (const k of [-1, 1]) for (let j = 0; j < 3; j++) lights.push({ p: P(-s, k * (11 + j * 1.5), 0.9), color: cRed, color2: cOff, dir: D, size: 1.8, day: 0.15 });
          if (s >= 300) lights.push({ p: P(-s, 0, 1.4), color: cFlash, color2: cOff, dir: D, size: 3.2, day: 0.6, seq: 1 + (720 - s) / 30 });
        }
        for (let t = -21; t <= 21; t += 1.5) if (Math.abs(t) > 3) lights.push({ p: P(-300, t, 0.9), color: cWarm, color2: cOff, dir: D, size: 3.0, day: 0.25 });
      } else {
        // runway end identifier lights: a pair of synchronised flashers at the threshold corners
        for (const k of [-1, 1]) lights.push({ p: P(-3, k * (rw / 2 + 12), 1.2), color: cFlash, color2: cOff, dir: D, size: 2.6, day: 0.5, seq: 1 });
      }
    }
  }
  if (rwShGeos.length) { const m = new THREE.Mesh(mergeGeometries(rwShGeos), shoulder); m.renderOrder = 1; g.add(m); }
  if (rwGeos.length) { const m = new THREE.Mesh(mergeGeometries(rwGeos), asphalt); m.renderOrder = 2; g.add(m); }
  if (rubberGeos.length) {
    const rc = document.createElement('canvas'); rc.width = 64; rc.height = 256; const rx = rc.getContext('2d')!;
    const img = rx.createImageData(64, 256); let seed = 99; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let yy = 0; yy < 256; yy++) for (let xx = 0; xx < 64; xx++) {
      const u = (xx + 0.5) / 64 - 0.5, v = (yy + 0.5) / 256;
      const lane = Math.exp(-Math.pow((Math.abs(u) - 0.16) / 0.1, 2)) * 0.8 + Math.exp(-Math.pow(u / 0.34, 2)) * 0.35;
      const along = Math.sin(Math.PI * v) ** 1.5;
      img.data.set([8, 8, 9, Math.max(0, Math.min(255, 255 * 0.5 * lane * along * (0.7 + 0.6 * rnd())))], (yy * 64 + xx) * 4);
    }
    rx.putImageData(img, 0, 0); const rt = new THREE.CanvasTexture(rc); rt.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(mergeGeometries(rubberGeos), new THREE.MeshBasicMaterial({ map: rt, transparent: true, depthWrite: false })); m.renderOrder = 3; g.add(m);
  }

  // runway holding positions: the four-line marking (two solid lines on the holding side, two dashed on the runway side)
  // on a black panel, runway guard lights either side
  const holdY: THREE.BufferGeometry[] = [], holdB: THREE.BufferGeometry[] = [];
  for (const hp of air.holdingPositions) {
    const n = air.nodes.get(hp.nodeId); if (!n || !hp.runwayRefs.length) continue;
    const other = n.edges.find(e => e.type === 'taxiway' && !e.leadIn); if (!other) continue;
    const p = world.toLocal(n.lng, n.lat); const q = xy(other.to);
    const dir = new THREE.Vector3(q.x - p.x, 0, -(q.y - p.y)).normalize(); const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const centre = toV3(p.x, p.y, base + 0.82);
    // which way is the runway?
    let best = Infinity, toRw = 1;
    for (const rl of rwLines) for (const k of [-1, 1]) {
      const t = centre.clone().addScaledVector(dir, k * 20).sub(rl.a); const s = Math.max(0, Math.min(rl.len, t.x * rl.d.x + t.z * rl.d.z));
      const dd = Math.hypot(t.x - rl.d.x * s, t.z - rl.d.z * s); if (dd < best) { best = dd; toRw = k; }
    }
    if (best > 400) continue;
    const R = dir.clone().multiplyScalar(toRw); const hw = TAXIWAY_WIDTH / 2;
    const line = (off: number, w: number, list: THREE.BufferGeometry[], yy = 0, t0 = -hw, t1 = hw) => list.push(ribbon(centre.clone().addScaledVector(R, off).addScaledVector(side, t0).setY(base + 0.82 + yy), centre.clone().addScaledVector(R, off).addScaledVector(side, t1).setY(base + 0.82 + yy), w));
    line(0.9, 4.6, holdB, -0.03);
    line(-0.6, 0.45, holdY); line(0.3, 0.45, holdY);
    for (const off of [1.2, 2.1]) for (let t = -hw; t < hw - 0.3; t += 1.8) line(off, 0.45, holdY, 0, t, Math.min(hw, t + 0.9));
    for (const k of [-1, 1]) for (let j = 0; j < 2; j++) lights.push({ p: centre.clone().addScaledVector(side, k * (hw + 2.5 + j * 0.9)).setY(base + 1.4), color: cAmber, color2: cOff, dir: R, size: 1.3, day: 0.45, flash: 1 + j * 0.5 });
  }

  // taxiway lighting: green centreline lights every 15 m, blue edge lights every 30 m where no other pavement is beside
  const near = (x: number, z: number, skip: Seg, r: number) => {
    for (const sg of segs) {
      if (sg === skip) continue;
      const ax = sg.a.x, az = -sg.a.y, bx = sg.b.x, bz = -sg.b.y; const dx = bx - ax, dz = bz - az; const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)); if (Math.hypot(x - ax - dx * t, z - az - dz * t) < r) return true;
    }
    for (const rl of rwLines) { const tx = x - rl.a.x, tz = z - rl.a.z; const s = tx * rl.d.x + tz * rl.d.z; if (s > -30 && s < rl.len + 30 && Math.abs(tx * rl.d.z - tz * rl.d.x) < rl.hw + 6) return true; }
    return false;
  };
  for (const sg of segs) {
    const va = toV3(sg.a.x, sg.a.y, base + 0.95), vb = toV3(sg.b.x, sg.b.y, base + 0.95);
    const d = vb.clone().sub(va); const L = d.length(); if (L < 4) continue; d.normalize(); const sd = new THREE.Vector3(-d.z, 0, d.x);
    const n = Math.max(1, Math.round(L / 15));
    for (let i = 0; i < n; i++) { const p = va.clone().addScaledVector(d, (i + 0.5) * L / n); lights.push({ p, color: cGreen, size: 1.2, day: 0 }); }
    if (sg.apron) continue;
    const m = Math.max(1, Math.round(L / 30));
    for (let i = 0; i < m; i++) for (const k of [-1, 1]) {
      const p = va.clone().addScaledVector(d, (i + 0.5) * L / m).addScaledVector(sd, k * (TAXIWAY_WIDTH / 2 + 1.2));
      if (near(p.x, p.z, sg, TAXIWAY_WIDTH / 2 + 0.6) || onApron({ x: p.x, y: -p.z })) continue;
      lights.push({ p, color: cBlue, size: 1.9, day: 0 });
    }
  }

  // paint meshes
  if (whiteGeos.length) { const m = new THREE.Mesh(mergeGeometries(whiteGeos), white); m.renderOrder = 4; g.add(m); }
  if (desGeos.length) { const dm = markingMaterial(PALETTE.marking); dm.map = des.tex; dm.transparent = true; dm.depthWrite = false; dm.alphaTest = 0.02; const m = new THREE.Mesh(mergeGeometries(desGeos), dm); m.renderOrder = 4; g.add(m); }
  if (clBack.length) { const m = new THREE.Mesh(mergeGeometries(clBack), black); m.renderOrder = 3; g.add(m); }
  if (clGeos.length) { const m = new THREE.Mesh(mergeGeometries(clGeos), yellow); m.renderOrder = 4; g.add(m); g.add(markingLines(clLine, PALETTE.taxiLine)); }
  if (holdB.length) { const m = new THREE.Mesh(mergeGeometries(holdB), black); m.renderOrder = 4; g.add(m); }
  if (holdY.length) { const m = new THREE.Mesh(mergeGeometries(holdY), yellow); m.renderOrder = 5; g.add(m); }
  void fades;

  const lh = lightPoints(lights); g.add(lh.points);
  night.push({ setNight: (n) => lh.setNight(n) });
  g.userData.base = base;
  return g;
}
